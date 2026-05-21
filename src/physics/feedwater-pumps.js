// feedwater-pumps.js (III.11) -- main feedwater + condensate pump model.
//
// PWR-only. Replaces the wave-2 cmd.mainFwTrip placeholder boolean with a
// real two-stage pump train:
//
//   condenser hotwell --[condensate pumps]--> LP heaters / deaerator
//        deaerator storage --[MFW pumps]--> HP heaters --> steam generators
//
// The 3-element feedwater controller in plant.js demands a feedwater flow;
// the pumps can only DELIVER up to their installed capacity. This module
// computes that capacity (state.feedwaterPumps.mfwCapacityKgPerS); plant.js
// caps the per-loop controller demand at capacity/L. Trip one MFW pump and
// the SGs are starved -- the canonical loss-of-feedwater transient.
//
// Trip / unavailability causes modelled:
//   - electrical: MFW + condensate pumps are large NON-SAFETY loads, not
//     on the EDG-backed Class 1E bus -- they die on loss of offsite power
//     (cmd.lossOfOffsitePower) and do NOT come back when EDGs pick up.
//   - operator: cmd.mainFwTrip trips ALL MFW pumps; per-pump manual stops.
//   - fault injection: cmd.mfwPumpFault[i] / cmd.condPumpFault[i].
//   - suction loss (NPSH): the MFW pumps take suction downstream of the
//     condensate pumps; if condensate capacity cannot keep up with MFW
//     flow the MFW pumps cavitate. A sustained deficit (npshTripDelaySec)
//     latches an NPSH trip. Reversible when suction recovers -- real
//     plants damage the impeller, but pedagogy favours recoverability.
//
// Head curve: feedwater pumps discharge into the SG secondary. Delivered
// flow is flat at rated until SG pressure approaches the pump knee, then
// derates parabolically to zero at the shutoff head -- so an SG over-
// pressure event chokes feedwater delivery (a real ATWS concern).
//
// AFW coupling: afw.js auto-starts on mfwAvailable === false (III.11), so
// a non-operator MFW failure promptly starts auxiliary feedwater without
// waiting for SG level to fall to the lo-lo setpoint.
//
// RBMK/MSR have no T.feedwaterPumps -> state.feedwaterPumps is null and
// this module early-returns; their plant branches are untouched.
//
// References: Westinghouse FSAR Ch 10.4.7 (condensate + feedwater system);
// NUREG-0611 (loss-of-feedwater transient generic study).

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

export function stepFeedwaterPumps(state, dt) {
  const fp = state.feedwaterPumps;
  if (!fp) return;                       // RBMK / MSR — no model

  const cfg = state.T.feedwaterPumps;
  const cmd = state.cmd;

  // MFW + condensate pumps are non-safety loads: available only with
  // offsite power. EDG pickup energizes the Class 1E bus, NOT these.
  const offsitePower = !cmd.lossOfOffsitePower;

  // === Condensate pumps ===
  let condCap = 0;
  for (let i = 0; i < fp.condPumps.length; i++) {
    const p = fp.condPumps[i];
    const fault = cmd.condPumpFault && cmd.condPumpFault[i];
    if (fault && fault !== 'none') p.faulted = true;   // latched
    const stopped = cmd.condPumpManualStop && cmd.condPumpManualStop[i] === true;
    p.running = offsitePower && !p.faulted && !stopped;
    p.flowKgPerS = p.running ? cfg.condRatedFlowKgPerS : 0;
    if (p.running) condCap += cfg.condRatedFlowKgPerS;
  }
  fp.condCapacityKgPerS = condCap;

  // === MFW NPSH ===
  // The MFW pumps need the condensate system to keep their suction
  // supplied. The reference demand is the SG steam flow (state.out.steamFlow)
  // — what feedwater must replace. Steam flow is trip-INDEPENDENT (it comes
  // from the primary→secondary Qsg, not the FW pumps), so the NPSH latch
  // cannot oscillate: once the MFW pumps trip on NPSH and FW flow → 0, the
  // steam reference still reflects the real demand. After a scram the steam
  // demand collapses to decay-heat level and a single condensate pump can
  // again supply it — so MFW NPSH legitimately recovers post-trip.
  const mfwDemandRef = state.out.steamFlow || 0;
  const anyMfwTrying = offsitePower && !cmd.mainFwTrip;
  const suctionShort = anyMfwTrying && mfwDemandRef > 1 && condCap < mfwDemandRef;
  if (suctionShort) fp.npshAccumSec += dt;
  else fp.npshAccumSec = Math.max(0, fp.npshAccumSec - dt);
  // Latch evaluated from the (pre-update) accumulator → use the running
  // value; reversible — clears once suction recovers and the accumulator
  // drains back below the delay.
  fp.npshLost = fp.npshAccumSec >= (cfg.npshTripDelaySec ?? 5);
  fp.suctionAvailable = !suctionShort;

  // === MFW pumps ===
  // Head derate: flat until the SG-pressure knee, parabolic to zero at
  // shutoff head.
  const sgP = state.sgSecondaryP || 0;
  const knee = cfg.mfwKneePressureMPa ?? 8.5;
  const shutoff = cfg.mfwShutoffPressureMPa ?? 13.0;
  let headFrac = 1;
  if (sgP > knee) {
    const x = (sgP - knee) / Math.max(shutoff - knee, 1e-6);
    headFrac = clamp(1 - x * x, 0, 1);
  }

  let nRunning = 0;
  for (let i = 0; i < fp.mfwPumps.length; i++) {
    const p = fp.mfwPumps[i];
    const fault = cmd.mfwPumpFault && cmd.mfwPumpFault[i];
    if (fault && fault !== 'none') p.faulted = true;   // latched
    const stopped = cmd.mfwPumpManualStop && cmd.mfwPumpManualStop[i] === true;
    p.running = offsitePower && !p.faulted && !stopped
      && cmd.mainFwTrip !== true && !fp.npshLost;
    p.flowKgPerS = p.running ? cfg.mfwRatedFlowKgPerS * headFrac : 0;
    if (p.running) nRunning++;
  }

  fp.mfwCapacityKgPerS = nRunning * cfg.mfwRatedFlowKgPerS * headFrac;
  fp.mfwRunningCount = nRunning;
  fp.mfwAvailable = fp.mfwCapacityKgPerS > 1;

  // Diagnostics for the gauge layer.
  state.out.mfwCapacityKgPerS = fp.mfwCapacityKgPerS;
  state.out.mfwRunningCount = nRunning;
  state.out.condRunningCount = fp.condPumps.filter(p => p.running).length;
  state.out.feedwaterPumpsAvailable = fp.mfwAvailable;
}
