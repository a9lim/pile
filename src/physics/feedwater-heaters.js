// feedwater-heaters.js (III.10) -- lumped regenerative feedwater heater train.
//
// Models the chain of extraction-steam heaters between the condenser
// hotwell and the steam generator (PWR) / steam drum (RBMK). A
// Westinghouse 4-loop plant heats condensate from ~38 C (hotwell) to a
// final feedwater temperature of ~226 C through ~6 stages (3 LP heaters,
// the deaerator, 2 HP heaters); the RBMK uses a shorter ~165 C chain.
// Each stage taps steam from a turbine extraction point, so the heating
// duty scales with turbine load.
//
// THE PEDAGOGICAL OBJECT is the FEEDWATER-HEATER-ISOLATION transient.
// Isolating a string of heaters drops the feedwater temperature sharply.
// Colder feedwater forces the SG to spend more of the crossed primary
// heat on sensible heating before it can boil -- see plant.js's hFgEff
// term -- so for a fixed primary->secondary Qsg less steam is produced,
// SG pressure sags, the primary->secondary delta-T deepens, the primary
// cold leg over-cools, and (negative moderator coefficient) the colder
// moderator adds POSITIVE reactivity. Power rises until the rods / Tave
// program compensate. The handoff flagged "check the sign": colder
// moderator with alpha_mod < 0 gives rho_mod = alpha_mod * (T - T_ref)
// = (neg) * (neg) = POSITIVE. Feedwater-heater isolation is a mild
// overpower transient.
//
// MSR (molten-salt reactor) has no feedwater system -- state.feedwater
// is null and this module early-returns. NOTE the moisture-separator-
// reheater, confusingly also abbreviated "MSR", is a turbine-side
// component between the HP and LP turbines and is modelled in III.13,
// not here.
//
// === Model ===
//
// Each stage i has a design temperature rise designRiseK. The feedwater
// temperature TARGET is
//     T_target = T_condenser + loadFactor * sum_{in-service} designRiseK
// where loadFactor in [0,1] is the turbine load fraction (extraction
// steam is proportional to throttle flow). The delivered temperature
// relaxes toward the target through a first-order lag (heater-train
// metal + water inventory thermal inertia, tau ~ 35-40 s).
//
// === Critical-by-construction ===
//
// At init every stage is in service and loadFactor = 1, so T_FW =
// designTempK exactly. plant.js anchors hFgEff to designTempK
// (hFgEff == hFg when T_FW == designTempK), so the wave-2 secondary
// equilibrium is reproduced bit-for-bit at t=0. state.js initialises
// feedwater.tempK = designTempK.
//
// References: Westinghouse FSAR Ch 10.4.7; El-Wakil "Powerplant
// Technology" Ch 3 (regenerative Rankine feedwater heating).

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export function stepFeedwaterHeaters(state, dt) {
  const fw = state.feedwater;
  if (!fw) return;                       // MSR -- no feedwater system

  const cmd = state.cmd;
  const inService = cmd.fwHeaterInService;   // per-stage booleans (or undefined)

  // Turbine load fraction drives extraction-steam availability. Extraction
  // steam is proportional to the steam passing through the turbine, which
  // tracks generator output. One-step lag on generatorMWe is fine (it is
  // last step's value; the heater train's own 35-40 s lag dominates).
  const nominalMWe = state.T.nominalGridLoadMW || state.T.nominalPowerMWe || 1;
  const loadFactor = clamp((state.out.generatorMWe || 0) / nominalMWe, 0, 1);

  let sumRise = 0;
  let nInService = 0;
  for (let i = 0; i < fw.stages.length; i++) {
    const st = fw.stages[i];
    // A stage is in service unless the operator / scenario explicitly
    // isolated it (inService[i] === false).
    const on = inService ? inService[i] !== false : true;
    st.inService = on;
    if (on) { sumRise += st.designRiseK; nInService++; }
  }

  const targetK = fw.condenserTempK + loadFactor * sumRise;
  fw.targetTempK = targetK;

  // First-order lag toward the target.
  const tau = fw.lagTauSec || 40;
  fw.tempK += (targetK - fw.tempK) * clamp(dt / tau, 0, 1);

  // Diagnostics for the gauge layer.
  state.out.feedwaterTempK = fw.tempK;
  state.out.fwHeatersInService = nInService;
  state.out.fwHeatersTotal = fw.stages.length;
}
