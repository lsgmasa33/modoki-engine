/** scene-loading.md, Phase 1 — a Save All with zero edits must not
 *  regenerate `createdAt`. Before this phase `serializeScene` stamped
 *  `new Date().toISOString()` unconditionally; now it reuses the FILE's own
 *  stamp, captured into `SceneManager`'s `loadedScenes` bookkeeping at load time
 *  (an untyped field on the raw parsed JSON, same pattern as the scene's `id`).
 *
 *  Drives the REAL `sceneManager.loadScene` (via `preloaded` for the primary, a
 *  mocked `fetch` for the base — mirrors sceneManagerLifecycle.test.ts and
 *  sceneManagerBaseSceneChain.test.ts's own patterns) and the REAL
 *  `serializeScene`, not a mock, so a wiring mistake between the two modules
 *  would actually be caught. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const BASE_GUID = '50000000-0000-4000-8000-0000000000ba';
const BASE_CREATED_AT = '2024-01-01T00:00:00.000Z';

let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return { ok: true, json: async () => body } as Response;
  }
  return { ok: false, status: 404, json: async () => ({}) } as Response;
});

// serialize.ts's setCurrentScenePath persists the last-scene path to
// localStorage; the jsdom env here doesn't provide one (mirrors newScene.test.ts).
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

let sceneGuidCounter = 0;
// `serializeScene`'s createdAt lookup keys off the scene's guid, matched against
// `sceneManager.getLoadedScenes()` — so every fixture needs a REAL guid `id`
// (registered in the manifest the same way SceneManager.loadScene itself does for
// any scene carrying one), not just a name. Without this the lookup misses and
// silently falls back to "no prior createdAt" — the bug this fixture must NOT hide.
const sceneOf = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `60000000-0000-4000-8000-${String(++sceneGuidCounter).padStart(12, '0')}`,
  version: 10,
  resources: [],
  entities: [{ id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name, parentId: 0 } } }],
  ...extra,
});

beforeEach(async () => {
  installLocalStorage();
  vi.resetModules();
  fetchResponses = {
    '/base.json': sceneOf('BaseThing', { id: BASE_GUID, createdAt: BASE_CREATED_AT }),
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
  const scene = await import('../../src/runtime/scene/SceneManager');
  scene.sceneManager.resetForTesting();
  const ser = await import('../../src/editor/scene/serialize');
  // `sceneManager.loadScene` (runtime) never touches `_currentScenePath` — that's
  // editor-level state the real app syncs separately in `createEditor.tsx` right
  // after the load resolves. Mirror that wiring here so `serializeScene()`'s
  // sceneId lookup (and therefore the createdAt lookup keyed off it) resolves the
  // same way it does in the running editor, not the "brand-new scene" fallback.
  const load = async (path: string, opts?: Parameters<typeof scene.sceneManager.loadScene>[1]) => {
    await scene.sceneManager.loadScene(path, opts);
    ser.setCurrentScenePath(path);
  };
  return { sceneManager: scene.sceneManager, serializeScene: ser.serializeScene, load };
}

describe('createdAt stability (Phase 1)', () => {
  it('reuses the FILE\'s createdAt on save after a plain load — no edits, no regeneration', async () => {
    const { serializeScene, load } = await setup();
    const ORIGINAL = '2020-06-15T12:00:00.000Z';
    await load('/level.json', { preloaded: { createdAt: ORIGINAL, ...sceneOf('Level') } as never });

    const scene = await serializeScene();
    expect(scene.createdAt).toBe(ORIGINAL);
  });

  it('a scene with NO prior createdAt (never saved with this field) gets a fresh one, not undefined', async () => {
    const { serializeScene, load } = await setup();
    await load('/level.json', { preloaded: sceneOf('Level') as never }); // no createdAt field

    const scene = await serializeScene();
    expect(scene.createdAt).toBeTruthy();
    expect(() => new Date(scene.createdAt).toISOString()).not.toThrow();
  });

  it('two consecutive serializes of the same loaded scene return the IDENTICAL createdAt — a read never mutates it', async () => {
    const { serializeScene, load } = await setup();
    const ORIGINAL = '2021-03-03T03:03:03.000Z';
    await load('/level.json', { preloaded: { createdAt: ORIGINAL, ...sceneOf('Level') } as never });

    const first = await serializeScene();
    const second = await serializeScene(); // simulates enterPlay's snapshot, then a later real save
    expect(first.createdAt).toBe(ORIGINAL);
    expect(second.createdAt).toBe(ORIGINAL);
  });

  it('a NAMED BASE scene also preserves its own createdAt, independent of the primary\'s', async () => {
    const { sceneManager, serializeScene, load } = await setup();
    const PRIMARY_CREATED_AT = '2022-09-09T09:09:09.000Z';
    await load('/level.json', {
      preloaded: { createdAt: PRIMARY_CREATED_AT, baseScene: BASE_GUID, ...sceneOf('Level') } as never,
    });

    const primary = await serializeScene();
    expect(primary.createdAt).toBe(PRIMARY_CREATED_AT);

    let baseEntry: { path: string; guid: string } | undefined;
    for (const entry of sceneManager.getLoadedScenes().values()) if (entry.role === 'base') baseEntry = entry;
    expect(baseEntry).toBeDefined();

    const baseFile = await serializeScene({ scene: { path: baseEntry!.path, guid: baseEntry!.guid } });
    expect(baseFile.createdAt).toBe(BASE_CREATED_AT);
    expect(baseFile.createdAt).not.toBe(primary.createdAt);
  });

  it('a scene with an explicit createdAt survives a swap AWAY and back (loadedScenes is per-load, not stale)', async () => {
    const { serializeScene, load } = await setup();
    const A_CREATED_AT = '2019-01-01T00:00:00.000Z';
    fetchResponses['/sceneA.json'] = { createdAt: A_CREATED_AT, ...sceneOf('A') };
    await load('/sceneA.json'); // real fetch, no `preloaded`
    expect((await serializeScene()).createdAt).toBe(A_CREATED_AT);

    await load('/level.json', { preloaded: sceneOf('Other') as never });
    await load('/sceneA.json'); // back to A — re-fetched, re-captured
    expect((await serializeScene()).createdAt).toBe(A_CREATED_AT);
  });
});
