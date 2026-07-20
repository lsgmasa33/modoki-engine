/** Primitive collider shapes — capsule / cylinder / cone (box + sphere are exercised throughout
 *  the other suites). Each is built as a dynamic body dropped onto a static floor: it must come to
 *  rest ABOVE the floor (the shape produced a real collider — no NaN, no fall-through), and as a
 *  static floor it must catch a falling ball. Confirms makeColliderDesc wires every primitive. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';

beforeAll(async () => { await initRapier3D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics3D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'p', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };
const SHAPES: Array<Record<string, unknown>> = [
  { shape: 'capsule', radius: 0.3, halfHeight: 0.4 },
  { shape: 'cylinder', radius: 0.3, halfHeight: 0.4 },
  { shape: 'cone', radius: 0.3, halfHeight: 0.4 },
];

describe('physics3D — primitive collider shapes', () => {
  for (const s of SHAPES) {
    it(`${s.shape} dynamic body falls and rests on a floor (no NaN / fall-through)`, () => {
      tw = createTestWorld({ systems: [PHYS] });
      tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
      tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
        Collider3D({ shape: 'box', halfW: 5, halfH: 0.2, halfD: 5 }));
      const b = tw.spawn(Transform({ x: 0, y: 3, z: 0 }), RigidBody3D({ bodyType: 'dynamic', angularDamping: 2 }),
        Collider3D(s));
      tw.step(180);
      const tf = tw.trait<{ x: number; y: number; z: number }>(Transform, b);
      expect(Number.isFinite(tf.y)).toBe(true);      // no NaN blow-up
      expect(tf.y).toBeGreaterThan(0);               // came to rest above the floor top (y≈0.2)
      expect(tf.y).toBeLessThan(3);                  // actually fell (didn't hang in the air)
    });
  }

  it('a cylinder static floor catches a falling ball', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'cylinder', radius: 3, halfHeight: 0.3 }));
    const ball = tw.spawn(Transform({ x: 0, y: 3, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.3 }));
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, ball).y).toBeGreaterThan(0);   // caught, not through
  });
});
