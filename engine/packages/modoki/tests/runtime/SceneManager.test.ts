/** SceneManager integration tests — scene-to-scene swap, shared resource dedup,
 *  cancel-and-replace concurrency, persistent entity transfer.
 *
 *  Mocks fetch() (scene JSON + resource files) and GLTFLoader. Mocks the world
 *  registry's worldSwap listeners are real — we observe entity-id changes after
 *  the swap to confirm the new world is active. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

// ── Test traits ──────────────────────────────────────────────────────────

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });
const Renderable3D = trait({ mesh: '', material: '', isVisible: true });
const PlayerProfile = trait({ score: 0, level: 1 });

// ── GLTFLoader mock (for acquireMesh transitive model load) ─────────────

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(path: string, onLoad: (gltf: any) => void) {
      const scene = {
        position: { set: () => {} },
        rotation: { set: () => {} },
        scale: { setScalar: () => {} },
        updateMatrixWorld: () => {},
        traverse: (cb: (child: any) => void) => {
          cb({
            isMesh: true,
            name: `mesh_${path.split('/').pop()}`,
            geometry: { uuid: `geo-${path}`, dispose: () => {} },
            material: { uuid: `mat-${path}`, dispose: () => {} },
            position: { set: () => {} },
            rotation: { set: () => {} },
            scale: { set: () => {} },
            removeFromParent: () => {},
          });
        },
      };
      onLoad({ scene });
    }
  },
}));

// ── Mock the trait registry to expose our test traits ──────────────────

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number' }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Renderable3D', trait: Renderable3D, category: 'component', fields: { mesh: { type: 'string' }, material: { type: 'string' }, isVisible: { type: 'boolean' } } },
    { name: 'PlayerProfile', trait: PlayerProfile, category: 'component', fields: { score: { type: 'number' }, level: { type: 'number' } } },
    { name: 'Persistent', trait: null as any, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find(t => t.name === name),
  };
});

// ── Mock fetch() for scene JSON + .mat.json + .mesh.json ───────────────

let fetchCalls: Record<string, number> = {};
const fetchResponses: Record<string, unknown> = {};

// ── GUID ↔ path map ──
// Asset references are GUID-only now: a scene's resources[].path and every
// entity material ref is a GUID resolved through the manifest to a path, which
// is the cache/refcount key. So refs (resources[].path, Renderable3D.material)
// use GUIDs; stats assertions stay keyed by the resolved material PATH. The
// scene file paths ('/sceneA.json' etc.) are passed directly to loadScene and
// stay as paths — loadScene fetches by path; only nested asset refs are GUIDs.
const MAT_GUIDS: Record<string, string> = {
  '/materials/m1.mat.json': '20000000-0000-4000-8000-000000000001',
  '/materials/m2.mat.json': '20000000-0000-4000-8000-000000000002',
  '/materials/m3.mat.json': '20000000-0000-4000-8000-000000000003',
  '/materials/m4.mat.json': '20000000-0000-4000-8000-000000000004',
  '/materials/m5.mat.json': '20000000-0000-4000-8000-000000000005',
};
const M = (path: string) => MAT_GUIDS[path];

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  fetchCalls[url] = (fetchCalls[url] || 0) + 1;
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) {
      return { ok: true, json: async () => body } as Response;
    }
  }
  return { ok: false, status: 404, json: async () => ({}) } as Response;
});

// ── Test fixtures ──────────────────────────────────────────────────────

function defineSceneA() {
  fetchResponses['/sceneA.json'] = {
    version: 6,
    resources: [
      { type: 'material', path: M('/materials/m1.mat.json') },
      { type: 'material', path: M('/materials/m2.mat.json') },
      { type: 'material', path: M('/materials/m3.mat.json') },
    ],
    entities: [
      { id: 100, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'A1', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/m1.mat.json') } } },
      { id: 101, traits: { Transform: { x: 2 }, EntityAttributes: { name: 'A2', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/m2.mat.json') } } },
      { id: 102, traits: { Transform: { x: 3 }, EntityAttributes: { name: 'A3', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/m3.mat.json') } } },
    ],
  };
}

function defineSceneB_sharedM2() {
  // Scene B reuses m2 from scene A, adds m4 + m5
  fetchResponses['/sceneB.json'] = {
    version: 6,
    resources: [
      { type: 'material', path: M('/materials/m4.mat.json') },
      { type: 'material', path: M('/materials/m5.mat.json') },
      { type: 'material', path: M('/materials/m2.mat.json') }, // shared
    ],
    entities: [
      { id: 200, traits: { Transform: { x: 10 }, EntityAttributes: { name: 'B1', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/m4.mat.json') } } },
      { id: 201, traits: { Transform: { x: 11 }, EntityAttributes: { name: 'B2', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/m5.mat.json') } } },
      { id: 202, traits: { Transform: { x: 12 }, EntityAttributes: { name: 'B3', parentId: 0 }, Renderable3D: { mesh: '', material: M('/materials/m2.mat.json') } } },
    ],
  };
}

function defineMaterials() {
  fetchResponses['/materials/m1.mat.json'] = { color: 0xff0000 };
  fetchResponses['/materials/m2.mat.json'] = { color: 0x00ff00 };
  fetchResponses['/materials/m3.mat.json'] = { color: 0x0000ff };
  fetchResponses['/materials/m4.mat.json'] = { color: 0xffff00 };
  fetchResponses['/materials/m5.mat.json'] = { color: 0xff00ff };
}

beforeEach(async () => {
  vi.resetModules();
  fetchCalls = {};
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  defineMaterials();

  // Patch the Persistent trait into our trait registry mock so it matches the
  // real Persistent trait that SceneManager imports
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/ecs/traitRegistry');
  const persistentMeta = getAllTraits().find((m: any) => m.name === 'Persistent');
  if (persistentMeta) (persistentMeta as any).trait = Persistent;

  // Register material GUIDs → paths on the fresh module graph (resetModules
  // wipes the manifest). SceneManager resolves resources[].path / material refs
  // through this same manifest instance, so registration must happen post-reset.
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  for (const [path, guid] of Object.entries(MAT_GUIDS)) {
    manifest.registerAsset(guid, path, 'material');
  }
});

async function getSceneManager() {
  const mod = await import('../../src/runtime/scene/SceneManager');
  mod.sceneManager.resetForTesting();
  return mod;
}

async function getCache() {
  return import('../../src/runtime/loaders/meshTemplateCache');
}

async function getWorld() {
  return import('../../src/runtime/ecs/world');
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SceneManager — basic load', () => {
  it('loads a scene and makes it the current one', async () => {
    defineSceneA();
    const { sceneManager } = await getSceneManager();

    expect(sceneManager.getCurrent()).toBeNull();
    await sceneManager.loadScene('/sceneA.json');

    const current = sceneManager.getCurrent();
    expect(current).not.toBeNull();
    expect(current!.path).toBe('/sceneA.json');
    expect(current!.state).toBe('active');
  });

  it('loads from opts.preloaded without fetching the scene path', async () => {
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    const preloaded = {
      version: 8,
      resources: [],
      entities: [
        { id: 1, traits: { Transform: { x: 9 }, EntityAttributes: { name: 'Pre', parentId: 0 } } },
      ],
    };
    await sceneManager.loadScene('/never-fetched.json', { preloaded: preloaded as any });

    expect(sceneManager.getCurrent()!.path).toBe('/never-fetched.json');
    expect(fetchCalls['/never-fetched.json']).toBeUndefined(); // scene path not fetched

    let count = 0;
    getCurrentWorld().query(EntityAttributes).updateEach(() => { count++; });
    expect(count).toBe(1);
  });

  it('treats opts.preloaded as read-only — does NOT mutate the caller-owned object (F3)', async () => {
    const { sceneManager } = await getSceneManager();
    // The dev-server / agent-bridge caller reuses this parsed object for
    // validate-then-load; loadScene must not silently rewrite its resources/version.
    const preloaded = {
      version: 6,
      resources: [] as string[],
      entities: [
        { id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Pre', parentId: 0 } } },
      ],
    };
    const resourcesRef = preloaded.resources; // same array identity must survive

    await sceneManager.loadScene('/never-fetched.json', { preloaded: preloaded as any });

    // loadScene fills `data.resources` with the full transitive walk + bumps version,
    // but only on its OWN shallow clone — the caller's object is untouched.
    expect(preloaded.resources).toBe(resourcesRef); // not reassigned
    expect(preloaded.resources).toEqual([]);        // not appended-to
    expect(preloaded.version).toBe(6);              // not bumped
  });

  it('after load, the current world contains the scene entities', async () => {
    defineSceneA();
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/sceneA.json');

    let count = 0;
    getCurrentWorld().query(EntityAttributes).updateEach(() => { count++; });
    expect(count).toBe(3);
  });

  it('acquires every resource in the manifest', async () => {
    defineSceneA();
    const { sceneManager } = await getSceneManager();
    const { getResourceStats } = await getCache();

    await sceneManager.loadScene('/sceneA.json');
    const stats = getResourceStats();
    expect(stats.materials['/materials/m1.mat.json']).toBe(1);
    expect(stats.materials['/materials/m2.mat.json']).toBe(1);
    expect(stats.materials['/materials/m3.mat.json']).toBe(1);
  });
});

describe('SceneManager — A,B,C → D,E,B shared resource', () => {
  it('does not refetch the shared material on swap', async () => {
    defineSceneA();
    defineSceneB_sharedM2();
    const { sceneManager } = await getSceneManager();

    await sceneManager.loadScene('/sceneA.json');
    expect(fetchCalls['/materials/m1.mat.json']).toBe(1);
    expect(fetchCalls['/materials/m2.mat.json']).toBe(1);
    expect(fetchCalls['/materials/m3.mat.json']).toBe(1);

    await sceneManager.loadScene('/sceneB.json');
    // Shared m2 should NOT be refetched
    expect(fetchCalls['/materials/m2.mat.json']).toBe(1);
    // m4, m5 fetched fresh
    expect(fetchCalls['/materials/m4.mat.json']).toBe(1);
    expect(fetchCalls['/materials/m5.mat.json']).toBe(1);
  });

  it('after swap, scene A entities are gone and scene B entities exist', async () => {
    defineSceneA();
    defineSceneB_sharedM2();
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/sceneA.json');
    await sceneManager.loadScene('/sceneB.json');

    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([attr]: any[]) => {
      names.push((attr as any).name as string);
    });
    expect(names.sort()).toEqual(['B1', 'B2', 'B3']);
  });

  it('drops scene-A-only materials but keeps the shared one', async () => {
    defineSceneA();
    defineSceneB_sharedM2();
    const { sceneManager } = await getSceneManager();
    const { getResourceStats } = await getCache();

    await sceneManager.loadScene('/sceneA.json');
    await sceneManager.loadScene('/sceneB.json');

    const stats = getResourceStats();
    // Scene A's exclusive materials are gone
    expect(stats.materials['/materials/m1.mat.json']).toBeUndefined();
    expect(stats.materials['/materials/m3.mat.json']).toBeUndefined();
    // Shared m2 is still held — by scene B now
    expect(stats.materials['/materials/m2.mat.json']).toBe(1);
    // Scene B's exclusive materials — only scene B holds them
    expect(stats.materials['/materials/m4.mat.json']).toBe(1);
    expect(stats.materials['/materials/m5.mat.json']).toBe(1);
  });
});

describe('SceneManager — concurrent loads (cancel-and-replace)', () => {
  it('aborting an in-flight load releases its resources', async () => {
    defineSceneA();
    defineSceneB_sharedM2();
    const { sceneManager } = await getSceneManager();
    const { getResourceStats } = await getCache();

    // Start loading A but immediately replace with B
    const aPromise = sceneManager.loadScene('/sceneA.json');
    const bPromise = sceneManager.loadScene('/sceneB.json');

    // A's promise should reject (aborted); B's should resolve
    await expect(aPromise).rejects.toThrow();
    await expect(bPromise).resolves.toBeUndefined();

    // Final state: only scene B's resources
    const stats = getResourceStats();
    expect(sceneManager.getCurrent()!.path).toBe('/sceneB.json');
    expect(stats.materials['/materials/m1.mat.json']).toBeUndefined();
    expect(stats.materials['/materials/m4.mat.json']).toBeDefined();
  });
});

describe('SceneManager — persistent entities', () => {
  it('persistent root entity survives a scene swap', async () => {
    defineSceneA();
    defineSceneB_sharedM2();
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/sceneA.json');

    // Spawn a persistent entity in mainWorld
    const mainWorld = getCurrentWorld();
    const player = mainWorld.spawn(
      Transform({ x: 999, y: 999, z: 0 }),
      EntityAttributes({ name: 'Player', parentId: 0 }),
      PlayerProfile({ score: 42, level: 7 }),
    );
    const { markPersistent } = await import('../../src/runtime/traits/Persistent');
    markPersistent(player, 'test-guid-player');

    // Verify it's there
    let foundBefore = 0;
    mainWorld.query(PlayerProfile).updateEach(([p]: any[]) => {
      foundBefore++;
      expect((p as any).score).toBe(42);
    });
    expect(foundBefore).toBe(1);

    // Swap to scene B
    await sceneManager.loadScene('/sceneB.json');

    // The persistent entity should have been transferred to the new world
    const newWorld = getCurrentWorld();
    let foundAfter = 0;
    let preservedScore = 0;
    let preservedName = '';
    newWorld.query(PlayerProfile).updateEach(([p]: any[], entity: { id(): number }) => {
      foundAfter++;
      preservedScore = (p as any).score;
      // Cross-check name from EntityAttributes
      if (entity.has(EntityAttributes)) {
        preservedName = (entity.get(EntityAttributes) as any).name;
      }
    });
    expect(foundAfter).toBe(1);
    expect(preservedScore).toBe(42);
    expect(preservedName).toBe('Player');
  });

  it('shadows a scene root by matching guid (no duplicate)', async () => {
    // Define a scene whose root carries the same Persistent guid as our runtime entity
    fetchResponses['/sceneWithDuplicate.json'] = {
      version: 6,
      resources: [],
      entities: [
        // The scene file's "Player" with matching guid — should be excluded
        { id: 50, traits: {
          Transform: { x: 0 },
          EntityAttributes: { name: 'Player', parentId: 0 },
          PlayerProfile: { score: 0, level: 1 },
          Persistent: { guid: 'test-guid-player' },
        } },
        // An unrelated entity that should still be loaded
        { id: 51, traits: {
          Transform: { x: 5 },
          EntityAttributes: { name: 'Tree', parentId: 0 },
        } },
      ],
    };

    const { sceneManager } = await getSceneManager();
    const { markPersistent } = await import('../../src/runtime/traits/Persistent');
    const { getCurrentWorld } = await getWorld();

    // Set up an initial scene + a persistent Player with score 99
    defineSceneA();
    await sceneManager.loadScene('/sceneA.json');
    const player = getCurrentWorld().spawn(
      Transform({ x: 999 }),
      EntityAttributes({ name: 'Player', parentId: 0 }),
      PlayerProfile({ score: 99, level: 5 }),
    );
    markPersistent(player, 'test-guid-player');

    // Load the scene that also has a Player with matching guid
    await sceneManager.loadScene('/sceneWithDuplicate.json');

    // After swap: only ONE Player (the persistent one) and one Tree
    const newWorld = getCurrentWorld();
    let playerCount = 0;
    let preservedScore = -1;
    newWorld.query(PlayerProfile).updateEach(([p]: any[]) => {
      playerCount++;
      preservedScore = (p as any).score;
    });
    expect(playerCount).toBe(1);
    expect(preservedScore).toBe(99); // persistent value, not the scene's 0

    // Tree should still be present
    let treeCount = 0;
    newWorld.query(EntityAttributes).updateEach(([attr]: any[]) => {
      if ((attr as any).name === 'Tree') treeCount++;
    });
    expect(treeCount).toBe(1);
  });

  it('persistent entity child tree survives the swap', async () => {
    defineSceneA();
    defineSceneB_sharedM2();
    const { sceneManager } = await getSceneManager();
    const { markPersistent } = await import('../../src/runtime/traits/Persistent');
    const { getCurrentWorld } = await getWorld();

    await sceneManager.loadScene('/sceneA.json');

    const mainWorld = getCurrentWorld();
    const root = mainWorld.spawn(
      Transform({ x: 5 }),
      EntityAttributes({ name: 'PersistentRoot', parentId: 0 }),
    );
    markPersistent(root, 'test-guid-persistent-root');
    const rootId = root.id();
    mainWorld.spawn(
      Transform({ x: 6 }),
      EntityAttributes({ name: 'Child1', parentId: rootId }),
    );
    mainWorld.spawn(
      Transform({ x: 7 }),
      EntityAttributes({ name: 'Child2', parentId: rootId }),
    );

    await sceneManager.loadScene('/sceneB.json');

    // After swap, expect 3 entities from the persistent subtree
    const newWorld = getCurrentWorld();
    const namesByParent = new Map<number, string[]>();
    let newRootId = -1;
    newWorld.query(EntityAttributes).updateEach(([attr]: any[], entity: { id(): number }) => {
      const name = (attr as any).name as string;
      if (name === 'PersistentRoot') newRootId = entity.id();
      const parentId = (attr as any).parentId as number;
      let list = namesByParent.get(parentId);
      if (!list) { list = []; namesByParent.set(parentId, list); }
      list.push(name);
    });

    expect(newRootId).not.toBe(-1);
    // Children should be parented to the new root id (different from old)
    const childNames = namesByParent.get(newRootId)?.sort();
    expect(childNames).toEqual(['Child1', 'Child2']);
  });

  it('same-name scene root with a different guid is NOT shadowed', async () => {
    // Regression test: the old name-based filter would shadow any "Player"
    // root. The new guid-based filter only shadows when guids match.
    fetchResponses['/sceneWithSameNameDiffGuid.json'] = {
      version: 6,
      resources: [],
      entities: [
        { id: 50, traits: {
          Transform: { x: 0 },
          EntityAttributes: { name: 'Player', parentId: 0 },
          PlayerProfile: { score: 0, level: 1 },
          Persistent: { guid: 'different-guid' }, // different from runtime
        } },
        { id: 51, traits: {
          Transform: { x: 5 },
          EntityAttributes: { name: 'Tree', parentId: 0 },
        } },
      ],
    };

    const { sceneManager } = await getSceneManager();
    const { markPersistent } = await import('../../src/runtime/traits/Persistent');
    const { getCurrentWorld } = await getWorld();

    defineSceneA();
    await sceneManager.loadScene('/sceneA.json');
    const player = getCurrentWorld().spawn(
      Transform({ x: 999 }),
      EntityAttributes({ name: 'Player', parentId: 0 }),
      PlayerProfile({ score: 99, level: 5 }),
    );
    markPersistent(player, 'test-guid-player');

    await sceneManager.loadScene('/sceneWithSameNameDiffGuid.json');

    // After swap: TWO Players — the persistent one (score 99) and the scene one (score 0)
    const newWorld = getCurrentWorld();
    let playerCount = 0;
    const scores: number[] = [];
    newWorld.query(PlayerProfile).updateEach(([p]: any[]) => {
      playerCount++;
      scores.push((p as any).score);
    });
    expect(playerCount).toBe(2);
    expect(scores.sort()).toEqual([0, 99]);
  });

  it('markPersistent throws on a non-root entity', async () => {
    const { markPersistent } = await import('../../src/runtime/traits/Persistent');
    const { getCurrentWorld } = await getWorld();

    defineSceneA();
    const { sceneManager } = await getSceneManager();
    await sceneManager.loadScene('/sceneA.json');

    const mainWorld = getCurrentWorld();
    const parent = mainWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'Parent', parentId: 0 }),
    );
    const child = mainWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'Child', parentId: parent.id() }),
    );

    expect(() => markPersistent(child)).toThrow(/only root entities/);
  });
});

// ── filterPersistentDuplicates — direct unit tests ──────────────────────
//
// The happy path is covered by the 'shadows a scene root by matching guid'
// integration test above. These unit tests pin down the edge cases of the
// pure function without spinning up the full SceneManager/fetch pipeline.

describe('filterPersistentDuplicates', () => {
  // Helper to build a scene entry tersely
  const entry = (
    id: number,
    name: string,
    parentId: number = 0,
    extra: Record<string, Record<string, unknown>> = {},
  ) => ({
    id,
    traits: {
      EntityAttributes: { name, parentId },
      ...extra,
    },
  });

  /** Build a persistent entry with a guid — shorthand for scene roots that
   *  carry the Persistent trait. */
  const persistentEntry = (
    id: number,
    name: string,
    guid: string,
    parentId: number = 0,
    extra: Record<string, Record<string, unknown>> = {},
  ) => ({
    id,
    traits: {
      EntityAttributes: { name, parentId },
      Persistent: { guid },
      ...extra,
    },
  });

  /** Build a persistent snapshot (simulates snapshotPersistentEntities output). */
  const snap = (id: number, name: string, guid: string, parentId: number = 0) => ({
    id,
    traits: {
      EntityAttributes: { name, parentId },
      Persistent: { guid },
    },
  });

  async function getFilter() {
    const mod = await import('../../src/runtime/scene/SceneManager');
    return mod.filterPersistentDuplicates;
  }

  it('returns data unchanged when there are no persistent snapshots', async () => {
    const filter = await getFilter();
    const data = { version: 6, resources: [], entities: [entry(1, 'A'), entry(2, 'B')] };
    const out = filter(data as any, []);
    expect(out).toBe(data);
  });

  it('returns data unchanged when no scene root guid matches a persistent guid', async () => {
    const filter = await getFilter();
    const data = { version: 6, resources: [], entities: [entry(1, 'A'), entry(2, 'B')] };
    const snapshots = [snap(10, 'NotInScene', 'guid-x')];
    const out = filter(data as any, snapshots as any);
    expect(out).toBe(data);
  });

  it('excludes a scene root with matching guid', async () => {
    const filter = await getFilter();
    const data = {
      version: 6,
      resources: [],
      entities: [persistentEntry(1, 'Player', 'guid-1'), entry(2, 'Tree'), entry(3, 'Rock')],
    };
    const snapshots = [snap(10, 'Player', 'guid-1')];
    const out = filter(data as any, snapshots as any);
    expect(out).not.toBe(data);
    expect(out.entities.map((e: any) => e.id).sort()).toEqual([2, 3]);
  });

  it('excludes the full descendant subtree of a guid-matched root', async () => {
    const filter = await getFilter();
    const data = {
      version: 6,
      resources: [],
      entities: [
        persistentEntry(1, 'Player', 'guid-1'),  // root, guid matches
        entry(2, 'Hand', 1),                      // child
        entry(3, 'Finger', 2),                    // grandchild
        entry(4, 'Thumb', 2),                     // grandchild
        entry(5, 'Nail', 4),                      // great-grandchild
        entry(6, 'UnrelatedRoot'),                // unrelated root, kept
        entry(7, 'Sibling', 6),                   // kept
      ],
    };
    const snapshots = [snap(10, 'Player', 'guid-1')];
    const out = filter(data as any, snapshots as any);
    expect(out.entities.map((e: any) => e.id).sort()).toEqual([6, 7]);
  });

  it('does NOT shadow a scene root with the same name but no Persistent trait', async () => {
    const filter = await getFilter();
    // Scene root "Player" has no Persistent trait — should NOT be pruned
    const data = {
      version: 6,
      resources: [],
      entities: [entry(1, 'Player'), entry(2, 'Tree')],
    };
    const snapshots = [snap(10, 'Player', 'guid-1')];
    const out = filter(data as any, snapshots as any);
    expect(out).toBe(data);
  });

  it('does NOT shadow a scene root with the same name but different guid', async () => {
    const filter = await getFilter();
    const data = {
      version: 6,
      resources: [],
      entities: [persistentEntry(1, 'Player', 'guid-other'), entry(2, 'Tree')],
    };
    const snapshots = [snap(10, 'Player', 'guid-1')];
    const out = filter(data as any, snapshots as any);
    expect(out).toBe(data);
  });

  it('handles multiple persistent roots matching multiple scene roots', async () => {
    const filter = await getFilter();
    const data = {
      version: 6,
      resources: [],
      entities: [
        persistentEntry(1, 'Player', 'guid-1'),
        entry(2, 'PlayerHand', 1),
        persistentEntry(3, 'Camera', 'guid-2'),
        entry(4, 'CameraRig', 3),
        entry(5, 'KeepMe'),
      ],
    };
    const snapshots = [
      snap(10, 'Player', 'guid-1'),
      snap(20, 'Camera', 'guid-2'),
    ];
    const out = filter(data as any, snapshots as any);
    expect(out.entities.map((e: any) => e.id)).toEqual([5]);
  });

  it('ignores persistent snapshot entries that are not roots (parentId !== 0)', async () => {
    const filter = await getFilter();
    // A snapshot child with a guid — only root snapshots should drive exclusion
    const data = {
      version: 6,
      resources: [],
      entities: [persistentEntry(1, 'Hand', 'guid-hand')],
    };
    const snapshots = [snap(10, 'Hand', 'guid-hand', 99)]; // non-root snapshot
    const out = filter(data as any, snapshots as any);
    expect(out).toBe(data);
  });

  it('skips persistent snapshots that are missing the Persistent trait', async () => {
    const filter = await getFilter();
    const data = { version: 6, resources: [], entities: [persistentEntry(1, 'Player', 'guid-1')] };
    // Malformed snapshot: no Persistent trait at all
    const snapshots = [{ id: 10, traits: { EntityAttributes: { name: 'Player', parentId: 0 } } }];
    const out = filter(data as any, snapshots as any);
    expect(out).toBe(data);
  });

  it('skips persistent snapshots with empty guid', async () => {
    const filter = await getFilter();
    const data = { version: 6, resources: [], entities: [persistentEntry(1, 'Player', 'guid-1')] };
    const snapshots = [
      { id: 10, traits: { EntityAttributes: { name: 'Player', parentId: 0 }, Persistent: { guid: '' } } },
    ];
    const out = filter(data as any, snapshots as any);
    expect(out).toBe(data);
  });

  it('ignores scene entries that are missing EntityAttributes', async () => {
    const filter = await getFilter();
    const data = {
      version: 6,
      resources: [],
      entities: [
        { id: 1, traits: { Transform: { x: 0 } } }, // no EntityAttributes
        persistentEntry(2, 'Player', 'guid-1'),
      ],
    };
    const snapshots = [snap(10, 'Player', 'guid-1')];
    const out = filter(data as any, snapshots as any);
    expect(out.entities.map((e: any) => e.id)).toEqual([1]);
  });
});

describe('beforeSwap hooks', () => {
  // Combined into one test to stay within koota's 16-world limit.
  it('fires hooks in order before swap, swallows errors, and respects unregister', async () => {
    defineSceneA();
    const { sceneManager } = await getSceneManager();
    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');

    let hookWorld: any = null;
    let mainWorldDuringHook: any = null;
    const order: number[] = [];

    // Hook that captures the staging world
    const captureHook = vi.fn(async (stagingWorld: any) => {
      hookWorld = stagingWorld;
      mainWorldDuringHook = getCurrentWorld();
      order.push(1);
    });

    // Hook that throws — should not abort the load
    const failingHook = vi.fn(async () => {
      order.push(2);
      throw new Error('prewarm failed');
    });

    // Hook that's removed before load — should NOT be called
    const removedHook = vi.fn(async () => { order.push(99); });

    sceneManager.registerBeforeSwap(captureHook);
    sceneManager.registerBeforeSwap(failingHook);
    sceneManager.registerBeforeSwap(removedHook);
    sceneManager.unregisterBeforeSwap(removedHook);

    await sceneManager.loadScene('/sceneA.json');

    // captureHook verifies it receives the staging world (not the current world)
    expect(captureHook).toHaveBeenCalledTimes(1);
    expect(hookWorld).toBeDefined();
    expect(hookWorld).not.toBe(mainWorldDuringHook);

    // failingHook ran but didn't abort the load
    expect(failingHook).toHaveBeenCalledTimes(1);

    // removedHook was unregistered — never called
    expect(removedHook).not.toHaveBeenCalled();

    // Hooks ran in registration order (captureHook=1, failingHook=2)
    expect(order).toEqual([1, 2]);

    sceneManager.unregisterBeforeSwap(captureHook);
    sceneManager.unregisterBeforeSwap(failingHook);
    sceneManager.unloadAll();
  });
});
