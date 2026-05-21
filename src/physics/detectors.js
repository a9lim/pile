// detectors.js -- I.4: Source/Intermediate/Power Range nuclear instrumentation.
//
// Three detector channels each model a real fission-chamber / ion-chamber pair
// with realistic dynamic range, lag (1st-order low-pass), and counting noise.
// The "true" flux comes from state.out.fissionPowerMW / T.nominalPowerMWth
// (axial-mean fraction of nominal); each channel converts to its native units,
// applies its lag, then adds Gaussian noise of channel-appropriate magnitude.
//
// Channels match real PWR NI design:
//   SR — pulse-counting fission chamber outside the core (graphite reflector
//        or thimble). Sees startup source + subcritical multiplication.
//        Range ~10⁻¹ to 10⁵ cps, log; integration window ~1 s; Poisson noise.
//        Off-scale high above ~10⁵ cps (pulse pile-up corrupts counts).
//   IR — Compensated ion chamber, Campbell mode (variance of detector current
//        ∝ flux). Wide dynamic range without saturation. ~10⁻¹¹ to 10⁻³ A
//        ≈ 10⁻⁸ to 1.0 fraction of nominal power. ~200 ms time constant;
//        ~3% rms relative noise.
//   PR — Uncompensated ion chamber, linear current → linear power fraction.
//        0 to ~120% of nominal. ~100 ms time constant; ~0.5% rms full-scale.
//        On-scale low above ~1% nominal.
//
// The pedagogical "blind zone" during startup approach-to-critical is between
// SR off-scale (~10⁻³ frac) and PR on-scale (~10⁻²); IR is the single useful
// channel through the gap, so the operator must overlap channels and trust IR.

const SR_CPS_AT_NOMINAL = 5e9;       // SR detector cps at full power (off-scale by ~4 decades)
const SR_INTEGRATION_S = 1.0;        // electronics integration window
const SR_OFFSCALE_HIGH_CPS = 1e5;    // pulse pile-up rail
const SR_FLOOR_CPS = 0.1;            // intrinsic background + startup source

const IR_AMP_AT_NOMINAL = 1e-3;      // ion-chamber current at 100% flux
const IR_TAU_S = 0.2;                // 1st-order lag time constant
const IR_REL_NOISE = 0.03;           // 3% rms relative (Campbell averaging)
const IR_FLOOR_AMP = 1e-12;          // electronics noise floor

const PR_TAU_S = 0.1;                // fast — used by the protection system
const PR_REL_NOISE = 0.005;          // 0.5% rms of full scale
const PR_ONSCALE_LOW = 0.01;         // below 1% nominal reads as "0%"

// Box-Muller standard normal. Deterministic seeding isn't needed — we just
// want visual jitter on the readout, not reproducibility for testing.
function gauss() {
  const u1 = Math.max(Math.random(), 1e-12);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function createDetectorState() {
  return {
    sr: { cpsLagged: SR_FLOOR_CPS, displayCps: SR_FLOOR_CPS, offscale: false },
    ir: { ampLagged: IR_FLOOR_AMP, displayAmp: IR_FLOOR_AMP },
    pr: { fracLagged: 0, displayFrac: 0, offscaleLow: true },
  };
}

export function stepDetectors(state, dt) {
  if (!state.detectors) state.detectors = createDetectorState();
  const det = state.detectors;
  const T = state.T;
  const nominal = Math.max(T.nominalPowerMWth ?? 1, 1e-9);

  // True flux fraction = fissionPowerMW / nominal. Avoid div by 0 / negatives.
  const fission = state.out?.fissionPowerMW ?? 0;
  const trueFrac = Math.max(0, fission / nominal);

  // dt may be 0 on a degenerate first call (e.g. UI bootstrap). 1-exp(0)=0
  // makes the lag a no-op in that case, which is what we want.
  const aSR = 1 - Math.exp(-Math.max(dt, 0) / SR_INTEGRATION_S);
  const aIR = 1 - Math.exp(-Math.max(dt, 0) / IR_TAU_S);
  const aPR = 1 - Math.exp(-Math.max(dt, 0) / PR_TAU_S);

  // === Source Range ===
  // True cps = trueFrac × SR_CPS_AT_NOMINAL + floor (source neutrons).
  const trueCps = SR_FLOOR_CPS + trueFrac * SR_CPS_AT_NOMINAL;
  det.sr.cpsLagged += (trueCps - det.sr.cpsLagged) * aSR;
  // Poisson noise on the lagged display: σ = sqrt(C/τ).
  const noiseSR = Math.sqrt(Math.max(det.sr.cpsLagged, 1) / SR_INTEGRATION_S) * gauss();
  det.sr.displayCps = Math.max(SR_FLOOR_CPS, det.sr.cpsLagged + noiseSR);
  det.sr.offscale = det.sr.displayCps > SR_OFFSCALE_HIGH_CPS;

  // === Intermediate Range ===
  const trueAmp = IR_FLOOR_AMP + trueFrac * IR_AMP_AT_NOMINAL;
  det.ir.ampLagged += (trueAmp - det.ir.ampLagged) * aIR;
  const noiseIR = det.ir.ampLagged * IR_REL_NOISE * gauss();
  det.ir.displayAmp = Math.max(IR_FLOOR_AMP, det.ir.ampLagged + noiseIR);

  // === Power Range ===
  det.pr.fracLagged += (trueFrac - det.pr.fracLagged) * aPR;
  const noisePR = PR_REL_NOISE * gauss();
  det.pr.displayFrac = det.pr.fracLagged + noisePR;
  det.pr.offscaleLow = det.pr.displayFrac < PR_ONSCALE_LOW;

  // Mirror to state.out for the gauge layer.
  state.out.detSrCps = det.sr.displayCps;
  state.out.detSrOffscale = det.sr.offscale;
  state.out.detIrAmp = det.ir.displayAmp;
  // Power-fraction equivalent of the IR current — convenient for the log
  // display (gauge formatter writes "10^x").
  state.out.detIrPowerFrac = det.ir.displayAmp / IR_AMP_AT_NOMINAL;
  state.out.detPrFrac = det.pr.displayFrac;
  state.out.detPrOffscaleLow = det.pr.offscaleLow;
}
