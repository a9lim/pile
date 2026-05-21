// Scenario — load follow (100 → 75 → 100%). The xenon transient as a
// control problem. Sandbox-style: no script, the operator drives the
// grid-load slider in the Reactivity tab.
//
// Runs from the default PWR init (hot full power), so it needs no exotic
// cold-startup state.

// Module-scope closure state: the "restore" objective must not register
// until the "reduce" objective has been reached first (power starts at
// 100%, so an un-gated restore test would be true at t=0).
let downReached = false;

export default {
  id: 'load-follow',
  title: 'Load Follow: 100 → 75 → 100%',
  type: 'pwr',
  timeAccel: 60,
  intro:
    'The grid needs less power overnight. Take generator output down to ' +
    '75% of rated, then bring it back to 100%. Leave the rod bank in AUTO. ' +
    'As power drops, xenon-135 builds in and pushes reactivity down; as you ' +
    'raise power again it burns back out. Watch the xenon term on the ' +
    'reactivity stack and keep the plant clear of its trip setpoints.',

  reset() { downReached = false; },

  setup(state) {
    // Default PWR init is hot full power — exactly the load-follow start
    // point. Just make sure the rod controller is in AUTO.
    state.autoRod.enabled = true;
  },

  objectives: [
    {
      id: 'reduce',
      text: 'Reduce generator output to 75% of rated',
      test: (s) => {
        const frac = s.gridLoadMW / Math.max(s.T.nominalGridLoadMW, 1);
        if (frac <= 0.78) downReached = true;
        return downReached;
      },
    },
    {
      id: 'restore',
      text: 'Return generator output to 100% of rated',
      test: (s) => {
        const frac = s.gridLoadMW / Math.max(s.T.nominalGridLoadMW, 1);
        return downReached && frac >= 0.97;
      },
    },
  ],

  fail: [
    {
      id: 'scram',
      reason:
        'The reactor scrammed. A load follow is a controlled manoeuvre — ' +
        'a trip means a plant variable went past a protection setpoint. ' +
        'Ramp more slowly and let the rod controller keep up.',
      test: (s) => s.scramActive === true,
    },
  ],

  script: null,
};
