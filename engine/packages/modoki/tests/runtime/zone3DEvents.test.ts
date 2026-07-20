import { describe, it, expect, afterEach } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { setPlayState } from '../../src/runtime/systems/playState';
import { Transform } from '../../src/runtime/traits/Transform';
import { Zone3D } from '../../src/runtime/traits/Zone3D';
import { ZoneOccupant } from '../../src/runtime/traits/ZoneOccupant';
import { OnZone3D } from '../../src/runtime/traits/OnZone3D';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { zone3DSystem } from '../../src/runtime/systems/zone3DSystem';
import { zone3DEvents } from '../../src/runtime/managers/Zone3DEvents';

// Zone systems are internally play-state-gated; run them at their production tier (post-transform).
const ZONE = { name: 'zone3D', fn: zone3DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 };

let tw: TestWorld | undefined;
afterEach(() => { if (tw) { zone3DEvents.__clear(tw.world); tw.dispose(); tw = undefined; } });

/** Move an occupant to a new world position between steps (no physics — direct Transform edit). */
function moveTo(e: Entity, x: number, y: number, z: number) {
  e.set(Transform, { ...(e.get(Transform) as object), x, y, z });
}

describe('Zone3D triggers — containment & enter/exit', () => {
  it('fires enter then exit as an occupant crosses a box zone (journal + bus)', () => {
    tw = createTestWorld({ systems: [ZONE] });
    // Box zone: full size = scale, so sx=4 → half-extent 2 in X.
    const zone = tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);

    const hits: Array<{ zone: number; other: number; phase: string }> = [];
    zone3DEvents.onZone((z, o, phase) => hits.push({ zone: z.id(), other: o.id(), phase }), tw.world);

    tw.step(1);                              // occupant outside → nothing
    expect(hits).toHaveLength(0);

    moveTo(occ, 0, 0, 0); tw.step(1);        // inside → enter
    moveTo(occ, 10, 0, 0); tw.step(1);       // outside → exit

    expect(hits.map((h) => h.phase)).toEqual(['enter', 'exit']);
    expect(hits[0].zone).toBe(zone.id());
    expect(hits[0].other).toBe(occ.id());

    // Journal carries tick-stamped @zone events with raw ids.
    const journal = tw.events({ type: '@zone' });
    expect(journal).toHaveLength(2);
    expect((journal[0].payload as { zone: number; other: number; phase: string })).toEqual(
      { zone: zone.id(), other: occ.id(), phase: 'enter' },
    );
  });

  it('sphere containment uses radius = sx (uniform)', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 3, sy: 3, sz: 3 }), Zone3D({ shape: 'sphere' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    let inside = 0;
    zone3DEvents.onZoneEnter(() => { inside++; }, tw.world);

    moveTo(occ, 2.9, 0, 0); tw.step(1);   // within radius 3 → enter
    expect(inside).toBe(1);
    moveTo(occ, 3.1, 0, 0); tw.step(1);   // just outside radius → exit (no new enter)
    moveTo(occ, 0, 0, 3.5); tw.step(1);   // outside on Z
    expect(inside).toBe(1);
    moveTo(occ, 0, 0, 2.5); tw.step(1);   // back inside → second enter
    expect(inside).toBe(2);
  });

  it('a rotated box contains a point outside its axis-aligned extent', () => {
    tw = createTestWorld({ systems: [ZONE] });
    // Tall, narrow box (half X=1, half Z=4) rotated 90° about Y: its long axis now runs along X.
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, rx: 0, ry: Math.PI / 2, rz: 0, sx: 2, sy: 4, sz: 8 }),
      Zone3D({ shape: 'box' }),
    );
    const occ = tw.spawn(Transform({ x: 3, y: 0, z: 0 }), ZoneOccupant);   // outside unrotated, inside rotated
    let inside = 0;
    zone3DEvents.onZoneEnter(() => { inside++; }, tw.world);

    tw.step(1);
    expect(inside).toBe(1);

    // Prove rotation is load-bearing: same box unrotated does NOT contain (3,0,0).
    zone.set(Transform, { ...(zone.get(Transform) as object), ry: 0 });
    tw.step(1);
    // The occupant left the (now unrotated) box → an exit balanced the earlier enter.
    expect(tw.events({ type: '@zone' }).filter((e) => (e.payload as { phase: string }).phase === 'exit')).toHaveLength(1);
  });

  it('ignores entities that are NOT tagged ZoneOccupant', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 10, sy: 10, sz: 10 }), Zone3D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }));   // plain entity sitting inside the zone, no tag
    let fired = 0;
    zone3DEvents.onZone(() => { fired++; }, tw.world);
    tw.step(3);
    expect(fired).toBe(0);
  });
});

describe('Zone3D triggers — declarative OnZone3D', () => {
  it('dispatches onEnter/onExit with the occupant as target and zone as self', () => {
    const fired: Array<{ target?: number; self?: number; phase?: string }> = [];
    tw = createTestWorld({
      systems: [ZONE],
      actions: {
        zoneAct: (ctx) => {
          const p = ctx.params as { self: Entity; other: Entity; phase: string } | undefined;
          fired.push({ target: (ctx.target as Entity | undefined)?.id(), self: p?.self.id(), phase: p?.phase });
        },
      },
    });
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }),
      Zone3D({ shape: 'box' }),
      OnZone3D({ onEnter: 'zoneAct', onExit: 'zoneAct' }),
    );
    const occ = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);

    moveTo(occ, 0, 0, 0); tw.step(1);
    moveTo(occ, 10, 0, 0); tw.step(1);

    expect(fired).toEqual([
      { target: occ.id(), self: zone.id(), phase: 'enter' },
      { target: occ.id(), self: zone.id(), phase: 'exit' },
    ]);
  });

  it('an empty action field reacts only to the other phase', () => {
    const phases: string[] = [];
    tw = createTestWorld({ systems: [ZONE], actions: { onlyEnter: (ctx) => phases.push((ctx.params as { phase: string }).phase) } });
    const occ = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }), OnZone3D({ onEnter: 'onlyEnter', onExit: '' }));

    tw.step(1);                          // enter fires
    moveTo(occ, 10, 0, 0); tw.step(1);   // exit — but onExit is empty, so no dispatch
    expect(phases).toEqual(['enter']);
  });
});

describe('Zone3D triggers — despawn, GUID, sim-gating', () => {
  it('synthesizes an exit when an occupant inside the zone is despawned', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    const phases: string[] = [];
    zone3DEvents.onZone((_z, _o, phase) => phases.push(phase), tw.world);

    tw.step(1);                 // enter
    occ.destroy(); tw.step(1);  // gone while inside → synthesized exit
    expect(phases).toEqual(['enter', 'exit']);
  });

  it('synthesizes an exit when the zone itself is despawned with an occupant inside', () => {
    tw = createTestWorld({ systems: [ZONE] });
    const zone = tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    const phases: string[] = [];
    zone3DEvents.onZone((_z, _o, phase) => phases.push(phase), tw.world);

    tw.step(1);                  // enter
    zone.destroy(); tw.step(1);  // zone gone → prior occupant exits
    expect(phases).toEqual(['enter', 'exit']);
  });

  it('journals stable GUIDs when both entities carry them (Percept)', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }), EntityAttributes({ guid: 'g-zone' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant, EntityAttributes({ guid: 'g-occ' }));
    tw.step(1);
    const j = tw.events({ type: '@zone' });
    expect(j).toHaveLength(1);
    expect(j[0].payload as { zone: string; other: string }).toMatchObject({ zone: 'g-zone', other: 'g-occ' });
  });

  it('clears the baseline on Stop so the next Play re-fires enter for what is already inside', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    let enters = 0, exits = 0;
    zone3DEvents.onZone((_z, _o, phase) => { if (phase === 'enter') enters++; else exits++; }, tw.world);

    tw.step(1);
    expect(enters).toBe(1);
    setPlayState('stopped'); tw.step(2);   // baseline cleared; no exit emitted on Stop
    expect(exits).toBe(0);
    setPlayState('playing'); tw.step(1);   // fresh start → re-enter for the still-inside occupant
    expect(enters).toBe(2);
  });

  it('pause freezes membership: no re-enter on resume', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    let enters = 0;
    zone3DEvents.onZoneEnter(() => { enters++; }, tw.world);

    tw.step(1);
    expect(enters).toBe(1);
    setPlayState('paused'); tw.step(3);    // frozen — membership kept
    setPlayState('playing'); tw.step(1);   // resume — still inside, no spurious re-enter
    expect(enters).toBe(1);
  });

  it('unsubscribe stops delivery', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    let count = 0;
    const off = zone3DEvents.onZone(() => { count++; }, tw.world);
    off();
    tw.step(3);
    expect(count).toBe(0);
  });

  it('onZoneExit helper fires only on exit', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    let exits = 0;
    zone3DEvents.onZoneExit(() => { exits++; }, tw.world);
    tw.step(1);                          // enter — not delivered to onZoneExit
    expect(exits).toBe(0);
    moveTo(occ, 100, 0, 0); tw.step(1);  // exit
    expect(exits).toBe(1);
  });

  it('a synthesized exit is despawn-safe: still-alive zone keeps its GUID, dead occupant falls back to its id', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }), EntityAttributes({ guid: 'g-zone' }));
    const occ = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant, EntityAttributes({ guid: 'g-occ' }));
    tw.step(1);
    const occId = occ.id();
    occ.destroy(); tw.step(1);   // gone while inside → synthesized exit; its GUID is no longer resolvable
    const exit = tw.events({ type: '@zone' }).find((e) => (e.payload as { phase: string }).phase === 'exit');
    expect(exit).toBeTruthy();
    // The zone survives (GUID kept); a destroyed entity can't resolve a GUID, so `other` is its id.
    expect(exit!.payload as { zone: string; other: number }).toMatchObject({ zone: 'g-zone', other: occId });
  });
});

describe('Zone3D triggers — occupant accounting', () => {
  it('a zone that is ALSO a ZoneOccupant never triggers on itself', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }), Zone3D({ shape: 'box' }), ZoneOccupant);
    let fired = 0;
    zone3DEvents.onZone(() => { fired++; }, tw.world);
    tw.step(2);
    expect(fired).toBe(0);
  });

  it('tracks each occupant independently inside one zone', () => {
    tw = createTestWorld({ systems: [ZONE] });
    tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 20, sy: 20, sz: 20 }), Zone3D({ shape: 'box' }));
    const a = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    const b = tw.spawn(Transform({ x: 100, y: 0, z: 0 }), ZoneOccupant);   // starts outside
    const inside = new Set<number>();
    zone3DEvents.onZone((_z, o, phase) => { if (phase === 'enter') inside.add(o.id()); else inside.delete(o.id()); }, tw.world);

    tw.step(1);
    expect([...inside]).toEqual([a.id()]);           // only A inside
    moveTo(b, 0, 0, 0); tw.step(1);                  // B enters; A stays
    expect(inside.has(a.id()) && inside.has(b.id())).toBe(true);
    moveTo(a, 100, 0, 0); tw.step(1);                // A leaves; B stays
    expect([...inside]).toEqual([b.id()]);
  });

  it('one occupant inside two overlapping same-channel zones gets one enter PER zone', () => {
    tw = createTestWorld({ systems: [ZONE] });
    const z1 = tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 10, sy: 10, sz: 10 }), Zone3D({ shape: 'box' }));
    const z2 = tw.spawn(Transform({ x: 0, y: 0, z: 0, sx: 10, sy: 10, sz: 10 }), Zone3D({ shape: 'box' }));
    tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant);
    const zonesHit = new Set<number>();
    zone3DEvents.onZoneEnter((z) => { zonesHit.add(z.id()); }, tw.world);
    tw.step(2);
    expect([...zonesHit].sort()).toEqual([z1.id(), z2.id()].sort());
  });

  it('uses the occupant WORLD position (parented occupant), not its local Transform', () => {
    tw = createTestWorld({ systems: [ZONE] });
    const parent = tw.spawn(Transform({ x: 10, y: 0, z: 0 }));
    // Child local (0,0,0) → world (10,0,0) once parented. The zone sits at the parent, half-extent 1.
    const child = tw.spawn(Transform({ x: 0, y: 0, z: 0 }), ZoneOccupant, EntityAttributes({ parentId: parent.id() }));
    tw.spawn(Transform({ x: 10, y: 0, z: 0, sx: 2, sy: 2, sz: 2 }), Zone3D({ shape: 'box' }));
    let enters = 0;
    zone3DEvents.onZoneEnter(() => { enters++; }, tw.world);
    tw.step(1);
    expect(enters).toBe(1);   // would be 0 if the system used the child's LOCAL (0,0,0)
    expect(child.id()).toBeTruthy();
  });
});

describe('Zone3D triggers — shape coverage', () => {
  // For each shape: an inside point fires enter, an outside point does not (verified via a fresh
  // occupant each time so counts are unambiguous). Containment matches the documented volume.
  function insideFires(zoneTraits: unknown[], x: number, y: number, z: number): boolean {
    const t = createTestWorld({ systems: [ZONE] });
    t.spawn(...zoneTraits);
    t.spawn(Transform({ x, y, z }), ZoneOccupant);
    let hit = false;
    zone3DEvents.onZoneEnter(() => { hit = true; }, t.world);
    t.step(1);
    zone3DEvents.__clear(t.world); t.dispose();
    return hit;
  }

  it('circle is a flat XZ disc (radius = sx), Y ignored', () => {
    const mk = () => [Transform({ x: 0, y: 0, z: 0, sx: 3, sy: 3, sz: 3 }), Zone3D({ shape: 'circle' })] as never;
    expect(insideFires(mk(), 0, 100, 0)).toBe(true);    // far in Y, still inside (Y ignored)
    expect(insideFires(mk(), 3.5, 0, 0)).toBe(false);   // radial 3.5 > 3
  });

  it('cylinder: radius = sx AND height clamp |dy| ≤ sy/2', () => {
    const mk = () => [Transform({ x: 0, y: 0, z: 0, sx: 3, sy: 4, sz: 3 }), Zone3D({ shape: 'cylinder' })] as never;
    expect(insideFires(mk(), 2.9, 1.9, 0)).toBe(true);
    expect(insideFires(mk(), 0, 2.1, 0)).toBe(false);   // above half-height 2
    expect(insideFires(mk(), 3.1, 0, 0)).toBe(false);   // outside radius
  });

  it('capsule: radius sx, caps + segment, includes the dz term', () => {
    const mk = () => [Transform({ x: 0, y: 0, z: 0, sx: 1, sy: 6, sz: 1 }), Zone3D({ shape: 'capsule' })] as never;
    expect(insideFires(mk(), 0, 0, 0.9)).toBe(true);    // radial via dz
    expect(insideFires(mk(), 0, 2.9, 0)).toBe(true);    // inside the top cap
    expect(insideFires(mk(), 0, 0, 1.1)).toBe(false);   // radial > 1
    expect(insideFires(mk(), 0, 3.1, 0)).toBe(false);   // past the cap tip
  });

  it('plane is a flat XZ rectangle (sx × sz), Y ignored', () => {
    const mk = () => [Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 1, sz: 6 }), Zone3D({ shape: 'plane' })] as never;
    expect(insideFires(mk(), 1.9, 100, 2.9)).toBe(true);   // within half-extents, Y ignored
    expect(insideFires(mk(), 2.1, 0, 0)).toBe(false);      // outside X half-extent
    expect(insideFires(mk(), 0, 0, 3.1)).toBe(false);      // outside Z half-extent
  });
});
