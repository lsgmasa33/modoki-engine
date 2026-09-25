/** #1424 — `modoki_prefab edit-exit` refuses while the prefab world holds unsaved edits.
 *
 *  edit-exit reloads the return scene, which discards the prefab-edit world. It had no unsaved-work
 *  guard, so it answered ok:true over an unsaved delete (observed live on Court), with the undo
 *  stack gone. Driven through `runAgentOp` against the real op; only the two prefabEdit entry
 *  points are mocked — `isEditingPrefab` (entering prefab-edit for real needs a mocked
 *  SceneManager, see prefabEditUnsavedProbe.test.ts) and `exitPrefabEditing`, which is the swap
 *  whose NOT happening is the assertion. The unsaved state is the REAL cause table. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { markSceneSaved, clearHistory, clearDirtyAssets, markAssetDirty } from '@modoki/engine/editor';
import { getEditVersion, pushAction, undo } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

const prefab = vi.hoisted(() => ({ editing: true, exit: vi.fn(async () => '/assets/scenes/main.scene.json') }));
vi.mock('../../packages/modoki/src/editor/scene/prefabEdit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEditingPrefab: () => prefab.editing,
  exitPrefabEditing: () => prefab.exit(),
}));

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  prefab.editing = true;
  prefab.exit.mockClear();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
});
afterEach(() => {
  game?.dispose(); game = undefined;
  clearDirtyAssets();
  markSceneSaved();
  vi.unstubAllGlobals();
});

/** An unsaved edit in the (prefab-edit) world: the edit version moves past its saved baseline. */
const dirtyTheWorld = () => markSceneSaved(getEditVersion() - 1);

describe('prefab edit-exit and unsaved prefab-world edits (#1424)', () => {
  it('refuses with REQUIRES_SAVE and does NOT leave prefab-edit mode', async () => {
    dirtyTheWorld();
    await expect(runAgentOp('prefab', { prefabAction: 'edit-exit' })).rejects.toMatchObject({ code: 'REQUIRES_SAVE' });
    expect(prefab.exit).not.toHaveBeenCalled();
  });

  it('the refusal names edit-save, not save_all (save_all refuses in prefab-edit mode)', async () => {
    dirtyTheWorld();
    const err = await runAgentOp('prefab', { prefabAction: 'edit-exit' }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/edit-save/);
    expect(String((err as Error).message)).not.toMatch(/Run modoki_save_all to write all of it/);
  });

  it('discardUnsaved:true exits deliberately', async () => {
    dirtyTheWorld();
    const r = await runAgentOp('prefab', { prefabAction: 'edit-exit', discardUnsaved: true }) as { ok: boolean; wasEditing: boolean };
    expect(r).toMatchObject({ ok: true, wasEditing: true });
    expect(prefab.exit).toHaveBeenCalledTimes(1);
  });

  it('the legacy `force` alias also exits (resave-prefabs.sh relies on it, with its output discarded)', async () => {
    dirtyTheWorld();
    const r = await runAgentOp('prefab', { prefabAction: 'edit-exit', force: true }) as { ok: boolean; wasEditing: boolean };
    expect(r).toMatchObject({ ok: true, wasEditing: true });
    expect(prefab.exit).toHaveBeenCalledTimes(1);
  });

  // #1424 review: edit-save writes the prefab world only; save_all writes parked work even in
  // prefab-edit mode. A parked-only refusal that named edit-save sent the agent round a loop.
  it('a PARKED-only refusal in prefab-edit names save_all, not edit-save', async () => {
    markAssetDirty('/assets/particles/fx-1424.particle.json', 'particle', { emitter: {} });
    const err = await runAgentOp('prefab', { prefabAction: 'edit-exit' }).catch((e: Error) => e);
    const msg = String((err as Error).message);
    expect(msg).toMatch(/Run modoki_save_all to write the parked entries/);
    expect(msg).not.toMatch(/edit-save/);
    expect(prefab.exit).not.toHaveBeenCalled();
  });

  it('new-scene in prefab-edit gives the prefab-edit refusal, not "save first"', async () => {
    dirtyTheWorld();
    const err = await runAgentOp('new-scene', {}).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/UNSAVED work/);
  });

  it('a clean prefab world exits without asking', async () => {
    const r = await runAgentOp('prefab', { prefabAction: 'edit-exit' }) as { ok: boolean; wasEditing: boolean };
    expect(r).toMatchObject({ ok: true, wasEditing: true });
    expect(prefab.exit).toHaveBeenCalledTimes(1);
  });

  it('not in prefab-edit mode stays the wasEditing:false no-op, even with unsaved scene work', async () => {
    prefab.editing = false;
    dirtyTheWorld();
    const r = await runAgentOp('prefab', { prefabAction: 'edit-exit' }) as { ok: boolean; wasEditing: boolean };
    expect(r).toMatchObject({ ok: true, wasEditing: false });
    expect(prefab.exit).not.toHaveBeenCalled();
  });

  it('outside prefab-edit mode a refusal still names save_all (load-scene)', async () => {
    prefab.editing = false;
    dirtyTheWorld();
    const err = await runAgentOp('load-scene', { path: '/assets/scenes/other.scene.json' }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/Run modoki_save_all to write all of it/);
  });
});

/** #1579 — the gate reads the world once the undo in flight has landed. An undo's dirty mark comes at its END, so a
 *  gate read during the step passed a world the step then dirtied, and the swap (which waits for the step) discarded
 *  it with no refusal. One op stands for the four that share `guardUnsavedAfterUndo` (load-scene, new-scene, prefab
 *  edit-open, edit-exit). Mutation: drop the helper's wait — this goes red (the exit runs). */
describe('the agent unsaved-work gate and an undo in flight (#1579)', () => {
  it('an undo still running when edit-exit arrives: the gate waits for it, sees its dirty mark, and refuses', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    pushAction({ label: 'Edit', undo: () => gate, redo: () => {} });
    markSceneSaved(); // saved after the edit: clean until the undo lands
    const step = undo();
    for (let i = 0; i < 5; i++) await Promise.resolve(); // the step is running

    const exit = runAgentOp('prefab', { prefabAction: 'edit-exit' });
    exit.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    open();
    expect(await step).toBe(true);
    await expect(exit).rejects.toMatchObject({ code: 'REQUIRES_SAVE' });
    expect(prefab.exit).not.toHaveBeenCalled();
  });
});
