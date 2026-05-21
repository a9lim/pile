// state.js -- top-level mutable state container for the pile sim.
//
// Single global object passed by reference to physics modules. UI modules read
// from this; UI handlers write to state.cmd (commands queued for the next
// physics step), not state.* directly.

import { TYPES } from './reactor-types.js';
import { createDetectorState } from './physics/detectors.js';
import { excessRhoPcm, coreAverageBurnup, cycleLabel, betaScale } from './physics/burnup.js';
import { initMultichannelState, stepMultichannel } from './physics/multichannel.js';
import { createModesState } from './physics/modes.js';
import { containmentInitMasses } from './physics/containment.js';
import { iodineEquilibrium, xenonEquilibrium } from './physics/xenon.js';
import { tSat as saturationTempK_init } from './physics/steam-tables.js';

export function createState(reactorTypeId = 'pwr') {
  const T = TYPES[reactorTypeId];
  const N = T.axialNodes;
  const dz = T.coreHeight / N;

  // === 1D axial fields ===
  const flux = new Float64Array(N);              // n/cm² · s, normalized to 1.0 = nominal
  // Six precursor groups × N axial nodes, stored as row-major [group][node]
  const precursors = [];
  for (let g = 0; g < 6; g++) precursors.push(new Float64Array(N));
  const T_fuel = new Float64Array(N);            // K — pellet centerline (3-node stack)
  const T_clad = new Float64Array(N);            // K — clad outer surface (3-node stack); slaved to T_coolant for MSR
  const T_coolant = new Float64Array(N);         // K
  const T_graphite = new Float64Array(N);        // K, only used if reactor has graphite
  const voidFrac = new Float64Array(N);          // 0..1, only meaningful if direct cycle
  const qualityFrac = new Float64Array(N);       // steam mass quality, separate from void fraction
  const xenon = new Float64Array(N);             // normalized atoms/cm³ (1 = peak eq at full power)
  const iodine = new Float64Array(N);

  // === Initial conditions: critical reactor at nominal power ===
  // Equilibrium precursor: C_g = (β_g / Λ) · n / λ_g  (with ρ = 0 → n′ = 0)
  const fluxProfile = new Float64Array(N);
  let profileSum = 0;
  for (let k = 0; k < N; k++) {
    fluxProfile[k] = Math.sin(Math.PI * (k + 0.5) / N);
    profileSum += fluxProfile[k];
  }
  // Normalize so axial average = 1.0
  for (let k = 0; k < N; k++) fluxProfile[k] *= (N / profileSum);

  // Start at hot full-power equilibrium. Xenon/iodine and decay-heat
  // inventories are populated consistently, then snapshotted as reactivity
  // references below so the documented initial state is still critical by
  // construction. Startup-after-refuel scenarios should explicitly clear
  // these inventories rather than overloading the default operating state.
  // Series-resistance split: total fuel→coolant resistance R_total = R_pellet +
  // R_film_DB. For PWR/RBMK, T_pellet sits above T_clad above T_coolant; the
  // numerical T_pellet here equals the old lumped T_fuel formula identically
  // because R_pellet + R_film_DB = N / htCoeff by construction. MSR has no
  // distinct clad (fuel-in-coolant), so T_clad is slaved to T_coolant.
  const isFuelInCoolantInit = T.primaryTopology === 'msr';
  const fp = T.pelletResistanceFraction ?? 0.85;
  const areaTotalInit = T.heatTransferAreaM2 ?? 0;
  const areaPerNodeInit = areaTotalInit > 0 ? areaTotalInit / N : 0;
  const h_DB_init = areaTotalInit > 0 ? T.htCoeff / areaTotalInit : 0;
  const R_pellet_init = areaPerNodeInit > 0 ? fp / (h_DB_init * areaPerNodeInit) : 0;
  const R_film_DB_init = areaPerNodeInit > 0 ? (1 - fp) / (h_DB_init * areaPerNodeInit) : 0;
  // Fallback when heatTransferAreaM2 is absent — split the legacy lumped
  // resistance N/htCoeff per the same fraction.
  const R_total_legacy = T.htCoeff > 0 ? N / T.htCoeff : 0;
  const R_pellet_fallback = R_total_legacy * fp;
  const R_film_DB_fallback = R_total_legacy * (1 - fp);
  const R_pellet_eff = R_pellet_init > 0 ? R_pellet_init : R_pellet_fallback;
  const R_film_eff_init = R_film_DB_init > 0 ? R_film_DB_init : R_film_DB_fallback;

  // II.1 — Precursor equilibrium uses the burnup-scaled β so the initial state
  // is critical when neutronics scales both the prompt-α subtraction and the
  // per-group precursor source by the same factor. Without this, an EOC core
  // has ~+1000 pcm of "phantom" delayed source at init.
  const betaScaleInit = betaScale(T.initialBurnupMWdPerTU ?? 0, T);

  const startCritical = true;
  if (startCritical) {
    for (let k = 0; k < N; k++) {
      flux[k] = fluxProfile[k];
      for (let g = 0; g < 6; g++) {
        precursors[g][k] = (T.beta[g] * betaScaleInit / T.Lambda) * flux[k] / T.lambda[g];
      }
      // Thermal initial conditions — linear axial coolant profile
      const frac = (k + 0.5) / N;
      T_coolant[k] = T.coolantInletTempK + frac * (T.coolantOutletTempK - T.coolantInletTempK);
      // Per-node steady-state heat from the flux profile (W).
      const peakFactor = fluxProfile[k];
      const localPow = (T.nominalPowerMWth * 1e6) * peakFactor / N;
      if (isFuelInCoolantInit) {
        // MSR fuel-in-coolant: combined node. Old formula preserved verbatim.
        T_fuel[k] = T_coolant[k] + localPow / (T.htCoeff / N);
        T_clad[k] = T_coolant[k];   // safety value — no real clad in MSR
      } else {
        // 3-node stack: T_clad above coolant by Q·R_film_DB; T_pellet above
        // clad by Q·R_pellet. Sum is identical to the old lumped formula.
        T_clad[k] = T_coolant[k] + localPow * R_film_eff_init;
        T_fuel[k] = T_clad[k] + localPow * R_pellet_eff;
      }
      T_graphite[k] = T.graphiteMassKg ? 0.5 * (T_fuel[k] + T_coolant[k]) : T_coolant[k];
      voidFrac[k] = 0;
      qualityFrac[k] = 0;
      iodine[k] = iodineEquilibrium(flux[k]);
      xenon[k] = xenonEquilibrium(flux[k], T.xenonOffGasRateS ?? 0);
    }
  } else {
    // Cold shutdown
    for (let k = 0; k < N; k++) {
      flux[k] = 1e-12;
      for (let g = 0; g < 6; g++) precursors[g][k] = 0;
      T_coolant[k] = T.coolantInletTempK;
      T_fuel[k] = T.coolantInletTempK;
      T_clad[k] = T.coolantInletTempK;
      T_graphite[k] = T.coolantInletTempK;
      voidFrac[k] = 0;
      qualityFrac[k] = 0;
      xenon[k] = 0;
      iodine[k] = 0;
    }
  }

  // === Lumped scalars ===
  // Pressurizer (PWR), atmospheric (MSR), drum separator (RBMK)
  const pressurizerP = T.pressurizerPressureMPa;
  // III.2 — Dynamic pressurizer state. PWR only — all fields stay at their
  // default (zero / null / closed) for RBMK and MSR, and pressurizer.js
  // early-returns when T.pressurizer is undefined so they never get updated.
  // The static pressurizerP above remains pinned for those reactor types,
  // which is the documented behavior.
  const PZ = T.pressurizer;
  const pressurizerLevel = PZ ? PZ.designLevel : 0;
  // Compute initial steam / water masses from level + geometry. Using the
  // same height heuristic as pressurizer.js — keep the two in sync.
  let pressurizerSteamMass = 0;
  let pressurizerWaterMass = 0;
  let pressurizerTwater = T.coolantInletTempK ?? 290;
  if (PZ) {
    const rho_water = 740;
    const rho_steam = 100;
    const pzrHeightM = Math.pow(PZ.volumeM3, 1 / 3) * 2.5;
    const A_pzr = PZ.volumeM3 / pzrHeightM;
    const V_water = A_pzr * pzrHeightM * PZ.designLevel;
    const V_steam = PZ.volumeM3 - V_water;
    pressurizerWaterMass = V_water * rho_water;
    pressurizerSteamMass = V_steam * rho_steam;
    // Subcooled-by-design: a few K below T_sat at the setpoint.
    pressurizerTwater = saturationTempK_init(pressurizerP) - 5;
  }
  const heaterBanks = PZ ? {
    variable: 0,
    backup1: false,
    backup2: false,
    backup3: false,
    lockedOut: false,
  } : {
    variable: 0,
    backup1: false,
    backup2: false,
    backup3: false,
    lockedOut: false,
  };
  const sprayValveOpen = 0;
  const porvOpen = false;
  const codeSafetyValves = [false, false, false];
  const prtMass = 0;
  const prtRuptured = false;
  // Steam generator secondary (or direct-cycle secondary header)
  const sgSecondaryP = T.sgSecondaryPressureMPa;
  // III.7 — SG narrow-range level. PWR initializes at the controller setpoint
  // (default 0.50) so the 3-element FW regulator's integral starts at zero
  // and the mass balance is in steady state. plant.js overwrites this each
  // step from the SG water-mass balance. RBMK/MSR keep the wave-1 0.5 default
  // (their plant.js branches don't use this for trip logic the same way).
  const sgSecondaryLevel = T.sg ? (T.sg.levelSetpoint ?? 0.5) : 0.5;
  // III.9 — Secondary-side valve scalars. PWR-only initial alignment;
  // RBMK/MSR don't read these.
  const msivOpen = T.primaryTopology === 'pwr';
  const advPositions = T.primaryTopology === 'pwr'
    ? new Array(T.loopCount ?? 1).fill(0) : null;
  const condenserBypassOpen = 0;
  const intermediateLoopT = (T.coolantInletTempK + T.coolantOutletTempK) / 2 - 50;
  // Containment
  const containmentP = 0.1013;         // MPa absolute (atmospheric)
  // III.17 — normal containment-air design T. The atmosphere runs warm from
  // RCS / piping standing heat; containment.js's T_AMBIENT_K and the
  // critical-by-construction algebra both reference 315 K.
  const containmentT = 315;            // K — normal containment-air design T

  // === Reference temperatures for feedback coefficients (PER NODE) ===
  // ρ = 0 at this state by construction. Each node's reference is its own
  // initial steady-state temperature, so feedback integrates from local design
  // values rather than a global average — otherwise edge nodes (cold relative
  // to a flux-weighted center average) would have huge spurious positive
  // Doppler at the edges and trigger local prompt-supercriticality.
  const Tf0Ref = new Float64Array(N);
  const Tc0Ref = new Float64Array(N);
  const Tg0Ref = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    Tf0Ref[k] = T_fuel[k];
    Tc0Ref[k] = T_coolant[k];
    Tg0Ref[k] = T_graphite[k];
  }

  // Decay heat groups. Correlation is per-reactor-type via T.decayHeatModel
  // (falls back to ANS-5.1 if unset/unknown). Group count comes from the
  // resolved model so future correlations with different group counts (e.g. a
  // verified 23-group Tobias-Henderson set) drop in without further edits.
  // Initialized to equilibrium at nominal P:
  //   dH_i/dt = a_i · P_fission - λ_i · H_i  →  H_i,eq = a_i · P / λ_i
  // Total decay power = Σ λ_i · H_i = P · Σ a_i. ANS-5.1 best-estimate gives
  // Σ a_i ≈ 0.0699 (~7%) at t=0 after shutdown; conservative variant inflates
  // this by the safetyFactor.
  const dhCoeffs = getDecayHeatCoeffs(T.decayHeatModel);
  const decayHeatGroups = new Float64Array(dhCoeffs.a.length);
  for (let i = 0; i < dhCoeffs.a.length; i++) {
    decayHeatGroups[i] = dhCoeffs.a[i] * (T.nominalPowerMWth * 1e6) / dhCoeffs.lambda[i];
  }

  // === Controls ===
  // Rod bank positions: array because we have regulating + shutdown + safety banks
  // Rods start at the reactor-type's preferred initial fraction (0 for PWR;
  // ~0.7 for RBMK so the auto-controller has bidirectional authority in the
  // boron-dominant regime; ~0.1 for MSR). The rhoOffset below cancels the
  // rod ρ at init so the documented critical-by-construction state still
  // holds regardless of initial rod position.
  const initialRodFrac = startCritical ? (T.initialRodFrac ?? 0) : 1.0;
  const rodBanks = {
    regulating: initialRodFrac,
    safety: 0,
  };

  // === Per-node rod ρ reference ===
  // With rods at initialRodFrac > 0, each node has a baseline rod contribution
  // to ρ. We snapshot this PER NODE and subtract it from the live rod
  // contribution during reactivity evaluation, so:
  //   - At init: ρ_rods[k] = 0 everywhere (reactor critical by construction).
  //   - As rods move: ρ_rods[k] = (current - initial) for that node.
  // A scalar offset is insufficient because flux redistributes after t=0, and
  // a flux-weighted scalar cancellation only holds for the initial flux shape.
  // Per-node cancellation survives arbitrary flux relaxation.
  const rodRhoInit = new Float64Array(N);
  if (startCritical) {
    const rodTotalWorth = -(T.rodWorthPcmTotal * 1e-5);
    for (let k = 0; k < N; k++) {
      rodRhoInit[k] = rodTotalWorth * T.rodWorth(k, N, initialRodFrac);
    }
  }

  const xenonRhoInit = new Float64Array(N);
  if (startCritical) {
    const xenonWorth = (T.xenonWorthPcmAtEq ?? -2800) * 1e-5;
    for (let k = 0; k < N; k++) xenonRhoInit[k] = xenonWorth * xenon[k];
  }

  // === II.1 — Burnup tracking ===
  // Per-node integrated fission exposure in MWd/tU. Initialized uniformly
  // to the reactor-type's initial-state operating point (PWR MOC ≈ 18 GWd/tU,
  // RBMK MOC ≈ 10 GWd/tU, MSR continuously-refueled ≈ 0). Burnup advances in
  // physics/burnup.js::stepBurnup as fission power × elapsed time. The
  // coefficient-scaling functions (β_eff, Doppler, ν·Σ_f) and the excess-ρ
  // contribution are interpolated piecewise-linearly from a 5-point anchor
  // table — see physics/burnup.js.
  const initialBu = T.initialBurnupMWdPerTU ?? 0;
  const burnup = new Float64Array(N);
  for (let k = 0; k < N; k++) burnup[k] = initialBu;

  // Per-node excess-ρ reference for critical-by-construction.
  // excessRhoPcm(BU) is monotone decreasing — at BU = 0 it gives +5000 pcm
  // (fresh-fuel excess that operators compensate by boration + xenon buildup),
  // at EOC it goes negative (operators withdraw rods / reduce boron to
  // compensate). We snapshot the init value PER NODE and subtract it in
  // computePerNodeReactivity / buildReactivityStack, so at t = 0 the
  // contribution is zero everywhere; as burnup accumulates, the live
  // excessRhoPcm minus the init value tracks the DELTA the operator must
  // compensate for. Structurally identical to rodRhoInit's algebra.
  const burnupRhoInit = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    burnupRhoInit[k] = excessRhoPcm(burnup[k], T) * 1e-5;
  }
  const excessRhoInitPcm = excessRhoPcm(initialBu, T);

  // === II.4 — Modal expansion (azimuthal + radial first modes) ===
  // PWR + RBMK get T.modes; MSR omits it because the well-mixed single-region
  // MSRE-class core is well-represented by the fundamental mode alone. Built
  // via modes.js::createModesState — null when T.modes is undefined and the
  // physics module early-returns. The 4 quadrant amplitudes start uniform at
  // 1.0 (sum = 4.0) and radialSkew at 0.0 — critical-by-construction, no
  // asymmetry at t=0.
  const modes = createModesState(T);

  // === Trip log ===
  const trips = {
    highFlux: false,
    shortPeriod: false,
    lowDnbr: false,
    highCoolantT: false,
    lowPressurizerP: false,
    highPressurizerP: false,
    // III.2 — Pressurizer level trips (PWR only). Low-level (<17%) is a scram
    // — bare heater elements would burn out and the steam space would
    // depressurize uncontrollably. High-level (>92%) is a scram interlock —
    // pressurizer-filled (water-solid) operation eliminates the pressure
    // control authority of the steam dome.
    lowPzrLevel: false,
    highPzrLevel: false,
    lowSgLevel: false,
    highSgLevel: false,
    highContainmentP: false,
    lowCoolantFlow: false,
    manualScram: false,
    lossOfOffsitePower: false,
    // I.6 — RBMK Operating Reactivity Margin warning. A WARNING channel, not a
    // scram input — pedagogically the whole point of ORM monitoring is that
    // SCRAM at low ORM is what triggered the Chernobyl excursion. rps.js's
    // SCRAM_TRIPS set excludes lowOrm from the auto-scram criterion.
    lowOrm: false,
    // II.7 — Flow-excursion (Ledinegg) WARNING channel. RBMK-only. Latches
    // when state.out.ledineggUnstable has been sustained ≥ 2 sim-seconds.
    // Excluded from SCRAM_TRIPS — operator action (raise flow, reduce
    // power, etc.) is the appropriate response. The pedagogical hook is
    // that the indicator turns red BEFORE the dryout cascade.
    flowExcursion: false,
    // III.4 — RCP seal LOCA SCRAM trip. PWR only — fires when stage 2 of
    // the staged seal failure (NRC "21-21-21" model) has latched. Stage 1
    // alone is recoverable with HHSI margin and operator action; stage 2
    // means leakage has climbed to ~76 gpm per pump and the primary is
    // genuinely leaking faster than makeup can compensate. Latched
    // permanently — physical seal damage doesn't repair.
    sealLoca: false,
    // III.4 — Cooling-lost warning channels. Latch after dual cooling has
    // been gone for ≥ 2 sim-seconds. Excluded from SCRAM_TRIPS (operator
    // action: restore CCW / re-arm charging pumps). Pedagogical: gives
    // the operator a "you have ~25 minutes" indication BEFORE sealLoca
    // fires.
    sealCoolingLost: false,
    // III.5 — SI (Safety Injection) actuation WARNING. Latches when any of
    // the actuation criteria fire (lowPressurizerP, lowPressurizerLevel +
    // scram, highContainmentP, or manual). Not a scram input — it's the
    // signal that starts ECCS. PWR-only via state.eccs presence.
    siActuated: false,
    // III.6 — Low RWST WARNING. Latches when rwstFractionFull < 20%.
    // Operator prompt to prepare for E-1.3 sump-switchover. PWR-only.
    lowRwst: false,
    // III.5 — NPSH-loss warnings for the HHSI / LHSI pumps. Latch when
    // a pump's NPSH accumulator exceeds 5 sustained sim-seconds of
    // inadequate suction inventory. PWR-only.
    npshLossHhsi: false,
    npshLossLhsi: false,
    // III.3 — CVCS warnings. PWR-only via state.cvcs presence.
    cvcsLoss: false,
    letdownIsolated: false,
    // III.14 — EDG status / fault / fuel warnings. PWR-only.
    // edgRunning is intentionally a "good news" lamp — lit while ≥1 EDG
    // is carrying load, cleared on natural shutdown.
    edgRunning: false,
    edgFailure: false,
    lowFuelOil: false,
    // III.15 — DC battery warnings. PWR-only.
    batteryLow: false,
    batteryDepleted: false,
    // III.16 — grid / vital-AC warnings. PWR-only. degradedGridVoltage
    // fires while switchyard voltage is below the degraded-voltage relay
    // setpoint; vitalAcLost fires when every inverter has dropped out
    // (instrument buses dark). Both WARNING-class (not in SCRAM_TRIPS).
    degradedGridVoltage: false,
    vitalAcLost: false,
    // III.19 — CCW + SW warnings. PWR-only.
    lossCcw: false,
    lossSw: false,
    ccwHotLeg: false,
    // III.8 — AFW WARNING channels. PWR-only via state.afw presence.
    // afwActuated mirrors state.afw.actuated; afwLowFlow latches when
    // AFW signaled but flow < 50 gpm for 30 sustained seconds (TMI-2
    // closed-block-valve indication tell); tdafwUnavailable flags the
    // steam-powered train as out-of-service.
    afwActuated: false,
    afwLowFlow: false,
    tdafwUnavailable: false,
    // III.9 — Secondary-side valve WARNING channels. PWR-only.
    msivClosed: false,
    advManualOpen: false,
    // III.17 — Containment WARNING channels. PWR-only via state.containment
    // presence. highContainmentTemp fires on a sustained atmosphere over-temp;
    // containmentSprayActuated is a spray-running status lamp. Both WARNING
    // (excluded from SCRAM_TRIPS) — the existing highContainmentP scram
    // channel is unchanged and remains the containment-pressure scram authority.
    highContainmentTemp: false,
    containmentSprayActuated: false,
    // III.20 — Spent Fuel Pool WARNING channels. PWR-only via state.sfp
    // presence. NONE are SCRAM inputs — the SFP is independent of the reactor
    // and an SFP cooling loss must not trip the reactor.
    sfpCoolingLost: false,
    sfpHighTemp: false,
    sfpBoiling: false,
    sfpLowLevel: false,
    sfpFuelUncovered: false,
    // III.11 — Loss of main feedwater WARNING. Fires when the MFW pump
    // model reports no pump delivering (mfwAvailable === false). PWR-only
    // via state.feedwaterPumps presence. WARNING (not in SCRAM_TRIPS) —
    // AFW is the designed response, not a reactor trip.
    mfwLost: false,
    // III.12 — Steam generator tube rupture WARNING. Fires when any SG has
    // a ruptured tube leaking primary→secondary. PWR-only. WARNING (not in
    // SCRAM_TRIPS) — the leak debits RCS inventory and the existing
    // lowPressurizerP / lowPzrLevel scrams trip the reactor; this channel
    // is the diagnostic annunciator that names the event.
    sgtr: false,
    // III.13 — Turbine mechanical overspeed SCRAM. Fires when the rotor
    // speed reaches the overspeed-trip setpoint (110%) after a load
    // rejection the governor failed to arrest. PWR-only. In SCRAM_TRIPS.
    turbineOverspeed: false,
  };
  const tripBypass = Object.fromEntries(Object.keys(trips).map(k => [k, false]));
  const tripFirstActivated = Object.fromEntries(Object.keys(trips).map(k => [k, 0]));

  const state = {
    reactorTypeId,
    T,
    N,
    dz,

    // Fields
    flux,
    precursors,
    T_fuel,
    T_clad,
    T_coolant,
    T_graphite,
    voidFrac,
    qualityFrac,
    xenon,
    iodine,

    // Scalars
    pressurizerP,
    // III.2 — Dynamic pressurizer state (PWR only; remains at init defaults
    // for RBMK/MSR because their T.pressurizer is undefined and pressurizer.js
    // early-returns). See physics/pressurizer.js for the model.
    pressurizerLevel,
    pressurizerSteamMass,
    pressurizerWaterMass,
    pressurizerTwater,
    heaterBanks,
    sprayValveOpen,
    porvOpen,
    codeSafetyValves,
    prtMass,
    prtRuptured,
    sgSecondaryP,
    sgSecondaryLevel,
    intermediateLoopT,
    msrDrainFrac: 0,
    drainTankT: T.primaryTopology === 'msr' ? T.coolantInletTempK : 0,
    drainTankHeatMW: 0,
    containmentP,
    containmentT,
    decayHeatGroups,

    // Controls (current applied positions)
    rodBanks,
    boronPpm: T.boronInitialPpm ?? 0,
    coolantFlowFrac: 1.0,
    turbineValve: T.turbineValveOpen,
    gridLoadMW: T.nominalGridLoadMW,

    // Commands (queued by UI, consumed by physics)
    cmd: {
      regulatingTarget: rodBanks.regulating,
      safetyTarget: 0,
      boronTarget: T.boronInitialPpm ?? 0,
      coolantFlowTarget: 1.0,
      turbineValveTarget: T.turbineValveOpen,
      gridLoadTarget: T.nominalGridLoadMW,
      scramRequested: false,
      // Loss of offsite power (station blackout). Operator/scenario knob;
      // III.16 — electrical.js's undervoltage relays also LATCH this true
      // when switchyard voltage collapses. Consumed (via `!!`) by edgs.js,
      // eccs.js, rcp.js, rps.js. Previously an implicit undefined.
      lossOfOffsitePower: false,
      // III.2 — Pressurizer operator actions + scenario failure injection.
      // porvBlockValveClosed: operator action to isolate a stuck PORV after
      //   diagnosing the failure (TMI-2 operators famously did not realize the
      //   PORV was stuck for ~2 hours; the block valve closure was finally
      //   what stopped the LOCA).
      // porvStuckOpenFault: scenario-injectable; PORV refuses to re-close at
      //   its lower hysteresis threshold.
      // codeSafetyValveStuck: per-valve stuck-open failure (rare in practice
      //   but available for scenario use).
      // heaterManualOverride: 'off' forces all heaters off regardless of P.
      //   Anything else (null / undefined / 'auto') leaves the bank in
      //   automatic. Operator action.
      porvBlockValveClosed: false,
      porvStuckOpenFault: false,
      codeSafetyValveStuck: [false, false, false],
      heaterManualOverride: null,
      // III.4 — RCP shaft-seal cooling availability overrides.
      // sealInjectionForced: null (default) uses CVCS coupling when state.cvcs
      // exists, with a legacy LOOP fallback for tests without CVCS. true →
      // forces injection available regardless of LOOP; false → forces
      // unavailable.
      // ccwAvailable: defaults true; hard scenario override. Normal behavior
      // reads state.ccw.available when aux-cooling exists.
      sealInjectionForced: null,
      ccwAvailable: true,
      // III.5 + III.6 — ECCS operator commands.
      // manualSiActuation: pushbutton — when true, OR'd into the SI
      //   actuation logic so the operator can force-fire SI.
      // siReset: one-shot — set true to clear the latched siActuated
      //   flag (only effective when all firing conditions have cleared).
      //   Consumed (set back to false) by eccs.js on successful reset.
      // eccsSuctionSource: 'rwst' (default) or 'sump'. Manual switchover
      //   command — the E-1.3 procedural action.
      // rhrAligned: operator manually aligns RHR for cooldown. Inactive
      //   until aligned + RCS_P below the shutoff.
      // accumulatorIsolated: per-tank isolation flags. Today only
      //   scenarios manipulate these; UI is deferred.
      // edgsCarryingEccs: legacy hard override — real EDG/electrical state
      //   is preferred when present, but this keeps old tests/scenarios able
      //   to force an emergency bus.
      manualSiActuation: false,
      siReset: false,
      eccsSuctionSource: 'rwst',
      rhrAligned: false,
      accumulatorIsolated:
        new Array(T.eccs?.accumulator?.countTotal ?? 0).fill(false),
      edgsCarryingEccs: false,
      // III.3 — CVCS operator commands.
      // cvcsMode: 'auto' (default), 'dilute', 'borate', 'makeup'. Drives
      //   the boric acid blender output composition.
      // cvcsBoronTargetPpm: setpoint for AUTO / MAKEUP mode. Initialized
      //   to the type's boronInitialPpm so steady-state holds.
      // cvcsChargingPumpManual{Stop,Start}[i]: per-pump operator overrides.
      // cvcsChargingPumpFault[i]: scenario fault injection {'none','trip'}.
      // cvcsLetdownIsolated: operator manual letdown isolation (CCW-loss
      //   isolation is automatic via the cvcs.letdownIsolated mirror).
      cvcsMode: 'auto',
      cvcsBoronTargetPpm: T.boronInitialPpm ?? 0,
      cvcsChargingPumpManualStop:
        new Array(T.cvcs?.chargingPumpCount ?? 0).fill(false),
      cvcsChargingPumpManualStart:
        new Array(T.cvcs?.chargingPumpCount ?? 0).fill(false),
      cvcsChargingPumpFault:
        new Array(T.cvcs?.chargingPumpCount ?? 0).fill('none'),
      cvcsLetdownIsolated: false,
      // MSR freeze plug: active cooling keeps the salt plug frozen. Loss of
      // this cooling (or explicit operator melt) starts gravity drain.
      freezePlugCoolingAvailable: true,
      meltFreezePlug: false,
      // III.14 — EDG operator commands.
      // edgManualStart[i]: bypasses LOOP-driven auto-start (surveillance
      //   testing without simulating LOOP).
      // edgManualStop[i]: manual stop.
      // edgFault[i]: scenario fault injection in {'none','fuel','jacket',
      //   'lube','governor'}. Latched once raised.
      edgManualStart: new Array(T.edgs?.edgCount ?? 0).fill(false),
      edgManualStop: new Array(T.edgs?.edgCount ?? 0).fill(false),
      edgFault: new Array(T.edgs?.edgCount ?? 0).fill('none'),
      // III.16 — vital AC / grid operator + scenario knobs.
      // gridVoltagePU: switchyard voltage, per-unit (default 1.0). Drop it
      //   below ~0.90 (degraded-voltage relay, ~60 s delay) or ~0.25
      //   (loss-of-voltage relay, ~2 s) and electrical.js latches LOOP.
      // manualLoadShed: operator action to shed non-essential vital loads
      //   during a blackout — extends battery life (~4 h → ~7 h).
      // inverterFault[i]: per-inverter scenario fault injection — a
      //   faulted inverter drops its vital-AC output regardless of input.
      gridVoltagePU: 1.0,
      manualLoadShed: false,
      inverterFault: [false, false, false, false],
      // III.19 — CCW + SW operator commands. Per-pump stop + fault
      // injection. Faults in {'none','trip','lowSuction'}.
      ccwPumpManualStop: new Array(T.ccw?.ccwPumpCount ?? 0).fill(false),
      ccwPumpFault: new Array(T.ccw?.ccwPumpCount ?? 0).fill('none'),
      swPumpManualStop: new Array(T.ccw?.swPumpCount ?? 0).fill(false),
      swPumpFault: new Array(T.ccw?.swPumpCount ?? 0).fill('none'),
      // III.17 — Containment operator commands. PWR-relevant; inert otherwise.
      // containmentSprayManual: pushbutton — OR'd into spray actuation.
      // containmentSprayBlock: operator isolation — forces sprays OFF.
      // containmentSprayReset: one-shot — clears the latched sprayActuated
      //   flag (only effective once containment P is below the reset band);
      //   containment.js consumes it (sets back to false) on successful reset.
      // fanCoolerManualStop[i]: per-unit operator stop (4 fan-cooler units).
      containmentSprayManual: false,
      containmentSprayBlock: false,
      containmentSprayReset: false,
      fanCoolerManualStop:
        new Array(T.containment?.fanCoolerCount ?? 0).fill(false),
      // III.20 — Spent Fuel Pool operator commands.
      // sfpCoolingPumpOn: SFP circulation pump on/off. Default true (runs
      //   continuously in normal ops). False, or a LOOP without EDG pickup,
      //   or a loss of CCW, takes SFP cooling out.
      // sfpMakeupKgPerS: diverse makeup flow (FLEX / B.5.b portable pump).
      //   Sustained makeup ≥ boil-off rate arrests + reverses the level drop.
      sfpCoolingPumpOn: true,
      sfpMakeupKgPerS: 0,
      // III.7/III.11 — Main feedwater trip. Operator hard-trip of ALL
      // MFW pumps. physics/feedwater-pumps.js consumes it (zeroes MFW
      // capacity → plant.js caps FW demand at 0); afw.js auto-starts on it.
      mainFwTrip: false,
      // III.11 — Per-pump operator stops + scenario fault injection for
      // the main-feedwater + condensate pumps. Faults in {'none','trip'}
      // are latched once raised. Null for RBMK/MSR (no MFW pump model).
      mfwPumpManualStop: T.feedwaterPumps
        ? new Array(T.feedwaterPumps.mfwPumpCount).fill(false) : null,
      mfwPumpFault: T.feedwaterPumps
        ? new Array(T.feedwaterPumps.mfwPumpCount).fill('none') : null,
      condPumpManualStop: T.feedwaterPumps
        ? new Array(T.feedwaterPumps.condPumpCount).fill(false) : null,
      condPumpFault: T.feedwaterPumps
        ? new Array(T.feedwaterPumps.condPumpCount).fill('none') : null,
      // III.12 — SG tube commands (PWR only; null for RBMK/MSR).
      // sgTubeRupture[l]: scenario/operator SGTR injection per loop, latched.
      // sgTubePluggedFrac[l]: per-loop tube-plugging maintenance fraction,
      //   initialized to the type's baseline (plant.js anchors htLoop to the
      //   baseline so the init state is unchanged).
      sgTubeRupture: T.sgTubes && T.loopCount
        ? new Array(T.loopCount).fill(false) : null,
      sgTubePluggedFrac: T.sgTubes && T.loopCount
        ? new Array(T.loopCount).fill(T.sgTubes.baselinePluggedFraction ?? 0) : null,
      // III.13 — Turbine / generator commands (PWR only; inert otherwise).
      // generatorBreakerOpen: trips the generator off the grid — full load
      //   rejection (turbine overspeed transient).
      // generatorFieldCurrentPU: excitation / AVR setpoint. 1.0 = unity
      //   power factor; >1.0 over-excited (supplies VARs), <1.0 under.
      // turbineGovernorFault: disables the speed governor's fast valve
      //   closure → an uncontrolled overspeed on load rejection.
      generatorBreakerOpen: false,
      generatorFieldCurrentPU: 1.0,
      turbineGovernorFault: false,
      // III.10 — Feedwater heater isolation. Per-stage in-service flags,
      // one boolean per T.feedwater.stages entry (default all true). The
      // operator / scenario sets an entry false to isolate that heater
      // stage; physics/feedwater-heaters.js drops the isolated stage's
      // temperature rise from the FW-temp target. Null for MSR (no
      // feedwater system).
      fwHeaterInService: T.feedwater
        ? T.feedwater.stages.map(() => true)
        : null,
      // III.8 — AFW operator commands.
      // manualAfwStart: pushbutton — OR'd into auto-start logic.
      // afwReset: one-shot, clears latched actuation when conditions clear.
      // afwMovOpen: per-train per-SG MOV alignment (2 trains × loopCount
      //   SGs). Index = trainIdx*nSG + sgIdx; trainIdx ∈ {0:MDAFW,
      //   1:TDAFW}. Default true. Scenarios set false to model the
      //   TMI-2 closed-block-valve failure mode.
      // tdafwBlockValveOpen: TDAFW steam admission. Default true.
      manualAfwStart: false,
      afwReset: false,
      afwMovOpen: new Array(2 * (T.loopCount ?? 0)).fill(true),
      tdafwBlockValveOpen: true,
      // III.9 — Secondary-side valve commands.
      // msivCloseManual: operator MSIV close. Auto-close on highContP /
      //   lowSgP also forces closed regardless.
      // msivResetOpen: one-shot reopen (only effective when all auto-close
      //   conditions have cleared and msivCloseManual is false).
      // advPositions: per-loop ADV operator demand [0..1]. Auto-relief
      //   above 7.5 MPa overrides.
      msivCloseManual: false,
      msivResetOpen: false,
      advPositions: new Array(T.loopCount ?? 0).fill(0),
      // III.1 — Multi-loop operator commands (PWR only).
      // rcpRunning[l]: per-loop RCP on/off. Tripping one RCP drops that
      //   loop into coastdown → natural circulation while the other 3
      //   loops stay forced — the canonical single-RCP-trip asymmetry.
      // loopIsolated[l]: per-loop isolation. Closes the loop's MSIV,
      //   stops its primary flow, and removes it from the core-inlet
      //   mixing — the loop's SG is parked. Used for loop-isolation /
      //   maintenance scenarios. Default all loops running, none isolated.
      rcpRunning: new Array(T.loopCount ?? 0).fill(true),
      loopIsolated: new Array(T.loopCount ?? 0).fill(false),
      // II.4 — Modal-expansion asymmetry commands. Operator-set rod /
      // boron asymmetry in pcm; drives the per-quadrant tilt and the
      // center-vs-periphery skew through their relaxation ODEs (τ ≈
      // 100-400 s). PWR + RBMK consume; MSR ignores. Bulk-mean
      // component is subtracted before applying gain — uniform commands
      // produce no tilt.
      quadrantTiltPcm: [0, 0, 0, 0],
      radialSkewPcm: 0,
    },

    // RPS
    trips,
    tripBypass,
    tripFirstActivated,
    scramActive: false,
    freezePlugMelted: false,

    // Auto rod controller (LAR / regulating rod). Default ON for all three
    // types — the open-loop dynamics (RBMK void runaway, MSR overshoot, even
    // a slight PWR droop) make the sandbox much friendlier when an automatic
    // regulator holds power at the setpoint. User toggles AUTO/MANUAL via UI.
    // Per-type tuning lives in TYPES[].autoRod; defaults applied below.
    autoRod: {
      enabled: T.autoRod?.enabledDefault ?? false,     // type-specific default
      powerSetpoint: 1.0,                              // fraction of nominal
      gainRho: T.autoRod?.gainRho ?? 0.6,              // pcm out per pcm of current ρ
      gainPower: T.autoRod?.gainPower ?? 300,          // pcm per fractional power error
      // I.5 — Tave program coupling (PWR only). pcm of ρ-demand per K of
      // Tavg error vs the load-dependent Tavg program. RBMK/MSR have no
      // Tave program — the default 0 makes the term inert there.
      gainTavg: T.autoRod?.gainTavg ?? 0,
      servoMultiplier: T.autoRod?.servoMultiplier ?? 5, // rod-drive speed multiplier in AUTO
      lastRhoDemandPcm: 0,                             // diagnostic
    },

    // Reference temperatures for Doppler / moderator feedback (set to flux-
    // weighted current avg so initial state is critical by construction)
    Tf0Ref,
    Tc0Ref,
    Tg0Ref,
    // Per-node rod ρ at init — subtracted from live rod contribution so the
    // documented critical-by-construction guarantee holds even with nonzero
    // initial rod position.
    rodRhoInit,
    xenonRhoInit,
    voidRhoInit: new Float64Array(N),
    // II.1 — Per-node burnup (MWd/tU) and its excess-ρ reference snapshot.
    // burnupRhoInit follows the same critical-by-construction pattern as
    // rodRhoInit (per-node, not scalar). See state.js comment above and
    // physics/burnup.js for the anchor table.
    burnup,
    burnupRhoInit,

    // Bookkeeping
    simTime: 0,                    // seconds of sim time elapsed
    accel: 1,                      // time-acceleration multiplier
    running: true,
    lastReactivityStack: {
      rods: 0, boron: 0, doppler: 0, moderator: 0, void: 0, xenon: 0, burnup: 0, total: 0,
    },

    // Coolant return temperature from the SG/IHX/drum (set by plant.js each
    // step). Initialized to the design inlet temp so the first thermal step
    // has a well-defined value before plant.js has run once.
    _coolantReturnT: T.coolantInletTempK,

    // II.3 — RCP coastdown bookkeeping. Tracks the live coolant-flow fraction
    // while pumps are on, then exponentially decays from the captured value
    // once pumps are commanded off. See physics/circulation.js for the regime
    // model. Initialized to 1.0 because at t=0 the pumps are at design speed.
    _rcpCoastdownFlow: 1.0,

    // III.2 — Previous-step primary T_avg, used for the pressurizer surge
    // term (dT_avg/dt drives water in/out of the pressurizer). Initialized to
    // the design tAvg so dT_avg/dt = 0 at the first frame — critical-by-
    // construction (no spurious init transient). Only meaningful for PWR;
    // RBMK/MSR don't read this because pressurizer.js early-returns for them.
    _tAvgPrev: 0.5 * (T.coolantInletTempK + T.coolantOutletTempK),

    // Outputs for UI consumption
    out: {
      fissionPowerMW: T.nominalPowerMWth,
      decayHeatMW: 0.07 * T.nominalPowerMWth,
      drainTankDecayHeatMW: 0,
      // Thermal power, not prompt-fission plus afterheat double-count. The
      // decay inventory is initialized for post-trip residual heat, but at
      // equilibrium the prompt fraction plus decay fraction sums to nominal.
      totalCorePowerMW: T.nominalPowerMWth,
      generatorMWe: T.nominalPowerMWe,
      periodSec: Infinity,
      reactivityPcm: 0,
      // I.1 — Per-loop temperature instrumentation. All in K internally; the
      // gauge layer converts to °C for display. ΔT values are differences so
      // they read identically in K vs °C.
      //   tHotK     — top-of-core coolant (hot leg / steam-water riser)
      //   tColdK    — return temperature from SG/IHX/drum (cold leg)
      //   tAvgK     — (tHot + tCold) / 2 — the canonical PWR "Tavg" indication
      //   deltaTLoopK — tHot - tCold — proportional to power × inverse flow
      //   deltaTPowerFrac — deltaTLoop / design-ΔT — "ΔT-power" indication on
      //                     PWR panels, ≈ fraction-of-nominal-power at design flow
      //   peakDeltaFuelCoolantK — max over nodes of T_fuel[k] - T_coolant[k];
      //                            diagnostic hot-channel fuel-to-coolant ΔT.
      //                            DNBR is now computed separately in chf.js.
      tHotK: T.coolantOutletTempK,
      tColdK: T.coolantInletTempK,
      tAvgK: (T.coolantOutletTempK + T.coolantInletTempK) / 2,
      deltaTLoopK: T.coolantOutletTempK - T.coolantInletTempK,
      deltaTPowerFrac: 1.0,
      peakDeltaFuelCoolantK: 0,
      // I.2 — DNBR (departure from nucleate boiling ratio) at the hot
      // channel. dnbrPerNode is the per-axial-node profile (q''_chf /
      // q''_local), dnbrMin is the minimum across the channel (the
      // operator's number — trip at 1.3, warn at 1.5), dnbrMinNode is
      // the index of the limiting node. Null for MSR (no two-phase
      // regime in single-phase salt → no boiling crisis to depart from).
      // Populated each step by physics/chf.js::computeDnbr.
      dnbrPerNode: null,
      dnbrMin: null,
      dnbrMinNode: -1,
      // I.6 — RBMK Operating Reactivity Margin in equivalent fully-inserted
      // rods. Computed in sim.js::updateLoopOutputs from current bank position
      // against the design rod count. Null for non-RBMK reactors.
      orm: reactorTypeId === 'rbmk' ? (1 - initialRodFrac) * RBMK_TOTAL_RODS : null,
      // I.5 — PWR Tave program reference (load-dependent T_avg setpoint).
      // Updated in sim.js::updateLoopOutputs against current grid load fraction.
      // Null for reactors without a Tave program (RBMK boils, MSR is single-rod).
      tAvgProgramK: (T.tavgProgramFullC !== undefined) ? (T.tavgProgramFullC + 273.15) : null,

      // I.4 — SR/IR/PR detector channels. Initialized to floor values so the
      // first-frame render isn't blank; populated each step by stepDetectors.
      // See physics/detectors.js for range / lag / noise calibration.
      detSrCps: 0.1,
      detSrOffscale: false,
      detIrAmp: 1e-12,
      detIrPowerFrac: 1e-9,
      detPrFrac: 0,
      detPrOffscaleLow: true,
      // II.1 — Burnup readouts. coreBurnupAvg is the flux-weighted core mean
      // in MWd/tU; cycleProgressFrac is clamped against the type's discharge
      // target for the bar display.
      // a progress indication; cycleLabel ∈ {BOC, MOC, EOC}; excessRhoBurnedPcm
      // is how much fuel-cycle reactivity has been burned off since the loaded
      // initial state (= excessRhoPcm(live) - excessRhoPcm(init)). At init
      // this is 0 by construction; it goes negative as burnup accumulates,
      // and the operator must compensate via rod withdrawal / boron dilution.
      coreBurnupAvg: initialBu,
      cycleProgressFrac: Math.min(1, Math.max(0, initialBu / (T.cycleBurnupLimitMWdPerTU ?? 45000))),
      cycleLabel: cycleLabel(initialBu, T),
      excessRhoBurnedPcm: 0,
      excessRhoInitPcm,
      // II.3 — Regime-aware primary mass flow. flowMassRateKgPerS is the
      // actual mass flow driving thermal.js + plant.js this step;
      // flowFracOfNominal is the fraction of design flow; naturalCircFlowKgPerS
      // is the NC-only contribution (operator pedagogy — "if pumps fail, this
      // is what removes decay heat"); flowRegime ∈ {forced, transition, natural}.
      // All populated each step by physics/circulation.js::stepCirculation.
      // Initialized to design-point forced values so the first-frame render
      // isn't blank before circulation has run once.
      flowMassRateKgPerS: T.coolantMassFlowKgPerS,
      flowFracOfNominal: 1.0,
      naturalCircFlowKgPerS: 0,
      flowRegime: 'forced',
      // II.8 — Photoneutron source diagnostic. Total normalized source rate
      // (fraction of nominal birth rate per second, dimensionless) added to
      // the analytical neutronics update by stepNeutronics. At init this is
      // small but non-zero (decay heat at full-power equilibrium × T.
      // photoneutronYield); post-scram it tracks the decay-heat tail and
      // keeps the SR detector reading above its floor for hours-to-days.
      // See physics/neutronics.js for the source term derivation.
      photoneutronSourceNps: 0,
      // II.2 — Axial offset = (P_top - P_bot) / (P_top + P_bot). Dimensionless,
      // in [-1, +1]. The canonical reactor-breathing indicator: xenon
      // oscillations show up here as a slow (~30 hr) sinusoid. PWR Tech Spec
      // LCO 3.2.4 (Westinghouse/CE) limits AO to ±5% during steady-state ops.
      // Init flux profile is symmetric (sin shape, peak at mid-core) so AO ≈ 0
      // by construction. Recomputed each step in sim.js::updateLoopOutputs.
      axialOffset: 0,
      // II.7 — Parallel-channel TH (RBMK direct-cycle only). mHotKgPerS and
      // mAvgKgPerS are the per-channel-lump mass flows after the ΔP-balance
      // bisection. hotChannelQuality is the outlet steam quality in the hot
      // channel (channel-walk model). ledineggUnstable latches true when the
      // ΔP-vs-flow curve has multiple roots in [0.001, 0.999] (Ledinegg /
      // flow-excursion signature). flowSplitDivergent is true if the solver
      // couldn't converge and fell back to symmetric split. All null/zero
      // for PWR/MSR (single-channel TH). Populated each substep by
      // physics/multichannel.js::stepMultichannel.
      mHotKgPerS: 0,
      mAvgKgPerS: 0,
      hotChannelQuality: 0,
      avgChannelQuality: 0,
      bulkSteamQuality: 0,
      ledineggUnstable: false,
      flowSplitDivergent: false,

      // II.4 — Modal-expansion observables. azimuthalTilt is (max-min)/mean
      // of the 4 quadrant amplitudes (≈ QPTR-1 in the symmetric limit);
      // radialSkew mirrors state.modes.radialSkew for the gauge layer;
      // quadrantPower is per-quadrant fission MW (NW/NE/SW/SE), pre-
      // allocated so first-frame gauges don't see undefined. All zero at
      // init by construction.
      azimuthalTilt: 0,
      radialSkew: 0,
      modalPeakingFactor: 1,
      localPowerPeakFrac: 1,
      quadrantPower: new Float64Array(4),

      // III.7-9 — Secondary-side readouts. Populated each step by plant.js
      // (sgLevel/sgPressure/steamFlow/fwFlow/advTotalFlow/condBypassFlow/
      // msivOpen) and afw.js (afwTotalFlowKgPerS). Initialized so first-
      // frame render isn't blank. sgLevel/sgPressure carry the wave-1
      // design values for non-PWR; PWR overwrites every step from the
      // dynamic SG model.
      sgLevel: sgSecondaryLevel,
      sgPressure: sgSecondaryP,
      steamFlow: 0,
      fwFlow: 0,
      advTotalFlow: 0,
      condBypassFlow: 0,
      msivOpen: T.primaryTopology === 'pwr',
      afwTotalFlowKgPerS: 0,

      // III.10 — Feedwater heater train readouts. feedwaterTempK is the
      // delivered FW temperature (K); fwHeatersInService / fwHeatersTotal
      // count the heater stages in service. Populated each step by
      // physics/feedwater-heaters.js. Initialized to the design point so
      // the first-frame render is correct. Null FW temp for MSR (no
      // feedwater system).
      feedwaterTempK: T.feedwater
        ? T.feedwater.condenserTempC + 273.15
          + T.feedwater.stages.reduce((s, st) => s + st.designRiseK, 0)
        : null,
      fwHeatersInService: T.feedwater ? T.feedwater.stages.length : 0,
      fwHeatersTotal: T.feedwater ? T.feedwater.stages.length : 0,

      // III.11 — Main feedwater pump readouts. mfwCapacityKgPerS is the
      // total deliverable MFW flow; the running-count pair tracks pump
      // availability. Populated each step by physics/feedwater-pumps.js.
      // Initialized to the design point (all pumps running). Null/zero
      // for RBMK/MSR (no MFW pump model).
      mfwCapacityKgPerS: T.feedwaterPumps
        ? T.feedwaterPumps.mfwPumpCount * T.feedwaterPumps.mfwRatedFlowKgPerS
        : null,
      mfwRunningCount: T.feedwaterPumps ? T.feedwaterPumps.mfwPumpCount : 0,
      condRunningCount: T.feedwaterPumps ? T.feedwaterPumps.condPumpCount : 0,
      feedwaterPumpsAvailable: !!T.feedwaterPumps,

      // III.12 — SG tube rupture readouts. sgtrLeakKgPerS is the total
      // primary→secondary leak across all SGs; sgtrActive flags any
      // ruptured tube. Populated each step by physics/sg-tubes.js. Zero
      // for RBMK/MSR (no SG tube bundle).
      sgtrLeakKgPerS: 0,
      sgtrActive: false,

      // III.13 — Staged turbine + generator readouts. turbineSteamFlow is
      // written by plant.js (PWR) for turbine.js to consume; the rest are
      // populated by physics/turbine.js. Initialized to the design point
      // so the first-frame render is correct. Zero for RBMK/MSR (inline
      // generator calc; state.turbine null).
      turbineSteamFlow: 0,
      turbineMechPowerMW: T.turbine ? T.nominalPowerMWe : 0,
      turbineHpPowerMW: 0,
      turbineLpPowerMW: 0,
      turbineSpeedPU: 1.0,
      generatorMVAR: 0,
      generatorPowerFactor: 1.0,
      generatorTerminalVoltagePU: 1.0,

      // III.1 — Multi-loop readouts. rcsMassFrac is the live RCS liquid
      // inventory as a fraction of design (1.0 = full; drops on seal LOCA,
      // recovers on ECCS injection). loopFlowSpreadFrac is the max-min
      // spread of per-loop flow normalized by mean — 0 when symmetric,
      // grows when an RCP trips or a loop is isolated. Both null for
      // RBMK/MSR (single-loop). Populated each step by updateLoopOutputs.
      rcsMassFrac: T.loopCount ? 1.0 : null,
      loopFlowSpreadFrac: T.loopCount ? 0 : null,

      // III.17 — Containment readouts. Populated each step by containment.js
      // (PWR only). containmentPressureBarg is the operator-facing gauge value
      // (bar above atmospheric); the rest mirror containment-system state.
      // Stay at these defaults for RBMK/MSR (no containment module).
      containmentPressureMPa: 0.1013,
      containmentPressureBarg: 0,
      containmentTempK: 315,
      containmentSprayActive: false,
      containmentSprayFlowKgPerS: 0,
      containmentFanCoolersRunning: T.containment ? (T.containment.fanCoolerCount ?? 4) : 0,
      containmentSteamMassKg: 0,

      // III.20 — Spent Fuel Pool readouts. Populated each step by sfp.js
      // (PWR only). Left at these defaults for RBMK/MSR.
      sfpWaterTempK: T.sfp ? (T.sfp.normalTempK ?? 313.15) : null,
      sfpLevelFrac: T.sfp ? 1 : null,
      sfpBoiling: false,
      sfpBoiloffKgPerS: 0,
      sfpCoolingAvailable: !!T.sfp,
      sfpCoolingHeatMW: 0,
      sfpDecayHeatMW: T.sfp ? (T.sfp.decayHeatW ?? 0) / 1e6 : 0,
      sfpFuelUncovered: false,
      sfpZircFireRisk: false,
      sfpTimeToBoilSec: null,
      sfpTimeToUncoverSec: null,
    },

    // I.4 — Detector internal state (lagged values + offscale flags). Lives
    // outside `out` so the noise+lag accumulators aren't accidentally reset
    // by anything that touches `out`.
    detectors: createDetectorState(),

    // II.7 — Parallel-channel TH per-channel state. Initialized below via
    // initMultichannelState(state). For PWR/MSR these stay null (single-
    // channel TH continues to use state.T_coolant / state.voidFrac directly).
    T_coolant_hot: null,
    T_coolant_avg: null,
    voidFrac_hot: null,
    voidFrac_avg: null,
    qualityFrac_hot: null,
    qualityFrac_avg: null,
    m_hot: 0,
    m_avg: 0,

    // II.7 — Sustained-condition accumulator for the flowExcursion trip
    // channel. Latches the trip after 2 sim-seconds of ledineggUnstable.
    _ledineggAccum: 0,
    _msrLoopBuf: null,
    _msrLoopIdx: 0,

    // III.4 — RCP shaft-seal model state. PWR-only — built below if the
    // reactor type defines T.rcpSeal. RBMK / MSR get rcpSeal = null and
    // physics/rcp.js early-returns on the missing config. All mutation
    // post-init is owned by rcp.js (rule: nothing else writes to
    // state.rcpSeal.* after createState).
    rcpSeal: null,

    // III.4 — Sustained-condition accumulator for the sealCoolingLost
    // warning channel. Latches the warning after 2 sim-seconds of
    // both-cooling-streams-unavailable (matches the lowOrm / flowExcursion
    // accumulator pattern).
    _sealCoolingAccum: 0,

    // III.5 + III.6 — ECCS state. PWR-only; built below if T.eccs is
    // defined. RBMK / MSR get state.eccs = null and physics/eccs.js
    // early-returns on the missing config. All mutation post-init is
    // owned by eccs.js (same rule as rcpSeal — nothing else writes to
    // state.eccs.* after createState).
    eccs: null,

    // III.15 — DC distribution + AC availability roll-up. PWR-only.
    // Owned by physics/electrical.js post-init.
    electrical: null,
    // III.14 — Emergency Diesel Generators. PWR-only; built when T.edgs
    // is defined. Owned by physics/edgs.js post-init.
    edgs: null,
    // III.19 — Component Cooling Water + Service Water. PWR-only;
    // owned by physics/aux-cooling.js post-init.
    ccw: null,
    // III.17 — PWR large-dry containment. PWR-only; built below when
    // T.containment is defined. Owned by physics/containment.js post-init.
    containment: null,
    // III.20 — Spent Fuel Pool. PWR-only; built below when T.sfp is
    // defined. Owned by physics/sfp.js post-init.
    sfp: null,
    // III.3 — Chemical and Volume Control. PWR-only; owned by
    // physics/cvcs.js post-init.
    cvcs: null,
    // III.8 — Auxiliary feedwater. PWR-only; built when T.afw defined.
    // Owned by physics/afw.js post-init.
    afw: null,

    // III.9 — Secondary-side valves. PWR-only initial alignment;
    // RBMK/MSR don't read these. Owned by plant.js after init.
    msivOpen,
    advPositions,
    condenserBypassOpen,
    // III.7 — SG mass-balance + 3-element controller state. III.1 moved
    // this per-loop into state.loops[l] (sgWaterMassKg / sgPrevP /
    // fwIntegral / fwActual) — see the loop-builder below. The legacy
    // top-level scalars are gone; the per-loop slices replace them.

    // II.4 — Modal-expansion state (4 quadrant amplitudes + 1 radial
    // skew scalar). Owned by physics/modes.js post-init. Null for MSR.
    modes,

    // III.1 — Multi-loop primary system. state.loops is an array of L
    // loop objects (PWR only — null for RBMK/MSR, whose single-loop
    // plant branches are untouched). Each loop owns its RCP/flow state,
    // hot/cold leg temps, and SG (pressure / level / mass / 3-element
    // controller). circulation.js writes loop.massFlowKgPerS; plant.js
    // owns everything else post-init. The legacy aggregate scalars
    // (sgSecondaryP/Level, msivOpen, advPositions, condenserBypassOpen)
    // are kept alive as loop-averages so rps/chf/afw/mimic/gauges read
    // them unchanged. Built below from T.loopCount.
    loops: null,
    // III.10 — Feedwater heater train (PWR + RBMK; null for MSR). Owned
    // by physics/feedwater-heaters.js post-init. Built below from
    // T.feedwater.
    feedwater: null,
    // III.11 — Main feedwater + condensate pump train (PWR only; null for
    // RBMK/MSR). Owned by physics/feedwater-pumps.js post-init. Built
    // below from T.feedwaterPumps.
    feedwaterPumps: null,
    // III.12 — SG tube state, one entry per loop (PWR only; null for
    // RBMK/MSR). Owned by physics/sg-tubes.js post-init. Built below.
    sgTubes: null,
    // III.13 — Staged turbine + generator state (PWR only; null for
    // RBMK/MSR). Owned by physics/turbine.js post-init. Built below.
    turbine: null,
    // III.1 — Proper RCS liquid inventory (kg). Initialized to the
    // type's design figure. rcp.js (seal leak) and eccs.js (injection)
    // accumulate their net flow into _rcsExternalFlowKgPerS; pressurizer.js
    // integrates that into rcsMassKg AND folds it into the surge term so
    // pressurizer water tracks the inventory change. Replaces the wave-2
    // "pressurizerWaterMass stands in for RCS mass" stand-in. Null for
    // RBMK/MSR. _rcsExternalFlowKgPerS is reset to 0 at the top of each
    // sim step.
    rcsMassKg: T.loopCount ? (T.rcsMassDesignKg ?? 219000) : null,
    rcsMassDesignKg: T.rcsMassDesignKg ?? 0,
    _rcsExternalFlowKgPerS: 0,
    // III.17 — Per-step containment coupling accumulators. Reset to 0 at the
    // top of sim.js::step. Producers (rcp.js seal LOCA; pressurizer.js PRT
    // rupture; future LOCA-break scenarios) ADD their release; containment.js
    // consumes them. _containmentSprayDrawKgPerS / _containmentSumpInflowKgPerS
    // are WRITTEN by containment.js and READ by eccs.js (one-step lag — they
    // are NOT reset in sim.js so the cross-module hand-off survives the step).
    _containmentMassInflowKgPerS: 0,
    _containmentEnergyInflowWperS: 0,
    _containmentSprayDrawKgPerS: 0,
    _containmentSumpInflowKgPerS: 0,
  };
  // III.1 — Build the per-loop primary-system state (PWR only). Each loop
  // carries an equal share of design flow / SG mass / FW so the symmetric
  // initial state is identical to the wave-2 single-loop lump sliced into
  // L pieces — critical-by-construction is preserved.
  if (T.loopCount) {
    const L = T.loopCount;
    const sgC = T.sg || {};
    const designMassLoop = (sgC.designWaterMassKg ?? 120000) / L;
    const designFwLoop = (sgC.designFwKgPerS ?? 0) / L;
    const loops = [];
    for (let l = 0; l < L; l++) {
      loops.push({
        id: l,
        // RCP / flow
        rcpRunning: true,
        coastdownFlow: 1.0,            // per-loop II.3 coastdown latch
        massFlowKgPerS: T.coolantMassFlowKgPerS / L,
        isolated: false,
        // Legs
        tHotK: T.coolantOutletTempK,
        tColdK: T.coolantInletTempK,
        // SG (per-loop slice of the wave-2 lumped SG)
        sgPressureMPa: T.sgSecondaryPressureMPa,
        sgWaterMassKg: designMassLoop,
        sgLevel: sgC.levelSetpoint ?? 0.5,
        sgPrevP: T.sgSecondaryPressureMPa,
        fwIntegral: 0,
        fwActual: designFwLoop,
        // Secondary-side valves (one MSIV + one ADV per loop)
        msivOpen: true,
        advPosition: 0,
        // Heat / steam diagnostics (populated by plant.js each step)
        qSgW: 0,
        steamFlowKgPerS: 0,
        fwFlowKgPerS: designFwLoop,
      });
    }
    state.loops = loops;
  }
  // III.10 — Feedwater heater train. Built for PWR + RBMK (T.feedwater
  // defined); null for MSR (no feedwater system → feedwater-heaters.js and
  // plant.js's hFgEff term both early-return / no-op). designTempK is the
  // sum of every stage's design rise above the condenser hotwell — it is
  // the calibration anchor for plant.js's hFgEff term, so the SG energy
  // balance reproduces the wave-2 behaviour bit-for-bit at init. tempK is
  // seeded at designTempK → critical-by-construction.
  if (T.feedwater) {
    const fwC = T.feedwater;
    const stages = fwC.stages.map(st => ({
      name: st.name,
      designRiseK: st.designRiseK,
      inService: true,
    }));
    const sumRise = stages.reduce((s, st) => s + st.designRiseK, 0);
    const condenserTempK = fwC.condenserTempC + 273.15;
    const designTempK = condenserTempK + sumRise;
    state.feedwater = {
      tempK: designTempK,
      targetTempK: designTempK,
      designTempK,
      condenserTempK,
      cpJPerKgK: fwC.cpJPerKgK ?? 4500,
      lagTauSec: fwC.lagTauSec ?? 40,
      stages,
    };
  } else {
    state.feedwater = null;
  }
  // III.11 — Main feedwater + condensate pumps. PWR only. All pumps start
  // running (design point: full FW capacity), no faults, NPSH accumulator
  // empty → critical-by-construction (plant.js's capacity cap is slack at
  // init since 2×1050 = 2100 kg/s > the 1880 kg/s design FW flow).
  if (T.feedwaterPumps) {
    const fpC = T.feedwaterPumps;
    const mkPumps = (n, rated) => {
      const a = [];
      for (let i = 0; i < n; i++) {
        a.push({ running: true, faulted: false, flowKgPerS: rated });
      }
      return a;
    };
    state.feedwaterPumps = {
      mfwPumps: mkPumps(fpC.mfwPumpCount, fpC.mfwRatedFlowKgPerS),
      condPumps: mkPumps(fpC.condPumpCount, fpC.condRatedFlowKgPerS),
      mfwCapacityKgPerS: fpC.mfwPumpCount * fpC.mfwRatedFlowKgPerS,
      condCapacityKgPerS: fpC.condPumpCount * fpC.condRatedFlowKgPerS,
      mfwRunningCount: fpC.mfwPumpCount,
      mfwAvailable: true,
      suctionAvailable: true,
      npshAccumSec: 0,
      npshLost: false,
    };
  } else {
    state.feedwaterPumps = null;
  }
  // III.12 — SG tube state, one entry per loop (PWR only). Owned by
  // physics/sg-tubes.js post-init. pluggedFraction starts at the baseline
  // (plant.js anchors to it → init unchanged), no rupture, no leak.
  if (T.sgTubes && T.loopCount) {
    const baseline = T.sgTubes.baselinePluggedFraction ?? 0;
    const arr = [];
    for (let l = 0; l < T.loopCount; l++) {
      arr.push({
        pluggedFraction: baseline,
        ruptured: false,
        leakRateKgPerS: 0,
        cumulativeLeakKg: 0,
      });
    }
    state.sgTubes = arr;
  } else {
    state.sgTubes = null;
  }
  // III.13 — Staged turbine + generator. PWR only. Rotor synchronized at
  // 1.0 PU, breaker closed, no overspeed trip → critical-by-construction
  // (turbine.js's design-anchored efficiency reproduces the nameplate
  // generator output at the design steam flow).
  if (T.turbine) {
    state.turbine = {
      hpPowerMW: (T.nominalPowerMWe || 0) * (T.turbine.hpWorkFraction ?? 0.42),
      lpPowerMW: (T.nominalPowerMWe || 0) * (1 - (T.turbine.hpWorkFraction ?? 0.42)),
      mechPowerMW: T.nominalPowerMWe || 0,
      speedPU: 1.0,
      generatorMWe: T.nominalPowerMWe || 0,
      reactiveMVAR: 0,
      terminalVoltagePU: 1.0,
      fieldCurrentPU: 1.0,
      powerFactor: 1.0,
      breakerClosed: true,
      overspeedTrip: false,
    };
  } else {
    state.turbine = null;
  }
  if (T.rcpSeal) {
    state.rcpSeal = {
      stage1Lost: false,
      stage2Lost: false,
      stage3Lost: false,
      // Sustained dual-cooling-loss accumulators per stage. rcp.js
      // advances only the next-not-yet-failed stage's counter, so a
      // stage's tts is independent of the others (matches NRC PRA model
      // where each stage's failure timer starts from the prior stage's
      // failure event, not from t=0 of the dual loss).
      stage1AccumSec: 0,
      stage2AccumSec: 0,
      stage3AccumSec: 0,
      // Cooling-stream availability mirrors (rcp.js writes these every
      // step from cmd.sealInjectionForced + cmd.lossOfOffsitePower and
      // cmd.ccwAvailable). UI reads these to render AVAIL / LOST.
      sealInjectionAvailable: true,
      thermalBarrierCoolingAvailable: true,
      // Total leak across the lumped-one-loop stack in kg/s. Operator-
      // facing readout converts back to gpm for display.
      leakRateKgPerS: 0.0,
      // Latched timestamp of the FIRST stage failure (for forensic
      // readout "time since first failure"). Null when no failure yet.
      firstStageFailureTime: null,
    };
  }
  // III.5 + III.6 — Initialize ECCS state from the type's eccs config.
  // PWR-only — RBMK / MSR omit T.eccs and state.eccs stays null.
  if (T.eccs) {
    const eCfg = T.eccs;
    const accCount = eCfg.accumulator?.countTotal ?? 4;
    const perTankVol = eCfg.accumulator?.perTankVolumeM3 ?? 30;
    const Vgas0 = eCfg.accumulator?.perTankGasInitialVolumeM3 ?? 8;
    const Vwater0 = perTankVol - Vgas0;
    const gasP0 = eCfg.accumulator?.perTankGasPressureMPa ?? 4.2;
    const accumulators = [];
    for (let i = 0; i < accCount; i++) {
      accumulators.push({
        // Inventory tracks liquid water volume (m³). Initial water fills
        // the tank minus the gas headspace.
        inventoryM3: Vwater0,
        gasPressureMPa: gasP0,
        isolatedManually: false,
        flowing: false,
        flowKgPerS: 0,
      });
    }
    const rwstMass = eCfg.rwst?.initialMassKg ?? 1.5e6;
    state.eccs = {
      siActuated: false,
      siFirstActuatedTime: null,
      hhsiPumpAvailable: true,
      lhsiPumpAvailable: true,
      rhrPumpAligned: false,            // operator manually aligns
      hhsiFlowKgPerS: 0,
      lhsiFlowKgPerS: 0,
      rhrFlowKgPerS: 0,
      accumulators,
      // RWST inventory bookkeeping.
      rwstMassKg: rwstMass,
      rwstInitialMassKg: rwstMass,
      rwstFractionFull: 1.0,
      // Containment sump (where leaked / blown-down water collects).
      // Accumulates from external sources (RCP seal leak, future LOCA
      // break flows). Operators manually switch ECCS suction to sump
      // when RWST depletes (E-1.3 procedure).
      containmentWaterMassKg: 0,
      containmentSumpM3: 0,
      // Suction-source mirror. Eccs.js syncs from cmd.eccsSuctionSource
      // each step so UI reads from this without round-tripping cmd.
      suctionSource: 'rwst',
      // NPSH gating. npshAdequate = both pumps available; per-pump
      // sustained-condition accumulators latch pumpAvailable = false
      // after 5 sim-seconds of inadequate suction.
      npshAdequate: true,
      hhsiNpshAccumSec: 0,
      lhsiNpshAccumSec: 0,
    };
  }
  // III.15 + III.16 — DC distribution + vital AC inverters + grid coupling.
  // 4 battery banks at 100% / full voltage. Per-bank dcLoadAmps now carries
  // the BATTERY discharge load (0 when AC is up — the charger carries the
  // bus; nonzero only during a blackout). III.16 adds the grid/switchyard
  // model, the 4 vital-AC inverters, and the load-shed flag. Owned by
  // physics/electrical.js post-init.
  if (T.electrical) {
    const numBanks = 4;
    const cap = T.electrical.bankCapacityAh ?? 2000;
    const fullV = T.electrical.bankVoltageFullV ?? 250;
    const batteryAh = new Float64Array(numBanks);
    const batteryFrac = new Float64Array(numBanks);
    const batteryV = new Float64Array(numBanks);
    const dcLoadAmps = new Float64Array(numBanks);   // battery discharge load
    const inverters = [];
    for (let i = 0; i < numBanks; i++) {
      batteryAh[i] = cap;
      batteryFrac[i] = 1;
      batteryV[i] = fullV;
      dcLoadAmps[i] = 0;                              // AC up → no battery load
      inverters.push({
        available: true,
        sourceFromBattery: false,
        faulted: false,
      });
    }
    state.electrical = {
      batteryAh, batteryFrac, batteryV, dcLoadAmps,
      acAvailable: true,
      dcAvailable: true,
      // III.16 — vital AC. vitalAcAvailable is genuine now: true iff ≥1
      // inverter is up. Survives a blackout on battery power.
      vitalAcAvailable: true,
      inverters,
      loadShedActive: false,
      // III.16 — grid / switchyard. voltagePU is the switchyard voltage
      // (operator/scenario knob cmd.gridVoltagePU). The undervoltage
      // relays accumulate _lovAccumSec / _degAccumSec and latch LOOP.
      grid: {
        voltagePU: 1.0,
        degradedVoltage: false,
        lossOfVoltage: false,
        offsiteAvailable: true,
        _lovAccumSec: 0,
        _degAccumSec: 0,
      },
      totalChargingA: 0,
      totalDischargeA: 0,
      minBankFrac: 1,
      minBankIndex: 0,
      anyBankLow: false,
      anyBankDepleted: false,
    };
  }

  // III.14 — EDG state. Units in standby (not running). Auto-start on
  // cmd.lossOfOffsitePower. All faults clear, full fuel.
  if (T.edgs) {
    const numEdgs = T.edgs.edgCount ?? 2;
    const tankSize = T.edgs.fuelOilTankInitialKg ?? 150000;
    const units = [];
    for (let i = 0; i < numEdgs; i++) {
      units.push({
        running: false,
        outputKW: 0,
        fuelOilTankKg: tankSize,
        fuelTankFrac: 1,
        fuelBurnKgPerS: 0,
        jacketWaterTempK: 320,                  // 47 °C ambient
        lubeOilPressureMPa: 0.50,
        loadSequencerSec: 0,
        startDelayAccumSec: 0,
        faulted: false,
        faultReason: 'none',
        faultDescr: '',
      });
    }
    state.edgs = {
      units,
      runningCount: 0,
      anyRunning: false,
      anyFaulted: false,
      totalOutputKW: 0,
      eccsBusEnergized: false,
      lowestFuelFrac: 1,
      lowFuelOil: false,
    };
  }

  // III.19 — CCW + SW. All pumps running at init. CCW outlet T pre-
  // loaded at design 35 °C so the first frame doesn't see a transient warmup.
  if (T.ccw) {
    const nCcw = T.ccw.ccwPumpCount ?? 2;
    const nSw = T.ccw.swPumpCount ?? 2;
    const ccwFlow = T.ccw.ccwPumpFlowKgPerS ?? 750;
    const swFlow = T.ccw.swPumpFlowKgPerS ?? 1500;
    const mkCoolPump = flow => ({
      running: true,
      flowKgPerS: flow,
      faulted: false,
      faultReason: 'none',
      lowSuctionAccumSec: 0,
    });
    const ccwPumps = [];
    const swPumps = [];
    for (let i = 0; i < nCcw; i++) ccwPumps.push(mkCoolPump(ccwFlow));
    for (let i = 0; i < nSw; i++) swPumps.push(mkCoolPump(swFlow));
    state.ccw = {
      ccwPumps, swPumps,
      ccwPumpRunningCount: nCcw,
      swPumpRunningCount: nSw,
      flowKgPerS: nCcw * ccwFlow,
      swFlowKgPerS: nSw * swFlow,
      outletTempK: 308.15,
      available: true,
      swAvailable: true,
      hotLeg: false,
      lossAccumSec: 0,
      lossSwAccumSec: 0,
      ccwHotAccumSec: 0,
      lossLatched: false,
      lossSwLatched: false,
      ccwHotLatched: false,
    };
  }

  // III.17 — PWR large-dry containment. Control volume with a mass + energy
  // balance plus engineered safeguards (sprays, fan coolers, PAR stub).
  // PWR-only — RBMK/MSR omit T.containment and state.containment stays null;
  // physics/containment.js early-returns for them. Owned by containment.js
  // after init (nothing else writes state.containment.* — same rule as
  // state.eccs / state.ccw). Init steam mass is set so P = P_air + P_steam
  // closes at exactly 0.1013 MPa at the 315 K design ambient.
  if (T.containment) {
    const { airMassKg, steamMassKg } =
      containmentInitMasses(T.containmentVolumeM3 ?? 50000);
    state.containment = {
      airMassKg,
      steamMassKg,
      atmTempK: containmentT,
      pressureMPa: containmentP,
      sprayActuated: false,
      sprayRunning: false,
      sprayFlowKgPerS: 0,
      sprayFirstActuatedTime: null,
      fanCoolersRunning: T.containment.fanCoolerCount ?? 4,
      fanCoolerHeatRemovalW: 0,
      parsInstalled: T.containment.parCount ?? 2,
      parsActive: false,
      hydrogenMoleFrac: 0,
      highPressureAccumSec: 0,
      highTempAccumSec: 0,
      highPressureLatched: false,
      highTempLatched: false,
    };
  }

  // III.20 — Spent Fuel Pool. PWR-only — RBMK/MSR omit T.sfp and state.sfp
  // stays null (physics/sfp.js early-returns). The pool starts critical-by-
  // construction: cooling ON, water at the configured normal temperature,
  // full inventory. The HX UA in reactor-types.js is sized so Q_cooling =
  // Q_decay exactly at that temperature with CCW at its design outlet
  // (308.15 K) → dT/dt = 0. state.sfp is OWNED by physics/sfp.js after init.
  if (T.sfp) {
    state.sfp = {
      decayHeatW: T.sfp.decayHeatW,
      waterMassKg: T.sfp.designWaterMassKg,
      waterTempK: T.sfp.normalTempK,
      levelFrac: 1,
      pumpRunning: true,
      coolingAvailable: true,
      coolingHeatW: 0,
      decayHeatLoadW: T.sfp.decayHeatW,
      makeupKgPerS: 0,
      boiling: false,
      boiloffKgPerS: 0,
      fuelUncovered: false,
      fuelUncoveredTime: null,
      zircFireRisk: false,
      highTempAccumSec: 0,
      lowLevelAccumSec: 0,
      coolingLostAccumSec: 0,
      highTempLatched: false,
      lowLevelLatched: false,
      coolingLostLatched: false,
    };
  }

  // III.3 — CVCS. Charging pumps; pump 0 = duty (running), rest in standby.
  // Letdown clear. Boron target = current PWR boron (so the critical-by-
  // construction guarantee for steady-state boron survives).
  if (T.cvcs) {
    const chargingPumps = [];
    for (let i = 0; i < (T.cvcs.chargingPumpCount ?? 3); i++) {
      chargingPumps.push({
        running: i === 0,    // duty pump online
        faulted: false,
        faultReason: 'none',
      });
    }
    state.cvcs = {
      chargingPumps,
      chargingPumpRunningCount: 1,
      totalChargingFlowGpm: 75,
      totalChargingFlowKgPerS: 75 * 0.0631,
      sealInjectionAvailable: true,
      sealInjectionFlowGpm: 32,
      letdownIsolated: false,
      letdownFlowGpm: 75,
      letdownFlowKgPerS: 75 * 0.0631,
      makeupBoronPpm: T.boronInitialPpm ?? 0,
      cvcsMode: 'auto',
      boronTargetPpm: T.boronInitialPpm ?? 0,
      lossAccumSec: 0,
      lossLatched: false,
      letdownIsolatedLatched: false,
    };
  }

  // III.8 — AFW state. Two trains (1× motor-driven AC + 1× turbine-
  // driven steam). All in standby at init; auto-start latches on lowSgLevel
  // / LOOP / SI / mainFwTrip. Per-train dischargeMovsOpen tracks how many
  // of the per-SG MOVs are open (loopCount = full alignment, 0 = isolated).
  if (T.afw) {
    const nSG = T.loopCount ?? 1;
    state.afw = {
      actuated: false,
      firstActuatedTime: null,
      mdafw: { running: false, flowKgPerS: 0, dischargeMovsOpen: nSG },
      tdafw: { running: false, flowKgPerS: 0, dischargeMovsOpen: nSG },
      tdafwAvailable: true,
      totalFlowKgPerS: 0,
      totalFlowGpm: 0,
      lowFlowAccumSec: 0,
      lowFlowLatched: false,
    };
  }

  initMultichannelState(state);
  if (T.primaryTopology === 'direct') {
    stepMultichannel(
      state,
      state.sgSecondaryP,
      T.coolantInletTempK,
      T.heatCapCoolant,
      T.nominalPowerMWth * 1e6,
      0,
      N
    );
    for (let k = 0; k < N; k++) {
      state.Tc0Ref[k] = state.T_coolant[k];
      state.Tg0Ref[k] = state.T_graphite[k];
    }
  }
  const alphaVoidIsFunc = typeof T.alphaVoid === 'function';
  const initVoidCoeff = alphaVoidIsFunc ? T.alphaVoid(1) : (T.alphaVoid ?? 0);
  for (let k = 0; k < N; k++) state.voidRhoInit[k] = initVoidCoeff * state.voidFrac[k];
  return state;
}

// Real RBMK-1000 had 211 control + safety + shortened-absorber rods. Design
// minimum Operating Reactivity Margin was 30 rod-equivalents; Chernobyl
// operators violated this by withdrawing the bank past 0.93-equivalent
// insertion (~7 rod equivalents remaining) just before AZ-5.
export const RBMK_TOTAL_RODS = 211;

// ============================================================================
// Decay-heat correlations (I.9)
//
// Each correlation expresses fission-product afterheat as a sum of exponentials
//   P_dh(t)/P_0 = Σ a_i · exp(-λ_i · t)
// where t is time since the fission event. The dynamic model used in
// thermal.js treats each group as a reservoir charged by fission and decaying
// at λ_i, giving the same time response under arbitrary fission histories.
//
// `safetyFactor` (optional, default 1.0) multiplies each a_i to wrap the
// best-estimate fit with a +Nσ uncertainty band, as is conventional for
// Safety Analysis Report (SAR) calculations.
//
// Cite a real document for every coefficient set — do NOT hallucinate fits.
// If a desired correlation can't be sourced, leave it as a throwing stub
// rather than ship invented constants.
// ============================================================================

// ANS-5.1 (1979) 11-group decay-heat fit. Coefficients per Todreas & Kazimi,
// "Nuclear Systems Volume I" (2nd ed.), Table 8.2, derived from the original
// ANS-5.1-1979 standard "Decay Heat Power in Light Water Reactors". Best-
// estimate (no uncertainty multiplier); applicable for U-235 thermal fission
// over the time range ~1 s to ~10^9 s after shutdown. Σ a_i ≈ 0.0699.
export const DECAY_HEAT_COEFFS = Object.freeze({
  a: Object.freeze([
    0.00299, 0.00825, 0.01550, 0.01935, 0.01165,
    0.00645, 0.00231, 0.00164, 0.00085, 0.00043, 0.00057,
  ]),
  lambda: Object.freeze([
    1.7720, 0.5774, 0.06743, 0.006214, 4.739e-4,
    4.810e-5, 5.344e-6, 5.726e-7, 1.036e-7, 2.959e-8, 7.585e-10,
  ]),
  safetyFactor: 1.0,
  label: 'ANS-5.1 (1979) best-estimate',
});

// ANSI/ANS-5.1-1979 with a +2σ uncertainty multiplier baked in for use in
// SAR / licensing calculations. The 1979 standard prescribes uncertainty
// bounds that depend on time-after-shutdown; a flat +7.5% bound is a
// well-known conservative envelope used in many Westinghouse FSAR
// chapter-15 transient analyses (see e.g. ANSI/ANS-5.1-1979 §6 + the
// later 2005 revision's Table 7 commentary which retains the same shape).
// We implement it as the best-estimate fit with safetyFactor = 1.075 so the
// time response keeps the same shape and Σ a_i ≈ 0.0751.
export const DECAY_HEAT_COEFFS_CONSERVATIVE = Object.freeze({
  a: DECAY_HEAT_COEFFS.a,
  lambda: DECAY_HEAT_COEFFS.lambda,
  safetyFactor: 1.075,
  label: 'ANSI/ANS-5.1-1979 +2σ conservative (SAR)',
});

// Tobias-Henderson (1980/1989) 23-group fit. Coefficients NOT INCLUDED because
// I do not have a verifiable primary source for the full 23-group a/λ table.
// The original work is Tobias, "Decay Heat", Progress in Nuclear Energy 5(1),
// pp. 1-93 (1980), with subsequent updates by Henderson. The tables are
// reproduced in some Russian textbooks (Voskoboinikov; Frolov) and in
// ORNL/TM-XXX series reports, but I could not cross-verify the 23 pairs
// against the primary document at coding time, and inventing them would
// poison physics output. Per AGENTS.md: real coefficients only.
//
// If you have the source: replace `a: null, lambda: null` with the verified
// arrays (must be the same length), drop the throwing path in
// `getDecayHeatCoeffs`, and update the label. Until then, selecting this
// model raises so the failure is loud rather than silent-with-bad-physics.
export const DECAY_HEAT_COEFFS_TOBIAS_HENDERSON = Object.freeze({
  a: null,
  lambda: null,
  safetyFactor: 1.0,
  label: 'Tobias-Henderson 23-group (UNVERIFIED — coefficients not shipped)',
});

// Registry. Add new models here and they're automatically selectable per
// reactor type via TYPES[id].decayHeatModel.
export const DECAY_HEAT_MODELS = Object.freeze({
  'ans-5.1': DECAY_HEAT_COEFFS,
  'ans-5.1-conservative': DECAY_HEAT_COEFFS_CONSERVATIVE,
  'tobias-henderson': DECAY_HEAT_COEFFS_TOBIAS_HENDERSON,
});

// Resolve a model id to a normalized {a, lambda, safetyFactor, label} record
// with the safetyFactor folded into the effective `a` array, so callers don't
// have to remember to multiply. Default falls back to ANS-5.1 best-estimate
// for unknown / undefined ids. Throws if the requested model has no
// verified coefficients (currently Tobias-Henderson) so a selection error
// fails loudly instead of corrupting decay heat.
export function getDecayHeatCoeffs(modelId) {
  const raw = DECAY_HEAT_MODELS[modelId] ?? DECAY_HEAT_COEFFS;
  if (!raw.a || !raw.lambda) {
    throw new Error(
      `Decay-heat model "${modelId}" has no verified coefficients. ` +
      `See state.js — coefficients must be sourced from a primary document, ` +
      `not generated from training data.`
    );
  }
  if (raw.a.length !== raw.lambda.length) {
    throw new Error(`Decay-heat model "${modelId}" has mismatched a/λ lengths.`);
  }
  const sf = raw.safetyFactor ?? 1.0;
  if (sf === 1.0) {
    // Common path — return the frozen original so callers can cheaply
    // identity-compare and we avoid an allocation.
    return raw;
  }
  const aEff = new Float64Array(raw.a.length);
  for (let i = 0; i < raw.a.length; i++) aEff[i] = raw.a[i] * sf;
  return Object.freeze({
    a: aEff,
    lambda: raw.lambda,
    safetyFactor: sf,
    label: raw.label,
  });
}
