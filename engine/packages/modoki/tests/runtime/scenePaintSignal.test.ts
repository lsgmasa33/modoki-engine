/** `scenePaintSignal` — the DOM layer's "the renderer has actually painted this scene" wire (#334).
 *
 *  Sibling of `liveCompileGate.test.ts`, and for the same reason: this is async lifecycle code
 *  whose ways of being wrong are all silent. A promise that never resolves leaves the loading
 *  overlay up forever; one that resolves too early puts the game's HUD over an unpainted canvas —
 *  the bug it exists to fix; a waiter left parked across a game change leaks a timer and a closure.
 *  None of those show up in a render, so they are pinned here. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  armScenePaint, markScenePainted, abandonScenePaint, waitForScenePaint,
  isScenePaintPending, resetScenePaintSignal, SCENE_PAINT_MAX_WAIT_MS,
} from '../../src/runtime/rendering/scenePaintSignal';

beforeEach(() => {
  resetScenePaintSignal();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetScenePaintSignal();
});

describe('scenePaintSignal', () => {
  it('resolves "idle" when nothing has been armed — a project whose scene never swapped', async () => {
    expect(isScenePaintPending()).toBe(false);
    await expect(waitForScenePaint()).resolves.toBe('idle');
  });

  it('resolves "idle" immediately when the paint already landed before the caller waited', async () => {
    // The ordinary fast case: a trivial compile means Scene3D submitted the new scene's first
    // frame while GameShell was still finishing `onSceneReady`. Nothing should be added here.
    armScenePaint();
    markScenePainted();
    expect(isScenePaintPending()).toBe(false);
    await expect(waitForScenePaint()).resolves.toBe('idle');
  });

  it('HOLDS until a frame is actually submitted — the #334 bug, stated as a test', async () => {
    armScenePaint();
    const settled = vi.fn();
    const wait = waitForScenePaint().then((o) => { settled(o); return o; });

    // Many frames pass with the compile still holding the submit. Two rAFs — the old heuristic —
    // would have hidden the overlay here.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(isScenePaintPending()).toBe(true);

    markScenePainted();
    await expect(wait).resolves.toBe('painted');
    expect(isScenePaintPending()).toBe(false);
  });

  it('releases EVERY parked waiter on one paint', async () => {
    armScenePaint();
    const a = waitForScenePaint();
    const b = waitForScenePaint();
    markScenePainted();
    await expect(Promise.all([a, b])).resolves.toEqual(['painted', 'painted']);
  });

  it('a SECOND swap re-arms, and a waiter parked across it waits for the newer scene', async () => {
    armScenePaint();
    const wait = waitForScenePaint();
    // An in-flight scene swap replaces the scene the waiter was waiting for. The overlay wants
    // whatever is going to be underneath it, which is now the newer scene — so it keeps waiting.
    armScenePaint();
    expect(isScenePaintPending()).toBe(true);
    markScenePainted();
    await expect(wait).resolves.toBe('painted');
  });

  it('a paint with nothing armed does not satisfy a LATER wait', async () => {
    // The previous scene is still painting every frame when a swap lands. Those frames must not
    // count as the new scene's first — the arm is what draws the line.
    markScenePainted();
    armScenePaint();
    const settled = vi.fn();
    void waitForScenePaint().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it('gives up at the ceiling rather than leaving the overlay up forever', async () => {
    armScenePaint();
    const wait = waitForScenePaint();
    vi.advanceTimersByTime(SCENE_PAINT_MAX_WAIT_MS - 1);
    const settled = vi.fn();
    void wait.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(wait).resolves.toBe('timeout');
  });

  it('a timeout does not disarm — a late frame still marks the scene painted', async () => {
    armScenePaint();
    const wait = waitForScenePaint({ timeoutMs: 10 });
    vi.advanceTimersByTime(10);
    await expect(wait).resolves.toBe('timeout');
    expect(isScenePaintPending()).toBe(true);
    markScenePainted();
    expect(isScenePaintPending()).toBe(false);
  });

  it('abandon releases waiters when the 3D surface can no longer paint', async () => {
    armScenePaint();
    const wait = waitForScenePaint();
    abandonScenePaint(); // renderer creation failed, or Scene3D unmounted
    await expect(wait).resolves.toBe('abandoned');
  });

  it('an abort resolves the waiter, clears its timer and removes its listener', async () => {
    armScenePaint();
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const wait = waitForScenePaint({ signal: ac.signal });
    ac.abort();
    await expect(wait).resolves.toBe('cancelled');

    // No timer left behind: nothing is pending, so running the clock out cannot resolve or throw.
    expect(vi.getTimerCount()).toBe(0);
    // …and a later paint must not try to resolve the abandoned waiter again.
    markScenePainted();
    expect(isScenePaintPending()).toBe(false);
    removeSpy.mockRestore();
  });

  it('an already-aborted signal resolves without ever parking a waiter', async () => {
    armScenePaint();
    const ac = new AbortController();
    ac.abort();
    await expect(waitForScenePaint({ signal: ac.signal })).resolves.toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolving one waiter does not skip its neighbour (the mutate-while-iterating trap)', async () => {
    armScenePaint();
    const outcomes: string[] = [];
    const all = Promise.all([
      waitForScenePaint().then(o => { outcomes.push(o); return o; }),
      waitForScenePaint().then(o => { outcomes.push(o); return o; }),
      waitForScenePaint().then(o => { outcomes.push(o); return o; }),
    ]);
    markScenePainted();
    await all;
    expect(outcomes).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
