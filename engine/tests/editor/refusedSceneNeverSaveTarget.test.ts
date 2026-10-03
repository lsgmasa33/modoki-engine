/** #2128 — a scene file this build REFUSED to read is never a save target.
 *
 *  OBSERVED on v0.7.3 and main (QA-SCENE-0009/0010): the editor booted into a scene one format ahead of it, refused it,
 *  ended the walk in "Booting an empty world" with the refused file still bound, and the next Cmd+S wrote the empty world
 *  over it (37 entities gone). The boot fallback named the last candidate without asking why it missed.
 *
 *  Two mechanisms, each tested on its own, because either alone keeps the file (a redundant property):
 *   - the boot fallback binds nothing the walk REFUSED (`walkBootScenes`, by outcome: a scene refused for a too-new BASE
 *     is readable itself, so no record of its own file could say so);
 *   - every write of a scene file refuses one a read refused, whatever bound it: `saveScene` (bound or explicit; a human
 *     Cmd+S is offered Save As instead) and Save All's dirty bases. A refused hot reload leaves the OLD world bound to
 *     the newer file — the same hole by another route — and a rename, an undo restore and a refused base each reached it
 *     before the #2128 review.
 *  Driven through the REAL `SceneManager` (only `fetch` and the Save As panel are stubbed), so the refused file it names
 *  — the primary or a base of its chain — is the one the loader stamps.
 *
 *  Mutation checked, 16 mutations, each red here and nothing unrelated: the walk ignoring refusals; no `saveScene` guard;
 *  no Save As offer; the hot reload, or `loadScene`, not recording; no forget after a load / after a hot reload; a forget
 *  on every `openedFromFile` (the undo restore); no `'bound'` forget; no `refusedIfCorrupt`; no base stamp; edit-open
 *  ignoring the refusal; no base guard in Save All; no re-key on a move; the boot refusal logged at error. Both
 *  mechanisms reverted together is the #2128 revert-run: "the boot walk" writes the empty world over Warp.
 *  NOT distinguishable: `forgetScenesRead`'s kept-base filter (its own doc comment says why). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dialog = vi.hoisted(() => ({ asked: 0 }));
// The Save As panel: counted and cancelled — a human Cmd+S over a refused file is offered it instead of the write.
vi.mock('../../packages/modoki/src/editor/utils/saveDialog', async (orig) => ({
  ...await orig<object>(),
  chooseNewAssetPath: async () => { dialog.asked += 1; return null; },
}));
import { createTestWorld, type TestWorld, setPlayState, SCENE_FORMAT_VERSION, sceneManager } from '@modoki/engine/runtime';
import { clearHistory, clearDirtyAssets } from '@modoki/engine/editor';
import {
  loadScene, saveScene, setCurrentScenePath, getCurrentScenePath, markSceneSaved, beginBootSceneWalk,
  adoptWorldReloadedFromDisk, unreadableSceneReason, clearUnreadableScenes, saveAll, applyMovesToOpenScene, type BootSceneWalk,
} from '../../packages/modoki/src/editor/scene/serialize';
import { walkBootScenes } from '../../packages/modoki/src/editor/createEditor';
import { withAdoption, _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { markSceneDirty, clearAllSceneDirty, isSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { getCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const WARP = '/assets/scenes/Warp.scene.json';
const OTHER = '/assets/scenes/Other.scene.json';
const BASE = '/assets/scenes/Base.scene.json';
const MISSING = '/assets/scenes/NotYet.scene.json';
const WARP2 = '/assets/scenes/Warp2.scene.json';
const scene = (id: string, version: number, extra: object = {}) =>
  JSON.stringify({ id, version, name: 'S', entities: [], ...extra });
const WARP_ID = '00002128-0000-4000-8000-000000000001';
const OTHER_ID = '00002128-0000-4000-8000-000000000002';
const BASE_ID = '00002128-0000-4000-8000-000000000003';

let game: TestWorld | undefined;
let walk: BootSceneWalk | null = null;
/** The project's files, as the dev server serves them. A path not here answers with its SPA fallback (index.html). */
const files = new Map<string, string>();
const writes: string[] = [];

beforeEach(() => {
  for (const k of ['log', 'warn', 'info', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  clearUnreadableScenes();
  clearAllSceneDirty();
  dialog.asked = 0;
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  setCurrentScenePath(null);
  markSceneSaved();
  files.clear();
  writes.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/api/write-file')) {
      writes.push(JSON.parse(init!.body!).path);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.startsWith('/api/')) return new Response('{}', { status: 404 });
    const body = files.get(u.split('?')[0]);
    return new Response(body ?? '<!doctype html><html></html>', { status: 200 });
  }));
});

afterEach(async () => {
  walk?.release(); walk = null;
  await new Promise<void>((r) => setTimeout(r, 0));
  await sceneManager.unloadAll(); // a scene left current makes the next boot walk read itself as overtaken
  _resetSceneAdoptionForTests();
  game?.dispose(); game = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The editor's boot, as `createEditor` runs it: the walk, then the fallback's bind when nothing loaded. */
async function boot(candidates: string[]): Promise<string | null> {
  walk = beginBootSceneWalk();
  const w = walk;
  const { loaded, fallbackPath } = await walkBootScenes(candidates, { canonicalize: async (p) => p, load: (p) => w.load(p), settle: () => w.settle() });
  if (loaded) return loaded;
  if (fallbackPath) setCurrentScenePath(fallbackPath, 'adopted');
  return null;
}

describe('booting into a scene this build refuses binds nothing (#2128)', () => {
  it('the boot walk: a refused only candidate is not bound, and a save cannot write over it', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    expect(await boot([WARP]), 'premise: nothing loaded').toBeNull();
    const r = await saveScene({ allowDialog: false });
    expect(writes, 'the empty world was written over the refused file').not.toContain(WARP);
    expect(r.saved).toBe(false);
    expect(getCurrentScenePath()).toBeNull(); // the fallback's own half: a save asks for a path instead
  });

  it('ACCEPT SIDE: a last candidate that does not EXIST yet is still bound, so a fresh project saves there', async () => {
    expect(await boot([MISSING]), 'premise: nothing loaded').toBeNull();
    expect(getCurrentScenePath()).toBe(MISSING);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(writes).toEqual([MISSING]);
  });

  it('a refused EARLIER candidate does not stop the walk loading the next one, and logs no error (#91)', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    files.set(OTHER, scene(OTHER_ID, SCENE_FORMAT_VERSION));
    expect(await boot([WARP, OTHER])).toBe(OTHER);
    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors.filter((t) => t.includes('Refused to load scene'))).toEqual([]);
  });

  it('a candidate refused because its BASE is too new is not bound either — it is readable, but was not read', async () => {
    files.set(OTHER, scene(OTHER_ID, SCENE_FORMAT_VERSION, { baseScene: BASE }));
    files.set(BASE, scene(BASE_ID, SCENE_FORMAT_VERSION + 1));
    expect(await boot([OTHER]), 'premise: nothing loaded').toBeNull();
    expect(unreadableSceneReason(OTHER), 'premise: only the base is unreadable').toBeUndefined();
    await saveScene({ allowDialog: false });
    expect(writes).toEqual([]);
    expect(getCurrentScenePath()).toBeNull();
  });
});

describe('saveScene never writes a file a read refused, whatever bound it (#2128)', () => {
  it('the refused file bound anyway is refused with the read\'s own reason, nothing written', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    expect(await loadScene(WARP)).toBe('refused');
    setCurrentScenePath(WARP, 'adopted'); // any binder that does not read the file — the pre-fix boot fallback was one
    const r = await saveScene({ allowDialog: false });
    expect(r).toMatchObject({ saved: false, reason: 'unreadable-file', path: WARP });
    expect(r.error).toMatch(/newer than this engine supports/);
    expect(writes).toEqual([]);
  });

  it('an explicit path naming a refused file (an agent save_all {path}) is refused too', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    files.set(OTHER, scene(OTHER_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(OTHER)).toBe('loaded');
    expect(await loadScene(WARP)).toBe('refused');
    expect(getCurrentScenePath(), 'premise: the refused open kept the previous scene').toBe(OTHER);
    expect((await saveScene({ path: WARP, allowDialog: false })).reason).toBe('unreadable-file');
    expect(writes).toEqual([]);
    // …and the scene that IS open still saves.
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(writes).toEqual([OTHER]);
  });

  it('a refused hot reload: the OLD world stays bound to the now-newer file, and a save does not write it', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(WARP)).toBe('loaded');
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1)); // a newer build wrote it outside
    await expect(adoptWorldReloadedFromDisk(WARP, () => sceneManager.loadScene(WARP))).rejects.toThrow(/newer than this engine/);
    expect(getCurrentScenePath(), 'premise: the old world is still bound').toBe(WARP);
    expect((await saveScene({ allowDialog: false })).reason).toBe('unreadable-file');
    expect(writes).toEqual([]);
  });

  it('a HUMAN save (allowDialog) of the refused bound file asks for another file instead of writing it', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(WARP)).toBe('loaded');
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    await adoptWorldReloadedFromDisk(WARP, () => sceneManager.loadScene(WARP)).catch(() => {});
    const r = await saveScene(); // Cmd+S
    expect(dialog.asked, 'the Save As panel was offered').toBe(1);
    expect(r.reason).toBe('cancelled');
    expect(writes).toEqual([]);
  });

  it('Save All does not write a dirty BASE whose file a hot reload refused', async () => {
    files.set(OTHER, scene(OTHER_ID, SCENE_FORMAT_VERSION, { baseScene: BASE }));
    files.set(BASE, scene(BASE_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(OTHER)).toBe('loaded');
    files.set(BASE, scene(BASE_ID, SCENE_FORMAT_VERSION + 1));
    await expect(adoptWorldReloadedFromDisk(OTHER, () => sceneManager.loadScene(OTHER, { forceReloadBases: [BASE_ID] })))
      .rejects.toThrow(/newer than this engine/);
    markSceneDirty(BASE_ID); // an edit to an entity the base owns
    const r = await saveAll({ allowDialog: false });
    expect(writes).not.toContain(BASE);
    expect(r.failed?.map((f) => f.path)).toContain(BASE);
    expect(isSceneDirty(BASE_ID), 'the edit is kept, not marked written').toBe(true);
  });

  it('an undo restore (a `baseScene: loaded` offer over a SNAPSHOT) does not lift the refusal', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(WARP)).toBe('loaded');
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    await adoptWorldReloadedFromDisk(WARP, () => sceneManager.loadScene(WARP)).catch(() => {});
    // applyPrefabUndo's offer shape: the scene's own key, `baseScene: 'loaded'`, a world rebuilt from a preloaded snapshot.
    await withAdoption('prefab-undo-restore', async (a) => { a.offer({ world: getCurrentWorld(), path: WARP, baseScene: 'loaded' }); });
    expect(unreadableSceneReason(WARP)).toBeDefined();
    expect((await saveScene({ allowDialog: false })).reason).toBe('unreadable-file');
    expect(writes).toEqual([]);
  });

  it('renaming the refused open file keeps the refusal under its new name', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(WARP)).toBe('loaded');
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    await adoptWorldReloadedFromDisk(WARP, () => sceneManager.loadScene(WARP)).catch(() => {});
    applyMovesToOpenScene([{ from: WARP, to: WARP2 }]);
    expect(getCurrentScenePath(), 'premise: the editor followed the rename').toBe(WARP2);
    expect((await saveScene({ allowDialog: false })).reason).toBe('unreadable-file');
    expect(writes).toEqual([]);
  });

  it('a later successful HOT RELOAD of the file lifts the refusal', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(WARP)).toBe('loaded');
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    await adoptWorldReloadedFromDisk(WARP, () => sceneManager.loadScene(WARP)).catch(() => {});
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION));
    await adoptWorldReloadedFromDisk(WARP, () => sceneManager.loadScene(WARP));
    expect(unreadableSceneReason(WARP)).toBeUndefined();
  });

  it('a later successful read of a chain lifts its refused BASE too', async () => {
    files.set(OTHER, scene(OTHER_ID, SCENE_FORMAT_VERSION, { baseScene: BASE }));
    files.set(BASE, scene(BASE_ID, SCENE_FORMAT_VERSION + 1));
    expect(await loadScene(OTHER)).toBe('refused');
    files.set(BASE, scene(BASE_ID, SCENE_FORMAT_VERSION));
    expect(await loadScene(OTHER)).toBe('loaded');
    expect(unreadableSceneReason(BASE)).toBeUndefined();
  });

  it('a later successful read of the file lifts the refusal', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    expect(await loadScene(WARP)).toBe('refused');
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION)); // the outside writer put a readable version back
    expect(await loadScene(WARP)).toBe('loaded');
    expect(unreadableSceneReason(WARP)).toBeUndefined();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(writes).toEqual([WARP]);
  });

  it('a save the user asked for (a bind: Save As\'s Replace, Create Scene) lifts the refusal', async () => {
    files.set(WARP, scene(WARP_ID, SCENE_FORMAT_VERSION + 1));
    expect(await loadScene(WARP)).toBe('refused');
    setCurrentScenePath(WARP); // 'bound'
    expect(unreadableSceneReason(WARP)).toBeUndefined();
  });
});

describe('which file a read refused (#2128)', () => {
  it('corrupt JSON is REFUSED and recorded, like a too-new file — its bytes exist', async () => {
    files.set(WARP, '{"id": oops');
    expect(await loadScene(WARP)).toBe('refused');
    expect(unreadableSceneReason(WARP)).toMatch(/not valid JSON/);
  });

  it('ACCEPT SIDE: a MISSING file fails and is not recorded — there is nothing on disk to protect', async () => {
    expect(await loadScene(MISSING)).toBe('failed');
    expect(unreadableSceneReason(MISSING)).toBeUndefined();
  });

  it('a refused BASE of the chain records the base, not the scene that was asked for', async () => {
    files.set(OTHER, scene(OTHER_ID, SCENE_FORMAT_VERSION, { baseScene: BASE }));
    files.set(BASE, scene(BASE_ID, SCENE_FORMAT_VERSION + 1));
    expect(await loadScene(OTHER)).toBe('refused');
    expect(unreadableSceneReason(BASE)).toMatch(/newer than this engine supports/);
    expect(unreadableSceneReason(OTHER)).toBeUndefined();
  });
});
