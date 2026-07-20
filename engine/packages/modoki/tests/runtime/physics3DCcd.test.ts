/** CCD (continuous collision detection) — a fast, thin body tunnels through a thin static wall
 *  with `RigidBody3D.ccd` off and is stopped with it on. Gravity is zeroed so the only motion is
 *  the ball's +X launch velocity, isolating the discrete-vs-continuous solver step. */
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

/** Launch a tiny fast ball toward a thin wall at x=3. Returns its x after stepping.
 *  30 u/s ÷ 60 ≈ 5 u/step, so discrete samples land at 0,5,10,… — none inside the wall's
 *  thin [2.95,3.05] slab, so a discrete step jumps clean over it; CCD sweeps and catches it. */
function launch(ccd: boolean): number {
  tw = createTestWorld({ systems: [{ name: 'p', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
  tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));
  tw.spawn(Transform({ x: 3, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
    Collider3D({ shape: 'box', halfW: 0.05, halfH: 3, halfD: 3 }));   // thin in X, tall+deep
  const ball = tw.spawn(Transform({ x: 0, y: 0, z: 0 }),
    RigidBody3D({ bodyType: 'dynamic', vx: 300, gravityScale: 0, ccd }),
    Collider3D({ shape: 'sphere', radius: 0.05 }));
  tw.step(20);
  return tw.trait<{ x: number }>(Transform, ball).x;
}

describe('physics3D — CCD anti-tunneling', () => {
  it('a fast ball tunnels through a thin wall with CCD off', () => {
    expect(launch(false)).toBeGreaterThan(4);   // sailed clean through past x=3
  });

  it('a fast ball is stopped by the thin wall with CCD on', () => {
    expect(launch(true)).toBeLessThan(3);        // blocked on the near side of the wall
  });
});
