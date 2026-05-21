// xenon.js -- iodine-135 / xenon-135 chain per axial node.
//
// dI/dt = γ_I · Σ_f · φ           - λ_I · I
// dX/dt = γ_X · Σ_f · φ + λ_I · I - λ_X · X - σ_X · φ · X
//
// We work in normalized units where I = 1 and X = 1 at full-power equilibrium
// for a non-off-gas reactor. MSR off-gas lowers the equilibrium xenon inventory
// by adding a real removal sink.
// At equilibrium: I_eq · λ_I = γ_I · Σ_f · φ  →  I_eq ∝ φ
//                  X_eq · (λ_X + σ_X·φ) = (γ_I + γ_X) · Σ_f · φ
// So at full-power critical, normalized I and X equal 1 at unit local flux;
// away from unit flux, xenon follows the nonlinear burnout balance.
//
// MSR off-gas: noble fission products (Xe-135 is a noble gas under MSR conditions)
// are continuously stripped at rate state.T.xenonOffGasRateS. This adds a sink
// to the xenon equation.

const LAMBDA_I = 2.876e-5;   // s^-1 (T_1/2 = 6.7 h)
const LAMBDA_X = 2.106e-5;   // s^-1 (T_1/2 = 9.14 h)
// Effective sigma_X · φ at nominal flux normalized such that at equilibrium the
// "burnout" term equals λ_I (yielding I_eq ≈ X_eq at full power).
// Real ratio σ_X·φ/λ_X at full power ≈ 1.6. We bake this in.
const SIGMA_PHI_NOMINAL = 1.6 * LAMBDA_X; // s^-1 per unit normalized flux
const DIRECT_XE_YIELD_FRAC = 0.05;        // γ_X / γ_I, approximate thermal-fission ratio
const X_EQ_NOMINAL = (LAMBDA_I * (1 + DIRECT_XE_YIELD_FRAC))
  / (LAMBDA_X + SIGMA_PHI_NOMINAL);

export function iodineEquilibrium(phi) {
  return Math.max(0, phi);
}

export function xenonEquilibrium(phi, offGas = 0) {
  const p = Math.max(0, phi);
  const sinkX = LAMBDA_X + SIGMA_PHI_NOMINAL * p + Math.max(0, offGas);
  if (!(sinkX > 0)) return 0;
  const sourceActual = LAMBDA_I * (iodineEquilibrium(p) + DIRECT_XE_YIELD_FRAC * p);
  return sourceActual / (X_EQ_NOMINAL * sinkX);
}

export function stepXenon(state, dt) {
  const N = state.N;
  const offGas = state.T.xenonOffGasRateS ?? 0;

  for (let k = 0; k < N; k++) {
    const phi = state.flux[k];
    const I = state.iodine[k];
    const X = state.xenon[k];

    // Sources. I is normalized directly; X is normalized by X_EQ_NOMINAL so
    // X=1 at full-power equilibrium while retaining a small direct Xe yield.
    const srcI = LAMBDA_I * phi;
    const srcX = (LAMBDA_I * (I + DIRECT_XE_YIELD_FRAC * phi)) / X_EQ_NOMINAL;

    const sinkI = LAMBDA_I;
    const sinkX = LAMBDA_X + SIGMA_PHI_NOMINAL * phi + offGas;

    // Semi-implicit (analytical) update on each side
    const eI = Math.exp(-sinkI * dt);
    state.iodine[k] = I * eI + (srcI / sinkI) * (1 - eI);

    const eX = Math.exp(-sinkX * dt);
    state.xenon[k] = X * eX + (srcX / sinkX) * (1 - eX);
  }
}
