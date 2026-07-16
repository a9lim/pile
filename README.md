# Pile

A semi-realistic nuclear reactor simulator. Three reactor types — PWR, RBMK, and MSR — share a common 1D axial physics engine with six delayed-neutron precursor groups per node, burnup-aware point kinetics, fuel/clad/coolant thermal feedback, iodine-xenon dynamics, ANS-5.1 decay heat, and a coupled plant model from core heat source to turbine, condenser, grid load, safety buses, containment, and spent-fuel-pool support systems.

The point of three reactor types is that design choices show up as different dynamics. The PWR uses a Westinghouse four-loop reference design, collapsed in the simulator to one representative primary loop and steam generator, with soluble boron, CVCS, pressurizer, EDGs, batteries, AFW, ECCS/RWST/sump recirculation, containment sprays, fan coolers, SGTR, feedwater heaters, feedwater pumps, and a staged turbine-generator. The RBMK-1000 is graphite-moderated, boils in pressure tubes, separates steam mass quality from void fraction, and has low-power positive void feedback plus graphite-tipped rods. The MSR is MSRE-scale fuel salt with circulating delayed-neutron precursors, xenon off-gas removal, an intermediate loop, and a freeze-plug drain into a passively cooled drain-tank state.

The default initial condition is hot full-power equilibrium, not a clean fresh startup: xenon/iodine, delayed precursors, decay heat, burnup, and full-power RBMK boiling void are populated and then snapshotted as reactivity references so the reactor is critical by construction without hiding those inventories. After scram, decay heat remains as the residual heat source; during steady full-power operation, total core heat is not double-counted as fission plus afterheat.

Named for Chicago Pile-1 (Fermi, 2 December 1942).

[Live →](https://a9l.im/pile)

## Run locally

Serve from the parent directory so absolute paths to shared modules resolve:

```bash
cd path/to/a9lim.github.io && python -m http.server
```

Then visit `http://localhost:8000/pile/`.

For full Worker headers/routing behavior from the portfolio root:

```bash
cd path/to/a9lim.github.io && ./dev.sh
```

Node-side physics checks live in the project root (`test_round5.mjs`, `test_round6.mjs`, `test_round7.mjs`, `test_audit_fixes.mjs`) and should call `advanceSim`, not the bare inner `step`.

## License

AGPL-3.0. See [LICENSE](LICENSE).
