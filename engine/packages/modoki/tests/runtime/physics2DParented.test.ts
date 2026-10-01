/** P2 — physics2D respects WORLD transforms for PARENTED bodies (hierarchy-and-world-
 *  transform-plan), mirroring physics3DParented. A body parented under a translated group must
 *  seed/pose its collider at its WORLD position and read the solved WORLD pose back into LOCAL.
 *
 *  Screen is Y-DOWN; gravity (+Y) pulls a body "down" toward larger y. The pre-physics
 *  propagation pass (TRANSFORM_PREPASS) must run so worldTransforms is fresh for physics. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/physics/physics2DSystem';
import { transformPropagationSystem } from '../../src/runtime/core/ecs/transformPropagationSystem';
import { getWorldTransform3D } from '../../src/runtime/core/ecs/worldTransform';
import { initRapier2D } from '../../src/runtime/physics/rapierLoader';
import { Canvas2D } from '../../src/runtime/traits/Canvas2D';
import { Frame2D } from '../../src/runtime/traits/Frame2D';
import { forgetCanvasView2D } from '../../src/runtime/rendering/frame2D'; // registers the Frame2D fit provider

beforeAll(async () => { await initRapier2D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

const PRE = { name: 'prepass', fn: transformPropagationSystem, priority: SYSTEM_PRIORITY.TRANSFORM_PREPASS };
const PHYS = { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

describe('physics2D — parented bodies respect world transforms (P2)', () => {
  it('a parented STATIC floor collides at its WORLD x (a body only rests if it seeded there)', () => {
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));

    // Field group at world x=200. The floor is its child at LOCAL x=0 → WORLD x=200.
    const field = tw.spawn(Transform({ x: 200, y: 0 }), EntityAttributes({ name: 'Field', parentId: 0 }));
    tw.spawn(
      Transform({ x: 0, y: 0 }),                              // LOCAL → WORLD (200,0)
      EntityAttributes({ name: 'Floor', parentId: field.id() }),
      RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 50, halfH: 10 }),     // spans world x∈[150,250], top y=-10
    );
    // Unparented dynamic box above the floor at world x=200. Falls +y and rests at y = -10-5 = -15.
    const box = tw.spawn(
      Transform({ x: 200, y: -300 }),
      EntityAttributes({ name: 'Box', parentId: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 5, halfH: 5, restitution: 0, friction: 0.5 }),
    );

    tw.step(240);
    const tf = tw.trait<{ x: number; y: number }>(Transform, box);
    // If the floor had seeded at its LOCAL x=0 (world 0), the box at x=200 would miss it and
    // keep falling (y ≫ 0). With P2 the floor is at world x=200 → box rests at y≈-15.
    expect(tf.y).toBeCloseTo(-15, 0);
    expect(tf.x).toBeCloseTo(200, 0);
  });

  it('a parented DYNAMIC body seeds at world + reads back into LOCAL space', () => {
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));

    // Floor at WORLD x=200 (root static). A body not seeded at x≈200 misses it.
    tw.spawn(
      Transform({ x: 200, y: 0 }),
      EntityAttributes({ name: 'Floor', parentId: 0 }),
      RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10 }),
    );
    // Field group at x=200; dynamic box is its child at LOCAL (0,-300) → WORLD (200,-300).
    const field = tw.spawn(Transform({ x: 200, y: 0 }), EntityAttributes({ name: 'Field', parentId: 0 }));
    const box = tw.spawn(
      Transform({ x: 0, y: -300 }),                           // LOCAL → WORLD (200,-300)
      EntityAttributes({ name: 'Box', parentId: field.id() }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 5, halfH: 5, restitution: 0, friction: 0.5 }),
    );

    tw.step(240);

    // LOCAL Transform reads back inverted: x≈0 (parent's 200 subtracted), y≈-15 (rested on floor).
    const tf = tw.trait<{ x: number; y: number }>(Transform, box);
    expect(tf.x).toBeCloseTo(0, 0);    // NOT 200 — the world→local inverse ran
    expect(tf.y).toBeCloseTo(-15, 0);

    // Composed WORLD pose is where physics actually put the body — coincident, x≈200.
    const wt = getWorldTransform3D(box.id(), tw.world);
    expect(wt.x).toBeCloseTo(200, 0);
    expect(wt.y).toBeCloseTo(-15, 0);
  });

  // A body ON a Frame2D host: its world pose is fitted (`fit · local`), so its write-back inverts the parent with the
  // host's own fit composed in. Inverting the bare parent wrote the fitted pose back, fitted again next pass
  // (#1926 close-out review). Zero gravity: nothing moves it, so its Transform must not move either.
  it('a body on a Frame2D host writes back the local it has, not its fitted world pose', () => {
    forgetCanvasView2D();
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
    const canvas = tw.spawn(Canvas2D({ referenceWidth: 1000, referenceHeight: 2000 }), EntityAttributes({ name: 'Canvas', parentId: 0 }));
    // 500 x 500 covering 1000 x 2000: k = 4, x -500.
    const host = tw.spawn(
      Transform({ x: 10, y: 20, sx: 1, sy: 1 }),
      Frame2D({ width: 500, height: 500, fit: 'cover' }),
      EntityAttributes({ name: 'Host', parentId: canvas.id() }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 5, halfH: 5 }),
    );
    tw.step(10);
    const tf = tw.trait<{ x: number; y: number }>(Transform, host);
    expect(tf.x).toBeCloseTo(10, 3);
    expect(tf.y).toBeCloseTo(20, 3);
    const wt = getWorldTransform3D(host.id(), tw.world);
    expect(wt.x).toBeCloseTo(-500 + 4 * 10, 3);
  });

  it('a collider under a SCALED parent gets scaled EXTENTS (collides at the scaled size)', () => {
    tw = createTestWorld({ systems: [PRE, PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));

    // A parent group scaled 2× (no body). Its child floor's collider halfH must scale 10 → 20.
    const scaler = tw.spawn(
      Transform({ x: 0, y: 0, sx: 2, sy: 2 }),
      EntityAttributes({ name: 'Scaler', parentId: 0 }),
    );
    tw.spawn(
      Transform({ x: 0, y: 0 }),                              // world (0,0), world scale 2
      EntityAttributes({ name: 'Floor', parentId: scaler.id() }),
      RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 50, halfH: 10 }),     // world halfH = 10×2 = 20 → top y=-20
    );
    const box = tw.spawn(
      Transform({ x: 0, y: -100 }),
      EntityAttributes({ name: 'Box', parentId: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 5, halfH: 5, restitution: 0, friction: 0.5 }),
    );

    tw.step(240);
    const tf = tw.trait<{ y: number }>(Transform, box);
    // Scaled floor top at y=-20 → box rests at -25. (Unscaled it'd be top=-10 → rest -15 — the gap.)
    expect(tf.y).toBeCloseTo(-25, 0);
  });
});
