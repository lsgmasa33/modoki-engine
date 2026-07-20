/** Nested prefab serialize + round-trip (editor). A prefab edited in isolation
 *  that CONTAINS a child prefab instance must serialize the child as a single
 *  reference row (child GUID + diffs) — its members must NOT leak into the flat
 *  output — and an instantiate→serialize round-trip must be stable. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0 } },
] as const;

let testWorld: ReturnType<typeof createWorld>;
const index = new Map<number, any>();

const traitNamesOf = (e: any) => TRAITS.filter((t) => e.has(t.trait)).map((t) => t.name);

function getAllEntitiesImpl() {
  const out: { id: number; name: string; parentId: number; sortOrder: number; traits: string[] }[] = [];
  testWorld.query(EntityAttributes).updateEach(([ea], e) => {
    const d = ea as Record<string, unknown>;
    out.push({ id: e.id(), name: d.name as string, parentId: d.parentId as number, sortOrder: (d.sortOrder as number) ?? 0, traits: traitNamesOf(e) });
  });
  return out;
}

function readTraitDataImpl(id: number, meta: any) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return null;
  if (meta.category === 'tag') return {};
  const data = e.get(meta.trait);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta.fields)) out[k] = data[k];
  return out;
}

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  unregisterEntity: (e: any) => index.delete(e.id()),
}));

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  deleteEntities: (ids: number[]) => { for (const id of ids) { index.get(id)?.destroy(); index.delete(id); } },
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: vi.fn(),
}));

vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); index.clear(); });

const getModule = () => import('../../src/editor/scene/prefab');

const INNER = 'aaaaaaaa-0000-4000-8000-00000000inner'.replace('inner', '0001');
const OUTER = 'aaaaaaaa-0000-4000-8000-00000000outer'.replace('outer', '0002');

// Inner: root 'Hull' with a child 'Bolt'. The reference row keeps the root name
// ('Hull'); only the CHILD ('Bolt') must never leak into the flat output.
const innerPrefab = {
  id: INNER, version: 1 as const, name: 'Inner', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Hull', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Hull', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Bolt', traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Bolt', parentId: 1, guid: '' } } },
  ],
};
// Outer contains O1(root), O2 child, and a nested Inner instance under O2.
const outerPrefab = {
  id: OUTER, version: 2 as const, name: 'Outer', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'O1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'O2', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'O2', parentId: 1, guid: '' } } },
    { localId: 3, name: 'Hull', prefab: INNER, traits: { EntityAttributes: { name: 'Hull', parentId: 2, guid: '' } } },
  ],
};

describe('serializePrefab — nested prefabs', () => {
  it('writes a nested instance as ONE reference row; inner members do not leak', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, serializePrefab } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);

    const outerRoot = instantiatePrefab(outerPrefab as any);
    setPrefabSource(outerRoot, OUTER);

    const out = serializePrefab(outerRoot, OUTER)!;
    expect(out).not.toBeNull();
    expect(out.version).toBe(2);
    // O1 + O2 + one nested-ref row (named after the inner root 'Hull') = 3.
    // The inner CHILD 'Bolt' must be gone (it expands from the child file).
    expect(out.entities).toHaveLength(3);
    expect(out.entities.some((e) => e.name === 'Bolt')).toBe(false);
    expect(out.entities.filter((e) => e.prefab)).toHaveLength(1);

    const ref = out.entities.find((e) => e.prefab)!;
    expect(ref.prefab).toBe(INNER);
    expect(ref.name).toBe('Hull');
    // Its parentId localId points at O2's localId in the flat output.
    const o2 = out.entities.find((e) => e.name === 'O2')!;
    expect((ref.traits.EntityAttributes as Record<string, unknown>).parentId).toBe(o2.localId);
    // Pristine instance ⇒ no overrides / structure noise.
    expect(ref.overrides).toBeUndefined();
    expect(ref.added).toBeUndefined();
  });

  it('round-trips: instantiate the serialized prefab and re-serialize identically', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource, serializePrefab } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(OUTER, outerPrefab as any);

    const root1 = instantiatePrefab(outerPrefab as any);
    setPrefabSource(root1, OUTER);
    const out1 = serializePrefab(root1, OUTER)!;

    // Re-seed cache with the serialized outer + re-instantiate into a fresh world.
    testWorld = createWorld(); index.clear();
    setPrefabCache(OUTER, out1 as any);
    const root2 = instantiatePrefab(out1 as any);
    setPrefabSource(root2, OUTER);
    const out2 = serializePrefab(root2, OUTER)!;

    expect(out2.entities).toHaveLength(out1.entities.length);
    const ref1 = out1.entities.find((e) => e.prefab);
    const ref2 = out2.entities.find((e) => e.prefab);
    expect(ref2?.prefab).toBe(ref1?.prefab);
    // The inner child still doesn't leak after a round-trip.
    expect(out2.entities.some((e) => e.name === 'Bolt')).toBe(false);
    expect(out2.entities.filter((e) => e.prefab)).toHaveLength(1);
  });
});

describe('Create-Prefab-on-a-child then save outer → nested reference (regression)', () => {
  // Reproduces the user-reported bug: "Create Prefab" on an entity inside a
  // prefab-edit session must cache the new prefab by its GUID (PrefabInstance.source
  // is GUID-only), so saving the OUTER prefab references it instead of flattening.
  it('serializes the just-created child prefab as a reference row, not flattened', async () => {
    const mani = await import('../../src/runtime/loaders/assetManifest');
    const { serializePrefab, setPrefabCache, tagEntityTreeAsInstance } = await getModule();

    // Live edit world: a plain "Ship" root with a plain "Flame" child.
    const ship = testWorld.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Ship', parentId: 0, guid: 'g-ship' }));
    index.set(ship.id(), ship);
    const flame = testWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'Flame', parentId: ship.id(), guid: 'g-flame' }));
    index.set(flame.id(), flame);

    // --- Create Prefab on the Flame (mirrors Hierarchy.handleCreatePrefab) ---
    const childPrefab = serializePrefab(flame.id())!;
    expect(childPrefab.id).toBeTruthy();
    const savePath = '/games/x/assets/prefabs/Flame.prefab.json';
    mani.registerAsset(childPrefab.id!, savePath, 'prefab');
    setPrefabCache(childPrefab.id!, childPrefab);   // THE FIX: cache by GUID, not path
    tagEntityTreeAsInstance(flame.id(), savePath);  // Flame becomes an instance (source = GUID)

    // --- Now save the OUTER prefab (the Ship) ---
    const out = serializePrefab(ship.id(), 'g-ship-prefab')!;
    expect(out.version).toBe(2);
    const ref = out.entities.find((e) => e.prefab);
    expect(ref, 'Flame should be a nested reference row, not flattened').toBeTruthy();
    expect(ref!.prefab).toBe(childPrefab.id);
    // Flattening would have written the Flame's Transform inline on a second row.
    expect(out.entities.filter((e) => e.name === 'Flame')).toHaveLength(1);
    expect(ref!.traits.Transform).toBeUndefined(); // ref row carries only EntityAttributes
  });
});

describe('wouldCreateCycle — reference-cycle guard', () => {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'aaaaaaaa-0000-4000-8000-00000000000b';
  const C = 'aaaaaaaa-0000-4000-8000-00000000000c';

  it('detects self and transitive A→B→A cycles, allows acyclic nesting', async () => {
    const { setPrefabCache, wouldCreateCycle } = await getModule();
    // A nests B, B nests A (cycle); C nests nothing.
    setPrefabCache(A, { id: A, version: 2, name: 'A', rootLocalId: 1, entities: [{ localId: 1, name: 'A', traits: {} }, { localId: 2, name: 'B', prefab: B, traits: {} }] } as any);
    setPrefabCache(B, { id: B, version: 2, name: 'B', rootLocalId: 1, entities: [{ localId: 1, name: 'B', traits: {} }, { localId: 2, name: 'A', prefab: A, traits: {} }] } as any);
    setPrefabCache(C, { id: C, version: 1, name: 'C', rootLocalId: 1, entities: [{ localId: 1, name: 'C', traits: {} }] } as any);

    expect(wouldCreateCycle(A, A)).toBe(true);  // self
    expect(wouldCreateCycle(A, B)).toBe(true);  // nesting B in A → B transitively contains A
    expect(wouldCreateCycle(A, C)).toBe(false); // C contains nothing
    expect(wouldCreateCycle(C, A)).toBe(false); // A does not contain C
  });
});
