// stack.js -- horizontal stacked-bar visualization of the reactivity stack.
//
// Contributions go left if negative, right if positive, anchored at center.
// Each contribution drawn as its own colored segment, signed so the visible
// breakdown shows what's holding the reactor critical.

const KEYS = ['rods', 'boron', 'doppler', 'moderator', 'void', 'xenon', 'burnup'];
const LABELS = {
  rods: 'Rods', boron: 'Boron', doppler: 'Doppler',
  moderator: 'Moderator', void: 'Void', xenon: 'Xenon',
  // II.1 — Fuel-cycle excess-ρ relative to the loaded initial burnup state.
  burnup: 'Burnup',
};
const VARS = {
  rods: '--r-rod', boron: '--r-boron', doppler: '--r-doppler',
  moderator: '--r-moderator', void: '--r-void', xenon: '--r-xenon',
  // Re-use the doppler accent — they're both fuel-physics terms and the
  // colors.js token palette doesn't yet have a dedicated burnup hue.
  burnup: '--r-doppler',
};

export function createReactivityStack(canvas) {
  function render(state) {
    if (!canvas.isConnected) return;
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = window.resizeCanvasDPR(canvas, ctx);
    ctx.clearRect(0, 0, w, h);
    const stack = state.lastReactivityStack;
    const cs = getComputedStyle(canvas);
    const axisColor = cs.getPropertyValue('--chart-axis').trim() || 'rgba(0,0,0,0.7)';

    // Range: dynamic, max of |stack value| × 1.2, but at least 10000 pcm
    let maxAbs = 10000;
    for (const k of KEYS) {
      const v = Math.abs(stack[k] * 1e5);
      if (v > maxAbs) maxAbs = v;
    }
    maxAbs *= 1.2;

    const barH = 18;
    const rowGap = 6;
    const labelW = 70;
    const valW = 90;
    const inner = { x: labelW, w: w - labelW - valW, y: 6 };
    const cx = inner.x + inner.w / 2;

    // Header
    ctx.fillStyle = axisColor;
    ctx.font = '10px Recursive, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('— pcm  ←  0  →  + pcm', cx, inner.y + 8);
    inner.y += 18;

    // Center line
    ctx.strokeStyle = axisColor;
    ctx.beginPath();
    const yEnd = inner.y + KEYS.length * (barH + rowGap);
    ctx.moveTo(cx, inner.y);
    ctx.lineTo(cx, yEnd);
    ctx.stroke();

    KEYS.forEach((k, i) => {
      const v = stack[k] * 1e5;
      const y = inner.y + i * (barH + rowGap);
      // Label
      ctx.textAlign = 'right';
      ctx.fillStyle = axisColor;
      ctx.font = '11px Recursive, monospace';
      ctx.fillText(LABELS[k], labelW - 6, y + barH / 2 + 4);
      // Bar
      const frac = Math.min(1, Math.abs(v) / maxAbs);
      const barLen = frac * (inner.w / 2);
      const color = cs.getPropertyValue(VARS[k]).trim() || '#888';
      ctx.fillStyle = color;
      if (v >= 0) ctx.fillRect(cx, y, barLen, barH);
      else        ctx.fillRect(cx - barLen, y, barLen, barH);
      // Value
      ctx.textAlign = 'left';
      ctx.fillStyle = axisColor;
      ctx.font = '11px Recursive, monospace';
      ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(0), inner.x + inner.w + 4, y + barH / 2 + 4);
    });

    // Total
    const total = stack.total * 1e5;
    const yT = inner.y + KEYS.length * (barH + rowGap) + 8;
    ctx.textAlign = 'right';
    ctx.fillStyle = axisColor;
    ctx.font = 'bold 11px Recursive, monospace';
    ctx.fillText('Total', labelW - 6, yT + 4);
    ctx.textAlign = 'left';
    ctx.fillStyle = total >= 0
      ? (cs.getPropertyValue('--r-pos').trim() || '#c33')
      : (cs.getPropertyValue('--r-neg').trim() || '#3a3');
    ctx.fillText((total >= 0 ? '+' : '') + total.toFixed(0) + ' pcm', inner.x + inner.w + 4, yT + 4);
    // Also display in dollars
    const dollars = total / (state.T.betaTotal * 1e5);
    ctx.fillStyle = axisColor;
    ctx.fillText('(' + (dollars >= 0 ? '+' : '') + dollars.toFixed(2) + ' $)', inner.x + inner.w + 70, yT + 4);
  }
  return { render };
}
