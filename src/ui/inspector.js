// inspector.js -- single-slot component inspector dock.
//
// When a schematic component is clicked the dock renders that component's
// declarative inspector field list (see registry.js for the field schema).
// One inspector is shown at a time; selecting another replaces it.
//
// Controls write to SIM.state.cmd (and a few direct physics writes for
// operator actions) via the holder pattern — listeners close over `SIM` so a
// reactor-type swap that replaces SIM.state stays correct.

export function createInspector(dock, SIM, opts = {}) {
  const onClose = opts.onClose || (() => {});
  let refreshers = [];   // [(state) => void]
  let openDef = null;

  const head = document.createElement('div');
  head.className = 'insp-head';
  const title = document.createElement('span');
  title.className = 'insp-title';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tool-btn icon-tight insp-close';
  closeBtn.setAttribute('aria-label', 'Close inspector');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => close());
  head.appendChild(title);
  head.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'insp-body scrollbar-thin';

  dock.replaceChildren(head, body);

  function close() {
    if (!openDef) { dock.classList.remove('open'); return; }
    openDef = null;
    refreshers = [];
    dock.classList.remove('open');
    body.replaceChildren();
    onClose();
  }

  function show(def) {
    if (!def) { close(); return; }
    openDef = def;
    refreshers = [];
    title.textContent = def.title || 'Component';
    body.replaceChildren();
    for (const f of (def.fields || [])) buildField(f);
    dock.classList.add('open');
    update(SIM.state);
  }

  function update(state) {
    if (!openDef) return;
    for (const r of refreshers) {
      try { r(state); } catch (e) { /* tolerate transient state shape gaps */ }
    }
  }

  // ── Field builders ──────────────────────────────────────────────────
  function buildField(f) {
    switch (f.t) {
      case 'group':   return buildGroup(f);
      case 'note':    return buildNote(f);
      case 'readout': return buildReadout(f);
      case 'bar':     return buildBar(f);
      case 'slider':  return buildSlider(f);
      case 'toggle':  return buildToggle(f);
      case 'button':  return buildButton(f);
      case 'modegroup': return buildModeGroup(f);
    }
  }

  function buildGroup(f) {
    const el = document.createElement('div');
    el.className = 'insp-group';
    el.textContent = f.label;
    body.appendChild(el);
  }

  function buildNote(f) {
    const el = document.createElement('p');
    el.className = 'insp-note panel-hint';
    el.textContent = f.text;
    body.appendChild(el);
  }

  function buildReadout(f) {
    const row = document.createElement('div');
    row.className = 'insp-row';
    const lbl = document.createElement('span');
    lbl.className = 'insp-label';
    lbl.textContent = f.label;
    const val = document.createElement('span');
    val.className = 'insp-val';
    row.append(lbl, val);
    body.appendChild(row);
    refreshers.push(s => {
      const txt = String(f.get(s));
      if (val.textContent !== txt) val.textContent = txt;
      val.style.color = f.color ? (f.color(s) || '') : '';
    });
  }

  function buildBar(f) {
    const row = document.createElement('div');
    row.className = 'insp-row insp-bar-row';
    const lbl = document.createElement('span');
    lbl.className = 'insp-label';
    lbl.textContent = f.label;
    const track = document.createElement('div');
    track.className = 'insp-bar';
    const fill = document.createElement('div');
    fill.className = 'insp-bar-fill';
    track.appendChild(fill);
    row.append(lbl, track);
    body.appendChild(row);
    refreshers.push(s => {
      const v = Math.max(0, Math.min(1, f.get(s) || 0));
      fill.style.width = (v * 100).toFixed(1) + '%';
      fill.style.background = f.color ? (f.color(s) || 'var(--text-secondary)') : 'var(--text-secondary)';
    });
  }

  function buildSlider(f) {
    const wrap = document.createElement('div');
    wrap.className = 'insp-ctrl';
    const lblRow = document.createElement('div');
    lblRow.className = 'insp-ctrl-label';
    const lbl = document.createElement('span');
    lbl.textContent = f.label;
    const valSpan = document.createElement('span');
    valSpan.className = 'insp-ctrl-val';
    lblRow.append(lbl, valSpan);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(f.min); input.max = String(f.max); input.step = String(f.step);
    input.value = String(f.get(SIM.state));
    input.setAttribute('aria-label', f.label);
    wrap.append(lblRow, input);
    body.appendChild(wrap);

    let syncing = false;
    const fmt = f.fmt || (v => String(v));
    if (window._forms?.bindSlider) {
      window._forms.bindSlider(input, valSpan,
        v => { if (!syncing) f.set(SIM.state, v); }, fmt);
    } else {
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valSpan.textContent = fmt(v);
        if (!syncing) f.set(SIM.state, v);
      });
      valSpan.textContent = fmt(parseFloat(input.value));
    }

    refreshers.push(s => {
      const disabled = f.disabled ? !!f.disabled(s) : false;
      input.disabled = disabled;
      wrap.classList.toggle('insp-ctrl-locked', disabled);
      // When locked (e.g. rod bank in AUTO) mirror the live value.
      if (disabled) {
        const v = f.get(s);
        if (Math.abs(parseFloat(input.value) - v) > 1e-4) {
          syncing = true;
          input.value = String(v);
          input.dispatchEvent(new Event('input', { bubbles: false }));
          syncing = false;
        }
      }
    });
  }

  function buildToggle(f) {
    const label = document.createElement('label');
    label.className = 'insp-tog tog-wrap';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const tog = document.createElement('span');
    tog.className = 'tog';
    const thumb = document.createElement('span');
    thumb.className = 'tog-thumb';
    tog.appendChild(thumb);
    const span = document.createElement('span');
    span.className = 'insp-tog-label';
    span.textContent = f.label;
    label.append(input, tog, span);
    body.appendChild(label);
    input.checked = !!f.get(SIM.state);
    input.addEventListener('change', () => {
      f.set(SIM.state, input.checked);
      window._haptics?.trigger('selection');
    });
    refreshers.push(s => {
      const v = !!f.get(s);
      if (input.checked !== v) input.checked = v;
    });
  }

  function buildButton(f) {
    const btn = document.createElement('button');
    btn.className = 'insp-btn ghost-btn' + (f.danger ? ' insp-btn-danger' : '');
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      f.onClick(SIM.state);
      window._haptics?.trigger(f.danger ? 'heavy' : 'selection');
    });
    body.appendChild(btn);
    refreshers.push(s => {
      if (f.active) btn.classList.toggle('active', !!f.active(s));
      if (f.label2) {
        const t = f.label2(s);
        if (t && btn.textContent !== t) btn.textContent = t;
      }
    });
  }

  function buildModeGroup(f) {
    const wrap = document.createElement('div');
    wrap.className = 'insp-ctrl';
    const lblRow = document.createElement('div');
    lblRow.className = 'insp-ctrl-label';
    const lbl = document.createElement('span');
    lbl.textContent = f.label;
    lblRow.appendChild(lbl);
    const group = document.createElement('div');
    group.className = 'mode-toggles insp-modegroup';
    const btns = [];
    for (const opt of f.options) {
      const b = document.createElement('button');
      b.className = 'mode-btn';
      b.textContent = opt.label;
      b.addEventListener('click', () => {
        f.set(SIM.state, opt.v);
        window._haptics?.trigger('selection');
      });
      group.appendChild(b);
      btns.push({ b, v: opt.v });
    }
    wrap.append(lblRow, group);
    body.appendChild(wrap);
    refreshers.push(s => {
      const cur = f.get(s);
      for (const { b, v } of btns) {
        const on = v === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    });
  }

  return { show, close, update, isOpen: () => !!openDef };
}
