/** Close-out (2026-09-05, #762 follow-up fallout): every editor path that OPENS a prefab
 *  for isolated editing (`openPrefabForEditing`) used to fetch the `.prefab.json` RAW —
 *  `fetch(asset.path)` + `parseAssetJson` — never through `getPrefabSource`, which is where the
 *  `UIAnchor.zIndex` → `UIElement.zIndex` migration used to live exclusively. A prefab authoring
 *  `UIAnchor.zIndex` therefore opened with the key silently dropped (the synthetic edit scene
 *  never runs `migrateV12toV13` — it starts life already at `SCENE_FORMAT_VERSION`, and
 *  `setPrefabCache` seeded the SAME cache `getPrefabSource` reads first with the un-migrated
 *  object, poisoning every later read in the session too), and saving wrote the loss to disk.
 *
 *  This drives the REAL `openPrefabForEditing` → `buildPrefabEditScene` → (spawn into the live
 *  world) → `serializePrefab` round trip, with only `sceneManager.loadScene` stubbed — and stubbed
 *  to actually SPAWN the built edit-scene's entities (mirroring `instantiatePrefab`'s own spawn
 *  loop), not mocked away, so the test can see what the user would actually edit, not just what
 *  was fetched. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// sceneManager.getCurrent() is read once (to compute the return-scene) and loadScene(key,
// {preloaded}) is what would normally hand the built edit-scene to the real loader. Stubbed to
// spawn `preloaded.entities` into the current world using the SAME registered-trait metadata
// `instantiatePrefab` uses, so this is a real spawn, not a no-op.
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => null,
    loadScene: async (
      _key: string,
      opts: { preloaded: { entities: { traits: Record<string, unknown> }[] } },
    ) => {
      const { getAllTraits } = await import('@modoki/engine/runtime');
      const { getCurrentWorld, spawnEntity } = await import('@modoki/engine/runtime');
      const allTraits = getAllTraits();
      for (const entry of opts.preloaded.entities) {
        const args: unknown[] = [];
        for (const meta of allTraits) {
          const saved = entry.traits[meta.name];
          if (saved === undefined) continue;
          args.push(saved === true ? meta.trait() : meta.trait(saved as Record<string, unknown>));
        }
        spawnEntity(getCurrentWorld(), ...(args as Parameters<typeof spawnEntity>[1][]));
      }
    },
    getLoadedScenes: () => new Map(),
  },
}));

// savePrefabEdit's writePrefabFile POSTs through backendFetch — capture what it would have
// written to disk instead of hitting a real dev server.
let written: { path: string; content: string } | null = null;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', () => ({
  backendFetch: async (url: string, init?: { body?: string }) => {
    if (url === '/api/write-file' && init?.body) {
      written = JSON.parse(init.body) as { path: string; content: string };
    }
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  },
}));

import { getAllEntities, getCurrentWorld } from '@modoki/engine/runtime';
import { getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { setRunMode } from '@modoki/engine/runtime';
import type { PrefabFile } from '@modoki/engine/editor';
import { openPrefabForEditing, savePrefabEdit, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefab';
import { setCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';

registerAllTraits();

// jsdom-less node env — setCurrentScenePath persists to localStorage (mirrors the other
// prefab-edit test files' setup).
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

const RAW_PREFAB: PrefabFile = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  version: 2,
  name: 'Badge',
  rootLocalId: 1,
  entities: [
    {
      localId: 1, name: 'Badge',
      traits: {
        EntityAttributes: { name: 'Badge', parentId: 0, layer: 'ui', guid: '' },
        UIAnchor: { anchor: 'top-left', zIndex: 20 } as unknown as Record<string, unknown>,
        UIElement: { width: 100, height: 40, zIndex: 0 } as unknown as Record<string, unknown>,
      },
    },
  ],
};

beforeEach(() => {
  written = null;
  setRunMode('stopped');
  setCurrentScenePath(null);
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify(RAW_PREFAB),
    json: async () => JSON.parse(JSON.stringify(RAW_PREFAB)),
  }));
});

describe('openPrefabForEditing → savePrefabEdit round trip (#762 follow-up close-out)', () => {
  it('migrates UIAnchor.zIndex onto UIElement.zIndex BEFORE seeding the prefab cache', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });

    const cached = getCachedPrefabSync(RAW_PREFAB.id!);
    expect(cached).not.toBeNull();
    const traits = cached!.entities[0].traits as Record<string, Record<string, unknown>>;
    expect(traits.UIElement.zIndex).toBe(20);
    expect(traits.UIAnchor.zIndex).toBeUndefined();
  });

  it('spawns the edit-world root with the migrated value (what the user actually sees)', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });

    const eaMeta = getTraitByName('EntityAttributes')!;
    const uiElMeta = getTraitByName('UIElement')!;
    let rootId = 0;
    getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
      if ((ea as Record<string, unknown>).guid === PREFAB_EDIT_ROOT_GUID) rootId = entity.id();
    });
    expect(rootId).toBeGreaterThan(0);
    const rootEntity = getAllEntities().find((e) => e.id === rootId);
    expect(rootEntity).toBeDefined();
    const el = getCurrentWorld().entities.find((e) => e.id() === rootId)!.get(uiElMeta.trait) as Record<string, unknown>;
    expect(el.zIndex).toBe(20);
  });

  it('the value SURVIVES a save — written .prefab.json carries UIElement.zIndex, not UIAnchor.zIndex', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });

    const ok = await savePrefabEdit();
    expect(ok).toBe(true);
    expect(written).not.toBeNull();

    const savedPrefab = JSON.parse(written!.content) as PrefabFile;
    const savedTraits = savedPrefab.entities[0].traits as unknown as Record<string, Record<string, unknown>>;
    expect(savedTraits.UIElement.zIndex).toBe(20);
    expect(savedTraits.UIAnchor?.zIndex).toBeUndefined();
  });
});
