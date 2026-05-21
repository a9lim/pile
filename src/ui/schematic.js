// schematic.js -- registry-driven SVG plant schematic.
//
// Builds the diagram (zones, pipes, components) from registry.js, drives
// zoom/pan via the shared `createCamera` helper, dispatches click-to-select,
// and refreshes inline readouts + flow animation + temperature coloring +
// alarm pulses each frame.
//
// State is read-only here — physics owns all writes.

import { buildRegistry } from './registry.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Resolve CSS custom properties to rgb triples (canvas round-trip), cached
// and flushed on theme change.
function makeColorResolver() {
  const probe = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return {
    rgb(varName) {
      if (cache.has(varName)) return cache.get(varName);
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue(varName).trim() || '#808080';
      probe.fillStyle = '#000';
      probe.fillStyle = raw;
      const norm = probe.fillStyle;
      let rgb = [128, 128, 128];
      if (norm.startsWith('#') && norm.length === 7) {
        rgb = [parseInt(norm.slice(1, 3), 16), parseInt(norm.slice(3, 5), 16),
               parseInt(norm.slice(5, 7), 16)];
      } else {
        const m = norm.match(/(\d+)\D+(\d+)\D+(\d+)/);
        if (m) rgb = [+m[1], +m[2], +m[3]];
      }
      cache.set(varName, rgb);
      return rgb;
    },
    invalidate() { cache.clear(); },
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerpRgb(a, b, t) {
  return `rgb(${(lerp(a[0], b[0], t)) | 0},${(lerp(a[1], b[1], t)) | 0},${(lerp(a[2], b[2], t)) | 0})`;
}

const BASE_FLOW_SPEED = 26; // SVG px / sim-equivalent second

function addText(parent, cls, x, y, txt) {
  const t = svgEl('text', { class: cls, x, y });
  if (txt != null) t.textContent = txt;
  parent.appendChild(t);
  return t;
}

// Generic component — vessel / tank / pump / valve / etc.
function buildComponent(def, parent) {
  const g = svgEl('g', { class: 'sch-comp', 'data-id': def.id });
  const circle = def.kind === 'pump' || def.kind === 'generator';
  const cx = def.x + def.w / 2;
  let shapeEl;
  if (circle) {
    shapeEl = svgEl('circle', { class: 'sch-shape sch-shape-' + def.kind,
      cx, cy: def.y + def.h / 2, r: Math.min(def.w, def.h) / 2 });
  } else {
    shapeEl = svgEl('rect', { class: 'sch-shape sch-shape-' + def.kind,
      x: def.x, y: def.y, width: def.w, height: def.h, rx: 3 });
  }
  g.appendChild(shapeEl);
  const readoutEls = [];
  if (circle) {
    addText(g, 'sch-label', cx, def.y + def.h + 15, def.label);
    for (let i = 0; i < 2; i++)
      readoutEls.push(addText(g, 'sch-readout', cx, def.y + def.h + 30 + i * 14));
  } else {
    const hasSub = !!def.sub && def.h >= 78;
    addText(g, 'sch-label', cx, def.y + 19, def.label);
    if (hasSub) addText(g, 'sch-sub', cx, def.y + 32, def.sub);
    let ry = def.y + (hasSub ? 50 : 35);
    for (let i = 0; i < 3; i++) { readoutEls.push(addText(g, 'sch-readout', cx, ry)); ry += 16; }
  }
  parent.appendChild(g);
  return { def, g, shapeEl, readoutEls };
}

// Reactor core — drawn as a top-down assembly map. The vessel outline plus a
// grid of fuel-assembly cells recoloured per frame from the synthesized
// radial power map (radial bowing × quadrant tilt × power level).
function buildCore(def, parent) {
  const g = svgEl('g', { class: 'sch-comp sch-comp-core', 'data-id': def.id });
  const square = def.coreShape === 'square';
  const cx = def.x + def.w / 2;
  const diam = Math.min(def.w, def.h - 58) - 30;
  const ccx = cx, ccy = def.y + 32 + diam / 2;
  let shapeEl;
  if (square) {
    shapeEl = svgEl('rect', { class: 'sch-shape sch-shape-core',
      x: ccx - diam / 2, y: ccy - diam / 2, width: diam, height: diam, rx: 4 });
  } else {
    shapeEl = svgEl('circle', { class: 'sch-shape sch-shape-core',
      cx: ccx, cy: ccy, r: diam / 2 });
  }
  g.appendChild(shapeEl);
  const GRID = 13;
  const pitch = diam / GRID;
  const gap = Math.max(1.5, pitch * 0.14);
  const cellG = svgEl('g', { class: 'sch-core-cells' });
  const coreCells = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const nx = ((i + 0.5) / GRID) * 2 - 1;
    const ny = ((j + 0.5) / GRID) * 2 - 1;
    const rr = Math.hypot(nx, ny);
    if (!square && rr > 1.02) continue;
    const rect = svgEl('rect', { class: 'sch-core-cell',
      x: ccx - diam / 2 + i * pitch + gap / 2,
      y: ccy - diam / 2 + j * pitch + gap / 2,
      width: pitch - gap, height: pitch - gap });
    cellG.appendChild(rect);
    coreCells.push({ rect, nx, ny, r: Math.min(rr, 1) });
  }
  g.appendChild(cellG);
  addText(g, 'sch-label', cx, def.y + 20, def.label);
  const readoutEls = [];
  for (let i = 0; i < 2; i++)
    readoutEls.push(addText(g, 'sch-readout', cx, def.y + def.h - 22 + i * 16));
  parent.appendChild(g);
  return { def, g, shapeEl, readoutEls, coreCells };
}

// Per-frame recolour of the core assembly map.
function updateCore(ce, s, coolRgb, hotRgb) {
  const pf = clamp01(s.out.detPrFrac != null
    ? s.out.detPrFrac : (s.out.fissionPowerMW / 3400));
  let q = [1, 1, 1, 1];
  const qp = s.out.quadrantPower;
  if (qp && qp.length === 4) {
    const m = (qp[0] + qp[1] + qp[2] + qp[3]) / 4 || 1;
    q = [qp[0] / m, qp[1] / m, qp[2] / m, qp[3] / m];
  }
  const skew = s.out.radialSkew || 0;
  for (const c of ce.coreCells) {
    const base = Math.max(0.12, Math.cos(c.r * 1.4)) * (1 + skew * (0.5 - c.r));
    const qi = (c.ny < 0 ? 0 : 2) + (c.nx < 0 ? 0 : 1);
    const t = clamp01(base * q[qi] * (0.18 + 0.92 * pf));
    c.rect.style.fill = lerpRgb(coolRgb, hotRgb, t);
  }
}

export function createSchematic(svg, stage, opts = {}) {
  const onSelect = opts.onSelect || (() => {});
  const colors = makeColorResolver();

  let reg = null;
  let cam = null;
  let selectedId = null;
  // per-build live element registries
  let compEls = [];      // { def, g, shapeEl, readoutEls[], built }
  let pipeEls = [];       // { def, pathEl, offset }
  let lastNow = performance.now();

  // Theme change → flush color cache.
  new MutationObserver(muts => {
    for (const m of muts) if (m.attributeName === 'data-theme') colors.invalidate();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ── Build / rebuild for a reactor type ────────────────────────────────
  function rebuild(state) {
    reg = buildRegistry(state.reactorTypeId);
    svg.replaceChildren();
    compEls = [];
    pipeEls = [];
    selectedId = null;

    const gZones = svgEl('g', { class: 'sch-zones' });
    const gPipes = svgEl('g', { class: 'sch-pipes' });
    const gComps = svgEl('g', { class: 'sch-comps' });

    // Zones
    for (const z of reg.zones) {
      const r = svgEl('rect', {
        class: 'sch-zone' + (z.partial ? ' sch-zone-partial' : ''),
        x: z.x, y: z.y, width: z.w, height: z.h, rx: 4,
      });
      gZones.appendChild(r);
      if (z.label) {
        const t = svgEl('text', { class: 'sch-zone-label', x: z.x + 12, y: z.y + 20 });
        t.textContent = z.label;
        gZones.appendChild(t);
      }
    }

    // Pipes
    for (const def of reg.pipes) {
      const p = svgEl('path', {
        class: 'sch-pipe sch-pipe-' + def.kind + (def.flow ? ' sch-flow' : ''),
        d: def.d,
      });
      gPipes.appendChild(p);
      pipeEls.push({ def, pathEl: p, offset: 0 });
    }

    // Components — core gets the top-down assembly map, the rest a shape.
    for (const def of reg.components) {
      compEls.push(def.kind === 'core'
        ? buildCore(def, gComps)
        : buildComponent(def, gComps));
    }

    svg.appendChild(gZones);
    svg.appendChild(gPipes);
    svg.appendChild(gComps);

    // Camera — fit the whole plant on (re)build.
    const rect = stage.getBoundingClientRect();
    if (!cam) {
      cam = window.createCamera({
        width: rect.width || 800, height: rect.height || 600,
        minZoom: 0.12, maxZoom: 3.5, wheelFactor: 1.12,
        onUpdate: c => svg.setAttribute('viewBox', c.getViewBoxString()),
      });
      cam.bindWheel(svg);
      cam.bindTouch(svg, { singleFingerPan: false });
      bindDragSelect();
    } else {
      cam.setViewport(rect.width || 800, rect.height || 600);
    }
    cam.zoomToFit(reg.viewBox, 0);
  }

  // ── Pointer: left-drag pans, click (no drag) selects ─────────────────
  function bindDragSelect() {
    let downX = 0, downY = 0, lastX = 0, lastY = 0, dragging = false, moved = 0;
    svg.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      downX = lastX = e.clientX; downY = lastY = e.clientY;
      dragging = true; moved = 0;
      svg.classList.add('grabbing');
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (cam) cam.panBy(dx, dy);
    });
    window.addEventListener('mouseup', e => {
      if (!dragging) return;
      dragging = false;
      svg.classList.remove('grabbing');
      if (moved < 5) {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const comp = hit && hit.closest && hit.closest('.sch-comp');
        select(comp ? comp.dataset.id : null);
      }
    });
  }

  function select(id) {
    if (id === selectedId) return;          // no-op guard breaks close() recursion
    selectedId = id;
    for (const c of compEls) c.g.classList.toggle('selected', c.def.id === id);
    onSelect(id);
  }

  function fitAll() {
    if (cam && reg) cam.zoomToFit(reg.viewBox, 280);
  }

  // Programmatic focus — used by the inspector dock / external select.
  function focusComponent(id) {
    const c = compEls.find(x => x.def.id === id);
    select(id);
    if (c && cam) {
      cam.zoomToFit({ x: c.def.x - 90, y: c.def.y - 90, w: c.def.w + 180, h: c.def.h + 180 }, 280);
    }
  }

  function resize() {
    if (!cam) return;
    const rect = stage.getBoundingClientRect();
    cam.setViewport(rect.width || 800, rect.height || 600);
  }

  // ── Per-frame render ─────────────────────────────────────────────────
  function render(state) {
    if (!reg) return;   // rebuild() must run first (main.js handles type swap)
    const now = performance.now();
    const dtWall = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;

    const T = state.T;
    const tCold = T.coolantInletTempK, tHot = T.coolantOutletTempK;
    const span = Math.max(tHot - tCold, 1);
    const coldRgb = colors.rgb('--coolant-cold');
    const hotRgb = colors.rgb('--coolant-hot');
    const neutronRgb = colors.rgb('--neutron');
    const fuelRgb = colors.rgb('--fuel');

    // Pipes — flow marquee + temperature recolor.
    for (const pe of pipeEls) {
      const def = pe.def;
      if (def.flow && state.running) {
        const frac = Math.max(0, def.flow(state) || 0);
        const accelTerm = 1 + Math.max(0, Math.log10(Math.max(state.accel, 1))) * 0.7;
        let off = pe.offset - Math.min(frac * accelTerm, 6) * BASE_FLOW_SPEED * dtWall;
        if (off < -1300 || off > 1300) off = off % 130;
        pe.offset = off;
        pe.pathEl.style.strokeDashoffset = off.toFixed(2);
      }
      if (def.temp) {
        const t = clamp01((def.temp(state) - tCold) / span);
        pe.pathEl.style.stroke = lerpRgb(coldRgb, hotRgb, t);
      }
    }

    // Components — inline readouts, tint, alarm, selection.
    for (const ce of compEls) {
      const def = ce.def;
      if (def.readout) {
        let lines;
        try { lines = def.readout(state) || []; } catch (e) { lines = []; }
        for (let i = 0; i < ce.readoutEls.length; i++) {
          const txt = lines[i] != null ? String(lines[i]) : '';
          if (ce.readoutEls[i].textContent !== txt) ce.readoutEls[i].textContent = txt;
        }
      }
      if (ce.coreCells) {
        updateCore(ce, state, neutronRgb, fuelRgb);
      } else if (def.tint) {
        const v = def.tint(state);
        ce.shapeEl.style.fill = v
          ? `color-mix(in srgb, var(${v}) 20%, var(--bg-hover))` : '';
      }
      let alarmed = false;
      if (def.alarm) { try { alarmed = !!def.alarm(state); } catch (e) { alarmed = false; } }
      ce.g.classList.toggle('alarm', alarmed);
    }
  }

  function getComponent(id) {
    const c = compEls.find(x => x.def.id === id);
    return c ? c.def : null;
  }

  return { rebuild, render, select, focusComponent, resize, getComponent, fitAll,
    getCamera: () => cam, getSelected: () => selectedId };
}
