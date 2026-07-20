/** entityActions unit tests — writeTraitFieldWithUndo, snapshotEntity, respawnFromSnapshot,
 *  deleteEntityWithUndo (including redo fallback). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
});
const EntityAttributes = trait({
  name: '' as string,
  isActive: true as boolean,
  sortOrder: 0,
  parentId: 0,
  guid: '' as string,
  layer: '' as '' | '3d' | '2d' | 'ui',
});
const TestTag = trait();
const Health = trait({ hp: 100 });
// AoS trait with a map field (clips) NOT declared in meta.fields — mirrors SpriteAnimator,
// exercising the readTraitDataFull fallback path in writeTraitFieldsPerEntityWithUndo.
const SpriteAnim = trait(() => ({ clips: {} as Record<string, any>, clip: '' as string, time: 0, playing: true }));
const PrefabInstance = trait({ source: '', localId: 0, rootInstanceId: 0, parentLocalId: 0 });

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  registerEntity: (entity: any) => entityIndex.set(entity.id(), entity),
  unregisterEntity: (entity: any) => entityIndex.delete(entity.id()),
  setStructureCallback: vi.fn(),
  findEntityByGuid: (guid: string, world: any = testWorld) => {
    let found: any;
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
  getGuidIndex: (world: any = testWorld) => {
    const m = new Map<string, any>();
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { const g = ea.guid; if (g && !m.has(g)) m.set(g, e); });
    return m;
  },
  rebuildGuidIndexSync: () => {},
}));

const traitDefs = [
  {
    name: 'Transform', trait: Transform, category: 'component' as const,
    fields: {
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' },
      sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' },
    },
  },
  {
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component' as const,
    fields: {
      name: { type: 'string' }, isActive: { type: 'boolean' },
      sortOrder: { type: 'number' }, parentId: { type: 'number' },
      guid: { type: 'string' }, layer: { type: 'string' },
    },
  },
  { name: 'TestTag', trait: TestTag, category: 'tag' as const, fields: {} },
  { name: 'Health', trait: Health, category: 'component' as const, fields: { hp: { type: 'number' } } },
  // Only scalar fields declared; `clips`/`clip` are intentionally omitted (custom section owns them).
  { name: 'SpriteAnim', trait: SpriteAnim, category: 'component' as const, fields: { time: { type: 'number' }, playing: { type: 'boolean' } } },
  {
    name: 'PrefabInstance', trait: PrefabInstance, category: 'component' as const,
    fields: {
      source: { type: 'string' }, localId: { type: 'number' },
      rootInstanceId: { type: 'number' }, parentLocalId: { type: 'number' },
    },
  },
];

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getAllTraits: () => traitDefs,
  getTraitByName: (name: string) => traitDefs.find(t => t.name === name),
  transformName: (n: string) => n,
}));

// Mock worldTransforms (used by reparentEntity)
vi.mock('../../src/three/systems/transformPropagationSystem', () => ({
  worldTransforms: new Map(),
}));

// Capture pushed actions
let pushedActions: { label: string; undo: () => void | Promise<void>; redo: () => void | Promise<void> }[] = [];
vi.mock('../../src/editor/undo/undoManager', () => ({
  pushAction: (action: any) => { pushedActions.push(action); },
}));

beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
  pushedActions = [];
});

afterEach(() => {
  testWorld.destroy();
});

function spawnEntity(name: string, tf?: Partial<Record<string, number>>, parentId = 0) {
  const entity = testWorld.spawn(
    Transform(tf as any ?? {}),
    EntityAttributes({ name, parentId }),
  );
  entityIndex.set(entity.id(), entity);
  return entity;
}

async function getModule() {
  return import('../../src/editor/undo/entityActions');
}

describe('writeTraitFieldWithUndo', () => {
  it('writes field and pushes undo action', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const entity = spawnEntity('Test', { x: 0 });

    const tfMeta = traitDefs.find(t => t.name === 'Transform')!;
    writeTraitFieldWithUndo(entity.id(), tfMeta as any, 'x', 42);

    // Verify the field was written
    let xValue = 0;
    testWorld.query(Transform).updateEach(([tf], e) => {
      if (e.id() === entity.id()) xValue = tf.x;
    });
    expect(xValue).toBe(42);

    // Verify undo was pushed
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toContain('Transform');
    expect(pushedActions[0].label).toContain('x');
  });

  it('undo restores previous value', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const entity = spawnEntity('Test', { x: 10 });

    const tfMeta = traitDefs.find(t => t.name === 'Transform')!;
    writeTraitFieldWithUndo(entity.id(), tfMeta as any, 'x', 99);

    // Undo
    pushedActions[0].undo();

    let xValue = 0;
    testWorld.query(Transform).updateEach(([tf], e) => {
      if (e.id() === entity.id()) xValue = tf.x;
    });
    expect(xValue).toBe(10);
  });

  it('handles tag trait toggle', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const entity = spawnEntity('Tagged');

    const tagMeta = traitDefs.find(t => t.name === 'TestTag')!;
    writeTraitFieldWithUndo(entity.id(), tagMeta as any, '', true);

    expect(entity.has(TestTag)).toBe(true);
    expect(pushedActions[0].label).toContain('toggle');

    // Undo removes tag
    pushedActions[0].undo();
    expect(entity.has(TestTag)).toBe(false);
  });

  it('tags a value edit with a per-(entity,trait,field) coalesceKey (F6)', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const entity = spawnEntity('Test', { x: 0 });
    const tfMeta = traitDefs.find(t => t.name === 'Transform')!;
    writeTraitFieldWithUndo(entity.id(), tfMeta as any, 'x', 1);
    const key = (pushedActions[0] as any).coalesceKey as string | undefined;
    expect(key).toBeDefined();
    expect(key).toContain('Transform.x');
    expect(key).toContain(String(entity.id()));
  });

  it('does NOT coalesce tag toggles (discrete clicks, not keystrokes)', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const entity = spawnEntity('Tagged');
    const tagMeta = traitDefs.find(t => t.name === 'TestTag')!;
    writeTraitFieldWithUndo(entity.id(), tagMeta as any, '', true);
    expect((pushedActions[0] as any).coalesceKey).toBeUndefined();
  });
});

describe('writeTraitFieldsPerEntityWithUndo (multi-field, single undo)', () => {
  function spawnSpriteAnim() {
    const e = testWorld.spawn(
      SpriteAnim({ clips: { rolling: { frames: ['a'], fps: 12, mode: 'loop', cycles: 0 } }, clip: 'rolling', time: 5, playing: true }),
      EntityAttributes({ name: 'sa', guid: 'g-sa-1' }),
    );
    entityIndex.set(e.id(), e);
    return e;
  }

  it('renames a track (clips + clip) atomically and restores BOTH on a single undo', async () => {
    const { writeTraitFieldsPerEntityWithUndo } = await getModule();
    const meta = traitDefs.find(t => t.name === 'SpriteAnim')!;
    const e = spawnSpriteAnim();

    writeTraitFieldsPerEntityWithUndo([e.id()], meta as any, (full) => {
      const clips = full!.clips as Record<string, any>;
      const out: Record<string, any> = {};
      for (const k of Object.keys(clips)) out[k === 'rolling' ? 'rollinga' : k] = clips[k];
      return { clips: out, clip: 'rollinga' };
    }, 'Rename track');

    // Applied: key renamed AND active pointer follows — in ONE undo entry.
    expect(Object.keys(e.get(SpriteAnim)!.clips)).toEqual(['rollinga']);
    expect(e.get(SpriteAnim)!.clip).toBe('rollinga');
    expect(pushedActions).toHaveLength(1);

    // Single undo restores both fields together (the bug: name didn't revert).
    pushedActions[0].undo();
    expect(Object.keys(e.get(SpriteAnim)!.clips)).toEqual(['rolling']);
    expect(e.get(SpriteAnim)!.clip).toBe('rolling');

    // Redo re-applies both.
    pushedActions[0].redo();
    expect(Object.keys(e.get(SpriteAnim)!.clips)).toEqual(['rollinga']);
    expect(e.get(SpriteAnim)!.clip).toBe('rollinga');
  });

  it('skips an entity whose patch is empty (no spurious undo entry)', async () => {
    const { writeTraitFieldsPerEntityWithUndo } = await getModule();
    const meta = traitDefs.find(t => t.name === 'SpriteAnim')!;
    spawnSpriteAnim();
    const e2 = spawnSpriteAnim();
    writeTraitFieldsPerEntityWithUndo([e2.id()], meta as any, () => ({}), 'noop');
    expect(pushedActions).toHaveLength(0);
  });
});

describe('writeTraitFieldMultiWithUndo', () => {
  it('shares one coalesceKey across the whole selection (order-independent)', async () => {
    const { writeTraitFieldMultiWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 0 });
    const b = spawnEntity('B', { x: 0 });
    const tfMeta = traitDefs.find(t => t.name === 'Transform')!;

    writeTraitFieldMultiWithUndo([a.id(), b.id()], tfMeta as any, 'x', 5);
    const key1 = (pushedActions[0] as any).coalesceKey;
    pushedActions = [];
    writeTraitFieldMultiWithUndo([b.id(), a.id()], tfMeta as any, 'x', 6);
    const key2 = (pushedActions[0] as any).coalesceKey;

    expect(key1).toBeDefined();
    expect(key1).toBe(key2); // same selection in either order → same key → coalesces
  });
});

describe('snapshotEntity', () => {
  it('captures all traits on an entity', async () => {
    const { snapshotEntity } = await getModule();
    const entity = spawnEntity('Hero', { x: 5, y: 10, z: 15 });

    const snapshot = snapshotEntity(entity.id());
    expect(snapshot).not.toBeNull();
    expect(snapshot!.id).toBe(entity.id());

    const tfSnap = snapshot!.traits.find(t => t.meta.name === 'Transform');
    expect(tfSnap).toBeDefined();
    expect((tfSnap!.data as Record<string, unknown>).x).toBe(5);
    expect((tfSnap!.data as Record<string, unknown>).y).toBe(10);
  });

  it('captures tag traits as boolean true', async () => {
    const { snapshotEntity } = await getModule();
    const entity = spawnEntity('Tagged');
    entity.add(TestTag);

    const snapshot = snapshotEntity(entity.id());
    const tagSnap = snapshot!.traits.find(t => t.meta.name === 'TestTag');
    expect(tagSnap).toBeDefined();
    expect(tagSnap!.data).toBe(true);
  });

  it('captures children recursively', async () => {
    const { snapshotEntity } = await getModule();
    const parent = spawnEntity('Parent');
    const child = spawnEntity('Child', { x: 1 }, parent.id());

    const snapshot = snapshotEntity(parent.id());
    expect(snapshot!.children).toHaveLength(1);
    expect(snapshot!.children[0].id).toBe(child.id());
  });

  it('returns null for non-existent entity', async () => {
    const { snapshotEntity } = await getModule();
    expect(snapshotEntity(99999)).toBeNull();
  });
});

describe('respawnFromSnapshot', () => {
  it('recreates entity from snapshot', async () => {
    const { snapshotEntity, respawnFromSnapshot } = await getModule();
    const entity = spawnEntity('Hero', { x: 42, y: 7 });
    const snapshot = snapshotEntity(entity.id())!;

    // Destroy original
    entity.destroy();
    entityIndex.delete(entity.id());

    // Respawn
    const newId = respawnFromSnapshot(snapshot);
    expect(newId).toBeGreaterThan(0);

    // Verify transform data preserved
    let found = false;
    testWorld.query(Transform).updateEach(([tf], e) => {
      if (e.id() === newId) { found = true; expect(tf.x).toBe(42); expect(tf.y).toBe(7); }
    });
    expect(found).toBe(true);
  });

  it('recreates children with new parent IDs', async () => {
    const { snapshotEntity, respawnFromSnapshot } = await getModule();
    const parent = spawnEntity('Parent');
    spawnEntity('Child', { x: 1 }, parent.id());
    const snapshot = snapshotEntity(parent.id())!;
    expect(snapshot.children).toHaveLength(1);

    // Destroy originals
    entityIndex.clear();

    const newParentId = respawnFromSnapshot(snapshot);
    expect(newParentId).toBeGreaterThan(0);

    // Verify child exists with new parent
    let childFound = false;
    testWorld.query(EntityAttributes).updateEach(([ea]) => {
      if (ea.parentId === newParentId) childFound = true;
    });
    expect(childFound).toBe(true);
  });

  // This is the kernel behind the Hierarchy "Paste" (copy) action: a snapshot is
  // re-spawned under a *chosen* parent, and the original tree must stay intact.
  it('pastes a deep copy under a chosen parent, leaving the original intact', async () => {
    const { snapshotEntity, respawnFromSnapshot } = await getModule();
    const src = spawnEntity('Widget', { x: 3 });
    spawnEntity('WidgetChild', { x: 1 }, src.id());
    const dest = spawnEntity('Folder');
    const snapshot = snapshotEntity(src.id())!;

    const pastedId = respawnFromSnapshot(snapshot, dest.id());
    expect(pastedId).toBeGreaterThan(0);
    expect(pastedId).not.toBe(src.id());

    const parentOf = (id: number) => {
      let p: number | undefined;
      testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === id) p = ea.parentId; });
      return p;
    };
    const childCountOf = (id: number) => {
      let n = 0;
      testWorld.query(EntityAttributes).updateEach(([ea]) => { if (ea.parentId === id) n++; });
      return n;
    };

    // Pasted root is reparented under dest and carries a deep-copied child.
    expect(parentOf(pastedId)).toBe(dest.id());
    expect(childCountOf(pastedId)).toBe(1);

    // The original is untouched: still at root, still owns its own child.
    expect(parentOf(src.id())).toBe(0);
    expect(childCountOf(src.id())).toBe(1);
  });
});

describe('createEntitySubtreeWithUndo', () => {
  const countByNames = (names: string[]) => {
    let n = 0;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[]) => { if (names.includes(ea.name)) n++; });
    return n;
  };
  const findByName = (name: string) => {
    let out: { id: number; parent: number } | null = null;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (ea.name === name) out = { id: e.id(), parent: ea.parentId }; });
    return out as { id: number; parent: number } | null;
  };

  it('creates a nested subtree as ONE undo entry; undo removes all, redo restores', async () => {
    const { createEntitySubtreeWithUndo } = await getModule();
    const selectEntity = vi.fn();
    const rootId = createEntitySubtreeWithUndo('Add rig', 0, {
      traits: [
        { name: 'Transform', data: { x: 100 } },
        { name: 'EntityAttributes', data: { name: 'RigRoot', layer: '2d' } },
      ],
      children: [{
        traits: [
          { name: 'Transform', data: { y: 96 } },
          { name: 'EntityAttributes', data: { name: 'boneA', layer: '2d' } },
        ],
        children: [{
          traits: [
            { name: 'Transform', data: { y: -96 } },
            { name: 'EntityAttributes', data: { name: 'boneB', layer: '2d' } },
          ],
        }],
      }],
    }, selectEntity);

    expect(rootId).not.toBeNull();
    expect(selectEntity).toHaveBeenLastCalledWith(rootId);
    // Hierarchy is correct: boneA under root, boneB under boneA.
    const a = findByName('boneA')!; const b = findByName('boneB')!;
    expect(findByName('RigRoot')!.id).toBe(rootId);
    expect(a.parent).toBe(rootId);
    expect(b.parent).toBe(a.id);
    // ONE undo entry for the whole subtree.
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Add rig');
    expect(countByNames(['RigRoot', 'boneA', 'boneB'])).toBe(3);

    // Undo removes the whole subtree; redo restores it.
    pushedActions[0].undo();
    expect(countByNames(['RigRoot', 'boneA', 'boneB'])).toBe(0);
    pushedActions[0].redo();
    expect(countByNames(['RigRoot', 'boneA', 'boneB'])).toBe(3);
  });

  it('forces each child parentId to its spawned parent (caller specs need not know ids)', async () => {
    const { createEntitySubtreeWithUndo } = await getModule();
    const rootId = createEntitySubtreeWithUndo('t', 0, {
      traits: [{ name: 'EntityAttributes', data: { name: 'P' } }],
      children: [{ traits: [{ name: 'EntityAttributes', data: { name: 'C', parentId: 999 } }] }],
    }, vi.fn());
    expect(findByName('C')!.parent).toBe(rootId); // bogus 999 overridden
  });
});

describe('duplicateEntity', () => {
  it('duplicates an entity into the same parent and selects the copy', async () => {
    const { duplicateEntity } = await getModule();
    const parent = spawnEntity('Parent');
    const original = spawnEntity('Original', { x: 5 }, parent.id());
    const selectEntity = vi.fn();

    const newId = duplicateEntity(original.id(), selectEntity);
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(original.id());
    expect(selectEntity).toHaveBeenLastCalledWith(newId);

    // Copy lives under the same parent
    let copyParent = -1;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => {
      if (e.id() === newId) copyParent = ea.parentId;
    });
    expect(copyParent).toBe(parent.id());
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Duplicate Entity');
  });

  it('duplicates children recursively', async () => {
    const { duplicateEntity } = await getModule();
    const root = spawnEntity('Root');
    spawnEntity('Kid', { x: 1 }, root.id());
    const selectEntity = vi.fn();

    const newId = duplicateEntity(root.id(), selectEntity)!;

    let kidCount = 0;
    testWorld.query(EntityAttributes).updateEach(([ea]) => {
      if (ea.parentId === newId) kidCount++;
    });
    expect(kidCount).toBe(1);
  });

  it('undo removes the duplicate, redo re-creates it', async () => {
    const { duplicateEntity } = await getModule();
    const original = spawnEntity('Dup', { x: 3 });
    const selectEntity = vi.fn();

    duplicateEntity(original.id(), selectEntity);
    const countDups = () => {
      let n = 0;
      testWorld.query(EntityAttributes).updateEach(([ea]) => { if (ea.name === 'Dup') n++; });
      return n;
    };
    expect(countDups()).toBe(2);

    pushedActions[0].undo();
    expect(countDups()).toBe(1);

    pushedActions[0].redo();
    expect(countDups()).toBe(2);
  });

  it('assigns the duplicate a distinct sortOrder (max sibling + 1), never the source value', async () => {
    const { duplicateEntity } = await getModule();
    const parent = spawnEntity('Parent');
    // Original with an explicit sortOrder among its parent's children.
    const original = testWorld.spawn(
      Transform({}),
      EntityAttributes({ name: 'Original', parentId: parent.id(), sortOrder: 5 }),
    );
    entityIndex.set(original.id(), original);
    const selectEntity = vi.fn();

    const sortOrderOf = (id: number) => {
      let so = -1;
      testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === id) so = ea.sortOrder; });
      return so;
    };

    const newId = duplicateEntity(original.id(), selectEntity)!;
    expect(sortOrderOf(original.id())).toBe(5);     // source untouched
    expect(sortOrderOf(newId)).toBe(6);             // max sibling (5) + 1
    expect(sortOrderOf(newId)).not.toBe(sortOrderOf(original.id())); // no collision

    // Redo must reassign a distinct sortOrder too (not clone the source's 5).
    pushedActions[0].undo();
    pushedActions[0].redo();
    let redoId = -1;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => {
      if (ea.name === 'Original' && e.id() !== original.id()) redoId = e.id();
    });
    expect(sortOrderOf(redoId)).toBe(6);
  });

  it('mints a FRESH distinct guid for the copy (and its children), never the source guid', async () => {
    // Regression: duplicating an entity used to copy EntityAttributes verbatim,
    // including guid → two entities sharing one guid. That broke guid-keyed logic
    // (prefab "+added.<guid>" override keys → duplicate-key React crash, selection
    // restore, asset refs).
    const { duplicateEntity } = await getModule();
    const root = testWorld.spawn(
      Transform({}),
      EntityAttributes({ name: 'Root', parentId: 0, guid: 'src-root' }),
    );
    entityIndex.set(root.id(), root);
    const kid = testWorld.spawn(
      Transform({}),
      EntityAttributes({ name: 'Kid', parentId: root.id(), guid: 'src-kid' }),
    );
    entityIndex.set(kid.id(), kid);
    const selectEntity = vi.fn();

    const guidOf = (id: number) => {
      let g = '';
      testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === id) g = ea.guid; });
      return g;
    };

    const newId = duplicateEntity(root.id(), selectEntity)!;
    // Source guids untouched.
    expect(guidOf(root.id())).toBe('src-root');
    expect(guidOf(kid.id())).toBe('src-kid');

    // Collect every live guid; all must be unique and the copies must differ from source.
    const guids: string[] = [];
    testWorld.query(EntityAttributes).updateEach(([ea]) => { guids.push(ea.guid); });
    expect(new Set(guids).size).toBe(guids.length); // no collisions anywhere
    const copyGuid = guidOf(newId);
    expect(copyGuid).toBeTruthy();
    expect(copyGuid).not.toBe('src-root');
    expect(copyGuid).not.toBe('src-kid');

    // Redo must reproduce the SAME fresh guid (stable identity across undo/redo),
    // not mint a third one or fall back to the source guid.
    pushedActions[0].undo();
    pushedActions[0].redo();
    let redoRootId = -1;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => {
      if (ea.name === 'Root' && e.id() !== root.id()) redoRootId = e.id();
    });
    expect(guidOf(redoRootId)).toBe(copyGuid);
  });

  it('returns null for non-existent entity', async () => {
    const { duplicateEntity } = await getModule();
    expect(duplicateEntity(99999, vi.fn())).toBeNull();
    expect(pushedActions).toHaveLength(0);
  });

  // ── prefab F1: duplicating prefab-instance members ──
  // Builds a 2-entity instance (root A + child member B), both PrefabInstance,
  // rootInstanceId === A.id (the instance-root convention).
  const spawnInstance = () => {
    const a = testWorld.spawn(
      Transform({}),
      EntityAttributes({ name: 'A', parentId: 0, guid: 'src-A' }),
      PrefabInstance({ source: 'prefabs/p.prefab.json', localId: 1, rootInstanceId: 0 }),
    );
    entityIndex.set(a.id(), a);
    a.set(PrefabInstance, { ...a.get(PrefabInstance)!, rootInstanceId: a.id() });
    const b = testWorld.spawn(
      Transform({}),
      EntityAttributes({ name: 'B', parentId: a.id(), guid: 'src-B' }),
      PrefabInstance({ source: 'prefabs/p.prefab.json', localId: 2, rootInstanceId: a.id() }),
    );
    entityIndex.set(b.id(), b);
    return { a, b };
  };
  const piOf = (id: number) => entityIndex.get(id)?.get(PrefabInstance) as
    { source: string; localId: number; rootInstanceId: number } | undefined;

  it('duplicating an instance ROOT re-roots the copy into its OWN linked instance', async () => {
    const { duplicateEntity } = await getModule();
    const { a, b } = spawnInstance();

    const newRootId = duplicateEntity(a.id(), vi.fn())!;
    // Collect the copy's two members (skip the source A/B by guid).
    const copyIds: number[] = [];
    testWorld.query(EntityAttributes).updateEach(([ea], e) => {
      if (ea.guid === 'src-A' || ea.guid === 'src-B') return;
      copyIds.push(e.id());
    });
    expect(copyIds).toHaveLength(2);

    // Copy is still a linked instance of the same prefab, but rooted at ITSELF.
    for (const id of copyIds) {
      const pi = piOf(id)!;
      expect(pi.source).toBe('prefabs/p.prefab.json');     // same prefab
      expect(pi.rootInstanceId).toBe(newRootId);            // re-rooted to the copy
    }
    // localIds preserved (a second instance shares the prefab-local ids).
    expect(new Set(copyIds.map(id => piOf(id)!.localId))).toEqual(new Set([1, 2]));
    // Source instance untouched — disjoint rootInstanceId group keyed on its own A.
    expect(piOf(a.id())!.rootInstanceId).toBe(a.id());
    expect(piOf(b.id())!.rootInstanceId).toBe(a.id());
    expect(newRootId).not.toBe(a.id());

    // Redo must re-root again (fresh ids) — no stale rootInstanceId from the source.
    pushedActions[0].undo();
    pushedActions[0].redo();
    let redoRoot = -1;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (ea.name === 'A' && e.id() !== a.id()) redoRoot = e.id(); });
    expect(piOf(redoRoot)!.rootInstanceId).toBe(redoRoot);
  });

  it('duplicating a child MEMBER strips PrefabInstance → an added plain child', async () => {
    const { duplicateEntity } = await getModule();
    const { a, b } = spawnInstance();

    const newId = duplicateEntity(b.id(), vi.fn())!;
    // The copy carries NO PrefabInstance (it's an added child, like a hand-added entity).
    expect(entityIndex.get(newId)?.has(PrefabInstance)).toBe(false);
    // It's parented under B's parent (A, a member) so captureInstanceStructure sees it as added.
    let copyParent = -1;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === newId) copyParent = ea.parentId; });
    expect(copyParent).toBe(a.id());
    // Source member B untouched.
    expect(piOf(b.id())!.rootInstanceId).toBe(a.id());
    expect(piOf(b.id())!.localId).toBe(2);
  });
});

describe('reparentEntity prefab boundaries (panels F2)', () => {
  // Instance: A (root) with child member B, both PrefabInstance, rootInstanceId === A.id.
  const buildInstance = () => {
    const a = testWorld.spawn(Transform({}), EntityAttributes({ name: 'A', parentId: 0, guid: 'A' }),
      PrefabInstance({ source: 'p.json', localId: 1, rootInstanceId: 0 }));
    entityIndex.set(a.id(), a);
    a.set(PrefabInstance, { ...a.get(PrefabInstance)!, rootInstanceId: a.id() });
    const b = testWorld.spawn(Transform({}), EntityAttributes({ name: 'B', parentId: a.id(), guid: 'B' }),
      PrefabInstance({ source: 'p.json', localId: 2, rootInstanceId: a.id() }));
    entityIndex.set(b.id(), b);
    return { a, b };
  };
  const has = (id: number) => entityIndex.get(id)?.has(PrefabInstance) ?? false;

  it('auto-detaches a member dragged OUT of its instance (and undo re-tags it)', async () => {
    const { reparentEntity } = await getModule();
    const { a, b } = buildInstance();
    expect(reparentEntity(b.id(), 0)).toBe(true); // move B to scene root
    expect(has(b.id())).toBe(false);              // B unpacked → plain entity
    expect(has(a.id())).toBe(true);               // source root untouched

    pushedActions[pushedActions.length - 1].undo();
    expect(has(b.id())).toBe(true);               // re-tagged on undo
    expect(entityIndex.get(b.id())!.get(PrefabInstance)!.rootInstanceId).toBe(a.id());
  });

  it('keeps PrefabInstance when a member moves WITHIN the same instance', async () => {
    const { reparentEntity } = await getModule();
    const { a, b } = buildInstance();
    const d = testWorld.spawn(Transform({}), EntityAttributes({ name: 'D', parentId: a.id(), guid: 'D' }),
      PrefabInstance({ source: 'p.json', localId: 3, rootInstanceId: a.id() }));
    entityIndex.set(d.id(), d);
    expect(reparentEntity(b.id(), d.id())).toBe(true); // B under D — both in instance A
    expect(has(b.id())).toBe(true);                    // stays a member
    expect(entityIndex.get(b.id())!.get(PrefabInstance)!.rootInstanceId).toBe(a.id());
  });

  it('allows a plain entity dragged INTO an instance (stays plain → added child)', async () => {
    const { reparentEntity } = await getModule();
    const { a } = buildInstance();
    const c = testWorld.spawn(Transform({}), EntityAttributes({ name: 'C', parentId: 0, guid: 'C' }));
    entityIndex.set(c.id(), c);
    expect(reparentEntity(c.id(), a.id())).toBe(true);
    expect(has(c.id())).toBe(false); // no PrefabInstance added — it's an added child
    let parent = -1;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === c.id()) parent = ea.parentId; });
    expect(parent).toBe(a.id());
  });
});

describe('reparentEntity core rules (panels #1)', () => {
  const attrOf = (id: number) => {
    let out: { parentId: number; sortOrder: number } | null = null;
    testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === id) out = { parentId: ea.parentId, sortOrder: ea.sortOrder }; });
    return out!;
  };
  const tfOf = (id: number) => {
    let out: Record<string, number> | null = null;
    testWorld.query(Transform).updateEach(([t], e) => { if (e.id() === id) out = { x: t.x, y: t.y, z: t.z, sx: t.sx, sy: t.sy, sz: t.sz }; });
    return out!;
  };

  it('rejects a self-drop', async () => {
    const { reparentEntity } = await getModule();
    const a = spawnEntity('A');
    expect(reparentEntity(a.id(), a.id())).toBe(false);
    expect(pushedActions).toHaveLength(0);
  });

  it('rejects an ancestor cycle (moving a parent under its own descendant)', async () => {
    const { reparentEntity } = await getModule();
    const a = spawnEntity('A');
    const b = spawnEntity('B', {}, a.id()); // B is a child of A
    expect(reparentEntity(a.id(), b.id())).toBe(false); // can't put A under B
    expect(pushedActions).toHaveLength(0);
  });

  it('is a no-op (returns false, no undo) when parent and order are unchanged', async () => {
    const { reparentEntity } = await getModule();
    const a = spawnEntity('A'); // parent 0, sortOrder 0
    expect(reparentEntity(a.id(), 0)).toBe(false); // same parent, no new sortOrder
    expect(pushedActions).toHaveLength(0);
  });

  it('applies the new parent + sortOrder and pushes one undo action', async () => {
    const { reparentEntity } = await getModule();
    const p = spawnEntity('P');
    const c = spawnEntity('C'); // at root
    expect(reparentEntity(c.id(), p.id(), 30)).toBe(true);
    expect(attrOf(c.id())).toEqual({ parentId: p.id(), sortOrder: 30 });
    expect(pushedActions).toHaveLength(1);
  });

  it('reorders under the same parent without a parent change', async () => {
    const { reparentEntity } = await getModule();
    const p = spawnEntity('P');
    const c = spawnEntity('C', {}, p.id());
    expect(reparentEntity(c.id(), p.id(), 50)).toBe(true); // same parent, new order
    expect(attrOf(c.id())).toEqual({ parentId: p.id(), sortOrder: 50 });
    expect(pushedActions[0].label).toContain('Reorder');
  });

  it('compensates the local transform on parent change to preserve world position', async () => {
    const mod = await import('../../src/three/systems/transformPropagationSystem');
    const wt = mod.worldTransforms as Map<number, any>;
    wt.clear();
    const { reparentEntity } = await getModule();
    const p = spawnEntity('P', { x: 10 });
    const c = spawnEntity('C', { x: 10 }); // world (10,0,0) at root
    wt.set(p.id(), { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    wt.set(c.id(), { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

    expect(reparentEntity(c.id(), p.id())).toBe(true);
    // local = inv(parentWorld) * childWorld → x: 10 - 10 = 0 (stays at world x=10 under P)
    expect(tfOf(c.id()).x).toBeCloseTo(0, 5);
    wt.clear();
  });

  it('undo restores parent + sortOrder + local transform; redo re-applies', async () => {
    const mod = await import('../../src/three/systems/transformPropagationSystem');
    const wt = mod.worldTransforms as Map<number, any>;
    wt.clear();
    const { reparentEntity } = await getModule();
    const p = spawnEntity('P', { x: 10 });
    const c = spawnEntity('C', { x: 10 });
    wt.set(p.id(), { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    wt.set(c.id(), { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

    reparentEntity(c.id(), p.id(), 7);
    expect(attrOf(c.id())).toEqual({ parentId: p.id(), sortOrder: 7 });
    expect(tfOf(c.id()).x).toBeCloseTo(0, 5);

    const action = pushedActions[pushedActions.length - 1];
    action.undo();
    expect(attrOf(c.id())).toEqual({ parentId: 0, sortOrder: 0 });
    expect(tfOf(c.id()).x).toBeCloseTo(10, 5); // original local restored

    action.redo();
    expect(attrOf(c.id())).toEqual({ parentId: p.id(), sortOrder: 7 });
    expect(tfOf(c.id()).x).toBeCloseTo(0, 5);
    wt.clear();
  });
});

describe('deleteEntityWithUndo', () => {
  it('deletes entity and pushes undo action', async () => {
    const { deleteEntityWithUndo } = await getModule();
    const entity = spawnEntity('Victim', { x: 99 });
    const id = entity.id();

    deleteEntityWithUndo(id);

    expect(entityIndex.has(id)).toBe(false);
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Delete Entity');
  });

  it('undo respawns the deleted entity', async () => {
    const { deleteEntityWithUndo } = await getModule();
    const entity = spawnEntity('Respawnable', { x: 77 });

    deleteEntityWithUndo(entity.id());
    expect(pushedActions).toHaveLength(1);

    // Undo
    pushedActions[0].undo();

    // Verify an entity with the same name exists
    let found = false;
    testWorld.query(EntityAttributes).updateEach(([ea]) => {
      if (ea.name === 'Respawnable') found = true;
    });
    expect(found).toBe(true);
  });

  it('is a no-op for non-existent entity', async () => {
    const { deleteEntityWithUndo } = await getModule();
    deleteEntityWithUndo(99999);
    expect(pushedActions).toHaveLength(0);
  });

  it('redo deletes the entity again by name', async () => {
    const { deleteEntityWithUndo } = await getModule();
    const entity = spawnEntity('RedoTarget', { x: 1 });

    deleteEntityWithUndo(entity.id());
    // Undo (respawn)
    pushedActions[0].undo();

    // Verify respawned
    let exists = false;
    testWorld.query(EntityAttributes).updateEach(([ea]) => {
      if (ea.name === 'RedoTarget') exists = true;
    });
    expect(exists).toBe(true);

    // Redo (delete again)
    pushedActions[0].redo();

    // Verify deleted again
    exists = false;
    testWorld.query(EntityAttributes).updateEach(([ea]) => {
      if (ea.name === 'RedoTarget') exists = true;
    });
    expect(exists).toBe(false);
  });
});

describe('deleteEntitiesWithUndo', () => {
  function nameExists(name: string): boolean {
    let found = false;
    testWorld.query(EntityAttributes).updateEach(([ea]) => { if (ea.name === name) found = true; });
    return found;
  }

  it('deletes the whole selection as a SINGLE undo entry', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A'); const b = spawnEntity('B'); const c = spawnEntity('C');

    deleteEntitiesWithUndo([a.id(), b.id(), c.id()]);

    expect(entityIndex.has(a.id())).toBe(false);
    expect(entityIndex.has(b.id())).toBe(false);
    expect(entityIndex.has(c.id())).toBe(false);
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Delete 3 Entities');
  });

  it('one undo restores every deleted entity; redo deletes them all again', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    const a = spawnEntity('Alpha'); const b = spawnEntity('Beta');

    deleteEntitiesWithUndo([a.id(), b.id()]);
    expect(nameExists('Alpha')).toBe(false);
    expect(nameExists('Beta')).toBe(false);

    pushedActions[0].undo();
    expect(nameExists('Alpha')).toBe(true);
    expect(nameExists('Beta')).toBe(true);

    pushedActions[0].redo();
    expect(nameExists('Alpha')).toBe(false);
    expect(nameExists('Beta')).toBe(false);
  });

  it('drops descendants whose ancestor is also selected (no double-handling)', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    const parent = spawnEntity('Parent');
    const child = spawnEntity('Child', undefined, parent.id());

    // Select both parent and child. Parent's snapshot already captures the
    // child subtree, so only one root should be snapshotted.
    deleteEntitiesWithUndo([parent.id(), child.id()]);
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Delete Entity'); // 1 root, singular label
    expect(nameExists('Parent')).toBe(false);
    expect(nameExists('Child')).toBe(false);

    // Undo restores both (the subtree comes back with the parent).
    pushedActions[0].undo();
    expect(nameExists('Parent')).toBe(true);
    expect(nameExists('Child')).toBe(true);
  });

  it('threads the selection setter: clears on delete, reselects restored ids on undo', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    const a = spawnEntity('S1'); const b = spawnEntity('S2');
    const selCalls: number[][] = [];

    deleteEntitiesWithUndo([a.id(), b.id()], (ids) => selCalls.push(ids));
    expect(selCalls).toEqual([[]]); // cleared on initial delete

    pushedActions[0].undo();
    expect(selCalls).toHaveLength(2);
    expect(selCalls[1]).toHaveLength(2); // two restored ids reselected
  });

  it('is a no-op (no undo entry) for an empty selection', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    deleteEntitiesWithUndo([]);
    expect(pushedActions).toHaveLength(0);
  });

  it('is a no-op for ids that do not resolve to live entities', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    deleteEntitiesWithUndo([99999, 88888]);
    expect(pushedActions).toHaveLength(0);
  });
});

// ── Multi-entity editing (Inspector multi-select) ──

const tfMeta = () => traitDefs.find(t => t.name === 'Transform')! as any;
const healthMeta = () => traitDefs.find(t => t.name === 'Health')! as any;

function xOf(id: number) {
  let x = NaN;
  testWorld.query(Transform).updateEach(([tf], e) => { if (e.id() === id) x = tf.x; });
  return x;
}
function hpOf(id: number) {
  let hp: number | null = null;
  testWorld.query(Health).updateEach(([h], e) => { if (e.id() === id) hp = h.hp; });
  return hp;
}

describe('writeTraitFieldMultiWithUndo', () => {
  it('writes one field to every entity as a single undo entry, restoring mixed prior values', async () => {
    const { writeTraitFieldMultiWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 1 });
    const b = spawnEntity('B', { x: 2 });

    writeTraitFieldMultiWithUndo([a.id(), b.id()], tfMeta(), 'x', 9);
    expect(xOf(a.id())).toBe(9);
    expect(xOf(b.id())).toBe(9);

    // One coalesced undo entry, labelled with the count.
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toContain('(2)');

    // Undo restores each entity's distinct original value.
    pushedActions[0].undo();
    expect(xOf(a.id())).toBe(1);
    expect(xOf(b.id())).toBe(2);

    // Redo reapplies to both.
    pushedActions[0].redo();
    expect(xOf(a.id())).toBe(9);
    expect(xOf(b.id())).toBe(9);
  });

  it('is a no-op (no undo entry) for an empty selection', async () => {
    const { writeTraitFieldMultiWithUndo } = await getModule();
    writeTraitFieldMultiWithUndo([], tfMeta(), 'x', 5);
    expect(pushedActions).toHaveLength(0);
  });
});

describe('writeTraitFieldPerEntityWithUndo', () => {
  it('derives each entity\'s new value from its own prior value (preserves per-entity state)', async () => {
    const { writeTraitFieldPerEntityWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 1 });
    const b = spawnEntity('B', { x: 2 });

    // Mirrors the UIAction.bindings case: one logical edit, but the result is
    // computed per-entity so each keeps its own distinct value.
    writeTraitFieldPerEntityWithUndo([a.id(), b.id()], tfMeta(), 'x',
      (old) => (old as number) + 10, 'Edit binding x');
    expect(xOf(a.id())).toBe(11);
    expect(xOf(b.id())).toBe(12);

    // One coalesced undo entry labelled with the count.
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toContain('(2)');

    // Undo restores each entity's distinct original value.
    pushedActions[0].undo();
    expect(xOf(a.id())).toBe(1);
    expect(xOf(b.id())).toBe(2);

    // Redo reapplies the per-entity result.
    pushedActions[0].redo();
    expect(xOf(a.id())).toBe(11);
    expect(xOf(b.id())).toBe(12);
  });

  it('skips entities whose computed value is unchanged (no spurious writes)', async () => {
    const { writeTraitFieldPerEntityWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 5 });
    const b = spawnEntity('B', { x: 2 });

    // Only b changes (a returns its old value → skipped).
    writeTraitFieldPerEntityWithUndo([a.id(), b.id()], tfMeta(), 'x',
      (old) => (old as number) === 2 ? 99 : (old as number), 'Edit binding x');
    expect(xOf(a.id())).toBe(5);
    expect(xOf(b.id())).toBe(99);

    // Single entity changed → no count suffix.
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).not.toContain('(');
  });

  it('is a no-op (no undo entry) when nothing changes or selection is empty', async () => {
    const { writeTraitFieldPerEntityWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 7 });
    writeTraitFieldPerEntityWithUndo([a.id()], tfMeta(), 'x', (old) => old, 'Edit binding x');
    writeTraitFieldPerEntityWithUndo([], tfMeta(), 'x', () => 1, 'Edit binding x');
    expect(pushedActions).toHaveLength(0);
  });
});

// ── Structured !edit detail (Percept V1) ──
// The write helpers attach a machine-readable {trait, field, entities[guid], old[], new[]}
// diff to the pushed action; undoManager forwards it into the editor journal's !edit event.

function guidOf(id: number) {
  let g = '';
  testWorld.query(EntityAttributes).updateEach(([ea], e) => { if (e.id() === id) g = ea.guid; });
  return g;
}

describe('structured edit detail (Percept V1)', () => {
  it('writeTraitFieldWithUndo captures {trait, field, entity guid, old→new}', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const e = spawnEntity('Test', { x: 0 });
    writeTraitFieldWithUndo(e.id(), tfMeta(), 'x', 42);
    const detail = (pushedActions[0] as any).detail;
    expect(detail).toEqual({ trait: 'Transform', field: 'x', entities: [guidOf(e.id())], old: [0], new: [42] });
    expect(detail.entities[0]).toBeTruthy(); // a real minted guid, not ''
  });

  it('a tag toggle reports field "" with boolean old→new', async () => {
    const { writeTraitFieldWithUndo } = await getModule();
    const e = spawnEntity('Tagged');
    writeTraitFieldWithUndo(e.id(), traitDefs.find(t => t.name === 'TestTag')! as any, '', true);
    expect((pushedActions[0] as any).detail).toEqual({ trait: 'TestTag', field: '', entities: [guidOf(e.id())], old: [false], new: [true] });
  });

  it('writeTraitFieldMultiWithUndo aligns entities/old with the selection and broadcasts new', async () => {
    const { writeTraitFieldMultiWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 1 });
    const b = spawnEntity('B', { x: 2 });
    writeTraitFieldMultiWithUndo([a.id(), b.id()], tfMeta(), 'x', 9);
    const detail = (pushedActions[0] as any).detail;
    expect(detail).toEqual({ trait: 'Transform', field: 'x', entities: [guidOf(a.id()), guidOf(b.id())], old: [1, 2], new: [9, 9] });
  });

  it('writeTraitFieldPerEntityWithUndo records each entity\'s distinct old→new (skips unchanged)', async () => {
    const { writeTraitFieldPerEntityWithUndo } = await getModule();
    const a = spawnEntity('A', { x: 1 });
    const b = spawnEntity('B', { x: 2 });
    writeTraitFieldPerEntityWithUndo([a.id(), b.id()], tfMeta(), 'x', (old) => (old as number) + 10, 'Edit x');
    const detail = (pushedActions[0] as any).detail;
    expect(detail).toEqual({ trait: 'Transform', field: 'x', entities: [guidOf(a.id()), guidOf(b.id())], old: [1, 2], new: [11, 12] });
  });
});

describe('structural journal kinds (Percept V2)', () => {
  const spawnG = (name: string, guid: string, parentId = 0) => {
    const e = testWorld.spawn(Transform({}), EntityAttributes({ name, parentId, guid }));
    entityIndex.set(e.id(), e);
    return e;
  };
  const last = () => pushedActions[pushedActions.length - 1] as any;

  it('createEntitySubtreeWithUndo tags !create with entity + parent guids', async () => {
    const { createEntitySubtreeWithUndo } = await getModule();
    const rootId = createEntitySubtreeWithUndo('Add', 0, { traits: [{ name: 'EntityAttributes', data: { name: 'R' } }] }, vi.fn())!;
    expect(last().kind).toBe('!create');
    expect(last().journalPayload).toEqual({ entity: guidOf(rootId), parent: 'root' });
  });

  it('duplicateEntity tags !duplicate with copy + source + parent guids', async () => {
    const { duplicateEntity } = await getModule();
    const p = spawnG('P', 'g-p');
    const src = spawnG('S', 'g-s', p.id());
    const newId = duplicateEntity(src.id(), vi.fn())!;
    expect(last().kind).toBe('!duplicate');
    expect(last().journalPayload).toEqual({ entity: guidOf(newId), source: 'g-s', parent: 'g-p' });
  });

  it('deleteEntityWithUndo tags !delete with the entity guid', async () => {
    const { deleteEntityWithUndo } = await getModule();
    const e = spawnG('D', 'g-d');
    deleteEntityWithUndo(e.id());
    expect(last().kind).toBe('!delete');
    expect(last().journalPayload).toEqual({ entities: ['g-d'] });
  });

  it('deleteEntitiesWithUndo lists every deleted guid', async () => {
    const { deleteEntitiesWithUndo } = await getModule();
    const a = spawnG('A', 'g-a'); const b = spawnG('B', 'g-b');
    deleteEntitiesWithUndo([a.id(), b.id()]);
    expect(last().kind).toBe('!delete');
    expect((last().journalPayload.entities as string[]).slice().sort()).toEqual(['g-a', 'g-b']);
  });

  it('reparentEntity tags !reparent with from/to parent guids (reorder:false on parent change)', async () => {
    const { reparentEntity } = await getModule();
    const oldP = spawnG('OldP', 'g-old');
    const newP = spawnG('NewP', 'g-new');
    const c = spawnG('C', 'g-c', oldP.id());
    reparentEntity(c.id(), newP.id());
    expect(last().kind).toBe('!reparent');
    expect(last().journalPayload).toEqual({ entity: 'g-c', from: 'g-old', to: 'g-new', reorder: false });
  });

  it('a pure reorder (same parent) marks reorder:true with equal from/to', async () => {
    const { reparentEntity } = await getModule();
    const p = spawnG('P', 'g-pp');
    const c = spawnG('C', 'g-cc', p.id());
    reparentEntity(c.id(), p.id(), 50); // same parent, new sortOrder
    expect(last().journalPayload).toEqual({ entity: 'g-cc', from: 'g-pp', to: 'g-pp', reorder: true });
  });
});

describe('addTraitToEntitiesWithUndo', () => {
  it('adds the trait only to entities that lack it, in one undo entry', async () => {
    const { addTraitToEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A');
    const b = spawnEntity('B');
    b.add(Health({ hp: 30 })); // b already has it

    addTraitToEntitiesWithUndo([a.id(), b.id()], healthMeta());
    expect(a.has(Health)).toBe(true);
    expect(b.has(Health)).toBe(true);
    expect(hpOf(b.id())).toBe(30); // existing data untouched (not re-added)
    expect(pushedActions).toHaveLength(1);

    // Undo only removes from the entity that actually received it.
    pushedActions[0].undo();
    expect(a.has(Health)).toBe(false);
    expect(b.has(Health)).toBe(true);
    expect(hpOf(b.id())).toBe(30);
  });

  it('pushes no undo entry when every entity already has the trait', async () => {
    const { addTraitToEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A');
    a.add(Health());
    addTraitToEntitiesWithUndo([a.id()], healthMeta());
    expect(pushedActions).toHaveLength(0);
  });
});

describe('removeTraitFromEntitiesWithUndo', () => {
  it('removes from entities that have it and restores per-entity data on undo', async () => {
    const { removeTraitFromEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A'); a.add(Health({ hp: 50 }));
    const b = spawnEntity('B'); b.add(Health({ hp: 80 }));
    const c = spawnEntity('C'); // no Health

    removeTraitFromEntitiesWithUndo([a.id(), b.id(), c.id()], healthMeta());
    expect(a.has(Health)).toBe(false);
    expect(b.has(Health)).toBe(false);
    expect(c.has(Health)).toBe(false);
    expect(pushedActions).toHaveLength(1);

    // Undo restores each entity's original hp.
    pushedActions[0].undo();
    expect(hpOf(a.id())).toBe(50);
    expect(hpOf(b.id())).toBe(80);
    expect(c.has(Health)).toBe(false); // c never had it
  });

  it('pushes no undo entry when no selected entity has the trait', async () => {
    const { removeTraitFromEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A');
    removeTraitFromEntitiesWithUndo([a.id()], healthMeta());
    expect(pushedActions).toHaveLength(0);
  });
});

describe('pasteTraitValuesWithUndo', () => {
  const healthMetaLocal = () => traitDefs.find(t => t.name === 'Health')! as any;
  const spriteAnimMeta = () => traitDefs.find(t => t.name === 'SpriteAnim')! as any;

  function spawnHealth(name: string, hp: number, guid: string) {
    const e = testWorld.spawn(Health({ hp }), EntityAttributes({ name, guid }));
    entityIndex.set(e.id(), e);
    return e;
  }

  it('writes copied values onto every target as ONE undo entry, and undo restores each', async () => {
    const { pasteTraitValuesWithUndo } = await getModule();
    const a = spawnHealth('A', 10, 'g-a');
    const b = spawnHealth('B', 20, 'g-b');

    pasteTraitValuesWithUndo([a.id(), b.id()], healthMetaLocal(), { hp: 77 });

    expect(a.get(Health)!.hp).toBe(77);
    expect(b.get(Health)!.hp).toBe(77);
    expect(pushedActions).toHaveLength(1);

    await pushedActions[0].undo();
    expect(a.get(Health)!.hp).toBe(10);
    expect(b.get(Health)!.hp).toBe(20);
  });

  it('skips entities that lack the trait', async () => {
    const { pasteTraitValuesWithUndo } = await getModule();
    const withHealth = spawnHealth('A', 10, 'g-a');
    const without = spawnEntity('B');

    pasteTraitValuesWithUndo([withHealth.id(), without.id()], healthMetaLocal(), { hp: 5 });

    expect(withHealth.get(Health)!.hp).toBe(5);
    expect(without.has(Health)).toBe(false);
    expect(pushedActions).toHaveLength(1);
  });

  it('no-ops (no undo entry) when no target carries the trait', async () => {
    const { pasteTraitValuesWithUndo } = await getModule();
    const a = spawnEntity('A');
    pasteTraitValuesWithUndo([a.id()], healthMetaLocal(), { hp: 5 });
    expect(pushedActions).toHaveLength(0);
  });

  it('ignores clipboard keys the target trait no longer declares (schema drift)', async () => {
    const { pasteTraitValuesWithUndo } = await getModule();
    const a = spawnHealth('A', 10, 'g-a');

    pasteTraitValuesWithUndo([a.id()], healthMetaLocal(), { hp: 42, staminaRemovedInV2: 9 });

    expect(a.get(Health)!.hp).toBe(42);
    expect('staminaRemovedInV2' in (a.get(Health)! as any)).toBe(false);
  });

  // The whole reason copy AND paste both clone: readTraitDataFull returns live
  // refs, so a shared object field would otherwise alias across pasted entities.
  it('does not alias an object field across two pasted entities', async () => {
    const { pasteTraitValuesWithUndo } = await getModule();
    const a = testWorld.spawn(SpriteAnim({ clips: {}, clip: '', time: 0, playing: false }), EntityAttributes({ name: 'A', guid: 'g-a' }));
    const b = testWorld.spawn(SpriteAnim({ clips: {}, clip: '', time: 0, playing: false }), EntityAttributes({ name: 'B', guid: 'g-b' }));
    entityIndex.set(a.id(), a); entityIndex.set(b.id(), b);

    const copied = { clips: { roll: { fps: 12 } }, clip: 'roll', time: 0, playing: true };
    pasteTraitValuesWithUndo([a.id(), b.id()], spriteAnimMeta(), copied);

    expect(a.get(SpriteAnim)!.clips).not.toBe(b.get(SpriteAnim)!.clips);
    // Mutating one pasted entity's clips must not touch the other — nor the clipboard.
    (a.get(SpriteAnim)!.clips as any).roll.fps = 60;
    expect((b.get(SpriteAnim)!.clips as any).roll.fps).toBe(12);
    expect(copied.clips.roll.fps).toBe(12);
  });
});

describe('pasteTraitAsNewWithUndo', () => {
  const healthMetaLocal = () => traitDefs.find(t => t.name === 'Health')! as any;

  it('adds the trait with the copied values as ONE undo entry; undo removes it outright', async () => {
    const { pasteTraitAsNewWithUndo } = await getModule();
    const a = spawnEntity('A');
    expect(a.has(Health)).toBe(false);

    pasteTraitAsNewWithUndo([a.id()], healthMetaLocal(), { hp: 33 });

    expect(a.has(Health)).toBe(true);
    expect(a.get(Health)!.hp).toBe(33);
    // One entry — NOT an add + a write. A half-pasted component after Cmd+Z is the bug.
    expect(pushedActions).toHaveLength(1);

    await pushedActions[0].undo();
    expect(a.has(Health)).toBe(false);

    await pushedActions[0].redo();
    expect(a.get(Health)!.hp).toBe(33);
  });

  it('skips entities that already carry the trait (never clobbers existing values)', async () => {
    const { pasteTraitAsNewWithUndo } = await getModule();
    const existing = testWorld.spawn(Health({ hp: 5 }), EntityAttributes({ name: 'A', guid: 'g-a' }));
    entityIndex.set(existing.id(), existing);
    const fresh = spawnEntity('B');

    pasteTraitAsNewWithUndo([existing.id(), fresh.id()], healthMetaLocal(), { hp: 99 });

    expect(existing.get(Health)!.hp).toBe(5);
    expect(fresh.get(Health)!.hp).toBe(99);
  });

  it('no-ops (no undo entry) when every target already has the trait', async () => {
    const { pasteTraitAsNewWithUndo } = await getModule();
    const a = testWorld.spawn(Health({ hp: 5 }), EntityAttributes({ name: 'A', guid: 'g-a' }));
    entityIndex.set(a.id(), a);
    pasteTraitAsNewWithUndo([a.id()], healthMetaLocal(), { hp: 99 });
    expect(pushedActions).toHaveLength(0);
  });

  it('drops keys the trait no longer declares', async () => {
    const { pasteTraitAsNewWithUndo } = await getModule();
    const a = spawnEntity('A');
    pasteTraitAsNewWithUndo([a.id()], healthMetaLocal(), { hp: 7, goneInV2: 1 });
    expect(a.get(Health)!.hp).toBe(7);
    expect('goneInV2' in (a.get(Health)! as any)).toBe(false);
  });
});

describe('addTraitToEntitiesWithUndo — prefilled values (the Paste-As-New path)', () => {
  const healthMetaLocal = () => traitDefs.find(t => t.name === 'Health')! as any;
  const spriteAnimMeta = () => traitDefs.find(t => t.name === 'SpriteAnim')! as any;

  it('adds the trait at defaults when no values are given', async () => {
    const { addTraitToEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A');
    addTraitToEntitiesWithUndo([a.id()], healthMetaLocal());
    expect(a.get(Health)!.hp).toBe(100); // trait default, untouched
    expect(pushedActions[0].label).toBe('Add Health');
  });

  it('prefills the trait from values and uses the caller-supplied label', async () => {
    const { addTraitToEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A');
    addTraitToEntitiesWithUndo([a.id()], healthMetaLocal(), { hp: 33 }, 'Paste Health As New');
    expect(a.get(Health)!.hp).toBe(33);
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Paste Health As New');
  });

  it('pasteTraitAsNewWithUndo delegates here — one action, undo removes the trait', async () => {
    // Guards the collapse of the duplicated action body: paste-as-new must stay ONE
    // undo entry (an add + a separate write would leave a half-pasted component on Cmd+Z).
    const { pasteTraitAsNewWithUndo } = await getModule();
    const a = spawnEntity('A');
    pasteTraitAsNewWithUndo([a.id()], healthMetaLocal(), { hp: 33 });
    expect(pushedActions).toHaveLength(1);
    expect(pushedActions[0].label).toBe('Paste Health As New');
    await pushedActions[0].undo();
    expect(a.has(Health)).toBe(false);
  });

  it('does not alias an object field across two prefilled entities — nor on REDO', async () => {
    const { addTraitToEntitiesWithUndo } = await getModule();
    const a = spawnEntity('A'); const b = spawnEntity('B');
    const values = { clips: { roll: { fps: 12 } }, clip: 'roll', time: 0, playing: true };

    addTraitToEntitiesWithUndo([a.id(), b.id()], spriteAnimMeta(), values, 'Paste SpriteAnim As New');
    expect(a.get(SpriteAnim)!.clips).not.toBe(b.get(SpriteAnim)!.clips);

    // Redo re-seats the trait: it must clone AGAIN, not hand both entities one object.
    await pushedActions[0].undo();
    await pushedActions[0].redo();
    expect(a.get(SpriteAnim)!.clips).not.toBe(b.get(SpriteAnim)!.clips);
    (a.get(SpriteAnim)!.clips as any).roll.fps = 60;
    expect((b.get(SpriteAnim)!.clips as any).roll.fps).toBe(12);
    expect(values.clips.roll.fps).toBe(12); // the caller's object is never seated either
  });

  it('notifies the animation recorder for each prefilled field (Auto-Key parity)', async () => {
    // Paste Values (via the field writer) records; a prefilled add must too, or an armed
    // Auto-Key silently misses every value a pasted component brought with it.
    const { addTraitToEntitiesWithUndo } = await getModule();
    const { setRecordHook } = await import('../../src/editor/animation/recording');
    const seen: Array<[number, string, string, unknown]> = [];
    setRecordHook((id, traitName, field, value) => { seen.push([id, traitName, field, value]); });
    try {
      const a = spawnEntity('A');
      addTraitToEntitiesWithUndo([a.id()], healthMetaLocal(), { hp: 42 }, 'Paste Health As New');
      expect(seen).toEqual([[a.id(), 'Health', 'hp', 42]]);
    } finally { setRecordHook(null); }
  });

  it('does NOT notify the recorder for a plain (defaults-only) add', async () => {
    const { addTraitToEntitiesWithUndo } = await getModule();
    const { setRecordHook } = await import('../../src/editor/animation/recording');
    const seen: unknown[] = [];
    setRecordHook((...args) => { seen.push(args); });
    try {
      addTraitToEntitiesWithUndo([spawnEntity('A').id()], healthMetaLocal());
      expect(seen).toEqual([]); // no values were authored — nothing to key
    } finally { setRecordHook(null); }
  });
});

describe('filterToTraitSchema', () => {
  it('drops keys the trait no longer declares', async () => {
    const { filterToTraitSchema } = await getModule();
    const meta = traitDefs.find(t => t.name === 'Health')! as any;
    expect(filterToTraitSchema(meta, { hp: 1, goneInV2: 2 })).toEqual({ hp: 1 });
  });

  it('passes AoS values through untouched (schema is a function — nothing to filter)', async () => {
    const { filterToTraitSchema } = await getModule();
    const meta = traitDefs.find(t => t.name === 'SpriteAnim')! as any;
    const values = { clips: {}, clip: 'x', anything: 1 };
    expect(filterToTraitSchema(meta, values)).toBe(values);
  });
});
