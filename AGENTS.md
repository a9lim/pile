# AGENTS.md

Part of the **a9l.im** portfolio. See root `AGENTS.md` for the shared design system, head loading order, CSS conventions, and shared code policy. Sibling projects: `geon`, `shoals`, `gerry`, `cyano`, `scripture`, `miasma`.

## Rules

- Always prefer shared modules (`shared-*.js`, `shared/base.css`) over project-specific reimplementations. UI code uses shared via `window.*` globals. **Physics code stays UI-decoupled** — keep small helpers (e.g. inline `clamp`) in physics modules so they run cleanly under node for unit testing.
- Do not manually test via browser automation. The user tests changes themselves.
- For wave order and known-deferred items, see `HANDOFF.md`.

## Running Locally

```bash
cd path/to/a9lim.github.io && npm run build && python -m http.server --directory dist     # static-only
cd path/to/a9lim.github.io && ./dev.sh                  # full Worker behavior
```

`/pile/` uses absolute paths to shared modules. For node-side physics checks, write a throwaway `test_sim.mjs` at the project root that imports `./src/state.js` + `./src/sim.js` and runs `advanceSim` (never bare `step` — it skips adaptive substepping). Delete after use.

The permanent regression surface is the twelve `test_*.mjs` files listed under **Files**. Run all of them after changes to shared state, orchestration, reactor-type configuration, or inspector bindings; run the relevant type-specific subset for narrowly isolated work.

## Overview

Semi-realistic nuclear reactor simulator. Three reactor types selectable from the left rail:

- **PWR** — 3411 MWth Westinghouse-class, U-tube SG, soluble boron control, ~2 s scram
- **RBMK-1000** — 3200 MWth graphite-moderated, boiling water in pressure tubes, direct cycle, **two-loop Main Circulation Circuit** (left/right core halves, MCPs + suction-cavitation derate), **positive void coefficient at low power**, **graphite-tipped rods with positive lower-section reactivity**, ~18 s scram
- **MSR** — 8 MWth MSRE-class, fuel dissolved in FLiBe salt, **circulating delayed-neutron precursors** (partial decay outside core), coolant-salt loop to an **air-cooled radiator + blower** (MSRE-accurate — no turbine/generator; blower speed is the power-control actuator), **freeze-plug** passive drain + freeze-protection heaters, **off-gas Xe-135 removal**, sealed reactor cell, online redox/corrosion chemistry, very strong Doppler

Shared physics engine: 1D axial point-kinetics, 6 delayed-neutron precursor groups per node, lumped fuel/clad/coolant thermal-hydraulics with axial enthalpy walk, I-135/Xe-135 chain, burnup-dependent coefficients, 11-group ANS-5.1 decay heat, IAPWS-IF97 saturation, and a reactor-protection / warning-channel network. Reactor-type swap is live (no reload) via a state-holder pattern.

## Architecture

**`main.js`** — entry point. Caches DOM into `$`, creates the **`SIM = { state: createState('pwr') }`** holder, builds the schematic / inspector / axial+stack canvases / annunciator, wires the toolbar (theme / play-pause / speed / step / reset / about / audio / scenarios) and the left-rail reactor-type selector + SCRAM, runs the rAF loop, renders left-rail readouts (`renderRail`). **All UI references go through `SIM.state`** so the type selector can swap state in place without re-binding listeners.

**`src/state.js`** — `createState(reactorTypeId)` returns the full mutable state: 1D arrays (`flux`, `precursors[g]` 6×N, `T_fuel`, `T_coolant`, `T_graphite`, `voidFrac`, `qualityFrac`, `xenon`, `iodine`), the per-node critical-by-construction references (see below), lumped scalars (`pressurizerP`, `sgSecondaryP`, `sgSecondaryLevel`, `intermediateLoopT`, `containmentP`), 11 ANS-5.1 decay-heat groups at full-power equilibrium, the `state.cmd.*` command queue, and the `autoRod` block. PWR-only blocks (`rcsMassKg`, `eccs`, `rcpSeal`, `cvcs`, `edgs`, `electrical`, `ccw`, `afw`, `containment`, `sfp`, `feedwaterPumps`, `sgTubes`, `turbine`) are allocated here and set `null` for RBMK/MSR; `feedwater` is PWR+RBMK. RBMK owns `rbmkElectrical`, `rbmkEccs`, `rbmkAls`, and `rbmkAux`; MSR owns `msrRadiator`, `msrPumpBowl`, `msrOffGas`, `msrCell`, and `msrChem`. **`loops` exists for PWR (1 collapsed loop) and RBMK (2-loop MCC), and is `null` for MSR.** The RBMK loop object is direct-cycle-shaped (`drumPressureMPa`/`drumLevel`/`suctionSubcoolK`/`cavitating`/`standbyPumpAvailable` instead of the PWR SG fields). Default startup is hot full-power equilibrium, not clean-core.

**`src/integrator.js`** — `advanceWithBudget(state, wallDt, step)` runs adaptive substeps toward `wallDt × accel` of sim time; `pickDt` sizes substeps from prompt-mode reactivity scale and current period. Max 256 substeps/frame; overflow carries in `state._simTimeDebt` and `state._lastAdvancedSimDt` reports the actual advance. **Always call `advanceSim`, never bare `step`** — `step` bypasses adaptive substepping and explodes on stiff prompt modes.

**`src/sim.js`** — orchestrator. One step: reset accumulators → RPS → autopilot → circulation → PWR electrical/EDGs → RBMK electrical/ECCS/ALS/auxiliaries → MSR auxiliaries → common PWR support systems → neutronics → modes → thermal → DNBR → xenon → burnup → RCP seals → PWR ECCS → SG tubes → pressurizer → containment → AFW → feedwater pumps/heaters → plant → turbine → detectors → readouts → `buildReactivityStack`. RCP-seals / ECCS / SGTR before pressurizer (leak/inject/level coupling) and containment after the release accumulators are load-bearing orderings.

### Critical-by-construction

Initial state is critical with zero net feedback at t=0. The mechanism: every operating inventory that contributes reactivity is snapshotted **per node** at init and the snapshot is subtracted from the live value, so a realistic full-power start injects no static ρ.

- **Reference temperatures** `Tf0Ref` / `Tc0Ref` / `Tg0Ref` — Float64Array[N] of initial `T_fuel` / `T_coolant` / `T_graphite`. Doppler and moderator coefficients integrate from these (`α · (T[k] − Ref[k])` per node).
- **Per-node ρ snapshots** `rodRhoInit` / `xenonRhoInit` / `voidRhoInit` / `burnupRhoInit` — Float64Array[N], subtracted from the live rod / xenon / void / burnup contributions in `computePerNodeReactivity` and `buildReactivityStack`.
- Rods start at `initialRodFrac` (PWR 0, RBMK 0.85, MSR 0.1); boron at `boronInitialPpm` where defined; xenon/iodine at equilibrium; burnup at `initialBurnupMWdPerTU`; RBMK direct-cycle void/quality from `stepMultichannel`.
- Equilibrium precursors are built with the burnup-scaled β so the prompt-α subtraction and the delayed source agree at non-zero BU.

**All of these MUST be per-node Float64Array, never a scalar offset.** A flux-weighted scalar only cancels for the *initial* flux shape; after one substep flux redistributes and the residual leaks back in as spurious feedback → edge-node prompt-supercriticality → flux runaway. This bug family has bitten `Tf0Ref`, `rodRhoInit`, and `burnupRhoInit`. Reactor-type swap rebuilds all reference arrays from the new state. **Don't change this without re-deriving the reference scheme.**

### `src/physics/`

- `autopilot.js` — LAR-style auto-rod controller. Pure P-control on reactivity + power error, ρ-demand clamped ±200 pcm, rate-limited at `T.rodSpeed · servoMultiplier`. Writes both `state.rodBanks.regulating` (direct) and `cmd.regulatingTarget` (UI mirror). No-op on scram or `autoRod.enabled = false`; `rps.js` clears `enabled` on scram-fire (user re-arms after reset). PWR + RBMK default ON, MSR OFF (huge Doppler self-regulates; closed-loop overdrives → power explosion → Doppler-clamp oscillation).
- `neutronics.js` — **semi-analytical** per-node update (not RK4). Per substep with locally-constant ρ_k, S_k: `n_k(t+dt) = n_k·e^(α·dt) + (S_k/α)·(e^(α·dt)−1)`, α = (ρ_k−β)/Λ − 2D/dz², S = Σλ_g·C_{g,k} + (D/dz²)(n_{k−1}+n_{k+1}). Unconditionally stable. Precursors: analytical decay + trapezoidal-mean source. MSR adds upwind precursor advection + a 20 s delay-line ring buffer for top-of-core precursors returning at the bottom (decayed by `exp(−λ_g·τ_external)`). Co-scales the prompt-α subtraction AND the per-group precursor source by `betaScale(buAvg)`. The photoneutron source (`T.photoneutronYield`, ∝ decay heat) is always-on — see Gotchas.
- `thermal.js` — per-node fuel/coolant (PWR/RBMK) or merged fuel-in-coolant (MSR). Upwind axial enthalpy advection; semi-implicit decay-heat groups. Void via the channel-walk enthalpy balance (see Key Conventions). RBMK direct-cycle void is delegated to `multichannel.js`; PWR/MSR use the inline channel-walk path.
- `multichannel.js` (II.7) — parallel-channel TH, RBMK only. Hot lump (5% of channels, 1.7× peaking) + avg lump (95%) share plenum pressure; per-substep ΔP-balance bisection finds the flow split. Per-pipe ΔP = friction (quadratic in m_per_pipe) + gravity; friction calibrated against per-pipe design flow (1661 channels, ≈6.3 kg/s/pipe nominal). 16-point residual sampling detects Ledinegg multi-root → `out.ledineggUnstable`, picks the lowest-flow root for the hot channel. Per-channel state blends back to `state.T_coolant` / `voidFrac` / `qualityFrac` with `wHot = 0.05`; chf.js reads hot-channel quality.
- `xenon.js` — normalized I/X chain (1 = full-power equilibrium). MSR off-gas adds a sink at `T.xenonOffGasRateS`.
- `plant.js` — PWR (3-element FW regulation, AFW intake, MSIVs, ADVs, condenser bypass), RBMK (direct cycle, steam mass flow from thermodynamic quality, **per-loop drum-separator level control** — Wave B: a 3-element-style controller per loop whose feedwater feedforward = turbine steam draw apportioned by loop flow, so total feedwater == `turbineSteamFlow` at init and the `_coolantReturnT` blend is unchanged; writes the aggregate min drum level to `state.sgSecondaryLevel`), MSR (intermediate loop + freeze-plug drain / drain-tank decay heat). PI valve controller closes the loop from grid load demand. PWR primary→SG heat transfer is flow-weighted and enthalpy-limited so stagnant loops don't transfer design UA heat.
- `rps.js` — SCRAM trips + warning/status annunciators. `TRIP_LABELS` is the label source of truth; only `SCRAM_TRIPS` keys fire scram. On scram-fire also zeroes `cmd.gridLoadTarget` / `cmd.turbineValveTarget` and slams the valve shut at 0.5/s (see Key Conventions — the turbine trip is what makes scram subcritical).
- `reactor-types.js` — per-type coefficient packs. RBMK `alphaVoid` is a function of `powerFrac` (positive low, negative high). RBMK rod-worth shape is signed — −0.16 graphite zone, +4.80 boron zone (× negative `rodTotalWorth`; peak graphite-tip at rod=0.643 gives ~+615 pcm). Per-type: `initialRodFrac`, `initialBurnupMWdPerTU` (PWR 18000 = MOC, RBMK 10000 = MOC, MSR 0 = continuously-refueled), `rcpCoastdownTauSec` (10/30/5 s), `naturalCircCoeff` (0.044/0.042/0.0096), `autoRod` block.
- `burnup.js` (II.1) — per-node burnup accumulator + piecewise-linear scalings (5 anchors: 0/5/15/30/45 kMWd/tU) for β_eff, Doppler, ν·Σ_f, and an additive excess-ρ. Exports `stepBurnup`, `coreAverageBurnup` (unweighted axial mean — conserves the bulk energy balance), `cycleLabel`, `betaScale`, `dopplerScale`, `nuFissionScale`, `excessRhoPcm`, `fuelMassTU`.
- `circulation.js` (II.3 + III.1) — three-regime primary mass-flow model. Computes `m_forced`, `m_coast`, `m_nc`; **`m_total = max(m_forced + m_coast, m_nc)`** — dominant driver wins, never additive. Regime label (`state.out.flowRegime` ∈ {`forced`, `transition`, `natural`}) uses a 1.5× dominance margin; physics always uses the max. Consumers read `state.out.flowMassRateKgPerS` / `flowFracOfNominal`, not the command scalar. Per-loop path (`stepCirculationMultiLoop`) runs when `state.loops` exists (PWR + RBMK); total flow = Σ loop flows. **RBMK adds an MCP suction-cavitation derate** (gated on `T.mcpCavitationModel`): `suctionSubcoolK = tSat(drumP) − returnT`; below `T.mcpCavitationSubcoolK` the loop's forced flow derates to a 0.2 floor over an 8 K span. Identity (derate 1.0) at the ~11 K subcooled design point.
- `pressurizer.js` (III.2) — Westinghouse dynamic pressurizer, **PWR-only** (RBMK/MSR early-return; `state.sgSecondaryP` stands in for RBMK drum pressure). Owns heaters, spray, PORV / stuck-open / block valve, code safeties, PRT, surge dynamics, level, pressure. Integrates `state._rcsExternalFlowKgPerS` (net seal leak + ECCS + SGTR) into `state.rcsMassKg`.
- `rcp.js` (III.4) — Westinghouse RCP shaft-seal LOCA, **PWR-only**. NRC SECY-93-087 "21-21-21" three-stage staged-failure clock; stages advance only when BOTH seal injection (CVCS) AND thermal-barrier cooling (CCW) are unavailable — either alone keeps the accumulator drained. Above-normal leak → `_rcsExternalFlowKgPerS` (negative) + containment accumulators. Trips: `sealLoca` (SCRAM, stage 2+), `sealCoolingLost` (WARNING).
- `eccs.js` (III.5/6) — ECCS with RWST inventory + sump-switchover, **PWR-only**. Four paths through one `stepEccs`: HHSI, LHSI, passive accumulators, RHR. Motor paths gated by `state.electrical.acAvailable` / `state.edgs.eccsBusEnergized`. Operator switches `cmd.eccsSuctionSource` (`'rwst'` / `'sump'`); NPSH loss is reversible for pedagogy. Injection → `_rcsExternalFlowKgPerS`.
- `modes.js` (II.4) — modal expansion: 4 quadrant amplitudes (sum-conserved at 4.0) + 1 radial skew scalar (clamped ±0.3), each driven through a relaxation ODE by operator asymmetry commands. PWR + RBMK only. Feeds `out.modalPeakingFactor` / `out.localPowerPeakFrac` into high-flux / DNBR safety calcs (a surrogate, not a full radial mesh).
- `cvcs.js` (III.3) — Chemical & Volume Control, **PWR-only**. `chargingPumpCount` centrifugal charging pumps (pump 0 duty, rest standby on SI cross-trip / manual). Seal-injection branch sets `state.cvcs.sealInjectionAvailable` (consumed by rcp.js). Letdown gated on CCW (HX would boil dry without a heat sink; FSAR 9.3.4.2.4). Boric-acid blender with VCT τ ≈ 5 min; operator commands `cmd.cvcsBoronTargetPpm` + `cmd.cvcsMode` ∈ {auto, dilute, borate, makeup}; mirrors `cmd.boronTarget` for legacy consumers. WARNING: cvcsLoss, letdownIsolated.
- `edgs.js` (III.14) — `edgCount` Class 1E Emergency Diesel Generators (1× 9000 kW), **PWR-only**. 10 s start delay; ECCS bus energized at +35 s of the load sequencer. Per-EDG fuel/jacket/lube state; faults via `cmd.edgFault[i]` ∈ {none, fuel, jacket, lube, governor}. Sets `state.edgs.eccsBusEnergized`. WARNING: edgRunning, edgFailure, lowFuelOil.
- `electrical.js` (III.15/16) — Class 1E DC distribution + vital-AC inverters + grid coupling, **PWR-only**. 4× 250 V battery banks (linear 250→200 V). AC up iff offsite OR (≥1 EDG + ≥1 bank > 5%); DC up iff ≥1 bank > 5%. 4 inverters → `vitalAcAvailable` survives a station blackout on battery. Switchyard undervoltage relays (loss-of-voltage < 0.25 PU, degraded < 0.90 PU) latch `cmd.lossOfOffsitePower = true`. **`stepElectrical` runs before `stepEdgs`** (one-step lag, intentional). WARNING: batteryLow, batteryDepleted, degradedGridVoltage, vitalAcLost.
- `aux-cooling.js` (III.19) — Component Cooling Water + Service Water, **PWR-only**. 1× CCW pump (750 kg/s) + 1× SW pump (1500 kg/s), AC-powered. Lumped CCW outlet-T dynamics; hot-leg warning at 50 °C. Sets `state.ccw.available` (consumed by rcp.js + cvcs.js). WARNING: lossCcw, lossSw, ccwHotLeg.
- `afw.js` (III.8) — Auxiliary feedwater, **PWR-only**. 2 trains: MDAFW (AC) + TDAFW (steam-powered, AC-independent — the SBO heat sink). Per-train per-SG MOVs via `cmd.afwMovOpen` (`2 × loopCount`, index `trainIdx·nSG + sgIdx`, train 0 = MDAFW, 1 = TDAFW). Auto-start latched on low SG level / LOOP / SI / main-FW trip. **TMI-2 hook**: closing every train's MOVs makes AFW signal but deliver no flow → `afwLowFlow` latches at +30 s. Runs before `stepPlant`. WARNING: afwActuated, afwLowFlow, tdafwUnavailable.
- `steam-tables.js` (I.8) — IAPWS-IF97 water/steam properties. **UI-decoupled, no pile imports, node-testable** (`node src/physics/steam-tables.js` → 30-assertion self-test). Region 4 (`tSat` / `pSat`), Regions 1/2 Gibbs, the saturation-line set (`hf` / `hg` / `hfg` / `rhoF` / `rhoG` / `cpF` / `cpG`). `plant.js` / `thermal.js` / `multichannel.js` / `pressurizer.js` / `state.js` import `tSat`.
- `containment.js` (III.17) — PWR large-dry containment, **PWR-only**. Lumped single-region control volume: Dalton-law air+steam partial pressure, atmosphere energy balance, sprays (RWST-fed, AC, auto at Hi-3 0.17 MPa), fan coolers (CCW+AC). **Single owner of `containmentP` / `containmentT` after init** — consumes `_containmentMassInflowKgPerS` / `_containmentEnergyInflowWperS`. Runs after rcp/eccs/pressurizer. WARNING: highContainmentTemp, containmentSprayActuated (the highContainmentP SCRAM is unchanged).
- `sfp.js` (III.20) — Spent Fuel Pool cooling, **PWR-only**. Fixed ~5 MW stored-inventory decay heat (independent of reactor power), HX→CCW loop, AC pump. Loss of cooling → heatup → boil-off → `fuelUncovered` / `zircFireRisk`. Critical-by-construction (HX UA sized for dT/dt=0 at init). 5 WARNING trips, none SCRAM. Decoupled from the RCS.
- `feedwater-heaters.js` (III.10) — regenerative FW heater train, **PWR + RBMK**. Extraction-steam heater cascade; `state.feedwater.tempK` relaxes (τ ≈ 40 s) toward `condenserTemp + loadFactor·ΣdesignRise`. `cmd.fwHeaterInService[]` isolates stages. SG-energy coupling lives in `plant.js`: Qsg divided by `hFgEff = hFg + cpFw·(T_FW_design − T_FW)`, anchored so `hFgEff == hFg` at init. Runs before `stepPlant`.
- `feedwater-pumps.js` (III.11) — main FW + condensate pumps, **PWR-only**. 1× MFW + 1× condensate, large NON-safety loads (die on LOOP, not EDG-backed). Trip on electrical / operator / fault / NPSH (condensate below SG demand → cavitation, reversible). `afw.js` auto-starts on `!mfwAvailable`. Runs before `stepPlant`. WARNING: mfwLost.
- `sg-tubes.js` (III.12) — SG tube plugging + rupture, **PWR-only**, one entry per loop. Plugging degrades primary→secondary HT (`plant.js` scales htLoop, anchored at the 4% baseline). SGTR (`cmd.sgTubeRupture[l]`, latched) opens a `coeff·√(P_primary − P_sg)` leak ≈ 20 kg/s → `_rcsExternalFlowKgPerS`; self-limiting. Runs after `stepEccs`, before `stepPressurizer`. WARNING: sgtr.
- `turbine.js` (III.13) — staged turbine + synchronous generator, **PWR-only**. RBMK keeps its inline direct-cycle generator calculation; MSR deliberately reports zero generation because the MSRE-scale branch rejects heat through an air radiator. `mechPower = steam·availDrop·turbineEfficiency` (0.83, calibrated to 1150 MWe nameplate at design), split HP/LP by `hpWorkFraction`. Load rejection (`cmd.generatorBreakerOpen`) → swing equation → governor fast-closes the valve; `cmd.turbineGovernorFault` → runaway to the 110% `turbineOverspeed` SCRAM. Runs after `stepPlant`.

### `src/ui/`

Schematic-centric control board: left rail (type selector, core/reactivity glance, axial profile, reactivity stack, SCRAM), centre zoom/pan plant schematic, right rail (RPS annunciator + trend sparklines). Clicking a component opens a centred inspector dock. The old sidebar/tabs/gauges/mimic/faults UI is retired — those files are deleted.

- `registry.js` — **single source of truth for the schematic.** `buildRegistry(reactorTypeId)` → `{viewBox, zones, components, pipes}`. Each component carries geometry, a `kind`, an inline `readout(state)→string[]`, `tint` / `alarm` hooks, and a declarative inspector field list (types: `group` / `note` / `readout` / `bar` / `slider` / `toggle` / `button` / `modegroup`). Uniform grid via `makeGrid({x0,y0,cw,ch,gap})` (`cell` for rects, `sq` for circular kinds); `pipePath(points)` builds orthogonal pipe `d` strings. The live registries contain 17 PWR components, 13 RBMK components (two-loop MCC, drum, ELEC/DREG, ECCS, ALS, gas circuit, CPS cooling, MFW, turbine island), and 10 MSR components (radiator/blower, off-gas, reactor cell, chemistry, drain path). Keep cells non-overlapping — `test_registry_smoke.mjs` checks every getter + a component-overlap pass across all 3 types.
- `schematic.js` — registry-driven SVG renderer. Builds zones/pipes/components once per type; zoom/pan via the shared `createCamera`; a click with <5 px movement selects. Per frame: flow-marquee `stroke-dashoffset`, temperature recolor (`--coolant-cold`→`--coolant-hot`), inline readouts, alarm pulse, selection highlight. `kind:'core'` renders a 13×13 fuel-assembly map recoloured from a synthesized radial power map. **`buildShape(def)` dispatches a per-`kind` silhouette** (pump=volute circle, generator=circle+terminal box, turbine=tapered trapezoid, valve=bowtie, drum=horizontal cylinder, radiator=finned bank, hx=shell+tube lines, tank=squat rounded, vessel=domed-top): the primary fillable element stays `shapeEl` (tint/alarm/select keyed on `.sch-shape`); stroke-only `.sch-detail` accents overlay. Add a new kind here + assign it in `registry.js`. Theme-swap flushes the cached RGB palette via `MutationObserver`.
- `inspector.js` — single-slot component inspector. `show(def)` builds the declarative field list into a centred modal dock; `update(state)` refreshes per frame. Control handlers close over the `SIM` holder → write to live `SIM.state.cmd`. ✕ / Esc closes. Locked sliders (rod bank in AUTO) mirror the live value.
- `format.js` — shared value formatters (`FMT`) + severity-colour helpers (`COL`, `band`, `bandLow`, `peak`).
- `axial.js`, `stack.js` — left-rail canvas renderers (axial flux/temp/xenon profile, reactivity stack). Use `window.resizeCanvasDPR`.
- `annunciator.js` — right-rail RPS trip-light grid. Built with `replaceChildren()` + DOM methods (the innerHTML hook blocks raw HTML assignment in new files).
- `period-audio.js` (I.10) — WebAudio period-meter count-rate channel. Off by default; AudioContext created lazily in the toggle handler (autoplay-safe). `initPeriodAudio($, SIM)` bound once in main.js; `updatePeriodAudio(state)` per frame.
- `scenarios.js` — guided-scenario picker overlay + live objectives HUD. Scenario definitions live in the top-level `scenarios/` directory.
- Right-rail trend sparklines (fission, peak fuel, xenon worth, axial offset) use shared `createSparkHistory` / `pushSparkSample` / `drawSparkline`; samples pushed every 0.1 s sim time. Axial offset (`out.axialOffset = (P_top − P_bot)/(P_top + P_bot)`, recomputed in `sim.js::updateLoopOutputs`, boundary at `floor(N/2)`) uses a custom `renderSparkAo` in `main.js` — fixed y-range [−0.2, +0.2] with a dashed ±5% LCO 3.2.4 band overlay (shared `drawSparkline` auto-scales, which would slide the band off-canvas).

## Reactor-type swap

`_forms.bindModeGroup` on `#reactor-type-toggles` drives `rebuildState(newType)` in `main.js`:

```js
SIM.state = createState(newType);   // replace state in place
schematic.rebuild(SIM.state);       // rebuild the SVG from the new registry
inspector.close();                  // drop any open inspector
```

Render functions take `SIM.state` per frame and inspector handlers close over the `SIM` holder, so both stay correct across the swap. Sparkline buffers reset on swap.

## Color Tokens (`colors.js`)

`colors.js` maps the shared palette to reactor-physics roles:

- `--neutron` (blue) — flux profile
- `--gamma` (green) — decay heat / activation
- `--coolant-cold` / `--coolant-hot` — pipe temperature ramp
- `--fuel` (rose) — fuel temp
- `--steam` (purple)
- `--scram` (rose) — SCRAM button + RPS trips
- `--r-pos` / `--r-neg` — reactivity sign (engineering convention: positive ρ is unsafe → red)
- `--r-rod`, `--r-boron`, `--r-xenon`, `--r-doppler`, `--r-moderator`, `--r-void` — reactivity stack components

## Key Conventions

### Units
- reactivity in **pcm** (10⁻⁵) for display; internal is the absolute fraction
- power in MWth (core) / MWe (generator)
- time in seconds; xenon/iodine in **normalized atoms** (1 = peak full-power equilibrium)
- temperature in **K** internally, °C for UI

### Time acceleration
`state.accel ∈ {1, 10, 60, 600, 3600, 36000}×`. The integrator auto-tightens substeps during fast transients regardless of accel, so high accel is safe for slow phenomena (xenon transients) but won't ride through prompt jumps.

### Reactivity stack
Built additively in `buildReactivityStack`, flux-weighted across nodes; physics uses the per-node values from `computePerNodeReactivity`. Never assemble ρ at multiple sites. The critical-by-construction references are documented under Architecture.

### Boron
PWR has `boronInitialPpm: 1200` and `boronWorthPcmPerPpm: -0.011`; RBMK/MSR set neither. `computePerNodeReactivity` and `buildReactivityStack` MUST use `?? 0` fallbacks — otherwise `(0 − undefined) · undefined = NaN` cascades through the stack and kills flux. Boron drive is slow and flow-limited: the slider commands the CVCS blender target; actual soluble boron follows with the VCT residence-time lag and only moves when charging flow is available. The delay is realistic, not a bug.

### Turbine trip on scram
`rps.js` zeroes `cmd.gridLoadTarget` / `cmd.turbineValveTarget` on scram-fire and force-closes `state.turbineValve` at 0.5/s while scram is active. This is what makes scram actually subcritical — otherwise the over-extracting SG over-cools the primary, the moderator coefficient compensates rod insertion, and the reactor settles at low-power critical.

### Channel-walk void model (RBMK / BWR direct cycle)
```
h_local = h_in
for k = 0..N-1:
  Q_node = (P_fission + P_decay) · φ[k] / Σφ
  h_local += Q_node / mass_flow
  quality = max(0, (h_local − h_sat) / hFg)
  α = quality / (quality + (1−quality)·slip·ρ_g/ρ_f)
  voidFrac[k] = clamp01(α)
  if h_local > h_sat: T_coolant[k] = T_sat   (pin)
```
Slip ratio 2, ρ_f 740, ρ_g 35 kg/m³ at ~7 MPa.

### Saturation curve — IAPWS-IF97 (I.8)
`physics/steam-tables.js` is the single source of truth for water/steam properties. `plant.js` / `thermal.js` / `multichannel.js` / `pressurizer.js` / `state.js` import `tSat` (state.js aliases it `saturationTempK_init` for pressurizer init — still IF97). The old kPa-form Antoine (three duplicate definitions) is retired — **do not re-add a local `saturationTempK`.** The `hFg = 1.5e6` literal and the `RHO_F = 740` / `RHO_G = 35` slip densities are calibration anchors, deliberately NOT IF97-swapped; `steam-tables.js` exposes the true values for a future re-verification.

### Scram speed
Reactor-type-specific: PWR 0.5/s (~2 s full insertion), RBMK 0.05/s (~21 s — the slow scram is part of why Chernobyl happened), MSR 0.1/s.

## Gotchas

### Will cause bugs

- **`SIM.state` is the live holder.** Functions outside `main.js` take `state` as a parameter, never capture from module scope — the reactor-type selector replaces `SIM.state` wholesale.
- **Inspector control handlers read `SIM.state.cmd` at call time, not bind time.** `inspector.js` rebuilds the dock DOM per selection; `set` / `onClick` handlers close over the `SIM` holder and deref inside, so a type swap stays correct.
- **`advanceSim`, not bare `step`.** `step` is the internal physics tick; direct user code (tests, scenarios) must go through `advanceSim` for adaptive substepping.
- **Decay heat continues for hours after scram.** At full power, total core heat is nominal (prompt-equivalent + equilibrium decay), not `fission + decay` double-counted. After scram `out.decayHeatMW` is the residual source.
- **RBMK positive void coefficient is low-power-only.** Default full-power startup is near-steady; the Chernobyl mechanism is explored by driving low-power / low-ORM / high-void states, not by relying on an unphysical startup overshoot.
- **MSR `alphaVoid` is 0** (single-phase salt) but the type still goes through `computePerNodeReactivity`, which dereferences it — both scalar (0) and function forms are handled via `typeof alphaVoid === 'function'`.
- **Auto-rod writes `state.rodBanks.regulating` directly**, bypassing `stepRps`'s rate-limited servo. It has its own limit at `T.rodSpeed · servoMultiplier`; `stepRps`'s drive-toward-target no-ops because the autopilot also writes `cmd.regulatingTarget`.
- **Live mass flow is `state.out.flowMassRateKgPerS`, NOT `T.coolantMassFlowKgPerS · state.coolantFlowFrac`.** Anything in `thermal.js` / `plant.js` needing flow reads `state.out` (legacy expression only as a defensive fallback). Forgetting this means natural-circulation regimes don't drive thermal — pumps "off" but fuel still cools at full rate.
- **The photoneutron source is always-on, not init-cancelled.** Zeroing it at init would also zero it post-scram, defeating SR-detector persistence; a constant source rate doesn't algebraically cancel against a constant ρ offset through the (ρ−β)/Λ kinematics. Accept the few-pcm init bias.
- **`multichannel.js` writes per-channel AND blended state.** Hot/avg lumps populate temperature/void/quality, then blend back to canonical `state.T_coolant` / `voidFrac` / `qualityFrac` (`wHot = 0.05`). Reactivity / schematic / axial read the blend; CHF/DNBR reads hot-channel quality.
- **Multichannel friction is per-pipe, not per-lump.** Both lumps share `K_fric_per_pipe` (1661 geometrically identical tubes; parallel channels each see one channel's ΔP). Calibrating per-lump friction against `m_des_hot` / `m_des_avg` makes the hot K ~350× the avg and kills the Ledinegg shape. Calibrate against `m_per_pipe_design`.
- **`state.pressurizerP` is owned by `pressurizer.js` after init** — outside writes get clobbered next step. Exceptions: reset / type-swap (`createState`) and deliberate scenario/test P-jumps. RBMK/MSR have no `T.pressurizer`, so the static value persists.
- **`pressurizerLevel < 0.17` fires the heater lockout AND the `lowPzrLevel` scram together** — intentionally aligned (uncovered heater elements burn out; once scrammed the heaters are useless anyway). Don't decouple without considering the failure mode.
- **`state._tAvgPrev` is the surge integrator's backward-difference base**, init to design tAvg so dT_avg/dt = 0 at t=0. `pressurizer.js` reads and writes it each step — don't reset it independently of an actual T_avg change or you inject a fake surge spike.
- **RCS inventory moves through the `state._rcsExternalFlowKgPerS` accumulator**, not direct `pressurizerWaterMass` writes. `sim.js` resets it each step; `rcp.js` adds −leak, `eccs.js` / `sg-tubes.js` add ±flow, `pressurizer.js` integrates the net into `state.rcsMassKg`. Nothing else writes `pressurizerWaterMass` or `rcsMassKg` (both `null` for RBMK/MSR).
- **`cmd.sealInjectionForced` is tri-state.** `null` = use the model coupling (`state.cvcs.sealInjectionAvailable`, else the legacy `!cmd.lossOfOffsitePower` fallback); `true` / `false` = hard override. `null` and `false` are semantically different — not a plain bool.
- **`cmd.eccsSuctionSource` is a string** (`'rwst'` / `'sump'`), not a bool. `eccs.js` does NOT auto-switch when the RWST empties — that's the operator's job; forgetting cavitates the pumps and latches them off via the NPSH machinery (pedagogically-faithful TMI-2-era behavior).
- **EDG / electrical state is the AC-availability hook.** During LOOP, motor-driven safety pumps read `state.electrical.acAvailable` / `state.edgs.eccsBusEnergized` when those blocks exist. `cmd.edgsCarryingEccs` is a legacy hard override for models without the electrical block. Accumulators are passive.
- **`electrical.js` latches `cmd.lossOfOffsitePower = true`** via the switchyard undervoltage relays — physics writing a `cmd` field deliberately, so a grid-voltage collapse looks like a LOOP to every downstream consumer. The relay only latches TRUE; clearing is manual. If LOOP latches "spontaneously", check `cmd.gridVoltagePU`.
- **`state.loops` is the per-loop truth for PWR and RBMK; MSR has no loop array.** `plant.js` writes compatible aggregate scalars such as `sgSecondaryP` / `sgSecondaryLevel` so shared RPS/readout paths stay stable. Drive PWR/RBMK loop flow and isolation through `cmd.rcpRunning[l]` / `cmd.loopIsolated[l]`; do not infer that a non-PWR loop carries PWR steam-generator fields.
- **NPSH latch is reversible** — `pumpAvailable` returns when suction recovers. Real plants damage the impeller permanently; for pedagogy it comes back. For an irreversible model, latch `pumpAvailable = false` directly and document.
- **The accumulator N₂-kicker threshold is hard-coded `minInventoryBeforeIsolateM3 = 1.0 m³`** — below it the check valve closes to block N₂ ingestion; `flowing` stays false thereafter even if gas pressure still exceeds RCS P.
- **Per-subsystem state blocks are owned by their physics modules after `createState` returns** — `eccs`, `rcpSeal`, `modes`, `cvcs`, `edgs`, `electrical`, `ccw`, `afw`, `containment`, `sfp`, `feedwater`, `feedwaterPumps`, `sgTubes`, `turbine`, plus `containmentP` / `containmentT`. Nothing else writes them; scenario / test code sets the corresponding `cmd.*` knobs and lets physics latch consequences naturally (`rcpSeal.firstStageFailureTime` latches once and never resets — forensic readout).

### Do NOT re-add

- **Per-loop multichannel for the RBMK two-loop MCC.** The two RBMK loops are a *plant-side flow split* (left/right core halves); the core is still a single shared 1-D axial mesh. `multichannel.js` runs ONCE on the combined flow (`out.flowMassRateKgPerS` = Σ loop flows). Its `K_fric`/hot-lump calibration is anchored on the whole core (10500 kg/s, 1661 channels). Running it twice (per loop) halves the channel count + design flow per call, re-opens that calibration, and forces two separate void/quality reference snapshots — breaking critical-by-construction. Loop asymmetry rides on the per-loop *flow* (and later per-drum state), never on two void meshes.
- **RK4 in neutronics** — unstable on long quasi-equilibrium runs (single-node prompt-supercriticality after ~500 substeps). The semi-analytical step is correct.
- **Reservoir excess-enthalpy void model** — boils 100% of coolant mass per substep in upper nodes. Use the channel-walk balance.
- **Scalar reference temps / scalar ρ offsets** for Doppler-moderator, nonzero initial rod position, or burnup — flux redistribution leaks through scalar cancellation. Use per-node Float64Arrays (see Critical-by-construction).
- **Flux-weighted core-average burnup** for `out.coreBurnupAvg` — use the unweighted axial mean; it conserves the bulk energy balance ΔBU_avg = P_fis · dt / fuelMTU frame-by-frame.
- **Single quartic fit for the burnup anchor table** — keep the five piecewise-linear anchors; recalibration stays one-line.
- **Original RBMK rod-worth signs** (`+0.35` graphite, `−1` boron) — both backwards. Current `−0.16` / `+4.80` (× negative `rodTotalWorth`) give the right physical sign.
- **MSR `autoRod` enabled by default** — closed-loop control drives the rod fully out → power explosion → Doppler-clamp oscillation, worse than open-loop. Defaults OFF.
- **The wave-1 hand-tuned SG-level mass balance** — oscillated enough to fire both level trips during normal startup. The III.7 3-element controller (steam-flow feedforward + level-PI master + first-order valve lag) owns `sgSecondaryLevel`. Don't shorten the integral time below ~15 s (it'll chase the shrink/swell signature) and don't drop the feedforward.
- **`shortPeriod` trip on single-substep noise** — must be sustained ≥ 0.5 s AND `avgFlux > 1.02`.
- **DNBR trip with `> 350 K` ΔT** — design steady state has peak ΔT ≈ 770 K; current threshold is 1100 K.
- **`window.clamp` / `window.resizeCanvasDPR` inside physics modules** — physics is UI-decoupled for node testability; only UI code touches `window.*`.
- **Additive sum of forced + natural circulation** — the dominant driver wins (`max(m_forced + m_coast, m_nc)`). Adding them over-flows the regime handoff and inflates forced-regime flows ~10-20%.
- **Photoneutron init-cancellation via a constant ρ offset** — it doesn't algebraically cancel (see the always-on note above); zeroing it at init drops the post-scram SR detector to its floor.
- **Fixed-point iteration for the DC↔EDG dependency** — `stepElectrical` first (reads previous-step `edgs.runningCount`), `stepEdgs` second (reads this-step `electrical.dcAvailable`). One substep of "AC lost" on a fresh LOOP is acceptable; iteration thrashes on the integrator boundary.
- **Direct boron scalar slew** — III.3 replaced it with the CVCS makeup-blender + VCT model. `cmd.cvcsBoronTargetPpm` is the knob; `cmd.boronTarget` is mirrored for legacy consumers (don't remove the mirror until all consumers migrate).
- **Bulk-mean folded into the per-quadrant modal targets before the gain** — uniform `cmd.quadrantTiltPcm` produces no tilt; the mean is subtracted before applying `gainAz`.
- **Per-quadrant writes that bypass the modes.js sum-4.0 re-normalize** — `modes.js` re-normalizes every substep to conserve fundamental power; bypassing it leaks power into/out of the modal basis.
- **Un-anchoring the III.10–13 design-point coefficients** — `hFgEff = hFg + cpFw·(T_FW_design − T_FW)` (III.10), the SG-tube degrade `(1−plugged)/(1−baseline)` (III.12), and the turbine `turbineEfficiency` (III.13) are each identity at the design point (critical-by-construction). The III.11 MFW pumps are sized to the SG model's actual ~2300 kg/s full-power flow, NOT the `designFwKgPerS` config figure (1880).

### Semantic traps

- **Reactivity dollars** = ρ/β. β is type-specific (PWR/RBMK Keepin U-235 = 0.0065; MSR U-233 set = 0.0042).
- **MSR Doppler is huge** (~−110 pcm/K vs PWR's −2.8) — fuel expansion drops fissile density immediately.
- **Decay heat at t=0 after shutdown is ~6.7%** of operating power — use the `DECAY_HEAT_COEFFS` fit, not the textbook 7% round-up.
- **Period readout** comes from the per-substep log-flux derivative — it flickers on very long periods / near zero crossings; the UI shows `∞` when `|period| > 1e6`.
- **CVCS letdown auto-isolates on loss of CCW** — no operator action needed (the letdown HX would boil dry without a heat sink; FSAR 9.3.4.2.4). A loss-of-CCW scenario takes out boration/dilution AND seal injection together, since both flow through the CVCS.
- **MSIV closure halts all turbine steam flow** (`generatorMWe → 0`) but ADVs and condenser bypass tap upstream of the MSIVs and keep draining the SG — after closure the SG must vent through one of them to relieve decay-heat pressure rise (the ATWS "secondary heat sink loss" mode).

## Files

```
pile/
  index.html, main.js, colors.js, styles.css, og-image.webp
  AGENTS.md, CLAUDE.md (= @AGENTS.md), README.md, HANDOFF.md, about.md, LICENSE
  test_round5.mjs, test_round6.mjs, test_round7.mjs, test_audit_fixes.mjs
  test_rbmk_wavea.mjs (two-loop MCC), test_rbmk_waveb.mjs (drum-level + electrical/DREG + ECCS + ALS),
  test_rbmk_wavec.mjs (gas/CPS/MFW aux), test_rbmk_waved.mjs (fault deck + pipe break),
  test_msr_wavea.mjs (air radiator), test_msr_waveb.mjs (off-gas + cell), test_msr_wavec.mjs (chemistry),
  test_registry_smoke.mjs (getter + overlap, all 3 types)
  src/
    state.js, integrator.js, sim.js, reactor-types.js
    physics/  neutronics, thermal, xenon, plant, rps, autopilot, detectors,
              chf, burnup, circulation, multichannel, pressurizer, rcp, eccs,
              modes, cvcs, edgs, electrical, aux-cooling, afw, steam-tables,
              containment, sfp, feedwater-heaters, feedwater-pumps, sg-tubes, turbine,
              rbmk-electrical, rbmk-eccs, rbmk-als, rbmk-aux (RBMK B/C/D),
              msr-aux (MSR off-gas / cell / chemistry)
    ui/       registry, schematic, inspector, format, axial, stack,
              annunciator, scenarios, period-audio
  scenarios/  engine.js, index.js, load-follow.js, msr-overpower.js
```

## What's Wired to the Site

- The parent build stages this submodule at `dist/pile/`, so Workers Static Assets serves existing `/pile/*` files before the Worker. Parent `static/_headers` owns Early Hints and CDN caching.
- Canonical portfolio-card data lives in parent `content/projects/pile.md`; `tools/build.mjs` generates `dist/src/projects.js`, `.build/content.generated.mjs`, and the root ItemList JSON-LD from it.
- `about.md` is the canonical Pile SEO summary. The parent build synchronizes its metadata into the staged `dist/pile/index.html`, discovery files, and sitemap output without editing this submodule.
- Included in `sitemap-main.xml`, `llms.txt`, `llms-full.txt`, the root ItemList JSON-LD, and SPA prefetch rules after a root build.
- OG image: parent source `tools/og/pile.html` → `projects/pile/og-image.webp` (run `node tools/og/generate.js` from the parent).
