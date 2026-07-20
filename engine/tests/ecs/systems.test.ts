/** ECS system unit tests — timeSystem, rotate3DSystem, transformPropagationSystem. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { timeSystem, resetTimeBaseline, rotate3DSystem, Rotate3D } from '@modoki/engine/runtime';
import { transformPropagationSystem, worldTransforms, deactivatedEntities } from '@modoki/engine/three';
import { Transform, Time, Paused, EntityAttributes } from '@modoki/engine/runtime';

// Each test creates a local world — must destroy it afterwards to stay within koota's 16-world limit.
let w: ReturnType<typeof createWorld>;

afterEach(() => {
  w?.destroy();
  vi.restoreAllMocks();
});

// timeSystem keeps a module-level `lastTime` (seeded from performance.now() at
// import) that persists ACROSS tests — there's no reset hook. A test that left
// `lastTime` in the past would make the next test's first delta negative. So
// every timeSystem/rotate3D test stubs performance.now from a MONOTONICALLY
// INCREASING cursor: each test starts strictly after the previous test's last
// `lastTime`, so the first tick is always a large positive delta (clamped to
// MAX_DELTA). Tests needing a precise sub-cap delta take one "sync" tick to pin
// `lastTime` to the stubbed clock, then advance a known amount.
let _clockCursor = 10_000_000;
function stubClock() {
  _clockCursor += 1_000_000; // always ahead of any prior test's lastTime
  let now = _clockCursor;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    get now() { return now; },
    advanceMs(ms: number) { now += ms; _clockCursor = now; },
  };
}

describe('timeSystem', () => {
  it('updates time on each tick', () => {
    stubClock();
    w = createWorld();
    w.spawn(Time());

    timeSystem(w);

    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });
    expect(time).toBeDefined();
    expect(time.frame).toBe(1);
    expect(time.delta).toBeGreaterThan(0);
  });

  it('accumulates elapsed and frame count over multiple ticks', () => {
    const clock = stubClock();
    w = createWorld();
    w.spawn(Time());

    timeSystem(w);
    clock.advanceMs(16); timeSystem(w);
    clock.advanceMs(16); timeSystem(w);

    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });
    expect(time.frame).toBe(3);
  });

  it('clamps delta to exactly MAX_DELTA (1/30) on a long frame', () => {
    const clock = stubClock();
    w = createWorld();
    w.spawn(Time());

    // Sync tick pins lastTime to the stubbed clock (its own delta is irrelevant).
    timeSystem(w);
    // A 500ms frame (tab throttled / GC pause) must clamp, not teleport.
    clock.advanceMs(500);
    timeSystem(w);

    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });
    expect(time.delta).toBe(1 / 30); // clamped exactly, not 0.5
  });

  it('reports the true (sub-cap) delta on a normal frame', () => {
    const clock = stubClock();
    w = createWorld();
    w.spawn(Time());

    timeSystem(w);       // sync tick
    clock.advanceMs(16); // ~60fps frame
    timeSystem(w);

    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });
    expect(time.delta).toBeCloseTo(0.016, 6); // unclamped — below MAX_DELTA
  });

  it('initializes smoothedDelta to delta on first frame', () => {
    const clock = stubClock();
    // Reset the module-level smoothing/clock baseline so the seed branch
    // (smoothedCadence===0 && frame===0) actually fires this tick — otherwise a
    // prior test's residual EMA state sends it down the blend path.
    resetTimeBaseline();
    w = createWorld();
    w.spawn(Time());

    clock.advanceMs(16); // a clean sub-cap first frame
    timeSystem(w);
    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });

    expect(time.smoothedDelta).toBe(time.delta); // seeded := delta
    expect(time.smoothedElapsed).toBe(time.delta);
  });

  it('blends smoothedDelta via EMA: smoothed = delta*0.15 + prev*0.85 (F6: clamped delta)', () => {
    const clock = stubClock();
    resetTimeBaseline(); // deterministic seed (smoothedCadence 0, lastTime synced)
    w = createWorld();
    w.spawn(Time());

    // Seed tick: a clean 20ms frame seeds smoothedDelta := delta = 0.020.
    clock.advanceMs(20);
    timeSystem(w);
    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });
    const seeded = time.smoothedDelta;
    expect(seeded).toBeCloseTo(0.020, 8);

    // Next tick: a clean 10ms frame. The EMA feeds the CLAMPED `delta` (F6), here
    // == raw since it's below MAX_DELTA: smoothed = 0.010*0.15 + seeded*0.85.
    clock.advanceMs(10);
    timeSystem(w);
    w.query(Time).updateEach(([t]) => { time = t; });
    const expected = 0.010 * 0.15 + seeded * 0.85;
    expect(time.smoothedDelta).toBeCloseTo(expected, 8);
  });

  it('smoothedDelta converges monotonically toward a constant frame delta', () => {
    // Replaces a former flaky test that asserted a false invariant
    // (smoothedElapsed ≤ elapsed) with a fudge factor. With constant frames the
    // EMA error decays geometrically — a real, deterministic property.
    const clock = stubClock();
    w = createWorld();
    w.spawn(Time());

    const FRAME_MS = 1000 / 60; // 16.67ms
    const FRAME_S = FRAME_MS / 1000;

    timeSystem(w); // seed (smoothedDelta := MAX_DELTA, larger than FRAME_S)

    let prevErr = Infinity;
    let time: any;
    for (let i = 0; i < 40; i++) {
      clock.advanceMs(FRAME_MS);
      timeSystem(w);
      w.query(Time).updateEach(([t]) => { time = t; });
      const err = Math.abs(time.smoothedDelta - FRAME_S);
      expect(err).toBeLessThanOrEqual(prevErr + 1e-12); // non-increasing → converging
      prevErr = err;
    }
    expect(prevErr).toBeLessThan(1e-4); // settled onto the true frame time
  });

  it('ignores the per-entity Paused tag — global time is gated by playState, not this trait', () => {
    // Regression for ecs-core F1: the old `entity.has(Paused)` branch in timeSystem was
    // dead/misleading (zero producers; the pipeline skips the whole TIME tier when paused
    // via playState, so the branch could never run). It was removed — tagging the Time
    // entity Paused must NOT freeze global time. (rotate3D/animation still honor the tag.)
    const clock = stubClock();
    w = createWorld();
    const ent = w.spawn(Time());

    timeSystem(w);
    clock.advanceMs(16);
    timeSystem(w);
    let time: any;
    w.query(Time).updateEach(([t]) => { time = t; });
    const elapsedBefore = time.elapsed;
    const frameBefore = time.frame;

    ent.add(Paused);
    clock.advanceMs(16);
    timeSystem(w);
    w.query(Time).updateEach(([t]) => { time = t; });
    expect(time.frame).toBe(frameBefore + 1);          // keeps counting despite the tag
    expect(time.elapsed).toBeGreaterThan(elapsedBefore); // keeps advancing
    expect(time.delta).toBeCloseTo(0.016, 6);
  });
});

describe('rotate3DSystem', () => {
  it('rotates entity around specified axis', () => {
    stubClock();
    w = createWorld();
    w.spawn(Time());
    const entity = w.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Rotate3D({ axis: 'z', speed: Math.PI }),
    );

    timeSystem(w);
    rotate3DSystem(w);

    let tf: any;
    w.query(Transform).updateEach(([t], e) => {
      if (e.id() === entity.id()) tf = t;
    });

    expect(tf.rz).toBeGreaterThan(0);
  });

  it('does not rotate paused entities', () => {
    stubClock();
    w = createWorld();
    w.spawn(Time());
    const entity = w.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Rotate3D({ axis: 'y', speed: 10 }),
      Paused(),
    );

    timeSystem(w);

    rotate3DSystem(w);

    let tf: any;
    w.query(Transform).updateEach(([t], e) => {
      if (e.id() === entity.id()) tf = t;
    });

    expect(tf.ry).toBe(0);
  });
});

describe('transformPropagationSystem', () => {
  it('computes world transform for root entity (world === local)', () => {
    w = createWorld();
    const entity = w.spawn(Transform({ x: 5, y: 3, z: 2, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }));

    transformPropagationSystem(w);

    const wt = worldTransforms.get(entity.id());
    expect(wt).toBeDefined();
    expect(wt?.x).toBe(5);
    expect(wt?.y).toBe(3);
    expect(wt?.z).toBe(2);
  });

  it('composes a child as parent.world × child.local (translation)', () => {
    w = createWorld();
    const parent = w.spawn(Transform({ x: 10, y: 0, z: 0 }), EntityAttributes({ parentId: 0 }));
    const child = w.spawn(Transform({ x: 5, y: 0, z: 0 }), EntityAttributes({ parentId: parent.id() }));

    transformPropagationSystem(w);

    expect(worldTransforms.get(parent.id())?.x).toBe(10);     // root: local
    expect(worldTransforms.get(child.id())?.x).toBeCloseTo(15, 6); // 10 + 5
    expect(worldTransforms.get(child.id())?.y).toBeCloseTo(0, 6);
  });

  it('applies parent scale to the child offset and inherits scale', () => {
    w = createWorld();
    const parent = w.spawn(Transform({ x: 10, y: 0, z: 0, sx: 2, sy: 2, sz: 2 }), EntityAttributes({ parentId: 0 }));
    const child = w.spawn(Transform({ x: 3, y: 0, z: 0 }), EntityAttributes({ parentId: parent.id() }));

    transformPropagationSystem(w);

    const cw = worldTransforms.get(child.id());
    expect(cw?.x).toBeCloseTo(16, 6); // 10 + 2*3 — parent scale stretches the offset
    expect(cw?.sx).toBeCloseTo(2, 6); // inherits parent scale
  });

  it('propagates a grandchild through the full chain', () => {
    w = createWorld();
    const a = w.spawn(Transform({ x: 1 }), EntityAttributes({ parentId: 0 }));
    const b = w.spawn(Transform({ x: 2 }), EntityAttributes({ parentId: a.id() }));
    const c = w.spawn(Transform({ x: 4 }), EntityAttributes({ parentId: b.id() }));

    transformPropagationSystem(w);

    expect(worldTransforms.get(c.id())?.x).toBeCloseTo(7, 6); // 1 + 2 + 4
  });

  it('marks inactive entities and their descendants as deactivated (transitive)', () => {
    w = createWorld();
    const active = w.spawn(Transform({ x: 0 }), EntityAttributes({ isActive: true, parentId: 0 }));
    const inactiveParent = w.spawn(Transform({ x: 0 }), EntityAttributes({ isActive: false, parentId: 0 }));
    const childOfInactive = w.spawn(Transform({ x: 0 }), EntityAttributes({ isActive: true, parentId: inactiveParent.id() }));

    transformPropagationSystem(w);

    expect(deactivatedEntities.has(active.id())).toBe(false);
    expect(deactivatedEntities.has(inactiveParent.id())).toBe(true);  // self-inactive
    expect(deactivatedEntities.has(childOfInactive.id())).toBe(true); // inherits parent's inactive state
  });
});
