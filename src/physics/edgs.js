// edgs.js — III.14 Emergency Diesel Generators + ECCS-bus load sequencer.
//
// Class 1E EDG(s) (TDI- or EMD-class engines) auto-start on a Loss of
// Offsite Power signal. Count and rating come from T.edgs (this sim
// runs a single 9000 kW unit). The startup sequence
// (NUREG-1410 / WCAP-15784) is:
//
//   t = 0    : LOOP detected
//   t ≈ 10 s : EDG comes up to speed, output breaker closes onto its
//              dead bus
//   t ∈ [10, 60] s : Load sequencer brings safety loads on in steps so
//              the diesel doesn't trip on overload. ECCS injection
//              pumps land roughly mid-sequence, ~30-40 s after EDG
//              breaker close.
//
// We model that as a single `loadSequencerSec` accumulator per EDG that
// climbs 0 → 60 once the breaker is closed. The ECCS bus energizes when
// any EDG's sequencer passes the ECCS step (35 s by default; tunable
// via T.edgs.eccsBusEnergizeAtSec).
//
// Failure modes (per-EDG, scenario-injectable via cmd.edgFault[]):
//   - 'fuel'     : injection-rack stop solenoid stuck — engine keeps
//                  burning but no recovery. We model it as a tank
//                  immediately empty.
//   - 'jacket'   : jacket water cooling lost (CCW down). Engine
//                  overheats. We trip output at jacket temperature
//                  > 110 °C, which arrives over ~30 min if the engine
//                  is loaded.
//   - 'lube'     : lube oil pressure low (oil pump failure). Instant
//                  trip — real plant has the trip relay direct-wired
//                  to the engine breaker for crank protection.
//   - 'governor' : governor runaway — load can't be controlled. Output
//                  is forced to runout (120 % overload) and the engine
//                  trips on overcurrent in ~3 minutes.
//   - 'none'     : no fault.
//
// Resource bookkeeping:
//   - fuelOilTankKg : per-EDG tank (T.edgs.fuelOilTankInitialKg),
//                     sized for ~7 days at full load. Burn rate scales
//                     with output. Below 10 % the lowFuelOil warning latches.
//   - jacketWaterTempK : warms while loaded with no CCW; cools toward
//                        ambient when CCW is restored or load is shed.
//   - lubeOilPressureMPa : starts at 0.5 MPa nominal; the 'lube' fault
//                          collapses it to zero immediately.
//
// References:
//   - NUREG-1410 "Loss of Vital AC Power and Residual Heat Removal"
//   - WCAP-15784 "Risk-Informed Assessment of EDG Mission Time"
//   - 10 CFR 50.63 (Station Blackout Rule, EDG reliability requirements)
//   - IEEE 387-2017 "Diesel-Generator Units Applied as Standby Power
//     Supplies for Nuclear Power Generating Stations"
//
// Module ordering in sim.js: AFTER stepElectrical (so we read this step's
// battery state for the control-power floor) and BEFORE stepAuxCooling /
// stepCvcs (so they see this step's `eccsBusEnergized` flag).

import { DC_CONTROL_FLOOR_FRAC } from './electrical.js';

// Engine-rating reference. The actual per-unit rating is T.edgs.ratedKwPerEdg;
// this 4500 kW figure is the calibration anchor for the fuel-burn rate
// (FUEL_BURN_KG_PER_S_AT_RATED was measured against it).
const RATED_KW_REFERENCE = 4500;

// Startup timing.
const START_DELAY_SEC = 10; // breaker close after start command
// Load-sequencer step at which the ECCS bus is energized. Real Westinghouse
// sequencers walk through 5-10 stages, with ECCS landing roughly halfway.
const ECCS_BUS_ENERGIZE_DEFAULT_SEC = 35;

// Fuel consumption: ~0.2 kg/s per running EDG at rated load. Real number is
// closer to 0.18 (TDI DSR-48 spec sheet, ~225 g/kWh × 4500 kW / 3600 s),
// but 0.2 keeps the math rounder and is within the ±10 % calibration band.
const FUEL_BURN_KG_PER_S_AT_RATED = 0.20;

// Jacket-water thermal model. Engine block + jacket water at ~5000 kg ×
// ~3.8 kJ/kg/K → ~19 MJ/K. CCW removes heat at ~30 % of engine output
// when cooling is healthy; with cooling lost, ALL the dissipated heat
// (~30 % of fuel energy) goes into the block.
const JACKET_HEAT_CAP_J_PER_K = 1.9e7;
const ENGINE_DISSIPATION_FRAC = 0.30; // fraction of fuel energy → block heat
const FUEL_HEATING_VALUE_J_PER_KG = 4.27e7; // diesel ~42.7 MJ/kg
const JACKET_AMBIENT_K = 320; // 47 °C nominal jacket-water inlet
const JACKET_TRIP_K = 383.15; // 110 °C — overheat trip
const JACKET_COOLING_W_PER_K = 8e4; // ~80 kW/K — calibrated against the
// 30-min-to-trip target with engine at full load and CCW lost.

// Lube oil — compact placeholder; jacket water and fuel are modeled in more
// detail, but oil pressure is still a simple trip threshold.
const LUBE_OIL_NOMINAL_MPA = 0.50;
const LUBE_OIL_TRIP_MPA = 0.20;

// Warning thresholds.
const LOW_FUEL_FRAC = 0.10;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Per-step EDG advancement. PWR-only — RBMK / MSR omit `T.edgs` and the
 * module early-returns.
 *
 * Reads:
 *   - state.cmd.lossOfOffsitePower
 *   - state.cmd.edgManualStart[i] (override for testing without LOOP)
 *   - state.cmd.edgManualStop[i]
 *   - state.cmd.edgFault[i] in {'none','fuel','jacket','lube','governor'}
 *   - state.electrical?.dcAvailable + per-bank batteryFrac (control floor)
 *   - state.ccw?.available (jacket cooling — read-only; aux-cooling.js owns)
 *
 * Writes:
 *   - state.edgs.units[i].{running, outputKW, fuelOilTankKg,
 *                          jacketWaterTempK, lubeOilPressureMPa,
 *                          loadSequencerSec, faulted, faultReason,
 *                          startDelayAccumSec, fuelBurnKgPerS}
 *   - state.edgs.runningCount
 *   - state.edgs.totalOutputKW
 *   - state.edgs.eccsBusEnergized
 *   - state.edgs.lowestFuelFrac
 */
export function stepEdgs(state, dt) {
  const T = state.T;
  if (!T.edgs) return;
  const eg = state.edgs;
  if (!eg) return; // defensive
  const cfg = T.edgs;

  const eccsEnergizeSec = cfg.eccsBusEnergizeAtSec ?? ECCS_BUS_ENERGIZE_DEFAULT_SEC;
  const tankSizeKg = cfg.fuelOilTankInitialKg ?? 150000;

  // Per-unit rating + governor overload (120 %). Fuel burn at rated load
  // scales from the reference figure so a larger collapsed unit burns
  // proportionally more.
  const ratedKW = cfg.ratedKwPerEdg ?? RATED_KW_REFERENCE;
  const overloadKW = ratedKW * 1.2;
  const ratedBurnKgPerS = FUEL_BURN_KG_PER_S_AT_RATED * ratedKW / RATED_KW_REFERENCE;

  // Operator commands. Defaults — empty / undefined arrays still resolve
  // to "no fault, no manual override."
  const manualStart = state.cmd.edgManualStart || [];
  const manualStop = state.cmd.edgManualStop || [];
  const faults = state.cmd.edgFault || [];
  const offsitePowerLost = !!state.cmd.lossOfOffsitePower;

  // Control-power floor — EDG can't start without DC for the breaker
  // controls + start solenoid. Per the file header, we're reading
  // electrical.js's CURRENT-step output (electrical runs first in sim.js).
  // Falls back to "available" if electrical.js hasn't built state.electrical
  // yet (e.g. very first frame on a non-PWR before swap, or RBMK/MSR).
  const dcOk = !state.electrical
    || (state.electrical.dcAvailable === true);

  let runningCount = 0;
  let totalKW = 0;
  let eccsBusEnergized = false;
  let lowestFuelFrac = 1;

  for (let i = 0; i < eg.units.length; i++) {
    const u = eg.units[i];
    const fault = faults[i] || u.faultReason || 'none';
    const wantsStart = (offsitePowerLost || !!manualStart[i])
      && !manualStop[i];

    // === Apply scenario-injected faults ===
    // Latched once raised — fault clears only via a dedicated reset
    // command (not modeled yet — scenarios that want to recover should
    // null the fault flag AND set u.faulted = false directly).
    if (fault !== 'none' && u.faultReason === 'none') {
      u.faulted = true;
      u.faultReason = fault;
      // Fault-specific instantaneous side effects.
      if (fault === 'fuel') {
        // Engine immediately runs out of fuel — supply line break or stop
        // solenoid stuck. Leaves the existing fuel quantity readable for
        // forensics ("had 137,000 kg at the time of failure") rather than
        // zeroing it.
        u.faultDescr = 'fuel supply lost';
      } else if (fault === 'lube') {
        u.lubeOilPressureMPa = 0;
        u.faultDescr = 'lube oil pressure trip';
      } else if (fault === 'governor') {
        u.faultDescr = 'governor runaway';
      } else if (fault === 'jacket') {
        u.faultDescr = 'jacket cooling lost';
      }
    }

    // === Start sequence ===
    // Fully transient — once the start delay clears, the unit "runs" if
    // there are no trips.
    if (wantsStart && !u.running && !u.faulted && dcOk) {
      u.startDelayAccumSec += dt;
      if (u.startDelayAccumSec >= START_DELAY_SEC) {
        u.running = true;
        u.loadSequencerSec = 0;
      }
    } else if (!wantsStart && u.running) {
      // Operator stop / LOOP cleared. Trip the breaker, run the engine
      // through cooldown idle (modeled instantly here — IRL ~5 min).
      u.running = false;
      u.outputKW = 0;
      u.loadSequencerSec = 0;
      u.startDelayAccumSec = 0;
    }

    // === Trip checks (running engines only) ===
    if (u.running) {
      // Lube oil pressure — instant trip.
      if (u.lubeOilPressureMPa < LUBE_OIL_TRIP_MPA) {
        u.running = false;
        u.outputKW = 0;
        u.faulted = true;
        u.faultReason = u.faultReason === 'none' ? 'lube' : u.faultReason;
        u.faultDescr = 'lube oil pressure trip';
      }
      // Jacket overheat — slow trip.
      if (u.jacketWaterTempK > JACKET_TRIP_K) {
        u.running = false;
        u.outputKW = 0;
        u.faulted = true;
        u.faultReason = u.faultReason === 'none' ? 'jacket' : u.faultReason;
        u.faultDescr = 'jacket overtemp trip';
      }
      // Fuel exhaustion — graceful trip (engine stops, no fault flag
      // because tank-empty is recoverable by refilling).
      if (u.fuelOilTankKg <= 0) {
        u.running = false;
        u.outputKW = 0;
      }
    }
    // 'fuel' fault forces tank empty regardless of running state, so the
    // engine can't keep running on residual fuel after the fault is
    // injected. Real failure mode for stop-solenoid-stuck would be the
    // opposite (can't shut down) but we don't model the breaker side of
    // the consequence.
    if (u.faulted && u.faultReason === 'fuel') {
      u.fuelOilTankKg = 0;
    }

    // === Load + output ===
    if (u.running) {
      u.loadSequencerSec += dt;
      // Output ramps with the sequencer until rated, then sits at rated
      // unless governor-failed.
      const baseFrac = clamp(u.loadSequencerSec / Math.max(1, eccsEnergizeSec * 1.5), 0, 1);
      let outputKW = baseFrac * ratedKW;
      if (u.faulted && u.faultReason === 'governor') {
        // Runaway — output forced to overload until the engine trips on
        // overcurrent (~3 minutes; we model with the same loadSequencer
        // counter past 180 s).
        outputKW = overloadKW;
        if (u.loadSequencerSec > 180) {
          u.running = false;
          u.outputKW = 0;
        }
      }
      u.outputKW = outputKW;
      // Fuel burn proportional to output share.
      const burnFrac = outputKW / ratedKW;
      const burnKgPerS = ratedBurnKgPerS * burnFrac;
      u.fuelBurnKgPerS = burnKgPerS;
      u.fuelOilTankKg = Math.max(0, u.fuelOilTankKg - burnKgPerS * dt);
      // Jacket water heating. CCW removes heat when available; with
      // cooling lost, all engine dissipation accumulates in the block.
      const heatGenW = burnKgPerS * FUEL_HEATING_VALUE_J_PER_KG * ENGINE_DISSIPATION_FRAC;
      const ccwOk = state.ccw ? (state.ccw.available === true) : true;
      const heatRemovedW = ccwOk
        ? heatGenW + JACKET_COOLING_W_PER_K * (u.jacketWaterTempK - JACKET_AMBIENT_K)
        : 0;
      const dT = (heatGenW - heatRemovedW) * dt / JACKET_HEAT_CAP_J_PER_K;
      u.jacketWaterTempK = Math.max(JACKET_AMBIENT_K, u.jacketWaterTempK + dT);
      // Lube oil pressure: nominal while running unless faulted.
      if (u.faultReason !== 'lube') {
        u.lubeOilPressureMPa = LUBE_OIL_NOMINAL_MPA;
      }
      runningCount += 1;
      totalKW += outputKW;
      // ECCS bus energizes once any EDG's sequencer crosses the step.
      if (u.loadSequencerSec >= eccsEnergizeSec) eccsBusEnergized = true;
    } else {
      // Engine stopped — bleed jacket back toward ambient through residual
      // heat-loss to the room. Slow because no forced cooling.
      const dTbleed = -0.05 * (u.jacketWaterTempK - JACKET_AMBIENT_K) * dt;
      u.jacketWaterTempK = Math.max(JACKET_AMBIENT_K, u.jacketWaterTempK + dTbleed);
      u.outputKW = 0;
      u.fuelBurnKgPerS = 0;
    }

    const tankFrac = u.fuelOilTankKg / Math.max(1, tankSizeKg);
    u.fuelTankFrac = tankFrac;
    if (tankFrac < lowestFuelFrac) lowestFuelFrac = tankFrac;
  }

  eg.runningCount = runningCount;
  eg.totalOutputKW = totalKW;
  eg.eccsBusEnergized = eccsBusEnergized;
  eg.lowestFuelFrac = lowestFuelFrac;
  eg.anyFaulted = eg.units.some(u => u.faulted);
  eg.lowFuelOil = lowestFuelFrac < LOW_FUEL_FRAC;
  // Convenience: was AT LEAST one EDG ever started this trip? Used by
  // the rps.js `edgRunning` indicator, which is a "good news" warning
  // (light is on while EDGs are carrying load — operator awareness, not
  // an alarm).
  eg.anyRunning = runningCount > 0;
}
