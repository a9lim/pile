// circulation.js -- regime-aware primary coolant mass-flow model.
//
// Wave 2.5 Phase II.3 — replaces the always-on forced-flow assumption with a
// three-regime model: FORCED (RCPs on), COASTDOWN (RCPs commanded off but
// inertia + decaying flow), NATURAL (buoyancy-driven by decay/fission heat).
// The three contributions are computed independently each step; the dominant
// driver wins via max(m_forced + m_coast, m_nc) so handoff between forced and
// natural circulation is smooth without a discontinuous mode switch.
//
// Wave 2.5 Phase III.1 — for PWR the model is per-loop: each of the L primary
// loops has its own RCP (cmd.rcpRunning[l]), coastdown latch, and natural-
// circulation share. The total core flow is the sum of per-loop flows, which
// is what thermal.js reads. Tripping one RCP coasts that loop down into NC
// while the other loops stay forced — the canonical asymmetric transient.
// RBMK/MSR keep the wave-2 single-loop model unchanged.
//
// Natural-circulation calibration target — fraction of nominal flow at
// decay-heat-only (P ≈ 0.07 · P_nominal, fresh post-scram):
//
//   PWR  ~4%   — Westinghouse 4-loop operating experience, ~3-5% typical
//                (see NUREG/CR-5535 SBO assessments, B&W Mark-B NC tests)
//   RBMK ~6%   — direct-cycle channels benefit from steam in upper risers
//                (Lahey & Moody, "Thermal Hydraulics of a BWR", §9)
//   MSR  ~12%  — hot salt density drops sharply with T; MSRE natural-
//                circulation tests confirmed strong NC at low power
//                (Haubenreich & Engel, "MSRE Operation", ORNL-4396, §7)
//
// The buoyancy law mass_flow_nc = k · cbrt(Q / Q_ref) drops out of a one-
// dimensional Boussinesq integral around the loop:
//
//     (ρ_cold − ρ_hot) · g · H_loop  =  ½ · K_loss · (ṁ / A)² / ρ
//
// where (ρ_cold − ρ_hot) ∝ β_th · ΔT and ΔT ∝ Q / ṁ for a fixed c_p, giving
// ṁ³ ∝ Q · g · H · β_th · A² / K_loss. The per-type geometry (core height,
// loop hydraulic resistance, coolant β_th, c_p) is folded into a single
// `naturalCircCoeff` legacy calibration anchor — no separate geom term needed
// because the operating-experience flow fraction at decay heat is the target,
// not a first-principles K-loss budget. Runtime preserves that anchor and uses
// cubic scaling away from it.

// Below this commanded coolant-flow fraction the pumps are treated as
// "tripped" — coastdown kinematics take over (forced + nc → coast + nc).
// Threshold chosen so a normal slider drag past 5% still reads as the user
// intentionally stopping the pumps, not a fluctuation in operator command.
const NC_HANDOFF_FRAC = 0.05;

// Forced vs natural dominance margin for regime classification. The thermal-
// hydraulic flow is whatever max() picks; this margin only affects the
// operator-facing string ("forced" / "natural" / "transition").
const REGIME_DOMINANCE_MARGIN = 1.5;

export function stepCirculation(state, dt) {
  if (state.loops) {
    stepCirculationMultiLoop(state, dt);
    return;
  }
  stepCirculationSingleLoop(state, dt);
}

// III.1 — Per-loop circulation for PWR. Each loop's forced + coastdown flow
// is independent (its own RCP); natural circulation is a core-wide buoyancy
// drive shared equally across the non-isolated loops. Total core flow is the
// sum — that is what thermal.js / plant.js read via state.out.flowMassRateKgPerS.
function stepCirculationMultiLoop(state, dt) {
  const T = state.T;
  const loops = state.loops;
  const L = loops.length;
  const perLoopDesign = T.coolantMassFlowKgPerS / L;
  const tau = T.rcpCoastdownTauSec ?? 10;
  const cmdRcp = state.cmd.rcpRunning || [];
  const cmdIso = state.cmd.loopIsolated || [];

  // Core-wide natural circulation from total core heat (fission + decay).
  const Q_core_W = Math.max((state.out?.totalCorePowerMW ?? 0) * 1e6, 0);
  const coeff = T.naturalCircCoeff ?? 0;
  const m_nc_total = naturalCirculationFlow(T, Q_core_W);

  // Count loops that can carry NC flow (not isolated). The buoyant head is
  // shared equally — an isolated loop's valves are shut so it circulates
  // nothing.
  let nActive = 0;
  for (let l = 0; l < L; l++) {
    if (!(cmdIso[l] === true)) nActive++;
  }
  if (nActive < 1) nActive = 1;
  const m_nc_loop = m_nc_total / nActive;

  let m_total = 0;
  let m_pumped_total = 0;
  for (let l = 0; l < L; l++) {
    const loop = loops[l];
    loop.isolated = cmdIso[l] === true;
    loop.rcpRunning = !(cmdRcp[l] === false);
    if (loop.isolated) {
      // Isolated loop: shut valves, no circulation. Coastdown latch reset so
      // re-opening the loop with the RCP on starts clean.
      loop.coastdownFlow = 0;
      loop.massFlowKgPerS = 0;
      continue;
    }
    // Operator-commanded flow fraction for THIS loop: the global slider
    // (state.coolantFlowFrac) gated by this loop's RCP on/off.
    const loopCmdFrac = state.coolantFlowFrac * (loop.rcpRunning ? 1 : 0);
    let m_forced = 0;
    let m_coast = 0;
    if (loopCmdFrac > NC_HANDOFF_FRAC) {
      // RCP on: latch the live fraction, no separate coast term.
      loop.coastdownFlow = loopCmdFrac;
      m_forced = perLoopDesign * loopCmdFrac;
    } else {
      // RCP tripped: exponential coastdown of the captured flow.
      loop.coastdownFlow *= Math.exp(-dt / Math.max(tau, 1e-3));
      m_coast = perLoopDesign * loop.coastdownFlow;
    }
    const m_pumped = m_forced + m_coast;
    const m_loop = Math.max(m_pumped, m_nc_loop);
    loop.massFlowKgPerS = m_loop;
    m_total += m_loop;
    m_pumped_total += m_pumped;
  }

  // Regime classification on the totals.
  let regime;
  if (m_pumped_total > m_nc_total * REGIME_DOMINANCE_MARGIN) regime = 'forced';
  else if (m_nc_total > m_pumped_total * REGIME_DOMINANCE_MARGIN) regime = 'natural';
  else regime = 'transition';

  state.out.flowMassRateKgPerS = m_total;
  state.out.flowFracOfNominal = T.coolantMassFlowKgPerS > 0
    ? m_total / T.coolantMassFlowKgPerS
    : 0;
  state.out.naturalCircFlowKgPerS = m_nc_total;
  state.out.flowRegime = regime;
}

// Single-loop circulation for RBMK / MSR (which have no state.loops). See
// file header for the regime model.
function stepCirculationSingleLoop(state, dt) {
  const T = state.T;

  // Forced (commanded) flow contribution
  const m_forced = T.coolantMassFlowKgPerS * state.coolantFlowFrac;

  // Coastdown bookkeeping. While the operator is commanding pumps on, the
  // coastdown integrator stores the current forced flow fraction so that the
  // moment pumps drop below NC_HANDOFF_FRAC we have a defined starting flow
  // to decay from. When pumps come back on we reset to 0 — no double-counting.
  if (state._rcpCoastdownFlow === undefined) state._rcpCoastdownFlow = 0;
  if (state.coolantFlowFrac > NC_HANDOFF_FRAC) {
    // Pumps on (or coasting back up). Latch the live fraction, no decay.
    state._rcpCoastdownFlow = state.coolantFlowFrac;
    // Forced regime: coast contribution folds into m_forced via the fact that
    // state.coolantFlowFrac is already the operator's commanded flow. The
    // coastdown variable only matters once pumps drop below the handoff.
  } else {
    // Pumps off — exponential decay of the captured flow. Time constant
    // T.rcpCoastdownTauSec controls how long the rotor + entrained fluid
    // continue to push flow. PWR ~10 s (typical 4-loop RCP), RBMK ~30 s
    // (bigger MCP rotors), MSR ~5 s (small mechanical pumps).
    const tau = T.rcpCoastdownTauSec ?? 10;
    state._rcpCoastdownFlow *= Math.exp(-dt / Math.max(tau, 1e-3));
  }

  // Coast contribution is separate from m_forced ONLY when pumps are
  // commanded off — otherwise the operator's commanded flow IS the live flow.
  // This keeps the steady-state pumps-on regime as a clean
  // m_total = m_forced, no spurious coast term added.
  const m_coast = state.coolantFlowFrac > NC_HANDOFF_FRAC
    ? 0
    : T.coolantMassFlowKgPerS * state._rcpCoastdownFlow;

  // Natural circulation. Total core heat (fission + decay) drives buoyancy.
  // If updateLoopOutputs hasn't run yet (first step), fall back to the
  // initial out.totalCorePowerMW set in state.js.
  const Q_core_W = Math.max((state.out?.totalCorePowerMW ?? 0) * 1e6, 0);
  const m_nc = naturalCirculationFlow(T, Q_core_W);

  // Dominant driver wins. Forced + coast and natural never additively stack
  // in real loops — buoyancy contributes negligibly while forced flow is
  // running (the pumped pressure rise dwarfs the natural head), and once
  // pumps are gone, natural takes over the loop without "leftover" forced
  // contribution beyond the coastdown term.
  const m_pumped = m_forced + m_coast;
  const m_total = Math.max(m_pumped, m_nc);

  // Regime classification for the operator gauge.
  let regime;
  if (m_pumped > m_nc * REGIME_DOMINANCE_MARGIN) regime = 'forced';
  else if (m_nc > m_pumped * REGIME_DOMINANCE_MARGIN) regime = 'natural';
  else regime = 'transition';

  state.out.flowMassRateKgPerS = m_total;
  state.out.flowFracOfNominal = T.coolantMassFlowKgPerS > 0
    ? m_total / T.coolantMassFlowKgPerS
    : 0;
  state.out.naturalCircFlowKgPerS = m_nc;
  state.out.flowRegime = regime;
}

function naturalCirculationFlow(T, Q_core_W) {
  const coeff = T.naturalCircCoeff ?? 0;
  const q = Math.max(Q_core_W, 0);
  if (!(coeff > 0) || q <= 0) return 0;
  // Preserve the existing per-type calibration at the canonical post-scram
  // decay-heat point, but use the cubic buoyancy scaling derived above away
  // from that anchor instead of sqrt(Q).
  const qRef = 0.07 * (T.nominalPowerMWth ?? 0) * 1e6;
  if (!(qRef > 0)) return coeff * Math.cbrt(q);
  const mRef = coeff * Math.sqrt(qRef);
  return mRef * Math.cbrt(q / qRef);
}
