/** rotate3DSystem — spins entities with the Rotate3D trait by speed × visual delta.
 *
 *  Backfills the "no rotate3DSystem test at all" gap (ecs-core Missing Tests).
 *  Drives the REAL Time trait via getVisualDelta, so it also exercises the
 *  playState / timeScale gating the system inherits from the visual-delta accessor. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform, clampAngle } from '../../src/runtime/traits/Transform';
import { Paused } from '../../src/runtime/traits/Paused';
import { Rotate3D } from '../../src/runtime/traits/Rotate3D';
import { Time } from '../../src/runtime/traits/Time';
import { rotate3DSystem } from '../../src/runtime/systems/rotate3DSystem';
import { setPlayState } from '../../src/runtime/systems/playState';

// Visual delta = Time.smoothedDelta × timeScale, frozen to 0 unless the sim is
// running. Spawn a Time entity that represents a frame timeSystem already produced.
function spawnTime(world: ReturnType<typeof createWorld>, opts: Partial<{ smoothedDelta: number; timeScale: number }> = {}) {
  return world.spawn(Time({ smoothedDelta: opts.smoothedDelta ?? 0.5, delta: opts.smoothedDelta ?? 0.5, timeScale: opts.timeScale ?? 1 }));
}

beforeEach(() => setPlayState('playing')); // getVisualDelta gates on isSimRunning()
afterEach(() => setPlayState('playing'));

describe('rotate3DSystem', () => {
  it('advances the chosen axis by speed × visual delta', () => {
    const world = createWorld();
    spawnTime(world, { smoothedDelta: 0.5 });
    const ex = world.spawn(Transform({ rx: 0 }), Rotate3D({ axis: 'x', speed: 2 }));
    const ey = world.spawn(Transform({ ry: 0 }), Rotate3D({ axis: 'y', speed: 2 }));
    const ez = world.spawn(Transform({ rz: 0 }), Rotate3D({ axis: 'z', speed: 2 }));

    rotate3DSystem(world); // angle = speed(2) × dt(0.5) = 1 rad

    expect(ex.get(Transform)!.rx).toBeCloseTo(1, 6);
    expect(ey.get(Transform)!.ry).toBeCloseTo(1, 6);
    expect(ez.get(Transform)!.rz).toBeCloseTo(1, 6);
    // The non-spun axes stay put.
    expect(ex.get(Transform)!.ry).toBe(0);
    expect(ex.get(Transform)!.rz).toBe(0);
  });

  it('accumulates across frames and wraps via clampAngle', () => {
    const world = createWorld();
    spawnTime(world, { smoothedDelta: 1 });
    const e = world.spawn(Transform({ ry: 0 }), Rotate3D({ axis: 'y', speed: 5 }));

    let expected = 0;
    for (let i = 0; i < 4; i++) {
      rotate3DSystem(world); // +5 rad each frame
      expected = clampAngle(expected + 5);
    }
    // 20 rad raw wraps via clampAngle into (-2π, 2π]; assert the system matches.
    expect(e.get(Transform)!.ry).toBeCloseTo(expected, 6);
    expect(e.get(Transform)!.ry).toBeGreaterThan(-Math.PI * 2);
    expect(e.get(Transform)!.ry).toBeLessThanOrEqual(Math.PI * 2);
  });

  it('skips entities tagged Paused', () => {
    const world = createWorld();
    spawnTime(world, { smoothedDelta: 0.5 });
    const e = world.spawn(Transform({ ry: 0 }), Rotate3D({ axis: 'y', speed: 2 }));
    e.add(Paused);

    rotate3DSystem(world);
    expect(e.get(Transform)!.ry).toBe(0);
  });

  it('is a no-op when the sim is not running (visual delta 0)', () => {
    const world = createWorld();
    spawnTime(world, { smoothedDelta: 0.5 });
    const e = world.spawn(Transform({ ry: 0 }), Rotate3D({ axis: 'y', speed: 2 }));

    setPlayState('stopped');
    rotate3DSystem(world);
    expect(e.get(Transform)!.ry).toBe(0);
  });

  it('is a no-op when timeScale is 0 (time-stop)', () => {
    const world = createWorld();
    spawnTime(world, { smoothedDelta: 0.5, timeScale: 0 });
    const e = world.spawn(Transform({ ry: 0 }), Rotate3D({ axis: 'y', speed: 2 }));

    // smoothedDelta already carries the timeScale (timeSystem applies it AFTER
    // smoothing), so a time-stopped frame presents smoothedDelta 0 → no rotation.
    world.query(Time).updateEach(([t]: any) => { t.smoothedDelta = 0; });
    rotate3DSystem(world);
    expect(e.get(Transform)!.ry).toBe(0);
  });

  it('does nothing when there is no Time entity', () => {
    const world = createWorld();
    const e = world.spawn(Transform({ ry: 0 }), Rotate3D({ axis: 'y', speed: 2 }));
    rotate3DSystem(world); // getVisualDelta → 0 (no Time singleton)
    expect(e.get(Transform)!.ry).toBe(0);
  });
});
