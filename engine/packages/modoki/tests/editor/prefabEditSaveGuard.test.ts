/** Cmd+S in the prefab-edit world must never offer "Save Scene As".
 *
 *  ⚠️ **The bug, as reported: "prefab cannot be saved — when I press cmd+s it opens a new file
 *  dialog."** Prefab-edit deliberately sets the scene path to null so a normal save cannot target a
 *  real file — but `saveScene`'s no-path branch then treated null as *"first save, ask for a name"*
 *  and opened the native Save-As panel. Accepting it would have written the prefab-edit world —
 *  the prefab PLUS its throwaway scaffolding (key light, ambient, HDR, the Canvas2D host and the
 *  centring stage) — into a brand-new scene file.
 *
 *  How it was reached: an exit whose scene reload failed left the world synthetic while clearing the
 *  `editingPrefab` flag, so `isEditingPrefab()` returned false and Cmd+S fell through to `saveAll()`.
 *  That specific route is fixed (see resolveReturnScene), but the flag can desync in more than one
 *  way, so the SAVE PATH itself has to refuse. It asks the WORLD, not the flag — the flag is the
 *  thing that was wrong.
 *
 *  ⚠️ The control case at the bottom is load-bearing: without it, "the dialog was not opened" would
 *  pass just as happily if `saveScene` had thrown early or the mock were mis-wired. It proves the
 *  dialog branch is genuinely live and that the guard is what suppresses it. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';

let currentPath: string | null = null;
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (currentPath ? { path: currentPath } : null),
    getLoadedScenes: () => new Map(),
  },
}));

// setCurrentScenePath persists the path for the editor's "reopen last scene"; this suite runs in
// node, where localStorage does not exist. Stub it — the persistence is not what is under test.
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

const saveAssetDialog = vi.fn(async () => null); // null = the human cancelled
vi.mock('../../src/editor/utils/saveDialog', () => ({ saveAssetDialog }));

const { EntityAttributes } = await import('../../src/runtime/core/traits/EntityAttributes');
const { Transform } = await import('../../src/runtime/core/traits/Transform');
const { setCurrentWorld, registerEntity, indexEntityGuid } = await import('../../src/runtime/core/ecs/world');
const { registerTrait } = await import('../../src/runtime/core/ecs/traitRegistry');
const { setRunMode } = await import('../../src/runtime/core/playState');
const { saveScene, setCurrentScenePath } = await import('../../src/editor/scene/serialize');
const { PREFAB_EDIT_SCENE_PREFIX, isPrefabEditWorld } = await import('../../src/editor/scene/prefabEditWorld');

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum' }, guid: { type: 'string' } },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } },
  });
}

beforeEach(() => {
  saveAssetDialog.mockClear();
  currentPath = null;
  setRunMode('stopped');
  setCurrentScenePath(null); // what prefab-edit does, and the state the dialog branch keys on
  registerAll();
  const w = createWorld();
  setCurrentWorld(w);
  const e = w.spawn(EntityAttributes({ name: 'Thing', guid: 'g-thing' }), Transform({ x: 1 }));
  registerEntity(e); indexEntityGuid(e);
});

describe('isPrefabEditWorld', () => {
  it('reads the LIVE world, both directions', () => {
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}g-ship`;
    expect(isPrefabEditWorld()).toBe(true);
    currentPath = '/assets/scenes/main.scene.json';
    expect(isPrefabEditWorld()).toBe(false);
    currentPath = null;
    expect(isPrefabEditWorld(), 'no scene loaded is not a prefab-edit world').toBe(false);
  });
});

describe('saveScene refuses the prefab-edit world', () => {
  it('returns prefab-edit and opens NO dialog — even with the store flag absent', () => {
    // The exact failing state: synthetic world, null scene path, nothing claiming a prefab session.
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}320bf1fc`;
    return saveScene().then((r) => {
      expect(r.saved).toBe(false);
      expect(r.reason).toBe('prefab-edit');
      expect(saveAssetDialog, 'no "Save Scene As" panel — this is the reported bug')
        .not.toHaveBeenCalled();
    });
  });

  it('refuses an explicit path too — the scaffolding must not reach ANY file', async () => {
    // Save-As is not the only way in: a caller passing a path would otherwise write the prefab-edit
    // world straight to disk with no dialog at all, which is strictly worse.
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}320bf1fc`;
    const r = await saveScene({ path: '/assets/scenes/oops.scene.json' });
    expect(r.saved).toBe(false);
    expect(r.reason).toBe('prefab-edit');
  });

  it('ALLOWS the save when a real path is set, even though the live world is still synthetic', async () => {
    // ⚠️ The regression the first version of this guard caused. `newScene()` wipes the ECS world and
    // sets the editor's file path WITHOUT touching sceneManager, so after "Create Scene" from the
    // Assets panel during prefab-edit the live path is STILL the synthetic one. A guard keyed on
    // that alone refused to write the brand-new scene — silently, because neither the creatable's
    // create() nor Assets' runCreate checks the result. The real path is the discriminator: it means
    // the world is no longer the prefab's.
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}320bf1fc`;   // stale: newScene did not update it
    setCurrentScenePath('/assets/scenes/brand-new.scene.json');
    const r = await saveScene();
    expect(r.reason, 'not refused — this is a real scene being created').not.toBe('prefab-edit');
    expect(saveAssetDialog, 'and no dialog: it has a path already').not.toHaveBeenCalled();
  });

  // ── CONTROL ──────────────────────────────────────────────────────────────────
  it('a REAL scene with no path still reaches the dialog — so the assertions above mean something', async () => {
    currentPath = '/assets/scenes/main.scene.json';
    const r = await saveScene();
    expect(saveAssetDialog, 'the Save-As branch is genuinely live and reachable').toHaveBeenCalledTimes(1);
    expect(r.reason, 'the mock cancels, so nothing is written').toBe('cancelled');
  });
});
