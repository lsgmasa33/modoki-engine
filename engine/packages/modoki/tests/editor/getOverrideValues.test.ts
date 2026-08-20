/** getOverrideValues unit tests — same diff logic as getOverrides, but
 *  emits the actual override VALUES so they can round-trip into scene files. */

import { describe, it, expect, beforeAll } from 'vitest';
import { trait } from 'koota';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';

async function getModule() {
  return import('../../src/editor/scene/prefab');
}

function makePrefab(entities: { localId: number; traits: Record<string, Record<string, unknown> | boolean> }[]) {
  // getOverrideValues only reads localId/traits per entity — PrefabEntity.name is
  // filled with a placeholder since these fixtures don't exercise naming.
  return { name: 'test', entities: entities.map((e) => ({ ...e, name: '' })), rootLocalId: 1, version: 1 as const };
}

describe('getOverrideValues', () => {
  it('returns empty object when fields match exactly', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 5, y: 10, z: 0 } } }]);
    expect(getOverrideValues(1, { Transform: { x: 5, y: 10, z: 0 } }, prefab)).toEqual({});
  });

  /** ── the boundary that makes added-child COMPACTION safe (kxcE2EBsVmrbbHpBzXMb) ──
   *
   *  `snapshotAddedTraits` now omits a field holding its SCHEMA default, because an added child
   *  has no prefab base and the loader refills from the schema. A member OVERRIDE is the opposite
   *  case and must NOT be compacted the same way: it is diffed against the PREFAB's value, so
   *  setting a field back to the koota default is a real, writable override whenever the prefab
   *  holds a non-default. This pins that the two rules stay apart.
   *
   *  (The mirror direction — an ABSENT base field reading as the schema default, which is what
   *  lets a compacted child be promoted into a prefab without every instance reporting a spurious
   *  override — is already covered by the "a base field that is ABSENT falls back to the schema
   *  default" describe below, which registers a trait double so the fallback actually runs.
   *  `Transform` is not registered in this file, so a test written here would pass on
   *  `getTraitByName` returning undefined rather than on the behaviour.) */
  it('WRITES an override that sets a field to the koota default, when the prefab holds a non-default', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 42 } } }]);
    // Live value 0 IS Transform.x's schema default — and still an override, because the base is 42.
    // No schema lookup is involved: `x` is present in the base, so this is meaningful unregistered.
    expect(getOverrideValues(1, { Transform: { x: 0 } }, prefab)).toEqual({ Transform: { x: 0 } });
  });

  it('emits the new value for changed numeric fields', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 5, y: 10, z: 0 } } }]);
    const out = getOverrideValues(1, { Transform: { x: 99, y: 10, z: 0 } }, prefab);
    expect(out).toEqual({ Transform: { x: 99 } });
  });

  it('emits the new value for changed string fields', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { EntityAttributes: { name: 'Tree' } } }]);
    expect(getOverrideValues(1, { EntityAttributes: { name: 'ModifiedTree' } }, prefab))
      .toEqual({ EntityAttributes: { name: 'ModifiedTree' } });
  });

  it('honors float tolerance — sub-1e-6 deltas are NOT overrides', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 1.0000001, y: 5 } } }]);
    expect(getOverrideValues(1, { Transform: { x: 1.0000002, y: 5 } }, prefab)).toEqual({});
  });

  it('skips parentId — it gets remapped at instantiation', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { EntityAttributes: { name: 'a', parentId: 0 } } }]);
    const out = getOverrideValues(1, { EntityAttributes: { name: 'a', parentId: 42 } }, prefab);
    expect(out).toEqual({});
  });

  it('skips EntityAttributes.guid — per-instance identity, never applies back to the prefab', async () => {
    const { getOverrideValues } = await getModule();
    // Prefab files clear guid to '' (templates carry no per-instance identity); the
    // live instance has a minted guid. That difference must NOT be an override.
    const prefab = makePrefab([{ localId: 1, traits: { EntityAttributes: { name: 'a', guid: '' } } }]);
    const out = getOverrideValues(1, {
      EntityAttributes: { name: 'a', guid: '43d67a90-3750-4b5f-888e-b91f39e76ae2' },
    }, prefab);
    expect(out).toEqual({});
  });

  it('captures a renamed instance member but still excludes its minted guid', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { EntityAttributes: { name: 'a', guid: '' } } }]);
    const out = getOverrideValues(1, {
      EntityAttributes: { name: 'renamed', guid: 'instance-guid' },
    }, prefab);
    expect(out).toEqual({ EntityAttributes: { name: 'renamed' } }); // name is a real override; guid is not
  });

  it('excludes guid even when the prefab base itself carries one (still instance-local)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { EntityAttributes: { name: 'a', guid: 'base-guid' } } }]);
    const out = getOverrideValues(1, {
      EntityAttributes: { name: 'a', guid: 'different-instance-guid' },
    }, prefab);
    expect(out).toEqual({});
  });

  it('skips PrefabInstance entirely', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 0 } } }]);
    const out = getOverrideValues(1, {
      Transform: { x: 0 },
      PrefabInstance: { source: 'x', localId: 1, rootInstanceId: 99 },
    }, prefab);
    expect(out).toEqual({});
  });

  it('returns empty when localId does not exist in prefab', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 0 } } }]);
    expect(getOverrideValues(99, { Transform: { x: 999 } }, prefab)).toEqual({});
  });

  it('groups multiple field changes under a single trait key', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 2, traits: { Transform: { x: 0, y: 0, z: 0 } } }]);
    const out = getOverrideValues(2, { Transform: { x: 1, y: 2, z: 0 } }, prefab);
    expect(out).toEqual({ Transform: { x: 1, y: 2 } });
  });

  it('handles multiple traits independently', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: {
        Transform: { x: 0 },
        Renderable3D: { color: 0xff0000, size: 1 },
      },
    }]);
    const out = getOverrideValues(1, {
      Transform: { x: 5 },
      Renderable3D: { color: 0x00ff00, size: 1 },
    }, prefab);
    expect(out).toEqual({
      Transform: { x: 5 },
      Renderable3D: { color: 0x00ff00 },
    });
  });

  it('ignores boolean (tag) traits in the prefab source', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Paused: true } }]);
    // Even if current data shape conflicts, getOverrideValues should skip
    expect(getOverrideValues(1, { Paused: { whatever: 1 } as Record<string, unknown> }, prefab)).toEqual({});
  });

  it('captures a whole trait the prefab does NOT define at that localId (added trait)', async () => {
    const { getOverrideValues } = await getModule();
    // Prefab child (localId 2) has only Transform; the user added Rotate3D on the instance.
    const prefab = makePrefab([{ localId: 2, traits: { Transform: { x: 0 } } }]);
    const out = getOverrideValues(2, {
      Transform: { x: 0 },
      Rotate3D: { axis: 'y', speed: 1.5 },
    }, prefab);
    expect(out).toEqual({ Rotate3D: { axis: 'y', speed: 1.5 } });
  });

  it('captures added traits on the root too (unified root+child path)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Transform: { x: 0 } } }]);
    const out = getOverrideValues(1, {
      Transform: { x: 0 },
      Rotate3D: { axis: 'z', speed: 2 },
    }, prefab);
    expect(out).toEqual({ Rotate3D: { axis: 'z', speed: 2 } });
  });

  it('captures an added tag trait the prefab lacks (empty-object override)', async () => {
    const { getOverrideValues } = await getModule();
    // Prefab child has only Transform; the user added the Paused tag on the instance.
    // readTraitData yields {} for a present tag, so currentTraits carries `Paused: {}`.
    const prefab = makePrefab([{ localId: 2, traits: { Transform: { x: 0 } } }]);
    const out = getOverrideValues(2, { Transform: { x: 0 }, Paused: {} }, prefab);
    expect(out).toEqual({ Paused: {} });
  });

  it('does NOT capture a tag the prefab already defines on that localId', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 2, traits: { Transform: { x: 0 }, Paused: true } }]);
    const out = getOverrideValues(2, { Transform: { x: 0 }, Paused: {} }, prefab);
    expect(out).toEqual({});
  });

  // --- AoS (array-of-structs) fields: compared by VALUE, not by reference. A
  //     plain `!==` would flag these on every rigged instance (the live array and
  //     the array from the prefab JSON are distinct instances even when equal). ---

  it('does NOT flag an array field whose contents match the base (AnimationLibrary.animSets)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { AnimationLibrary: { retarget: true, animSets: ['a1b2', 'c3d4'] } },
    }]);
    // Same contents, fresh array instance (what readTraitDataFull produces from the live ECS).
    const out = getOverrideValues(1, {
      AnimationLibrary: { retarget: true, animSets: ['a1b2', 'c3d4'] },
    }, prefab);
    expect(out).toEqual({});
  });

  it('flags an array field that actually differs (added entry)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { AnimationLibrary: { animSets: ['a1b2'] } } }]);
    const out = getOverrideValues(1, { AnimationLibrary: { animSets: ['a1b2', 'new5'] } }, prefab);
    expect(out).toEqual({ AnimationLibrary: { animSets: ['a1b2', 'new5'] } });
  });

  it('does NOT flag an array-of-objects field whose contents match (SkinnedMeshRenderer.materials)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { SkinnedMeshRenderer: { node: 'Body', materials: [{ slot: 0, material: 'mat-guid' }] } },
    }]);
    const out = getOverrideValues(1, {
      SkinnedMeshRenderer: { node: 'Body', materials: [{ slot: 0, material: 'mat-guid' }] },
    }, prefab);
    expect(out).toEqual({});
  });

  it('flags an array-of-objects field when a nested value differs', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { SkinnedMeshRenderer: { materials: [{ slot: 0, material: 'mat-a' }] } },
    }]);
    const out = getOverrideValues(1, {
      SkinnedMeshRenderer: { materials: [{ slot: 0, material: 'mat-b' }] },
    }, prefab);
    expect(out).toEqual({ SkinnedMeshRenderer: { materials: [{ slot: 0, material: 'mat-b' }] } });
  });

  it('does NOT flag an object field (boneMaps) whose contents match the base', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { AnimationLibrary: { boneMaps: { Hips: 'root', Spine: 'spine_01' } } },
    }]);
    // Key order intentionally shuffled — structural compare must ignore it.
    const out = getOverrideValues(1, {
      AnimationLibrary: { boneMaps: { Spine: 'spine_01', Hips: 'root' } },
    }, prefab);
    expect(out).toEqual({});
  });

  it('applies float tolerance to NESTED numbers (e.g. material color)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { SkinnedMeshRenderer: { materials: [{ color: 0.5000001 }] } },
    }]);
    const out = getOverrideValues(1, {
      SkinnedMeshRenderer: { materials: [{ color: 0.5000002 }] },
    }, prefab);
    expect(out).toEqual({});
  });

  it('agrees with getOverrides on the set of changed keys', async () => {
    const { getOverrideValues, getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 0, y: 0 }, EntityAttributes: { name: 'a' } },
    }]);
    const current = { Transform: { x: 1, y: 0 }, EntityAttributes: { name: 'b' } };
    const values = getOverrideValues(1, current, prefab);
    const keys = getOverrides(1, current, prefab);
    const fromValues = new Set<string>();
    for (const [t, fields] of Object.entries(values)) for (const f of Object.keys(fields)) fromValues.add(`${t}.${f}`);
    expect(fromValues).toEqual(keys);
  });
});

/** A field ABSENT from the prefab base means the trait's schema DEFAULT — not "unknown".
 *
 *  ⚠️ The gate used to be `origValue !== undefined`, so a base missing the field skipped the
 *  comparison entirely and a real instance override was never reported. That was latent for as long
 *  as prefab files wrote every field, and became REACHABLE on 2026-08-08 when `serializePrefab`
 *  started dropping BLANK asset refs (a prefab with no material stopped writing `material: ""`).
 *
 *  The save path survives it — `captureInstanceOverrides` folds marked fields back in — but the RAW
 *  callers do not: the Inspector's "overridden" highlight, and the Apply-to-Prefab / Revert-Overrides
 *  dialogs, which build their checkbox tree from these diffs. A field missing from the diff has no
 *  checkbox at all, so it cannot be applied or reverted. */
describe('getOverrideValues — a base field that is ABSENT falls back to the schema default', () => {
  const R2D = trait({ sprite: '', material: '', width: 1, height: 1 });

  beforeAll(() => {
    registerTrait({
      name: 'Renderable2DTestDouble', trait: R2D, category: 'component',
      fields: { sprite: { type: 'string' }, material: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } },
    });
  });

  it('reports a real GUID as an override even though the base omits the field', async () => {
    const { getOverrideValues } = await getModule();
    // Exactly what a stripped prefab looks like: no `material` key at all.
    const prefab = makePrefab([{ localId: 1, traits: { Renderable2DTestDouble: { sprite: 'circle', width: 80 } } }]);
    const out = getOverrideValues(1, {
      Renderable2DTestDouble: { sprite: 'circle', material: 'a026fcb5-eceb-463c-8afb-feed81965326', width: 80 },
    }, prefab);
    expect(out, 'the instance set a material the base does not have — that IS an override')
      .toEqual({ Renderable2DTestDouble: { material: 'a026fcb5-eceb-463c-8afb-feed81965326' } });
  });

  it('does NOT report an override when the instance also holds the default', async () => {
    // The other direction: absent base + default instance value are the same thing, so a diff here
    // would spam a spurious override onto every instance of every stripped prefab.
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { Renderable2DTestDouble: { sprite: 'circle', width: 80 } } }]);
    const out = getOverrideValues(1, { Renderable2DTestDouble: { sprite: 'circle', material: '', width: 80 } }, prefab);
    expect(out).toEqual({});
  });

  it('an UNREGISTERED trait still degrades safely (no schema to consult, no crash)', async () => {
    const { getOverrideValues } = await getModule();
    const prefab = makePrefab([{ localId: 1, traits: { NotRegisteredAnywhere: { a: 1 } } }]);
    expect(() => getOverrideValues(1, { NotRegisteredAnywhere: { a: 1, b: 2 } }, prefab)).not.toThrow();
  });
});
