/** The global UI input lock (#466) — `applyBindings`' guard against a double tap firing an
 *  action twice. A single lock covers every discrete activation (click / submit / a toggle's
 *  change) across the WHOLE UI, deliberately GLOBAL rather than per-button (the owner's
 *  override of the linked issue's own per-button proposal — see the test below that pins it).
 *  Release waits on BOTH an authored time floor AND any promise a 'call' handler returned,
 *  whichever is later; a safety valve force-releases a lock that outlives `inputLockMaxMs` so a
 *  hung async handler can't brick the UI permanently. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { applyBindings, setUIClickCue, type UIActionBinding } from '../../src/runtime/ui/bindings';
import { registerUIAction, unregisterUIAction } from '../../src/runtime/core/actionRegistry';
import { setPlayState } from '../../src/runtime/core/playState';
import { UISettings, UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS, UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS } from '../../src/runtime/traits/UISettings';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} });
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} });

const call = (action: string, event: UIActionBinding['event'] = 'click'): UIActionBinding[] =>
  [{ event, kind: 'call', action }];

describe('applyBindings input lock', () => {
  let world: ReturnType<typeof createWorld>;

  beforeEach(() => {
    world = createWorld();
    setCurrentWorld(world); // fires onWorldSwap, clearing lock state left by the previous test
    setPlayState('playing');
    setManualNow(0);
  });
  afterEach(() => {
    setPlayState('playing');
    world.destroy();
    restoreRealClock();
  });

  it('swallows a second click on the SAME button inside the window — handler and cue fire once', () => {
    let calls = 0;
    let cueCount = 0;
    setUIClickCue(() => { cueCount += 1; });
    registerUIAction('test.lockSame', () => { calls += 1; });
    try {
      applyBindings(call('test.lockSame'), 'click', { selfGuid: 'btn-1' });
      applyBindings(call('test.lockSame'), 'click', { selfGuid: 'btn-1' }); // inside the window
      expect(calls).toBe(1);
      // The locked second click is swallowed BEFORE the cue fires — the doubled sound was the
      // original bug report's own proof the action ran twice.
      expect(cueCount).toBe(1);
    } finally {
      unregisterUIAction('test.lockSame');
      setUIClickCue(null);
    }
  });

  // ⚠️ Owner's OVERRIDE of #466's own stated requirement ("a fast tap on a DIFFERENT button still
  // fires"). The lock is GLOBAL, not per-button — do NOT "fix" this back to per-button behaviour.
  it('ALSO swallows a click on a DIFFERENT button inside the window (owner override, not the issue\'s design)', () => {
    let a = 0;
    let b = 0;
    registerUIAction('test.lockA', () => { a += 1; });
    registerUIAction('test.lockB', () => { b += 1; });
    try {
      applyBindings(call('test.lockA'), 'click', { selfGuid: 'btn-a' });
      applyBindings(call('test.lockB'), 'click', { selfGuid: 'btn-b' }); // different button, same window
      expect(a).toBe(1);
      expect(b).toBe(0);
    } finally {
      unregisterUIAction('test.lockA');
      unregisterUIAction('test.lockB');
    }
  });

  it('fires normally after inputLockMinMs elapses (default 300ms, driven by the manual clock)', () => {
    let calls = 0;
    registerUIAction('test.lockFloor', () => { calls += 1; });
    try {
      applyBindings(call('test.lockFloor'), 'click', { selfGuid: 'btn-1' });
      advanceManual(UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS + 1);
      applyBindings(call('test.lockFloor'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2);
    } finally {
      unregisterUIAction('test.lockFloor');
    }
  });

  it('async gate: holds the lock past inputLockMinMs until the promise settles, then works again', async () => {
    let resolveFn!: () => void;
    const pending = new Promise<void>((res) => { resolveFn = res; });
    let calls = 0;
    registerUIAction('test.lockAsync', () => { calls += 1; return pending; });
    try {
      applyBindings(call('test.lockAsync'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      advanceManual(UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS + 1); // floor elapsed, promise still pending
      applyBindings(call('test.lockAsync'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1); // still swallowed — the action hasn't completed

      resolveFn();
      await pending; // let the .finally() microtask run

      applyBindings(call('test.lockAsync'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2); // lock released once the promise settled
    } finally {
      unregisterUIAction('test.lockAsync');
    }
  });

  it('authored perturbation: a scene-authored inputLockMinMs actually changes the floor', () => {
    world.spawn(UISettings({ inputLockMinMs: 50 }));
    let calls = 0;
    registerUIAction('test.lockAuthored', () => { calls += 1; });
    try {
      applyBindings(call('test.lockAuthored'), 'click', { selfGuid: 'btn-1' });
      advanceManual(60); // past the AUTHORED 50ms, well under the 300ms default
      applyBindings(call('test.lockAuthored'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2); // proves the field is READ, not merely declared
    } finally {
      unregisterUIAction('test.lockAuthored');
    }
  });

  it('authored inputLockMinMs: 0 disables the floor while the async gate still holds', async () => {
    world.spawn(UISettings({ inputLockMinMs: 0 }));
    let resolveFn!: () => void;
    const pending = new Promise<void>((res) => { resolveFn = res; });
    let calls = 0;
    registerUIAction('test.lockZeroFloor', () => { calls += 1; return pending; });
    try {
      applyBindings(call('test.lockZeroFloor'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      // No time advance at all — the floor is 0, but the promise is still pending.
      applyBindings(call('test.lockZeroFloor'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1); // async gate alone still blocks

      resolveFn();
      await pending;

      applyBindings(call('test.lockZeroFloor'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2);
    } finally {
      unregisterUIAction('test.lockZeroFloor');
    }
  });

  it('safety valve: force-releases past inputLockMaxMs and warns, for a promise that never settles', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    registerUIAction('test.lockHung', () => { calls += 1; return new Promise<void>(() => {}); });
    try {
      applyBindings(call('test.lockHung'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      advanceManual(10001); // past the default 10000ms max — the promise never settles
      applyBindings(call('test.lockHung'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2); // recovered
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0][0])).toContain('test.lockHung');
    } finally {
      unregisterUIAction('test.lockHung');
      warnSpy.mockRestore();
    }
  });

  // Finding 3: `lockPendingNames` must be PRUNED as each promise settles, not just decremented —
  // otherwise the valve's warning keeps naming a handler that already finished.
  it('safety valve warning names only the STILL-pending handler, not one that already settled', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fastCalls = 0;
    let hungCalls = 0;
    const fastPromise = Promise.resolve();
    registerUIAction('test.fastAction', () => { fastCalls += 1; return fastPromise; });
    registerUIAction('test.hungAction', () => { hungCalls += 1; return new Promise<void>(() => {}); });
    const bindings: UIActionBinding[] = [
      { event: 'click', kind: 'call', action: 'test.fastAction' },
      { event: 'click', kind: 'call', action: 'test.hungAction' },
    ];
    try {
      applyBindings(bindings, 'click', { selfGuid: 'btn-1' });
      expect(fastCalls).toBe(1);
      expect(hungCalls).toBe(1);

      // Let the fast promise's own settle() microtask run — it should prune ITS name, leaving
      // only the hung one pending.
      await fastPromise;
      await Promise.resolve(); // one more tick for trackLockPromise's .then(settle, settle)

      advanceManual(10001); // past the default max — the hung handler still hasn't settled
      applyBindings(bindings, 'click', { selfGuid: 'btn-1' });
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('test.hungAction');
      expect(message).not.toContain('test.fastAction');
    } finally {
      unregisterUIAction('test.fastAction');
      unregisterUIAction('test.hungAction');
      warnSpy.mockRestore();
    }
  });

  it('continuous exemption: a range-slider-style change fires repeatedly and never takes the lock', () => {
    let sliderCalls = 0;
    let clickCalls = 0;
    registerUIAction('test.lockSlider', () => { sliderCalls += 1; });
    registerUIAction('test.lockClick', () => { clickCalls += 1; });
    try {
      applyBindings(call('test.lockSlider', 'change'), 'change', { selfGuid: 'slider-1', eventValue: 1, continuous: true });
      applyBindings(call('test.lockSlider', 'change'), 'change', { selfGuid: 'slider-1', eventValue: 2, continuous: true });
      applyBindings(call('test.lockSlider', 'change'), 'change', { selfGuid: 'slider-1', eventValue: 3, continuous: true });
      expect(sliderCalls).toBe(3); // every drag tick ran — continuous never blocks itself

      // A continuous stream must not have taken the lock either — a discrete click right after
      // still fires.
      applyBindings(call('test.lockClick'), 'click', { selfGuid: 'btn-1' });
      expect(clickCalls).toBe(1);
    } finally {
      unregisterUIAction('test.lockSlider');
      unregisterUIAction('test.lockClick');
    }
  });

  it('a submit and a toggle-style change DO respect the lock', () => {
    let submitCalls = 0;
    let toggleCalls = 0;
    registerUIAction('test.lockSubmit', () => { submitCalls += 1; });
    registerUIAction('test.lockToggle', () => { toggleCalls += 1; });
    try {
      applyBindings(call('test.lockSubmit', 'submit'), 'submit', { selfGuid: 'field-1', eventValue: 'x' });
      // submit took the lock — a toggle change right after (no continuous flag) is swallowed.
      applyBindings(call('test.lockToggle', 'change'), 'change', { selfGuid: 'toggle-1', eventValue: true });
      expect(submitCalls).toBe(1);
      expect(toggleCalls).toBe(0);

      advanceManual(UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS + 1);
      applyBindings(call('test.lockToggle', 'change'), 'change', { selfGuid: 'toggle-1', eventValue: true });
      expect(toggleCalls).toBe(1);
    } finally {
      unregisterUIAction('test.lockSubmit');
      unregisterUIAction('test.lockToggle');
    }
  });

  // Guards the `UIActionHandler = (ctx) => unknown` contract: it must stay `unknown`, not
  // `void | Promise<void>`, because TS's void-returning-function exemption does not survive a
  // union — a FUTURE "tidy up the types" pass narrowing this back to a union would silently
  // break every game handler written as a value-returning one-liner (`onClick: () => count++`),
  // and since games are copied OUT of this repo (#29), that's game code we can't see or fix.
  it('a value-returning one-liner handler compiles and is treated as SYNCHRONOUS by the lock', () => {
    let bumped = 0;
    // The exact shape this guards: no braces, no `void` cast — the arrow's implicit return is
    // the increment's own numeric result, which `dispatchUIAction`/`trackLockPromise` must
    // accept without a type error and without mistaking it for a pending promise.
    registerUIAction('test.lockOneLiner', () => bumped++);
    try {
      applyBindings(call('test.lockOneLiner'), 'click', { selfGuid: 'btn-1' });
      expect(bumped).toBe(1);

      // A number is not a thenable, so the lock must lift on the time floor, not stay held
      // forever waiting for a "promise" that was never one.
      advanceManual(UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS + 1);
      applyBindings(call('test.lockOneLiner'), 'click', { selfGuid: 'btn-1' });
      expect(bumped).toBe(2);
    } finally {
      unregisterUIAction('test.lockOneLiner');
    }
  });

  // Regression for a classification error in the original brief: the text input's 'change' was
  // going to be left DISCRETE, but a controlled `<input value={inputValue}>` fires 'change' once
  // per KEYSTROKE — locking it drops every character typed within the lock window after the
  // first, because the binding write IS what produces the field's value (a swallowed keystroke
  // is LOST, not delayed). `continuous: true` on that event stream is what UINode.tsx now sets.
  it('typing regression: a text-input-shaped change with continuous:true never drops a keystroke', () => {
    const field = world.spawn(EntityAttributes({ guid: 'field-1', name: 'field-1' }), UIElement({ placeholder: '' }));
    let calls = 0;
    registerUIAction('test.lockTyping', () => { calls += 1; });
    const bindings: UIActionBinding[] = [
      { event: 'change', kind: 'set', target: 'field-1', component: 'UIElement', property: 'placeholder', value: '$value' },
      { event: 'change', kind: 'call', action: 'test.lockTyping' },
    ];
    try {
      // Fast typing: every keystroke fires 'change' with NO clock advance between them — the
      // exact shape that would starve every keystroke but the first if 'change' took the lock.
      for (const chars of ['h', 'he', 'hel', 'hell', 'hello']) {
        applyBindings(bindings, 'change', { selfGuid: 'field-1', eventValue: chars, continuous: true });
      }
      expect((field.get(UIElement) as any).placeholder).toBe('hello'); // ends at the LAST keystroke
      expect(calls).toBe(5); // the call binding ran once per keystroke, not swallowed after the first

      // Must not itself have taken the lock — a discrete click right after still fires.
      let clickCalls = 0;
      registerUIAction('test.lockTypingClick', () => { clickCalls += 1; });
      try {
        applyBindings(call('test.lockTypingClick'), 'click', { selfGuid: 'btn-1' });
        expect(clickCalls).toBe(1);
      } finally {
        unregisterUIAction('test.lockTypingClick');
      }
    } finally {
      unregisterUIAction('test.lockTyping');
    }
  });

  it('the converse still holds: a submit right after fast typing DOES respect the lock', () => {
    let submitCalls = 0;
    registerUIAction('test.lockTypingSubmit', () => { submitCalls += 1; });
    registerUIAction('test.lockTyping3', () => {});
    try {
      // Several rapid 'change' events first (the continuous stream), then a discrete 'submit'.
      for (let i = 0; i < 3; i++) {
        applyBindings(call('test.lockTyping3', 'change'), 'change', { selfGuid: 'field-1', eventValue: 'x', continuous: true });
      }
      applyBindings(call('test.lockTypingSubmit', 'submit'), 'submit', { selfGuid: 'field-1', eventValue: 'x' });
      expect(submitCalls).toBe(1);
      // A second submit right after (no clock advance) IS blocked by the lock the first took —
      // proving the preceding continuous stream never interfered with submit's own lock-taking.
      applyBindings(call('test.lockTypingSubmit', 'submit'), 'submit', { selfGuid: 'field-1', eventValue: 'x' });
      expect(submitCalls).toBe(1);
    } finally {
      unregisterUIAction('test.lockTypingSubmit');
      unregisterUIAction('test.lockTyping3');
    }
  });

  // Regression for a race in trackLockPromise: a promise registered against an EARLIER lock
  // (one force-released by the max-ms safety valve, or cleared by a world swap) must not
  // decrement the CURRENT lock's pendingCount when it finally settles late. Without the
  // `lockGen` generation guard, step 4 below releases lock 2 early — while activation 2's own
  // handler is still in flight — letting a THIRD tap through underneath it: the exact double-fire
  // #466 exists to prevent. Do NOT "simplify" the `gen === lockGen` check away.
  it('a stale promise from a force-released lock does not release a later lock early (generation guard)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // inputLockMinMs: 0 isolates the mechanism under test to pure async-completion gating — with
    // the default 300ms floor still in play, the time floor alone would mask a broken generation
    // guard (lock 2 would stay "locked" by the floor even if its pendingCount wrongly hit 0).
    world.spawn(UISettings({ inputLockMinMs: 0 }));
    let resolve1!: () => void;
    const pending1 = new Promise<void>((res) => { resolve1 = res; });
    let resolve2!: () => void;
    const pending2 = new Promise<void>((res) => { resolve2 = res; });
    let calls1 = 0;
    let calls2 = 0;
    let calls3 = 0;
    registerUIAction('test.lockGenA', () => { calls1 += 1; return pending1; });
    registerUIAction('test.lockGenB', () => { calls2 += 1; return pending2; });
    registerUIAction('test.lockGenC', () => { calls3 += 1; });
    try {
      // 1. Activation 1: a handler whose promise never settles (yet).
      applyBindings(call('test.lockGenA'), 'click', { selfGuid: 'btn-1' });
      expect(calls1).toBe(1);

      // 2. Past inputLockMaxMs — the next lock CHECK force-releases lock 1.
      advanceManual(UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS + 1);

      // 3. Activation 2 acquires a FRESH lock with its own pending async handler.
      applyBindings(call('test.lockGenB'), 'click', { selfGuid: 'btn-2' });
      expect(calls2).toBe(1);

      // 4. Activation 1's stale promise settles NOW, after lock 2 already exists.
      resolve1();
      await pending1;

      // Lock 2 must STILL be held — its own handler hasn't settled — so a third tap is swallowed.
      applyBindings(call('test.lockGenC'), 'click', { selfGuid: 'btn-3' });
      expect(calls3).toBe(0);

      // Resolving activation 2's OWN handler is what actually releases lock 2 (the floor is 0
      // here, so completion alone is the gate).
      resolve2();
      await pending2;
      applyBindings(call('test.lockGenC'), 'click', { selfGuid: 'btn-3' });
      expect(calls3).toBe(1);
    } finally {
      unregisterUIAction('test.lockGenA');
      unregisterUIAction('test.lockGenB');
      unregisterUIAction('test.lockGenC');
      warnSpy.mockRestore();
    }
  });

  // Regression: `trackLockPromise` used to await a rejecting handler's promise via
  // `Promise.resolve(result).finally(...)` — `.finally()` RE-THROWS into its own derived
  // promise, which nobody awaits, so a rejecting handler produced TWO unhandled rejections
  // instead of the handler's own one. Fixed by settling both paths with `.then(onFulfilled,
  // onRejected)`, matching `managerRegistry.ts`'s `activate()` idiom, which swallows.
  it('a REJECTING async handler still releases the lock, adds no extra unhandled rejection, and WARNS (finding 4)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // inputLockMinMs: 0 isolates the mechanism under test (async-completion gating) from the
    // time floor, same as the generation-guard test above.
    world.spawn(UISettings({ inputLockMinMs: 0 }));
    let rejectFn!: (e: Error) => void;
    const pending = new Promise<void>((_res, rej) => { rejectFn = rej; });
    // The handler's own promise IS awaited by something (this test), so IT never reports as
    // unhandled — only trackLockPromise's OWN derived promise is what's being checked here.
    pending.catch(() => {}); // silence the handler's own rejection; not what we're testing
    let calls = 0;
    registerUIAction('test.lockReject', () => { calls += 1; return pending; });
    try {
      applyBindings(call('test.lockReject'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      rejectFn(new Error('handler failed'));
      await pending.catch(() => {}); // let trackLockPromise's .then(..) microtask run too

      // Lock released even though the handler rejected — decrement must happen on BOTH paths.
      applyBindings(call('test.lockReject'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2);

      // Give any unhandledRejection listener a turn to fire before asserting on it.
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      // `.then(settle, settle)` used to swallow a rejection completely — the lock's `.then`
      // both attaches a rejection handler AND used to do nothing with the error. Now the
      // rejection path must log, naming the action, before the lock releases.
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0][0])).toContain('test.lockReject');
    } finally {
      unregisterUIAction('test.lockReject');
      process.off('unhandledRejection', onUnhandled);
      warnSpy.mockRestore();
    }
  });

  // Finding 4's exemption: a superseded scene load rejects with AbortError as ordinary
  // operation (a fast double-navigation cancels the first `engine.loadScene`), and must stay
  // silent — logging it would be noise on every quick nav.
  it('an AbortError rejection is exempt from the warn (finding 4 exemption)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    world.spawn(UISettings({ inputLockMinMs: 0 }));
    let rejectFn!: (e: Error) => void;
    const pending = new Promise<void>((_res, rej) => { rejectFn = rej; });
    pending.catch(() => {});
    let calls = 0;
    registerUIAction('test.lockAbort', () => { calls += 1; return pending; });
    try {
      applyBindings(call('test.lockAbort'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      rejectFn(abortErr);
      await pending.catch(() => {});

      applyBindings(call('test.lockAbort'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2); // lock still released normally
      expect(warnSpy).not.toHaveBeenCalled(); // but silently — no noise for a normal cancel
    } finally {
      unregisterUIAction('test.lockAbort');
      warnSpy.mockRestore();
    }
  });

  // Finding 5: the Inspector can't express a cross-field constraint, so authoring
  // `inputLockMinMs > inputLockMaxMs` is legal input. Unclamped, the valve would fire before
  // the floor even elapses — force-releasing (and warning) on every activation past the
  // (smaller) max. `acquireLock`'s call site clamps `maxMs` up to `minMs`.
  it('an authored inputLockMinMs > inputLockMaxMs does not force-release before the floor', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    world.spawn(UISettings({ inputLockMinMs: 1000, inputLockMaxMs: 100 }));
    let calls = 0;
    registerUIAction('test.lockInverted', () => { calls += 1; });
    try {
      applyBindings(call('test.lockInverted'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      // Past the authored (smaller) max but still under the authored (larger) min — an
      // unclamped valve would force-release and warn here.
      advanceManual(150);
      applyBindings(call('test.lockInverted'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1); // still swallowed — the floor, not the inverted max, governs
      expect(warnSpy).not.toHaveBeenCalled();

      // Past the (larger) min: the floor elapsed, so it fires now.
      advanceManual(1000);
      applyBindings(call('test.lockInverted'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2);
      // Strengthened: assert across the WHOLE sequence, not just the pre-floor window — a
      // legitimate second tap past the floor must never warn either. This is the assertion that
      // actually distinguishes the fix from the bug it fixes: BEFORE the reorder in
      // `isInputLockActive`, this exact tap hit the max-ms valve the instant the (smaller,
      // clamped-up) ceiling elapsed and warned every time, even though `calls` came out
      // "correct" — the earlier version of this test stopped checking `warnSpy` right where the
      // bug lived and so passed under both the buggy and fixed code.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      unregisterUIAction('test.lockInverted');
      warnSpy.mockRestore();
    }
  });

  // Finding 1: the max-ms valve must never fire on an IDLE lock with nothing pending — only a
  // genuinely-pending (async, unsettled) lock can hang. A plain synchronous handler settles
  // instantly, so its lock has nothing pending well before `inputLockMaxMs` and must be freed
  // silently by the floor branch, however much later the next tap lands.
  it('idling past inputLockMaxMs with a plain synchronous handler does not warn — the floor frees it silently', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    registerUIAction('test.lockIdleSync', () => { calls += 1; });
    try {
      applyBindings(call('test.lockIdleSync'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      // Idle well past the default max — nothing pending, so the valve must not fire.
      advanceManual(UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS + 1000);
      applyBindings(call('test.lockIdleSync'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2); // the tap fires
      expect(warnSpy).not.toHaveBeenCalled(); // and it fires silently, no "handler never settled"
    } finally {
      unregisterUIAction('test.lockIdleSync');
      warnSpy.mockRestore();
    }
  });

  // An authored min === max is a perfectly reasonable value (not an inversion), and must not
  // collapse into a warn on every second tap either — same underlying bug as the min>max case.
  it('an authored inputLockMinMs === inputLockMaxMs does not warn on a legitimate second tap', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    world.spawn(UISettings({ inputLockMinMs: 1000, inputLockMaxMs: 1000 }));
    let calls = 0;
    registerUIAction('test.lockEqual', () => { calls += 1; });
    try {
      applyBindings(call('test.lockEqual'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(1);

      advanceManual(1150); // past the shared floor/ceiling
      applyBindings(call('test.lockEqual'), 'click', { selfGuid: 'btn-1' });
      expect(calls).toBe(2);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      unregisterUIAction('test.lockEqual');
      warnSpy.mockRestore();
    }
  });
});
