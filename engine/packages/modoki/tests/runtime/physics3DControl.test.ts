import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import {
  physics3DSystem, disposePhysics3D,
  applyImpulse3D, applyTorqueImpulse3D, setLinvel3D, setAngvel3D,
} from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

function world0g(t: TestWorld) {
  // Zero gravity so the control API's effect is isolated from falling.
  t.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0, unitsPerMeter: 1 }));
}

describe('physics3D control API — impulses, forces, velocity', () => {
  it('applyImpulse3D kicks a resting body (no-op before the body exists, then works)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );
    // Body doesn't exist until the system's first tick — the call is a safe no-op.
    expect(applyImpulse3D(tw.world, box, 0, 10, 0)).toBe(false);
    tw.step(1);                                    // creates the Rapier body
    expect(applyImpulse3D(tw.world, box, 0, 10, 0)).toBe(true);
    tw.step(30);
    const tf = tw.trait<{ y: number }>(Transform, box);
    const rb = tw.trait<{ vy: number }>(RigidBody3D, box);
    expect(rb.vy).toBeGreaterThan(0);              // moving up from the impulse
    expect(tf.y).toBeGreaterThan(0.1);
  });

  it('setLinvel3D sets velocity directly in world units/s', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.5 }),
    );
    tw.step(1);
    setLinvel3D(tw.world, box, 5, 0, 0);
    tw.step(1);
    const rb = tw.trait<{ vx: number }>(RigidBody3D, box);
    expect(rb.vx).toBeCloseTo(5, 3);               // exactly what we set (upm = 1)
    tw.step(30);
    expect(tw.trait<{ x: number }>(Transform, box).x).toBeGreaterThan(2);
  });

  it('applyTorqueImpulse3D and setAngvel3D spin a body', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );
    tw.step(1);
    setAngvel3D(tw.world, box, 0, 3, 0);
    tw.step(1);
    expect(tw.trait<{ avy: number }>(RigidBody3D, box).avy).toBeCloseTo(3, 2);
    applyTorqueImpulse3D(tw.world, box, 0, 5, 0);  // add more spin about Y
    tw.step(1);
    expect(tw.trait<{ avy: number }>(RigidBody3D, box).avy).toBeGreaterThan(3);
  });
});

describe('physics3D per-axis locks', () => {
  it('lockTransY freezes vertical motion under gravity (body slides but never falls)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    const box = tw.spawn(
      Transform({ x: 0, y: 5, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic', lockTransY: true }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );
    tw.step(120);
    expect(tw.trait<{ y: number }>(Transform, box).y).toBeCloseTo(5, 4);  // Y locked — no fall
  });

  it('per-axis rotation lock: only the unlocked axis spins', () => {
    tw = createTestWorld({ systems: [PHYS] });
    world0g(tw);
    const box = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      // Lock X and Z rotation; only Y (yaw) free.
      RigidBody3D({ bodyType: 'dynamic', lockRotX: true, lockRotZ: true }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );
    tw.step(1);
    // Torque about all three axes — only Y should take.
    applyTorqueImpulse3D(tw.world, box, 4, 4, 4);
    tw.step(2);
    const rb = tw.trait<{ avx: number; avy: number; avz: number }>(RigidBody3D, box);
    expect(rb.avx).toBeCloseTo(0, 4);
    expect(rb.avz).toBeCloseTo(0, 4);
    expect(Math.abs(rb.avy)).toBeGreaterThan(0.1);
  });
});
