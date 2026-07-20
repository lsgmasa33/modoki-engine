/** sceneMutate unit tests — setTrait / addEntity / removeEntity on the on-disk
 *  scene shape. Deterministic GUID minting injected. Pure, no world. */

import { describe, it, expect } from 'vitest';
import { applyOps, type MutableScene, type MutateOp } from '../../src/runtime/scene/sceneMutate';
import { validateSceneData, type SceneSchema } from '../../src/runtime/scene/sceneValidation';

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
  it('warns when parentId matches no existing entity (orphan), but still adds', () => {
    const scene = freshScene();
    const res = applyOps(scene, [{ op: 'addEntity', name: 'Orphan', parentId: 999 }], mint);
    expect(res.errors).toEqual([]);
    expect(res.changed).toBe(1); // still added
    expect(res.warnings.join('\n')).toMatch(/parentId '999' matches no existing entity/);
  });

  it('does NOT warn when parentId matches an existing entity (numeric or guid)', () => {
    expect(applyOps(freshScene(), [{ op: 'addEntity', name: 'A', parentId: 1 }], mint).warnings).toEqual([]);
    expect(applyOps(freshScene(), [{ op: 'addEntity', name: 'B', parentId: 'g-root' }], mint).warnings).toEqual([]);
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
    applyOps(scene, [{ op: 'removeEntity', entity: { name: 'Child' } }], mint);
    expect(scene.entities.map((e) => e.id)).toEqual([1]);
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
