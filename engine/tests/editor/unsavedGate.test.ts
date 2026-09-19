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
import { markAssetDirty, clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { markSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { markBaseSceneEdit, clearPendingBaseScenes } from '../../packages/modoki/src/editor/scene/pendingBaseScene';
import {
  parkMetaEdit, stampMetaReadPath, clearPendingMeta, clearMetaBaselines,
} from '../../packages/modoki/src/editor/scene/pendingMeta';
import {
  decideUnsavedGate, describeLostWork, confirmDiscardUnsaved, answerUnsavedGateRequest,
  type UnsavedGateDeps, type GateChoice,
} from '../../packages/modoki/src/editor/scene/unsavedGate';

/** One driver per cause, and whether a WORLD SWAP destroys it. Hand-written on purpose: the gate
 *  derives the split from `writtenBy`, so a list derived the same way would test the derivation
 *  against itself. The completeness test below makes a sixth cause fail here. */
const DRIVERS: Record<keyof UnsavedCauses, { drive: () => void; lostOnWorldSwap: boolean }> = {
  sceneDirty: { drive: () => markSceneSaved(getEditVersion() - 1), lostOnWorldSwap: true },
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
