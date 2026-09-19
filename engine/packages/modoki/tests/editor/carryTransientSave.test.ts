/** A runtime subtree carried across a level swap stays out of the next save (#1427).
 *
 *  The base-scene carry respawns every `Persistent` root (and a kept base) from a snapshot built
 *  from the trait registry. `Transient` is deliberately unregistered, so the snapshot dropped it:
 *  a runtime child under a `Persistent` root — a UIEntries pool row, a generated tile — came back
 *  untagged, and the next save of the new level wrote it into the scene file as authored content.
 *
 *  Driven through the real SceneManager carry and the real `serializeScene`. The harness is
 *  timeResourceProvenance.test.ts's: `vi.resetModules()` in beforeEach, so every trait the test
 *  touches is either mocked with one identity or imported dynamically from the fresh graph. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const BASE_GUID = '91000000-0000-4000-8000-0000000000ba';
const L1 = '/assets/scenes/l1.json';
const L2 = '/assets/scenes/l2.json';
let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
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
    '/assets/scenes/base.json': {
      id: BASE_GUID, version: 12, resources: [],
      entities: [{ traits: { EntityAttributes: { name: 'Camera', guid: '91000000-0000-4000-8000-00000000ca4e' } } }],
    },
    [L1]: {
      id: '91000000-0000-4000-8000-000000000001', version: 12, baseScene: BASE_GUID, resources: [],
      entities: [{ traits: { EntityAttributes: { name: 'PRoot', guid: '91000000-0000-4000-8000-0000000000a1' }, Persistent: true } }],
    },
    [L2]: {
      id: '91000000-0000-4000-8000-000000000002', version: 12, baseScene: BASE_GUID, resources: [],
      entities: [{ traits: { EntityAttributes: { name: 'L2Thing', guid: '91000000-0000-4000-8000-0000000000b2' } } }],
    },
  };
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/core/ecs/traitRegistry');
  (getAllTraits().find((m: { name: string }) => m.name === 'Persistent') as { trait: unknown }).trait = Persistent;
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(BASE_GUID, '/assets/scenes/base.json', 'scene');
});

describe('a runtime subtree carried across a swap is not saved (#1427)', () => {
  // Mutation: drop the `restoreMarkers` call in SceneManager's carry respawn — the pool row comes
  // back untagged and the level-2 save writes it.
  it('a Transient child under a Persistent root stays out of the next level\'s save', async () => {
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const ser = await import('../../src/editor/scene/serialize');
    const { getCurrentWorld, spawnEntity } = await import('../../src/runtime/core/ecs/world');
    const { Transient } = await import('../../src/runtime/core/traits/Transient');
    sceneMod.sceneManager.resetForTesting();

    await sceneMod.sceneManager.loadScene(L1);
    let rootId = 0;
    getCurrentWorld().query(EntityAttributes).updateEach(([a]: [{ name: string }], e: { id(): number }) => { if (a.name === 'PRoot') rootId = e.id(); });
    expect(rootId).not.toBe(0);
    const row = spawnEntity(getCurrentWorld(), EntityAttributes({ name: 'PoolRow', parentId: rootId }));
    row.add(Transient);

    await sceneMod.sceneManager.loadScene(L2); // carries PRoot and its subtree
    const names: string[] = [];
    getCurrentWorld().query(EntityAttributes).updateEach(([a]: [{ name: string }]) => { names.push(a.name); });
    expect(names).toContain('PoolRow'); // the premise: the row IS carried, live

    ser.setCurrentScenePath(L2);
    const saved = await ser.serializeScene() as { entities: Array<{ name?: string; traits?: { EntityAttributes?: { name?: string } } }> };
    const savedNames = saved.entities.map((e) => e.name ?? e.traits?.EntityAttributes?.name);
    expect(savedNames).toContain('PRoot');
    expect(savedNames).not.toContain('PoolRow');
  });
});
