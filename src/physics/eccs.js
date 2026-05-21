// eccs.js — III.5 + III.6 Emergency Core Cooling System.
//
// Westinghouse-class PWR ECCS broken out as four independent injection paths,
// each sized to a different break size / RCS-pressure regime:
//
//   HHSI (high-head safety injection)  — centrifugal charging-class pump,
//     high head (~17 MPa shutoff) + low flow (runout ~250 gpm at zero P). The
//     workhorse for small-break LOCA where RCS stays above the LHSI shutoff
//     and the accumulators stay closed.
//   LHSI (low-head safety injection)   — multistage centrifugal, low head
//     (~2 MPa shutoff) + high flow (runout ~4000 gpm). Useful only after
//     RCS has depressurized significantly — large LOCA, sustained SBLOCA
//     after pressurizer + accumulators have dumped.
//   Accumulators                       — 4× ~30 m³ tanks pressurized with
//     N₂ at ~4.2 MPa, water held against a swing-check valve. PASSIVE — no
//     LOOP or AC dependency. Open when RCS pressure drops below tank gas
//     pressure; nitrogen kicker prevented by closing the valve at low
//     inventory.
//   RHR (residual heat removal / LPSI mode) — same pump set as LHSI in
//     most Westinghouse designs, operated in cooldown alignment. Active
//     below RCS_P < 2.5 MPa, operator manually aligns.
//
// SI actuation logic (Westinghouse standard):
//   pressurizerP < 12.4 MPa
//   OR (pressurizerLevel < 0.17 AND scramActive — distinguishes from normal
//      shrinkage)
//   OR containmentP > 0.115 MPa
//   OR cmd.manualSiActuation
// Once latched, stays latched until cmd.siReset AND all conditions clear.
// Accumulators are always-armed; SI signal doesn't change their state.
//
// Suction source bookkeeping (III.6):
//   Phase 1 (injection): pumps draw from RWST (~1500 m³ = 1.5e6 kg full,
//     borated water at ambient T).
//   Phase 2 (recirculation): when RWST drops below ~10%, operators manually
//     realign ECCS suction to the containment sump (NOT auto — this is
//     the famous E-1.3 switchover, a TMI-2-class concern). Sump volume
//     accumulates as the LOCA leak deposits water in containment.
//   lowRwst (< 20%) warning fires at the prompt-for-switchover threshold.
//
// NPSH failure:
//   Pumps need ≥ ~50 m³ effective suction inventory; below that they
//   cavitate and deliver 0 flow. We latch pumpAvailable = false after
//   5 sustained sim-seconds of inadequate NPSH. Recovers when suction
//   recovers (real plants damage the impeller permanently, but for
//   pedagogy reversibility is fine).
//
// Containment sump bookkeeping:
//   state.eccs.containmentWaterMassKg accumulates from external sources
//   (today: state.rcpSeal.leakRateKgPerS). LOCA-break flow can be added
//   by future scenarios. Sump volume = containmentWaterMassKg / 1000
//   (ρ ≈ 1000 kg/m³ for the room-temp borated water).
//
// Pump head curves (parabolic, very simple):
//   flowGpm = max(0, runoutFlowGpm × (1 - (RCS_P / shutoffP_MPa)^2))
//   - 0 at shutoff pressure
//   - runout at zero RCS pressure
//   - middle of the curve hits roughly the design point
// Real Westinghouse pump curves are more complex (with an inflection from
// the runout flat region), but this captures the operationally-relevant
// behavior: HHSI dominant at high RCS P, LHSI useless until P drops, RHR
// only after cooldown alignment + low P.
//
// Unit conventions:
//   - Display in gpm (operator-facing — Westinghouse panels read in gpm)
//   - Physics in kg/s
//   - GPM_TO_KG_PER_S = 0.0631 (same as rcp.js; matches 998.2 kg/m³ for
//     ambient borated water)
//
// References:
//   - Westinghouse SBLOCA Safety Analysis (FSAR Chapter 15.6)
//   - NUREG/CR-5640 "Application of Bayesian Methods to PRA"
//     (accumulator nitrogen-kick discussion)
//   - WCAP-10054-P-A "Small Break LOCA Methodology" (HHSI head curves)
//   - NRC E-1.3 procedure (switchover to recirc)
//   - Lahey & Moody, "Thermal-Hydraulics of a BWR" §10 (NPSH theory)
//
// Module ordering in sim.js::step:
//   stepRcpSeals → stepEccs → stepPressurizer.
//   stepRcpSeals must run first so the seal leak is debited from
//   pressurizerWaterMass AND deposited into containmentWaterMassKg before
//   stepEccs computes SI conditions and sump volume. stepEccs runs BEFORE
//   stepPressurizer so injection inflow lands in pressurizerWaterMass on
//   the same step the pressurizer model consumes for its level / pressure
//   update.

// Conversion: 1 US gallon per minute of cold water ≈ 0.0631 kg/s (same as
// rcp.js; matches 998.2 kg/m³ at 20°C reference density).
const GPM_TO_KG_PER_S = 0.0631;

// NPSH latch period: 5 sustained sim-seconds of inadequate suction inventory
// before the pump is taken offline. Suction recovery resets the accumulator.
const NPSH_LATCH_SEC = 5;

export function stepEccs(state, dt) {
  const T = state.T;
  // No-op for any reactor type without ECCS config (RBMK / MSR). The
  // physics module is PWR-only; state.js builds state.eccs only when
  // T.eccs is defined.
  if (!T.eccs) return;
  const eccs = state.eccs;
  if (!eccs) return; // defensive — state.js builds this for PWR only
  const cfg = T.eccs;

  // ============================================================
  // 1. Update containment sump from external sources
  // ============================================================
  // RCP-seal leak plus the one-step-lag containment-spray handoff. Note:
  // rcp.js already debits RCS inventory for the same leak — this just
  // captures the released mass in containment-side accounting.
  const sealLeakKgPerS = (state.rcpSeal && state.rcpSeal.leakRateKgPerS) || 0;
  // Only above-normal leakage actually reaches containment atmosphere /
  // sump (normal seal leakage is captured by the PRT under normal ops).
  // Match rcp.js's gate: leakage above 1.5× the normal rate.
  const sealCfg = T.rcpSeal;
  const normalGpm = sealCfg ? (sealCfg.normalLeakageGpm ?? 0.5) : 0.5;
  const normalKgPerS = normalGpm * GPM_TO_KG_PER_S;
  const releaseKgPerS = sealLeakKgPerS > normalKgPerS * 1.5 ? sealLeakKgPerS : 0;
  const spraySumpInflowKgPerS = Math.max(0, state._containmentSumpInflowKgPerS || 0);
  eccs.containmentWaterMassKg = Math.max(0,
    eccs.containmentWaterMassKg + (releaseKgPerS + spraySumpInflowKgPerS) * dt);
  // Sump volume: ρ ≈ 1000 kg/m³ for the room-temp borated water that
  // condenses out of the released steam after containment cools.
  eccs.containmentSumpM3 = eccs.containmentWaterMassKg / 1000;
  const sprayRwstDrawKg = Math.max(0, state._containmentSprayDrawKgPerS || 0) * dt;
  if (sprayRwstDrawKg > 0) {
    eccs.rwstMassKg = Math.max(0, eccs.rwstMassKg - sprayRwstDrawKg);
  }
  state._containmentSprayDrawKgPerS = 0;
  state._containmentSumpInflowKgPerS = 0;

  // ============================================================
  // 2. Determine suction source and NPSH availability per pump
  // ============================================================
  // Operator-commanded suction source. Default 'rwst'; manual switchover
  // to 'sump' is procedure E-1.3, the famous TMI-2 lesson.
  if (state.cmd.eccsSuctionSource === 'sump' || state.cmd.eccsSuctionSource === 'rwst') {
    eccs.suctionSource = state.cmd.eccsSuctionSource;
  } else {
    eccs.suctionSource = 'rwst';
  }
  // Effective suction inventory (m³) — RWST volume or sump volume.
  const suctionM3 = eccs.suctionSource === 'rwst'
    ? (eccs.rwstMassKg / 1000)
    : eccs.containmentSumpM3;

  // Per-pump NPSH check. Each pump has its own min-suction threshold and
  // sustained-condition accumulator. 5s latch period; recovery resets.
  const npshMinHhsi = cfg.hhsi.npshMinSuctionM3 ?? 50;
  const npshMinLhsi = cfg.lhsi.npshMinSuctionM3 ?? 50;
  if (suctionM3 < npshMinHhsi) {
    eccs.hhsiNpshAccumSec += dt;
    if (eccs.hhsiNpshAccumSec > NPSH_LATCH_SEC) eccs.hhsiPumpAvailable = false;
  } else {
    eccs.hhsiNpshAccumSec = 0;
    eccs.hhsiPumpAvailable = true;
  }
  if (suctionM3 < npshMinLhsi) {
    eccs.lhsiNpshAccumSec += dt;
    if (eccs.lhsiNpshAccumSec > NPSH_LATCH_SEC) eccs.lhsiPumpAvailable = false;
  } else {
    eccs.lhsiNpshAccumSec = 0;
    eccs.lhsiPumpAvailable = true;
  }
  // Composite NPSH flag for the gauge layer (any pump cavitating).
  eccs.npshAdequate = eccs.hhsiPumpAvailable && eccs.lhsiPumpAvailable;

  // ============================================================
  // 3. SI actuation logic (latched; stays latched until reset)
  // ============================================================
  const act = cfg.siActuation;
  const lowPzrPCond = state.pressurizerP < (act.lowPressurizerP_MPa ?? 12.4);
  const lowPzrLvlCond = state.pressurizerLevel < (act.lowPressurizerLevel ?? 0.17)
    && state.scramActive === true;
  const highContPCond = state.containmentP > (act.highContainmentP_MPa ?? 0.115);
  const manualCond = !!state.cmd.manualSiActuation;
  const anyFireCond = lowPzrPCond || lowPzrLvlCond || highContPCond || manualCond;

  if (!eccs.siActuated && anyFireCond) {
    eccs.siActuated = true;
    if (eccs.siFirstActuatedTime === null) {
      eccs.siFirstActuatedTime = state.simTime;
    }
  } else if (eccs.siActuated && !anyFireCond && state.cmd.siReset === true) {
    // Reset requires BOTH the operator-pushed reset command AND all firing
    // conditions cleared. Either alone keeps the latch in place.
    eccs.siActuated = false;
    eccs.siFirstActuatedTime = null;
    state.cmd.siReset = false; // consume one-shot reset
    state.cmd.manualSiActuation = false; // clear sticky manual button
  }

  // ============================================================
  // 4. AC power gating for active pumps
  // ============================================================
  // Charging / SI / RHR pumps are AC-powered. LOOP knocks them off
  // unless the EDGs are loading the ECCS bus. III.14 wired:
  // state.edgs.eccsBusEnergized is the natural availability signal
  // when edgs.js is built. The cmd.edgsCarryingEccs flag is left in
  // place as a hard override so existing tests / scenarios that
  // forced the ECCS bus on directly still work during the migration.
  const acAvailable = !state.cmd.lossOfOffsitePower
    || state.cmd.edgsCarryingEccs === true
    || (state.edgs && state.edgs.eccsBusEnergized === true);

  // ============================================================
  // 5. HHSI flow (parabolic head curve)
  // ============================================================
  let hhsiFlowKgPerS = 0;
  if (eccs.siActuated && eccs.hhsiPumpAvailable && acAvailable) {
    const ratio = state.pressurizerP / (cfg.hhsi.shutoffP_MPa ?? 17.0);
    const factor = 1 - ratio * ratio;
    if (factor > 0) {
      const flowGpm = cfg.hhsi.runoutFlowGpm * factor;
      hhsiFlowKgPerS = flowGpm * GPM_TO_KG_PER_S;
    }
  }
  eccs.hhsiFlowKgPerS = hhsiFlowKgPerS;

  // ============================================================
  // 6. LHSI flow (parabolic head curve, low shutoff)
  // ============================================================
  let lhsiFlowKgPerS = 0;
  if (eccs.siActuated && eccs.lhsiPumpAvailable && acAvailable) {
    const ratio = state.pressurizerP / (cfg.lhsi.shutoffP_MPa ?? 2.0);
    const factor = 1 - ratio * ratio;
    if (factor > 0) {
      const flowGpm = cfg.lhsi.runoutFlowGpm * factor;
      lhsiFlowKgPerS = flowGpm * GPM_TO_KG_PER_S;
    }
  }
  eccs.lhsiFlowKgPerS = lhsiFlowKgPerS;

  // ============================================================
  // 7. RHR flow (operator-aligned, low-pressure)
  // ============================================================
  // RHR uses the LHSI pumps in cooldown mode; only active when the
  // operator has manually aligned (cmd.rhrAligned), the LHSI pump is
  // NPSH-available, and AC power is up. RHR shares cavitation fate
  // with LHSI (same pump physically).
  eccs.rhrPumpAligned = !!state.cmd.rhrAligned;
  let rhrFlowKgPerS = 0;
  if (eccs.rhrPumpAligned && eccs.lhsiPumpAvailable && acAvailable) {
    const ratio = state.pressurizerP / (cfg.rhr.shutoffP_MPa ?? 2.5);
    const factor = 1 - ratio * ratio;
    if (factor > 0) {
      const flowGpm = cfg.rhr.runoutFlowGpm * factor;
      rhrFlowKgPerS = flowGpm * GPM_TO_KG_PER_S;
    }
  }
  eccs.rhrFlowKgPerS = rhrFlowKgPerS;

  // ============================================================
  // 8. Accumulator flow (passive — no AC/SI dependency)
  // ============================================================
  // Per tank: open the swing-check valve passively when RCS_P drops
  // below the gas pressure. Flow is choked, scaling as sqrt(ΔP).
  // Isothermal expansion: as inventory drains, the trapped N₂ headspace
  // grows, gas pressure drops via PV = const.
  //
  // k_accum tunes the choked-discharge constant so a single tank empties
  // in ~30 s at the design ΔP (~3 MPa at first opening). With 30 m³ ≈
  // 30000 kg of water and 30 s drain time at sqrt(3) ≈ 1.73, the kg/s
  // figure is ~1000 → k_accum ≈ 1000/1.73 ≈ 580 kg/s/sqrt(MPa).
  const accCfg = cfg.accumulator;
  // kg/s per sqrt(MPa) of ΔP — tuned for ~30 s drain of a 30 m³ tank;
  // a collapsed (larger) tank scales kAccum up to keep the same drain rate.
  const k_accum = accCfg.kAccum ?? 580;
  const acc = eccs.accumulators;
  // Sync command-side isolation flags into the accumulator state.
  const isolatedArr = state.cmd.accumulatorIsolated || [];
  let totalAccFlowKgPerS = 0;
  for (let i = 0; i < acc.length; i++) {
    const tank = acc[i];
    tank.isolatedManually = !!isolatedArr[i];
    // Nitrogen-kicker gate: close the check valve before N₂ ingestion.
    const minInv = accCfg.minInventoryBeforeIsolateM3 ?? 1.0;
    const dpMPa = tank.gasPressureMPa - state.pressurizerP;
    if (!tank.isolatedManually && dpMPa > 0 && tank.inventoryM3 > minInv) {
      tank.flowing = true;
      tank.flowKgPerS = k_accum * Math.sqrt(dpMPa);
      // Drain inventory.
      const drainM3 = tank.flowKgPerS * dt / 1000;
      tank.inventoryM3 = Math.max(0, tank.inventoryM3 - drainM3);
      // Isothermal gas expansion: gasP × V_gas = const. V_gas grows as
      // water inventory shrinks: V_gas_now = V_gas_init + (V_water_init - V_water_now)
      //                       = V_gas_init + (perTankVolumeM3 - inventoryM3)
      //                                       — wrong: that includes the initial gas space
      // Right formula: at init, gas occupies perTankGasInitialVolumeM3 = 8 m³
      // (the tank is 30 m³ but only 22 m³ is water at design). As water
      // drains the gas expands into the freed volume:
      //   V_gas(t) = perTankGasInitialVolumeM3 + (perTankInitialWater - inventory_now)
      // where perTankInitialWater = perTankVolumeM3 - perTankGasInitialVolumeM3.
      const Vgas0 = accCfg.perTankGasInitialVolumeM3 ?? 8;
      const Vwater0 = accCfg.perTankVolumeM3 - Vgas0;
      const Vgas_now = Vgas0 + (Vwater0 - tank.inventoryM3);
      // PV = const → P_now = P0 × Vgas0 / Vgas_now.
      const Pgas0 = accCfg.perTankGasPressureMPa ?? 4.2;
      tank.gasPressureMPa = Pgas0 * Vgas0 / Math.max(0.1, Vgas_now);
      totalAccFlowKgPerS += tank.flowKgPerS;
    } else {
      tank.flowing = false;
      tank.flowKgPerS = 0;
    }
  }

  // ============================================================
  // 9. Aggregate inflow into RCS (III.1)
  // ============================================================
  const totalInflowKgPerS = hhsiFlowKgPerS + lhsiFlowKgPerS + rhrFlowKgPerS
    + totalAccFlowKgPerS;
  const inflowKg = totalInflowKgPerS * dt;
  // Credit injection to the RCS via the per-step external-flow accumulator
  // state._rcsExternalFlowKgPerS (positive = mass entering the system).
  // pressurizer.js integrates this into state.rcsMassKg and folds it into
  // the surge term (RCS grows → insurge → pressurizer level rises). The
  // pressurizer model carries its own high-level scram + code-safety-valve
  // authority and clamps pressurizerWaterMass against an overfill cap, so
  // a misrouted injection without relief can't blow up the integrator.
  // Replaces the wave-2 direct pressurizerWaterMass credit ("the stand-in").
  state._rcsExternalFlowKgPerS += totalInflowKgPerS;

  // ============================================================
  // 10. Drain suction source
  // ============================================================
  if (eccs.suctionSource === 'rwst') {
    eccs.rwstMassKg = Math.max(0, eccs.rwstMassKg - inflowKg);
  } else {
    // Sump: same accumulator that we just added the leak release to.
    // Net effect over a step is releaseKgPerS - totalInflowKgPerS; we
    // applied the +release above, now apply the -draw here.
    eccs.containmentWaterMassKg = Math.max(0,
      eccs.containmentWaterMassKg - inflowKg);
    eccs.containmentSumpM3 = eccs.containmentWaterMassKg / 1000;
  }

  // ============================================================
  // 11. Update readout fractions
  // ============================================================
  eccs.rwstFractionFull = eccs.rwstInitialMassKg > 0
    ? (eccs.rwstMassKg / eccs.rwstInitialMassKg)
    : 0;
}
