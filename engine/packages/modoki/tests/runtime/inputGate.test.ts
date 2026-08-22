// @vitest-environment jsdom
/** Host input gate (focus-scope refactor P5.1).
 *
 *  jsdom, not node: the #264 block below drives the REAL pointerSource through window
 *  PointerEvents, because the defect only exists in the interaction between the registry's
 *  gate bookkeeping and a source that QUEUES discrete events. A fake source with a counting
 *  `reset()` cannot express it — which is exactly why the bug survived this file's original
 *  coverage.
 *
 *  The editor needs the running game to stop receiving input while an editor panel owns
 *  the keyboard — but that policy CANNOT live in a source: keyboardSource ships inside
 *  every game and must never know what a "panel" is. So the runtime provides the
 *  mechanism (this gate) and the host supplies the predicate, mirroring the injectable
 *  clock. A shipped game installs no gate and behaves exactly as before. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setInputGate, isInputSuppressed, sampleAll, registerSource, unregisterSource,
  type InputSource,
} from '../../src/runtime/input/inputSources';
import { createInputFrame, computePointerEdge } from '../../src/runtime/core/inputActions';
import type { InputFrame } from '../../src/runtime/core/inputActions';
import { pointerSource } from '../../src/runtime/input/pointerSource';

// Use the REAL frame factory: the built-in keyboard/gamepad/pointer sources are
// globally registered and sample into it too, so a hand-rolled partial frame throws
// inside pointerSource rather than testing anything.
const emptyFrame = (): InputFrame => createInputFrame();

/** A stand-in source that records sampling and resets. */
function fakeSource(name: string) {
  const calls = { sample: 0, reset: 0, attach: 0, detach: 0 };
  const src: InputSource = {
    name,
    attach() { calls.attach++; },
    detach() { calls.detach++; },
    reset() { calls.reset++; },
    sample() { calls.sample++; },
  };
  return { src, calls };
}

let fake: ReturnType<typeof fakeSource>;

beforeEach(() => {
  setInputGate(null);
  fake = fakeSource('test-fake');
  registerSource(fake.src);
});
afterEach(() => {
  unregisterSource('test-fake');
  setInputGate(null);
});

describe('default behaviour — a shipped game installs no gate', () => {
  it('is not suppressed with no gate', () => {
    expect(isInputSuppressed()).toBe(false);
  });

  it('samples sources normally', () => {
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
    expect(fake.calls.reset).toBe(0);
  });
});

describe('gate closed — input stops reaching the game', () => {
  it('skips sampling entirely', () => {
    setInputGate(() => true);
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(0);
  });

  it('drains latched state EVERY suppressed frame, not once on the closing edge (#264)', () => {
    // Load-bearing, not tidiness: hold W, click the Hierarchy, and without the reset
    // `held` still contains 'w' so the character keeps walking until you release.
    //
    // Continuous, not edge-triggered — that is the #264 change. The old code reset once on
    // closing and once on REOPENING, and the reopening one ate the click that opened the
    // gate (see the pointerSource regression test below). Draining every suppressed frame
    // keeps the backlog property with nothing left to clear at reopen.
    setInputGate(() => true);
    sampleAll(emptyFrame());
    sampleAll(emptyFrame());
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(3);
    expect(fake.calls.sample).toBe(0);
  });

  it('resumes sampling when the gate reopens, and does NOT reset on that frame', () => {
    let blocked = true;
    setInputGate(() => blocked);
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(1);

    blocked = false;
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
    expect(fake.calls.reset).toBe(1);   // the reopened frame is left ALONE — #264

    blocked = true;
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(2);   // suppressed again → draining again
  });

  it('keeps draining while shut, and stops once open — the bookkeeping half', () => {
    // ⚠️ SCOPE, because the first draft of this test claimed more than it checks: `fake` is a
    // COUNTING source with no queue, so nothing here can verify that queued DATA does not
    // replay. It pins the reset FREQUENCY only. The real anti-replay property — a genuine
    // queued press not leaking into the game — is pinned by
    // '#264 › still drops a press made while the gate was shut', which drives the real
    // pointerSource. (The test this replaced was count-only too, so that property was never
    // covered before either; the #264 block is strictly stronger than what was deleted.)
    let blocked = true;
    setInputGate(() => blocked);
    sampleAll(emptyFrame());
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(2);   // drained on each suppressed frame, so nothing accrues

    blocked = false;
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);

    // Staying open must not re-fire reset every frame — a source that is being sampled
    // must keep its state.
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(2);
    expect(fake.calls.sample).toBe(2);
  });
});

/** #264 — the click that OPENS the gate must survive.
 *
 *  Uses the REAL pointerSource, not the fake above: the defect lived in the interaction
 *  between the registry's edge bookkeeping and a source that QUEUES discrete events, and a
 *  fake with a counting `reset()` cannot express that. `PanelFocusHost` moves the keyboard
 *  scope on capture-phase pointerdown — before pointerSource's own window listener runs — so
 *  a click into the Game panel opens the gate and enqueues its press within one tick. */
describe('#264: the press that opens the gate', () => {
  const firePointer = (type: string, x: number, y: number, pointerId = 1): void => {
    const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
    (ev as { pointerId: number }).pointerId = pointerId;
    window.dispatchEvent(ev);
  };
  const step = (prev: { down: boolean }): InputFrame => {
    const f = emptyFrame();
    sampleAll(f);
    computePointerEdge(f, prev);
    return f;
  };

  // `detach()` calls reset(), which clears down/activeId/pending/the 1€ filters — but NOT
  // x/y/startX/startY, which persist as the last known pointer position by design. Inert
  // today (no later test in this file reads pointer coordinates) and called out here because
  // the next one that does would inherit 160/140 from the drag case above.
  afterEach(() => { pointerSource.detach(); });

  it('delivers a press that lands in the same tick the scope moves to the game', () => {
    pointerSource.attach();
    let scope = 'hierarchy';
    setInputGate(() => scope !== 'game');
    const prev = { down: false };

    step(prev);                              // suppressed frame — drains, samples nothing
    scope = 'game';                          // PanelFocusHost, capture phase
    firePointer('pointerdown', 100, 100);    // pointerSource's window listener, same tick
    const f = step(prev);                    // the reopened frame

    // Before #264 this was {pressed:false, down:false} — the reopening-edge reset cleared
    // `pending` AND `activeId`, so the whole gesture died, not just this edge.
    expect(f.pointer.pressed).toBe(true);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.x).toBe(100);
  });

  it('keeps the REST of that gesture alive — a drag, not just the press edge', () => {
    // `reset()` also nulls `activeId`, and every later move/up checks `pointerId !== activeId`.
    // So the old bug lost drag-to-aim entirely; asserting only the pressed edge would miss it.
    pointerSource.attach();
    let scope = 'hierarchy';
    setInputGate(() => scope !== 'game');
    const prev = { down: false };

    step(prev);
    scope = 'game';
    firePointer('pointerdown', 100, 100);
    step(prev);
    firePointer('pointermove', 160, 140);
    const f = step(prev);

    expect(f.pointer.down).toBe(true);
    expect(f.pointer.dragX).toBe(60);
    expect(f.pointer.dragY).toBe(40);
  });

  it('still drops a press made while the gate was shut', () => {
    // The other half, and the one the deleted reopening reset was protecting: a click in an
    // editor panel must NOT reach the game when focus later returns to the GameView.
    pointerSource.attach();
    let scope = 'hierarchy';
    setInputGate(() => scope !== 'game');
    const prev = { down: false };

    step(prev);
    firePointer('pointerdown', 10, 10);      // clicked the Hierarchy — gate still shut
    step(prev);                              // drained here
    scope = 'game';
    const f = step(prev);

    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.down).toBe(false);
  });
});

describe('robustness', () => {
  it('a source whose reset() THROWS cannot kill the frame callback (#264 follow-up)', () => {
    // Making the drain continuous removed the throttle that used to bound this: under the old
    // edge-triggered shape a throwing reset could not repeat, and frameDriver clears a
    // callback's error count on any successful run. Per-frame it throws every suppressed
    // frame, and frameDriver auto-unregisters after 10 CONSECUTIVE errors — that callback
    // being the whole 'ecs' pipeline. So an unguarded drain lets one buggy game-registered
    // source kill physics/animation/transforms by leaving an editor panel focused for ~166ms.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad: InputSource = {
      name: 'test-throwing-reset',
      attach() {}, detach() {}, sample() {},
      reset() { throw new Error('boom'); },
    };
    // Registered BEFORE the healthy one, deliberately: `fake` (from beforeEach) already sits
    // earlier in the array, so asserting on it proves nothing about whether a throw stops the
    // iteration. `after` is what pins that — a first draft asserted on `fake` and a
    // break-out-of-the-loop mutation sailed straight through it.
    const after = fakeSource('test-after-thrower');
    registerSource(bad);
    registerSource(after.src);
    setInputGate(() => true);
    try {
      for (let i = 0; i < 12; i++) expect(() => sampleAll(emptyFrame())).not.toThrow();
      // Reported ONCE, not once per frame — a per-frame console.error is its own outage.
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('test-throwing-reset');
      // A source AFTER the thrower is still drained — one bad source must not strand the rest.
      expect(after.calls.reset).toBe(12);
    } finally {
      unregisterSource('test-throwing-reset');
      unregisterSource('test-after-thrower');
      err.mockRestore();
    }
  });


  it('fails OPEN when the gate throws', () => {
    // A broken editor predicate must never make a game permanently uncontrollable.
    setInputGate(() => { throw new Error('boom'); });
    expect(isInputSuppressed()).toBe(false);
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
  });

  it('treats a non-true return as open', () => {
    setInputGate(() => undefined as unknown as boolean);
    expect(isInputSuppressed()).toBe(false);
  });

  it('clearing the gate restores sampling', () => {
    setInputGate(() => true);
    sampleAll(emptyFrame());
    setInputGate(null);
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
  });

  it('does not require a source to implement reset()', () => {
    const bare: InputSource = { name: 'bare', attach() {}, detach() {}, sample() {} };
    registerSource(bare);
    setInputGate(() => true);
    expect(() => sampleAll(emptyFrame())).not.toThrow();
    unregisterSource('bare');
  });
});

describe("the editor's actual policy", () => {
  // () => focusedPanel !== null && focusedPanel !== 'game'
  const policy = (focusedPanel: string | null) => () => focusedPanel !== null && focusedPanel !== 'game';

  it('suppresses while an editor panel owns the keyboard', () => {
    setInputGate(policy('hierarchy'));
    expect(isInputSuppressed()).toBe(true);
  });

  it('allows input when the GameView is focused', () => {
    setInputGate(policy('game'));
    expect(isInputSuppressed()).toBe(false);
  });

  it('allows input when NOTHING is focused', () => {
    // Pressing Play and immediately using WASD must work without first clicking the
    // GameView — otherwise the gate turns into a "why is my game dead?" bug.
    setInputGate(policy(null));
    expect(isInputSuppressed()).toBe(false);
  });
});
