// rbmk-als.js -- RBMK Accident Localization System (СЛА). Wave-B.
// Gated on T.rbmkAls; no-op for PWR/MSR.
//
// The RBMK has no Western-style pressure-retaining containment — the reactor
// hall is only a confinement (the defining Chernobyl design gap). What it DOES
// have is the ALS: the lower water-pipe compartments are leak-tight and vent a
// pipe-break's steam through a two-storey pressure-SUPPRESSION pool (the
// "bubbler pond") that condenses it. The pool is also the long-term ECCS water
// source (rbmk-eccs.js pumps draw from it).
//
// Inputs: state._rbmkAlsSteamInflowKgPerS (break / relief steam, reset each
// step in sim.js; a break model in Wave D feeds it) and
// state._rbmkEccsPoolDrawKgPerS (ECCS pumped draw). Dormant at init (no steam
// in) → no effect on the reactor; the ALS carries no reactivity.

export function stepRbmkAls(state, dt) {
  const T = state.T;
  const cfg = T.rbmkAls;
  const als = state.rbmkAls;
  if (!cfg || !als) return;

  // Break steam read directly from the command (stepRbmkAls runs before
  // stepPlant in the step, so reading plant's accumulator would lag a full
  // step behind the per-step reset). Other producers may still add to the
  // accumulator.
  const breakSteam = state.cmd.rbmkPipeBreak === true
    ? (T.rbmkBreak?.breakFlowKgPerS ?? 0) : 0;
  const steamIn = Math.max((state._rbmkAlsSteamInflowKgPerS ?? 0) + breakSteam, 0);   // kg/s
  // Pool condenses incoming steam up to a capacity (only while it has water);
  // the condensed mass heats the pool.
  const condCap = (cfg.poolCondenseCapKgPerS ?? 800) * (als.poolInventoryM3 > 1 ? 1 : 0);
  const condensed = Math.min(steamIn, condCap);

  // Compartment pressure: incoming steam LOADS the compartment (pressurizes it),
  // while condensation + venting relax it back toward baseline. The
  // suppression pool limits the peak — at a sustained break the pressure
  // settles where loading == relaxation, well below an uncontained value.
  const baseP = cfg.baselineP ?? 0.1;
  const load = steamIn * (cfg.pressurePerKgPerS ?? 5e-5);
  const relax = (als.compartmentPressureMPa - baseP) / (cfg.relaxTauSec ?? 60);
  als.compartmentPressureMPa = clamp(als.compartmentPressureMPa + (load - relax) * dt, 0.05, 2);

  // Pool temperature: latent heat of condensed steam in, pool coolers out.
  const hFg = 1.5e6;
  const poolMass = Math.max(als.poolInventoryM3 * 1000, 1);
  const qIn = condensed * hFg;
  const qOut = (cfg.poolCoolerUaWperK ?? 5e5) * Math.max(als.poolTempK - (cfg.ultimateSinkK ?? 308), 0);
  als.poolTempK = clamp(als.poolTempK + (qIn - qOut) / (poolMass * 4180) * dt, 280, 420);

  // Inventory: gains condensate, loses ECCS pumped draw.
  const draw = Math.max(state._rbmkEccsPoolDrawKgPerS ?? 0, 0);
  als.poolInventoryM3 = Math.max(0, als.poolInventoryM3 + (condensed - draw) * dt / 1000);

  als.sprayActive = als.compartmentPressureMPa > (cfg.spraySetpointMPa ?? 0.13);
}

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
