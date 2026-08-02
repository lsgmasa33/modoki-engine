/** resizeBus unit tests — the debug menu's force-resize registry (see resizeBus.ts's
 *  header for WHY it exists: it just re-invokes handlers that already re-read config). */

import { describe, it, expect, afterEach } from 'vitest';
import { onForceResize, forceResizeAllSurfaces } from '../../src/runtime/rendering/resizeBus';

describe('resizeBus', () => {
  // resizeBus's listener Set is module-level (that's the point — a global bus), so it
  // persists across tests in this file unless each test unsubscribes what it registered.
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const unsub of cleanups.splice(0)) unsub();
  });

  it('fires a registered callback on forceResizeAllSurfaces', () => {
    let calls = 0;
    cleanups.push(onForceResize(() => { calls += 1; }));
    forceResizeAllSurfaces();
    expect(calls).toBe(1);
  });

  it('stops firing once unsubscribed', () => {
    let calls = 0;
    const unsubscribe = onForceResize(() => { calls += 1; });
    unsubscribe();
    forceResizeAllSurfaces();
    expect(calls).toBe(0);
  });

  it('fires every registered listener, not just the first', () => {
    let a = 0;
    let b = 0;
    let c = 0;
    cleanups.push(onForceResize(() => { a += 1; }));
    cleanups.push(onForceResize(() => { b += 1; }));
    cleanups.push(onForceResize(() => { c += 1; }));
    forceResizeAllSurfaces();
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('a listener that unsubscribes ITSELF mid-notify still lets every other listener fire', () => {
    // Sanity check for the self-unsubscribe path specifically (distinct from the
    // "not-yet-fired sibling" case below): removing your OWN already-visited Set entry
    // mid-iteration is safe even under a naive live iteration (JS Set iterators only skip
    // an entry that is deleted BEFORE it is visited), so this doesn't by itself prove
    // forceResizeAllSurfaces snapshots the listener list — it proves self-unsubscribe
    // doesn't corrupt bookkeeping (double-fires, throws, or drops a sibling).
    let before = 0;
    let after = 0;
    let selfCalls = 0;
    cleanups.push(onForceResize(() => { before += 1; }));
    const selfUnsub = onForceResize(() => {
      selfCalls += 1;
      selfUnsub();
    });
    cleanups.push(onForceResize(() => { after += 1; }));

    forceResizeAllSurfaces();
    expect(before).toBe(1);
    expect(selfCalls).toBe(1);
    expect(after).toBe(1);

    // And the self-unsubscribed listener really is gone: a second broadcast doesn't call it again.
    forceResizeAllSurfaces();
    expect(before).toBe(2);
    expect(selfCalls).toBe(1);
    expect(after).toBe(2);
  });

  it('a listener that unsubscribes a NOT-YET-FIRED sibling mid-notify does not skip that sibling', () => {
    // This is the case that actually distinguishes "iterate a copy" from "iterate the live
    // Set". A Set iterator skips an entry that is removed BEFORE it's visited — so if
    // forceResizeAllSurfaces iterated `listeners` directly, the first listener unsubscribing
    // the third (not yet visited) would make the third never fire. Snapshotting via
    // `[...listeners]` up front means every listener registered at broadcast time still runs,
    // even one that an earlier listener unregisters mid-broadcast.
    let first = 0;
    let third = 0;
    let unsubThird: (() => void) | null = null;
    cleanups.push(onForceResize(() => {
      first += 1;
      unsubThird?.();
    }));
    unsubThird = onForceResize(() => { third += 1; });

    forceResizeAllSurfaces();
    expect(first).toBe(1);
    expect(third).toBe(1); // still fired this round despite being unsubscribed mid-broadcast

    // But it really is gone for the NEXT broadcast.
    forceResizeAllSurfaces();
    expect(first).toBe(2);
    expect(third).toBe(1);
  });
});
