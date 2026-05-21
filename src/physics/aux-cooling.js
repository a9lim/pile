// aux-cooling.js — III.19 Component Cooling Water + Service Water systems.
//
// PWR has TWO cascaded closed-loop cooling systems behind the seal /
// instrument / pump-bearing heat sinks:
//
//   CCW (Component Cooling Water) — closed loop, treated demineralized
//     water at moderate pressure. Picks up heat from RCP thermal-barrier
//     HX (4×), letdown HX, RHR HX, ECCS pump motor coolers, sample HX,
//     and miscellaneous instrument coolers. Rejects to SW via the
//     CCW HX.
//
//   SW (Service Water) — open loop drawn from the ultimate heat sink
//     (lake / cooling tower / seawater intake). Picks up CCW HX heat
//     and rejects to atmosphere or back to the source.
//
// Pump count + per-pump flow come from T.ccw (this sim runs a single
// full-capacity pump for each system). Both are AC-powered. Loss of AC for either system propagates: SW loss
// disables CCW, CCW loss disables RCP thermal barrier (→ seal LOCA path
// in rcp.js) and letdown (→ no boration / dilution / makeup, and
// pressurizer level control degrades).
//
// Failure / degradation modes (scenario-injectable):
//   - cmd.swPumpFault[i] in {'none','trip','lowSuction'}
//   - cmd.ccwPumpFault[i] in {'none','trip','lowSuction'}
// 'lowSuction' models a low intake-bay level (drought, ice, screen
// fouling) that takes the pump out of service after a short delay.
//
// Module ordering in sim.js: AFTER stepEdgs (so we read this step's AC
// availability) and BEFORE stepCvcs / stepRcpSeals / stepEccs (so they
// see this step's `ccw.available` flag).
//
// References:
//   - WCAP-15376-A "Risk-Informed Assessment of CCW System Configuration"
//   - NUREG-1275 Vol. 11 (CCW operating experience)
//   - Westinghouse SOP "Component Cooling Water System Operation"
//   - INPO 88-021 "Service Water System Reliability Improvement"

// Default per-pump rated mass flow at 100 % capacity. Real Westinghouse
// numbers: CCW pumps ~750 kg/s each, SW pumps ~1500 kg/s each. We carry
// per-type knobs so the reactor-types.js block can override.
const CCW_PUMP_FLOW_DEFAULT_KG_PER_S = 750;
const SW_PUMP_FLOW_DEFAULT_KG_PER_S = 1500;

// CCW HX capacity. Tuned so CCW outlet T sits around 35 °C with one CCW
// pump + one SW pump running at full primary plant heat load (~30 MW
// thermal load on the CCW system). The 30 MW figure is from the
// Westinghouse 4-loop CCW design heat balance (FSAR §9.2.2).
const CCW_DESIGN_HEAT_LOAD_W = 3.0e7;
const CCW_HX_UA_W_PER_K = 7e5; // overall UA — calibrated against
                                // ΔT ≈ 15 K at design load with SW
                                // entering at ~25 °C.

// CCW loop thermal mass (water inventory + piping). Sets the time
// constant for CCW outlet T to respond to load / cooling changes.
const CCW_LOOP_HEAT_CAP_J_PER_K = 4.0e8; // ~95,000 kg of water + steel

// Service water inlet temperature (ultimate heat sink). Real plants see
// seasonal variation 5-30 °C; we hold it at design summer max for the
// pessimistic case.
const SW_INLET_TEMP_K = 298.15; // 25 °C

// Sustained-condition accumulators — same pattern as rps.js's lowOrm /
// flowExcursion / sealCoolingLost: the warning latches only after 2
// sustained sim-seconds.
const WARNING_LATCH_SEC = 2;

// CCW outlet temperature warning threshold. Above this the SW side is
// degraded (high SW T or insufficient SW flow), and downstream loads
// (charging pump motors, RCP TB, letdown HX) start losing margin.
const CCW_HOT_TRIP_K = 323.15; // 50 °C

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Per-step CCW + SW advancement. PWR-only — RBMK / MSR omit T.ccw and
 * the module early-returns.
 *
 * Reads:
 *   - state.electrical?.acAvailable
 *   - state.cmd.ccwPumpFault[i], cmd.swPumpFault[i]
 *   - state.cmd.ccwPumpManualStop[i], cmd.swPumpManualStop[i]
 *   - rough thermal load proxy from state.out.fissionPowerMW + decayHeatMW
 *
 * Writes:
 *   - state.ccw.available, .pumpRunningCount, .flowKgPerS, .outletTempK
 *   - state.ccw.swAvailable, .swPumpRunningCount, .swFlowKgPerS
 *   - state.ccw.hotLeg (bool, gauge layer reads)
 *   - state.ccw.lossAccumSec, .lossSwAccumSec, .ccwHotAccumSec
 *
 * Compatibility: legacy state.cmd.ccwAvailable still drives the logic
 * if the explicit pump array isn't built (preserves III.4 / III.5
 * scenarios that wrote the boolean directly until they migrate).
 */
export function stepAuxCooling(state, dt) {
  const T = state.T;
  if (!T.ccw) return;
  const c = state.ccw;
  if (!c) return; // defensive
  const cfg = T.ccw;

  const acOk = state.electrical
    ? state.electrical.acAvailable === true
    : true;

  const ccwFaults = state.cmd.ccwPumpFault || [];
  const swFaults = state.cmd.swPumpFault || [];
  const ccwStops = state.cmd.ccwPumpManualStop || [];
  const swStops = state.cmd.swPumpManualStop || [];
  const legacyOverride = state.cmd.ccwAvailable === false;

  // === Service water pumps ===
  // SW pumps are the upstream half — without them, CCW HX has nothing to
  // dump heat into. Per-pump availability + fault tracking.
  let swRunning = 0;
  let swFlow = 0;
  for (let i = 0; i < c.swPumps.length; i++) {
    const u = c.swPumps[i];
    const fault = swFaults[i] || u.faultReason || 'none';
    if (fault !== 'none' && u.faultReason === 'none') {
      u.faulted = true;
      u.faultReason = fault;
    }
    // Pump runs iff: AC available, not manually stopped, not faulted,
    // not below the suction-low threshold (modeled as a 5-sec accumulator
    // for the lowSuction fault).
    if (u.faultReason === 'lowSuction') {
      u.lowSuctionAccumSec += dt;
      if (u.lowSuctionAccumSec > 5) {
        u.faulted = true;
      }
    } else {
      u.lowSuctionAccumSec = 0;
    }
    const wantsRun = acOk && !swStops[i] && !u.faulted;
    u.running = wantsRun;
    u.flowKgPerS = wantsRun ? (cfg.swPumpFlowKgPerS ?? SW_PUMP_FLOW_DEFAULT_KG_PER_S) : 0;
    if (wantsRun) {
      swRunning += 1;
      swFlow += u.flowKgPerS;
    }
  }
  c.swPumpRunningCount = swRunning;
  c.swFlowKgPerS = swFlow;
  c.swAvailable = swRunning > 0;

  // === CCW pumps ===
  // Same pattern. CCW additionally requires SW to NOT be lost (real plant:
  // the operator manually trips CCW pumps after sustained loss of SW to
  // protect the pump bearings, but for the operator-trainer purposes the
  // pumps continue running and CCW outlet T just climbs — we model the
  // unavailability through the outlet-T → CCW_HOT_TRIP path below).
  let ccwRunning = 0;
  let ccwFlow = 0;
  for (let i = 0; i < c.ccwPumps.length; i++) {
    const u = c.ccwPumps[i];
    const fault = ccwFaults[i] || u.faultReason || 'none';
    if (fault !== 'none' && u.faultReason === 'none') {
      u.faulted = true;
      u.faultReason = fault;
    }
    if (u.faultReason === 'lowSuction') {
      u.lowSuctionAccumSec += dt;
      if (u.lowSuctionAccumSec > 5) u.faulted = true;
    } else {
      u.lowSuctionAccumSec = 0;
    }
    const wantsRun = acOk && !ccwStops[i] && !u.faulted;
    u.running = wantsRun;
    u.flowKgPerS = wantsRun ? (cfg.ccwPumpFlowKgPerS ?? CCW_PUMP_FLOW_DEFAULT_KG_PER_S) : 0;
    if (wantsRun) {
      ccwRunning += 1;
      ccwFlow += u.flowKgPerS;
    }
  }
  c.ccwPumpRunningCount = ccwRunning;
  c.flowKgPerS = ccwFlow;

  // === CCW loop temperature dynamics ===
  // Simple lumped energy balance:
  //   CCW absorbs heat from plant loads (proportional to total reactor
  //   power for now — a quick proxy because most CCW load is from the
  //   ECCS pump motor coolers, RHR HX, letdown HX, etc., all of which
  //   scale with plant operating state).
  //   CCW rejects heat through CCW HX to SW: Q = UA × (T_ccw - T_sw_in)
  //   when both pumps are running. Without SW, no heat rejection.
  const out = state.out;
  const totalCorePowerMW = out.totalCorePowerMW ?? ((out.fissionPowerMW ?? 0) + (out.decayHeatMW ?? 0));
  // Plant load fraction, capped at design power so post-trip we still get
  // appreciable CCW load from pump motors / instrumentation.
  const loadFrac = clamp(totalCorePowerMW / Math.max(1, T.nominalPowerMWth), 0.05, 1.5);
  const Q_load = CCW_DESIGN_HEAT_LOAD_W * loadFrac;
  const Q_reject = c.swAvailable && ccwRunning > 0
    ? CCW_HX_UA_W_PER_K * (c.outletTempK - SW_INLET_TEMP_K)
    : 0;
  const dT = (Q_load - Q_reject) * dt / CCW_LOOP_HEAT_CAP_J_PER_K;
  c.outletTempK = clamp(c.outletTempK + dT, SW_INLET_TEMP_K, 423.15);

  // === Roll up CCW availability ===
  // CCW is "available" downstream when: AC up, CCW pumps running, SW
  // pumps running, outlet T below the hot-trip threshold, no operator
  // override declaring it unavailable. The legacy `cmd.ccwAvailable =
  // false` knob (used by III.4 / III.5 scenarios) still works as a hard
  // override.
  const ccwOk = !legacyOverride
    && acOk
    && ccwRunning > 0
    && c.swAvailable
    && c.outletTempK < CCW_HOT_TRIP_K;
  c.available = ccwOk;
  c.hotLeg = c.outletTempK > CCW_HOT_TRIP_K;

  // === Sustained-condition accumulators (warnings) ===
  c.lossAccumSec = c.available ? 0 : c.lossAccumSec + dt;
  c.lossSwAccumSec = c.swAvailable ? 0 : c.lossSwAccumSec + dt;
  c.ccwHotAccumSec = c.hotLeg ? c.ccwHotAccumSec + dt : 0;

  c.lossLatched = c.lossAccumSec > WARNING_LATCH_SEC;
  c.lossSwLatched = c.lossSwAccumSec > WARNING_LATCH_SEC;
  c.ccwHotLatched = c.ccwHotAccumSec > WARNING_LATCH_SEC;
}
