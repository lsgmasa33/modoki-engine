/** Compound colliders — one RigidBody3D adopts child entities that carry a Collider3D but no
 *  RigidBody3D of their own, attaching each as an extra collider at the child's LOCAL Transform
 *  offset. A body with two "feet" offset left/right straddles a gap between two pedestals, while
 *  the same body with a single centered collider drops through. A collision on a CHILD collider
 *  resolves to the CHILD entity (event mapping). 3D is Y-up → gravity pulls toward −Y. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'p', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

/** Two static pedestals (tops at y≈−3.8) with a 2-unit gap between their inner edges (x∈[−1,1]). */
function spawnPedestals(): void {
  tw!.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
  for (const x of [-1.5, 1.5]) {
    tw!.spawn(Transform({ x, y: -4, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.2, halfD: 0.5, friction: 0.9 }));
  }
}

describe('physics3D — compound colliders', () => {
  it('a two-footed compound straddles a gap that swallows a single centered box', () => {
    tw = createTestWorld({ systems: [PHYS] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 1, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }), EntityAttributes({}));
    for (const fx of [-1.5, 1.5]) {
      tw.spawn(Transform({ x: fx, y: 0, z: 0 }),
        Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.2, halfD: 0.4, friction: 0.9 }),
        EntityAttributes({ parentId: body.id() }));
    }
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeGreaterThan(-4);   // rested on the feet
  });

  it('the same body with a single centered collider falls through the gap', () => {
    tw = createTestWorld({ systems: [PHYS] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 1, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.2, halfD: 0.4 }));
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeLessThan(-6);      // dropped through
  });

  it('a collision on a child collider resolves to the CHILD entity', () => {
    tw = createTestWorld({ systems: [PHYS] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 1, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }), EntityAttributes({}));
    const footIds = [-1.5, 1.5].map((fx) =>
      tw!.spawn(Transform({ x: fx, y: 0, z: 0 }),
        Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.2, halfD: 0.4, friction: 0.9 }),
        EntityAttributes({ parentId: body.id() })).id());
    tw.step(180);
    const collisions = tw.events({ type: '@collision' });
    const involvesFoot = collisions.some((e) => {
      const p = e.payload as { a: number; b: number };
      return footIds.includes(p.a) || footIds.includes(p.b);
    });
    expect(involvesFoot).toBe(true);
  });
});

describe('physics3D — compound membership changes mid-scene', () => {
  it('removing the child feet rebuilds the body; its narrow own collider slips the gap', () => {
    tw = createTestWorld({ systems: [PHYS] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 1, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1, fixedRotation: true }),
      Collider3D({ shape: 'box', halfW: 0.2, halfH: 0.2, halfD: 0.2, friction: 0.9 }), EntityAttributes({}));
    const feet = [-1.5, 1.5].map((fx) =>
      tw!.spawn(Transform({ x: fx, y: 0, z: 0 }),
        Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.2, halfD: 0.4, friction: 0.9 }),
        EntityAttributes({ parentId: body.id() })));
    tw.step(150);
    const yRest = tw.trait<{ y: number }>(Transform, body).y;
    expect(yRest).toBeGreaterThan(-4);                        // straddling the gap on its two feet

    feet.forEach((f) => (f as unknown as { destroy(): void }).destroy());
    tw.step(150);
    // Rebuilt with only the narrow own collider (fits the 2-unit gap) → drops through.
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeLessThan(yRest - 1);
  });
});
