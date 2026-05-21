// period-audio.js -- audible count-rate channel (the operator's "period meter").
//
// Real PWR/RBMK control rooms have an audio count-rate channel: a loudspeaker
// that clicks once per (scaled) neutron detection. Operators learn to *hear*
// the reactor — a slow tick at shutdown, an accelerating chatter as it climbs
// toward criticality, a frantic machine-gun on a short positive period. This
// module reproduces that instrument with WebAudio.
//
// DESIGN: a click train, not a continuous tone. The pitch of a tone would
// imply a continuous analog signal; the count-rate channel is genuinely
// discrete (one click ~ one scaled count) and the click *rate* is the
// pedagogically truthful readout — it tracks neutron population directly, and
// a shortening period shows up as the rate accelerating. Each click is a
// short decaying sine burst synthesised in-browser (no samples, no assets).
//
// All audio is generated client-side via the WebAudio API, so there is no
// network fetch and nothing for the site CSP to gate (see report).
//
// Off by default. The AudioContext is created lazily inside the toggle's
// click handler so it satisfies the browser autoplay-gesture policy. Driven
// from main.js's rAF loop: initPeriodAudio($, SIM) once, updatePeriodAudio(s)
// per frame.

// ── Tuning constants ───────────────────────────────────────────────────────
// Click rate is derived from neutron population (fission power fraction). The
// count-rate channel is a log instrument in real life; we map log-power to a
// click rate between a slow idle tick and a capped ceiling so it never
// degenerates into a continuous buzz.
const RATE_MIN_HZ      = 0.5;    // shutdown / source-range idle tick
const RATE_MAX_HZ      = 22;     // ceiling — past this the ear hears a buzz, not counts
const RATE_FLOOR_POWER = 1e-6;   // power fraction mapped to RATE_MIN_HZ
const RATE_CEIL_POWER  = 1.5;    // power fraction mapped to RATE_MAX_HZ (slightly over nominal)

// A short positive period (power rising fast) gets an additional rate boost on
// top of the power-based rate, so "going critical" is audibly distinct from
// "sitting at power." Boost ramps in for periods shorter than ~80 s.
const PERIOD_ALARM_S   = 80;     // positive periods below this start adding urgency
const PERIOD_BOOST_MAX = 1.6;   // multiplier on click rate at a very short period

// Click timbre. Pitch nudges up slightly as rate climbs so a fast train also
// sounds higher — reinforces the "reactor is hot" cue without a separate tone.
const CLICK_FREQ_LO    = 760;    // Hz, idle click pitch
const CLICK_FREQ_HI    = 1280;   // Hz, fast-train click pitch
const CLICK_DECAY_S    = 0.028;  // exponential amplitude decay of each burst
const GAIN_DEFAULT     = 0.16;   // master gain — modest; the channel is a monitor, not an alarm

// Real-time scheduling guard. At high time-accel the period readout is still
// real-time-meaningful, but the *click train must stay a real-time instrument*
// — a control-room speaker clicks in wall time, not sim time. We schedule
// clicks against the AudioContext clock (wall time) and the rate cap keeps it
// from machine-gunning regardless of accel. updatePeriodAudio reads sim state
// once per rAF frame; the scheduler interpolates clicks between frames.
const SCHEDULE_AHEAD_S = 0.12;   // how far ahead of the audio clock we queue clicks

export function initPeriodAudio($, SIM) {
  const state = {
    enabled: false,
    ctx: null,
    master: null,
    rateHz: RATE_MIN_HZ,
    nextClickTime: 0,    // AudioContext-clock timestamp of the next scheduled click
    btn: $ && $.audioBtn ? $.audioBtn : null,
  };

  // Lazy AudioContext + master gain. Created on first enable (user gesture),
  // reused thereafter. Returns false if WebAudio is unavailable.
  function ensureContext() {
    if (state.ctx) return true;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    state.ctx = new Ctor();
    state.master = state.ctx.createGain();
    state.master.gain.value = GAIN_DEFAULT;
    state.master.connect(state.ctx.destination);
    return true;
  }

  // Synthesise one click: a short decaying sine burst. Each click is its own
  // throwaway oscillator + gain node (WebAudio's idiomatic one-shot pattern).
  function scheduleClick(when, freq) {
    const ctx = state.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    // Percussive envelope: near-instant attack, exponential decay.
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(1.0, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, when + CLICK_DECAY_S);
    osc.connect(env);
    env.connect(state.master);
    osc.start(when);
    osc.stop(when + CLICK_DECAY_S + 0.01);
  }

  function setEnabled(on) {
    if (on) {
      if (!ensureContext()) return;        // no WebAudio support — stay disabled
      // A context created/resumed inside a user gesture is unblocked.
      if (state.ctx.state === 'suspended') state.ctx.resume();
      state.enabled = true;
      // Seed the scheduler just ahead of the current audio clock.
      state.nextClickTime = state.ctx.currentTime + 0.05;
    } else {
      state.enabled = false;
      if (state.ctx && state.ctx.state === 'running') state.ctx.suspend();
    }
    syncButton();
  }

  function syncButton() {
    if (!state.btn) return;
    state.btn.classList.toggle('active', state.enabled);
    state.btn.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    state.btn.title = state.enabled ? 'Count-rate audio: on' : 'Count-rate audio: off';
  }

  if (state.btn) {
    state.btn.addEventListener('click', () => setEnabled(!state.enabled));
    syncButton();
  }

  // scheduleClick closes over `state.ctx`/`state.master`; bind it onto the
  // handle so the module-scope updatePeriodAudio can drive the scheduler
  // without a window global.
  state.scheduleClickInternal = scheduleClick;

  // Expose the live handle so updatePeriodAudio (called from the rAF loop)
  // can reach the scheduler. Single module-scoped handle — no window writes.
  _audio = state;
}

// Module-scoped handle set by initPeriodAudio; read by updatePeriodAudio.
let _audio = null;

// Map sim state → target click rate (Hz). Pure function of the public
// out.* readouts, so it is node-testable in isolation.
export function clickRateForState(simState) {
  const out = simState.out;
  // Neutron-population proxy: fission power fraction of nominal.
  const T = simState.T;
  const nominal = (T && T.nominalPowerMWth) || 1;
  const powerFrac = Math.max((out.fissionPowerMW || 0) / nominal, RATE_FLOOR_POWER);

  // Log-interpolate power → base rate. The count-rate channel is a decade
  // instrument; equal decades of power give equal rate steps.
  const lo = Math.log(RATE_FLOOR_POWER);
  const hi = Math.log(RATE_CEIL_POWER);
  let t = (Math.log(Math.min(powerFrac, RATE_CEIL_POWER)) - lo) / (hi - lo);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  let rate = RATE_MIN_HZ + t * (RATE_MAX_HZ - RATE_MIN_HZ);

  // Short-positive-period urgency boost. A rising reactor (finite positive
  // period) clicks faster than its raw power would imply, so an operator hears
  // "going critical" before the power gauge has moved much.
  const p = out.periodSec;
  if (Number.isFinite(p) && p > 0 && p < PERIOD_ALARM_S) {
    const urgency = 1 - p / PERIOD_ALARM_S;          // 0 at 80 s, →1 at very short
    rate *= 1 + urgency * (PERIOD_BOOST_MAX - 1);
  }

  if (rate > RATE_MAX_HZ) rate = RATE_MAX_HZ;
  if (rate < RATE_MIN_HZ) rate = RATE_MIN_HZ;
  return rate;
}

// Per-frame driver. Cheap no-op until the operator enables audio. Schedules
// click bursts against the AudioContext (wall-clock) timeline so the train
// stays a real-time instrument independent of state.accel — at 36000× the
// period readout is still meaningful but the speaker must not machine-gun, and
// the RATE_MAX_HZ cap plus wall-clock scheduling guarantee that.
export function updatePeriodAudio(simState) {
  const a = _audio;
  if (!a || !a.enabled || !a.ctx) return;
  if (a.ctx.state !== 'running') return;   // suspended (tab hidden / toggled off)

  a.rateHz = clickRateForState(simState);

  const now = a.ctx.currentTime;
  // If the scheduler fell far behind (tab was backgrounded), snap forward so
  // we don't dump a backlog of clicks all at once.
  if (a.nextClickTime < now) a.nextClickTime = now + 0.02;

  const interval = 1 / a.rateHz;
  // Click pitch tracks the rate so a fast train also sounds higher.
  const pitchT = (a.rateHz - RATE_MIN_HZ) / (RATE_MAX_HZ - RATE_MIN_HZ);
  const freq = CLICK_FREQ_LO + Math.max(0, Math.min(1, pitchT)) * (CLICK_FREQ_HI - CLICK_FREQ_LO);

  // Queue every click that falls inside the look-ahead window.
  const horizon = now + SCHEDULE_AHEAD_S;
  while (a.nextClickTime < horizon) {
    a.scheduleClickInternal(a.nextClickTime, freq);
    a.nextClickTime += interval;
  }
}
