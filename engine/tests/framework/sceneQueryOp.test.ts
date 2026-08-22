/** The `scene-query` agent op (#288 gap 1) — raycast / shapecast / point-pick over the live
 *  physics world, behind `modoki_scene_query`.
 *
 *  What is actually worth pinning here is the REFUSAL TAXONOMY, not the casting. Rapier does the
 *  casting and `physics3DSystem.test.ts` already proves it; what this op adds is the ability to
 *  tell three outcomes apart that every underlying function collapses onto a single `null`:
 *
 *    • no physics world exists at all  → NOT_AVAILABLE_HERE
 *    • the direction has zero length   → REFUSED_BY_OP
 *    • the ray genuinely hit nothing   → ok:true, hit:null
 *
 *  In game code that collapse is harmless — the next line is `if (hit)`. Through a tool it is
 *  §0's rank-2 failure: "could not look" reported authoritatively as "nothing is there". The
 *  miss-versus-refusal assertions below are the ones QA could not write before this op existed.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  createTestWorld, type TestWorld,
  Transform, EntityAttributes, RigidBody3D, Collider3D, Physics3D,
  RigidBody2D, Collider2D, Physics2D,
  physics3DSystem, physics2DSystem, disposePhysics3D, disposePhysics2D,
  initRapier3D, initRapier2D,
} from '@modoki/engine/runtime';
import { SYSTEM_PRIORITY } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

// Rapier is WASM and loads asynchronously; the physics systems no-op until it is ready, so
// without this every `step()` below would build no world and every query would refuse — the
// refusal being CORRECT would make the whole file pass vacuously except for the assertions that
// expect a hit. (It did, on the first run: 12 of 16 failed with 'no 3D physics world'.)
beforeAll(async () => { await Promise.all([initRapier3D(), initRapier2D()]); });

const PHYS3 = { name: 'phys3', priority: SYSTEM_PRIORITY.PHYSICS, fn: physics3DSystem };
const PHYS2 = { name: 'phys2', priority: SYSTEM_PRIORITY.PHYSICS, fn: physics2DSystem };

let tw: TestWorld | undefined;
afterEach(() => {
  if (tw) { disposePhysics3D(tw.world); disposePhysics2D(tw.world); tw.dispose(); }
  tw = undefined;
});

type Reply = {
  ok?: boolean; code?: string; error?: string; hint?: string; options?: string[];
  kind?: string; dim?: string;
  hit?: { entityId: number; guid: string | null; name: string | null; point?: number[]; normal?: number[]; distance?: number } | null;
};
const q = (params: unknown) => runAgentOp('scene-query', params) as Promise<Reply>;

/** A floor at y=0 (half-height 1, so its top surface is y=1) with a name + guid, in a stepped
 *  3D world. Stepping once is what BUILDS the Rapier world — before that there is none. */
function floorWorld3D() {
  tw = createTestWorld({ systems: [PHYS3] });
  tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
  const floor = tw.spawn(
    EntityAttributes({ name: 'Floor', guid: 'floor-guid-0001' }),
    Transform({ x: 0, y: 0, z: 0 }),
    RigidBody3D({ bodyType: 'static' }),
    Collider3D({ shape: 'box', halfW: 100, halfH: 1, halfD: 100 }),
  );
  tw.step(1);
  return floor;
}

describe('scene-query: a refusal is never dressed up as a miss', () => {
  it('NO PHYSICS WORLD refuses NOT_AVAILABLE_HERE — the stopped-editor case', async () => {
    // A world with no physics system has no Rapier world at all. raycast3D answers `null` here,
    // exactly as it does for a clean miss — so an op that just forwarded it would tell the agent
    // the ray flew through empty space.
    tw = createTestWorld({ systems: [] });
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    expect(r.hit).toBeUndefined();               // no null hit to misread
    expect(String(r.error)).toMatch(/NOT "the query missed"/);
    expect(String(r.hint)).toMatch(/play/i);     // …and it says how to get a world
  });

  it('the 2D and 3D worlds are SEPARATE — a 2d query on a 3d-only scene refuses', async () => {
    floorWorld3D();
    const r = await q({ kind: 'raycast', dim: '2d', origin: [0, 10], direction: [0, -1] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    expect(String(r.error)).toMatch(/2D physics world/);
  });

  it('a ZERO-LENGTH direction refuses instead of reporting a miss', async () => {
    floorWorld3D();
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, 0, 0] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    // The realistic way in: normalizing a delta between two coincident points. "Nothing was hit"
    // would send the caller looking for a missing collider instead of at their own arithmetic.
    expect(String(r.error)).toMatch(/NOT a miss/);
  });

  it('a GENUINE miss is ok:true with hit:null — the answer the refusals make trustworthy', async () => {
    floorWorld3D();
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, 1, 0], maxDistance: 5 });
    expect(r.ok).toBe(true);
    expect(r.hit).toBeNull();
  });
});

describe('scene-query: hits are addressed by GUID, not by runtime id', () => {
  it('a raycast hit carries guid + name alongside the raw id', async () => {
    const floor = floorWorld3D();
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0], maxDistance: 100 });
    expect(r.ok).toBe(true);
    expect(r.hit?.entityId).toBe(floor.id());
    // §3: the raw id is reassigned on every scene reload (and a mutate triggers one), so handing
    // it back as the only address is handing back something that expires.
    expect(r.hit?.guid).toBe('floor-guid-0001');
    expect(r.hit?.name).toBe('Floor');
    expect(r.hit?.distance).toBeCloseTo(9, 1);   // y=10 down to the floor top at y=1
    expect(r.hit?.normal?.[1]).toBeCloseTo(1, 1); // pointing up
    expect(r.hit?.point).toHaveLength(3);
  });

  it('exclude takes a NAME or a guid and keeps that body out of the result', async () => {
    floorWorld3D();
    const before = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0] });
    expect(before.hit?.name).toBe('Floor');
    for (const spec of ['Floor', 'floor-guid-0001']) {
      const after = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0], exclude: spec });
      expect(after.ok, `exclude:${spec}`).toBe(true);
      expect(after.hit, `exclude:${spec}`).toBeNull();
    }
  });

  it('an AMBIGUOUS exclude name is refused, never first-matched', async () => {
    tw = createTestWorld({ systems: [PHYS3] });
    tw.spawn(Physics3D({ gravityX: 0, gravityY: -9.81, gravityZ: 0 }));
    for (const guid of ['dup-a', 'dup-b']) {
      tw.spawn(
        EntityAttributes({ name: 'Wall', guid }),
        Transform({ x: guid === 'dup-a' ? -5 : 5, y: 0, z: 0 }),
        RigidBody3D({ bodyType: 'static' }),
        Collider3D({ shape: 'box', halfW: 1, halfH: 1, halfD: 1 }),
      );
    }
    tw.step(1);
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0], exclude: 'Wall' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AMBIGUOUS');
    // The refusal must hand back the guids, or the caller has no way to proceed.
    expect(r.options).toEqual(['dup-a', 'dup-b']);
  });

  it('an exclude that matches nothing refuses rather than silently casting unfiltered', async () => {
    floorWorld3D();
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0], exclude: 'Nope' });
    expect(r.ok).toBe(false);
    // Dropping the filter would answer a DIFFERENT question than the one asked, and report ok.
    expect(String(r.error)).toMatch(/no entity named or guid'd/);
  });
});

describe("scene-query: kind:'point' keeps its own shape", () => {
  it('reports containment, and does NOT pad distance/normal with zeros', async () => {
    floorWorld3D();
    const inside = await q({ kind: 'point', dim: '3d', point: [0, 0, 0] });
    expect(inside.ok).toBe(true);
    expect(inside.hit?.guid).toBe('floor-guid-0001');
    // §2 — same field name, same meaning, or ABSENT. A zeroed `distance` here would mean
    // something different from a `distance:0` on a raycast (which means "started inside"), and
    // that drift is exactly what the rule exists to stop.
    expect(inside.hit).not.toHaveProperty('distance');
    expect(inside.hit).not.toHaveProperty('normal');
    expect(inside.hit).not.toHaveProperty('point');
  });

  it('a point in empty space is a null hit, not a refusal', async () => {
    floorWorld3D();
    const outside = await q({ kind: 'point', dim: '3d', point: [0, 50, 0] });
    expect(outside.ok).toBe(true);
    expect(outside.hit).toBeNull();
  });
});

describe('scene-query: 2D is a first-class citizen, not a subset', () => {
  // #288 lists four queries; there are six. Building only the four would have shipped a surface
  // with three 3D kinds and one 2D kind, for no reason.
  it('all three kinds work in 2d', async () => {
    tw = createTestWorld({ systems: [PHYS2] });
    tw.spawn(Physics2D({ gravityX: 0, gravityY: 0 }));
    tw.spawn(
      EntityAttributes({ name: 'Block2D', guid: 'block-2d-0001' }),
      Transform({ x: 0, y: 0 }),
      RigidBody2D({ bodyType: 'static' }),
      Collider2D({ shape: 'box', halfW: 10, halfH: 10 }),
    );
    tw.step(1);

    const ray = await q({ kind: 'raycast', dim: '2d', origin: [-100, 0], direction: [1, 0] });
    expect(ray.hit?.guid).toBe('block-2d-0001');
    // 2D vectors are 2-arity — a 3-arity origin is refused rather than silently truncated.
    expect(ray.hit?.point).toHaveLength(2);

    const sweep = await q({ kind: 'shapecast', dim: '2d', origin: [-100, 0], direction: [1, 0], radius: 2 });
    expect(sweep.hit?.guid).toBe('block-2d-0001');

    const pick = await q({ kind: 'point', dim: '2d', point: [0, 0] });
    expect(pick.hit?.guid).toBe('block-2d-0001');
  });

  it('a vector of the wrong arity for the dimension is refused', async () => {
    floorWorld3D();
    const r = await q({ kind: 'raycast', dim: '3d', origin: [0, 10], direction: [0, -1, 0] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/3 finite numbers/);
  });
});

describe('scene-query: an unsupported argument is refused, not ignored', () => {
  it("exclude on kind:'shapecast' refuses — castShape has no exclusion filter", async () => {
    floorWorld3D();
    const r = await q({ kind: 'shapecast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0], radius: 1, exclude: 'Floor' });
    expect(r.ok).toBe(false);
    // Accepting and dropping it would be the worse outcome by far: the caster's own body is the
    // single most likely hit for a sweep, so the answer would look plausible and be wrong.
    expect(String(r.error)).toMatch(/not supported for kind:'shapecast'/);
  });

  it('shapecast without a positive radius is refused', async () => {
    floorWorld3D();
    for (const radius of [undefined, 0, -1]) {
      const r = await q({ kind: 'shapecast', dim: '3d', origin: [0, 10, 0], direction: [0, -1, 0], ...(radius !== undefined ? { radius } : {}) });
      expect(r.ok, `radius=${radius}`).toBe(false);
      expect(String(r.error)).toMatch(/positive finite radius/);
    }
  });

  it('a missing kind or dim is refused with the real options', async () => {
    floorWorld3D();
    expect((await q({ dim: '3d' })).options).toEqual(['raycast', 'shapecast', 'point']);
    expect((await q({ kind: 'point' })).options).toEqual(['2d', '3d']);
  });
});
