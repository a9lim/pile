// registry.js -- the per-reactor-type plant registry. Single source of truth
// for: schematic geometry (components, pipes, zones), the inline readouts each
// component shows on the diagram, its visual-state hooks (tint / alarm), and
// the declarative inspector field list rendered when the component is clicked.
//
// buildRegistry(reactorTypeId) -> { viewBox, zones, components, pipes }
//
// LAYOUT — every component is placed on a single uniform grid (makeGrid).
// Pipes route along grid-aligned waypoints (pipePath). Each reactor type is
// one plant; redundant parallel equipment (loops, EDGs, pumps) is collapsed
// to a single representative component, matching the collapsed physics.
//
// A component:
//   { id, kind, x, y, w, h, label, sub,
//     readout(state)->string[],  tint(state)->cssVar|null, alarm(state)->bool,
//     inspector: { title, fields: [...] } }
//
// Inspector field types (rendered by inspector.js):
//   group   {t,label}
//   note    {t,text}
//   readout {t,label,get(s)->str,color?(s)->cssVar}
//   bar     {t,label,get(s)->0..1,color?(s)->cssVar}
//   slider  {t,label,min,max,step,get(s)->n,set(s,n),fmt(n)->str,disabled?(s)}
//   toggle  {t,label,get(s)->bool,set(s,bool)}
//   button  {t,label,onClick(s),active?(s)->bool,danger?,label2?(s)->str}
//   modegroup {t,label,options:[{v,label}],get(s)->v,set(s,v)}

import { FMT, COL, band, bandLow, peak } from './format.js';
import { setAutoRod } from '../physics/autopilot.js';
import { manualScram } from '../physics/rps.js';

// ── Field-builder shorthands ────────────────────────────────────────────
const grp  = label => ({ t: 'group', label });
const note = text  => ({ t: 'note', text });
const ro   = (label, get, color) => ({ t: 'readout', label, get, color });
const bar  = (label, get, color) => ({ t: 'bar', label, get, color });
const sld  = (label, min, max, step, get, set, fmt, disabled) =>
  ({ t: 'slider', label, min, max, step, get, set, fmt, disabled });
const tog  = (label, get, set) => ({ t: 'toggle', label, get, set });
const btn  = (label, onClick, opts = {}) => ({ t: 'button', label, onClick, ...opts });
const modeg = (label, options, get, set) => ({ t: 'modegroup', label, options, get, set });

const onoff = v => (v ? 'ON' : 'OFF');
const availLost = v => (v ? 'AVAIL' : 'LOST');
const okCol = v => (v ? '' : COL.alarm);

// ════════════════════════════════════════════════════════════════════════
//  Layout grid
// ════════════════════════════════════════════════════════════════════════
//
// makeGrid returns a cell allocator + anchor helpers. Components occupy
// whole cells (or a centered square for circular kinds); pipes route
// through the gap channels between cells.
function makeGrid({ x0, y0, cw, ch, gap }) {
  const colX = c => x0 + c * (cw + gap);
  const rowY = r => y0 + r * (ch + gap);
  return {
    cw, ch, gap, colX, rowY,
    // full cell rect (optionally spanning cs cols × rs rows)
    cell: (c, r, cs = 1, rs = 1) => ({
      x: colX(c), y: rowY(r),
      w: cs * cw + (cs - 1) * gap,
      h: rs * ch + (rs - 1) * gap,
    }),
    // centered square — for circular kinds (pump / generator)
    sq: (c, r, frac = 0.6) => {
      const side = Math.min(cw, ch) * frac;
      return {
        x: colX(c) + (cw - side) / 2,
        y: rowY(r) + (ch - side) / 2,
        w: side, h: side,
      };
    },
    cx: c => colX(c) + cw / 2,
    cy: r => rowY(r) + ch / 2,
  };
}

// Build an SVG path string from a list of [x,y] waypoints (orthogonal).
function pipePath(pts) {
  return pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
}

// ════════════════════════════════════════════════════════════════════════
//  Shared inspector fragments
// ════════════════════════════════════════════════════════════════════════

// Core-physics readouts common to every reactor type.
function coreCommonReadouts() {
  return [
    ro('Fission', s => FMT.power(s.out.fissionPowerMW)),
    ro('Decay heat', s => FMT.power(s.out.decayHeatMW)),
    ro('Total Q', s => FMT.power(s.out.totalCorePowerMW)),
    ro('Reactivity', s => FMT.reactivityPcm(s.out.reactivityPcm),
       s => s.out.reactivityPcm >= 0 ? COL.alarm : COL.good),
    ro('Period', s => FMT.period(s.out.periodSec),
       s => { const p = s.out.periodSec;
         return (isFinite(p) && p > 0 && p < 30) ? COL.alarm : ''; }),
    ro('Peak pellet', s => FMT.tempC(peak(s.T_fuel, s.N)),
       s => band(peak(s.T_fuel, s.N), 2100, 2800)),
    ro('Peak coolant', s => FMT.tempC(peak(s.T_coolant, s.N))),
    ro('Axial offset', s => FMT.signedPct(s.out.axialOffset),
       s => band(Math.abs(s.out.axialOffset), 0.05, 0.10)),
    ro('Core burnup', s => FMT.burnup(s.out.coreBurnupAvg ?? 0)),
  ];
}

// Rod-bank control block (AUTO/MAN + position slider).
function rodControl() {
  return [
    modeg('Rod control',
      [{ v: 'auto', label: 'AUTO' }, { v: 'manual', label: 'MAN' }],
      s => s.autoRod?.enabled ? 'auto' : 'manual',
      (s, v) => setAutoRod(s, v === 'auto')),
    sld('Rod bank', 0, 1, 0.001,
      s => s.rodBanks.regulating,
      (s, v) => { s.cmd.regulatingTarget = v; },
      v => (v * 100).toFixed(1) + '%',
      s => !!s.autoRod?.enabled),
  ];
}

// Detector channels (SR / IR / PR).
function detectorReadouts() {
  return [
    grp('Detectors'),
    ro('Source range', s => FMT.detSr(s.out.detSrCps, s.out.detSrOffscale),
       s => s.out.detSrOffscale ? COL.alarm : (s.out.detSrCps > 5e4 ? COL.warn : '')),
    ro('Intermediate', s => FMT.detIr(s.out.detIrPowerFrac)),
    ro('Power range', s => FMT.detPr(s.out.detPrFrac, s.out.detPrOffscaleLow),
       s => s.out.detPrOffscaleLow ? COL.warn : ''),
  ];
}

// ════════════════════════════════════════════════════════════════════════
//  PWR registry
// ════════════════════════════════════════════════════════════════════════
//
// 6×3 uniform grid:
//   [CVCS] [PZR ] [SG  ] [RCP ] [TURB] [GEN ]
//   [ECCS] [CORE] [ACCM] [CTMT] [COND] [FWHT]
//   [AFW ] [ELEC] [CCW ] [SFP ] [MFWP]
function buildPwr() {
  const components = [];
  const pipes = [];
  const G = makeGrid({ x0: 70, y0: 70, cw: 340, ch: 300, gap: 70 });

  // Background zone tints (geographic, behind the cells).
  const zones = [
    { x: 40, y: 25, w: 1630, h: 745, label: 'Reactor & Primary Plant' },
    { x: 1680, y: 25, w: 810, h: 745, label: 'Secondary / Turbine Island' },
    { x: 40, y: 780, w: 2040, h: 360, label: 'Support Systems' },
  ];

  const push = def => { components.push(def); return def; };
  const pipe = (kind, pts, extra) =>
    pipes.push({ d: pipePath(pts), kind, ...(extra || {}) });

  // ── Reactor core (1,1) ───────────────────────────────────────────────
  push({
    id: 'core', kind: 'core', ...G.cell(1, 1),
    label: 'REACTOR', sub: 'PWR core',
    readout: s => [FMT.power(s.out.fissionPowerMW), FMT.reactivityPcm(s.out.reactivityPcm)],
    tint: () => '--fuel',
    alarm: s => s.out.reactivityPcm > 400 || peak(s.T_fuel, s.N) > 2800,
    inspector: {
      title: 'Reactor Core',
      fields: [
        grp('Power & reactivity'),
        ...coreCommonReadouts(),
        ro('DNBR (min)', s => s.out.dnbrMin == null ? '—' : s.out.dnbrMin.toFixed(2),
           s => s.out.dnbrMin == null ? '' : bandLow(s.out.dnbrMin, 1.5, 1.3)),
        ro('Cycle', s => s.out.cycleLabel ?? 'BOC'),
        grp('Rod control'),
        ...rodControl(),
        grp('Coolant'),
        sld('Coolant flow', 0, 1.2, 0.001,
          s => s.cmd.coolantFlowTarget,
          (s, v) => { s.cmd.coolantFlowTarget = v; },
          v => (v * 100).toFixed(0) + '%'),
        ro('Mass flow', s => FMT.flowKgPerS(s.out.flowMassRateKgPerS ?? 0)),
        ro('Flow regime', s => (s.out.flowRegime ?? 'forced').replace(/^./, c => c.toUpperCase()),
           s => s.out.flowRegime === 'natural' ? COL.alarm
              : (s.out.flowRegime === 'transition' ? COL.warn : '')),
        grp('Spatial modes'),
        ro('Azimuthal tilt', s => FMT.signedPct(s.out.azimuthalTilt ?? 0),
           s => band(Math.abs(s.out.azimuthalTilt ?? 0), 0.02, 0.05)),
        sld('Tilt NW', -500, 500, 10, s => s.cmd.quadrantTiltPcm[0],
          (s, v) => { s.cmd.quadrantTiltPcm[0] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Tilt NE', -500, 500, 10, s => s.cmd.quadrantTiltPcm[1],
          (s, v) => { s.cmd.quadrantTiltPcm[1] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Tilt SW', -500, 500, 10, s => s.cmd.quadrantTiltPcm[2],
          (s, v) => { s.cmd.quadrantTiltPcm[2] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Tilt SE', -500, 500, 10, s => s.cmd.quadrantTiltPcm[3],
          (s, v) => { s.cmd.quadrantTiltPcm[3] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Radial skew', -500, 500, 10, s => s.cmd.radialSkewPcm,
          (s, v) => { s.cmd.radialSkewPcm = v; }, v => v.toFixed(0) + ' pcm'),
        ...detectorReadouts(),
        grp('Emergency procedures'),
        note('Action bundles with physics behind them — see the schematic component inspectors for the individual systems.'),
        btn('E-0 · Reactor trip', s => {
          manualScram(s); s.cmd.manualAfwStart = true; s.cmd.manualSiActuation = true;
        }, { danger: true }),
        btn('E-1 · RCS inventory', s => {
          s.cmd.porvBlockValveClosed = true; s.cmd.manualSiActuation = true;
          s.cmd.heaterManualOverride = 'off';
        }),
        btn('E-1.3 · Sump recirc', s => {
          s.cmd.eccsSuctionSource = 'sump'; s.cmd.rhrAligned = true;
        }),
        btn('SBO · Heat sink', s => {
          if (Array.isArray(s.cmd.edgManualStart)) s.cmd.edgManualStart.fill(true);
          s.cmd.manualLoadShed = true; s.cmd.manualAfwStart = true;
          s.cmd.tdafwBlockValveOpen = true;
        }),
        btn('Clear sticky actions', s => {
          s.cmd.manualSiActuation = false; s.cmd.manualAfwStart = false;
          s.cmd.manualLoadShed = false; s.cmd.rhrAligned = false;
          s.cmd.heaterManualOverride = null; s.cmd.sfpMakeupKgPerS = 0;
          if (Array.isArray(s.cmd.edgManualStart)) s.cmd.edgManualStart.fill(false);
        }),
      ],
    },
  });

  // ── Pressurizer (1,0) ────────────────────────────────────────────────
  push({
    id: 'pzr', kind: 'vessel', ...G.cell(1, 0),
    label: 'PRESSURIZER', sub: 'RCS pressure control',
    readout: s => [FMT.pressureMPa(s.pressurizerP), FMT.pct(s.pressurizerLevel) + ' lvl'],
    tint: () => '--steam',
    alarm: s => s.pressurizerLevel < 0.17 || s.pressurizerLevel > 0.92
      || s.porvOpen || s.codeSafetyValves.some(v => v),
    inspector: {
      title: 'Pressurizer',
      fields: [
        grp('Pressure & level'),
        ro('Pressure', s => FMT.pressureMPa(s.pressurizerP),
           s => band(Math.abs(s.pressurizerP - 15.5), 0.7, 1.4)),
        ro('Level', s => FMT.pct1(s.pressurizerLevel),
           s => (s.pressurizerLevel < 0.17 || s.pressurizerLevel > 0.92) ? COL.alarm
              : ((s.pressurizerLevel < 0.22 || s.pressurizerLevel > 0.87) ? COL.warn : '')),
        bar('Water level', s => s.pressurizerLevel),
        ro('PRT mass', s => s.prtRuptured ? 'DUMPED' : s.prtMass.toFixed(0) + ' kg',
           s => s.prtRuptured ? COL.alarm : ''),
        grp('Heaters'),
        ro('Heater state', s => {
          const hb = s.heaterBanks;
          if (hb.lockedOut) return 'LOCKOUT';
          if (s.cmd.heaterManualOverride === 'off') return 'OVERRIDE OFF';
          const b = []; if (hb.backup1) b.push('B1'); if (hb.backup2) b.push('B2'); if (hb.backup3) b.push('B3');
          if (hb.variable < 0.01 && !b.length) return 'OFF';
          if (!b.length) return `VAR ${(hb.variable * 100).toFixed(0)}%`;
          return `VAR + ${b.join('+')}`;
        }, s => s.heaterBanks.lockedOut ? COL.alarm
             : ((s.heaterBanks.backup1 || s.heaterBanks.backup2 || s.heaterBanks.backup3) ? COL.warn : '')),
        modeg('Heater mode',
          [{ v: 'auto', label: 'AUTO' }, { v: 'off', label: 'OFF' }],
          s => s.cmd.heaterManualOverride === 'off' ? 'off' : 'auto',
          (s, v) => { s.cmd.heaterManualOverride = v === 'off' ? 'off' : null; }),
        grp('Relief valves'),
        ro('PORV', s => {
          if (s.cmd.porvBlockValveClosed) return 'BLOCKED';
          if (s.porvOpen && s.cmd.porvStuckOpenFault) return 'STUCK OPEN';
          return s.porvOpen ? 'OPEN' : 'CLOSED';
        }, s => (s.porvOpen && s.cmd.porvStuckOpenFault) ? COL.alarm : (s.porvOpen ? COL.warn : '')),
        ro('Code safety valves', s => `${s.codeSafetyValves.filter(v => v).length}/3 open`,
           s => s.codeSafetyValves.some(v => v) ? COL.alarm : ''),
        btn('PORV block valve', s => { s.cmd.porvBlockValveClosed = !s.cmd.porvBlockValveClosed; },
          { active: s => !!s.cmd.porvBlockValveClosed,
            label2: s => s.cmd.porvBlockValveClosed ? 'PORV BLOCKED' : 'PORV block valve' }),
        grp('Fault injection'),
        btn('Stuck-open PORV', s => {
          const next = !s.cmd.porvStuckOpenFault;
          s.cmd.porvStuckOpenFault = next;
          if (next) s.porvOpen = true;
          else if (s.pressurizerP <= (s.T.pressurizer?.porvCloseP ?? 15.9)) s.porvOpen = false;
        }, { danger: true, active: s => !!s.cmd.porvStuckOpenFault,
             label2: s => s.cmd.porvStuckOpenFault ? 'CLEAR PORV FAULT' : 'Stuck-open PORV' }),
      ],
    },
  });

  // ── Steam generator (2,0) — single lumped SG (loop 0) ────────────────
  push({
    id: 'sg', kind: 'vessel', loopIndex: 0, ...G.cell(2, 0),
    label: 'STEAM GEN', sub: 'U-tube steam generator',
    readout: s => [FMT.pressureMPa(s.loops[0].sgPressureMPa),
                   FMT.pct(s.loops[0].sgLevel) + ' lvl'],
    tint: () => '--coolant-hot',
    alarm: s => s.loops[0].sgLevel < 0.10
      || (s.sgTubes && s.sgTubes[0] && s.sgTubes[0].ruptured),
    inspector: {
      title: 'Steam Generator',
      fields: [
        grp('Secondary side'),
        ro('SG pressure', s => FMT.pressureMPa(s.loops[0].sgPressureMPa)),
        ro('SG level', s => FMT.pct1(s.loops[0].sgLevel),
           s => bandLow(s.loops[0].sgLevel, 0.30, 0.10)),
        bar('Narrow-range level', s => s.loops[0].sgLevel),
        ro('Hot-leg temp', s => FMT.tempC(s.loops[0].tHotK)),
        ro('Cold-leg temp', s => FMT.tempC(s.loops[0].tColdK)),
        ro('Steam flow', s => FMT.flowKgPerS(s.out.steamFlow ?? 0)),
        grp('Steam isolation'),
        ro('MSIV', s => s.msivOpen ? 'OPEN' : 'CLOSED', s => okCol(s.msivOpen)),
        btn('MSIV close', s => { s.cmd.msivCloseManual = true; },
          { active: s => !!s.cmd.msivCloseManual }),
        btn('MSIV reset', s => { s.cmd.msivResetOpen = true; s.cmd.msivCloseManual = false; }),
        sld('ADV demand', 0, 1, 0.01,
          s => s.cmd.advPositions ? s.cmd.advPositions[0] : 0,
          (s, v) => { if (s.cmd.advPositions) s.cmd.advPositions[0] = v; },
          v => (v * 100).toFixed(0) + '%'),
        grp('Tubes'),
        ro('Tube status', s => {
          const t = s.sgTubes && s.sgTubes[0];
          if (!t) return '—';
          if (t.ruptured) return 'RUPTURED · ' + FMT.flowKgPerS(s.out.sgtrLeakKgPerS ?? 0);
          return (t.pluggedFraction * 100).toFixed(0) + '% plugged';
        }, s => (s.sgTubes && s.sgTubes[0] && s.sgTubes[0].ruptured) ? COL.alarm : ''),
        grp('Fault injection'),
        btn('Inject tube rupture (SGTR)', s => {
          if (s.cmd.sgTubeRupture) s.cmd.sgTubeRupture[0] = true;
        }, { danger: true, active: s => !!(s.cmd.sgTubeRupture && s.cmd.sgTubeRupture[0]) }),
      ],
    },
  });

  // ── Reactor coolant pump (3,0) — single RCP (loop 0) ─────────────────
  push({
    id: 'rcp', kind: 'pump', loopIndex: 0, ...G.sq(3, 0),
    label: 'RCP', sub: 'coolant pump',
    readout: s => [FMT.flowKgPerS(s.loops[0].massFlowKgPerS)],
    alarm: s => s.loops[0].isolated || (!s.loops[0].rcpRunning && !s.scramActive),
    inspector: {
      title: 'Reactor Coolant Pump',
      fields: [
        grp('Primary loop'),
        ro('Status', s => s.loops[0].isolated ? 'ISOLATED'
           : (s.loops[0].rcpRunning ? 'RUNNING' : 'STOPPED'),
           s => s.loops[0].isolated ? COL.alarm : (s.loops[0].rcpRunning ? '' : COL.warn)),
        ro('Loop flow', s => FMT.flowKgPerS(s.loops[0].massFlowKgPerS)),
        ro('Flow regime', s => (s.out.flowRegime ?? 'forced').replace(/^./, c => c.toUpperCase()),
           s => s.out.flowRegime === 'natural' ? COL.alarm
              : (s.out.flowRegime === 'transition' ? COL.warn : '')),
        ro('Cold-leg temp', s => FMT.tempC(s.loops[0].tColdK)),
        tog('RCP running', s => !!s.cmd.rcpRunning[0],
          (s, v) => { s.cmd.rcpRunning[0] = v; }),
        tog('Loop isolated', s => !!s.cmd.loopIsolated[0],
          (s, v) => { s.cmd.loopIsolated[0] = v; }),
        grp('Shaft seals'),
        ro('Seal leak', s => FMT.gpm(s.rcpSeal.leakRateKgPerS),
           s => s.rcpSeal.stage2Lost ? COL.alarm : (s.rcpSeal.stage1Lost ? COL.warn : '')),
        ro('Stages lost', s => {
          const n = (s.rcpSeal.stage1Lost ? 1 : 0) + (s.rcpSeal.stage2Lost ? 1 : 0)
            + (s.rcpSeal.stage3Lost ? 1 : 0);
          return n + '/3';
        }),
        ro('Seal injection', s => availLost(s.rcpSeal.sealInjectionAvailable),
           s => okCol(s.rcpSeal.sealInjectionAvailable)),
        ro('Thermal barrier', s => availLost(s.rcpSeal.thermalBarrierCoolingAvailable),
           s => okCol(s.rcpSeal.thermalBarrierCoolingAvailable)),
        ro('Since 1st failure', s => s.rcpSeal.firstStageFailureTime == null ? '—'
           : FMT.mmss(s.simTime - s.rcpSeal.firstStageFailureTime),
           s => s.rcpSeal.firstStageFailureTime == null ? '' : COL.alarm),
      ],
    },
  });

  // ── Turbine–generator (4,0) ──────────────────────────────────────────
  push({
    id: 'turbine', kind: 'turbine', ...G.cell(4, 0),
    label: 'TURBINE', sub: 'HP · MSR · LP',
    readout: s => [FMT.power1(s.out.turbineMechPowerMW ?? 0).replace('MWth', 'MW')],
    alarm: s => (s.out.turbineSpeedPU ?? 1) > 1.05,
    inspector: {
      title: 'Turbine–Generator',
      fields: [
        grp('Turbine'),
        ro('HP / LP power', s => `${(s.out.turbineHpPowerMW ?? 0).toFixed(0)} / ${(s.out.turbineLpPowerMW ?? 0).toFixed(0)} MW`),
        ro('Rotor speed', s => ((s.out.turbineSpeedPU ?? 1) * 100).toFixed(1) + '%',
           s => band(s.out.turbineSpeedPU ?? 1, 1.02, 1.05)),
        ro('Turbine valve', s => FMT.pct(s.turbineValve)),
        grp('Generator'),
        ro('Output', s => FMT.powerE(s.out.generatorMWe)),
        ro('Reactive', s => `${(s.out.generatorMVAR ?? 0).toFixed(0)} MVAR · PF ${(s.out.generatorPowerFactor ?? 1).toFixed(2)}`),
        grp('Load control'),
        sld('Grid load', 0, 1.1, 0.001,
          s => s.gridLoadMW / Math.max(s.T.nominalGridLoadMW, 1),
          (s, v) => { s.cmd.gridLoadTarget = v * s.T.nominalGridLoadMW; },
          v => (v * 100).toFixed(0) + '%'),
        sld('Excitation', 0.7, 1.3, 0.01,
          s => s.cmd.generatorFieldCurrentPU ?? 1,
          (s, v) => { s.cmd.generatorFieldCurrentPU = v; },
          v => v.toFixed(2) + ' pu'),
        grp('Fault injection'),
        btn('Load rejection', s => { s.cmd.generatorBreakerOpen = !s.cmd.generatorBreakerOpen; },
          { danger: true, active: s => !!s.cmd.generatorBreakerOpen,
            label2: s => s.cmd.generatorBreakerOpen ? 'CLOSE BREAKER' : 'Load rejection' }),
        tog('Governor fault', s => !!s.cmd.turbineGovernorFault,
          (s, v) => { s.cmd.turbineGovernorFault = v; }),
      ],
    },
  });

  // ── Generator (5,0) ──────────────────────────────────────────────────
  push({
    id: 'generator', kind: 'generator', ...G.sq(5, 0),
    label: 'GEN', sub: 'generator',
    readout: s => [FMT.powerE(s.out.generatorMWe)],
    tint: () => '--neutron',
    inspector: {
      title: 'Generator',
      fields: [
        ro('Real power', s => FMT.powerE(s.out.generatorMWe)),
        ro('Reactive power', s => (s.out.generatorMVAR ?? 0).toFixed(0) + ' MVAR'),
        ro('Power factor', s => (s.out.generatorPowerFactor ?? 1).toFixed(2)),
        ro('Rotor speed', s => ((s.out.turbineSpeedPU ?? 1) * 100).toFixed(1) + '%'),
        note('Detailed turbine controls live in the TURBINE inspector.'),
      ],
    },
  });

  // ── Condenser (4,1) ──────────────────────────────────────────────────
  push({
    id: 'condenser', kind: 'vessel', ...G.cell(4, 1),
    label: 'CONDENSER', sub: 'main condenser',
    readout: s => [FMT.flowKgPerS(s.out.steamFlow ?? 0)],
    tint: () => '--coolant-cold',
    inspector: {
      title: 'Main Condenser',
      fields: [
        ro('Steam flow', s => FMT.flowKgPerS(s.out.steamFlow ?? 0)),
        ro('Feedwater flow', s => FMT.flowKgPerS(s.out.fwFlow ?? 0)),
        ro('Condenser bypass', s => FMT.pct(s.condenserBypassOpen ?? 0)),
        note('Rejects turbine exhaust heat to circulating water. Condensate pumps draw from the hotwell.'),
      ],
    },
  });

  // ── Feedwater heaters (5,1) ──────────────────────────────────────────
  push({
    id: 'fwheaters', kind: 'vessel', ...G.cell(5, 1),
    label: 'FW HEATERS', sub: 'regenerative train',
    readout: s => [s.feedwater ? FMT.tempC(s.out.feedwaterTempK) : '—'],
    alarm: s => s.feedwater && s.out.fwHeatersInService < s.out.fwHeatersTotal,
    inspector: {
      title: 'Feedwater Heater Train',
      fields: [
        ro('FW temperature', s => s.feedwater ? FMT.tempC(s.out.feedwaterTempK) : '—',
           s => (s.feedwater && s.out.fwHeatersInService < s.out.fwHeatersTotal) ? COL.warn : ''),
        ro('Stages in service', s => `${s.out.fwHeatersInService}/${s.out.fwHeatersTotal}`),
        btn('Isolate HP heater string', s => {
          const fw = s.feedwater, arr = s.cmd.fwHeaterInService;
          if (!fw || !arr) return;
          const hp = [];
          for (let i = 0; i < fw.stages.length; i++) if (/^HP/.test(fw.stages[i].name)) hp.push(i);
          if (!hp.length) return;
          const any = hp.some(i => arr[i] !== false);
          for (const i of hp) arr[i] = !any;
        }, { danger: true }),
        note('Isolating HP heaters drops final FW temperature — a mild overpower transient via the moderator coefficient.'),
      ],
    },
  });

  // ── Main feedwater pump (4,2) — single MFW pump ──────────────────────
  push({
    id: 'mfwpumps', kind: 'pump', ...G.sq(4, 2),
    label: 'MFW PUMP', sub: 'main feedwater',
    readout: s => [s.feedwaterPumps ? FMT.flowKgPerS(s.out.fwFlow ?? 0) : '—'],
    alarm: s => s.feedwaterPumps && !s.feedwaterPumps.mfwAvailable,
    inspector: {
      title: 'Main Feedwater Pump',
      fields: [
        ro('Status', s => s.feedwaterPumps
           ? (s.feedwaterPumps.mfwAvailable ? 'RUNNING' : 'TRIPPED') : '—',
           s => (s.feedwaterPumps && !s.feedwaterPumps.mfwAvailable) ? COL.alarm : ''),
        ro('FW capacity', s => FMT.flowKgPerS(s.out.mfwCapacityKgPerS ?? 0)),
        ro('FW flow', s => FMT.flowKgPerS(s.out.fwFlow ?? 0)),
        ro('Condensate pumps', s => s.feedwaterPumps
           ? `${s.out.condRunningCount}/${s.feedwaterPumps.condPumps.length}` : '—'),
        tog('MFW pump', s => !(s.cmd.mfwPumpManualStop && s.cmd.mfwPumpManualStop[0]),
          (s, v) => { if (s.cmd.mfwPumpManualStop) s.cmd.mfwPumpManualStop[0] = !v; }),
        grp('Fault injection'),
        btn('Trip main feedwater', s => {
          const active = !!s.cmd.mainFwTrip;
          s.cmd.mainFwTrip = !active;
          if (s.cmd.mfwPumpManualStop) s.cmd.mfwPumpManualStop.fill(!active);
          if (!active) s.cmd.manualAfwStart = true;
        }, { danger: true, active: s => !!s.cmd.mainFwTrip }),
      ],
    },
  });

  // ── Containment (3,1) — spray + fan coolers + atmosphere ─────────────
  push({
    id: 'ctmt', kind: 'vessel', ...G.cell(3, 1),
    label: 'CONTAINMENT', sub: 'large-dry · sprays · fans',
    readout: s => [(s.out.containmentPressureBarg ?? 0).toFixed(2) + ' barg',
                   s.containment.sprayRunning ? 'SPRAYING' : 'standby'],
    alarm: s => s.containment.sprayRunning || s.containmentT > 400,
    inspector: {
      title: 'Containment',
      fields: [
        grp('Atmosphere'),
        ro('Pressure', s => (s.out.containmentPressureBarg ?? 0).toFixed(2) + ' barg',
           s => band(s.containmentP, 0.13, 0.15)),
        ro('Temperature', s => FMT.tempC(s.containmentT),
           s => s.containmentT > 400 ? COL.alarm : ''),
        ro('Steam mass', s => (s.containment.steamMassKg / 1000).toFixed(1) + ' t'),
        grp('Heat removal'),
        ro('Sprays', s => s.containment.sprayRunning
           ? FMT.gpm(s.containment.sprayFlowKgPerS) : 'OFF',
           s => s.containment.sprayRunning ? COL.warn : ''),
        ro('Fan coolers', s => s.containment.fanCoolersRunning > 0 ? 'RUNNING' : 'OFF',
           s => s.containment.fanCoolersRunning > 0 ? '' : COL.warn),
        ro('PARs', s => s.containment.parsInstalled + ' (passive)'),
        btn('Manual spray', s => { s.cmd.containmentSprayManual = !s.cmd.containmentSprayManual; },
          { active: s => !!s.cmd.containmentSprayManual }),
        btn('Block spray', s => { s.cmd.containmentSprayBlock = !s.cmd.containmentSprayBlock; },
          { active: s => !!s.cmd.containmentSprayBlock }),
        note('Fan coolers are the continuous long-term containment heat sink — gated on CCW + AC. Sprays are the high-capacity transient knockdown.'),
      ],
    },
  });

  // ── Accumulator (2,1) — single passive injection tank ────────────────
  push({
    id: 'accm', kind: 'tank', ...G.cell(2, 1),
    label: 'ACCUMULATOR', sub: 'passive N₂ injection',
    readout: s => [s.eccs.accumulators[0].inventoryM3.toFixed(0) + ' m³'],
    tint: () => '--coolant-cold',
    alarm: s => s.eccs.accumulators[0].flowing,
    inspector: {
      title: 'Accumulator',
      fields: [
        ro('Inventory', s => s.eccs.accumulators[0].inventoryM3.toFixed(1) + ' m³'),
        ro('Status', s => s.eccs.accumulators[0].flowing ? 'INJECTING'
           : (s.eccs.accumulators[0].isolatedManually ? 'ISOLATED' : 'armed'),
           s => s.eccs.accumulators[0].flowing ? COL.warn : ''),
        ro('Gas pressure', s => FMT.pressureMPa(s.eccs.accumulators[0].gasPressureMPa)),
        bar('Inventory', s => s.eccs.accumulators[0].inventoryM3 / 120),
        tog('Isolate', s => !!s.cmd.accumulatorIsolated[0],
          (s, v) => { s.cmd.accumulatorIsolated[0] = v; }),
        note('Passive N₂-pressurized tank — opens automatically when RCS pressure drops below the tank gas pressure. No AC dependency.'),
      ],
    },
  });

  // ── CVCS (0,0) — charging / letdown / boration ───────────────────────
  push({
    id: 'cvcs', kind: 'hx', ...G.cell(0, 0),
    label: 'CVCS', sub: 'chemical & volume control',
    readout: s => [FMT.ppm(s.boronPpm), FMT.gpm(s.cvcs.totalChargingFlowKgPerS)],
    alarm: s => s.cvcs.chargingPumpRunningCount === 0 || s.cvcs.letdownIsolated,
    inspector: {
      title: 'CVCS — Chemical & Volume Control',
      fields: [
        grp('Charging & letdown'),
        ro('Mode', s => (s.cvcs.cvcsMode || 'auto').toUpperCase(),
           s => s.cvcs.cvcsMode === 'auto' ? '' : COL.warn),
        ro('Charging flow', s => FMT.gpm(s.cvcs.totalChargingFlowKgPerS),
           s => s.cvcs.chargingPumpRunningCount === 0 ? COL.alarm : ''),
        ro('Letdown', s => s.cvcs.letdownIsolated ? 'ISOLATED'
           : FMT.gpm(s.cvcs.letdownFlowKgPerS), s => s.cvcs.letdownIsolated ? COL.alarm : ''),
        ro('Seal injection', s => availLost(s.cvcs.sealInjectionAvailable),
           s => okCol(s.cvcs.sealInjectionAvailable)),
        grp('Boration'),
        ro('Actual boron', s => FMT.ppm(s.boronPpm)),
        ro('Boron target', s => FMT.ppm(s.cvcs.boronTargetPpm)),
        sld('Boron setpoint', 0, 3000, 1,
          s => s.cmd.cvcsBoronTargetPpm,
          (s, v) => { s.cmd.boronTarget = v; s.cmd.cvcsBoronTargetPpm = v; },
          v => v.toFixed(0) + ' ppm'),
        modeg('CVCS mode',
          [{ v: 'auto', label: 'AUTO' }, { v: 'borate', label: 'BORATE' }, { v: 'dilute', label: 'DILUTE' }],
          s => s.cmd.cvcsMode || 'auto',
          (s, v) => { s.cmd.cvcsMode = v; }),
        note('Boron moves slowly — actual concentration follows the setpoint through the VCT residence-time lag (τ ≈ 5 min).'),
      ],
    },
  });

  // ── ECCS (0,1) — RWST + injection pumps + sump ───────────────────────
  push({
    id: 'eccs', kind: 'tank', ...G.cell(0, 1),
    label: 'ECCS', sub: 'emergency core cooling',
    readout: s => [FMT.pct(s.eccs.rwstFractionFull) + ' RWST',
                   s.eccs.siActuated ? 'SI ACTUATED' : 'armed'],
    tint: () => '--coolant-cold',
    alarm: s => s.eccs.siActuated || s.eccs.rwstFractionFull < 0.10,
    inspector: {
      title: 'ECCS — Emergency Core Cooling',
      fields: [
        grp('Injection'),
        ro('SI status', s => s.eccs.siActuated
           ? 'ACTUATED ' + FMT.mmss(s.eccs.siFirstActuatedTime != null
               ? s.simTime - s.eccs.siFirstActuatedTime : 0)
           : 'ARMED', s => s.eccs.siActuated ? COL.alarm : ''),
        ro('HHSI flow', s => FMT.gpm(s.eccs.hhsiFlowKgPerS)),
        ro('LHSI flow', s => FMT.gpm(s.eccs.lhsiFlowKgPerS)),
        ro('RHR flow', s => FMT.gpm(s.eccs.rhrFlowKgPerS)),
        grp('Inventory'),
        ro('RWST level', s => FMT.pct1(s.eccs.rwstFractionFull),
           s => bandLow(s.eccs.rwstFractionFull, 0.20, 0.10)),
        bar('RWST', s => s.eccs.rwstFractionFull),
        ro('Suction source', s => s.eccs.suctionSource === 'sump' ? 'SUMP' : 'RWST',
           s => !s.eccs.npshAdequate ? COL.alarm : (s.eccs.suctionSource === 'sump' ? COL.warn : '')),
        ro('Sump inventory', s => s.eccs.containmentSumpM3.toFixed(1) + ' m³'),
        grp('Operator actions'),
        btn('Manual SI', s => { s.cmd.manualSiActuation = !s.cmd.manualSiActuation; },
          { active: s => !!s.cmd.manualSiActuation, danger: true }),
        btn('SI reset', s => { s.cmd.siReset = true; }),
        btn('Suction source', s => {
          s.cmd.eccsSuctionSource = s.cmd.eccsSuctionSource === 'sump' ? 'rwst' : 'sump';
        }, { active: s => s.cmd.eccsSuctionSource === 'sump',
             label2: s => s.cmd.eccsSuctionSource === 'sump' ? 'SUCTION → SUMP' : 'SUCTION → RWST' }),
        btn('RHR cooldown align', s => { s.cmd.rhrAligned = !s.cmd.rhrAligned; },
          { active: s => !!s.cmd.rhrAligned }),
      ],
    },
  });

  // ── AFW (0,2) — auxiliary feedwater ──────────────────────────────────
  push({
    id: 'afw', kind: 'tank', ...G.cell(0, 2),
    label: 'AFW', sub: 'auxiliary feedwater',
    readout: s => [s.afw.actuated ? 'ACTUATED' : 'standby',
                   FMT.flowKgPerS(s.afw.totalFlowKgPerS)],
    alarm: s => s.afw.actuated && s.afw.lowFlowLatched,
    inspector: {
      title: 'Auxiliary Feedwater',
      fields: [
        grp('Status'),
        ro('AFW status', s => s.afw.actuated ? 'ACTUATED' : 'standby',
           s => s.afw.actuated ? COL.warn : ''),
        ro('Total flow', s => FMT.flowKgPerS(s.afw.totalFlowKgPerS)),
        ro('MDAFW', s => s.afw.mdafw.running ? FMT.gpm(s.afw.mdafw.flowKgPerS) : 'standby'),
        ro('TDAFW', s => s.afw.tdafw.running ? FMT.gpm(s.afw.tdafw.flowKgPerS)
           : (s.afw.tdafwAvailable ? 'standby' : 'UNAVAIL'),
           s => s.afw.tdafwAvailable ? '' : COL.warn),
        grp('Operator actions'),
        btn('Manual AFW start', s => { s.cmd.manualAfwStart = true; },
          { active: s => !!s.cmd.manualAfwStart }),
        btn('AFW reset', s => { s.cmd.afwReset = true; s.cmd.manualAfwStart = false; }),
        tog('TDAFW steam block open', s => s.cmd.tdafwBlockValveOpen !== false,
          (s, v) => { s.cmd.tdafwBlockValveOpen = v; }),
        grp('Fault injection'),
        btn('Close all AFW MOVs', s => {
          if (!Array.isArray(s.cmd.afwMovOpen)) return;
          const anyClosed = s.cmd.afwMovOpen.some(v => v === false);
          s.cmd.afwMovOpen.fill(anyClosed);
        }, { danger: true, active: s => Array.isArray(s.cmd.afwMovOpen) && s.cmd.afwMovOpen.some(v => v === false) }),
      ],
    },
  });

  // ── Electrical (1,2) — buses + batteries + grid + EDG ────────────────
  push({
    id: 'electrical', kind: 'vessel', ...G.cell(1, 2),
    label: 'ELECTRICAL', sub: 'buses · battery · EDG · grid',
    readout: s => [availLost(s.electrical.acAvailable) + ' AC',
                   s.edgs.units[0].running ? 'EDG RUN' : 'EDG stby'],
    alarm: s => !s.electrical.acAvailable || s.electrical.anyBankDepleted
      || s.edgs.units[0].faulted,
    inspector: {
      title: 'Electrical Distribution',
      fields: [
        grp('Buses'),
        ro('AC', s => availLost(s.electrical.acAvailable), s => okCol(s.electrical.acAvailable)),
        ro('DC', s => availLost(s.electrical.dcAvailable), s => okCol(s.electrical.dcAvailable)),
        ro('Vital AC', s => s.electrical.vitalAcAvailable ? 'OK' : 'LOST',
           s => okCol(s.electrical.vitalAcAvailable)),
        ro('Inverters', s => {
          const inv = s.electrical.inverters || [];
          const a = inv.filter(u => u.available).length;
          const f = inv.filter(u => u.faulted).length;
          return `${a}/${inv.length}` + (f ? ` (${f}F)` : '');
        }),
        grp('Batteries'),
        ro('Min bank', s => (s.electrical.minBankFrac * 100).toFixed(0) + '%',
           s => s.electrical.anyBankDepleted ? COL.alarm : (s.electrical.anyBankLow ? COL.warn : '')),
        bar('Min bank charge', s => s.electrical.minBankFrac),
        ro('Discharge', s => (s.electrical.totalDischargeA ?? 0).toFixed(0) + ' A',
           s => band(s.electrical.totalDischargeA ?? 0, 50, 200)),
        grp('Grid / switchyard'),
        ro('Grid voltage', s => (s.electrical.grid?.voltagePU ?? 1).toFixed(2) + ' pu',
           s => s.electrical.grid?.lossOfVoltage ? COL.alarm
              : (s.electrical.grid?.degradedVoltage ? COL.warn : '')),
        sld('Switchyard voltage', 0, 1.1, 0.01,
          s => s.cmd.gridVoltagePU ?? 1,
          (s, v) => { s.cmd.gridVoltagePU = v; }, v => v.toFixed(2) + ' pu'),
        btn('Load shed', s => { s.cmd.manualLoadShed = !s.cmd.manualLoadShed; },
          { active: s => !!s.cmd.manualLoadShed }),
        grp('Emergency diesel generator'),
        ro('Status', s => s.edgs.units[0].running ? 'RUNNING' : 'stopped',
           s => s.edgs.units[0].running ? COL.warn : ''),
        ro('Output', s => (s.edgs.units[0].outputKW ?? 0).toFixed(0) + ' kW'),
        ro('Fuel oil', s => ((s.edgs.units[0].fuelTankFrac ?? 1) * 100).toFixed(0) + '%',
           s => bandLow(s.edgs.units[0].fuelTankFrac ?? 1, 0.25, 0.10)),
        ro('ECCS bus', s => s.edgs.eccsBusEnergized ? 'ENERGIZED' : 'dead',
           s => s.edgs.eccsBusEnergized ? COL.warn : ''),
        ro('EDG fault', s => s.edgs.units[0].faulted
           ? (s.edgs.units[0].faultReason || 'FAULT') : 'none',
           s => s.edgs.units[0].faulted ? COL.alarm : ''),
        btn('EDG manual start', s => {
          if (Array.isArray(s.cmd.edgManualStart))
            s.cmd.edgManualStart[0] = !s.cmd.edgManualStart[0];
        }, { active: s => Array.isArray(s.cmd.edgManualStart) && !!s.cmd.edgManualStart[0] }),
        grp('Fault injection'),
        modeg('EDG fault mode',
          [{ v: 'none', label: 'NONE' }, { v: 'fuel', label: 'FUEL' },
           { v: 'jacket', label: 'JACKET' }, { v: 'lube', label: 'LUBE' }],
          s => (s.cmd.edgFault && s.cmd.edgFault[0]) || 'none',
          (s, v) => { if (s.cmd.edgFault) s.cmd.edgFault[0] = v; }),
      ],
    },
  });

  // ── CCW / Service Water (2,2) ────────────────────────────────────────
  push({
    id: 'ccw', kind: 'hx', ...G.cell(2, 2),
    label: 'CCW / SW', sub: 'component & service cooling',
    readout: s => [availLost(s.ccw.available) + ' CCW',
                   FMT.tempC(s.ccw.outletTempK)],
    alarm: s => !s.ccw.available || !s.ccw.swAvailable,
    inspector: {
      title: 'CCW / Service Water',
      fields: [
        ro('CCW', s => availLost(s.ccw.available), s => okCol(s.ccw.available)),
        ro('Service water', s => availLost(s.ccw.swAvailable), s => okCol(s.ccw.swAvailable)),
        ro('CCW outlet', s => FMT.tempC(s.ccw.outletTempK), s => s.ccw.hotLeg ? COL.alarm : ''),
        ro('CCW pump', s => s.ccw.ccwPumpRunningCount > 0 ? 'RUNNING' : 'STOPPED',
           s => s.ccw.ccwPumpRunningCount > 0 ? '' : COL.alarm),
        ro('SW pump', s => s.ccw.swPumpRunningCount > 0 ? 'RUNNING' : 'STOPPED',
           s => s.ccw.swPumpRunningCount > 0 ? '' : COL.alarm),
        grp('Fault injection'),
        btn('Loss of CCW / SW', s => {
          const loss = s.cmd.ccwAvailable === false;
          s.cmd.ccwAvailable = loss;
          if (Array.isArray(s.cmd.ccwPumpManualStop)) s.cmd.ccwPumpManualStop.fill(!loss);
          if (Array.isArray(s.cmd.swPumpManualStop)) s.cmd.swPumpManualStop.fill(!loss);
        }, { danger: true, active: s => s.cmd.ccwAvailable === false }),
      ],
    },
  });

  // ── Spent fuel pool (3,2) ────────────────────────────────────────────
  push({
    id: 'sfp', kind: 'tank', ...G.cell(3, 2),
    label: 'SFP', sub: 'spent fuel pool',
    readout: s => [FMT.tempC(s.sfp.waterTempK), FMT.pct(s.sfp.levelFrac) + ' lvl'],
    tint: () => '--coolant-cold',
    alarm: s => s.sfp.boiling || s.sfp.fuelUncovered,
    inspector: {
      title: 'Spent Fuel Pool',
      fields: [
        ro('Pool temp', s => FMT.tempC(s.sfp.waterTempK),
           s => s.sfp.boiling ? COL.alarm : (s.sfp.highTempLatched ? COL.warn : '')),
        ro('Pool level', s => FMT.pct1(s.sfp.levelFrac),
           s => s.sfp.fuelUncovered ? COL.alarm : (s.sfp.lowLevelLatched ? COL.warn : '')),
        bar('Pool level', s => s.sfp.levelFrac),
        ro('Cooling', s => availLost(s.sfp.coolingAvailable), s => okCol(s.sfp.coolingAvailable)),
        ro('Heat load', s => (s.sfp.decayHeatLoadW / 1e6).toFixed(2) + ' MW'),
        ro('Margin', s => s.sfp.fuelUncovered ? 'FUEL UNCOVERED'
           : (s.out.sfpTimeToUncoverSec != null ? (s.out.sfpTimeToUncoverSec / 3600).toFixed(1) + ' h to uncover'
           : (s.out.sfpTimeToBoilSec != null ? (s.out.sfpTimeToBoilSec / 3600).toFixed(1) + ' h to boil' : 'stable'))),
        grp('Operator actions'),
        sld('Diverse makeup', 0, 80, 1,
          s => s.cmd.sfpMakeupKgPerS || 0,
          (s, v) => { s.cmd.sfpMakeupKgPerS = v; }, v => v.toFixed(0) + ' kg/s'),
        grp('Fault injection'),
        btn('Stop SFP cooling pump', s => { s.cmd.sfpCoolingPumpOn = s.cmd.sfpCoolingPumpOn === false; },
          { danger: true, active: s => s.cmd.sfpCoolingPumpOn === false }),
      ],
    },
  });

  // ── Pipes ────────────────────────────────────────────────────────────
  const loopFlow = s => (s.loops[0].massFlowKgPerS || 0) / 17000;
  // Hot leg: core → SG
  pipe('hot', [[820, 590], [850, 590], [850, 400], [1060, 400], [1060, 370]],
    { flow: loopFlow, temp: s => s.loops[0].tHotK });
  // Cold leg: SG → RCP
  pipe('cold', [[1230, 220], [1377, 220]],
    { flow: loopFlow, temp: s => s.loops[0].tColdK });
  // Cold leg: RCP → core
  pipe('cold', [[1470, 313], [1470, 415], [460, 415], [460, 590], [480, 590]],
    { flow: loopFlow, temp: s => s.loops[0].tColdK });
  // Surge line: pressurizer ↔ core
  pipe('hot', [[650, 370], [650, 440]]);
  // Steam: SG → turbine
  pipe('steam', [[1060, 70], [1060, 35], [1880, 35], [1880, 70]],
    { flow: s => s.turbineValve });
  // Steam: turbine → condenser
  pipe('steam', [[1880, 370], [1880, 440]], { flow: s => s.turbineValve });
  // Condensate: condenser → FW heaters
  pipe('feed', [[2050, 590], [2120, 590]], { flow: s => s.turbineValve });
  // Condensate: FW heaters → MFW pump
  pipe('feed', [[2290, 740], [2290, 775], [1880, 775], [1880, 867]],
    { flow: s => s.turbineValve });
  // Feedwater: MFW pump → SG
  pipe('feed', [[1880, 1053], [1880, 1150], [835, 1150], [835, 370], [890, 370]],
    { flow: s => s.turbineValve });
  // ECCS injection → core
  pipe('cold', [[410, 590], [480, 590]], { flow: s => s.eccs.hhsiFlowKgPerS / 16 });
  // AFW → SG
  pipe('feed', [[240, 1110], [240, 1165], [865, 1165], [865, 370], [920, 370]],
    { flow: s => s.afw.totalFlowKgPerS / 200 });

  return { viewBox: { x: 0, y: 0, w: 2540, h: 1210 }, zones, components, pipes };
}

// ════════════════════════════════════════════════════════════════════════
//  RBMK registry
// ════════════════════════════════════════════════════════════════════════
//
// 4×2 uniform grid:
//   [DRUM] [    ] [TURB] [GEN ]
//   [CORE] [MCP ] [COND] [FEED]
function buildRbmk() {
  const components = [];
  const pipes = [];
  const G = makeGrid({ x0: 70, y0: 70, cw: 360, ch: 320, gap: 80 });
  const zones = [
    { x: 40, y: 30, w: 920, h: 800, label: 'Confinement (partial)', partial: true },
    { x: 990, y: 30, w: 920, h: 800, label: 'Turbine Hall' },
    // Wave-B/C — support + safety systems row(s) below the plant.
    { x: 40, y: 858, w: 1870, h: 740, label: 'Support / Safety Systems' },
  ];
  const push = def => { components.push(def); return def; };
  const pipe = (kind, pts, extra) =>
    pipes.push({ d: pipePath(pts), kind, ...(extra || {}) });

  // Core (0,1)
  push({
    id: 'core', kind: 'core', coreShape: 'square', ...G.cell(0, 1),
    label: 'REACTOR', sub: 'graphite + channels',
    readout: s => [FMT.power(s.out.fissionPowerMW),
      ((s.voidFrac.reduce((a, b) => a + b, 0) / s.N) * 100).toFixed(0) + '% void'],
    tint: () => '--gamma',
    alarm: s => s.out.reactivityPcm > 400 || (s.out.orm != null && s.out.orm < 15),
    inspector: {
      title: 'RBMK Reactor Core',
      fields: [
        grp('Power & reactivity'),
        ...coreCommonReadouts(),
        ro('Avg void', s => ((s.voidFrac.reduce((a, b) => a + b, 0) / s.N) * 100).toFixed(1) + '%'),
        ro('ORM', s => s.out.orm == null ? '—' : s.out.orm.toFixed(1) + ' rods',
           s => s.out.orm == null ? '' : bandLow(s.out.orm, 30, 15)),
        ro('Hot/avg flow', s => `${(s.out.mHotKgPerS ?? 0).toFixed(0)} / ${(s.out.mAvgKgPerS ?? 0).toFixed(0)} kg/s`,
           s => s.out.ledineggUnstable ? COL.alarm : (s.out.flowSplitDivergent ? COL.warn : '')),
        grp('Rod control'),
        ...rodControl(),
        note('RBMK control rods are graphite-tipped — initial insertion adds positive reactivity in the lower core. Scram is slow (~21 s).'),
        grp('Coolant'),
        sld('Coolant flow', 0, 1.2, 0.001,
          s => s.cmd.coolantFlowTarget,
          (s, v) => { s.cmd.coolantFlowTarget = v; }, v => (v * 100).toFixed(0) + '%'),
        ro('Total core flow', s => FMT.flowKgPerS(s.out.flowMassRateKgPerS ?? 0)),
        ro('Loop A / B flow', s => `${(s.loops[0].massFlowKgPerS ?? 0).toFixed(0)} / ${(s.loops[1].massFlowKgPerS ?? 0).toFixed(0)} kg/s`),
        ro('Loop spread', s => FMT.pct1(s.out.loopFlowSpreadFrac ?? 0),
           s => band(s.out.loopFlowSpreadFrac ?? 0, 0.02, 0.10)),
        ro('Flow regime', s => (s.out.flowRegime ?? 'forced').replace(/^./, c => c.toUpperCase()),
           s => s.out.flowRegime === 'natural' ? COL.alarm
              : (s.out.flowRegime === 'transition' ? COL.warn : '')),
        grp('Spatial modes'),
        sld('Tilt NW', -500, 500, 10, s => s.cmd.quadrantTiltPcm[0],
          (s, v) => { s.cmd.quadrantTiltPcm[0] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Tilt NE', -500, 500, 10, s => s.cmd.quadrantTiltPcm[1],
          (s, v) => { s.cmd.quadrantTiltPcm[1] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Tilt SW', -500, 500, 10, s => s.cmd.quadrantTiltPcm[2],
          (s, v) => { s.cmd.quadrantTiltPcm[2] = v; }, v => v.toFixed(0) + ' pcm'),
        sld('Tilt SE', -500, 500, 10, s => s.cmd.quadrantTiltPcm[3],
          (s, v) => { s.cmd.quadrantTiltPcm[3] = v; }, v => v.toFixed(0) + ' pcm'),
        ...detectorReadouts(),
        grp('Fault injection'),
        btn('Pressure-tube break (LOCA)', s => { s.cmd.rbmkPipeBreak = !s.cmd.rbmkPipeBreak; },
          { danger: true, active: s => !!s.cmd.rbmkPipeBreak,
            label2: s => s.cmd.rbmkPipeBreak ? 'ISOLATE BREAK' : 'Pressure-tube break (LOCA)' }),
        note('The signature RBMK excursions emerge from the core physics: drop power + raise void (positive void coefficient at low power), or withdraw rods to a low ORM and then scram (graphite-tipped rods add positive ρ in the lower core first). A pressure-tube break drains the affected drum, depressurizes the circuit (→ ECCS), and vents steam to the ALS pool.'),
      ],
    },
  });

  // Steam drum separators (0,0) — one per loop, level-controlled (Wave B)
  const drumLoopFields = (l, name) => [
    grp(name),
    ro('Level', s => FMT.pct1(s.loops[l].drumLevel),
       s => bandLow(s.loops[l].drumLevel, 0.30, 0.25)),
    bar('Drum level', s => s.loops[l].drumLevel),
    ro('Feedwater', s => FMT.flowKgPerS(s.loops[l].fwFlowKgPerS ?? 0)),
    ro('Steam out', s => FMT.flowKgPerS(s.loops[l].steamFlowKgPerS ?? 0)),
  ];
  push({
    id: 'drum', kind: 'drum', ...G.cell(0, 0),
    label: 'DRUM SEP', sub: 'steam separators',
    readout: s => [FMT.pressureMPa(s.sgSecondaryP),
                   FMT.pct(Math.min(s.loops[0].drumLevel, s.loops[1].drumLevel)) + ' lvl'],
    tint: () => '--coolant-hot',
    alarm: s => s.loops.some(l => !l.isolated && l.drumLevel < 0.25),
    inspector: {
      title: 'Steam Drum Separators (per loop)',
      fields: [
        grp('Common'),
        ro('Drum pressure', s => FMT.pressureMPa(s.sgSecondaryP)),
        ro('Steam flow', s => FMT.flowKgPerS(s.out.steamFlow ?? 0)),
        ro('Feedwater', s => s.cmd.mainFwTrip ? 'TRIPPED' : 'auto',
           s => s.cmd.mainFwTrip ? COL.alarm : ''),
        note('Direct-cycle: each loop’s drum separates the steam–water mix from its pressure tubes; dry steam goes to the turbine, water recirculates via the downcomers. A 3-element controller feeds water to hold level; loss of feedwater drains the drums toward the low-level scram.'),
        ...drumLoopFields(0, 'Loop A (left)'),
        ...drumLoopFields(1, 'Loop B (right)'),
        grp('Fault injection'),
        btn('Trip feedwater', s => { s.cmd.mainFwTrip = !s.cmd.mainFwTrip; },
          { danger: true, active: s => !!s.cmd.mainFwTrip,
            label2: s => s.cmd.mainFwTrip ? 'RESTORE FEEDWATER' : 'Trip feedwater' }),
      ],
    },
  });

  // Main circulation pumps — two-loop MCC (Wave A). One representative
  // running MCP (+ 1 standby) per loop; left/right core halves. The single
  // schematic icon controls both loops via the per-loop inspector below; the
  // visual two-pump split + bespoke pump shapes land in the Part-3 layout pass.
  const mcpStatus = l => s => {
    const lp = s.loops[l];
    if (lp.isolated) return 'ISOLATED';
    if (lp.cavitating) return 'CAVITATING';
    if (!lp.rcpRunning) return 'COASTDOWN';
    return 'RUNNING';
  };
  const mcpStatusCol = l => s => {
    const lp = s.loops[l];
    if (lp.isolated || lp.cavitating) return COL.alarm;
    return lp.rcpRunning ? '' : COL.warn;
  };
  const mcpLoopFields = (l, name) => [
    grp(name),
    ro('Status', mcpStatus(l), mcpStatusCol(l)),
    ro('Loop flow', s => FMT.flowKgPerS(s.loops[l].massFlowKgPerS)),
    ro('Suction subcool', s => s.loops[l].suctionSubcoolK.toFixed(1) + ' K',
       s => s.loops[l].cavitating ? COL.alarm : bandLow(s.loops[l].suctionSubcoolK, 5, 2)),
    tog('MCP running', s => !(s.cmd.rcpRunning[l] === false),
      (s, v) => { s.cmd.rcpRunning[l] = v; }),
    tog('Loop isolated', s => !!s.cmd.loopIsolated[l],
      (s, v) => { s.cmd.loopIsolated[l] = v; }),
  ];
  push({
    id: 'mcp', kind: 'pump', ...G.sq(1, 1),
    label: 'MCP', sub: 'recirc pumps',
    readout: s => [FMT.flowKgPerS(s.out.flowMassRateKgPerS ?? 0),
                   (s.out.flowRegime ?? 'forced')],
    alarm: s => s.loops.some(lp => lp.cavitating || lp.isolated),
    inspector: {
      title: 'Main Circulation Pumps (two-loop MCC)',
      fields: [
        grp('Core total'),
        ro('Total core flow', s => FMT.flowKgPerS(s.out.flowMassRateKgPerS ?? 0)),
        ro('Flow regime', s => (s.out.flowRegime ?? 'forced').replace(/^./, c => c.toUpperCase()),
           s => s.out.flowRegime === 'natural' ? COL.alarm
              : (s.out.flowRegime === 'transition' ? COL.warn : '')),
        ro('Loop spread', s => FMT.pct1(s.out.loopFlowSpreadFrac ?? 0),
           s => band(s.out.loopFlowSpreadFrac ?? 0, 0.02, 0.10)),
        sld('Master flow demand', 0, 1.2, 0.001, s => s.cmd.coolantFlowTarget,
          (s, v) => { s.cmd.coolantFlowTarget = v; }, v => (v * 100).toFixed(0) + '%'),
        note('Each loop cools one core half through its own MCP set, distribution headers and drum separator. Tripping one loop’s MCP coasts that half into natural circulation — a single-MCP-trip asymmetry. Low suction subcooling cavitates the pump and derates its flow.'),
        ...mcpLoopFields(0, 'Loop A (left)'),
        ...mcpLoopFields(1, 'Loop B (right)'),
      ],
    },
  });

  // Electrical / DREG diesels + TG rundown (0,2) — Wave B
  push({
    id: 'elec', kind: 'vessel', ...G.cell(0, 2),
    label: 'ELEC / DREG', sub: 'aux AC · diesels · rundown',
    readout: s => [s.rbmkElectrical ? (s.rbmkElectrical.acAvailable ? 'AC OK' : 'BLACKOUT') : '—',
                   s.rbmkElectrical ? `${s.rbmkElectrical.runningCount}/${s.rbmkElectrical.dgUnits.length} DG` : ''],
    alarm: s => s.rbmkElectrical && (!s.rbmkElectrical.acAvailable || s.rbmkElectrical.anyDgFaulted),
    inspector: {
      title: 'Auxiliary Electrical / DREG',
      fields: [
        grp('Buses'),
        ro('AC supply', s => s.rbmkElectrical?.acAvailable ? 'AVAIL' : 'LOST',
           s => okCol(!!s.rbmkElectrical?.acAvailable)),
        ro('Offsite power', s => s.rbmkElectrical?.offsiteAvailable ? 'AVAIL' : 'LOST',
           s => okCol(!!s.rbmkElectrical?.offsiteAvailable)),
        ro('Diesels running', s => s.rbmkElectrical
           ? `${s.rbmkElectrical.runningCount}/${s.rbmkElectrical.dgUnits.length}` : '—',
           s => s.rbmkElectrical && s.rbmkElectrical.runningCount > 0 ? COL.warn : ''),
        ro('TG rundown', s => s.rbmkElectrical?.rundownActive
           ? `ACTIVE ${(s.rbmkElectrical.rundownEnergy * 100).toFixed(0)}%` : 'idle',
           s => s.rbmkElectrical?.rundownActive ? COL.warn : ''),
        grp('Operator actions'),
        btn('Loss of offsite power', s => { s.cmd.lossOfOffsitePower = !s.cmd.lossOfOffsitePower; },
          { danger: true, active: s => !!s.cmd.lossOfOffsitePower,
            label2: s => s.cmd.lossOfOffsitePower ? 'RESTORE OFFSITE' : 'Loss of offsite power' }),
        btn('Start all diesels', s => {
          if (Array.isArray(s.cmd.rbmkDgManualStart)) s.cmd.rbmkDgManualStart.fill(true);
        }, { active: s => Array.isArray(s.cmd.rbmkDgManualStart) && s.cmd.rbmkDgManualStart.every(Boolean) }),
        grp('Fault injection'),
        btn('Fault diesel 1', s => {
          if (Array.isArray(s.cmd.rbmkDgFault))
            s.cmd.rbmkDgFault[0] = s.cmd.rbmkDgFault[0] === 'none' ? 'mechanical' : 'none';
        }, { danger: true, active: s => Array.isArray(s.cmd.rbmkDgFault) && s.cmd.rbmkDgFault[0] !== 'none' }),
        note('On loss of offsite power the diesels start after ~15 s; the coasting turbo-generator back-feeds the buses (rundown) to bridge the gap and keep the MCPs spinning. A station blackout (no offsite, no diesel, rundown spent) coasts the pumps into natural circulation.'),
      ],
    },
  });

  // ECCS / САОР (1,2) — Wave B
  push({
    id: 'eccs', kind: 'tank', ...G.cell(1, 2),
    label: 'ECCS', sub: 'САОР · accumulators + pumps',
    readout: s => [s.rbmkEccs ? (s.rbmkEccs.actuated ? 'ACTUATED' : 'armed') : '—',
                   s.rbmkEccs ? FMT.flowKgPerS(s.rbmkEccs.totalInjectionKgPerS) : ''],
    tint: () => '--coolant-cold',
    alarm: s => s.rbmkEccs && s.rbmkEccs.actuated,
    inspector: {
      title: 'Emergency Core Cooling (САОР)',
      fields: [
        grp('Injection'),
        ro('Status', s => s.rbmkEccs?.actuated ? 'ACTUATED' : 'armed',
           s => s.rbmkEccs?.actuated ? COL.warn : ''),
        ro('Total injection', s => FMT.flowKgPerS(s.rbmkEccs?.totalInjectionKgPerS ?? 0)),
        ro('Pumped (pool)', s => FMT.flowKgPerS(s.rbmkEccs?.pumpFlowKgPerS ?? 0)),
        ro('Accumulators', s => s.rbmkEccs
           ? `${s.rbmkEccs.accumulators.filter(a => a.flowing).length}/${s.rbmkEccs.accumulators.length} flowing` : '—'),
        ro('Accum inventory', s => s.rbmkEccs
           ? s.rbmkEccs.accumulators.reduce((t, a) => t + a.inventoryM3, 0).toFixed(0) + ' m³' : '—'),
        grp('Operator actions'),
        btn('Manual ECCS', s => { s.cmd.rbmkEccsManual = !s.cmd.rbmkEccsManual; },
          { danger: true, active: s => !!s.cmd.rbmkEccsManual }),
        btn('ECCS reset', s => { s.cmd.rbmkEccsReset = true; s.cmd.rbmkEccsManual = false; }),
        note('Fast N₂ accumulators (passive) + AC-gated pumps drawing from the ALS suppression pool inject makeup into the two core halves on low drum level / pressure.'),
      ],
    },
  });

  // Accident Localization System / suppression pool (2,2) — Wave B
  push({
    id: 'als', kind: 'tank', ...G.cell(2, 2),
    label: 'ALS POOL', sub: 'pressure suppression',
    readout: s => [s.rbmkAls ? FMT.pressureMPa(s.rbmkAls.compartmentPressureMPa) : '—',
                   s.rbmkAls ? FMT.tempC(s.rbmkAls.poolTempK) : ''],
    tint: () => '--coolant-cold',
    alarm: s => s.rbmkAls && s.rbmkAls.compartmentPressureMPa > 0.13,
    inspector: {
      title: 'Accident Localization System',
      fields: [
        grp('Suppression pool'),
        ro('Compartment P', s => FMT.pressureMPa(s.rbmkAls?.compartmentPressureMPa ?? 0.1),
           s => band(s.rbmkAls?.compartmentPressureMPa ?? 0.1, 0.13, 0.30)),
        ro('Pool temp', s => FMT.tempC(s.rbmkAls?.poolTempK ?? 308),
           s => band(s.rbmkAls?.poolTempK ?? 308, 350, 380)),
        ro('Pool inventory', s => (s.rbmkAls?.poolInventoryM3 ?? 0).toFixed(0) + ' m³'),
        ro('Sprays', s => s.rbmkAls?.sprayActive ? 'ACTIVE' : 'off',
           s => s.rbmkAls?.sprayActive ? COL.warn : ''),
        note('No Western-style containment — the RBMK lower compartments vent a pipe break’s steam through this pressure-suppression pool, which condenses it. The pool is also the long-term ECCS water source.'),
      ],
    },
  });

  // Main feedwater pumps (3,2) — Wave C
  push({
    id: 'mfw', kind: 'pump', ...G.sq(3, 2),
    label: 'MFW PUMPS', sub: 'main feedwater',
    readout: s => [s.rbmkAux ? (s.rbmkAux.mfwAvailable ? 'RUNNING' : 'TRIPPED') : '—'],
    alarm: s => s.rbmkAux && !s.rbmkAux.mfwAvailable,
    inspector: {
      title: 'Main Feedwater Pumps',
      fields: [
        ro('Status', s => s.rbmkAux?.mfwAvailable ? 'RUNNING' : 'TRIPPED',
           s => s.rbmkAux?.mfwAvailable ? '' : COL.alarm),
        ro('Total feedwater', s => FMT.flowKgPerS(
           (s.loops?.[0]?.fwFlowKgPerS ?? 0) + (s.loops?.[1]?.fwFlowKgPerS ?? 0))),
        btn('Trip feedwater pumps', s => { s.cmd.rbmkMfwTrip = !s.cmd.rbmkMfwTrip; },
          { danger: true, active: s => !!s.cmd.rbmkMfwTrip,
            label2: s => s.cmd.rbmkMfwTrip ? 'RESTORE MFW' : 'Trip feedwater pumps' }),
        note('AC-powered main feedwater pumps feed the drum separators. They die on a station blackout, draining the drums toward the low-level scram.'),
      ],
    },
  });

  // Graphite gas circuit (0,3) — Wave C
  push({
    id: 'gas', kind: 'hx', ...G.cell(0, 3),
    label: 'GAS CIRCUIT', sub: 'He/N₂ graphite cooling',
    readout: s => [s.rbmkAux ? (s.rbmkAux.gasCoolingOk ? 'COOLING' : 'LOST') : '—',
                   s.rbmkAux ? FMT.tempC(s.rbmkAux.avgGraphiteTempK) : ''],
    tint: () => '--gamma',
    alarm: s => s.rbmkAux && (!s.rbmkAux.gasCoolingOk
      || s.rbmkAux.avgGraphiteTempK > 1373),
    inspector: {
      title: 'Graphite Gas Circuit',
      fields: [
        ro('Gas cooling', s => s.rbmkAux?.gasCoolingOk ? 'OK' : 'LOST',
           s => okCol(!!s.rbmkAux?.gasCoolingOk)),
        ro('Avg graphite temp', s => FMT.tempC(s.rbmkAux?.avgGraphiteTempK ?? 0),
           s => band(s.rbmkAux?.avgGraphiteTempK ?? 0, 1273, 1373)),
        ro('Stack cooling', s => ((s.rbmkAux?.graphiteCoolingFactor ?? 1) * 100).toFixed(0) + '%',
           s => (s.rbmkAux?.graphiteCoolingFactor ?? 1) < 0.99 ? COL.warn : ''),
        btn('Trip gas circulators', s => { s.cmd.rbmkGasCircuitTrip = !s.cmd.rbmkGasCircuitTrip; },
          { danger: true, active: s => !!s.cmd.rbmkGasCircuitTrip }),
        note('The graphite stack sits in a circulated He/N₂ atmosphere that prevents oxidation and carries stack heat to the channels. Loss of circulation overheats the graphite, feeding the (positive-at-low-power) moderator coefficient.'),
      ],
    },
  });

  // CPS rod-cooling circuit (1,3) — Wave C
  push({
    id: 'cps', kind: 'hx', ...G.cell(1, 3),
    label: 'CPS COOLING', sub: 'control-rod cooling',
    readout: s => [s.rbmkAux ? (s.rbmkAux.cpsCoolingOk ? 'OK' : 'LOST') : '—'],
    alarm: s => s.rbmkAux && !s.rbmkAux.cpsCoolingOk,
    inspector: {
      title: 'CPS Rod-Cooling Circuit',
      fields: [
        ro('Cooling', s => s.rbmkAux?.cpsCoolingOk ? 'OK' : 'LOST',
           s => okCol(!!s.rbmkAux?.cpsCoolingOk)),
        ro('Scram drive', s => ((s.rbmkAux?.scramSpeedFactor ?? 1) * 100).toFixed(0) + '%',
           s => (s.rbmkAux?.scramSpeedFactor ?? 1) < 1 ? COL.alarm : ''),
        btn('Trip CPS cooling', s => { s.cmd.rbmkCpsCoolingTrip = !s.cmd.rbmkCpsCoolingTrip; },
          { danger: true, active: s => !!s.cmd.rbmkCpsCoolingTrip }),
        note('Cools the control-rod channels separately from the main circuit. Loss makes the rods drag — derating the already-slow (~21 s) scram drive.'),
      ],
    },
  });

  turbineIsland(components, pipes, G, 2);

  // Core ↔ drum ↔ MCP loop. core(0,1) x70-430 y470-790; drum(0,0)
  // x70-430 y70-390; MCP sq centred (690,630).
  pipe('steam', [[250, 470], [250, 390]],
    { flow: s => s.coolantFlowFrac, temp: s => s.T_coolant[s.N - 1] });
  pipe('cold', [[430, 210], [690, 210], [690, 534]],
    { flow: s => s.coolantFlowFrac, temp: s => s.T_coolant[0] });
  pipe('cold', [[594, 630], [430, 630]],
    { flow: s => s.coolantFlowFrac, temp: s => s.T_coolant[0] });
  // Drum → turbine steam, feed pump → drum return.
  pipe('steam', [[430, 260], [950, 260]], { flow: s => s.turbineValve });
  pipe('feed', [[1570, 726], [1570, 830], [480, 830], [480, 330], [430, 330]],
    { flow: s => s.turbineValve });

  return { viewBox: { x: 0, y: 0, w: 1990, h: 1640 }, zones, components, pipes };
}

// ════════════════════════════════════════════════════════════════════════
//  MSR registry
// ════════════════════════════════════════════════════════════════════════
//
// 5×2 uniform grid:
//   [CORE] [IHX ] [SG  ] [TURB] [GEN ]
//   [DRAIN][PUMP] [    ] [COND] [FEED]
//   freeze-plug sits in the channel between CORE and DRAIN.
function buildMsr() {
  const components = [];
  const pipes = [];
  const G = makeGrid({ x0: 70, y0: 70, cw: 320, ch: 300, gap: 70 });
  const zones = [
    { x: 40, y: 30, w: 800, h: 740, label: 'Reactor Cell' },
    { x: 860, y: 30, w: 770, h: 740, label: 'Heat Rejection (air radiator)' },
  ];
  const push = def => { components.push(def); return def; };
  const pipe = (kind, pts, extra) =>
    pipes.push({ d: pipePath(pts), kind, ...(extra || {}) });

  // Core (0,0)
  push({
    id: 'core', kind: 'core', ...G.cell(0, 0),
    label: 'REACTOR', sub: 'fuel salt',
    readout: s => [FMT.power(s.out.fissionPowerMW), FMT.tempC(peak(s.T_fuel, s.N))],
    tint: () => '--fuel',
    inspector: {
      title: 'MSR Reactor Core',
      fields: [
        grp('Power & reactivity'),
        ...coreCommonReadouts(),
        grp('Rod control'),
        ...rodControl(),
        note('MSR Doppler feedback is enormous (~−110 pcm/K) — fuel-salt expansion self-regulates. Auto-rod is off by default.'),
        grp('Coolant'),
        sld('Salt flow', 0, 1.2, 0.001, s => s.cmd.coolantFlowTarget,
          (s, v) => { s.cmd.coolantFlowTarget = v; }, v => (v * 100).toFixed(0) + '%'),
        ...detectorReadouts(),
      ],
    },
  });

  // Drain tank (0,1)
  push({
    id: 'drain-tank', kind: 'tank', ...G.cell(0, 1),
    label: 'DRAIN TANK', sub: 'passive cooling',
    readout: s => [FMT.power(s.out.drainTankDecayHeatMW ?? 0)],
    inspector: {
      title: 'Drain Tank',
      fields: [
        ro('Decay heat', s => FMT.power(s.out.drainTankDecayHeatMW ?? 0)),
        note('Receives drained fuel salt. Passive air cooling removes decay heat with no pumps or power.'),
      ],
    },
  });

  // Freeze plug — small valve in the core → drain-tank channel.
  push({
    id: 'freeze-plug', kind: 'valve',
    x: G.cx(0) - 45, y: G.rowY(0) + G.ch + 5, w: 90, h: G.gap - 10,
    label: 'FREEZE PLUG', sub: '',
    readout: s => [s.freezePlugMelted ? 'DRAINING' : 'frozen'],
    alarm: s => s.freezePlugMelted,
    inspector: {
      title: 'Freeze Plug',
      fields: [
        ro('State', s => s.freezePlugMelted ? 'MELTED — DRAINING' : 'frozen',
           s => s.freezePlugMelted ? COL.alarm : ''),
        tog('Plug cooling', s => s.cmd.freezePlugCoolingAvailable !== false,
          (s, v) => { s.cmd.freezePlugCoolingAvailable = v; }),
        btn('Melt freeze plug', s => { s.cmd.meltFreezePlug = !s.cmd.meltFreezePlug; },
          { danger: true, active: s => !!s.cmd.meltFreezePlug }),
        note('A passive safety device: lose plug cooling (or the loop goes hot and stagnant) and the salt drains to the passively-cooled drain tank.'),
      ],
    },
  });

  // Intermediate heat exchanger (1,0)
  push({
    id: 'ihx', kind: 'hx', ...G.cell(1, 0),
    label: 'IHX', sub: 'intermediate HX',
    readout: s => [FMT.tempC(s.intermediateLoopT)],
    tint: () => '--coolant-hot',
    inspector: {
      title: 'Intermediate Heat Exchanger',
      fields: [
        ro('Intermediate loop T', s => FMT.tempC(s.intermediateLoopT)),
        ro('Core outlet T', s => FMT.tempC(s.T_coolant[s.N - 1])),
        note('Isolates the radioactive fuel salt from the air-radiator heat sink through a clean intermediate coolant-salt loop.'),
      ],
    },
  });

  // Primary salt pump (1,1)
  push({
    id: 'primary-pump', kind: 'pump', ...G.sq(1, 1),
    label: 'FUEL PUMP', sub: 'salt pump + bowl',
    readout: s => [FMT.flowKgPerS(s.out.flowMassRateKgPerS ?? 0)],
    inspector: {
      title: 'Fuel-Salt Pump + Pump Bowl',
      fields: [
        ro('Mass flow', s => FMT.flowKgPerS(s.out.flowMassRateKgPerS ?? 0)),
        ro('Bowl level', s => s.msrPumpBowl ? FMT.pct1(s.msrPumpBowl.levelFrac) : '—'),
        ro('Salt charge', s => s.msrPumpBowl ? (s.msrPumpBowl.saltMassKg).toFixed(0) + ' kg' : '—'),
        sld('Salt flow', 0, 1.2, 0.001, s => s.cmd.coolantFlowTarget,
          (s, v) => { s.cmd.coolantFlowTarget = v; }, v => (v * 100).toFixed(0) + '%'),
        note('The pump bowl has a helium gas space above the salt — where the off-gas system sparges out ⁱ³⁵Xe / Kr (the off-gas subsystem clicks separately). Tripping the fuel pump strands the circulating delayed-neutron precursors in-core, inserting positive reactivity.'),
      ],
    },
  });

  // MSR-A — air-cooled radiator (2,0). Replaces the steam generator; MSRE
  // rejected its heat to the atmosphere, not a turbine.
  push({
    id: 'radiator', kind: 'radiator', ...G.cell(2, 0),
    label: 'AIR RADIATOR', sub: 'salt → air',
    readout: s => [s.msrRadiator ? FMT.power(s.msrRadiator.heatRejectedMW) : '—',
                   s.msrRadiator ? FMT.tempC(s.msrRadiator.coolantSaltTempK) : ''],
    tint: () => '--coolant-hot',
    alarm: s => s.msrRadiator && s.msrRadiator.coolantSaltFrozen,
    inspector: {
      title: 'Air-Cooled Radiator',
      fields: [
        grp('Heat rejection'),
        ro('Heat rejected', s => FMT.power(s.msrRadiator?.heatRejectedMW ?? 0)),
        ro('Coolant salt T', s => FMT.tempC(s.msrRadiator?.coolantSaltTempK ?? 0),
           s => s.msrRadiator?.coolantSaltFrozen ? COL.alarm
              : bandLow(s.msrRadiator?.coolantSaltTempK ?? 999, 783, 727)),
        ro('Air outlet', s => FMT.tempC(s.msrRadiator?.airOutletTempK ?? 0)),
        ro('Salt state', s => s.msrRadiator?.coolantSaltFrozen ? 'FROZEN' : 'molten',
           s => s.msrRadiator?.coolantSaltFrozen ? COL.alarm : ''),
        ro('Freeze heaters', s => s.msrRadiator?.freezeHeaterOn ? 'ON' : 'off',
           s => s.msrRadiator?.freezeHeaterOn ? COL.warn : ''),
        grp('Doors'),
        sld('Bypass doors', 0, 1, 0.01, s => s.cmd.msrBypassDoors ?? 0,
          (s, v) => { s.cmd.msrBypassDoors = v; }, v => (v * 100).toFixed(0) + '%'),
        btn('Trip freeze heaters', s => { s.cmd.msrFreezeHeaterTrip = !s.cmd.msrFreezeHeaterTrip; },
          { danger: true, active: s => !!s.cmd.msrFreezeHeaterTrip }),
        note('The coolant salt dumps reactor heat to the air through a finned radiator. Blower speed sets the power demand; bypass doors and freeze heaters keep the salt above its liquidus when cold.'),
      ],
    },
  });

  // MSR-A — main blower (3,0): the power-control actuator.
  push({
    id: 'blower', kind: 'pump', ...G.sq(3, 0),
    label: 'BLOWER', sub: 'radiator air',
    readout: s => [((s.cmd.msrBlowerSpeed ?? 1) * 100).toFixed(0) + '%'],
    inspector: {
      title: 'Radiator Main Blower',
      fields: [
        ro('Blower speed', s => ((s.cmd.msrBlowerSpeed ?? 1) * 100).toFixed(0) + '%'),
        ro('Heat rejected', s => FMT.power(s.msrRadiator?.heatRejectedMW ?? 0)),
        sld('Blower speed', 0, 1.5, 0.01, s => s.cmd.msrBlowerSpeed ?? 1,
          (s, v) => { s.cmd.msrBlowerSpeed = v; }, v => (v * 100).toFixed(0) + '%'),
        note('Forces air across the radiator. More airflow → more heat removed → the salt cools → the huge MSR Doppler raises power to match. The blower is the MSR’s primary power-control actuator.'),
      ],
    },
  });

  // MSR-B — off-gas system (4,0)
  push({
    id: 'offgas', kind: 'tank', ...G.cell(4, 0),
    label: 'OFF-GAS', sub: 'He sparge · charcoal',
    readout: s => [s.msrOffGas ? (s.msrOffGas.available ? 'STRIPPING' : 'LOST') : '—'],
    tint: () => '--gamma',
    alarm: s => s.msrOffGas && !s.msrOffGas.available,
    inspector: {
      title: 'Off-Gas System',
      fields: [
        ro('Status', s => s.msrOffGas?.available ? 'STRIPPING Xe/Kr' : 'LOST',
           s => okCol(!!s.msrOffGas?.available)),
        ro('Charcoal loading', s => s.msrOffGas ? FMT.pct1(s.msrOffGas.charcoalLoadingFrac) : '—'),
        ro('Core xenon', s => FMT.pct1((s.xenon[s.N >> 1] ?? 0)),
           s => band((s.xenon[s.N >> 1] ?? 0), 1.2, 1.6)),
        btn('Trip off-gas sparge', s => { s.cmd.msrOffGasTrip = !s.cmd.msrOffGasTrip; },
          { danger: true, active: s => !!s.cmd.msrOffGasTrip }),
        note('Helium bubbled through the pump bowl carries ¹³⁵Xe and Kr out of the fuel salt to charcoal-bed holdup, where they decay. This is why an MSR’s xenon poisoning is small — lose the sparge and xenon builds back up.'),
      ],
    },
  });

  // MSR-B — sealed reactor cell containment (3,1)
  push({
    id: 'cell', kind: 'vessel', ...G.cell(3, 1),
    label: 'REACTOR CELL', sub: 'sealed · inert',
    readout: s => [s.msrCell ? FMT.tempC(s.msrCell.tempK) : '—',
                   s.msrCell ? FMT.pressureMPa(s.msrCell.pressureMPa) : ''],
    tint: () => '--coolant-cold',
    alarm: s => s.msrCell && s.msrCell.tempK > 420,
    inspector: {
      title: 'Reactor Cell Containment',
      fields: [
        ro('Cell temperature', s => FMT.tempC(s.msrCell?.tempK ?? 0),
           s => band(s.msrCell?.tempK ?? 0, 400, 420)),
        ro('Cell pressure', s => FMT.pressureMPa(s.msrCell?.pressureMPa ?? 0)),
        note('The reactor and drain-tank cells are sealed and inert (N₂), slightly subatmospheric, with a vapor-condensing system — the MSR analog of containment. They take the drain-tank afterheat.'),
      ],
    },
  });

  // MSR-C — fuel-salt chemistry (4,1)
  push({
    id: 'chem', kind: 'hx', ...G.cell(4, 1),
    label: 'CHEMISTRY', sub: 'redox · corrosion',
    readout: s => [s.msrChem ? 'U⁴⁺/U³⁺ ' + s.msrChem.redoxRatio.toFixed(2) : '—'],
    alarm: s => s.msrChem && (s.msrChem.redoxRatio > 1.8 || s.msrChem.corrosionIndex > 1.0),
    inspector: {
      title: 'Fuel-Salt Chemistry',
      fields: [
        ro('Redox (U⁴⁺/U³⁺)', s => (s.msrChem?.redoxRatio ?? 1).toFixed(2),
           s => band(s.msrChem?.redoxRatio ?? 1, 1.5, 1.8)),
        ro('Corrosion index', s => (s.msrChem?.corrosionIndex ?? 0).toFixed(2),
           s => band(s.msrChem?.corrosionIndex ?? 0, 0.5, 1.0)),
        ro('Reductant', s => s.msrChem?.reductantOn ? 'ADDING' : 'off',
           s => s.msrChem?.reductantOn ? COL.warn : ''),
        btn('Add reductant (Be / UF₃)', s => { s.cmd.msrRedoxControl = !s.cmd.msrRedoxControl; },
          { active: s => !!s.cmd.msrRedoxControl }),
        note('Fission frees fluorine, drifting the salt oxidizing (U⁴⁺/U³⁺ up), which corrodes the Hastelloy. Periodic reductant addition holds the redox in-band — online chemistry control, an MSR-defining operation.'),
      ],
    },
  });

  // Primary salt loop: core → IHX → pump → core.
  pipe('hot', [[390, 220], [460, 220]],
    { flow: s => s.coolantFlowFrac, temp: s => s.T_coolant[s.N - 1] });
  pipe('cold', [[620, 370], [620, 500]],
    { flow: s => s.coolantFlowFrac, temp: s => s.T_coolant[0] });
  pipe('cold', [[530, 590], [420, 590], [420, 300], [390, 300]],
    { flow: s => s.coolantFlowFrac, temp: s => s.T_coolant[0] });
  // Drain path: core → freeze plug → drain tank (flows only when melted).
  pipe('cold', [[230, 370], [230, 440]],
    { flow: s => (s.freezePlugMelted ? 1 : 0) });
  // Coolant-salt loop: IHX ↔ radiator.
  pipe('intermediate', [[780, 190], [850, 190]],
    { flow: s => s.coolantFlowFrac, temp: s => s.intermediateLoopT });
  pipe('intermediate', [[850, 250], [780, 250]],
    { flow: s => s.coolantFlowFrac, temp: s => s.intermediateLoopT });
  // Radiator → blower air path (cosmetic).
  pipe('steam', [[1170, 220], [1240, 220]], { flow: s => s.cmd.msrBlowerSpeed ?? 1 });

  return { viewBox: { x: 0, y: 0, w: 1660, h: 850 }, zones, components, pipes };
}

// ════════════════════════════════════════════════════════════════════════
//  Shared turbine island (RBMK direct cycle + MSR intermediate cycle)
// ════════════════════════════════════════════════════════════════════════
//
// Places TURBINE (col,0), GEN (col+1,0), CONDENSER (col,1), FEED PUMP
// (col+1,1) and wires the steam header. `col` is the grid column of the
// turbine.
function turbineIsland(components, pipes, G, col) {
  const pipe = (kind, pts, extra) =>
    pipes.push({ d: pipePath(pts), kind, ...(extra || {}) });

  components.push({
    id: 'turbine', kind: 'turbine', ...G.cell(col, 0),
    label: 'TURBINE', sub: 'HP · LP',
    readout: s => [FMT.powerE(s.out.generatorMWe)],
    alarm: s => (s.out.turbineSpeedPU ?? 1) > 1.05,
    inspector: {
      title: 'Turbine–Generator',
      fields: [
        ro('Generator', s => FMT.powerE(s.out.generatorMWe)),
        ro('Turbine valve', s => FMT.pct(s.turbineValve)),
        sld('Grid load', 0, 1.1, 0.001,
          s => s.gridLoadMW / Math.max(s.T.nominalGridLoadMW, 1),
          (s, v) => { s.cmd.gridLoadTarget = v * s.T.nominalGridLoadMW; },
          v => (v * 100).toFixed(0) + '%'),
      ],
    },
  });
  components.push({
    id: 'generator', kind: 'generator', ...G.sq(col + 1, 0),
    label: 'GEN', sub: '',
    readout: s => [FMT.powerE(s.out.generatorMWe)],
    tint: () => '--neutron',
    inspector: {
      title: 'Generator',
      fields: [ro('Output', s => FMT.powerE(s.out.generatorMWe))],
    },
  });
  components.push({
    id: 'condenser', kind: 'vessel', ...G.cell(col, 1),
    label: 'CONDENSER', sub: '',
    readout: s => [FMT.flowKgPerS(s.out.steamFlow ?? 0)],
    tint: () => '--coolant-cold',
    inspector: {
      title: 'Condenser',
      fields: [ro('Steam flow', s => FMT.flowKgPerS(s.out.steamFlow ?? 0))],
    },
  });
  components.push({
    id: 'feedpump', kind: 'pump', ...G.sq(col + 1, 1),
    label: 'FEED PUMP', sub: '',
    readout: () => ['feed'],
    inspector: { title: 'Feedwater Pump', fields: [note('Returns condensate to the steam side.')] },
  });

  // Internal turbine-island pipes. The steam supply into the turbine and
  // the feed return out of the feed pump are caller-drawn (they reach the
  // reactor-type-specific steam source).
  // Turbine → generator.
  pipe('steam', [[G.colX(col) + G.cw, G.cy(0)], [G.cx(col + 1), G.cy(0)]],
    { flow: s => s.turbineValve });
  // Turbine → condenser.
  pipe('steam', [[G.cx(col), G.rowY(0) + G.ch], [G.cx(col), G.cy(1)]],
    { flow: s => s.turbineValve });
  // Condenser → feed pump.
  pipe('feed', [[G.colX(col) + G.cw, G.cy(1)], [G.cx(col + 1), G.cy(1)]],
    { flow: s => s.turbineValve });
}

// ── Public entrypoint ───────────────────────────────────────────────────
export function buildRegistry(reactorTypeId) {
  if (reactorTypeId === 'rbmk') return buildRbmk();
  if (reactorTypeId === 'msr') return buildMsr();
  return buildPwr();
}
