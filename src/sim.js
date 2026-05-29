// sim.js -- top-level physics orchestrator.
//
// One sim step, in dependency order:
//   reset flow/release accumulators → RPS → autopilot → circulation →
//   electrical / EDGs / aux cooling / SFP / CVCS → neutronics → modes →
//   thermal → DNBR → xenon → burnup → RCP seals → ECCS → SG tubes →
//   pressurizer → containment → AFW / feedwater pumps / feedwater heaters →
//   plant → turbine → detectors → loop/readout derivations → reactivity stack.

import { stepNeutronics, buildReactivityStack } from './physics/neutronics.js';
import { stepThermal } from './physics/thermal.js';
import { stepXenon } from './physics/xenon.js';
import { stepPlant } from './physics/plant.js';
import { stepRps } from './physics/rps.js';
import { stepAutopilot } from './physics/autopilot.js';
import { stepDetectors } from './physics/detectors.js';
import { computeDnbr } from './physics/chf.js';
import { stepBurnup, coreAverageBurnup, cycleLabel, excessRhoPcm } from './physics/burnup.js';
import { stepCirculation } from './physics/circulation.js';
import { stepPressurizer } from './physics/pressurizer.js';
import { stepRcpSeals } from './physics/rcp.js';
import { stepEccs } from './physics/eccs.js';
import { stepElectrical } from './physics/electrical.js';
import { stepEdgs } from './physics/edgs.js';
import { stepRbmkElectrical } from './physics/rbmk-electrical.js';
import { stepRbmkEccs } from './physics/rbmk-eccs.js';
import { stepRbmkAls } from './physics/rbmk-als.js';
import { stepRbmkAux } from './physics/rbmk-aux.js';
import { stepMsrAux } from './physics/msr-aux.js';
import { stepAuxCooling } from './physics/aux-cooling.js';
import { stepCvcs } from './physics/cvcs.js';
import { stepAfw } from './physics/afw.js';
import { stepModes } from './physics/modes.js';
import { stepContainment } from './physics/containment.js';
import { stepSfp } from './physics/sfp.js';
import { stepFeedwaterHeaters } from './physics/feedwater-heaters.js';
import { stepFeedwaterPumps } from './physics/feedwater-pumps.js';
import { stepSgTubes } from './physics/sg-tubes.js';
import { stepTurbine } from './physics/turbine.js';
import { advanceWithBudget } from './integrator.js';
import { RBMK_TOTAL_RODS } from './state.js';

export function step(state, dt) {
  // III.1 — Reset the per-step RCS external-flow accumulator. rcp.js (seal
  // leak, negative) and eccs.js (injection, positive) add their net flow
  // into this; pressurizer.js integrates it into state.rcsMassKg and folds
  // it into the surge term. Reset here so it's a clean per-step tally.
  state._rcsExternalFlowKgPerS = 0;
  // III.17 — Reset the per-step containment release accumulators. rcp.js
  // (seal LOCA), pressurizer.js (PRT rupture), and future LOCA scenarios add
  // release mass/energy; containment.js consumes them. The spray-draw /
  // sump-inflow accumulators are NOT reset here — they are written by
  // containment.js and read by eccs.js on the next step (one-step lag).
  state._containmentMassInflowKgPerS = 0;
  state._containmentEnergyInflowWperS = 0;
  // Wave-B — RBMK ALS steam-inflow accumulator (break / relief steam producers
  // add to it; rbmk-als.js consumes it). Reset each step like the PWR
  // containment accumulators above.
  state._rbmkAlsSteamInflowKgPerS = 0;
  // Order matters. RPS first so commands and trips apply to this step.
  // Autopilot runs after RPS (so it sees scramActive set on this step) but
  // before neutronics (so its rod change takes effect on this step's flux).
  stepRps(state, dt);
  stepAutopilot(state, dt);
  // II.3 — Circulation regime model. Computes primary mass flow as the
  // dominant of forced+coastdown vs natural circulation each step, populates
  // state.out.flow* readouts. Runs before thermal + plant because both
  // modules read state.out.flowMassRateKgPerS for their flow term. Neutronics
  // doesn't depend on flow so ordering vs stepNeutronics doesn't matter.
  stepCirculation(state, dt);
  // III.15 — DC + AC roll-up. Runs FIRST among the support systems so
  // edgs.js / aux-cooling.js / cvcs.js see this step's acAvailable /
  // dcAvailable flags. Reads previous-step state.edgs.runningCount to
  // break the DC↔EDG circular dependency (one-step lag is fine for
  // these slow systems). No-op for RBMK/MSR (T.electrical undef).
  stepElectrical(state, dt);
  // III.14 — EDGs. Runs after stepElectrical (needs DC control floor)
  // and before aux-cooling / cvcs / rcp / eccs (those read this step's
  // eccsBusEnergized / runningCount).
  stepEdgs(state, dt);
  // Wave-B — RBMK auxiliary AC + DREG diesels + TG rundown. Computes
  // state.rbmkElectrical.acAvailable; circulation.js gates the MCPs on it
  // (one-step lag, like the PWR DC↔EDG ordering). No-op for PWR/MSR.
  stepRbmkElectrical(state, dt);
  // Wave-B — RBMK ECCS then ALS. ECCS computes per-half injection (folded into
  // the drum balance by stepPlant later this step) and the pool draw; ALS
  // consumes the draw + any break/relief steam inflow and owns the suppression
  // pool. Run before neutronics/thermal so the injection lands this step.
  stepRbmkEccs(state, dt);
  stepRbmkAls(state, dt);
  // Wave-C — RBMK auxiliary circuits (graphite gas circuit, CPS rod cooling,
  // MFW pumps). Runs before stepThermal (sets the graphite over-heat term it
  // reads) and before stepPlant (sets mfwAvailable for the drum controller).
  stepRbmkAux(state, dt);
  // MSR-B — off-gas system + reactor-cell containment. Runs before stepXenon
  // (which reads msrOffGas.xeRemovalRateS for its sink). No-op for PWR/RBMK.
  stepMsrAux(state, dt);
  // III.19 — CCW + SW. After EDGs (needs AC) and before CVCS / rcp /
  // eccs (those read this step's ccw.available).
  stepAuxCooling(state, dt);
  // III.20 — Spent Fuel Pool. After stepAuxCooling (so this step's
  // state.ccw.available / outletTempK are current — the SFP HX rejects to
  // CCW) and after stepElectrical (so this step's acAvailable is current —
  // the SFP circulation pump is AC-powered). The SFP is fully decoupled from
  // the RCS, so its position relative to neutronics/thermal/pressurizer is
  // immaterial. No-op for RBMK/MSR (T.sfp undefined → sfp.js early-returns).
  stepSfp(state, dt);
  // III.3 — CVCS. After EDGs + aux-cooling (needs AC + CCW). Before rcp /
  // eccs because cvcs.sealInjectionAvailable replaces the wave-2 LOOP-
  // coupled stand-in those modules use.
  stepCvcs(state, dt);
  stepNeutronics(state, dt);
  // II.4 — Modal expansion. Runs AFTER stepNeutronics (so the fundamental
  // flux + state.out.fissionPowerMW are current — quadrantPower is
  // fundamental × per-quadrant amplitude / 4) and BEFORE stepThermal (so
  // per-quadrant power is exposed before any future radial thermal
  // coupling). For now thermal still reads the lumped fission power, but
  // the order matters when II.5 / II.9 split the 1D state radially.
  // No-op for MSR (T.modes undefined).
  stepModes(state, dt);
  stepThermal(state, dt);
  // I.2 — DNBR right after thermal so flux + voidFrac + temps are current.
  // rps.js reads state.out.dnbrMin on the NEXT step (one-substep lag); the
  // adaptive integrator keeps substeps short during transients so the lag
  // is sub-100ms in any practical scenario.
  computeDnbr(state);
  stepXenon(state, dt);
  // II.1 — Burnup accumulator. Advances per-node BU by fission power × dt,
  // flux-weighted across the axial profile. Coefficient scalings (β_eff,
  // Doppler) and excess-ρ are read live in neutronics from the resulting
  // state.burnup array, so the burn-in is self-consistent over long runs.
  stepBurnup(state, dt);
  // III.4 — RCP shaft-seal LOCA model. Runs AFTER stepThermal (so the
  // T_coolant is current for the seal pre-image temperature, even though
  // the simplified model doesn't read it yet) and BEFORE stepPressurizer
  // (so the pressurizer model picks up the reduced water inventory in the
  // same step the leak is debited). No-op for RBMK/MSR (T.rcpSeal undef).
  stepRcpSeals(state, dt);
  // III.5 + III.6 — ECCS. Runs AFTER stepRcpSeals (so the seal-LOCA leak
  // is already deposited into the containment sump and debited from
  // pressurizerWaterMass — eccs.js reads both for SI actuation logic and
  // for the sump-inventory accounting) and BEFORE stepPressurizer (so
  // injection inflow lands in pressurizerWaterMass on the same step that
  // the pressurizer level / pressure update consumes the inventory
  // change). No-op for RBMK/MSR (T.eccs undefined → eccs.js early-returns).
  stepEccs(state, dt);
  // III.12 — SG tube rupture / plugging. Runs AFTER stepEccs and BEFORE
  // stepPressurizer so a tube-rupture leak lands in this step's
  // _rcsExternalFlowKgPerS tally that pressurizer.js consumes. The leaked
  // mass is also added to the affected SG by stepPlant later this step.
  // No-op for RBMK/MSR (state.sgTubes null).
  stepSgTubes(state, dt);
  // III.2 — Dynamic pressurizer. Must run AFTER stepThermal (so T_hot is
  // current for the surge-rate calculation), AFTER stepRcpSeals (so leak
  // mass is already debited from pressurizerWaterMass), AFTER stepEccs
  // (so injection inflow is already credited to pressurizerWaterMass),
  // and BEFORE stepPlant (so plant.js sees the updated state.pressurizerP).
  // No-op for RBMK/MSR (T.pressurizer is undefined for those types).
  stepPressurizer(state, dt);
  // III.17 — PWR large-dry containment. Runs AFTER stepRcpSeals (so the
  // seal-LOCA release has been deposited into _containmentMassInflowKgPerS /
  // _containmentEnergyInflowWperS this step), AFTER stepEccs (so the sump
  // inventory eccs.js maintains is current — containment.js READS it), and
  // AFTER stepPressurizer (so any pressurizer PRT-rupture release routed
  // through the accumulators is already tallied). containment.js is the
  // single owner of state.containmentP / state.containmentT after init.
  // No-op for RBMK/MSR (T.containment undefined → early-return).
  stepContainment(state, dt);
  // III.8 — Auxiliary feedwater. Runs BEFORE stepPlant so the SG mass
  // balance in plant.js sees the current AFW flow this step. Reads
  // state.sgSecondaryLevel for the auto-start trigger (one-substep lag —
  // the auto-start setpoint sits well above the trip envelope, so the
  // lag doesn't matter operationally). No-op for RBMK/MSR (T.afw undef).
  stepAfw(state, dt);
  // III.11 — Main feedwater + condensate pumps. Runs BEFORE stepPlant so
  // its mfwCapacityKgPerS caps this step's FW-controller demand. Reads
  // last step's state.out.fwFlow for the NPSH check (one-step lag). No-op
  // for RBMK/MSR (state.feedwaterPumps null).
  stepFeedwaterPumps(state, dt);
  // III.10 — Feedwater heater train. Runs BEFORE stepPlant so the SG
  // energy balance (hFgEff) and the RBMK drum-inlet blend see this step's
  // feedwater temperature. Reads last step's generatorMWe for the
  // extraction-steam load factor (one-step lag — the heater train's own
  // 35-40 s thermal lag dominates). No-op for MSR (state.feedwater null).
  stepFeedwaterHeaters(state, dt);
  stepPlant(state, dt);
  // III.13 — Staged turbine + generator. Runs AFTER stepPlant, which
  // stores the turbine steam flow in state.out.turbineSteamFlow. Computes
  // the HP/LP stage power, generator real/reactive output, and rotor-speed
  // / overspeed dynamics. plant.js's pidValveControl reads last step's
  // generatorMWe (one-step lag inside the feedback loop). No-op for
  // RBMK/MSR (state.turbine null — they keep their inline generator calc).
  stepTurbine(state, dt);
  // I.4 — SR/IR/PR detector channels. Reads state.out.fissionPowerMW (set by
  // stepNeutronics) and writes lagged + noisy display values back to state.out
  // for the gauge layer.
  stepDetectors(state, dt);
  updateLoopOutputs(state, dt);
  buildReactivityStack(state);
  state.simTime += dt;
}

// I.1 — Derive the per-loop instrumentation outputs from current state. Runs
// at end of each step so plant.js's _coolantReturnT is already current. Pure
// readout computation; no state mutation outside state.out.
function updateLoopOutputs(state, dt) {
  const T = state.T;
  const N = state.N;
  const out = state.out;
  const tHot = state.T_coolant[N - 1];
  const tCold = state._coolantReturnT ?? T.coolantInletTempK;
  const designDt = T.coolantOutletTempK - T.coolantInletTempK;
  out.tHotK = tHot;
  out.tColdK = tCold;
  out.tAvgK = 0.5 * (tHot + tCold);
  out.deltaTLoopK = tHot - tCold;
  out.deltaTPowerFrac = designDt > 0 ? (tHot - tCold) / designDt : 0;
  // T_fuel is the pellet centerline (3-node thermal stack); this is the
  // peak across-the-rod ΔT (pellet → coolant), now spanning two series
  // resistances rather than one lumped node. Still meaningful as a
  // hot-channel proxy; DNBR (computed in chf.js) supersedes it for the
  // boiling-crisis safety analysis.
  let peak = 0;
  for (let k = 0; k < N; k++) {
    const d = state.T_fuel[k] - state.T_coolant[k];
    if (d > peak) peak = d;
  }
  out.peakDeltaFuelCoolantK = peak;

  // II.2 — Axial offset. (P_top − P_bot) / (P_top + P_bot) over the flux
  // profile. Symmetric init flux ≈ 0 at t=0; xenon oscillations push it
  // toward ±5%+ over hours. PWR Tech Spec LCO 3.2.4 band is ±5%.
  // floor(N/2) handles odd-N gracefully (PWR/RBMK/MSR all use N=20 today
  // so the boundary is exact).
  const mid = N >> 1;
  let pTop = 0;
  let pBot = 0;
  for (let k = 0; k < mid; k++) pBot += state.flux[k];
  for (let k = mid; k < N; k++) pTop += state.flux[k];
  const pTot = pTop + pBot;
  out.axialOffset = pTot > 0 ? (pTop - pBot) / pTot : 0;

  // III.1 — Multi-loop readouts (PWR only). rcsMassFrac is the live RCS
  // liquid inventory as a fraction of design — drops on a seal LOCA,
  // recovers on ECCS injection. loopFlowSpreadFrac is (max-min)/mean of the
  // per-loop primary flow: 0 when symmetric, climbs when an RCP trips or a
  // loop is isolated.
  if (state.loops) {
    // rcsMassFrac only applies to the PWR tracked-inventory model; RBMK has
    // loopCount:2 but rcsMassDesignKg 0 → leave it null (gauge renders N/A).
    if (state.rcsMassDesignKg > 0) {
      out.rcsMassFrac = state.rcsMassKg / state.rcsMassDesignKg;
    }
    let mMin = Infinity;
    let mMax = -Infinity;
    let mSum = 0;
    for (let l = 0; l < state.loops.length; l++) {
      const m = state.loops[l].massFlowKgPerS || 0;
      if (m < mMin) mMin = m;
      if (m > mMax) mMax = m;
      mSum += m;
    }
    const mMean = mSum / state.loops.length;
    out.loopFlowSpreadFrac = mMean > 1 ? (mMax - mMin) / mMean : 0;
  }

  // II.1 — Burnup readouts. coreBurnupAvg is the flux-weighted core mean;
  // cycleProgressFrac normalizes to a ~45 GWd/tU discharge horizon for the
  // BOC → EOC progress indication; cycleLabel buckets to BOC/MOC/EOC;
  // excessRhoBurnedPcm reports how much fuel-cycle ρ has been burned off
  // (relative to the loaded initial state — zero at t=0 by construction,
  // negative as depletion accumulates).
  if (state.burnup) {
    const buAvg = coreAverageBurnup(state);
    out.coreBurnupAvg = buAvg;
    out.cycleProgressFrac = Math.min(1, Math.max(0, buAvg / (T.cycleBurnupLimitMWdPerTU ?? 45000)));
    out.cycleLabel = cycleLabel(buAvg, T);
    const initPcm = out.excessRhoInitPcm ?? excessRhoPcm(buAvg, T);
    out.excessRhoBurnedPcm = excessRhoPcm(buAvg, T) - initPcm;
  }

  // I.6 — RBMK Operating Reactivity Margin. Worth-weighted equivalent rods:
  // remaining negative insertion worth / one average full-insertion rod.
  // Still a lumped bank model, but it follows the nonlinear graphite-tip /
  // boron-section shape instead of raw travel.
  // For PWR/MSR the concept doesn't apply — keep `out.orm` as the initial
  // null so the gauge can render N/A.
  if (T.id === 'rbmk') {
    let fullWorth = 0;
    let liveWorth = 0;
    for (let k = 0; k < N; k++) {
      const phi = state.flux[k] || 1;
      fullWorth += T.rodWorth(k, N, 1) * phi;
      liveWorth += T.rodWorth(k, N, state.rodBanks.regulating) * phi;
    }
    const oneRodWorth = fullWorth / Math.max(RBMK_TOTAL_RODS, 1);
    out.orm = oneRodWorth > 0 ? Math.max(0, (fullWorth - liveWorth) / oneRodWorth) : 0;
  }

  // I.5 — PWR Tave program. Linear in commanded grid load fraction (treated as
  // the operator's load-demand reference, equivalent to first-stage turbine
  // pressure feedforward on a real plant). Other reactor types have undefined
  // program endpoints and skip the computation, leaving out.tAvgProgramK null.
  if (T.tavgProgramFullC !== undefined && T.tavgProgramZeroC !== undefined) {
    const nominalLoad = T.nominalGridLoadMW || 1;
    let loadFrac = state.gridLoadMW / nominalLoad;
    if (loadFrac < 0) loadFrac = 0;
    else if (loadFrac > 1.1) loadFrac = 1.1;
    const Tprog_C = T.tavgProgramZeroC + loadFrac * (T.tavgProgramFullC - T.tavgProgramZeroC);
    out.tAvgProgramK = Tprog_C + 273.15;
  }

  // I.7 — Inverse-kinetics ρ diagnostic. Independent estimate of ρ from observed
  // flux dynamics: ρ_inv = β + Λ·(1/n)·(dn/dt) − (Λ/n)·Σ_g λ_g·C_g. Compared
  // against the constructive `out.reactivityPcm` (sum of per-node feedbacks); the
  // residual is near zero in steady state and signals numerical drift, modeling
  // error, or scenario-engine state injection.
  //
  // dn/dt is estimated via an EWMA on n with τ ≈ 1 s of sim time: in steady
  // state EWMA tracks n and dn/dt → 0, while during transients (n - EWMA)/τ is
  // a low-pass-filtered slope. The smoothing introduces a small bias on fast
  // ramps (~tens of pcm during 1$ insertions) but eliminates substep noise.
  if (out.reactivityInversePcm === undefined) out.reactivityInversePcm = 0;
  if (out.reactivityResidualPcm === undefined) out.reactivityResidualPcm = 0;
  if (out._invFluxEWMA === undefined) out._invFluxEWMA = out.fissionPowerMW / T.nominalPowerMWth;

  const n = out.fissionPowerMW / T.nominalPowerMWth;
  const tau = 1.0;
  const alpha = (dt > 0) ? (1 - Math.exp(-dt / tau)) : 0;
  out._invFluxEWMA = out._invFluxEWMA * (1 - alpha) + n * alpha;
  const dndt = (n - out._invFluxEWMA) / tau;

  if (n < 1e-6 || !Number.isFinite(n)) {
    out.reactivityInversePcm = NaN;
    out.reactivityResidualPcm = NaN;
  } else {
    let lamC = 0;
    for (let g = 0; g < 6; g++) {
      const C = state.precursors[g];
      let sum = 0;
      for (let k = 0; k < N; k++) sum += C[k];
      lamC += T.lambda[g] * (sum / N);
    }
    const rhoInv = T.betaTotal + T.Lambda * (dndt / n) - (T.Lambda / n) * lamC;
    out.reactivityInversePcm = rhoInv * 1e5;
    out.reactivityResidualPcm = out.reactivityInversePcm - out.reactivityPcm;
  }
}

export function advanceSim(state, wallDtSec) {
  if (!state.running) return 0;
  const accelDt = wallDtSec * state.accel;
  return advanceWithBudget(state, accelDt, step);
}

// Single-step advance, used by the toolbar step button. Ignores `running` so
// the operator can nudge the sim forward while paused. Uses the current accel
// so 1× steps a tenth of a second and 600× steps a minute, matching the speed
// dial. Returns the wall-clock seconds equivalent of the substep budget used.
export function stepSim(state, wallDtSec) {
  const accelDt = (wallDtSec ?? 0.1) * state.accel;
  return advanceWithBudget(state, accelDt, step);
}
