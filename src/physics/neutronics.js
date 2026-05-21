// neutronics.js -- 1D axial point-kinetics with six delayed-neutron precursor
// groups per node, axial diffusion coupling, and per-node reactivity feedback.
//
// Integration scheme: SEMI-ANALYTICAL per-node update.
// For each substep, treating reactivity ρ_k and precursor source as locally
// constant, the per-node flux and precursor equations have closed-form solutions.
// Unconditionally stable for any dt — does not suffer the explicit-RK4 stiffness
// blowup at the Λ/β prompt time scale.
//
// Per node k:
//   dn_k/dt = α_k · n_k + S_k
//   α_k     = (ρ_k − β)/Λ − 2D/dz²            (prompt + diffusion-loss-to-neighbors)
//   S_k     = Σ_g λ_g C_{g,k} + (D/dz²)·(n_{k−1} + n_{k+1})  (delayed + diffusion-from-neighbors)
//   ⇒ n_k(t+dt) = n_k·e^(α_k·dt) + (S_k/α_k)·(e^(α_k·dt) − 1)
//
// Per group g, per node k:
//   dC/dt = (β_g/Λ)·n − λ_g·C  + advection (MSR only)
//   ⇒ C(t+dt) = C·e^(−λ_g·dt) + (β_g·n_avg/(Λ·λ_g))·(1 − e^(−λ_g·dt))
// Where n_avg is the trapezoidal mean of n_k(t) and n_k(t+dt) for accuracy.
//
// We snapshot n_old at the start of the substep so that the diffusion coupling
// uses time-consistent neighbor values across all nodes.

import { betaScale, dopplerScale, excessRhoPcm, coreAverageBurnup, nuFissionScale } from './burnup.js';

let RHO_BUF = null;
let N_OLD_BUF = null;

export function stepNeutronics(state, dt) {
  const N = state.N;
  const T = state.T;
  const Lambda = T.Lambda;
  const betas = T.beta;
  const lambdas = T.lambda;
  // II.1 — β_eff drops with burnup (plutonium build-in lowers the effective
  // delayed-fraction). For self-consistency we scale BOTH the prompt-α
  // subtraction (ρ - β)/Λ AND the per-group precursor source (β_g/Λ)·n by
  // the same core-average factor. Per-group λ_g decays stay unscaled (the
  // delayed spectrum shape doesn't shift meaningfully with burnup; only the
  // total fraction does). A scenario at EOC has β_eff ~0.0051 vs BOC's ~0.0065.
  // Without this co-scaling, equilibrium precursors and the prompt equation
  // disagree by O(few hundred pcm) at init — critical-by-construction fails.
  const buAvg = state.burnup ? coreAverageBurnup(state) : 0;
  const betaScaleAvg = betaScale(buAvg, T);
  const betaTotal = T.betaTotal * betaScaleAvg;
  const D = T.Dz;
  const dz = state.dz;

  if (!RHO_BUF || RHO_BUF.length !== N) {
    RHO_BUF = new Float64Array(N);
    N_OLD_BUF = new Float64Array(N);
  }

  computePerNodeReactivity(state, RHO_BUF);

  const dz2 = dz * dz;
  const Ddz2 = D / dz2;
  const advU = T.circulatingPrecursors ? coreFlowVelocity(state) : 0;

  // Snapshot n at substep start for time-consistent diffusion coupling
  for (let k = 0; k < N; k++) N_OLD_BUF[k] = state.flux[k];

  // Precompute per-group exponential decay over dt (independent of node)
  const eLambda = new Array(6);
  for (let g = 0; g < 6; g++) eLambda[g] = Math.exp(-lambdas[g] * dt);

  // === II.8 — Photoneutron source ===
  // The D(γ,n)¹H reaction (E_γ > 2.225 MeV) on light water — and Be(γ,n) on
  // graphite trace Be-9 / on FLiBe explicitly — converts a small fraction of
  // fission-product decay gammas into neutrons. We lump the full coupling
  // (photon spectrum × cross section × moderator areal density) into a
  // single dimensionless yield per reactor type and tie the source to current
  // decay-heat power. Distributed by current flux shape (matches the
  // thermal.js convention for the decay-heat axial profile — gamma emitters
  // are distributed roughly by historical flux, and the current flux shape
  // is a fine first approximation at the timescales the SR detector cares
  // about).
  //
  // Units: state.flux[k] is dimensionless flux normalized so n=1 ↔ nominal
  // power. The S terms in the analytical update have units of [1/s] (rate of
  // change of n). At full-power steady state the precursor source per node
  // is Σ_g (β_g/Λ)·n ≈ (β_total/Λ) ≈ O(300) per second. The photoneutron
  // source has the same units; we set it to
  //   S_photo_total = T.photoneutronYield · decayFrac · (β_total/Λ)
  //   S_photo[k]    = S_photo_total · flux_shape[k]
  // so the dimensionless "yield" is fraction-of-nominal-birth-rate per
  // fraction-of-nominal-decay-heat. Deep-subcritical floor: α_k ≈ -β/Λ,
  // n_floor[k] ≈ S_photo[k] / |α_k| ≈ yield · decayFrac · flux_shape[k].
  // For PWR (yield 2.5e-4, decayFrac ≈ 0.05 at 1 h post-scram) this is
  // ≈ 1.3e-5 of nominal — the documented SR-floor target.
  const photoYield = T.photoneutronYield ?? 0;
  const decayHeatMW = state.out?.decayHeatMW ?? 0;
  const nominalMW = T.nominalPowerMWth || 1;
  const decayFrac = Math.max(0, decayHeatMW / nominalMW);
  let fluxShapeSum = 0;
  for (let k = 0; k < N; k++) fluxShapeSum += N_OLD_BUF[k];
  if (fluxShapeSum <= 1e-30) fluxShapeSum = 1e-30;
  // The total normalized source rate (averaged across nodes after the
  // flux-shape weighting) is yield · decayFrac · (β/Λ). Exposed as a
  // diagnostic for the optional UI gauge / scripted scenarios.
  const photoTotalNps = photoYield * decayFrac * (betaTotal / Lambda);
  state.out.photoneutronSourceNps = photoTotalNps;

  // === Per-node analytical flux update ===
  for (let k = 0; k < N; k++) {
    const nOld = N_OLD_BUF[k];
    const rhoK = RHO_BUF[k];

    // Delayed neutron source (uses precursors at start of substep)
    let delayed = 0;
    for (let g = 0; g < 6; g++) delayed += lambdas[g] * state.precursors[g][k];

    // Diffusion neighbors (reflective BC at top and bottom)
    const nL = k === 0     ? nOld : N_OLD_BUF[k - 1];
    const nR = k === N - 1 ? nOld : N_OLD_BUF[k + 1];

    // Photoneutron source per node (see header). At init this contributes a
    // small bias to the equilibrium (a few pcm — documented in HANDOFF.md);
    // post-scram it's what keeps the SR detector reading above its floor.
    // The shape weighting follows current flux — a degenerate case (all zero
    // flux during a hard cold-shutdown) leaves the source at zero, which is
    // acceptable because a true cold core has neither decay heat nor flux.
    const photoSrc = photoTotalNps * (N * N_OLD_BUF[k] / fluxShapeSum);

    const alpha = (rhoK - betaTotal) / Lambda - 2 * Ddz2;
    const S = delayed + Ddz2 * (nL + nR) + photoSrc;

    // n(t+dt) = n·e^(α·dt) + (S/α)·(e^(α·dt) − 1)
    // Edge case: |α·dt| very small → use Taylor series to avoid 0/0
    let nNew;
    const adt = alpha * dt;
    if (Math.abs(adt) < 1e-8) {
      nNew = nOld + (alpha * nOld + S) * dt;
    } else {
      const eA = Math.exp(adt);
      nNew = nOld * eA + (S / alpha) * (eA - 1);
    }
    if (!Number.isFinite(nNew)) nNew = 0;
    if (nNew < 0) nNew = 0;
    state.flux[k] = nNew;
  }

  // === Per-group, per-node analytical precursor update ===
  // Use trapezoidal-mean n for source: averages n_old and n_new
  for (let g = 0; g < 6; g++) {
    const bg = betas[g] * betaScaleAvg;   // II.1: co-scale per-group β with the prompt-α subtraction
    const lg = lambdas[g];
    const eL = eLambda[g];
    const C = state.precursors[g];
    for (let k = 0; k < N; k++) {
      const nMean = 0.5 * (N_OLD_BUF[k] + state.flux[k]);
      const srcEq = (bg / (Lambda * lg)) * nMean;   // C_eq if n held at nMean
      let cNew = C[k] * eL + srcEq * (1 - eL);

      // MSR precursor advection (upwind, explicit on top of analytical decay)
      if (advU > 0) {
        const CkM1 = k === 0 ? msrInletPrecursor(state, g) : C[k - 1];
        cNew += (-advU * (cNew - CkM1) / dz) * dt;
      }
      if (!Number.isFinite(cNew) || cNew < 0) cNew = 0;
      C[k] = cNew;
    }
  }

  // MSR precursor loop: push top-of-core values into the delay buffer
  if (T.circulatingPrecursors) {
    updateMsrPrecursorLoop(state, dt);
  }

  // Update output diagnostics
  let totalFlux = 0;
  for (let k = 0; k < N; k++) totalFlux += state.flux[k];
  const avgFlux = totalFlux / N;

  // Fission power = flux × nominal-power-per-unit-flux, with the advertised
  // burnup-dependent νΣf scaling applied relative to the loaded initial fuel.
  const fissNow = nuFissionScale(buAvg, T);
  const fissInit = nuFissionScale(T.initialBurnupMWdPerTU ?? 0, T);
  const fissScale = fissInit > 0 ? fissNow / fissInit : 1;
  state.out.fissionPowerMW = avgFlux * T.nominalPowerMWth * fissScale;

  // Period: dn/n / dt. Use the change in avgFlux over this step.
  if (state.out._prevAvgFlux === undefined || state.out._prevAvgFlux <= 0) {
    state.out.periodSec = Infinity;
  } else if (avgFlux <= 0) {
    state.out.periodSec = Infinity;
  } else {
    const d = Math.log(avgFlux / state.out._prevAvgFlux);
    if (Math.abs(d) < 1e-9) state.out.periodSec = Infinity;
    else state.out.periodSec = dt / d;
  }
  state.out._prevAvgFlux = avgFlux;
}

// === Per-node reactivity (in fractional units, not pcm) ===
//
// ρ_k = ρ_rod_k + ρ_boron + α_f·(T_f - T_f0) + α_m·(T_mod - T_mod0) + α_void·v_k + ρ_xenon_k
//
// Reference temperatures are the nominal full-power values; we treat the equilibrium
// state as critical at ρ_total = 0, so feedbacks integrate from there.
export function computePerNodeReactivity(state, out) {
  const T = state.T;
  const N = state.N;
  const rod = state.rodBanks.regulating;
  const safety = state.rodBanks.safety;
  const rodTotalWorth = -(T.rodWorthPcmTotal * 1e-5); // negative = absorbing
  // Boron only applies to PWR; RBMK and MSR have no soluble boron control.
  const boronInit = T.boronInitialPpm ?? 0;
  const boronWorth = T.boronWorthPcmPerPpm ?? 0;
  const boronRho = (state.boronPpm - boronInit) * boronWorth * 1e-5;

  // Per-node reference temps (Float64Array)
  const Tf0Arr = state.Tf0Ref;

  const alphaVoidIsFunc = typeof T.alphaVoid === 'function';
  const powerFrac = state.out.fissionPowerMW / T.nominalPowerMWth;
  const rodRhoInit = state.rodRhoInit;
  // II.1 — Burnup-dependent feedback. Doppler weakens slightly with depletion
  // (plutonium build-in shifts the resonance integral); excess ρ tracks the
  // depletion-of-fissile-inventory effect relative to the loaded initial state.
  const burnupArr = state.burnup;
  const burnupRhoInit = state.burnupRhoInit;

  for (let k = 0; k < N; k++) {
    const wReg = T.rodWorth(k, N, rod);
    const wSaf = T.rodWorth(k, N, safety);
    // Rod contribution is RELATIVE to the initial rod position — the per-node
    // reference (rodRhoInit) is subtracted so the documented initial state is
    // critical by construction even when initialRodFrac != 0.
    const rodRho = rodTotalWorth * (wReg + wSaf) - (rodRhoInit ? rodRhoInit[k] : 0);
    const buK = burnupArr ? burnupArr[k] : 0;
    const dopScale = burnupArr ? dopplerScale(buK, T) : 1;
    const dopplerRho = T.alphaFuel * dopScale * (state.T_fuel[k] - Tf0Arr[k]);
    const moderatorRho = moderatorFeedbackRho(state, k);
    const aVoid = alphaVoidIsFunc ? T.alphaVoid(powerFrac) : T.alphaVoid;
    const voidRho = aVoid * state.voidFrac[k] - (state.voidRhoInit ? state.voidRhoInit[k] : 0);
    // Xenon: equilibrium at full power = ρ_x,eq ≈ -2800 pcm. Scale stored xenon (~1 at eq) by this.
    const xenonWorth = (T.xenonWorthPcmAtEq ?? -2800) * 1e-5;
    const xenonRho = xenonWorth * state.xenon[k] - (state.xenonRhoInit ? state.xenonRhoInit[k] : 0);
    // II.1 — Burnup excess-ρ contribution relative to the loaded initial state.
    // Same critical-by-construction trick as rodRhoInit: at t=0 the live value
    // equals burnupRhoInit[k] everywhere and the term contributes zero.
    const buInit = burnupRhoInit ? burnupRhoInit[k] : 0;
    const buRho = burnupArr ? (excessRhoPcm(buK, T) * 1e-5 - buInit) : 0;
    out[k] = rodRho + boronRho + dopplerRho + moderatorRho + voidRho + xenonRho + buRho;
  }
}

function moderatorFeedbackRho(state, k) {
  const T = state.T;
  if (!T.alphaModerator) return 0;
  if (T.moderatorFeedbackState === 'graphite') {
    return T.alphaModerator * (state.T_graphite[k] - state.Tg0Ref[k]);
  }
  return T.alphaModerator * (state.T_coolant[k] - state.Tc0Ref[k]);
}

// Build the average reactivity stack for UI display.
// Each contribution is averaged across nodes, weighted by local flux (so we report
// the effective contribution to the dominant mode).
export function buildReactivityStack(state) {
  const T = state.T;
  const N = state.N;
  const rod = state.rodBanks.regulating;
  const rodTotalWorth = -(T.rodWorthPcmTotal * 1e-5);
  // Per-node reference temps (Float64Array)
  const Tf0Arr = state.Tf0Ref;
  const alphaVoidIsFunc = typeof T.alphaVoid === 'function';
  const powerFrac = state.out.fissionPowerMW / T.nominalPowerMWth;
  const aVoid = alphaVoidIsFunc ? T.alphaVoid(powerFrac) : T.alphaVoid;
  // Boron only applies to PWR; RBMK and MSR have no soluble boron control.
  const boronInit = T.boronInitialPpm ?? 0;
  const boronWorth = T.boronWorthPcmPerPpm ?? 0;
  const boronRho = (state.boronPpm - boronInit) * boronWorth * 1e-5;

  const rodRhoInit = state.rodRhoInit;
  // II.1 — Burnup contributions (Doppler-scale + excess-ρ vs init).
  const burnupArr = state.burnup;
  const burnupRhoInit = state.burnupRhoInit;
  let fluxSum = 0;
  let rRods = 0, rBoron = 0, rDop = 0, rMod = 0, rVoid = 0, rXe = 0, rBu = 0;
  for (let k = 0; k < N; k++) {
    const phi = state.flux[k];
    fluxSum += phi;
    const wReg = T.rodWorth(k, N, rod);
    const wSaf = T.rodWorth(k, N, state.rodBanks.safety);
    // Per-node rod contribution relative to initial position (critical-by-
    // construction guarantee — see state.js's rodRhoInit comment).
    const initK = rodRhoInit ? rodRhoInit[k] : 0;
    rRods += (rodTotalWorth * (wReg + wSaf) - initK) * phi;
    rBoron += boronRho * phi;
    const buK = burnupArr ? burnupArr[k] : 0;
    const dopScale = burnupArr ? dopplerScale(buK, T) : 1;
    rDop  += T.alphaFuel * dopScale * (state.T_fuel[k] - Tf0Arr[k]) * phi;
    rMod  += moderatorFeedbackRho(state, k) * phi;
    rVoid += (aVoid * state.voidFrac[k] - (state.voidRhoInit ? state.voidRhoInit[k] : 0)) * phi;
    {
      const xenonWorth = (T.xenonWorthPcmAtEq ?? -2800) * 1e-5;
      rXe += (xenonWorth * state.xenon[k] - (state.xenonRhoInit ? state.xenonRhoInit[k] : 0)) * phi;
    }
    const buInit = burnupRhoInit ? burnupRhoInit[k] : 0;
    rBu   += (burnupArr ? (excessRhoPcm(buK, T) * 1e-5 - buInit) : 0) * phi;
  }
  if (fluxSum <= 0) fluxSum = 1e-12;
  const stack = {
    rods: rRods / fluxSum,
    boron: rBoron / fluxSum,
    doppler: rDop / fluxSum,
    moderator: rMod / fluxSum,
    void: rVoid / fluxSum,
    xenon: rXe / fluxSum,
    burnup: rBu / fluxSum,
  };
  stack.total = stack.rods + stack.boron + stack.doppler + stack.moderator + stack.void + stack.xenon + stack.burnup;
  state.lastReactivityStack = stack;
  state.out.reactivityPcm = stack.total * 1e5;
  return stack;
}

// === MSR precursor circulation ===

function coreFlowVelocity(state) {
  // u = (volumetric flow) / (core cross-section). For our purposes we just use
  // u = coreHeight / (coreFlowFracOfLoop · loopTransitTime).
  const T = state.T;
  const loopTransit = T.precursorLoopTransitSec;
  const coreFrac = T.coreFlowFracOfLoop;
  const coreTransit = loopTransit * coreFrac;
  return T.coreHeight / coreTransit;       // m/s
}

function msrInletPrecursor(state, group) {
  if (!state._msrLoopBuf) return 0;
  return state._msrLoopBuf[group][state._msrLoopIdx ?? 0];
}

const LOOP_BUF_DT = 0.05;
const LOOP_BUF_LEN = 400; // 20 s buffer @ 0.05s — covers all reactor types' loop transit

function updateMsrPrecursorLoop(state, dt) {
  const T = state.T;
  if (!state._msrLoopBuf) {
    state._msrLoopBuf = [];
    for (let g = 0; g < 6; g++) state._msrLoopBuf.push(new Float64Array(LOOP_BUF_LEN));
    state._msrLoopIdx = 0;
  }
  // Accumulate sim dt; when we cross the buffer cell boundary, push the
  // top-of-core precursor value (decayed by exp(-λ τ_external)) into the slot
  // that will be read 1 loop-transit-time from now.
  if (!state._loopAccum) state._loopAccum = 0;
  state._loopAccum += dt;
  while (state._loopAccum >= LOOP_BUF_DT) {
    state._loopAccum -= LOOP_BUF_DT;
    const externalTransit = T.precursorLoopTransitSec * (1 - T.coreFlowFracOfLoop);
    for (let g = 0; g < 6; g++) {
      const topVal = state.precursors[g][state.N - 1];
      const decayedReturn = topVal * Math.exp(-T.lambda[g] * externalTransit);
      state._msrLoopBuf[g][state._msrLoopIdx] = decayedReturn;
    }
    state._msrLoopIdx = ((state._msrLoopIdx ?? 0) + 1) % LOOP_BUF_LEN;
  }
}
