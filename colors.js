/* ===================================================
   colors.js -- Pile project-specific design tokens.
   Maps reactor physics concepts to shared extended palette
   colors and injects themed CSS custom properties.
   =================================================== */

_PALETTE.neutron      = _PALETTE.extended.blue;
_PALETTE.gamma        = _PALETTE.extended.green;
_PALETTE.coolantCold  = _PALETTE.extended.blue;
_PALETTE.coolantHot   = _PALETTE.extended.orange;
_PALETTE.fuel         = _PALETTE.extended.rose;
_PALETTE.steam        = _PALETTE.extended.purple;
_PALETTE.scram        = _PALETTE.extended.rose;
_PALETTE.reactivityPos = _PALETTE.extended.rose;
_PALETTE.reactivityNeg = _PALETTE.extended.green;
_PALETTE.boron        = _PALETTE.extended.yellow;
_PALETTE.xenon        = _PALETTE.extended.purple;
_PALETTE.doppler      = _PALETTE.extended.orange;
_PALETTE.moderator    = _PALETTE.extended.blue;
_PALETTE.void         = _PALETTE.extended.yellow;
_PALETTE.rod          = _PALETTE.extended.green;

_freezeTokens();

(function () {
  const P = _PALETTE, L = P.light, D = P.dark;
  _injectProjectVars(
    `  --neutron: ${P.neutron};
  --gamma: ${P.gamma};
  --coolant-cold: ${P.coolantCold};
  --coolant-hot: ${P.coolantHot};
  --fuel: ${P.fuel};
  --steam: ${P.steam};
  --scram: ${P.scram};
  --r-pos: ${P.reactivityPos};
  --r-neg: ${P.reactivityNeg};
  --r-rod: ${P.rod};
  --r-boron: ${P.boron};
  --r-xenon: ${P.xenon};
  --r-doppler: ${P.doppler};
  --r-moderator: ${P.moderator};
  --r-void: ${P.void};
  --chart-grid: ${_r(L.text, 0.06)};
  --chart-axis: ${L.textSecondary};
  --strip-line: ${L.text};
  --annunciator-off: ${_r(L.text, 0.08)};
  --annunciator-warn: ${P.extended.orange};
  --annunciator-trip: ${P.extended.rose};
  --dialog-bg: ${L.panelSolid};`,
    `  --chart-grid: ${_r(D.text, 0.06)};
  --chart-axis: ${D.textSecondary};
  --strip-line: ${D.text};
  --annunciator-off: ${_r(D.text, 0.08)};
  --dialog-bg: ${D.panelSolid};`
  );
})();
