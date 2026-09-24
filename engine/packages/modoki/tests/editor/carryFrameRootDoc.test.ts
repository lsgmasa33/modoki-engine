/** A prefab-instance root carried across a scene swap keeps the record of the document it was expanded
 *  from (#1483).
 *
 *  The base-scene carry respawns a kept base (and every `Persistent` root) FLAT, from a snapshot. Its
 *  members keep their `PrefabInstance.localId`s, whose meaning is the document the frame was expanded
 *  from, but the per-root record of that document (`noteFrameDoc`) lived in the old world and was left
 *  behind. The editor then read the frame as expanded from whatever its cache held, which the prefab change
 *  that caused a hot reload had already replaced, and every capture matched members with the wrong rows.
 *
 *  Driven through the real SceneManager carry; the harness is carryTransientSave.test.ts's. */

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

describe('a carried frame root keeps the document it was expanded from (#1483)', () => {
  // Mutation: drop the `noteFrameRootDoc` call in SceneManager's carry respawn — the carried root has no
  // record in the new world.
  it('the record follows the root into the new world — as the ROOT`s, not as the source`s latest', async () => {
    const sceneMod = await import('../../src/runtime/scene/SceneManager');
    const { getCurrentWorld } = await import('../../src/runtime/core/ecs/world');
    const ids = await import('../../src/runtime/core/ecs/identityParents');
    sceneMod.sceneManager.resetForTesting();

    await sceneMod.sceneManager.loadScene(L1);
    const find = (name: string) => {
      let hit: unknown;
      getCurrentWorld().query(EntityAttributes).updateEach(([a]: [{ name: string }], e: unknown) => { if (a.name === name) hit = e; });
      return hit as Parameters<typeof ids.frameRootDoc>[1];
    };
    const doc = { rootLocalId: 1, entities: [{ localId: 1 }, { localId: 2, nodeGuid: '91000000-0000-4000-8000-00000000d0c2' }] };
    ids.noteFrameDoc(getCurrentWorld(), 'kit', doc, find('PRoot'));

    await sceneMod.sceneManager.loadScene(L2); // carries PRoot
    const carried = find('PRoot');
    expect(carried).toBeDefined();
    expect(ids.frameRootDoc(getCurrentWorld(), carried)).toEqual({ source: 'kit', doc });
    // Root only: the new world did not expand `kit`, so its per-source record stays empty.
    expect(ids.frameDocReader(getCurrentWorld(), () => undefined)('kit')).toBeUndefined();
  });
});
