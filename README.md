# Pile

A semi-realistic nuclear reactor simulator. Three reactor types — PWR, RBMK, and MSR — share a common 1D axial physics engine with six delayed-neutron precursor groups per node, burnup-aware point kinetics, fuel/clad/coolant thermal feedback, iodine-xenon dynamics, selectable decay-heat correlations, IAPWS-IF97 saturation properties, and type-specific plant models from core heat source to each design's heat sink and support systems.

The point of three reactor types is that design choices show up as different dynamics. The PWR uses a Westinghouse four-loop reference design collapsed to one representative primary loop and steam generator, with soluble boron, CVCS, a dynamic pressurizer, EDGs and batteries, AFW, ECCS/RWST/sump recirculation, containment sprays and fan coolers, SGTR, feedwater systems, and a staged turbine-generator. The RBMK-1000 has two modeled Main Circulation Circuit halves with drum separators and MCP cavitation, direct-cycle steam, DREG-backed electrical buses, split ECCS, an Accident Localization System suppression pool, graphite-gas and CPS-cooling auxiliaries, and a pressure-tube-break fault. The MSR is an MSRE-scale fuel-salt system with circulating delayed-neutron precursors, xenon off-gas removal, online redox/corrosion chemistry, a sealed reactor cell, an intermediate coolant-salt loop, an air-cooled radiator and blower instead of a generator, and freeze-plug drainage into a passively cooled tank.

The default initial condition is hot full-power equilibrium, not a clean fresh startup: xenon/iodine, delayed precursors, decay heat, burnup, and full-power RBMK boiling void are populated and then snapshotted as reactivity references so the reactor is critical by construction without hiding those inventories. After scram, decay heat remains as the residual heat source; during steady full-power operation, total core heat is not double-counted as fission plus afterheat.

Named for Chicago Pile-1 (Fermi, 2 December 1942).

[Live →](https://a9l.im/pile)

## Run locally

Build from the parent repository root and serve `dist/` so absolute paths to shared modules resolve:

```bash
cd path/to/a9lim.github.io && npm run build && python -m http.server --directory dist
```

Then visit `http://localhost:8000/pile/`.

For full Worker headers/routing behavior from the portfolio root:

```bash
cd path/to/a9lim.github.io && ./dev.sh
```

Node-side regression checks live in the project root. Run the four cross-cutting suites (`test_round5.mjs`, `test_round6.mjs`, `test_round7.mjs`, `test_audit_fixes.mjs`), the four RBMK suites, the three MSR suites, and `test_registry_smoke.mjs` after changes that cross reactor-type or UI-registry boundaries. Tests and ad-hoc probes should call `advanceSim`, not the bare inner `step`.

## License

AGPL-3.0. See [LICENSE](LICENSE).
