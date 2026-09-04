/** core/gpuContextTracking.ts — Phase 3 of #590 (docs/plans/ios-rendering-update-wedge.md). The
 *  shared live GL/GPU-context counter every context-creating site (`canvas2DPool`, `scene3DSync`'s
 *  `makeWebGPURenderer`, `rampWorkloadGL`, `deviceCaps`) now calls into. This file exercises the
 *  module in isolation, pure; the integration tests proving each REAL call site is actually wired
 *  live in that site's own test file (`canvas2DPool.test.ts`, `scene3DSync.test.ts`,
 *  `rampProbeRunner.test.ts`, `deviceCaps.test.ts`). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  noteGpuContextCreated, noteGpuContextDestroyed, liveGpuContextCount,
  totalGpuContextsCreated, totalGpuContextsDestroyed,
  __resetGpuContextTrackingForTest,
} from '../../src/runtime/core/gpuContextTracking';

beforeEach(() => {
  __resetGpuContextTrackingForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetGpuContextTrackingForTest();
});

describe('gpuContextTracking', () => {
  it('starts at zero', () => {
    expect(liveGpuContextCount()).toBe(0);
  });

  it('increments on create, decrements on destroy, in step', () => {
    noteGpuContextCreated();
    expect(liveGpuContextCount()).toBe(1);
    noteGpuContextCreated();
    expect(liveGpuContextCount()).toBe(2);
    noteGpuContextDestroyed();
    expect(liveGpuContextCount()).toBe(1);
    noteGpuContextDestroyed();
    expect(liveGpuContextCount()).toBe(0);
  });

  it('floors at zero — a stray extra destroy() cannot go negative', () => {
    noteGpuContextCreated();
    noteGpuContextDestroyed();
    noteGpuContextDestroyed(); // one too many
    expect(liveGpuContextCount()).toBe(0);
    // And the counter still tracks correctly afterward — a naive `count--` with no floor would
    // leave this at -1 + 1 = 0 too, which is why the NEXT create is the real discriminator.
    noteGpuContextCreated();
    expect(liveGpuContextCount()).toBe(1);
  });

  it('warns exactly once after crossing the soft limit (8), not on every crossing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 12; i++) noteGpuContextCreated();
    expect(liveGpuContextCount()).toBe(12);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('live GL/GPU contexts');

    // Dropping below the limit and climbing back over it must NOT re-warn (deliberate — see the
    // module's own doc comment: a session hovering at the limit would otherwise be re-spammed).
    for (let i = 0; i < 12; i++) noteGpuContextDestroyed();
    for (let i = 0; i < 12; i++) noteGpuContextCreated();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn at or under the soft limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 8; i++) noteGpuContextCreated();
    expect(warn).not.toHaveBeenCalled();
  });

  it('__resetGpuContextTrackingForTest clears both the count and the warn-once latch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 12; i++) noteGpuContextCreated();
    expect(warn).toHaveBeenCalledTimes(1);

    __resetGpuContextTrackingForTest();
    expect(liveGpuContextCount()).toBe(0);

    for (let i = 0; i < 12; i++) noteGpuContextCreated();
    expect(warn).toHaveBeenCalledTimes(2); // the latch was cleared too — a fresh session can warn again
  });

  // Second device measurement (docs/plans/ios-rendering-update-wedge.md): fps and every live
  // JS-visible count read FLAT for 16 minutes up to a confirmed jetsam — a live snapshot cannot
  // see create/destroy CHURN. These cumulative totals exist so churn is visible even when the
  // live gauge holds steady.
  describe('cumulative totals (a live snapshot cannot see churn)', () => {
    it('start at zero', () => {
      expect(totalGpuContextsCreated()).toBe(0);
      expect(totalGpuContextsDestroyed()).toBe(0);
    });

    it('climb monotonically and independently of the live count', () => {
      noteGpuContextCreated();
      noteGpuContextCreated();
      noteGpuContextDestroyed();
      expect(liveGpuContextCount()).toBe(1);
      expect(totalGpuContextsCreated()).toBe(2);
      expect(totalGpuContextsDestroyed()).toBe(1);
    });

    it('reveal repeated create/destroy CHURN a flat live count hides — the whole point', () => {
      // A live count pinned at 1 the entire time — exactly the flat-fps, flat-count device
      // measurement — while 50 contexts have actually cycled through underneath it. Each loop
      // iteration is one create + one destroy: net zero on the LIVE count, +1/+1 on the totals.
      noteGpuContextCreated(); // baseline
      expect(liveGpuContextCount()).toBe(1);
      for (let i = 0; i < 50; i++) {
        noteGpuContextCreated();
        noteGpuContextDestroyed();
        expect(liveGpuContextCount()).toBe(1); // pinned — reads as "nothing is happening"
      }
      expect(totalGpuContextsCreated()).toBe(51); // but 51 contexts were actually created
      expect(totalGpuContextsDestroyed()).toBe(50);
    });

    it('the invariant `created - destroyed === live` always holds — a mutation that inflates one without the other breaks it', () => {
      noteGpuContextCreated();
      noteGpuContextCreated();
      noteGpuContextCreated();
      noteGpuContextDestroyed();
      noteGpuContextDestroyed();
      noteGpuContextDestroyed();
      noteGpuContextDestroyed(); // one too many — must not inflate totalDestroyed past totalCreated
      expect(totalGpuContextsCreated() - totalGpuContextsDestroyed()).toBe(liveGpuContextCount());
      expect(totalGpuContextsDestroyed()).toBe(3); // NOT 4 — the stray call was a no-op, both sides
    });

    it('__resetGpuContextTrackingForTest clears the cumulative totals too', () => {
      noteGpuContextCreated();
      noteGpuContextDestroyed();
      __resetGpuContextTrackingForTest();
      expect(totalGpuContextsCreated()).toBe(0);
      expect(totalGpuContextsDestroyed()).toBe(0);
    });
  });
});
