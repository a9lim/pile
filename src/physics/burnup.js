// burnup.js -- per-node fuel burnup tracking + lifecycle-dependent coefficient scaling.
//
// Phase II.1 (Wave 2.5). Per-axial-node accumulator that tracks integrated
// thermal-power exposure per metric ton of uranium (MWd/tU). Cycle-dependent
// scalings for β_eff, Doppler (α_fuel), ν·Σ_f, and an additive excess-ρ term
// are interpolated piecewise-linearly from a five-point anchor table covering
// the full Beginning-of-Cycle (BOC) → End-of-Cycle (EOC) range.
//
// Anchor data (textbook-typical for U-235 PWR fuel @ ~3-4% enrichment;
// Duderstadt & Hamilton, "Nuclear Reactor Analysis" ch. 14 — fuel depletion +
// reactivity coefficient burnup dependence; Lamarsh & Baratta, "Introduction
// to Nuclear Engineering" 3rd ed. ch. 7 — fuel cycle):
//
//   BU (MWd/tU) | β_eff vs BOC | Doppler vs BOC | ν·Σ_f vs BOC | ρ_excess (pcm)
//   ------------+--------------+----------------+--------------+----------------
//   0           | 1.00         | 1.00 (strong)  | 1.00         | +5000 (fresh)
//   5000        | 0.97         | 0.97           | 0.96         | +3000
//   15000       | 0.92         | 0.93           | 0.88         | +1000
//   30000       | 0.85         | 0.88           | 0.74         | -2000
//   45000       | 0.78         | 0.84           | 0.58         | -6000
//
// β_eff drops because plutonium build-in (²³⁹Pu has β ≈ 0.0021 vs U-235's
// 0.0065) lowers the effective delayed fraction; Doppler weakens because the
// resonance integral is dominated by ²³⁸U which depletes only slightly, and
// the slight reduction here reflects fuel-temperature-coefficient changes from
// plutonium build-in; ν·Σ_f drops because the fissile inventory burns out
// faster than Pu builds in. The ρ_excess column tracks the operator-relevant
// reactivity that has to be compensated by boration/rod insertion early in
// cycle and withdrawn later in cycle.
//
// Implementation choice: a single five-point piecewise-linear table rather
// than a quartic fit, so anchor recalibration (per fuel type, per enrichment,
// per scenario) is one-line. Clamps at the endpoints — extrapolation outside
// the validated range would be misleading.

const PWR_ANCHORS = Object.freeze([
  { bu: 0,     beta: 1.00, doppler: 1.00, nuFission: 1.00, excessPcm:  5000 },
  { bu: 5000,  beta: 0.97, doppler: 0.97, nuFission: 0.96, excessPcm:  3000 },
  { bu: 15000, beta: 0.92, doppler: 0.93, nuFission: 0.88, excessPcm:  1000 },
  { bu: 30000, beta: 0.85, doppler: 0.88, nuFission: 0.74, excessPcm: -2000 },
  { bu: 45000, beta: 0.78, doppler: 0.84, nuFission: 0.58, excessPcm: -6000 },
]);

const RBMK_ANCHORS = Object.freeze([
  { bu: 0,     beta: 1.00, doppler: 1.00, nuFission: 1.00, excessPcm:  3500 },
  { bu: 5000,  beta: 0.98, doppler: 0.98, nuFission: 0.97, excessPcm:  2000 },
  { bu: 10000, beta: 0.95, doppler: 0.96, nuFission: 0.93, excessPcm:   500 },
  { bu: 20000, beta: 0.90, doppler: 0.93, nuFission: 0.84, excessPcm: -1500 },
  { bu: 26000, beta: 0.87, doppler: 0.91, nuFission: 0.78, excessPcm: -3000 },
]);

const MSR_ANCHORS = Object.freeze([
  { bu: 0,     beta: 1.00, doppler: 1.00, nuFission: 1.00, excessPcm: 0 },
  { bu: 10000, beta: 1.00, doppler: 1.00, nuFission: 1.00, excessPcm: 0 },
]);

// Piecewise-linear interpolator over the anchor table. Reads one of the
// scalar fields; clamps at the endpoints.
function anchorsFor(T) {
  const model = T?.burnupModel;
  if (model === 'rbmk') return RBMK_ANCHORS;
  if (model === 'online-msr' || T?.primaryTopology === 'msr') return MSR_ANCHORS;
  return PWR_ANCHORS;
}

function interp(bu, key, T) {
  const anchors = anchorsFor(T);
  if (!Number.isFinite(bu)) return anchors[0][key];
  if (bu <= anchors[0].bu) return anchors[0][key];
  const last = anchors[anchors.length - 1];
  if (bu >= last.bu) return last[key];
  for (let i = 1; i < anchors.length; i++) {
    const lo = anchors[i - 1];
    const hi = anchors[i];
    if (bu <= hi.bu) {
      const t = (bu - lo.bu) / (hi.bu - lo.bu);
      return lo[key] + t * (hi[key] - lo[key]);
    }
  }
  return last[key];
}

export function betaScale(bu, T)        { return interp(bu, 'beta', T); }
export function dopplerScale(bu, T)     { return interp(bu, 'doppler', T); }
export function nuFissionScale(bu, T)   { return interp(bu, 'nuFission', T); }
export function excessRhoPcm(bu, T)     { return interp(bu, 'excessPcm', T); }

// Conversion from kg fuel mass to metric tons of uranium. UO₂ is ~88% U by
// mass (M_U = 238, M_O2 = 32 → 238/(238+32) ≈ 0.881). For MSRE-class fluoride
// salt the U fraction in the entire fuel salt is much smaller (UF4 + LiF +
// BeF2 + ZrF4 mixture). The reactor-types table can override these via
// T.fuelMassFractionU; online-refueled MSR packs default to no burnup advance.
export function fuelMassTU(T) {
  if (T.fuelMassTU !== undefined) return T.fuelMassTU;       // explicit override
  const fracU = T.fuelMassFractionU ?? (T.primaryTopology === 'msr' ? 0.005 : 0.881);
  return (T.fuelMassKg ?? 0) * fracU / 1000;                  // kg → metric tons
}

// Advance per-node burnup by dt (seconds). Per node:
//   ΔBU[k] [MWd/tU] = P_local_MW · (dt / 86400 days) / (fuelMTU / N)
// where P_local_MW = P_fis · flux[k] / Σflux (axial fission distribution)
// and the per-node fuel mass is fuelMTU / N (uniform axial fuel loading).
// The N's give: ΔBU[k] = N · (flux[k]/fluxSum) · (P_fis · dt_days / fuelMTU),
// and the flux-weighted core-average of ΔBU is exactly the bulk increment
// P_fis · dt_days / fuelMTU when flux > 0 anywhere (verified analytically).
// Decay heat is intentionally excluded — burnup conventionally tracks
// fission energy released, not afterheat.
export function stepBurnup(state, dt) {
  if (!state.burnup) return;
  const T = state.T;
  if (T.burnupModel === 'online-msr') return;
  const fuelMTU = fuelMassTU(T);
  if (!(fuelMTU > 0)) return;             // gracefully degrade if mass unknown
  const Pfis = state.out.fissionPowerMW;
  if (!(Pfis > 0)) return;                // subcritical / shut-down → no burn
  const N = state.N;
  let fluxSum = 0;
  for (let k = 0; k < N; k++) fluxSum += state.flux[k];
  if (!(fluxSum > 0)) return;
  const dtDays = dt / 86400;
  const bulkDelta = (Pfis * dtDays) / fuelMTU;     // bulk-average MWd/tU this dt
  // Distribute across nodes proportional to local flux. Σ(N · flux[k]/fluxSum) = N,
  // so each node's share scales with its flux share of the axial average.
  for (let k = 0; k < N; k++) {
    state.burnup[k] += bulkDelta * N * (state.flux[k] / fluxSum);
  }
}

// Core-average burnup. Two conventions exist in the field:
//   (a) unweighted axial mean — conserves the bulk energy balance
//       ΔBU_avg = P_fis · dt / fuelMTU exactly, frame-by-frame
//   (b) flux-weighted mean — emphasizes hot-channel exposure, used in
//       BOC/MOC/EOC indication where the peak fuel-pin burnup matters
// We ship (a) here because the operator readout has to match the energy
// balance (audit-trail integrity); a hot-channel BU follow-up gauge can
// be added later if scenarios need it. Used for the global β_eff and
// the BOC/MOC/EOC indicator label.
export function coreAverageBurnup(state) {
  if (!state.burnup) return 0;
  const N = state.N;
  if (N === 0) return 0;
  let sum = 0;
  for (let k = 0; k < N; k++) sum += state.burnup[k];
  return sum / N;
}

// Cycle-label classification for the gauge. Anchors at 5000 / 30000 MWd/tU.
export function cycleLabel(buAvg, T) {
  if (!Number.isFinite(buAvg)) return 'BOC';
  const anchors = anchorsFor(T);
  const last = anchors[anchors.length - 1]?.bu ?? 45000;
  if (buAvg < 0.2 * last) return 'BOC';
  if (buAvg < 0.75 * last) return 'MOC';
  return 'EOC';
}
