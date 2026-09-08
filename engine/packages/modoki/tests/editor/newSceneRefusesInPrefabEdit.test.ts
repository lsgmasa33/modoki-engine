/** `newScene()` must REFUSE while a prefab is being edited (owner, 2026-09-07, #853).
 *
 *  Before this, Assets → Create Scene during prefab-edit produced an ambiguous half-state that
 *  two separate guards elsewhere had to work around: the synthetic prefab-edit path stayed live
 *  under a real scene path (`saveScene`'s conjunction), and `currentSceneKey()` had to narrow to
 *  the synthetic prefix to stop Stop() reloading a blank world under the previous scene's
 *  identity. Refusing outright is what lets both of those stop being special cases.
 *
 *  ⚠️ **Why mocking `SceneManager` is legitimate HERE and would not be in `newScene.test.ts`.**
 *  The mechanism under test in this file is the refusal PREDICATE — does `newScene` reach the
 *  world swap at all — so the swap itself is exactly the thing that should be a spy. The swap
 *  mechanism is covered against the REAL manager next door (`newScene.test.ts`: onWorldSwap
 *  fires, the world is populated before listeners run, no scenes are left loaded). Mocking it
 *  there would be #838's defect — a test that mocks away the thing it claims to cover.
 *
 *  ⚠️ The CONTROL case at the bottom is load-bearing. "It threw" would pass just as happily if
 *  `newScene` threw for some unrelated reason (a mis-wired mock, a missing trait registration),
 *  and "the swap did not happen" would pass if the swap never happened on ANY path. The control
 *  proves the same call succeeds and DOES reach the swap once the world is not a prefab-edit
 *  world — i.e. that the refusal is what makes the difference, not the harness. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';

let currentPath: string | null = null;
const replaceWorldContent = vi.fn(async (populate: (w: object) => void) => {
  // Behave enough like the real thing that the control case is a genuine success path:
  // populate is what spawns the starter entities, and the real manager always calls it.
  populate(createWorld());
});
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (currentPath ? { path: currentPath } : null),
    getLoadedScenes: () => new Map(),
    replaceWorldContent,
  },
}));

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

const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');
const { Transform } = await import('../../src/runtime/core/traits/Transform');
const { Camera } = await import('../../src/runtime/traits/Camera');
const { Environment } = await import('../../src/three/traits/Environment');
const { Light } = await import('../../src/three/traits/Light');
const { setCurrentWorld } = await import('../../src/runtime/core/ecs/world');
const { registerTrait } = await import('../../src/runtime/core/ecs/traitRegistry');
const { newScene, NewSceneRefusedError, getCurrentScenePath, setCurrentScenePath } =
  await import('../../src/editor/scene/serialize');
const { PREFAB_EDIT_SCENE_PREFIX, isPrefabEditWorld } =
  await import('../../src/editor/scene/prefabEditWorld');

function registerAll() {
  registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum', options: ['', '3d', '2d', 'ui'] }, guid: { type: 'string' } } });
  registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } });
  registerTrait({ name: 'Camera', trait: Camera, category: 'component', fields: { fov: { type: 'number' } } });
  registerTrait({ name: 'Environment', trait: Environment, category: 'component', fields: { hdrPath: { type: 'string' }, intensity: { type: 'number' } } });
  registerTrait({ name: 'Light', trait: Light, category: 'component', fields: { lightType: { type: 'enum', options: ['ambient', 'directional', 'point', 'spot'] }, color: { type: 'color' }, intensity: { type: 'number' } } });
}

describe('newScene() during prefab edit', () => {
  beforeEach(() => {
    replaceWorldContent.mockClear();
    setCurrentWorld(createWorld());
    registerAll();
    setCurrentScenePath('/assets/scenes/alpha.json');
  });

  it('refuses, with a NewSceneRefusedError naming what to do', async () => {
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}320bf1fc`;
    expect(isPrefabEditWorld()).toBe(true);   // the premise, not the assertion

    await expect(newScene('/assets/scenes/beta.json')).rejects.toThrow(NewSceneRefusedError);
    await expect(newScene('/assets/scenes/beta.json')).rejects.toThrow(/exit prefab edit mode/i);
  });

  it('refuses BEFORE touching the world or the editor scene path', async () => {
    // The refusal has to be worth more than an error message: a refusal that had already
    // swapped the world, or already repointed the editor at a file it then never wrote,
    // would leave the editor in a worse state than the half-state it exists to prevent.
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}320bf1fc`;

    await expect(newScene('/assets/scenes/beta.json')).rejects.toThrow(NewSceneRefusedError);

    expect(replaceWorldContent).not.toHaveBeenCalled();
    expect(getCurrentScenePath()).toBe('/assets/scenes/alpha.json');
  });

  it('CONTROL: the same call succeeds and reaches the swap when the world is not a prefab-edit world', async () => {
    currentPath = null;
    expect(isPrefabEditWorld()).toBe(false);

    await expect(newScene('/assets/scenes/beta.json')).resolves.toBeUndefined();

    expect(replaceWorldContent).toHaveBeenCalledTimes(1);
    expect(getCurrentScenePath()).toBe('/assets/scenes/beta.json');
  });
});
