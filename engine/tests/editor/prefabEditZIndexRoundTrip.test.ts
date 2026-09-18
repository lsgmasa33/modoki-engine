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
      return { keptBaseGuids: new Set<string>() };
    },
    getLoadedScenes: () => new Map(),
  },
}));

// savePrefabEdit's writePrefabFile POSTs through postWriteFile (#835) — capture what it would
// have written to disk instead of hitting a real dev server. jsonFileBody is left as the REAL
// implementation (importOriginal) — it's a pure byte producer, not something this test needs to
// fake, and faking it would silently stop this file from catching a #835 regression in it.
let written: { path: string; content: string } | null = null;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/backend/editorBackend')>();
  return {
    ...actual,
    postWriteFile: async (path: string, content: string) => {
      written = { path, content };
      return { ok: true, json: async () => ({}), text: async () => '' } as Response;
    },
  };
});

import { getAllEntities, getCurrentWorld } from '@modoki/engine/runtime';
import { getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { setRunMode } from '@modoki/engine/runtime';
import type { PrefabFile } from '@modoki/engine/editor';
import { openPrefabForEditing, savePrefabEdit, savePrefabEditReport, PREFAB_EDIT_ROOT_GUID } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { getCachedPrefabSync, warnInertPrefabSizes } from '../../packages/modoki/src/editor/scene/prefab';
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

/** The prefab the stubbed fetch serves — RAW_PREFAB unless a test swaps it. */
let served: PrefabFile = RAW_PREFAB;

beforeEach(() => {
  written = null;
  served = RAW_PREFAB;
  setRunMode('stopped');
  setCurrentScenePath(null);
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify(served),
    json: async () => JSON.parse(JSON.stringify(served)),
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

// #1258: the agent `edit-save` op answers with the report's warnings — the editor Console is not where an agent
// looks. Driven through the same real open → spawn → serialize → write round trip as the save above, because the
// finding is computed from what the edit world SERIALIZES, not from the file that was opened.
describe('savePrefabEditReport keeps the validation warnings its write reported (#1258)', () => {
  // A width in % under a top-left anchor: LIVE on disk. The test makes it inert in the edit world instead.
  const BAND: PrefabFile = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
    version: 2,
    name: 'Band',
    rootLocalId: 1,
    entities: [{
      localId: 1, name: 'Band',
      traits: {
        EntityAttributes: { name: 'Band', parentId: 0, layer: 'ui', guid: '' },
        UIAnchor: { anchor: 'top-left' } as unknown as Record<string, unknown>,
        UIElement: { width: 90, widthUnit: '%' } as unknown as Record<string, unknown>,
      },
    }],
  };

  it('reports the finding for the edited template — made inert in the edit world, not on disk — and still saves', async () => {
    // The premise, or the test cannot tell "validated what was serialized" from "validated the opened file".
    expect(warnInertPrefabSizes(BAND, BAND.id!)).toEqual([]);
    served = BAND;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await openPrefabForEditing({ path: '/games/x/assets/prefabs/Band.prefab.json', name: 'Band' });
      // The edit: a stretch anchor now owns the authored width's axis, so the width is stored, shown, never applied.
      const eaMeta = getTraitByName('EntityAttributes')!;
      const anchorMeta = getTraitByName('UIAnchor')!;
      let edited = false;
      getCurrentWorld().query(eaMeta.trait).updateEach(([ea], entity) => {
        if ((ea as Record<string, unknown>).guid !== PREFAB_EDIT_ROOT_GUID) return;
        entity.set(anchorMeta.trait, { anchor: 'stretch' });
        edited = true;
      });
      expect(edited).toBe(true);
      const report = await savePrefabEditReport();
      expect(report.saved).toBe(true);
      expect(written).not.toBeNull();
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings.join('\n')).toContain('entity[localId=1] "Band".UIElement.width is inert');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports no warnings for a clean template', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    expect(await savePrefabEditReport()).toEqual({ saved: true, warnings: [] });
  });

  it('savePrefabEdit is the same save, answered as a boolean', async () => {
    await openPrefabForEditing({ path: '/games/x/assets/prefabs/Badge.prefab.json', name: 'Badge' });
    await expect(savePrefabEdit()).resolves.toBe(true);
    setRunMode('playing');
    try {
      await expect(savePrefabEdit()).resolves.toBe(false);
    } finally {
      setRunMode('stopped');
    }
  });
});
