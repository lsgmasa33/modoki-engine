/** Authored launch velocity (#1592). `RigidBody2D/3D.vx…` are runtimeOnly solver read-back, so an
 *  authored value there was dropped by the Play snapshot and every save; the authored channel is
 *  `initial*`. These pin the three rules of `physics/launchVelocity.ts` through the real systems:
 *  a new body launches with `initial*`; code-written `vx…` beats it; and a same-entity REBUILD
 *  keeps its live velocity rather than re-launching a body that had come to rest. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/physics/physics2DSystem';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/physics/physics3DSystem';
import { initRapier2D } from '../../src/runtime/physics/rapierLoader';
import { initRapier3D } from '../../src/runtime/physics/rapier3DLoader';
import type { Entity } from 'koota';
import { setRunMode } from '../../src/runtime/core/playState';

beforeAll(async () => { await initRapier2D(); await initRapier3D(); });
let tw: TestWorld | undefined;
let dispose: ((w: TestWorld['world']) => void) | undefined;
afterEach(() => { if (tw) { dispose?.(tw.world); tw.dispose(); tw = undefined; } });

type Tf = { x: number; y: number; z: number; rz: number };

function world2D(): TestWorld {
  dispose = disposePhysics2D;
  tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
  tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
  return tw;
}
function world3D(): TestWorld {
  dispose = disposePhysics3D;
  tw = createTestWorld({ systems: [{ name: 'p', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
  tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));
  return tw;
}

describe('RigidBody2D launch velocity (#1592)', () => {
  it('a new body launches with the authored initialVx/initialVy', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialVx: 600, initialVy: -300 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(30);
    const tf = w.trait<Tf>(Transform, ball);
    expect(tf.x).toBeGreaterThan(250);
    expect(tf.y).toBeLessThan(-100);
  });

  it('a new body spins with the authored initialAngularVel', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialAngularVel: 3 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).rz).toBeGreaterThan(1);
  });

  it('a vx written by code before the body exists beats initialVx', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', vx: 600, initialVx: -600 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(250);
  });

  it('a rebuild of a body that came to rest does NOT re-launch it', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialVx: 600, linearDamping: 50 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(60);
    const rest = w.trait<Tf>(Transform, ball).x;
    expect(rest).toBeGreaterThan(0);   // it did launch
    // canSleep is in bodySig → a structural rebuild of the SAME entity. The read-back is zeroed
    // exactly (a damped body reads back a tiny non-zero `vx`, which would win on its own and make
    // this test unable to see a re-launch).
    ball.set(RigidBody2D, { ...(ball.get(RigidBody2D) as object), vx: 0, vy: 0, angularVel: 0, canSleep: false, linearDamping: 0 });
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeCloseTo(rest, 0);
  });

  it('a body carried into a FRESH physics world (a scene swap) at rest is not re-launched', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialVx: 600, initialAngularVel: 3, linearDamping: 50, angularDamping: 50 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(60);
    const rest = w.trait<Tf>(Transform, ball);
    zero2D(ball);
    disposePhysics2D(w.world);   // what a swap does: new physics state, the entity (and its runtimeOnly fields) carried
    w.step(30);
    const after = w.trait<Tf>(Transform, ball);
    expect(after.x).toBeCloseTo(rest.x, 0);
    expect(after.rz).toBeCloseTo(rest.rz, 2);
  });

  it('a body CARRIED across Stop (Persistent / kept base scene) launches again on the next Play', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialVx: 600, linearDamping: 50 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(60);
    const rest = w.trait<Tf>(Transform, ball).x;
    // NOT zeroed: the leftover read-back is a tiny non-zero `vx` after damping, and it must not
    // pass for a code-written launch velocity. Stop → Play: Stop disposes physics and carries the
    // entity with its runtimeOnly fields intact (the authored restore skips them), so only the new
    // Play session can say "launch again".
    setRunMode('stopped');
    disposePhysics2D(w.world);
    setRunMode('playing');
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(rest + 10);   // damping 50 → a relaunch adds ~22; a missed one adds 0
  });

  it('a body carried across Stop MID-FLIGHT starts the next Play with initialVx, not its old velocity', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialVx: 600 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(10);
    ball.set(RigidBody2D, { ...(ball.get(RigidBody2D) as object), initialVx: -600 });   // re-authored between Plays
    setRunMode('stopped');
    disposePhysics2D(w.world);
    setRunMode('playing');
    const x0 = w.trait<Tf>(Transform, ball).x;
    w.step(10);
    expect(w.trait<Tf>(Transform, ball).x).toBeLessThan(x0 - 50);
  });

  it('Stop resets a carried body even when its world has not ticked physics yet (swapped in just before Stop)', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', initialVx: 600 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(10);                     // launched, flying at ~600
    disposePhysics2D(w.world);      // the world has no physics state — as right after a swap
    setRunMode('stopped');
    setRunMode('playing');
    ball.set(RigidBody2D, { ...(ball.get(RigidBody2D) as object), initialVx: -600 });
    const x0 = w.trait<Tf>(Transform, ball).x;
    w.step(10);
    expect(w.trait<Tf>(Transform, ball).x).toBeLessThan(x0 - 50);
  });

  it('a carried body released by code on the next Play keeps the code-written vx', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', linearDamping: 50 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(10);                                  // Play 1: launched as dynamic…
    ball.set(RigidBody2D, { ...(ball.get(RigidBody2D) as object), bodyType: 'kinematic' });
    w.step(2);                                   // …ends Play 1 held kinematic
    setRunMode('stopped');
    setRunMode('playing');
    w.step(2);
    ball.set(RigidBody2D, { ...(ball.get(RigidBody2D) as object), bodyType: 'dynamic', vx: 600, linearDamping: 0 });   // thrown by code
    const x0 = w.trait<Tf>(Transform, ball).x;
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(x0 + 250);
  });

  it('a body that starts kinematic and is released to dynamic launches with initialVx then', () => {
    const w = world2D();
    const ball = w.spawn(Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'kinematic', initialVx: 600 }), Collider2D({ shape: 'circle', radius: 5 }));
    w.step(10);
    expect(w.trait<Tf>(Transform, ball).x).toBe(0);
    ball.set(RigidBody2D, { ...(ball.get(RigidBody2D) as object), bodyType: 'dynamic' });
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(250);
  });
});

/** Zero the read-back EXACTLY: a damped body reads back a tiny non-zero value, which would win on
 *  its own and hide a re-launch. */
function zero2D(e: Entity): void { e.set(RigidBody2D, { ...(e.get(RigidBody2D) as object), vx: 0, vy: 0, angularVel: 0 }); }
function zero3D(e: Entity): void { e.set(RigidBody3D, { ...(e.get(RigidBody3D) as object), vx: 0, vy: 0, vz: 0, avx: 0, avy: 0, avz: 0 }); }

describe('RigidBody3D launch velocity (#1592)', () => {
  it('a new body launches with the authored initialVx/Vy/Vz', () => {
    const w = world3D();
    const ball = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', initialVx: 6, initialVz: -3 }), Collider3D({ shape: 'sphere', radius: 0.1 }));
    w.step(30);
    const tf = w.trait<Tf>(Transform, ball);
    expect(tf.x).toBeGreaterThan(2.5);
    expect(tf.z).toBeLessThan(-1);
  });

  it('a new body spins with the authored initialAvz', () => {
    const w = world3D();
    const box = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', initialAvz: 3 }), Collider3D({ shape: 'box', halfW: 0.1, halfH: 0.1, halfD: 0.1 }));
    w.step(20);
    expect(Math.abs(w.trait<Tf>(Transform, box).rz)).toBeGreaterThan(0.5);
  });

  it('a vx written by code before the body exists beats initialVx', () => {
    const w = world3D();
    const ball = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', vx: 6, initialVx: -6 }), Collider3D({ shape: 'sphere', radius: 0.1 }));
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(2.5);
  });

  it('a rebuild of a body that came to rest does NOT re-launch it', () => {
    const w = world3D();
    const ball = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', initialVx: 6, linearDamping: 50 }), Collider3D({ shape: 'sphere', radius: 0.1 }));
    w.step(60);
    const rest = w.trait<Tf>(Transform, ball).x;
    expect(rest).toBeGreaterThan(0);
    ball.set(RigidBody3D, { ...(ball.get(RigidBody3D) as object), vx: 0, vy: 0, vz: 0, canSleep: false, linearDamping: 0 });
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeCloseTo(rest, 1);
  });

  it('a body carried into a FRESH physics world (a scene swap) at rest is not re-launched', () => {
    const w = world3D();
    const ball = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', initialVx: 6, linearDamping: 50 }), Collider3D({ shape: 'sphere', radius: 0.1 }));
    w.step(60);
    const rest = w.trait<Tf>(Transform, ball).x;
    zero3D(ball);
    disposePhysics3D(w.world);
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeCloseTo(rest, 1);
  });

  it('a body carried across Stop launches again on the next Play, whatever its leftover read-back', () => {
    const w = world3D();
    const ball = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', initialVx: 6, linearDamping: 50 }), Collider3D({ shape: 'sphere', radius: 0.1 }));
    w.step(60);
    const rest = w.trait<Tf>(Transform, ball).x;
    setRunMode('stopped');
    disposePhysics3D(w.world);
    setRunMode('playing');
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(rest + 0.1);
  });

  it('a body that starts kinematic and is released to dynamic launches with initialVx then', () => {
    const w = world3D();
    const ball = w.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'kinematic', initialVx: 6 }), Collider3D({ shape: 'sphere', radius: 0.1 }));
    w.step(10);
    expect(w.trait<Tf>(Transform, ball).x).toBe(0);
    ball.set(RigidBody3D, { ...(ball.get(RigidBody3D) as object), bodyType: 'dynamic' });
    w.step(30);
    expect(w.trait<Tf>(Transform, ball).x).toBeGreaterThan(2.5);
  });
});
