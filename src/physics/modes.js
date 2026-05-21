// modes.js — II.4 modal-expansion neutronics (azimuthal + radial first modes).
//
// The 1D axial point-kinetics solver in neutronics.js carries the fundamental
// (zero-th) spatial mode — uniform across radius and azimuth, sin(πz/H) shaped
// in the axial. For wave-3 scenarios (quadrant-tilt, loose-pattern xenon
// oscillations, asymmetric rod insertions) we need the next-higher spatial
// modes too, but a full 2D radial × azimuthal mesh is overkill for the
// pedagogical value. Instead we project the perturbation onto a small basis:
//
//   • 4 azimuthal "quadrant" amplitudes  state.modes.quadrant[0..3]   (NW/NE/SW/SE)
//   • 1 radial "center vs periphery" skew  state.modes.radialSkew     ∈ [-MAX, +MAX]
//
// Each mode evolves as a relaxation ODE driven by an operator-set asymmetry
// command (in pcm of rod / boron asymmetry). The mode lives on top of the
// fundamental — quadrant amplitudes always sum to 4.0 (so total power is
// preserved) and radial skew is centered on zero. At t=0 with zero asymmetry
// commands, all amplitudes are 1.0 and skew is 0.0 (critical-by-construction).
//
// Per substep:
//   target_q[i] = 1 + g_az · ρ_q[i]   (with the 4 targets re-normalized)
//   q[i] += dt/τ_az · (target_q[i] − q[i])
//   then re-normalize so sum(q) = 4   (preserves fundamental power exactly)
//
//   target_skew = clamp(g_rad · ρ_skew, ±MAX)
//   skew += dt/τ_rad · (target_skew − skew)
//
// where ρ_q[i] = state.cmd.quadrantTiltPcm[i] and ρ_skew =
// state.cmd.radialSkewPcm. Per-reactor-type τ_az / τ_rad / g_az / g_rad live
// on T.modes; see reactor-types.js.
//
// Outputs (state.out):
//   azimuthalTilt          (max - min) / mean of the 4 quadrant amplitudes
//                          — operator-facing tilt magnitude
//   quadrantPower[0..3]    quadrant fraction × total fission MW
//                          — for a 4-quadrant power gauge
//   radialSkew             mirrored from state.modes for the gauge layer
//
// The modes are still a compact surrogate rather than a full 2D mesh, but
// they are no longer display-only: the peak azimuthal/radial factor feeds the
// high-flux and DNBR safety calculations through out.modalPeakingFactor.
//
// Per-reactor-type: PWR + RBMK get T.modes; MSR is well-mixed (single point-
// kinetics shape carried via circulating fuel + small core) so T.modes is
// undefined and stepModes early-returns. RBMK has weaker coupling than PWR
// (longer migration length in graphite spreads asymmetric rod-bank insertions
// out across the core); both have longer τ_rad than τ_az because the radial
// first eigenvalue is closer to the fundamental.
//
// Module ordering in sim.js::step:
//   stepNeutronics → stepModes → stepThermal.
// We need the fundamental flux + state.out.fissionPowerMW from neutronics
// (so quadrantPower can multiply against it) and we want quadrantPower
// available before thermal in case a future pass wires it into per-node
// thermal feedback.
//
// References:
//   - Duderstadt & Hamilton, "Nuclear Reactor Analysis" ch. 6-7
//     (modal expansion of the diffusion equation; Helmholtz eigenfunctions
//     of the bare-cylinder geometry).
//   - Lewins, "Importance: The Adjoint Function" ch. 4
//     (per-mode dynamics and the time-constant separation between
//     fundamental and higher modes via ΔB² scaling).
//   - Lamarsh & Baratta, "Introduction to Nuclear Engineering" ch. 5
//     (geometric buckling tables; first-azimuthal eigenvalue separation
//     ≈ 0.05-0.10 for cylindrical PWR cores).

// Maximum permitted radial skew. ±0.3 is plenty wide for a first-mode
// "center vs periphery" indication — a real PWR's radial peaking factor is
// about 1.55 at the design nominal, so a 30% skew on the perturbation
// amplitude is well past the operational envelope.
const RADIAL_SKEW_MAX = 0.3;

// Minimum mean quadrant amplitude, for the tilt-magnitude denominator. The
// re-normalization step below pins the mean at 1.0 by construction, so this
// guard only fires if a future pass leaves the mean non-unit during a
// transient. Documented for future-instance defense.
const TILT_MEAN_FLOOR = 1e-6;

// Default per-mode tunings. Reactor-types.js overrides via T.modes.* but the
// defaults keep this module testable in isolation if a scenario forgets to
// extend the type pack.
const DEFAULTS = Object.freeze({
  tauAzSec: 120,
  tauRadSec: 300,
  // Gain in (fractional amplitude) per (pcm of asymmetry command). 5e-4
  // means ±200 pcm of asymmetry → ±10% steady-state quadrant tilt, which is
  // the operationally-relevant magnitude (PWR Tech Spec QPTR limit is 1.02
  // ≈ 2% tilt for normal ops; we expose it loose enough for scenarios).
  gainAz: 5e-4,
  gainRad: 5e-4,
});

/**
 * Allocate state.modes for a reactor type that defines T.modes.
 * Returns null for types without modal-expansion config (MSR).
 *
 * Called from state.js::createState and on reactor-type swap. The per-axial-
 * mode amplitudes start uniform (1.0 each, sum 4.0) and the radial skew at 0
 * — critical-by-construction matches the documented invariant for the rest
 * of the sim.
 *
 * @param {object} T  reactor-type config from reactor-types.js
 * @returns {object|null}
 */
export function createModesState(T) {
  if (!T || !T.modes) return null;
  const quadrant = new Float64Array(4);
  for (let i = 0; i < 4; i++) quadrant[i] = 1.0;
  return {
    quadrant,
    radialSkew: 0,
  };
}

/**
 * Modal-expansion update. Reads state.cmd.quadrantTiltPcm[0..3] and
 * state.cmd.radialSkewPcm; writes state.modes.quadrant[0..3] and
 * state.modes.radialSkew. Populates state.out.azimuthalTilt,
 * state.out.quadrantPower[0..3], and state.out.radialSkew.
 *
 * No-op for reactor types without T.modes (MSR).
 *
 * @param {object} state
 * @param {number} dt sim seconds
 */
export function stepModes(state, dt) {
  const T = state.T;
  if (!T || !T.modes) return;
  const modes = state.modes;
  if (!modes) return; // defensive — state.js builds this when T.modes exists

  const cfg = T.modes;
  const tauAz = cfg.tauAzSec ?? DEFAULTS.tauAzSec;
  const tauRad = cfg.tauRadSec ?? DEFAULTS.tauRadSec;
  const gainAz = cfg.gainAz ?? DEFAULTS.gainAz;
  const gainRad = cfg.gainRad ?? DEFAULTS.gainRad;

  // Pull asymmetry commands. Defaults to zero when scenario / UI hasn't
  // touched them, preserving critical-by-construction.
  const tiltCmd = state.cmd.quadrantTiltPcm;
  const skewCmd = state.cmd.radialSkewPcm ?? 0;

  // ============================================================
  // 1. Azimuthal first mode — 4 quadrant amplitudes
  // ============================================================
  // Build the per-quadrant target. mean(target) = 1 by construction whenever
  // mean(ρ_q) = 0; we don't enforce that on the command side (operator can
  // bias all four quadrants positive at once and we'll renormalize), so we
  // explicitly subtract the target mean before applying the gain so that
  // bulk reactivity moves stay in the fundamental and only the tilt hits
  // the modal amplitudes.
  let cmdMean = 0;
  for (let i = 0; i < 4; i++) {
    const c = (tiltCmd && Number.isFinite(tiltCmd[i])) ? tiltCmd[i] : 0;
    cmdMean += c;
  }
  cmdMean *= 0.25;

  // Apply the relaxation update.
  // dt/τ explicit-Euler is fine because τ_az ≫ substep dt in any practical
  // accel bucket (substeps land in the milliseconds-to-seconds range; τ is
  // 100s+). For the same reason we don't bother with the analytical
  // exp(-dt/τ) form here.
  const stepAz = Math.min(1, dt / tauAz);
  for (let i = 0; i < 4; i++) {
    const cmdI = (tiltCmd && Number.isFinite(tiltCmd[i])) ? tiltCmd[i] : 0;
    const target = 1 + gainAz * (cmdI - cmdMean);
    const cur = modes.quadrant[i];
    let next = cur + stepAz * (target - cur);
    if (!Number.isFinite(next) || next < 0) next = 0;
    modes.quadrant[i] = next;
  }

  // Re-normalize so sum(q) = 4 exactly. Preserves fundamental power. If the
  // step pushed the sum away from 4 due to asymmetric clipping, this folds
  // the leakage back into the mean; the tilt shape is preserved because
  // each amplitude is rescaled by the same factor.
  let sumQ = 0;
  for (let i = 0; i < 4; i++) sumQ += modes.quadrant[i];
  if (sumQ > TILT_MEAN_FLOOR) {
    const scale = 4 / sumQ;
    for (let i = 0; i < 4; i++) modes.quadrant[i] *= scale;
  } else {
    // Total amplitude collapsed (shouldn't happen — guarded above) — reset
    // to the uniform shape rather than carry NaN through to the gauge layer.
    for (let i = 0; i < 4; i++) modes.quadrant[i] = 1.0;
  }

  // ============================================================
  // 2. Radial first mode — center-vs-periphery skew
  // ============================================================
  // Single scalar; same relaxation form. Clamp to ±RADIAL_SKEW_MAX so a
  // wildly large operator command can't push the gauge into a negative-
  // periphery-power regime (which would be physically meaningless until we
  // actually split the 1D state radially).
  const skewTargetRaw = gainRad * skewCmd;
  const skewTarget = skewTargetRaw > RADIAL_SKEW_MAX ? RADIAL_SKEW_MAX
    : (skewTargetRaw < -RADIAL_SKEW_MAX ? -RADIAL_SKEW_MAX : skewTargetRaw);
  const stepRad = Math.min(1, dt / tauRad);
  let nextSkew = modes.radialSkew + stepRad * (skewTarget - modes.radialSkew);
  if (!Number.isFinite(nextSkew)) nextSkew = 0;
  if (nextSkew > RADIAL_SKEW_MAX) nextSkew = RADIAL_SKEW_MAX;
  else if (nextSkew < -RADIAL_SKEW_MAX) nextSkew = -RADIAL_SKEW_MAX;
  modes.radialSkew = nextSkew;

  // ============================================================
  // 3. Output diagnostics
  // ============================================================
  const out = state.out;
  // Tilt magnitude: (max - min) / mean. Mean is 1 by construction (re-
  // normalized above) but we recompute defensively. Equivalent to the QPTR
  // (quadrant power tilt ratio) operator gauge minus 1 in the symmetric-tilt
  // limit; full QPTR ratio differs because it conventionally divides max by
  // average rather than range/average.
  let qMin = modes.quadrant[0];
  let qMax = modes.quadrant[0];
  let qSum = modes.quadrant[0];
  for (let i = 1; i < 4; i++) {
    const v = modes.quadrant[i];
    if (v < qMin) qMin = v;
    if (v > qMax) qMax = v;
    qSum += v;
  }
  const qMean = qSum / 4;
  out.azimuthalTilt = qMean > TILT_MEAN_FLOOR ? (qMax - qMin) / qMean : 0;
  out.radialSkew = modes.radialSkew;
  out.modalPeakingFactor = (qMean > TILT_MEAN_FLOOR ? qMax / qMean : 1)
    * (1 + Math.abs(modes.radialSkew));
  out.localPowerPeakFrac = ((out.fissionPowerMW ?? 0) / Math.max(state.T.nominalPowerMWth, 1))
    * out.modalPeakingFactor;

  // Per-quadrant absolute power (MWth). Each quadrant sees its amplitude /
  // 4 of the total fission power — fundamental power × shape factor.
  // Allocate the output array on first call.
  if (!out.quadrantPower || out.quadrantPower.length !== 4) {
    out.quadrantPower = new Float64Array(4);
  }
  const fissionMW = out.fissionPowerMW ?? 0;
  for (let i = 0; i < 4; i++) {
    out.quadrantPower[i] = fissionMW * modes.quadrant[i] * 0.25;
  }
}
