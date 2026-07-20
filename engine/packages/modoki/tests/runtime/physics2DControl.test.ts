/** physics2D imperative control API — impulses / forces / velocity / torque / wake, headless via
 *  createTestWorld + real Rapier. Mirrors physics3DControl. 2D screen frame: +Y is DOWN, and the
 *  system round-trips velocity through vecEcsToPhys/vecPhysToEcs (scale + Y-flip), so a value set
 *  in world units/s reads back in the same world units/s. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import {
  physics2DSystem, disposePhysics2D,
  applyImpulse2D, applyTorqueImpulse2D, addForce2D, setLinvel2D, setAngvel2D, resetForces2D, wakeBody2D,
} from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';

beforeAll(async () => { await initRapier2D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

function world0g(t: TestWorld) {
  // Zero gravity so the control API's effect is isolated from falling.
  t.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
}

describe('physics2D control API — impulses, forces, velocity', () => {
  it('applyImpulse2D kicks a resting body (no-op before the body exists, then works)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20 }),
    );
    // Body doesn't exist until the system's first tick — the call is a safe no-op.
    expect(applyImpulse2D(tw.world, box, 30, 0)).toBe(false);
    tw.step(1);                                    // creates the Rapier body
    expect(applyImpulse2D(tw.world, box, 30, 0)).toBe(true);
    tw.step(30);
    const tf = tw.trait<{ x: number }>(Transform, box);
    const rb = tw.trait<{ vx: number }>(RigidBody2D, box);
    expect(rb.vx).toBeGreaterThan(0);              // moving +X from the impulse
    expect(tf.x).toBeGreaterThan(1);
  });

  it('setLinvel2D sets velocity directly in world units/s, honoring the Y-flip round-trip', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }),
    );
    tw.step(1);
    setLinvel2D(tw.world, box, 5, 7);              // world units/s, +Y = screen-down
    tw.step(1);
    const rb = tw.trait<{ vx: number; vy: number }>(RigidBody2D, box);
    expect(rb.vx).toBeCloseTo(5, 2);               // exactly what we set (ppm cancels)
    expect(rb.vy).toBeCloseTo(7, 2);               // Y round-trips through the flip
    tw.step(20);
    const tf = tw.trait<{ x: number; y: number }>(Transform, box);
    expect(tf.x).toBeGreaterThan(0.5);
    expect(tf.y).toBeGreaterThan(0.5);             // +Y screen-down
  });

  it('addForce2D accelerates a body continuously; resetForces2D stops the accumulation', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20 }),
    );
    tw.step(1);
    addForce2D(tw.world, box, 200, 0);
    tw.step(20);
    const vAfterForce = tw.trait<{ vx: number }>(RigidBody2D, box).vx;
    expect(vAfterForce).toBeGreaterThan(0);
    resetForces2D(tw.world, box);
    const vAtReset = tw.trait<{ vx: number }>(RigidBody2D, box).vx;
    tw.step(20);
    // Force cleared → no further acceleration (velocity holds, minus any tiny numerical drift).
    expect(tw.trait<{ vx: number }>(RigidBody2D, box).vx).toBeLessThanOrEqual(vAtReset + 0.01);
  });

  it('setAngvel2D / applyTorqueImpulse2D spin the body about Z', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20 }),
    );
    tw.step(1);
    setAngvel2D(tw.world, box, 2);                 // rad/s about Z
    tw.step(1);
    expect(tw.trait<{ angularVel: number }>(RigidBody2D, box).angularVel).toBeCloseTo(2, 2);
    tw.step(20);
    expect(Math.abs(tw.trait<{ rz: number }>(Transform, box).rz)).toBeGreaterThan(0.1);

    // A one-shot torque impulse changes the angular velocity.
    setAngvel2D(tw.world, box, 0);
    tw.step(1);
    applyTorqueImpulse2D(tw.world, box, 500);
    tw.step(2);
    expect(Math.abs(tw.trait<{ angularVel: number }>(RigidBody2D, box).angularVel)).toBeGreaterThan(0);
  });

  it('control helpers return false for an entity with no body; wakeBody2D wakes a sleeper', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const noBody = tw.spawn(Transform({ x: 0, y: 0 }));
    expect(applyImpulse2D(tw.world, noBody, 1, 1)).toBe(false);
    expect(setAngvel2D(tw.world, noBody, 1)).toBe(false);
    expect(wakeBody2D(tw.world, noBody)).toBe(false);

    const box = tw.spawn(
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20 }),
    );
    tw.step(1);
    expect(wakeBody2D(tw.world, box)).toBe(true);
  });
});
