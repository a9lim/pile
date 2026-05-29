// rps.js -- Reactor Protection System: SCRAM channels, warning annunciators,
// and scram drive.
//
// TRIP_LABELS contains both scram-capable trips and warning/status lamps. Only
// keys listed in SCRAM_TRIPS actually fire a scram; the rest latch for operator
// indication. Once any non-bypassed SCRAM_TRIP trips and SCRAM is enabled, all
// safety rods drive in at the reactor-type-specific scram speed.
//
// Core scram channels:
//   highFlux          : avg flux > 1.15 of nominal
//   shortPeriod       : period < 20 s and rising (positive period only)
//   lowDnbr           : DNBR_min < 1.3 at the hot channel — Bowring-class CHF
//                       correlation in physics/chf.js. The standard PWR SAFDL
//                       (Specified Acceptable Fuel Design Limit) is 1.3.
//                       Bypassed for MSR (no boiling crisis in single-phase salt).
//   highCoolantT      : top-of-core coolant > 340°C (PWR), 290°C (RBMK), 720°C (MSR)
//   lowPressurizerP   : < 13 MPa (PWR)
//   highPressurizerP  : > 17 MPa (PWR)
//   lowSgLevel        : < 0.15 (PWR)
//   highSgLevel       : > 0.85 (PWR)
//   highContainmentP  : > 0.15 MPa abs (PWR)
//   lowCoolantFlow    : < 0.85 of nominal
//   manualScram       : operator-initiated
//   lossOfOffsitePower: pump trip + bus loss → scram

const TRIP_LABELS = Object.freeze({
  highFlux:           'HIGH FLUX',
  shortPeriod:        'SHORT PERIOD',
  lowDnbr:            'LOW DNBR',
  highCoolantT:       'HIGH COOLANT T',
  lowPressurizerP:    'LOW PZR P',
  highPressurizerP:   'HIGH PZR P',
  // III.2 — Pressurizer level trips (PWR only). Low-level scram protects the
  // heater elements from uncovering and the steam space from collapsing;
  // high-level scram prevents water-solid (no steam dome) operation which
  // would eliminate pressure control authority.
  lowPzrLevel:        'LOW PZR LVL',
  highPzrLevel:       'HIGH PZR LVL',
  lowSgLevel:         'LOW SG LVL',
  highSgLevel:        'HIGH SG LVL',
  highContainmentP:   'HIGH CONT P',
  lowCoolantFlow:     'LOW FLOW',
  manualScram:        'MANUAL SCRAM',
  lossOfOffsitePower: 'LOOP',
  lowOrm:             'LOW ORM',
  // II.7 — Flow excursion (Ledinegg) warning. RBMK direct-cycle only.
  // Operator indication, not a scram input: response is to raise flow or
  // reduce power, not to slam the rods (which would actually worsen the
  // dryout in the hot channel on a slow scram).
  flowExcursion:      'FLOW EXCURSION',
  // Wave-B — RBMK drum-separator level protection (direct-cycle only).
  // lowDrumLevel is a SCRAM input (loss of drum water → pressure-tube dryout);
  // highDrumLevel is a WARNING (moisture carryover degrades the turbine).
  lowDrumLevel:       'LOW DRUM LVL',
  highDrumLevel:      'HIGH DRUM LVL',
  // Wave-B — RBMK auxiliary-AC WARNING channels (direct-cycle only). SBO =
  // no offsite, no diesel, rundown expired (MCPs coasting to natural circ).
  rbmkSbo:            'STATION BLACKOUT',
  rbmkDgFault:        'DIESEL FAULT',
  // Wave-B — RBMK ECCS / ALS WARNING channels (direct-cycle only).
  rbmkEccsActuated:   'ECCS ACTUATED',
  rbmkAlsHighP:       'HIGH ALS P',
  // Wave-C — RBMK auxiliary-circuit WARNING channels (direct-cycle only).
  gasCircuitLost:     'GAS CIRCUIT',
  highGraphiteTemp:   'HIGH GRAPHITE T',
  cpsCoolingLost:     'CPS COOLING',
  rbmkMfwLost:        'MFW LOST',
  // Wave-D — RBMK pressure-tube break (LOCA) WARNING.
  rbmkPipeBreak:      'PRESSURE TUBE BREAK',
  // MSR-A — air-radiator / coolant-salt WARNING channels (MSR only).
  msrSaltFreeze:      'COOLANT SALT FREEZE',
  msrFreezeHeaters:   'FREEZE HEATERS',
  // MSR-B — off-gas + reactor-cell WARNING channels (MSR only).
  msrOffGasLost:      'OFF-GAS LOST',
  msrCellHighTemp:    'CELL HIGH T',
  // MSR-C — fuel-salt chemistry WARNING channels (MSR only).
  msrRedoxHigh:       'REDOX OXIDIZING',
  msrCorrosion:       'CORROSION',
  // III.4 — RCP shaft-seal LOCA scram trip. PWR-only. Fires when stage 2
  // of the staged "21-21-21" failure has latched (cumulative leak ≈ 76
  // gpm/pump — primary draining faster than HHSI can compensate over
  // sustained periods).
  sealLoca:           'SEAL LOCA',
  // III.4 — RCP seal cooling lost. WARNING channel only (excluded from
  // SCRAM_TRIPS). Fires after 2 sustained sim-seconds of both seal
  // injection AND CCW unavailable. Pedagogical: gives the operator ~25
  // min warning before sealLoca itself fires.
  sealCoolingLost:    'SEAL COOLING',
  // III.5 — Safety Injection actuated. WARNING channel — indicates that
  // ECCS is running, not a fault. PWR-only via state.eccs presence.
  siActuated:         'SI ACTUATED',
  // III.6 — Low RWST. WARNING channel — fires at < 20% to prompt the
  // operator to prepare for E-1.3 sump-switchover. PWR-only.
  lowRwst:            'LOW RWST',
  // III.5 — NPSH-loss warnings on the HHSI / LHSI pumps. WARNING
  // channels — latch when sustained-suction-inadequacy takes the pump
  // offline. PWR-only.
  npshLossHhsi:       'NPSH HHSI',
  npshLossLhsi:       'NPSH LHSI',
  // III.3 — CVCS warnings. PWR-only via state.cvcs presence.
  cvcsLoss:           'CVCS LOSS',
  letdownIsolated:    'LETDOWN ISO',
  // III.14 — EDG status / fault / fuel warnings. PWR-only.
  // edgRunning is intentionally a "good news" lamp.
  edgRunning:         'EDG ON',
  edgFailure:         'EDG FAULT',
  lowFuelOil:         'LOW FUEL OIL',
  // III.15 — DC battery warnings. PWR-only.
  batteryLow:         'BATT LOW',
  batteryDepleted:    'BATT DEPLETED',
  // III.16 — grid / vital-AC warnings. PWR-only.
  degradedGridVoltage: 'DEGRADED GRID',
  vitalAcLost:        'VITAL AC LOST',
  // III.19 — CCW + SW warnings. PWR-only.
  lossCcw:            'LOSS CCW',
  lossSw:             'LOSS SW',
  ccwHotLeg:          'CCW HOT',
  // III.8 — AFW WARNING channels. PWR-only via state.afw presence.
  afwActuated:        'AFW ACTUATED',
  afwLowFlow:         'AFW LOW FLOW',
  tdafwUnavailable:   'TDAFW UNAVAIL',
  // III.11 — Loss of main feedwater WARNING. PWR-only.
  mfwLost:            'MFW LOST',
  // III.12 — Steam generator tube rupture WARNING. PWR-only.
  sgtr:               'SGTR',
  // III.13 — Turbine mechanical overspeed SCRAM. PWR-only.
  turbineOverspeed:   'TURB OVERSPD',
  // III.9 — Secondary-valve WARNING channels. PWR-only.
  msivClosed:         'MSIV CLOSED',
  advManualOpen:      'ADV OPEN',
  // III.17 — Containment WARNING channels. PWR-only via state.containment
  // presence. highContainmentTemp fires on a sustained atmosphere over-temp;
  // containmentSprayActuated is a status lamp (sprays running). Both WARNING
  // (excluded from SCRAM_TRIPS) — the existing highContainmentP SCRAM channel
  // is unchanged and remains the containment-pressure scram authority.
  highContainmentTemp:      'HIGH CONT T',
  containmentSprayActuated: 'CONT SPRAY',
  // III.20 — Spent Fuel Pool WARNING channels. PWR-only via state.sfp
  // presence. NONE are SCRAM inputs — the SFP is independent of the reactor
  // and an SFP cooling loss must not trip the reactor.
  sfpCoolingLost:     'SFP COOL LOST',
  sfpHighTemp:        'SFP HIGH T',
  sfpBoiling:         'SFP BOILING',
  sfpLowLevel:        'SFP LOW LVL',
  sfpFuelUncovered:   'SFP UNCOVERED',
});
export const TRIP_KEYS = Object.freeze(Object.keys(TRIP_LABELS));
export function tripLabel(key) { return TRIP_LABELS[key]; }

// I.6 — The set of trip channels that actually fire scram. `lowOrm` is an
// operator WARNING channel only: scramming at low ORM is what triggered
// Chernobyl (graphite tip slams into void-positive bottom-of-core). Real
// RBMK control rooms had ORM as a separate panel indication, not a wired
// scram input. We follow that convention.
const SCRAM_TRIPS = Object.freeze(new Set([
  'highFlux', 'shortPeriod', 'lowDnbr', 'highCoolantT',
  'lowPressurizerP', 'highPressurizerP',
  // III.2 — pressurizer level trips are real-plant SCRAM inputs.
  'lowPzrLevel', 'highPzrLevel',
  'lowSgLevel', 'highSgLevel',
  'highContainmentP', 'lowCoolantFlow', 'manualScram', 'lossOfOffsitePower',
  // Wave-B/D — RBMK low drum level (channel dryout) + high ALS compartment
  // pressure (suppression-pool over-pressure = pressure-tube-break detection)
  // are scram inputs.
  'lowDrumLevel', 'rbmkAlsHighP',
  // III.4 — Stage-2 seal failure is the SCRAM input. Stage-1 alone stays
  // a warning (sealCoolingLost) since HHSI can absorb the ~21 gpm leak.
  'sealLoca',
  // III.13 — turbine mechanical overspeed trips the reactor (the turbine
  // trip removes the heat sink; the reactor must follow).
  'turbineOverspeed',
]));

export function stepRps(state, dt) {
  const T = state.T;
  const N = state.N;
  let avgFlux = 0;
  for (let k = 0; k < N; k++) avgFlux += state.flux[k];
  avgFlux /= N;

  const topCoolantC = state.T_coolant[N - 1] - 273.15;

  // Short-period trip needs to be SUSTAINED — single noisy substep doesn't trip.
  // Require positive period < 20s observed over 0.5s of sim time, and avg flux
  // actually above 1.0 (rising case, not transient noise from a decaying state).
  const periodCondition = isFinite(state.out.periodSec) && state.out.periodSec > 0 && state.out.periodSec < 20 && avgFlux > 1.02;
  state._shortPeriodAccum = periodCondition ? (state._shortPeriodAccum || 0) + dt : 0;

  // II.7 — Flow excursion (Ledinegg) sustained-condition accumulator. Same
  // pattern as _shortPeriodAccum: bisection solver's multi-root flag has to
  // hold for 2 sim-seconds before the trip latches. Suppresses transient
  // flicker during fast power/flow ramps where the bisection grid might
  // briefly see two roots that disappear next substep.
  const ledineggCond = state.out.ledineggUnstable === true;
  state._ledineggAccum = ledineggCond ? (state._ledineggAccum || 0) + dt : 0;

  // III.4 — RCP seal cooling-lost sustained-condition accumulator. Same
  // pattern again: latches the warning channel after 2 sim-seconds of
  // both injection AND CCW unavailable. The seal-stage-degradation
  // accumulators in state.rcpSeal use minutes (independent of this);
  // this accumulator is just for the operator warning indication.
  const sealCoolLost = !!state.rcpSeal
    && state.rcpSeal.sealInjectionAvailable === false
    && state.rcpSeal.thermalBarrierCoolingAvailable === false;
  state._sealCoolingAccum = sealCoolLost ? (state._sealCoolingAccum || 0) + dt : 0;

  const checks = {
    highFlux:          Math.max(avgFlux, state.out.localPowerPeakFrac ?? avgFlux) > 1.15,
    shortPeriod:       state._shortPeriodAccum > 0.5,
    // I.2 — Real DNBR via Bowring-class CHF in physics/chf.js. Trip at 1.3
    // (the PWR SAFDL — below this point the wall is past nucleate boiling
    // and clad temperature spikes within seconds). MSR has no boiling
    // crisis to depart from (single-phase FLiBe), so dnbrMin is null there
    // and the channel never trips.
    lowDnbr:           T.primaryTopology !== 'msr'
                        && state.out.dnbrMin !== null
                        && Number.isFinite(state.out.dnbrMin)
                        && state.out.dnbrMin < 1.3,
    highCoolantT:      topCoolantC > coolantTripC(T),
    lowPressurizerP:   T.primaryTopology === 'pwr' && state.pressurizerP < 13.0,
    highPressurizerP:  T.primaryTopology === 'pwr' && state.pressurizerP > 17.0,
    // III.2 — PWR-only level trips. The low-level setpoint (0.17) matches the
    // heater-bank low-level lockout in pressurizer.js — once the elements
    // uncover, scram before they burn out. The high-level setpoint (0.92)
    // is the standard interlock against water-solid operation.
    lowPzrLevel:       T.primaryTopology === 'pwr' && state.pressurizerLevel < 0.17,
    highPzrLevel:      T.primaryTopology === 'pwr' && state.pressurizerLevel > 0.92,
    lowSgLevel:        T.primaryTopology === 'pwr' && state.sgSecondaryLevel < 0.15,
    highSgLevel:       T.primaryTopology === 'pwr' && state.sgSecondaryLevel > 0.85,
    highContainmentP:  state.containmentP > 0.15,
    lowCoolantFlow:    (state.out.flowFracOfNominal ?? state.coolantFlowFrac) < 0.85,
    manualScram:       !!state.cmd.scramRequested,
    lossOfOffsitePower: !!state.cmd.lossOfOffsitePower,
    // I.6 — Warning-only channel: ORM below the design-minimum floor (15
    // rod-equivalents). RBMK-only. Latches like a normal trip so the
    // annunciator can flash but is excluded from SCRAM_TRIPS so it doesn't
    // initiate auto-scram. Operator action required.
    lowOrm:            T.id === 'rbmk' && state.out.orm !== null && state.out.orm < 15,
    // II.7 — Warning-only channel: Ledinegg / density-wave flow excursion in
    // RBMK direct-cycle. Same WARNING pattern as lowOrm (excluded from
    // SCRAM_TRIPS) — the appropriate operator response is to raise pump
    // flow or reduce power, not initiate a slow-scram (RBMK's 18-21 s rod
    // insertion would let the hot-channel dryout finish before the rods
    // arrive). 2-second sustained condition gate prevents transient
    // multi-root-flicker from latching the trip.
    flowExcursion:     T.id === 'rbmk' && state._ledineggAccum > 2,
    // Wave-B — RBMK drum-separator level protection. Aggregate (min) drum
    // level is written by plant.js. Low → SCRAM, high → WARNING.
    lowDrumLevel:      T.primaryTopology === 'direct'
                        && state.sgSecondaryLevel < (T.rbmkDrum?.lowLevelScram ?? 0.25),
    highDrumLevel:     T.primaryTopology === 'direct'
                        && state.sgSecondaryLevel > (T.rbmkDrum?.highLevelWarn ?? 0.85),
    // Wave-B — RBMK station blackout + diesel fault WARNINGs.
    rbmkSbo:           !!state.rbmkElectrical && state.rbmkElectrical.acAvailable === false,
    rbmkDgFault:       !!state.rbmkElectrical && state.rbmkElectrical.anyDgFaulted === true,
    // Wave-B — RBMK ECCS actuated (status) + ALS compartment over-pressure.
    rbmkEccsActuated:  !!state.rbmkEccs && state.rbmkEccs.actuated === true,
    rbmkAlsHighP:      !!state.rbmkAls
                        && state.rbmkAls.compartmentPressureMPa
                            > (T.rbmkAls?.highPressureWarnMPa ?? 0.13),
    // Wave-C — RBMK auxiliary-circuit WARNINGs.
    gasCircuitLost:    !!state.rbmkAux && state.rbmkAux.gasCoolingOk === false,
    highGraphiteTemp:  !!state.rbmkAux
                        && state.rbmkAux.avgGraphiteTempK > (T.rbmkAux?.highGraphiteTempWarnK ?? 1373),
    cpsCoolingLost:    !!state.rbmkAux && state.rbmkAux.cpsCoolingOk === false,
    rbmkMfwLost:       !!state.rbmkAux && state.rbmkAux.mfwAvailable === false,
    // Wave-D — pressure-tube break (direct-cycle only).
    rbmkPipeBreak:     T.primaryTopology === 'direct' && state.cmd.rbmkPipeBreak === true,
    // MSR-A — coolant-salt freeze + freeze-heater status (MSR only).
    msrSaltFreeze:     !!state.msrRadiator && state.msrRadiator.coolantSaltFrozen === true,
    msrFreezeHeaters:  !!state.msrRadiator && state.msrRadiator.freezeHeaterOn === true,
    // MSR-B — off-gas loss + reactor-cell over-temp.
    msrOffGasLost:     !!state.msrOffGas && state.msrOffGas.available === false,
    msrCellHighTemp:   !!state.msrCell
                        && state.msrCell.tempK > (T.msrCell?.highTempWarnK ?? 420),
    // MSR-C — redox drifted oxidizing + accumulated corrosion.
    msrRedoxHigh:      !!state.msrChem
                        && state.msrChem.redoxRatio > (T.msrChem?.redoxWarnRatio ?? 1.8),
    msrCorrosion:      !!state.msrChem
                        && state.msrChem.corrosionIndex > (T.msrChem?.corrosionWarnIndex ?? 1.0),
    // III.4 — RCP seal LOCA SCRAM trip. Fires when stage-2 seal failure
    // has latched (cumulative ~76 gpm/pump, exceeds HHSI margin). PWR-
    // only via state.rcpSeal presence. Stage-3 implies stage-2, so any
    // 2+ degradation tier scrams.
    sealLoca:          !!state.rcpSeal && state.rcpSeal.stage2Lost === true,
    // III.4 — Seal cooling-lost warning. Latches after 2 sim-seconds of
    // both cooling streams unavailable. WARNING (not in SCRAM_TRIPS).
    sealCoolingLost:   !!state.rcpSeal && state._sealCoolingAccum > 2,
    // III.5 — SI actuated. Mirror state.eccs.siActuated (eccs.js owns the
    // latch; this annunciator channel just visualizes it). WARNING.
    siActuated:        !!state.eccs && state.eccs.siActuated === true,
    // III.6 — Low RWST. Fires at < 20% (cfg.rwst.lowAlarmFrac). WARNING.
    lowRwst:           !!state.eccs
                        && state.eccs.rwstFractionFull
                            < (T.eccs?.rwst?.lowAlarmFrac ?? 0.20),
    // III.5 — Pump NPSH loss warnings. Mirror pumpAvailable flags from
    // eccs.js. WARNING — no auto-scram (operator restores suction).
    npshLossHhsi:      !!state.eccs && state.eccs.hhsiPumpAvailable === false,
    npshLossLhsi:      !!state.eccs && state.eccs.lhsiPumpAvailable === false,
    // III.3 — CVCS warnings. cvcs.lossLatched fires after the module's
    // own ~5s sustained-no-charging accumulator; letdownIsolated mirrors
    // the cvcs flag (no separate accumulator — letdown isolation is
    // event-driven from CCW loss).
    cvcsLoss:          !!state.cvcs && state.cvcs.lossLatched === true,
    letdownIsolated:   !!state.cvcs && state.cvcs.letdownIsolated === true,
    // III.14 — EDG indicator + fault + low fuel.
    edgRunning:        !!state.edgs && state.edgs.anyRunning === true,
    edgFailure:        !!state.edgs && state.edgs.anyFaulted === true,
    lowFuelOil:        !!state.edgs && state.edgs.lowFuelOil === true,
    // III.15 — Battery thresholds.
    batteryLow:        !!state.electrical && state.electrical.anyBankLow === true,
    batteryDepleted:   !!state.electrical && state.electrical.anyBankDepleted === true,
    // III.16 — grid / vital-AC WARNING channels. degradedGridVoltage
    // mirrors the degraded-voltage relay input; vitalAcLost fires when
    // every inverter has dropped out. Both WARNING (not in SCRAM_TRIPS).
    degradedGridVoltage: !!state.electrical && !!state.electrical.grid
                        && state.electrical.grid.degradedVoltage === true,
    vitalAcLost:       !!state.electrical
                        && state.electrical.vitalAcAvailable === false,
    // III.19 — CCW + SW losses (sustained-condition latched in
    // aux-cooling.js).
    lossCcw:           !!state.ccw && state.ccw.lossLatched === true,
    lossSw:            !!state.ccw && state.ccw.lossSwLatched === true,
    ccwHotLeg:         !!state.ccw && state.ccw.ccwHotLatched === true,
    // III.8 — AFW WARNING channels. PWR-only via state.afw presence.
    afwActuated:       !!state.afw && state.afw.actuated === true,
    afwLowFlow:        !!state.afw && state.afw.lowFlowLatched === true,
    tdafwUnavailable:  !!state.afw && state.afw.tdafwAvailable === false,
    // III.11 — loss of main feedwater. Fires when no MFW pump is
    // delivering. WARNING (not in SCRAM_TRIPS) — AFW is the response.
    mfwLost:           !!state.feedwaterPumps
                        && state.feedwaterPumps.mfwAvailable === false,
    // III.12 — steam generator tube rupture. Fires while any SG has a
    // ruptured tube. WARNING (not in SCRAM_TRIPS) — the RCS-inventory loss
    // trips the reactor through the existing lowPressurizerP / lowPzrLevel
    // scram channels; this annunciator names the event for the operator.
    sgtr:              !!state.sgTubes && state.sgTubes.some(t => t.ruptured),
    // III.13 — turbine mechanical overspeed. SCRAM input — a tripped
    // turbine removes the secondary heat sink.
    turbineOverspeed:  !!state.turbine && state.turbine.overspeedTrip === true,
    // III.9 — Secondary-valve WARNING channels.
    msivClosed:        T.primaryTopology === 'pwr' && state.msivOpen === false,
    advManualOpen:     T.primaryTopology === 'pwr'
                        && Array.isArray(state.advPositions)
                        && state.advPositions.some(p => p > 0.05),
    // III.17 — Containment WARNINGs. highContainmentTemp mirrors the
    // containment module's own 2 s sustained-condition latch; containmentSpray
    // mirrors the spray-running flag (status lamp, not a fault). PWR-only.
    // The containment-pressure SCRAM stays on the unchanged highContainmentP.
    highContainmentTemp:      !!state.containment
                               && state.containment.highTempLatched === true,
    containmentSprayActuated: !!state.containment
                               && state.containment.sprayRunning === true,
    // III.20 — SFP WARNINGs. All mirror latched flags / discrete thresholds
    // owned by physics/sfp.js. PWR-only via state.sfp presence. NONE in
    // SCRAM_TRIPS — independent of the reactor protection function.
    sfpCoolingLost:    !!state.sfp && state.sfp.coolingLostLatched === true,
    sfpHighTemp:       !!state.sfp && state.sfp.highTempLatched === true,
    sfpBoiling:        !!state.sfp && state.sfp.boiling === true,
    sfpLowLevel:       !!state.sfp && state.sfp.lowLevelLatched === true,
    sfpFuelUncovered:  !!state.sfp && state.sfp.fuelUncovered === true,
  };

  let anyTripped = false;
  for (const k of TRIP_KEYS) {
    if (checks[k] && !state.tripBypass[k] && !state.trips[k]) {
      state.trips[k] = true;
      state.tripFirstActivated[k] = state.simTime;
    }
    if (state.trips[k] && !state.tripBypass[k] && SCRAM_TRIPS.has(k)) anyTripped = true;
  }

  if (anyTripped && !state.scramActive) {
    state.scramActive = true;
    // Turbine trip on scram: drop grid load demand to zero, close turbine valve.
    // This is what really keeps primary from over-cooling (and what makes scram
    // produce a meaningful subcritical state instead of a low-power equilibrium).
    state.cmd.gridLoadTarget = 0;
    state.cmd.turbineValveTarget = 0;
    // Auto-rod controller drops out on scram. After reset, the operator must
    // re-arm AUTO mode explicitly — matches real LAR / regulating-rod logic
    // (you do not let the auto controller restart the reactor by itself).
    if (state.autoRod) state.autoRod.enabled = false;
  }
  // Scram drives rods in at scramSpeed. Wave-C — RBMK CPS rod-cooling loss
  // drags the rods, derating the scram drive (rbmkAux.scramSpeedFactor, 1.0
  // normally).
  if (state.scramActive) {
    const scramSpeed = T.scramSpeed * (state.rbmkAux?.scramSpeedFactor ?? 1);
    state.rodBanks.regulating = Math.min(1, state.rodBanks.regulating + scramSpeed * dt);
    state.rodBanks.safety = Math.min(1, state.rodBanks.safety + scramSpeed * dt);
    // Force valve closed during scram (overrides PI controller in plant.js)
    state.turbineValve = Math.max(0, state.turbineValve - 0.5 * dt);
  } else {
    // Normal rod drive: track command
    driveTowards(state.rodBanks, 'regulating', state.cmd.regulatingTarget, T.rodSpeed, dt);
    driveTowards(state.rodBanks, 'safety', state.cmd.safetyTarget, T.rodSpeed, dt);
  }

  // Legacy direct boron drive remains only for reactor packs without a CVCS
  // blender. PWR boron is owned by physics/cvcs.js so flow/letdown/AC limits
  // actually matter.
  if (!state.cvcs) driveTowardsScalar(state, 'boronPpm', state.cmd.boronTarget, 5, dt);
  // Coolant flow (pumps spin up at a moderate rate)
  driveTowardsScalar(state, 'coolantFlowFrac', state.cmd.coolantFlowTarget, 0.1, dt);
  // Grid load demand follows commanded value with operator slew
  driveTowardsScalar(state, 'gridLoadMW', state.cmd.gridLoadTarget, T.nominalGridLoadMW * 0.02, dt);
}

function coolantTripC(T) {
  switch (T.id) {
    case 'pwr':  return 340;
    case 'rbmk': return 290;
    case 'msr':  return 720;
  }
  return 350;
}

function driveTowards(obj, key, target, ratePerSec, dt) {
  const cur = obj[key];
  const maxStep = ratePerSec * dt;
  if (target > cur)      obj[key] = Math.min(target, cur + maxStep);
  else if (target < cur) obj[key] = Math.max(target, cur - maxStep);
}
function driveTowardsScalar(state, key, target, ratePerSec, dt) {
  const cur = state[key];
  const maxStep = ratePerSec * dt;
  if (target > cur)      state[key] = Math.min(target, cur + maxStep);
  else if (target < cur) state[key] = Math.max(target, cur - maxStep);
}

export function resetScram(state) {
  state.scramActive = false;
  for (const k of TRIP_KEYS) {
    state.trips[k] = false;
    state.tripFirstActivated[k] = 0;
  }
  state.cmd.scramRequested = false;
  state.cmd.lossOfOffsitePower = false;
}

export function manualScram(state) {
  state.cmd.scramRequested = true;
}
