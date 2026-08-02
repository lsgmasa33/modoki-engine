/** LOCAL ↔ WORLD Transform authoring (`set_transform {space}`) — the FILE-path conversion.
 *
 *  The bug this exists to prevent, measured 2026-07-30 against a real editor: `set_transform`'s
 *  `position` was documented as "World position" and wrote the LOCAL fields, so asking for a
 *  parented entity's OWN CURRENT world position moved it by exactly the parent offset and reported
 *  success. Read and write were in different spaces and nothing said so.
 *
 *  The load-bearing test here is the ROUND TRIP: local → world → local must return the original.
 *  A conversion that is merely "reasonable" is not enough — an authoring tool has to be exact, or
 *  every edit drifts.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  parentWorldTrs, localToWorldTrs, worldToLocalTrs, mergeTrs, persistedTrsKeys, collapsedParentAxes, matrixToTrs, type TRS,
} from '../../src/runtime/scene/transformSpace';
import type { MutableEntity } from '../../src/runtime/scene/sceneMutate';

const trs = (p: Partial<TRS>): TRS => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, ...p });

/** An entity in the format scene files ACTUALLY use: `EntityAttributes.parentId` is a GUID STRING
 *  and every entity carries `EntityAttributes.guid`.
 *
 *  These fixtures used to pass a NUMERIC parentId, which is the legacy form. That is why the
 *  original conversion — which accepted only numbers — passed every test here while being a silent
 *  no-op against every real scene on disk. A fixture that encodes the author's assumption instead
 *  of the on-disk shape proves nothing about production. `entLegacy` below keeps one numeric case,
 *  deliberately, so both forms stay covered. */
const guidOf = (id: number) => `0000000${id}-0000-4000-8000-00000000000${id}`;

const ent = (id: number, t: Partial<TRS>, parentId = 0): MutableEntity => ({
  id,
  traits: {
    Transform: { ...trs(t) } as unknown as Record<string, unknown>,
    EntityAttributes: { guid: guidOf(id), ...(parentId ? { parentId: guidOf(parentId) } : {}) },
  },
});

/** A PREFAB-INSTANCE ancestor, in the shape `serialize.ts` really writes: only `PrefabInstance` in
 *  `traits`, with the placement in `overrides[localId].Transform`. Verified against
 *  `games/sling/runtime/assets/scenes/Base.json` (`Fish Zone L`, overrides["1"].Transform at
 *  (-9.5,-1.7,-2) scale 3) — 25 such instances exist across games/ and demos/. */
const entInstance = (id: number, t: Partial<TRS>, parentId = 0, localId = 1): MutableEntity => ({
  id,
  prefab: 'p-guid',
  traits: {
    PrefabInstance: { localId } as unknown as Record<string, unknown>,
    EntityAttributes: { guid: guidOf(id), ...(parentId ? { parentId: guidOf(parentId) } : {}) },
  },
  overrides: { [localId]: { Transform: { ...trs(t) } } },
} as unknown as MutableEntity);

/** The LEGACY numeric-parentId shape, still readable. */
const entLegacy = (id: number, t: Partial<TRS>, parentId = 0): MutableEntity => ({
  id,
  traits: { Transform: { ...trs(t) } as unknown as Record<string, unknown>, EntityAttributes: { parentId } },
});

const near = (a: TRS, b: TRS, eps = 1e-9) => {
  for (const k of Object.keys(a) as (keyof TRS)[]) {
    expect(Math.abs(a[k] - b[k]), `${k}: ${a[k]} vs ${b[k]}`).toBeLessThan(eps);
  }
};

describe('parentWorldTrs — walking the chain', () => {
  it('is null for a root entity (world == local, nothing to convert)', () => {
    const scene = [ent(1, { x: 5 })];
    expect(parentWorldTrs(scene, scene[0])).toBeNull();
  });

  it('returns the parent world transform for one level', () => {
    const scene = [ent(1, { x: 10, y: 20 }), ent(2, { x: 3 }, 1)];
    near(parentWorldTrs(scene, scene[1])!, trs({ x: 10, y: 20 }));
  });

  it('composes a multi-level chain', () => {
    const scene = [ent(1, { x: 10 }), ent(2, { x: 5 }, 1), ent(3, { x: 1 }, 2)];
    near(parentWorldTrs(scene, scene[2])!, trs({ x: 15 }));
  });

  it('survives a parentId CYCLE instead of hanging (hand-edited scenes exist)', () => {
    const a = ent(1, { x: 1 }, 2);
    const b = ent(2, { x: 1 }, 1);
    expect(() => parentWorldTrs([a, b], a)).not.toThrow();
  });

  it('resolves a GUID parentId — the form every real scene file uses', () => {
    // The regression that shipped: with only the numeric form accepted, this returned null for a
    // genuinely parented entity, and world->local silently became a pass-through.
    const scene = [ent(1, { x: 10, y: 20 }), ent(2, { x: 3 }, 1)];
    const p = parentWorldTrs(scene, scene[1]);
    expect(p, 'a GUID parentId must resolve to the parent, not null').not.toBeNull();
    near(p!, trs({ x: 10, y: 20 }));
  });

  it('still resolves the LEGACY numeric parentId', () => {
    const scene = [entLegacy(1, { x: 10 }), entLegacy(2, { x: 3 }, 1)];
    near(parentWorldTrs(scene, scene[1])!, trs({ x: 10 }));
  });

  it('a GUID chain composes across multiple levels', () => {
    const scene = [ent(1, { x: 10 }), ent(2, { x: 5 }, 1), ent(3, { x: 1 }, 2)];
    near(parentWorldTrs(scene, scene[2])!, trs({ x: 15 }));
  });

  it('treats a DANGLING parentId as root rather than throwing', () => {
    const scene = [ent(2, { x: 3 }, 999)];
    expect(parentWorldTrs(scene, scene[0])).toBeNull();
  });
});

/** REGRESSION (independent review, 2026-07-30). `trsOf` read only `traits.Transform`, but a
 *  serialized prefab-instance root has NO top-level Transform — `serialize.ts` writes only
 *  `PrefabInstance` for a captured root and puts the placement in `overrides[localId]`. So every
 *  instance ancestor composed as IDENTITY and a `space:'world'` write under one was off by the
 *  instance's whole placement, reported as success. `sceneMutate.ts`'s `traitWriteContainer` has
 *  encoded this rule for WRITES all along; this is the read side of it. */
describe('a PREFAB-INSTANCE ancestor contributes its override Transform, not identity', () => {
  it('reads the placement out of overrides[localId]', () => {
    const scene = [entInstance(1, { x: -9.5, y: -1.7, z: -2, sx: 3, sy: 3, sz: 3 }), ent(2, {}, 1)];
    const p = parentWorldTrs(scene, scene[1]);
    expect(p, 'an instance ancestor must not be null/identity').not.toBeNull();
    near(p!, trs({ x: -9.5, y: -1.7, z: -2, sx: 3, sy: 3, sz: 3 }));
  });

  it('so a world-space placement under an instance lands where it was asked to', () => {
    // The measured failure: the marker was written local (-9.5,-1.7,-2) — the WORLD value verbatim
    // — and therefore ended up at world (-38,-6.8,-8) once composed against the instance.
    const scene = [entInstance(1, { x: -9.5, y: -1.7, z: -2, sx: 3, sy: 3, sz: 3 }), ent(2, {}, 1)];
    const parent = parentWorldTrs(scene, scene[1])!;
    const local = worldToLocalTrs(trs({ x: -9.5, y: -1.7, z: -2 }), parent);
    // The instance's own origin — and local scale 1/3, since a world scale of 1 under a parent
    // scaled 3 IS one third. (Getting this wrong first time is a good illustration of why the
    // conversion is worth a test rather than an eyeball.)
    near(local, trs({ x: 0, y: 0, z: 0, sx: 1 / 3, sy: 1 / 3, sz: 1 / 3 }), 1e-9);
    // …and composing it back reproduces the requested world point.
    near(localToWorldTrs(local, parent), trs({ x: -9.5, y: -1.7, z: -2 }), 1e-9);
  });

  it('an instance whose override has no Transform is still identity — the KNOWN, narrower gap', () => {
    // Its placement lives in the prefab FILE, which this module is not given. Pinned so the
    // limitation is explicit rather than looking like the bug above.
    const noTf = { id: 1, prefab: 'p', traits: { PrefabInstance: { localId: 1 }, EntityAttributes: { guid: guidOf(1) } },
      overrides: { 1: { EntityAttributes: { name: 'X' } } } } as unknown as MutableEntity;
    const scene = [noTf, ent(2, {}, 1)];
    near(parentWorldTrs(scene, scene[1])!, trs({}));
  });
});

/** REGRESSION (independent review, 2026-07-30; behaviour decided by the owner 2026-07-31).
 *
 *  Both conversions computed the whole pose correctly and then wrote back ONLY the keys the caller
 *  had literally named — which under a rotated parent throws away part of their own answer, because
 *  a world X maps onto local x, y AND z together. So `{space:'world', x:10}` kept x, dropped the
 *  y/z that made it correct, and left the entity somewhere else while reporting `changed:1`.
 *
 *  Decision: write every axis the conversion touched, expanded by GROUP (position / rotation /
 *  scale). Group-wise rather than all-nine so a position write does not land decompose noise on
 *  rotation and scale, which the caller never mentioned. */
describe('persistedTrsKeys — a partial world write persists the whole coupled group', () => {
  it('expands a single position axis to x, y and z', () => {
    expect(persistedTrsKeys({ x: 10 })).toEqual(['x', 'y', 'z']);
  });

  it('does NOT drag in rotation or scale for a position-only write', () => {
    // The reason it is not simply "write all nine": those come back through a decompose
    // round-trip, so writing them would dirty axes the caller never named.
    expect(persistedTrsKeys({ x: 10 })).not.toContain('rx');
    expect(persistedTrsKeys({ x: 10 })).not.toContain('sx');
  });

  it('expands each group independently, in TRS order', () => {
    expect(persistedTrsKeys({ y: 1, rz: 0.5 })).toEqual(['x', 'y', 'z', 'rx', 'ry', 'rz']);
    expect(persistedTrsKeys({ sy: 2 })).toEqual(['sx', 'sy', 'sz']);
  });

  it('persists nothing when no TRS field was named', () => {
    expect(persistedTrsKeys({ someOtherField: 1 })).toEqual([]);
  });

  it('the expanded write actually LANDS the request under a rotated parent', () => {
    // End to end: ask for world x only, keep just the keys the rule says to persist, and confirm
    // the entity is where it was asked to be. Filtering to ['x'] alone is what used to fail here.
    const parent = trs({ rz: Math.PI / 4 });
    const local = trs({});
    const wantWorld = mergeTrs(localToWorldTrs(local, parent), { x: 10 });
    const nextLocal = worldToLocalTrs(wantWorld, parent);

    const persisted: Record<string, number> = { ...local } as unknown as Record<string, number>;
    for (const k of persistedTrsKeys({ x: 10 })) persisted[k] = nextLocal[k];
    expect(localToWorldTrs(persisted as unknown as TRS, parent).x).toBeCloseTo(10, 9);

    // …and the old key-wise filter demonstrably does not.
    const named: Record<string, number> = { ...local } as unknown as Record<string, number>;
    named.x = nextLocal.x;
    expect(localToWorldTrs(named as unknown as TRS, parent).x).not.toBeCloseTo(10, 6);
  });
});

/** REGRESSION (independent review, 2026-07-30; behaviour decided by the owner 2026-07-31).
 *
 *  A zero-scaled ancestor collapses every descendant onto its origin, so a world-space placement
 *  under it has NO solution — and both paths answered one anyway, silently and DIFFERENTLY:
 *  three.js `decompose` hits its `det === 0` branch and substitutes scale (1,1,1) + an identity
 *  quaternion, so the collapsed parent read back as unscaled AND unrotated; the exact-inverse path
 *  inverted a singular matrix to the zero matrix. Two confident wrong answers.
 *
 *  Decision: refuse, naming the collapsed axes. */
describe('collapsedParentAxes — a request with no solution is refused, not guessed', () => {
  it('names the zero-scaled axes', () => {
    expect(collapsedParentAxes(trs({ sx: 0 }))).toEqual(['x']);
    expect(collapsedParentAxes(trs({ sy: 0, sz: 0 }))).toEqual(['y', 'z']);
  });

  it('is null for an invertible parent, and for a root (nothing to convert)', () => {
    expect(collapsedParentAxes(trs({ sx: 2, sy: 0.5, sz: 1 }))).toBeNull();
    expect(collapsedParentAxes(null)).toBeNull();
  });

  it('treats float dust as collapsed — 1e-12 is zero for every practical purpose', () => {
    expect(collapsedParentAxes(trs({ sx: 1e-12 }))).toEqual(['x']);
    // …but a small, genuinely usable scale is not.
    expect(collapsedParentAxes(trs({ sx: 1e-4 }))).toBeNull();
  });

  it('is exactly the case where decompose LIES about the parent', () => {
    // The mechanism, pinned: a singular parent matrix decomposes to an identity-ish TRS, which is
    // why the old code produced a plausible number instead of failing.
    const collapsed = trs({ sx: 0, rz: Math.PI / 4 });
    const roundTripped = matrixToTrs(
      new THREE.Matrix4().compose(
        new THREE.Vector3(collapsed.x, collapsed.y, collapsed.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(collapsed.rx, collapsed.ry, collapsed.rz)),
        new THREE.Vector3(collapsed.sx, collapsed.sy, collapsed.sz)),
    );
    expect(roundTripped.sx, 'decompose substitutes scale 1 on a singular matrix').toBeCloseTo(1, 9);
    expect(roundTripped.rz, '…and drops the rotation entirely').toBeCloseTo(0, 9);
    // Which is precisely why the guard reads the ORIGINAL parent, not a decomposed copy.
    expect(collapsedParentAxes(collapsed)).toEqual(['x']);
  });
});

describe('the round trip is exact — an authoring conversion that drifts is useless', () => {
  const cases: Array<[string, TRS, TRS]> = [
    ['translation only', trs({ x: 10, y: 20, z: 30 }), trs({ x: 1, y: 2, z: 3 })],
    ['rotated parent', trs({ x: 5, ry: Math.PI / 3 }), trs({ x: 2, y: 1, z: -4 })],
    ['uniformly scaled parent', trs({ x: 1, sx: 2, sy: 2, sz: 2 }), trs({ x: 3, y: 4, z: 5 })],
    ['rotated + scaled parent', trs({ x: 1, y: 2, rx: 0.3, ry: -0.7, rz: 1.1, sx: 2, sy: 2, sz: 2 }), trs({ x: 3, rz: 0.5, sx: 1.5, sy: 1.5, sz: 1.5 })],
    ['rotated child under rotated parent', trs({ ry: Math.PI / 4 }), trs({ x: 1, rx: 0.2, ry: 0.4, rz: -0.6 })],
  ];

  for (const [label, parent, local] of cases) {
    it(`${label}: local → world → local recovers the original`, () => {
      const world = localToWorldTrs(local, parent);
      near(worldToLocalTrs(world, parent), local, 1e-9);
    });
  }

  it('is the IDENTITY for a root entity (no parent), not an approximation', () => {
    const local = trs({ x: 1.25, ry: 0.5, sx: 3 });
    expect(worldToLocalTrs(local, null)).toEqual(local);
    expect(localToWorldTrs(local, null)).toEqual(local);
  });

  it('reproduces the ORIGINAL BUG when the space is mistaken', () => {
    // The exact shape measured live: parent at (200,247), child local (623,679) → world (823,926).
    // Writing that world value as LOCAL is what displaced the entity by the parent offset.
    const parent = trs({ x: 199.722234, y: 247.130619 });
    const local = trs({ x: 623.496094, y: 679.0625 });
    const world = localToWorldTrs(local, parent);
    expect(world.x).toBeCloseTo(823.218328, 5);
    expect(world.y).toBeCloseTo(926.193119, 5);

    // The fix: asking for the entity's OWN current world position must be a NO-OP.
    near(worldToLocalTrs(world, parent), local, 1e-9);

    // …whereas the old behaviour (writing world numbers into the local fields) moved it again by
    // the parent offset — this is the regression, pinned so it cannot come back quietly.
    const ifWrittenAsLocal = localToWorldTrs(world, parent);
    expect(ifWrittenAsLocal.x).toBeCloseTo(1022.940562, 5);
  });
});

describe('mergeTrs — a PARTIAL write must convert as a whole pose', () => {
  it('overlays only the supplied numeric fields', () => {
    const base = trs({ x: 1, y: 2, z: 3, sx: 9 });
    expect(mergeTrs(base, { y: 99 })).toEqual({ ...base, y: 99 });
  });

  it('ignores non-numeric junk rather than writing NaN', () => {
    const base = trs({ x: 1 });
    expect(mergeTrs(base, { x: 'nope', y: null, z: undefined } as Record<string, unknown>)).toEqual(base);
  });

  it('a world X under a ROTATED parent changes local Y/Z too — the reason for whole-pose conversion', () => {
    // Field-by-field conversion would treat local.x as a function of world.x alone. It is not:
    // under rotation the axes mix, so converting one field in isolation silently moves the others.
    const parent = trs({ ry: Math.PI / 2 });
    const local = trs({ x: 1, y: 0, z: 0 });
    const world = localToWorldTrs(local, parent);
    const nextLocal = worldToLocalTrs(mergeTrs(world, { x: 5 }), parent);
    // Under a 90° Y rotation, moving in world X moves the child along its local Z.
    expect(Math.abs(nextLocal.z - local.z)).toBeGreaterThan(1);
  });
});
