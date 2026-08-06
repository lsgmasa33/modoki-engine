/** Profiler markers (profiler plan P1) — `runtime/core/profilerMarkers.ts`.
 *
 *  Timing is driven by the injectable clock (`setManualNow`/`advanceManual`), so every duration
 *  here is exact rather than approximate — no `toBeCloseTo`, no real elapsed time.
 *
 *  The tests that matter most are the ones about not being WRONG: a throwing scope must not
 *  corrupt the stack, an unbalanced end must not close somebody else's span, and a truncated
 *  tree must announce itself. A profiler that silently reports an incomplete tree as a complete
 *  one is worse than no profiler — it is the same failure class the whole plan exists to avoid. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setProfilerEnabled, isProfilerEnabled, beginProfilerSample, endProfilerSample, profileScope,
  beginProfilerFrame, endProfilerFrame, getMarkerTree, getMarkerFaults, getMarkerNodeCount,
  resetProfilerMarkers, MAX_MARKER_DEPTH, MAX_MARKER_NODES,
} from '../../src/runtime/core/profilerMarkers';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

/** Run a span of exactly `ms`. */
function span(name: string, ms: number, inner?: () => void) {
  beginProfilerSample(name);
  advanceManual(ms);
  inner?.();
  endProfilerSample();
}

/** Find a child by name in a sample tree. */
function child(node: { children: Array<{ name: string }> } | null, name: string) {
  return (node?.children ?? []).find((c) => c.name === name) as
    { name: string; totalMs: number; selfMs: number; calls: number; children: never[] } | undefined;
}

beforeEach(() => {
  resetProfilerMarkers();
  setProfilerEnabled(true);
  setManualNow(0);
  beginProfilerFrame();
});

afterEach(() => {
  setProfilerEnabled(false);
  resetProfilerMarkers();
  restoreRealClock();
});

describe('profilerMarkers — timing and nesting', () => {
  it('records a flat span', () => {
    span('ecs', 12);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'ecs')).toMatchObject({ totalMs: 12, selfMs: 12, calls: 1 });
  });

  it('derives self time as total minus children', () => {
    beginProfilerSample('frame-work');
    advanceManual(2);
    span('physics', 5);
    span('render', 8);
    advanceManual(3);
    endProfilerSample();
    endProfilerFrame();

    const work = child(getMarkerTree(), 'frame-work')!;
    expect(work.totalMs).toBe(18);   // 2 + 5 + 8 + 3
    expect(work.selfMs).toBe(5);     // 18 - (5 + 8)
  });

  it('accumulates repeated entries into ONE node with a call count', () => {
    span('system', 3);
    span('system', 4);
    span('system', 5);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'system')).toMatchObject({ totalMs: 12, calls: 3 });
  });

  it('keeps same-named spans under DIFFERENT parents separate', () => {
    beginProfilerSample('a'); span('sync', 3); endProfilerSample();
    beginProfilerSample('b'); span('sync', 7); endProfilerSample();
    endProfilerFrame();

    const tree = getMarkerTree();
    expect(child(child(tree, 'a') as never, 'sync')).toMatchObject({ totalMs: 3 });
    expect(child(child(tree, 'b') as never, 'sync')).toMatchObject({ totalMs: 7 });
  });

  it('handles recursion without double-counting the parent', () => {
    // Re-entering the same name nests a child under itself; the outer node's total covers the
    // whole call and its self time excludes the inner one.
    beginProfilerSample('recurse');
    advanceManual(1);
    span('recurse', 4);
    advanceManual(1);
    endProfilerSample();
    endProfilerFrame();

    const outer = child(getMarkerTree(), 'recurse')!;
    expect(outer.totalMs).toBe(6);
    expect(outer.selfMs).toBe(2);
  });
});

describe('profilerMarkers — frame lifecycle', () => {
  it('zeroes accumulators between frames but KEEPS the tree', () => {
    span('ecs', 10);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'ecs')!.totalMs).toBe(10);
    const nodesAfterFirstFrame = getMarkerNodeCount();

    beginProfilerFrame();
    span('ecs', 4);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'ecs')!.totalMs).toBe(4);
    // Reused, not rebuilt — this is what makes the steady state allocation-free.
    expect(getMarkerNodeCount()).toBe(nodesAfterFirstFrame);
  });

  it('omits nodes untouched this frame rather than showing rows of zeroes', () => {
    span('boot-only', 5);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'boot-only')).toBeDefined();

    beginProfilerFrame();
    span('steady', 2);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'boot-only')).toBeUndefined();
    expect(child(getMarkerTree(), 'steady')).toBeDefined();
  });

  it('a span left open at frame end is recorded as a fault, not silently closed', () => {
    beginProfilerSample('leaked');
    advanceManual(5);
    endProfilerFrame();
    expect(getMarkerFaults().unbalancedEnds).toBe(1);
    // ...and it does not leak into the next frame's stack.
    beginProfilerFrame();
    span('clean', 3);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'clean')).toMatchObject({ totalMs: 3, selfMs: 3 });
  });
});

describe('profilerMarkers — must not be WRONG', () => {
  it('a THROWING scope still closes its span', () => {
    // Reachable in normal operation: frameDriver catches callback throws, so a system that
    // throws mid-frame would otherwise leave the stack permanently unbalanced.
    beginProfilerSample('outer');
    advanceManual(1);
    expect(() => profileScope('boom', () => { advanceManual(2); throw new Error('x'); }))
      .toThrow('x');
    advanceManual(1);
    endProfilerSample();
    endProfilerFrame();

    const outer = child(getMarkerTree(), 'outer')!;
    expect(outer.totalMs).toBe(4);
    expect(outer.selfMs).toBe(2);
    expect(getMarkerFaults().unbalancedEnds).toBe(0);
  });

  it('an unbalanced end is counted and closes NOBODY', () => {
    endProfilerSample(); // nothing open
    expect(getMarkerFaults().unbalancedEnds).toBe(1);
    span('after', 3);
    endProfilerFrame();
    expect(child(getMarkerTree(), 'after')).toMatchObject({ totalMs: 3 });
  });

  it('a depth-truncated span unwinds correctly instead of closing another span', () => {
    // The subtle one: a span refused for depth STILL calls endProfilerSample(). If those pops were not
    // tracked separately they would close legitimate outer spans and every duration above the
    // cap would silently collapse.
    for (let i = 0; i < MAX_MARKER_DEPTH; i++) beginProfilerSample(`d${i}`);
    beginProfilerSample('too-deep');       // refused
    advanceManual(5);
    endProfilerSample();                   // must unwind the refusal, not close d31
    for (let i = MAX_MARKER_DEPTH - 1; i >= 0; i--) endProfilerSample();
    endProfilerFrame();

    const f = getMarkerFaults();
    expect(f.depthTruncated).toBe(1);
    expect(f.unbalancedEnds).toBe(0);
    expect(child(getMarkerTree(), 'd0')!.totalMs).toBe(5);
  });

  it('caps distinct nodes and REPORTS hitting the cap', () => {
    // The classic mistake this guards: a marker name built from per-entity data.
    for (let i = 0; i < MAX_MARKER_NODES + 20; i++) span(`enemy-${i}`, 0);
    endProfilerFrame();
    expect(getMarkerNodeCount()).toBeLessThanOrEqual(MAX_MARKER_NODES);
    expect(getMarkerFaults().nodeCapHit).toBeGreaterThan(0);
  });
});

describe('profilerMarkers — disabled', () => {
  it('records nothing and allocates no nodes when off', () => {
    resetProfilerMarkers();
    setProfilerEnabled(false);
    const before = getMarkerNodeCount();
    for (let i = 0; i < 100; i++) span(`s${i}`, 1);
    profileScope('scoped', () => advanceManual(1));
    expect(getMarkerNodeCount()).toBe(before);
    expect(getMarkerTree()).toBeNull();
  });

  it('profileScope still returns the value and propagates throws when off', () => {
    setProfilerEnabled(false);
    expect(profileScope('x', () => 42)).toBe(42);
    expect(() => profileScope('y', () => { throw new Error('z'); })).toThrow('z');
  });

  it('returns the value when ON too', () => {
    expect(profileScope('x', () => 42)).toBe(42);
  });

  it('toggling OFF mid-frame abandons open spans instead of carrying them', () => {
    beginProfilerSample('open');
    setProfilerEnabled(false);
    setProfilerEnabled(true);
    beginProfilerFrame();
    span('fresh', 2);
    endProfilerFrame();
    expect(getMarkerFaults().unbalancedEnds).toBe(0);
    expect(child(getMarkerTree(), 'fresh')).toMatchObject({ totalMs: 2 });
  });

  it('isProfilerEnabled reflects the flag', () => {
    setProfilerEnabled(false);
    expect(isProfilerEnabled()).toBe(false);
    setProfilerEnabled(true);
    expect(isProfilerEnabled()).toBe(true);
  });
});
