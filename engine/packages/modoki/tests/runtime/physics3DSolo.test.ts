/** Solo (parentless) static colliders — a Collider3D on an entity with NO RigidBody3D of its own
 *  and NO body parent is created as a PARENTLESS Rapier collider: fixed world geometry that a
 *  dynamic body rests on and collides with, WITHOUT a dummy RigidBody3D. This matches Rapier's
 *  native "a collider without a parent behaves as if attached to a fixed body". A collider parented
 *  under a non-body GROUP is honored at its composed WORLD pose (the case that a wall-under-an-empty-
 *  group hit). Removing the collider entity drops it so the body falls through. 3D is Y-up. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { getContactState, _resetContactIndex } from '../../src/runtime/systems/physicsContactIndex';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } _resetContactIndex(); });

const PHYS = { name: 'p', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };
const yOf = (e: unknown) => tw!.trait<{ y: number }>(Transform, e as never).y;

describe('physics3D — solo (parentless) static colliders', () => {
  it('a dynamic body rests on a parentless static collider (no RigidBody3D on the floor)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    // Solo floor: Collider3D only — NO RigidBody3D, no parent. Top at y = -4 + 0.5 = -3.5.
    tw.spawn(Transform({ x: 0, y: -4, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9 }), EntityAttributes({}));
    const body = tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    tw.step(180);
    expect(yOf(body)).toBeGreaterThan(-4);   // rested on the solo floor, did not fall through
  });

  it('a collision on the solo collider resolves to its entity', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    const floorId = tw.spawn(Transform({ x: 0, y: -4, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9 }), EntityAttributes({})).id();
    tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    tw.step(180);
    const collisions = tw.events({ type: '@collision' });
    const involvesFloor = collisions.some((e) => {
      const p = e.payload as { a: number; b: number };
      return p.a === floorId || p.b === floorId;
    });
    expect(involvesFloor).toBe(true);
  });

  it('a collider parented under a non-body GROUP is placed at its composed WORLD pose', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    // Pure organizational group at y=-4 (no RigidBody3D, no Collider3D) — like Sling's "Wall Left".
    const group = tw.spawn(Transform({ x: 0, y: -4, z: 0 }), EntityAttributes({}));
    // Floor collider at LOCAL y=0 → WORLD y=-4 (top -3.5). If it were placed at LOCAL (0) the body
    // would rest near y≈0.9; if orphaned it would fall past -6. World placement rests it near -3.1.
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9 }),
      EntityAttributes({ parentId: group.id() }));
    const body = tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    tw.step(180);
    const y = yOf(body);
    expect(y).toBeGreaterThan(-3.7);   // did not fall through
    expect(y).toBeLessThan(-2.5);      // rested at WORLD y (~-3.1), NOT the local-y (~0.9) mis-placement
  });

  it('removing the solo collider entity lets the body fall through', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    const floor = tw.spawn(Transform({ x: 0, y: -4, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9 }), EntityAttributes({}));
    const body = tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    tw.step(150);
    const yRest = yOf(body);
    expect(yRest).toBeGreaterThan(-4);                 // resting on the solo floor

    (floor as unknown as { destroy(): void }).destroy();
    tw.step(200);
    expect(yOf(body)).toBeLessThan(yRest - 2);         // floor gone → fell through
  });

  it('a solo collider under a non-body group attributes Percept contacts to ITSELF, not the parent, and clears on removal', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    const group = tw.spawn(Transform({ x: 0, y: -4, z: 0 }), EntityAttributes({}));   // non-body group
    const floor = tw.spawn(Transform({ x: 0, y: 0, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9 }),
      EntityAttributes({ parentId: group.id() }));
    const body = tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    const floorId = floor.id();
    tw.step(180);
    // The contact rolls up to the SOLO collider (its own id), symmetric with the body — NOT the group.
    expect(getContactState(tw.world, floorId)?.contacts ?? []).toContain(body.id());
    expect(getContactState(tw.world, body.id())?.contacts ?? []).toContain(floorId);
    expect(getContactState(tw.world, group.id())?.contacts ?? []).not.toContain(body.id());
    // Removing the solo collider clears its index entry — no phantom-contact leak under the group.
    (floor as unknown as { destroy(): void }).destroy();
    tw.step(2);
    expect(getContactState(tw.world, floorId)?.contacts ?? []).not.toContain(body.id());
    expect(getContactState(tw.world, group.id())?.contacts ?? []).not.toContain(body.id());
  });

  it('a solo floor that GAINS its own body is dropped as solo (no ghost fixed collider keeps holding the body)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    const floor = tw.spawn(Transform({ x: 0, y: -4, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9 }), EntityAttributes({}));
    const body = tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    tw.step(120);
    expect(yOf(body)).toBeGreaterThan(-4);             // resting on the solo floor
    // Floor gains its OWN dynamic body → no longer solo. The reconcile must drop the solo collider,
    // else a ghost fixed floor keeps holding `body`. Both should now fall together.
    (floor as unknown as { add(t: unknown): void }).add(RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }));
    tw.step(220);
    expect(yOf(floor)).toBeLessThan(-8);               // floor fell (it's a dynamic body now)
    expect(yOf(body)).toBeLessThan(-8);                // body fell too — no leaked solo collider held it
  });

  it('flipping a solo collider to a sensor mid-play lets the body fall through (material applied in place)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -30, gravityZ: 0 }));
    const floor = tw.spawn(Transform({ x: 0, y: -4, z: 0 }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, friction: 0.9, isSensor: false }), EntityAttributes({}));
    const body = tw.spawn(Transform({ x: 0, y: 2, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider3D({ shape: 'box', halfW: 0.4, halfH: 0.4, halfD: 0.4 }), EntityAttributes({}));
    tw.step(150);
    const yRest = yOf(body);
    expect(yRest).toBeGreaterThan(-4);                 // solid floor holds it
    // Flip isSensor true — a material/filter change applied IN PLACE (no rebuild). Body falls through.
    floor.set(Collider3D, { ...floor.get(Collider3D)!, isSensor: true });
    tw.step(200);
    expect(yOf(body)).toBeLessThan(yRest - 2);         // now passes through the sensor
  });
});
