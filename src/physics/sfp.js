// sfp.js — III.20 Spent Fuel Pool cooling.
//
// The Spent Fuel Pool (SFP) is a deep, borated-water-filled basin adjacent
// to (or, in BWRs, above) the reactor that stores discharged fuel
// assemblies. It is a SEPARATE plant system from the reactor cooling
// loops, and its single most important property for the operator-trainer
// is INDEPENDENCE: the SFP decay-heat load is a slowly-decaying inventory
// of OLD fuel and has essentially NOTHING to do with whether the reactor
// is at power, scrammed, or defueled. A reactor SCRAM does not change the
// SFP heat load; a loss of SFP cooling is its own initiating event.
//
// The SFP cooling train (one per Westinghouse plant, typically 2×100%
// pump + HX redundancy lumped here to a single loop):
//
//   pool water → SFP circulation pump → SFP heat exchanger → back to pool
//                                            │
//                                            └─ rejects to CCW
//
// The SFP HX dumps the pool's decay heat into the Component Cooling Water
// system (state.ccw). The circulation pump is AC-powered. So the SFP
// cooling function is lost on EITHER:
//   - loss of AC (LOOP without EDG pickup) — the pump stops, OR
//   - loss of CCW — the HX has no heat sink even with the pump running.
// Operator can also stop the pump manually (`cmd.sfpCoolingPumpOn`).
//
// === Loss-of-cooling progression (the III.20 scope) ===
//
// With cooling lost, the pool is a thermos with a multi-MW heater in it.
// The progression — slow, hours-long — is:
//
//   1. Heatup phase. Pool bulk temperature climbs from its ~40 °C normal
//      value toward saturation. Energy balance:
//          m · c · dT/dt = Q_decay − Q_cooling
//      with Q_cooling = 0 once the train is lost. At a few-MW load and
//      ~1.4×10⁶ kg of water this is ~0.5 K per minute — single-digit
//      hours to reach boiling. (NRC SFP studies, NUREG-1738, give 4-100 h
//      to boil depending on pool loading / time since last offload; a
//      heavily-loaded pool right after a full-core offload is the fast
//      end. We model the mid case, defensible for a pool ~1 yr post-outage.)
//
//   2. Boil-off phase. At saturation (~373 K at the pool's free surface,
//      atmospheric) the pool can no longer store the heat as sensible
//      energy — it goes to latent heat of vaporization:
//          dm/dt = −Q_decay / h_fg
//      Pool level drops. h_fg ≈ 2.26×10⁶ J/kg at atmospheric. At ~5 MW
//      this boils off ~2.2 kg/s ≈ 8 t/h — a fully-covered pool (the racks
//      sit under ~8 m of water; ~3 m of that is above the active fuel)
//      uncovers the fuel tops over many hours.
//
//   3. Uncovery. When the water level drops to the top of the active fuel
//      (`uncoveryLevelFrac`), the assemblies start to be exposed to steam
//      / air. This is where the III.20 model STOPS and raises a flag:
//      `state.sfp.fuelUncovered = true` and the `sfpFuelUncovered`
//      warning latches. The full zirconium-fire severe-accident chain
//      (clad heatup in steam/air, Zr-steam exothermic runaway, fission-
//      product release) is Phase IV / VI.26 — not modeled here. III.20
//      delivers the operator-relevant precursor chain and the alarm.
//
// Makeup: the operator can add water via `cmd.sfpMakeupKgPerS` (a fire
// pump / safety-related makeup line / portable diesel pump — the
// post-Fukushima B.5.b / FLEX provision). Makeup adds mass and, because
// the incoming water is cooler than the pool, also removes a little
// sensible heat; we credit only the mass for simplicity (the thermal
// credit is second-order against a multi-MW decay load).
//
// === Critical-by-construction ===
//
// At init, cooling is ON. state.js sizes the pool at its normal operating
// temperature and the HX UA is chosen so that, with CCW at its design
// outlet temperature, Q_cooling = Q_decay EXACTLY at the normal pool
// temperature → dT/dt = 0. The pool sits flat until something perturbs
// it. (See the UA-sizing note on T.sfp in reactor-types.js: the report
// gives the closed-form UA that makes this hold.)
//
// === Time-accel stability ===
//
// The heatup ODE is dT/dt = (Q_decay − UA·(T − T_sink))/(m·c): a stable
// first-order relaxation toward an equilibrium temperature. Explicit
// Euler on a relaxation ODE is stable as long as dt < 2·τ where
// τ = m·c / UA. With m·c ≈ 5.9×10⁹ J/K and UA ≈ 1.x×10⁵ W/K, τ is many
// hours, so even the integrator's coarsest substep at 36000× accel is far
// inside the stability bound. The boil-off phase is dm/dt = −Q/h_fg —
// linear, unconditionally stable. So the SFP ODE is safe at any accel the
// sim offers; we still clamp T at the saturation ceiling and mass at
// [0, design] defensively. No adaptive-substep pressure is added by this
// module.
//
// References:
//   - NUREG-1738 "Technical Study of Spent Fuel Pool Accident Risk at
//     Decommissioning Nuclear Power Plants" (heatup / boil-off timelines)
//   - NUREG-2161 "Consequence Study of a Beyond-Design-Basis Earthquake
//     Affecting the Spent Fuel Pool for a US Mark I BWR"
//   - NRC Order EA-12-049 / NEI 12-06 (FLEX — diverse SFP makeup)
//   - Westinghouse FSAR Ch 9.1.3 (Spent Fuel Pool Cooling and Cleanup)
//
// Module ordering in sim.js::step: AFTER stepAuxCooling (so this step's
// state.ccw.available is current — the SFP HX rejects to CCW) and AFTER
// stepElectrical (so this step's AC-availability is current — the SFP
// circulation pump is AC-powered). Placed late in the support-system
// block alongside the other III.x auxiliaries. The SFP does not feed
// back into the reactor / RCS at all, so its position relative to
// neutronics / thermal / pressurizer is immaterial.

// Latent heat of vaporization of water at atmospheric pressure (J/kg).
const H_FG_ATMOSPHERIC = 2.26e6;

// Specific heat of liquid water at SFP temperatures (~40-100 °C), J/kg/K.
const C_WATER = 4186;

// Sustained-condition accumulator period for the warning channels —
// matches the 2 s convention used by aux-cooling.js / rps.js.
const WARNING_LATCH_SEC = 2;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Per-step Spent Fuel Pool advancement. PWR-only — RBMK / MSR omit T.sfp
 * and the module early-returns (state.sfp is null for those types; see
 * the universality note in the III.20 report — making it universal is a
 * trivial follow-up, the physics is reactor-type-agnostic).
 *
 * Reads:
 *   - state.ccw?.available, state.ccw?.outletTempK (heat-sink for the HX)
 *   - state.electrical?.acAvailable (circulation pump power)
 *   - state.cmd.sfpCoolingPumpOn, state.cmd.sfpMakeupKgPerS
 *   - state.simTime (for the boil-off start timestamp)
 *
 * Writes:
 *   - state.sfp.* (this module OWNS the block after createState)
 *   - state.out.sfp* readouts
 */
export function stepSfp(state, dt) {
  const T = state.T;
  // No-op for any reactor type without SFP config (RBMK / MSR). PWR-only,
  // same pattern as eccs.js / aux-cooling.js. state.js builds state.sfp
  // only when T.sfp is defined.
  if (!T.sfp) return;
  const sfp = state.sfp;
  if (!sfp) return; // defensive — state.js builds this for PWR only
  const cfg = T.sfp;

  // ============================================================
  // 1. Decay-heat load of the stored inventory
  // ============================================================
  // The SFP heat load is a slowly-decaying fixed inventory of OLD fuel.
  // Over a single simulator session (hours of sim time) the change is
  // negligible, so we hold it constant at the configured value. The
  // optional cfg.decayConstantPerSec lets a scenario apply a slow
  // exponential decay (e.g. modeling a months-long run); default 0 =
  // constant. This is INDEPENDENT of state.out.fissionPowerMW — a
  // reactor scram does not change it. That independence is the whole
  // pedagogical point of the module.
  if (cfg.decayConstantPerSec && cfg.decayConstantPerSec > 0) {
    sfp.decayHeatW *= Math.exp(-cfg.decayConstantPerSec * dt);
  }
  const Q_decay = sfp.decayHeatW;

  // ============================================================
  // 2. Cooling-train availability
  // ============================================================
  // The SFP circulation pump is AC-powered; the SFP HX rejects to CCW.
  // Cooling is available iff: operator hasn't stopped the pump, AC is up,
  // and CCW is available as a heat sink. Either AC loss or CCW loss takes
  // the function out — the two classic SFP-loss initiators.
  const pumpCommandedOn = state.cmd.sfpCoolingPumpOn !== false; // default ON
  const acOk = state.electrical
    ? state.electrical.acAvailable === true
    : true;
  const ccwOk = state.ccw
    ? state.ccw.available === true
    : true;
  sfp.pumpRunning = pumpCommandedOn && acOk;
  sfp.coolingAvailable = sfp.pumpRunning && ccwOk;

  // ============================================================
  // 3. Heat removed by the SFP HX
  // ============================================================
  // Q_cooling = UA · (T_pool − T_sink). The sink is the CCW supply
  // temperature when CCW is exposing one (state.ccw.outletTempK); if CCW
  // isn't modeled for this build we fall back to a fixed ultimate-heat-
  // sink temperature. Heat removal only happens when the whole train is
  // available; a stopped pump or lost CCW gives Q_cooling = 0.
  const sinkTempK = (state.ccw && Number.isFinite(state.ccw.outletTempK))
    ? state.ccw.outletTempK
    : (cfg.ultimateHeatSinkTempK ?? 308.15);
  let Q_cooling = 0;
  if (sfp.coolingAvailable) {
    Q_cooling = cfg.hxUA_W_per_K * (sfp.waterTempK - sinkTempK);
    if (Q_cooling < 0) Q_cooling = 0; // HX can't heat the pool
  }
  sfp.coolingHeatW = Q_cooling;
  sfp.decayHeatLoadW = Q_decay;

  // ============================================================
  // 4. Operator makeup
  // ============================================================
  // Diverse makeup (FLEX / B.5.b portable pump, safety-related makeup
  // line). Adds mass; we credit only the mass, not the (second-order)
  // sensible-heat removal of the cooler incoming water. Clamped to the
  // design full mass so makeup can't overfill the pool model.
  const makeupKgPerS = Math.max(0, state.cmd.sfpMakeupKgPerS || 0);
  sfp.makeupKgPerS = makeupKgPerS;

  // ============================================================
  // 5. Energy / mass balance — heatup vs boil-off
  // ============================================================
  // Phase determined by whether the pool has reached its saturation
  // ceiling. Below saturation: sensible heatup, mass changes only by
  // makeup. At saturation with a net heat surplus: boil-off, temperature
  // pinned at T_sat and the surplus drives mass loss through h_fg.
  const T_sat = cfg.saturationTempK ?? 373.15;
  const m = sfp.waterMassKg;
  const heatCapJ = m * C_WATER; // current pool heat capacity, J/K
  const Q_net = Q_decay - Q_cooling; // > 0 = pool gaining energy

  if (sfp.waterTempK < T_sat - 1e-6 || Q_net <= 0) {
    // --- Heatup / cooldown phase (sensible heat) ---
    // First-order relaxation ODE: dT/dt = Q_net / (m·c). Stable under
    // explicit Euler for any dt the integrator offers (τ = m·c/UA is
    // many hours). Clamp the result at the saturation ceiling so a large
    // accel substep can't overshoot into unphysical superheated liquid.
    if (heatCapJ > 0) {
      const dT = Q_net * dt / heatCapJ;
      sfp.waterTempK = clamp(sfp.waterTempK + dT, sinkTempK - 5, T_sat);
    }
    sfp.boiling = false;
    sfp.boiloffKgPerS = 0;
    // Mass only changes by makeup in this phase.
    sfp.waterMassKg = clamp(m + makeupKgPerS * dt, 0, cfg.designWaterMassKg);
  } else {
    // --- Boil-off phase ---
    // Pool is at saturation with a heat surplus. Temperature is pinned;
    // the surplus boils water off: dm/dt = −Q_net / h_fg. Linear in dt,
    // unconditionally stable. Makeup is added back in the same balance,
    // so sustained makeup ≥ boil-off rate arrests (and reverses) the
    // level drop.
    sfp.waterTempK = T_sat;
    sfp.boiling = true;
    const boiloffKgPerS = Q_net / H_FG_ATMOSPHERIC;
    sfp.boiloffKgPerS = boiloffKgPerS;
    const dm = (makeupKgPerS - boiloffKgPerS) * dt;
    sfp.waterMassKg = clamp(m + dm, 0, cfg.designWaterMassKg);
    // If makeup has refilled enough that the pool drops back below the
    // boiling ceiling on the next step the heatup branch resumes — but
    // while pinned at T_sat the temperature stays there; the operator
    // sees the level recover before the temperature does, which is the
    // physically-correct ordering.
  }

  // ============================================================
  // 6. Level + uncovery
  // ============================================================
  // Level is reported as a fraction of the design (full) inventory. The
  // active fuel sits in the bottom of the pool; `uncoveryLevelFrac` is
  // the level at which the water surface reaches the top of the active
  // fuel. Below that, assemblies begin to be exposed → zirc-fire risk.
  // III.20 stops here and raises the flag; the fire physics is Phase IV.
  sfp.levelFrac = cfg.designWaterMassKg > 0
    ? sfp.waterMassKg / cfg.designWaterMassKg
    : 0;
  const uncoveryFrac = cfg.uncoveryLevelFrac ?? 0.35;
  const nowUncovered = sfp.levelFrac <= uncoveryFrac;
  if (nowUncovered && !sfp.fuelUncovered) {
    sfp.fuelUncovered = true;
    if (sfp.fuelUncoveredTime === null) sfp.fuelUncoveredTime = state.simTime;
  } else if (!nowUncovered && sfp.makeupKgPerS > 0) {
    // Makeup has re-covered the fuel. Clear the flag so the operator can
    // see the recovery (the timestamp is kept as a forensic record of
    // when uncovery first occurred — same convention as rcp.js's
    // firstStageFailureTime).
    sfp.fuelUncovered = false;
  }
  // Zirc-fire risk flag: fuel uncovered AND still boiling (heat with no
  // water cover). This is the hand-off marker to the Phase IV / VI.26
  // severe-accident chain — III.20 only raises it.
  sfp.zircFireRisk = sfp.fuelUncovered && sfp.boiling;

  // ============================================================
  // 7. Warning sustained-condition accumulators
  // ============================================================
  // Same 2 s sustained-condition pattern as aux-cooling.js. SFP warnings
  // are all WARNING-class (the SFP is not the reactor — see the rps.js
  // delta in the III.20 report; none of these are in SCRAM_TRIPS).
  const highTempCond = sfp.waterTempK > (cfg.highTempWarnK ?? 333.15);
  const lowLevelCond = sfp.levelFrac < (cfg.lowLevelWarnFrac ?? 0.85);
  const coolingLostCond = !sfp.coolingAvailable;

  sfp.highTempAccumSec = highTempCond ? sfp.highTempAccumSec + dt : 0;
  sfp.lowLevelAccumSec = lowLevelCond ? sfp.lowLevelAccumSec + dt : 0;
  sfp.coolingLostAccumSec = coolingLostCond ? sfp.coolingLostAccumSec + dt : 0;

  sfp.highTempLatched = sfp.highTempAccumSec > WARNING_LATCH_SEC;
  sfp.lowLevelLatched = sfp.lowLevelAccumSec > WARNING_LATCH_SEC;
  sfp.coolingLostLatched = sfp.coolingLostAccumSec > WARNING_LATCH_SEC;
  // Boiling and uncovery latch immediately (no 2 s gate) — they are
  // discrete physical thresholds, not noisy continuous signals, and the
  // operator wants the alarm the instant the pool crosses them.

  // ============================================================
  // 8. Readouts
  // ============================================================
  const out = state.out;
  out.sfpWaterTempK = sfp.waterTempK;
  out.sfpLevelFrac = sfp.levelFrac;
  out.sfpBoiling = sfp.boiling;
  out.sfpBoiloffKgPerS = sfp.boiloffKgPerS;
  out.sfpCoolingAvailable = sfp.coolingAvailable;
  out.sfpCoolingHeatMW = Q_cooling / 1e6;
  out.sfpDecayHeatMW = Q_decay / 1e6;
  out.sfpFuelUncovered = sfp.fuelUncovered;
  out.sfpZircFireRisk = sfp.zircFireRisk;
  // Time-to-boil / time-to-uncovery estimates, useful as operator
  // decision-support readouts. Both are first-order projections from the
  // current rate (they ignore the slow decay of Q_decay, which is
  // conservative — the real margins are slightly longer).
  if (sfp.boiling) {
    out.sfpTimeToBoilSec = 0;
    // Time to uncover the fuel from the current level at the current
    // net boil-off rate. Infinite (null) when makeup ≥ boil-off.
    const netDrainKgPerS = sfp.boiloffKgPerS - sfp.makeupKgPerS;
    if (netDrainKgPerS > 1e-6) {
      const massToUncovery = sfp.waterMassKg
        - uncoveryFrac * cfg.designWaterMassKg;
      out.sfpTimeToUncoverSec = Math.max(0, massToUncovery / netDrainKgPerS);
    } else {
      out.sfpTimeToUncoverSec = null; // makeup holds the level
    }
  } else {
    out.sfpTimeToUncoverSec = null;
    // Time to reach saturation from the current temperature at the
    // current net heating rate. Null when the pool is being cooled
    // (Q_net ≤ 0) — it will never boil.
    if (Q_net > 1e-3 && heatCapJ > 0) {
      out.sfpTimeToBoilSec = (T_sat - sfp.waterTempK) * heatCapJ / Q_net;
    } else {
      out.sfpTimeToBoilSec = null;
    }
  }
}
