// reactor-types.js -- coefficient packs and topology config per reactor type.
//
// All temperature coefficients are in absolute fraction per kelvin (not pcm/K).
// Multiply by 1e5 for pcm display.
//
// Six-group delayed-neutron data is the canonical Keepin set for thermal U-235.
// For RBMK we use the same data (graphite-thermal spectrum is close enough for
// pedagogical purposes); for MSR we use the MSRE-fitted set with slightly
// shorter precursor half-lives reflecting the ²³³U/²³⁵U mix in FLiBe fuel.

// Keepin (1965) six-group U-235 thermal delayed-neutron data
const BETA_U235 = Object.freeze([
  0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273,
]);
const LAMBDA_U235 = Object.freeze([
  0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01,
]);
const BETA_TOTAL_U235 = BETA_U235.reduce((a, b) => a + b, 0); // ≈ 0.0065

// MSRE-fitted six-group set, ²³³U-dominant. Slightly smaller β_total.
const BETA_U233 = Object.freeze([
  0.000226, 0.000787, 0.000698, 0.001457, 0.000484, 0.000167,
]);
const LAMBDA_U233 = Object.freeze([
  0.0124, 0.0334, 0.121, 0.321, 1.27, 3.41,
]);

// Axial rod-worth profile generator. nodeIndex 0 = bottom of core, N-1 = top.
// rodFrac 0 = fully withdrawn (no rod in core), 1 = fully inserted (rod fills core from top).
// For PWR/MSR: simple linear top-down insertion with sin profile (peak worth near mid-core).
function pwrRodWorth(nodeIndex, totalNodes, rodFrac) {
  // Rod tip is at axial position (1 - rodFrac) measured from bottom. Above tip = rodded.
  const tipPos = 1 - rodFrac;
  const nodePos = (nodeIndex + 0.5) / totalNodes;
  if (nodePos < tipPos) return 0;
  // Sin² axial worth weighting peaks at mid-core. Multiplied by 2 so the
  // integral over the full core at rodFrac=1 sums to N (one "unit" per node);
  // this makes rodWorthPcmTotal calibrate cleanly to the worth at full
  // insertion under uniform flux.
  const w = Math.sin(Math.PI * nodePos);
  return 2 * w * w;
}

// RBMK rod has graphite displacer on lower 4.5 m and boron section above.
// Insertion fills the core from the top: the leading edge of the rod (its
// bottom, the graphite displacer) enters the top of the core first. Graphite
// displaces water, REDUCING absorption (water is a thermal absorber in RBMK
// while graphite is mostly moderator) → POSITIVE reactivity contribution.
// As insertion progresses past rodFrac ≈ 0.643, the boron section enters the
// top of the core and the graphite slides down toward the bottom.
//
// Sign convention: rodTotalWorth is negative (absorber default). To get the
// "graphite tip adds positive ρ" effect we return a NEGATIVE shape in the
// graphite zone (negative × negative rodTotalWorth = positive contribution).
// Boron zone returns a positive shape (positive × negative rodTotalWorth =
// negative contribution).
//
// Coefficients calibrated so that:
//   - full insertion (rodFrac = 1) gives net Σwreg/N ≈ 1 → ρ_rods ≈ -rodWorthPcmTotal
//   - peak graphite-tip insertion (rodFrac = 0.643, no boron in core yet)
//     gives Σwreg/N ≈ -0.123 → ρ_rods ≈ +615 pcm (real RBMK is ~+650 pcm).
function rbmkRodWorth(nodeIndex, totalNodes, rodFrac) {
  const nodePos = (nodeIndex + 0.5) / totalNodes;
  const tipPos = 1 - rodFrac;
  const graphiteFrac = 4.5 / 7;
  const boronStartPos = tipPos + graphiteFrac;
  const w = Math.sin(Math.PI * nodePos);
  const wSq = 2 * w * w;
  if (nodePos < tipPos) return 0;
  if (nodePos < boronStartPos) return -0.16 * wSq;   // graphite tip → +ρ (positive scram effect)
  return +4.80 * wSq;                                // boron section → -ρ (strong absorber)
}

// Generic MSR rod (only one regulating rod in MSRE). Linear from top.
function msrRodWorth(nodeIndex, totalNodes, rodFrac) {
  return pwrRodWorth(nodeIndex, totalNodes, rodFrac);
}

export const TYPES = Object.freeze({
  pwr: Object.freeze({
    id: 'pwr',
    name: 'PWR',
    longName: 'Pressurized Water Reactor (Westinghouse 4-loop class)',
    nominalPowerMWth: 3411,
    nominalPowerMWe: 1150,
    axialNodes: 20,
    coreHeight: 3.66,                // m (12 ft)
    Lambda: 2.0e-5,                  // prompt neutron generation time, s
    beta: BETA_U235,
    lambda: LAMBDA_U235,
    betaTotal: BETA_TOTAL_U235,
    // I.9 — Decay heat correlation id (looked up in state.js's
    // DECAY_HEAT_MODELS). Scenarios can override this per-instance by
    // mutating state.T.decayHeatModel before the first step, or by
    // patching the type pack before createState(). Available ids:
    //   'ans-5.1'              — best-estimate ANS-5.1 1979 (default)
    //   'ans-5.1-conservative' — same fit × 1.075 for SAR runs
    //   'tobias-henderson'     — stub, throws until coefficients verified
    decayHeatModel: 'ans-5.1',
    alphaFuel:      -2.8e-5,         // Doppler, 1/K (strongly negative)
    alphaModerator: -3.5e-4,         // moderator/coolant temp, 1/K (strongly negative)
    moderatorFeedbackState: 'coolant',
    xenonWorthPcmAtEq: -2800,
    alphaVoid:      0,               // not applicable to subcooled PWR
    Dz: 1.0e-3,                      // axial diffusion coefficient (lumped, m²/s)
    rodWorthPcmTotal: 8000,          // pcm fully inserted (regulating bank)
    rodWorth: pwrRodWorth,
    rodSpeed: 0.005,                 // frac/s manual drive
    scramSpeed: 0.5,                 // frac/s on scram (~2 s full insertion)
    boronWorthPcmPerPpm: -0.011,     // -11 pcm per ppm
    boronInitialPpm: 1200,
    primaryTopology: 'pwr',
    circulatingPrecursors: false,
    // III.1 — Multi-loop primary system. The physics is parametric in
    // loopCount; this sim runs a single lumped RCS loop (one RCP, one
    // hot/cold leg, one SG) as a deliberate usability simplification —
    // the Westinghouse class is really 4-loop. state.js builds
    // state.loops[loopCount] for PWR; physics splits the RCS plumbing
    // per loop while the core stays a single 1-D axial mesh. RBMK/MSR
    // omit loopCount and keep their single-loop plant branches.
    loopCount: 1,
    // III.1 — Design RCS liquid inventory (loops + core + pressurizer
    // water). Approximate: rcsVolumeM3 (290 m³, see pressurizer config)
    // at hot-leg density ~700 kg/m³ ≈ 203000 kg of solid-loop water,
    // plus ~16000 kg of pressurizer water at design level. state.js
    // initializes state.rcsMassKg from this; rcp.js (seal leak) and
    // eccs.js (injection) move it via state._rcsExternalFlowKgPerS, and
    // state.out.rcsMassFrac reports it as a fraction of design.
    rcsMassDesignKg: 219000,
    coolantInletTempK: 290 + 273.15,
    coolantOutletTempK: 325 + 273.15,
    // I.5 — Tave program. Linear in grid load fraction. Westinghouse 4-loop
    // class plants typically run hot-zero-power Tavg ≈ 286°C, full-power Tavg
    // ≈ 305°C — a ~19°C swing. The autopilot in AUTO mode drives the
    // regulating bank to keep actual Tavg on this curve (via gainTavg below).
    tavgProgramZeroC: 286,
    tavgProgramFullC: 305,
    pressurizerPressureMPa: 15.5,
    coolantMassFlowKgPerS: 17000,    // total primary flow
    fuelMassKg: 80000,
    coolantMassKg: 240000,
    heatCapFuel: 300,                // J/kg/K
    heatCapCoolant: 5400,            // J/kg/K (sub-cooled water at 300°C, 15 MPa)
    // I.3 — heatTransferAreaM2 is the total fuel-rod outside surface area in
    // the core. Used by thermal.js to derive a per-area single-phase film
    // coefficient (h_DB_perArea = htCoeff / heatTransferAreaM2, W/m²/K) for
    // the Jens-Lottes subcooled-nucleate-boiling enhancement. The JL term
    // composes against the lumped fuel-conduction resistance via the
    // FILM_RESISTANCE_FRAC split in thermal.js, so adding this field does
    // NOT itself recalibrate htCoeff — the enhancement is multiplicative
    // and only fires when the bulk approaches saturation.
    // PWR Westinghouse 4-loop: 193 assemblies × 264 rods × ~9.5 mm OD ×
    // ~3.66 m active length ≈ 5400 m² (standard FSAR figure).
    heatTransferAreaM2: 5400,
    htCoeff: 6.8e6,                  // W/K total fuel→coolant (single-phase baseline)
    // Three-node thermal stack (T_pellet → T_clad → T_coolant). The total
    // fuel→coolant resistance R_total = R_pellet + R_film. Pellet conduction
    // dominates in oxide-fuel rods (~85% of the resistance for UO₂); the rest
    // is split between gap conductance and film convection. Subcooled NB
    // enhances ONLY the film portion via real (T_clad - T_sat) wall superheat.
    pelletResistanceFraction: 0.85,
    // Clad thermal mass: 193 fuel assemblies × 264 rods × ~9.5 mm OD × 0.65
    // mm thick × 3.66 m active × ρ_Zr ≈ 6500 kg/m³ → ~23000 kg total Zircaloy.
    cladMassKg: 23000,
    cladHeatCapJPerKgK: 330,         // Zircaloy specific heat (essentially flat 0-1000 K)
    // I.2 — CHF / DNBR calibration. flowAreaM2 = total open flow area in
    // the core (PWR Westinghouse 4-loop ≈ 5 m² across all assemblies);
    // hotChannelFactor = radial peaking factor F_q applied to local q'';
    // chfScaling sets the Bowring-class q''_chf prefactor. Calibrated
    // against design steady state for DNBR_min ≈ 2.5-3.0 (matches typical
    // FSAR steady-state margin against the 1.3 SAFDL).
    flowAreaM2: 5.0,
    hotChannelFactor: 2.5,
    chfScaling: 3.9e5,
    sgPrimaryToSecondaryHt: 9.1e7,   // W/K — sized so 3.64 GW (incl. decay) crosses SG at ΔT=40K
    sgSecondaryPressureMPa: 6.9,
    turbineValveOpen: 1.0,
    nominalGridLoadMW: 1150,
    defaultAccelLow: 1,
    // II.1 — Burnup tracking. Each reactor type starts at a sensible operating
    // point in its fuel cycle. PWR runs ~3-cycle, ~45 GWd/tU discharge BU; MOC
    // ≈ 18 GWd/tU is the canonical "credible mid-cycle" state for scenario
    // work. See physics/burnup.js for the coefficient-scaling anchor table.
    initialBurnupMWdPerTU: 18000,
    burnupModel: 'pwr',
    cycleBurnupLimitMWdPerTU: 45000,
    // II.3 — Natural circulation + RCP coastdown. PWR Westinghouse 4-loop
    // RCPs have ~10 s flow-coastdown half-life (entrained-fluid inertia
    // dominates rotor inertia at the relevant timescales). naturalCircCoeff
    // calibrated so that at decay-heat-only (Q = 0.07 × 3411 = 239 MW = 2.39e8
    // W) the NC flow ≈ 4% × 17000 = 680 kg/s: coeff = 680 / sqrt(2.39e8) ≈
    // 0.044 (kg/s)/sqrt(W). 3-5% NC is the well-documented Westinghouse
    // 4-loop figure (NUREG/CR-5535).
    rcpCoastdownTauSec: 10,
    naturalCircCoeff: 0.044,
    // II.8 — Photoneutron yield (dimensionless): the fraction of nominal
    // birth-rate per fraction of nominal decay-heat produced via the D(γ,n)¹H
    // channel in the moderator. PWR light water has ~0.015% natural D₂O; the
    // ~10⁻⁴ neutrons-per-fission figure at full-power equilibrium translates
    // to a per-node analytical source whose subcritical-floor multiplier
    // works out to roughly photoneutronYield × decayFrac. Calibrated against
    // the post-scram target of ~10⁻⁵ × P_nominal at the 1 h SR reading.
    // See physics/neutronics.js for the unit derivation. Calibrated against a
    // 10 h post-scram run (3411 MW → manual scram → 10 h @ 600× accel):
    //   yield=1e-3 → floor 4.5e-2 MW = 1.3e-5 × P_nominal at +10 h, ρ_init
    //   bias -0.04 pcm vs the yield=0 baseline. The 10⁻⁵ floor target is the
    //   documented "fraction of nominal flux that a real PWR SR detector
    //   actually sees days after shutdown" — matches Lewis "Fundamentals of
    //   Nuclear Reactor Physics" §11 (light-water photoneutron from D ≈
    //   ~10⁻⁴ neutrons per fission at full power equilibrium).
    photoneutronYield: 1e-3,
    // Auto-rod controller (LAR-style): PWR has a fairly slow auto rod drive in
    // reality; we mirror that with a modest servo multiplier.
    initialRodFrac: 0,
    autoRod: {
      enabledDefault: true,
      gainRho: 0.5,
      gainPower: 200,
      // I.5 — Tave program coupling. 15 pcm of ρ-demand per K of Tavg error.
      // Modest gain — doesn't replace gainPower, just adds a feedforward
      // signal so the controller anticipates load-following deviations
      // before power-error develops. Real Westinghouse plants use Tavg
      // error as the primary signal but for pedagogical purposes a small
      // additive term reads cleanly on the demand readout.
      gainTavg: 15,
      servoMultiplier: 8,
    },
    // III.2 — Westinghouse-class pressurizer tuning. PWR-only — RBMK uses
    // state.sgSecondaryP as drum pressure, MSR is essentially atmospheric, so
    // those reactor types omit this field entirely. physics/pressurizer.js
    // early-returns when T.pressurizer is undefined.
    //
    // setpointP / threshold pressures / mass-flow caps define plant identity.
    // cPzrJPerMPa, kSurgeMPaPerK, and the standing Q_loss bias live in
    // pressurizer.js as module-level defaults — scenarios can override them
    // by adding the keys here.
    pressurizer: {
      setpointP: 15.5,
      porvOpenP: 16.2,
      porvCloseP: 15.9,
      codeSvOpenP: 17.1,
      codeSvCloseP: 16.8,
      variableHeaterMaxW: 150e3,
      backupHeaterW: 450e3,      // per bank, 3 banks
      sprayMaxKgPerS: 25,
      porvFlowKgPerS: 25,
      codeSvFlowKgPerS: 100,     // per valve
      volumeM3: 39,
      designLevel: 0.55,
      rcsVolumeM3: 290,
      rcsAlpha: 1.0e-3,          // K^-1, water thermal expansion at PWR primary T
      prtRuptureKg: 12000,
    },
    // III.4 — RCP shaft-seal LOCA model (Westinghouse). Lumped one-loop
    // representation of the canonical "21-21-21" staged-failure path from
    // NRC SECY-93-087 and NUREG/CR-5167. Required cooling is BOTH seal
    // injection (CVCS charging pump, AC-powered) AND thermal barrier
    // cooling (CCW); losing either alone drains the accumulator but
    // doesn't advance stages. PWR-only — RBMK MCPs and MSR magnetic-
    // bearing pumps have different (or no) shaft-seal configurations.
    // physics/rcp.js early-returns when T.rcpSeal is undefined.
    rcpSeal: {
      pumpCount: 1,
      // Normal-operation per-pump leakage with both cooling streams.
      // Westinghouse Type-93/93A seals run ~0.3-0.5 gpm; lumped to 0.5
      // here as a slightly-conservative round figure.
      normalLeakageGpm: 0.5,
      // Per-stage post-failure CUMULATIVE leakage rates (gpm). When
      // stage1 has failed and stages 2-3 haven't yet, total is stage1.
      // When stages 1+2 have failed, total is stage2 (NOT stage1+stage2 —
      // the "21-21-21" naming refers to the cumulative at each stage in
      // the canonical worst-case PRA model, not a sum-of-stages model).
      stage1LeakGpm: 21,
      stage2LeakGpm: 76,
      stage3LeakGpm: 480,
      // Per-stage time-to-failure when BOTH cooling streams are
      // unavailable. SECY-93-087 / WCAP-15603 frame these as ~15-30 min /
      // ~30-60 min / ~60-120 min ranges; we land in the middle of each
      // for the simulator. The accumulator is per-stage, advanced only
      // for the next-not-yet-failed stage.
      stage1FailureMinutesNoCooling: 25,
      stage2FailureMinutesNoCooling: 50,
      stage3FailureMinutesNoCooling: 90,
    },
    // III.4 / III.17 — Containment free volume. PWR large-dry containment
    // ≈ 50000 m³ (Westinghouse 4-loop class). Read by physics/containment.js
    // for the air/steam partial-pressure balance.
    containmentVolumeM3: 50000,
    // III.17 — PWR large-dry containment. Engineered-safeguard tunings for
    // physics/containment.js. RBMK has no Western-style pressure-retaining
    // containment (the reactor hall was a confinement — the defining
    // Chernobyl design gap); MSRE was cell-housed. Neither sets this block,
    // so state.containment is null and containment.js early-returns.
    //
    // The spray-actuation pressure is the Westinghouse "Hi-3" containment-
    // spray signal (~0.17 MPa abs ≈ 0.7 barg), deliberately above the SI
    // "Hi-1" at 0.115 MPa so sprays start only for a genuine large release.
    // Spray flow ≈ 2× 3250 gpm pumps (Westinghouse FSAR §6.2.2). Fan-cooler
    // UA tuned for ~0.5 MW/K total (4× 1.2e5 W/K) — lower instantaneous
    // capacity than the sprays but continuous.
    // References: Westinghouse FSAR Ch 6.2; NUREG-0800 SRP §6.2.1.1.A;
    // ANSI/ANS-56.4 (spray droplet efficiency).
    containment: {
      spraySetpointMPa: 0.17,        // Hi-3 containment-spray actuation
      sprayResetMPa: 0.14,           // reset-permissive hysteresis band
      sprayFlowGpm: 6500,            // lumped two-pump rated flow
      sprayEfficiency: 0.7,          // ANSI/ANS-56.4 droplet-efficiency band
      sprayInletTempK: 315,          // RWST water temp (≈ ambient)
      sprayMinSuctionKg: 5e4,        // min RWST inventory to run sprays
      fanCoolerCount: 1,             // recirculation fan-cooler bank (collapsed from 4)
      fanCoolerUaWperK: 4.8e5,       // overall UA (4× per-unit — preserves total)
      parCount: 2,                   // PARs — Phase IV.8 stub, inert here
      highPressureWarnMPa: 0.13,     // annunciator WARNING (below the scram)
      highTempWarnK: 400,            // atmosphere over-temp WARNING
      maxAtmTempK: 475,              // modeling clamp (not severe-accident)
    },
    // III.5 + III.6 — Emergency Core Cooling System. Four injection paths
    // (HHSI / LHSI / accumulators / RHR), suction-source bookkeeping
    // (RWST → sump), SI actuation logic, and NPSH limits. PWR-only —
    // RBMK / MSR have no T.eccs field and physics/eccs.js early-returns.
    //
    // Pump head curves are simple parabolic (flowGpm = runout × (1 -
    // (P/shutoff)²)) — captures the right operationally-relevant
    // behavior (HHSI dominant at high RCS_P, LHSI/RHR useless until P
    // drops) without the full Westinghouse pump-curve fidelity.
    //
    // Per-pump tunings (Westinghouse 4-loop class typical):
    //   HHSI: shutoff ~17 MPa, runout ~250 gpm
    //         (~150 gpm at 13 MPa, ~50 gpm at 15.5 MPa design RCS).
    //   LHSI: shutoff ~2 MPa, runout ~4000 gpm
    //         (multistage centrifugal, useful only after RCS dump).
    //   RHR:  shutoff ~2.5 MPa, runout ~3500 gpm
    //         (LHSI in cooldown-mode alignment, operator-initiated).
    //
    // Accumulators: 4× 30 m³ tanks, 22 m³ water + 8 m³ N₂ headspace at
    // 4.2 MPa. Passive — open when RCS_P drops below gas P. Nitrogen-
    // kicker prevention closes the check valve at 1.0 m³ inventory.
    //
    // RWST: 4×10⁵ gallons ≈ 1500 m³ ≈ 1.5e6 kg. Low alarm at 20% (operator
    // prompt to prepare for E-1.3 switchover); 10% is the real-procedure
    // switchover threshold but operators must do it manually.
    //
    // References:
    //   - Westinghouse FSAR Chapter 6.3 (ECCS sizing).
    //   - WCAP-10054-P-A (HHSI head curves).
    //   - NRC E-1.3 (switchover procedure).
    eccs: {
      hhsi: {
        shutoffP_MPa: 17.0,
        runoutFlowGpm: 250,
        npshMinSuctionM3: 50,
      },
      lhsi: {
        shutoffP_MPa: 2.0,
        runoutFlowGpm: 4000,
        npshMinSuctionM3: 50,
      },
      rhr: {
        shutoffP_MPa: 2.5,
        runoutFlowGpm: 3500,
        npshMinSuctionM3: 50,
      },
      accumulator: {
        countTotal: 1,                        // collapsed from 4 (usability)
        perTankVolumeM3: 120,                 // 4× — total inventory preserved
        perTankGasPressureMPa: 4.2,
        perTankGasInitialVolumeM3: 32,        // 120 m³ tank, 88 m³ water + 32 m³ N₂
        minInventoryBeforeIsolateM3: 4.0,     // nitrogen-kick threshold (4×)
        kAccum: 2320,                         // choked-discharge const (4× — same drain rate)
      },
      rwst: {
        initialMassKg: 1.5e6,
        lowAlarmFrac: 0.20,
        switchoverFrac: 0.10,
      },
      siActuation: {
        lowPressurizerP_MPa: 12.4,
        lowPressurizerLevel: 0.17,
        highContainmentP_MPa: 0.115,
      },
    },
    // III.7 — SG secondary side. Westinghouse 4-loop single-SG lump
    // (4× 30 m³ tube bundle ≈ 120 t water inventory at design level).
    // 3-element FW controller tuning matched to IAEA-TECDOC-981 §3.4
    // canonical values for W-4 SGs: Kp ≈ 600 kg/s per fraction-level,
    // Ki giving Ti ≈ 30 s integral time. The slow integral is intentional
    // — it must NOT chase the 3 %/min Tave-program-driven shrink/swell
    // during normal load following. designWaterMassKg ≈ 4× 30000 kg/SG
    // (Westinghouse FSAR Ch 5.4). designFwKgPerS ≈ 4× 470 kg/s per loop
    // (Westinghouse FSAR Ch 10.4.7, matches the ~3.4 GWth heat balance).
    // kSwell from the bubble-population model (IAEA-TECDOC-981 §3.4).
    sg: {
      levelSetpoint: 0.5,
      designWaterMassKg: 120000,
      designFwKgPerS: 1880,
      fwKp: 600,
      fwKi: 20,
      fwValveTau: 4,
      kSwell: 0.05,
      turbineEff: 0.34,
      hFg: 1.5e6,
    },
    // III.8 — Auxiliary feedwater. 2 trains: 1× motor-driven (AC) +
    // 1× turbine-driven (steam-powered, AC-independent). The motor-driven
    // train is collapsed from the Westinghouse 2× MDAFW arrangement
    // (1400 gpm = 2× 700). TDAFW kept separate — it is the SBO heat
    // sink, not redundant parallel equipment. Auto-start at SG
    // narrow-range < 30%. References: Westinghouse FSAR Ch 10.4.9;
    // NRC IN-86-105; NUREG-1410 (TMI-2 final report).
    afw: {
      lowSgLevelStart: 0.30,
      mdafw: { runoutFlowGpm: 1400, shutoffP_MPa: 8.0 },
      tdafw: { runoutFlowGpm: 800, shutoffP_MPa: 9.0,
               minSteamPressureMPa: 0.5 },
    },
    // III.15 + III.16 — Class 1E DC distribution + vital AC inverters +
    // grid coupling. 4× 250 V / 2000 Ah battery banks. III.16 gives each
    // train an inverter (DC → vital AC, survives a blackout on battery),
    // a switchyard-voltage / undervoltage-relay model, and operator load
    // shedding. Per-bank SBO discharge ≈ 500 A unshed / 300 A shed → ~4 h
    // / ~7 h battery life (IEEE-308 / NUREG-1776 band). Load / inverter /
    // relay tunables are module constants in physics/electrical.js.
    electrical: {
      bankCapacityAh: 2000,
      bankVoltageFullV: 250,
      bankVoltageEmptyV: 200,
    },
    // III.14 — Emergency Diesel Generators. 1× 9000 kW Class 1E EDG
    // (collapsed from 2× 4500 kW — usability simplification; one unit
    // carries the full ECCS load). 10 s start delay; ECCS bus energized
    // at +35 s of load sequencer. Fuel oil tank sized for ~7 days at
    // full load (300,000 kg).
    edgs: {
      edgCount: 1,
      ratedKwPerEdg: 9000,
      startDelaySec: 10,
      eccsBusEnergizeAtSec: 35,
      fuelOilTankInitialKg: 300000,
    },
    // III.19 — Component Cooling Water + Service Water. 1× CCW pump
    // (750 kg/s), 1× SW pump (1500 kg/s) — collapsed from the 2×100%
    // (running + standby) arrangement to a single pump each. AC-powered.
    ccw: {
      ccwPumpCount: 1,
      swPumpCount: 1,
      ccwPumpFlowKgPerS: 750,
      swPumpFlowKgPerS: 1500,
    },
    // III.20 — Spent Fuel Pool cooling. PWR-only — RBMK/MSR omit T.sfp and
    // physics/sfp.js early-returns. The SFP is a separate plant system: a
    // deep borated-water basin storing discharged assemblies, cooled by its
    // own HX→CCW loop with an AC-powered circulation pump.
    //
    // decayHeatW: aggregate decay heat of the stored inventory — 5 MW,
    //   inside the NUREG-1738 range, giving a ~20 h time-to-boil with
    //   cooling lost. FIXED — independent of reactor power.
    // designWaterMassKg: full-pool water inventory (~1300 m³ ≈ 1.42e6 kg).
    // hxUA_W_per_K: SIZED FOR CRITICAL-BY-CONSTRUCTION — with CCW at its
    //   design outlet (state.ccw init outletTempK = 308.15 K) and the pool
    //   at normalTempK (313.15 K), Q_cooling = UA·(313.15−308.15) must equal
    //   decayHeatW → UA = decayHeatW / 5 K = 1.0e6 W/K. If decayHeatW or
    //   normalTempK change, recompute UA = decayHeatW / (normalTempK−308.15).
    // saturationTempK: open free surface → atmospheric → 373.15 K.
    // normalTempK: SFP Tech-Spec normal operating temp ~40 °C.
    // uncoveryLevelFrac: level at which the surface reaches the fuel tops.
    // References: NUREG-1738; NUREG-2161; Westinghouse FSAR Ch 9.1.3;
    //   NRC Order EA-12-049 / NEI 12-06 (FLEX diverse SFP makeup).
    sfp: {
      decayHeatW: 5.0e6,
      designWaterMassKg: 1.42e6,
      hxUA_W_per_K: 1.0e6,
      saturationTempK: 373.15,
      normalTempK: 313.15,
      ultimateHeatSinkTempK: 308.15,
      uncoveryLevelFrac: 0.35,
      lowLevelWarnFrac: 0.85,
      highTempWarnK: 333.15,
    },
    // III.3 — Chemical and Volume Control. 1× centrifugal charging
    // pump (75 gpm rated at design RCS P, parabolic head curve up to
    // 17 MPa shutoff / 250 gpm runout) — collapsed from the 3-pump
    // (1 duty + 2 standby) arrangement. Letdown gated on CCW. Boric
    // acid blender with VCT τ ≈ 5 min replaces the old direct scalar
    // boron slew.
    cvcs: {
      chargingPumpCount: 1,          // collapsed from 3 (1 duty + 2 standby)
      chargingPumpRatedFlowGpm: 75,
      chargingPumpShutoffMPa: 17.0,
      designRcsPressureMPa: 15.5,
    },
    // II.4 — Modal-expansion tunings (azimuthal first mode + radial
    // first mode). PWR has the canonical Westinghouse 4-loop quadrant
    // geometry with first-azimuthal eigenvalue separation ΔB²/B² ≈
    // 0.05-0.10 (Lamarsh & Baratta ch. 5); the resulting tilt time
    // constant is dominated by delayed-neutron precursor lag, ≈ 100-200 s.
    // Radial first mode is closer to the fundamental (longer τ) because
    // the bare-cylinder J₁ root sits closer to J₀ than the cos(2θ)
    // azimuthal. gainAz/Rad pair: ±200 pcm asymmetry → ±10% tilt at
    // steady state.
    modes: {
      tauAzSec: 120,
      tauRadSec: 300,
      gainAz: 5e-4,
      gainRad: 5e-4,
    },
    // III.10 — Regenerative feedwater heater train. Westinghouse 4-loop
    // plants heat condensate from the condenser hotwell (~38 °C) to a
    // final feedwater temperature of ~226 °C through a cascade of
    // extraction-steam heaters: 3 LP heaters, the deaerator, 2 HP heaters.
    // Each stage taps steam from a turbine extraction point, so the
    // heating duty scales with turbine load. designTempK is derived in
    // state.js as condenserTempC + Σ designRiseK — it is the calibration
    // anchor for plant.js's hFg_eff term (hFg_eff == hFg at design FW
    // temp, so the wave-2 secondary equilibrium holds bit-for-bit at
    // init). cpJPerKgK is subcooled-water specific heat at ~190 °C / 7 MPa.
    // lagTauSec is the heater-train metal + water thermal inertia.
    // Stage rises sum to 188 K → 38 + 188 = 226 °C design FW temp.
    // References: Westinghouse FSAR Ch 10.4.7; El-Wakil "Powerplant
    // Technology" §3 (regenerative Rankine feedwater heating).
    feedwater: {
      condenserTempC: 38,
      cpJPerKgK: 4500,
      lagTauSec: 40,
      stages: [
        { name: 'LP-1',      designRiseK: 22 },
        { name: 'LP-2',      designRiseK: 28 },
        { name: 'LP-3',      designRiseK: 30 },
        { name: 'Deaerator', designRiseK: 37 },
        { name: 'HP-6',      designRiseK: 35 },
        { name: 'HP-7',      designRiseK: 36 },
      ],
    },
    // III.11 — Main feedwater + condensate pump train. 2× ~63% MFW pumps
    // (each 1450 kg/s; 2 give ~26% margin over the ~2300 kg/s full-power
    // FW flow this SG model actually runs) and 3× condensate pumps sized
    // so any 2 cover full flow. Both are large NON-SAFETY loads — they die
    // on loss of offsite power and are NOT picked up by the EDGs. MFW
    // pumps take suction downstream of the condensate pumps; losing 2 of 3
    // condensate pumps starves the MFW suction and trips them on NPSH
    // after npshTripDelaySec. The head curve is flat to the SG-pressure
    // knee then parabolic to the shutoff head. References: Westinghouse
    // FSAR Ch 10.4.7; NUREG-0611.
    feedwaterPumps: {
      mfwPumpCount: 1,               // collapsed from 2 (usability)
      mfwRatedFlowKgPerS: 2900,      // 2× — full-flow single pump
      mfwKneePressureMPa: 8.5,
      mfwShutoffPressureMPa: 13.0,
      condPumpCount: 1,              // collapsed from 3
      condRatedFlowKgPerS: 3900,     // 3× — full-flow single pump
      npshTripDelaySec: 5,
    },
    // III.12 — SG tube bundle: plugging + tube rupture (SGTR). A
    // Westinghouse Model-F SG has ~3592 U-tubes; plants run with a few
    // percent plugged for support (degraded / leaking tubes taken out of
    // service). Plugging degrades the primary→secondary heat transfer:
    // plant.js scales htLoop by (1−plugged)/(1−baseline), anchored at the
    // baseline so the init state is unchanged (critical-by-construction).
    // A tube RUPTURE (scenario/operator injected) opens a primary→secondary
    // leak path — leakRate = coeff·sqrt(P_primary − P_sg), ~20 kg/s at the
    // ~8.5 MPa design ΔP. The leak debits RCS inventory and floods the
    // affected SG (which then carries radioactive primary water — the SGTR
    // hazard). It is self-limiting: as the pressurizer depressurizes the
    // ΔP shrinks, so primary depressurization to the SG pressure is the
    // mitigation. References: Ginna 1982, Indian Point-2 1991 SGTR events;
    // NUREG-0844 (SGTR generic study); Westinghouse FSAR Ch 5.4.2.
    sgTubes: {
      tubesPerSg: 3592,
      baselinePluggedFraction: 0.04,
      ruptureLeakCoeffKgPerSPerSqrtMPa: 7.0,
    },
    // III.13 — Staged turbine + synchronous generator. The available heat
    // drop is hg(sgP) (IAPWS-IF97) down to condenserEnthalpyJPerKg (the
    // LP-exhaust enthalpy at ~5 kPa condenser vacuum). turbineEfficiency is
    // the lumped calibration anchor (stage isentropic effs × realised
    // fraction of the ideal drop) — set so design steam (~2274 kg/s) gives
    // the ~1150 MWe nameplate. hpWorkFraction splits the mechanical power
    // for the HP/LP stage readouts. rotorInertiaSec is the H constant
    // (stored kinetic energy ÷ rated power, ~6-9 s for a large TG set);
    // it sets the load-rejection overspeed rate. overspeedTripPU is the
    // mechanical-overspeed SCRAM. reactiveSensitivity maps generator field
    // current (excitation) to reactive power. References: El-Wakil
    // "Powerplant Technology" Ch 5-6; Kundur "Power System Stability" Ch 3.
    turbine: {
      hpWorkFraction: 0.42,
      condenserEnthalpyJPerKg: 2.15e6,
      turbineEfficiency: 0.83,
      generatorEfficiency: 0.985,
      rotorInertiaSec: 8,
      overspeedTripPU: 1.10,
      governorBandPU: 0.02,
      reactiveSensitivityMVARperPU: 2000,
    },
  }),

  rbmk: Object.freeze({
    id: 'rbmk',
    name: 'RBMK',
    longName: 'RBMK-1000 (graphite-moderated boiling-water channel reactor)',
    nominalPowerMWth: 3200,
    nominalPowerMWe: 1000,
    axialNodes: 20,
    coreHeight: 7.0,
    Lambda: 1.0e-4,                  // slower neutron lifetime due to graphite moderation
    beta: BETA_U235,
    lambda: LAMBDA_U235,
    betaTotal: BETA_TOTAL_U235,
    // I.9 — see PWR comment. RBMK uses the same U-235 ANS-5.1 fit; a future
    // scenario could override to 'ans-5.1-conservative' for SAR-style runs.
    decayHeatModel: 'ans-5.1',
    alphaFuel:      -1.2e-5,         // Doppler, weak
    alphaModerator: -1.5e-5,         // graphite temperature coefficient, weak
    moderatorFeedbackState: 'graphite',
    xenonWorthPcmAtEq: -2400,
    // Void coefficient is POWER-DEPENDENT — positive at low power, negative at high power.
    // Returns 1/(fractional void); fed power as fraction of nominal.
    alphaVoid:      (powerFrac) => {
      // Empirical fit: ~+4 pcm/% void at 7% power, transitioning to ~-1 pcm/% void at 100%.
      const a = 4.5e-3 * (1 - powerFrac) - 1.0e-3 * powerFrac;
      return a; // ≈ +0.0045 at p=0, -0.001 at p=1, per fractional void
    },
    Dz: 1.5e-3,
    rodWorthPcmTotal: 5000,
    rodWorth: rbmkRodWorth,
    rodSpeed: 0.0025,
    scramSpeed: 0.05,                // SLOW SCRAM — 18-21 s full insertion
    rodTipPositiveEffect: true,
    primaryTopology: 'direct',
    circulatingPrecursors: false,
    coolantInletTempK: 270 + 273.15,
    coolantOutletTempK: 284 + 273.15,
    pressurizerPressureMPa: 6.5,     // drum separator pressure
    coolantMassFlowKgPerS: 10500,
    fuelMassKg: 190000,              // UO₂ in 1661 channels
    coolantMassKg: 100000,
    graphiteMassKg: 1700000,         // huge graphite stack
    heatCapFuel: 300,
    heatCapCoolant: 4800,
    heatCapGraphite: 900,
    // I.3 — RBMK-1000: 1661 fuel channels × 18 rods × ~13.6 mm OD × ~6.86 m
    // active length ≈ 8800 m². Bulk coolant reaches saturation in the upper
    // half of the channel (direct cycle), so the JL film enhancement fires
    // at full strength there and pulls peak T_fuel down by ~100-200 K vs the
    // pre-I.3 single-phase-only model. htCoeff itself is unchanged.
    heatTransferAreaM2: 8800,
    htCoeff: 3.0e7,                  // RBMK has lower ΔT due to boiling latent heat
    // Three-node thermal stack (see PWR comment). RBMK Zircaloy mass: 1661
    // channels × 18 rods × ~13.6 mm OD × 0.9 mm thick × 6.86 m active ×
    // ρ_Zr ≈ 6500 kg/m³ → ~50000 kg total cladding mass.
    pelletResistanceFraction: 0.85,
    cladMassKg: 50000,
    cladHeatCapJPerKgK: 330,
    // I.2 — CHF / DNBR calibration. RBMK runs near saturation through the
    // upper half of every channel — quality climbs to ~14% at the outlet
    // and the (1-X) factor in the Bowring kernel cuts CHF substantially
    // there. flowAreaM2 = total subchannel area (1661 channels × ~80 mm²
    // each ≈ 0.13 m², lumped to ~1.5 m² for the simulator's averaged
    // single-channel representation); hotChannelFactor lower than PWR
    // because RBMK has a flatter radial flux profile by design.
    // chfScaling tuned for DNBR_min ≈ 1.5-2.0 at design steady state —
    // RBMK runs closer to dryout by design than a PWR.
    flowAreaM2: 1.5,
    hotChannelFactor: 1.7,
    chfScaling: 8.5e4,
    sgPrimaryToSecondaryHt: 0,       // direct cycle, no SG
    sgSecondaryPressureMPa: 6.5,
    turbineValveOpen: 1.0,
    nominalGridLoadMW: 1000,
    defaultAccelLow: 1,
    // RBMK starts with rods at 0.85 — well past the "rod insertion adds positive
    // ρ via graphite tip" zone (which crosses zero around rod=0.815 with current
    // c_g/c_b calibration) and into the boron-dominant regime. From here, the
    // LAR has CORRECT-SIGN bidirectional authority: inserting more rod adds
    // negative ρ (damps positive excursions), withdrawing adds positive ρ
    // (damps droops). Real plants maintain ORM (operating reactivity margin)
    // by keeping rods 30-40% inserted at full power. The rhoOffset in state.js
    // cancels the rod ρ at init so the reactor stays critical-by-construction.
    initialRodFrac: 0.85,
    // II.1 — RBMK ran at substantially lower discharge BU than PWR (~22 GWd/tU
    // lifetime average for the original 1.8% enriched fuel; later upgrades to
    // 2.4% pushed this to ~26 GWd/tU). MOC ≈ 10 GWd/tU is the mid-cycle
    // operating state used for scenarios.
    initialBurnupMWdPerTU: 10000,
    burnupModel: 'rbmk',
    cycleBurnupLimitMWdPerTU: 26000,
    // II.3 — RBMK MCPs (main circulation pumps) have larger rotors than PWR
    // RCPs and a much higher coastdown inertia (the four pumps per side push
    // ~10000 kg/s each). Coastdown τ ≈ 30 s. NC is augmented by steam quality
    // in the upper risers (direct cycle); calibrated to ~6% × 10500 = 630
    // kg/s at decay heat: Q = 0.07 × 3200 = 224 MW = 2.24e8 W →
    // coeff = 630 / sqrt(2.24e8) ≈ 0.042. Reference: Lahey & Moody, "Thermal
    // Hydraulics of a BWR" §9 (BWR-class natural-circulation theory carries
    // directly to RBMK boiling channels).
    rcpCoastdownTauSec: 30,
    naturalCircCoeff: 0.042,
    // II.8 — Photoneutron yield. Slightly higher than PWR because commercial
    // reactor-grade graphite carries trace Be-9 (sub-ppm) which adds a small
    // Be(γ,n) channel on top of the D(γ,n) source from light water in the
    // pressure tubes. ~2× PWR — order-of-magnitude figure, no real
    // BNL/Kurchatov measurement to anchor against. Calibrated so the
    // post-scram subcritical floor lands near ~5×10⁻⁴ × P_nominal at +10 h
    // (higher than PWR — RBMK has larger Λ so deep-subcritical |α| is
    // smaller and the same source produces a higher floor). Note RBMK's
    // slow scram + positive void coefficient mean it doesn't actually cross
    // into deep-subcritical until well after rod insertion completes; the
    // photoneutron contribution is what holds the SR detector above its
    // floor through the late tail (10 h+).
    photoneutronYield: 2e-3,
    // RBMK LAR drives rods very fast in real plants — ~0.4 m/s in a 7m core
    // ≈ 0.057 frac/s ≈ 23× the manual shim rate. We push higher here because
    // RBMK void runaway has a ~50 ms time constant at +200 pcm; the LAR has
    // to be able to insert several pcm per substep.
    autoRod: {
      enabledDefault: true,
      gainRho: 1.0,
      gainPower: 400,
      servoMultiplier: 60,
    },
    // II.4 — Modal-expansion tunings. RBMK has a much larger graphite-
    // moderated core (12 m diameter × 7 m tall) with a longer neutron
    // migration length than PWR; this spreads asymmetric rod-bank
    // insertions over a wider radial footprint and slows the per-mode
    // relaxation. τ_az and τ_rad both ~70% longer than PWR; gain reduced
    // proportionally so the same ±200 pcm asymmetry produces a similar
    // steady-state tilt magnitude.
    modes: {
      tauAzSec: 200,
      tauRadSec: 400,
      gainAz: 4e-4,
      gainRad: 4e-4,
    },
    // III.10 — RBMK regenerative feedwater heating. The direct-cycle
    // RBMK condenses turbine exhaust and reheats it through a shorter
    // heater chain to a design feedwater temperature of ~165 °C (the
    // figure the wave-1 stepRbmkPlant hard-coded). Fewer stages than the
    // PWR — 2 LP heaters, deaerator, 1 HP heater. designTempK derived in
    // state.js = 40 + 125 = 165 °C. RBMK feedwater temperature feeds the
    // drum-inlet blend, so a feedwater-heater isolation cools the core
    // inlet directly — a sharper reactivity path than the PWR's.
    feedwater: {
      condenserTempC: 40,
      cpJPerKgK: 4400,
      lagTauSec: 35,
      stages: [
        { name: 'LP-1',      designRiseK: 30 },
        { name: 'LP-2',      designRiseK: 32 },
        { name: 'Deaerator', designRiseK: 33 },
        { name: 'HP-4',      designRiseK: 30 },
      ],
    },
  }),

  msr: Object.freeze({
    id: 'msr',
    name: 'MSR',
    longName: 'Molten Salt Reactor (MSRE-class, FLiBe + UF₄)',
    nominalPowerMWth: 8,             // MSRE was 8 MWth (tiny but realistic)
    nominalPowerMWe: 0,              // MSRE had no electric generation, but we'll add one
    axialNodes: 20,
    coreHeight: 1.6,                 // m
    Lambda: 4.0e-4,
    beta: BETA_U233,
    lambda: LAMBDA_U233,
    betaTotal: BETA_U233.reduce((a, b) => a + b, 0),
    // I.9 — Strictly speaking U-233 thermal fission has its own decay-heat
    // fit (Schrock or ANS-5.1's U-233 variant), but the U-235 ANS-5.1 fit
    // is a reasonable first approximation at MSRE-class powers (8 MWth) and
    // the off-gas Xe removal dominates fission-product behaviour anyway.
    // Documented here so the next pass can swap in a U-233-specific fit.
    decayHeatModel: 'ans-5.1',
    alphaFuel:      -1.1e-4,         // ENORMOUS Doppler — fuel expands and drops density
    alphaModerator: -3.0e-5,         // graphite moderator
    moderatorFeedbackState: 'graphite',
    xenonWorthPcmAtEq: -900,
    alphaVoid:      0,               // no voids in single-phase salt
    Dz: 5.0e-4,
    rodWorthPcmTotal: 1500,
    rodWorth: msrRodWorth,
    rodSpeed: 0.005,
    scramSpeed: 0.1,
    primaryTopology: 'msr',
    circulatingPrecursors: true,
    precursorLoopTransitSec: 16.7,   // MSRE loop transit time
    coreFlowFracOfLoop: 0.25,        // fraction of loop volume inside core
    coolantInletTempK: 635 + 273.15, // salt inlet (1175°F)
    coolantOutletTempK: 663 + 273.15,// salt outlet (1225°F)
    pressurizerPressureMPa: 0.5,     // atmospheric+a-bit
    coolantMassFlowKgPerS: 60,
    fuelMassKg: 5000,                // total fuel salt
    coolantMassKg: 0,                // fuel-in-coolant — single state
    graphiteMassKg: 4000,
    heatCapFuel: 1500,               // J/kg/K (molten salt is good)
    heatCapCoolant: 1500,
    heatCapGraphite: 1750,
    // I.3 — MSR has fuel-in-coolant (no clad surface), and the salt is
    // single-phase at 0.5 MPa with no boiling regime. The JL branch in
    // thermal.js is gated off for the fuel-in-coolant topology, so the area
    // value here is only carried for completeness / future extensibility.
    // Estimated from MSRE: ~50 m² wetted graphite-channel surface.
    heatTransferAreaM2: 50,
    htCoeff: 1.0e5,                  // 8 MW / 80K ΔT (MSRE-class)
    sgPrimaryToSecondaryHt: 1.0e5,
    intermediateLoopHt: 1.0e5,
    sgSecondaryPressureMPa: 5.0,
    turbineValveOpen: 1.0,
    nominalGridLoadMW: 0,
    freezePlugTempK: 922,            // 649°C melts the plug
    drainTankPassiveUaWPerK: 2.5e4,  // passive drain-tank cooling to cell air
    xenonOffGasRateS: 1 / 60,        // s⁻¹ removal rate (~60s e-fold noble-gas residence)
    defaultAccelLow: 1,
    // MSRE had one regulating rod; we start it slightly inserted so the LAR
    // can move both directions. Doppler is enormous here (-110 pcm/K) so the
    // open-loop is already very stable — gains stay conservative to avoid
    // overdriving (P-controller oscillation observed in tuning).
    initialRodFrac: 0.10,
    // II.1 — MSRs continuously refuel (UF₄ feed + off-gas + fissile separation),
    // so the steady-state operating point is structurally "fresh" — BU = 0 is
    // the right initial condition for an idealized MSR sandbox. A future
    // scenario could ramp burnup of the salt charge by setting this nonzero.
    initialBurnupMWdPerTU: 0,
    burnupModel: 'online-msr',
    cycleBurnupLimitMWdPerTU: 10000,
    // II.3 — MSR pumps are small (60 kg/s nominal); coastdown is short
    // (~5 s). MSRE natural-circulation testing (Haubenreich & Engel,
    // "MSRE Operation", ORNL-4396 §7) showed strong NC at low power because
    // hot salt density drops sharply with T (FLiBe β_th is ~2e-4 1/K, larger
    // than water at 300°C). Calibrated to ~12% × 60 = 7.2 kg/s at decay heat:
    // Q = 0.07 × 8 = 0.56 MW = 5.6e5 W → coeff = 7.2 / sqrt(5.6e5) ≈ 0.0096.
    rcpCoastdownTauSec: 5,
    naturalCircCoeff: 0.0096,
    // II.8 — Photoneutron yield, ~30-40× PWR. FLiBe explicitly contains Be-9
    // (~14 wt% Be), and the Be(γ,n)⁸Be reaction has a much lower threshold
    // (1.667 MeV) than D(γ,n) (2.225 MeV), so a much larger fraction of the
    // fission-product gamma spectrum couples through. MSRE measurements
    // (Briggs, ORNL-TM-732; Haubenreich & Engel ORNL-4396 §6) show
    // photoneutrons dominated the subcritical SR count rate after shutdown.
    // Calibrated so the post-scram subcritical floor lands near ~10⁻³ ×
    // P_nominal at 1 h (corresponds to ~8 kW residual fission for the 8 MWth
    // MSRE — substantially higher than PWR thanks to the Be-9 channel).
    // Note: MSR doesn't drive deep-subcritical on scram in the current sim
    // (huge Doppler + autoRod default OFF clamps it at low-power critical
    // rather than truly shut down), so the post-scram floor isn't a clean
    // single-number target here. The yield is set ~50× PWR per the Be-9
    // physics; verify via state.out.photoneutronSourceNps which tracks
    // decay heat linearly.
    photoneutronYield: 5e-2,
    // MSR default OFF: huge Doppler (-110 pcm/K) already self-regulates,
    // and the closed-loop P-controller drives the rod-fully-out → power
    // explosion → Doppler clamp pattern, which is worse than the open-loop
    // 13 MW droop. User can enable manually for fine-tuning at steady state.
    autoRod: {
      enabledDefault: false,
      gainRho: 0.3,
      gainPower: 40,
      servoMultiplier: 2,
    },
  }),
});

export const TYPE_IDS = Object.freeze(['pwr', 'rbmk', 'msr']);
