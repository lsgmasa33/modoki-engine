/** SceneManager's multi-scene internals (base-scene plan, Phases 1-2):
 *   - `data.baseScene` is tracked and exposed via getCurrentBaseScene() (Phase 1).
 *     Not yet wired into the load/carry pipeline (that's Phase 5) — this pins only
 *     that the ref is recorded on load and cleared on unload/reset.
 *   - `getLoadedScenes()` (Phase 2, replacing the old single `currentScene` field
 *     with a `loadedScenes` map + primaryId) agrees with getCurrent() for a plain
 *     load — a chain of one, since no scene declares `baseScene` yet.
 *
 *  Own file for the same reason as sceneManagerLifecycle.test.ts: a fresh module
 *  graph + koota counter, independent of SceneManager.test.ts's world budget. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
  };
});

const sceneOf = (name: string, baseScene?: string) => ({
  version: 10,
  resources: [],
  ...(baseScene ? { baseScene } : {}),
  entities: [{ id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name, parentId: 0 } } }],
});

beforeEach(async () => {
  vi.resetModules();
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/core/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;
});

async function setup() {
  const mod = await import('../../src/runtime/scene/SceneManager');
  mod.sceneManager.resetForTesting();
  return mod.sceneManager;
}

describe('SceneManager.getCurrentBaseScene', () => {
  it('is undefined for a scene with no baseScene ref', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level.json', { preloaded: sceneOf('Level') as never });
    expect(sceneManager.getCurrentBaseScene()).toBeUndefined();
  });

  it('records the baseScene ref after load', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level.json', { preloaded: sceneOf('Level', 'base-guid-1') as never });
    expect(sceneManager.getCurrentBaseScene()).toBe('base-guid-1');
  });

  it('updates on the next load, including clearing back to undefined', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level1.json', { preloaded: sceneOf('Level1', 'base-guid-1') as never });
    expect(sceneManager.getCurrentBaseScene()).toBe('base-guid-1');

    await sceneManager.loadScene('/level2.json', { preloaded: sceneOf('Level2') as never });
    expect(sceneManager.getCurrentBaseScene()).toBeUndefined();
  });

  it('is cleared by unloadAll', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level.json', { preloaded: sceneOf('Level', 'base-guid-1') as never });
    await sceneManager.unloadAll();
    expect(sceneManager.getCurrentBaseScene()).toBeUndefined();
  });
});

describe('SceneManager.getLoadedScenes', () => {
  it('a plain load returns exactly one primary entry matching getCurrent()', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level.json', { preloaded: sceneOf('Level') as never });

    const loaded = sceneManager.getLoadedScenes();
    expect(loaded.size).toBe(1);
    const current = sceneManager.getCurrent();
    expect(current).not.toBeNull();
    const entry = loaded.get(current!.id);
    expect(entry).toBeDefined();
    expect(entry!.path).toBe(current!.path);
    expect(entry!.role).toBe('primary');
  });

  it('a swap replaces the entry wholesale — still exactly one primary entry', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level1.json', { preloaded: sceneOf('Level1') as never });
    await sceneManager.loadScene('/level2.json', { preloaded: sceneOf('Level2') as never });

    const loaded = sceneManager.getLoadedScenes();
    expect(loaded.size).toBe(1);
    const current = sceneManager.getCurrent();
    expect(current!.path).toBe('/level2.json');
    expect(loaded.get(current!.id)?.role).toBe('primary');
  });

  it('is empty after unloadAll', async () => {
    const sceneManager = await setup();
    await sceneManager.loadScene('/level.json', { preloaded: sceneOf('Level') as never });
    await sceneManager.unloadAll();
    expect(sceneManager.getLoadedScenes().size).toBe(0);
    expect(sceneManager.getCurrent()).toBeNull();
  });
});
