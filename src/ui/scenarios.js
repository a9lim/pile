// src/ui/scenarios.js — Wave 3 scenario UI: a picker overlay (opened from a
// toolbar button) and a live objectives HUD. The scenario *engine* lives in
// scenarios/engine.js; this module is its operator-facing surface.
//
// New-file innerHTML hook: every node here is built with createElement /
// textContent / replaceChildren — never innerHTML.

import { SCENARIOS } from '../../scenarios/index.js';

// initScenarios(SIM, engine, hooks) — wires the overlay + HUD and returns a
// { render } whose render() is called once per rAF frame.
//
// hooks: {
//   rebuildState(typeId)  — createState(typeId) + re-wire all UI (main.js)
//   setPlaying(bool)      — play/pause
//   syncSpeed()           — refresh the speed button label
// }
export function initScenarios(SIM, engine, hooks) {
  const overlay  = document.getElementById('scenario-overlay');
  const list     = document.getElementById('scenario-list');
  const openBtn  = document.getElementById('scenario-btn');
  const closeBtn = document.getElementById('scenario-close');
  const hud      = document.getElementById('scenario-hud');

  // Per-scenario HUD refs, rebuilt by buildHud().
  let objRows = [];
  let statusEl = null;

  function openOverlay()  { if (overlay) overlay.hidden = false; }
  function closeOverlay() { if (overlay) overlay.hidden = true; }

  if (openBtn) openBtn.addEventListener('click', openOverlay);
  // shared helper wires close-button + backdrop-click dismiss; Escape stays local.
  initOverlayDismiss(overlay, closeBtn, closeOverlay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) closeOverlay();
  });

  // ── Picker cards ───────────────────────────────────────────────────────
  for (const sc of SCENARIOS) {
    const card = document.createElement('div');
    card.className = 'scenario-card';

    const h = document.createElement('h3');
    h.className = 'scenario-card-title';
    h.textContent = sc.title;
    card.appendChild(h);

    const p = document.createElement('p');
    p.className = 'scenario-card-summary';
    p.textContent = sc.summary;
    card.appendChild(p);

    const btn = document.createElement('button');
    btn.className = 'ghost-btn scenario-start-btn';
    btn.textContent = 'Start scenario';
    btn.addEventListener('click', () => startScenario(sc, btn));
    card.appendChild(btn);

    if (list) list.appendChild(card);
  }

  async function startScenario(sc, btn) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    let mod;
    try {
      const imported = await sc.load();
      mod = imported.default;
    } catch (_) {
      btn.disabled = false;
      btn.textContent = 'Load failed — retry';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Start scenario';

    launch(mod);
    closeOverlay();
  }

  // Build the scenario's reactor state and arm the engine. Shared by the
  // picker's Start button and the HUD's Restart button.
  function launch(mod) {
    hooks.rebuildState(mod.type);  // createState(type) + re-wire all UI
    engine.begin(mod, SIM.state);  // reset() + setup() + accel + tracking
    hooks.setPlaying(false);       // start paused on the briefing
    hooks.syncSpeed();             // begin() just changed state.accel
    buildHud(mod);
  }

  // ── HUD ────────────────────────────────────────────────────────────────
  function buildHud(mod) {
    if (!hud) return;
    hud.replaceChildren();
    objRows = [];
    statusEl = null;

    const title = document.createElement('div');
    title.className = 'scenario-hud-title';
    title.textContent = mod.title;
    hud.appendChild(title);

    if (mod.intro) {
      const intro = document.createElement('p');
      intro.className = 'scenario-hud-intro';
      intro.textContent = mod.intro;
      hud.appendChild(intro);
    }

    const objList = document.createElement('div');
    objList.className = 'scenario-hud-objs';
    for (const o of mod.objectives) {
      const row = document.createElement('div');
      row.className = 'scenario-obj';

      const dot = document.createElement('span');
      dot.className = 'scenario-obj-dot';
      row.appendChild(dot);

      const txt = document.createElement('span');
      txt.className = 'scenario-obj-text';
      txt.textContent = o.text;
      row.appendChild(txt);

      objList.appendChild(row);
      objRows.push({ dot, row });
    }
    hud.appendChild(objList);

    statusEl = document.createElement('div');
    statusEl.className = 'scenario-status';
    statusEl.textContent = 'Objectives 0 / ' + mod.objectives.length;
    hud.appendChild(statusEl);

    const actions = document.createElement('div');
    actions.className = 'scenario-hud-actions';

    const restartBtn = document.createElement('button');
    restartBtn.className = 'ghost-btn scenario-hud-btn';
    restartBtn.textContent = 'Restart';
    restartBtn.addEventListener('click', () => {
      const a = engine.getActive();
      if (a) launch(a.module);
    });
    actions.appendChild(restartBtn);

    const endBtn = document.createElement('button');
    endBtn.className = 'ghost-btn scenario-hud-btn';
    endBtn.textContent = 'End scenario';
    endBtn.addEventListener('click', () => {
      engine.end();
      hud.hidden = true;
    });
    actions.appendChild(endBtn);

    hud.appendChild(actions);
    hud.hidden = false;
  }

  // ── Per-frame render ───────────────────────────────────────────────────
  function render() {
    const active = engine.getActive();
    if (!active) {
      if (hud && !hud.hidden) hud.hidden = true;
      return;
    }
    if (hud && hud.hidden) hud.hidden = false;

    for (let i = 0; i < objRows.length; i++) {
      const met = !!(active.objectives[i] && active.objectives[i].met);
      objRows[i].dot.classList.toggle('met', met);
      objRows[i].row.classList.toggle('met', met);
    }

    if (!statusEl) return;
    if (active.failed) {
      statusEl.textContent = 'Failed — ' + active.failReason;
      statusEl.className = 'scenario-status failed';
    } else if (active.complete) {
      statusEl.textContent = 'Scenario complete — all objectives met.';
      statusEl.className = 'scenario-status complete';
    } else {
      const done = active.objectives.filter((o) => o.met).length;
      statusEl.textContent = 'Objectives ' + done + ' / ' + active.objectives.length;
      statusEl.className = 'scenario-status';
    }
  }

  return { render };
}
