/** CCD (continuous collision detection) — proves a fast, thin-passing body does NOT
 *  tunnel through a thin static wall when `RigidBody2D.ccd` is on, and DOES tunnel when
 *  it's off (the plan's Phase-4 on/off diff). Gravity is zeroed so the only motion is the
 *  ball's horizontal launch velocity — isolating the discrete-vs-continuous solver step. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';

beforeAll(async () => { await initRapier2D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

/** Launch a small ball rightward at high speed toward a thin wall at x=300.
 *  Returns the ball's resting/there x after stepping. */
function launch(ccd: boolean): number {
  tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
  tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
  // Thin wall (6 units wide) centered at x=300, tall enough to block any y.
  tw.spawn(Transform({ x: 300, y: 0 }), RigidBody2D({ bodyType: 'static' }),
    Collider2D({ shape: 'box', halfW: 3, halfH: 300 }));
  // Tiny, very fast ball: 500 units/step (30000 u/s ÷ 60). Discrete samples land at
  // 0, 500, 1000, … — none inside the wall's [294,306] overlap zone — so a discrete
  // step jumps clean over it. CCD sweeps the motion and catches it.
  const ball = tw.spawn(Transform({ x: 0, y: 0 }),
    RigidBody2D({ bodyType: 'dynamic', vx: 30000, gravityScale: 0, ccd }),
    Collider2D({ shape: 'circle', radius: 3 }));
  tw.step(20);
  return tw.trait<{ x: number }>(Transform, ball).x;
}

describe('physics2D — CCD anti-tunneling', () => {
  it('a fast ball tunnels through a thin wall with CCD off', () => {
    expect(launch(false)).toBeGreaterThan(400); // sailed clean through past x=300
  });

  it('a fast ball is stopped by the thin wall with CCD on', () => {
    expect(launch(true)).toBeLessThan(300); // blocked on the near side of the wall
  });
});
