// turbine.js (III.13) -- staged turbine + synchronous generator.
//
// PWR-only. Replaces the wave-2 lumped `generatorMWe = steam·hFg·eff`
// scalar in plant.js with a staged turbine-generator:
//
//   SG steam --[HP turbine]--> crossover --[MSR]--> [LP turbine]--> condenser
//                                                        |
//                                              shaft --> [generator] --> grid
//
// HP / MSR / LP STAGES. The available heat drop is taken from the real
// IAPWS-IF97 saturated-vapour enthalpy at the live SG pressure
// (steam-tables.js hg) down to a fixed LP-exhaust enthalpy at condenser
// vacuum. So when SG pressure sags (load increase, feedwater-heater
// isolation) the available enthalpy drop genuinely shrinks. The lumped
// turbineEfficiency is the calibration anchor (stage isentropic
// efficiencies × the fraction of the ideal drop actually realised) — set
// so design steam → nominal generator output. The total mechanical power
// is split HP / LP by hpWorkFraction for the stage readouts; the moisture-
// separator-reheater (MSR) between the stages is folded into the lumped
// efficiency (a full stage-by-stage isentropic expansion is deferred).
//
// GENERATOR. A synchronous machine tied to the grid. While the breaker is
// closed and the grid is up the rotor is grid-locked at synchronous speed
// (speedPU = 1.0) and real power equals the turbine mechanical power times
// the generator efficiency. Field current (the AVR / excitation, operator
// knob cmd.generatorFieldCurrentPU) sets reactive power: over-excitation
// (>1.0) supplies VARs, under-excitation absorbs them; at 1.0 the machine
// runs at unity power factor. Terminal voltage on-grid is pinned by the
// switchyard (cmd.gridVoltagePU); off-grid it is the open-circuit EMF.
//
// LOAD REJECTION + OVERSPEED. Opening the generator breaker
// (cmd.generatorBreakerOpen) sheds the entire electrical load. The turbine
// mechanical power now has nowhere to go and accelerates the rotor via the
// swing equation 2H·dω/dt = P_mech − P_elec. The speed governor responds
// by fast-closing the turbine valve. With a healthy governor the speed
// peaks a few percent high and recovers; with cmd.turbineGovernorFault the
// valve does not close, the rotor runs away, and the mechanical overspeed
// trip fires at overspeedTripPU (1.10) — a SCRAM channel that also slams
// the valve. Rotor coast-down afterwards is by windage (∝ speed²).
//
// Module ordering (sim.js): AFTER stepPlant, which stores the turbine
// steam flow in state.out.turbineSteamFlow. plant.js's pidValveControl
// reads last step's state.out.generatorMWe (one-step lag — fine inside a
// feedback loop). RBMK/MSR keep their inline generatorMWe calculation and
// state.turbine is null → this module early-returns.
//
// References: El-Wakil "Powerplant Technology" Ch 5-6 (steam turbines);
// Kundur "Power System Stability and Control" Ch 3 (synchronous machine,
// swing equation); Westinghouse FSAR Ch 10.2.

import { hg } from './steam-tables.js';

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export function stepTurbine(state, dt) {
  const tb = state.turbine;
  if (!tb) return;                       // RBMK / MSR — inline calc kept

  const cfg = state.T.turbine;
  const cmd = state.cmd;
  const out = state.out;

  // === Available heat drop (steam-tables, pressure-dependent) ===
  const sgP = state.sgSecondaryP || 0.1;
  const hCond = cfg.condenserEnthalpyJPerKg ?? 2.15e6;
  const availDrop = Math.max(hg(sgP) - hCond, 0);          // J/kg

  // === Turbine mechanical power ===
  const steam = out.turbineSteamFlow || 0;                 // kg/s, from plant.js
  const mechPowerMW = steam * availDrop * (cfg.turbineEfficiency ?? 0.83) / 1e6;
  const hpFrac = cfg.hpWorkFraction ?? 0.42;
  tb.hpPowerMW = mechPowerMW * hpFrac;
  tb.lpPowerMW = mechPowerMW * (1 - hpFrac);
  tb.mechPowerMW = mechPowerMW;

  // === Rotor speed + governor ===
  const ratedMW = (state.T.nominalPowerMWe || 1150)
    / (cfg.generatorEfficiency ?? 0.985);                  // mechanical rating
  const gridUp = !cmd.lossOfOffsitePower;
  // Breaker: tied to the grid unless the operator opened it, the grid is
  // down, or an overspeed trip has fired.
  tb.breakerClosed = !cmd.generatorBreakerOpen && gridUp && !tb.overspeedTrip;

  let pElecMW;
  if (tb.breakerClosed) {
    // Synchronised to an infinite grid → rotor is speed-locked. Real power
    // out equals the mechanical power in (generator losses applied).
    tb.speedPU = 1.0;
    pElecMW = mechPowerMW * (cfg.generatorEfficiency ?? 0.985);
  } else {
    // Islanded rotor — integrate the swing equation. No electrical load
    // (full load rejection); windage ∝ speed² is the only brake besides
    // the governor closing the valve.
    pElecMW = 0;
    const H = cfg.rotorInertiaSec ?? 8;
    const windageMW = ratedMW * 0.01 * tb.speedPU * tb.speedPU;
    const pMechPu = mechPowerMW / ratedMW;
    const pBrakePu = windageMW / ratedMW;
    // 2H·dωpu/dt = P_mech_pu − P_brake_pu
    tb.speedPU += (pMechPu - pBrakePu) / (2 * H) * dt;
    tb.speedPU = clamp(tb.speedPU, 0, 2);
  }

  // Speed governor — fast valve closure on overspeed. Healthy governor
  // closes the throttle at ~3/s once speed exceeds the governor band;
  // cmd.turbineGovernorFault disables it (the runaway scenario).
  const band = cfg.governorBandPU ?? 0.02;
  if (tb.speedPU > 1.0 + band && !cmd.turbineGovernorFault) {
    state.turbineValve = clamp(state.turbineValve - 3.0 * dt, 0, 1);
  }
  // Mechanical overspeed trip — latched. Slams the valve and scrams.
  if (tb.speedPU >= (cfg.overspeedTripPU ?? 1.10)) {
    tb.overspeedTrip = true;
  }
  if (tb.overspeedTrip) {
    state.turbineValve = clamp(state.turbineValve - 5.0 * dt, 0, 1);
  }

  // === Generator electrical output ===
  tb.generatorMWe = pElecMW;
  out.generatorMWe = pElecMW;
  // Field current → reactive power. Unity power factor at fieldCurrentPU
  // = 1.0; over-excitation supplies VARs, under-excitation absorbs them.
  const fieldPU = Number.isFinite(cmd.generatorFieldCurrentPU)
    ? cmd.generatorFieldCurrentPU : 1.0;
  tb.fieldCurrentPU = fieldPU;
  tb.reactiveMVAR = tb.breakerClosed
    ? (cfg.reactiveSensitivityMVARperPU ?? 2000) * (fieldPU - 1.0)
    : 0;
  // Terminal voltage: grid-pinned on-line, open-circuit EMF off-line.
  tb.terminalVoltagePU = tb.breakerClosed
    ? (Number.isFinite(cmd.gridVoltagePU) ? cmd.gridVoltagePU : 1.0)
    : fieldPU * tb.speedPU;
  // Power factor.
  const p = tb.generatorMWe, q = tb.reactiveMVAR;
  const s = Math.hypot(p, q);
  tb.powerFactor = s > 1 ? p / s : 1.0;

  // Diagnostics for the gauge layer.
  out.turbineMechPowerMW = tb.mechPowerMW;
  out.turbineHpPowerMW = tb.hpPowerMW;
  out.turbineLpPowerMW = tb.lpPowerMW;
  out.turbineSpeedPU = tb.speedPU;
  out.generatorMVAR = tb.reactiveMVAR;
  out.generatorPowerFactor = tb.powerFactor;
  out.generatorTerminalVoltagePU = tb.terminalVoltagePU;
}
