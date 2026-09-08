/** #445 — the body-reconcile `updateEach` must not fan out to game code.
 *
 *  `removeBody`/`removeSoloCollider` synthesize collision-EXIT events for pairs that are still
 *  overlapping when a body is rebuilt (a `bodySig` change, or an id recycled onto a new entity).
 *  Those synthesized exits reach game code — a `physics2DEvents` subscriber and the declarative
 *  `OnCollision2D` action — and until #445 they were routed from INSIDE the reconcile query.
 *
 *  koota's `updateEach` snapshots each queried trait before the callback and writes that snapshot
 *  back after it returns, so anything the handler `set`s on `Transform`/`RigidBody2D` of the entity
 *  being rebuilt was silently discarded. Nothing threw; the write just vanished. Sibling of #432.
 *
 *  Both tests force the rebuild the same way: overlap a sensor, then change the collider geometry
 *  (which is part of `bodySig`) so the next reconcile pass rebuilds the body while overlapping.
 *
 *  ⚠️ The overlapping body is KINEMATIC, and that is load-bearing rather than incidental. A DYNAMIC
 *  body's Transform is owned by the solver: the Rapier→ECS pull later in the same tick writes
 *  `tf.x = <solved pose>` unconditionally, so a handler's `set(Transform, …)` on a dynamic body is
 *  overwritten no matter where the exit is routed. That is physics being authoritative about a
 *  simulated pose, NOT #445 — do not "fix" it by moving the exit flush past the pull, which would
 *  hand a pre-step exit a post-step world for a body that no longer exists. A kinematic body is
 *  skipped by that pull (`rec.bodyType !== 'dynamic'` returns), so its Transform is the honest
 *  probe for the write-back clobber this issue is actually about. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/physics/physics2DSystem';
import { physics2DEvents } from '../../src/runtime/physics/Physics2DEvents';
import { initRapier2D } from '../../src/runtime/physics/rapierLoader';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/physics/physics3DSystem';
import { physics3DEvents } from '../../src/runtime/physics/Physics3DEvents';
import { initRapier3D } from '../../src/runtime/physics/rapier3DLoader';

beforeAll(async () => { await initRapier2D(); await initRapier3D(); });

let tw: TestWorld | undefined;
let dim: '2d' | '3d' = '2d';
afterEach(() => {
  if (!tw) return;
  if (dim === '2d') { physics2DEvents.__clear(tw.world); disposePhysics2D(tw.world); }
  else { physics3DEvents.__clear(tw.world); disposePhysics3D(tw.world); }
  tw.dispose(); tw = undefined;
});

const PHYS2 = { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS };
const PHYS3 = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

describe('#445 — a synthesized contact exit must not be routed from inside the reconcile query', () => {
  it('2D: a subscriber\'s Transform write on the rebuilt entity survives the frame', () => {
    dim = '2d';
    tw = createTestWorld({ systems: [PHYS2] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
    // Overlapping from tick 0, and nothing moves (no gravity) — so the only exit that can ever
    // fire is the SYNTHESIZED one from the rebuild below. The SENSOR is the dynamic one: Rapier
    // generates no pair between two non-dynamic bodies, so something in the pair has to be, and
    // it must not be the entity whose Transform we assert on.
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 60, isSensor: true }));
    // KINEMATIC on purpose — see the note above the describe block.
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'kinematic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    let exits = 0;
    physics2DEvents.onSensor((_s, other, phase) => {
      if (phase !== 'exit') return;
      exits++;
      // The handler writes a trait the reconcile query itself holds, on the entity being rebuilt.
      other.set(Transform, { x: 999, y: 999 });
    }, tw.world);

    tw.step(2);                                  // enter
    body.set(Collider2D, { radius: 30 });        // bodySig changes ⇒ rebuild next pass
    tw.step(1);                                  // rebuild ⇒ synthesized exit

    expect(exits).toBe(1);
    expect(body.get(Transform)!.x).toBe(999);
  });

  it('3D: a subscriber\'s Transform write on the rebuilt entity survives the frame', () => {
    dim = '3d';
    tw = createTestWorld({ systems: [PHYS3] });
    tw.spawn(Physics3D({ gravityY: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 60, halfH: 60, halfD: 60, isSensor: true }));
    // KINEMATIC on purpose — see the note above the describe block.
    const body = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'kinematic' }),
      Collider3D({ shape: 'sphere', radius: 12 }));

    let exits = 0;
    physics3DEvents.onSensor((_s, other, phase) => {
      if (phase !== 'exit') return;
      exits++;
      other.set(Transform, { x: 999, y: 999, z: 999 });
    }, tw.world);

    tw.step(2);
    body.set(Collider3D, { radius: 30 });
    tw.step(1);

    expect(exits).toBe(1);
    expect(body.get(Transform)!.x).toBe(999);
  });

  it('2D: a partner whose isSensor flips before the flush is still routed as a SENSOR exit', () => {
    // Deferring the route opened an aliasing window inline routing did not have:
    // `applyBodyMaterial` toggles `ColliderInfo.isSensor` IN PLACE (a material/filter edit is
    // applied in place, NOT a rebuild), so a partner visited LATER in the same query could
    // rewrite which channel an already-collected pair routes on. It surfaced as a sensor exit
    // arriving on the collision channel — the `onSensor` subscriber never hears it and its
    // "inside the trigger" state stays stuck 'entered', which is the H1 bug the synthesized
    // exit exists to prevent. `collectContactExits` copies the infos; this pins that.
    dim = '2d';
    tw = createTestWorld({ systems: [PHYS2] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
    // Spawned FIRST so the reconcile query visits it before the sensor.
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'kinematic' }),
      Collider2D({ shape: 'circle', radius: 12 }));
    const sensor = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 60, isSensor: true }));

    let sensorExits = 0, collisionExits = 0;
    physics2DEvents.onSensor((_s, _o, phase) => { if (phase === 'exit') sensorExits++; }, tw.world);
    physics2DEvents.onCollision((_a, _b, phase) => { if (phase === 'exit') collisionExits++; }, tw.world);

    tw.step(2);                                   // enter
    body.set(Collider2D, { radius: 30 });         // rebuild ⇒ collect the exit
    sensor.set(Collider2D, { isSensor: false });  // same frame, visited AFTER ⇒ in-place flip
    tw.step(1);

    expect(sensorExits).toBe(1);
    expect(collisionExits).toBe(0);
  });
});
