/** physicsContactIndex (Percept) — the queryable CURRENT-contacts readback. Headless via
 *  createTestWorld + real Rapier 2D. Asserts: a settled body reports its solid `contacts`;
 *  a sensor overlap reports `overlaps`; contacts roll up to the BODY entity (a compound
 *  child's contact is attributed to its parent body, and a body never lists itself); and
 *  despawn / exit clears the entry. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { physics2DEvents } from '../../src/runtime/managers/Physics2DEvents';
import { getContactState, updateContactIndex, _resetContactIndex } from '../../src/runtime/systems/physicsContactIndex';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';
import type { World } from 'koota';

beforeAll(async () => { await initRapier2D(); });
let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { physics2DEvents.__clear(tw.world); disposePhysics2D(tw.world); tw.dispose(); tw = undefined; }
  _resetContactIndex();
});

const PHYS = { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

describe('physicsContactIndex — solid contacts', () => {
  it('a settled body reports the floor in `contacts`, symmetric, then clears on despawn', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }));

    tw.step(240); // fall + settle on the floor

    const cs = getContactState(tw.world, body.id());
    expect(cs).toBeDefined();
    expect(cs!.contacts).toContain(floor.id());
    expect(cs!.overlaps).toEqual([]);           // a solid floor is not a sensor overlap
    // Symmetric: the floor lists the body too.
    expect(getContactState(tw.world, floor.id())!.contacts).toContain(body.id());

    // Despawn the body → synthesized exit drops it from the index (both directions).
    body.destroy();
    tw.step(1);
    expect(getContactState(tw.world, body.id())).toBeUndefined();
    expect(getContactState(tw.world, floor.id())).toBeUndefined(); // floor now touches nothing
  });
});

describe('physicsContactIndex — sensor overlaps', () => {
  it('a body inside a sensor reports it in `overlaps` (not `contacts`), cleared on exit-by-despawn', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 })); // no gravity: stays overlapping
    const zone = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 60, isSensor: true }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 })); // spawns already inside the sensor

    tw.step(5); // enter fires (pre-overlapping)

    const cs = getContactState(tw.world, body.id());
    expect(cs).toBeDefined();
    expect(cs!.overlaps).toContain(zone.id());
    expect(cs!.contacts).toEqual([]);           // a sensor is an overlap, not a solid contact
    expect(getContactState(tw.world, zone.id())!.overlaps).toContain(body.id());

    body.destroy();
    tw.step(1);
    expect(getContactState(tw.world, zone.id())).toBeUndefined();
  });
});

describe('physicsContactIndex — roll-up to the body', () => {
  it('a compound child\'s contact is attributed to its PARENT body, and a body never lists itself', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));
    // Compound body: parent carries the RigidBody but NO own collider; a single child
    // entity carries the collider (adopted as a compound child). All contact happens at
    // the child collider, but must roll up to the parent body.
    const parent = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      EntityAttributes({ name: 'parent' }));
    const child = tw.spawn(Transform({ x: 0, y: 0 }), Collider2D({ shape: 'circle', radius: 15 }),
      EntityAttributes({ name: 'child', parentId: parent.id() }));

    tw.step(240);

    // The PARENT body reports the floor; the child (not a body) reports nothing.
    const cs = getContactState(tw.world, parent.id());
    expect(cs).toBeDefined();
    expect(cs!.contacts).toContain(floor.id());
    expect(cs!.contacts).not.toContain(parent.id());   // never lists itself
    expect(cs!.contacts).not.toContain(child.id());     // rolled up, not the child
    expect(getContactState(tw.world, child.id())).toBeUndefined();
    // Floor lists the PARENT body, not the child collider entity.
    const fc = getContactState(tw.world, floor.id())!;
    expect(fc.contacts).toContain(parent.id());
    expect(fc.contacts).not.toContain(child.id());
  });
});

describe('physicsContactIndex — refcount (many collider pairs per body pair)', () => {
  // `world` is only ever used as a Map key here, so a bare object stands in.
  const w = () => ({} as unknown as World);

  it('keeps a body pair while ANY collider pair between them is still active', () => {
    const world = w();
    // Two collider pairs between bodies 1 and 2 both enter (e.g. two legs on one floor).
    updateContactIndex(world, 1, 2, false, 'enter');
    updateContactIndex(world, 1, 2, false, 'enter');
    expect(getContactState(world, 1)!.contacts).toEqual([2]);
    // One collider lifts off → the body is STILL touching via the other. A plain Set would
    // wrongly report separation here; the refcount holds it.
    updateContactIndex(world, 1, 2, false, 'exit');
    expect(getContactState(world, 1)!.contacts).toEqual([2]);
    // The second lifts → now truly separated; both entries pruned.
    updateContactIndex(world, 1, 2, false, 'exit');
    expect(getContactState(world, 1)).toBeUndefined();
    expect(getContactState(world, 2)).toBeUndefined();
  });

  it('counts solid contacts and sensor overlaps independently', () => {
    const world = w();
    updateContactIndex(world, 1, 3, false, 'enter'); // solid
    updateContactIndex(world, 1, 3, true, 'enter');  // sensor overlap (independent counter)
    expect(getContactState(world, 1)!.contacts).toEqual([3]);
    expect(getContactState(world, 1)!.overlaps).toEqual([3]);
    updateContactIndex(world, 1, 3, false, 'exit');  // drop only the solid
    expect(getContactState(world, 1)!.contacts).toEqual([]);
    expect(getContactState(world, 1)!.overlaps).toEqual([3]); // overlap survives
  });
});

describe('physicsContactIndex — removal cleanup (review fixes)', () => {
  it('despawning a COMPOUND body clears its contact from the surviving partner (#1)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));
    const parent = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      EntityAttributes({ name: 'parent' }));
    const child = tw.spawn(Transform({ x: 0, y: 0 }), Collider2D({ shape: 'circle', radius: 15 }),
      EntityAttributes({ name: 'child', parentId: parent.id() }));

    tw.step(240);
    expect(getContactState(tw.world, floor.id())!.contacts).toContain(parent.id());

    // Destroy the whole compound. The despawn-exit rolls the DEAD child up to its own id
    // (not the parent), so the incremental decrement misses — dropEntityFromContactIndex in
    // removeBody(parent) must still clear it. (floor survives → normal cleanup pass runs.)
    child.destroy(); parent.destroy();
    tw.step(1);
    expect(getContactState(tw.world, parent.id())).toBeUndefined();
    expect(getContactState(tw.world, floor.id())).toBeUndefined(); // floor's only contact was the compound
  });

  it('clears the index when ALL bodies despawn in one frame (zero-body early-out, #3)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }));

    tw.step(240);
    expect(getContactState(tw.world, body.id())!.contacts).toContain(floor.id());

    // Both bodies gone in one frame → next tick hits the zero-body early-out, which SKIPS
    // the removeBody cleanup pass; it must still clear the index directly.
    floor.destroy(); body.destroy();
    tw.step(1);
    expect(getContactState(tw.world, body.id())).toBeUndefined();
    expect(getContactState(tw.world, floor.id())).toBeUndefined();
  });
});

describe('physicsContactIndex — accessor shape', () => {
  it('returns undefined for a body touching nothing, and sorted arrays', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
    const lonely = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 5 }));
    tw.step(3);
    expect(getContactState(tw.world, lonely.id())).toBeUndefined();
  });
});
