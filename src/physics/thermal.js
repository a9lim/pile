// thermal.js -- 1D axial thermal-hydraulics + decay heat + void formation.
//
// THREE-NODE THERMAL STACK (PWR / RBMK)
//
// Each axial node evolves three temperatures in series:
//
//   T_pellet[k]   pellet centerline (state.T_fuel — same array, renamed semantically)
//   T_clad[k]     clad outer surface
//   T_coolant[k]  coolant bulk
//
// Series-resistance heat path:
//
//   q_pellet_clad[k]  = (T_pellet[k] - T_clad[k])  / R_pellet      [W per node]
//   q_clad_coolant[k] = (T_clad[k]   - T_coolant[k]) / R_film_eff[k] [W per node]
//
// where (areaPerNode = T.heatTransferAreaM2 / N, h_DB = T.htCoeff/T.heatTransferAreaM2):
//
//   R_pellet      = T.pelletResistanceFraction       / (h_DB · areaPerNode)
//   R_film_DB     = (1 - T.pelletResistanceFraction) / (h_DB · areaPerNode)
//   R_film_eff[k] = R_film_DB / filmEnhancement[k]
//
// At init (state.js startCritical branch): T_clad[k] = T_coolant[k] +
// Q_local·R_film_DB and T_pellet[k] = T_clad[k] + Q_local·R_pellet. By
// construction R_pellet + R_film_DB = N/htCoeff, so T_pellet at init is
// numerically identical to the old lumped-fuel formula — Doppler reference
// temps Tf0Ref are unchanged.
//
// I.3 — Jens-Lottes nucleate boiling (1951, AECU-2627), now using REAL T_clad
// instead of the synthetic film-wall estimate that the original I.3 ship had:
//
//     ΔT_sat,JL = 25 · (q'')^0.25 · exp(-P/6.2)    [°C, q'' in MW/m², P in MPa]
//   inverted:
//     q''_NB = ((T_clad - T_sat) / (25·exp(-P/6.2)))^4 · 1e6   [W/m²]
//
// The boiling-enhanced film coefficient h_NB = q''_NB / (T_clad - T_sat) is
// compared against the single-phase per-area film coefficient
// h_film_DB_per_area = h_DB / (1 - pelletResistanceFraction). The ratio is
// the film enhancement multiplier; clamped at JL_MAX_FILM_ENHANCEMENT (5×)
// to stay inside JL's validity window. A bulk-subcooling weight (1 at
// saturation, 0 at NB_SUBCOOL_LIMIT_K = 30 K subcool) softens the gate.
// Final R_film_eff = R_film_DB / filmEnhancement; T_clad's evolution sees
// this as a reduced clad→coolant resistance.
//
// Why this is now physically clean (vs the pre-refactor I.3 workaround): with
// a real T_clad in state, ΔT_sat,wall = T_clad - T_sat is a directly
// measurable proxy for clad surface temperature minus saturation temperature
// (~95 K typical in PWR upper nodes, well inside JL's validity for subcooled
// NB). The pre-refactor implementation had to invent FILM_RESISTANCE_FRAC =
// 0.3 to estimate a synthetic wall temperature from the single lumped node
// it had access to. That's now retired.
//
// Pressure choice for the JL correlation:
//   - PWR: state.pressurizerP (~15.5 MPa) — primary system pressure.
//   - RBMK: state.sgSecondaryP (~6.5 MPa) — drum = primary in direct cycle.
//   - MSR: JL skipped (single-phase salt at 0.5 MPa, no boiling regime).
//
// Evolution per dt:
//
//   dT_pellet[k]  = (P_local[k] - q_pellet_clad[k])           / (m_pellet_node · c_pellet) · dt
//   dT_clad[k]    = (q_pellet_clad[k] - q_clad_coolant[k])    / (m_clad_node   · c_clad)   · dt
//   dT_coolant[k] = (q_clad_coolant[k] + flow_advection_W[k]) / (m_coolant_node · c_coolant) · dt
//
// flow_advection_W[k] = ṁ · c · (T_coolant[k-1 or T_in] - T_coolant[k]).
// P_local[k] = (P_fission + P_decay) · phi[k] / Σphi.
//
// MSR has fuel-in-coolant — no clad surface, no series stack — and uses the
// legacy single-node update unchanged. T_clad[k] is held at T_coolant[k] for
// safety (so any code that reads T_clad doesn't NaN).
//
// Axial coolant advection is upwind explicit: each node's coolant is replaced
// by the inflow from below at rate (ṁ / m_c_node).
//
// Void fraction: if T_coolant > T_sat at the local pressure, we compute
// equilibrium quality based on enthalpy excess. RBMK direct-cycle uses this.
// This is the BULK void model and is independent of the JL film term — JL
// adds clad-side subcooled boiling enhancement, while the channel-walk
// quality model handles bulk-coolant void after the bulk crosses h_sat.
//
// Decay heat: multi-group exponential fit sourced by fission. Correlation is
// selectable per reactor type via T.decayHeatModel (resolved through
// getDecayHeatCoeffs). Group count is read from the resolved coefficient set
// so a future 23-group fit drops in without further edits. Total decay heat
// is summed and distributed per node by current flux shape.

import { getDecayHeatCoeffs } from '../state.js';
import { stepMultichannel } from './multichannel.js';

// I.3 — bulk subcooling threshold (K) above which the JL nucleate-boiling
// enhancement is fully suppressed. Below this the wall is in the active NB
// regime; above it, single-phase forced convection dominates and bubbles
// recondense too rapidly on the wall to enhance h.
const NB_SUBCOOL_LIMIT_K = 30;
// Maximum film enhancement from the JL term over the single-phase film
// coefficient. Beyond this we'd be entering CHF / DNB territory where JL no
// longer applies — the proper regime transition is the job of I.2 (CHF
// correlations + DNBR). This cap keeps the boiling-augmented film bounded
// until that lands. Now that R_pellet and R_film are resolved separately,
// even a 5× film enhancement only roughly doubles the total fuel→coolant
// conductance (because R_pellet still dominates), preserving stability.
const JL_MAX_FILM_ENHANCEMENT = 5;

export function stepThermal(state, dt) {
  const T = state.T;
  const N = state.N;
  const dz = state.dz;

  // === Per-node fission power distribution from current flux ===
  const totalFissionMW = state.out.fissionPowerMW;
  // Distribute by flux shape
  let fluxSum = 0;
  for (let k = 0; k < N; k++) fluxSum += state.flux[k];
  if (fluxSum <= 0) fluxSum = 1e-12;

  // === Decay heat groups update (semi-implicit) ===
  // dH_i/dt = a_i · P_fission_total - λ_i · H_i
  // Analytical: H_i(t+dt) = H_i e^{-λ_i dt} + (a_i P / λ_i)·(1 - e^{-λ_i dt})
  //
  // Coefficient set is resolved each step from T.decayHeatModel — cheap
  // dictionary lookup and lets scenarios swap the correlation live (e.g.
  // "this run is a SAR conservative calc"). Group count is whatever the
  // resolved model says, and state.decayHeatGroups is sized to match in
  // createState. If those ever disagree we silently truncate to the smaller
  // length rather than corrupt memory.
  const dhCoeffs = getDecayHeatCoeffs(T.decayHeatModel);
  const nGroups = Math.min(dhCoeffs.a.length, state.decayHeatGroups.length);
  let totalDecayHeatW = 0;
  let decayFracEq = 0;
  const Pfis = totalFissionMW * 1e6; // W
  for (let i = 0; i < nGroups; i++) {
    const lam = dhCoeffs.lambda[i];
    const a = dhCoeffs.a[i];
    decayFracEq += a;
    const e = Math.exp(-lam * dt);
    const Hnew = state.decayHeatGroups[i] * e + (a * Pfis / lam) * (1 - e);
    state.decayHeatGroups[i] = Hnew;
    totalDecayHeatW += lam * Hnew; // λ_i · H_i = decay power from group i
  }
  state.out.decayHeatMW = totalDecayHeatW / 1e6;
  const promptThermalW = Math.max(0, Pfis * (1 - decayFracEq));
  const drainFrac = T.primaryTopology === 'msr' ? (state.msrDrainFrac ?? 0) : 0;
  const coreDecayHeatW = totalDecayHeatW * (1 - drainFrac);
  state.out.drainTankDecayHeatMW = totalDecayHeatW * drainFrac / 1e6;
  state.out.totalCorePowerMW = (promptThermalW + coreDecayHeatW) / 1e6;

  // Decay heat distribution: by current flux shape (most of it where the recent fission was)
  // Reasonable for short-time-after-shutdown; for very long after, this slightly mislocates
  // but the integrated effect on each fuel node is what matters.

  // === Per-node thermal step ===
  const mFuelPerNode = T.fuelMassKg / N;
  const mCoolPerNode = T.coolantMassKg / N || 1; // avoid div by 0 for MSR fuel-in-coolant
  const cFuel = T.heatCapFuel;
  const cCool = T.heatCapCoolant;
  // Three-node series-resistance constants. With areaTotal > 0:
  //   R_pellet  = pelletResistanceFraction       / (h_DB · areaPerNode)  [K/W]
  //   R_film_DB = (1 - pelletResistanceFraction) / (h_DB · areaPerNode)  [K/W]
  // The film-only per-area coefficient h_film_DB_per_area = h_DB/(1 - fp) is
  // the JL ratio denominator (used to convert h_NB to a film enhancement).
  const areaTotal = T.heatTransferAreaM2 ?? 0;
  const areaPerNode = areaTotal > 0 ? areaTotal / N : 0;
  const h_DB = areaTotal > 0 ? T.htCoeff / areaTotal : 0;
  const fp = T.pelletResistanceFraction ?? 0.85;
  const R_pellet = areaPerNode > 0 ? fp / (h_DB * areaPerNode) : 0;
  const R_film_DB = areaPerNode > 0 ? (1 - fp) / (h_DB * areaPerNode) : 0;
  const h_film_DB_per_area = (areaPerNode > 0 && (1 - fp) > 0)
    ? h_DB / (1 - fp)
    : 0;
  const m_clad_per_node = (T.cladMassKg ?? 0) / N;
  const c_clad = T.cladHeatCapJPerKgK ?? 330;
  // Legacy lumped coefficient — used only by the MSR fuel-in-coolant branch.
  const hPerNode = T.htCoeff / N;
  // II.3 — Regime-aware primary mass flow from circulation.js. Falls back to
  // the legacy forced-only expression if state.out.flowMassRateKgPerS hasn't
  // been populated yet (defensive — tests that drive stepThermal directly).
  const flowKgPerSec = state.out?.flowMassRateKgPerS
    ?? (T.coolantMassFlowKgPerS * state.coolantFlowFrac);

  // For MSR (fuel-in-coolant), m_coolant per node is 0 — we set the coolant temp to track fuel temp.
  // We'll handle that branch explicitly.
  const isFuelInCoolant = T.primaryTopology === 'msr';

  // Pressure for the JL correlation. PWR uses primary pressure; RBMK direct-
  // cycle uses drum pressure (which is the system pressure). MSR skipped — no
  // boiling in single-phase salt.
  let pressureForJL_MPa = 0;
  if (!isFuelInCoolant) {
    pressureForJL_MPa = T.primaryTopology === 'direct'
      ? (state.sgSecondaryP ?? 0)
      : (state.pressurizerP ?? 0);
  }
  const Tsat_local = pressureForJL_MPa > 0 ? saturationTempK(pressureForJL_MPa) : 0;
  // 25 · exp(-P/6.2), the JL pressure factor. Cached outside the node loop.
  const jlPressFactor = pressureForJL_MPa > 0
    ? 25 * Math.exp(-pressureForJL_MPa / 6.2)
    : 0;

  // Coolant inlet temp (from return loop). For now, slaved to T.coolantInletTempK with
  // a small adjustment based on SG return temperature delta (set in primary.js).
  const Tin = state._coolantReturnT ?? T.coolantInletTempK;

  // Decay heat per node (proportional to flux shape)
  // Use buf, since we will compute new fuel temps in place
  for (let k = 0; k < N; k++) {
    const phi = state.flux[k];
    const localFissionW = promptThermalW * phi / fluxSum;
    const localDecayW = coreDecayHeatW * phi / fluxSum;
    const localPowerW = localFissionW + localDecayW;
    const Tp = state.T_fuel[k];     // pellet centerline
    const Tcl = state.T_clad[k];    // clad outer
    const Tc = state.T_coolant[k];  // coolant bulk

    if (isFuelInCoolant) {
      // Single-phase salt: combined fuel+salt node. Heat goes to intermediate loop via h_eff per node.
      const dT = (localPowerW - hPerNode * (Tp - state.intermediateLoopT)) / (mFuelPerNode * cFuel);
      state.T_fuel[k] = Tp + dT * dt;
      state.T_coolant[k] = state.T_fuel[k]; // tied
      state.T_clad[k] = state.T_coolant[k]; // safety value — no real clad
    } else {
      // Three-node series-resistance stack with optional Jens-Lottes nucleate-
      // boiling enhancement on the film resistance (see header for full
      // derivation). T_clad is a real state variable; ΔT_sat,wall = T_clad
      // - T_sat is the JL kernel argument directly.
      let R_film_eff = R_film_DB;
      if (R_film_DB > 0 && jlPressFactor > 0 && Tcl > Tc) {
        const subcool = Tsat_local - Tc;
        let nbWeight;
        if (subcool <= 0) nbWeight = 1;
        else if (subcool >= NB_SUBCOOL_LIMIT_K) nbWeight = 0;
        else nbWeight = 1 - subcool / NB_SUBCOOL_LIMIT_K;
        if (nbWeight > 0) {
          const dTsat_wall = Tcl - Tsat_local;     // real wall superheat
          if (dTsat_wall > 0) {
            // q''_NB = (ΔT_sat,wall / jlPressFactor)^4 · 1e6 [W/m²]
            // h_NB   = q''_NB / ΔT_sat,wall                   [W/m²/K]
            const q_NB_perArea = Math.pow(dTsat_wall / jlPressFactor, 4) * 1e6;
            const h_NB = q_NB_perArea / dTsat_wall;
            let rawEnhancement = h_NB / Math.max(h_film_DB_per_area, 1e-6);
            if (rawEnhancement > 1) {
              if (rawEnhancement > JL_MAX_FILM_ENHANCEMENT) {
                rawEnhancement = JL_MAX_FILM_ENHANCEMENT;
              }
              const filmEnhancement = 1 + (rawEnhancement - 1) * nbWeight;
              if (filmEnhancement > 1) {
                R_film_eff = R_film_DB / filmEnhancement;
              }
            }
          }
        }
      }
      // Series heat flows (W per node).
      const q_pellet_clad = R_pellet > 0 ? (Tp - Tcl) / R_pellet : 0;
      const q_clad_coolant = R_film_eff > 0 ? (Tcl - Tc) / R_film_eff : 0;

      // Pellet: P_local in - q_pellet_clad out.
      const dTp = (localPowerW - q_pellet_clad) / (mFuelPerNode * cFuel);
      state.T_fuel[k] = Tp + dTp * dt;

      // Clad: q_pellet_clad in - q_clad_coolant out. If cladMassKg is unset
      // (legacy type pack), slave clad to algebraic equilibrium so we don't
      // divide by zero — physics still works, just with no clad thermal lag.
      if (m_clad_per_node > 0 && c_clad > 0) {
        const dTcl = (q_pellet_clad - q_clad_coolant) / (m_clad_per_node * c_clad);
        state.T_clad[k] = Tcl + dTcl * dt;
      } else if (R_film_eff > 0) {
        state.T_clad[k] = Tc + q_clad_coolant * R_film_eff;
      }

      // Coolant: enthalpy balance with axial flow. q_clad_coolant is the
      // node's heat input from cladding (replaces the old lumped h_eff·ΔT).
      const Tbelow = k === 0 ? Tin : state.T_coolant[k - 1];
      const flowDeltaT = (flowKgPerSec * cCool * (Tbelow - Tc)) / (mCoolPerNode * cCool);
      const dTc = (q_clad_coolant / (mCoolPerNode * cCool)) + flowDeltaT;
      state.T_coolant[k] = Tc + dTc * dt;
    }
  }

  // Graphite temperature for RBMK / MSR (lumped, slow)
  if (T.graphiteMassKg) {
    const mGraph = T.graphiteMassKg / N;
    const hGraph = (T.htCoeff * 0.3) / N; // graphite-coolant coupling weaker
    for (let k = 0; k < N; k++) {
      const Tg = state.T_graphite[k];
      const Tref = state.T_coolant[k];
      const dTg = (hGraph * (state.T_fuel[k] - Tg) - hGraph * (Tg - Tref)) / (mGraph * T.heatCapGraphite);
      state.T_graphite[k] = Tg + dTg * dt;
    }
  }

  // Void fraction: direct-cycle (RBMK/BWR). II.7 replaces the original
  // single-channel channel-walk void model with a two-channel parallel-
  // channel TH solver (hot + average channels sharing inlet/outlet plenum
  // pressures via a ΔP-balance bisection). The multichannel module also
  // writes back blended state.T_coolant[k] / state.voidFrac[k] so existing
  // reactivity feedback / axial display / mimic code reads a consistent
  // "core average" view. PWR/MSR are unaffected — the multichannel branch
  // is gated on T.primaryTopology === 'direct' inside stepMultichannel and
  // is a no-op for other topologies.
  if (T.primaryTopology === 'direct') {
    stepMultichannel(state, state.sgSecondaryP, Tin, cCool, Pfis, totalDecayHeatW, fluxSum);
  }
}

// I.8 — Water saturation temperature via the IAPWS-IF97 Region 4 equation
// (physics/steam-tables.js). Single source of truth; the kPa-form Antoine
// duplicate is retired. `tSat` takes MPa, returns K.
import { tSat as saturationTempK } from './steam-tables.js';

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
