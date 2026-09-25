/** The frame-loop HOLD the gameplay recorder takes (#1479): the rAF chain keeps firing (so the
 *  watchdog sees a live loop) but runs no callbacks, and `stepOneFrame()` still runs them — the
 *  external driver owns the cadence. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (() => 0) as any;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (() => {}) as any;
});
afterEach(() => { vi.restoreAllMocks(); });

async function setup() {
  let frame: ((t: number) => void) | null = null;
  let rafCalls = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { frame = cb as (t: number) => void; rafCalls++; return rafCalls; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  const d = await import('../../src/runtime/rendering/frameDriver');
  d.setTargetFPS(0);
  let runs = 0;
  d.registerFrameCallback('probe', () => runs++, 0);
  d.startFrameDriver();
  return { d, fire: (t: number) => frame!(t), runs: () => runs, rafCalls: () => rafCalls };
}

describe('frameDriver — held for an external driver', () => {
  it('a held loop runs no callbacks but keeps its rAF chain armed', async () => {
    const { d, fire, runs, rafCalls } = await setup();
    fire(0);
    expect(runs()).toBe(1);
    d.setFrameLoopHeld(true);
    expect(d.isFrameLoopHeld()).toBe(true);
    const before = rafCalls();
    fire(16); fire(32); fire(48);
    expect(runs()).toBe(1);
    // Still rescheduling itself every frame — the chain is alive, only its work is skipped.
    expect(rafCalls()).toBe(before + 3);
    d.stopFrameDriver();
  });

  it('stepOneFrame still runs the callbacks while held — the driver advances one frame at a time', async () => {
    const { d, fire, runs } = await setup();
    d.setFrameLoopHeld(true);
    fire(0);
    expect(runs()).toBe(0);
    d.stepOneFrame(); d.stepOneFrame();
    expect(runs()).toBe(2);
    d.stopFrameDriver();
  });

  it('releasing the hold gives the cadence back to rAF', async () => {
    const { d, fire, runs } = await setup();
    d.setFrameLoopHeld(true);
    fire(0);
    d.setFrameLoopHeld(false);
    fire(16);
    expect(runs()).toBe(1);
    d.stopFrameDriver();
  });
});
