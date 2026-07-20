/** Compound colliders (Phase 4.2) — one RigidBody2D adopts child entities that carry a
 *  Collider2D but no RigidBody2D of their own, attaching each as an extra collider at the
 *  child's local Transform offset.
 *
 *  Proven physically: a body with two "feet" offset left/right straddles a gap between two
 *  pedestals and rests on them, whereas the same body with a single centered collider drops
 *  straight through the gap. Also proven: a collision on a CHILD collider resolves to the
 *  CHILD entity (event mapping), so per-child OnCollision2D/journal works. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';

beforeAll(async () => { await initRapier2D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

/** Two static pedestals with a 200-unit gap between their inner edges (x in [-100,100]). */
function spawnPedestals(): void {
  tw!.spawn(Physics2D({ gravityX: 0, gravityY: 30, pixelsPerMeter: 100 }));
  for (const x of [-150, 150]) {
    tw!.spawn(Transform({ x, y: 400 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 50, halfH: 20, friction: 0.9 }));
  }
}

describe('physics2D — compound colliders', () => {
  it('a two-footed compound straddles a gap that swallows a single centered box', () => {
    // Compound: body with NO own collider + two foot children at local x = ±150.
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 100 }),
      RigidBody2D({ bodyType: 'dynamic', angularDamping: 1 }), EntityAttributes({}));
    for (const fx of [-150, 150]) {
      tw.spawn(Transform({ x: fx, y: 0 }), Collider2D({ shape: 'box', halfW: 40, halfH: 20, friction: 0.9 }),
        EntityAttributes({ parentId: body.id() }));
    }
    tw.step(240);
    // Feet land on the pedestals (tops at y=380); body rests just above (~360), well short
    // of the gap it would fall through.
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeLessThan(400);
  });

  it('the same body with a single centered collider falls through the gap', () => {
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 100 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 40, halfH: 20 }));
    tw.step(240);
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeGreaterThan(500);
  });

  it('a collision on a child collider resolves to the CHILD entity', () => {
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    spawnPedestals();
    const body = tw.spawn(Transform({ x: 0, y: 100 }),
      RigidBody2D({ bodyType: 'dynamic', angularDamping: 1 }), EntityAttributes({}));
    const footIds = [-150, 150].map((fx) =>
      tw!.spawn(Transform({ x: fx, y: 0 }), Collider2D({ shape: 'box', halfW: 40, halfH: 20, friction: 0.9 }),
        EntityAttributes({ parentId: body.id() })).id());
    tw.step(240);
    const collisions = tw.events({ type: '@collision' });
    // At least one foot landed → a collision naming that foot child entity (not the parent).
    const involvesFoot = collisions.some((e) => {
      const p = e.payload as { a: number; b: number };
      return footIds.includes(p.a) || footIds.includes(p.b);
    });
    expect(involvesFoot).toBe(true);
  });
});

describe('physics2D — compound membership changes mid-scene (T5)', () => {
  it('removing the child feet rebuilds the body; its narrow own collider slips the gap', () => {
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    spawnPedestals();
    // Body has a NARROW own collider (fits the 200-wide gap) + two wide feet that straddle it.
    const body = tw.spawn(Transform({ x: 0, y: 100 }),
      RigidBody2D({ bodyType: 'dynamic', angularDamping: 1, fixedRotation: true }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20, friction: 0.9 }), EntityAttributes({}));
    const feet = [-150, 150].map((fx) =>
      tw!.spawn(Transform({ x: fx, y: 0 }), Collider2D({ shape: 'box', halfW: 40, halfH: 20, friction: 0.9 }),
        EntityAttributes({ parentId: body.id() })));
    tw.step(180);
    const yRest = tw.trait<{ y: number }>(Transform, body).y;
    expect(yRest).toBeLessThan(420);                    // straddling the gap on its two feet

    feet.forEach((f) => (f as unknown as { destroy(): void }).destroy());
    tw.step(180);
    // Rebuilt with only the narrow own collider → no longer straddles → drops through the gap.
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeGreaterThan(yRest + 100);
  });
});
