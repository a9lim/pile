// plant.js -- balance of plant: primary return temperature, SG / direct-cycle
// or IHX heat sink, secondary valves, and load-demand valve control. PWR
// pressurizer and staged turbine-generator are owned by separate modules.
//
// For all reactor types, this module:
//   1. Computes the primary-side return coolant temperature (T_in to the core)
//   2. Tracks the SG (or intermediate loop) inventory and pressure
//   3. Exposes steam flow / heat-sink demand for turbine.js or inline RBMK/MSR output
//   4. Implements a PI controller from grid load demand to turbine valve position
//
// PWR topology:
//   core → hot leg → SG primary side → cold leg (back to inlet)
//   SG secondary: 3-element FW regulation + AFW + MSIVs / ADVs / condenser
//   bypass dumps; steam path through MSIVs to turbine valve → HP turbine →
//   condenser. Later PWR turbine staging/generator dynamics live in turbine.js.
//
// RBMK (direct cycle):
//   core (boiling) → drum separator → steam line → turbine valve → HP turbine
//   separated water + condensate → feedwater → core inlet
//   No SG; secondary === primary
//
// MSR topology:
//   core (fuel salt) → IHX primary side → return to inlet
//   IHX secondary: intermediate salt loop → steam generator → turbine
//   Intermediate loop temperature is the bridge variable.
//
// === III.7 + III.8 + III.9 (PWR-only) ===
//
// 3-element feedwater regulation (the long-standing "pinned at 0.5" replacement):
//
//   Master PI on level error, with steam-flow feedforward:
//     m_FW_demand = m_steam_meas + Kp · (lvl_setpoint - lvl_meas)
//                                + Ki · ∫(lvl_setpoint - lvl_meas) dt
//   Inner loop: first-order lag on actual FW flow (modeling reg-valve
//   actuator + check valves), τ ≈ 4 s.
//
//   The steam-flow feedforward makes the controller a 3-element design
//   (level + steam flow + FW flow) without an explicit second PI on
//   the inner loop — at steady state demand = steam flow exactly, so
//   the integral of level error stays bounded. In transient, the
//   integral picks up the imbalance.
//
//   Critical-by-construction: at t=0 lvl_err = 0, ∫lvl_err = 0,
//   m_FW = m_steam = design steam flow → controller is in equilibrium.
//
// Shrink/swell: as steam pressure drops (load increase), water in the
// SG flashes and bubble fraction grows → indicated level RISES briefly
// even though water mass is dropping. This is the famous "wrong-way"
// indication that confused TMI-2 operators. We model it as:
//   level_indicated = level_actual - K_swell · (dP/dt)
//   K_swell ≈ 0.05 fraction-level / (MPa/s)   (tuned, see header)
// Negative dP/dt (steam P falling, load increase) → positive correction
// → level_indicated goes ABOVE level_actual → controller cuts FW.
//
// Steam pressure dynamics: previously a hand-tuned proportional
// integrator over (steam_made - steam_consumed). Kept that form (simple
// and stable) and just routed all consumption paths through the new
// total m_steam_total = turbine + ADVs + condenser bypass + safety
// valves.
//
// Secondary-side valves (III.9):
//   - MSIVs (1 lumped, modeling 4 in parallel): fully open by default.
//     Auto-close on highContainmentP > 0.15 MPa OR sgSecondaryP < 5 MPa.
//     cmd.msivCloseManual is the operator command. When closed,
//     m_to_turbine = 0; turbine eats whatever the residual steam header
//     can supply through the (now-closed) MSIVs.
//   - ADVs (4× atmospheric dump valves, lumped): operator-controlled
//     0..1 OR auto-relief above 7.5 MPa. Steam to atmosphere — also
//     drains SG mass, so the level keeps falling without AFW or MFW.
//   - Condenser bypass dumps (~10% of design steam): open
//     automatically on plant trip while sgSecondaryP > 6.5 MPa, to
//     dissipate decay-heat steam without overpressurizing the SG. State
//     ∈ [0..1].

const HFG_DEFAULT = 1.5e6;       // J/kg — SG/drum latent-heat calibration anchor

// 3-element PI tuning — slow integral so the regulator does NOT chase the
// 3 % startup transient where AUTO + Tave program drives load. ~30 s
// integral time is the canonical Westinghouse FW-controller setting per
// IAEA-TECDOC-981 §3 ("Steam Generator Dynamics") for plants with
// 4-loop W-class SGs. Kp tuned to ~12% of design FW flow per fraction
// of level error — about 220 kg/s per 1% level error for the lumped
// 4-SG model — enough authority to pull level back without overshoot.
const FW_PI_KP_DEFAULT = 600;       // kg/s per fraction of (lvl_set - lvl_meas)
const FW_PI_KI_DEFAULT = 20;        // kg/s per (fraction · second) — Ti ≈ 30 s
const FW_VALVE_TAU_DEFAULT = 4;     // s — actuator + check-valve first-order lag
const FW_INTEGRAL_CLAMP = 1500;     // kg/s — anti-windup cap on integral term

// Shrink/swell coupling. K_swell tuned so that a 0.1 MPa/s pressure
// transient (~ 5%/min steam-P drop, equivalent to ~5%/min load
// increase) puts ~0.5% offset on the indicated level. References:
// IAEA-TECDOC-981 §3.4; Hetsroni "Handbook of Multiphase Systems"
// §6.5 on SG narrow-range indication and the bubble-population model.
const K_SWELL_DEFAULT = 0.05;       // fraction-level per (MPa/s)

// SG mass balance constants. SG_BLOWDOWN_FRAC bleeds 1% of design FW
// for chemistry control (boric acid + dissolved iron management). The
// blowdown stream goes to the blowdown demin and never returns —
// always a small drain on the inventory.
const SG_BLOWDOWN_FRAC = 0.01;

// Pressure dynamics — previous hand-tuned coupling. dP = (m_made - m_used) ×
// PRESSURE_COUPLING / SG_PRESSURE_TAU. Calibrated against the original
// behavior: at init, m_made ≈ m_used exactly, so dP/dt = 0 — preserves
// critical-by-construction.
const SG_PRESSURE_TAU = 5;
const SG_PRESSURE_COUPLING = 0.0001;

// Secondary-side valve thresholds.
const MSIV_AUTO_CLOSE_LOW_SG_P = 5.0;          // MPa — low-pressure isolation
const MSIV_AUTO_CLOSE_HIGH_CONT_P = 0.15;      // MPa — containment isolation
const ADV_AUTO_RELIEF_P = 7.5;                 // MPa — auto-open above
const ADV_MAX_FLOW_KGPS_PER_VALVE = 200;       // per valve at full open
const COND_BYPASS_OPEN_SG_P = 6.5;             // MPa — keep open above
const COND_BYPASS_MAX_FLOW_KGPS = 250;         // ~10% of design steam

export function stepPlant(state, dt) {
  const T = state.T;
  switch (T.primaryTopology) {
    case 'pwr': return stepPwrPlant(state, dt);
    case 'direct': return stepRbmkPlant(state, dt);
    case 'msr': return stepMsrPlant(state, dt);
    default: throw new Error(`unknown primary topology: ${T.primaryTopology}`);
  }
}

// ============================================================================
// === PWR (III.1 multi-loop) ===
// ============================================================================
//
// The PWR primary system is L independent loops (state.loops, built in
// state.js from T.loopCount). The reactor core is still a single 1-D axial
// mesh — all loops tap the same core-outlet temperature T_coolant[N-1] for
// their hot leg, and the core inlet is the flow-weighted mix of the loops'
// cold legs.
//
// Each loop carries its own RCP/flow (circulation.js writes loop.massFlowKgPerS),
// its own SG (pressure / level / mass / 3-element FW controller / MSIV / ADV),
// and its own steam contribution to the common turbine header.
//
// Per-loop constant scaling (preserves the wave-2 single-loop dynamics when
// all L loops are symmetric):
//   - extensive quantities (SG mass, FW flow, primary→secondary UA) divide by L
//   - the SG-pressure coupling MULTIPLIES by L: dP_loop = (made_loop -
//     used_loop)·(COUPLING·L). Since made_loop = made_total/L, this makes
//     each loop's dP/dt equal to the wave-2 aggregate dP/dt — a smaller SG
//     pressurizes proportionally faster for a given absolute imbalance.
//   - the FW-controller gains Kp/Ki divide by L (each loop trims 1/L of the
//     total correction), so the integral anti-windup cap FW_INTEGRAL_CLAMP/L
//     over Ki_loop lands on the same ±integral bound as wave-2.
//
// Legacy aggregate scalars (state.sgSecondaryP / sgSecondaryLevel /
// msivOpen / advPositions / condenserBypassOpen) are written each step as
// loop-averages so rps.js / chf.js / afw.js / mimic.js / gauges.js read
// them unchanged.
function stepPwrPlant(state, dt) {
  const T = state.T;
  const sgCfg = T.sg || {};
  const cmd = state.cmd;
  const loops = state.loops;
  const L = loops.length;
  const cCool = T.heatCapCoolant;
  const hFg = sgCfg.hFg ?? HFG_DEFAULT;

  // III.10 — Feedwater-temperature coupling. The SG must heat subcooled
  // feedwater from T_FW up to its saturation temperature (sensible heat)
  // before the rest of the crossed primary heat can boil it (latent
  // heat). Folding the sensible term into an effective latent heat:
  //   steamMade = Qsg / hFgEff,  hFgEff = hFg + cpFw·(T_FW_design − T_FW)
  // The deviation is anchored at the DESIGN feedwater temperature so
  // hFgEff == hFg at init (T_FW == designTempK) — the wave-2 secondary
  // equilibrium is preserved bit-for-bit. Colder feedwater (heater
  // isolation) raises hFgEff → less steam per unit Qsg → SG pressure
  // sags → deeper primary ΔT → cold-leg over-cooling → +ρ via the
  // negative moderator coefficient. Clamped ≥ 0.5·hFg as a numerical
  // floor (a physically unreachable +110 K of FW superheat would be
  // needed to hit it).
  const fw = state.feedwater;
  const hFgEff = fw
    ? Math.max(hFg + fw.cpJPerKgK * (fw.designTempK - fw.tempK), 0.5 * hFg)
    : hFg;

  // III.11 — Main feedwater pump capacity cap. The 3-element FW controller
  // can demand at most what the installed MFW pumps deliver this step
  // (physics/feedwater-pumps.js), split equally across the L loops. When
  // pumps trip (electrical / operator / NPSH) the capacity falls and the
  // SGs are starved — the loss-of-feedwater transient. Infinity when the
  // pump model is absent (defensive; PWR always has it).
  const fpump = state.feedwaterPumps;
  const mfwCapLoop = fpump ? fpump.mfwCapacityKgPerS / L : Infinity;

  // III.12 — SG-tube-plugging baseline. The per-loop heat-transfer degrade
  // is anchored here so the as-built init plugging produces htDegrade = 1.
  const sgTubeBaseline = (T.sgTubes && T.sgTubes.baselinePluggedFraction) || 0;

  // Hot-leg temperature (shared core outlet — top of the 1-D core mesh).
  const T_hot = state.T_coolant[state.N - 1];

  // Per-loop scaled constants.
  const designFwTotal = sgCfg.designFwKgPerS ?? 0;
  const designMassTotal = sgCfg.designWaterMassKg ?? 120000;
  const designFwLoop = designFwTotal / L;
  const designMassLoop = designMassTotal / L;
  const htLoop = (T.sgPrimaryToSecondaryHt || 0) / L;
  const Kp = (sgCfg.fwKp ?? FW_PI_KP_DEFAULT) / L;
  const Ki = (sgCfg.fwKi ?? FW_PI_KI_DEFAULT) / L;
  const tauFw = sgCfg.fwValveTau ?? FW_VALVE_TAU_DEFAULT;
  const kSwell = sgCfg.kSwell ?? K_SWELL_DEFAULT;
  const setpoint = sgCfg.levelSetpoint ?? 0.5;
  const sgDesignP = T.sgSecondaryPressureMPa || 6.9;
  // Per-loop turbine choke share — Σ over L loops with valve=1, P-ratio=1
  // equals the wave-2 aggregate choked flow.
  const chokedFlowRatedLoop = T.nominalPowerMWth * 1e6 / hFg / L;
  const integralBound = FW_INTEGRAL_CLAMP / L / Math.max(Ki, 1e-9);

  // Average loop SG pressure (from last step's per-loop values) drives the
  // plant-wide condenser-bypass logic.
  let avgSgPprev = 0;
  for (let l = 0; l < L; l++) avgSgPprev += loops[l].sgPressureMPa;
  avgSgPprev /= L;

  // Condenser bypass dumps — plant-wide (one set of valves on the common
  // steam header). Open on scram while header pressure is high; the total
  // bypass flow is split equally across the loops' SG mass balances.
  const bypassWanted = state.scramActive && avgSgPprev > COND_BYPASS_OPEN_SG_P;
  let bypassLive = state.condenserBypassOpen ?? 0;
  bypassLive = clamp(bypassLive + ((bypassWanted ? 1 : 0) - bypassLive) * dt / 1.0, 0, 1);
  state.condenserBypassOpen = bypassLive;
  const condBypassTotalKgPerS = bypassLive * COND_BYPASS_MAX_FLOW_KGPS
    * (avgSgPprev / sgDesignP);
  const condBypassLoop = condBypassTotalKgPerS / L;

  // AFW (afw.js owns the calculation; runs before plant.js). Split equally
  // across the loops' SGs — III.1 keeps a single AFW aggregate; per-MOV
  // per-SG routing is deferred (afw.js is already per-MOV-aware).
  const m_afw_total = (state.afw && state.afw.totalFlowKgPerS) || 0;
  const m_afw_loop = m_afw_total / L;

  // Accumulators for the aggregate readouts + core-inlet mixing.
  let totalSteamMade = 0;       // Σ Qsg/hFg — steam produced
  let totalTurbineSteam = 0;    // Σ steam to the turbine header
  let totalAdvFlow = 0;
  let totalFwFlow = 0;
  let coldWeightedSum = 0;      // Σ m_loop · T_cold_loop
  let flowSum = 0;              // Σ m_loop (non-isolated, carrying flow)
  let sgPsum = 0;
  let sgLevelSum = 0;
  let allMsivOpen = true;
  const advArr = [];

  for (let l = 0; l < L; l++) {
    const loop = loops[l];
    const m_loop = loop.massFlowKgPerS || 0;
    // Isolated loop: MSIV shut, SG parked, no primary heat path, no steam.
    if (loop.isolated) {
      loop.msivOpen = false;
      loop.qSgW = 0;
      loop.steamFlowKgPerS = 0;
      loop.tHotK = T_hot;
      loop.tColdK = saturationTempK(loop.sgPressureMPa);
      loop.sgPrevP = loop.sgPressureMPa;
      sgPsum += loop.sgPressureMPa;
      sgLevelSum += loop.sgLevel;
      allMsivOpen = false;
      advArr.push(loop.advPosition);
      continue;
    }

    // === Primary → secondary heat transfer for this loop ===
    const T_sat_sec = saturationTempK(loop.sgPressureMPa);
    // III.12 — tube-plugging heat-transfer degrade. Plugged tubes carry no
    // primary flow and transfer no heat. The factor is anchored at the
    // baseline plugging fraction so the as-built init state is unchanged
    // (critical-by-construction); plugging beyond baseline shrinks Qsg.
    const tube = state.sgTubes ? state.sgTubes[l] : null;
    const htDegrade = tube
      ? clamp((1 - tube.pluggedFraction) / (1 - sgTubeBaseline), 0, 1.2)
      : 1;
    // A stagnant loop (m_loop ≈ 0) delivers no convective heat to its SG —
    // the primary water in the tubes cools toward T_sat. Gate Qsg on flow.
    const designLoopFlow = Math.max(T.coolantMassFlowKgPerS / L, 1);
    const flowFactor = Math.pow(clamp(m_loop / designLoopFlow, 0, 1.2), 0.8);
    const convectiveLimit = m_loop * cCool * Math.max(T_hot - T_sat_sec, 0);
    const Qsg = m_loop > 1
      ? Math.min(htLoop * htDegrade * flowFactor * Math.max(T_hot - T_sat_sec, 0), convectiveLimit)
      : 0;
    loop.qSgW = Qsg;
    loop.tHotK = T_hot;
    // Cold-leg temperature. Cannot fall below the SG saturation temp (the
    // SG can't cool the primary below its own boiling point).
    const dropC = Qsg / Math.max(m_loop * cCool, 1);
    loop.tColdK = Math.max(T_hot - dropC, T_sat_sec);

    const steamMade = Qsg / hFgEff;   // III.10 — FW-temp-dependent latent load
    loop.steamFlowKgPerS = steamMade;
    totalSteamMade += steamMade;

    // === MSIV (per loop) ===
    const msivAutoClose = state.containmentP > MSIV_AUTO_CLOSE_HIGH_CONT_P
      || loop.sgPressureMPa < MSIV_AUTO_CLOSE_LOW_SG_P
      || cmd.msivCloseManual === true;
    if (msivAutoClose) loop.msivOpen = false;
    else if (cmd.msivResetOpen === true) loop.msivOpen = true;
    if (loop.msivOpen === undefined) loop.msivOpen = true;
    if (!loop.msivOpen) allMsivOpen = false;

    // === ADV (one per loop; cmd.advPositions[l]) ===
    let advTgt = (cmd.advPositions && cmd.advPositions[l]) || 0;
    if (loop.sgPressureMPa > ADV_AUTO_RELIEF_P) {
      const relief = clamp((loop.sgPressureMPa - ADV_AUTO_RELIEF_P) / 0.2, 0, 1);
      advTgt = Math.max(advTgt, relief);
    }
    const advTau = 2;
    loop.advPosition = clamp(
      loop.advPosition + (advTgt - loop.advPosition) * dt / advTau, 0, 1);
    const advFlow = loop.advPosition * ADV_MAX_FLOW_KGPS_PER_VALVE
      * (loop.sgPressureMPa / sgDesignP);
    advArr.push(loop.advPosition);
    totalAdvFlow += advFlow;

    // === Turbine steam from this loop (gated by its MSIV) ===
    const turbineSteam = loop.msivOpen
      ? state.turbineValve * chokedFlowRatedLoop * (loop.sgPressureMPa / sgDesignP)
      : 0;
    totalTurbineSteam += turbineSteam;

    // === III.7 — 3-element FW controller (per loop) ===
    if (!Number.isFinite(loop.sgPrevP)) loop.sgPrevP = loop.sgPressureMPa;
    const dPdt = dt > 0 ? (loop.sgPressureMPa - loop.sgPrevP) / dt : 0;
    const levelIndicated = clamp(loop.sgLevel - kSwell * dPdt, 0, 1);
    const lvlErr = setpoint - levelIndicated;
    if (!Number.isFinite(loop.fwIntegral)) loop.fwIntegral = 0;
    loop.fwIntegral = clamp(loop.fwIntegral + lvlErr * dt,
      -integralBound, integralBound);
    const blowdownFf = SG_BLOWDOWN_FRAC * designFwLoop;
    let m_FW_demand = turbineSteam + advFlow + condBypassLoop + blowdownFf
      + Kp * lvlErr + Ki * loop.fwIntegral;
    // III.11 — cap demand at min(controller envelope, per-loop MFW pump
    // capacity). mainFwTrip is also enforced directly (belt-and-suspenders;
    // the pump model already zeroes capacity on a main-FW trip).
    m_FW_demand = clamp(m_FW_demand, 0, Math.min(2 * designFwLoop, mfwCapLoop));
    if (cmd.mainFwTrip === true) m_FW_demand = 0;
    if (!Number.isFinite(loop.fwActual)) loop.fwActual = m_FW_demand;
    loop.fwActual = loop.fwActual + (m_FW_demand - loop.fwActual) * (dt / tauFw);
    loop.fwActual = clamp(loop.fwActual, 0, 2 * designFwLoop);
    const m_main_fw = loop.fwActual;
    loop.fwFlowKgPerS = m_main_fw;
    totalFwFlow += m_main_fw;

    // === SG mass balance (per loop) ===
    // III.12 — a ruptured tube floods this SG with primary water. The leak
    // (computed by sg-tubes.js, debited from RCS inventory there) is added
    // to the secondary inventory here, so the affected SG's level rises.
    const tubeLeak = tube ? tube.leakRateKgPerS : 0;
    const m_steam_total = turbineSteam + advFlow + condBypassLoop;
    const m_blowdown = SG_BLOWDOWN_FRAC * designFwLoop;
    const dMdt = m_main_fw + m_afw_loop + tubeLeak - m_steam_total - m_blowdown;
    loop.sgWaterMassKg = Math.max(0, loop.sgWaterMassKg + dMdt * dt);
    loop.sgLevel = clamp(loop.sgWaterMassKg / (2 * designMassLoop), 0, 1);

    // === SG pressure dynamics (per loop; COUPLING·L — see header) ===
    const dP = (steamMade - m_steam_total) * (SG_PRESSURE_COUPLING * L);
    loop.sgPressureMPa = clamp(
      loop.sgPressureMPa + dP * dt / SG_PRESSURE_TAU, 0.1, 12);
    loop.sgPrevP = loop.sgPressureMPa;

    // Core-inlet mixing weight.
    coldWeightedSum += m_loop * loop.tColdK;
    flowSum += m_loop;
    sgPsum += loop.sgPressureMPa;
    sgLevelSum += loop.sgLevel;
  }

  // === Core inlet = flow-weighted mix of the loops' cold legs ===
  // If every loop is dead (all isolated / no flow), the core is not being
  // cooled — return temp pins to the hot leg (core heats up: correct).
  state._coolantReturnT = flowSum > 0 ? (coldWeightedSum / flowSum) : T_hot;

  // === Turbine steam flow (common header) ===
  // III.13 — the staged turbine + generator model (physics/turbine.js,
  // runs after stepPlant) consumes this and owns state.out.generatorMWe.
  // The wave-2 lumped `generatorMWe = steam·hFg·turbineEff` calc is
  // retired for PWR (RBMK/MSR keep their inline versions).
  state.out.turbineSteamFlow = totalTurbineSteam;

  // === Aggregate scalars for the legacy readers (rps/chf/afw/mimic/gauges) ===
  state.sgSecondaryP = sgPsum / L;
  state.sgSecondaryLevel = sgLevelSum / L;
  state.msivOpen = allMsivOpen;
  state.advPositions = advArr;
  // Consume the one-shot MSIV reset once all loops have processed it.
  if (cmd.msivResetOpen === true) cmd.msivResetOpen = false;

  const out = state.out;
  out.steamFlow = totalSteamMade;
  out.sgLevel = state.sgSecondaryLevel;
  out.sgPressure = state.sgSecondaryP;
  out.fwFlow = totalFwFlow;
  out.advTotalFlow = totalAdvFlow;
  out.condBypassFlow = condBypassTotalKgPerS;
  out.msivOpen = state.msivOpen;
  out.afwTotalFlowKgPerS = m_afw_total;

  // Grid load demand → turbine valve PI control.
  pidValveControl(state, dt);
}

// ============================================================================
// === RBMK (direct cycle) ===
// ============================================================================
function stepRbmkPlant(state, dt) {
  const T = state.T;
  // Total steam mass generated in core this step. Use thermodynamic quality,
  // not void fraction: void is volume fraction and can be large at small mass
  // quality because steam density is tiny.
  // II.3 — see PWR plant comment.
  const mFlow = state.out.flowMassRateKgPerS
    ?? (T.coolantMassFlowKgPerS * state.coolantFlowFrac);
  const bulkQuality = state.out.bulkSteamQuality ?? (() => {
    let q = 0;
    for (let k = 0; k < state.N; k++) q += state.qualityFrac?.[k] ?? 0;
    return q / Math.max(state.N, 1);
  })();
  const steamMassRateKgPerS = mFlow * clamp(bulkQuality, 0, 1);

  const hFg = 1.5e6;
  const chokedFlowRated = T.nominalPowerMWth * 1e6 / hFg;
  const turbineSteamFlow = state.turbineValve * chokedFlowRated * (state.sgSecondaryP / T.sgSecondaryPressureMPa);

  // Wave-D — pressure-tube break (LOCA). Vents circuit water/steam: drains the
  // affected loop's drum (below), depressurizes the circuit, and sends steam to
  // the ALS suppression pool. Zero unless cmd.rbmkPipeBreak → init unchanged.
  const breakActive = !!state.cmd.rbmkPipeBreak;
  const breakLoop = state.cmd.rbmkPipeBreakLoop ?? 0;
  const breakFlow = breakActive ? (T.rbmkBreak?.breakFlowKgPerS ?? 500) : 0;
  // (ALS reads the break steam directly — see rbmk-als.js — because it runs
  // before stepPlant in the step order.)

  // Drum pressure dynamics. (A pressure-tube break's primary modeled effects
  // are the affected-loop drum drain below + steam to the ALS + ECCS
  // actuation on the break signal; the crude lumped drum-pressure model is
  // dominated by the concurrent power transient, so an explicit break
  // depressurization term is deferred to the cleanup pass.)
  const dP = (steamMassRateKgPerS - turbineSteamFlow) * 0.0001;
  state.sgSecondaryP += dP * dt / 5;
  state.sgSecondaryP = clamp(state.sgSecondaryP, 0.1, 10);

  // Wave-B — per-loop drum-separator level control. Each loop's drum loses the
  // steam drawn to the turbine (apportioned by that loop's share of total
  // flow) and gains feedwater from a 3-element-style controller (steam-flow
  // feedforward + level PI). Total feedwater (fwTotal) replaces the wave-1
  // turbineSteamFlow term in the core-inlet blend below; at init the
  // controller feedforward == steam draw so fwTotal == turbineSteamFlow and
  // the blend (state._coolantReturnT) is unchanged — critical-by-construction.
  // A feedwater trip (cmd.mainFwTrip) zeroes feedwater → level drains →
  // lowDrumLevel SCRAM, and the lost cold makeup heats the core inlet.
  const drumC = T.rbmkDrum;
  let fwTotal = turbineSteamFlow;          // wave-1 fallback if no drum config
  if (drumC && state.loops) {
    // Feedwater stops on operator trip OR loss of the main FW pumps (Wave C:
    // AC-powered, so a station blackout also kills feedwater).
    const fwTripped = !!state.cmd.mainFwTrip
      || (state.rbmkAux && state.rbmkAux.mfwAvailable === false);
    const L0 = drumC.levelSetpoint ?? 0.5;
    const span = drumC.designWaterMassKg ?? 100000;
    let totalFlow = 0;
    for (const lp of state.loops) if (!lp.isolated) totalFlow += lp.massFlowKgPerS || 0;
    totalFlow = Math.max(totalFlow, 1e-6);
    fwTotal = 0;
    for (const lp of state.loops) {
      if (lp.isolated) { lp.steamFlowKgPerS = 0; lp.fwFlowKgPerS = 0; continue; }
      const frac = (lp.massFlowKgPerS || 0) / totalFlow;
      const steamDraw = turbineSteamFlow * frac;               // this loop's steam out
      lp.steamFlowKgPerS = steamDraw;
      const err = L0 - lp.drumLevel;                           // +ve when level low
      // PI feedwater demand, feedforward on steam draw. Anti-windup: only
      // integrate while not clamped.
      let fwDemand = steamDraw + (drumC.fwKp ?? 2500) * err + (drumC.fwKi ?? 60) * lp.fwIntegral;
      if (fwTripped) fwDemand = 0;
      const fwMax = drumC.maxFwKgPerS ?? 4000;
      const fw = fwDemand < 0 ? 0 : (fwDemand > fwMax ? fwMax : fwDemand);
      if (!fwTripped && fw > 0 && fw < fwMax) lp.fwIntegral += err * dt;
      lp.fwFlowKgPerS = fw;
      // Wave-B — ECCS makeup (rbmk-eccs.js) is additional cold inflow to this
      // loop's drum. Zero unless ECCS is actuated → init unchanged.
      const eccsIn = lp.eccsInjectionKgPerS || 0;
      fwTotal += fw + eccsIn;
      // Wave-D — pressure-tube break drains the affected loop's drum.
      const breakOut = (breakFlow > 0 && lp.id === breakLoop) ? breakFlow : 0;
      // Drum water balance: dLevel = (feedwater + ECCS − steam − break) / span.
      lp.drumLevel = clamp(lp.drumLevel + (fw + eccsIn - steamDraw - breakOut) / span * dt, 0, 1);
    }
    // Aggregate (min) drum level for the RPS level trips + legacy readers.
    let minLvl = Infinity;
    for (const lp of state.loops) if (!lp.isolated && lp.drumLevel < minLvl) minLvl = lp.drumLevel;
    state.sgSecondaryLevel = Number.isFinite(minLvl) ? minLvl : (L0);
  }

  // Feedwater return: cold (at feedwater temp ~165°C). Mixed with separator
  // water at sat temp. III.10 — feedwater temperature is a real variable
  // driven by physics/feedwater-heaters.js (heater chain + extraction-steam
  // load scaling). Falls back to the wave-1 fixed 165°C if the feedwater
  // block is somehow absent. At init feedwater.tempK == designTempK ==
  // 165°C, so the wave-1 blend temperature is preserved bit-for-bit.
  const T_fw = state.feedwater ? state.feedwater.tempK : (165 + 273.15);
  const T_sat = saturationTempK(state.sgSecondaryP);
  // Returning water is a mix of fresh feedwater (mass = fwTotal, from the
  // Wave-B drum controller; == turbineSteamFlow at init) and recirculated
  // separator water (mass = mFlow − steamMassRate, at sat temp).
  const recircRate = Math.max(mFlow - steamMassRateKgPerS, 0);
  const blendTemp = (recircRate * T_sat + fwTotal * T_fw) / Math.max(recircRate + fwTotal, 1);
  state._coolantReturnT = blendTemp;

  const turbineEff = 0.31;
  state.out.generatorMWe = turbineSteamFlow * hFg * turbineEff / 1e6;

  pidValveControl(state, dt);
}

// ============================================================================
// === MSR ===
// ============================================================================
function stepMsrPlant(state, dt) {
  const T = state.T;
  // Primary heats intermediate loop via IHX. Primary outlet (top of core fuel temp).
  // For MSR (fuel-in-coolant), T_fuel == T_coolant — the 3-node split is N/A.
  let Tprim = 0;
  for (let k = 0; k < state.N; k++) Tprim += state.T_fuel[k];
  Tprim /= state.N;
  const Tint = state.intermediateLoopT;
  const retainedSalt = clamp(1 - (state.msrDrainFrac ?? 0), 0, 1);
  const Q_ihx = retainedSalt * T.intermediateLoopHt * (Tprim - Tint);

  // MSR-A — air-cooled radiator heat rejection (replaces the SG/turbine; the
  // real MSRE dumped 8 MWth to atmosphere). Blower speed × open doors set the
  // air-side conductance. Below the coolant-salt liquidus the salt freezes and
  // flow blocks (no rejection); freeze-protection heaters hold it above the
  // setpoint. The primary return below is UNCHANGED (Q_ihx identical) so the
  // primary-side init criticality is preserved.
  const rad = state.msrRadiator;
  let Q_rad = 0, Q_heater = 0;
  if (rad) {
    const rc = T.msrRadiator;
    rad.coolantSaltFrozen = Tint < (rc.coolantLiquidusK ?? 727);
    const blower = clamp(state.cmd.msrBlowerSpeed ?? 1, 0, 1.5);
    const bypass = clamp(state.cmd.msrBypassDoors ?? 0, 0, 1);
    const airK = rad.airInletTempK;
    Q_rad = rad.coolantSaltFrozen ? 0
      : rad.uaWperK * blower * (1 - bypass) * Math.max(Tint - airK, 0);
    rad.freezeHeaterOn = state.cmd.msrFreezeHeaterTrip !== true
      && Tint < (rc.freezeProtectSetpointK ?? 783);
    Q_heater = rad.freezeHeaterOn ? (rc.freezeHeaterPowerW ?? 3e5) : 0;
    rad.heatRejectedMW = Q_rad / 1e6;
    rad.coolantSaltTempK = Tint;
    rad.airOutletTempK = airK + (Q_rad > 0 ? 60 * blower * (1 - bypass) : 0);
  }

  // Coolant-salt (intermediate) loop: m·c·dT/dt = Q_ihx + Q_heater − Q_rad.
  const mInt = 2000; // kg of coolant salt (estimate)
  const cInt = 1500;
  state.intermediateLoopT += (Q_ihx + Q_heater - Q_rad) / (mInt * cInt) * dt;

  // Primary return: simple drop based on Q_ihx and flow. UNCHANGED.
  // II.3 — regime-aware flow from circulation.js.
  const mFlow = state.out.flowMassRateKgPerS
    ?? (T.coolantMassFlowKgPerS * state.coolantFlowFrac);
  const dropC = Q_ihx / Math.max(mFlow * T.heatCapCoolant, 1);
  state._coolantReturnT = Tprim - dropC;

  // No turbine / generator — heat goes to the air radiator.
  state.out.generatorMWe = 0;
  state.out.heatRejectedMW = Q_rad / 1e6;
  state.sgSecondaryP = clamp(state.sgSecondaryP, 0.1, 10);

  // Freeze plug check
  const minLoopT = Math.min(state._coolantReturnT, Tprim);
  if (Tprim > T.freezePlugTempK || state.cmd?.freezePlugCoolingAvailable === false) {
    // Plug melts on loss of forced plug cooling / power, or from hot stagnant
    // salt when pumps are stopped. Operator melt is handled below.
    if (state.coolantFlowFrac < 0.05 || state.cmd?.freezePlugCoolingAvailable === false) {
      state.freezePlugMelted = true;
    }
  }
  if (state.cmd?.meltFreezePlug) state.freezePlugMelted = true;
  if (state.freezePlugMelted) {
    const oldDrain = state.msrDrainFrac ?? 0;
    const newDrain = 1 - (1 - oldDrain) * Math.exp(-dt / 3);
    state.msrDrainFrac = clamp(newDrain, 0, 1);
    const oldRetained = Math.max(1 - oldDrain, 1e-9);
    const newRetained = Math.max(1 - state.msrDrainFrac, 0);
    const scale = newRetained / oldRetained;
    for (let k = 0; k < state.N; k++) {
      state.flux[k] *= scale;
      for (let g = 0; g < 6; g++) state.precursors[g][k] *= scale;
    }
    const drainHeatW = (state.out.drainTankDecayHeatMW ?? 0) * 1e6;
    const drainMass = T.fuelMassKg ?? 5000;
    const drainCp = T.heatCapFuel ?? 1500;
    const drainAmbient = 600;
    const drainUa = T.drainTankPassiveUaWPerK ?? 2.5e4;
    state.drainTankT += ((drainHeatW - drainUa * Math.max(state.drainTankT - drainAmbient, 0))
      / Math.max(drainMass * drainCp, 1)) * dt;
    state.drainTankHeatMW = drainHeatW / 1e6;
    state.out.generatorMWe = 0;
  }
}

// === PI controller for turbine valve from grid load demand ===
function pidValveControl(state, dt) {
  const T = state.T;
  // III.13 — when the generator is off the grid (load rejection / breaker
  // open), the turbine is on SPEED control: turbine.js's governor owns the
  // valve. The load-following PI must not fight it, or the valve limit-
  // cycles. PWR-only gate (state.turbine null for RBMK/MSR).
  if (state.turbine && state.turbine.breakerClosed === false) return;
  const demandMW = state.gridLoadMW;
  const actualMW = state.out.generatorMWe;
  const err = demandMW - actualMW;
  state._valveIntegral = (state._valveIntegral || 0) + err * dt;
  const Kp = 0.02;
  const Ki = 0.001;
  const valveCommand = clamp(0.5 + Kp * err + Ki * state._valveIntegral, 0, 1);
  // Slew rate limit on valve actuator
  const slewPerSec = 0.05;
  const delta = clamp(valveCommand - state.turbineValve, -slewPerSec * dt, slewPerSec * dt);
  state.turbineValve = clamp(state.turbineValve + delta, 0, 1);

  // If grid load demand changes, the user is driving it — sync target to actual
  if (Math.abs(state.cmd.turbineValveTarget - state.turbineValve) > 0.5) {
    // Manual override mode: don't fight it
    state.turbineValve = state.cmd.turbineValveTarget;
  }
}

// I.8 — Water saturation temperature via the IAPWS-IF97 Region 4 equation
// (physics/steam-tables.js). Replaces the kPa-form Antoine that was
// duplicated across plant.js / thermal.js / multichannel.js — single source
// of truth now. `tSat` takes MPa, returns K (same signature as the old fn).
import { tSat as saturationTempK } from './steam-tables.js';

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
