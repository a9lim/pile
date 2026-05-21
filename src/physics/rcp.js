// rcp.js — III.4 Westinghouse RCP shaft-seal LOCA model.
//
// Reactor coolant pumps run on staged shaft seals (#1 / #2 / #3). Two cooling
// streams normally protect them:
//   1. Seal injection (~8 gpm cold water from CVCS / charging pump) — flows
//      DOWN the shaft annulus past the seal stack, providing a forward leak
//      path that also keeps the seals cool.
//   2. Thermal barrier cooling (CCW through a HX at the bottom of the seal
//      stack) — removes heat conducted up the shaft from the primary fluid.
//
// Lose BOTH for a sustained period and seal degradation starts. NRC SECY-
// 93-087 documented the canonical "21-21-21" three-stage failure path:
//   - Stage #1 lets go after ~15-30 minutes of dual loss, leakage jumps
//     from ~0.5 gpm to ~21 gpm per pump.
//   - Stage #2 follows ~30-60 min after #1; leakage jumps to ~76 gpm.
//   - Stage #3 (worst case) saturates around ~480 gpm per pump.
//
// All three stages degraded = SBLOCA on the primary, draining the
// pressurizer at a rate competitive with HHSI capacity. Pre-Fukushima
// extended-SBO concern at Westinghouse plants was driven by this exact
// failure mode; FLEX retrofits prioritize restoring CCW-equivalent flow
// fast enough to head it off.
//
// Scope (III.4):
//   - Seal staging is still one common degradation clock, but leakage is
//     multiplied by the number of PWR pumps so the inventory loss is plant-
//     total rather than per-pump disguised as total.
//   - Pumps with seal-LOCA failure mode are PWR-only. RBMK MCPs have a
//     different seal arrangement and aren't an extended-SBO concern;
//     MSR pumps are submerged in salt with magnetic-bearing variants and
//     have no shaft seals at all. Module early-returns when
//     T.rcpSeal === undefined.
//
// Cooling-loss model (design choice):
//   We use the DUAL-LOSS path: stages only advance when BOTH seal
//   injection AND thermal barrier cooling are unavailable. Standard NRC
//   modeling (NUREG/CR-5167 ANL, SECY-93-087 21-21-21) frames the rapid
//   degradation path this way — the redundant cooling channels are
//   independent and either alone is enough to protect the seals. Single-
//   loss-only is a "gradual rise to ~5 gpm" different model that this
//   module doesn't try to capture. While only one stream is lost the
//   accumulator drains.
//
// Couplings (operator-facing override hooks):
//   - state.cmd.sealInjectionForced (bool|null) — operator/scenario override.
//     true → forces injection AVAILABLE regardless of LOOP; false → forces
//     UNAVAILABLE. null/undefined → default behavior: read
//     state.cvcs.sealInjectionAvailable when the CVCS model exists, otherwise
//     fall back to cmd.lossOfOffsitePower for legacy tests without CVCS.
//   - state.cmd.ccwAvailable (bool, default true) — operator/scenario
//     hard override. Normal behavior reads state.ccw.available when the
//     aux-cooling model exists.
//
// Inventory bookkeeping:
//   The seal leakage is from the RCS at large. rcp.js writes the net leak into
//   state._rcsExternalFlowKgPerS; pressurizer.js is the single integrator for
//   state.rcsMassKg and the pressurizer level / surge consequences. Do not
//   write state.pressurizerWaterMass directly here.
//
// Containment dump (III.17):
//   Seal water leaves the RCS at ~290°C / 15.5 MPa and flashes immediately
//   on release. The escaped mass + its enthalpy are deposited into the
//   per-step containment accumulators (state._containmentMassInflowKgPerS /
//   _containmentEnergyInflowWperS); physics/containment.js consumes them
//   and drives the containment P/T from a real mass + energy balance.
//   This replaces the wave-2 direct `state.containmentP +=` hand-tuned
//   coupling — containment.js is now the single owner of state.containmentP.
//
// References:
//   - NUREG/CR-5167 (ANL), "Cost/Benefit Analysis for Generic Issue 23:
//     Reactor Coolant Pump Seal Failures", 1992.
//   - NRC SECY-93-087, "Policy, Technical, and Licensing Issues Pertaining
//     to Evolutionary and Advanced Light-Water Reactor Designs" — codifies
//     the "21-21-21" three-stage staged-failure assumption used in PRA.
//   - WCAP-15603 (Westinghouse), "Reactor Coolant Pump Seal Performance
//     Following a Loss of All Seal Cooling", widely cited proprietary
//     reference for the staged-failure timing.

// Conversion: 1 US gallon per minute of cold water ≈ 0.0631 kg/s
// (using 998.2 kg/m³ at 20°C reference density).
const GPM_TO_KG_PER_S = 0.0631;

// III.17 — Seal-LOCA → containment coupling. When seal water (~290 °C /
// 15.5 MPa) escapes and flashes to ~0.1 MPa, only the FLASH FRACTION
// becomes airborne steam that pressurizes the containment atmosphere:
//   x = (h_liq(290 °C) − h_f(0.1 MPa)) / h_fg(0.1 MPa) ≈ 0.38.
// The flash steam carries ~h_g(0.1 MPa) ≈ 2.68e6 J/kg of enthalpy; the
// remaining ~62 % stays as hot liquid that falls to the containment sump
// (it does NOT pressurize the atmosphere — sump bookkeeping is eccs.js's
// job). Depositing 100 % of the leak as steam-enthalpy over-pressurizes
// containment and spuriously trips the Hi-1 SI signal on even a small
// 21 gpm stage-1 seal leak.
const SEAL_FLASH_FRACTION = 0.38;
const H_SEAL_RELEASE_J_PER_KG = 2.68e6;

export function stepRcpSeals(state, dt) {
  const T = state.T;
  // No-op for any reactor without RCP-seal config (RBMK MCPs and MSR
  // magnetic-bearing pumps).
  if (!T.rcpSeal) return;
  const seal = state.rcpSeal;
  if (!seal) return; // defensive — state.js builds this for PWR only
  const cfg = T.rcpSeal;

  // === Determine cooling availability ===
  // Seal injection: explicit override > CVCS coupling > LOOP fallback.
  // III.3 wired: state.cvcs.sealInjectionAvailable comes from cvcs.js
  // when the module is built (PWR with T.cvcs defined). Pre-CVCS fallback
  // (RBMK / MSR / sims with the old gating) preserves the wave-2 LOOP-
  // coupled behavior. cmd.sealInjectionForced still acts as a hard
  // override for scenario / test injection.
  const injForce = state.cmd.sealInjectionForced;
  let injAvail;
  if (injForce === true) injAvail = true;
  else if (injForce === false) injAvail = false;
  else if (state.cvcs) injAvail = state.cvcs.sealInjectionAvailable;
  else injAvail = !state.cmd.lossOfOffsitePower;
  // Thermal barrier cooling: explicit override > CCW system > default true.
  // III.19 wired: state.ccw.available drives availability when aux-cooling.js
  // is built. cmd.ccwAvailable === false still acts as a hard override for
  // scenario injection so existing tests keep working.
  const ccwAvail = state.cmd.ccwAvailable === false
    ? false
    : (state.ccw ? state.ccw.available : true);
  seal.sealInjectionAvailable = injAvail;
  seal.thermalBarrierCoolingAvailable = ccwAvail;
  // Dual-loss model (see file header): stages only advance when BOTH
  // streams are unavailable. Either alone is sufficient cooling to keep
  // seal temperature in band on the 25-min-to-stage-1 timescale; only the
  // simultaneous loss path matches the SECY-93-087 "21-21-21" timing.
  // Single-stream-loss is a different (slow gradual leakage rise) model
  // that this module doesn't try to capture — accumulator stays drained.
  const coolingAvailable = injAvail || ccwAvail;

  // === Accumulator update ===
  // When cooling is available, drain all stage accumulators at the same
  // rate they accumulate (so a short loss-then-restore cycles cleanly
  // back to zero). When unavailable, accumulate dt into the next-stage
  // counter only — staged failures advance one at a time.
  if (coolingAvailable) {
    seal.stage1AccumSec = Math.max(0, seal.stage1AccumSec - dt);
    seal.stage2AccumSec = Math.max(0, seal.stage2AccumSec - dt);
    seal.stage3AccumSec = Math.max(0, seal.stage3AccumSec - dt);
  } else {
    if (!seal.stage1Lost) {
      seal.stage1AccumSec += dt;
    } else if (!seal.stage2Lost) {
      seal.stage2AccumSec += dt;
    } else if (!seal.stage3Lost) {
      seal.stage3AccumSec += dt;
    }
  }

  // === Stage-failure latching ===
  // Each stage's gate is on the accumulator vs its tuned time-to-failure.
  // Once latched, stages stay failed even if cooling is restored — the
  // physical seal damage doesn't repair itself. firstStageFailureTime
  // latches on stage1 fire only.
  const t1 = (cfg.stage1FailureMinutesNoCooling ?? 25) * 60;
  const t2 = (cfg.stage2FailureMinutesNoCooling ?? 50) * 60;
  const t3 = (cfg.stage3FailureMinutesNoCooling ?? 90) * 60;
  if (!seal.stage1Lost && seal.stage1AccumSec > t1) {
    seal.stage1Lost = true;
    if (seal.firstStageFailureTime === null) {
      seal.firstStageFailureTime = state.simTime;
    }
  }
  if (seal.stage1Lost && !seal.stage2Lost && seal.stage2AccumSec > t2) {
    seal.stage2Lost = true;
  }
  if (seal.stage2Lost && !seal.stage3Lost && seal.stage3AccumSec > t3) {
    seal.stage3Lost = true;
  }

  // === Compute leakage ===
  // Cumulative-stage convention: stage3 lost (which implies 1+2 also lost)
  // sets the leakage to the stage3 figure, not stage1+stage2+stage3. The
  // 21-21-21 nomenclature is "per stage AT that stage's failure"; the
  // gpm numbers in cfg are cumulative totals.
  let leakGpm;
  if (seal.stage3Lost) leakGpm = cfg.stage3LeakGpm ?? 480;
  else if (seal.stage2Lost) leakGpm = cfg.stage2LeakGpm ?? 76;
  else if (seal.stage1Lost) leakGpm = cfg.stage1LeakGpm ?? 21;
  else leakGpm = cfg.normalLeakageGpm ?? 0.5;
  const pumpCount = Math.max(1, cfg.pumpCount ?? state.loops?.length ?? 1);
  seal.leakRateKgPerS = leakGpm * pumpCount * GPM_TO_KG_PER_S;

  // Above-normal leakage: a real seal-failure inventory loss. Normal
  // ~0.5 gpm seal leakage is balanced by CVCS charging / seal injection
  // and collected by the PRT, so it does NOT change net RCS inventory —
  // gate the RCS debit and the containment dump on the same threshold.
  const aboveNormalLeak = leakGpm > (cfg.normalLeakageGpm ?? 0.5) * 1.5;

  // === Couple to RCS inventory (III.1) ===
  // Above-normal seal leakage is debited from the RCS via the per-step
  // external-flow accumulator state._rcsExternalFlowKgPerS (negative =
  // mass leaving the system). pressurizer.js (which runs AFTER us in
  // sim.js) integrates this into state.rcsMassKg AND folds it into the
  // pressurizer surge term, so pressurizer water drains at the leak rate
  // (RCS shrinks → outsurge → level falls). This replaces the wave-2
  // direct pressurizerWaterMass debit ("the stand-in"); the inventory
  // bookkeeping now lives on the proper state.rcsMassKg scalar.
  if (aboveNormalLeak) state._rcsExternalFlowKgPerS -= seal.leakRateKgPerS;

  // === Containment dump (III.17) ===
  // Seal water flashes to steam on release at ~290 °C / 15.5 MPa → ~0.1 MPa.
  // Deposit the released MASS and ENERGY into the per-step containment
  // accumulators; physics/containment.js consumes them to drive P/T from a
  // real mass + energy balance. Skip the normal-leakage rate (the PRT
  // collects it under normal operation — no containment release).
  if (aboveNormalLeak) {
    const flashSteamKgPerS = seal.leakRateKgPerS * SEAL_FLASH_FRACTION;
    state._containmentMassInflowKgPerS += flashSteamKgPerS;
    state._containmentEnergyInflowWperS +=
      flashSteamKgPerS * H_SEAL_RELEASE_J_PER_KG;
  }
}
