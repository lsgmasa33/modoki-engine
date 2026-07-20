/** entityUtils unit tests — findEntity, getEntityTraits, readTraitData, writeTraitField,
 *  getAllEntities, buildEntityTree, deleteEntity.
 *
 *  Uses real koota world + traits with mocked world module to inject the test world. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

// Real traits matching modoki runtime
const Transform = trait({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
});

const EntityAttributes = trait({
  name: '' as string,
  isActive: true as boolean,
  sortOrder: 0,
  parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui',
});

const TestTag = trait();

// Renderable traits — only their PRESENCE matters for layer derivation (F8).
const Renderable3D = trait({ mesh: '' as string, isVisible: true as boolean });
const Renderable2D = trait({ sprite: '' as string, isVisible: true as boolean });
const UIElement = trait({ text: '' as string });
const Light = trait({ kind: '' as string });

// AoS (callback-form) trait with non-scalar live keys NOT declared in meta.fields —
// mirrors AnimationLibrary (animSets/boneMaps). Exercises readTraitDataFull's live-key
// fallback (the bone-map-lost-on-save fix).
const Library = trait(() => ({
  animSets: [] as string[],
  retarget: false as boolean,
  boneMaps: {} as Record<string, Record<string, string>>,
}));

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();

// Mock world module
vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  registerEntity: (entity: any) => entityIndex.set(entity.id(), entity),
  unregisterEntity: (entity: any) => entityIndex.delete(entity.id()),
  setStructureCallback: vi.fn(),
}));

// Mock trait registry
vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    {
      name: 'Transform', trait: Transform, category: 'component',
      fields: {
        x: { type: 'number', step: 0.1 }, y: { type: 'number', step: 0.1 }, z: { type: 'number', step: 0.1 },
        rx: { type: 'number', step: 0.1 }, ry: { type: 'number', step: 0.1 }, rz: { type: 'number', step: 0.1 },
        sx: { type: 'number', step: 0.1 }, sy: { type: 'number', step: 0.1 }, sz: { type: 'number', step: 0.1 },
      },
    },
    {
      name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
      fields: {
        name: { type: 'string' }, isActive: { type: 'boolean' },
        sortOrder: { type: 'number' }, parentId: { type: 'number' },
        layer: { type: 'string' },
      },
    },
    {
      name: 'TestTag', trait: TestTag, category: 'tag', fields: {},
    },
    {
      // Only `retarget` is a curated Inspector field; animSets/boneMaps are AoS-only.
      name: 'Library', trait: Library, category: 'component',
      fields: { retarget: { type: 'boolean' } },
    },
    { name: 'Renderable3D', trait: Renderable3D, category: 'component', fields: {} },
    { name: 'Renderable2D', trait: Renderable2D, category: 'component', fields: {} },
    { name: 'UIElement', trait: UIElement, category: 'component', fields: {} },
    { name: 'Light', trait: Light, category: 'component', fields: {} },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find(t => t.name === name),
    transformName: (n: string) => n,
  };
});

beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
});

afterEach(() => {
  testWorld.destroy();
});

async function getUtils() {
  return import('../../src/runtime/ecs/entityUtils');
}

describe('findEntity', () => {
  it('finds entity by ID via index', async () => {
    const { findEntity } = await getUtils();
    const entity = testWorld.spawn(
      Transform({ x: 5 }),
      EntityAttributes({ name: 'Hero' }),
    );
    entityIndex.set(entity.id(), entity);

    const found = findEntity(entity.id());
    expect(found).toBe(entity);
  });

  it('returns null for non-existent entity', async () => {
    const { findEntity } = await getUtils();
    expect(findEntity(99999)).toBeNull();
  });
});

describe('getEntityTraits', () => {
  it('returns all registered traits on an entity', async () => {
    const { getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(
      Transform({ x: 1 }),
      EntityAttributes({ name: 'Test' }),
    );
    entityIndex.set(entity.id(), entity);

    const traits = getEntityTraits(entity.id());
    const names = traits.map(t => t.name);
    expect(names).toContain('Transform');
    expect(names).toContain('EntityAttributes');
  });

  it('includes tag traits', async () => {
    const { getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'Tagged' }),
    );
    entity.add(TestTag);
    entityIndex.set(entity.id(), entity);

    const traits = getEntityTraits(entity.id());
    const names = traits.map(t => t.name);
    expect(names).toContain('TestTag');
  });

  it('returns empty array for non-existent entity', async () => {
    const { getEntityTraits } = await getUtils();
    expect(getEntityTraits(99999)).toEqual([]);
  });
});

describe('readTraitData', () => {
  it('reads field values from a component trait', async () => {
    const { readTraitData, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(
      Transform({ x: 7, y: 8, z: 9 }),
      EntityAttributes({ name: 'Data' }),
    );
    entityIndex.set(entity.id(), entity);

    const traits = getEntityTraits(entity.id());
    const tfMeta = traits.find(t => t.name === 'Transform')!;
    const data = readTraitData(entity.id(), tfMeta);
    expect(data).toBeDefined();
    expect(data!.x).toBe(7);
    expect(data!.y).toBe(8);
    expect(data!.z).toBe(9);
  });

  it('returns empty object for tag traits', async () => {
    const { readTraitData, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'Tagged' }),
    );
    entity.add(TestTag);
    entityIndex.set(entity.id(), entity);

    const traits = getEntityTraits(entity.id());
    const tagMeta = traits.find(t => t.name === 'TestTag')!;
    const data = readTraitData(entity.id(), tagMeta);
    expect(data).toEqual({});
  });

  it('returns null for non-existent entity', async () => {
    const { readTraitData } = await getUtils();
    const meta = { name: 'Transform', trait: Transform, category: 'component' as const, fields: {} };
    expect(readTraitData(99999, meta as any)).toBeNull();
  });

  it('returns null when entity does not have the trait', async () => {
    const { readTraitData } = await getUtils();
    const entity = testWorld.spawn(
      EntityAttributes({ name: 'NoTransform' }),
    );
    entityIndex.set(entity.id(), entity);
    const meta = { name: 'Transform', trait: Transform, category: 'component' as const, fields: {} };
    expect(readTraitData(entity.id(), meta as any)).toBeNull();
  });

  // ── AoS non-scalar live keys (the bone-map-lost-on-save bug) ──
  it('readTraitData DROPS an AoS field absent from meta.fields (animSets/boneMaps)', async () => {
    const { readTraitData, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(EntityAttributes({ name: 'Rig' }), Library({ retarget: true, animSets: ['s1'], boneMaps: { s1: { joint0: 'bone0' } } }));
    entityIndex.set(entity.id(), entity);
    const meta = getEntityTraits(entity.id()).find(t => t.name === 'Library')!;
    const data = readTraitData(entity.id(), meta);
    expect(data).toEqual({ retarget: true });        // only the curated field — animSets/boneMaps gone
  });

  it('readTraitDataFull keeps an AoS trait\'s non-scalar live keys', async () => {
    const { readTraitDataFull, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(EntityAttributes({ name: 'Rig' }), Library({ retarget: true, animSets: ['s1'], boneMaps: { s1: { joint0: 'bone0' } } }));
    entityIndex.set(entity.id(), entity);
    const meta = getEntityTraits(entity.id()).find(t => t.name === 'Library')!;
    const data = readTraitDataFull(entity.id(), meta)!;
    expect(data.retarget).toBe(true);
    expect(data.animSets).toEqual(['s1']);
    expect(data.boneMaps).toEqual({ s1: { joint0: 'bone0' } });
  });

  it('readTraitDataFull still returns every field of a SoA trait', async () => {
    const { readTraitDataFull, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(Transform({ x: 1, sy: 3 }), EntityAttributes({ name: 'S' }));
    entityIndex.set(entity.id(), entity);
    const meta = getEntityTraits(entity.id()).find(t => t.name === 'Transform')!;
    const data = readTraitDataFull(entity.id(), meta)!;
    expect(data.x).toBe(1);
    expect(data.sy).toBe(3);
    expect(Object.keys(data).sort()).toEqual(['rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'x', 'y', 'z']);
  });
});

describe('writeTraitField', () => {
  it('writes a field value to a component trait', async () => {
    const { writeTraitField, readTraitData, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(
      Transform({ x: 0 }),
      EntityAttributes({ name: 'Writable' }),
    );
    entityIndex.set(entity.id(), entity);

    const traits = getEntityTraits(entity.id());
    const tfMeta = traits.find(t => t.name === 'Transform')!;
    writeTraitField(entity.id(), tfMeta, 'x', 42);

    const data = readTraitData(entity.id(), tfMeta);
    expect(data!.x).toBe(42);
  });

  it('adds tag trait when value is truthy', async () => {
    const { writeTraitField } = await getUtils();
    const entity = testWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'NoTag' }),
    );
    entityIndex.set(entity.id(), entity);

    const tagMeta = { name: 'TestTag', trait: TestTag, category: 'tag' as const, fields: {} };
    writeTraitField(entity.id(), tagMeta as any, '', true);

    expect(entity.has(TestTag)).toBe(true);
  });

  it('removes tag trait when value is falsy', async () => {
    const { writeTraitField } = await getUtils();
    const entity = testWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'HasTag' }),
    );
    entity.add(TestTag);
    entityIndex.set(entity.id(), entity);

    const tagMeta = { name: 'TestTag', trait: TestTag, category: 'tag' as const, fields: {} };
    writeTraitField(entity.id(), tagMeta as any, '', false);

    expect(entity.has(TestTag)).toBe(false);
  });
});

describe('getAllEntities', () => {
  it('returns all entities with EntityAttributes', async () => {
    const { getAllEntities } = await getUtils();
    testWorld.spawn(Transform(), EntityAttributes({ name: 'A' }));
    testWorld.spawn(Transform(), EntityAttributes({ name: 'B' }));
    testWorld.spawn(Transform(), EntityAttributes({ name: 'C' }));

    const all = getAllEntities();
    const names = all.map(e => e.name);
    expect(names).toContain('A');
    expect(names).toContain('B');
    expect(names).toContain('C');
  });

  it('reads parentId and sortOrder from EntityAttributes', async () => {
    const { getAllEntities } = await getUtils();
    const parent = testWorld.spawn(Transform(), EntityAttributes({ name: 'Parent', parentId: 0, sortOrder: 10 }));
    testWorld.spawn(Transform(), EntityAttributes({ name: 'Child', parentId: parent.id(), sortOrder: 5 }));

    const all = getAllEntities();
    const child = all.find(e => e.name === 'Child')!;
    expect(child.parentId).toBe(parent.id());
    expect(child.sortOrder).toBe(5);
  });

  it('uses EntityAttributes.name when set', async () => {
    const { getAllEntities } = await getUtils();
    testWorld.spawn(Transform(), EntityAttributes({ name: 'ExplicitName' }));

    const all = getAllEntities();
    expect(all.find(e => e.name === 'ExplicitName')).toBeDefined();
  });

  it('falls back to "Entity {id}" when no name available', async () => {
    const { getAllEntities } = await getUtils();
    const entity = testWorld.spawn(Transform(), EntityAttributes({ name: '' }));

    const all = getAllEntities();
    const found = all.find(e => e.id === entity.id())!;
    expect(found.name).toBe(`Entity ${entity.id()}`);
  });

  it('includes trait names in entity info', async () => {
    const { getAllEntities } = await getUtils();
    const entity = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'Test' }));
    entity.add(TestTag);

    const all = getAllEntities();
    const found = all.find(e => e.id === entity.id())!;
    expect(found.traits).toContain('Transform');
    expect(found.traits).toContain('EntityAttributes');
    expect(found.traits).toContain('TestTag');
  });
});

describe('subtreeIds', () => {
  // The F-key focus walks ECS parent links because the THREE graph is FLAT: renderables
  // are added to the scene root with baked world transforms, so an entity's children are
  // not its object's children. A mesh-less group's geometry lives entirely in its subtree.
  const flat = [
    { id: 1, name: 'Island', traits: [], parentId: 0, sortOrder: 0 },
    { id: 2, name: 'Boat', traits: [], parentId: 1, sortOrder: 0 },
    { id: 3, name: 'Oar', traits: [], parentId: 2, sortOrder: 0 },
    { id: 4, name: 'Palm', traits: [], parentId: 1, sortOrder: 0 },
    { id: 9, name: 'Elsewhere', traits: [], parentId: 0, sortOrder: 0 },
  ];

  it('returns the root plus every descendant, at any depth', async () => {
    const { subtreeIds } = await getUtils();
    expect(new Set(subtreeIds(flat as any, 1))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('starts with the root itself', async () => {
    const { subtreeIds } = await getUtils();
    expect(subtreeIds(flat as any, 1)[0]).toBe(1);
  });

  it('excludes siblings and unrelated roots', async () => {
    const { subtreeIds } = await getUtils();
    expect(subtreeIds(flat as any, 2)).toEqual([2, 3]);
    expect(subtreeIds(flat as any, 9)).toEqual([9]);
  });

  it('a leaf is its own subtree', async () => {
    const { subtreeIds } = await getUtils();
    expect(subtreeIds(flat as any, 3)).toEqual([3]);
  });

  it('an unknown id has no subtree', async () => {
    const { subtreeIds } = await getUtils();
    expect(subtreeIds(flat as any, 404)).toEqual([]);
  });
});

describe('buildEntityTree', () => {
  it('builds flat list into tree structure', async () => {
    const { buildEntityTree } = await getUtils();
    const entities = [
      { id: 1, name: 'Root', traits: [], parentId: 0, sortOrder: 0 },
      { id: 2, name: 'Child', traits: [], parentId: 1, sortOrder: 0 },
    ];

    const tree = buildEntityTree(entities as any);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].id).toBe(2);
  });

  it('returns empty array for empty input', async () => {
    const { buildEntityTree } = await getUtils();
    expect(buildEntityTree([])).toEqual([]);
  });

  it('sorts by sortOrder then by id', async () => {
    const { buildEntityTree } = await getUtils();
    const entities = [
      { id: 3, name: 'C', traits: [], parentId: 0, sortOrder: 0 },
      { id: 1, name: 'A', traits: [], parentId: 0, sortOrder: 0 },
      { id: 2, name: 'B', traits: [], parentId: 0, sortOrder: 0 },
    ];

    const tree = buildEntityTree(entities as any);
    expect(tree.map(e => e.id)).toEqual([1, 2, 3]);
  });
});

describe('writeTraitField — field preservation', () => {
  it('preserves other fields when writing one field', async () => {
    const { writeTraitField, readTraitData, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(
      Transform({ x: 1, y: 2, z: 3 }),
      EntityAttributes({ name: 'Multi' }),
    );
    entityIndex.set(entity.id(), entity);

    const traits = getEntityTraits(entity.id());
    const tfMeta = traits.find(t => t.name === 'Transform')!;
    writeTraitField(entity.id(), tfMeta, 'x', 99);

    const data = readTraitData(entity.id(), tfMeta);
    expect(data!.x).toBe(99);
    expect(data!.y).toBe(2);
    expect(data!.z).toBe(3);
  });
});

describe('deleteEntities', () => {
  it('bulk deletes multiple entities in one call', async () => {
    const { deleteEntities } = await getUtils();
    const a = testWorld.spawn(Transform(), EntityAttributes({ name: 'A', parentId: 0 }));
    const b = testWorld.spawn(Transform(), EntityAttributes({ name: 'B', parentId: 0 }));
    const c = testWorld.spawn(Transform(), EntityAttributes({ name: 'C', parentId: 0 }));
    entityIndex.set(a.id(), a);
    entityIndex.set(b.id(), b);
    entityIndex.set(c.id(), c);

    deleteEntities([a.id(), b.id()]);

    expect(entityIndex.has(a.id())).toBe(false);
    expect(entityIndex.has(b.id())).toBe(false);
    expect(entityIndex.has(c.id())).toBe(true);
  });

  it('deletes children of all specified entities', async () => {
    const { deleteEntities } = await getUtils();
    const p1 = testWorld.spawn(Transform(), EntityAttributes({ name: 'P1', parentId: 0 }));
    const c1 = testWorld.spawn(Transform(), EntityAttributes({ name: 'C1', parentId: p1.id() }));
    const p2 = testWorld.spawn(Transform(), EntityAttributes({ name: 'P2', parentId: 0 }));
    const c2 = testWorld.spawn(Transform(), EntityAttributes({ name: 'C2', parentId: p2.id() }));
    entityIndex.set(p1.id(), p1);
    entityIndex.set(c1.id(), c1);
    entityIndex.set(p2.id(), p2);
    entityIndex.set(c2.id(), c2);

    deleteEntities([p1.id(), p2.id()]);

    expect(entityIndex.has(p1.id())).toBe(false);
    expect(entityIndex.has(c1.id())).toBe(false);
    expect(entityIndex.has(p2.id())).toBe(false);
    expect(entityIndex.has(c2.id())).toBe(false);
  });

  it('handles empty array gracefully', async () => {
    const { deleteEntities } = await getUtils();
    expect(() => deleteEntities([])).not.toThrow();
  });
});

describe('deleteEntity', () => {
  it('deletes entity and its children', async () => {
    const { deleteEntity } = await getUtils();
    const parent = testWorld.spawn(Transform(), EntityAttributes({ name: 'Parent', parentId: 0 }));
    const child = testWorld.spawn(Transform(), EntityAttributes({ name: 'Child', parentId: parent.id() }));
    entityIndex.set(parent.id(), parent);
    entityIndex.set(child.id(), child);

    deleteEntity(parent.id());

    // Both should be removed from index
    expect(entityIndex.has(parent.id())).toBe(false);
    expect(entityIndex.has(child.id())).toBe(false);
  });

  it('preserves siblings when deleting one child', async () => {
    const { deleteEntity } = await getUtils();
    const parent = testWorld.spawn(Transform(), EntityAttributes({ name: 'Parent', parentId: 0 }));
    const child1 = testWorld.spawn(Transform(), EntityAttributes({ name: 'Child1', parentId: parent.id() }));
    const child2 = testWorld.spawn(Transform(), EntityAttributes({ name: 'Child2', parentId: parent.id() }));
    entityIndex.set(parent.id(), parent);
    entityIndex.set(child1.id(), child1);
    entityIndex.set(child2.id(), child2);

    deleteEntity(child1.id());

    expect(entityIndex.has(child1.id())).toBe(false);
    expect(entityIndex.has(parent.id())).toBe(true);
    expect(entityIndex.has(child2.id())).toBe(true);
  });

  it('handles non-existent entity gracefully', async () => {
    const { deleteEntity } = await getUtils();
    expect(() => deleteEntity(99999)).not.toThrow();
  });
});

describe('writeTraitField — structure dirty for EntityAttributes (Hierarchy sync)', () => {
  it('bumps structure version when EntityAttributes.name changes', async () => {
    const { writeTraitField, getStructureVersion, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(Transform(), EntityAttributes({ name: 'Old' }));
    entityIndex.set(entity.id(), entity);

    const attrMeta = getEntityTraits(entity.id()).find(t => t.name === 'EntityAttributes')!;
    const before = getStructureVersion();
    writeTraitField(entity.id(), attrMeta, 'name', 'New');
    expect(getStructureVersion()).toBe(before + 1);
  });

  it('notifies onStructureDirty subscribers when the name changes (so Hierarchy refreshes)', async () => {
    const { writeTraitField, onStructureDirty, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(Transform(), EntityAttributes({ name: 'Old' }));
    entityIndex.set(entity.id(), entity);

    let notified = 0;
    const unsub = onStructureDirty(() => { notified++; });
    const attrMeta = getEntityTraits(entity.id()).find(t => t.name === 'EntityAttributes')!;
    writeTraitField(entity.id(), attrMeta, 'name', 'Renamed');
    unsub();
    expect(notified).toBe(1);
  });

  it('bumps structure version for layer/parentId/sortOrder changes too', async () => {
    const { writeTraitField, getStructureVersion, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(Transform(), EntityAttributes({ name: 'E' }));
    entityIndex.set(entity.id(), entity);
    const attrMeta = getEntityTraits(entity.id()).find(t => t.name === 'EntityAttributes')!;

    for (const [field, value] of [['layer', 'ui'], ['parentId', 5], ['sortOrder', 3]] as const) {
      const before = getStructureVersion();
      writeTraitField(entity.id(), attrMeta, field, value);
      expect(getStructureVersion()).toBe(before + 1);
    }
  });

  it('does NOT bump structure version for non-structural EntityAttributes fields (isActive)', async () => {
    const { writeTraitField, getStructureVersion, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(Transform(), EntityAttributes({ name: 'E' }));
    entityIndex.set(entity.id(), entity);
    const attrMeta = getEntityTraits(entity.id()).find(t => t.name === 'EntityAttributes')!;

    const before = getStructureVersion();
    writeTraitField(entity.id(), attrMeta, 'isActive', false);
    expect(getStructureVersion()).toBe(before);
  });

  it('does NOT bump structure version for non-EntityAttributes traits (Transform)', async () => {
    const { writeTraitField, getStructureVersion, getEntityTraits } = await getUtils();
    const entity = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'E' }));
    entityIndex.set(entity.id(), entity);
    const tfMeta = getEntityTraits(entity.id()).find(t => t.name === 'Transform')!;

    const before = getStructureVersion();
    writeTraitField(entity.id(), tfMeta, 'x', 42);
    expect(getStructureVersion()).toBe(before);
  });
});

describe('getStructureVersion (regression for M3)', () => {
  it('starts at zero and bumps on each markStructureDirty', async () => {
    const { markStructureDirty, getStructureVersion } = await getUtils();
    const start = getStructureVersion();
    markStructureDirty();
    expect(getStructureVersion()).toBe(start + 1);
    markStructureDirty();
    markStructureDirty();
    expect(getStructureVersion()).toBe(start + 3);
  });

  it('bumps after deleteEntity (since it calls markStructureDirty internally)', async () => {
    const { deleteEntity, getStructureVersion } = await getUtils();
    const entity = testWorld.spawn(Transform(), EntityAttributes({ name: 'Doomed' }));
    entityIndex.set(entity.id(), entity);
    const before = getStructureVersion();
    deleteEntity(entity.id());
    expect(getStructureVersion()).toBeGreaterThan(before);
  });

  it('notifies subscribers AND bumps version (subscribers should observe new version)', async () => {
    const { onStructureDirty, markStructureDirty, getStructureVersion } = await getUtils();
    let seenVersion = -1;
    const unsub = onStructureDirty(() => { seenVersion = getStructureVersion(); });
    const start = getStructureVersion();
    markStructureDirty();
    expect(seenVersion).toBe(start + 1);
    unsub();
  });
});

describe('getTrait / setTrait (typed, direct component access)', () => {
  it('getTrait reads the live trait data; null when absent', async () => {
    const { getTrait } = await getUtils();
    const entity = testWorld.spawn(Transform({ x: 5, y: 2 }), EntityAttributes({ name: 'A' }));
    entityIndex.set(entity.id(), entity);
    expect(getTrait(entity.id(), Transform)).toMatchObject({ x: 5, y: 2 });
    // Entity lacks Camera-like trait → null; missing entity → null.
    expect(getTrait(99999, Transform)).toBeNull();
  });

  it('setTrait merges a partial (other fields untouched) and writes', async () => {
    const { setTrait, getTrait } = await getUtils();
    const entity = testWorld.spawn(Transform({ x: 5, y: 2, z: 9 }), EntityAttributes({ name: 'A' }));
    entityIndex.set(entity.id(), entity);
    setTrait(entity.id(), Transform, { x: 42 });
    const t = getTrait(entity.id(), Transform)!;
    expect(t.x).toBe(42);   // changed
    expect(t.y).toBe(2);    // untouched
    expect(t.z).toBe(9);    // untouched
  });

  it('setTrait fires the dirty signal (so editor/UI refresh)', async () => {
    const { setTrait, addDirtyListener } = await getUtils();
    const entity = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'A' }));
    entityIndex.set(entity.id(), entity);
    let dirtied = 0;
    const unsub = addDirtyListener(() => { dirtied++; });
    setTrait(entity.id(), Transform, { x: 1 });
    expect(dirtied).toBeGreaterThan(0);
    unsub();
  });

  it('setTrait no-ops on a missing entity / absent trait', async () => {
    const { setTrait } = await getUtils();
    expect(() => setTrait(99999, Transform, { x: 1 })).not.toThrow();
  });
});

describe('deriveLayer (F8 — reconcile stored layer against the present renderable trait)', () => {
  it('maps each primary renderable trait to its layer regardless of stored value', async () => {
    const { deriveLayer } = await getUtils();
    expect(deriveLayer(['Transform', 'Renderable3D'], '')).toBe('3d');
    expect(deriveLayer(['Transform', 'Renderable3DPrimitive'], '')).toBe('3d');
    expect(deriveLayer(['Transform', 'Renderable2D'], '')).toBe('2d');
    expect(deriveLayer(['Transform', 'Text3D'], '')).toBe('3d');
    expect(deriveLayer(['Transform', 'Text2D'], '')).toBe('2d');
    expect(deriveLayer(['UIElement', 'RenderableUI'], '')).toBe('ui');
    expect(deriveLayer(['RenderableUI'], '')).toBe('ui');
  });

  it('the present renderable trait WINS over a drifted stored layer', async () => {
    const { deriveLayer } = await getUtils();
    // A Renderable2D entity stuck at '3d', a Renderable3DPrimitive stuck at '' — both reconciled.
    expect(deriveLayer(['Renderable2D'], '3d')).toBe('2d');
    expect(deriveLayer(['Renderable3DPrimitive'], '')).toBe('3d');
  });

  it('falls back to the stored layer when no primary renderable trait is present', async () => {
    const { deriveLayer } = await getUtils();
    // Light / HDR / ModelSource / group nodes have no unambiguous primary renderer.
    expect(deriveLayer(['Light'], '3d')).toBe('3d');
    expect(deriveLayer(['Transform'], '')).toBe('');
    expect(deriveLayer([], 'ui')).toBe('ui');
  });
});

describe('getAllEntities — layer reconciliation (F8)', () => {
  it('derives layer from the renderable trait, overriding a drifted stored layer', async () => {
    const { getAllEntities } = await getUtils();
    // Stored '3d' but actually a 2D renderable → reconciled to '2d'.
    const drifted = testWorld.spawn(Renderable2D(), EntityAttributes({ name: 'Drifted', layer: '3d' }));
    // No stored layer but a 3D renderable → derived '3d'.
    const blank3d = testWorld.spawn(Renderable3D(), EntityAttributes({ name: 'Blank3D', layer: '' }));
    // UI element → 'ui'.
    const ui = testWorld.spawn(UIElement(), EntityAttributes({ name: 'Panel', layer: 'ui' }));
    // Light with stored '3d' and no primary renderable → keeps '3d'.
    const light = testWorld.spawn(Light(), EntityAttributes({ name: 'Sun', layer: '3d' }));
    // Group node with no renderable, blank layer → stays undefined.
    const group = testWorld.spawn(Transform(), EntityAttributes({ name: 'Group', layer: '' }));

    const all = getAllEntities();
    expect(all.find(e => e.id === drifted.id())!.layer).toBe('2d');
    expect(all.find(e => e.id === blank3d.id())!.layer).toBe('3d');
    expect(all.find(e => e.id === ui.id())!.layer).toBe('ui');
    expect(all.find(e => e.id === light.id())!.layer).toBe('3d');
    expect(all.find(e => e.id === group.id())!.layer).toBeUndefined();
  });
});
