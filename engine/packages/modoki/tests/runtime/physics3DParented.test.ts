/** P2 — physics3D respects WORLD transforms for PARENTED bodies (hierarchy-and-world-
 *  transform-plan). A body parented under a moved/translated group must:
 *    (1) seed + pose its collider at its WORLD position (a parented static floor collides
 *        where it renders, not at its raw local Transform), and
 *    (2) read the solved WORLD pose back into its LOCAL Transform (parentWorld⁻¹ · world),
 *        so the mesh stays coincident with the body instead of flying off by the parent offset.
 *
 *  These exercise the pre-physics propagation pass (TRANSFORM_PREPASS) + world-seed/readback
 *  wiring together — the pass must run so `worldTransforms` is fresh when physics reads it. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { transformPropagationSystem } from '../../src/three/systems/transformPropagationSystem';
import { getWorldTransform3D } from '../../src/runtime/ecs/worldTransform';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

// Pre-physics world-transform pass (170) + physics (175). The pass MUST run before physics so
// worldTransforms holds this-frame world poses when physics seeds/poses parented bodies.
const PRE = { name: 'prepass', fn: transformPropagationSystem, priority: SYSTEM_PRIORITY.TRANSFORM_PREPASS };
const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

describe('physics3D — parented bodies respect world transforms (P2)', () => {
  it('a parented STATIC floor collides at its WORLD height (not its local y)', () => {
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));

    // A group translated up by 5. The floor is its child at LOCAL y=0 → WORLD y=5.
    const riser = tw.spawn(
      Transform({ x: 0, y: 5, z: 0 }),
      EntityAttributes({ name: 'Riser', parentId: 0 }),
    );
    tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),                       // LOCAL 0 → WORLD y=5
      EntityAttributes({ name: 'Floor', parentId: riser.id() }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),  // top at world y = 5+1 = 6
    );
    // Unparented dynamic box dropped from world y=20 → rests on the floor top (6) + half (0.5).
    const box = tw.spawn(
      Transform({ x: 0, y: 20, z: 0 }),
      EntityAttributes({ name: 'Box', parentId: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5, restitution: 0, friction: 0.5 }),
    );

    tw.step(300);
    const tf = tw.trait<{ y: number }>(Transform, box);
    // With P2 the floor collides at world y=6 → box rests at 6.5. (Pre-P2 it seeded at local
    // y=0, top at 1, box would rest at ~1.5 — the regression this guards.)
    expect(tf.y).toBeCloseTo(6.5, 1);
  });

  it('a parented DYNAMIC body seeds at world + reads back into LOCAL space', () => {
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));

    // Floor at WORLD x=100 (root static body). Anything not seeded at x≈100 misses it.
    tw.spawn(
      Transform({ x: 100, y: 0, z: 0 }),
      EntityAttributes({ name: 'Floor', parentId: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 50, halfH: 1, halfD: 50 }),   // top at world y=1
    );
    // Field group translated to x=100. Dynamic box is its child at LOCAL (0,10,0) → WORLD (100,10,0).
    const field = tw.spawn(
      Transform({ x: 100, y: 0, z: 0 }),
      EntityAttributes({ name: 'Field', parentId: 0 }),
    );
    const box = tw.spawn(
      Transform({ x: 0, y: 10, z: 0 }),                      // LOCAL → WORLD (100,10,0)
      EntityAttributes({ name: 'Box', parentId: field.id() }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5, restitution: 0, friction: 0.5 }),
    );

    tw.step(300);

    // LOCAL Transform reads back inverted: x≈0 (parent's 100 subtracted), y≈1.5 (rested on floor).
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, box);
    expect(tf.x).toBeCloseTo(0, 1);   // NOT 100 — the world→local inverse ran
    expect(tf.y).toBeCloseTo(1.5, 1);

    // And the composed WORLD pose is where physics actually put the body — coincident, x≈100.
    const wt = getWorldTransform3D(box.id(), tw.world);
    expect(wt.x).toBeCloseTo(100, 1);
    expect(wt.y).toBeCloseTo(1.5, 1);
  });

  it('seed + readback stay SYMMETRIC even WITHOUT the pre-pass registered (headless robustness)', () => {
    // Only PHYS, no PRE → the worldTransforms cache is never populated. The symmetric fallback
    // must still seed a parented body at its TRUE world (on-demand) and invert on readback, so a
    // test author who forgets the pre-pass doesn't get a body that seeds local but reads back world.
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));
    tw.spawn(
      Transform({ x: 100, y: 0, z: 0 }),
      EntityAttributes({ name: 'Floor', parentId: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 50, halfH: 1, halfD: 50 }),
    );
    const field = tw.spawn(Transform({ x: 100, y: 0, z: 0 }), EntityAttributes({ name: 'Field', parentId: 0 }));
    const box = tw.spawn(
      Transform({ x: 0, y: 10, z: 0 }),
      EntityAttributes({ name: 'Box', parentId: field.id() }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5, restitution: 0, friction: 0.5 }),
    );
    tw.step(300);
    const tf = tw.trait<{ x: number; y: number }>(Transform, box);
    expect(tf.x).toBeCloseTo(0, 1);   // still local-inverted despite no cache
    expect(tf.y).toBeCloseTo(1.5, 1); // still landed on the world-x=100 floor (seeded at world)
  });

  it('a collider under a SCALED parent gets scaled EXTENTS (collides at the scaled size)', () => {
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));

    // Parent group scaled 2× (no body). Its child floor's collider halfH must scale 1 → 2.
    const scaler = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 2, sy: 2, sz: 2 }),
      EntityAttributes({ name: 'Scaler', parentId: 0 }),
    );
    tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),                       // world (0,0,0), world scale 2
      EntityAttributes({ name: 'Floor', parentId: scaler.id() }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 50, halfH: 1, halfD: 50 }),  // world halfH = 1×2 = 2 → top y=2
    );
    const box = tw.spawn(
      Transform({ x: 0, y: 20, z: 0 }),
      EntityAttributes({ name: 'Box', parentId: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5, restitution: 0, friction: 0.5 }),
    );

    tw.step(300);
    const tf = tw.trait<{ y: number }>(Transform, box);
    // Scaled floor top at y=2 → box rests at 2.5. (Unscaled it'd be top=1 → rest 1.5 — the gap.)
    expect(tf.y).toBeCloseTo(2.5, 1);
  });
});
