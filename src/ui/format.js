// format.js -- value formatters shared by the schematic inline readouts and
// the component inspector. Extracted from the old gauges.js FMT table so the
// two render paths (SVG <text> labels + inspector rows) agree on units.

export const FMT = {
  power: v => v.toFixed(0) + ' MWth',
  power1: v => v.toFixed(1) + ' MWth',
  powerE: v => v.toFixed(0) + ' MWe',
  period: v => {
    if (!isFinite(v) || Math.abs(v) > 1e6) return '∞';
    if (Math.abs(v) < 0.1) return v.toExponential(1) + ' s';
    return v.toFixed(1) + ' s';
  },
  reactivityPcm: v => (v >= 0 ? '+' : '') + v.toFixed(0) + ' pcm',
  dollars: (v, beta) => {
    const d = v / (beta * 1e5);
    return (d >= 0 ? '+' : '') + d.toFixed(2) + ' $';
  },
  tempC: v => (v - 273.15).toFixed(0) + ' °C',
  tempC1: v => (v - 273.15).toFixed(1) + ' °C',
  deltaT: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' K',
  pressureMPa: v => v.toFixed(2) + ' MPa',
  ppm: v => v.toFixed(0) + ' ppm',
  pct: v => (v * 100).toFixed(0) + '%',
  pct1: v => (v * 100).toFixed(1) + '%',
  flowKgPerS: v => v.toFixed(0) + ' kg/s',
  // Westinghouse panels read pump flow in gpm; internal physics is kg/s.
  gpm: v => {
    const g = v / 0.0631;
    if (g < 1) return '0 gpm';
    if (g < 10) return g.toFixed(1) + ' gpm';
    return g.toFixed(0) + ' gpm';
  },
  burnup: v => v.toFixed(0) + ' MWd/tU',
  signedPct: v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%',
  mmss: secs => {
    if (secs == null || !Number.isFinite(secs)) return '—';
    const s = Math.max(0, secs);
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  },
  simTime: s => {
    if (s < 60) return s.toFixed(1) + ' s';
    if (s < 3600) return (s / 60).toFixed(1) + ' min';
    if (s < 86400) return (s / 3600).toFixed(2) + ' hr';
    return (s / 86400).toFixed(2) + ' d';
  },
  amps: v => (v >= 0 ? '+' : '') + v.toFixed(0) + ' A',
  detSr: (cps, off) => off
    ? '> 1e5 cps'
    : (cps < 1 ? cps.toExponential(1) + ' cps' : cps.toFixed(0) + ' cps'),
  detIr: frac => '10^' + Math.log10(Math.max(frac, 1e-12)).toFixed(1),
  detPr: (frac, low) => low ? '< 1%' : (frac * 100).toFixed(1) + '%',
};

// Color tokens for value severity. Returned as CSS var() strings so the
// inspector / schematic can set element style directly.
export const COL = {
  ok: '',
  warn: 'var(--r-doppler)',
  alarm: 'var(--r-pos)',
  good: 'var(--r-neg)',
};

// band(value, warnAt, alarmAt) -> color, for monotone-increasing severity.
export function band(v, warnAt, alarmAt) {
  if (v >= alarmAt) return COL.alarm;
  if (v >= warnAt) return COL.warn;
  return COL.ok;
}
// bandLow -> severity increases as value drops.
export function bandLow(v, warnAt, alarmAt) {
  if (v <= alarmAt) return COL.alarm;
  if (v <= warnAt) return COL.warn;
  return COL.ok;
}

// Peak helper — many readouts want the hottest axial node.
export function peak(arr, n) {
  let m = -Infinity;
  for (let k = 0; k < n; k++) if (arr[k] > m) m = arr[k];
  return m;
}
