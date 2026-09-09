/** #889 phase 2 — the `resolve-unsaved` probe while the editor is in PREFAB-EDIT mode.
 *
 *  ## Why this needs its own file
 *
 *  `resolveUnsavedOp.test.ts` pins the general shape: a dirty live world with no scene path is
 *  reported under a marker instead of being dropped. It cannot reach THIS case, because the probe
 *  asks `isPrefabEditWorld()` — whether `sceneManager`'s current scene is a `/__prefab-edit__/`
 *  world — and that needs a mocked `sceneManager`, which is a whole-file decision.
 *
 *  ⚠️ The probe asks the WORLD, not the `editingPrefab` store flag, and the two can disagree in
 *  both directions. The flag is used only to NAME the prefab once the world has answered.
 *
 *  ## What was actually wrong
 *
 *  `serialize.ts` nulls `_currentScenePath` on entering prefab-edit **on purpose**, so an ordinary
 *  save cannot target the prefab world. The probe's `sceneDirty` row was
 *  `causes.sceneDirty && primaryScenePath ? [row] : []` — so for the whole of prefab-edit it
 *  answered `holds: []` with `covers` naming all four registries. Not an `unknown`, which every
 *  Node gate refuses on: a **false clear**, which every Node gate proceeds past. Edit a prefab,
 *  leave it unsaved, and `/api/duplicate-asset` would copy the pre-edit bytes and
 *  `/api/unused-assets` would feed the cleanup dialog a graph the prefab is missing from.
 *
 *  ## The property that matters
 *
 *  The prefab is reported under **its own asset-root path**, not a marker — because that is what
 *  makes a PATH-SCOPED ask work, and `/api/validate-prefab` is exactly such an ask. A version of
 *  this fix that reported prefab-edit under the pathless marker would satisfy the sibling file's
 *  cases and still leave validate-prefab unable to see the one document it validates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** `isPrefabEditWorld()` reads `sceneManager.getCurrent()?.path` and asks whether it starts with
 *  `/__prefab-edit__/`. Mutable here so one file can drive both sides of that branch — a fixture
 *  pinned to the prefab-edit world could not show the non-prefab case still behaves. */
let currentScene: { path: string } | null = null;
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => currentScene,
    loadScene: async () => {},
    getLoadedScenes: () => new Map(),
  },
}));

import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { PREFAB_EDIT_SCENE_PREFIX } from '../../packages/modoki/src/editor/scene/prefabEditWorld';
import {
  setCurrentScenePath, markSceneSaved, unsavedChangeCauses,
} from '../../packages/modoki/src/editor/scene/serialize';
import { getEditVersion } from '../../packages/modoki/src/editor/undo/undoManager';
import { clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { clearPendingMeta, clearMetaBaselines } from '../../packages/modoki/src/editor/scene/pendingMeta';
import { clearPendingBaseScenes } from '../../packages/modoki/src/editor/scene/pendingBaseScene';
import { clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';

// Same stub the other editor suites use — `setCurrentScenePath(path)` persists the last-scene key.
vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });

registerEditorAgentOps();

type Hold = { path: string; registry: string; detail?: string };
type Reply = { ok?: boolean; holds?: Hold[]; covers?: string[] };
const resolve = (params: unknown) => runAgentOp('resolve-unsaved', params) as Promise<Reply>;
const liveScenePaths = (r: Reply) =>
  (r.holds ?? []).filter((h) => h.registry === 'liveScene').map((h) => h.path);

const PREFAB = { path: '/games/x/assets/prefabs/Badge.prefab.json', guid: 'badge-guid', name: 'Badge' };

/** Enter prefab-edit the way the editor does: a `/__prefab-edit__/` world AND the store flag, with
 *  no scene path. The WORLD is what the probe reads; the flag only supplies the prefab's path. Both
 *  are set here because that is the real state — the cases below drive each half missing on
 *  purpose, and those are the interesting ones. */
const enterPrefabEdit = (prefab = PREFAB) => {
  currentScene = { path: `${PREFAB_EDIT_SCENE_PREFIX}${prefab.guid}` };
  useEditorStore.setState({ editingPrefab: prefab, prefabReturnScenePath: '/assets/scenes/main.scene.json' });
  setCurrentScenePath(null);
};
const dirtyTheWorld = () => markSceneSaved(getEditVersion() - 1);

const reset = () => {
  currentScene = null;
  useEditorStore.setState({ editingPrefab: null, prefabReturnScenePath: null });
  setCurrentScenePath(null);
  markSceneSaved(getEditVersion());
  clearPendingMeta(); clearMetaBaselines();
  clearDirtyAssets(); clearPendingBaseScenes(); clearAllSceneDirty();
};
beforeEach(reset);
afterEach(reset);

describe('resolve-unsaved in prefab-edit mode (#889 phase 2)', () => {
  it('CONTROL — prefab-edit with a CLEAN world reports nothing', async () => {
    // The accept side, and it runs first on purpose: every "it reports the prefab" assertion below
    // is only meaningful if the probe is capable of saying nothing in this same fixture.
    enterPrefabEdit();
    expect(unsavedChangeCauses().sceneDirty).toBe(false);

    expect(liveScenePaths(await resolve({}))).toEqual([]);
  });

  it('reports the PREFAB by its own asset-root path, not a marker', async () => {
    enterPrefabEdit();
    dirtyTheWorld();
    expect(unsavedChangeCauses().sceneDirty, 'the world is dirty').toBe(true);

    const r = await resolve({});
    expect(liveScenePaths(r), 'this was [] before the fix').toEqual([PREFAB.path]);
    expect((r.holds ?? [])[0]?.detail).toMatch(/PREFAB open for editing/);
    // A full answer, not an `unknown` — which is what made the old reply dangerous rather than
    // merely incomplete: a gate refuses on `unknown` and proceeds on a covered empty `holds`.
    expect(r.covers).toEqual(['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene']);
  });

  it('a PATH-SCOPED ask about that prefab matches — this is what /api/validate-prefab does', async () => {
    // The property the route depends on. Reporting prefab-edit under the pathless marker would
    // pass the global case above and leave this one empty, i.e. validate-prefab would disclose
    // nothing about the very document it just read off disk.
    enterPrefabEdit();
    dirtyTheWorld();

    expect(liveScenePaths(await resolve({ paths: [PREFAB.path] }))).toEqual([PREFAB.path]);
  });

  it('a path-scoped ask about a DIFFERENT prefab does not match', async () => {
    enterPrefabEdit();
    dirtyTheWorld();

    expect(liveScenePaths(await resolve({ paths: ['/games/x/assets/prefabs/Other.prefab.json'] }))).toEqual([]);
  });

  it('falls back to the GUID when the store entry carries no path', async () => {
    // Not decoration: the alternative is dropping the row, and "I could not translate it" reported
    // as "nothing is held" is the failure this whole probe exists to prevent. The manifest is not
    // seeded in this suite, so the guid is what survives.
    enterPrefabEdit({ ...PREFAB, path: undefined as unknown as string });
    dirtyTheWorld();

    const r = await resolve({});
    expect(liveScenePaths(r)).toEqual([PREFAB.guid]);
    expect((r.holds ?? [])[0]?.detail).toMatch(/resolves to no manifest entry/);
  });

  it('a prefab-edit WORLD whose store flag is already cleared is still reported', async () => {
    // ⚠️ The third outcome, and it only became REACHABLE when this branch started asking the world
    // instead of the store flag. `serialize.ts` documents the state: an exit whose scene reload
    // failed leaves the world synthetic with `editingPrefab` cleared. The probe must still say the
    // world is dirty — it is what would be written — and must NOT claim a guid was reported, which
    // the old two-way detail string did.
    currentScene = { path: `${PREFAB_EDIT_SCENE_PREFIX}orphaned` };
    useEditorStore.setState({ editingPrefab: null, prefabReturnScenePath: null });
    setCurrentScenePath(null);
    dirtyTheWorld();

    const r = await resolve({});
    expect(liveScenePaths(r)).toEqual(['(unsaved live world — no file on disk)']);
    expect((r.holds ?? [])[0]?.detail).toMatch(/editor flag is already cleared/);
    expect((r.holds ?? [])[0]?.detail, 'no guid was reported, so it must not say one was')
      .not.toMatch(/reported by guid/);
  });

  it('a stale store flag with no prefab-edit WORLD is not treated as prefab-edit', async () => {
    // `isEditingPrefab()` clears the flag in this case and returns false, so the dirty world is
    // pathless rather than a prefab. Pinned because the fix reads that helper rather than the
    // store directly, and a version that read the store would report a prefab that is not open.
    useEditorStore.setState({ editingPrefab: PREFAB, prefabReturnScenePath: null });
    currentScene = { path: '/assets/scenes/main.scene.json' };
    setCurrentScenePath(null);
    dirtyTheWorld();

    expect(liveScenePaths(await resolve({}))).toEqual(['(unsaved live world — no file on disk)']);
  });
});
