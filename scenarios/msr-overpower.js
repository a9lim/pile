// Scenario — MSR overpower transient. Doppler self-termination without a
// scram. Sandbox-style: no script, the operator withdraws the rod bank by
// hand (MSR autopilot is off by default — see setup()).
//
// Runs from the default MSR init, so it needs no exotic startup state.

// Module-scope closure state: sim-time at which the rod bank was first
// withdrawn fully, used to time the "ride it out" objective.
let injectTime = null;

export default {
  id: 'msr-overpower',
  title: 'MSR Overpower Transient',
  type: 'msr',
  timeAccel: 10,
  intro:
    'A molten-salt reactor has an enormous prompt-negative temperature ' +
    'coefficient — the fuel salt expands the instant it heats, dropping ' +
    'fissile density. Switch the rod bank to MAN and withdraw it fully to ' +
    'inject reactivity. Core power will spike. Do NOT scram: hold the ' +
    'reactor and watch the Doppler term on the reactivity stack clamp the ' +
    'excursion on its own. Keep it stable for three minutes after rod-out.',

  reset() { injectTime = null; },

  setup(state) {
    // MSR autopilot defaults OFF (its Doppler self-regulates and the
    // closed-loop controller overdrives it). Leave it off — the operator
    // drives the rod bank by hand for this scenario.
    state.autoRod.enabled = false;
  },

  objectives: [
    {
      id: 'inject',
      text: 'Withdraw the rod bank fully to inject positive reactivity',
      test: (s) => {
        if (s.rodBanks.regulating >= 0.97 && injectTime === null) {
          injectTime = s.simTime;
        }
        return injectTime !== null;
      },
    },
    {
      id: 'ride-out',
      text: 'Hold the reactor — no scram — for 3 minutes after rod withdrawal',
      test: (s) =>
        injectTime !== null &&
        !s.scramActive &&
        s.simTime - injectTime >= 180,
    },
  ],

  fail: [
    {
      id: 'scram',
      reason:
        'You scrammed. The lesson of this scenario is that the MSR’s ' +
        'Doppler feedback terminates the excursion with no operator action — ' +
        'scramming pre-empts the very physics you came to watch.',
      test: (s) => s.scramActive === true,
    },
    {
      id: 'runaway',
      reason:
        'Core power ran past 10× nominal — the excursion outran ' +
        'feedback. This should not be reachable in the MSR; if it happened, ' +
        'the model has a problem.',
      test: (s) => s.out.fissionPowerMW > 80,
    },
  ],

  script: null,
};
