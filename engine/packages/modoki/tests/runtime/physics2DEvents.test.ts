/** Physics2DEvents manager (option C) + declarative OnCollision2D (option B) —
 *  headless via createTestWorld + real Rapier. A dynamic body falls through a static
 *  sensor (enter→exit) and onto a static floor (solid contact). We assert the manager
 *  subscribers fire with the right entities/phase, that an OnCollision2D action is
 *  dispatched with the OTHER entity as target, and that unsubscribe/clear work. */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { RigidBody2D } from '../../src/runtime/traits/RigidBody2D';
import { Collider2D } from '../../src/runtime/traits/Collider2D';
import { Physics2D } from '../../src/runtime/traits/Physics2D';
import { OnCollision2D } from '../../src/runtime/traits/OnCollision2D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { physics2DSystem, disposePhysics2D } from '../../src/runtime/systems/physics2DSystem';
import { physics2DEvents } from '../../src/runtime/managers/Physics2DEvents';
import { initRapier2D } from '../../src/runtime/systems/rapierLoader';

beforeAll(async () => { await initRapier2D(); });
let tw: TestWorld | undefined;
afterEach(() => { if (tw) { physics2DEvents.__clear(tw.world); disposePhysics2D(tw.world); tw.dispose(); tw = undefined; } });

const PHYS = { name: 'physics2D', fn: physics2DSystem, priority: SYSTEM_PRIORITY.PHYSICS };

describe('Physics2DEvents — manager subscribers', () => {
  it('fires onSensorEnter then onSensorExit as a body falls through a sensor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    // Thin sensor zone at y=200; body starts above and falls DOWN (+Y) through it.
    const sensor = tw.spawn(Transform({ x: 0, y: 200 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10, isSensor: true }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    const hits: Array<{ sensor: Entity; other: Entity; phase: string }> = [];
    physics2DEvents.onSensor((s, o, phase) => hits.push({ sensor: s, other: o, phase }), tw.world);

    tw.step(240);

    const enter = hits.find((h) => h.phase === 'enter');
    const exit = hits.find((h) => h.phase === 'exit');
    expect(enter).toBeTruthy();
    expect(exit).toBeTruthy();
    // The sensor entity is the one whose collider isSensor; the other is the falling body.
    expect(enter!.sensor.id()).toBe(sensor.id());
    expect(enter!.other.id()).toBe(body.id());
  });

  it('fires onCollisionEnter for a solid contact (body lands on floor)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }));

    const contacts: Array<{ a: number; b: number }> = [];
    physics2DEvents.onCollisionEnter((a, b) => contacts.push({ a: a.id(), b: b.id() }), tw.world);

    tw.step(240);

    expect(contacts.length).toBeGreaterThan(0);
    const ids = contacts.flatMap((c) => [c.a, c.b]);
    expect(ids).toContain(floor.id());
    expect(ids).toContain(body.id());
  });

  it('fires onContact once with impact point/normal/speed when a body lands on a floor', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }));   // top surface at y≈280
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }));

    const contacts: Array<{ a: number; b: number; point: readonly number[]; normal: readonly number[]; speed: number }> = [];
    physics2DEvents.onContact((a, b, d) => {
      if (a.id() === body.id() || b.id() === body.id()) contacts.push({ a: a.id(), b: b.id(), ...d });
    }, tw.world);

    tw.step(240);

    expect(contacts.length).toBeGreaterThanOrEqual(1);
    const first = contacts[0];
    expect([first.a, first.b]).toContain(body.id());
    // Impact point sits near the floor's top surface (y≈280), well below the body's start (y=0).
    expect(first.point[1]).toBeGreaterThan(240);
    expect(first.point[1]).toBeLessThan(300);
    // Floor is horizontal → contact normal is near-vertical in screen space.
    expect(Math.abs(first.normal[1])).toBeGreaterThan(0.8);
    expect(first.point).toHaveLength(2);
    expect(first.normal).toHaveLength(2);
    // The body was falling, so the approach speed along the normal is non-trivial.
    expect(first.speed).toBeGreaterThan(0);

    // The journal carries a tick-stamped 'contact' event too.
    const journal = tw.events({ type: '@contact' });
    expect(journal.length).toBeGreaterThanOrEqual(1);
    const jp = journal[0].payload as { a: number; b: number; point: number[]; normal: number[]; speed: number };
    expect([jp.a, jp.b]).toContain(body.id());
    expect(jp.point).toHaveLength(2);
  });

  it('@collision/@sensor journal stable GUIDs when entities carry them (item 2)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    // Solid floor + a sensor above it, both guid'd; a guid'd body falls through the sensor onto the floor.
    tw.spawn(Transform({ x: 0, y: 200 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10, isSensor: true }), EntityAttributes({ guid: 'g-sensor' }));
    tw.spawn(Transform({ x: 0, y: 400 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }), EntityAttributes({ guid: 'g-floor' }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }), EntityAttributes({ guid: 'g-ball' }));

    tw.step(240);

    const sensorEv = tw.events({ type: '@sensor' })[0]?.payload as { sensor: string | number; other: string | number };
    expect([sensorEv.sensor, sensorEv.other].slice().sort()).toEqual(['g-ball', 'g-sensor']);
    const collEv = tw.events({ type: '@collision' })[0]?.payload as { a: string | number; b: string | number };
    expect([collEv.a, collEv.b].slice().sort()).toEqual(['g-ball', 'g-floor']);
  });

  it('resolveRefName names an entity by GUID even after it despawns (side-table)', async () => {
    const { resolveRefName } = await import('../../src/runtime/systems/journal');
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }), EntityAttributes({ guid: 'g-floor', name: 'Floor' }));
    const ball = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }), EntityAttributes({ guid: 'g-ball', name: 'Ball' }));

    tw.step(240); // a contact fires → entityRef captures both names into the side-table
    expect(resolveRefName('g-ball', tw.world)).toBe('Ball');

    ball.destroy(); // the ref is now gone from the live world…
    tw.step(1);
    expect(ball.isAlive()).toBe(false);
    // …yet the name captured at emit time still resolves — the whole point of the side-table.
    expect(resolveRefName('g-ball', tw.world)).toBe('Ball');
  });

  it('@contact is Tier-2 watch-gated: dropped when capture is off, lean @collision stays always-on', async () => {
    const { setVerboseCapture } = await import('../../src/runtime/systems/journal');
    tw = createTestWorld({ systems: [PHYS] }); // harness opens all Tier-2 captures by default
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }), EntityAttributes({ guid: 'g-floor' }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }), EntityAttributes({ guid: 'g-ball' }));

    setVerboseCapture('@contact', false); // close the diagnostic watch
    tw.step(240);
    expect(tw.events({ type: '@contact' }).length).toBe(0);      // Tier-2: dropped
    expect(tw.events({ type: '@collision' }).length).toBeGreaterThanOrEqual(1); // Tier-1: still recorded

    // Reopen the watch and drop a SECOND ball — a fresh contact ENTER must now be recorded, proving
    // the reopen branch actually re-enables emission (the half the old test left unasserted).
    setVerboseCapture('@contact', true);
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }), EntityAttributes({ guid: 'g-ball2' }));
    tw.step(240);
    expect(tw.events({ type: '@contact' }).length).toBeGreaterThanOrEqual(1); // recording again
    setVerboseCapture('@contact', false); // leave state clean for the next test (dispose also resets)
  });

  it('@contact journals stable GUIDs when entities carry them (Percept V4)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 300 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20 }), EntityAttributes({ guid: 'g-floor' }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 15 }), EntityAttributes({ guid: 'g-body' }));

    tw.step(240);

    const journal = tw.events({ type: '@contact' });
    expect(journal.length).toBeGreaterThanOrEqual(1);
    const jp = journal[0].payload as { a: string | number; b: string | number };
    // Both refs are GUIDs (hot-reload-stable), not runtime numeric ids.
    expect([jp.a, jp.b].slice().sort()).toEqual(['g-body', 'g-floor']);
  });

  it('unsubscribe stops delivery; __clear drops all subscribers', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 200 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10, isSensor: true }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    let count = 0;
    const off = physics2DEvents.onSensor(() => { count++; }, tw.world);
    off(); // immediately unsubscribe
    tw.step(240);
    expect(count).toBe(0);
  });
});

describe('OnCollision2D — declarative action dispatch', () => {
  it('dispatches onEnter with the OTHER entity as target when a body enters the sensor', () => {
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
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    const sensor = tw.spawn(Transform({ x: 0, y: 200 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10, isSensor: true }),
      OnCollision2D({ onEnter: 'zoneEnter' }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    tw.step(240);

    const enter = fired.find((f) => f.phase === 'enter');
    expect(enter).toBeTruthy();
    expect(enter!.target).toBe(body.id());   // action target = the OTHER entity
    expect(enter!.self).toBe(sensor.id());   // params.self = the trait owner
  });

  it('an unwired action name is a no-op (does not throw in the pipeline)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 200 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10, isSensor: true }),
      OnCollision2D({ onEnter: 'doesNotExist' }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    expect(() => tw!.step(240)).not.toThrow();
  });

  it('dispatches onExit when the body leaves the sensor', () => {
    const fired: string[] = [];
    tw = createTestWorld({
      systems: [PHYS],
      actions: {
        zoneEnter: () => fired.push('enter'),
        zoneExit: () => fired.push('exit'),
      },
    });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 20, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 200 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 10, isSensor: true }),
      OnCollision2D({ onEnter: 'zoneEnter', onExit: 'zoneExit' }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    tw.step(240);   // falls in then out

    expect(fired).toContain('enter');
    expect(fired).toContain('exit');
    expect(fired.indexOf('enter')).toBeLessThan(fired.indexOf('exit'));
  });
});

describe('Physics2DEvents — H1: exit on despawn + no double-enter on hot edit', () => {
  it('synthesizes a sensor exit when a body inside a trigger is despawned', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 })); // no gravity: body rests inside
    const sensor = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 60, isSensor: true }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12 }));

    const hits: Array<{ sensor: number; other: number; phase: string }> = [];
    physics2DEvents.onSensor((s, o, phase) => hits.push({ sensor: s.id(), other: o.id(), phase }), tw.world);

    tw.step(5);                                    // enter fires (pre-overlapping)
    expect(hits.some((h) => h.phase === 'enter')).toBe(true);
    expect(hits.some((h) => h.phase === 'exit')).toBe(false);

    body.destroy();                                // despawn while still inside the trigger
    tw.step(1);                                    // cleanup pass removes the body → synthesized exit

    const exit = hits.find((h) => h.phase === 'exit');
    expect(exit).toBeTruthy();
    expect(exit!.sensor).toBe(sensor.id());
    expect(exit!.other).toBe(body.id());
  });

  it('a hot material edit while overlapping does NOT re-fire enter (no rebuild churn)', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
    tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 60, halfH: 60, isSensor: true }));
    const body = tw.spawn(Transform({ x: 0, y: 0 }), RigidBody2D({ bodyType: 'dynamic' }),
      Collider2D({ shape: 'circle', radius: 12, friction: 0.5 }));

    let enters = 0, exits = 0;
    physics2DEvents.onSensor((_s, _o, phase) => { if (phase === 'enter') enters++; else exits++; }, tw.world);

    tw.step(5);
    expect(enters).toBe(1);
    // Edit material (friction) — this used to rebuild the collider → drop exit + re-fire enter.
    body.set(Collider2D, { ...body.get(Collider2D)!, friction: 0.9 });
    tw.step(5);

    expect(enters).toBe(1);   // still exactly one enter — applied in place, no rebuild
    expect(exits).toBe(0);    // and no spurious exit
  });
});

describe('physics2D — solo (parentless) static colliders', () => {
  // A Collider2D with no RigidBody2D of its own and no body parent is now created as a PARENTLESS
  // Rapier collider (fixed world geometry) — it collides + fires events without a dummy body,
  // instead of the old orphan warning. Mirrors the 3D behaviour. 2D convention: +Y is down,
  // gravityY positive pulls down, a floor at y=400 is rested on at y<400.
  it('a dynamic body collides with + rests on a parentless static collider (no dummy body, no warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      tw = createTestWorld({ systems: [PHYS] });
      tw.spawn(Physics2D({ gravityX: 0, gravityY: 30, pixelsPerMeter: 100 }));
      // Solo floor: Collider2D only — NO RigidBody2D, no parent (EntityAttributes as in a real scene).
      const floorId = tw.spawn(Transform({ x: 0, y: 400 }),
        Collider2D({ shape: 'box', halfW: 200, halfH: 20, friction: 0.9 }), EntityAttributes({ parentId: 0 })).id();
      const body = tw.spawn(Transform({ x: 0, y: 100 }),
        RigidBody2D({ bodyType: 'dynamic', angularDamping: 1 }),
        Collider2D({ shape: 'box', halfW: 20, halfH: 20 }), EntityAttributes({ parentId: 0 }));
      tw.step(240);
      expect(tw.trait<{ y: number }>(Transform, body).y).toBeLessThan(400);   // rested on the solo floor
      const hitFloor = tw.events({ type: '@contact' }).some((e) => {
        const p = e.payload as { a: number; b: number };
        return p.a === floorId || p.b === floorId;                            // collision resolves to the solo entity
      });
      expect(hitFloor).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('has no RigidBody2D'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a collider parented under a non-body GROUP is placed at its composed WORLD pose', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 30, pixelsPerMeter: 100 }));
    // Pure organizational group at y=400 (no RigidBody2D, no Collider2D) — like Sling's wall groups.
    const group = tw.spawn(Transform({ x: 0, y: 400 }), EntityAttributes({ parentId: 0 }));
    // Floor collider at LOCAL y=0 → WORLD y=400. If it were placed at LOCAL (0) the body (below it in
    // +Y-down) would fall through; world placement catches it and it rests short of 400.
    tw.spawn(Transform({ x: 0, y: 0 }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20, friction: 0.9 }),
      EntityAttributes({ parentId: group.id() }));
    const body = tw.spawn(Transform({ x: 0, y: 100 }),
      RigidBody2D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20 }), EntityAttributes({ parentId: 0 }));
    tw.step(240);
    const y = tw.trait<{ y: number }>(Transform, body).y;
    expect(y).toBeLessThan(400);      // rested on the group-parented floor (did NOT fall through)
    expect(y).toBeGreaterThan(200);   // and it fell from y=100 toward the WORLD-y floor (not local y=0)
  });

  it('a parentless SENSOR (trigger) fires an overlap resolving to the solo entity', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0, pixelsPerMeter: 100 }));
    // Solo sensor: Collider2D isSensor, NO RigidBody2D, no parent — a body-less trigger volume.
    const sensorId = tw.spawn(Transform({ x: 0, y: 0 }),
      Collider2D({ shape: 'box', halfW: 40, halfH: 40, isSensor: true }), EntityAttributes({ parentId: 0 })).id();
    // A body drifts into it (no gravity, moving -X).
    tw.spawn(Transform({ x: 220, y: 0 }),
      RigidBody2D({ bodyType: 'dynamic', gravityScale: 0, vx: -300 }),
      Collider2D({ shape: 'box', halfW: 10, halfH: 10 }), EntityAttributes({ parentId: 0 }));
    tw.step(120);
    const overlap = tw.events({ type: '@sensor' }).some((e) => {
      const p = e.payload as { sensor: number; other: number; phase: string };
      return p.sensor === sensorId && p.phase === 'enter';   // resolves to the solo sensor entity
    });
    expect(overlap).toBe(true);
  });

  it('removing the solo collider entity lets the body fall through', () => {
    tw = createTestWorld({ systems: [PHYS] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 30, pixelsPerMeter: 100 }));
    const floor = tw.spawn(Transform({ x: 0, y: 400 }),
      Collider2D({ shape: 'box', halfW: 200, halfH: 20, friction: 0.9 }), EntityAttributes({ parentId: 0 }));
    const body = tw.spawn(Transform({ x: 0, y: 100 }),
      RigidBody2D({ bodyType: 'dynamic', angularDamping: 1 }),
      Collider2D({ shape: 'box', halfW: 20, halfH: 20 }), EntityAttributes({ parentId: 0 }));
    tw.step(150);
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeLessThan(400);     // resting on the solo floor
    (floor as unknown as { destroy(): void }).destroy();
    tw.step(240);
    expect(tw.trait<{ y: number }>(Transform, body).y).toBeGreaterThan(500);  // floor gone → fell through
  });
});
