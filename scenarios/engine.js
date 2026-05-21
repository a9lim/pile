// Scenario engine (Wave 3a). Drives a loaded scenario module against the
// live sim state: applies the scenario's setup, evaluates objective and
// fail predicates each frame, fires scripted events, and tracks completion.
//
// UI-decoupled and dependency-free — main.js ticks it inside the rAF loop
// and src/ui/scenarios.js renders its status. Scenario modules are plain
// ES modules (see scenarios/load-follow.js); predicates are real functions,
// so there is no DSL and no eval (CSP-clean).
//
// A scenario module shape:
//   {
//     id, title, type ('pwr'|'rbmk'|'msr'), timeAccel?, intro?,
//     reset?(),               // clear any module-scope closure state
//     setup?(state),          // mutate the freshly-created state
//     objectives: [ { id, text, test(state) -> bool } ],
//     fail?:      [ { id, reason, test(state) -> bool } ],
//     script?:    [ { atSec, action(state), note? } ] | null,
//   }

export function createScenarioEngine() {
  let active = null;

  function begin(module, state) {
    if (typeof module.reset === 'function') module.reset();
    if (typeof module.setup === 'function') module.setup(state);
    if (typeof module.timeAccel === 'number') state.accel = module.timeAccel;
    // Reset scripted-event fired flags so a Restart replays cleanly.
    if (Array.isArray(module.script)) {
      module.script.forEach((ev) => { ev._fired = false; });
    }
    active = {
      module,
      objectives: module.objectives.map((o) => ({
        id: o.id, text: o.text, met: false, metAt: 0,
      })),
      failed: false,
      failReason: '',
      complete: false,
      completedAt: 0,
    };
  }

  function tick(state) {
    if (!active || active.complete || active.failed) return;
    const mod = active.module;

    // Objective predicates — sticky: once met, stays met.
    for (let i = 0; i < mod.objectives.length; i++) {
      const tracked = active.objectives[i];
      if (tracked.met) continue;
      let ok = false;
      try { ok = !!mod.objectives[i].test(state); } catch (_) { ok = false; }
      if (ok) { tracked.met = true; tracked.metAt = state.simTime; }
    }

    // Fail predicates — the first one to trip ends the run.
    if (Array.isArray(mod.fail)) {
      for (const f of mod.fail) {
        let bad = false;
        try { bad = !!f.test(state); } catch (_) { bad = false; }
        if (bad) {
          active.failed = true;
          active.failReason = f.reason || 'Scenario failed.';
          return;
        }
      }
    }

    // Scripted events (replay scenarios). Sandbox scenarios use script: null.
    if (Array.isArray(mod.script)) {
      for (const ev of mod.script) {
        if (!ev._fired && state.simTime >= ev.atSec) {
          ev._fired = true;
          try { ev.action(state); } catch (_) {}
        }
      }
    }

    if (active.objectives.every((o) => o.met)) {
      active.complete = true;
      active.completedAt = state.simTime;
    }
  }

  function end() {
    if (active && typeof active.module.reset === 'function') {
      active.module.reset();
    }
    active = null;
  }

  return {
    begin,
    tick,
    end,
    isActive: () => !!active,
    getActive: () => active,
  };
}
