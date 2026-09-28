/** #1702 — each loaded scene entry records the prefabs its FILE uses (`LoadedSceneEntry.prefabRefs`), which the editor's
 *  hot reload reads to reload only for a prefab change the open scene uses (`agentBridgePrefabReloadFilter.test.ts`).
 *
 *  A real load over `preloaded` scene data and a stubbed `fetch` for the prefab files. Pinned: a direct ref, a NESTED ref
 *  found only by walking the fetched prefab, the path each resolved to at load (the watcher names a path, and after a
 *  delete the manifest may no longer map it back), and a ref that did NOT resolve (missing at load) kept by its guid.
 *
 *  Mutations, each checked red here: drop `prefabRefs` from the entry; drop the resolved path (`out.add(resolved)`);
 *  turn off the game-trait sweep in `collectResourceRefsFromEntities` (red on the spawner case only).
 *  NOT a mutation: building it from `sceneData.resources` instead of the collected refs stays green, because
 *  `collectSceneResourceRefs` writes the collected list (nested included) back onto `sceneData.resources` — one list. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' } } },
  ];
  return { getAllTraits: () => traits, getTraitByName: (name: string) => traits.find((t) => t.name === name) };
});

const A = 'aaaaaaaa-0000-4000-8000-000000001702';
const B = 'bbbbbbbb-0000-4000-8000-000000001702';
const MISSING = 'cccccccc-0000-4000-8000-000000001702';
const A_PATH = '/assets/kit/A.prefab.json';
const B_PATH = '/assets/kit/B.prefab.json';
const UNUSED = 'dddddddd-0000-4000-8000-000000001702';

const docs: Record<string, unknown> = {
  [A_PATH]: { id: A, version: 2, name: 'A', rootLocalId: 1, entities: [{ localId: 1, name: 'A', traits: {} }, { localId: 2, prefab: B, traits: {} }] },
  [B_PATH]: { id: B, version: 2, name: 'B', rootLocalId: 1, entities: [{ localId: 1, name: 'B', traits: {} }] },
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const doc = docs[String(url).split('?')[0]];
    return doc
      ? new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('not found', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('LoadedSceneEntry.prefabRefs (#1702)', () => {
  it('records direct and nested prefab refs, each with its load-time path, and a ref missing at load by its guid', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    registerAsset(A, A_PATH, 'prefab');
    registerAsset(B, B_PATH, 'prefab');
    registerAsset(UNUSED, '/assets/kit/Unused.prefab.json', 'prefab');
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    await sceneManager.loadScene('/assets/level.scene.json', {
      preloaded: {
        version: 10,
        resources: [{ type: 'prefab', path: A }, { type: 'prefab', path: MISSING }],
        entities: [{ id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name: 'Level', parentId: 0 } } }],
      } as never,
    });
    const [entry] = [...sceneManager.getLoadedScenes().values()];
    expect(new Set(entry.prefabRefs)).toEqual(new Set([A, A_PATH, B, B_PATH, MISSING]));
  });

  it('a prefab named ONLY by a game trait`s GUID field (a spawner) is recorded — the resources walker`s sweep, not a list', async () => {
    const { registerAsset } = await import('../../src/runtime/loaders/assetManifest');
    registerAsset(A, A_PATH, 'prefab');
    registerAsset(B, B_PATH, 'prefab');
    const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
    sceneManager.resetForTesting();
    await sceneManager.loadScene('/assets/spawn.scene.json', {
      preloaded: {
        version: 10,
        resources: [],
        entities: [{ id: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Spawner', parentId: 0 }, EnemySpawner: { enemyPrefab: A } } }],
      } as never,
    });
    const [entry] = [...sceneManager.getLoadedScenes().values()];
    expect(new Set(entry.prefabRefs)).toEqual(new Set([A, A_PATH, B, B_PATH]));
  });
});
