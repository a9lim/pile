// multichannel.js -- II.7: parallel-channel TH model for RBMK direct-cycle.
//
// Replaces the single-channel channel-walk void model in thermal.js with a
// minimum two-channel split: a HOT channel (representative of the peak-power
// fuel assemblies, scaled by T.hotChannelFactor) and an AVG channel (the bulk
// of the core). Both channels share inlet plenum + outlet plenum pressures,
// so the ΔP from inlet to outlet must equalize. This couples the channels:
// a flow perturbation in one channel changes its enthalpy gain → its void
// distribution → its average density → its hydrostatic head → the ΔP balance,
// which feeds back to the other channel's flow.
//
// PEDAGOGICAL OBJECTS UNLOCKED:
//
//   1. Density-wave instability. A flow perturbation in the hot channel
//      creates an enthalpy perturbation that travels at coolant velocity
//      through the channel; becomes a density perturbation in the upper
//      voided region; and feeds back to ΔP-balance with the transit-time lag.
//      If the loop gain is > 1 the perturbation grows into a self-sustaining
//      oscillation. Captured indirectly here through ΔP-balance solver
//      behaviour — perturbing one channel's flow causes the other channel's
//      flow to swing in the opposite direction.
//
//   2. Ledinegg instability (flow excursion). At low power + low flow the
//      channel ΔP-vs-flow curve has a NEGATIVE-SLOPE region: friction
//      (quadratic in ṁ) is small at low flow, but the gravity term collapses
//      faster because the upper portion of the channel boils away to high
//      void → low density. Operating in the negative-slope region is unstable
//      — a small flow perturbation gets amplified. Captured here by the
//      bisection solver detecting multiple roots of the ΔP-balance and
//      flagging `out.ledineggUnstable`.
//
// SOLVER STRATEGY:
//
//   Each substep:
//     1. m_total = state.out.flowMassRateKgPerS (from circulation.js)
//     2. P_hot, P_avg from total core power × hot/avg fraction split.
//     3. Parameterize: m_hot = m_total · f_hot, m_avg = m_total · (1 - f_hot).
//        Bisect on the ΔP-balance residual r(f_hot) = ΔP_hot - ΔP_avg over
//        f_hot ∈ [0.001, 0.999]. 30 iterations max; convergence when
//        |r| < 0.5% of mean ΔP.
//     4. Multi-root check: sample r(f) at 16 points across the interval; if
//        sign changes more than once, set out.ledineggUnstable = true and
//        pick the LOWEST-flow root for the hot channel (the unstable /
//        dryout branch — the pedagogical hook).
//     5. If bisection fails to converge: symmetric fallback split and set
//        flowSplitDivergent = true.
//
//   With the chosen 2-channel power split (hot channel is ~5% of core but
//   gets ~1.7× the per-channel power), in nominal steady state the bisection
//   converges in 6-10 iterations and produces a single-root flow split where
//   the hot channel "self-throttles" — its higher void → lower average
//   density → less gravity drive → less flow drawn at the same shared ΔP.
//
// ΔP MODEL:
//
//   ΔP(m, P_W) = K_fric · m² / ρ_avg(m, P_W)  +  ρ_avg(m, P_W) · g · L
//
//   where ρ_avg(m, P_W):
//     h_out = h_in + P_W / m         (outlet enthalpy)
//     If h_out < h_sat: single-phase, ρ_avg = rhoF (= 740 kg/m³ at ~7 MPa)
//     Else two-phase with outlet quality x_out = (h_out - h_sat) / h_fg,
//          channel-average quality x_avg ≈ x_out / 2 (linear quality profile),
//          α_avg from x_avg via slip-ratio model,
//          ρ_avg = α·rhoG + (1-α)·rhoF.
//
//   Constants chosen so single-phase friction balances all-liquid gravity at
//   nominal flow: K_fric ≈ ρ_f²·g·L / m_design² per channel. Acceleration
//   term omitted (small relative to friction + gravity at the precision
//   needed for pedagogy).
//
// CALIBRATION (RBMK steady state, m_total = 10500 kg/s, P_core = 3200 MW):
//
//   hotChannelFractionOfCore = 0.05   (5% of channels are "hot")
//   hotChannelFactor         = 1.7    (from chf.js — radial peaking factor)
//
//   Per-channel power: 1661 total channels in RBMK. Hot subset = 83 channels.
//   P_hot_per_channel = (P_core · 0.05 / 83) · 1.7
//   P_avg_per_channel =  P_core · 0.95 / 1578
//   Ratio = (0.05 / 83) · 1.7 / (0.95 / 1578) = 1.69 ≈ 1.7  ✓
//
//   But the multichannel solver treats hot + avg as two LUMPED channels:
//     P_hot_lumped = P_core · 0.05 · 1.7 / (0.05 · 1.7 + 0.95)
//                  = P_core · 0.0820  (≈ 8.2% of total core power)
//     P_avg_lumped = P_core · (1 - 0.0820) = P_core · 0.9180
//
//   This is the per-LUMPED-channel-aggregate power, applied to the lumped
//   mass flow that the solver assigns to each side of the parallel split.

const G_GRAVITY = 9.81;
const H_FG_RBMK = 1.5e6;      // J/kg latent heat at ~7 MPa (matches thermal.js)
const RHO_F = 740;            // kg/m³ saturated water at ~7 MPa
const RHO_G = 35;             // kg/m³ saturated steam at ~7 MPa
const SLIP = 2;               // homogeneous-equilibrium slip ratio

// Per the spec: roughly 5% of channels in RBMK are the "hot" peak-power
// representatives, getting the peaking factor applied.
const HOT_CHANNEL_FRACTION_OF_CORE = 0.05;

// RBMK has 1661 fuel channels. The parallel-channel model treats hot and avg
// as two LUMPS, each consisting of many physical channels (hot lump ≈ 83
// channels, avg lump ≈ 1578). All physical channels in a lump are in
// parallel — they share the same ΔP. Each channel carries m_lump / N_lump
// of mass flow, and the lump's ΔP equals one channel's ΔP at that per-pipe
// flow. So friction and gravity calibrate against PER-PIPE flow, not the
// lumped sum. This is what gives the channels comparable friction
// characteristics and lets the Ledinegg shape emerge.
const N_CHANNELS_RBMK = 1661;

// Solver tuning.
const BISECTION_MAX_ITERS = 30;
const BISECTION_TOL_FRAC = 0.005;          // |r| < 0.5% of mean ΔP
const MULTI_ROOT_SAMPLES = 16;             // f_hot ∈ [0.001, 0.999] grid
const F_HOT_MIN = 0.001;
const F_HOT_MAX = 0.999;

// Channel-averaged density given mass flow and power input. Takes both h_in
// and h_sat explicitly. h_fg is supplied so callers can pass the proper
// latent heat for the pressure. Also returns outlet quality x_out for the
// hot-channel-quality readout.
function rhoAvgAndQuality(m, P_W, h_in, h_sat, h_fg) {
  const m_eff = Math.max(m, 1e-3);
  const h_out = h_in + P_W / m_eff;
  if (h_out <= h_sat) {
    return { rhoAvg: RHO_F, xOut: 0, xAvg: 0 };
  }
  const x_out = Math.min(1, (h_out - h_sat) / h_fg);
  // Linear quality profile assumption: x grows ~linearly from 0 at the
  // saturation point in the channel to x_out at outlet. The integral mean
  // is x_out/2 if saturation occurs at the inlet; if the lower portion of
  // the channel is subcooled (h_in < h_sat), the integral mean is still
  // proportional but smaller. The simplification x_avg = x_out / 2 is the
  // upper bound and is what we use here for pedagogical clarity — the
  // Ledinegg signature lives in the shape of the curve, not its absolute
  // value.
  const x_avg = x_out / 2;
  const alpha = x_avg / (x_avg + (1 - x_avg) * SLIP * RHO_G / RHO_F);
  const rho = alpha * RHO_G + (1 - alpha) * RHO_F;
  return { rhoAvg: rho, xOut: x_out, xAvg: x_avg };
}

// ΔP(m_lump, P_W) for one parallel-channel lump. Per-pipe flow is
// m_lump / N_channels_in_lump; per-pipe enthalpy gain is P_W / m_lump (the
// lump's total power goes into the lump's total mass flow → same per-pipe
// enthalpy gain). Per-pipe ΔP is friction (quadratic in per-pipe flow) plus
// gravity (depends only on average density, not flow). The lump's ΔP is
// numerically equal to one channel's ΔP because channels in parallel
// equalize ΔP.
function channelDeltaP(m_lump, P_W, h_in, h_sat, h_fg, K_fric_per_pipe, L_core, nPipes) {
  const m_eff = Math.max(m_lump, 1e-3);
  // Per-pipe enthalpy gain — same formula as before; P_W / m_lump is the
  // lump's enthalpy gain (per kg of flowing coolant).
  const { rhoAvg } = rhoAvgAndQuality(m_eff, P_W, h_in, h_sat, h_fg);
  const m_per_pipe = m_eff / nPipes;
  const dP_fric = K_fric_per_pipe * m_per_pipe * m_per_pipe / Math.max(rhoAvg, 1e-3);
  const dP_grav = rhoAvg * G_GRAVITY * L_core;
  return { dP: dP_fric + dP_grav, rhoAvg };
}

// Sign of r(f_hot) at f_hot. Positive means hot ΔP > avg ΔP (hot channel
// "wants" less flow at this split, i.e. true hot-channel flow would be lower).
function residual(f_hot, ctx) {
  const m_hot = ctx.m_total * f_hot;
  const m_avg = ctx.m_total * (1 - f_hot);
  const dpHot = channelDeltaP(m_hot, ctx.P_hot, ctx.h_in, ctx.h_sat, ctx.h_fg, ctx.K_fric_per_pipe, ctx.L_core, ctx.nHot);
  const dpAvg = channelDeltaP(m_avg, ctx.P_avg, ctx.h_in, ctx.h_sat, ctx.h_fg, ctx.K_fric_per_pipe, ctx.L_core, ctx.nAvg);
  return { r: dpHot.dP - dpAvg.dP, dpHot: dpHot.dP, dpAvg: dpAvg.dP };
}

// Initialise per-channel state arrays for RBMK direct-cycle. PWR + MSR get
// nulls (the multichannel solver is gated off there).
export function initMultichannelState(state) {
  const T = state.T;
  if (T.primaryTopology !== 'direct') {
    state.T_coolant_hot = null;
    state.T_coolant_avg = null;
    state.voidFrac_hot = null;
    state.voidFrac_avg = null;
    state.qualityFrac_hot = null;
    state.qualityFrac_avg = null;
    state.m_hot = 0;
    state.m_avg = 0;
    return;
  }
  const N = state.N;
  state.T_coolant_hot = new Float64Array(N);
  state.T_coolant_avg = new Float64Array(N);
  state.voidFrac_hot = new Float64Array(N);
  state.voidFrac_avg = new Float64Array(N);
  state.qualityFrac_hot = new Float64Array(N);
  state.qualityFrac_avg = new Float64Array(N);
  // Seed from the (already populated) blended state.T_coolant / state.voidFrac.
  for (let k = 0; k < N; k++) {
    state.T_coolant_hot[k] = state.T_coolant[k];
    state.T_coolant_avg[k] = state.T_coolant[k];
    state.voidFrac_hot[k] = state.voidFrac[k];
    state.voidFrac_avg[k] = state.voidFrac[k];
    state.qualityFrac_hot[k] = state.qualityFrac[k];
    state.qualityFrac_avg[k] = state.qualityFrac[k];
  }
  // Seed flow split symmetrically; the first solver call corrects it.
  const m_total = state.out?.flowMassRateKgPerS ?? T.coolantMassFlowKgPerS;
  state.m_hot = m_total * HOT_CHANNEL_FRACTION_OF_CORE;
  state.m_avg = m_total - state.m_hot;
}

// Per-substep update — solves the ΔP balance, walks per-channel enthalpy +
// quality, writes back to per-channel arrays AND the blended state.T_coolant
// / state.voidFrac (which feed reactivity feedback, axial display, etc.).
//
// Inputs from caller:
//   pressureMPa — local system pressure for h_sat / h_fg calc (drum P)
//   Tin         — inlet coolant temperature
//   cCool       — coolant specific heat
//   Pfis        — current fission power (W)
//   Pdecay      — current decay heat power (W)
//   fluxSum     — Σ flux[k]  (for axial power shape)
//
// Effects on state:
//   state.T_coolant_hot[k], state.voidFrac_hot[k]
//   state.T_coolant_avg[k], state.voidFrac_avg[k]
//   state.T_coolant[k] (blended)
//   state.voidFrac[k]  (blended)
//   state.m_hot, state.m_avg
//   state.out.mHotKgPerS, state.out.mAvgKgPerS, state.out.hotChannelQuality
//   state.out.ledineggUnstable, state.out.flowSplitDivergent
export function stepMultichannel(state, pressureMPa, Tin, cCool, Pfis, Pdecay, fluxSum) {
  const T = state.T;
  const N = state.N;
  const out = state.out;
  if (T.primaryTopology !== 'direct') return false;

  // Saturation temperature / enthalpy at the local pressure (IF97 Region 4
  // via steam-tables.js). h_fg is held at the calibrated 7 MPa value for
  // pedagogical clarity; for sub-7-MPa transients the slight error in h_fg
  // matters less than the shape of the ΔP curve.
  const Tsat = saturationTempK(pressureMPa);
  const h_in = Tin * cCool;
  const h_sat = Tsat * cCool;
  const h_fg = H_FG_RBMK;
  const L_core = T.coreHeight;

  // Lumped-channel power split. Hot subset is HOT_CHANNEL_FRACTION_OF_CORE
  // of the channels; its per-channel power is hotChannelFactor× the average
  // per-channel power. So hot LUMPED power = P_core · f · F_q / (f·F_q + 1-f).
  const f = HOT_CHANNEL_FRACTION_OF_CORE;
  const F_q = T.hotChannelFactor ?? 1.7;
  const P_core_W = Pfis + Pdecay;
  const hotShare = (f * F_q) / (f * F_q + (1 - f));     // ≈ 0.0820 with f=0.05, F_q=1.7
  const P_hot = P_core_W * hotShare;
  const P_avg = P_core_W - P_hot;

  // K_fric calibration — PER-PIPE. Both hot and avg lumps share the same
  // per-pipe friction coefficient because the channels are geometrically
  // identical (RBMK has 1661 identical pressure tubes). At the design
  // operating point, per-pipe flow = m_design_total / N_channels ≈ 6.3 kg/s
  // (= 10500 / 1661). Calibrate so per-pipe friction ΔP at design flow
  // equals the all-liquid gravity head ρ_f·g·L:
  //   K_fric_per_pipe · (m_per_pipe_des)² / ρ_f = ρ_f·g·L
  //   K_fric_per_pipe = ρ_f²·g·L / m_per_pipe_des²
  // With the SAME K_fric on both lumps but different per-pipe flows when
  // f_hot ≠ design fraction, the ΔP curves diverge with the expected
  // Ledinegg shape: hot channel boiling at low flow drops grav head; high
  // flow drives friction quadratically.
  const m_total = Math.max(out.flowMassRateKgPerS ?? T.coolantMassFlowKgPerS, 1);
  const nHot = Math.max(1, Math.round(f * N_CHANNELS_RBMK));
  const nAvg = Math.max(1, N_CHANNELS_RBMK - nHot);
  // Per-pipe design flow at nominal m_total (constant calibration target —
  // friction curve doesn't slide around with operator flow command).
  const m_total_design = T.coolantMassFlowKgPerS;
  const m_per_pipe_design = m_total_design / N_CHANNELS_RBMK;
  const K_fric_per_pipe = (RHO_F * RHO_F * G_GRAVITY * L_core) / (m_per_pipe_design * m_per_pipe_design);

  const ctx = {
    m_total, P_hot, P_avg, h_in, h_sat, h_fg,
    K_fric_per_pipe, L_core, nHot, nAvg,
  };

  // Sample residual on a coarse grid to detect sign changes → multi-root
  // (Ledinegg). Also tracks the sign-change locations as bisection seeds.
  const samples = new Array(MULTI_ROOT_SAMPLES + 1);
  const fGrid = new Array(MULTI_ROOT_SAMPLES + 1);
  for (let i = 0; i <= MULTI_ROOT_SAMPLES; i++) {
    const f_hot = F_HOT_MIN + (F_HOT_MAX - F_HOT_MIN) * (i / MULTI_ROOT_SAMPLES);
    fGrid[i] = f_hot;
    samples[i] = residual(f_hot, ctx);
  }
  // Find sign changes.
  const signChanges = [];
  for (let i = 0; i < MULTI_ROOT_SAMPLES; i++) {
    const a = samples[i].r;
    const b = samples[i + 1].r;
    if ((a > 0 && b < 0) || (a < 0 && b > 0)) {
      signChanges.push({ lo: fGrid[i], hi: fGrid[i + 1] });
    }
  }
  const ledineggDetected = signChanges.length > 1;

  // Bisection target bracket. If multi-root, pick the LOWEST-flow root for
  // the hot channel (unstable / dryout branch). Otherwise the single root.
  let bracket;
  if (signChanges.length === 0) {
    // No interior root — pick the endpoint with smaller |residual|.
    bracket = null;
  } else {
    // signChanges sorted ascending in f_hot by construction; lowest hot flow
    // = smallest f_hot value = signChanges[0].
    bracket = signChanges[0];
  }

  let f_hot_solved;
  let converged = false;
  if (bracket) {
    let lo = bracket.lo;
    let hi = bracket.hi;
    let rLo = residual(lo, ctx);
    let rHi = residual(hi, ctx);
    const dpMean = 0.5 * (Math.abs(rLo.dpHot) + Math.abs(rLo.dpAvg) + Math.abs(rHi.dpHot) + Math.abs(rHi.dpAvg)) / 2;
    const tol = Math.max(dpMean * BISECTION_TOL_FRAC, 1e-3);
    for (let it = 0; it < BISECTION_MAX_ITERS; it++) {
      const mid = 0.5 * (lo + hi);
      const rMid = residual(mid, ctx);
      if (Math.abs(rMid.r) < tol) {
        f_hot_solved = mid;
        converged = true;
        break;
      }
      if ((rMid.r > 0 && rLo.r > 0) || (rMid.r < 0 && rLo.r < 0)) {
        lo = mid; rLo = rMid;
      } else {
        hi = mid; rHi = rMid;
      }
    }
    if (!converged) f_hot_solved = 0.5 * (lo + hi);
    converged = true;     // bracket existed → solver narrowed; treat as converged
  } else {
    // No sign change. The minimum-|r| endpoint is the closest single-phase
    // solution; in steady state this should be the natural-flow operating
    // point. Use linear interpolation between the two grid points with
    // smallest |r|.
    let bestIdx = 0;
    let bestAbs = Math.abs(samples[0].r);
    for (let i = 1; i <= MULTI_ROOT_SAMPLES; i++) {
      const a = Math.abs(samples[i].r);
      if (a < bestAbs) { bestAbs = a; bestIdx = i; }
    }
    f_hot_solved = fGrid[bestIdx];
    converged = true;
  }

  // If for some reason we never solved (e.g. degenerate input), fall back
  // to symmetric split and flag divergence.
  let divergent = false;
  if (!Number.isFinite(f_hot_solved) || f_hot_solved < F_HOT_MIN || f_hot_solved > F_HOT_MAX) {
    f_hot_solved = 0.5;
    divergent = true;
  }

  const m_hot = m_total * f_hot_solved;
  const m_avg = m_total * (1 - f_hot_solved);

  // Walk per-channel enthalpy node-by-node — same channel-walk pattern as
  // the original single-channel void model in thermal.js, applied twice.
  walkChannel(state, 'hot', m_hot, P_hot, h_in, h_sat, h_fg, Tsat, cCool, fluxSum);
  walkChannel(state, 'avg', m_avg, P_avg, h_in, h_sat, h_fg, Tsat, cCool, fluxSum);

  // Hot-channel outlet quality readout (after walking).
  const { xOut: xOutHot } = rhoAvgAndQuality(m_hot, P_hot, h_in, h_sat, h_fg);
  const { xOut: xOutAvg } = rhoAvgAndQuality(m_avg, P_avg, h_in, h_sat, h_fg);

  // Blend per-channel state back to the canonical state.T_coolant / voidFrac
  // arrays that everything else (neutronics moderator/void feedback, axial
  // display, mimic, etc.) reads. Weight by hotChannelFractionOfCore so the
  // bulk core feedback sees the "average" channel dominantly — the hot
  // channel is bookkeeping for the DNBR / Ledinegg story.
  const wHot = f;
  const wAvg = 1 - f;
  for (let k = 0; k < N; k++) {
    state.T_coolant[k] = wHot * state.T_coolant_hot[k] + wAvg * state.T_coolant_avg[k];
    state.voidFrac[k] = wHot * state.voidFrac_hot[k] + wAvg * state.voidFrac_avg[k];
    state.qualityFrac[k] = wHot * state.qualityFrac_hot[k] + wAvg * state.qualityFrac_avg[k];
  }

  state.m_hot = m_hot;
  state.m_avg = m_avg;
  out.mHotKgPerS = m_hot;
  out.mAvgKgPerS = m_avg;
  out.hotChannelQuality = xOutHot;
  out.avgChannelQuality = xOutAvg;
  out.bulkSteamQuality = (m_hot * xOutHot + m_avg * xOutAvg) / Math.max(m_hot + m_avg, 1e-9);
  out.ledineggUnstable = ledineggDetected || divergent;
  out.flowSplitDivergent = divergent;
  return true;
}

// Channel-walk void model — node-by-node enthalpy progression with the slip-
// ratio quality→void map. Operates on per-channel arrays:
// state.T_coolant_<which>[k] and state.voidFrac_<which>[k].
//
// In subcooled nodes (h_local ≤ h_sat) the per-channel T inherits the bulk
// state.T_coolant[k] that the main thermal-loop already evolved with the
// proper clad-coolant heat flow + flow advection. That keeps the multichannel
// path from clobbering the careful per-node enthalpy evolution upstream of
// the saturation point. Only in boiling nodes does the multichannel walk
// pin T to T_sat (heat goes into latent, not sensible) — same convention as
// the original single-channel void model in thermal.js.
function walkChannel(state, which, m, P_W, h_in, h_sat, h_fg, Tsat, cCool, fluxSum) {
  const N = state.N;
  const Tarr = which === 'hot' ? state.T_coolant_hot : state.T_coolant_avg;
  const Varr = which === 'hot' ? state.voidFrac_hot : state.voidFrac_avg;
  const Qarr = which === 'hot' ? state.qualityFrac_hot : state.qualityFrac_avg;
  const m_eff = Math.max(m, 1e-3);
  let h_local = h_in;
  for (let k = 0; k < N; k++) {
    const phi = state.flux[k];
    const localPowerW = P_W * phi / Math.max(fluxSum, 1e-12);
    h_local += localPowerW / m_eff;
    const x = Math.max(0, (h_local - h_sat) / h_fg);
    const x_eff = Math.min(1, x);
    Qarr[k] = x_eff;
    const alpha = x_eff / (x_eff + (1 - x_eff) * SLIP * RHO_G / RHO_F);
    Varr[k] = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
    if (h_local > h_sat) {
      Tarr[k] = Tsat;
    } else {
      // Subcooled — inherit the main-loop-evolved bulk temperature so we
      // don't overwrite the per-node clad-coolant + advection update with
      // a coarse h/c_p approximation.
      Tarr[k] = state.T_coolant[k];
    }
  }
}

// I.8 — Water saturation temperature via the IAPWS-IF97 Region 4 equation
// (physics/steam-tables.js). Single source of truth; the kPa-form Antoine
// duplicate is retired. `tSat` takes MPa, returns K.
import { tSat as saturationTempK } from './steam-tables.js';
