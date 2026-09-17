/** The editor prefab cache is read SYNCHRONOUSLY by code that walks the LIVE tree, and
 *  a miss is treated as "not a prefab" (#1284).
 *
 *  The state these tests put the world in is the NORMAL one, not an edge case: an
 *  ordinary scene load fills the RUNTIME cache and leaves this one empty, so every live
 *  nested instance is cold until something happens to fetch it. That is why the
 *  pre-existing nested-serialize tests never caught this — every one of them calls
 *  `setPrefabCache` by hand first, so they only ever exercise the warm path.
 *
 *  ⚠️ `serializePrefab` flattening a cold child is DELIBERATE and stays: it is sync and
 *  has nothing else it can do. The defect was that nothing warmed the cache before it.
 *  So the contract under test is the WARMER's, and the first test here pins the
 *  degraded branch precisely so the second one is known to be testing a real difference
 *  rather than two spellings of the same pass. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string, sortOrder: 0 });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });

const TRAITS = [
  { name: 'Transform', trait: Transform, category: 'component', fields: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 } },
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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { index.delete(e.id()); e.destroy(); },
  findEntityByGuid: () => undefined,
  indexEntityGuid: vi.fn(),
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => getAllEntitiesImpl(),
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  subtreeIds: (id: number) => [id],
  deleteEntities: (ids: number[]) => { for (const id of ids) { index.get(id)?.destroy(); index.delete(id); } },
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  readTraitDataFull: (id: number, meta: any) => {
    const e: any = index.get(id);
    if (!e || !e.has(meta.trait)) return null;
    if (meta.category === 'tag') return {};
    const data = e.get(meta.trait);
    const schema = (meta.trait as { schema?: unknown }).schema;
    const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = data[k];
    return out;
  },
  writeTraitField: vi.fn(),
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({ invalidatePrefab: vi.fn(), replaceCachedPrefab: vi.fn() }));

/** The manifest seam `getPrefabSource` resolves through. Deliberately NOT stubbed out to
 *  return the prefab directly — the warmer's whole job is to perform this fetch, so a
 *  mock that skipped it would make the tests pass with the warmer deleted. */
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'g-minted',
  registerAsset: vi.fn(),
  getGuidForPath: () => undefined,
  isGuid: () => true,
  resolveRef: (ref: string) => `/assets/${ref}.prefab.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));

const INNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const MID = 'aaaaaaaa-0000-4000-8000-000000000002';
/** A source the mock fetch 404s — never negative-cached, so it re-fetches unless deduped. */
const MISSING = 'aaaaaaaa-0000-4000-8000-00000000dead';

/** Inner: root 'Hull' with a child 'Bolt'. Both must vanish from the outer's flat rows
 *  once the child is referenced rather than flattened. */
const innerPrefab = {
  id: INNER, version: 2 as const, name: 'Inner', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Hull', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Hull', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Bolt', traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Bolt', parentId: 1, guid: '' } } },
  ],
};

/** MID holds a nested row of INNER, so a live MID instance is two prefabs deep. */
const midPrefab = {
  id: MID, version: 2 as const, name: 'Mid', rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Arm', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Arm', parentId: 0, guid: '' } } },
    { localId: 2, name: 'Hull', prefab: INNER, traits: { EntityAttributes: { name: 'Hull', parentId: 1, guid: '' } } },
  ],
};

let fetches: string[] = [];
const mockFetch = vi.fn(async (url: string) => {
  fetches.push(String(url));
  if (String(url).includes(INNER)) {
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(innerPrefab)) } as any;
  }
  if (String(url).includes(MID)) {
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(midPrefab)) } as any;
  }
  return { ok: false, status: 404, json: async () => ({}) } as any;
});

beforeEach(() => {
  testWorld = createWorld();
  index.clear();
  fetches = [];
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

const getModule = () => import('../../src/editor/scene/prefab');

/** Build the observed shape: a plain entity holding a live instance of INNER, with the
 *  editor cache COLD — exactly what an ordinary scene load leaves behind (the loader
 *  fills the runtime cache, not this one). The instance is spawned through the real
 *  `instantiatePrefab` so its members carry real `rootInstanceId`/`parentLocalId`
 *  bookkeeping, then the cache entry is evicted to reproduce the cold state. */
async function coldWorldHoldingOneInstance() {
  const mod = await getModule();
  const holder = testWorld.spawn(Transform, EntityAttributes({ name: 'Swim Zone', parentId: 0, guid: 'holder-guid' }));
  index.set(holder.id(), holder);

  mod.setPrefabCache(INNER, innerPrefab as any);
  const innerRoot = mod.instantiatePrefab(innerPrefab as any, holder.id());
  expect(innerRoot, 'the fixture must actually spawn the nested instance').toBeGreaterThan(0);
  mod.setPrefabSource(innerRoot, INNER);

  mod.setPrefabCache(INNER, null);   // ← the scene-load state
  expect(mod.getCachedPrefabSync(INNER), 'fixture must start COLD or it tests nothing').toBeNull();
  return { mod, holderId: holder.id(), innerRoot };
}

describe('serializePrefab over a COLD cache — the degraded branch this fix exists to prevent', () => {
  it('flattens the held nested instance into copies, with no prefab row at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mod, holderId } = await coldWorldHoldingOneInstance();

    const out = mod.serializePrefab(holderId)!;

    expect(out.entities.some((e) => e.prefab), 'a cold read must produce NO reference row').toBe(false);
    expect(out.entities.map((e) => e.name)).toEqual(['Swim Zone', 'Hull', 'Bolt']);
    expect(warn.mock.calls.flat().join(' ')).toContain('flattening instead of referencing');
    warn.mockRestore();
  });
});

describe('preloadNestedPrefabsForSubtree — the warmer (#1284)', () => {
  it('fetches the live subtree\'s instance sources, so serialize writes a REFERENCE row', async () => {
    const { mod, holderId } = await coldWorldHoldingOneInstance();

    await mod.preloadNestedPrefabsForSubtree(holderId);

    expect(fetches.some((u) => u.includes(INNER)), 'the warmer must actually go to the manifest').toBe(true);
    const out = mod.serializePrefab(holderId)!;
    const ref = out.entities.find((e) => e.prefab);
    expect(ref?.prefab, 'the nested instance must survive as a reference to its child prefab').toBe(INNER);
    expect(out.entities.map((e) => e.name), 'the child\'s members must NOT leak in as copies').toEqual(['Swim Zone', 'Hull']);
  });

  it('warms a source the prefab FILE does not mention — the user-added case the file walk misses', async () => {
    const { mod, holderId, innerRoot } = await coldWorldHoldingOneInstance();

    // `preloadNestedPrefabs` walks prefab.entities[].prefab. A live instance that is not a
    // row of any file is invisible to it, which is the gap at captureNestedRef /
    // captureNestedInstanceOverrides. An empty file must therefore warm NOTHING...
    await mod.preloadNestedPrefabs({ id: 'g-outer', version: 2, name: 'Outer', rootLocalId: 1, entities: [] } as any);
    expect(mod.getCachedPrefabSync(INNER), 'the file walk cannot see a live-only source').toBeNull();

    // ...while the live walk finds it from the same world.
    await mod.preloadNestedPrefabsForSubtree(holderId);
    expect(mod.getCachedPrefabSync(INNER), 'the live walk must reach it').not.toBeNull();
    expect(innerRoot).toBeGreaterThan(0);
  });

  it('is a SUPERSET of the serialized rows — it warms the selection root too', async () => {
    const { mod, innerRoot } = await coldWorldHoldingOneInstance();

    // planPrefabRows never collapses the selection root, so serializing FROM the instance
    // root needs no reference row — but the warmer still fetches it. Over-warming costs a
    // cached fetch; under-warming is the bug, so this asymmetry is deliberate and pinned.
    await mod.preloadNestedPrefabsForSubtree(innerRoot);
    expect(mod.getCachedPrefabSync(INNER)).not.toBeNull();
  });

  /** ⚠️ The dedupe has to be measured on a source whose fetch FAILS, and the reason is the
   *  whole point of the test. `getPrefabSource` short-circuits on `prefabCache.has(source)`,
   *  so with a source that loads, the second instance is already served from the cache and
   *  the fetch count is 1 whether or not `seen` exists — the assertion would be measuring
   *  someone else's mechanism. A 404 is never negative-cached (`if (prefab) prefabCache.set`),
   *  so it is the one input where `seen` is the only thing standing between two live
   *  instances and two network round-trips. Found by close-out review; the first version of
   *  this test passed with the dedupe deleted. */
  it('fetches an UNLOADABLE source once, not once per instance holding it', async () => {
    const { mod, holderId } = await coldWorldHoldingOneInstance();
    // Spawned WITH the trait: setPrefabSource only rewrites entities that already carry
    // PrefabInstance with a matching rootInstanceId, so on a plain entity it is a silent no-op.
    const hold = (name: string, guid: string) => {
      const e = testWorld.spawn(Transform, EntityAttributes({ name, parentId: holderId, guid }),
        PrefabInstance({ source: MISSING, localId: 1, rootInstanceId: 0, parentLocalId: 0 }));
      e.set(PrefabInstance, { source: MISSING, localId: 1, rootInstanceId: e.id(), parentLocalId: 0 });
      index.set(e.id(), e);
      return e;
    };
    hold('A', 'a'); hold('B', 'b');
    fetches = [];

    await mod.preloadNestedPrefabsForSubtree(holderId);

    expect(mod.getCachedPrefabSync(MISSING), 'a failed fetch must not be cached').toBeNull();
    expect(fetches.filter((u) => u.includes(MISSING)).length,
      'without the `seen` set this is 2 — nothing else dedupes an unloadable source').toBe(1);
  });
});

describe('preloadNestedPrefabsForSubtree — depth', () => {
  /** A prefab two levels deep. `collectTree` is a full descendant walk and
   *  `instantiatePrefab` makes every nested root its own `PrefabInstance`, so the inner
   *  instance is its OWN entry in the live walk rather than something reached by
   *  recursing through MID's file. This test is what pins that claim — without it, a
   *  warmer that stopped at the subtree's direct children would look correct. */
  it('warms a prefab nested two levels down', async () => {
    const mod = await getModule();
    const holder = testWorld.spawn(Transform, EntityAttributes({ name: 'Holder', parentId: 0, guid: 'h' }));
    index.set(holder.id(), holder);

    mod.setPrefabCache(INNER, innerPrefab as any);
    mod.setPrefabCache(MID, midPrefab as any);
    const midRoot = mod.instantiatePrefab(midPrefab as any, holder.id());
    mod.setPrefabSource(midRoot, MID);
    mod.setPrefabCache(INNER, null);
    mod.setPrefabCache(MID, null);

    await mod.preloadNestedPrefabsForSubtree(holder.id());

    expect(mod.getCachedPrefabSync(MID), 'depth 1').not.toBeNull();
    expect(mod.getCachedPrefabSync(INNER), 'depth 2').not.toBeNull();
  });
});
