// electrical.js — III.15 Class 1E DC distribution + III.16 vital AC inverters
// + offsite-power / switchyard coupling.
//
// Westinghouse-class PWR has four redundant Class 1E electrical trains
// (A, B, C, D). Each train has a station battery bank, a battery charger
// (rectifier off the safety AC bus), and an inverter (DC → regulated 120 V
// vital AC for instrumentation + RPS logic). Three PRA / SBO-relevant
// questions live here:
//
//   1. Is AC power available on the safety buses? Drives EDG starts, CCW /
//      SW pump motors, charging-pump motors, ECCS pump motors, and the
//      battery chargers. See `state.electrical.acAvailable`.
//
//   2. Is DC control power around? Class 1E batteries hold up the DC
//      instrument buses during a station blackout. See
//      `state.electrical.batteryAh[0..3]` / `dcAvailable`.
//
//   3. Is VITAL AC around? The vital instrument buses are fed by inverters,
//      not directly off the safety AC bus. The inverter's input is the
//      battery (or, when AC is up, the charger output). So vital AC
//      SURVIVES a station blackout on battery power — until the batteries
//      deplete, at which point the inverters drop out and the operator
//      loses instrumentation, RPS logic, and TDAFW control. This is the
//      instrument-loss-order question that defines the late-SBO sequence.
//      See `state.electrical.vitalAcAvailable` / `inverters[]`.
//
// === III.16 — vital AC inverters ===
//
// 4 inverters, one per train. Inverter i is available iff it is not
// faulted (`cmd.inverterFault[i]`) AND either main AC is up (the inverter
// runs off the charger / a regulated maintenance-bypass source) OR its
// own battery bank is above the inverter dropout floor. `vitalAcAvailable`
// is true iff ANY inverter is up. When AC is lost the inverter draws its
// vital-AC load from the battery (`sourceFromBattery`), which is what
// makes the SBO battery-discharge load realistic (III.15 modelled only a
// light "instrumentation" load and never drained the bank during normal
// ops — that is fixed here).
//
// === III.16 — offsite power / switchyard ===
//
// Offsite power reaches the safety buses through the switchyard +
// startup/aux transformers. `state.electrical.grid.voltagePU` is the
// switchyard voltage (operator/scenario knob `cmd.gridVoltagePU`, default
// 1.0). Two undervoltage relays watch the safety bus:
//   - Loss-of-voltage (LOV): voltage < ~0.25 PU sustained ~2 s.
//   - Degraded-voltage:      voltage < ~0.90 PU sustained ~60 s (the
//     second-level UV relay mandated post-1979, IE Bulletin 79-27 /
//     Generic Letter 79-36 — protects safety motors from sustained
//     undervoltage).
// Either relay, on actuation, latches `cmd.lossOfOffsitePower = true` —
// i.e. it trips the bus off offsite power and transfers to the EDGs,
// exactly as a real plant's LOOP signal is generated. Everything
// downstream (edgs.js auto-start, eccs.js AC gating, rps.js LOOP scram)
// then responds through the existing `cmd.lossOfOffsitePower` signal with
// no extra wiring. The relay only ever LATCHES the flag true; the
// operator clears it manually (manual bus re-transfer) once grid voltage
// is restored.
//
// === III.16 — load shedding ===
//
// During a station blackout the inverter draws its full vital-AC load
// from the battery. `cmd.manualLoadShed` is the operator action to shed
// non-essential vital loads, cutting the per-bank discharge from the full
// figure to a vital-only figure — the difference between a ~4 h and a
// ~7 h battery life. `loadShedActive` mirrors the command.
//
// Circular dependency with edgs.js (unchanged from III.15):
//   stepElectrical runs FIRST in sim.js. It reads the PREVIOUS step's
//   `state.edgs.runningCount`; edgs.js then reads THIS step's
//   `state.electrical.dcAvailable`. One-step lag on slow systems, no
//   fixed-point iteration.
//
// References:
//   - NUREG-1776 "Regulatory Effectiveness of the Station Blackout Rule"
//   - NUREG/CR-6890 "Reevaluation of Station Blackout Risk at NPPs"
//   - IEEE Std 308-2020 "Class 1E Power Systems for Nuclear Generating
//     Stations" (battery sizing)
//   - IE Bulletin 79-27 / Generic Letter 79-36 (degraded-voltage relay)
//   - IEEE Std 944 "Application & Testing of Uninterruptible Power
//     Supplies" (inverter / vital AC)

const NUM_BANKS = 4;

// Per-bank rated capacity (amp-hours) and nominal terminal voltage.
const BANK_CAPACITY_AH = 2000;
const BANK_VOLTAGE_FULL_V = 250;
const BANK_VOLTAGE_EMPTY_V = 200;

// Per-bank base DC load (instrumentation + control + relay logic) that the
// inverter reflects onto the battery during a blackout. Always present.
const L_INSTRUMENT_BASE_A = 50;

// Vital-AC inverter load reflected onto the battery while the inverter is
// running off the battery (AC lost). Full load vs the post-load-shed
// vital-only figure. Per-bank SBO discharge: base + inverter.
//   unshed:  50 + 450 = 500 A → 2000 Ah ≈ 4.0 h battery life
//   shed:    50 + 250 = 300 A → 2000 Ah ≈ 6.7 h battery life
// — within the IEEE-308 / NUREG-1776 4-8 h Class-1E SBO band.
const INVERTER_LOAD_FULL_A = 450;
const INVERTER_LOAD_SHED_A = 250;

// Charger float / recharge current per bank when the safety AC bus is
// energised. The charger carries the full DC + inverter load directly;
// the battery only sees current when recharging from a prior discharge
// (modelled as a flat float-rate top-up — the bulk phase is a sub-minute
// event vs the multi-hour discharge dynamics we care about) or, with AC
// lost, when supplying the load.
const CHARGER_FLOAT_A_PER_BANK = 30;

// Battery cap as a fraction of rated — charging tapers to zero above this.
const BANK_CHARGE_CAP_FRAC = 1.10;

// Inverter input dropout: below this bank fraction the inverter can no
// longer regulate and drops its vital-AC output. Same value as the DC
// control floor — the inverter and the control buses die together.
const INVERTER_DROPOUT_FRAC = 0.05;

// Undervoltage relay setpoints + time delays (switchyard voltage, PU).
const LOSS_OF_VOLTAGE_PU = 0.25;
const LOV_DELAY_SEC = 2;
const DEGRADED_VOLTAGE_PU = 0.90;
const DEGRADED_DELAY_SEC = 60;

// Warning thresholds (mirrored into rps.js).
const LOW_BANK_FRAC = 0.30;
const DEPLETED_BANK_FRAC = 0.05;

// Control-power floor for EDG start logic. edgs.js reads this so the
// constant lives near both consumers — keep in sync.
export const DC_CONTROL_FLOOR_FRAC = 0.05;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Per-step DC distribution + vital AC + AC roll-up. PWR-only — RBMK and
 * MSR omit `T.electrical` and the module early-returns.
 *
 * Reads:  state.cmd.lossOfOffsitePower / gridVoltagePU / manualLoadShed /
 *         inverterFault[], state.edgs?.runningCount (previous step).
 * Writes: state.electrical.* (batteries, grid, inverters, vitalAcAvailable,
 *         loadShedActive, acAvailable, dcAvailable), and LATCHES
 *         state.cmd.lossOfOffsitePower on an undervoltage-relay actuation.
 */
export function stepElectrical(state, dt) {
  const T = state.T;
  if (!T.electrical) return;
  const elec = state.electrical;
  if (!elec) return; // defensive

  // === Grid / switchyard + undervoltage relays (III.16) ===
  const grid = elec.grid;
  grid.voltagePU = clamp(state.cmd.gridVoltagePU ?? 1.0, 0, 1.5);
  // Instantaneous undervoltage flags (drive the annunciator warnings).
  grid.degradedVoltage = grid.voltagePU < DEGRADED_VOLTAGE_PU;
  grid.lossOfVoltage = grid.voltagePU < LOSS_OF_VOLTAGE_PU;
  // Sustained-condition accumulators. The LOV relay is fast (~2 s); the
  // degraded-voltage relay is slow (~60 s). Either, sustained past its
  // delay, actuates the LOOP signal. Accumulators drain when voltage
  // recovers above the setpoint.
  grid._lovAccumSec = grid.lossOfVoltage
    ? grid._lovAccumSec + dt
    : Math.max(0, grid._lovAccumSec - dt);
  grid._degAccumSec = grid.degradedVoltage
    ? grid._degAccumSec + dt
    : Math.max(0, grid._degAccumSec - dt);
  const uvRelayActuated = grid._lovAccumSec > LOV_DELAY_SEC
    || grid._degAccumSec > DEGRADED_DELAY_SEC;
  // The undervoltage relay LATCHES the LOOP signal — it trips the safety
  // bus off offsite power and transfers to the EDGs. Once latched the
  // operator must clear cmd.lossOfOffsitePower manually (bus re-transfer).
  if (uvRelayActuated && !state.cmd.lossOfOffsitePower) {
    state.cmd.lossOfOffsitePower = true;
  }
  const offsitePowerLost = !!state.cmd.lossOfOffsitePower;
  grid.offsiteAvailable = !offsitePowerLost;

  // Previous-step EDG count drives the AC roll-up + charging current.
  const edgRunningCount = state.edgs ? (state.edgs.runningCount | 0) : 0;

  // === Aggregate DC availability ===
  // Any bank above the control-power floor counts (vital instrumentation
  // is bussed across all four trains).
  let dcAvailable = false;
  for (let i = 0; i < NUM_BANKS; i++) {
    if (elec.batteryAh[i] / BANK_CAPACITY_AH > DC_CONTROL_FLOOR_FRAC) {
      dcAvailable = true;
      break;
    }
  }
  elec.dcAvailable = dcAvailable;

  // === AC availability roll-up ===
  // Offsite power is the cheapest source. Lost → need ≥1 EDG running AND
  // DC control power for the EDG output breakers.
  const acAvailable = !offsitePowerLost
    ? true
    : (edgRunningCount > 0 && dcAvailable);
  elec.acAvailable = acAvailable;

  // === Vital AC inverters (III.16) ===
  // Each inverter is fed from the charger when AC is up, from its own
  // battery when AC is lost. Available iff not faulted AND (AC up OR its
  // bank above the inverter dropout floor). Vital AC is up iff ANY
  // inverter is up — so vital AC survives a blackout on battery power.
  const faultArr = state.cmd.inverterFault || [];
  const sourceFromBattery = !acAvailable;
  let anyInverterUp = false;
  for (let i = 0; i < NUM_BANKS; i++) {
    const inv = elec.inverters[i];
    inv.faulted = faultArr[i] === true;
    const bankFrac = elec.batteryAh[i] / BANK_CAPACITY_AH;
    inv.available = !inv.faulted
      && (acAvailable || bankFrac > INVERTER_DROPOUT_FRAC);
    inv.sourceFromBattery = sourceFromBattery && inv.available;
    if (inv.available) anyInverterUp = true;
  }
  elec.vitalAcAvailable = anyInverterUp;

  // === Load shedding (III.16) ===
  // Operator action: shed non-essential vital loads to extend battery
  // life during a blackout. Only matters while inverters run off battery.
  const loadShedActive = state.cmd.manualLoadShed === true;
  elec.loadShedActive = loadShedActive;
  const inverterDrawA = loadShedActive ? INVERTER_LOAD_SHED_A
    : INVERTER_LOAD_FULL_A;

  // === Per-bank discharge / charge bookkeeping ===
  // AC up: the charger carries the DC + inverter load directly and floats
  //   the battery — the battery only takes a recharge trickle if it is
  //   below 100 % (net current ≥ 0, no normal-ops drain).
  // AC down: the battery supplies the base load plus, for each up
  //   inverter, that inverter's vital-AC draw.
  let aggDischargeA = 0;
  let aggChargingA = 0;
  const cellCap = BANK_CAPACITY_AH * BANK_CHARGE_CAP_FRAC;
  for (let i = 0; i < NUM_BANKS; i++) {
    let netA;
    let loadA;
    if (acAvailable) {
      // Charger carries the load; battery floats (or recharges).
      loadA = 0;
      netA = elec.batteryAh[i] < BANK_CAPACITY_AH
        ? CHARGER_FLOAT_A_PER_BANK
        : 0;
    } else {
      // Blackout: battery supplies base load + its inverter's draw.
      const invA = elec.inverters[i].available ? inverterDrawA : 0;
      loadA = L_INSTRUMENT_BASE_A + invA;
      netA = -loadA;
    }
    elec.dcLoadAmps[i] = loadA;
    // dQ = I · dt (seconds → hours via /3600).
    elec.batteryAh[i] = clamp(elec.batteryAh[i] + netA * dt / 3600, 0, cellCap);
    const frac = elec.batteryAh[i] / BANK_CAPACITY_AH;
    elec.batteryFrac[i] = frac;
    // Linear voltage curve (good to ~5 % for the operator's panel).
    elec.batteryV[i] = BANK_VOLTAGE_EMPTY_V
      + clamp(frac, 0, 1) * (BANK_VOLTAGE_FULL_V - BANK_VOLTAGE_EMPTY_V);
    if (netA > 0) aggChargingA += netA;
    else aggDischargeA += -netA;
  }
  elec.totalDischargeA = aggDischargeA;
  elec.totalChargingA = aggChargingA;

  // === Lowest-bank readouts (for the gauge layer) ===
  let minFrac = 1;
  let minIdx = 0;
  for (let i = 0; i < NUM_BANKS; i++) {
    if (elec.batteryFrac[i] < minFrac) {
      minFrac = elec.batteryFrac[i];
      minIdx = i;
    }
  }
  elec.minBankFrac = minFrac;
  elec.minBankIndex = minIdx;
  elec.anyBankLow = minFrac < LOW_BANK_FRAC;
  elec.anyBankDepleted = minFrac < DEPLETED_BANK_FRAC;
}
