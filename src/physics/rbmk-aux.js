// rbmk-aux.js -- RBMK auxiliary circuits (Wave C). Gated on T.rbmkAux.
// Three AC-powered support circuits, all lost on a station blackout:
//
//   1. Graphite gas circuit (He/N₂). Circulators sweep an inert gas through
//      the graphite stack to prevent oxidation and carry stack heat to the
//      coolant. Loss of circulation → the graphite sheds less heat → a
//      graphite over-heat term (state.rbmkAux.graphiteExtraHeatW) that
//      thermal.js folds into the graphite node, feeding the (graphite)
//      moderator reactivity coefficient. Zero in normal operation → init
//      unperturbed (critical-by-construction).
//   2. CPS rod-cooling circuit. Cools the control-rod channels; on loss the
//      rods drag, derating the scram drive speed (state.rbmkAux.scramSpeedFactor,
//      read by rps.js). 1.0 normally.
//   3. Main feedwater pumps. AC-powered; on loss (operator trip or SBO) drum
//      feedwater stops — plant.js's drum controller reads mfwAvailable.

export function stepRbmkAux(state, dt) {
  const T = state.T;
  const cfg = T.rbmkAux;
  const aux = state.rbmkAux;
  if (!cfg || !aux) return;

  const acOk = !state.rbmkElectrical || state.rbmkElectrical.acAvailable !== false;

  // ── 1. Graphite gas circuit ───────────────────────────────────────────
  // The He/N₂ circuit is one of the graphite stack's heat-removal paths. Loss
  // of circulation reduces the graphite→coolant cooling: graphiteCoolingFactor
  // relaxes from 1.0 toward graphiteCoolingLossFactor, and thermal.js scales
  // the graphite cooling term by it. 1.0 in normal operation → init unchanged.
  aux.gasCoolingOk = acOk && state.cmd.rbmkGasCircuitTrip !== true;
  const targetFactor = aux.gasCoolingOk ? 1 : (cfg.graphiteCoolingLossFactor ?? 0.5);
  const tau = cfg.graphiteCoolingTauSec ?? 120;
  aux.graphiteCoolingFactor += (targetFactor - aux.graphiteCoolingFactor) * (1 - Math.exp(-dt / tau));
  // Average graphite temperature readout (thermal.js owns state.T_graphite).
  let tg = 0;
  for (let k = 0; k < state.N; k++) tg += state.T_graphite[k];
  aux.avgGraphiteTempK = tg / state.N;

  // ── 2. CPS rod-cooling circuit ────────────────────────────────────────
  aux.cpsCoolingOk = acOk && state.cmd.rbmkCpsCoolingTrip !== true;
  aux.scramSpeedFactor = aux.cpsCoolingOk ? 1 : (cfg.cpsCoolingScramDerate ?? 0.5);

  // ── 3. Main feedwater pumps ───────────────────────────────────────────
  aux.mfwAvailable = acOk && state.cmd.rbmkMfwTrip !== true && state.cmd.mainFwTrip !== true;
}
