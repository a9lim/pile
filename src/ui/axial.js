// axial.js -- vertical canvas showing per-node profiles: flux, T_fuel, xenon.
//
// Each profile is drawn as a filled curve from a center line, with the core
// outline drawn around them. Rod insertion is overlaid as a dark bar from the
// top descending.

export function createAxialDisplay(canvas) {
  function render(state) {
    if (!canvas.isConnected) return;
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = window.resizeCanvasDPR(canvas, ctx);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(canvas);
    const cFlux = cs.getPropertyValue('--neutron').trim() || '#39c';
    const cFuel = cs.getPropertyValue('--fuel').trim() || '#c33';
    const cXe = cs.getPropertyValue('--r-xenon').trim() || '#838';
    const cRod = cs.getPropertyValue('--r-rod').trim() || '#3a3';
    const cVoid = cs.getPropertyValue('--r-void').trim() || '#cb3';
    const cAxis = cs.getPropertyValue('--chart-axis').trim() || 'rgba(0,0,0,0.6)';
    const cGrid = cs.getPropertyValue('--chart-grid').trim() || 'rgba(0,0,0,0.07)';

    const N = state.N;
    const margin = 24;
    const colW = (w - 4 * margin) / 3;
    const innerH = h - 40;
    const x0 = margin;

    const cols = [
      { label: 'Flux', color: cFlux, data: state.flux, max: 2.5, peak: peak(state.flux) },
      { label: 'T_pellet °C', color: cFuel, data: state.T_fuel.map(v => v - 273.15), max: 1600, peak: peak(state.T_fuel) - 273.15 },
      { label: 'Xe-135', color: cXe, data: state.xenon, max: 2.5, peak: peak(state.xenon) },
    ];

    cols.forEach((c, idx) => {
      const cx = x0 + idx * (colW + margin) + colW / 2;
      const xL = cx - colW / 2;
      const xR = cx + colW / 2;
      const yTop = 20;
      const yBot = yTop + innerH;

      // Column outline (light fill behind = core boundary)
      ctx.fillStyle = cGrid;
      ctx.fillRect(xL, yTop, colW, innerH);

      // Data fill from baseline (left edge)
      const ndata = c.data instanceof Float64Array ? c.data : Float64Array.from(c.data);
      ctx.fillStyle = c.color + (idx === 1 ? '' : '');
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(xL, yBot);
      for (let k = 0; k < N; k++) {
        const yFrac = (k + 0.5) / N;
        const y = yBot - yFrac * innerH;
        const xFrac = Math.min(1, Math.max(0, ndata[k] / c.max));
        const x = xL + xFrac * colW;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(xL, yTop);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // Center vertical axis
      ctx.strokeStyle = cAxis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xL, yTop);
      ctx.lineTo(xL, yBot);
      ctx.stroke();

      // T_clad overlay on the pellet-temperature column. Drawn as a thin line
      // on the same °C scale (max 1600) so the operator sees the pellet→clad
      // temperature drop directly. MSR slaves T_clad to T_coolant (no real
      // clad), so the overlay degenerates to the coolant profile there.
      if (idx === 1 && state.T_clad) {
        ctx.strokeStyle = cRod;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (let k = 0; k < N; k++) {
          const yFrac = (k + 0.5) / N;
          const y = yBot - yFrac * innerH;
          const v = state.T_clad[k] - 273.15;
          const xFrac = Math.min(1, Math.max(0, v / 1600));
          const x = xL + xFrac * colW;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Rod insertion overlay (flux column only)
      if (idx === 0) {
        const rodFrac = state.rodBanks.regulating;
        if (rodFrac > 0) {
          ctx.fillStyle = cRod;
          ctx.globalAlpha = 0.4;
          ctx.fillRect(xL, yTop, colW, rodFrac * innerH);
          ctx.globalAlpha = 1;
        }
        // Void fraction overlay (right edge, narrow band)
        let totalVoid = 0;
        for (let k = 0; k < N; k++) totalVoid += state.voidFrac[k];
        if (totalVoid > 0.01) {
          ctx.fillStyle = cVoid;
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(xR, yBot);
          for (let k = 0; k < N; k++) {
            const yFrac = (k + 0.5) / N;
            const y = yBot - yFrac * innerH;
            const v = state.voidFrac[k];
            const x = xR - v * colW * 0.3;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(xR, yTop);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // I.2 — DNBR overlay on the Flux column. Per-node DNBR plotted
        // against a 0-5 horizontal scale across the column width, with a
        // dashed vertical reference at DNBR=1.3 (the trip threshold).
        // Curve coloured red when minimum is in the trip band; amber in
        // the warn band (1.3-1.5); plain accent above. Skipped for MSR
        // (dnbrPerNode null because no boiling crisis exists).
        const dnbr = state.out.dnbrPerNode;
        if (dnbr && dnbr.length === N) {
          const dnbrMin = state.out.dnbrMin;
          let dnbrColor;
          if (dnbrMin !== null && dnbrMin < 1.3) {
            dnbrColor = cs.getPropertyValue('--r-pos').trim() || '#c33';
          } else if (dnbrMin !== null && dnbrMin < 1.5) {
            dnbrColor = cs.getPropertyValue('--r-doppler').trim() || '#c93';
          } else {
            dnbrColor = cAxis;
          }
          // Trip-threshold reference line first (so curve draws on top).
          const xTrip = xL + (1.3 / 5) * colW;
          ctx.strokeStyle = 'rgba(255,80,80,0.35)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(xTrip, yTop);
          ctx.lineTo(xTrip, yBot);
          ctx.stroke();
          ctx.setLineDash([]);
          // Per-node DNBR trace.
          ctx.strokeStyle = dnbrColor;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let k = 0; k < N; k++) {
            const yFrac = (k + 0.5) / N;
            const y = yBot - yFrac * innerH;
            const xFrac = Math.min(1, Math.max(0, dnbr[k] / 5));
            const x = xL + xFrac * colW;
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      // Label + peak value
      ctx.fillStyle = cAxis;
      ctx.font = '10px Recursive, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(c.label, xL, yBot + 13);
      ctx.textAlign = 'right';
      ctx.fillText(formatPeak(c.peak), xR, yBot + 13);

      // Top label (bottom of core marker)
      ctx.textAlign = 'left';
      ctx.fillText('TOP', xL, yTop - 6);
    });
  }

  return { render };
}

function peak(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}
function formatPeak(v) {
  if (Math.abs(v) > 100) return v.toFixed(0);
  if (Math.abs(v) > 1) return v.toFixed(2);
  return v.toExponential(1);
}
