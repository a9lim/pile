// chf.js -- I.2: critical heat flux correlation + DNBR (departure from
// nucleate boiling ratio).
//
// DNBR = q''_chf / q''_local at the hot channel. Trip at 1.3 (the standard
// PWR Specified Acceptable Fuel Design Limit), warn at 1.5. Below 1.0 the
// wall is past CHF — film boiling sets in, h drops by 1-2 orders of
// magnitude, T_clad spikes a few hundred K within seconds, fuel rod fails.
//
// Bowring-class simplified form (SI units throughout):
//
//   q''_chf [W/m²] = A · G^0.4 · (1 - X) · f(P)
//
// where:
//   G   = local mass flux                          [kg/m²·s]
//   X   = local equilibrium quality                [—]    (0 if subcooled)
//   P   = local system pressure                    [MPa]
//   A   = per-reactor calibration constant chosen so steady-state DNBR
//         lands in the 2-3 range at design conditions
//   f(P) = pressure factor, gentle peak at ~7 MPa, clamped [0.5, 1.5]
//
// References:
//   - Bowring, R.W., "A Simple but Accurate Round Tube, Uniform Heat Flux,
//     Dryout Correlation Over the Pressure Range 0.7-17 MPa", AEEW-R-789,
//     UK Atomic Energy Authority Winfrith (1972).
//   - Tong, L.S., "Heat Transfer in Water-Cooled Nuclear Reactors", Nuclear
//     Engineering and Design 6(4), pp. 301-324 (1967) — W-3 origin paper
//     and the canonical PWR safety-analysis CHF correlation.
//   - Groeneveld, D.C. et al., "The 2006 CHF look-up table", Nuclear
//     Engineering and Design 237(15-17), pp. 1909-1922 (2007) — modern
//     1.6M-entry interpolation reference.
//
// The full W-3 has 5 multiplicative terms and 15+ tuned coefficients in
// non-SI units (Btu/hr/ft², psia, lbm/hr/ft²); the Groeneveld 2006 LUT is a
// 1.6M-entry interpolation table. Both are overkill for this simulator and
// a maintenance liability. We ship a pedagogical reduced form that captures
// the three load-bearing physics behaviours preserved across all three:
//   (1) CHF decreases with rising quality (∝ 1-X),
//   (2) CHF decreases at low flow (∝ G^0.4),
//   (3) CHF peaks near 7 MPa (gentle pressure factor).

// Bowring-class CHF — SI units, Watt-per-square-metre out.
export function chfBowring(G_kgM2s, X, P_MPa, A_scaling) {
  const Gterm = Math.pow(Math.max(G_kgM2s, 1), 0.4);
  const Xterm = Math.max(0, 1 - X);
  // Pressure factor — gentle peak near 7 MPa, clamped to [0.5, 1.5].
  let pFactor = 1 - 0.5 * Math.abs(P_MPa - 7) / 14;
  if (pFactor < 0.5) pFactor = 0.5;
  if (pFactor > 1.5) pFactor = 1.5;
  return A_scaling * Gterm * Xterm * pFactor;
}

// Compute per-node DNBR profile and minimum across the hot channel.
// Writes:
//   state.out.dnbrPerNode  — Float64Array, length N, one DNBR per axial node
//   state.out.dnbrMin      — minimum across the channel (the operator
//                            indication; trip threshold is 1.3)
//   state.out.dnbrMinNode  — index of the node where the minimum occurs
//
// MSR has no boiling crisis (single-phase salt at 0.5 MPa, no two-phase
// regime exists for FLiBe) — this function early-returns with all three
// fields nulled out.
//
// Reads only from state; never mutates state.flux/T/voidFrac, so safe to
// call at any point in the step pipeline. We call it from sim.js after
// stepThermal so flux + voidFrac + temps are all current.
export function computeDnbr(state) {
  const T = state.T;
  const N = state.N;
  // MSR / unconfigured types: no DNBR.
  if (T.primaryTopology === 'msr' || !T.heatTransferAreaM2 || !T.chfScaling) {
    state.out.dnbrPerNode = null;
    state.out.dnbrMin = null;
    state.out.dnbrMinNode = -1;
    return;
  }
  if (!state.out.dnbrPerNode || state.out.dnbrPerNode.length !== N) {
    state.out.dnbrPerNode = new Float64Array(N);
  }
  const dnbr = state.out.dnbrPerNode;

  const areaPerNode = T.heatTransferAreaM2 / N;
  // Mass flux through the active flow area. Per-type T.flowAreaM2 is the
  // representative cross-sectional flow area (sum across all subchannels);
  // a conservative ~5 m² for PWR open-lattice cores, ~1.5 m² for the RBMK
  // pressure-tube assemblage. Falls back to 5 m² if unset.
  const flowArea = T.flowAreaM2 ?? 5;
  // Mass flux must follow the live circulation model, not the operator's
  // commanded pump-speed scalar. Per-loop RCP trips and natural circulation can
  // leave state.coolantFlowFrac high while actual core flow is far lower.
  const liveFlowKgPerS = state.out?.flowMassRateKgPerS
    ?? (T.coolantMassFlowKgPerS * state.coolantFlowFrac);
  const G = liveFlowKgPerS / Math.max(flowArea, 1e-3);
  const A = T.chfScaling;
  // Local pressure: drum pressure for direct-cycle (RBMK), pressurizer for
  // pressurized PWR primary.
  const P_MPa = T.primaryTopology === 'direct'
    ? (state.sgSecondaryP ?? 0)
    : (state.pressurizerP ?? 0);

  // Total core power for q'' (fission + decay both heat the cladding).
  const totalCoreW = (state.out.totalCorePowerMW ?? state.out.fissionPowerMW) * 1e6;
  let fluxSum = 0;
  for (let k = 0; k < N; k++) fluxSum += state.flux[k];
  if (fluxSum <= 0) fluxSum = 1e-12;

  // Hot-channel peaking factor F_q. We don't simulate radial peaking
  // explicitly (the 1D axial model averages over the radial cross-section);
  // lump it into a per-type constant. PWR FSAR design hot-spot factor is
  // typically ~2.5; RBMK runs flatter by design (~1.7).
  const Fq = (T.hotChannelFactor ?? 2.5) * (state.out.modalPeakingFactor ?? 1);

  // II.7 — When the multichannel TH solver has populated per-channel state
  // (RBMK direct-cycle), use hot-channel steam mass quality directly for the
  // CHF kernel. Void fraction is a volume fraction, not quality; the fallback
  // to void is only for legacy states without quality arrays.
  const useHotChannelVoid = state.voidFrac_hot != null;

  let dnbrMin = Infinity;
  let dnbrMinNode = -1;
  for (let k = 0; k < N; k++) {
    const phi = state.flux[k];
    // Local heat flux per area, augmented by hot-channel peaking factor.
    const q_local = (totalCoreW * phi / fluxSum / areaPerNode) * Fq;     // W/m²
    // Local steam mass quality. Hot-channel quality when available; otherwise
    // blended/bulk quality (or a legacy void fallback).
    const X = useHotChannelVoid
      ? (state.qualityFrac_hot?.[k] ?? state.voidFrac_hot[k] ?? 0)
      : (state.qualityFrac?.[k] ?? state.voidFrac[k] ?? 0);
    const q_chf = chfBowring(G, X, P_MPa, A);
    const r = q_chf / Math.max(q_local, 1);
    dnbr[k] = r;
    if (r < dnbrMin) {
      dnbrMin = r;
      dnbrMinNode = k;
    }
  }
  state.out.dnbrMin = dnbrMin;
  state.out.dnbrMinNode = dnbrMinNode;
}
