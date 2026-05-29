// msr-aux.js -- MSR auxiliary subsystems (Wave B). Gated per-block.
//
//   1. Off-gas system. Helium sparged through the pump bowl strips ¹³⁵Xe / Kr
//      from the fuel salt; the gas is held up in charcoal beds where it decays.
//      This is WHY an MSR's xenon poisoning is small — the noble gases leave
//      before they can absorb neutrons. xenon.js reads state.msrOffGas
//      .xeRemovalRateS for its sink, so a loss of off-gas (sparge trip) lets
//      ¹³⁵Xe build back up. At init the rate equals T.xenonOffGasRateS (the
//      value the equilibrium xenon was built with) → critical-by-construction.
//   2. Reactor-cell containment. The reactor + drain-tank cells are sealed and
//      inert (N₂), slightly subatmospheric. They heat up from drain-tank
//      afterheat (and any salt spill) and are held by cell coolers — the MSR
//      analog of containment.

export function stepMsrAux(state, dt) {
  const T = state.T;

  // ── Off-gas ────────────────────────────────────────────────────────────
  const og = state.msrOffGas;
  if (og) {
    og.available = state.cmd.msrOffGasTrip !== true;
    og.xeRemovalRateS = og.available ? (T.xenonOffGasRateS ?? 0) : 0;
    // Charcoal beds slowly load while stripping (saturate over days).
    if (og.available) {
      og.charcoalLoadingFrac = Math.min(1,
        og.charcoalLoadingFrac + dt / (T.msrOffGas?.charcoalFillTauSec ?? 6e5));
    }
  }

  // ── Fuel-salt chemistry (Wave C) ─────────────────────────────────────────
  // Redox potential tracked as the U⁴⁺/U³⁺ ratio (normalized 1.0 = in-band).
  // Fission frees fluorine → the salt drifts oxidizing (ratio up), which
  // corrodes the Hastelloy structurals. Operator adds reductant (Be / UF₃) to
  // pull it back. Slow inventory bookkeeping — no reactivity coupling, so init
  // is unaffected.
  const ch = state.msrChem;
  if (ch) {
    const cfg = T.msrChem;
    const powerFrac = (state.out.fissionPowerMW ?? 0) / Math.max(T.nominalPowerMWth, 1);
    ch.reductantOn = state.cmd.msrRedoxControl === true;
    const reductant = ch.reductantOn ? (cfg.reductantRatePerS ?? 1e-3) : 0;
    ch.redoxRatio = clamp(ch.redoxRatio
      + ((cfg.oxidationRatePerS ?? 2e-4) * powerFrac - reductant) * dt, 0.5, 5);
    const over = Math.max(ch.redoxRatio - (cfg.corrosionThreshold ?? 1.5), 0);
    ch.corrosionIndex = Math.max(0, ch.corrosionIndex + over * (cfg.corrosionRatePerS ?? 1e-4) * dt);
  }

  // ── Reactor-cell containment ─────────────────────────────────────────────
  const cell = state.msrCell;
  if (cell) {
    const cfg = T.msrCell;
    const sinkK = cfg.sinkK ?? 311;
    // Drain-tank afterheat sits in the cell; a small standing fraction couples
    // even when the plug is intact (cell holds the hot loop).
    const qIn = (state.drainTankHeatMW ?? 0) * 1e6 * (state.freezePlugMelted ? 1 : 0.02);
    const qOut = (cfg.coolerUaWperK ?? 3e4) * Math.max(cell.tempK - sinkK, 0);
    cell.tempK = clamp(cell.tempK + (qIn - qOut) / (cfg.thermalMassJperK ?? 5e7) * dt, 280, 600);
    // Sealed inert gas: pressure tracks temperature, baseline slightly subatmos.
    cell.pressureMPa = (cfg.baselineP ?? 0.09) * (cell.tempK / sinkK);
  }
}

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
