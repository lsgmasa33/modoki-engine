/** scene-loading.md, Phase 4 — THE GATE.
 *
 *  "No-op Save All -> empty git diff" is a necessary but NOT sufficient test: `saveAll`
 *  only writes DIRTY scenes, so an empty diff can mean "not written", not "byte-stable"
 *  (this false-pass bit the A9 investigation twice — see base-scene-and-persistence-
 *  plan.md). The gate that actually pins A10 is PATH-INDEPENDENCE: `serializeScene()`
 *  for the SAME scene must produce identical output regardless of HOW it arrived —
 *  a cold chained load (base spawns first) vs. a carried level swap (primary spawns
 *  first, base respawned from a snapshot afterward). Before Phases 0-3 these differed
 *  by 51 ids on the primary and 8 on the fish (measured live in sling); this test pins
 *  that as a permanent regression gate using synthetic fixtures, no file write needed.
 *
 *  Drives the REAL `sceneManager.loadScene` (real `fetch` mock, not `preloaded` — the
 *  chain-resolution fetch of the base must be genuine for a true cold-vs-carry
 *  comparison) and the REAL `serializeScene`, mirroring sceneCreatedAtStability.test.ts
 *  and sceneManagerBaseSceneChain.test.ts's own patterns. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
const PrefabInstance = trait({ source: '', localId: 0, rootInstanceId: 0, parentLocalId: 0 });

// `runtime/ecs/world.ts` (registerEntity/findEntityByGuid/indexEntityGuid) imports the
// REAL EntityAttributes trait directly — a guid-based lookup (rootInstanceId as a guid,
// Phase 2) silently fails to resolve unless this test's spawned entities carry the SAME
// trait identity the guid index reads. See sceneManagerBaseSceneChain.test.ts for the
// same gotcha, documented at length there.
vi.mock('../../src/runtime/traits/EntityAttributes', () => ({ EntityAttributes }));

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
    { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: { source: {}, localId: {}, rootInstanceId: { entityId: { onMissing: 'stripTrait' } }, parentLocalId: {} } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const BASE_GUID = '70000000-0000-4000-8000-0000000000ba';
const FISH_ROOT_GUID = '70000000-0000-4000-8000-00000000f001';
const FISH_CHILD_GUID = '70000000-0000-4000-8000-00000000f002';
const LEVEL1_GUID = '70000000-0000-4000-8000-000000000001';
const LEVEL2_GUID = '70000000-0000-4000-8000-000000000002';
const BASE_CREATED_AT = '2023-05-05T05:05:05.000Z';

let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return { ok: true, json: async () => body } as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as Response;
});

function installLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

beforeEach(async () => {
  installLocalStorage();
  vi.resetModules();
  fetchResponses = {
    '/base.json': {
      id: BASE_GUID,
      version: 12,
      createdAt: BASE_CREATED_AT,
      resources: [],
      entities: [
        { traits: { Transform: true, EntityAttributes: { name: 'Camera', guid: 'g-camera' } } },
        // A flat prefab root + member — mirrors the CARRIED-snapshot shape (Phase
        // 15's A8-fix suite): rootInstanceId on the root points at ITSELF (as a
        // guid, since Phase 2), the member's points at the root, and the member's
        // parentId also points at the root.
        {
          traits: {
            Transform: true,
            EntityAttributes: { name: 'FishRoot', guid: FISH_ROOT_GUID },
            PrefabInstance: { source: 'fish-prefab-guid', localId: 1, rootInstanceId: FISH_ROOT_GUID, parentLocalId: 0 },
          },
        },
        {
          traits: {
            Transform: true,
            EntityAttributes: { name: 'FishChild', guid: FISH_CHILD_GUID, parentId: FISH_ROOT_GUID },
            PrefabInstance: { source: 'fish-prefab-guid', localId: 2, rootInstanceId: FISH_ROOT_GUID, parentLocalId: 0 },
          },
        },
      ],
    },
    '/level1.json': {
      // Explicit createdAt (Phase 1) — without it, each load mints `new Date()`
      // fresh, and two loads a millisecond apart would legitimately differ. That's
      // not what this gate is testing (it's testing PATH-independence, not
      // Phase-1's own already-covered behavior), so pin it like a real save would.
      id: LEVEL1_GUID, version: 12, createdAt: '2022-02-02T02:02:02.000Z', baseScene: BASE_GUID, resources: [],
      entities: [{ traits: { Transform: true, EntityAttributes: { name: 'Level1Thing', guid: 'g-l1' } } }],
    },
    '/level2.json': {
      id: LEVEL2_GUID, version: 12, createdAt: '2022-03-03T03:03:03.000Z', baseScene: BASE_GUID, resources: [],
      entities: [{ traits: { Transform: true, EntityAttributes: { name: 'Level2Thing', guid: 'g-l2' } } }],
    },
  };
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(BASE_GUID, '/base.json', 'scene');
});

async function setup() {
  const sceneMod = await import('../../src/runtime/scene/SceneManager');
  const ser = await import('../../src/editor/scene/serialize');
  const load = async (path: string) => {
    await sceneMod.sceneManager.loadScene(path);
    ser.setCurrentScenePath(path);
  };
  const serializeBase = async () => {
    let baseEntry: { path: string; guid: string } | undefined;
    for (const entry of sceneMod.sceneManager.getLoadedScenes().values()) if (entry.role === 'base') baseEntry = entry;
    if (!baseEntry) throw new Error('base not loaded');
    return ser.serializeScene({ scene: { path: baseEntry.path, guid: baseEntry.guid } });
  };
  return { sceneManager: sceneMod.sceneManager, serializeScene: ser.serializeScene, load, serializeBase };
}

/** Strip the one field genuinely allowed to differ between two loads of the SAME
 *  content family (Transient/etc. don't apply here) — nothing, actually: a
 *  path-independent save must match on EVERYTHING, entities included. Kept as an
 *  identity function so the comparison below states its intent explicitly. */
function normalize<T>(x: T): T { return x; }

describe('Phase 4 gate 1 — path-independence: cold chain load vs. carried level swap', () => {
  it('serializeScene(base) is IDENTICAL after a cold chain load and after a carry — entities, rootInstanceId, createdAt', async () => {
    // Path A: cold chain load. Nothing loaded before level1, so its chain
    // (base + level1) loads fresh — base spawns FIRST (root-most-base-first).
    const a = await setup();
    a.sceneManager.resetForTesting();
    await a.load('/level1.json');
    const baseA = await a.serializeBase();

    // Path B: carried. Load level2 first (fresh base + level2), THEN level1 —
    // the base is KEPT (shared baseScene) and respawned from a snapshot
    // (SceneManager's carry path), not reloaded from file.
    const b = await setup();
    b.sceneManager.resetForTesting();
    await b.load('/level2.json');
    await b.load('/level1.json');
    const baseB = await b.serializeBase();

    expect(normalize(baseB.createdAt)).toBe(normalize(baseA.createdAt));
    expect(normalize(baseB.entities)).toEqual(normalize(baseA.entities));
  });

  it('serializeScene(primary) is IDENTICAL after a cold chain load and after a carry (the primary is always spawned fresh from its own file either way)', async () => {
    const a = await setup();
    a.sceneManager.resetForTesting();
    await a.load('/level1.json');
    const primaryA = await a.serializeScene();

    const b = await setup();
    b.sceneManager.resetForTesting();
    await b.load('/level2.json');
    await b.load('/level1.json');
    const primaryB = await b.serializeScene();

    expect(normalize(primaryB.createdAt)).toBe(normalize(primaryA.createdAt));
    expect(normalize(primaryB.entities)).toEqual(normalize(primaryA.entities));
  });

  it('within a single arrival path, the result is deterministic across repeated cycles (not just lucky once)', async () => {
    const s = await setup();
    s.sceneManager.resetForTesting();
    await s.load('/level2.json');
    await s.load('/level1.json');
    const first = await s.serializeBase();

    await s.load('/level2.json');
    await s.load('/level1.json'); // a second carry cycle
    const second = await s.serializeBase();

    expect(second.entities).toEqual(first.entities);
  });
});

describe('Phase 4 gate 3 — round-trip integrity: a carried prefab member never loses its PrefabInstance trait', () => {
  it('after a carry, the flattened fish root AND member both still carry PrefabInstance with a self-consistent rootInstanceId', async () => {
    const { sceneManager, load } = await setup();
    sceneManager.resetForTesting();
    await load('/level2.json');
    await load('/level1.json'); // carries the base

    const { getCurrentWorld } = await import('../../src/runtime/ecs/world');
    const world = getCurrentWorld();
    const rows: { name: string; hasPI: boolean; rootInstanceId?: number }[] = [];
    world.query(EntityAttributes).updateEach(([ea]: Record<string, unknown>[], e: { id(): number; has(t: unknown): boolean; get(t: unknown): Record<string, unknown> }) => {
      const name = ea.name as string;
      if (name !== 'FishRoot' && name !== 'FishChild') return;
      const hasPI = e.has(PrefabInstance);
      rows.push({ name, hasPI, rootInstanceId: hasPI ? (e.get(PrefabInstance).rootInstanceId as number) : undefined });
    });
    expect(rows).toHaveLength(2);
    const root = rows.find((r) => r.name === 'FishRoot')!;
    const child = rows.find((r) => r.name === 'FishChild')!;
    // Never stripped (the onMissing:'stripTrait' failure mode Phase 2's Rollback
    // note warns about — this is exactly the regression it would cause).
    expect(root.hasPI).toBe(true);
    expect(child.hasPI).toBe(true);
    // Self-consistent: root points at itself, child points at the (same) root.
    expect(root.rootInstanceId).toBe(child.rootInstanceId);
  });
});
