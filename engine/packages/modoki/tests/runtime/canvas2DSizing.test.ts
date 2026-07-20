/** canvas2DSizing unit tests — bounded initial-measure retry (F10). */

import { describe, it, expect, vi } from 'vitest';
import { retrySizeUntilMeasured } from '../../src/runtime/rendering/canvas2DSizing';

/** A controllable rAF: scheduled callbacks queue and only run when step() is called. */
function fakeScheduler() {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    scheduleFrame: (cb: () => void) => { const id = next++; queue.set(id, cb); return id; },
    cancelFrame: (id: number) => { queue.delete(id); },
    /** Run all currently-queued callbacks once (a single "frame"). */
    step() {
      const cbs = [...queue.values()];
      queue.clear();
      cbs.forEach(cb => cb());
    },
    pending: () => queue.size,
  };
}

describe('retrySizeUntilMeasured (F10)', () => {
  it('applies the size immediately when the first measure is non-zero (no retry)', () => {
    const sched = fakeScheduler();
    const applySize = vi.fn();
    const warn = vi.fn();
    retrySizeUntilMeasured({
      measure: () => ({ w: 320, h: 480 }),
      applySize, warn,
      scheduleFrame: sched.scheduleFrame, cancelFrame: sched.cancelFrame,
    });
    expect(applySize).toHaveBeenCalledExactlyOnceWith(320, 480);
    expect(sched.pending()).toBe(0);   // nothing scheduled
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries until the box becomes non-zero, then applies once (mid-layout 0×0 window)', () => {
    const sched = fakeScheduler();
    const applySize = vi.fn();
    const warn = vi.fn();
    // 0×0 for the first two attempts, then a real box.
    const sizes = [{ w: 0, h: 0 }, { w: 0, h: 0 }, { w: 100, h: 200 }];
    let i = 0;
    retrySizeUntilMeasured({
      measure: () => sizes[Math.min(i++, sizes.length - 1)],
      applySize, warn,
      scheduleFrame: sched.scheduleFrame, cancelFrame: sched.cancelFrame,
    });

    expect(applySize).not.toHaveBeenCalled();   // first attempt: 0×0
    expect(sched.pending()).toBe(1);
    sched.step();                                // second attempt: still 0×0
    expect(applySize).not.toHaveBeenCalled();
    sched.step();                                // third attempt: real box
    expect(applySize).toHaveBeenCalledExactlyOnceWith(100, 200);
    expect(sched.pending()).toBe(0);             // stopped retrying
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once and stops after maxFrames of persistent 0×0 (hidden ancestor)', () => {
    const sched = fakeScheduler();
    const applySize = vi.fn();
    const warn = vi.fn();
    retrySizeUntilMeasured({
      measure: () => ({ w: 0, h: 0 }),         // never sizes
      applySize, warn,
      scheduleFrame: sched.scheduleFrame, cancelFrame: sched.cancelFrame,
      maxFrames: 3,
    });
    // attempt#1 (frames→1) schedules; step → #2 (frames→2) schedules; step → #3 (frames→3) warns.
    expect(sched.pending()).toBe(1);
    sched.step();
    expect(warn).not.toHaveBeenCalled();
    expect(sched.pending()).toBe(1);
    sched.step();
    expect(warn).toHaveBeenCalledExactlyOnceWith(3);
    expect(applySize).not.toHaveBeenCalled();
    expect(sched.pending()).toBe(0);             // gave up — no more frames scheduled
  });

  it('cancel() stops a pending retry — a queued frame never applies or warns', () => {
    const sched = fakeScheduler();
    const applySize = vi.fn();
    const warn = vi.fn();
    const cancel = retrySizeUntilMeasured({
      measure: () => ({ w: 0, h: 0 }),
      applySize, warn,
      scheduleFrame: sched.scheduleFrame, cancelFrame: sched.cancelFrame,
      maxFrames: 10,
    });
    expect(sched.pending()).toBe(1);
    cancel();                                    // unmount before the box ever sizes
    expect(sched.pending()).toBe(0);             // cancelFrame dropped the queued callback
    sched.step();                                // even if something fired, the guard bails
    expect(applySize).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
