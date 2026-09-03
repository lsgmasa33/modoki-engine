/** `gestureSource` — the multi-touch pan/pinch/tap recognizer (#443).
 *
 *  These drive the REAL source with real `window` pointer events and assert on the `GestureFrame` a
 *  game actually reads, rather than on the recognizer's internals. That matters most for the tap
 *  rules: "released quickly" and "released without travelling" are two separate escapes, and a test
 *  that only exercised one would pass against a recognizer that had forgotten the other.
 *
 *  Timestamps are set explicitly on each event because the whole tap contract is measured from
 *  `e.timeStamp` — the source reads no wall clock, so the test controls time completely. */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gestureSource, configureGestures, DEFAULT_TAP_MAX_MS, DEFAULT_TAP_SLOP_PX, EMULATED_PINCH_SEED_PX } from '../../packages/modoki/src/runtime/input/gestureSource';
import { createInputFrame, beginSample, type InputFrame } from '../../packages/modoki/src/runtime/core/inputActions';
import { registerPointerBlocker, clearPointerBlockers } from '../../packages/modoki/src/runtime/core/pointerBlockers';

beforeEach(() => {
  configureGestures({ tapMaxMs: DEFAULT_TAP_MAX_MS, tapSlopPx: DEFAULT_TAP_SLOP_PX, mouseEmulation: false });
  gestureSource.attach();
});

afterEach(() => {
  gestureSource.detach();
  clearPointerBlockers();
  document.body.innerHTML = '';
});

interface SendOpts { on?: EventTarget; pointerType?: string; shiftKey?: boolean; button?: number }

/** Dispatch one pointer event with a controlled id, position and timestamp. */
function send(type: string, id: number, x: number, y: number, t: number, opts: SendOpts = {}): void {
  const ev = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  ev.pointerId = id;
  ev.clientX = x;
  ev.clientY = y;
  ev.pointerType = opts.pointerType ?? 'touch';
  ev.button = opts.button ?? 0;
  ev.shiftKey = opts.shiftKey ?? false;
  ev.ctrlKey = false;
  ev.altKey = false;
  Object.defineProperty(ev, 'timeStamp', { value: t });
  (opts.on ?? window).dispatchEvent(ev);
}

/**
 * Base for every timestamp below.
 *
 * ⚠️ NOT zero, and that is load-bearing. `e.timeStamp` is milliseconds since page load, so a real
 * one is a large number. An earlier version of these tests counted from ~0 and hid a bug where a
 * leftover finger's `downT` was seeded to 0: `timeStamp - 0 >= tapMaxMs` is true for every real
 * event, so the finger promoted to panning, but at t=25 the subtraction stayed inside the window
 * and the test passed. Start the clock somewhere honest.
 */
const T0 = 1_483_920;

/** A modifier + left-drag with a MOUSE — the emulated-pinch gesture. */
const mouse = (shift = true): SendOpts => ({ pointerType: 'mouse', button: 0, shiftKey: shift });

/** Sample exactly as `inputSystem` does — `beginSample` first, because clearing the per-frame edges
 *  is part of the contract and a sample without it would let a stale `tapped` read as fresh. */
function sample(frame: InputFrame = createInputFrame()): InputFrame {
  beginSample(frame);
  gestureSource.sample(frame);
  return frame;
}

describe('tap', () => {
  it('a short, still press is a tap, reported at the DOWN position', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerup', 1, 102, 101, T0 + 100);

    const f = sample();
    expect(f.gesture.tapped).toBe(true);
    // The down point, not the up point — that is what the player aimed at.
    expect(f.gesture.tapX).toBe(100);
    expect(f.gesture.tapY).toBe(100);
  });

  it('a press held past the tap window is NOT a tap, even without moving', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerup', 1, 100, 100, T0 + DEFAULT_TAP_MAX_MS + 1);

    expect(sample().gesture.tapped).toBe(false);
  });

  it('a press that travels past the slop is NOT a tap, even when it is fast', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointermove', 1, 100 + DEFAULT_TAP_SLOP_PX + 5, 100, T0 + 20);
    send('pointerup', 1, 100 + DEFAULT_TAP_SLOP_PX + 5, 100, T0 + 40);

    // 40ms is well inside the tap window; only the distance rule can reject this. A duration-only
    // recognizer would call a fast flick a tap.
    expect(sample().gesture.tapped).toBe(false);
  });

  it('a tap fires on exactly ONE frame', () => {
    send('pointerdown', 1, 50, 50, T0 + 0);
    send('pointerup', 1, 50, 50, T0 + 50);

    expect(sample().gesture.tapped).toBe(true);
    // The second frame runs beginSample with no new events — the edge must not repeat.
    expect(sample().gesture.tapped).toBe(false);
  });

  it('a cancelled press emits no tap', () => {
    send('pointerdown', 1, 50, 50, T0 + 0);
    send('pointercancel', 1, 50, 50, T0 + 30);

    expect(sample().gesture.tapped).toBe(false);
  });
});

describe('pan', () => {
  it('promotes the instant the slop is crossed — it does NOT wait out the tap window', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointermove', 1, 100 + DEFAULT_TAP_SLOP_PX + 1, 100, T0 + 5); // 5ms in

    expect(sample().gesture.panning).toBe(true);
  });

  it('resumes from the CROSSING point, so engaging pan does not jump by the slop', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    // The move that promotes. Its own travel is the slop being consumed, not pan distance.
    send('pointermove', 1, 120, 100, T0 + 5);
    expect(sample().gesture.panX).toBe(0);

    // The next move is real pan, measured from where promotion happened (120), not from 100.
    send('pointermove', 1, 150, 100, T0 + 10);
    expect(sample().gesture.panX).toBe(30);
  });

  it('promotes a slow held finger once it moves past the tap window, even inside the slop', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointermove', 1, 102, 100, T0 + DEFAULT_TAP_MAX_MS + 10);

    expect(sample().gesture.panning).toBe(true);
  });

  it('accumulates every move between two frames, not just the newest', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointermove', 1, 120, 100, T0 + 5); // promotes
    sample();

    send('pointermove', 1, 130, 100, T0 + 10);
    send('pointermove', 1, 145, 100, T0 + 15);
    // Reading only the newest event would report 15; the finger travelled 25.
    expect(sample().gesture.panX).toBe(25);
  });

  it('reports no pan on a frame with no movement', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointermove', 1, 140, 100, T0 + 5);
    sample();
    send('pointermove', 1, 160, 100, T0 + 10);
    expect(sample().gesture.panX).toBe(20);
    expect(sample().gesture.panX).toBe(0);
  });
});

describe('pinch', () => {
  it('reports the spread ratio against the distance the pinch STARTED at', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5); // start distance 100
    let f = sample();
    expect(f.gesture.pinching).toBe(true);
    expect(f.gesture.pinchStarted).toBe(true);
    expect(f.gesture.pinchScale).toBeCloseTo(1, 6);

    send('pointermove', 2, 300, 100, T0 + 10); // distance 200
    f = sample();
    expect(f.gesture.pinchScale).toBeCloseTo(2, 6);
  });

  it('pinchScaleDelta is per-FRAME, so multiplying the deltas equals the absolute scale', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5); // 100
    sample();

    send('pointermove', 2, 250, 100, T0 + 10); // 150
    const a = sample().gesture.pinchScaleDelta;
    send('pointermove', 2, 300, 100, T0 + 15); // 200
    const b = sample().gesture.pinchScaleDelta;

    expect(a * b).toBeCloseTo(2, 6);
  });

  it('two fingers pan by their CENTROID while zooming', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5); // centroid x 150
    sample();

    // Both fingers slide +40 with the spread unchanged: pure pan, no zoom.
    send('pointermove', 1, 140, 100, T0 + 10);
    send('pointermove', 2, 240, 100, T0 + 10);
    const f = sample();
    expect(f.gesture.panX).toBeCloseTo(40, 6);
    expect(f.gesture.pinchScale).toBeCloseTo(1, 6);
  });

  it('lifting to one finger ends the pinch and does NOT resume panning', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5);
    sample();

    send('pointerup', 2, 200, 100, T0 + 20);
    const f = sample();
    expect(f.gesture.pinchEnded).toBe(true);
    expect(f.gesture.pinching).toBe(false);
    expect(f.gesture.pointerCount).toBe(1);

    // The surviving finger must not fling the content — a fresh press is required.
    send('pointermove', 1, 400, 100, T0 + 25);
    expect(sample().gesture.panX).toBe(0);
  });

  it('REGRESSION: a leftover finger cannot pan, however long the gesture ran', () => {
    // The bug: the surviving finger was parked in 'pending' with `downT = 0`. Since `e.timeStamp`
    // is ms since page load, `timeStamp - 0` always cleared the tap window, so the very next move
    // promoted it to panning and the content flew off under a finger the player had already
    // stopped pinching with. Now it goes to a 'dead' phase that only lifting every finger leaves.
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5);
    sample();
    send('pointerup', 2, 200, 100, T0 + 20);
    sample();

    // Move the survivor a long way, well past both the slop AND the tap window.
    send('pointermove', 1, 500, 400, T0 + 2000);
    const f = sample();
    expect(f.gesture.panning).toBe(false);
    expect(f.gesture.panX).toBe(0);
    expect(f.gesture.panY).toBe(0);
  });

  it('a fresh press after every finger lifts pans normally again', () => {
    // The CONTROL for the above — 'dead' must not be a trap the source never leaves.
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5);
    send('pointerup', 2, 200, 100, T0 + 20);
    send('pointerup', 1, 100, 100, T0 + 30);
    sample();

    send('pointerdown', 3, 300, 300, T0 + 100);
    send('pointermove', 3, 340, 300, T0 + 110); // promotes
    sample();
    send('pointermove', 3, 370, 300, T0 + 120);
    expect(sample().gesture.panX).toBe(30);
  });

  it('a second finger abandons a tap candidacy', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5);
    send('pointerup', 2, 200, 100, T0 + 20);
    send('pointerup', 1, 100, 100, T0 + 40); // inside the tap window, never moved

    expect(sample().gesture.tapped).toBe(false);
  });
});

describe('blocking and thresholds', () => {
  it('a press starting on blocked chrome is never tracked', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    registerPointerBlocker(panel);

    send('pointerdown', 1, 100, 100, T0 + 0, { on: panel });
    send('pointerup', 1, 100, 100, T0 + 50, { on: panel });

    const f = sample();
    expect(f.gesture.pointerCount).toBe(0);
    expect(f.gesture.tapped).toBe(false);
  });

  it('the thresholds are retunable, and a game is expected to author its own', () => {
    configureGestures({ tapMaxMs: 60 });
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerup', 1, 100, 100, T0 + 100); // would be a tap at the 250ms default

    expect(sample().gesture.tapped).toBe(false);
  });
});

describe('the host input gate (#264-adjacent) — a suppressed frame reports NO gesture, not a latched one', () => {
  /**
   * `beginSample` clears the WHOLE gesture frame every frame (edges and levels alike), and
   * `inputSources.sampleAll` skips `sample()` entirely on a suppressed frame — it calls `drain(s)`
   * (i.e. `reset()`) instead, which only clears the SOURCE's own finger-tracking state, never the
   * frame. This test drives both halves by hand, exactly as `sampleAll` does, rather than through
   * `sampleAll` itself: the source registry (`registerSource`/`isInputSuppressed`) is a SEPARATE
   * app-lifetime singleton this file's `gestureSource.attach()`/`detach()` per-test cycle does not
   * touch, so reaching for it here would leak across the whole suite. Reading `inputSources.ts`'s
   * own header comment is what specifies this exact shape (`beginSample`, then `reset()`, no
   * `sample()`) as the contract under test.
   *
   * Before #264-adjacent, `beginSample` left `pinching`/`pointerCount` LATCHED (only the per-frame
   * EDGES/deltas were cleared), so a suppressed frame kept reporting the pinch that was live when
   * the gate closed. Wordweave gates its whole spelling drag on `pinching` (`games/wordweave`'s
   * "#444" pinch-owns-the-pointer rule) — a latched `true` there is not a cosmetic stale read, it
   * is a board that stops accepting input for as long as an editor panel holds focus.
   */
  it('a pinch that is live when input gets suppressed reports NO pinch on the suppressed frame', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    send('pointerdown', 2, 200, 100, T0 + 5); // starts the pinch
    const f = sample();
    expect(f.gesture.pinching).toBe(true);
    expect(f.gesture.pointerCount).toBe(2);

    // The suppressed frame: `sampleAll` neither delivers new events nor calls `sample()` — it
    // clears the frame (`beginSample`) and drains the source (`reset()`) instead.
    beginSample(f);
    gestureSource.reset?.();

    expect(f.gesture.pinching).toBe(false);
    expect(f.gesture.pointerCount).toBe(0);
  });
});

describe('pointer set identity (#623)', () => {
  it('the one-finger swap is visible', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    const f1 = sample();
    const v1 = f1.gesture.pointerSetVersion;

    // No sample in between — id 1 lifts and a DIFFERENT id lands in the same window. `pointerCount`
    // and the pinch edges cannot see this; only the identity stamp can.
    send('pointerup', 1, 100, 100, T0 + 10);
    send('pointerdown', 2, 400, 400, T0 + 10);
    const f2 = sample();

    expect(f1.gesture.pointerCount).toBe(1);
    expect(f2.gesture.pointerCount).toBe(1);
    expect(f2.gesture.pinchStarted).toBe(false);
    expect(f2.gesture.pinchEnded).toBe(false);
    expect(f2.gesture.pointerSetVersion).not.toBe(v1);
  });

  it('movement alone does not bump it', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    const v1 = sample().gesture.pointerSetVersion;

    send('pointermove', 1, 100 + DEFAULT_TAP_SLOP_PX + 5, 100, T0 + 5); // promotes to panning
    send('pointermove', 1, 100 + DEFAULT_TAP_SLOP_PX + 40, 100, T0 + 10);
    const f = sample();

    expect(f.gesture.panning).toBe(true);
    expect(f.gesture.pointerSetVersion).toBe(v1);
  });

  it('a second finger landing bumps it, and lifting back to one bumps it again', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    const v1 = sample().gesture.pointerSetVersion;

    send('pointerdown', 2, 200, 100, T0 + 5);
    const v2 = sample().gesture.pointerSetVersion;
    expect(v2).not.toBe(v1);

    send('pointerup', 2, 200, 100, T0 + 20);
    const v3 = sample().gesture.pointerSetVersion;
    expect(v3).not.toBe(v2);
  });

  it('never 0 while a pointer is live', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    const f = sample();
    expect(f.gesture.pointerCount).toBe(1);
    expect(f.gesture.pointerSetVersion).toBeGreaterThan(0);
  });

  it('reset() is a change', () => {
    send('pointerdown', 1, 100, 100, T0 + 0);
    const v1 = sample().gesture.pointerSetVersion;

    // No `addPointer` between the two samples — isolates `clearPointers`'s OWN bump. A prior
    // version of this test landed a fresh pointer AFTER `reset()` and before re-sampling, so
    // `addPointer`'s bump alone satisfied the assertion below: deleting `pointerSetVersion++` from
    // `clearPointers` still left v1=V+1, a silent reset, then the new `addPointer` bumping to
    // V+2 — still "not equal", so the test could not tell the two bumps apart. `sample()` publishes
    // the raw module-level counter regardless of `live.length` (`gestureSource.ts`'s own
    // `sample()`: `g.pointerSetVersion = pointerSetVersion` is unconditional), so the bump from a
    // `reset()` alone, over an otherwise-untouched `live`, is directly observable here with nothing
    // else that could have caused it.
    gestureSource.reset?.();
    const v2 = sample().gesture.pointerSetVersion;

    expect(v2).not.toBe(v1);
  });
});

describe('mouse pinch emulation', () => {
  beforeEach(() => { configureGestures({ mouseEmulation: true }); });

  it('a modifier + mouse drag becomes a pinch once the fingers separate', () => {
    send('pointerdown', 9, 300, 300, T0 + 0, mouse());
    // Both synthetic fingers start ON the anchor, so nothing is armed yet — a zero spread has no
    // ratio to report against.
    expect(sample().gesture.pinching).toBe(false);

    send('pointermove', 9, 300 + EMULATED_PINCH_SEED_PX + 10, 300, T0 + 20, mouse());
    const f = sample();
    expect(f.gesture.pinching).toBe(true);
    expect(f.gesture.pinchStarted).toBe(true);
    expect(f.gesture.pointerCount).toBe(2);
  });

  it('THE POINT OF MIRRORING: the zoom centre stays nailed to the anchor', () => {
    send('pointerdown', 9, 300, 300, T0 + 0, mouse());
    send('pointermove', 9, 360, 300, T0 + 10, mouse());
    let f = sample();
    expect(f.gesture.centerX).toBeCloseTo(300, 6);
    expect(f.gesture.centerY).toBeCloseTo(300, 6);

    // Drag somewhere else entirely — the centroid must not follow the cursor.
    send('pointermove', 9, 300, 420, T0 + 20, mouse());
    f = sample();
    expect(f.gesture.centerX).toBeCloseTo(300, 6);
    expect(f.gesture.centerY).toBeCloseTo(300, 6);
  });

  it('moving AWAY from the anchor zooms in, moving back toward it zooms out', () => {
    send('pointerdown', 9, 300, 300, T0 + 0, mouse());
    send('pointermove', 9, 350, 300, T0 + 10, mouse()); // arms at spread 100
    sample();

    send('pointermove', 9, 400, 300, T0 + 20, mouse()); // spread 200
    expect(sample().gesture.pinchScale).toBeCloseTo(2, 6);

    send('pointermove', 9, 325, 300, T0 + 30, mouse()); // spread 50
    expect(sample().gesture.pinchScale).toBeCloseTo(0.5, 6);
  });

  it('without a modifier the same mouse drag is an ordinary pan, not a pinch', () => {
    send('pointerdown', 9, 300, 300, T0 + 0, mouse(false));
    send('pointermove', 9, 380, 300, T0 + 10, mouse(false));
    const f = sample();
    expect(f.gesture.pinching).toBe(false);
    expect(f.gesture.panning).toBe(true);
  });

  it('releasing ends the emulated pinch', () => {
    send('pointerdown', 9, 300, 300, T0 + 0, mouse());
    send('pointermove', 9, 380, 300, T0 + 10, mouse());
    sample();
    send('pointerup', 9, 380, 300, T0 + 20, mouse());

    const f = sample();
    expect(f.gesture.pinching).toBe(false);
    expect(f.gesture.pinchEnded).toBe(true);
    expect(f.gesture.pointerCount).toBe(0);
  });

  it('is OFF when disabled, so a release build cannot pinch by accident', () => {
    configureGestures({ mouseEmulation: false });
    send('pointerdown', 9, 300, 300, T0 + 0, mouse());
    send('pointermove', 9, 380, 300, T0 + 10, mouse());
    expect(sample().gesture.pinching).toBe(false);
  });
});
