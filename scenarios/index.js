// Scenario registry (Wave 3). Metadata only — the full scenario module
// (setup, objectives, fail predicates) is lazy-imported via `load()` when
// the operator picks it, so the picker overlay stays cheap.
//
// To add a scenario: write scenarios/<id>.js exporting the module shape
// documented in engine.js, then add an entry here.

export const SCENARIOS = [
  {
    id: 'load-follow',
    title: 'Load Follow: 100 → 75 → 100%',
    summary:
      'Ramp the PWR down to 75% and back to full power while xenon-135 ' +
      'works against you. The xenon transient as a control problem.',
    load: () => import('./load-follow.js'),
  },
  {
    id: 'msr-overpower',
    title: 'MSR Overpower Transient',
    summary:
      'Inject reactivity into a molten-salt reactor and watch its huge ' +
      'Doppler coefficient terminate the excursion — with no scram.',
    load: () => import('./msr-overpower.js'),
  },
];
