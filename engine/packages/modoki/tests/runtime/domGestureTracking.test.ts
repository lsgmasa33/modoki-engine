/** domGestureTracking — a native TOUCH gesture live anywhere in the DOM, independent of the
 *  canvas-scoped `Input` resource (#579). See the module's own header for the full argument —
 *  why this exists, why it is TOUCH ONLY (a first cut also tracked mouse and review found that
 *  froze the editor's own live-tuning loop for no benefit — a mouse press cannot start or desync
 *  the WebKit touch-scroll compositor this guards), and why the safety timeout resets on
 *  `touchmove` rather than only on `touchstart`. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  wireDomGestureTracking, unwireDomGestureTracking, isDomGestureActive, resetDomGestureTracking,
} from '../../src/runtime/ui/domGestureTracking';
import { registerPointerBlocker, clearPointerBlockers } from '../../src/runtime/core/pointerBlockers';

/** `touchstart`/`touchmove` dispatch is target-aware for #595 — an optional `target` element lets a
 *  case simulate a touch landing on a specific node (e.g. simulated editor chrome) rather than
 *  always on `document` itself. */
const touchStart = (target: EventTarget = document) =>
  target.dispatchEvent(new Event('touchstart', { bubbles: true }));
const touchMove = (target: EventTarget = document) =>
  target.dispatchEvent(new Event('touchmove', { bubbles: true }));
/** `touches` defaults to empty — a real `TouchEvent` isn't constructible in jsdom, so `onEnd`'s
 *  multi-touch check is driven by stubbing the property on a plain `Event`, which is exactly
 *  what the module reads (`e.touches.length`) and nothing more. */
const touchEnd = (touches: unknown[] = [], target: EventTarget = window) => {
  const e = new Event('touchend', { bubbles: true }) as Event & { touches: unknown[] };
  e.touches = touches;
  target.dispatchEvent(e);
};
const touchCancel = () => {
  const e = new Event('touchcancel', { bubbles: true }) as Event & { touches: unknown[] };
  e.touches = [];
  window.dispatchEvent(e);
};
const pointerDown = (pointerType: string) =>
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType }));

beforeEach(() => {
  wireDomGestureTracking();
});
afterEach(() => {
  unwireDomGestureTracking();
  resetDomGestureTracking();
  clearPointerBlockers();
});

describe('domGestureTracking', () => {
  it('is inactive before anything happens', () => {
    expect(isDomGestureActive()).toBe(false);
  });

  it('a touchstart activates it; touchend ends it', () => {
    touchStart();
    expect(isDomGestureActive()).toBe(true);
    touchEnd();
    expect(isDomGestureActive()).toBe(false);
  });

  it('touchcancel also ends a touch gesture', () => {
    touchStart();
    touchCancel();
    expect(isDomGestureActive()).toBe(false);
  });

  it('a touchend with other fingers still down does NOT end the gesture — multi-touch', () => {
    touchStart();
    touchEnd([{}]); // one finger lifted, one still reported down
    expect(isDomGestureActive(), 'a finger still down must keep the gesture active').toBe(true);
    touchEnd([]); // the last finger lifts
    expect(isDomGestureActive()).toBe(false);
  });

  it('a MOUSE pointerdown does NOT activate it — this file is touch-only (found in review: tracking mouse froze the editor\'s own live-tuning loop for no benefit)', () => {
    pointerDown('mouse');
    expect(isDomGestureActive()).toBe(false);
  });

  it('a TOUCH pointercancel is not even listened for — this file no longer tracks Pointer Events at all', () => {
    touchStart();
    window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
    expect(isDomGestureActive(), 'a touch gesture is only ever ended by a real touchend/touchcancel').toBe(true);
    touchEnd();
  });

  it('unwireDomGestureTracking stops listening and resets the flag', () => {
    touchStart();
    expect(isDomGestureActive()).toBe(true);
    unwireDomGestureTracking();
    expect(isDomGestureActive(), 'unwiring must not leave a stale gesture active').toBe(false);
    touchStart(); // no listener attached any more — must not reactivate it
    expect(isDomGestureActive()).toBe(false);
    wireDomGestureTracking(); // re-arm for afterEach's own unwire to have something to tear down
  });

  it('a missing end event does not wedge the flag true forever — the safety timeout', () => {
    vi.useFakeTimers();
    try {
      touchStart();
      expect(isDomGestureActive()).toBe(true);
      vi.advanceTimersByTime(5001);
      expect(isDomGestureActive(), 'the safety timeout must have fired').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ⚠️ **The regression this design exists to avoid.** A first cut keyed the safety timeout off
   * `touchstart` alone — defensible for `scrollAnchor.ts`'s quick settle-and-release gestures, but
   * wrong here: browsing a long list with a finger down for MORE than 5s is ordinary, and a timer
   * that only measured "since start" would un-gate the probe mid-browse, reproducing the original
   * stall for the rest of that same touch.
   */
  it('touchmove resets the safety deadline — a long, active gesture is never wedged off early', () => {
    vi.useFakeTimers();
    try {
      touchStart();
      // Keep "moving" every 2s, well under the 5s deadline each time — a real scroll's touchmove
      // stream is far denser than this, so this is a conservative lower bound.
      for (let i = 0; i < 4; i += 1) {
        vi.advanceTimersByTime(2000);
        touchMove();
        expect(isDomGestureActive(), `still active after ${(i + 1) * 2}s of activity`).toBe(true);
      }
      // Total elapsed here is 8s — past the original fixed timeout — and it is STILL active
      // because activity never stopped.
      touchEnd();
      expect(isDomGestureActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ⚠️ **Round 3 review's finding: `onMove` must set `active = true` unconditionally, not just
   * re-arm an already-active gesture.** A version gated on `if (active) armSafetyTimer()` can
   * never recover once the safety timer fires mid-touch (finger held still ≥5s, then resumes
   * moving) — the gate stays silently off for the rest of that touch, reopening the original
   * forced-layout stall during the exact "pause then resume scrolling" case this file exists for.
   */
  it('a touchmove AFTER the safety timeout has already fired reactivates the gesture, not just extends it', () => {
    vi.useFakeTimers();
    try {
      touchStart();
      vi.advanceTimersByTime(5001);
      expect(isDomGestureActive(), 'fixture: the safety timeout must have fired first').toBe(false);
      touchMove();
      expect(
        isDomGestureActive(),
        'a touchmove always means a finger is down, whatever the flag said a moment ago — ' +
          'gating the re-arm on the stale flag is what makes a paused-then-resumed drag never ' +
          'recover',
      ).toBe(true);
      touchEnd();
      expect(isDomGestureActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('but a gesture that goes truly idle (no touchmove) still times out at 5s after the LAST activity', () => {
    vi.useFakeTimers();
    try {
      touchStart();
      vi.advanceTimersByTime(3000);
      touchMove(); // resets the deadline to 3s + 5s = 8s
      expect(isDomGestureActive()).toBe(true);
      vi.advanceTimersByTime(4999); // 7.999s total — just under the reset deadline
      expect(isDomGestureActive()).toBe(true);
      vi.advanceTimersByTime(2); // past it
      expect(isDomGestureActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** ── #595: a touch's TARGET is filtered against the game surface ──
   *
   *  Reproduces the editor case: the game runtime and the editor's own chrome share one
   *  `document`, so `wireDomGestureTracking`'s listeners see BOTH. `registerPointerBlocker` stands
   *  in for `UIRenderer`'s runtime-mode-only registration of the game's UI root — anything outside
   *  it is, from this module's point of view, editor chrome. */
  describe('target filtering against the registered game surface (#595)', () => {
    it('a touchstart OUTSIDE the registered game surface does not activate the gesture', () => {
      const gameRoot = document.createElement('div');
      const chrome = document.createElement('div');
      document.body.append(gameRoot, chrome);
      registerPointerBlocker(gameRoot);

      touchStart(chrome);
      expect(isDomGestureActive(), 'a touch on editor chrome must not be tracked').toBe(false);
    });

    it('a touchstart INSIDE the registered game surface activates the gesture', () => {
      const gameRoot = document.createElement('div');
      const chrome = document.createElement('div');
      document.body.append(gameRoot, chrome);
      registerPointerBlocker(gameRoot);

      touchStart(gameRoot);
      expect(isDomGestureActive()).toBe(true);
      touchEnd();
    });

    it('a touchend on chrome still clears an active gesture started inside the game surface — onEnd is ungated', () => {
      const gameRoot = document.createElement('div');
      const chrome = document.createElement('div');
      document.body.append(gameRoot, chrome);
      registerPointerBlocker(gameRoot);

      touchStart(gameRoot);
      expect(isDomGestureActive()).toBe(true);
      touchEnd([], chrome);
      expect(
        isDomGestureActive(),
        'a release landing off the game surface must still end the gesture, or the flag wedges true forever',
      ).toBe(false);
    });

    it('the safety-timer recovery still works for a touch on the game surface after the timer fires', () => {
      const gameRoot = document.createElement('div');
      document.body.append(gameRoot);
      registerPointerBlocker(gameRoot);

      vi.useFakeTimers();
      try {
        touchStart(gameRoot);
        expect(isDomGestureActive()).toBe(true);
        vi.advanceTimersByTime(5001);
        expect(isDomGestureActive(), 'fixture: the safety timeout must have fired first').toBe(false);
        touchMove(gameRoot);
        expect(
          isDomGestureActive(),
          'a touchmove on the game surface after the timer fired must re-arm the gesture',
        ).toBe(true);
        touchEnd();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
