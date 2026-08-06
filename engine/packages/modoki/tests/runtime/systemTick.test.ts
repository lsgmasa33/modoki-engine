/** systemTick.ts unit tests — the flag `spawnEntity` (ecs/world.ts) reads to tag a runtime
 *  spawn `Transient` (#124). Verifies the flag's shape in isolation: off by default, on only
 *  for the duration of a tick, and — the case the try/finally in `runPipeline` exists for — off
 *  again after a system throws mid-tick. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getModule() {
  return import('../../src/runtime/core/systemTick');
}

describe('systemTick', () => {
  it('inSystemTick() is false before any tick', async () => {
    const { inSystemTick } = await getModule();
    expect(inSystemTick()).toBe(false);
  });

  it('inSystemTick() is true between begin and end, false after', async () => {
    const { beginSystemTick, endSystemTick, inSystemTick } = await getModule();
    beginSystemTick();
    expect(inSystemTick()).toBe(true);
    endSystemTick();
    expect(inSystemTick()).toBe(false);
  });

  it('is true while a real registered system is executing (via runPipeline)', async () => {
    const { registerSystem, runPipeline } = await import('../../src/runtime/core/pipeline');
    const { inSystemTick } = await getModule();
    let observedInside = false;
    registerSystem('probe', () => { observedInside = inSystemTick(); }, 100);

    expect(inSystemTick()).toBe(false); // not yet ticking
    runPipeline({} as any);
    expect(observedInside).toBe(true);
    expect(inSystemTick()).toBe(false); // tick ended
  });

  it('is false again after a system throws mid-tick (try/finally in runPipeline)', async () => {
    const { registerSystem, runPipeline } = await import('../../src/runtime/core/pipeline');
    const { inSystemTick } = await getModule();
    registerSystem('throwing', () => { throw new Error('boom'); }, 100);

    expect(() => runPipeline({} as any)).toThrow('boom');
    expect(inSystemTick()).toBe(false);
  });
});
