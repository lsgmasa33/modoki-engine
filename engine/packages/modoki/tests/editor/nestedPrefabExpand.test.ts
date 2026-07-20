/** Nested-prefab instantiation semantics (the hardest invariant to get right).
 *  `instantiatePrefab` expands a `prefab` reference row into its OWN foreign
 *  instance and must:
 *   - set `rootInstanceId` on each member to the ecs id of the INNERMOST instance
 *     root it belongs to (never stomp an inner member's rootInstanceId with the
 *     outer root — the `ownMemberIds` scoping),
 *   - chain `EntityAttributes.parentId` across instance boundaries via ecs ids,
 *   - stamp `parentLocalId` on a nested root with the OUTER row's localId,
 *   - recurse to arbitrary depth (nested-nested),
 *   - not hang on a reference cycle (the `_stack` backstop).
 *  These assert the exact id/parent/root table from the design plan. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0 } },
  { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: 0, parentId: 0, guid: 0, sortOrder: 0 } },
  { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: 0, localId: 0, rootInstanceId: 0, parentLocalId: 0 } },
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
  deleteEntities: vi.fn(),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: vi.fn(),
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getTraitByName: (n: string) => TRAITS.find((t) => t.name === n),
  getAllTraits: () => TRAITS,
}));
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn() }));

// Serve nested prefabs that are NOT pre-cached (for the preload-transitive test).
const fileServer = new Map<string, unknown>(); // guid -> prefab JSON
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'gen-guid',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: (s: string) => typeof s === 'string' && s.includes('-'),
  resolveRef: (g: string) => `/__prefabs__/${g}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));
// @ts-expect-error mock global
global.fetch = vi.fn(async (url: string) => {
  const m = /\/__prefabs__\/(.+)\.json$/.exec(url);
  const guid = m?.[1];
  if (guid && fileServer.has(guid)) return { ok: true, json: async () => fileServer.get(guid) } as Response;
  return { ok: false, json: async () => ({}) } as Response;
});

beforeEach(() => { testWorld = createWorld(); index.clear(); fileServer.clear(); });
const getModule = () => import('../../src/editor/scene/prefab');

// ── Fixtures ───────────────────────────────────────────────────────────
const INNER = 'aaaaaaaa-0000-4000-8000-0000000inner';
const MID = 'aaaaaaaa-0000-4000-8000-00000000mid0';
const TOP = 'aaaaaaaa-0000-4000-8000-00000000top0';

// Inner: root I1 (localId 1) with a child I2 (localId 2, parented to I1).
const innerPrefab = {
  id: INNER, version: 1 as const, name: 'Inner', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'I1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'I1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'I2', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'I2', parentId: 1, guid: '' } } },
  ],
};
// Mid (a.k.a. "Outer" in the 2-level test): M1 root, M2 child, and a nested Inner
// row (localId 3) hung under M2 (localId 2).
const midPrefab = {
  id: MID, version: 2 as const, name: 'Mid', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'M1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'M1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'M2', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'M2', parentId: 1, guid: '' } } },
    { localId: 3, name: 'I1', prefab: INNER, traits: { EntityAttributes: { name: 'I1', parentId: 2, guid: '' } } },
  ],
};
// Top: T1 root with a nested Mid row (localId 2) hung under T1 (localId 1).
const topPrefab = {
  id: TOP, version: 2 as const, name: 'Top', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'T1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'T1', parentId: 0, guid: '' } } },
    { localId: 2, name: 'M1', prefab: MID, traits: { EntityAttributes: { name: 'M1', parentId: 1, guid: '' } } },
  ],
};

function findByName(name: string): number {
  let id = 0;
  testWorld.query(EntityAttributes).updateEach(([ea], e) => { if ((ea as any).name === name) id = e.id(); });
  return id;
}
const piOf = (id: number) => index.get(id).get(PrefabInstance) as Record<string, unknown>;
const eaOf = (id: number) => index.get(id).get(EntityAttributes) as Record<string, unknown>;

describe('instantiatePrefab — 2-level nesting (rootInstanceId / parentId table)', () => {
  it('scopes rootInstanceId to the innermost root and chains parentId by ecs id', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(MID, midPrefab as any);

    const midRoot = instantiatePrefab(midPrefab as any);
    setPrefabSource(midRoot, MID);

    const M1 = findByName('M1'), M2 = findByName('M2'), I1 = findByName('I1'), I2 = findByName('I2');
    expect(midRoot).toBe(M1); // rootLocalId 1 → M1 is the instance root

    // OWN members of the Mid instance carry rootInstanceId === M1, source === MID.
    expect(piOf(M1)).toMatchObject({ source: MID, localId: 1, rootInstanceId: M1 });
    expect(piOf(M2)).toMatchObject({ source: MID, localId: 2, rootInstanceId: M1 });
    // INNER members keep their OWN root (I1) — NOT stomped to M1.
    expect(piOf(I1)).toMatchObject({ source: INNER, localId: 1, rootInstanceId: I1 });
    expect(piOf(I2)).toMatchObject({ source: INNER, localId: 2, rootInstanceId: I1 });

    // parentId chains across the instance boundary via ecs ids.
    expect(eaOf(M1).parentId).toBe(0);   // mid root → scene parent (0)
    expect(eaOf(M2).parentId).toBe(M1);
    expect(eaOf(I1).parentId).toBe(M2);  // nested root hangs under the outer member M2
    expect(eaOf(I2).parentId).toBe(I1);

    // The nested root remembers WHICH outer row produced it (Mid's localId 3).
    expect(piOf(I1).parentLocalId).toBe(3);
  });
});

describe('instantiatePrefab — 3-level nesting (nested-nested)', () => {
  it('expands all three levels with correct per-level roots and a full parent chain', async () => {
    const { instantiatePrefab, setPrefabCache, setPrefabSource } = await getModule();
    setPrefabCache(INNER, innerPrefab as any);
    setPrefabCache(MID, midPrefab as any);
    setPrefabCache(TOP, topPrefab as any);

    const topRoot = instantiatePrefab(topPrefab as any);
    setPrefabSource(topRoot, TOP);

    const T1 = findByName('T1'), M1 = findByName('M1'), M2 = findByName('M2'), I1 = findByName('I1'), I2 = findByName('I2');

    // Exactly one of each — no double-expansion.
    expect(getAllEntitiesImpl()).toHaveLength(5);

    // Three distinct instance roots, each owning only its own level.
    expect(piOf(T1)).toMatchObject({ source: TOP, localId: 1, rootInstanceId: T1 });
    expect(piOf(M1)).toMatchObject({ source: MID, localId: 1, rootInstanceId: M1 });
    expect(piOf(M2)).toMatchObject({ source: MID, localId: 2, rootInstanceId: M1 });
    expect(piOf(I1)).toMatchObject({ source: INNER, localId: 1, rootInstanceId: I1 });
    expect(piOf(I2)).toMatchObject({ source: INNER, localId: 2, rootInstanceId: I1 });

    // Full parent chain T1 → M1 → M2 → I1 → I2 by ecs id.
    expect(eaOf(T1).parentId).toBe(0);
    expect(eaOf(M1).parentId).toBe(T1);
    expect(eaOf(M2).parentId).toBe(M1);
    expect(eaOf(I1).parentId).toBe(M2);
    expect(eaOf(I2).parentId).toBe(I1);

    // parentLocalId points each nested root at its producing outer row.
    expect(piOf(M1).parentLocalId).toBe(2); // Top's nested row localId
    expect(piOf(I1).parentLocalId).toBe(3); // Mid's nested row localId
  });
});

describe('preloadNestedPrefabs — transitive fetch into the cache', () => {
  it('fetches grandchildren so a later sync instantiate finds every level cached', async () => {
    const { preloadNestedPrefabs, getCachedPrefabSync, instantiatePrefab, setPrefabCache } = await getModule();
    // prefabCache is a module singleton — evict any entries a prior test cached.
    setPrefabCache(MID, null); setPrefabCache(INNER, null);
    // Only TOP is cached; MID + INNER must be fetched transitively.
    setPrefabCache(TOP, topPrefab as any);
    fileServer.set(MID, midPrefab);
    fileServer.set(INNER, innerPrefab);
    expect(getCachedPrefabSync(MID)).toBeNull();
    expect(getCachedPrefabSync(INNER)).toBeNull();

    await preloadNestedPrefabs(topPrefab as any);

    expect(getCachedPrefabSync(MID)).not.toBeNull();
    expect(getCachedPrefabSync(INNER)).not.toBeNull();
    // The sync instantiate now succeeds end to end (all five entities).
    instantiatePrefab(topPrefab as any);
    expect(getAllEntitiesImpl()).toHaveLength(5);
  });
});

describe('instantiatePrefab — reference-cycle backstop', () => {
  it('aborts a self-nesting prefab without hanging or stack-overflowing', async () => {
    const { instantiatePrefab, setPrefabCache } = await getModule();
    const SELF = 'aaaaaaaa-0000-4000-8000-0000000self0';
    // A prefab whose only child references ITSELF.
    const selfPrefab = {
      id: SELF, version: 2 as const, name: 'Self', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'S1', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'S1', parentId: 0, guid: '' } } },
        { localId: 2, name: 'S2', prefab: SELF, traits: { EntityAttributes: { name: 'S2', parentId: 1, guid: '' } } },
      ],
    };
    setPrefabCache(SELF, selfPrefab as any);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    const root = instantiatePrefab(selfPrefab as any); // must return, not hang
    // The outer level still spawns its own member; the recursive self-expansion is
    // refused by the `_stack` guard (logged), so no infinite tree.
    expect(root).toBe(findByName('S1'));
    expect(getAllEntitiesImpl().length).toBeLessThanOrEqual(2);
    warn.mockRestore();
  });
});
