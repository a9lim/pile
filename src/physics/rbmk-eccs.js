// rbmk-eccs.js -- RBMK Emergency Core Cooling System (САОР). Wave-B.
// Gated on T.rbmkEccs; no-op for PWR/MSR.
//
// Two subsystems, both injecting makeup water into the two core halves (the
// two loops' drums):
//   - FAST: N₂-pressurized hydraulic accumulators — passive, discharge on
//     actuation until empty. No AC needed.
//   - LONG-TERM: ECCS pumps drawing from the Accident-Localization suppression
//     pool (rbmk-als.js). AC-gated via rbmkElectrical.eccsBusEnergized.
//
// Actuation (latched): low drum level, low drum pressure, or manual. Injection
// is split across the non-isolated loops; plant.js folds lp.eccsInjectionKgPerS
// into each drum's water balance (and the cold-makeup blend). Dormant at init
// (actuated=false → zero injection) so critical-by-construction is untouched.

export function stepRbmkEccs(state, dt) {
  const T = state.T;
  const cfg = T.rbmkEccs;
  const e = state.rbmkEccs;
  if (!cfg || !e) return;

  const drumLvl = state.sgSecondaryLevel ?? 0.5;
  const drumP = state.sgSecondaryP ?? 7;
  // Break detection: ALS suppression-pool over-pressure (a pressure-tube break
  // dumps steam into the localization compartments). This is the robust LOCA
  // actuation signal.
  const breakDetected = !!state.rbmkAls
    && state.rbmkAls.compartmentPressureMPa > (cfg.actuationAlsPressureMPa ?? 0.13);
  const trig = state.cmd.rbmkEccsManual === true
    || drumLvl < (cfg.actuationDrumLevel ?? 0.30)
    || drumP < (cfg.actuationDrumPressureMPa ?? 4.0)
    || breakDetected;
  if (trig && !e.actuated) { e.actuated = true; e.firstActuatedTime = state.simTime; }
  if (state.cmd.rbmkEccsReset === true) { e.actuated = false; e.firstActuatedTime = null; }

  let total = 0;
  if (e.actuated) {
    // Passive accumulators discharge until empty.
    const accFlow = cfg.accumulatorFlowKgPerS ?? 200;
    for (const a of e.accumulators) {
      if (a.inventoryM3 > 0) {
        a.flowing = true;
        a.inventoryM3 = Math.max(0, a.inventoryM3 - accFlow * dt / 1000);
        total += accFlow;
      } else { a.flowing = false; }
    }
    // Pumped path: AC-gated + needs pool suction.
    const acOk = !state.rbmkElectrical || state.rbmkElectrical.eccsBusEnergized !== false;
    const poolOk = !state.rbmkAls || state.rbmkAls.poolInventoryM3 > 1;
    e.pumpFlowKgPerS = (acOk && poolOk) ? (cfg.pumpFlowKgPerS ?? 600) : 0;
    total += e.pumpFlowKgPerS;
  } else {
    for (const a of e.accumulators) a.flowing = false;
    e.pumpFlowKgPerS = 0;
  }
  e.totalInjectionKgPerS = total;
  // ALS debits the pumped draw from the suppression pool next.
  state._rbmkEccsPoolDrawKgPerS = e.pumpFlowKgPerS;

  // Split across non-isolated loops (the two core halves).
  if (state.loops) {
    let nActive = 0;
    for (const lp of state.loops) if (!lp.isolated) nActive++;
    nActive = Math.max(nActive, 1);
    for (const lp of state.loops) lp.eccsInjectionKgPerS = lp.isolated ? 0 : total / nActive;
  }
}
