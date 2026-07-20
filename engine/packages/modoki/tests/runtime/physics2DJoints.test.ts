/** Joint2D behavior — headless via createTestWorld + real Rapier. Joints reference
 *  bodies by GUID (EntityAttributes.guid), resolved by findEntityByGuid. Asserts on
 *  trait state (positions / preserved distances), never pixels. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { Joint2D } from '../../src/runtime/traits/Joint2D';
import { Collider2D as ColliderTrait } from '../../src/runtime/traits/Collider2D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';

beforeAll(async () => { await initRapier2D(); });

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

function newWorld(gravityY = 0) {
  const t = createTestWorld({
    systems: [{ name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }],
  });
  t.spawn(Physics2D({ gravityX: 0, gravityY, pixelsPerMeter: 100 }));
  return t;
}

function body(t: TestWorld, guid: string, x: number, y: number, type: 'dynamic' | 'static' | 'kinematic' = 'dynamic') {
  return t.spawn(
    EntityAttributes({ guid }),
    Transform({ x, y }),
    RigidBody2D({ bodyType: type }),
    Collider2D({ shape: 'circle', radius: 10, density: 1 }),
  );
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('Joint2D — rope', () => {
  it('limits the bob to the rope length under gravity', () => {
    tw = newWorld(9.81);
    body(tw, 'anchor', 0, 0, 'static');
    const bob = body(tw, 'bob', 0, 50); // starts within the 100-unit rope
    tw.spawn(Joint2D({ type: 'rope', entityA: 'anchor', entityB: 'bob', length: 100 }));
    tw.step(240);
    const p = tw.trait<{ x: number; y: number }>(Transform, bob);
    // Falls until the rope goes taut, then hangs ~100 units below the anchor.
    expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(100, 0);
    expect(p.y).toBeGreaterThan(0); // hangs below (screen +Y = down)
  });
});

describe('Joint2D — revolute (hinge)', () => {
  it('pins the bob so it swings while preserving the arm length', () => {
    tw = newWorld(9.81);
    body(tw, 'anchor', 0, 0, 'static');
    const bob = body(tw, 'bob', 100, 0); // arm points along +X initially
    // anchorB = (-100,0) so B's anchor point sits on A's origin.
    tw.spawn(Joint2D({ type: 'revolute', entityA: 'anchor', entityB: 'bob', anchorAX: 0, anchorAY: 0, anchorBX: -100, anchorBY: 0 }));
    tw.step(40);
    const p = tw.trait<{ x: number; y: number }>(Transform, bob);
    expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(100, 0); // rigid arm
    expect(p.y).toBeGreaterThan(1); // swung downward under gravity
  });
});

describe('Joint2D — spring', () => {
  it('pulls the bob toward the rest length', () => {
    tw = newWorld(0);
    body(tw, 'anchor', 0, 0, 'static');
    const bob = body(tw, 'bob', 300, 0); // far from the 100-unit rest length
    tw.spawn(Joint2D({ type: 'spring', entityA: 'anchor', entityB: 'bob', length: 100, stiffness: 60, damping: 4 }));
    tw.step(400);
    const p = tw.trait<{ x: number; y: number }>(Transform, bob);
    expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(100, 0);
  });
});

describe('Joint2D — fixed (weld)', () => {
  it('rigidly carries body B when kinematic body A moves', () => {
    tw = newWorld(0);
    const a = body(tw, 'a', 0, 0, 'kinematic');
    const b = body(tw, 'b', 50, 0); // 50 to the right of A at weld time
    // Weld B's anchor point (its origin shifted by -50) onto A's origin, so the fixed
    // joint holds the 50-unit offset instead of collapsing the two origins together.
    tw.spawn(Joint2D({ type: 'fixed', entityA: 'a', entityB: 'b', anchorBX: -50 }));
    tw.step(1); // establish the weld
    // Drive A rightward gradually; B should ride along at the same offset.
    for (let i = 1; i <= 60; i++) { a.set(Transform, { x: i * 3 }); tw.step(1); }
    const pa = tw.trait<{ x: number; y: number }>(Transform, a);
    const pb = tw.trait<{ x: number; y: number }>(Transform, b);
    expect(pa.x).toBeCloseTo(180, 0);
    expect(pb.x - pa.x).toBeCloseTo(50, 0); // offset preserved
    expect(pb.y).toBeCloseTo(0, 0);
  });
});

describe('Joint2D — revolute motor', () => {
  it('drives the hinge toward a target angle (position motor)', () => {
    tw = newWorld(0);
    body(tw, 'anchor', 0, 0, 'static');
    const bob = body(tw, 'bob', 100, 0);
    tw.spawn(Joint2D({
      type: 'revolute', entityA: 'anchor', entityB: 'bob', anchorBX: -100, anchorBY: 0,
      motorEnabled: true, motorTargetPos: Math.PI / 2, motorStiffness: 5000, motorDamping: 100,
    }));
    tw.step(300);
    const p = tw.trait<{ x: number; y: number }>(Transform, bob);
    // Motor rotated the arm ~90° from +X: it now points roughly along ±Y (x≈0), arm preserved.
    expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(100, 0);
    expect(Math.abs(p.x)).toBeLessThan(20);
    expect(Math.abs(p.y)).toBeGreaterThan(80);
  });
});

describe('Joint2D — multi-joint body rebuild (review Finding 1)', () => {
  it('keeps BOTH joints when a body carrying two of them is rebuilt', () => {
    tw = newWorld(0);
    body(tw, 'q1', -200, 0, 'static');
    body(tw, 'q2', 200, 0, 'static');
    const b = body(tw, 'b', 0, 0); // dynamic, pulled equally by two opposing springs
    tw.spawn(Joint2D({ type: 'spring', entityA: 'q1', entityB: 'b', length: 100, stiffness: 40, damping: 3 }));
    tw.spawn(Joint2D({ type: 'spring', entityA: 'q2', entityB: 'b', length: 100, stiffness: 40, damping: 3 }));
    tw.step(200);
    expect(Math.abs(tw.trait<{ x: number }>(Transform, b).x)).toBeLessThan(20); // balanced at center

    // Force a structural rebuild of B (collider dims change) — Rapier auto-removes B's
    // joints; the reconciler must recreate BOTH (the bug destroyed one via handle reuse).
    b.set(ColliderTrait, { radius: 25 });
    tw.step(200);
    // Still balanced at center → both springs survived. If one were lost, the surviving
    // spring would drag B ~100 units toward its anchor.
    expect(Math.abs(tw.trait<{ x: number }>(Transform, b).x)).toBeLessThan(20);
  });
});

describe('Joint2D — deferred activation & teardown', () => {
  it('activates only once both endpoints exist, and survives an endpoint despawn', () => {
    tw = newWorld(9.81);
    body(tw, 'anchor', 0, 0, 'static');
    tw.spawn(Joint2D({ type: 'rope', entityA: 'anchor', entityB: 'bob', length: 100 }));
    tw.step(30); // 'bob' does not exist yet — joint inert, no crash
    const bob = body(tw, 'bob', 0, 50);
    tw.step(240);
    expect(dist(tw.trait<{ x: number; y: number }>(Transform, bob), { x: 0, y: 0 })).toBeCloseTo(100, 0);
    // Despawn the bob — the joint must tear down cleanly on the next tick.
    (bob as unknown as { destroy(): void }).destroy();
    expect(() => tw!.step(5)).not.toThrow();
  });
});

describe('Joint2D — prismatic (T3)', () => {
  it('constrains the body to slide only along its axis', () => {
    tw = newWorld(20);                                   // gravity down
    body(tw, 'anchor', 0, 0, 'static');
    const b = body(tw, 'slider', 0, 40, 'dynamic');      // offset so the circles don't overlap
    tw.spawn(EntityAttributes({ guid: 'j' }),
      Joint2D({ type: 'prismatic', entityA: 'anchor', entityB: 'slider', axisX: 0, axisY: 1 }));
    tw.step(150);
    const p = tw.trait<{ x: number; y: number }>(Transform, b);
    expect(Math.abs(p.x)).toBeLessThan(3);               // locked to the axis (no X drift)
    expect(p.y).toBeGreaterThan(70);                     // slid DOWN the axis under gravity (from y=40)
  });

  it('respects prismatic limits (clamps travel vs a free slider)', () => {
    const slideY = (limited: boolean): number => {
      const t = newWorld(20);
      body(t, 'anchor', 0, 0, 'static');
      const b = body(t, 'slider', 0, 40, 'dynamic');
      t.spawn(EntityAttributes({ guid: 'j' }), Joint2D({
        type: 'prismatic', entityA: 'anchor', entityB: 'slider', axisX: 0, axisY: 1,
        ...(limited ? { limitsEnabled: true, limitMin: -20, limitMax: 20 } : {}),
      }));
      t.step(240);
      const y = t.trait<{ y: number }>(Transform, b).y;
      disposePhysics2D(t.world); t.dispose();
      return y;
    };
    const free = slideY(false);
    const clamped = slideY(true);
    expect(clamped).toBeLessThan(free - 30);             // the limit stopped it well short of free travel
  });
});

describe('Joint2D — revolute limits (T3)', () => {
  it('clamps the swing short of free (and executes the min/max angle swap)', () => {
    const swingRz = (limited: boolean): number => {
      const t = newWorld(40);                            // strong gravity to reach equilibrium/limit
      // Hinge is a SENSOR so it doesn't physically block the arm that overlaps the pivot.
      t.spawn(EntityAttributes({ guid: 'hinge' }), Transform({ x: 0, y: 0 }),
        RigidBody2D({ bodyType: 'static' }), ColliderTrait({ shape: 'circle', radius: 5, isSensor: true }));
      const arm = t.spawn(EntityAttributes({ guid: 'arm' }), Transform({ x: 60, y: 0 }),
        RigidBody2D({ bodyType: 'dynamic', angularDamping: 0.4 }),
        ColliderTrait({ shape: 'box', halfW: 60, halfH: 6, density: 1 }));
      t.spawn(EntityAttributes({ guid: 'j' }), Joint2D({
        type: 'revolute', entityA: 'hinge', entityB: 'arm',
        anchorAX: 0, anchorAY: 0, anchorBX: -60, anchorBY: 0,
        ...(limited ? { limitsEnabled: true, limitMin: -0.5, limitMax: 0.5 } : {}),
      }));
      t.step(400);
      const rz = Math.abs(t.trait<{ rz: number }>(Transform, arm).rz);
      disposePhysics2D(t.world); t.dispose();
      return rz;
    };
    const free = swingRz(false);
    const clamped = swingRz(true);
    expect(free).toBeGreaterThan(0.8);                   // free arm swings well past the ±0.5 limit
    expect(clamped).toBeGreaterThan(0.35);               // reached the limit on the allowed side (swap→stuck at 0)
    expect(clamped).toBeLessThan(0.7);                   // clamped at ~0.5 (limit engaged, not free)
  });
});
