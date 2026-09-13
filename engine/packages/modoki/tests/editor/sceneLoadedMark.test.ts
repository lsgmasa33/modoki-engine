/** SceneManager.loadScene marks the world it promotes as holding a loaded scene (#1135), BEFORE the
 *  promote — so the first `onWorldSwap` listener (and the first GAME tick) against that world can
 *  already tell it from the pre-scene boot window. `resolveCanvas2DHost` is the consumer.
 *
 *  Harness copied from sceneIdStability.test.ts: real `sceneManager.loadScene` over a mocked `fetch`. */

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

const SCENE_PATH = '/assets/scenes/mark.json';
const SCENE_BODY = {
  id: '4bc54ae4-0000-4000-8000-00000000abcd',
  version: 9,
  resources: [],
  entities: [{ id: 3, traits: { Transform: true, EntityAttributes: { name: 'Island', guid: 'g-island' } } }],
};

let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  // completeResponse fills in text() — the loaders read the body as text. See tests/stubs/assetResponse.ts.
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => structuredClone(body) });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

beforeEach(async () => {
  vi.resetModules();
  fetchResponses = { [SCENE_PATH]: SCENE_BODY };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

async function setup() {
  const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
  const { loadedScenePath, PREFAB_EDIT_SCENE_PREFIX } = await import('../../src/runtime/core/ecs/sceneLoaded');
  const { onWorldSwap, getCurrentWorld } = await import('../../src/runtime/core/ecs/worldRegistry');
  sceneManager.resetForTesting();
  return { sceneManager, loadedScenePath, PREFAB_EDIT_SCENE_PREFIX, onWorldSwap, getCurrentWorld };
}

describe('loadScene marks its world as a loaded scene (#1135)', () => {
  it('the promoted world carries the scene path, and already does when onWorldSwap fires', async () => {
    const { sceneManager, loadedScenePath, onWorldSwap, getCurrentWorld } = await setup();
    expect(loadedScenePath(getCurrentWorld()), 'a world no scene was loaded into is unmarked').toBeUndefined();
    const seenAtSwap: Array<string | undefined> = [];
    const off = onWorldSwap((next) => { seenAtSwap.push(loadedScenePath(next)); });
    try {
      await sceneManager.loadScene(SCENE_PATH);
    } finally {
      off();
    }
    expect(loadedScenePath(getCurrentWorld())).toBe(SCENE_PATH);
    expect(seenAtSwap).toEqual([SCENE_PATH]);
  });

  // The #1135 review: the editor reloads Play-mode and timeline-preview snapshots through
  // `loadScene(path ?? '', { preloaded })`, and enters prefab edit through a synthetic path. Neither is
  // a scene FILE, and marking them made a blank scene's second Play report a missing host.
  it('an untitled snapshot reload (path "") is NOT marked', async () => {
    const { sceneManager, loadedScenePath, getCurrentWorld } = await setup();
    await sceneManager.loadScene('', { preloaded: structuredClone(SCENE_BODY) as never });
    expect(sceneManager.getCurrent(), 'premise: the load promoted a world').not.toBeNull();
    expect(loadedScenePath(getCurrentWorld())).toBeUndefined();
  });

  it('the prefab-edit world is NOT marked', async () => {
    const { sceneManager, loadedScenePath, PREFAB_EDIT_SCENE_PREFIX, getCurrentWorld } = await setup();
    await sceneManager.loadScene(`${PREFAB_EDIT_SCENE_PREFIX}some-guid`, { preloaded: structuredClone(SCENE_BODY) as never });
    expect(sceneManager.getCurrent()?.path, 'premise: the load promoted the prefab-edit world')
      .toBe(`${PREFAB_EDIT_SCENE_PREFIX}some-guid`);
    expect(loadedScenePath(getCurrentWorld())).toBeUndefined();
  });
});
