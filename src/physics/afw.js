// afw.js — III.8 Auxiliary Feedwater system.
//
// PWR-only. Two independent trains feed the steam generator(s) through
// motor-operated discharge valves. One motor-driven (MDAFW) train is
// AC-powered; one turbine-driven (TDAFW) train uses main-steam to spin
// a Terry turbine and is independent of AC — it's the SBO heat sink.
// The MDAFW train is collapsed from the Westinghouse 2× MDAFW
// arrangement (a usability simplification).
//
// Train flow ratings (FSAR / NRC IN-86-105 typical):
//   MDAFW: 1400 gpm at 8 MPa SG pressure (parabolic head curve)
//   TDAFW:  800 gpm  (steam-driven, runs on residual main-steam pressure)
//
// Auto-start logic (any of):
//   - Low SG narrow-range level (<30%)
//   - Loss of offsite power
//   - SI actuated
//   - Loss of main feedwater (cmd.mainFwTrip or feedwater-pumps.js unavailable)
// Once latched, stays latched until cmd.afwReset && all conditions clear.
//
// Per-train discharge MOV alignment (TMI-2 famous failure mode):
//   Each train has one discharge MOV per steam generator.
//   cmd.afwMovOpen[t*nSG + sg] (2 trains × loopCount SGs; default all
//   true). When the train auto-starts but ALL its discharge MOVs are
//   closed, the train spins up but no water reaches the SG — the
//   famous TMI-2 condition that went unnoticed for 8 minutes.
//
// Indication: out.afwLowFlow latches when AFW has been signaled for >30
// sustained sim-seconds but aggregate flow is < 50 gpm (the "you have a
// running pump but the discharge is closed" tell).
//
// TDAFW availability (cmd.tdafwBlockValveOpen, default true):
//   Closed-block-valve scenario: TDAFW pump is intact but its steam
//   admission valve is locked closed — the pedagogical analog of the
//   "TDAFW out of service for testing" condition. The trip channel
//   tdafwUnavailable mirrors this so the operator sees it on the
//   annunciator.
//
// Module ordering in sim.js::step:
//   stepAfw runs BEFORE stepPlant so plant.js sees the current AFW flow
//   when computing the SG mass balance. afw.js reads state.sgSecondaryLevel
//   for the auto-start trigger — one-substep lag is fine (auto-start
//   thresholds are well above the trip envelope).
//
// References:
//   - Westinghouse FSAR Chapter 10.4.9 (AFW system).
//   - NRC IN-86-105 (auxiliary feedwater pump trip experiences).
//   - NUREG-1410 (TMI-2 final report — closed AFW block valves).
//   - IAEA-TECDOC-981 §4 (AFW reliability assessment methodology).

// Conversion: 1 US gallon per minute of cold water ≈ 0.0631 kg/s
// (matches eccs.js / rcp.js — 998.2 kg/m³ at 20°C reference density).
const GPM_TO_KG_PER_S = 0.0631;

// Sustained low-flow window before afwLowFlow latches. 30 s matches
// the TMI-2 timeline window where the closed block valves went
// unnoticed; in practice any indication delay >> 10 s is operationally
// significant.
const LOW_FLOW_LATCH_SEC = 30;

// Aggregate-flow threshold (gpm) below which "AFW signaled but not
// flowing" is annunciated. 50 gpm is well below normal AFW flow
// (~700-800 gpm/train) but well above seal-leakage / standby flow.
const LOW_FLOW_THRESHOLD_GPM = 50;

export function stepAfw(state, dt) {
  const T = state.T;
  // No-op for any reactor type without AFW config (RBMK / MSR). The
  // physics module is PWR-only; state.js builds state.afw only when
  // T.afw is defined.
  if (!T.afw) return;
  const afw = state.afw;
  if (!afw) return; // defensive — state.js builds this for PWR only
  const cfg = T.afw;

  // ============================================================
  // 1. Determine AC-power availability (gates MDAFW trains)
  // ============================================================
  // Charging-class motor-driven AFW pumps are AC-powered. LOOP knocks
  // them off unless the EDGs / alternate AC source is feeding them.
  // Use the electrical roll-up / EDG-backed AC state. The legacy
  // edgsCarryingEccs flag remains only for non-electrical fallback states.
  const acAvailable = state.electrical
    ? state.electrical.acAvailable === true
    : (!state.cmd.lossOfOffsitePower || state.cmd.edgsCarryingEccs === true);

  // ============================================================
  // 2. Auto-start logic (latched)
  // ============================================================
  // Any of:
  //   - SG narrow-range level < lowSgLevelStart (default 0.30)
  //   - cmd.lossOfOffsitePower
  //   - state.eccs.siActuated
  //   - cmd.mainFwTrip OR loss of all main-FW pumps (III.11)
  //   - cmd.manualAfwStart (operator pushbutton)
  const lowLevelStart = state.sgSecondaryLevel < (cfg.lowSgLevelStart ?? 0.30);
  const loopStart = !!state.cmd.lossOfOffsitePower;
  const siStart = !!(state.eccs && state.eccs.siActuated);
  // III.11 — loss of main feedwater. Either the operator hard-trip
  // (cmd.mainFwTrip) or the physics pump model reporting no MFW pump
  // delivering (state.feedwaterPumps.mfwAvailable === false) auto-starts AFW.
  const mfwStart = !!state.cmd.mainFwTrip
    || (state.feedwaterPumps != null && state.feedwaterPumps.mfwAvailable === false);
  const manualStart = !!state.cmd.manualAfwStart;
  const anyStartCond = lowLevelStart || loopStart || siStart || mfwStart || manualStart;

  if (!afw.actuated && anyStartCond) {
    afw.actuated = true;
    if (afw.firstActuatedTime === null) afw.firstActuatedTime = state.simTime;
  } else if (afw.actuated && !anyStartCond && state.cmd.afwReset === true) {
    // Reset requires BOTH operator command AND all firing conditions clear.
    afw.actuated = false;
    afw.firstActuatedTime = null;
    state.cmd.afwReset = false;     // consume one-shot
    state.cmd.manualAfwStart = false; // clear sticky pushbutton
  }

  // ============================================================
  // 3. Per-train MOV alignment + flow calculation
  // ============================================================
  // The cmd.afwMovOpen array shape is [t*nSG + sg] — train index
  // t ∈ {0:MDAFW, 1:TDAFW}, SG index sg ∈ {0..nSG-1}. We lump to a
  // single-SG mass balance but track per-MOV state for the indication.
  const movArr = state.cmd.afwMovOpen || [];
  const sgPressureMPa = state.sgSecondaryP;
  const nSG = state.loops ? state.loops.length : 1;

  function countOpenMovs(t) {
    let openCount = 0;
    for (let sg = 0; sg < nSG; sg++) {
      // Default true if cmd flag undefined (initial alignment).
      if (movArr[t * nSG + sg] !== false) openCount += 1;
    }
    return openCount;
  }

  function trainFlowKgPerS(tCfg, t) {
    const openCount = countOpenMovs(t);
    if (openCount === 0) return { flowKgPerS: 0, openCount: 0 };
    // Parabolic head curve identical in shape to ECCS pumps:
    //   flowGpm = runout × (1 - (P/shutoff)²)
    // Real AFW pumps have a flatter curve in the operating range, but
    // this captures the right gross behavior (zero flow at the
    // shutoff head, runout at zero back-pressure).
    const ratio = sgPressureMPa / (tCfg.shutoffP_MPa ?? 8.0);
    const factor = 1 - ratio * ratio;
    if (factor <= 0) return { flowKgPerS: 0, openCount };
    const flowGpm = (tCfg.runoutFlowGpm ?? 1400) * factor;
    return { flowKgPerS: flowGpm * GPM_TO_KG_PER_S, openCount };
  }

  // --- MDAFW (motor-driven, AC-powered) ---
  let mdafwFlow = 0, mdafwOpen = 0;
  if (afw.actuated && acAvailable) {
    const r = trainFlowKgPerS(cfg.mdafw, 0);
    mdafwFlow = r.flowKgPerS;
    mdafwOpen = r.openCount;
  } else {
    // Standby — count MOVs anyway so UI can show "ready" alignment.
    mdafwOpen = countOpenMovs(0);
  }
  afw.mdafw.running = afw.actuated && acAvailable;
  afw.mdafw.flowKgPerS = mdafwFlow;
  afw.mdafw.dischargeMovsOpen = mdafwOpen;

  // --- TDAFW (turbine-driven, AC-independent) ---
  // Steam-powered from the main steam line. Available during SBO so
  // long as the SGs are still pressurized AND the steam admission
  // block valve is open. Trips off if all SGs depressurize below
  // the minimum steam-pressure threshold (~0.5 MPa — turbine governor
  // can't sustain shaft speed below that).
  const tdafwBlockOpen = state.cmd.tdafwBlockValveOpen !== false; // default true
  const tdafwSteamOk = sgPressureMPa > (cfg.tdafw.minSteamPressureMPa ?? 0.5);
  let tdafwFlow = 0, tdafwOpen = 0;
  if (afw.actuated && tdafwBlockOpen && tdafwSteamOk) {
    const r = trainFlowKgPerS(cfg.tdafw, 1);
    tdafwFlow = r.flowKgPerS;
    tdafwOpen = r.openCount;
  } else {
    tdafwOpen = countOpenMovs(1);
  }
  afw.tdafw.running = afw.actuated && tdafwBlockOpen && tdafwSteamOk;
  afw.tdafw.flowKgPerS = tdafwFlow;
  afw.tdafw.dischargeMovsOpen = tdafwOpen;
  // tdafw availability mirror — flips false either when the operator
  // closes the block valve or the SGs depressurize. Drives the
  // tdafwUnavailable warning channel.
  afw.tdafwAvailable = tdafwBlockOpen && tdafwSteamOk;

  // ============================================================
  // 4. Aggregate flow + low-flow indication
  // ============================================================
  const totalKgPerS = mdafwFlow + tdafwFlow;
  afw.totalFlowKgPerS = totalKgPerS;
  const totalGpm = totalKgPerS / GPM_TO_KG_PER_S;
  afw.totalFlowGpm = totalGpm;

  // Low-flow latch: AFW signaled but aggregate flow far below normal
  // for sustained period. The 30-second window matches the TMI-2
  // indication-failure timeline.
  if (afw.actuated && totalGpm < LOW_FLOW_THRESHOLD_GPM) {
    afw.lowFlowAccumSec += dt;
    if (afw.lowFlowAccumSec > LOW_FLOW_LATCH_SEC) afw.lowFlowLatched = true;
  } else {
    afw.lowFlowAccumSec = 0;
    // Auto-clear when flow recovers above threshold (e.g. operator
    // opens the closed MOVs). Real plants keep a manual reset; for
    // pedagogy let it self-clear so the operator sees the indication
    // change as they fix the problem.
    if (totalGpm >= LOW_FLOW_THRESHOLD_GPM) afw.lowFlowLatched = false;
  }
}
