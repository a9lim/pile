// autopilot.js -- automatic regulating-rod controller.
//
// Drives `state.rodBanks.regulating` to hold reactor power at
// `state.autoRod.powerSetpoint` (fraction of nominal) while keeping
// reactivity near zero. Models the LAR (Local Automatic Regulator) on RBMK,
// the regulating rod on MSRE, and a simple "rod-bank-on-auto" mode on PWR.
//
// Design:
//   ρ_demand_pcm = -K_rho · ρ_current_pcm - K_pow · (power_frac - setpoint)
//   rod_delta    = -ρ_demand_pcm / rodWorthPcmTotal           (insertion ↑ → ρ ↓)
//   rate-limited at T.rodSpeed · servoMultiplier              (LAR ~ 3× manual drive)
//
// The controller writes to BOTH `state.rodBanks.regulating` (direct, so the
// effect lands on this step's neutronics) AND `state.cmd.regulatingTarget`
// (so the UI slider mirrors the controller's commanded position when AUTO
// is selected). stepRps's drive-toward-target then becomes a no-op for rods
// because cmd == current.
//
// Hands off entirely when scram is active (rps.js drives rods in at scramSpeed).
// On scram, the autopilot is also automatically disabled so it doesn't try to
// pull rods back out the moment the user clicks "Reset" — they must re-arm.
//
// Per-reactor-type tuning lives on `state.autoRod` so it's per-instance and
// can be hot-swapped with the rest of state on reactor-type change.

export function stepAutopilot(state, dt) {
  if (state.scramActive) return;
  const ar = state.autoRod;
  if (!ar || !ar.enabled) return;

  const T = state.T;
  const rhoPcm = state.out.reactivityPcm;
  const powerFrac = state.out.fissionPowerMW / T.nominalPowerMWth;
  const powerErr = powerFrac - ar.powerSetpoint;

  // I.5 — PWR Tave program coupling. When the reactor type has a Tave
  // program (PWR — RBMK/MSR don't), add a Tavg-error term: positive Tavg_err
  // (actual hotter than program) demands negative ρ → insert rod → lower
  // power → Tavg drops. Matches Westinghouse "Tave-controlled" rod logic.
  // Other reactor types fall through with zero contribution.
  let tavgErrK = 0;
  if (state.out.tAvgProgramK !== null && state.out.tAvgProgramK !== undefined &&
      state.out.tAvgK !== undefined && (ar.gainTavg ?? 0) !== 0) {
    tavgErrK = state.out.tAvgK - state.out.tAvgProgramK;
  }

  // Composite demand: zero out current ρ, plus a stiffness term that biases ρ
  // toward driving power back to setpoint, plus Tavg-program tracking on
  // reactor types that have one. All contributions live in pcm. Clamped to
  // ±200 pcm to keep the P-controller from oscillating against a fast-Doppler
  // core (MSR's -110 pcm/K coefficient closes a 200 pcm gap in <2K of fuel
  // heating — anything bigger overshoots).
  let rhoDemandPcm =
    -ar.gainRho * rhoPcm
    - ar.gainPower * powerErr
    - (ar.gainTavg ?? 0) * tavgErrK;
  if (rhoDemandPcm > 200) rhoDemandPcm = 200;
  else if (rhoDemandPcm < -200) rhoDemandPcm = -200;

  // Translate demanded ρ change to rod position change. Inserting more rod
  // pushes ρ down: dρ/d(rodFrac) ≈ -rodWorthPcmTotal averaged across the core.
  // So rod_delta = -ρ_demand / rodWorth (positive demand wants positive ρ
  // change, i.e. withdraw rod).
  const rodWorth = Math.max(T.rodWorthPcmTotal, 1);
  let rodDelta = -rhoDemandPcm / rodWorth;

  // Rate limit. Servo multiplier represents the LAR/regulating-rod drive
  // being faster than the manual shim/bank drive on real plants.
  const maxRate = T.rodSpeed * (ar.servoMultiplier ?? 3);
  const cap = maxRate * dt;
  if (rodDelta > cap) rodDelta = cap;
  else if (rodDelta < -cap) rodDelta = -cap;

  let newPos = state.rodBanks.regulating + rodDelta;
  if (newPos < 0) newPos = 0;
  else if (newPos > 1) newPos = 1;

  state.rodBanks.regulating = newPos;
  state.cmd.regulatingTarget = newPos;

  // Diagnostic: expose the controller's demand for UI display.
  ar.lastRhoDemandPcm = rhoDemandPcm;
}

// Toggle autopilot on/off. When turning OFF (manual mode), the user's slider
// value (cmd.regulatingTarget) takes over via the normal stepRps drive.
export function setAutoRod(state, enabled) {
  if (!state.autoRod) return;
  state.autoRod.enabled = !!enabled;
}

// Set the power setpoint (fraction of nominal). Clamped to [0.01, 1.1].
export function setAutoRodSetpoint(state, frac) {
  if (!state.autoRod) return;
  if (!Number.isFinite(frac)) return;
  if (frac < 0.01) frac = 0.01;
  else if (frac > 1.1) frac = 1.1;
  state.autoRod.powerSetpoint = frac;
}
