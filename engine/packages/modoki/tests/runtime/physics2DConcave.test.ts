/** Dynamic concave shapes via convex decomposition (Phase 4.4). A `concave` collider
 *  decomposes its point list into convex pieces (poly-decomp) so a genuine concave solid
 *  works in the solver — proven by a U-shaped cup that CATCHES a ball inside its cavity,
 *  where the same points as a convex `polygon` (hull) would leave the ball sitting on top. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';
import { decomposeConcaveToPhys } from '../../src/runtime/systems/concaveDecomp';

// A U/cup opening toward -Y (screen up): solid bottom + two side walls, hollow middle.
const CUP = '[[-100,-100],[-60,-100],[-60,60],[60,60],[60,-100],[100,-100],[100,100],[-100,100]]';

describe('concaveDecomp — decomposeConcaveToPhys', () => {
  it('splits a concave U into multiple convex pieces', () => {
    const pieces = decomposeConcaveToPhys(CUP, 100);
    expect(pieces).not.toBeNull();
    expect(pieces!.length).toBeGreaterThan(1);            // a U is not convex → >1 piece
  });
  it('returns null for too-few points (falls back to hull)', () => {
    expect(decomposeConcaveToPhys('[[0,0],[10,0],[5,10]]', 100)).toBeNull();
  });
});

describe('physics2D — concave collider catches a ball a hull would not', () => {
  beforeAll(async () => { await initRapier2D(); });
  let tw: TestWorld | undefined;
  afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

  function dropIntoCup(shape: 'concave' | 'polygon'): number {
    tw = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape, points: CUP, friction: 0.6 }));
    const ball = tw.spawn(Transform({ x: 0, y: -250 }),
      RigidBody2D({ bodyType: 'dynamic', angularDamping: 0.5 }),
      Collider2D({ shape: 'circle', radius: 30, friction: 0.6 }));
    tw.step(240);
    return tw.trait<{ y: number }>(Transform, ball).y;
  }

  it('the concave cup holds the ball inside (y>0); the convex hull leaves it on top (y<0)', () => {
    const inside = dropIntoCup('concave');   // rests on the cavity floor (~y=30)
    const onTop = dropIntoCup('polygon');    // hull fills the cup → ball sits on top (~y=-130)
    expect(inside).toBeGreaterThan(0);
    expect(onTop).toBeLessThan(-50);
    expect(inside).toBeGreaterThan(onTop + 100);
  });
});

describe('physics2D — concave decompose-failure fallback (T6)', () => {
  beforeAll(async () => { await initRapier2D(); });
  let tw2: TestWorld | undefined;
  afterEach(() => { if (tw2) { disposePhysics2D(tw2.world); tw2.dispose(); tw2 = undefined; } });

  it('an un-decomposable concave shape falls back to a convex hull that still collides', async () => {
    const { vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      tw2 = createTestWorld({ systems: [{ name: 'p', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
      tw2.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
      // 3 points → can't be concave/decomposed → makeColliderDesc falls back to a convex hull.
      tw2.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
        Collider2D({ shape: 'concave', points: '[[-100,0],[100,0],[0,-60]]', friction: 0.6 }));
      const ball = tw2.spawn(Transform({ x: 0, y: -200 }),
        RigidBody2D({ bodyType: 'dynamic', angularDamping: 0.5 }),
        Collider2D({ shape: 'circle', radius: 20, friction: 0.6 }));
      tw2.step(240);
      // Caught on the hull (not fallen to +∞) — proves the fallback produced a real collider.
      expect(tw2.trait<{ y: number }>(Transform, ball).y).toBeLessThan(50);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('convex hull'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
