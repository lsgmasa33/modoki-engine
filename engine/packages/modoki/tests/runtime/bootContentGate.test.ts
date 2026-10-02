/** `bootContentGate` — the boot reveal's "every 2D surface and visible UI image has arrived" wire
 *  (#1928), the 2D/UI twin of `scenePaintSignal` (#334).
 *
 *  Every way this is wrong is silent: a wait that resolves early is the bug itself (the splash
 *  comes down over a dark page and the art pops in), a token that never settles holds every boot to
 *  the ceiling, and a stale `done`/`disarm` from an earlier boot corrupts the next one. None of that
 *  shows in a render, so it is pinned here. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  armBootContent, trackBootContent, waitForBootContent, pendingBootContent, resetBootContentGate,
  BOOT_CONTENT_MAX_WAIT_MS, type BootContentResult,
} from '../../src/runtime/core/bootContentGate';
import { getBootTimeline, resetBootTimeline } from '../../src/runtime/core/bootTimeline';

/** Has the promise settled yet? Drains the microtask queue, without advancing fake time. */
async function settled<T>(p: Promise<T>): Promise<{ done: boolean; value?: T }> {
  let out: { done: boolean; value?: T } = { done: false };
  p.then((value) => { out = { done: true, value }; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return out;
}

beforeEach(() => {
  resetBootContentGate();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetBootContentGate();
});

describe('bootContentGate', () => {
  it('registers nothing outside a boot — the editor and every post-reveal frame pay nothing', async () => {
    expect(trackBootContent('canvas2d:1')).toBeNull();
    expect(pendingBootContent()).toEqual([]);
    await expect(waitForBootContent()).resolves.toEqual({ outcome: 'idle', pending: [] });
  });

  it('an armed boot with nothing registered resolves "idle" at once — a project with no 2D/UI surface waits for nothing', async () => {
    armBootContent();
    await expect(waitForBootContent()).resolves.toEqual({ outcome: 'idle', pending: [] });
  });

  it('holds until EVERY registered item is done, then resolves "ready"', async () => {
    armBootContent();
    const board = trackBootContent('canvas2d:7')!;
    const backdrop = trackBootContent('ui-image:reef.webp')!;
    const wait = waitForBootContent();

    board();
    expect((await settled(wait)).done).toBe(false);
    expect(pendingBootContent()).toEqual(['ui-image:reef.webp']);

    backdrop();
    expect(await settled(wait)).toEqual({ done: true, value: { outcome: 'ready', pending: [] } });
  });

  it('waits for content that registers AFTER the wait began — the set must empty, not just the first snapshot', async () => {
    armBootContent();
    const first = trackBootContent('canvas2d:1')!;
    const wait = waitForBootContent();
    const late = trackBootContent('ui-image:late.webp')!;
    first();
    expect((await settled(wait)).done).toBe(false);
    late();
    expect((await settled(wait)).value?.outcome).toBe('ready');
  });

  it('a hand-off in one synchronous run is not "everything arrived" — the Suspense fallback releases a moment before the mount registers', async () => {
    armBootContent();
    const fallback = trackBootContent('canvas2d:5')!;
    const wait = waitForBootContent();
    // React's passive-effect flush: the fallback's cleanup, then the real mount's effect.
    fallback();
    const mount = trackBootContent('canvas2d:5')!;
    expect((await settled(wait)).done).toBe(false);
    mount();
    expect((await settled(wait)).value?.outcome).toBe('ready');
  });

  it('done is idempotent — a producer calling it from both its success path and its cleanup cannot settle someone else', async () => {
    armBootContent();
    const a = trackBootContent('canvas2d:1')!;
    trackBootContent('canvas2d:2');
    const wait = waitForBootContent();
    a(); a(); a();
    expect((await settled(wait)).done).toBe(false);
    expect(pendingBootContent()).toEqual(['canvas2d:2']);
  });

  it('times out at the ceiling and names what never arrived — a dead surface delays the reveal, never prevents it', async () => {
    armBootContent();
    trackBootContent('canvas2d:9');
    const wait = waitForBootContent();
    vi.advanceTimersByTime(BOOT_CONTENT_MAX_WAIT_MS - 1);
    expect((await settled(wait)).done).toBe(false);
    vi.advanceTimersByTime(1);
    expect((await settled(wait)).value).toEqual({ outcome: 'timeout', pending: ['canvas2d:9'] });
  });

  it('the abort signal drops the waiter and its timer — a game change mid-boot', async () => {
    armBootContent();
    trackBootContent('canvas2d:1');
    const ctl = new AbortController();
    const wait = waitForBootContent({ signal: ctl.signal });
    ctl.abort();
    expect((await settled(wait)).value?.outcome).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing the window releases a parked waiter, and a done from the OLD window cannot touch the new one', async () => {
    const disarm1 = armBootContent();
    const stale = trackBootContent('canvas2d:old')!;
    const wait1 = waitForBootContent();
    disarm1();
    expect((await settled(wait1)).value?.outcome).toBe('cancelled');
    expect(pendingBootContent()).toEqual([]);

    armBootContent();
    trackBootContent('canvas2d:new');
    const wait2 = waitForBootContent();
    stale();   // the previous boot's surface finally drew
    expect((await settled(wait2)).done).toBe(false);
    expect(pendingBootContent()).toEqual(['canvas2d:new']);
  });

  it('a stale disarm (an old boot effect\'s cleanup) cannot close the NEWER window', () => {
    const disarm1 = armBootContent();
    armBootContent();
    disarm1();
    expect(trackBootContent('canvas2d:1')).not.toBeNull();
  });

  it('records a boot-content span per item, so the boot profiler shows what the reveal waited on', () => {
    resetBootTimeline();
    armBootContent();
    trackBootContent('canvas2d:42')!();
    const spans = getBootTimeline().spans.filter(s => s.name === 'boot-content');
    expect(spans.map(s => s.detail)).toEqual(['canvas2d:42']);
  });
});

// Type-level: the result carries the labels the caller logs on timeout.
const _typecheck: (r: BootContentResult) => string[] = (r) => r.pending;
void _typecheck;
