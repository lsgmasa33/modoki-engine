import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import {
  physics3DSystem, raycast3D, disposePhysics3D,
} from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

/** Static floor whose top surface sits at y=1 (box at y=0, half-Y extent 1), plus a unit
 *  dynamic box (half-extent 0.5) dropped from y=10. It rests with its center at y=1.5. */
function dropScene(t: TestWorld) {
  t.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));
  t.spawn(
    Transform({ x: 0, y: 0, z: 0 }),
    RigidBody3D({ bodyType: 'static' }),
    Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),
  );
  return t.spawn(
    Transform({ x: 0, y: 10, z: 0 }),
    RigidBody3D({ bodyType: 'dynamic' }),
    Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5, restitution: 0, friction: 0.5 }),
  );
}

describe('physics3DSystem — falling, resting, determinism', () => {
  it('a dynamic box falls under gravity and rests on a static floor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const box = dropScene(tw);
    tw.step(300);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, box);
    expect(tf.y).toBeCloseTo(1.5, 1);  // floor top (1) + box half-extent (0.5)
    // Box-on-box resting contact micro-slips a hair laterally — a few thousandths is expected.
    expect(tf.x).toBeCloseTo(0, 2);
    expect(tf.z).toBeCloseTo(0, 2);
  });

  it('does not move while timeScale is 0 (time-stop)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const box = dropScene(tw);
    tw.setTimeScale(0).step(120);
    expect(tw.trait<{ y: number }>(Transform, box).y).toBeCloseTo(10, 6);
  });

  it('reads back a dynamic body velocity (falling → negative vy)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const box = dropScene(tw);
    tw.step(10);
    const rb = tw.trait<{ vy: number }>(RigidBody3D, box);
    expect(rb.vy).toBeLessThan(0);  // falling in -Y
  });

  it('two independent runs produce bit-identical final state', () => {
    const run = () => {
      const t = createTestWorld({ systems: [PHYS] });
      const box = dropScene(t);
      t.step(200);
      const { x, y, z } = t.trait<{ x: number; y: number; z: number }>(Transform, box);
      disposePhysics3D(t.world); t.dispose();
      return { x, y, z };
    };
    expect(run()).toEqual(run());  // exact — Rapier f32 is reproducible
  });

  it('a static body holds its authored pose (no drift)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    const wall = tw.spawn(
      Transform({ x: 3, y: 4, z: -5 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 1, halfH: 1, halfD: 1 }),
    );
    tw.step(120);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, wall);
    expect(tf.x).toBeCloseTo(3, 6);
    expect(tf.y).toBeCloseTo(4, 6);
    expect(tf.z).toBeCloseTo(-5, 6);
  });
});

describe('physics3DSystem — raycast', () => {
  it('a downward ray hits the top of a static box and reports distance + normal', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    const floor = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),
    );
    tw.step(1);  // create the Rapier world/bodies (static → no motion)

    const hit = raycast3D(tw.world, 0, 10, 0, 0, -1, 0, { maxDistance: 100 });
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe(floor.id());
    expect(hit!.distance).toBeCloseTo(9, 1);  // from y=10 down to floor top y=1
    expect(hit!.ny).toBeCloseTo(1, 1);        // surface normal points up
  });

  it('returns null when the ray misses everything', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'sphere', radius: 1 }),
    );
    tw.step(1);
    // Cast well to the side, away from the unit sphere at the origin.
    expect(raycast3D(tw.world, 50, 10, 0, 0, -1, 0, { maxDistance: 100 })).toBeNull();
  });
});
