/** Reconcile + lifecycle edge cases for the 3D system — the 3D counterparts of the 2D core
 *  suite: generation guard on recycled ids, world rebuild after all bodies removed, mid-scene
 *  hot edits (restitution / shape swap / collider removal), and sensor no-solver-response.
 *  3D is Y-up → gravity pulls toward −Y, "down" is decreasing y. */
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

const newWorld = () => createTestWorld({ systems: [{ name: 'p', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS }] });
const grav = (y = -20) => tw!.spawn(Physics3D({ gravityX: 0, gravityY: y, gravityZ: 0 }));

describe('physics3D — Percept isSleeping read-back (S5)', () => {
  it('reports a falling body awake and a settled body asleep', () => {
    tw = newWorld();
    grav();
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 20, halfH: 0.2, halfD: 20 }));
    const box = tw.spawn(Transform({ x: 0, y: 4, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.3, halfH: 0.3, halfD: 0.3, restitution: 0 }));
    tw.step(3); // still falling
    expect(tw.trait<{ isSleeping: boolean }>(RigidBody3D, box).isSleeping).toBe(false);
    tw.step(400); // settle on the floor + let the solver put it to sleep
    expect(tw.trait<{ isSleeping: boolean }>(RigidBody3D, box).isSleeping).toBe(true);
  });
});

describe('physics3D — reconcile + lifecycle', () => {
  it('does not let a recycled entity id adopt the previous body (generation guard)', () => {
    tw = newWorld();
    grav();
    const a = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));
    tw.step(30);                       // 'a' falls away
    (a as unknown as { destroy(): void }).destroy();
    // A new entity likely reuses a's id (koota recycles) with a bumped generation.
    const b = tw.spawn(Transform({ x: 3, y: 5, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));
    tw.step(1);
    // b must start from ITS authored x=3 — not adopt a's simulated pose (~x=0).
    expect(tw.trait<{ x: number }>(Transform, b).x).toBeCloseTo(3, 3);
  });

  it('rebuilds cleanly after every physics entity is removed then a new one added', () => {
    tw = newWorld();
    grav();
    const a = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));
    tw.step(10);
    (a as unknown as { destroy(): void }).destroy();
    tw.step(2);   // zero-body early-out → world disposed
    const b = tw.spawn(Transform({ x: 0, y: 5, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));
    tw.step(60);
    expect(tw.trait<{ y: number }>(Transform, b).y).toBeLessThan(5);   // fell (world rebuilt)
  });

  it('a restitution edit mid-fall takes effect on the next impact', () => {
    tw = newWorld();
    grav();
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 20, halfH: 0.2, halfD: 20, restitution: 0.9 }));
    const ball = tw.spawn(Transform({ x: 0, y: 4, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2, restitution: 0 }));   // non-bouncy at first
    tw.step(20);                                   // still falling, above the floor
    ball.set(Collider3D, { restitution: 0.9 });    // make it bouncy mid-fall (hot edit)
    tw.step(25);
    let peak = tw.trait<{ y: number }>(Transform, ball).y;
    for (let i = 0; i < 150; i++) { tw.step(1); const y = tw.trait<{ y: number }>(Transform, ball).y; if (y > peak) peak = y; }
    // The edit took effect → the ball rebounded high (up = +Y). Without it, it rests near y≈0.4.
    expect(peak).toBeGreaterThan(1.5);
  });

  it('a sensor emits sensor events (not collision) and applies no solver response', () => {
    tw = newWorld();
    grav();
    const zone = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.3, halfD: 5, isSensor: true }));
    const box = tw.spawn(Transform({ x: 0, y: 4, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));
    tw.step(120);
    const sensorEvents = tw.events({ type: '@sensor' });
    expect(sensorEvents.length).toBeGreaterThanOrEqual(1);
    const evt = sensorEvents[0].payload as { sensor: number; other: number };
    expect(evt.sensor).toBe(zone.id());
    expect(evt.other).toBe(box.id());
    expect(tw.trait<{ y: number }>(Transform, box).y).toBeLessThan(0);   // fell straight through
    expect(tw.events({ type: '@collision' })).toHaveLength(0);            // sensors never collide
  });

  it("removing a floor's Collider3D drops the body resting on it", () => {
    tw = newWorld();
    grav();
    const floor = tw.spawn(Transform({ x: 0, y: -3, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.2, halfD: 5 }));
    const ball = tw.spawn(Transform({ x: 0, y: 2, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));
    tw.step(150);
    const yRest = tw.trait<{ y: number }>(Transform, ball).y;
    expect(yRest).toBeGreaterThan(-3);                                       // resting on the floor
    (floor as unknown as { remove(t: unknown): void }).remove(Collider3D);   // floor rebuilt w/o collider
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, ball).y).toBeLessThan(yRest - 1);   // fell through
  });

  it('swapping the collider shape changes contact behavior', () => {
    tw = newWorld();
    grav();
    // Floor with a 0.6-wide gap in the middle (two static boxes; inner edges at x=∓0.3).
    for (const fx of [-1.3, 1.3]) {
      tw.spawn(Transform({ x: fx, y: -3, z: 0 }), RigidBody3D({ bodyType: 'static' }),
        Collider3D({ shape: 'box', halfW: 1, halfH: 0.2, halfD: 5 }));
    }
    // A WIDE box bridges the gap and rests; then swap to a small sphere that slips through.
    const obj = tw.spawn(Transform({ x: 0, y: 2, z: 0 }), RigidBody3D({ bodyType: 'dynamic', fixedRotation: true }),
      Collider3D({ shape: 'box', halfW: 0.6, halfH: 0.15, halfD: 0.6 }));
    tw.step(120);
    const yBridged = tw.trait<{ y: number }>(Transform, obj).y;
    expect(yBridged).toBeGreaterThan(-3);                                    // bridged across the gap
    (obj as unknown as { set(t: unknown, v: unknown): void }).set(Collider3D, { shape: 'sphere', radius: 0.12 });
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, obj).y).toBeLessThan(yBridged - 0.5);   // slipped through
  });
});

describe('physics3D — kinematic bodies', () => {
  it('a kinematic body ignores gravity and stays solid for a dynamic body to rest on', () => {
    tw = newWorld();
    grav();
    const floor = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'kinematic' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.2, halfD: 5 }));
    const ball = tw.spawn(Transform({ x: 0, y: 2, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.3 }));
    tw.step(120);
    expect(tw.trait<{ y: number }>(Transform, floor).y).toBeCloseTo(0, 3);   // kinematic ignores gravity
    expect(tw.trait<{ y: number }>(Transform, ball).y).toBeGreaterThan(0);   // rests on it (solid)
  });

  it('a kinematic platform driven by its Transform carries a resting dynamic body up', () => {
    tw = newWorld();
    grav();
    const floor = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'kinematic' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.2, halfD: 5, friction: 1 }));
    const ball = tw.spawn(Transform({ x: 0, y: 1, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.3, friction: 1 }));
    tw.step(60);                                             // let the ball settle on the platform
    const yStart = tw.trait<{ y: number }>(Transform, ball).y;
    for (let i = 1; i <= 60; i++) {                          // drive the platform upward
      (floor as unknown as { set(t: unknown, v: unknown): void }).set(Transform, { x: 0, y: i * 0.03, z: 0 });
      tw.step(1);
    }
    expect(tw.trait<{ y: number }>(Transform, floor).y).toBeCloseTo(1.8, 1);   // platform moved up
    expect(tw.trait<{ y: number }>(Transform, ball).y).toBeGreaterThan(yStart + 1);   // ball rode up with it
  });
});
