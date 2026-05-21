// sg-tubes.js (III.12) -- steam generator tube bundle: plugging + rupture.
//
// PWR-only. The SG primary/secondary boundary is ~3600 thin-walled U-tubes
// per SG. Two phenomena live here:
//
// PLUGGING. Plants operate with a few percent of tubes plugged — tubes
// found degraded (wear, denting, stress-corrosion cracking) during ISI are
// removed from service by mechanical plugs. A plugged tube carries no
// primary flow and transfers no heat, so plugging degrades the effective
// primary→secondary heat-transfer coefficient. plant.js scales each loop's
// htLoop by (1 − plugged)/(1 − baseline) — ANCHORED at the baseline
// fraction, so the as-built init state (baseline plugging) is unchanged and
// critical-by-construction holds. Plugging beyond the baseline degrades Qsg;
// it is a maintenance state, set via cmd.sgTubePluggedFrac, not a transient.
//
// SGTR (steam generator tube rupture). A tube lets go — a primary→secondary
// breach. Driven by the primary-to-secondary pressure differential (~15.5
// MPa pressurizer vs ~7 MPa SG ≈ 8.5 MPa ΔP):
//     leakRate = coeff · sqrt(max(P_primary − P_sg, 0))
// calibrated to ~20 kg/s at the design ΔP (a design-basis single-tube
// double-ended rupture). The leak:
//   - DEBITS RCS inventory — added (negative) to state._rcsExternalFlowKgPerS,
//     which pressurizer.js integrates into rcsMassKg + the surge term, so
//     pressurizer level/pressure fall (and the existing lowPressurizerP /
//     lowPzrLevel scrams fire — SGTR is diagnosed from that symptom set).
//   - FLOODS the affected SG — plant.js adds leakRateKgPerS to that loop's
//     SG mass balance, so the ruptured SG's level rises. The leaked water
//     is radioactive primary coolant — the SGTR release hazard (a full
//     radiological model is Phase IV; here we track the leaked inventory).
// The leak is SELF-LIMITING: as the pressurizer depressurizes, ΔP shrinks.
// Depressurizing the primary to the affected SG's pressure stops it — the
// real SGTR mitigation strategy.
//
// Module ordering (sim.js): AFTER stepEccs and BEFORE stepPressurizer, so
// the tube leak lands in the same step's _rcsExternalFlowKgPerS tally that
// pressurizer.js consumes — the same slot the seal LOCA / ECCS flows use.
//
// RBMK/MSR have no T.sgTubes → state.sgTubes is null and this module
// early-returns (RBMK is direct-cycle with no SG; MSR uses an IHX).
//
// References: NUREG-0844 (SGTR generic study); NUREG-1477 (Ginna /
// Indian Point-2 SGTR events); Westinghouse FSAR Ch 5.4.2.

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export function stepSgTubes(state, dt) {
  const tubes = state.sgTubes;
  if (!tubes) return;                    // RBMK / MSR — no SG tube bundle

  const cfg = state.T.sgTubes;
  const cmd = state.cmd;
  const loops = state.loops;
  const pPrimary = state.pressurizerP || 0;
  const coeff = cfg.ruptureLeakCoeffKgPerSPerSqrtMPa ?? 7.0;

  let totalLeak = 0;
  let anyRuptured = false;
  for (let l = 0; l < tubes.length; l++) {
    const t = tubes[l];

    // Plugging — maintenance state from cmd.sgTubePluggedFrac (initialized
    // to the baseline). Clamped to a physically sane envelope.
    const pf = cmd.sgTubePluggedFrac ? cmd.sgTubePluggedFrac[l] : undefined;
    t.pluggedFraction = clamp(Number.isFinite(pf) ? pf
      : (cfg.baselinePluggedFraction ?? 0), 0, 0.6);

    // Rupture — scenario / operator injectable, latched (a torn tube does
    // not heal; the operator plugs/isolates the SG to terminate the event).
    if (cmd.sgTubeRupture && cmd.sgTubeRupture[l] === true) t.ruptured = true;

    if (t.ruptured) {
      const sgP = loops && loops[l] ? loops[l].sgPressureMPa : 0;
      const dP = Math.max(pPrimary - sgP, 0);
      t.leakRateKgPerS = coeff * Math.sqrt(dP);
      anyRuptured = true;
    } else {
      t.leakRateKgPerS = 0;
    }
    t.cumulativeLeakKg += t.leakRateKgPerS * dt;
    totalLeak += t.leakRateKgPerS;
  }

  // Primary inventory loss → the shared RCS external-flow accumulator
  // (pressurizer.js integrates it). Negative = outflow from the RCS.
  state._rcsExternalFlowKgPerS -= totalLeak;

  // Diagnostics for the gauge layer.
  state.out.sgtrLeakKgPerS = totalLeak;
  state.out.sgtrActive = anyRuptured;
}
