// steam-tables.js -- IAPWS-IF97 industrial steam tables.
//
// Wave 2.5 Phase I.8 — single source of truth for water/steam thermodynamic
// properties, replacing the kPa-form Antoine saturationTempK (which was
// DUPLICATED across plant.js / thermal.js / multichannel.js) and the
// scattered hardcoded fluid constants (HFG_DEFAULT = 1.5e6, RHO_F = 740,
// RHO_G = 35, etc.).
//
// Implements the IAPWS Industrial Formulation 1997 (IF97):
//
//   Region 4 — the saturation line. Explicit pSat(T) and tSat(p) basic
//              equations (a single quartic-resolvent pair, IF97 §8). Valid
//              273.15 K – 647.096 K / 611.213 Pa – 22.064 MPa.
//   Region 1 — compressed + saturated liquid. Dimensionless Gibbs free
//              energy g(p,T)/RT, 34 coefficients (IF97 §5, Table 2).
//   Region 2 — superheated + saturated vapour. Gibbs energy split into an
//              ideal-gas part (9 coefficients) + a residual part (43
//              coefficients) (IF97 §6, Tables 10 + 11).
//
// Evaluating Region 1 at (p, tSat(p)) gives saturated-liquid properties;
// Region 2 at (p, tSat(p)) gives saturated-vapour properties. The sim's
// operating envelope — PWR primary ~15.5 MPa / ~600 K, SG secondary
// ~6.9 MPa, RBMK drum ~6.5 MPa, MSR ~atmospheric — sits entirely inside
// Regions 1/2/4, so the boundary equation (B23) and the high-pressure
// Region 3/5 fits are intentionally NOT implemented.
//
// All Gibbs-energy properties (h, v, cp, ...) follow from the standard
// thermodynamic identities applied to g and its π/τ derivatives — see the
// per-region helper comments.
//
// References:
//   IAPWS R7-97(2012), "Revised Release on the IAPWS Industrial
//     Formulation 1997 for the Thermodynamic Properties of Water and
//     Steam." International Association for the Properties of Water and
//     Steam, 2012.
//   W. Wagner et al., "The IAPWS Industrial Formulation 1997 for the
//     Thermodynamic Properties of Water and Steam," J. Eng. Gas Turbines
//     Power 122 (2000) 150-184. doi:10.1115/1.483186
//
// Pure module: no window.*, no imports of other pile modules. Node-testable.
// Units throughout this module are SI: Pa, K, J/kg, J/(kg·K), m³/kg, kg/m³.
// The exported convenience wrappers take MPa where noted (the sim works in
// MPa for pressures) and return SI.

// Specific gas constant of ordinary water (IF97 §2, Eq. 1).
const R_WATER = 0.461526e3;        // J/(kg·K)

// Region 4 critical-point / triple-point bounds.
const T_TRIPLE = 273.15;           // K
const T_CRIT = 647.096;            // K
const P_TRIPLE = 611.213;          // Pa
const P_CRIT = 22.064e6;           // Pa

// ===========================================================================
// Region 4 — saturation line (IF97 §8, Eqs. 29-31).
//
// A single dimensionless equation links p and T through the quartic
//   β²·ϑ² + n1·β²·ϑ + n2·β² + n3·β·ϑ² + n4·β·ϑ + n5·β
//     + n6·ϑ² + n7·ϑ + n8 = 0
// with β = (p/p*)^(1/4), ϑ = T/T* + n9/(T/T* − n10), p* = 1 MPa, T* = 1 K.
// Solving for β gives pSat(T); solving for ϑ gives tSat(p). Both are
// closed-form (the resolvent of a quadratic in β² and in ϑ respectively).
// ===========================================================================

const R4_N = [
  0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2,
  0.12020824702470e5, -0.32325550322333e7,  0.14915108613530e2,
 -0.48232657361591e4,  0.40511340542057e6, -0.23855557567849e0,
  0.65017534844798e3,
];

// Saturation pressure as a function of temperature.
//   pSat(T_K) -> Pa, valid 273.15 K <= T <= 647.096 K.
export function pSatPa(T_K) {
  const T = clamp(T_K, T_TRIPLE, T_CRIT);
  const th = T + R4_N[8] / (T - R4_N[9]);          // ϑ
  const A = th * th + R4_N[0] * th + R4_N[1];
  const B = R4_N[2] * th * th + R4_N[3] * th + R4_N[4];
  const C = R4_N[5] * th * th + R4_N[6] * th + R4_N[7];
  const disc = B * B - 4 * A * C;
  const beta = 2 * C / (-B + Math.sqrt(Math.max(disc, 0)));
  const p_MPa = beta * beta * beta * beta;          // β⁴, p* = 1 MPa
  return p_MPa * 1e6;
}

// Saturation temperature as a function of pressure.
//   tSatK(p_Pa) -> K, valid 611.213 Pa <= p <= 22.064 MPa.
export function tSatK(p_Pa) {
  const p = clamp(p_Pa, P_TRIPLE, P_CRIT);
  const beta = Math.pow(p / 1e6, 0.25);             // β = (p/p*)^(1/4)
  const E = beta * beta + R4_N[2] * beta + R4_N[5];
  const F = R4_N[0] * beta * beta + R4_N[3] * beta + R4_N[6];
  const G = R4_N[1] * beta * beta + R4_N[4] * beta + R4_N[7];
  const D = 2 * G / (-F - Math.sqrt(Math.max(F * F - 4 * E * G, 0)));
  const inner = R4_N[9] + D;
  const th = 0.5 * (inner - Math.sqrt(Math.max(inner * inner
    - 4 * (R4_N[8] + R4_N[9] * D), 0)));
  return th;
}

// MPa-input convenience wrappers (the sim works in MPa).
//   tSat(p_MPa) -> K     pSat(T_K) -> MPa
export function tSat(p_MPa) { return tSatK(p_MPa * 1e6); }
export function pSat(T_K) { return pSatPa(T_K) / 1e6; }

// ===========================================================================
// Region 1 — compressed / saturated liquid (IF97 §5, Table 2).
//
// Reduced Gibbs energy  γ(π,τ) = g/(R·T) = Σ n_i · (7.1−π)^I_i · (τ−1.222)^J_i
// with π = p/p*, τ = T*/T,  p* = 16.53 MPa, T* = 1386 K.
// 34 coefficients. Properties follow from the π/τ derivatives:
//   v   =  R·T/p · π·γπ
//   h   =  R·T   · τ·γτ
//   cp  = −R     · τ²·γττ
// ===========================================================================

const R1_PSTAR = 16.53e6;          // Pa
const R1_TSTAR = 1386;             // K

const R1_I = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2,
  2, 2, 3, 3, 3, 4, 4, 4, 5, 8, 8, 21, 23, 29, 30, 31, 32,
];
const R1_J = [
  -2, -1, 0, 1, 2, 3, 4, 5, -9, -7, -1, 0, 1, 3, -3, 0, 1,
  3, 17, -4, 0, 6, -5, -2, 10, -8, -11, -6, -29, -31, -38, -39, -40, -41,
];
const R1_N = [
  0.14632971213167,    -0.84548187169114,    -0.37563603672040e1,
  0.33855169168385e1,  -0.95791963387872,     0.15772038513228,
 -0.16616417199501e-1,  0.81214629983568e-3,  0.28319080123804e-3,
 -0.60706301565874e-3, -0.18990068218419e-1, -0.32529748770505e-1,
 -0.21841717175414e-1, -0.52838357969930e-4, -0.47184321073267e-3,
 -0.30001780793026e-3,  0.47661393906987e-4, -0.44141845330846e-5,
 -0.72694996297594e-15,-0.31679644845054e-4, -0.28270797985312e-5,
 -0.85205128120103e-9, -0.22425281908000e-5, -0.65171222895601e-6,
 -0.14341729937924e-12,-0.40516996860117e-6, -0.12734301741641e-8,
 -0.17424871230634e-9, -0.68762131295531e-18, 0.14478307828521e-19,
  0.26335781662795e-22,-0.11947622640071e-22, 0.18228094581404e-23,
 -0.93537087292458e-25,
];

// Evaluate Region 1 dimensionless Gibbs energy and the derivatives needed
// for h, v, cp. Returns { gp, gt, gtt } where gp = γπ, gt = γτ, gtt = γττ.
function region1Gamma(p_Pa, T_K) {
  const pi = p_Pa / R1_PSTAR;
  const tau = R1_TSTAR / T_K;
  const a = 7.1 - pi;
  const b = tau - 1.222;
  let gp = 0, gt = 0, gtt = 0;
  for (let i = 0; i < 34; i++) {
    const I = R1_I[i], J = R1_J[i], n = R1_N[i];
    // γπ  = Σ −n·I·(7.1−π)^(I−1)·(τ−1.222)^J
    gp += -n * I * Math.pow(a, I - 1) * Math.pow(b, J);
    // γτ  = Σ  n·(7.1−π)^I·J·(τ−1.222)^(J−1)
    gt += n * Math.pow(a, I) * J * Math.pow(b, J - 1);
    // γττ = Σ  n·(7.1−π)^I·J·(J−1)·(τ−1.222)^(J−2)
    gtt += n * Math.pow(a, I) * J * (J - 1) * Math.pow(b, J - 2);
  }
  return { gp, gt, gtt };
}

// Region 1 general (p,T) properties. p_Pa, T_K -> SI.
export function region1Props(p_Pa, T_K) {
  const { gp, gt, gtt } = region1Gamma(p_Pa, T_K);
  const pi = p_Pa / R1_PSTAR;
  const tau = R1_TSTAR / T_K;
  const v = (R_WATER * T_K / p_Pa) * pi * gp;       // m³/kg
  const h = R_WATER * T_K * tau * gt;               // J/kg
  const cp = -R_WATER * tau * tau * gtt;            // J/(kg·K)
  return { v, rho: 1 / v, h, cp };
}

// ===========================================================================
// Region 2 — superheated / saturated vapour (IF97 §6, Tables 10 + 11).
//
// γ(π,τ) = γ°(π,τ) + γʳ(π,τ) ,  π = p/p*, τ = T*/T,
//   p* = 1 MPa, T* = 540 K.
// γ° = ln π + Σ_{i=1..9} n°_i·τ^(J°_i)            (ideal-gas part)
// γʳ = Σ_{i=1..43} nʳ_i·π^(Iʳ_i)·(τ−0.5)^(Jʳ_i)  (residual part)
// Properties as for Region 1.
// ===========================================================================

const R2_PSTAR = 1e6;              // Pa
const R2_TSTAR = 540;              // K

// Ideal-gas part — 9 coefficients (IF97 Table 10).
const R2_J0 = [0, 1, -5, -4, -3, -2, -1, 2, 3];
const R2_N0 = [
 -0.96927686500217e1,  0.10086655968018e2, -0.56087911283020e-2,
  0.71452738081455e-1,-0.40710498223928e0,  0.14240819171444e1,
 -0.43839511319450e1, -0.28408632460772e0,  0.21268463753307e-1,
];

// Residual part — 43 coefficients (IF97 Table 11).
const R2_IR = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 6, 6, 6,
  7, 7, 7, 8, 8, 9, 10, 10, 10, 16, 16, 18, 20, 20, 20, 21, 22, 23, 24, 24, 24,
];
const R2_JR = [
  0, 1, 2, 3, 6, 1, 2, 4, 7, 36, 0, 1, 3, 6, 35, 1, 2, 3, 7, 3, 16, 35,
  0, 11, 25, 8, 36, 13, 4, 10, 14, 29, 50, 57, 20, 35, 48, 21, 53, 39, 26, 40, 58,
];
const R2_NR = [
 -0.17731742473213e-2, -0.17834862292358e-1, -0.45996013696365e-1,
 -0.57581259083432e-1, -0.50325278727930e-1, -0.33032641670203e-4,
 -0.18948987516315e-3, -0.39392777243355e-2, -0.43797295650573e-1,
 -0.26674547914087e-4,  0.20481737692309e-7,  0.43870667284435e-6,
 -0.32277677238570e-4, -0.15033924542148e-2, -0.40668253562649e-1,
 -0.78847309559367e-9,  0.12790717852285e-7,  0.48225372718507e-6,
  0.22922076337661e-5, -0.16714766451061e-10,-0.21171472321355e-2,
 -0.23895741934104e2,  -0.59059564324270e-17,-0.12621808899101e-5,
 -0.38946842435739e-1,  0.11256211360459e-10,-0.82311340897998e1,
  0.19809712802088e-7,  0.10406965210174e-18,-0.10234747095929e-12,
 -0.10018179379511e-8, -0.80882908646985e-10, 0.10693031879409e0,
 -0.33662250574171e0,   0.89185845355421e-24, 0.30629316876232e-12,
 -0.42002467698208e-5, -0.59056029685639e-25, 0.37826947613457e-5,
 -0.12768608934681e-14, 0.73087610595061e-28, 0.55414715350778e-16,
 -0.94369707241210e-6,
];

// Region 2 dimensionless Gibbs energy derivatives. Returns
// { gp, gt, gtt } = (γ°π+γʳπ), (γ°τ+γʳτ), (γ°ττ+γʳττ).
function region2Gamma(p_Pa, T_K) {
  const pi = p_Pa / R2_PSTAR;
  const tau = R2_TSTAR / T_K;
  // Ideal-gas part. γ°π = 1/π ; γ°ττ etc. from the τ-power sum.
  let g0p = 1 / pi;
  let g0t = 0, g0tt = 0;
  for (let i = 0; i < 9; i++) {
    const J = R2_J0[i], n = R2_N0[i];
    g0t += n * J * Math.pow(tau, J - 1);
    g0tt += n * J * (J - 1) * Math.pow(tau, J - 2);
  }
  // Residual part.
  let grp = 0, grt = 0, grtt = 0;
  const b = tau - 0.5;
  for (let i = 0; i < 43; i++) {
    const I = R2_IR[i], J = R2_JR[i], n = R2_NR[i];
    const piI = Math.pow(pi, I);
    grp += n * I * Math.pow(pi, I - 1) * Math.pow(b, J);
    grt += n * piI * J * Math.pow(b, J - 1);
    grtt += n * piI * J * (J - 1) * Math.pow(b, J - 2);
  }
  return { gp: g0p + grp, gt: g0t + grt, gtt: g0tt + grtt };
}

// Region 2 general (p,T) properties. p_Pa, T_K -> SI.
export function region2Props(p_Pa, T_K) {
  const { gp, gt, gtt } = region2Gamma(p_Pa, T_K);
  const pi = p_Pa / R2_PSTAR;
  const tau = R2_TSTAR / T_K;
  const v = (R_WATER * T_K / p_Pa) * pi * gp;       // m³/kg
  const h = R_WATER * T_K * tau * gt;               // J/kg
  const cp = -R_WATER * tau * tau * gtt;            // J/(kg·K)
  return { v, rho: 1 / v, h, cp };
}

// ===========================================================================
// Saturation-line property set — the required deliverable.
//
// All take pressure in MPa. Region 1 at (p, tSat(p)) = saturated liquid;
// Region 2 at (p, tSat(p)) = saturated vapour. Clamped to the IF97 Region 4
// envelope so callers can pass MSR-near-atmospheric or off-design pressures
// without NaN.
// ===========================================================================

// Saturated-liquid specific enthalpy [J/kg].
export function hf(p_MPa) {
  const p = clampP(p_MPa);
  return region1Props(p * 1e6, tSat(p)).h;
}

// Saturated-vapour specific enthalpy [J/kg].
export function hg(p_MPa) {
  const p = clampP(p_MPa);
  return region2Props(p * 1e6, tSat(p)).h;
}

// Latent heat of vaporisation h_fg = h_g − h_f [J/kg].
export function hfg(p_MPa) {
  return hg(p_MPa) - hf(p_MPa);
}

// Saturated-liquid density [kg/m³].
export function rhoF(p_MPa) {
  const p = clampP(p_MPa);
  return region1Props(p * 1e6, tSat(p)).rho;
}

// Saturated-vapour density [kg/m³].
export function rhoG(p_MPa) {
  const p = clampP(p_MPa);
  return region2Props(p * 1e6, tSat(p)).rho;
}

// Saturated-liquid isobaric specific heat [J/(kg·K)].
export function cpF(p_MPa) {
  const p = clampP(p_MPa);
  return region1Props(p * 1e6, tSat(p)).cp;
}

// Saturated-vapour isobaric specific heat [J/(kg·K)].
export function cpG(p_MPa) {
  const p = clampP(p_MPa);
  return region2Props(p * 1e6, tSat(p)).cp;
}

// General (p,T) liquid/vapour convenience wrappers — MPa in, SI out. Useful
// for thermal.js subcooled-liquid properties (Region 1 at T < tSat).
export function h1(p_MPa, T_K) { return region1Props(p_MPa * 1e6, T_K).h; }
export function rho1(p_MPa, T_K) { return region1Props(p_MPa * 1e6, T_K).rho; }
export function cp1(p_MPa, T_K) { return region1Props(p_MPa * 1e6, T_K).cp; }
export function h2(p_MPa, T_K) { return region2Props(p_MPa * 1e6, T_K).h; }
export function rho2(p_MPa, T_K) { return region2Props(p_MPa * 1e6, T_K).rho; }
export function cp2(p_MPa, T_K) { return region2Props(p_MPa * 1e6, T_K).cp; }

// ---------------------------------------------------------------------------

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// Clamp a pressure (MPa) to the IF97 Region 4 envelope so saturation-line
// lookups stay well-defined for MSR-near-atmospheric / off-design inputs.
function clampP(p_MPa) {
  return clamp(p_MPa, P_TRIPLE / 1e6, P_CRIT / 1e6);
}

// ===========================================================================
// Self-test — node-only, guarded so importing the module never runs it.
//   node src/physics/steam-tables.js
// Reference values from the IAPWS-IF97 release (R7-97) verification tables
// and NIST Chemistry WebBook (Saturation Properties for Water).
// ===========================================================================

function selfTest() {
  let fails = 0;
  const check = (name, got, want, tol) => {
    const ok = Math.abs(got - want) <= tol;
    if (!ok) fails++;
    const status = ok ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${name}: got ${got.toPrecision(7)}, `
      + `want ${want} (tol ${tol})`);
  };

  console.log('IAPWS-IF97 steam-tables self-test');

  // --- Region 4 saturation line (IF97 §8 verification, Table 35/36) ---
  console.log(' Region 4 (saturation line)');
  // IF97 Table 36: tSat(0.1 MPa) = 372.7559 K, tSat(1 MPa) = 453.0356 K,
  // tSat(10 MPa) = 584.1494 K.
  check('tSat(0.1 MPa)', tSat(0.1), 372.7559, 0.01);
  check('tSat(1 MPa)', tSat(1), 453.0356, 0.01);
  check('tSat(10 MPa)', tSat(10), 584.1494, 0.01);
  // IF97 Table 35: pSat(300 K) = 0.00353659 MPa, pSat(500 K) = 2.63889777,
  // pSat(600 K) = 12.3443146 MPa.
  check('pSat(300 K)', pSat(300), 0.00353659, 1e-6);
  check('pSat(500 K)', pSat(500), 2.63889777, 1e-4);
  check('pSat(600 K)', pSat(600), 12.3443146, 1e-3);
  // pSat / tSat round-trip consistency.
  check('tSat(pSat(550 K))', tSat(pSat(550)), 550, 1e-3);
  // Sim operating points — IF97 Region 4 equation is itself authoritative;
  // these reference values are the IF97 tSat evaluated at the sim pressures
  // (cross-checked against the NIST WebBook saturation table to ±0.1 K).
  check('tSat(15.5 MPa) [PWR primary]', tSat(15.5), 617.94, 0.3);
  check('tSat(6.9 MPa)  [SG secondary]', tSat(6.9), 558.01, 0.3);
  check('tSat(6.5 MPa)  [RBMK drum]', tSat(6.5), 554.01, 0.3);
  check('tSat(0.101325 MPa) [1 atm]', tSat(0.101325), 373.124, 0.05);

  // --- Region 1 verification (IF97 §5, Table 5) ---
  console.log(' Region 1 (liquid)');
  // IF97 Table 5: at (3 MPa, 300 K) v = 0.100215168e-2 m³/kg,
  // h = 0.115331273e3 kJ/kg, cp = 0.417301218e1 kJ/(kg·K).
  let r1 = region1Props(3e6, 300);
  check('v1(3 MPa,300 K)', r1.v, 0.100215168e-2, 1e-8);
  check('h1(3 MPa,300 K) [kJ/kg]', r1.h / 1e3, 0.115331273e3, 0.01);
  check('cp1(3 MPa,300 K) [kJ/kgK]', r1.cp / 1e3, 0.417301218e1, 0.001);
  // IF97 Table 5: at (80 MPa, 300 K) and (3 MPa, 500 K).
  r1 = region1Props(80e6, 300);
  check('v1(80 MPa,300 K)', r1.v, 0.971180894e-3, 1e-8);
  r1 = region1Props(3e6, 500);
  check('h1(3 MPa,500 K) [kJ/kg]', r1.h / 1e3, 0.975542239e3, 0.02);

  // --- Region 2 verification (IF97 §6, Table 15) ---
  console.log(' Region 2 (vapour)');
  // IF97 Table 15: at (0.0035 MPa, 300 K) v = 0.394913866e2 m³/kg,
  // h = 0.254991145e4 kJ/kg, cp = 0.191300162e1 kJ/(kg·K).
  let r2 = region2Props(0.0035e6, 300);
  check('v2(0.0035 MPa,300 K)', r2.v, 0.394913866e2, 1e-3);
  check('h2(0.0035 MPa,300 K) [kJ/kg]', r2.h / 1e3, 0.254991145e4, 0.05);
  check('cp2(0.0035 MPa,300 K) [kJ/kgK]', r2.cp / 1e3, 0.191300162e1, 0.001);
  // IF97 Table 15: at (30 MPa, 700 K).
  r2 = region2Props(30e6, 700);
  check('h2(30 MPa,700 K) [kJ/kg]', r2.h / 1e3, 0.263149474e4, 0.1);

  // --- Saturation-line property set ---
  console.log(' Saturation-line properties');
  // NIST WebBook saturated water/steam.
  // 7 MPa: h_f = 1267.4 kJ/kg, h_g = 2772.6 kJ/kg, h_fg = 1505.2 kJ/kg.
  check('hf(7 MPa)  [kJ/kg]', hf(7) / 1e3, 1267.4, 2.0);
  check('hg(7 MPa)  [kJ/kg]', hg(7) / 1e3, 2772.6, 2.0);
  check('hfg(7 MPa) [kJ/kg]', hfg(7) / 1e3, 1505.1, 2.0);
  // 15.5 MPa saturated-liquid density ~600 kg/m³ region (NIST: ~594 kg/m³).
  check('rhoF(15.5 MPa)', rhoF(15.5), 594.4, 6.0);
  // 7 MPa saturated steam density (NIST: ~36.5 kg/m³).
  check('rhoG(7 MPa)', rhoG(7), 36.5, 1.0);
  // 7 MPa saturated-liquid density (NIST: ~739.7 kg/m³ — close to the old
  // hardcoded RHO_F = 740).
  check('rhoF(7 MPa)', rhoF(7), 739.7, 3.0);
  // 0.101325 MPa latent heat (NIST: 2256.4 kJ/kg).
  check('hfg(1 atm) [kJ/kg]', hfg(0.101325) / 1e3, 2256.4, 3.0);

  console.log(fails === 0
    ? 'ALL TESTS PASSED'
    : `${fails} TEST(S) FAILED`);
  return fails;
}

// Run the self-test only when executed directly under node.
if (typeof process !== 'undefined' && process.argv
    && import.meta.url === `file://${process.argv[1]}`) {
  const fails = selfTest();
  process.exit(fails === 0 ? 0 : 1);
}
