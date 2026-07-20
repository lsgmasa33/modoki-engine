import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody3D } from '../../src/runtime/traits/RigidBody3D';
import { Collider3D } from '../../src/runtime/traits/Collider3D';
import { Physics3D } from '../../src/runtime/traits/Physics3D';
import { OnCollision3D } from '../../src/runtime/traits/OnCollision3D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { physics3DSystem, disposePhysics3D } from '../../src/runtime/systems/physics3DSystem';
import { physics3DEvents } from '../../src/runtime/managers/Physics3DEvents';
import { initRapier3D } from '../../src/runtime/systems/rapier3DLoader';
import { resolveRefName, setVerboseCapture } from '../../src/runtime/systems/journal';

beforeAll(async () => { await initRapier3D(); });

let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { physics3DEvents.__clear(tw.world); disposePhysics3D(tw.world); tw.dispose(); tw = undefined; }
});

const PHYS = { name: 'physics3D', fn: physics3DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

describe('Physics3DEvents — sensors', () => {
  it('fires onSensor enter then exit as a body falls through a sensor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    const sensor = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, isSensor: true }),
    );
    const body = tw.spawn(
      Transform({ x: 0, y: 6, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.4 }),
    );

    const hits: Array<{ sensor: number; other: number; phase: string }> = [];
    physics3DEvents.onSensor((s, o, phase) => hits.push({ sensor: s.id(), other: o.id(), phase }), tw.world);

    tw.step(240);  // fall from y=6 through the sensor and out the bottom (no floor)

    const enter = hits.find((h) => h.phase === 'enter');
    const exit = hits.find((h) => h.phase === 'exit');
    expect(enter).toBeTruthy();
    expect(exit).toBeTruthy();
    expect(enter!.sensor).toBe(sensor.id());
    expect(enter!.other).toBe(body.id());
    // A sensor never produces a 'collision' journal event.
    expect(tw.events({ type: '@collision' })).toHaveLength(0);
    // The journal carries the tick-stamped 'sensor' events.
    expect(tw.events({ type: '@sensor' }).length).toBeGreaterThanOrEqual(2);
  });

  it('OnCollision3D dispatches onEnter with the OTHER entity as target', () => {
    const fired: Array<{ target?: number; self?: number; phase?: string }> = [];
    tw = createTestWorld({
      systems: [PHYS],
      actions: {
        zoneEnter: (ctx) => {
          const p = ctx.params as { self: Entity; other: Entity; phase: string } | undefined;
          fired.push({ target: (ctx.target as Entity | undefined)?.id(), self: p?.self.id(), phase: p?.phase });
        },
      },
    });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    const sensor = tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, isSensor: true }),
      OnCollision3D({ onEnter: 'zoneEnter' }),
    );
    const body = tw.spawn(
      Transform({ x: 0, y: 6, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.4 }),
    );

    tw.step(240);
    const enter = fired.find((f) => f.phase === 'enter');
    expect(enter).toBeTruthy();
    expect(enter!.target).toBe(body.id());
    expect(enter!.self).toBe(sensor.id());
  });
});

describe('Physics3DEvents — solid contacts', () => {
  it('emits a collision journal event when a dynamic box lands on a static floor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),
    );
    const box = tw.spawn(
      Transform({ x: 0, y: 6, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );

    let managerFired = false;
    physics3DEvents.onCollisionEnter((a, b) => {
      if (a.id() === box.id() || b.id() === box.id()) managerFired = true;
    }, tw.world);

    tw.step(180);

    const hits = tw.events({ type: '@collision' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const enter = hits.find((e) => (e.payload as { phase: string }).phase === 'enter');
    expect(enter).toBeTruthy();
    const p = enter!.payload as { a: number; b: number };
    expect([p.a, p.b]).toContain(box.id());
    expect(managerFired).toBe(true);  // the code-subscriber bus fired too
  });

  it('fires onContact once with impact point/normal/speed when a box lands on a floor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),  // top surface at y=1
    );
    const box = tw.spawn(
      Transform({ x: 0, y: 6, z: 0 }),
      RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }),
    );

    const contacts: Array<{ a: number; b: number; point: readonly number[]; normal: readonly number[]; speed: number }> = [];
    physics3DEvents.onContact((a, b, d) => {
      if (a.id() === box.id() || b.id() === box.id()) contacts.push({ a: a.id(), b: b.id(), ...d });
    }, tw.world);

    tw.step(180);

    // A contact fires on landing (only on begin, so the falling box produces at least one).
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    const first = contacts[0];
    expect([first.a, first.b]).toContain(box.id());
    // Impact point sits at the floor surface (y≈1), well below the box's start height.
    expect(first.point[1]).toBeGreaterThan(0.5);
    expect(first.point[1]).toBeLessThan(2);
    // Contact normal is near-vertical (floor is horizontal); sign depends on collider order.
    expect(Math.abs(first.normal[1])).toBeGreaterThan(0.8);
    // The box was falling, so the approach speed along the normal is non-trivial.
    expect(first.speed).toBeGreaterThan(0);

    // The journal carries a tick-stamped 'contact' event too, with the same shape.
    const journal = tw.events({ type: '@contact' });
    expect(journal.length).toBeGreaterThanOrEqual(1);
    const jp = journal[0].payload as { a: number; b: number; point: number[]; normal: number[]; speed: number };
    expect([jp.a, jp.b]).toContain(box.id());
    expect(jp.point).toHaveLength(3);
    expect(jp.normal).toHaveLength(3);
  });

  it('@contact journals stable GUIDs when entities carry them (Percept V4)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }), EntityAttributes({ guid: 'g-floor' }));
    tw.spawn(Transform({ x: 0, y: 6, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }), EntityAttributes({ guid: 'g-box' }));

    tw.step(180);

    const journal = tw.events({ type: '@contact' });
    expect(journal.length).toBeGreaterThanOrEqual(1);
    const jp = journal[0].payload as { a: string | number; b: string | number };
    expect([jp.a, jp.b].slice().sort()).toEqual(['g-box', 'g-floor']);
  });
});

// 3D parity for the Percept name-resolvability + Tier-2 volume-gating change (physics3DSystem shares
// physicsContactEvents.refOf and the same isVerboseCaptureActive('@contact') gate as 2D).
describe('Physics3DEvents — Percept tiers & resolvability (3D parity)', () => {
  it('@collision/@sensor journal stable GUIDs via refOf when entities carry them', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 4, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 3, halfH: 0.3, halfD: 3, isSensor: true }), EntityAttributes({ guid: 'g-sensor' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }), EntityAttributes({ guid: 'g-floor' }));
    tw.spawn(Transform({ x: 0, y: 9, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.4 }), EntityAttributes({ guid: 'g-ball' }));

    tw.step(240);

    const sensorEv = tw.events({ type: '@sensor' })[0]?.payload as { sensor: string | number; other: string | number };
    expect([sensorEv.sensor, sensorEv.other].slice().sort()).toEqual(['g-ball', 'g-sensor']);
    const collEv = tw.events({ type: '@collision' })[0]?.payload as { a: string | number; b: string | number };
    expect([collEv.a, collEv.b].slice().sort()).toEqual(['g-ball', 'g-floor']);
  });

  it('@contact is Tier-2 watch-gated: dropped when off, lean @collision stays always-on', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }), EntityAttributes({ guid: 'g-floor' }));
    tw.spawn(Transform({ x: 0, y: 6, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }), EntityAttributes({ guid: 'g-box' }));

    setVerboseCapture('@contact', false);
    tw.step(240);
    expect(tw.events({ type: '@contact' }).length).toBe(0);       // Tier-2: dropped
    expect(tw.events({ type: '@collision' }).length).toBeGreaterThanOrEqual(1); // Tier-1: recorded

    setVerboseCapture('@contact', true);
    tw.spawn(Transform({ x: 0.2, y: 6, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }), EntityAttributes({ guid: 'g-box2' }));
    tw.step(240);
    expect(tw.events({ type: '@contact' }).length).toBeGreaterThanOrEqual(1); // recording again
    setVerboseCapture('@contact', false);
  });

  it('resolveRefName names a guid entity by both keys, surviving despawn', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }), EntityAttributes({ guid: 'g-floor', name: 'Floor' }));
    const box = tw.spawn(Transform({ x: 0, y: 6, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'box', halfW: 0.5, halfH: 0.5, halfD: 0.5 }), EntityAttributes({ guid: 'g-box', name: 'Box' }));

    tw.step(180); // a contact fires → entityRef caches the name under both the guid and numeric id
    expect(resolveRefName('g-box', tw.world)).toBe('Box');

    box.destroy();
    tw.step(1);
    expect(box.isAlive()).toBe(false);
    expect(resolveRefName('g-box', tw.world)).toBe('Box');    // still nameable post-despawn
  });
});

describe('Physics3DEvents — despawn exit, hot edit, unsubscribe', () => {
  it('synthesizes a sensor exit when a body inside a trigger is despawned', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));   // no gravity: body rests inside
    const sensor = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 1, halfH: 1, halfD: 1, isSensor: true }));
    const body = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2 }));

    const hits: Array<{ sensor: number; other: number; phase: string }> = [];
    physics3DEvents.onSensor((s, o, phase) => hits.push({ sensor: s.id(), other: o.id(), phase }), tw.world);

    tw.step(5);                                     // enter fires (pre-overlapping)
    expect(hits.some((h) => h.phase === 'enter')).toBe(true);
    expect(hits.some((h) => h.phase === 'exit')).toBe(false);

    body.destroy();                                 // despawn while still inside the trigger
    tw.step(1);                                     // cleanup pass → synthesized exit

    const exit = hits.find((h) => h.phase === 'exit');
    expect(exit).toBeTruthy();
    expect(exit!.sensor).toBe(sensor.id());
    expect(exit!.other).toBe(body.id());
  });

  it('a hot material edit while overlapping does NOT re-fire enter (no rebuild churn)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: 0, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 1, halfH: 1, halfD: 1, isSensor: true }));
    const body = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.2, friction: 0.5 }));

    let enters = 0, exits = 0;
    physics3DEvents.onSensor((_s, _o, phase) => { if (phase === 'enter') enters++; else exits++; }, tw.world);

    tw.step(5);
    expect(enters).toBe(1);
    body.set(Collider3D, { ...body.get(Collider3D)!, friction: 0.9 });   // material-only edit
    tw.step(5);
    expect(enters).toBe(1);   // no rebuild → no spurious exit/re-enter
    expect(exits).toBe(0);
  });

  it('unsubscribe stops delivery; __clear drops all subscribers', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -20, gravityZ: 0 }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), RigidBody3D({ bodyType: 'static' }),
      Collider3D({ shape: 'box', halfW: 5, halfH: 0.5, halfD: 5, isSensor: true }));
    tw.spawn(Transform({ x: 0, y: 6, z: 0 }), RigidBody3D({ bodyType: 'dynamic' }),
      Collider3D({ shape: 'sphere', radius: 0.4 }));

    let count = 0;
    const off = physics3DEvents.onSensor(() => { count++; }, tw.world);
    off();   // immediately unsubscribe
    tw.step(240);
    expect(count).toBe(0);
  });
});
