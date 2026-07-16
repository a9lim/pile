// main.js -- entry point for Pile. Wires the schematic-centric control board:
// left rail (core glance + axial + stack + SCRAM), centre plant schematic with
// zoom/pan and a single component inspector dock, right rail (trips + trends).
//
// State lives in a holder (`SIM`) so the reactor-type selector can swap the
// underlying state without re-binding every UI listener.

import { createState } from './src/state.js';
import { advanceSim, stepSim } from './src/sim.js';
import { createAxialDisplay } from './src/ui/axial.js';
import { createReactivityStack } from './src/ui/stack.js';
import { buildAnnunciator, renderAnnunciator } from './src/ui/annunciator.js';
import { createSchematic } from './src/ui/schematic.js';
import { createInspector } from './src/ui/inspector.js';
import { initPeriodAudio, updatePeriodAudio } from './src/ui/period-audio.js';
import { createScenarioEngine } from './scenarios/engine.js';
import { initScenarios } from './src/ui/scenarios.js';
import { manualScram, resetScram } from './src/physics/rps.js';
import { FMT, COL } from './src/ui/format.js';

function id(s) { return document.getElementById(s); }
const $ = {
  themeBtn: id('theme-btn'), aboutBtn: id('about-btn'), audioBtn: id('audio-btn'),
  playBtn: id('play-btn'), speedBtn: id('speed-btn'), stepBtn: id('step-btn'),
  resetBtn: id('reset-btn'), scenarioBtn: id('scenario-btn'),
  reactorTypeToggles: id('reactor-type-toggles'),
  // left rail
  gReactorType: id('g-reactor-type'),
  gFission: id('g-fission'), gDecay: id('g-decay'), gTotal: id('g-total'),
  gGen: id('g-gen'), gSimTime: id('g-sim-time'),
  gReactivity: id('g-reactivity'), gDollars: id('g-dollars'),
  gPeriod: id('g-period'), gAo: id('g-ao'), gOrm: id('g-orm'), gOrmRow: id('g-orm-row'),
  axial: id('axial-canvas'), stackCanvas: id('reactivity-stack'),
  scramBtn: id('scram-btn'),
  // centre
  schematic: id('schematic'), stage: id('stage'), inspector: id('inspector'),
  zoomIn: id('zoom-in'), zoomOut: id('zoom-out'), zoomReset: id('zoom-reset'),
  zoomPct: id('zoom-pct'),
  // right rail
  annunciator: id('annunciator-grid'), btnReset: id('btn-reset-trips'),
  sparkPower: id('spark-power'), sparkTemp: id('spark-temp'),
  sparkXenon: id('spark-xenon'), sparkAo: id('spark-ao'),
  stripPowerVal: id('strip-power-val'), stripTempVal: id('strip-temp-val'),
  stripXenonVal: id('strip-xenon-val'), stripAoVal: id('strip-ao-val'),
};

// ── State holder ────────────────────────────────────────────────────────
const SIM = { state: createState('pwr') };

// ── UI components ───────────────────────────────────────────────────────
const axial = createAxialDisplay($.axial);
const stack = createReactivityStack($.stackCanvas);
const annunciatorCells = buildAnnunciator($.annunciator);

const inspector = createInspector($.inspector, SIM, {
  onClose: () => schematic.select(null),
});
const schematic = createSchematic($.schematic, $.stage, {
  onSelect: (cid) => {
    const c = cid ? schematic.getComponent(cid) : null;
    inspector.show(c ? c.inspector : null);
  },
});

// ── Sparkline histories ─────────────────────────────────────────────────
const SPARK_CAP = 600;
const hPower = createSparkHistory(SPARK_CAP);
const hTemp  = createSparkHistory(SPARK_CAP);
const hXenon = createSparkHistory(SPARK_CAP);
const hAo    = createSparkHistory(SPARK_CAP);

const _sparkCtx = {};
function sparkCtx(canvas) {
  if (!canvas) return null;
  if (!_sparkCtx[canvas.id]) _sparkCtx[canvas.id] = canvas.getContext('2d');
  return _sparkCtx[canvas.id];
}
function renderSpark(canvas, history, colorVar) {
  if (!canvas || history.count < 2) return;
  const ctx = sparkCtx(canvas);
  if (!ctx) return;
  const { width, height } = window.resizeCanvasDPR(canvas, ctx);
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(colorVar).trim() || '#000';
  drawSparkline(ctx, history, width, height, color, color + '44');
}
// Axial-offset sparkline with a fixed ±0.2 y-range so the ±5% Tech Spec band
// markers stay at a constant canvas position.
function renderSparkAo(canvas, history) {
  if (!canvas || history.count < 2) return;
  const ctx = sparkCtx(canvas);
  if (!ctx) return;
  const { width, height } = window.resizeCanvasDPR(canvas, ctx);
  ctx.clearRect(0, 0, width, height);
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue('--r-xenon').trim() || '#000';
  const dim = color + '44';
  const pad = height * 0.1, plotH = height - 2 * pad, range = 0.4;
  const yFor = v => {
    let vv = v; if (vv > 0.2) vv = 0.2; else if (vv < -0.2) vv = -0.2;
    return pad + plotH - ((vv + 0.2) / range) * plotH;
  };
  ctx.save();
  ctx.setLineDash([4, 4]); ctx.strokeStyle = dim; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yFor(0.05)); ctx.lineTo(width, yFor(0.05));
  ctx.moveTo(0, yFor(-0.05)); ctx.lineTo(width, yFor(-0.05));
  ctx.stroke();
  ctx.restore();
  const data = history.data, count = history.count, cap = history.cap;
  const base = (history.head - count + cap) % cap;
  const xScale = width / (cap - 1);
  ctx.beginPath();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  for (let i = 0; i < count; i++) {
    const x = i * xScale, y = yFor(data[(base + i) % cap]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  if (count < cap) {
    ctx.setLineDash([2, 2]); ctx.strokeStyle = dim;
    const nowX = (count / cap) * width;
    ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, height); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ── Scenario engine + UI ────────────────────────────────────────────────
const scenarioEngine = createScenarioEngine();
const scenarioUI = initScenarios(SIM, scenarioEngine, {
  rebuildState, setPlaying, syncSpeed: syncSpeedBtn,
});

// ── Theme ───────────────────────────────────────────────────────────────
if (window._toolbar) {
  window._toolbar.initTheme('pile-theme');
  if ($.themeBtn) $.themeBtn.addEventListener('click', () => window._toolbar.toggleTheme('pile-theme'));
}

// ── Play / pause ────────────────────────────────────────────────────────
function setPlaying(p) {
  SIM.state.running = p;
  if (window._toolbar?.updatePlayBtn) window._toolbar.updatePlayBtn($.playBtn, p);
}
function togglePlay() { setPlaying(!SIM.state.running); }
if ($.playBtn && window._toolbar?.updatePlayBtn) {
  window._toolbar.updatePlayBtn($.playBtn, SIM.state.running);
  $.playBtn.addEventListener('click', togglePlay);
}

// ── Speed ───────────────────────────────────────────────────────────────
const ACCEL_OPTIONS = [1, 10, 60, 600, 3600, 36000];
const ACCEL_LABEL = { 1: '1×', 10: '10×', 60: '1m', 600: '10m', 3600: '1h', 36000: '10h' };
function syncSpeedBtn() {
  if (!$.speedBtn) return;
  const accel = SIM.state.accel;
  const label = $.speedBtn.querySelector('.speed-label');
  if (label) label.textContent = ACCEL_LABEL[accel] ?? (accel + '×');
  $.speedBtn.title = 'Speed: ' + accel + '× (right-click to slow)';
}
function cycleSpeed(dir) {
  const idx = ACCEL_OPTIONS.indexOf(SIM.state.accel);
  const next = idx >= 0 ? idx + dir : 0;
  SIM.state.accel = ACCEL_OPTIONS[((next % ACCEL_OPTIONS.length) + ACCEL_OPTIONS.length) % ACCEL_OPTIONS.length];
  syncSpeedBtn();
  window._haptics?.trigger('selection');
}
if ($.speedBtn) {
  syncSpeedBtn();
  $.speedBtn.addEventListener('click', () => cycleSpeed(+1));
  $.speedBtn.addEventListener('contextmenu', e => { e.preventDefault(); cycleSpeed(-1); });
}

// ── Step ────────────────────────────────────────────────────────────────
function stepOnce() { stepSim(SIM.state, 0.1); window._haptics?.trigger('selection'); }
if ($.stepBtn) $.stepBtn.addEventListener('click', stepOnce);

// ── Reactor-state rebuild (shared by reset, type swap, scenarios) ───────
function rebuildState(typeId) {
  SIM.state = createState(typeId);
  schematic.rebuild(SIM.state);
  inspector.close();
  syncSpeedBtn();
  setPlaying(SIM.state.running);
  resetSparkHistory(hPower); resetSparkHistory(hTemp);
  resetSparkHistory(hXenon); resetSparkHistory(hAo);
  sampleAccum = 0;
}
function resetSim() {
  scenarioEngine.end();
  rebuildState(SIM.state.reactorTypeId);
  window._haptics?.trigger('light');
}
if ($.resetBtn) $.resetBtn.addEventListener('click', resetSim);

// ── SCRAM ───────────────────────────────────────────────────────────────
function fireScram() {
  manualScram(SIM.state);
  if ($.scramBtn) {
    $.scramBtn.classList.add('flash');
    setTimeout(() => $.scramBtn.classList.remove('flash'), 300);
  }
  window._haptics?.trigger('heavy');
}
if ($.scramBtn) $.scramBtn.addEventListener('click', fireScram);

// ── Reset trips ─────────────────────────────────────────────────────────
if ($.btnReset) {
  $.btnReset.addEventListener('click', () => {
    resetScram(SIM.state);
    SIM.state.cmd.turbineValveTarget = SIM.state.T.turbineValveOpen;
    window._haptics?.trigger('light');
  });
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────
const shortcuts = [
  { key: ' ',       label: 'Play / Pause',  group: 'Simulation', action: togglePlay },
  { key: '/',       label: 'Step forward',  group: 'Simulation', action: stepOnce },
  { key: '.',       label: 'Speed up',      group: 'Simulation', action: () => cycleSpeed(+1) },
  { key: ',',       label: 'Slow down',     group: 'Simulation', action: () => cycleSpeed(-1) },
  { key: 'r',       label: 'Reset',         group: 'Simulation', action: resetSim },
  { key: 'shift+s', label: 'Manual scram',  group: 'Simulation', action: fireScram },
  { key: 'f',       label: 'Fit plant view', group: 'View',      action: () => schematic.fitAll() },
  { key: 'Escape',  label: 'Close inspector', group: 'View',     action: () => inspector.close() },
];
if (typeof initShortcuts !== 'undefined') {
  initShortcuts(shortcuts, { helpTitle: 'Pile Keyboard Shortcuts' });
}

// ── About panel ─────────────────────────────────────────────────────────
if (window.initAboutPanel) {
  window.initAboutPanel({
    title: 'Pile',
    button: $.aboutBtn,
    description: 'Semi-realistic nuclear reactor simulator. Three reactor types share a 1D axial point-kinetics engine with thermal feedback, iodine-xenon dynamics, decay heat, burnup, and coupled plant safety systems. The plant schematic is interactive — click any component to inspect and operate it.',
    controls: [
      { label: 'Reactor type', value: 'PWR / RBMK / MSR — top of the left rail' },
      { label: 'Inspect', value: 'Click any schematic component' },
      { label: 'Navigate', value: 'Scroll to zoom · drag to pan · F to fit' },
      { label: 'Pause / step', value: 'Toolbar buttons or Space / /' },
      { label: 'Manual scram', value: 'Shift+S or the red SCRAM button' },
    ],
    shortcuts,
    repo: 'https://github.com/a9lim/a9lim.github.io',
    lastUpdated: '2026-07-16',
  });
}

// ── Period-meter audio ──────────────────────────────────────────────────
initPeriodAudio($, SIM);

// ── Reactor-type selector ───────────────────────────────────────────────
if ($.reactorTypeToggles && window._forms) {
  window._forms.bindModeGroup($.reactorTypeToggles, 'reactor', (newType) => {
    if (!['pwr', 'rbmk', 'msr'].includes(newType)) return;
    if (newType === SIM.state.reactorTypeId) return;
    scenarioEngine.end();
    rebuildState(newType);
  });
}

// ── Initial schematic build + zoom controls ─────────────────────────────
schematic.rebuild(SIM.state);
{
  const cam = schematic.getCamera();
  if (cam && cam.bindZoomButtons) {
    cam.bindZoomButtons({
      zoomIn: $.zoomIn, zoomOut: $.zoomOut, reset: $.zoomReset, display: $.zoomPct,
      onReset: () => schematic.fitAll(),
      formatZoom: z => Math.round(z * 100) + '%',
    });
  }
}
window.addEventListener('resize', () => schematic.resize());
// Layout may not be measured at module-eval time — refit once on the next frame.
requestAnimationFrame(() => { schematic.resize(); schematic.fitAll(); });

// ── Left-rail readouts ──────────────────────────────────────────────────
function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }
function setColored(el, txt, color) {
  if (!el) return;
  if (el.textContent !== txt) el.textContent = txt;
  el.style.color = color || '';
}
function renderRail(s) {
  const out = s.out;
  setText($.gReactorType, s.T.name);
  setText($.gFission, FMT.power(out.fissionPowerMW));
  setText($.gDecay, FMT.power(out.decayHeatMW));
  setText($.gTotal, FMT.power(out.totalCorePowerMW));
  setText($.gGen, FMT.powerE(out.generatorMWe));
  setText($.gSimTime, FMT.simTime(s.simTime));
  setColored($.gReactivity, FMT.reactivityPcm(out.reactivityPcm),
    out.reactivityPcm >= 0 ? COL.alarm : COL.good);
  setText($.gDollars, FMT.dollars(out.reactivityPcm, s.T.betaTotal));
  const p = out.periodSec;
  setColored($.gPeriod, FMT.period(p),
    (isFinite(p) && p > 0 && p < 30) ? COL.alarm
      : ((isFinite(p) && p < 0 && p > -30) ? COL.good : ''));
  setColored($.gAo, FMT.signedPct(out.axialOffset),
    Math.abs(out.axialOffset) > 0.10 ? COL.alarm
      : (Math.abs(out.axialOffset) > 0.05 ? COL.warn : ''));
  if ($.gOrmRow) {
    if (out.orm == null) {
      $.gOrmRow.style.display = 'none';
    } else {
      $.gOrmRow.style.display = '';
      setColored($.gOrm, out.orm.toFixed(1) + ' rods',
        out.orm < 15 ? COL.alarm : (out.orm < 30 ? COL.warn : COL.good));
    }
  }
}

// ── rAF loop ────────────────────────────────────────────────────────────
let last = performance.now();
let sampleAccum = 0;
const SAMPLE_INTERVAL = 0.1;

function frame(now) {
  const wallDt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const s = SIM.state;

  if (s.running) {
    advanceSim(s, wallDt);
    scenarioEngine.tick(s);
    sampleAccum += s._lastAdvancedSimDt ?? (wallDt * s.accel);
    while (sampleAccum >= SAMPLE_INTERVAL) {
      sampleAccum -= SAMPLE_INTERVAL;
      let peakF = 0;
      for (let k = 0; k < s.N; k++) if (s.T_fuel[k] > peakF) peakF = s.T_fuel[k];
      pushSparkSample(hPower, s.out.fissionPowerMW);
      pushSparkSample(hTemp, peakF - 273.15);
      pushSparkSample(hXenon, s.lastReactivityStack.xenon * 1e5);
      pushSparkSample(hAo, s.out.axialOffset);
    }
  } else {
    sampleAccum = 0;
  }

  renderRail(s);
  axial.render(s);
  stack.render(s);
  schematic.render(s);
  inspector.update(s);
  renderAnnunciator(annunciatorCells, s);
  updatePeriodAudio(s);
  scenarioUI.render();

  let peakFuelC = 0;
  for (let k = 0; k < s.N; k++) if (s.T_fuel[k] > peakFuelC) peakFuelC = s.T_fuel[k];
  peakFuelC -= 273.15;
  setText($.stripPowerVal, s.out.fissionPowerMW.toFixed(0) + ' MWth');
  setText($.stripTempVal, peakFuelC.toFixed(0) + ' °C');
  setText($.stripXenonVal, (s.lastReactivityStack.xenon * 1e5).toFixed(0) + ' pcm');
  setText($.stripAoVal, (s.out.axialOffset >= 0 ? '+' : '') + (s.out.axialOffset * 100).toFixed(2) + '%');
  renderSpark($.sparkPower, hPower, '--neutron');
  renderSpark($.sparkTemp, hTemp, '--fuel');
  renderSpark($.sparkXenon, hXenon, '--r-xenon');
  renderSparkAo($.sparkAo, hAo);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for debugging
window._pileSim = SIM;
