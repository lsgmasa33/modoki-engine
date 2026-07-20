import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { Joint3D } from '../../src/runtime/traits/Joint3D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };
const gravityWorld = (t: TestWorld) => t.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));

// A static anchor body at `pos` with an explicit guid. No collider — it's purely a joint
// attachment point, so it never collides with a body jointed on top of it.
function anchor(t: TestWorld, guid: string, x: number, y: number, z: number) {
  return t.spawn(
    Transform({ x, y, z }),
    RigidBody3D({ bodyType: 'static' }),
    EntityAttributes({ guid, name: guid }),
  );
}
// A dynamic weight body at `pos` with an explicit guid (a little damping so it settles).
function weight(t: TestWorld, guid: string, x: number, y: number, z: number) {
  return t.spawn(
    Transform({ x, y, z }),
    RigidBody3D({ bodyType: 'dynamic', linearDamping: 0.4, angularDamping: 0.4 }),
    Collider3D({ shape: 'sphere', radius: 0.3 }),
    EntityAttributes({ guid, name: guid }),
  );
}

describe('physics3D joints — constraints', () => {
  it('rope catches a falling body at its max length', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'anchor', 0, 6, 0);
    const w = weight(tw, 'weight', 0, 5, 0);
    tw.spawn(Joint3D({ type: 'rope', entityA: 'anchor', entityB: 'weight', length: 3 }));

    tw.step(300);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, w);
    // Hangs at most 3 below the anchor (y = 6 - 3), not free-falling.
    expect(tf.y).toBeCloseTo(3, 0);
    expect(Math.hypot(tf.x, tf.y - 6, tf.z)).toBeLessThanOrEqual(3.1);
  });

  it('fixed weld holds a dynamic body in place against gravity', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'anchor', 0, 5, 0);
    const w = weight(tw, 'weight', 0, 2, 0);
    // A's anchor is 3 below its origin = the weight's start; B's anchor at its origin.
    tw.spawn(Joint3D({ type: 'fixed', entityA: 'anchor', entityB: 'weight', anchorAY: -3 }));

    tw.step(120);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, w);
    expect(tf.y).toBeCloseTo(2, 1);   // welded — does not fall
    expect(tf.x).toBeCloseTo(0, 1);
  });

  it('spherical joint keeps a swinging bob at a constant distance from the pivot', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'pivot', 0, 5, 0);
    const bob = weight(tw, 'bob', 2, 5, 0);
    // Pivot at A's origin; B's anchor is 2 to its -x, so the bob hangs 2 from the pivot.
    tw.spawn(Joint3D({ type: 'spherical', entityA: 'pivot', entityB: 'bob', anchorBX: -2 }));

    tw.step(400);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, bob);
    const dist = Math.hypot(tf.x - 0, tf.y - 5, tf.z - 0);
    expect(dist).toBeCloseTo(2, 0);   // link length preserved
    expect(tf.y).toBeLessThan(4);     // swung down under gravity
  });

  it('spring keeps a weight bounded near the anchor (no free-fall)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'anchor', 0, 5, 0);
    const w = weight(tw, 'weight', 0, 4, 0);
    tw.spawn(Joint3D({ type: 'spring', entityA: 'anchor', entityB: 'weight', length: 1, stiffness: 200, damping: 5 }));

    tw.step(300);
    const y = tw.trait<{ y: number }>(Transform, w).y;
    expect(y).toBeGreaterThan(2);     // spring holds it up near the rest length, not falling away
    expect(y).toBeLessThan(5);
  });

  it('destroying the joint entity releases the body (reconciler tears it down)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'anchor', 0, 6, 0);
    const w = weight(tw, 'weight', 0, 5, 0);
    const jointEnt = tw.spawn(Joint3D({ type: 'rope', entityA: 'anchor', entityB: 'weight', length: 3 }));

    tw.step(200);
    const yHeld = tw.trait<{ y: number }>(Transform, w).y;
    expect(yHeld).toBeCloseTo(3, 0);  // caught by the rope

    (jointEnt as { destroy: () => void }).destroy();
    tw.step(120);
    const yFree = tw.trait<{ y: number }>(Transform, w).y;
    expect(yFree).toBeLessThan(yHeld - 1);  // joint gone → free-falls past the old limit
  });
});

describe('physics3D joints — hinge / slider / motor (axis, limits, drive)', () => {
  it('revolute hinge constrains the bob to a plane (unlike spherical)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'pivot', 0, 5, 0);
    const bob = weight(tw, 'bob', 2, 5, 0);
    // Hinge about the world Z axis at the pivot → the bob may only swing in the XY plane.
    tw.spawn(Joint3D({ type: 'revolute', entityA: 'pivot', entityB: 'bob', axisX: 0, axisY: 0, axisZ: 1, anchorBX: -2 }));

    tw.step(400);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, bob);
    expect(tf.z).toBeCloseTo(0, 2);                          // motion stays in-plane (hinge axis)
    expect(Math.hypot(tf.x, tf.y - 5, tf.z)).toBeCloseTo(2, 0);  // link length preserved
    expect(tf.y).toBeLessThan(4);                            // swung down
  });

  it('prismatic slider with a limit stops the body at the travel end', () => {
    tw = createTestWorld({ systems: [PHYS] });
    gravityWorld(tw);
    anchor(tw, 'anchor', 0, 5, 0);
    const slider = weight(tw, 'slider', 0, 5, 0);            // coincident at start
    // Slide along world -Y under gravity, limited to [-2, 0] → rests 2 below the start.
    tw.spawn(Joint3D({
      type: 'prismatic', entityA: 'anchor', entityB: 'slider',
      axisX: 0, axisY: 1, axisZ: 0, limitsEnabled: true, limitMin: -2, limitMax: 0,
    }));

    tw.step(300);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, slider);
    expect(tf.y).toBeCloseTo(3, 1);   // 5 - 2 (travel limit)
    expect(tf.x).toBeCloseTo(0, 2);   // locked off-axis
    expect(tf.z).toBeCloseTo(0, 2);
  });

  it('revolute velocity motor drives continuous spin toward the target rate', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));   // no gravity — isolate the motor
    anchor(tw, 'axle', 0, 0, 0);
    const wheel = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', angularDamping: 0 }),
      Collider3D({ shape: 'box', halfW: 1, halfH: 1, halfD: 0.2 }),
      EntityAttributes({ guid: 'wheel', name: 'wheel' }),
    );
    // Hinge about Z, velocity motor targeting 5 rad/s.
    tw.spawn(Joint3D({
      type: 'revolute', entityA: 'axle', entityB: 'wheel', axisX: 0, axisY: 0, axisZ: 1,
      motorEnabled: true, motorTargetVel: 5, motorStiffness: 0, motorDamping: 2,
    }));

    tw.step(240);
    const avz = tw.trait<{ avz: number }>(RigidBody3D, wheel).avz;
    expect(avz).toBeGreaterThan(3);   // motor drove it up toward 5 rad/s
    expect(avz).toBeLessThan(6);
  });
});
