/** previewLoopGuard — the mechanism that lets a displacement notification stop ONE panel's own
 *  rAF loop without touching the shared `isPreviewPlaying` store flag (#810 follow-up). See the
 *  module doc for the bug this replaces: the first pass's displaced callback called
 *  `setPreviewPlaying(false)`, which stopped BOTH panels' preview effects since they share the
 *  one flag. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPreviewLoopGuard } from '../../src/editor/panels/previewLoopGuard';

describe('createPreviewLoopGuard', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      const id = nextId++;
      rafCallbacks.set(id, fn);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafCallbacks.delete(id); });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  function fireFrame(id: number): void {
    const fn = rafCallbacks.get(id);
    rafCallbacks.delete(id);
    fn?.(0);
  }

  it('stop() cancels the currently in-flight rAF', () => {
    const guard = createPreviewLoopGuard();
    const id = requestAnimationFrame(() => {});
    guard.arm(id);
    guard.stop();
    expect(rafCallbacks.has(id)).toBe(false); // cancelAnimationFrame reached the real queue
  });

  it('a tick already queued does not reschedule once stopped — checked BEFORE the tick reschedules', () => {
    const guard = createPreviewLoopGuard();
    let ticks = 0;
    const tick = () => {
      if (guard.stopped) return; // the contract every caller must follow
      ticks += 1;
      guard.arm(requestAnimationFrame(tick));
    };
    const first = requestAnimationFrame(tick);
    guard.arm(first);
    guard.stop(); // displaced before the first tick ever ran
    // The frame is already gone from the fake queue (stop() cancelled it), but even a caller that
    // fired it anyway (a real browser can still invoke an id whose cancel raced the paint) must
    // not reschedule — prove that by invoking the callback directly, bypassing the fake queue.
    rafCallbacks.set(first, tick); // simulate "already queued, fires regardless of the cancel"
    fireFrame(first);
    expect(ticks).toBe(0); // refused to reschedule — the `stopped` check is what saved it
  });

  it('stop() is idempotent — a second call does nothing surprising', () => {
    const guard = createPreviewLoopGuard();
    const id = requestAnimationFrame(() => {});
    guard.arm(id);
    guard.stop();
    expect(() => guard.stop()).not.toThrow();
    expect(guard.stopped).toBe(true);
  });

  it('one guard stopping does not affect an INDEPENDENT guard\'s loop', () => {
    // Models the two-panel case: the displaced panel's guard stops; the surviving owner's guard
    // (a separate instance) keeps ticking untouched.
    const displaced = createPreviewLoopGuard();
    const survivor = createPreviewLoopGuard();
    let survivorTicks = 0;
    const survivorTick = () => {
      if (survivor.stopped) return;
      survivorTicks += 1;
      if (survivorTicks < 3) survivor.arm(requestAnimationFrame(survivorTick));
    };
    const displacedId = requestAnimationFrame(() => {});
    displaced.arm(displacedId);
    const survivorId = requestAnimationFrame(survivorTick);
    survivor.arm(survivorId);

    displaced.stop(); // only the displaced panel is told to stop
    fireFrame(survivorId);
    fireFrame([...rafCallbacks.keys()][0]);
    fireFrame([...rafCallbacks.keys()][0]);

    expect(survivorTicks).toBe(3); // the surviving loop kept running, unaffected
    expect(displaced.stopped).toBe(true);
    expect(survivor.stopped).toBe(false);
  });
});
