/** #1823 — a step that REPORTS a shortfall without throwing (`reportUndoFailure`) is not a clean `did:true`.
 *
 *  Owner B (docs/refusal-reporting.md U1–U3): `runStep` opens a step window (`stepWindow.ts`), `reportUndoFailure`
 *  records into it, and `undoStep`'s result carries the shortfall. The agent's undo op answers PARTIAL with
 *  `entry:'moved'`; the human gets ONE toast per step (owner ruling F1, 2026-09-29). A world swap during the step is
 *  `dropped` — PARTIAL with `entry:'dropped'`. A batch keeps each sub's class (`runSequential`), and a forward batch's
 *  rollback never reports into a step that is running beside it (`runOnStepChain`). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { markSceneSaved, pushAction } from '@modoki/engine/editor';
import { reportUndoFailure, UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { undoStep, swapHistory, canRedo, _resetHistoryContexts, type UndoAction } from '../../packages/modoki/src/editor/undo/undoManager';
import { composeUndoActions, runAsCompositeAction } from '../../packages/modoki/src/editor/undo/compositeAction';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { opReplyFor, OpRefusal } from '../../app/debug/opRefusal';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
let toast: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  game = createTestWorld({}); setPlayState('stopped'); _resetHistoryContexts(); markSceneSaved();
  toast = vi.fn();
  useEditorStore.setState({ showToast: toast } as never);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { consoleError.mockRestore(); game.dispose(); });

/** A step that reports `details` and returns, as the 28 asset-undo sites do. */
const reporting = (label: string, details: string[], opts: { userFixable?: boolean } = {}): UndoAction => ({
  label,
  undo: async () => { await Promise.resolve(); for (const detail of details) reportUndoFailure({ direction: 'Undo', label, detail, ...opts }); },
  redo: async () => {},
});
const agentFailure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as OpRefusal);

describe('undoStep carries a reported shortfall', () => {
  it('report-and-return: the entry MOVES as usual, the result names every detail, and the human gets ONE toast', async () => {
    pushAction(reporting('Delete 2 items', ['a.png still in the trash', 'b.png still in the trash']));
    const r = await undoStep('undo');
    expect(r).toEqual({
      did: true, label: 'Delete 2 items', refused: null, failed: null, dropped: false,
      shortfall: { label: 'Delete 2 items', details: ['a.png still in the trash', 'b.png still in the trash'] },
    });
    expect(canRedo()).toBe(true); // moved, not dropped
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Undo of "Delete 2 items" did not fully apply — see the console', 'warn');
  });

  it('a collision keeps its own wording, still once per step', async () => {
    pushAction(reporting('Rename a.png', ['another file is now at a.png'], { userFixable: true }));
    await undoStep('undo');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain('something already exists at the original path');
  });

  it('report-and-CONTINUE: the rest of the step runs, and the shortfall still reaches the result', async () => {
    let finished = false;
    pushAction({ label: 'Apply to Prefab', undo: async () => {
      reportUndoFailure({ direction: 'Undo', label: 'Apply to Prefab', detail: 'the scene save conflicted' });
      await Promise.resolve();
      finished = true;
    }, redo: async () => {} });
    const r = await undoStep('undo');
    expect(finished).toBe(true);
    expect(r.shortfall?.details).toEqual(['the scene save conflicted']);
  });

  it('a step that reports nothing is did:true with no shortfall and no toast', async () => {
    pushAction({ label: 'Move', undo: async () => { await Promise.resolve(); }, redo: () => {} });
    expect(await undoStep('undo')).toMatchObject({ did: true, shortfall: null, dropped: false });
    expect(toast).not.toHaveBeenCalled();
  });

  it('a report with NO step open stays console-only, and does not leak into the next step', async () => {
    reportUndoFailure({ direction: 'Redo', label: 'Reorder', detail: 'a forward caller ran the closure directly' });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('a forward caller ran the closure directly'));
    expect(toast).not.toHaveBeenCalled();
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    expect((await undoStep('undo')).shortfall).toBeNull();
  });

  it('a world swap during the step is DROPPED: on neither stack, and said so', async () => {
    swapHistory('a.scene.json');
    pushAction({ label: 'Nudge', undo: async () => { await Promise.resolve(); swapHistory('b.scene.json'); }, redo: () => {} });
    const r = await undoStep('undo');
    expect(r).toMatchObject({ did: true, label: 'Nudge', dropped: true, shortfall: null });
    expect(canRedo()).toBe(false);
  });
});

describe('a batch keeps each sub-action\'s class (runSequential)', () => {
  const refusing = (label: string): UndoAction => ({ label, undo: async () => { throw new UndoRefusedError(`${label}: changed`, `${label} changed on disk`); }, redo: async () => {} });
  const applying = (label: string): UndoAction => ({ label, undo: async () => {}, redo: async () => {} });

  it('every sub REFUSED → the batch is refused (nothing applied), carrying each sub\'s reason', async () => {
    pushAction(composeUndoActions([refusing('A'), refusing('B')], { label: 'Batch' })!);
    const r = await undoStep('undo');
    expect(r.failed).toEqual({ label: 'Batch', refused: true, error: 'B changed on disk; A changed on disk' });
  });

  it('a refusal beside a sub that applied → not a refusal, and the message names the failed sub', async () => {
    pushAction(composeUndoActions([applying('A'), refusing('B')], { label: 'Batch' })!);
    const r = await undoStep('undo');
    expect(r.failed?.refused).toBe(false);
    expect(r.failed?.error).toContain('"B" refused (B changed on disk)');
    expect(r.failed?.error).toContain('1 of 2');
  });

  it('a sub that REPORTS lands in the batch step\'s shortfall', async () => {
    pushAction(composeUndoActions([applying('A'), reporting('B', ['b.png still in the trash'])], { label: 'Batch' })!);
    expect((await undoStep('undo')).shortfall).toEqual({ label: 'Batch', details: ['b.png still in the trash'] });
  });
});

describe('a forward batch\'s rollback never reports into a running step (the window is time, not ownership)', () => {
  it('a rollback report while a step is awaiting stays out of that step\'s result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    pushAction({ label: 'Async asset step', undo: async () => { await gate; }, redo: async () => {} });
    // A forward batch already in flight: its captured sub reports on undo, and its body fails once the step is running.
    let failBody!: () => void;
    const bodyFails = new Promise<void>((_, reject) => { failBody = () => reject(new Error('op 2 failed')); });
    const batch = runAsCompositeAction({ label: 'Mutate' }, async () => {
      pushAction(reporting('Sub', ['rollback could not restore x.png']));
      await bodyFails;
    }).catch((e: Error) => e.message);
    const step = undoStep('undo');
    await new Promise((r) => setTimeout(r, 0)); // the step is inside its await, window open
    failBody(); // → the batch rolls back while the step's window is open
    await new Promise((r) => setTimeout(r, 0));
    release();
    const r = await step;
    expect(r.shortfall).toBeNull();
    expect(await batch).toBe('op 2 failed');
    // It still ran, and was still reported — to the console, as a forward path's report always was.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('rollback could not restore x.png'));
  });
});

describe('the agent undo op', () => {
  it('a shortfall is PARTIAL, entry:"moved", naming what did not apply', async () => {
    pushAction(reporting('Delete x.png', ['x.png still in the trash']));
    const e = await agentFailure(runAgentOp('undo', {}));
    expect(e?.code).toBe('PARTIAL');
    expect(e?.entry).toBe('moved');
    expect(e?.message).toContain('x.png still in the trash');
    expect(e?.message).toContain('MOVED to the redo stack');
  });

  it('a dropped step is PARTIAL, entry:"dropped"', async () => {
    swapHistory('a.scene.json');
    pushAction({ label: 'Nudge', undo: async () => { await Promise.resolve(); swapHistory('b.scene.json'); }, redo: () => {} });
    const e = await agentFailure(runAgentOp('undo', {}));
    expect(e?.code).toBe('PARTIAL');
    expect(e?.entry).toBe('dropped');
    expect(e?.message).toContain('"Nudge"');
  });

  it('a throwing step (#1681) says its entry was dropped as a field too', async () => {
    pushAction({ label: 'Delete x.png', undo: async () => { throw new Error('disk exploded'); }, redo: async () => {} });
    expect((await agentFailure(runAgentOp('undo', {})))?.entry).toBe('dropped');
  });

  it('a step that reported AND threw keeps what it reported in the reply', async () => {
    const throwing: UndoAction = { label: 'T', undo: async () => { throw new Error('disk exploded'); }, redo: async () => {} };
    pushAction(composeUndoActions([reporting('B', ['b.png still in the trash']), throwing], { label: 'Batch' })!);
    const e = await agentFailure(runAgentOp('undo', {}));
    expect(e?.code).toBe('PARTIAL');
    expect(e?.message).toContain('disk exploded');
    expect(e?.message).toContain('b.png still in the trash');
  });

  it('a REDO shortfall says the entry moved to the undo stack, where the next undo reverts it', async () => {
    pushAction({ label: 'Import', undo: async () => {}, redo: async () => { reportUndoFailure({ direction: 'Redo', label: 'Import', detail: 'x.png not re-imported' }); } });
    await undoStep('undo');
    const e = await agentFailure(runAgentOp('redo', {}));
    expect(e?.entry).toBe('moved');
    expect(e?.message).toContain('MOVED to the undo stack as usual, so the next undo reverts it');
  });

  it('a clean step still answers ok', async () => {
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    expect(await runAgentOp('undo', {})).toMatchObject({ did: true });
  });

  it('the reply carries `entry` on the wire (opReplyFor)', async () => {
    const reply = await opReplyFor(() => { throw new OpRefusal('PARTIAL', 'x', { entry: 'moved' }); });
    expect(reply).toEqual({ result: { ok: false, code: 'PARTIAL', error: 'x', entry: 'moved' } });
  });
});
