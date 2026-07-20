/** Deterministic stepping (Phase 1 — verification harness).
 *
 *  Proves `stepSimulation` advances a world by an exact, reproducible amount with
 *  no wall-clock involved — the foundation the headless playtest harness builds
 *  on. Registers `timeSystem` in the pipeline, steps, and asserts the Time trait
 *  advanced identically across repeated runs. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { Time } from '../../src/runtime/traits/Time';
import { timeSystem } from '../../src/runtime/systems/timeSystem';
import { getTime } from '../../src/runtime/systems/getTime';
import { stepSimulation } from '../../src/runtime/systems/stepSimulation';
import { registerSystem, unregisterSystem, SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { restoreRealClock, isManualClock } from '../../src/runtime/systems/clock';
import { getPlayState, setPlayState } from '../../src/runtime/systems/playState';
import { emit, journalEvents, clearJournal } from '../../src/runtime/systems/journal';

function runStepped(ticks: number, dt: number) {
  const world = createWorld();
  world.spawn(Time);
  registerSystem('time', timeSystem, SYSTEM_PRIORITY.TIME);
  try {
    stepSimulation(world, ticks, { dt });
    const t = getTime(world)!;
    return { elapsed: t.elapsed, frame: t.frame, delta: t.delta, smoothedDelta: t.smoothedDelta };
  } finally {
    unregisterSystem('time');
  }
}

afterEach(() => { restoreRealClock(); setPlayState('stopped'); });

describe('stepSimulation', () => {
  it('advances by an exact, fixed dt', () => {
    const r = runStepped(10, 1 / 60);
    expect(r.frame).toBe(10);
    expect(r.elapsed).toBeCloseTo(10 / 60, 6); // exactly 10 ticks of 1/60s
    expect(r.delta).toBeCloseTo(1 / 60, 6);
  });

  it('is reproducible — two identical runs produce identical results', () => {
    const a = runStepped(30, 1 / 60);
    const b = runStepped(30, 1 / 60);
    expect(a).toEqual(b); // byte-for-byte, not just close
  });

  it('converges smoothedDelta to delta under fixed dt (smoothing is identity)', () => {
    const r = runStepped(60, 1 / 60); // 1s — EMA fully warmed
    expect(r.smoothedDelta).toBeCloseTo(r.delta, 4);
  });

  it('restores the prior play-state and real clock afterward', () => {
    const before = getPlayState();
    runStepped(5, 1 / 60);
    expect(getPlayState()).toBe(before);
  });

  it('stamps journal events with the current frame (timeSystem → journal wiring)', () => {
    clearJournal();
    const world = createWorld();
    world.spawn(Time);
    registerSystem('time', timeSystem, SYSTEM_PRIORITY.TIME);
    // A game system that emits each frame, AFTER timeSystem has set the tick.
    registerSystem('emitter', () => emit('tick-marker'), SYSTEM_PRIORITY.GAME);
    try {
      stepSimulation(world, 3, { dt: 1 / 60 });
    } finally {
      unregisterSystem('emitter');
      unregisterSystem('time');
    }
    // Frames 1,2,3 — each emit is attributed to the frame timeSystem advanced to.
    // Journal is world-scoped (F1): stepSimulation makes `world` current during the
    // run, so the emits + tick-stamps land on it — read them back from that world.
    expect(journalEvents({ type: 'tick-marker' }, world).map((e) => e.tick)).toEqual([1, 2, 3]);
    clearJournal(world);
  });
});

// ── Restore semantics (Missing Test #5) ──
describe('stepSimulation — restore semantics', () => {
  function steppedWorld() {
    const world = createWorld();
    world.spawn(Time);
    registerSystem('time', timeSystem, SYSTEM_PRIORITY.TIME);
    return world;
  }

  it('restore:false leaves the manual clock installed for chaining', () => {
    const world = steppedWorld();
    try {
      stepSimulation(world, 3, { dt: 1 / 60, restore: false });
      expect(isManualClock()).toBe(true);   // clock stays manual → chainable
      expect(getPlayState()).toBe('playing'); // play-state not reverted either
    } finally {
      unregisterSystem('time');
    }
  });

  it('restore:true (default) returns to the real clock', () => {
    const world = steppedWorld();
    try {
      stepSimulation(world, 3, { dt: 1 / 60 });
      expect(isManualClock()).toBe(false);
    } finally {
      unregisterSystem('time');
    }
  });

  it('restores a prior PAUSED play-state, not just stopped', () => {
    const world = steppedWorld();
    setPlayState('paused');
    try {
      stepSimulation(world, 2, { dt: 1 / 60 });
      expect(getPlayState()).toBe('paused'); // forced to 'playing' during, reverted after
    } finally {
      unregisterSystem('time');
    }
  });

  it('restores a prior STOPPED play-state', () => {
    const world = steppedWorld();
    setPlayState('stopped');
    try {
      stepSimulation(world, 2, { dt: 1 / 60 });
      expect(getPlayState()).toBe('stopped');
    } finally {
      unregisterSystem('time');
    }
  });
});

// ── Headless-only guard (F4 / Missing Test #6) ──
describe('stepSimulation — headless-only guard', () => {
  // The guard is dev-gated (import.meta.env.DEV) — vitest runs as PROD by default,
  // so stub DEV on to exercise it.
  it('warns when invoked while a live real-clock "playing" session is active', () => {
    vi.stubEnv('DEV', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = createWorld();
    world.spawn(Time);
    registerSystem('time', timeSystem, SYSTEM_PRIORITY.TIME);
    // Simulate a live editor: real clock + playing.
    restoreRealClock();
    setPlayState('playing');
    try {
      stepSimulation(world, 1, { dt: 1 / 60 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('headless-only'));
    } finally {
      unregisterSystem('time');
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('does NOT warn for normal headless use (stopped, real clock)', () => {
    vi.stubEnv('DEV', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = createWorld();
    world.spawn(Time);
    registerSystem('time', timeSystem, SYSTEM_PRIORITY.TIME);
    restoreRealClock();
    setPlayState('stopped');
    try {
      stepSimulation(world, 1, { dt: 1 / 60 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      unregisterSystem('time');
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('does NOT warn on the supported chain path (manual clock already active)', () => {
    vi.stubEnv('DEV', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = createWorld();
    world.spawn(Time);
    registerSystem('time', timeSystem, SYSTEM_PRIORITY.TIME);
    try {
      stepSimulation(world, 1, { dt: 1 / 60, restore: false }); // leaves manual clock + playing
      const callsAfterFirst = warn.mock.calls.length;
      stepSimulation(world, 1, { dt: 1 / 60, restore: false }); // chained — must not warn
      expect(warn.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      unregisterSystem('time');
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
