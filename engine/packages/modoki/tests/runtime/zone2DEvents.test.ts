import { describe, it, expect, afterEach } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { Zone2D } from '../../src/runtime/traits/Zone2D';
import { Zone3D } from '../../src/runtime/traits/Zone3D';
import { ZoneOccupant } from '../../src/runtime/traits/ZoneOccupant';
import { OnZone2D } from '../../src/runtime/traits/OnZone2D';
import { zone2DSystem } from '../../src/runtime/zones/zone2DSystem';
import { zone3DSystem } from '../../src/runtime/zones/zone3DSystem';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { isRuntimeGuid } from '../../src/runtime/core/assetRefRules';
import { zone2DEvents } from '../../src/runtime/zones/Zone2DEvents';
import { zone3DEvents } from '../../src/runtime/zones/Zone3DEvents';
import { entityRef } from '../../src/runtime/core/journal';
import { destroyEntity } from '../../src/runtime/core/ecs/world';

const ZONE2D = { name: 'zone2D', fn: zone2DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 };
const ZONE3D = { name: 'zone3D', fn: zone3DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 };

let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { zone2DEvents.__clear(tw.world); zone3DEvents.__clear(tw.world); tw.dispose(); tw = undefined; }
});

function moveTo(e: Entity, x: number, y: number) {
  e.set(Transform, { ...(e.get(Transform) as object), x, y });
}

describe('Zone2D triggers — containment', () => {
  it('circle uses radius = sx', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 3, sy: 3 }), Zone2D({ shape: 'circle' }));
    const occ = tw.spawn(Transform({ x: 10, y: 0 }), ZoneOccupant);
    const phases: string[] = [];
    zone2DEvents.onZone((_z, _o, p) => phases.push(p), tw.world);

    tw.step(1);                       // outside
    moveTo(occ, 2.9, 0); tw.step(1);  // inside radius 3 → enter
    moveTo(occ, 0, 3.2); tw.step(1);  // outside on Y → exit
    expect(phases).toEqual(['enter', 'exit']);
  });

  it('box uses half-extents sx/2, sy/2 with rotation', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    // Tall narrow box: half X=1, half Y=4. Rotate 90° → long axis runs along world X.
    const zone = tw.spawn(Transform({ x: 0, y: 0, rz: Math.PI / 2, sx: 2, sy: 8 }), Zone2D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 3, y: 0 }), ZoneOccupant);   // inside rotated, outside unrotated
    let enters = 0, exits = 0;
    zone2DEvents.onZone((_z, _o, p) => { if (p === 'enter') enters++; else exits++; }, tw.world);

    tw.step(1);
    expect(enters).toBe(1);
    zone.set(Transform, { ...(zone.get(Transform) as object), rz: 0 });  // unrotate → (3,0) now outside
    tw.step(1);
    expect(exits).toBe(1);
  });

  it('capsule is a vertical pill: radius sx, total height sy', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 1, sy: 6 }), Zone2D({ shape: 'capsule' }));   // segment half=2, caps r=1
    const occ = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant);
    let inside = 0;
    zone2DEvents.onZoneEnter(() => { inside++; }, tw.world);

    moveTo(occ, 0, 2.9); tw.step(1);   // near the top cap tip (|y|≈2.9 < 2 + 1) → inside
    expect(inside).toBe(1);
    moveTo(occ, 1.5, 0); tw.step(1);   // radial 1.5 > radius 1 → exit
    moveTo(occ, 0.9, 0); tw.step(1);   // radial 0.9 < 1 → re-enter
    expect(inside).toBe(2);
  });

  it('ignores entities without ZoneOccupant', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 10, sy: 10 }), Zone2D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0 }));
    let fired = 0;
    zone2DEvents.onZone(() => { fired++; }, tw.world);
    tw.step(2);
    expect(fired).toBe(0);
  });
});

describe('Zone2D triggers — declarative + despawn', () => {
  it('OnZone2D dispatches with occupant as target, zone as self', () => {
    const fired: Array<{ target?: number; self?: number; phase?: string }> = [];
    tw = createTestWorld({
      systems: [ZONE2D],
      actions: {
        act: (ctx) => {
          const p = ctx.params as { self: Entity; other: Entity; phase: string };
          fired.push({ target: (ctx.target as Entity)?.id(), self: p.self.id(), phase: p.phase });
        },
      },
    });
    const zone = tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }), OnZone2D({ onEnter: 'act', onExit: 'act' }));
    const occ = tw.spawn(Transform({ x: 10, y: 0 }), ZoneOccupant);

    moveTo(occ, 0, 0); tw.step(1);
    moveTo(occ, 10, 0); tw.step(1);
    expect(fired).toEqual([
      { target: occ.id(), self: zone.id(), phase: 'enter' },
      { target: occ.id(), self: zone.id(), phase: 'exit' },
    ]);
  });

  it('synthesizes exit when the occupant is despawned inside', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant);
    const phases: string[] = [];
    zone2DEvents.onZone((_z, _o, p) => phases.push(p), tw.world);
    tw.step(1);
    occ.destroy(); tw.step(1);
    expect(phases).toEqual(['enter', 'exit']);
  });

  // QA-ZONE-0003: `runZoneTriggers`' cross-frame occupancy state used to be keyed by
  // `entity.id()`, which strips koota's generation. A despawn immediately followed by a respawn
  // that reclaims the SAME index (a scene hot-reload, or Play→Stop→Play landing between two
  // frames) then collided in the `.id()`-keyed map: the diff went BLIND — the dead occupant's
  // exit and the new occupant's enter both vanished, because the stripped key made them look
  // like the SAME still-present occupant. Fixed by keying on the packed entity (`.valueOf()`,
  // generation included) instead. This test forces the collision deterministically: koota's
  // entity index is a LIFO free list, so destroying `occ` and immediately spawning a same-shape
  // replacement reclaims the exact freed index — asserted below, so the test fails loudly rather
  // than silently passing if that free-list behavior ever changes.
  it('a same-index respawn (occupant despawn+recreate in one step) still fires exit AND enter, never a silent swap', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }));
    const occ1 = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant);
    const phases: string[] = [];
    zone2DEvents.onZone((_z, _o, p) => phases.push(p), tw.world);
    tw.step(1);
    expect(phases).toEqual(['enter']);

    occ1.destroy();
    const occ2 = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant); // reclaims occ1's freed index
    expect(occ2.id()).toBe(occ1.id());       // precondition: the index really was reused
    expect(occ2.valueOf()).not.toBe(occ1.valueOf()); // but the packed entity (generation) differs
    tw.step(1);

    // runZoneTriggers fires all enters before all exits within one diff — order aside, the point
    // is BOTH transitions survive: occ2's enter and occ1's exit, never silently absorbed into
    // "nothing changed" by a collided key.
    expect(phases).toEqual(['enter', 'enter', 'exit']);
  });

  // Close-out review (opus-reviewer) on the fix above: keying `ZoneState` by the packed entity
  // restores the event COUNT, but `routeZone` originally still resolved each event's JOURNAL
  // identity via `entityRef(deadHandle)` — and koota's `has()`/`get()` (which `entityRef` calls)
  // do NOT check generation, only `isAlive()` does. So the dead occupant's synthesized exit was
  // journaled under the RECLAIMED index's new (live) occupant's guid — the exit's `phase` count
  // was right, but its NAMED IDENTITY was silently swapped. The `phases: string[]` test above
  // cannot see this at all: it passes identically whether the exit names occ1 or occ2. This test
  // reads the journal payload itself, mirroring `physicsContactEvents.refOf`'s fix for the same
  // class of bug.
  it('a same-index respawn never journals the exit under the LIVE replacement\'s guid', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }));
    const occ1 = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant, EntityAttributes({ guid: 'guid-occ1', name: 'occ1' }));
    tw.step(1); // enter for occ1

    occ1.destroy();
    const occ2 = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant, EntityAttributes({ guid: 'guid-occ2', name: 'occ2' }));
    expect(occ2.id()).toBe(occ1.id()); // precondition: the index really was reused
    tw.step(1); // occ1's exit + occ2's enter, in one diff

    const zoneEvents = tw!.events({ type: '@zone' }).map((e) => e.payload as { zone: unknown; other: string | number; phase: string });
    const exit = zoneEvents.find((e) => e.phase === 'exit');
    const enter2 = zoneEvents.filter((e) => e.phase === 'enter').at(-1); // occ2's enter (the 2nd one)
    // occ2's OWN enter correctly names it — entityRef resolves a live entity's guid directly.
    expect(enter2?.other).toBe('guid-occ2');
    // occ1's exit must NOT claim to be occ2 (the misattribution this test guards): koota's
    // has()/get() don't check generation, so entityRef(deadHandle) would otherwise silently
    // resolve occ2's guid for occ1's own exit — reading as "occ2 entered and exited the same
    // tick", which is false. `refOf` returns the ref CACHED while occ1 was alive instead — occ1's
    // own guid, the same ref its enter carried (#1225; it used to be the bare numeric id).
    expect(exit?.other).not.toBe('guid-occ2');
    expect(exit?.other).toBe('guid-occ1');
  });

  // #1225: a despawn-exit carries the ref its ENTER carried. The cache used to be the numeric id,
  // so every runtime-guid occupant (#1210 — every code spawn) journaled enter as a guid and exit
  // as a number, and the pair could no longer be matched by ref.
  // Review follow-up: a ZONE member is seeded the frame the zone first appears; a guid changed later
  // reaches the despawn-exit only through the live refresh.
  it('a zone guid changed after the zone was first tracked is the ref its despawn-exit carries', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    const zone = tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }), EntityAttributes({ name: 'zone' }));
    const occ = tw.spawn(Transform({ x: 50, y: 50 }), ZoneOccupant, EntityAttributes({ name: 'shot' }));
    tw.step(1);                                    // zone tracked (member seeded), occupant outside
    zone.set(EntityAttributes, { ...zone.get(EntityAttributes)!, guid: 'd1225bbb-0000-4000-8000-000000000002' });
    moveTo(occ, 0, 0); tw.step(1);                 // enter — refOf(zone) is live here
    zone.destroy(); tw.step(1);                    // zone gone → synthesized exit

    const ev = tw.events({ type: '@zone' }).map((e) => e.payload as { zone: unknown; phase: string });
    expect(ev.find((e) => e.phase === 'exit')?.zone).toBe('d1225bbb-0000-4000-8000-000000000002');
  });

  it('a despawned runtime-guid occupant journals its exit under the same ref as its enter', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }), EntityAttributes({ name: 'zone' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant, EntityAttributes({ name: 'shot' }));
    tw.step(1);
    tw.step(1); // a second diff while inside — the member (and its cached ref) carries across frames
    occ.destroy(); tw.step(1);

    const ev = tw.events({ type: '@zone' }).map((e) => e.payload as { zone: unknown; other: unknown; phase: string });
    const enter = ev.find((e) => e.phase === 'enter');
    const exit = ev.find((e) => e.phase === 'exit');
    expect(isRuntimeGuid(enter?.other as string)).toBe(true);
    expect(exit?.other).toBe(enter?.other);
    expect(exit?.zone).toBe(enter?.zone);
  });
});

// #1227: an exit for a DESPAWNED occupant hands game code a dead handle. koota's has()/get() mask
// the generation, so `entityRef(deadHandle)` used to name whatever reclaimed the index — a live
// entity that never entered the zone. The engine now hands the ref it cached while the occupant was
// alive (`otherRef` in the action params, `refs.other` on the bus), and `entityRef` refuses a dead
// handle with null. Staged exactly as work-qa's repro: destroy g1, spawn g2 on the same index, step.
// Mutations: drop `otherRef` from `makeFireOnZone`'s params / `refs` from `__emitZone` (the ref
// assertions go red); drop `entityRef`'s isAlive check (the null assertion reads g2).
describe('Zone2D triggers — a despawned occupant\'s exit names IT, never the index\'s new owner (#1227)', () => {
  function stageReclaimedExit(t: TestWorld) {
    t.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }), OnZone2D({ onEnter: 'probe', onExit: 'probe' }),
      EntityAttributes({ guid: 'guid-zone', name: 'Zone' }));
    const g1 = t.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant, EntityAttributes({ guid: 'guid-g1', name: 'g1' }));
    t.step(1); // enter
    destroyEntity(g1);
    const g2 = t.spawn(Transform({ x: 50, y: 0 }), ZoneOccupant, EntityAttributes({ guid: 'guid-g2', name: 'g2' })); // outside the zone
    expect(g2.id()).toBe(g1.id()); // precondition: the index really was reclaimed
    t.step(1); // g1's synthesized exit
  }

  it('the OnZone2D exit action gets otherRef = the dead occupant, and entityRef(other) is null', () => {
    const seen: Array<{ phase: string; otherRef: unknown; selfRef: unknown; live: unknown }> = [];
    tw = createTestWorld({
      systems: [ZONE2D],
      actions: {
        probe: (ctx) => {
          const p = ctx.params as { other: Entity; phase: string; otherRef: unknown; selfRef: unknown };
          seen.push({ phase: p.phase, otherRef: p.otherRef, selfRef: p.selfRef, live: entityRef(p.other) });
        },
      },
    });
    stageReclaimedExit(tw);
    expect(seen).toEqual([
      { phase: 'enter', otherRef: 'guid-g1', selfRef: 'guid-zone', live: 'guid-g1' },
      { phase: 'exit', otherRef: 'guid-g1', selfRef: 'guid-zone', live: null },
    ]);
  });

  it('a zone2DEvents subscriber gets refs naming the dead occupant', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    const got: Array<[string, unknown, unknown]> = [];
    zone2DEvents.onZone((_z, _o, phase, refs) => got.push([phase, refs.zone, refs.other]), tw.world);
    const exits: unknown[] = [];
    zone2DEvents.onZoneExit((_z, _o, refs) => exits.push(refs.other), tw.world);
    stageReclaimedExit(tw);
    expect(got).toEqual([['enter', 'guid-zone', 'guid-g1'], ['exit', 'guid-zone', 'guid-g1']]);
    expect(exits).toEqual(['guid-g1']);
  });
});

describe('Zone triggers — 2D/3D channel isolation', () => {
  it('2D and 3D zones on one occupant fire independently without clobbering each other', () => {
    // Regression: the two systems share per-world occupancy state; without per-channel keying,
    // whichever ran second would see the other's membership and fire spurious exits.
    tw = createTestWorld({ systems: [ZONE2D, ZONE3D] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone2D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);

    let e2 = 0, x2 = 0, e3 = 0, x3 = 0;
    zone2DEvents.onZone((_z, _o, p) => { if (p === 'enter') e2++; else x2++; }, tw.world);
    zone3DEvents.onZone((_z, _o, p) => { if (p === 'enter') e3++; else x3++; }, tw.world);

    tw.step(3);   // occupant sits inside both; each fires exactly one enter, no exits
    expect([e2, x2, e3, x3]).toEqual([1, 0, 1, 0]);

    moveTo(occ, 100, 0); tw.step(1);   // leaves both → one exit each
    expect([e2, x2, e3, x3]).toEqual([1, 1, 1, 1]);
  });
});

describe('Zone2D triggers — deactivation means GONE, not paused', () => {
  /** The 2D half of the same contract the 3D suite pins: a deactivated zone/occupant drops out of
   *  the frame's lists and the membership diff synthesizes the exits, so the enter/exit ledger
   *  stays balanced. Duplicated per dimension ON PURPOSE — the guard lives in each system (only
   *  the containment test is dimension-specific), so a fix applied to one and not the other is
   *  exactly the drift `zoneTriggerCore`'s shared-core discipline exists to catch. */
  it('deactivating the ZONE fires exit, and re-activating fires a fresh enter', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    const zone = tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }), EntityAttributes({ name: 'z' }));
    tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant);
    const hits: string[] = [];
    zone2DEvents.onZone((_z, _o, phase) => hits.push(phase), tw.world);

    tw.step(1);
    expect(hits).toEqual(['enter']);

    zone.set(EntityAttributes, { ...zone.get(EntityAttributes)!, isActive: false });
    tw.step(2);
    expect(hits).toEqual(['enter', 'exit']);   // once, then quiet

    zone.set(EntityAttributes, { ...zone.get(EntityAttributes)!, isActive: true });
    tw.step(1);
    expect(hits).toEqual(['enter', 'exit', 'enter']);
  });

  it('deactivating an OCCUPANT exits it from the zone', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant, EntityAttributes({ name: 'o' }));
    const hits: string[] = [];
    zone2DEvents.onZone((_z, _o, phase) => hits.push(phase), tw.world);

    tw.step(1);
    occ.set(EntityAttributes, { ...occ.get(EntityAttributes)!, isActive: false });
    tw.step(1);

    expect(hits).toEqual(['enter', 'exit']);
  });

  it('CASCADES — deactivating the zone\'s parent exits its occupants', () => {
    tw = createTestWorld({ systems: [ZONE2D] });
    const parent = tw.spawn(Transform({ x: 0, y: 0 }), EntityAttributes({ name: 'group' }));
    tw.spawn(Transform({ x: 0, y: 0, sx: 4, sy: 4 }), Zone2D({ shape: 'box' }), EntityAttributes({ name: 'z', parentId: parent.id() }));
    tw.spawn(Transform({ x: 0, y: 0 }), ZoneOccupant);
    const hits: string[] = [];
    zone2DEvents.onZone((_z, _o, phase) => hits.push(phase), tw.world);

    tw.step(1);
    parent.set(EntityAttributes, { ...parent.get(EntityAttributes)!, isActive: false });
    tw.step(1);

    expect(hits).toEqual(['enter', 'exit']);
  });
});
