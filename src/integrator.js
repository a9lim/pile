// integrator.js -- adaptive RK4 with substep budget control.
//
// We integrate a function `step(state, dt)` rather than building a giant flat
// state vector and a derivative function. Each physics module knows how to
// advance its piece by dt. The integrator handles substep splitting when fast
// dynamics demand smaller dt.

const MAX_SUBSTEPS_PER_FRAME = 256;

export function advanceWithBudget(state, advanceDt, step) {
  // advanceDt is the wall-clock duration of one UI frame × accel.
  // We pick a substep dt small enough that |Δn/n| stays bounded.
  let remaining = advanceDt + (state._simTimeDebt ?? 0);
  const requested = remaining;
  let substeps = 0;

  while (remaining > 0 && substeps < MAX_SUBSTEPS_PER_FRAME) {
    const dt = pickDt(state, remaining);
    step(state, dt);
    remaining -= dt;
    substeps++;
    if (state.scramActive && dt > 0.02) {
      // tighten substepping during scram transient
      continue;
    }
  }
  const advanced = requested - remaining;
  state._lastAdvancedSimDt = advanced;
  state._simTimeDebt = remaining;
  state._substepBudgetExhausted = remaining > 1e-9;
  return substeps;
}

function pickDt(state, remaining) {
  // Heuristic: target |dn/n| < 0.1 per substep.
  // |dn/n| ≈ |ρ - β|/Λ · dt. So dt ≤ 0.1 · Λ / |ρ - β| when |ρ| close to β.
  const rho = state.lastReactivityStack.total;
  const beta = state.T.betaTotal;
  const Lambda = state.T.Lambda;
  // Effective denominator: use max of |rho|, beta_total — period-controlling factor
  const reactivityScale = Math.max(Math.abs(rho), beta);
  const promptDt = 0.1 * Lambda / Math.max(reactivityScale, 1e-6);

  // Thermal time-scale floor (don't substep ridiculously small for slow dynamics)
  const thermalDt = 0.05;

  // Period-based safety: if reactor is running away, want sub-period substeps
  const period = state.out.periodSec;
  const periodDt = Math.abs(period) < 60 ? Math.max(Math.abs(period) / 100, 0.001) : thermalDt;

  let dt = Math.min(promptDt, periodDt);
  // Don't shrink past 0.001 s (1 ms) — that's plenty for prompt-jump tracking
  dt = Math.max(dt, 0.001);
  // Don't grow past 0.5 s — keep thermal feedback stable
  dt = Math.min(dt, 0.5);
  // Don't exceed remaining
  dt = Math.min(dt, remaining);
  return dt;
}

// === Pure RK4 for an N-dim derivative system ===
// f(y, t) -> dy; y and dy are typed arrays of equal length.
// Used by neutronics for the prompt-jump-friendly stiff portion.
export function rk4(y, t, dt, f, scratch) {
  const N = y.length;
  const k1 = scratch.k1, k2 = scratch.k2, k3 = scratch.k3, k4 = scratch.k4, ytmp = scratch.ytmp;
  f(y, t, k1);
  for (let i = 0; i < N; i++) ytmp[i] = y[i] + 0.5 * dt * k1[i];
  f(ytmp, t + 0.5 * dt, k2);
  for (let i = 0; i < N; i++) ytmp[i] = y[i] + 0.5 * dt * k2[i];
  f(ytmp, t + 0.5 * dt, k3);
  for (let i = 0; i < N; i++) ytmp[i] = y[i] + dt * k3[i];
  f(ytmp, t + dt, k4);
  for (let i = 0; i < N; i++) {
    y[i] = y[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
}

export function rk4Scratch(N) {
  return {
    k1: new Float64Array(N),
    k2: new Float64Array(N),
    k3: new Float64Array(N),
    k4: new Float64Array(N),
    ytmp: new Float64Array(N),
  };
}
