import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { CharacterController3D } from '../../src/runtime/traits/CharacterController3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

// Floor top at y=0.5; a capsule character (halfHeight 0.5 + radius 0.3 = 0.8 half-extent)
// rests with its center at ~1.3. Returns the character entity.
function scene(t: TestWorld, startY = 5) {
  t.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));
  t.spawn(
    Transform({ x: 0, y: 0, z: 0 }),
    RigidBody3D({ bodyType: 'static' }),
    Collider3D({ shape: 'box', halfW: 20, halfH: 0.5, halfD: 20, friction: 0.8 }),
  );
  return t.spawn(
    Transform({ x: 0, y: startY, z: 0 }),
    RigidBody3D({ bodyType: 'kinematic' }),
    Collider3D({ shape: 'capsule', radius: 0.3, halfHeight: 0.5 }),
    CharacterController3D({ speed: 5, jumpSpeed: 6 }),
  );
}
const cc = (e: Entity) => e.get(CharacterController3D) as { grounded: boolean; velY: number; readbackReady: boolean };
const pos = (t: TestWorld, e: Entity) => t.trait<{ x: number; y: number; z: number }>(Transform, e);

describe('CharacterController3D', () => {
  it('falls under gravity and comes to rest grounded on the floor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const c = scene(tw, 5);
    tw.step(180);
    const tf = pos(tw, c);
    expect(tf.y).toBeGreaterThan(1.2);
    expect(tf.y).toBeLessThan(1.5);      // floor top 0.5 + capsule half-extent 0.8
    expect(cc(c).grounded).toBe(true);
    expect(cc(c).readbackReady).toBe(true);
  });

  it('walks horizontally on the XZ plane when moveX/moveZ are set', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const c = scene(tw, 2);
    tw.step(120);                        // land first
    expect(cc(c).grounded).toBe(true);
    const x0 = pos(tw, c).x;
    c.set(CharacterController3D, { moveX: 1, moveZ: 0.5 });
    tw.step(60);                         // ~1s of walking
    const tf = pos(tw, c);
    expect(tf.x - x0).toBeGreaterThan(3);   // moved +X at speed 5
    expect(tf.z).toBeGreaterThan(1);        // and +Z
    expect(cc(c).grounded).toBe(true);      // stayed on the ground
  });

  it('jumps when grounded (and a jump pressed airborne is ignored)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const c = scene(tw, 2);
    tw.step(120);
    const yGround = pos(tw, c).y;
    c.set(CharacterController3D, { jump: true });
    tw.step(1);
    expect(cc(c).velY).toBeGreaterThan(0);      // launched up
    tw.step(15);
    expect(pos(tw, c).y).toBeGreaterThan(yGround + 0.3);  // rose off the ground
    // A jump while airborne is dropped: request it mid-air, velY should keep falling, not spike.
    c.set(CharacterController3D, { jump: true });
    const vBefore = cc(c).velY;
    tw.step(1);
    expect(cc(c).velY).toBeLessThan(vBefore);   // still under gravity, no second launch
  });

  it('applies each character its own collision skin/offset (setOffset regression)', () => {
    // Two characters sharing the one KinematicCharacterController but with very different skins.
    // A larger skin keeps a larger gap, so the big-skin character must rest higher. Before the
    // setOffset fix, the second character reused the first's offset and rested at the same height.
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0, unitsPerMeter: 1 }));
    tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 20, halfH: 0.5, halfD: 20, friction: 0.8 }),
    );
    const mk = (x: number, skin: number) => tw!.spawn(
      Transform({ x, y: 3, z: 0 }),
      RigidBody3D({ bodyType: 'kinematic' }),
      Collider3D({ shape: 'capsule', radius: 0.3, halfHeight: 0.5 }),
      CharacterController3D({ speed: 5, jumpSpeed: 6, skin }),
    );
    const thin = mk(-3, 0.02);
    const thick = mk(3, 0.4);
    tw.step(180);
    const yThin = pos(tw, thin).y;
    const yThick = pos(tw, thick).y;
    expect(cc(thin).grounded).toBe(true);
    expect(cc(thick).grounded).toBe(true);
    expect(yThick).toBeGreaterThan(yThin + 0.25);   // the thick-skin character floats higher
  });

  it('honors an external Transform write (teleport/respawn)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    const c = scene(tw, 2);
    tw.step(120);                        // resting near origin
    c.set(Transform, { x: 6, y: 4, z: -3 });   // teleport
    tw.step(1);
    const tf = pos(tw, c);
    expect(tf.x).toBeCloseTo(6, 1);
    expect(tf.z).toBeCloseTo(-3, 1);
    expect(cc(c).velY).toBe(0);          // fall reset on teleport
  });
});
