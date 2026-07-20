import { describe, it, expect, afterEach } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Transform } from '../../src/runtime/traits/Transform';
import { Zone2D } from '../../src/runtime/traits/Zone2D';
import { Zone3D } from '../../src/runtime/traits/Zone3D';
import { ZoneOccupant } from '../../src/runtime/traits/ZoneOccupant';
import { OnZone2D } from '../../src/runtime/traits/OnZone2D';
import { zone2DSystem } from '../../src/runtime/systems/zone2DSystem';
import { zone3DSystem } from '../../src/runtime/systems/zone3DSystem';
import { zone2DEvents } from '../../src/runtime/managers/Zone2DEvents';
import { zone3DEvents } from '../../src/runtime/managers/Zone3DEvents';

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
