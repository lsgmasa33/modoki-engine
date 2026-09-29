/** sceneMutate unit tests — setTrait / addEntity / removeEntity on the on-disk
 *  scene shape. Deterministic GUID minting injected. Pure, no world. */

import { describe, it, expect } from 'vitest';
import { applyOps, assignSyntheticEntityIds, stripBackfilledEntityIds, ALSO_DELETED_CAP, type MutableScene, type MutateOp } from '../../src/runtime/scene/sceneMutate';
import { validateSceneData, type SceneSchema } from '../../src/runtime/loaders/sceneValidation';
import { formatRuntimeGuid } from '../../src/runtime/core/assetRefRules';
import { worldTrsOf } from '../../src/runtime/scene/transformSpace';
import * as THREE from 'three';

let guidN = 0;
const mint = () => `guid-${++guidN}`;

function freshScene(): MutableScene {
  guidN = 0;
  return {
    version: 8,
    entities: [
      { id: 1, name: 'Root', traits: { EntityAttributes: { name: 'Root', guid: 'g-root', parentId: 0 } } },
      { id: 2, name: 'Child', traits: { EntityAttributes: { name: 'Child', guid: 'g-child', parentId: 1 }, Transform: { x: 0, y: 0, z: 0 } } },
    ],
  };
}

describe('applyOps — setTrait', () => {
  it('patches existing trait fields, merging', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'setTrait', entity: { name: 'Child' }, trait: 'Transform', fields: { x: 5 } }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1);
    expect(scene.entities[1].traits.Transform).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('adds a new trait if absent', () => {
    const scene = freshScene();
    applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Rotate3D', fields: { speed: 2 } }], mint);
    expect(scene.entities[0].traits.Rotate3D).toEqual({ speed: 2 });
  });

  // #1216 C-12 / #1223 D6: the add was silent — `changed:1`, the same answer as a field edit.
  // Mutation: drop the `addedTraits.push` in applyOps' setTrait branch.
  it('says which trait it added, and lists neither an edit nor a tag', () => {
    const scene = freshScene();
    const res = applyOps(scene, [
      { op: 'setTrait', entity: { id: 1 }, trait: 'Rotate3D', fields: { speed: 2 } },
      { op: 'setTrait', entity: { id: 2 }, trait: 'Transform', fields: { x: 1 } },
      { op: 'setTrait', entity: { id: 2 }, trait: 'Persistent' },
    ], mint);
    expect(res.addedTraits).toEqual([{ op: 0, id: 1, guid: 'g-root', trait: 'Rotate3D' }]);
    expect(applyOps(freshScene(), [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', fields: { x: 1 } }], mint).addedTraits).toBeUndefined();
  });

  it('sets a tag when no fields given', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Persistent' }], mint);
    expect(scene.entities[0].traits.Persistent).toBe(true);
    expect(res.changed).toBe(1); // a fresh tag is a real change
  });

  it('re-tagging an existing trait is a no-op and does not count as changed (F6)', () => {
    const scene = freshScene();
    // 'Child' already has Transform as a component object. Re-tagging it (no fields)
    // must neither clobber the data nor report a change.
    const res = applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform' }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(0);
    expect(scene.entities[1].traits.Transform).toEqual({ x: 0, y: 0, z: 0 }); // untouched
  });

  it('resolves by guid', () => {
    const scene = freshScene();
    applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-child' }, trait: 'Transform', fields: { y: 9 } }], mint);
    expect((scene.entities[1].traits.Transform as { y: number }).y).toBe(9);
  });

  it('errors when entity not found', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'setTrait', entity: { name: 'Ghost' }, trait: 'Transform', fields: { x: 1 } }], mint);
    expect(res.changed).toBe(0);
    expect(res.errors.join('\n')).toMatch(/no entity matching/);
  });

  it('errors on ambiguous name match', () => {
    const scene = freshScene();
    scene.entities.push({ id: 3, name: 'Child', traits: {} });
    const res = applyOps(scene, [{ op: 'setTrait', entity: { name: 'Child' }, trait: 'Transform', fields: { x: 1 } }], mint);
    expect(res.errors.join('\n')).toMatch(/match.*disambiguate/);
  });

  // #1223 D1: the FILE path let `id` win over a guid given beside it, the opposite of the live path, so
  // one ref named two different entities depending on the persistence mode. Mutation: delete the
  // `given.length > 1` refusal in resolveEntity.
  it('refuses a ref carrying two addresses (AMBIGUOUS), and treats an empty string as absent', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'setTrait', entity: { id: 1, guid: 'g-child' }, trait: 'Transform', fields: { x: 7 } }], mint);
    expect(res.changed).toBe(0);
    expect(res.code).toBe('AMBIGUOUS');
    expect(res.errors.join('\n')).toMatch(/given together/);
    expect(scene.entities[0].traits.Transform).toBeUndefined(); // the id's entity was not written either
    // Accept side: an empty guid beside an id is ONE address.
    const ok = applyOps(scene, [{ op: 'setTrait', entity: { id: 2, guid: '' }, trait: 'Transform', fields: { x: 7 } }], mint);
    expect(ok.errors).toEqual([]);
    expect((scene.entities[1].traits.Transform as { x: number }).x).toBe(7);
  });
});

/** A scene whose entity #2 is a PREFAB INSTANCE root: its identity guid sits at
 *  the node TOP LEVEL (not EntityAttributes), and its root transform is authored
 *  as an override keyed by the root localId. Entity #1 is a plain (non-prefab)
 *  entity — a prefab instance can be nested under a non-prefab entity, and the
 *  routing must depend ONLY on the target being an instance, never on hierarchy. */
function prefabInstanceScene(): MutableScene {
  guidN = 0;
  return {
    version: 8,
    entities: [
      { id: 1, name: 'Group', traits: { EntityAttributes: { name: 'Group', guid: 'g-group', parentId: 0 } } },
      {
        id: 2,
        name: 'PadInst',
        traits: { PrefabInstance: { source: 'p-src', localId: 1, rootInstanceId: 2, parentLocalId: 0 } },
        prefab: 'p-src',
        overrides: { 1: { Transform: { x: 0, y: 0, z: 0 } } },
        guid: 'g-inst',
      },
    ],
  };
}

describe('applyOps — setTrait on prefab instances (routes into overrides)', () => {
  it('matches a prefab instance by its TOP-LEVEL guid (not EntityAttributes.guid)', () => {
    const scene = prefabInstanceScene();
    const res = applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'Transform', fields: { z: 8 } }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1);
  });

  it('writes Transform into overrides[rootLocalId], merged — NOT a stray top-level trait (the placement bug)', () => {
    const scene = prefabInstanceScene();
    applyOps(scene, [{ op: 'setTrait', entity: { name: 'PadInst' }, trait: 'Transform', fields: { z: 8, sx: 2.8, sy: 2.8, sz: 2.8 } }], mint);
    const inst = scene.entities[1];
    expect(inst.overrides![1].Transform).toEqual({ x: 0, y: 0, z: 8, sx: 2.8, sy: 2.8, sz: 2.8 });
    // The loader ignores a top-level trait on an instance node — must NOT be written there.
    expect(inst.traits.Transform).toBeUndefined();
  });

  it('routes correctly regardless of hierarchy (instance nested under a non-prefab entity)', () => {
    const scene = prefabInstanceScene(); // entity #1 (Group) is a plain non-prefab entity
    const res = applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', fields: { y: 3 } }], mint);
    expect(res.errors).toEqual([]);
    expect(scene.entities[1].overrides![1].Transform).toMatchObject({ y: 3 });
    expect(scene.entities[1].traits.Transform).toBeUndefined();
  });

  it('creates the override map on demand when the instance has none yet', () => {
    const scene = prefabInstanceScene();
    delete scene.entities[1].overrides;
    applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'Transform', fields: { z: 8 } }], mint);
    expect(scene.entities[1].overrides![1].Transform).toEqual({ z: 8 });
  });

  it('removeTrait on a prefab instance drops the override (not a top-level trait)', () => {
    const scene = prefabInstanceScene();
    scene.entities[1].overrides![1].Rotate3D = { speed: 1 };
    const res = applyOps(scene, [{ op: 'removeTrait', entity: { name: 'PadInst' }, trait: 'Rotate3D' }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1);
    expect(scene.entities[1].overrides![1].Rotate3D).toBeUndefined();
  });

  it('a plain (non-prefab) entity still writes to traits, not overrides (no regression)', () => {
    const scene = prefabInstanceScene();
    applyOps(scene, [{ op: 'setTrait', entity: { name: 'Group' }, trait: 'Transform', fields: { x: 1 } }], mint);
    expect(scene.entities[0].traits.Transform).toMatchObject({ x: 1 });
    expect(scene.entities[0].overrides).toBeUndefined();
  });
});

describe('applyOps — removeTrait', () => {
  it('removes a (non-core) component trait the entity has', () => {
    const scene = freshScene();
    scene.entities[1].traits.Light = { intensity: 1 };
    const res = applyOps(scene, [{ op: 'removeTrait', entity: { id: 2 }, trait: 'Light' }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1);
    expect(scene.entities[1].traits.Light).toBeUndefined();
    expect(scene.entities[1].traits.Transform).toBeDefined();       // core untouched
    expect(scene.entities[1].traits.EntityAttributes).toBeDefined(); // core untouched
  });

  it('removing an absent trait is a no-op (not an error, not changed)', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'removeTrait', entity: { id: 1 }, trait: 'Light' }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(0);
  });

  it('refuses to remove core Transform / EntityAttributes', () => {
    const scene = freshScene();
    const res = applyOps(scene, [
      { op: 'removeTrait', entity: { id: 1 }, trait: 'EntityAttributes' },
      { op: 'removeTrait', entity: { id: 2 }, trait: 'Transform' },
    ], mint);
    // Both core removals refused → both error, EntityAttributes still present.
    // (Transform is a core trait → refused even though the entity has it.)
    expect(res.changed).toBe(0);
    expect(res.errors.join('\n')).toMatch(/cannot remove core trait/);
    expect(scene.entities[0].traits.EntityAttributes).toBeDefined();
    expect(scene.entities[1].traits.Transform).toBeDefined();
  });

  // #1454: the prefab link is not a component — neither removed nor written by a generic edit. Mutation: drop the
  // removeTrait / setTrait refusal in applyOps.
  it('refuses to remove or write the PrefabInstance link', () => {
    const scene = freshScene();
    (scene.entities[0].traits as Record<string, unknown>).PrefabInstance = { source: 'g', localId: 1 };
    const res = applyOps(scene, [
      { op: 'removeTrait', entity: { id: 1 }, trait: 'PrefabInstance' },
      { op: 'setTrait', entity: { id: 2 }, trait: 'PrefabInstance', fields: { localId: 3 } },
    ], mint);
    expect(res.changed).toBe(0);
    expect(res.errors).toHaveLength(2);
    expect(res.errors.join('\n')).toMatch(/Detach Prefab/);
    expect((scene.entities[0].traits as Record<string, unknown>).PrefabInstance).toEqual({ source: 'g', localId: 1 });
    expect((scene.entities[1].traits as Record<string, unknown>).PrefabInstance).toBeUndefined();
  });

  // Close-out review: addEntity copied op.traits verbatim. Mutation: drop the addEntity refusal in applyOps.
  it('refuses an addEntity carrying the PrefabInstance link, creating nothing', () => {
    const scene = freshScene();
    const before = scene.entities.length;
    const res = applyOps(scene, [{ op: 'addEntity', name: 'Fake', traits: { PrefabInstance: { source: 'g', localId: 1 } } }], mint);
    expect(res.changed).toBe(0);
    expect(res.errors.join('\n')).toMatch(/Detach Prefab/);
    expect(scene.entities).toHaveLength(before);
  });

  it('errors when the entity is not found', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'removeTrait', entity: { name: 'Ghost' }, trait: 'Light' }], mint);
    expect(res.errors.join('\n')).toMatch(/no entity matching/);
  });
});

describe('applyOps — addEntity', () => {
  it('appends with next id, name, and minted guid', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'addEntity', name: 'New', parentId: 1, traits: { Transform: { x: 1, y: 2, z: 3 } } }], mint);
    expect(res.errors).toEqual([]);
    const added = scene.entities[scene.entities.length - 1];
    expect(added.id).toBe(3);
    expect(added.name).toBe('New');
    expect(added.traits.Transform).toEqual({ x: 1, y: 2, z: 3 });
    const attrs = added.traits.EntityAttributes as { name: string; guid: string; parentId: number };
    expect(attrs).toMatchObject({ name: 'New', guid: 'guid-1', parentId: 1 });
  });

  it('preserves a caller-supplied EntityAttributes guid', () => {
    const scene = freshScene();
    applyOps(scene, [{ op: 'addEntity', name: 'New', traits: { EntityAttributes: { guid: 'preset' } } }], mint);
    const added = scene.entities[scene.entities.length - 1];
    expect((added.traits.EntityAttributes as { guid: string }).guid).toBe('preset');
  });

  // F5 — orphan-parent warning.
  // #1825: the file create re-roots as the live one does, never stores the orphan. Mutation: store `askedParent` when
  // `graph.find` misses — the entity is saved with parentId 999.
  it('a parentId that names no entity creates the entity at the ROOT, with a warning — never an orphan', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'addEntity', name: 'Orphan', parentId: 999 }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1); // still added
    expect(res.warnings.join('\n')).toMatch(/parentId 999 matches no entity in this scene file — 'Orphan' was parented to the scene root instead/);
    expect((scene.entities[2].traits.EntityAttributes as { parentId: unknown }).parentId).toBe(0);
  });

  it('does NOT warn when parentId matches an existing entity (numeric or guid)', () => {
    expect(applyOps(freshScene(), [{ op: 'addEntity', name: 'A', parentId: 1 }], mint).warnings).toEqual([]);
    expect(applyOps(freshScene(), [{ op: 'addEntity', name: 'B', parentId: 'g-root' }], mint).warnings).toEqual([]);
  });

  it('reports what it CREATED — {op, id, guid, name} per addEntity (S3.12)', () => {
    // `changed:N` was the whole answer, so an agent had to re-find its own new entity by name —
    // which this surface refuses outright when the name is ambiguous, dead-ending "create then
    // edit" on step two. The sibling create-entity op has returned {id, name, guid} since C7.
    const scene = freshScene();
    const res = applyOps(scene, [
      { op: 'setTrait', entity: { name: 'Child' }, trait: 'Transform', fields: { x: 1 } },
      { op: 'addEntity', name: 'Box', parentId: 1 },
      { op: 'addEntity', name: 'Ball', parentId: 1 },
    ], mint);
    expect(res.created).toEqual([
      { op: 1, id: 3, guid: 'guid-1', name: 'Box' },
      { op: 2, id: 4, guid: 'guid-2', name: 'Ball' },
    ]);
  });

  it('omits `created` entirely when no entity was added (not an empty array)', () => {
    const res = applyOps(freshScene(), [{ op: 'setTrait', entity: { name: 'Child' }, trait: 'Transform', fields: { x: 1 } }], mint);
    expect(res.created).toBeUndefined();
  });

  it('the reported guid is the CALLER-SUPPLIED one when there is one', () => {
    const res = applyOps(freshScene(), [{ op: 'addEntity', name: 'New', traits: { EntityAttributes: { guid: 'preset' } } }], mint);
    expect(res.created?.[0].guid).toBe('preset');
  });

  it('does NOT warn for a parent created by an earlier op in the same batch', () => {
    const res = applyOps(freshScene(), [
      { op: 'addEntity', name: 'P', traits: { EntityAttributes: { guid: 'g-new-parent' } } },
      { op: 'addEntity', name: 'C', parentId: 'g-new-parent' },
    ], mint);
    expect(res.warnings).toEqual([]);
  });
});

describe('applyOps — removeEntity', () => {
  it('removes the entity and its descendants', () => {
    const scene = freshScene();
    // grandchild under Child(2)
    scene.entities.push({ id: 3, name: 'GC', traits: { EntityAttributes: { name: 'GC', guid: 'g-gc', parentId: 2 } } });
    const res = applyOps(scene, [{ op: 'removeEntity', entity: { id: 1 } }], mint);
    expect(res.errors).toEqual([]);
    expect(scene.entities).toEqual([]); // Root + Child + GC all gone
  });

  it('removes only the leaf when it has no children', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'removeEntity', entity: { name: 'Child' } }], mint);
    expect(scene.entities.map((e) => e.id)).toEqual([1]);
    expect(res).not.toHaveProperty('alsoDeleted'); // nothing cascaded, so no field at all
  });

  // #1262: `changed:1` was the whole answer, so a parent's remove took its subtree without a word.
  // Mutation: drop the `alsoDeleted.add(...)` call, or the `...alsoDeleted.fields()` spread.
  it('names the descendants the remove took, parents first, and not the entity it named', () => {
    const scene = freshScene();
    scene.entities.push({ id: 3, name: 'GC', traits: { EntityAttributes: { name: 'GC', guid: 'g-gc', parentId: 2 } } });
    const res = applyOps(scene, [{ op: 'removeEntity', entity: { name: 'Root' } }], mint);
    expect(res.alsoDeleted).toEqual(['g-child', 'g-gc']);
    expect(res).not.toHaveProperty('alsoDeletedTotal');
    expect(res).not.toHaveProperty('alsoDeletedNoGuidIds');
  });

  it('lists across every remove in the call, a guid-less descendant by id, and counts past the cap', () => {
    const scene: MutableScene = { version: 8, entities: [
      { id: 1, name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a', parentId: 0 } } },
      { id: 2, name: 'A1', traits: { EntityAttributes: { name: 'A1', parentId: 1 } } },
      { id: 3, name: 'B', traits: { EntityAttributes: { name: 'B', guid: 'g-b', parentId: 0 } } },
    ] };
    const n = ALSO_DELETED_CAP + 2;
    for (let i = 0; i < n; i++) scene.entities.push({ id: 10 + i, name: `k${i}`, traits: { EntityAttributes: { name: `k${i}`, guid: `g-k${i}`, parentId: 3 } } });
    const res = applyOps(scene, [
      { op: 'removeEntity', entity: { name: 'A' } },
      { op: 'removeEntity', entity: { name: 'B' } },
    ], mint);
    expect(res.alsoDeletedNoGuidIds).toEqual([2]);
    expect(res.alsoDeleted).toHaveLength(ALSO_DELETED_CAP - 1); // the cap counts both lists
    expect(res.alsoDeleted!.every((g) => g.startsWith('g-k'))).toBe(true);
    expect(res.alsoDeletedTotal).toBe(n + 1);
  });

  // F5 — dangling entity-ref warning.
  it('warns when a surviving UIAction.target references a removed entity', () => {
    const scene = freshScene();
    // A button (3) whose binding targets Child(2)'s guid.
    scene.entities.push({
      id: 3, name: 'Button',
      traits: {
        EntityAttributes: { name: 'Button', guid: 'g-btn', parentId: 1 },
        UIAction: { bindings: [{ event: 'click', kind: 'set', target: 'g-child', property: 'isVisible', value: true }] },
      },
    });
    const res = applyOps(scene, [{ op: 'removeEntity', entity: { id: 2 } }], mint);
    expect(res.errors).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(/Button UIAction\.target 'g-child' references a removed entity/);
  });

  it('does NOT warn when no surviving entity references the removed subtree', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'removeEntity', entity: { name: 'Child' } }], mint);
    expect(res.warnings).toEqual([]);
  });
});

describe('applyOps — setBaseScene (scene-loading.md Phase 7)', () => {
  it('sets the top-level baseScene field', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'setBaseScene', baseScene: 'base-guid-1' }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1);
    expect(scene.baseScene).toBe('base-guid-1');
  });

  it('is a no-op when the field already holds the same value', () => {
    const scene = freshScene();
    scene.baseScene = 'base-guid-1';
    const res = applyOps(scene, [{ op: 'setBaseScene', baseScene: 'base-guid-1' }], mint);
    expect(res.changed).toBe(0);
  });

  it('clears the field with null, omitting it entirely (not baseScene: "")', () => {
    const scene = freshScene();
    scene.baseScene = 'base-guid-1';
    const res = applyOps(scene, [{ op: 'setBaseScene', baseScene: null }], mint);
    expect(res.changed).toBe(1);
    expect('baseScene' in scene).toBe(false);
  });

  it('clearing an already-absent field is a no-op', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'setBaseScene', baseScene: null }], mint);
    expect(res.changed).toBe(0);
  });

  it('does not touch entities', () => {
    const scene = freshScene();
    const before = JSON.stringify(scene.entities);
    applyOps(scene, [{ op: 'setBaseScene', baseScene: 'base-guid-1' }], mint);
    expect(JSON.stringify(scene.entities)).toBe(before);
  });
});

describe('applyOps — robustness', () => {
  it('reports an error for an unknown op but keeps processing others', () => {
    const scene = freshScene();
    const ops = [
      { op: 'frobnicate' } as unknown as MutateOp,
      { op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 7 } } as MutateOp,
    ];
    const res = applyOps(scene, ops, mint);
    expect(res.errors.join('\n')).toMatch(/unknown op/);
    expect(res.changed).toBe(1);
  });

  it('handles a malformed scene', () => {
    const res = applyOps({ entities: null } as unknown as MutableScene, [], mint);
    expect(res.errors.join('\n')).toMatch(/entities is missing/);
  });
});

describe('applyOps + validateSceneData — integration round-trip', () => {
  const schema: SceneSchema = {
    traits: {
      Transform: { category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      Renderable3D: { category: 'component', fields: { mesh: { type: 'string' } } },
      EntityAttributes: { category: 'component', fields: { name: { type: 'string' }, guid: { type: 'string' }, parentId: { type: 'number' } } },
    },
  };

  it('a setTrait mutation produces a scene that still validates clean', () => {
    const scene = freshScene();
    applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', fields: { x: 3 } }], mint);
    // serialize → parse mirrors what the dev server writes + the browser reloads
    const roundTripped = JSON.parse(JSON.stringify(scene));
    expect(validateSceneData(roundTripped, schema).warnings).toEqual([]);
  });

  it('an addEntity mutation yields a valid entity (EntityAttributes well-formed)', () => {
    const scene = freshScene();
    applyOps(scene, [{ op: 'addEntity', name: 'Box', parentId: 1, traits: { Transform: { x: 0, y: 0, z: 0 } } }], mint);
    expect(validateSceneData(scene, schema).warnings).toEqual([]);
  });

  it('a bad ref injected by setTrait is caught by validation', () => {
    const scene = freshScene();
    applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Renderable3D', fields: { mesh: '/games/x/foo.mesh.json' } }], mint);
    expect(validateSceneData(scene, schema).warnings.join('\n')).toMatch(/internal asset path/);
  });
});

/**
 * C7 — report WHICH refs failed to resolve, so a caller that CAN see the live world can
 * explain them.
 *
 * The bug this serves: create_entity edits the LIVE world and does not save, so a brand-new
 * entity is real and visible while being absent from the scene FILE. This module is pure
 * over the file and CANNOT know that (docs §11 assumed it could) — so it reports the refs
 * and /api/scene-mutate turns them into "exists live, run save_all first".
 */
describe('applyOps — unresolved refs (C7)', () => {
  const scene = () => ({ entities: [{ id: 1, name: 'Existing', traits: {} }] }) as never;

  it('reports an unresolved ref instead of only a string error', () => {
    const res = applyOps(scene(), [
      { op: 'setTrait', entity: { guid: 'ghost-guid' }, trait: 'Transform', fields: { x: 1 } },
    ] as never);
    expect(res.changed).toBe(0);
    expect(res.unresolved).toEqual([{ guid: 'ghost-guid' }]);
  });

  it('says "in this scene FILE" — the old text implied the entity did not exist at all', () => {
    const res = applyOps(scene(), [
      { op: 'setTrait', entity: { guid: 'ghost-guid' }, trait: 'Transform', fields: { x: 1 } },
    ] as never);
    expect(res.errors.join('\n')).toMatch(/no entity matching .* in this scene FILE/);
  });

  it('a RESOLVED ref leaves unresolved empty (no false "save first" advice)', () => {
    const res = applyOps(scene(), [
      { op: 'setTrait', entity: { name: 'Existing' }, trait: 'Transform', fields: { x: 1 } },
    ] as never);
    expect(res.unresolved).toEqual([]);
    expect(res.changed).toBe(1);
  });

  it('collects EVERY unresolved ref, not just the first', () => {
    const res = applyOps(scene(), [
      { op: 'setTrait', entity: { guid: 'g1' }, trait: 'Transform', fields: { x: 1 } },
      { op: 'setTrait', entity: { name: 'Nope' }, trait: 'Transform', fields: { x: 2 } },
    ] as never);
    expect(res.unresolved).toEqual([{ guid: 'g1' }, { name: 'Nope' }]);
  });

  it('a malformed ref is NOT reported as unresolved (nothing to look up live)', () => {
    const res = applyOps(scene(), [
      { op: 'setTrait', entity: {}, trait: 'Transform', fields: { x: 1 } },
    ] as never);
    expect(res.errors.join('\n')).toMatch(/needs an id, name, or guid/);
    expect(res.unresolved).toEqual([]);
  });
});

// scene-loading.md, Phase 3 — a v12+ scene file carries NO entity
// `id` at all (serializeScene stopped writing it, since nothing on disk
// references it any more). This module still identifies entities by numeric id
// throughout, so the router-level caller MUST backfill before applyOps — this is
// the shim being tested directly, not through the router.
describe('assignSyntheticEntityIds (Phase 3, scene-loading.md)', () => {
  it('backfills the array index for every entity missing an id', () => {
    const scene: MutableScene = {
      version: 12,
      entities: [
        { name: 'Root', traits: { EntityAttributes: { name: 'Root', guid: 'g-root', parentId: 0 } } } as never,
        { name: 'Child', traits: { EntityAttributes: { name: 'Child', guid: 'g-child', parentId: 0 } } } as never,
      ],
    };
    assignSyntheticEntityIds(scene);
    expect(scene.entities[0].id).toBe(0);
    expect(scene.entities[1].id).toBe(1);
  });

  it('does NOT overwrite an id that is already present — only fills gaps', () => {
    const scene: MutableScene = {
      version: 11,
      entities: [
        { id: 7, name: 'Root', traits: {} },
        { id: 3, name: 'Child', traits: {} },
      ],
    };
    assignSyntheticEntityIds(scene);
    expect(scene.entities[0].id).toBe(7);
    expect(scene.entities[1].id).toBe(3);
  });

  it('a MIXED file (some entries id-less, some explicit) never lets a backfilled id collide with a real one', () => {
    // Entry 0 is id-less (array index 0 would normally be assigned), but entry 1
    // already explicitly claims id 0 — the naive "just use the index" backfill
    // would alias them, making EntityRef.id:0 ambiguous between two entities.
    const scene: MutableScene = {
      version: 12,
      entities: [
        { name: 'Gapless', traits: {} } as never,
        { id: 0, name: 'Explicit', traits: {} },
      ],
    };
    assignSyntheticEntityIds(scene);
    const ids = scene.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(2); // no collision
    expect(scene.entities[1].id).toBe(0); // explicit id untouched
    expect(scene.entities[0].id).not.toBe(0); // backfill skipped the taken slot
  });

  it('applyOps resolves entities by NAME/GUID (unaffected) and by the backfilled id, on a scene with no prior ids', () => {
    const scene: MutableScene = {
      version: 12,
      entities: [
        { name: 'Root', traits: { EntityAttributes: { name: 'Root', guid: 'g-root', parentId: 0 } } } as never,
        { name: 'Child', traits: { EntityAttributes: { name: 'Child', guid: 'g-child', parentId: 0 }, Transform: { x: 0 } } } as never,
      ],
    };
    assignSyntheticEntityIds(scene);
    // Address by the freshly-backfilled numeric id (Child = index 1).
    const res = applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } }], mint);
    expect(res.changed).toBe(1);
    expect((scene.entities[1].traits.Transform as Record<string, unknown>).x).toBe(9);
  });

  it('a fresh addEntity on a backfilled scene mints an id above the backfilled range (no collision)', () => {
    const scene: MutableScene = {
      version: 12,
      entities: [
        { name: 'A', traits: {} } as never,
        { name: 'B', traits: {} } as never,
      ],
    };
    assignSyntheticEntityIds(scene); // ids become 0, 1
    const res = applyOps(scene, [{ op: 'addEntity', name: 'New' }], mint);
    expect(res.changed).toBe(1);
    const added = scene.entities.find((e) => e.name === 'New')!;
    expect(added.id).toBeGreaterThan(1);
    // Uniqueness — the new id doesn't collide with either backfilled entity.
    expect(new Set(scene.entities.map((e) => e.id)).size).toBe(3);
  });
});

// Independent code review finding (2026-07-26): the router's real caller
// (editorBackendRouter.ts's /api/scene-mutate handler) writes `scene` back to
// disk after applyOps — without this, a single-field setTrait on a clean v12+
// file (no entity ids anywhere) would silently reintroduce an `id` on EVERY
// entity, exactly the diff noise Phase 3 removed, just via a different write
// path than Save All.
describe('stripBackfilledEntityIds (write-path fix for the assignSyntheticEntityIds backfill)', () => {
  it('removes ids from entities that were backfilled, leaving a mutated field intact', () => {
    const scene: MutableScene = {
      version: 12,
      entities: [
        { name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a' } } } as never,
        { name: 'B', traits: { Transform: { x: 0 } } } as never,
      ],
    };
    const backfilled = assignSyntheticEntityIds(scene);
    applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } }], mint);
    stripBackfilledEntityIds(scene, backfilled);

    expect(scene.entities.every((e) => e.id === undefined)).toBe(true);
    expect((scene.entities[1].traits.Transform as Record<string, unknown>).x).toBe(9);
  });

  it('does NOT strip the real id of an entity added by this same call', () => {
    const scene: MutableScene = {
      version: 12,
      entities: [{ name: 'A', traits: {} } as never],
    };
    const backfilled = assignSyntheticEntityIds(scene);
    applyOps(scene, [{ op: 'addEntity', name: 'New' }], mint);
    stripBackfilledEntityIds(scene, backfilled);

    const original = scene.entities.find((e) => e.name === 'A')!;
    const added = scene.entities.find((e) => e.name === 'New')!;
    expect(original.id).toBeUndefined();
    expect(added.id).toBeDefined();
  });

  it('is a no-op for a scene that never needed backfilling (already-idd entities keep their real ids)', () => {
    const scene: MutableScene = {
      version: 11,
      entities: [
        { id: 7, name: 'A', traits: {} },
        { id: 9, name: 'B', traits: {} },
      ],
    };
    const backfilled = assignSyntheticEntityIds(scene); // empty — both already had ids
    expect(backfilled.size).toBe(0);
    stripBackfilledEntityIds(scene, backfilled);
    expect(scene.entities[0].id).toBe(7);
    expect(scene.entities[1].id).toBe(9);
  });

  it('handles a REMOVED backfilled entity without error (simply absent from the array)', () => {
    const scene: MutableScene = {
      version: 12,
      entities: [
        { name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a' } } } as never,
        { name: 'B', traits: { EntityAttributes: { name: 'B', guid: 'g-b' } } } as never,
      ],
    };
    const backfilled = assignSyntheticEntityIds(scene);
    applyOps(scene, [{ op: 'removeEntity', entity: { name: 'A' } }], mint);
    expect(() => stripBackfilledEntityIds(scene, backfilled)).not.toThrow();
    expect(scene.entities).toHaveLength(1);
    expect(scene.entities[0].id).toBeUndefined();
  });
});

describe("setTrait {space:'world'} — authoring in world coordinates (file path)", () => {
  /** A parent at (200,247) with a child whose LOCAL is (623,679) — i.e. world (823,926). The exact
   *  shape measured live when `set_transform`'s `position` was documented as "World" and wrote
   *  LOCAL: asking for the child's own current world position displaced it by the parent offset. */
  const parented = (): MutableScene => ({
    entities: [
      { id: 1, name: 'Parent', traits: { Transform: { x: 200, y: 247, z: 0 }, EntityAttributes: { parentId: 0 } } },
      { id: 2, name: 'Child', traits: { Transform: { x: 623, y: 679, z: 0 }, EntityAttributes: { parentId: 1 } } },
    ],
  });
  const tf = (s: MutableScene, id: number) => s.entities.find((e) => e.id === id)!.traits.Transform as Record<string, number>;

  it("writing the child's OWN world position is a NO-OP (the bug, inverted)", () => {
    const scene = parented();
    const r = applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', space: 'world', fields: { x: 823, y: 926 } }]);
    expect(r.errors).toEqual([]);
    expect(tf(scene, 2).x).toBeCloseTo(623, 6);
    expect(tf(scene, 2).y).toBeCloseTo(679, 6);
  });

  it("without `space` the fields are written VERBATIM — the low-level op's literal contract", () => {
    const scene = parented();
    applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', fields: { x: 823 } }]);
    expect(tf(scene, 2).x).toBe(823); // local, unconverted — and now at world 1023
  });

  it("space:'world' places the child at the world point asked for", () => {
    const scene = parented();
    applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', space: 'world', fields: { x: 0, y: 0 } }]);
    expect(tf(scene, 2).x).toBeCloseTo(-200, 6);
    expect(tf(scene, 2).y).toBeCloseTo(-247, 6);
  });

  it('a PARTIAL world write leaves the unnamed axes alone', () => {
    const scene = parented();
    applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'Transform', space: 'world', fields: { x: 1000 } }]);
    expect(tf(scene, 2).x).toBeCloseTo(800, 6);
    expect(tf(scene, 2).y).toBe(679); // untouched, exactly — no decompose noise
  });

  it('is an exact no-op for a ROOT entity (world == local)', () => {
    const scene: MutableScene = { entities: [{ id: 1, traits: { Transform: { x: 5, y: 6 }, EntityAttributes: { parentId: 0 } } }] };
    applyOps(scene, [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', space: 'world', fields: { x: 42 } }]);
    expect(tf(scene, 1)).toEqual({ x: 42, y: 6 }); // untouched keys stay byte-identical
  });

  it("REFUSES `space` on a non-Transform trait rather than ignoring it", () => {
    // Never silently accept a parameter that does nothing — it implies a conversion that
    // never happened.
    const scene = parented();
    const r = applyOps(scene, [{ op: 'setTrait', entity: { id: 2 }, trait: 'EntityAttributes', space: 'world', fields: { name: 'x' } }]);
    expect(r.errors.join(' ')).toMatch(/'space' applies only to trait 'Transform'/);
    expect(r.changed).toBe(0);
  });
});

/** #1210: this edits the scene FILE, and a runtime guid is a LIVE-world address valid only until
 *  reload. An agent copying one from a live read must not get it written to disk. */
describe('applyOps — runtime guids never reach the file (#1210)', () => {
  const rg = formatRuntimeGuid(1, 77);

  it('addEntity mints over a caller-supplied runtime guid, and over an empty one', () => {
    const scene = freshScene();
    const res = applyOps(scene, [
      { op: 'addEntity', name: 'FromLive', traits: { EntityAttributes: { guid: rg } } },
      { op: 'addEntity', name: 'Blank', traits: { EntityAttributes: { guid: '' } } },
    ], mint);
    expect(res.errors).toEqual([]);
    const guidOf = (name: string) => (scene.entities.find((e) => e.name === name)!.traits.EntityAttributes as { guid: string }).guid;
    expect(guidOf('FromLive')).toBe('guid-1');
    expect(guidOf('Blank')).toBe('guid-2');
    expect(res.created?.map((c) => c.guid)).toEqual(['guid-1', 'guid-2']); // the reply names what was written
  });

  it('refuses the whole write when any field would carry a runtime guid', () => {
    const scene = freshScene();
    const res = applyOps(scene, [
      { op: 'setTrait', entity: { name: 'Child' }, trait: 'Transform', fields: { x: 5 } },
      { op: 'setTrait', entity: { name: 'Root' }, trait: 'UIAction', fields: { bindings: [{ target: rg }] } },
    ], mint);
    expect(res.changed).toBe(0); // the route writes only when changed > 0
    expect(res.errors.join('\n')).toMatch(/RUNTIME guid/);
  });

  // #1223 P4 review: the tripwire cleared `changed` and `created` but not `addedTraits`, so a refused write
  // still reported a trait added. Mutation: drop `addedTraits.length = 0` from the tripwire.
  it('a refused write reports no trait added either', () => {
    const res = applyOps(freshScene(), [
      { op: 'setTrait', entity: { id: 1 }, trait: 'Rotate3D', fields: { speed: 2 } },
      { op: 'setTrait', entity: { name: 'Root' }, trait: 'UIAction', fields: { bindings: [{ target: rg }] } },
    ], mint);
    expect(res.changed).toBe(0);
    expect(res.addedTraits).toBeUndefined();
  });

  // #1262: nor a cascade, since nothing left the file. Mutation: drop the tally reset from the tripwire.
  it('a refused write reports nothing also deleted', () => {
    const scene = freshScene();
    scene.entities.push({ id: 3, name: 'Other', traits: { EntityAttributes: { name: 'Other', guid: 'g-other', parentId: 0 } } });
    const res = applyOps(scene, [
      { op: 'removeEntity', entity: { name: 'Root' } },
      { op: 'setTrait', entity: { name: 'Other' }, trait: 'UIAction', fields: { bindings: [{ target: rg }] } },
    ], mint);
    expect(res.changed).toBe(0);
    expect(res).not.toHaveProperty('alsoDeleted');
  });

  it('a refused write reports no created entity — none was written', () => {
    const scene = freshScene();
    const res = applyOps(scene, [
      { op: 'addEntity', name: 'Holder', traits: { UIAction: { bindings: [{ target: rg }] } } },
    ], mint);
    expect(res.changed).toBe(0);
    expect(res.created ?? []).toEqual([]);
  });
});

/** #1825 — the file-direct parent write answers to the one parent rule (`parentLinkRefusal`, shared with the live
 *  `reparentRefusal`), judged against this file's own entries. It used to store any value. */
describe('applyOps — setTrait EntityAttributes.parentId is judged (#1825)', () => {
  const setParent = (scene: MutableScene, entity: Record<string, unknown>, parentId: unknown, opts = {}) =>
    applyOps(scene, [{ op: 'setTrait', entity, trait: 'EntityAttributes', fields: { parentId } } as MutateOp], mint, opts);
  const parentOf = (scene: MutableScene, i: number) => (scene.entities[i].traits.EntityAttributes as { parentId: unknown }).parentId;
  /** Root(1) > Child(2) > Grand(3); Config(4) is a resource at the root. */
  const tree = (): MutableScene => {
    const s = freshScene();
    s.entities.push(
      { id: 3, name: 'Grand', traits: { EntityAttributes: { name: 'Grand', guid: 'g-grand', parentId: 'g-child' } } },
      { id: 4, name: 'Config', traits: { EntityAttributes: { name: 'Config', guid: 'g-config', parentId: 0 }, GameConfig: { speed: 1 } } },
    );
    return s;
  };

  // Mutation: return { ok: true } when `graph.find` misses — the dead guid is stored.
  it('a parent that names no entity of this file is refused, and nothing is written', () => {
    const scene = tree();
    const res = setParent(scene, { guid: 'g-child' }, 'g-nowhere');
    expect(res.errors[0]).toMatch(/names no entity in this scene file.*nothing was applied/);
    expect(res.changed).toBe(0);
    expect(parentOf(scene, 1)).toBe(1);
  });

  // Mutation: return null from parentLinkRefusal for 'self-parent' / 'cycle' — each is stored.
  it('a self-parent and a cycle are refused', () => {
    const scene = tree();
    expect(setParent(scene, { guid: 'g-child' }, 'g-child').errors[0]).toMatch(/is the entity itself/);
    expect(setParent(scene, { guid: 'g-root' }, 'g-grand').errors[0]).toMatch(/is a descendant of this entity/);
    expect(parentOf(scene, 0)).toBe(0);
    expect(parentOf(scene, 1)).toBe(1);
  });

  // The resource half needs the schema's categories, which the route passes. Mutation: `isResource` always false.
  it('a resource parent, or a resource moved under an entity, is refused when the resource traits are known', () => {
    const scene = tree();
    const opts = { resourceTraits: new Set(['GameConfig']) };
    expect(setParent(scene, { guid: 'g-child' }, 'g-config', opts).errors[0]).toMatch(/would put a resource entity into the hierarchy/);
    expect(setParent(scene, { guid: 'g-config' }, 'g-root', opts).errors[0]).toMatch(/would put a resource entity/);
    expect(parentOf(scene, 3)).toBe(0);
  });

  // Accept side: a legal move is stored, by guid or legacy numeric id, and 0 re-roots.
  it('a legal move is written', () => {
    const scene = tree();
    expect(setParent(scene, { guid: 'g-grand' }, 'g-root').errors).toEqual([]);
    expect(parentOf(scene, 2)).toBe('g-root');
    expect(setParent(scene, { guid: 'g-grand' }, 2).errors).toEqual([]);
    expect(parentOf(scene, 2)).toBe(2);
    expect(setParent(scene, { guid: 'g-grand' }, 0).errors).toEqual([]);
    expect(parentOf(scene, 2)).toBe(0);
  });

  // An instance root's parent is the entry's own `traits.EntityAttributes.parentId`, which the loader reads; in the
  // overrides it moved nothing and would ride an Apply into the template. Mutation: drop the `container !==
  // entity.traits` branch — the parent lands in overrides[1].
  it('on an instance root the parent goes to the entry\'s own traits, and the other fields to its overrides', () => {
    const scene = prefabInstanceScene();
    const res = applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group', name: 'Renamed' } }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1);
    const inst = scene.entities[1];
    expect((inst.traits.EntityAttributes as { parentId: unknown }).parentId).toBe('g-group');
    expect(inst.overrides![1].EntityAttributes).toEqual({ name: 'Renamed' });
  });

  // Mutation: in addEntity, keep a resource `parent` — the new entity is stored under the resource.
  it('addEntity: an authored EntityAttributes.parentId is judged too, and a resource parent re-roots with a warning', () => {
    const scene = tree();
    const res = applyOps(scene, [{ op: 'addEntity', name: 'N', traits: { EntityAttributes: { parentId: 'g-config' } } }], mint, { resourceTraits: new Set(['GameConfig']) });
    expect(res.errors).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(/is a resource and holds no children — 'N' was parented to the scene root instead/);
    expect(parentOf(scene, 4)).toBe(0);
    const dead = applyOps(scene, [{ op: 'addEntity', name: 'M', traits: { EntityAttributes: { parentId: 'g-nowhere' } } }], mint);
    expect(dead.warnings.join('\n')).toMatch(/matches no entity in this scene file/);
    expect(parentOf(scene, 5)).toBe(0);
  });

  // The route backfills a temporary id into every entry of a v12 file and strips it before writing, so a numeric parent
  // naming one would be stored pointing at nothing. Mutation: index backfilled ids in fileParentGraph — the write passes.
  it('a numeric parent naming a BACKFILLED id is refused (setTrait) or re-rooted (addEntity) — it names nothing on disk', () => {
    const scene: MutableScene = { version: 13, entities: [
      { name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a', parentId: 0 } } },
      { name: 'B', traits: { EntityAttributes: { name: 'B', guid: 'g-b', parentId: 0 } } },
      { name: 'C', traits: { EntityAttributes: { name: 'C', guid: 'g-c', parentId: 0 } } },
    ] } as unknown as MutableScene;
    const syntheticIds = assignSyntheticEntityIds(scene);
    const res = applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-b' }, trait: 'EntityAttributes', fields: { parentId: 2 } }], mint, { syntheticIds });
    expect(res.errors[0]).toMatch(/names no entity in this scene file/);
    expect(parentOf(scene, 1)).toBe(0);
    const add = applyOps(scene, [{ op: 'addEntity', name: 'N', parentId: 2 }], mint, { syntheticIds });
    expect(add.warnings.join('\n')).toMatch(/matches no entity in this scene file/);
    expect(parentOf(scene, 3)).toBe(0);
    // Accept side: the guid form of the same parent passes.
    expect(applyOps(scene, [{ op: 'setTrait', entity: { guid: 'g-b' }, trait: 'EntityAttributes', fields: { parentId: 'g-c' } }], mint, { syntheticIds }).errors).toEqual([]);
  });
});

/** #1847 — a file-direct parent change keeps the WORLD pose, as every live reparent does (Unity's editor reparent too). It
 *  kept the stored LOCAL transform, so the entity jumped by the new parent's transform on the next load. */
describe('applyOps — setTrait parentId keeps the world pose (#1847)', () => {
  const tf = (x: number, extra: Record<string, number> = {}) => ({ x, y: 0, z: 0, ...extra });
  /** P is translated, rotated and scaled; Q is at the root; C sits under Q. Z is a zero-scale parent. */
  const scene = (): MutableScene => ({ version: 13, entities: [
    { id: 1, name: 'P', traits: { EntityAttributes: { name: 'P', guid: 'g-p', parentId: 0 }, Transform: tf(10, { ry: Math.PI / 2, sx: 2, sy: 2, sz: 2 }) } },
    { id: 2, name: 'Q', traits: { EntityAttributes: { name: 'Q', guid: 'g-q', parentId: 0 }, Transform: tf(-3, { y: 4 }) } },
    { id: 3, name: 'C', traits: { EntityAttributes: { name: 'C', guid: 'g-c', parentId: 'g-q' }, Transform: tf(1, { z: 2, rx: 0.3 }) } },
    { id: 4, name: 'Z', traits: { EntityAttributes: { name: 'Z', guid: 'g-z', parentId: 0 }, Transform: tf(0, { sx: 0 }) } },
    { id: 5, name: 'Bare', traits: { EntityAttributes: { name: 'Bare', guid: 'g-bare', parentId: 0 } } },
  ] } as MutableScene);
  const byName = (s: MutableScene, n: string) => s.entities.find((e) => e.name === n)!;
  /** Same world pose: position and scale per axis, orientation by quaternion angle (Euler angles are not unique). */
  const close = (a: Record<string, number>, b: Record<string, number>) => {
    for (const k of ['x', 'y', 'z', 'sx', 'sy', 'sz']) expect(a[k], k).toBeCloseTo(b[k]!, 6);
    const q = (t: Record<string, number>) => new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rx, t.ry, t.rz));
    expect(q(a).angleTo(q(b)), 'orientation').toBeLessThan(1e-6);
  };

  // Mutation: skip keepWorldPose (pose = null) — C keeps its local x=1 under P and lands somewhere else. Filtering the
  // rotation keys out of the write turns the orientation check red.
  it('under a translated, rotated, scaled parent the world pose is unchanged', () => {
    const s = scene();
    const before = worldTrsOf(s.entities, byName(s, 'C'));
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-c' }, trait: 'EntityAttributes', fields: { parentId: 'g-p' } }], mint);
    expect(res.errors).toEqual([]);
    close(worldTrsOf(s.entities, byName(s, 'C')) as never, before as never);
    // …and to the root: the world pose becomes the local one.
    applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-c' }, trait: 'EntityAttributes', fields: { parentId: 0 } }], mint);
    close(byName(s, 'C').traits.Transform as never, before as never);
  });

  // Only the persisted groups that change are written: a position-only move adds no rotation or scale keys, and an entity
  // storing no Transform gets none. Mutation: write every key of `next` in keepWorldPose — K gains rx..sz.
  it('a move writes only the Transform groups it changes', () => {
    const s = scene();
    s.entities.push({ id: 6, name: 'K', traits: { EntityAttributes: { name: 'K', guid: 'g-k', parentId: 0 }, Transform: { x: 1 } } });
    expect(applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-k' }, trait: 'EntityAttributes', fields: { parentId: 'g-q' } }], mint).errors).toEqual([]);
    expect(Object.keys(byName(s, 'K').traits.Transform as object).sort()).toEqual(['x', 'y', 'z']);
    expect((byName(s, 'K').traits.Transform as { x: number }).x).toBeCloseTo(4, 9);
    expect(applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-bare' }, trait: 'EntityAttributes', fields: { parentId: 'g-q' } }], mint).errors).toEqual([]);
    expect(byName(s, 'Bare').traits.Transform).toBeUndefined();
  });

  // Mutation: drop the collapsedParentAxes refusal — C is written with a degenerate transform.
  it('a zero-scale new parent is refused: no local transform keeps the pose', () => {
    const s = scene();
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-c' }, trait: 'EntityAttributes', fields: { parentId: 'g-z' } }], mint);
    expect(res.errors[0]).toMatch(/ZERO scale on x.*nothing was applied/);
    expect((byName(s, 'C').traits.EntityAttributes as { parentId: unknown }).parentId).toBe('g-q');
  });

  // An instance root is compensated in its OVERRIDES when they store its whole placement. Mutation: write the
  // compensation into `entity.traits` — the override keeps the old pose and the loader ignores the top-level Transform.
  it('an instance root whose override stores its whole Transform is compensated in its overrides', () => {
    const s = prefabInstanceScene();
    (s.entities[0].traits as Record<string, unknown>).Transform = tf(5);
    s.entities[1].overrides![1].Transform = { x: 2, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
    expect(applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group' } }], mint).errors).toEqual([]);
    expect((s.entities[1].overrides![1].Transform as { x: number }).x).toBeCloseTo(-3, 9);
    expect(s.entities[1].traits.Transform).toBeUndefined();
  });

  // A PARTIAL override (only the marked fields are written — the normal shape) or none takes the rest from the
  // template, which this route cannot read: guessing identity moved the entity (review: a template y=3 landed at 0).
  // So it keeps its local transform and says so. Mutation: make isTemplatePlaced return false — the partial
  // override is rewritten with identity-filled values.
  it('an instance root placed partly by its template keeps its local transform, with a warning', () => {
    for (const over of [{ x: 2 }, undefined]) {
      const s = prefabInstanceScene();
      (s.entities[0].traits as Record<string, unknown>).Transform = tf(5, { rz: Math.PI / 2 });
      if (over) s.entities[1].overrides![1].Transform = over; else delete s.entities[1].overrides;
      const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group' } }], mint);
      expect(res.errors).toEqual([]);
      expect(res.warnings.join('\n')).toMatch(/this instance root takes part of its placement from its prefab.*kept its LOCAL transform/);
      expect(s.entities[1].overrides?.[1]?.Transform).toEqual(over);
    }
  });

  // The same holds for a PARENT placed by its template: its world pose is unknown here. Same mutation.
  it('a new parent placed by its template: the entity keeps its local transform, with a warning naming the parent', () => {
    const s = prefabInstanceScene();
    s.entities.push({ id: 3, name: 'K', traits: { EntityAttributes: { name: 'K', guid: 'g-k', parentId: 0 }, Transform: { x: 1 } } });
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-k' }, trait: 'EntityAttributes', fields: { parentId: 'g-inst' } }], mint);
    expect(res.errors).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(/'PadInst' \(a prefab instance root on the parent chain\) takes part of its placement/);
    expect(s.entities[2].traits.Transform).toEqual({ x: 1 });
  });

  // A decomposition picks its own Euler angles and mirror axis, so rotation and scale are written only when their LINEAR
  // part changes. A translation-only move used to rewrite `{sy:-1}` as `{sx:-1, rz:π}` and a backwards yaw as
  // `{rx:-π, ry:0.64, rz:-π}`. Mutation: drop the `sameRotationScale` check — both come back rewritten.
  it('a move that changes only position leaves the authored rotation and scale numbers alone', () => {
    const s = scene();
    s.entities.push(
      { id: 6, name: 'G', traits: { EntityAttributes: { name: 'G', guid: 'g-g', parentId: 0 }, Transform: { x: 5, y: 2 } } },
      { id: 7, name: 'M', traits: { EntityAttributes: { name: 'M', guid: 'g-m', parentId: 0 }, Transform: { x: 1, sy: -1 } } },
      { id: 8, name: 'Y', traits: { EntityAttributes: { name: 'Y', guid: 'g-y', parentId: 0 }, Transform: { x: 1, ry: 2.5 } } },
    );
    for (const g of ['g-m', 'g-y']) expect(applyOps(s, [{ op: 'setTrait', entity: { guid: g }, trait: 'EntityAttributes', fields: { parentId: 'g-g' } }], mint).errors).toEqual([]);
    expect(byName(s, 'M').traits.Transform).toEqual({ x: -4, y: -2, z: 0, sy: -1 });
    expect(byName(s, 'Y').traits.Transform).toEqual({ x: -4, y: -2, z: 0, ry: 2.5 });
  });

  /** R is an instance root placed partly by its template (override x only), with plain C under it and E under C. */
  const deepScene = (): MutableScene => {
    const s = prefabInstanceScene();
    s.entities[1].overrides![1].Transform = { x: 4 };
    s.entities.push(
      { id: 3, name: 'C', traits: { EntityAttributes: { name: 'C', guid: 'g-c2', parentId: 'g-inst' }, Transform: { x: 1 } } },
      { id: 4, name: 'E', traits: { EntityAttributes: { name: 'E', guid: 'g-e', parentId: 'g-c2' }, Transform: { x: 2 } } },
      { id: 5, name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a2', parentId: 'g-inst' }, Transform: { x: 3 } } },
      { id: 6, name: 'Root2', traits: { EntityAttributes: { name: 'Root2', guid: 'g-r2', parentId: 0 }, Transform: { x: 5 } } },
    );
    return s;
  };

  // The template-placed entry need not be the parent itself: any entry on either chain's suffix makes that pose a guess.
  // Mutation: in reparentSuffixes, ask isTemplatePlaced of each chain's LAST entry only — both moves compute against an
  // identity-filled R and rewrite E.
  it('an instance root placed by its template DEEPER on either chain: kept local, warned, naming it', () => {
    const out = deepScene();                                   // old chain R > C, new chain the plain Root2
    const r1 = applyOps(out, [{ op: 'setTrait', entity: { guid: 'g-e' }, trait: 'EntityAttributes', fields: { parentId: 'g-r2' } }], mint);
    expect(r1.warnings.join('\n')).toMatch(/'PadInst' \(a prefab instance root on the parent chain\)/);
    expect(out.entities.find((e) => e.name === 'E')!.traits.Transform).toEqual({ x: 2 });
    const into = deepScene();                                  // E at the root, moved under C (new chain R > C)
    (into.entities.find((e) => e.name === 'E')!.traits.EntityAttributes as { parentId: unknown }).parentId = 0;
    const r2 = applyOps(into, [{ op: 'setTrait', entity: { guid: 'g-e' }, trait: 'EntityAttributes', fields: { parentId: 'g-c2' } }], mint);
    expect(r2.warnings.join('\n')).toMatch(/'PadInst' \(a prefab instance root on the parent chain\)/);
    expect(into.entities.find((e) => e.name === 'E')!.traits.Transform).toEqual({ x: 2 });
  });

  // …but on the SHARED prefix it cancels: E moved from C to its sibling A, both under R, is new = inv(A)·C·E whatever R
  // is. Mutation: compare the whole chains (no shared prefix) in reparentSuffixes — this warns and keeps x 2.
  it('an instance root shared by both chains cancels: a sibling move is compensated with no warning', () => {
    const s = deepScene();
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-e' }, trait: 'EntityAttributes', fields: { parentId: 'g-a2' } }], mint);
    expect(res.warnings).toEqual([]);
    expect((s.entities.find((e) => e.name === 'E')!.traits.Transform as { x: number }).x).toBeCloseTo(0, 9);  // 1 + 2 - 3
  });

  // The everyday case (26 of 29 instance roots in the repo's scenes store a partial override or none): an instance
  // root moved into an identity group keeps its pose by keeping its local, so nothing is said. Mutation: ask
  // isTemplatePlaced(entity) BEFORE the same-pose check — it warns falsely.
  it('an instance root placed by its template, moved into an identity group: no warning, nothing rewritten', () => {
    const s = prefabInstanceScene();
    s.entities[1].overrides![1].Transform = { x: 2 };
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group' } }], mint);
    expect(res.warnings).toEqual([]);
    expect(s.entities[1].overrides![1].Transform).toEqual({ x: 2 });
    expect((s.entities[1].traits.EntityAttributes as { parentId: unknown }).parentId).toBe('g-group');
  });

  // An instance root placed partly by its template is still compensated when its override stores x,y,z and the move
  // keeps the linear part: its position depends on its translation alone (12 of 29 instance roots in the repo's scenes
  // store that shape). Mutation: drop `!positionOnly` from the warning — it warns and x stays 3 (world jumps to 13).
  it('an instance root with x,y,z in its override, moved under a translated group: position compensated, nothing else', () => {
    const s = prefabInstanceScene();
    (s.entities[0].traits as Record<string, unknown>).Transform = tf(10);
    s.entities[1].overrides![1].Transform = { x: 3, y: 0, z: 1, ry: 0.5 };
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group' } }], mint);
    expect(res.warnings).toEqual([]);
    expect(s.entities[1].overrides![1].Transform).toEqual({ x: -7, y: 0, z: 1, ry: 0.5 });
  });

  // The instance-root exemption holds only while the move keeps the linear part: under a ROTATED group an {x,y,z}
  // override cannot be compensated without the template's rotation. Mutation: drop the
  // `sameRotationScale(from, to)` clause of positionOnly — the override gains identity-derived rotation.
  it('an instance root with x,y,z in its override, moved under a ROTATED group: warned, override untouched', () => {
    const s = prefabInstanceScene();
    (s.entities[0].traits as Record<string, unknown>).Transform = tf(10, { rz: 0.7 });
    s.entities[1].overrides![1].Transform = { x: 3, y: 0, z: 1, ry: 0.5 };
    const res = applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group' } }], mint);
    expect(res.warnings.join('\n')).toMatch(/this instance root takes part of its placement/);
    expect(s.entities[1].overrides![1].Transform).toEqual({ x: 3, y: 0, z: 1, ry: 0.5 });
  });

  // …and even when the suffix check's tolerance lets a tiny turn through, only POSITION is written into the partial
  // override. Mutation: drop the `isTemplatePlaced(entity)` early return in keepWorldPose — rx/rz appear in it.
  it('a template-placed root is never given rotation or scale by a compensation', () => {
    const s = prefabInstanceScene();
    (s.entities[0].traits as Record<string, unknown>).Transform = { x: -3, rz: 5e-5, sx: 0.01, sy: 0.01, sz: 0.01 };
    s.entities.push({ id: 3, name: 'A', traits: { EntityAttributes: { name: 'A', guid: 'g-a3', parentId: 0 }, Transform: { x: 5, sx: 0.01, sy: 0.01, sz: 0.01 } } });
    (s.entities[1].traits as Record<string, unknown>).EntityAttributes = { parentId: 'g-a3' };
    s.entities[1].overrides![1].Transform = { x: 3, y: 1, z: 2, ry: 0.5 };
    expect(applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-inst' }, trait: 'EntityAttributes', fields: { parentId: 'g-group' } }], mint).errors).toEqual([]);
    expect(Object.keys(s.entities[1].overrides![1].Transform as object).sort()).toEqual(['ry', 'x', 'y', 'z']);
    expect((s.entities[1].overrides![1].Transform as { ry: number }).ry).toBe(0.5);
  });

  // A move under a MIRRORED parent flips handedness: no rotation of the authored scale composes it, so the full
  // decomposition is written and the world pose kept. Mutation: drop the `determinant() <= 0` check in
  // rotationKeepingScale — an improper matrix is read as Euler angles and the pose is lost.
  it('a move under a mirrored parent keeps the world pose', () => {
    const s = scene();
    s.entities.push(
      { id: 6, name: 'Mir', traits: { EntityAttributes: { name: 'Mir', guid: 'g-mir', parentId: 0 }, Transform: { x: 2, sx: -1 } } },
      { id: 7, name: 'W', traits: { EntityAttributes: { name: 'W', guid: 'g-w', parentId: 0 }, Transform: { x: 1, rz: 0.4, sy: 2 } } },
    );
    const m = (t: Record<string, number>) => new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rx, t.ry, t.rz)), new THREE.Vector3(t.sx, t.sy, t.sz));
    const before = m(worldTrsOf(s.entities, byName(s, 'W')) as never);
    expect(applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-w' }, trait: 'EntityAttributes', fields: { parentId: 'g-mir' } }], mint).errors).toEqual([]);
    const after = m(worldTrsOf(s.entities, byName(s, 'W')) as never);
    after.elements.forEach((v, i) => expect(v, `element ${i}`).toBeCloseTo(before.elements[i]!, 9));
  });

  // A pure turn writes the rotation only and keeps the authored scale, mirror sign included; the decomposition moved a
  // mirror to `sx` and wrote float noise into the scale group. Mutation: drop the rotationKeepingScale branch — K gains
  // sx/sy noise and loses sy:-1, T gains rx..sz.
  it('a move that turns the entity writes rotation only, keeping the authored scale and its mirror', () => {
    const s = scene();
    s.entities.push(
      { id: 6, name: 'R90', traits: { EntityAttributes: { name: 'R90', guid: 'g-r90', parentId: 0 }, Transform: { rz: Math.PI / 2 } } },
      { id: 7, name: 'M', traits: { EntityAttributes: { name: 'M', guid: 'g-m', parentId: 0 }, Transform: { sy: -1 } } },
      { id: 8, name: 'T', traits: { EntityAttributes: { name: 'T', guid: 'g-t', parentId: 0 }, Transform: { rz: 0.5 } } },
      { id: 9, name: 'R3', traits: { EntityAttributes: { name: 'R3', guid: 'g-r3', parentId: 0 }, Transform: { rz: 0.3 } } },
    );
    for (const [g, p] of [['g-m', 'g-r90'], ['g-t', 'g-r3']]) {
      expect(applyOps(s, [{ op: 'setTrait', entity: { guid: g }, trait: 'EntityAttributes', fields: { parentId: p } }], mint).errors).toEqual([]);
    }
    const m = byName(s, 'M').traits.Transform as Record<string, number>;
    expect(m.sy).toBe(-1);
    expect(m.sx).toBeUndefined();
    expect(m.rz).toBeCloseTo(-Math.PI / 2, 9);
    const t = byName(s, 'T').traits.Transform as Record<string, number>;
    expect(Object.keys(t).sort()).toEqual(['rx', 'ry', 'rz']);
    expect(t.rz).toBeCloseTo(0.2, 9);
  });

  // Between two parents with the same world pose nothing is rewritten: the round trip turned `{sy:-1}` into the
  // equivalent `{sx:-1, rz:π}`, which a game reading the sign of `sy` does not treat as equivalent. Mutation: drop the
  // sameTrsMatrix early return — K's Transform is rewritten.
  it('a move between parents with the same world pose leaves the authored numbers alone', () => {
    const s = scene();
    s.entities.push(
      { id: 6, name: 'G', traits: { EntityAttributes: { name: 'G', guid: 'g-g', parentId: 0 }, Transform: tf(0) } },
      { id: 7, name: 'K', traits: { EntityAttributes: { name: 'K', guid: 'g-k', parentId: 0 }, Transform: { x: 1, sy: -1, rz: 3.5 } } },
    );
    expect(applyOps(s, [{ op: 'setTrait', entity: { guid: 'g-k' }, trait: 'EntityAttributes', fields: { parentId: 'g-g' } }], mint).errors).toEqual([]);
    expect(byName(s, 'K').traits.Transform).toEqual({ x: 1, sy: -1, rz: 3.5 });
  });
});
