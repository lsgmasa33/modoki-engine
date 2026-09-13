/** SceneManager.loadScene never promotes a world whose physics bodies cannot be stepped yet (#1175).
 *  On a cold load the physics systems skipped every tick until Rapier's lazy WASM init resolved, so
 *  a scene's first frames ran with no physics while step/journal/scene-state all reported success.
 *  The load now awaits the Rapier the STAGING world needs before the swap.
 *
 *  Harness copied from sceneLoadedMark.test.ts: real `sceneManager.loadScene` over a mocked `fetch`,
 *  with the REAL loaders (vi.resetModules gives every test a fresh, uninstantiated Rapier). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({
  name: '', isActive: true, sortOrder: 0, parentId: 0,
  layer: '' as '' | '3d' | '2d' | 'ui', guid: '', sourceScene: '',
});

// world.ts imports the REAL EntityAttributes directly for its guid index — see sceneLoadedMark.test.ts.
vi.mock('../../src/runtime/core/traits/EntityAttributes', () => ({ EntityAttributes }));

vi.mock('../../src/runtime/core/ecs/traitRegistry', async () => {
  // The REAL RigidBody2D, imported inside the factory so it is the same module instance
  // physicsReady.ts queries for — a local copy would never match and the test would pass vacuously.
  const { RigidBody2D } = await import('../../src/runtime/traits/RigidBody2D');
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {}, sourceScene: { hidden: true, runtimeOnly: true } } },
    { name: 'RigidBody2D', trait: RigidBody2D, category: 'component', fields: {} },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
    transformName: (name: string) => name,
  };
});

const BODY_SCENE = '/assets/scenes/body.json';
const EMPTY_SCENE = '/assets/scenes/empty.json';
const scene = (id: string, withBody: boolean) => ({
  id, version: 9, resources: [],
  entities: [{
    id: 3,
    traits: { Transform: true, EntityAttributes: { name: 'Crate', guid: 'g-crate' }, ...(withBody ? { RigidBody2D: true } : {}) },
  }],
});

let fetchResponses: Record<string, unknown> = {};

// @ts-expect-error mocking global
global.fetch = vi.fn(async (url: string) => {
  for (const [key, body] of Object.entries(fetchResponses)) {
    if (url.endsWith(key) || url === key) return completeResponse({ ok: true, json: async () => structuredClone(body) });
  }
  return completeResponse({ ok: false, status: 404, json: async () => ({}) });
});

beforeEach(async () => {
  vi.resetModules();
  fetchResponses = {
    [BODY_SCENE]: scene('4bc54ae4-0000-4000-8000-0000000b0d1e', true),
    [EMPTY_SCENE]: scene('4bc54ae4-0000-4000-8000-00000000e417', false),
  };
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
});

async function setup() {
  const { sceneManager } = await import('../../src/runtime/scene/SceneManager');
  const { onWorldSwap } = await import('../../src/runtime/core/ecs/worldRegistry');
  const { isRapierReady } = await import('../../src/runtime/physics/rapierLoader');
  const { RigidBody2D } = await import('../../src/runtime/traits/RigidBody2D');
  sceneManager.resetForTesting();
  return { sceneManager, onWorldSwap, isRapierReady, RigidBody2D };
}

describe('loadScene awaits physics before the swap (#1175)', () => {
  it('a scene with a RigidBody2D is promoted with Rapier2D ALREADY instantiated', async () => {
    const { sceneManager, onWorldSwap, isRapierReady, RigidBody2D } = await setup();
    expect(isRapierReady(), 'premise: a fresh module registry starts cold').toBe(false);
    const atSwap: Array<{ body: boolean; ready: boolean }> = [];
    const off = onWorldSwap((next) => { atSwap.push({ body: next.queryFirst(RigidBody2D) !== undefined, ready: isRapierReady() }); });
    try {
      await sceneManager.loadScene(BODY_SCENE);
    } finally {
      off();
    }
    // `body: true` is the premise that the scene really spawned a body the loader could see.
    expect(atSwap).toEqual([{ body: true, ready: true }]);
  });

  it('a scene with no bodies loads without instantiating Rapier', async () => {
    const { sceneManager, isRapierReady } = await setup();
    await sceneManager.loadScene(EMPTY_SCENE);
    expect(sceneManager.getCurrent(), 'premise: the load promoted a world').not.toBeNull();
    expect(isRapierReady()).toBe(false);
  });
});
