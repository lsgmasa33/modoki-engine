/** physics2DSystem behavior + determinism — headless via createTestWorld + real Rapier WASM.
 *
 *  Asserts on TRAIT state (final positions) and JOURNAL events (collisions/sensors),
 *  never pixels — exactly the harness contract. Rapier is initialized once in
 *  beforeAll so stepping is deterministic from tick 0. Each test disposes its Rapier
 *  world (WASM memory the GC can't reclaim) before the harness tears the world down. */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import {
  physics2DSystem, raycast2D, shapeCast2D, pointQuery2D, disposePhysics2D,
} from '../../src/runtime/systems/physics2DSystem';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';
import { setCurrentWorld } from '../../src/runtime/ecs/world';
import { setPlayState } from '../../src/runtime/systems/playState';
import { createWorld } from 'koota';

beforeAll(async () => { await initRapier2D(); });

let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { disposePhysics2D(tw.world); tw.dispose(); tw = undefined; }
});

function newWorld() {
  return createTestWorld({
    systems: [{ name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS }],
  });
}

/** A static floor centered at screen y=0 and a dynamic box dropped from above it.
 *  Screen is Y-DOWN, so "above" is a smaller (more negative) y; gravity (+Y) pulls
 *  the box downward toward the floor. Box rests with its bottom on the floor top:
 *  floor top (screen) = 0 - halfH_floor; box center = floortop - halfH_box. */
function dropScene(t: TestWorld) {
  t.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
  t.spawn(
    Transform({ x: 0, y: 0 }),
    RigidBody2D({ bodyType: 'static' }),
    Collider2D({ shape: 'box', halfW: 1000, halfH: 10 }),
  );
  const box = t.spawn(
    Transform({ x: 0, y: -500 }),
    RigidBody2D({ bodyType: 'dynamic' }),
    Collider2D({ shape: 'box', halfW: 25, halfH: 25, restitution: 0 }),
  );
  return box;
}

describe('physics2DSystem — falling & resting', () => {
  it('a dynamic box falls under gravity and comes to rest on a static floor', () => {
    tw = newWorld();
    const box = dropScene(tw);
    tw.step(240);
    const tf = tw.trait<{ x: number; y: number }>(Transform, box);
    // Rests at floor_top(-10) - box_halfH(25) = -35 (screen).
    expect(tf.y).toBeCloseTo(-35, 0);
    expect(tf.x).toBeCloseTo(0, 3); // no lateral drift
  });

  it('emits a collision journal event on contact', () => {
    tw = newWorld();
    const box = dropScene(tw);
    tw.step(240);
    const hits = tw.events({ type: '@collision' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const enter = hits.find((e) => (e.payload as { phase: string }).phase === 'enter');
    expect(enter).toBeDefined();
    const p = enter!.payload as { a: number; b: number };
    expect([p.a, p.b]).toContain(box.id());
  });

  it('gravity is frozen while timeScale is 0 (pause/time-stop)', () => {
    tw = newWorld();
    const box = dropScene(tw);
    tw.setTimeScale(0).step(120);
    const tf = tw.trait<{ y: number }>(Transform, box);
    expect(tf.y).toBeCloseTo(-500, 6); // never moved
  });
});

describe('physics2DSystem — Percept isSleeping read-back (S5)', () => {
  it('reports a falling body awake and a settled body asleep', () => {
    tw = newWorld();
    const box = dropScene(tw);
    tw.step(3); // still falling
    expect(tw.trait<{ isSleeping: boolean }>(RigidBody2D, box).isSleeping).toBe(false);
    tw.step(400); // settle on the floor + let the solver put it to sleep
    expect(tw.trait<{ isSleeping: boolean }>(RigidBody2D, box).isSleeping).toBe(true);
  });
});

describe('physics2DSystem — determinism', () => {
  it('two independent runs produce bit-identical final state', () => {
    const run = () => {
      const t = newWorld();
      const box = dropScene(t);
      t.step(200);
      const { x, y } = t.trait<{ x: number; y: number }>(Transform, box);
      disposePhysics2D(t.world);
      t.dispose();
      return { x, y };
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b); // exact — Rapier f32 is reproducible
  });
});

describe('physics2DSystem — raycast', () => {
  it('hits the resting box from above and returns an upward normal', () => {
    tw = newWorld();
    const box = dropScene(tw);
    tw.step(240); // let the box settle at y≈-35
    // Cast downward (+Y) from well above the box.
    const hit = raycast2D(tw.world, 0, -400, 0, 1, { maxDistance: 1000 });
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe(box.id());
    // Box top is at screen y≈-60; ray from -400 travels ~340 units down.
    expect(hit!.y).toBeCloseTo(-60, 0);
    // Surface normal points UP = screen -Y.
    expect(hit!.ny).toBeLessThan(0);
  });

  it('returns null when nothing is in the ray path', () => {
    tw = newWorld();
    dropScene(tw);
    tw.step(60);
    const miss = raycast2D(tw.world, 5000, -400, 0, 1, { maxDistance: 100 });
    expect(miss).toBeNull();
  });
});

describe('physics2DSystem — reconciler lifecycle', () => {
  it('does not let a recycled entity id adopt the previous body (generation guard)', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    const a = tw.spawn(
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20 }),
    );
    tw.step(30);                       // 'a' falls away from x=0/y=0
    (a as unknown as { destroy(): void }).destroy();
    // A new entity likely reuses a's id (koota recycles) with a bumped generation.
    const b = tw.spawn(
      Transform({ x: 300, y: -100 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20 }),
    );
    tw.step(1);
    const tf = tw.trait<{ x: number; y: number }>(Transform, b);
    // b must start from ITS authored x=300 — not adopt a's simulated pose (~x=0).
    expect(tf.x).toBeCloseTo(300, 3);
  });

  it('rebuilds cleanly after every physics entity is removed then a new one added', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    const a = tw.spawn(
      Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20 }),
    );
    tw.step(10);
    (a as unknown as { destroy(): void }).destroy();
    tw.step(2); // zero-body early-out → world disposed
    // A fresh body falls correctly from its authored position (world rebuilt).
    const b = tw.spawn(
      Transform({ x: 0, y: -500 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20 }),
    );
    tw.step(60);
    const tf = tw.trait<{ y: number }>(Transform, b);
    expect(tf.y).toBeGreaterThan(-500); // it fell (down = +Y)
  });

  it('a paused sim (timeScale 0) does not overwrite external Transform edits', () => {
    tw = newWorld();
    const box = dropScene(tw);
    tw.step(30);                        // let it fall a bit under gravity
    tw.setTimeScale(0);
    box.set(Transform, { x: 777, y: -222 }); // an inspector/script edit while paused
    tw.step(30);
    const tf = tw.trait<{ x: number; y: number }>(Transform, box);
    expect(tf.x).toBeCloseTo(777, 3);   // survived — pull is gated on dt>0
    expect(tf.y).toBeCloseTo(-222, 3);
  });
});

describe('physics2DSystem — polygon & polyline colliders', () => {
  it('a convex polygon collider (static) catches a falling ball', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    // A wide flat-topped convex quad centered at y=0.
    tw.spawn(
      Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'polygon', points: '[[-300,-20],[300,-20],[300,20],[-300,20]]' }),
    );
    const ball = tw.spawn(
      Transform({ x: 0, y: -400 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20 }),
    );
    tw.step(180);
    const tf = tw.trait<{ y: number }>(Transform, ball);
    // Rests atop the quad: top edge y=-20, ball radius 20 → center ≈ -40.
    expect(tf.y).toBeCloseTo(-40, 0);
  });

  it('a static polyline V-trough catches a ball instead of letting it fall through', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    // V shape (Y-down: larger y is lower). Bottom of the V at (0, 200).
    tw.spawn(
      Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'polyline', points: '[[-400,-200],[0,200],[400,-200]]' }),
    );
    const ball = tw.spawn(
      Transform({ x: -50, y: -400 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }),
    );
    tw.step(300);
    const tf = tw.trait<{ y: number }>(Transform, ball);
    // Caught by the trough — never fell past the lowest point of the V (y≈200).
    expect(tf.y).toBeLessThan(210);
    expect(tf.y).toBeGreaterThan(-400); // and it did fall
  });
});

describe('physics2DSystem — shape-cast & point-query', () => {
  function boxScene(t: TestWorld) {
    t.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 })); // no gravity — static test
    return t.spawn(
      Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 100, halfH: 100 }),
    );
  }

  it('shapeCast2D sweeps a circle onto a box and reports the hit entity + distance', () => {
    tw = newWorld();
    const box = boxScene(tw);
    tw.step(1);
    // Sweep a radius-30 circle from above (y=-500) downward (+Y).
    const hit = shapeCast2D(tw.world, 0, -500, 0, 1, 30, { maxDistance: 1000 });
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe(box.id());
    // Box top y=-100; circle radius 30 → contact when center at y≈-130, ~370 units down.
    expect(hit!.distance).toBeCloseTo(370, -1);
    expect(hit!.ny).toBeLessThan(0); // surface normal points up (screen -Y)
  });

  it('pointQuery2D returns the entity under an inside point and null outside', () => {
    tw = newWorld();
    const box = boxScene(tw);
    tw.step(1);
    expect(pointQuery2D(tw.world, 0, 0)).toBe(box.id());     // dead center
    expect(pointQuery2D(tw.world, 50, -50)).toBe(box.id());  // inside
    expect(pointQuery2D(tw.world, 500, 500)).toBeNull();     // far outside
  });
});

describe('physics2DSystem — live material edit (review Finding 2)', () => {
  it('a restitution edit mid-fall takes effect on the next impact', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    // Floor is bouncy; Rapier averages the two colliders' restitution, so the combined
    // value tracks the ball's (0 → 0.9 after the edit).
    tw.spawn(
      Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 1000, halfH: 10, restitution: 0.9 }),
    );
    const ball = tw.spawn(
      Transform({ x: 0, y: -300 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20, restitution: 0 }), // non-bouncy at first
    );
    tw.step(25);                                  // still falling, above the floor
    ball.set(Collider2D, { restitution: 0.9 });   // make it bouncy mid-fall (hot edit)
    tw.step(25);                                  // through the impact, starting to rebound
    let peak = tw.trait<{ y: number }>(Transform, ball).y;
    for (let i = 0; i < 120; i++) { tw.step(1); const y = tw.trait<{ y: number }>(Transform, ball).y; if (y < peak) peak = y; }
    // The edit took effect → the ball rebounded high (screen up = more negative Y).
    // If the edit were ignored (restitution stayed 0) it would rest near y=-30.
    expect(peak).toBeLessThan(-150);
  });
});

describe('physics2DSystem — sensors', () => {
  it('a sensor emits sensor events (not collision) and applies no solver response', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    // A stationary sensor zone the falling box passes through.
    const zone = tw.spawn(
      Transform({ x: 0, y: -100 }),
      RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20, isSensor: true }),
    );
    const box = tw.spawn(
      Transform({ x: 0, y: -400 }),
      RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 20 }),
    );
    tw.step(120);
    const sensorEvents = tw.events({ type: '@sensor' });
    expect(sensorEvents.length).toBeGreaterThanOrEqual(1);
    const evt = sensorEvents[0].payload as { sensor: number; other: number };
    expect(evt.sensor).toBe(zone.id());
    expect(evt.other).toBe(box.id());
    // No solver response: the box kept falling straight through, well past the sensor.
    const tf = tw.trait<{ y: number }>(Transform, box);
    expect(tf.y).toBeGreaterThan(-100);
    // A sensor never produces a 'collision' event.
    expect(tw.events({ type: '@collision' })).toHaveLength(0);
  });
});

describe('physics2DSystem — collider structural edits mid-scene (T7)', () => {
  it("removing a floor's Collider2D drops the body resting on it", () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));
    const ball = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }));
    tw.step(150);
    const yRest = tw.trait<{ y: number }>(Transform, ball).y;
    expect(yRest).toBeLessThan(300);                                        // resting on the floor
    (floor as unknown as { remove(t: unknown): void }).remove(Collider2D);  // floor rebuilt w/o collider
    tw.step(180);
    // The floor no longer collides → the ball falls through past it.
    expect(tw.trait<{ y: number }>(Transform, ball).y).toBeGreaterThan(yRest + 100);
  });

  it('swapping the collider shape changes contact behavior', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    // Floor with a 60-wide gap in the middle (two static boxes).
    for (const fx of [-130, 130]) {
      tw.spawn(Transform({ x: fx, y: 300 }), RigidBody2D({ bodyType: 'static' }),
        Collider2D({ shape: 'box', halfW: 100, halfH: 20 }));
    }
    // A WIDE box bridges the gap and rests; then swap to a small circle that slips through.
    const obj = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic', fixedRotation: true }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 15 }));
    tw.step(120);
    const yBridged = tw.trait<{ y: number }>(Transform, obj).y;
    expect(yBridged).toBeLessThan(300);                                    // bridged across the gap
    (obj as unknown as { set(t: unknown, v: unknown): void }).set(Collider2D, { shape: 'circle', radius: 12 });
    tw.step(180);
    expect(tw.trait<{ y: number }>(Transform, obj).y).toBeGreaterThan(yBridged + 50); // slipped through
  });
});

describe('physics2DSystem — lifecycle disposal auto-hooks (T1)', () => {
  it('Play→Stop disposes the Rapier world (next Play rebuilds fresh)', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 50, halfH: 50 }));
    tw.step(1);
    expect(raycast2D(tw.world, -200, 0, 1, 0)).not.toBeNull();   // ray hits the box
    setPlayState('stopped');                                      // → onPlayStateChange → disposeAllPhysics2D
    expect(raycast2D(tw.world, -200, 0, 1, 0)).toBeNull();        // Rapier world gone
    setPlayState('playing');                                      // restore for a clean teardown
  });

  it('a world swap disposes the OLD world', () => {
    tw = newWorld();
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 9.81, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 50, halfH: 50 }));
    tw.step(1);
    const old = tw.world;
    expect(raycast2D(old, -200, 0, 1, 0)).not.toBeNull();
    const next = createWorld();
    setCurrentWorld(next);                                        // → onWorldSwap(next, old) → disposePhysics2D(old)
    expect(raycast2D(old, -200, 0, 1, 0)).toBeNull();             // old world's Rapier state freed
    setCurrentWorld(old);                                         // restore so the harness afterEach is consistent
    next.destroy();
  });
});
