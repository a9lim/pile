// rbmk-electrical.js -- RBMK auxiliary AC, DREG emergency diesel generators,
// and the turbo-generator RUNDOWN. Wave-B. Gated on T.rbmkElectrical; no-op
// for PWR/MSR (those use their own electrical model / none).
//
// The distinctive RBMK feature modeled here is the turbo-generator rundown:
// on loss of offsite power the coasting main generator briefly back-feeds the
// unit buses, carrying the main circulation pumps (and ECCS pumps) through the
// ~15 s gap before the diesels reach load. Validating that this coastdown
// could actually bridge the gap was the purpose of the Chernobyl experiment.
//
// AC available  iff  offsite power OR ≥1 diesel running OR rundown active.
// circulation.js gates the MCPs on state.rbmkElectrical.acAvailable (one-step
// lag), so a station blackout coasts the pumps into natural circulation.

export function stepRbmkElectrical(state, dt) {
  const T = state.T;
  const cfg = T.rbmkElectrical;
  const el = state.rbmkElectrical;
  if (!cfg || !el) return;

  const loop = !!state.cmd.lossOfOffsitePower;
  el.offsiteAvailable = !loop;

  // DREG diesels — start on LOOP (or manual) after a delay; run while started,
  // unfaulted and fueled. Fuel burns down only while running.
  const faults = state.cmd.rbmkDgFault || [];
  const manual = state.cmd.rbmkDgManualStart || [];
  let anyRunning = false, anyFaulted = false, lowFuel = false, runningCount = 0;
  for (let i = 0; i < el.dgUnits.length; i++) {
    const u = el.dgUnits[i];
    const fault = faults[i] || 'none';
    u.faulted = fault !== 'none';
    u.faultReason = u.faulted ? fault : null;
    const wantStart = (loop || manual[i] === true) && !u.faulted && u.fuelFrac > 0;
    u.startTimer = wantStart ? Math.min((u.startTimer || 0) + dt, cfg.dgStartDelaySec + 1)
                             : 0;
    u.running = wantStart && u.startTimer >= (cfg.dgStartDelaySec ?? 15);
    if (u.running) {
      u.fuelFrac = Math.max(0, u.fuelFrac - dt / (cfg.dgFuelEnduranceSec ?? 6.048e5));
      anyRunning = true; runningCount++;
    }
    if (u.faulted) anyFaulted = true;
    if (u.fuelFrac < (cfg.lowFuelFrac ?? 0.1)) lowFuel = true;
  }
  el.anyDgRunning = anyRunning;
  el.runningCount = runningCount;
  el.anyDgFaulted = anyFaulted;
  el.lowFuelOil = lowFuel;

  // Turbo-generator rundown. Primed to full on the LOOP edge while the TG is
  // still spinning; decays exponentially while LOOP persists; cleared when
  // offsite returns.
  if (!loop) {
    el.rundownEnergy = 0;
    el._rundownPrimed = false;
  } else {
    const spinning = (state.out.generatorMWe ?? 0) > 1
      || (state.turbineValve ?? 0) > 0.1 || el.rundownEnergy > 0.05;
    if (!el._rundownPrimed && spinning) { el.rundownEnergy = 1; el._rundownPrimed = true; }
    el.rundownEnergy = Math.max(0, el.rundownEnergy * Math.exp(-dt / (cfg.rundownTauSec ?? 45)));
  }
  el.rundownActive = el.rundownEnergy > 0.05;

  el.acAvailable = el.offsiteAvailable || anyRunning || el.rundownActive;
  // ECCS / MCP buses follow AC availability (the rundown is exactly what was
  // meant to carry them through the gap).
  el.eccsBusEnergized = el.acAvailable;
}
