/** A scene's `id` is a fact about the ASSET, not about the format.
 *
 *  A `save_all` on `games/3d-test/runtime/assets/scenes/tropical-island.json` migrated
 *  it v9→v12 correctly and then ALSO replaced its top-level `id` with a fresh guid,
 *  leaving `project.config.json`'s scene reference dangling (docs/todo.md, 2026-07-30).
 *  The migration was never the culprit — every migrator in `loadSceneFile.ts` mutates
 *  in place and does not even see `id`/`createdAt`. The re-mint came from
 *  `serializeScene`, which recovered the PRIMARY's id by reverse-looking-up the path in
 *  the global asset manifest: `getGuidForPath(path) ?? newGuid()`. `registerAsset`
 *  EVICTS `pathToGuid[prior.path]` whenever the same guid is re-registered under a
 *  different path string, so an ordinary manifest rescan is enough to make that lookup
 *  miss — and a miss mints. `createdAt` then reset as a consequence, because its own
 *  `loadedScenes` lookup was keyed on the id being computed (circular).
 *
 *  The A10 gates (scenePathIndependence, sceneCreatedAtStability) compare `createdAt`
 *  and `entities` and never asserted `id`, which is precisely why this got through.
 *  This file is that missing assertion.
 *
 *  Mirrors scenePathIndependence.test.ts's harness: real `sceneManager.loadScene` over
 *  a mocked `fetch`, real `serializeScene`, synthetic fixtures, no file writes. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});

// world.ts imports the REAL EntityAttributes directly for its guid index — spawned
// entities must share that trait identity or guid lookups silently miss. Same gotcha
// documented at length in scenePathIndependence.test.ts / sceneManagerBaseSceneChain.
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const LEGACY_GUID = '4bc54ae4-0000-4000-8000-00000000abcd';
const LEGACY_CREATED_AT = '2021-01-01T01:01:01.000Z';
const SCENE_PATH = '/assets/scenes/tropical-island.json';
/** The SAME file addressed by a second path string — what a manifest rescan that
 *  indexes project-relative rather than asset-root-relative paths would register. */
const SCENE_PATH_ALT = '/games/3d-test/runtime/assets/scenes/tropical-island.json';

let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  // completeResponse fills in text() — the stubs below only supply json(), and the loaders read
  // the body as text so they can spot Vite's index.html SPA fallback. See tests/stubs/assetResponse.ts.
  for (const [key, body] of Object.entries(fetchResponses)) {
    // Deep-clone: the loader mutates the parsed data in place (version stamp,
    // synthetic entry ids, resource rewrite), so a shared object would let one
    // load's migration leak into the next and make a second load a different test.
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => structuredClone(body) });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
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
    // A genuine v9 file: carries per-entry numeric `id`s (dropped at v12) and
    // predates the `baseScene` field. The migration chain must take it to v12
    // WITHOUT touching the two identity fields.
    [SCENE_PATH]: {
      id: LEGACY_GUID,
      version: 9,
      createdAt: LEGACY_CREATED_AT,
      resources: [],
      entities: [
        { id: 3, traits: { Transform: true, EntityAttributes: { name: 'Island', guid: 'g-island' } } },
        { id: 11, traits: { Transform: true, EntityAttributes: { name: 'Palm', guid: 'g-palm' } } },
      ],
    },
  };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

async function setup() {
  const sceneMod = await import('../../src/runtime/scene/SceneManager');
  const ser = await import('../../src/editor/scene/serialize');
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  const load = async (path: string) => {
    await sceneMod.sceneManager.loadScene(path);
    ser.setCurrentScenePath(path);
  };
  sceneMod.sceneManager.resetForTesting();
  return { sceneManager: sceneMod.sceneManager, serializeScene: ser.serializeScene, load, manifest };
}

describe('scene identity survives a load→save round trip', () => {
  it('a v9 file migrated to v12 keeps its own `id` and `createdAt` — only the FORMAT changes', async () => {
    const { load, serializeScene } = await setup();
    await load(SCENE_PATH);

    const saved = await serializeScene();

    // The migration itself must have happened...
    expect(saved.version).toBe(12);
    expect(saved.entities).toHaveLength(2);
    // ...and it must be the only thing that changed. `id` is an asset REFERENCE:
    // project.config.json and createEditorSceneFallback.test.ts both name it, so a
    // re-mint dangles them silently.
    expect(saved.id).toBe(LEGACY_GUID);
    expect(saved.createdAt).toBe(LEGACY_CREATED_AT);
  });

  it('the id survives a manifest rescan that re-registers the same guid under a DIFFERENT path — the mechanism that actually re-minted tropical-island', async () => {
    const { load, serializeScene, manifest } = await setup();
    await load(SCENE_PATH);

    // The scanner re-registers the same scene under its other path form. This is
    // not a corruption — `registerAsset` deliberately drops the stale reverse entry
    // so one guid never maps back from two paths. The bug was that serialize's id
    // recovery depended on that reverse entry surviving.
    manifest.registerAsset(LEGACY_GUID, SCENE_PATH_ALT, 'scene');
    expect(manifest.getGuidForPath(SCENE_PATH)).toBeUndefined(); // the eviction, pinned

    const saved = await serializeScene();

    expect(saved.id).toBe(LEGACY_GUID);
    expect(saved.createdAt).toBe(LEGACY_CREATED_AT);
  });

  it('two consecutive saves agree on the id (a re-mint would also make save N+1 differ from save N)', async () => {
    const { load, serializeScene } = await setup();
    await load(SCENE_PATH);

    const first = await serializeScene();
    const second = await serializeScene();

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('a scene that was never loaded still mints a fresh id rather than throwing — the one case a new id is correct', async () => {
    const { serializeScene } = await setup();
    const ser = await import('../../src/editor/scene/serialize');
    ser.setCurrentScenePath(null); // e.g. newScene(), or the prefab-edit sandbox

    const saved = await serializeScene();

    expect(saved.id).toBeTruthy();
    expect(saved.id).not.toBe(LEGACY_GUID);
  });
});
