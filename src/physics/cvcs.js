// cvcs.js — III.3 Chemical and Volume Control System.
//
// Westinghouse-class PWR auxiliary system that does THREE jobs at once on
// the primary side:
//
//   1. Volume control — charging pumps inject water into the RCS to make
//      up for letdown + identified leakage + seal-injection draw, and
//      level control on the pressurizer is by charging-vs-letdown
//      balance under the pressurizer level program.
//
//   2. Chemistry control — letdown flow goes through a mixed-bed
//      demineralizer to remove fission/corrosion products, then through
//      the volume control tank (VCT) where it can be deborated /
//      borated by the boric acid blender on its way back to the
//      charging suction.
//
//   3. RCP seal injection — a small fraction of charging-pump discharge
//      (~8 gpm × 4 pumps = ~32 gpm total) is tapped off ahead of the
//      regenerative HX and routed down the RCP seal annulus. This is
//      ONE of the two cooling streams the RCP shaft seals depend on
//      (the other being CCW thermal-barrier cooling). Loss of seal
//      injection alone is recoverable; loss of BOTH streams initiates
//      the SECY-93-087 "21-21-21" failure path tracked in rcp.js.
//
// Scope (III.3):
//   - Centrifugal charging pump(s) (~75 gpm each at the pressurizer
//     setpoint; count from T.cvcs.chargingPumpCount). Pump 0 runs
//     normally, the rest are standby. SI signal cross-trips them all
//     to deliver to the SI header (mirrors HHSI in eccs.js because
//     they are physically the same pumps).
//   - Letdown line: control valve modulating ~75 gpm normal, through
//     the letdown HX (CCW heat sink) and the demin into the VCT.
//     Loss of CCW isolates letdown automatically (TIA / interlock).
//   - Boric acid blender: mixes from the boric acid tank (BAT, 4400 ppm)
//     and the reactor makeup water tank (RMWT, demin water, 0 ppm) to
//     produce a commanded boron concentration. Boration / dilution
//     timescale is the VCT residence time (~5 min) lumped into a
//     single time constant.
//   - Modes: AUTO (matches charging to letdown for level), DILUTE
//     (full demin), BORATE (full BAT), MAKEUP (manual). Operator
//     command via cmd.cvcsMode.
//
// Boron coupling:
//   This module REPLACES the wave-2 free-knob boron slider. The slew
//   from current `state.boronPpm` toward `cmd.cvcsBoronTargetPpm` lands
//   in here through the VCT residence-time + makeup blender model. The
//   rate is not fixed: one charging pump gives a ~5 minute time constant,
//   and additional pumps shorten it. The UI writes both the CVCS target
//   and the legacy `cmd.boronTarget` mirror while old tests/scenarios
//   migrate.
//
// Failure modes (operator / scenario knobs):
//   - cmd.cvcsChargingPumpManualStop[i]  — bool array length 3
//   - cmd.cvcsChargingPumpFault[i]       — string array {'none','trip'}
//   - cmd.cvcsLetdownIsolated            — bool, manual letdown isolation
//
// References:
//   - Westinghouse FSAR Chapter 9.3.4 (Chemical and Volume Control)
//   - WCAP-13045 "RCP Seal Injection Performance"
//   - NRC Inspection Manual 1245 (CVCS operability)
//   - Glasstone & Sesonske, "Nuclear Reactor Engineering" 4th ed., §11
//
// Module ordering in sim.js: AFTER stepEdgs + stepAuxCooling (so AC and
// CCW are current this step) and BEFORE stepRcpSeals + stepEccs (so
// they see this step's `cvcs.sealInjectionAvailable` flag instead of
// the legacy LOOP-coupled stand-in).

// Per-pump rated flow at the pressurizer-setpoint head. Real Westinghouse
// charging pumps deliver ~150 gpm each (PD-style on older plants, centrifugal
// on newer); we use 75 gpm so 1 pump satisfies normal charging+letdown
// balance and the other two are spare capacity for SI / boration.
const CHARGING_PUMP_FLOW_GPM = 75;

// Charging pump head curve same shape as HHSI in eccs.js — parabolic with
// a 17 MPa shutoff, runout at zero RCS P. They ARE the HHSI pumps.
const CHARGING_PUMP_SHUTOFF_MPA = 17.0;
const CHARGING_PUMP_RUNOUT_GPM = 250; // matches eccs.js HHSI runout

// Per-pump seal injection draw — Westinghouse 4-loop typical ~8 gpm/pump
// × 4 RCPs = 32 gpm. Comes out of charging discharge before the regen HX.
const SEAL_INJECTION_GPM_TOTAL = 32;
// Seal injection adequacy threshold. If charging output minus seal draw
// drops below this, seals are considered "lost" downstream.
const SEAL_INJECTION_MIN_GPM = 4; // ~1 gpm/pump minimum for cooling

// Letdown nominal flow. Symmetric with normal charging so RCS inventory
// is balanced (one charging pump matches one letdown valve flow path).
const LETDOWN_NOMINAL_GPM = 75;

// Boric acid tank concentration (BAT) and demin water tank (RMWT, 0 ppm).
const BAT_CONCENTRATION_PPM = 4400;
const RMWT_CONCENTRATION_PPM = 0;

// Boration time constant — VCT volume / one charging pump flow ≈ ~5 min
// residence. Replaces the old direct scalar slew with a first-order
// blender response; multiple running pumps divide the effective time constant.
const BORON_TAU_SEC = 300;

// gpm → kg/s for cold borated water (ρ ≈ 998 kg/m³).
const GPM_TO_KG_PER_S = 0.0631;

// Warning thresholds.
const CVCS_LOSS_LATCH_SEC = 5;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Per-step CVCS advancement. PWR-only — RBMK / MSR omit T.cvcs and the
 * module early-returns.
 *
 * Reads:
 *   - state.electrical?.acAvailable (from electrical.js)
 *   - state.ccw?.available (from aux-cooling.js — drives letdown HX)
 *   - state.eccs?.siActuated (cross-trips the standby charging pumps)
 *   - state.cmd.cvcsMode in {'auto','dilute','borate','makeup'}
 *   - state.cmd.cvcsBoronTargetPpm
 *   - state.cmd.cvcsChargingPumpManualStop[i]
 *   - state.cmd.cvcsChargingPumpFault[i]
 *   - state.cmd.cvcsLetdownIsolated
 *
 * Writes:
 *   - state.cvcs.sealInjectionAvailable (consumed by rcp.js)
 *   - state.cvcs.chargingPumpRunningCount, totalChargingFlowKgPerS
 *   - state.cvcs.letdownFlowKgPerS, letdownIsolated
 *   - state.cvcs.makeupBoronPpm (instantaneous blender output)
 *   - state.cvcs.lossAccumSec
 *   - state.boronPpm (drives the slew through the VCT model)
 */
export function stepCvcs(state, dt) {
  const T = state.T;
  if (!T.cvcs) return;
  const c = state.cvcs;
  if (!c) return; // defensive
  const cfg = T.cvcs;

  // === Power + cooling availability ===
  const acOk = state.electrical
    ? state.electrical.acAvailable === true
    : !state.cmd.lossOfOffsitePower;
  const ccwOk = state.ccw ? state.ccw.available === true : true;
  const siActuated = state.eccs ? state.eccs.siActuated === true : false;

  // === Per-pump status ===
  // Pump 0 is the duty pump (always demanded if AC up + not faulted/stopped).
  // Any further pumps are standby — start on SI signal or operator manual start.
  const stops = state.cmd.cvcsChargingPumpManualStop || [];
  const faults = state.cmd.cvcsChargingPumpFault || [];
  const manualStarts = state.cmd.cvcsChargingPumpManualStart || [];
  let runningCount = 0;
  for (let i = 0; i < c.chargingPumps.length; i++) {
    const u = c.chargingPumps[i];
    const fault = faults[i] || u.faultReason || 'none';
    if (fault !== 'none' && u.faultReason === 'none') {
      u.faulted = true;
      u.faultReason = fault;
    }
    const isDuty = i === 0;
    const wantsRun = !u.faulted && !stops[i] && acOk
      && (isDuty || siActuated || !!manualStarts[i]);
    u.running = wantsRun;
    if (wantsRun) runningCount += 1;
  }
  c.chargingPumpRunningCount = runningCount;

  // === Charging discharge flow ===
  // Parabolic head curve, summed across running pumps. The pressurizer
  // setpoint sets the operating P, so flow per pump is roughly
  // CHARGING_PUMP_FLOW_GPM at design.
  const headRatio = state.pressurizerP / (cfg.chargingPumpShutoffMPa ?? CHARGING_PUMP_SHUTOFF_MPA);
  const headFactor = Math.max(0, 1 - headRatio * headRatio);
  // At design P (15.5 MPa) headFactor ≈ 0.166 → with 250 gpm runout,
  // delivered ≈ 41 gpm/pump. We renormalize so 1 duty pump at design P
  // gives the rated CHARGING_PUMP_FLOW_GPM (75 gpm). The renormalization
  // bakes in the regen-HX backpressure that real plants subtract from
  // the pump curve before delivery.
  const designHeadFactor = 1 - Math.pow((cfg.designRcsPressureMPa ?? 15.5) / CHARGING_PUMP_SHUTOFF_MPA, 2);
  const renorm = designHeadFactor > 0
    ? (cfg.chargingPumpRatedFlowGpm ?? CHARGING_PUMP_FLOW_GPM) / (CHARGING_PUMP_RUNOUT_GPM * designHeadFactor)
    : 0;
  const perPumpGpm = CHARGING_PUMP_RUNOUT_GPM * headFactor * renorm;
  const totalChargingGpm = perPumpGpm * runningCount;
  c.totalChargingFlowGpm = totalChargingGpm;
  c.totalChargingFlowKgPerS = totalChargingGpm * GPM_TO_KG_PER_S;

  // === Seal injection branch ===
  // 32 gpm tapped off charging-pump discharge. Available iff at least
  // one charging pump is running AND the residual after seal draw is
  // above the minimum cooling figure.
  const sealDrawGpm = SEAL_INJECTION_GPM_TOTAL;
  const sealResidualGpm = totalChargingGpm - sealDrawGpm;
  const sealAvail = runningCount > 0 && sealResidualGpm >= 0;
  // Even with 0 charging output, the seal-injection branch is unavailable
  // if no pump is running. The "above minimum" check protects against the
  // pathological case where head curve drives delivery to 1 gpm and we'd
  // otherwise mark seals available.
  c.sealInjectionAvailable = runningCount > 0
    && totalChargingGpm > SEAL_INJECTION_MIN_GPM;
  c.sealInjectionFlowGpm = sealAvail ? Math.min(sealDrawGpm, totalChargingGpm) : 0;

  // === Letdown line ===
  // Letdown is isolated automatically on loss of CCW (letdown HX has no
  // heat sink), or manually via the operator override. Demin/VCT are
  // assumed available when letdown is flowing.
  const letdownIsolated = !ccwOk
    || !!state.cmd.cvcsLetdownIsolated;
  c.letdownIsolated = letdownIsolated;
  c.letdownFlowGpm = letdownIsolated ? 0 : LETDOWN_NOMINAL_GPM;
  c.letdownFlowKgPerS = c.letdownFlowGpm * GPM_TO_KG_PER_S;

  // === Boric acid blender ===
  // Mode-dependent makeup composition. AUTO and MAKEUP both blend from
  // BAT + RMWT to hit cmd.cvcsBoronTargetPpm; DILUTE forces 100 % RMWT;
  // BORATE forces 100 % BAT. The blender output then drives the
  // first-order approach of state.boronPpm to the target via the VCT
  // residence-time τ.
  const mode = state.cmd.cvcsMode || 'auto';
  const target = clamp(state.cmd.cvcsBoronTargetPpm ?? state.boronPpm, 0, BAT_CONCENTRATION_PPM);
  let blenderOut;
  if (mode === 'dilute') blenderOut = RMWT_CONCENTRATION_PPM;
  else if (mode === 'borate') blenderOut = BAT_CONCENTRATION_PPM;
  else blenderOut = target; // AUTO / MAKEUP — blender perfectly trims to target
  c.makeupBoronPpm = blenderOut;
  c.cvcsMode = mode;
  c.boronTargetPpm = target;

  // === Slew state.boronPpm toward the blender output ===
  // First-order exponential approach with τ = BORON_TAU_SEC. Charging
  // flow MUST be available — no flow → no makeup → no boron change.
  // This replaces the old direct scalar slew driven from cmd.boronTarget.
  if (runningCount > 0 && !letdownIsolated) {
    // Effective slew is (target - current) / τ with a step bound so the
    // accel-time integrator doesn't overshoot. tau_eff scales inversely
    // with the number of running pumps (more flow → faster turnover).
    const tauEff = BORON_TAU_SEC / Math.max(1, runningCount);
    const alpha = 1 - Math.exp(-dt / tauEff);
    state.boronPpm = state.boronPpm + (blenderOut - state.boronPpm) * alpha;
    // Mirror the blender target into the legacy cmd.boronTarget so any
    // downstream consumer that still reads it (rps.js, gauges, etc.)
    // sees a consistent picture during the migration window.
    state.cmd.boronTarget = state.boronPpm;
  }

  // === Sustained-condition accumulators ===
  // CVCS unavailable if no charging pumps running for > 5 sustained sec
  // (warning channel). Letdown isolation is its own warning.
  const cvcsLost = runningCount === 0;
  c.lossAccumSec = cvcsLost ? c.lossAccumSec + dt : 0;
  c.lossLatched = c.lossAccumSec > CVCS_LOSS_LATCH_SEC;
  c.letdownIsolatedLatched = letdownIsolated;
}
