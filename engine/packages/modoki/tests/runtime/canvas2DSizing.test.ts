/** canvas2DSizing unit tests — bounded initial-measure retry (F10) + the pure
 *  backing-size computation (#38, #55). */

import { describe, it, expect, vi } from 'vitest';
import { retrySizeUntilMeasured, computeBackingSize } from '../../src/runtime/rendering/canvas2DSizing';
import type { WebSizing } from '../../src/runtime/rendering/webCanvasSizing';
import { getRenderSettings, resetRenderSettings } from '../../src/runtime/rendering/renderSettings';

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

describe('computeBackingSize', () => {
  const MAX: WebSizing = { sizeMode: 'max', width: 1080, height: 1920 };

  it('multiplies the rect by devicePixelRatio when resolution is 0 (auto)', () => {
    expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 2, resolution: 0, web: null }))
      .toEqual({ w: 800, h: 600 });
  });

  it('a positive resolution OVERRIDES devicePixelRatio — it does not multiply with it', () => {
    // dpr 2 would give 800×600; resolution 3 must win outright, not compound (1200×900, not 2400×1800).
    expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 2, resolution: 3, web: null }))
      .toEqual({ w: 1200, h: 900 });
  });

  it('web:null bypasses sizeMode entirely — no clamp even at a size `max` would have shrunk', () => {
    // 2000×2000 at dpr 1 is far bigger than the 1080×1920 MAX target above, but web is
    // null (the editor-viewport case) so no clamp applies.
    expect(computeBackingSize({ rectWidth: 2000, rectHeight: 2000, devicePixelRatio: 1, resolution: 0, web: null }))
      .toEqual({ w: 2000, h: 2000 });
  });

  it('`max` clamps the POST-DPR buffer, aspect preserved (the #38 case: a retina phone viewport)', () => {
    // rect 393×852 (an iPhone-ish CSS viewport) × dpr 3 → device buffer 1179×2556.
    // Clamped to ≤1080×1920: height-limited (1920/2556 < 1080/1179), scale ≈0.751174.
    // width = round(1179 × 1920/2556) = 886, height = 1920 exactly.
    expect(computeBackingSize({ rectWidth: 393, rectHeight: 852, devicePixelRatio: 3, resolution: 0, web: MAX }))
      .toEqual({ w: 886, h: 1920 });
  });

  it('`free` passes the post-DPR buffer through unclamped', () => {
    const web: WebSizing = { sizeMode: 'free', width: 1080, height: 1920 };
    expect(computeBackingSize({ rectWidth: 2000, rectHeight: 2000, devicePixelRatio: 3, resolution: 0, web }))
      .toEqual({ w: 6000, h: 6000 });
  });

  it('`fixed` passes the post-DPR buffer through unclamped (its CSS size is already the render size)', () => {
    const web: WebSizing = { sizeMode: 'fixed', width: 1080, height: 1920 };
    expect(computeBackingSize({ rectWidth: 2000, rectHeight: 2000, devicePixelRatio: 3, resolution: 0, web }))
      .toEqual({ w: 6000, h: 6000 });
  });

  it('a 0×0 rect returns 0×0 even under `max` — must NOT clamp to 1×1 (would defeat the F10 retry)', () => {
    expect(computeBackingSize({ rectWidth: 0, rectHeight: 852, devicePixelRatio: 3, resolution: 0, web: MAX }))
      .toEqual({ w: 0, h: 0 });
    expect(computeBackingSize({ rectWidth: 393, rectHeight: 0, devicePixelRatio: 3, resolution: 0, web: MAX }))
      .toEqual({ w: 0, h: 0 });
  });

  it('the MAX_BACKING GPU cap scales BOTH axes uniformly by the longer axis, preserving aspect', () => {
    // rect 5000×100 at dpr 2 → device buffer 10000×200. Longest (10000) exceeds the
    // default 8192 cap → scale by 8192/10000 = 0.8192 on BOTH axes: 10000→8192, 200→163.84→164.
    expect(computeBackingSize({ rectWidth: 5000, rectHeight: 100, devicePixelRatio: 2, resolution: 0, web: null }))
      .toEqual({ w: 8192, h: 164 });
  });

  // #55 — pixi.pixelRatioCap: the AUTO-path counterpart of three.pixelRatioCap, so the 2D
  // and 3D render layers agree on DPR by default instead of the 2D layer running raw/sharper.
  describe('pixelRatioCap (#55)', () => {
    it('binds on the auto path: dpr 3 + cap 2 → backing is rect × 2, not rect × 3', () => {
      expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 3, resolution: 0, pixelRatioCap: 2, web: null }))
        .toEqual({ w: 800, h: 600 });
    });

    it('a pinned resolution is NEVER capped: resolution 3 + cap 2 → backing is rect × 3', () => {
      // The pin is an explicit "I want exactly N" — capping it would make the pin a lie.
      expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 3, resolution: 3, pixelRatioCap: 2, web: null }))
        .toEqual({ w: 1200, h: 900 });
    });

    it('a cap ABOVE the dpr is a no-op: dpr 1 + cap 2 → rect × 1', () => {
      expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 1, resolution: 0, pixelRatioCap: 2, web: null }))
        .toEqual({ w: 400, h: 300 });
    });

    it('omitting pixelRatioCap leaves behaviour exactly as before (uncapped)', () => {
      expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 3, resolution: 0, web: null }))
        .toEqual({ w: 1200, h: 900 });
    });

    it('composes with the `max` sizeMode clamp: cap applies first, then the sizeMode clamp', () => {
      // rect 393×852 at dpr 3, capped to 2 → device buffer 786×1704 (NOT the dpr-3 1179×2556
      // from the #38 test above). That buffer is already ≤ MAX (1080×1920) on both axes, so
      // the `max` clamp is a no-op here — proving the cap, not the clamp, produced this size.
      expect(computeBackingSize({ rectWidth: 393, rectHeight: 852, devicePixelRatio: 3, resolution: 0, pixelRatioCap: 2, web: MAX }))
        .toEqual({ w: 786, h: 1704 });
    });

    /** A cap of 0 is not hypothetical: `resolution`, the field directly ABOVE this one in
     *  Project Settings, uses 0 for "auto", and nothing validates numeric config (#39). Taken
     *  literally it produces a 0×0 backing — which the zero guard hands to
     *  retrySizeUntilMeasured as "not laid out yet", so the canvas retries every frame and
     *  then blames a display:none ancestor. A negative cap produced a NEGATIVE backing. */
    it('treats a cap of 0 as UNCAPPED, not as ratio 0 (which would zero the buffer)', () => {
      expect(computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 3, resolution: 0, pixelRatioCap: 0, web: null }))
        .toEqual({ w: 1200, h: 900 });
    });

    it('treats a NEGATIVE cap as uncapped too — never a negative backing size', () => {
      const { w, h } = computeBackingSize({ rectWidth: 400, rectHeight: 300, devicePixelRatio: 3, resolution: 0, pixelRatioCap: -1, web: null });
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect({ w, h }).toEqual({ w: 1200, h: 900 });
    });
  });
});

// Guards issue #55: the two render layers must not silently drift apart on their DPR-cap
// defaults. Lives here (not a dedicated renderSettings test file — none exists yet).
describe('pixi/three pixelRatioCap defaults agree (#55)', () => {
  it('DEFAULTS.pixi.pixelRatioCap === DEFAULTS.three.pixelRatioCap', () => {
    resetRenderSettings();
    const settings = getRenderSettings();
    expect(settings.pixi.pixelRatioCap).toBe(settings.three.pixelRatioCap);
  });
});
