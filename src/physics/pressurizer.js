// pressurizer.js — III.2 Westinghouse-class dynamic pressurizer.
//
// Replaces the static `state.pressurizerP = T.pressurizerPressureMPa` placeholder
// with a four-component dynamic model: variable + backup heater banks, spray
// from cold leg, PORV with the TMI-2 stuck-open failure mode, three code
// safety valves, and surge dynamics that couple primary loop T_avg to
// pressurizer level + dome pressure. PWR only — RBMK/MSR early-return.
//
// State variables owned by this module (allocated in state.js for PWR):
//   state.pressurizerP        MPa, dome pressure (already existed as static).
//   state.pressurizerLevel    fraction full of water, design ≈ 0.55.
//   state.pressurizerSteamMass    kg of saturated steam in the dome.
//   state.pressurizerWaterMass    kg of subcooled water at the bottom.
//   state.pressurizerTwater   K, the subcooled water temperature.
//   state.heaterBanks         { variable ∈ [0,1], backup1/2/3 ∈ bool, lockedOut bool }.
//   state.sprayValveOpen      0..1, proportional cold-leg spray.
//   state.porvOpen            bool, pneumatic relief valve.
//   state.codeSafetyValves    [bool, bool, bool], ASME Section III spring valves.
//   state.prtMass             kg of discharged steam in pressurizer relief tank.
//   state.prtRuptured         bool, rupture disk failed at prtRuptureKg.
//   state._tAvgPrev           K, previous-step primary T_avg (for dT/dt surge).
//
// Critical-by-construction:
//   At t = 0, P = T.pressurizerPressureMPa = setpoint, all valves closed,
//   variable heater = 0, dT_avg/dt = 0 (initial state is steady). No transient
//   should fire during the first ~30 sim-seconds at design point with autopilot
//   on. The static T_sat lookup in thermal.js reads state.pressurizerP, so
//   keeping init-P pinned at design value preserves the saturation curve thermal
//   code expects.
//
// Pressure ODE (tuned constant-C form, not a full IAPWS mass-energy balance):
//
//   dP/dt = (Q_net - Q_loss) / C_pzr + surgeP_term
//
// where:
//   Q_net    = Q_heaters - Q_spray_cooling - Q_porv_relief - Q_sv_relief    [W]
//   Q_loss   = small ambient loss to containment, scaled so a steady reactor
//              with variable heater modulating absorbs Q_loss
//   C_pzr    ≈ 1.5e9 J/MPa, tuned so 150 kW raises P at ~1e-4 MPa/s when
//              isolated (target: ~10 MPa over ~30 s with full heater bank,
//              isolated — within an order of magnitude of real Westinghouse
//              pressurizer step response)
//   surgeP_term  = K_surge · dT_avg/dt, K_surge ≈ 0.04 MPa/K, captures
//              insurge/outsurge compressing/expanding the steam space
//
// Level dynamics (mass-balance, simple but consistent):
//
//   dV_water/dt   = surge_in - spray_in - boiloff + condensate_in    [m³/s]
//   dLevel/dt = dV_water/dt / A_pzr     where A_pzr = volumeM3 / pzrHeight
//
// surge_in = -ρ_water · V_rcs · α_water · dT_avg/dt  (negative: heatup pushes
// water IN, displacing steam, raising level)
//
// Valves + heater state machines:
//
//   Variable heater (proportional band)
//     - Modulates 0..1 as P drops from (setpoint+0.05) to (setpoint-0.10).
//     - Above setpoint: 0.
//     - Below setpoint-0.10: 1.
//   Backup heaters (on/off):
//     - B1 cuts in at P < setpoint - 0.20 (≈15.30 MPa for 15.5 setpoint).
//     - B2 cuts in at P < setpoint - 0.50.
//     - B3 cuts in at P < setpoint - 0.80.
//     - All cut out at P > setpoint - 0.10 (small hysteresis).
//   Low-level heater lockout:
//     - All 4 banks lockout if pressurizerLevel < 0.17 to protect elements.
//   Operator manual override (cmd.heaterManualOverride):
//     - 'off' forces all heaters off regardless of P.
//   Spray valve (proportional):
//     - 0 when P < setpoint + 0.15.
//     - 1 when P > setpoint + 0.55.
//     - Linear in between.
//   PORV (pneumatic with hysteresis):
//     - Opens at 16.2 MPa, closes at 15.9 MPa.
//     - cmd.porvStuckOpenFault keeps it open below 15.9 (TMI-2 mode).
//     - cmd.porvBlockValveClosed forces porvOpen = false (operator isolation).
//   Code safety valves (3 × spring-loaded):
//     - Each opens at 17.1 MPa, closes at 16.8 MPa.
//     - cmd.codeSafetyValveStuck[i] (array of 3 bools) inject per-valve stuck.
//
// Remaining approximations:
//   - Saturation temperature comes from steam-tables.js, but hFg, c_p,water,
//     and densities are calibrated constants.
//   - Tracking water enthalpy is approximate — spray Q is mass × c_p × ΔT,
//     not a proper IAPWS h-difference.
//   - Surge compression of steam dome is captured only via the linear
//     surgeP_term, not as an actual P-V work integral.
//
// References:
//   - Westinghouse "Pressurizer System Description", typical FSAR Ch 5.
//   - "Pressurizer surge line transient analysis", Lucas (1983) NUREG/CR-3266.

import { tSat as saturationTempK } from './steam-tables.js';

const hFg_const = 1.5e6;        // J/kg — water latent heat at PWR primary P (calibration anchor; see header)
const cp_water_const = 5800;    // J/kg/K — calibrated subcooled water cp at ~290°C, 15 MPa
const rho_water_const = 740;    // kg/m³ — calibrated subcooled water density at ~290°C, 15 MPa
const rho_steam_const = 100;    // kg/m³ — calibrated saturated steam density at ~15.5 MPa
const C_pzr_default = 1.5e9;    // J/MPa — tuned constant capacitance (see header)
// K_surge: MPa per (K/s) of dT_avg/dt — surge compression term. Tuned so that
// a sustained 1%/min ramp in T_avg drives ~0.1 MPa drift (within the variable
// heater's authority), while a fast load-reject (~5%/min) drives 0.3-0.5 MPa
// and pulls in the backup heaters / closes spray. NB: this is per (K/s), NOT
// per K of total deviation — over short timescales it amounts to dt × K_surge
// × dTdt as a one-step ΔP contribution.
const K_surge_default = 0.01;
const Q_loss_design_default = 50e3; // W — ambient/static-loss bias absorbed by the variable heater at design

export function stepPressurizer(state, dt) {
  const T = state.T;
  // No-op for any reactor type without a pressurizer config (RBMK/MSR).
  if (!T.pressurizer) return;
  const P = T.pressurizer;

  // === Compute primary T_avg and its time derivative ===
  // Read from out if updateLoopOutputs has populated it; otherwise compute
  // inline. We're called BEFORE stepPlant per sim.js ordering, but AFTER
  // stepThermal — so state.T_coolant[N-1] is current and state._coolantReturnT
  // is the previous step's value (good enough — surge is a slow indication).
  const tHot = state.T_coolant[state.N - 1];
  const tCold = state._coolantReturnT ?? T.coolantInletTempK;
  const tAvg = 0.5 * (tHot + tCold);
  // dT_avg/dt: simple backwards difference. _tAvgPrev is initialized to the
  // design tAvg so dT_avg/dt = 0 at the first frame. Critical-by-construction.
  if (!Number.isFinite(state._tAvgPrev)) state._tAvgPrev = tAvg;
  const dTavgDt = dt > 0 ? (tAvg - state._tAvgPrev) / dt : 0;
  state._tAvgPrev = tAvg;

  const setpointP = P.setpointP;
  const levelNow = state.pressurizerLevel;
  const Pnow = state.pressurizerP;

  // === Heater state machine ===
  const heaters = state.heaterBanks;
  // Operator manual override: 'off' forces all banks off.
  const manualOff = state.cmd.heaterManualOverride === 'off';
  // Low-level lockout (real-plant heater protection — bare elements above the
  // water surface would burn out).
  heaters.lockedOut = levelNow < 0.17;
  if (heaters.lockedOut || manualOff) {
    heaters.variable = 0;
    heaters.backup1 = false;
    heaters.backup2 = false;
    heaters.backup3 = false;
  } else {
    // Variable heater proportional band: 1 at P ≤ setpoint - 0.10,
    // 0 at P ≥ setpoint + 0.05, linear between.
    const bandLo = setpointP - 0.10;
    const bandHi = setpointP + 0.05;
    let v;
    if (Pnow <= bandLo) v = 1;
    else if (Pnow >= bandHi) v = 0;
    else v = (bandHi - Pnow) / (bandHi - bandLo);
    heaters.variable = v;
    // Backup heaters with simple hysteresis: cut in at progressively lower P,
    // cut out at the band-high of the variable heater (setpoint - 0.10) so
    // they're fully off before the variable starts modulating to 0.
    const cutOutP = setpointP - 0.10;
    if (Pnow < setpointP - 0.20) heaters.backup1 = true;
    else if (Pnow > cutOutP) heaters.backup1 = false;
    if (Pnow < setpointP - 0.50) heaters.backup2 = true;
    else if (Pnow > cutOutP) heaters.backup2 = false;
    if (Pnow < setpointP - 0.80) heaters.backup3 = true;
    else if (Pnow > cutOutP) heaters.backup3 = false;
  }

  // Heater total Q [W].
  const variableW = P.variableHeaterMaxW * heaters.variable;
  const backupW =
    (heaters.backup1 ? P.backupHeaterW : 0) +
    (heaters.backup2 ? P.backupHeaterW : 0) +
    (heaters.backup3 ? P.backupHeaterW : 0);
  const Q_heaters = variableW + backupW;

  // === Spray valve (proportional, no hysteresis — pneumatic) ===
  let sprayOpen;
  if (Pnow <= setpointP + 0.15) sprayOpen = 0;
  else if (Pnow >= setpointP + 0.55) sprayOpen = 1;
  else sprayOpen = (Pnow - (setpointP + 0.15)) / 0.40;
  state.sprayValveOpen = sprayOpen;
  const sprayKgPerS = sprayOpen * P.sprayMaxKgPerS;
  // Spray cooling Q: cold-leg water (at T_cold) enters dome, must heat up to
  // T_sat to condense steam. Q_cool ≈ ṁ_spray × c_p × (T_sat - T_cold) +
  // ṁ_condensed × h_fg. For a tuned-ODE model we lump these into a single
  // effective Q_spray ~ ṁ_spray · h_fg (steam condensation dominates).
  const Q_spray_cooling = sprayKgPerS * hFg_const;

  // === PORV (pneumatic with hysteresis + stuck-open failure mode) ===
  const porvStuck = !!state.cmd.porvStuckOpenFault;
  const blockClosed = !!state.cmd.porvBlockValveClosed;
  let porvOpenNow = state.porvOpen;
  if (blockClosed) {
    porvOpenNow = false;
  } else if (porvStuck) {
    // Stuck open: opens at upper threshold like normal but never re-closes.
    if (Pnow >= P.porvOpenP) porvOpenNow = true;
  } else {
    if (Pnow >= P.porvOpenP) porvOpenNow = true;
    else if (Pnow <= P.porvCloseP) porvOpenNow = false;
  }
  state.porvOpen = porvOpenNow;
  const porvKgPerS = porvOpenNow ? P.porvFlowKgPerS : 0;
  const Q_porv = porvKgPerS * hFg_const; // latent heat removal as steam exits

  // === Code safety valves (3× spring-loaded, optional stuck-open faults) ===
  const stuckArr = state.cmd.codeSafetyValveStuck || [false, false, false];
  let svOpenCount = 0;
  let svKgPerS = 0;
  for (let i = 0; i < 3; i++) {
    let svOpen = state.codeSafetyValves[i];
    if (Pnow >= P.codeSvOpenP) svOpen = true;
    else if (Pnow <= P.codeSvCloseP && !stuckArr[i]) svOpen = false;
    if (stuckArr[i] && Pnow >= P.codeSvOpenP) svOpen = true; // failure mode lock
    state.codeSafetyValves[i] = svOpen;
    if (svOpen) {
      svOpenCount += 1;
      svKgPerS += P.codeSvFlowKgPerS;
    }
  }
  const Q_sv = svKgPerS * hFg_const;

  // === Net Q balance for pressure ODE ===
  // Q_loss represents standing heat loss to environment (containment air,
  // structural conduction, etc.). Scaled so steady-state variable heater
  // modulates around ~30-50% to compensate this load — gives the autopilot a
  // bias to push against.
  const Q_loss = Q_loss_design_default;
  const Q_net = Q_heaters - Q_spray_cooling - Q_porv - Q_sv - Q_loss;

  const C_pzr = P.cPzrJPerMPa ?? C_pzr_default;
  const K_surge = P.kSurgeMPaPerK ?? K_surge_default;
  // Surge ΔP term: positive dT/dt (heatup) → water flows IN → steam
  // compresses → P rises.
  const surgeP_term = K_surge * dTavgDt;

  let dP = (Q_net / C_pzr) * dt + surgeP_term * dt;
  state.pressurizerP = clamp(Pnow + dP, 0.1, 25);

  // === III.1 — RCS inventory coupling ===
  // rcp.js (seal leak, negative) and eccs.js (injection, positive)
  // accumulate their net flow into state._rcsExternalFlowKgPerS this step.
  // Integrate it into the proper RCS inventory scalar, then fold it into
  // the pressurizer surge below: when the RCS loses mass the pressurizer
  // outsurges to keep the solid loops full (level falls); injection
  // insurges (level rises). This replaces the wave-2 stand-in where rcp.js
  // / eccs.js wrote pressurizerWaterMass directly — net effect identical.
  const extRate = state._rcsExternalFlowKgPerS ?? 0;
  if (state.rcsMassKg !== null && state.rcsMassKg !== undefined) {
    state.rcsMassKg = Math.max(0, state.rcsMassKg + extRate * dt);
  }

  // === Surge mass-flow → level update ===
  // m_surge = ρ_water · V_rcs · α · dT_avg/dt  +  external RCS flow  [kg/s]
  // Positive heatup → water expands in RCS → pushed INTO pressurizer → level
  // rises. Sign convention: surgeIn > 0 means water entering pressurizer.
  // The external term carries seal-leak outsurge / ECCS-injection insurge.
  const m_surge_in = rho_water_const * P.rcsVolumeM3 * P.rcsAlpha * dTavgDt
    + extRate;
  // Spray flow adds mass directly to the dome (eventually drains into water
  // pool after condensing). For our lumped model we credit spray mass to the
  // water mass directly.
  const m_spray_in = sprayKgPerS;
  // Boil-off: water → steam at the heater surface. Mass-rate ≈ Q_heaters /
  // h_fg. (Only happens if there's water to boil; lockout handles the empty
  // case.)
  const m_boiloff = heaters.lockedOut ? 0 : (Q_heaters / hFg_const);
  // PORV + SV: steam exits the dome — removes from steam mass.
  const m_steam_out = porvKgPerS + svKgPerS;

  // Update water + steam masses. Water mass is floored at 0 (drained) and
  // capped at 10× design (overfill safety — the high-level scram in rps.js
  // and the code safety valves fire long before this, but the cap keeps a
  // misrouted ECCS injection from blowing up the integrator). Design water
  // mass = dome volume × design level × ρ_water.
  const waterMassCap = P.volumeM3 * P.designLevel * rho_water_const * 10;
  state.pressurizerWaterMass = clamp(
    state.pressurizerWaterMass + (m_surge_in + m_spray_in - m_boiloff) * dt,
    0, waterMassCap);
  state.pressurizerSteamMass = Math.max(0.1, // floor so dome doesn't go negative
    state.pressurizerSteamMass + (m_boiloff - m_steam_out) * dt);

  // Level from water mass + dome geometry. A_pzr = volumeM3 / pzrHeight.
  // We don't carry pzrHeight as a separate tuning constant — back-derive from
  // an aspect-ratio assumption (height = volumeM3^(1/3) × 2.5, modeling a
  // tall thin cylinder ~ 2.5:1 H:D). volumeWater = waterMass / ρ_water.
  const pzrHeightM = Math.pow(P.volumeM3, 1 / 3) * 2.5;
  const A_pzr = P.volumeM3 / pzrHeightM;
  const V_water = state.pressurizerWaterMass / rho_water_const;
  const levelFromMass = V_water / (A_pzr * pzrHeightM);
  state.pressurizerLevel = clamp(levelFromMass, 0, 1);

  // === Water temperature (subcooled bottom region) ===
  // The pressurizer water is heated by the heaters when there's water
  // present (heater elements are submerged) and cools toward T_sat - a few K
  // via wall conduction otherwise. For the tuned-ODE this is mostly cosmetic.
  // Only here so future CVCS coupling (III.3) has a well-defined temperature
  // to dump letdown into.
  const Tsat = saturationTempK(state.pressurizerP);
  const T_target = Tsat - 5; // saturated minus a few K (subcooled by design)
  const tauWater = 60; // s — slow thermal response
  state.pressurizerTwater += ((T_target - state.pressurizerTwater) / tauWater) * dt;

  // === PRT bookkeeping ===
  state.prtMass = Math.max(0, state.prtMass + (porvKgPerS + svKgPerS) * dt);
  const prtCap = P.prtRuptureKg ?? 12000;
  if (!state.prtRuptured && state.prtMass > prtCap) {
    state.prtRuptured = true;
  }
  if (state.prtRuptured) {
    // Slow drip to containment — order-of-magnitude, not the focus. Adds a
    // small steady leak proportional to PRT mass. III.17: routed through the
    // per-step containment accumulators (containment.js owns state.containmentP
    // now); the PRT water flashes on release, carrying ~steam enthalpy.
    const dripKgPerS = Math.min(state.prtMass, 5);
    state._containmentMassInflowKgPerS =
      (state._containmentMassInflowKgPerS ?? 0) + dripKgPerS;
    state._containmentEnergyInflowWperS =
      (state._containmentEnergyInflowWperS ?? 0) + dripKgPerS * 2.6e6;
    state.prtMass = Math.max(0, state.prtMass - dripKgPerS * dt);
  }
}

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
