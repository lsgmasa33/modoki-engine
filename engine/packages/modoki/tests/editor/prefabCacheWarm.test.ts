/** #1295 — the editor prefab cache is filled by the scene swap and by an instantiate, so the
 *  sync readers that walk the live tree are never cold.
 *
 *  Two mechanisms, and the tests exist to pin the DIFFERENCE between them and the naive
 *  versions that look identical from outside:
 *   - the swap warm must take what the loader already parsed, NOT re-fetch it;
 *   - an instantiate must cache under the key the instance ends up CARRYING (the guid that
 *     `setPrefabSource` resolves), not under the path the file was fetched by. Caching under
 *     the path is what the three raw-fetch entry points effectively did, and it left every
 *     mid-session instance invisible. */

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

function readTraitDataImpl(id: number, meta: any) {
  const e = index.get(id);
  if (!e || !e.has(meta.trait)) return null;
  const data = e.get(meta.trait);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta.fields)) out[k] = data[k];
  return out;
}

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => index.set(e.id(), e),
  spawnEntity: (world: any, ...t: any[]) => { const e = world.spawn(...t); index.set(e.id(), e); return e; },
  unregisterEntity: (e: any) => index.delete(e.id()),
  destroyEntity: (e: any) => { index.delete(e.id()); e.destroy(); },
  findEntityByGuid: () => undefined,
  indexEntityGuid: vi.fn(),
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  getAllEntities: () => {
    const out: any[] = [];
    testWorld.query(EntityAttributes).updateEach(([ea], e) => {
      const d = ea as Record<string, unknown>;
      out.push({ id: e.id(), name: d.name, parentId: d.parentId, sortOrder: 0, traits: traitNamesOf(e) });
    });
    return out;
  },
  findEntity: (id: number) => index.get(id),
  markStructureDirty: vi.fn(),
  subtreeIds: (id: number) => [id],
  deleteEntities: vi.fn(),
  readTraitData: (id: number, meta: any) => readTraitDataImpl(id, meta),
  readTraitDataFull: (id: number, meta: any) => readTraitDataImpl(id, meta),
  writeTraitField: vi.fn(),
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getTraitByName: (name: string) => TRAITS.find((t) => t.name === name),
  getAllTraits: () => TRAITS,
}));

/** The runtime cache the swap warm is supposed to take from, and the invalidation the
 *  read-side seed must NOT trigger. */
const runtimeCache = new Map<string, unknown>();
const invalidateSpy = vi.fn();
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  invalidatePrefab: (...a: unknown[]) => invalidateSpy(...a),
  getCachedPrefab: (ref: string) => runtimeCache.get(ref),
}));

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: { registerBeforeSwap: vi.fn(), unregisterBeforeSwap: vi.fn() },
}));

const PATH = '/assets/prefabs/fish.prefab.json';
const GUID = 'aaaaaaaa-0000-4000-8000-000000000001';

vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  newGuid: () => 'g-minted',
  registerAsset: vi.fn(),
  // The manifest resolves the PATH to a GUID — which is why setPrefabSource stores the guid,
  // and why caching under the path alone left the instance unreachable.
  getGuidForPath: (p: string) => (p === PATH ? GUID : undefined),
  isGuid: (r: string) => r === GUID,
  resolveRef: (r: string) => `/resolved/${r}.json`,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({ assetUrl: (p: string) => p }));

const prefabFile = {
  id: GUID, version: 2 as const, name: 'Fish', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Fish', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Fish', parentId: 0, guid: '' } } }],
};

let fetches: string[] = [];
const mockFetch = vi.fn(async (url: string) => {
  fetches.push(String(url));
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(prefabFile)) } as any;
});

beforeEach(() => {
  testWorld = createWorld(); index.clear(); runtimeCache.clear(); fetches = [];
  invalidateSpy.mockClear(); mockFetch.mockClear();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

const mod = () => import('../../src/editor/scene/prefab');
const warm = () => import('../../src/editor/scene/prefabCacheWarm');

/** A staging world holding one instance of GUID, with the editor cache cold. */
function stagingWorldWithInstance(source = GUID) {
  const w = createWorld();
  const e = w.spawn(Transform, EntityAttributes({ name: 'Fish', parentId: 0, guid: 'x' }),
    PrefabInstance({ source, localId: 1, rootInstanceId: 0, parentLocalId: 0 }));
  e.set(PrefabInstance, { source, localId: 1, rootInstanceId: e.id(), parentLocalId: 0 });
  return w;
}

describe('warmEditorPrefabCacheFor — the scene swap', () => {
  it('takes the loader\'s already-parsed object instead of re-fetching it', async () => {
    const { getCachedPrefabSync, setPrefabCache } = await mod();
    setPrefabCache(GUID, null);
    runtimeCache.set(GUID, prefabFile);

    await (await warm()).warmEditorPrefabCacheFor(stagingWorldWithInstance());

    expect(fetches, 'the loader already read these bytes — re-reading them is the cost this avoids').toEqual([]);
    expect(getCachedPrefabSync(GUID), 'same object, not a copy').toBe(prefabFile);
  });

  it('falls back to a fetch for a source the runtime cache cannot key', async () => {
    const { getCachedPrefabSync, setPrefabCache } = await mod();
    setPrefabCache(GUID, null);
    // runtimeCache deliberately empty — a raw asset path on an instance whose scene was never saved.

    await (await warm()).warmEditorPrefabCacheFor(stagingWorldWithInstance());

    expect(fetches.length, 'nothing else can supply it').toBe(1);
    expect(getCachedPrefabSync(GUID)).not.toBeNull();
  });

  it('does not re-seed a source already in the editor cache', async () => {
    const { setPrefabCache } = await mod();
    setPrefabCache(GUID, prefabFile as any);
    runtimeCache.set(GUID, { ...prefabFile, name: 'SHOULD NOT WIN' });
    invalidateSpy.mockClear();

    await (await warm()).warmEditorPrefabCacheFor(stagingWorldWithInstance());

    const { getCachedPrefabSync } = await mod();
    expect(getCachedPrefabSync(GUID)!.name).toBe('Fish');
  });

  /** ⚠️ The read-side seed must not call setPrefabCache, which invalidates the RUNTIME cache.
   *  Doing so would discard, once per prefab on every swap, exactly the entries the loader just
   *  acquired — turning a free map copy into a guaranteed re-fetch on the next scene. */
  it('does NOT invalidate the runtime cache it just read from', async () => {
    const { setPrefabCache } = await mod();
    setPrefabCache(GUID, null);
    runtimeCache.set(GUID, prefabFile);
    invalidateSpy.mockClear();

    await (await warm()).warmEditorPrefabCacheFor(stagingWorldWithInstance());

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('instantiatePrefabInstance — cache keyed by what the INSTANCE carries', () => {
  it('caches under the resolved GUID, not the path it was fetched by', async () => {
    const m = await mod();
    m.setPrefabCache(GUID, null);
    m.setPrefabCache(PATH, null);

    const rootId = await m.instantiatePrefabInstance(prefabFile as any, PATH);

    expect(rootId).toBeGreaterThan(0);
    const piMeta = TRAITS.find((t) => t.name === 'PrefabInstance')!;
    expect(readTraitDataImpl(rootId, piMeta)!.source,
      'setPrefabSource resolves the path to the guid — that is the key readers will use').toBe(GUID);
    expect(m.getCachedPrefabSync(GUID),
      'caching under the PATH alone is what left every mid-session instance invisible').not.toBeNull();
  });
});
