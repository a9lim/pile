// containment.js — III.17 PWR large-dry containment system.
//
// The wave-2 sim carried containment as two bare scalars (state.containmentP
// / state.containmentT) that rcp.js nudged directly when seal-LOCA leakage
// flashed to steam. III.17 promotes that into a real control volume with a
// mass + energy balance and the three engineered heat-removal systems of a
// Westinghouse large-dry containment:
//
//   Containment sprays — cold borated water drawn from the RWST and sprayed
//     into the containment atmosphere through ring headers. The droplets
//     fall through the steam, condense it (latent-heat removal), and knock
//     pressure down hard. Auto-actuated on high containment pressure (the
//     "Hi-3" / containment-spray-actuation setpoint, well above the SI
//     "Hi-1" setpoint). AC-powered — two 100% pumps.
//   Fan coolers — forced-convection recirculation units. Containment air is
//     blown across CCW-cooled coils. Lower instantaneous capacity than the
//     sprays but they run continuously and are the workhorse for the long-
//     term containment heat sink. Gated on CCW availability + AC.
//   PARs (passive autocatalytic recombiners) — STUB. Hydrogen generation
//     (Zr-water reaction) is Phase IV.2; the recombiner that consumes it is
//     Phase IV.8. PARs are modeled here only as a present-but-inert device
//     so the gauge layer / mimic can show them. No H2 chemistry.
//
// Control volume model (lumped, single-region — large-dry has no internal
// compartment of interest, unlike a BWR drywell/wetwell which is III.18):
//   - Atmosphere = a fixed-volume mix of (mostly) air plus condensable
//     steam. We track total steam mass `steamMassKg` and atmosphere
//     temperature `atmTempK`. The liquid sump is OWNED BY eccs.js
//     (state.eccs.containmentWaterMassKg) — this module READS it for the
//     spray-return accounting but never writes it.
//   - Pressure is the sum of the dry-air partial pressure and the steam
//     partial pressure, each from ideal-gas P = nRT/V. Air mass is fixed
//     (containment is sealed); steam mass varies with release / condensation.
//   - Energy balance on the atmosphere: steam release adds enthalpy; spray
//     condensation and fan-cooler duty remove it; a small structural-
//     heat-sink term relaxes the atmosphere toward the design ambient.
//
// Mass + energy input coupling (the rcp.js re-route):
//   rcp.js previously did `state.containmentP += leakKg * coupling`. III.17
//   replaces that with two per-step accumulators that sim.js zeroes at the
//   top of each step (same family as state._rcsExternalFlowKgPerS):
//     state._containmentMassInflowKgPerS  — kg/s of steam/water entering
//     state._containmentEnergyInflowWperS — W of enthalpy entering
//   Any module that vents primary fluid into containment (rcp.js seal LOCA;
//   future LOCA-break scenarios; pressurizer PORV/PRT-rupture path) adds to
//   these accumulators; containment.js consumes them. This module is the
//   single owner of state.containmentP / state.containmentT after init.
//
// Critical-by-construction:
//   At steady state the reactor is sealed, no primary fluid is escaping,
//   and the design intent is containment at atmospheric pressure / ambient
//   temperature. Init: P = 0.1013 MPa, T = 315 K (≈ 42 °C, the normal
//   containment-air design temperature for a Westinghouse plant — the
//   atmosphere runs warm from RCS / piping standing heat), steamMassKg set
//   to the partial pressure that closes P = P_air + P_steam at exactly
//   0.1013 MPa for that T and V. With zero inflow, no spray, and the
//   structural-relaxation term referenced to the same ambient T, every
//   rate is zero on the first frame.
//
// PWR-only: RBMK had no Western-style pressure-retaining containment (the
//   reactor hall was a confinement, not a containment — the defining
//   Chernobyl design gap); MSRE was housed in a cell, not a large-dry
//   containment. Neither type sets T.containmentVolumeM3 with a `containment`
//   config block, so state.containment is null and stepContainment early-
//   returns. (T.containmentVolumeM3 alone is set by PWR for the legacy rcp.js
//   coupling; the new module gates on the richer T.containment block AND the
//   PWR topology so a stray volume scalar can't half-activate the model.)
//
// References:
//   - Westinghouse FSAR Chapter 6.2 (Containment Systems — large-dry P/T
//     analysis, spray + fan-cooler sizing).
//   - NUREG-0800 SRP §6.2.1.1.A (PWR dry containment pressure analysis).
//   - ANSI/ANS-56.4 (containment spray heat-removal modeling).
//   - Todreas & Kazimi, "Nuclear Systems II" ch. 2 (containment thermo-
//     dynamics, the air+steam partial-pressure decomposition).
//   - Westinghouse AP1000 DCD §6.2 (PAR placement — H2 control, cited only
//     to document why PARs are a Phase-IV stub here).

// ----------------------------------------------------------------------
// Physical constants (module-local — physics is UI-decoupled, node-testable).
// ----------------------------------------------------------------------

// Ideal-gas specific constants (J / kg·K). Dry air and water vapor are
// modeled as ideal gases at containment conditions (low pressure, modest
// superheat) — adequate for the ±few-percent pressure fidelity this module
// targets. Containment intentionally keeps this low-pressure steam model
// module-local; the primary / secondary plant saturation curve is IF97.
const R_AIR = 287.0;    // J/kg·K
const R_STEAM = 461.5;  // J/kg·K

// Atmosphere heat capacity per unit mass. The containment atmosphere is
// overwhelmingly air by mass; we use a single lumped cv for the air+steam
// mix dominated by the air term. Constant-volume because the containment
// envelope is rigid.
const CV_ATM = 850.0;   // J/kg·K — air-dominated mix, constant volume

// Latent heat of condensation for the steam that the sprays / fan coolers
// knock out of the atmosphere. Constant at the containment pressure scale.
const H_FG = 2.26e6;    // J/kg at ≈ 0.1 MPa

// Reference / design ambient state for critical-by-construction.
const P_ATM = 0.1013;       // MPa absolute — sea-level atmospheric
const T_AMBIENT_K = 315.0;  // K (≈ 42 °C) — normal containment-air design T

// Structural / passive heat-sink relaxation time constant. The containment
// shell, internal concrete, and equipment are an enormous passive heat sink;
// after a release they slowly pull the atmosphere back toward ambient even
// with the engineered systems off. Long τ — this is the slow background
// term, not a credited safety function.
const STRUCTURAL_RELAX_TAU_S = 7200.0;  // 2 hours

// Sustained-condition latch period for the warning channels — matches the
// rps.js / aux-cooling.js 2-second convention.
const WARNING_LATCH_SEC = 2.0;

// gpm → kg/s for cold water (998.2 kg/m³ at 20 °C) — same convention as
// rcp.js / eccs.js so spray flow reads consistently across the sim.
const GPM_TO_KG_PER_S = 0.0631;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// ----------------------------------------------------------------------
// Initial steam mass that closes P = P_air + P_steam at exactly P_ATM for
// the design (T_AMBIENT_K, V) state. createState() calls this so the init
// block and the physics agree on the critical-by-construction point.
//
//   P_air   = m_air   · R_AIR   · T / V        (m_air fixed for all time)
//   P_steam = m_steam · R_STEAM · T / V
//   P_total = P_air + P_steam  ⇒  solve for the (m_air, m_steam) pair.
//
// We pick the split via a design relative humidity: at ambient the
// containment atmosphere is ~40 % steam-by-partial-pressure-fraction is far
// too high; physically the steam partial pressure at 42 °C / 40 % RH is only
// ~3.3 kPa. We use that small steam partial pressure and let air carry the
// balance. The exact split barely matters for the dynamics (air mass is
// constant; only steam mass moves), but getting the init steam mass right
// means a release adds to a physically-sensible baseline.
// ----------------------------------------------------------------------
export function containmentInitMasses(volumeM3) {
  const V = volumeM3;
  const T = T_AMBIENT_K;
  // Design steam partial pressure at ambient: ~3.3 kPa (42 °C, ~40 % RH).
  const pSteam0_MPa = 0.0033;
  const pAir0_MPa = P_ATM - pSteam0_MPa;
  // P[MPa]·1e6 = m·R·T/V  ⇒  m = P·1e6·V / (R·T)
  const airMassKg = pAir0_MPa * 1e6 * V / (R_AIR * T);
  const steamMassKg = pSteam0_MPa * 1e6 * V / (R_STEAM * T);
  return { airMassKg, steamMassKg };
}

// Pressure (MPa absolute) from current masses + temperature + volume.
// Dalton's law: P = P_air + P_steam, each ideal-gas.
function containmentPressureMPa(airMassKg, steamMassKg, atmTempK, volumeM3) {
  const pAir = airMassKg * R_AIR * atmTempK / volumeM3;       // Pa
  const pSteam = steamMassKg * R_STEAM * atmTempK / volumeM3; // Pa
  return (pAir + pSteam) / 1e6;                                // MPa
}

/**
 * Per-step containment advancement. PWR-only — RBMK / MSR omit the
 * T.containment config block (and primaryTopology !== 'pwr'), so the
 * module early-returns and the legacy scalar values persist untouched.
 *
 * Reads:
 *   - state._containmentMassInflowKgPerS  (steam/water release rate)
 *   - state._containmentEnergyInflowWperS (enthalpy release rate)
 *   - state.containmentP / state.containmentT (previous-step values)
 *   - state.eccs?.rwstMassKg               (spray suction inventory)
 *   - state.eccs?.containmentWaterMassKg   (sump — READ ONLY)
 *   - state.ccw?.available                 (fan-cooler heat sink)
 *   - state.electrical?.acAvailable        (spray + fan-cooler power)
 *   - state.cmd.containmentSprayManual / .containmentSprayBlock
 *   - state.cmd.fanCoolerManualStop[]
 *
 * Writes:
 *   - state.containmentP / state.containmentT (single owner after init)
 *   - state.containment.* (all containment-system state)
 *   - state.out.containment* readouts
 *   - state._containmentSprayDrawKgPerS (spray RWST draw — eccs.js hand-off)
 */
export function stepContainment(state, dt) {
  const T = state.T;
  // Gate on BOTH the rich config block AND the PWR topology. T.containmentVolumeM3
  // alone exists on PWR for the legacy rcp.js coupling; the full model needs
  // T.containment. RBMK/MSR have neither — state.containment is null for them.
  if (!T.containment || T.primaryTopology !== 'pwr') return;
  const c = state.containment;
  if (!c) return; // defensive — state.js builds this for PWR only
  const cfg = T.containment;
  const V = T.containmentVolumeM3 ?? 50000;

  // === Power availability ===
  const acOk = state.electrical
    ? state.electrical.acAvailable === true
    : true;
  // CCW is the fan-cooler heat sink. If aux-cooling.js hasn't built
  // state.ccw (shouldn't happen for PWR, but defensive), assume available.
  const ccwOk = state.ccw ? state.ccw.available === true : true;

  // === Consume the per-step release accumulators ===
  // sim.js zeroes these at the top of each step; rcp.js (+ future LOCA
  // scenarios) add to them. Defensive ?? 0 in case a step runs before any
  // producer module touched them.
  const massInflowKgPerS = state._containmentMassInflowKgPerS ?? 0;
  const energyInflowWperS = state._containmentEnergyInflowWperS ?? 0;

  // ============================================================
  // 1. Containment spray
  // ============================================================
  // Auto-actuation: latches when containment pressure exceeds the spray
  // setpoint (the Westinghouse "Hi-3" containment-spray-actuation signal,
  // ~0.17 MPa abs ≈ 0.7 barg — well above the SI "Hi-1" at ~0.115 MPa, so
  // sprays start only for a genuine large release, not a minor one HHSI can
  // chase). Stays latched until pressure drops below a reset hysteresis
  // band AND the operator clears it. Manual actuation OR's in; a manual
  // block forces sprays off (operator isolation of a spray-system fault).
  const spraySetpoint = cfg.spraySetpointMPa ?? 0.17;
  const sprayResetP = cfg.sprayResetMPa ?? 0.14;
  const blocked = state.cmd.containmentSprayBlock === true;
  const manualSpray = state.cmd.containmentSprayManual === true;

  if (!c.sprayActuated && state.containmentP > spraySetpoint) {
    c.sprayActuated = true;
    if (c.sprayFirstActuatedTime === null) {
      c.sprayFirstActuatedTime = state.simTime;
    }
  } else if (c.sprayActuated && state.containmentP < sprayResetP
             && state.cmd.containmentSprayReset === true) {
    c.sprayActuated = false;
    c.sprayFirstActuatedTime = null;
    state.cmd.containmentSprayReset = false; // consume one-shot reset
  }

  // Sprays run if (auto-actuated OR manual) AND not blocked AND AC is up
  // AND there is suction inventory in the RWST. Spray suction is from the
  // RWST in the injection phase; sump-recirc spray is a procedural follow-
  // on we leave to the operator's eccs suction switch (the spray draw is
  // debited from the RWST here, see the eccs hand-off below).
  const rwstMassKg = state.eccs ? state.eccs.rwstMassKg : 0;
  const sprayHasSuction = rwstMassKg > (cfg.sprayMinSuctionKg ?? 5e4);
  const sprayRunning = (c.sprayActuated || manualSpray) && !blocked
    && acOk && sprayHasSuction;
  c.sprayRunning = sprayRunning;

  // Spray flow: lumped two-pump capacity. Held at rated flow when running
  // (the pump head curve into a low-pressure containment is essentially
  // flat over the operating band — no need for the parabolic curve eccs.js
  // uses against high RCS pressure).
  const sprayFlowGpm = sprayRunning ? (cfg.sprayFlowGpm ?? 6500) : 0;
  const sprayFlowKgPerS = sprayFlowGpm * GPM_TO_KG_PER_S;
  c.sprayFlowKgPerS = sprayFlowKgPerS;

  // Steam condensed by the spray. Cold RWST droplets (~T_AMBIENT) fall
  // through the steam-laden atmosphere; steam condenses ON the cold droplet
  // surface, warming the droplet. The condensation budget per kg of spray
  // water is the sensible-heat capacity of the droplet to warm from its
  // cold inlet temperature toward the steam saturation temperature — NOT
  // toward the bulk atmosphere temperature. This is the key fidelity point:
  // a spray keeps condensing steam even after it has cooled the bulk air to
  // ambient, because the droplet surface sits below steam saturation as
  // long as steam is present. (Referencing the budget to bulk-air ΔT would
  // wrongly choke condensation the moment the air cooled, leaving pressure
  // plateaued — see III.17 report verification.)
  // Steam saturation temperature is estimated from the steam partial
  // pressure via the module-local containment fit below. A coarse estimate is
  // fine here since the budget is bounded by steam inventory anyway; primary
  // and secondary plant code use steam-tables.js IF97 instead.
  const sprayEff = cfg.sprayEfficiency ?? 0.7;
  const cpWater = 4186; // J/kg·K
  // Steam partial pressure (MPa) from the current inventory.
  const pSteamMPa = c.steamMassKg * R_STEAM * state.containmentT / V / 1e6;
  const tSatSteamK = steamSaturationTempK(pSteamMPa);
  // Spray inlet temperature = RWST water temperature ≈ ambient.
  const sprayInletK = cfg.sprayInletTempK ?? T_AMBIENT_K;
  // Droplet heatup span: from inlet toward steam saturation. Floored at 0
  // so a sub-ambient edge case can't make condensation negative.
  const sprayCondSpanK = Math.max(0, tSatSteamK - sprayInletK);
  const condensableBySpray = sprayFlowKgPerS * dt
    * sprayEff * cpWater * sprayCondSpanK / H_FG; // kg of steam condensable
  // Actual condensation also can't exceed the steam inventory.
  const steamCondensedBySpray = Math.min(condensableBySpray, c.steamMassKg);
  // Sensible-heat ΔT the spray takes off the bulk air (for the energy
  // balance below) — this term DOES reference bulk-air vs spray inlet.
  const sprayDeltaT = Math.max(0, state.containmentT - sprayInletK);

  // ============================================================
  // 2. Fan coolers
  // ============================================================
  // Forced-convection recirculation units. Heat removal Q = UA · (T_atm −
  // T_ccw_sink), available only with CCW (the coil heat sink) and AC (the
  // fan motors). Per-unit; operator can manually stop individual units.
  const numFans = cfg.fanCoolerCount ?? 4;
  const fanStops = state.cmd.fanCoolerManualStop || [];
  const fanUaPerUnit = cfg.fanCoolerUaWperK ?? 1.2e5;
  // CCW supply temperature is the fan-cooler coil sink. Read the live CCW
  // outlet temp when aux-cooling.js has built state.ccw; else fall back to
  // the ambient design temp.
  const ccwSinkT = state.ccw ? state.ccw.outletTempK : T_AMBIENT_K;
  let fansRunning = 0;
  let fanCoolerQ_W = 0;
  for (let i = 0; i < numFans; i++) {
    const running = acOk && ccwOk && !fanStops[i];
    if (running) {
      fansRunning += 1;
      // Heat pulled out of the atmosphere by this unit. Clamp ≥ 0 — a fan
      // cooler doesn't heat the containment when the atmosphere is colder
      // than its CCW sink.
      const dT = state.containmentT - ccwSinkT;
      if (dT > 0) fanCoolerQ_W += fanUaPerUnit * dT;
    }
  }
  c.fanCoolersRunning = fansRunning;
  c.fanCoolerHeatRemovalW = fanCoolerQ_W;

  // ============================================================
  // 3. PARs — STUB (Phase IV.8)
  // ============================================================
  // Passive autocatalytic recombiners consume hydrogen (H2 + ½O2 → H2O on
  // a catalyst, no ignition source needed). Hydrogen generation is the
  // Zr-water reaction (Phase IV.2) and the recombiner that consumes it is
  // Phase IV.8 — neither exists yet. We expose the device as present and
  // passive so the gauge layer / mimic can render it, but it does NOTHING
  // to the P/T balance here. Do NOT add H2 chemistry in this module.
  c.parsInstalled = cfg.parCount ?? 2;
  c.parsActive = false;          // becomes meaningful in Phase IV.8
  c.hydrogenMoleFrac = 0;        // Phase IV.2 will track real H2

  // ============================================================
  // 4. Steam mass balance
  // ============================================================
  // Steam in: the release accumulator (kg/s). Steam out: condensation by
  // sprays + fan coolers. Fan-cooler condensation: the fan-cooler duty is a
  // sensible+latent atmosphere-cooling term; the portion that actually
  // condenses steam is the latent fraction. We treat the fan-cooler duty as
  // condensing steam at H_FG up to the available steam inventory, which is
  // the dominant heat-removal mechanism in a steam-laden containment.
  const steamCondensedByFans = Math.min(
    fanCoolerQ_W * dt / H_FG,
    Math.max(0, c.steamMassKg - steamCondensedBySpray));
  const totalSteamCondensed = steamCondensedBySpray + steamCondensedByFans;

  const steamInKg = massInflowKgPerS * dt;
  c.steamMassKg = Math.max(0, c.steamMassKg + steamInKg - totalSteamCondensed);

  // ============================================================
  // 5. Atmosphere energy balance
  // ============================================================
  // dU/dt = Q_in − Q_spray − Q_fan − Q_struct
  //   Q_in     — enthalpy of the released steam/water (accumulator).
  //   Q_spray  — latent heat carried off by spray-condensed steam, PLUS the
  //              sensible heat the cold spray water absorbs from the air.
  //   Q_fan    — fan-cooler duty (already a heat-out rate).
  //   Q_struct — slow relaxation to the passive structural heat sink.
  // The atmosphere thermal mass is the air+steam mix; air dominates and is
  // constant, so we use the (fixed) air mass as the lumped thermal mass.
  const atmMassKg = c.airMassKg; // air-dominated; constant
  const heatCap = atmMassKg * CV_ATM; // J/K

  // Spray sensible-heat removal: the spray water leaves at ~atmosphere T,
  // having absorbed c_p·ΔT from the air per kg. (This is separate from the
  // latent term, which left with the condensed steam.)
  const Q_spray_sensible = sprayFlowKgPerS * cpWater * sprayDeltaT; // W
  const Q_spray_latent = steamCondensedBySpray * H_FG / dt;          // W
  const Q_spray = Q_spray_sensible + Q_spray_latent;

  // Structural relaxation: first-order pull toward ambient. Expressed as a
  // heat rate so it folds cleanly into the same energy balance.
  const Q_struct = heatCap * (state.containmentT - T_AMBIENT_K)
    / STRUCTURAL_RELAX_TAU_S;

  const dU = (energyInflowWperS - Q_spray - fanCoolerQ_W - Q_struct) * dt;
  let atmTempK = state.containmentT + dU / heatCap;
  // Clamp to a sane band — a runaway here would just be a modeling artifact
  // (this module isn't the severe-accident chain). Floor at ambient, cap at
  // the design-basis peak-plus-margin.
  atmTempK = clamp(atmTempK, T_AMBIENT_K, cfg.maxAtmTempK ?? 475);
  state.containmentT = atmTempK;
  c.atmTempK = atmTempK;

  // ============================================================
  // 6. Pressure from the updated masses + temperature
  // ============================================================
  // Dalton's law: air partial pressure (fixed mass, varies only with T) +
  // steam partial pressure (varies with both). This is the single owner of
  // state.containmentP after init.
  const pNew = containmentPressureMPa(c.airMassKg, c.steamMassKg, atmTempK, V);
  state.containmentP = pNew;
  c.pressureMPa = pNew;

  // ============================================================
  // 7. RWST draw hand-off to eccs.js
  // ============================================================
  // The spray pumps draw from the RWST. eccs.js owns RWST inventory, so
  // rather than this module writing eccs.rwstMassKg directly (which would
  // race the eccs.js suction-drain), we publish the spray draw on a per-
  // step accumulator that eccs.js reads and debits. Documented in the
  // report as the III.17 eccs.js delta. eccs.js consumes it on the next step
  // so sprays both condense steam and move real RWST/sump inventory.
  state._containmentSprayDrawKgPerS = sprayFlowKgPerS;
  // The spray water, having condensed steam and fallen out, joins the
  // containment sump (eccs.js's containmentWaterMassKg). We publish the
  // sump-deposit rate the same way; eccs.js credits it. Deposit = spray
  // flow that reached the floor + the steam it condensed (now liquid).
  state._containmentSumpInflowKgPerS = sprayFlowKgPerS
    + (totalSteamCondensed / dt);

  // ============================================================
  // 8. Warning channels — sustained-condition accumulators
  // ============================================================
  // Same 2-second-latch pattern as aux-cooling.js / rps.js. The trip
  // checks in rps.js read the latched booleans.
  const highP = pNew > (cfg.highPressureWarnMPa ?? 0.13);
  const highT = atmTempK > (cfg.highTempWarnK ?? 400);
  c.highPressureAccumSec = highP ? c.highPressureAccumSec + dt : 0;
  c.highTempAccumSec = highT ? c.highTempAccumSec + dt : 0;
  c.highPressureLatched = c.highPressureAccumSec > WARNING_LATCH_SEC;
  c.highTempLatched = c.highTempAccumSec > WARNING_LATCH_SEC;

  // ============================================================
  // 9. Readouts
  // ============================================================
  const out = state.out;
  out.containmentPressureMPa = pNew;
  out.containmentTempK = atmTempK;
  out.containmentSprayActive = sprayRunning;
  out.containmentSprayFlowKgPerS = sprayFlowKgPerS;
  out.containmentFanCoolersRunning = fansRunning;
  out.containmentSteamMassKg = c.steamMassKg;
  // Gauge band: barg = abs − atmospheric. Operators read containment in
  // barg / psig; the gauge layer can format from this.
  out.containmentPressureBarg = (pNew - P_ATM) * 10; // MPa → bar
}

// Steam saturation temperature (K) from partial pressure (MPa). Inverse
// Antoine, kPa-form, kept module-local for the containment partial-pressure
// band (a few kPa up to ~0.5 MPa). Do not copy this back into primary /
// secondary plant code; those modules use steam-tables.js IF97.
// Clamped to a sane floor so a near-zero steam inventory doesn't blow up
// the log.
function steamSaturationTempK(pMPa) {
  const pKPa = Math.max(0.61, pMPa * 1000); // floor at the triple point
  const T_C = 1668.21 / (7.09181 - Math.log10(pKPa)) - 228;
  return T_C + 273.15;
}
