/** The human's unsaved-work gate (#1419): `decideUnsavedGate` + what each scope counts as lost.
 *
 *  The causes are driven through the REAL registries (the same public mark/clear APIs
 *  `unsavedCauseTable.test.ts` uses), not a mocked `unsavedChangeCauses` — the scope split is
 *  derived from the cause table, and a mocked causes object would assert the mock's shape. Only the
 *  modal and the save are injected, because those are the human and the disk. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  unsavedChangeCauses, markSceneSaved, causeSpecs, type UnsavedCauses,
} from '../../packages/modoki/src/editor/scene/serialize';
import { getEditVersion } from '../../packages/modoki/src/editor/undo/undoManager';
import { UNREACHABLE_STATE } from '../../packages/modoki/src/editor/undo/stateToken';
import { markAssetDirty, clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { markSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { markBaseSceneEdit, clearPendingBaseScenes } from '../../packages/modoki/src/editor/scene/pendingBaseScene';
import {
  parkMetaEdit, stampMetaReadPath, clearPendingMeta, clearMetaBaselines,
} from '../../packages/modoki/src/editor/scene/pendingMeta';
import {
  decideUnsavedGate, describeLostWork, confirmDiscardUnsaved, answerUnsavedGateRequest, editingPrefabName,
  confirmUnsavedBeforeBuild, type UnsavedGateDeps, type GateChoice,
} from '../../packages/modoki/src/editor/scene/unsavedGate';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';

// The modal is the human: only the default-deps tests below reach it, and they read what it was asked to show.
const modal = vi.hoisted(() => ({ openChoiceModal: vi.fn(async () => 'cancel') }));
vi.mock('../../packages/modoki/src/editor/components/choiceModal', () => modal);

/** One driver per cause, and whether a WORLD SWAP destroys it. Hand-written on purpose: the gate
 *  derives the split from `writtenBy`, so a list derived the same way would test the derivation
 *  against itself. The completeness test below makes a sixth cause fail here. */
const DRIVERS: Record<keyof UnsavedCauses, { drive: () => void; lostOnWorldSwap: boolean }> = {
  sceneDirty: { drive: () => markSceneSaved({ version: getEditVersion() - 1, state: UNREACHABLE_STATE }), lostOnWorldSwap: true },
  dirtyScenes: { drive: () => markSceneDirty('guid-of-a-loaded-base'), lostOnWorldSwap: true },
  // Parked, path-keyed module state: it SURVIVES a scene swap (guardUnsaved's consequence clause).
  dirtyAssetPaths: { drive: () => markAssetDirty('/assets/x.mat.json', 'material', { a: 1 }), lostOnWorldSwap: false },
  pendingBaseScenes: { drive: () => markBaseSceneEdit('/assets/scenes/child.scene.json', 'base-guid'), lostOnWorldSwap: false },
  pendingImportSettings: {
    drive: () => { parkMetaEdit('/assets/tex.png', stampMetaReadPath({ maxSize: 1024 }, '/assets/tex.png')); },
    lostOnWorldSwap: false,
  },
};

function clearEverything(): void {
  clearDirtyAssets();
  clearAllSceneDirty();
  clearPendingBaseScenes();
  clearPendingMeta();
  clearMetaBaselines();
  markSceneSaved();
}

/** Real causes; a scripted human; a save that runs `onSave` (to model a save that does or does
 *  not clear the work). */
function deps(choice: GateChoice, onSave: () => void = () => {}) {
  return {
    causes: unsavedChangeCauses,
    ask: vi.fn<UnsavedGateDeps['ask']>(async () => choice),
    save: vi.fn<UnsavedGateDeps['save']>(async () => { onSave(); }),
    warn: vi.fn<UnsavedGateDeps['warn']>(),
  } satisfies UnsavedGateDeps;
}

describe('unsaved-work gate (#1419)', () => {
  beforeEach(clearEverything);
  afterEach(clearEverything);

  it('DRIVERS covers exactly the causes the table declares — a sixth cause fails here', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(Object.keys(causeSpecs()).sort());
  });

  it('a clean editor proceeds without asking, in both scopes', async () => {
    for (const scope of ['world-swap', 'page-unload'] as const) {
      const d = deps('cancel');
      expect(await decideUnsavedGate('open scene B', scope, d)).toBe(true);
      expect(d.ask).not.toHaveBeenCalled();
    }
  });

  // One row per cause and scope: does THIS gesture ask about THIS work?
  for (const [cause, { drive, lostOnWorldSwap }] of Object.entries(DRIVERS)) {
    it(`${cause}: a world swap ${lostOnWorldSwap ? 'asks' : 'does NOT ask'}, a page unload asks`, async () => {
      drive();
      const swap = deps('cancel');
      expect(await decideUnsavedGate('open scene B', 'world-swap', swap)).toBe(!lostOnWorldSwap);
      expect(swap.ask).toHaveBeenCalledTimes(lostOnWorldSwap ? 1 : 0);

      const unload = deps('cancel');
      expect(await decideUnsavedGate('quit Modoki', 'page-unload', unload)).toBe(false);
      expect(unload.ask).toHaveBeenCalledTimes(1);
    });
  }

  it('Cancel stays, Discard proceeds — and neither saves', async () => {
    DRIVERS.sceneDirty.drive();
    const cancel = deps('cancel');
    expect(await decideUnsavedGate('open scene B', 'world-swap', cancel)).toBe(false);
    const discard = deps('discard');
    expect(await decideUnsavedGate('open scene B', 'world-swap', discard)).toBe(true);
    expect(cancel.save).not.toHaveBeenCalled();
    expect(discard.save).not.toHaveBeenCalled();
  });

  it('Save proceeds when the save leaves nothing unsaved', async () => {
    DRIVERS.sceneDirty.drive();
    const d = deps('save', () => markSceneSaved());
    expect(await decideUnsavedGate('open scene B', 'world-swap', d)).toBe(true);
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.warn).not.toHaveBeenCalled();
  });

  // The case a trusting gate gets wrong: a cancelled Save As on an untitled scene or a failed write
  // returns normally, and proceeding would destroy exactly the work the human asked to keep.
  it('Save that leaves work unsaved STAYS and says what is still unsaved', async () => {
    DRIVERS.sceneDirty.drive();
    const d = deps('save' /* the save writes nothing */);
    expect(await decideUnsavedGate('open scene B', 'world-swap', d)).toBe(false);
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn.mock.calls[0][0]).toMatch(/unsaved scene changes/);
  });

  it('a Save that THROWS stays and says so — no unhandled rejection from a void gesture', async () => {
    DRIVERS.sceneDirty.drive();
    const d = { ...deps('save'), save: vi.fn<UnsavedGateDeps['save']>(async () => { throw new Error('disk full'); }) };
    expect(await decideUnsavedGate('open scene B', 'world-swap', d)).toBe(false);
    expect(d.warn.mock.calls[0][0]).toMatch(/Save failed — disk full/);
  });

  it('the modal is told what would be lost, named from the table labels', async () => {
    DRIVERS.sceneDirty.drive();
    DRIVERS.dirtyAssetPaths.drive();
    const d = deps('cancel');
    await decideUnsavedGate('quit Modoki', 'page-unload', d);
    const lost = d.ask.mock.calls[0][1] as string[];
    expect(lost).toContain('unsaved scene changes');
    expect(lost.some((l) => l.includes('1 unsaved asset edit') && l.includes('/assets/x.mat.json'))).toBe(true);
  });

  it('names at most three paths per cause and counts the rest', () => {
    for (let i = 0; i < 5; i++) markAssetDirty(`/assets/m${i}.mat.json`, 'material', { a: i });
    const [line] = describeLostWork(unsavedChangeCauses(), 'page-unload');
    expect(line).toMatch(/^5 unsaved asset edits: /);
    expect(line).toMatch(/\+2 more$/);
  });

  // In prefab edit the live world is the prefab, so its edits are the prefab's (Unity's Prefab Mode: "Prefab 'X' has
  // been modified"). The dialog read "unsaved scene changes" there, naming the scene the open had already saved.
  // Mutation: drop the `editingPrefab` branch in describeLostWork — the line reads "unsaved scene changes" again; stop
  // passing `editing` to the re-read after Save — the warn names the scene.
  it('in prefab edit the live world\'s edits name the prefab; a scene is named only when a scene is unsaved', async () => {
    DRIVERS.sceneDirty.drive();
    const d = { ...deps('save'), editingPrefab: () => 'Crate' };
    expect(await decideUnsavedGate('leave prefab edit', 'world-swap', d)).toBe(false);
    expect(d.ask.mock.calls[0][1]).toEqual(['unsaved changes to prefab "Crate"']);
    expect(d.warn.mock.calls[0][0]).toBe('Not leave prefab edit: still unsaved after Save — unsaved changes to prefab "Crate".');
    DRIVERS.dirtyScenes.drive();
    expect(describeLostWork(unsavedChangeCauses(), 'world-swap', 'Crate')).toEqual(['unsaved changes to prefab "Crate"', '1 unsaved edit in another loaded scene']);
    // Accept side: outside prefab edit the same cause still names the scene.
    expect(describeLostWork(unsavedChangeCauses(), 'world-swap')[0]).toBe('unsaved scene changes');
  });

  it('one prompt at a time: a second request while one is open answers false without asking', async () => {
    DRIVERS.sceneDirty.drive();
    let answer!: (c: GateChoice) => void;
    const first: UnsavedGateDeps = { ...deps('cancel'), ask: () => new Promise<GateChoice>((r) => { answer = r; }) };
    const second = deps('discard');
    const p1 = confirmDiscardUnsaved('open scene B', 'world-swap', first);
    expect(await confirmDiscardUnsaved('close the editor window', 'page-unload', second)).toBe(false);
    expect(second.ask).not.toHaveBeenCalled();
    answer('discard');
    expect(await p1).toBe(true);
    // …and the slot is released once the first is answered.
    expect(await confirmDiscardUnsaved('open scene C', 'world-swap', deps('discard'))).toBe(true);
  });
});

describe('answerUnsavedGateRequest — the renderer end of main\'s close/quit question', () => {
  it('ACKs before asking, then sends the final answer', async () => {
    const replies: unknown[] = [];
    let answer!: (v: boolean) => void;
    const done = answerUnsavedGateRequest({ id: 7, action: 'quit Modoki' }, (d) => replies.push(d),
      () => new Promise<boolean>((r) => { answer = r; }));
    // The human has not answered yet — the ack must already be out, or main reads a hung renderer.
    expect(replies).toEqual([{ id: 7, stage: 'ack' }]);
    answer(true);
    await done;
    expect(replies).toEqual([{ id: 7, stage: 'ack' }, { id: 7, stage: 'final', proceed: true }]);
  });

  it('asks with page-unload scope, and a throwing gate keeps the window', async () => {
    const replies: Array<{ stage: string; proceed?: boolean }> = [];
    const confirm = vi.fn(async () => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await answerUnsavedGateRequest({ id: 1, action: 'reload the editor' }, (d) => replies.push(d), confirm);
    err.mockRestore();
    expect(confirm).toHaveBeenCalledWith('reload the editor', 'page-unload');
    expect(replies[1]).toEqual({ id: 1, stage: 'final', proceed: false });
  });

  it('ignores a request with no numeric id', async () => {
    const reply = vi.fn();
    await answerUnsavedGateRequest({ action: 'x' }, reply, async () => true);
    expect(reply).not.toHaveBeenCalled();
  });
});

// The prefab-name BINDING (close-out review): the gate test above injects the name, so it could not see the default deps
// or the Build gate drop it. Mutations: drop `editingPrefab: editingPrefabName` from DEFAULT_DEPS — the leave gate names
// the scene; drop `editingPrefabName()` from confirmUnsavedBeforeBuild — so does the Build gate; answer from the store
// flag alone in editingPrefabName — the stale-flag and other-session cases name a prefab.
describe('the prefab-edit name, as the editor binds it', () => {
  const GUID = 'c0a7e000-0000-4000-8000-000000000001';
  const world = (path: string | null) => vi.spyOn(sceneManager, 'getCurrent').mockReturnValue((path === null ? null : { path }) as never);
  const session = (s: { path: string; guid: string; name: string } | null) => {
    if (s) useEditorStore.getState().openPrefabEditor(s, null); else useEditorStore.getState().closePrefabEditor();
  };
  beforeEach(() => { clearEverything(); modal.openChoiceModal.mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); session(null); });

  it('names the session only while the live world is that session\'s', () => {
    world(`/__prefab-edit__/${GUID}`);
    session({ path: '/assets/prefabs/crate.prefab.json', guid: GUID, name: 'Crate' });
    expect(editingPrefabName()).toBe('Crate');
    session({ path: '/assets/prefabs/crate.prefab.json', guid: GUID, name: '' });
    expect(editingPrefabName()).toBe('crate.prefab.json');
    // A world that outlived its session, or another session's: a prefab world, with no name to give.
    session({ path: '/assets/prefabs/other.prefab.json', guid: 'another', name: 'Other' });
    expect(editingPrefabName()).toBe('');
    session(null);
    expect(editingPrefabName()).toBe('');
    // A flag that outlived its world: a scene.
    world('/assets/scenes/main.scene.json');
    session({ path: '/assets/prefabs/crate.prefab.json', guid: GUID, name: 'Crate' });
    expect(editingPrefabName()).toBeNull();
    expect(describeLostWork({ ...unsavedChangeCauses(), sceneDirty: true }, 'world-swap', '')).toEqual(['unsaved changes to the prefab being edited']);
  });

  it('the leave gate and the Build gate both show the prefab\'s name', async () => {
    world(`/__prefab-edit__/${GUID}`);
    session({ path: '/assets/prefabs/crate.prefab.json', guid: GUID, name: 'Crate' });
    DRIVERS.sceneDirty.drive();
    expect(await confirmDiscardUnsaved('leave prefab edit', 'world-swap')).toBe(false);
    expect(await confirmUnsavedBeforeBuild('build for web')).toBe(false);
    const shown = modal.openChoiceModal.mock.calls.map((c) => (c as unknown as [{ details: string[] }])[0].details);
    expect(shown).toEqual([['unsaved changes to prefab "Crate"'], ['unsaved changes to prefab "Crate"']]);
  });
});
