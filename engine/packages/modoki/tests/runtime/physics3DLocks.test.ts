/** Per-axis translation/rotation locks + fixedRotation + gravityScale — the controls 3D adds
 *  over 2D (2D only has the single fixedRotation flag). Headless via createTestWorld + real
 *  Rapier. 3D is Y-up, so gravity pulls toward −Y. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics3DSystem, disposePhysics3D, applyTorqueImpulse3D } from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };
const box = () => Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 });

describe('physics3D — translation locks', () => {
  it('lockTransY: a body under gravity does NOT fall', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    const b = tw.spawn(Transform({ x: 0, y: 5, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', lockTransY: true }), box());
    tw.step(120);
    expect(tw.trait<{ y: number }>(Transform, b).y).toBeCloseTo(5, 2);   // frozen in Y
  });

  it('lockTransX/Z: diagonal gravity drops it in Y only; X/Z stay frozen', () => {
    // Gravity pulls +X, −Y, +Z. With X and Z translation locked, only the Y component moves it.
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 20, gravityY: -20, gravityZ: 20 }));
    const b = tw.spawn(Transform({ x: 0, y: 5, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', lockTransX: true, lockTransZ: true }), box());
    tw.step(60);
    const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, b);
    expect(tf.x).toBeCloseTo(0, 2);   // X frozen despite gravityX
    expect(tf.z).toBeCloseTo(0, 2);   // Z frozen despite gravityZ
    expect(tf.y).toBeLessThan(4);     // Y free → fell
  });
});

describe('physics3D — rotation locks', () => {
  // Note: `enabledRotations` locks the SOLVER path — a torque induces no rotation about a locked
  // axis (infinite inertia). (A directly-set angular velocity would still integrate; gameplay
  // "don't tip over" is the torque path, which is what these assert.)
  it('fixedRotation: a torque produces no rotation on any axis', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));
    const b = tw.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', fixedRotation: true }), box());
    tw.step(1);
    applyTorqueImpulse3D(tw.world, b, 100, 100, 100);
    tw.step(30);
    const rb = tw.trait<{ avx: number; avy: number; avz: number }>(RigidBody3D, b);
    expect(Math.abs(rb.avx) + Math.abs(rb.avy) + Math.abs(rb.avz)).toBeCloseTo(0, 3);
    const tf = tw.trait<{ rx: number; ry: number; rz: number }>(Transform, b);
    expect(Math.abs(tf.rx) + Math.abs(tf.ry) + Math.abs(tf.rz)).toBeLessThan(0.01);
  });

  it('per-axis rot lock: with X+Y locked, a torque about all axes spins only Z', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));
    const b = tw.spawn(Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', lockRotX: true, lockRotY: true }), box());
    tw.step(1);
    applyTorqueImpulse3D(tw.world, b, 20, 20, 20);   // torque on all three axes
    tw.step(20);
    const rb = tw.trait<{ avx: number; avy: number; avz: number }>(RigidBody3D, b);
    expect(Math.abs(rb.avx)).toBeCloseTo(0, 3);   // X locked
    expect(Math.abs(rb.avy)).toBeCloseTo(0, 3);   // Y locked
    expect(Math.abs(rb.avz)).toBeGreaterThan(0.5);  // Z free → spun
  });
});

describe('physics3D — gravityScale', () => {
  it('scale 0 hovers; scale 2 falls faster than scale 1', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    const hover = tw.spawn(Transform({ x: 0, y: 5, z: 0 }), RigidBody3D({ bodyType: 'dynamic', gravityScale: 0 }), box());
    const slow = tw.spawn(Transform({ x: 2, y: 5, z: 0 }), RigidBody3D({ bodyType: 'dynamic', gravityScale: 1 }), box());
    const fast = tw.spawn(Transform({ x: 4, y: 5, z: 0 }), RigidBody3D({ bodyType: 'dynamic', gravityScale: 2 }), box());
    tw.step(40);
    expect(tw.trait<{ y: number }>(Transform, hover).y).toBeCloseTo(5, 2);       // no gravity
    const ySlow = tw.trait<{ y: number }>(Transform, slow).y;
    const yFast = tw.trait<{ y: number }>(Transform, fast).y;
    expect(ySlow).toBeLessThan(5);          // fell
    expect(yFast).toBeLessThan(ySlow);      // fell further
  });
});
