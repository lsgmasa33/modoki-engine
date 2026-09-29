/** #1832 (agent half) — an agent op that records an undo entry must not overlap an undo/redo step.
 *
 *  A push made inside a step's window is dropped (`pushAction`): the window is TIME, so an agent edit that ran while a
 *  human's async undo was awaiting applied with no undo entry. Now: such an op is REFUSED while a step is queued or
 *  running, accepted once it has finished, and while it runs it holds new steps off (they refuse, never wait —
 *  docs/scene-loading.md § "Readers of the world"). Every op the editor registers is classified. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, getAllEntities } from '@modoki/engine/runtime';
import { markSceneSaved, pushAction } from '@modoki/engine/editor';
import { undoStep, undoLabel, _resetHistoryContexts, beginForwardEdit, undoRefusedReason, WORLD_SWITCH_STALL_WARN_MS, FORWARD_EDIT_MAX_HOLD_MS } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps, agentStepGate } from '../../app/editor/agentEditorOps';
import { UNDO_RECORDING_OPS, NON_RECORDING_OPS } from '../../app/editor/agentOpUndoClass';
import { runAgentOp, listAgentOps } from '../../app/debug/agentBridge';
import { makeEvalApi } from '../../app/editor/evalApi';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
beforeEach(() => { game = createTestWorld({}); setPlayState('stopped'); _resetHistoryContexts(); markSceneSaved(); });
afterEach(() => game.dispose());

/** An undo whose closure awaits until released — an asset or prefab undo waiting on the backend. */
function awaitingStep(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  pushAction({ label: 'Async asset step', undo: async () => { await gate; }, redo: async () => {} });
  return { release };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('an undo-recording agent op during a step', () => {
  it('is REFUSED while the step runs, and changes nothing', async () => {
    const { release } = awaitingStep();
    const step = undoStep('undo');
    try {
      await tick();
      const before = getAllEntities().length;
      const err = await runAgentOp('create-entity', { spec: { kind: 'empty' } }).then(() => null, (e: { code?: string; message: string }) => e);
      expect(err?.code).toBe('REFUSED_BY_OP');
      expect(err?.message).toContain('undo/redo step is still running');
      expect(getAllEntities().length).toBe(before);
    } finally { release(); await step; } // a failed assertion must not leave the step running into the next test
  });

  it('is ACCEPTED once the step has finished, and its entry is on the undo stack', async () => {
    const { release } = awaitingStep();
    const step = undoStep('undo');
    await tick();
    release();
    await step;
    await runAgentOp('create-entity', { spec: { kind: 'empty' } });
    expect(undoLabel()).not.toBe('');
    expect(undoLabel()).not.toBe('Async asset step');
  });

  it('a read-only op is not refused during a step', async () => {
    const { release } = awaitingStep();
    const step = undoStep('undo');
    try {
      await tick();
      await expect(runAgentOp('editor-state', {})).resolves.toBeTruthy();
    } finally { release(); await step; }
  });
});

describe('a step during an undo-recording agent op (the mirror race)', () => {
  it('is refused while the op holds, and runs once it has released', async () => {
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    const hold = agentStepGate('create-entity');
    try {
      expect(typeof hold).toBe('function');
      const refused = await undoStep('undo');
      expect(refused).toMatchObject({ did: false, refused: expect.stringContaining('agent edit is still landing') });
    } finally { if (typeof hold === 'function') hold(); }
    expect(await undoStep('undo')).toMatchObject({ did: true, label: 'Move' });
  });

  it('eval is NEVER gated — it is how an agent looks at a stalled step — but modoki.composite is', async () => {
    const { release } = awaitingStep();
    const step = undoStep('undo');
    try {
      await tick();
      expect(agentStepGate('eval')).toBeNull();
      const composite = makeEvalApi().composite as (label: string, fn: () => void) => Promise<void>;
      await expect(composite('Batch', () => {})).rejects.toMatchObject({ code: 'REFUSED_BY_OP' });
    } finally { release(); await step; }
  });

  it('modoki.composite holds steps off while its body runs, and releases after', async () => {
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    let during: unknown;
    const composite = makeEvalApi().composite as (label: string, fn: () => Promise<void>) => Promise<void>;
    await composite('Batch', async () => { during = await undoStep('undo'); });
    expect(during).toMatchObject({ did: false, refused: expect.stringContaining('agent edit is still landing') });
    expect(await undoStep('undo')).toMatchObject({ did: true, label: 'Move' });
  });
});

describe('the hold is released through runAgentOp, the path production takes', () => {
  it('after an op that succeeds, undo runs', async () => {
    await runAgentOp('create-entity', { spec: { kind: 'empty' } });
    expect(await undoStep('undo')).toMatchObject({ did: true, refused: null });
  });

  it('after an op whose handler THROWS, undo runs', async () => {
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    await expect(runAgentOp('create-entity', {})).rejects.toBeTruthy();
    expect(await undoStep('undo')).toMatchObject({ did: true, refused: null, label: 'Move' });
  });
});

describe('prefab is classified by action', () => {
  it('its recording actions are refused during a step; edit-open/exit/save and overrides are not (#1579 waits)', async () => {
    const { release } = awaitingStep();
    const step = undoStep('undo');
    try {
      await tick();
      for (const action of ['instantiate', 'create', 'detach', 'apply', 'revert']) {
        expect(agentStepGate('prefab', { action }), action).toMatchObject({ code: 'REFUSED_BY_OP' });
      }
      expect(agentStepGate('prefab', { prefabAction: 'apply' })).toMatchObject({ code: 'REFUSED_BY_OP' });
      for (const action of ['edit-open', 'edit-exit', 'edit-save', 'overrides']) {
        expect(agentStepGate('prefab', { action }), action).toBeNull();
      }
      expect(agentStepGate('prefab', { prefabAction: 'apply', dryRun: true }), 'a dry run records nothing').toBeNull();
      // …and through runAgentOp, the path production takes: the gate must be handed the params.
      await expect(runAgentOp('prefab', { prefabAction: 'apply', entityGuid: 'x' })).rejects.toMatchObject({ code: 'REFUSED_BY_OP' });
    } finally { release(); await step; }
  });
});

describe('every editor op is classified (agentOpUndoClass.ts)', () => {
  it('each registered op is in exactly one set, and each set names only registered ops', () => {
    const ops = listAgentOps();
    const unclassified = ops.filter((op) => !UNDO_RECORDING_OPS.has(op) && !NON_RECORDING_OPS.has(op));
    expect(unclassified, 'classify each new op: does it reach pushAction?').toEqual([]);
    expect(ops.filter((op) => UNDO_RECORDING_OPS.has(op) && NON_RECORDING_OPS.has(op))).toEqual([]);
    const registered = new Set(ops);
    expect([...UNDO_RECORDING_OPS, ...NON_RECORDING_OPS].filter((op) => !registered.has(op))).toEqual([]);
  });
});

describe('the forward-edit hold itself', () => {
  it('warns once it has held for the stall time, and not if released first', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const quick = beginForwardEdit();
      quick();
      vi.advanceTimersByTime(WORLD_SWITCH_STALL_WARN_MS + 1);
      expect(warn).not.toHaveBeenCalled();
      const stuck = beginForwardEdit();
      vi.advanceTimersByTime(WORLD_SWITCH_STALL_WARN_MS + 1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('an agent edit has held undo/redo'));
      stuck();
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });

  it('lets go at the bound, so an op that never settles cannot lock undo until a reload', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
      beginForwardEdit(); // never released — an eval timed out around it
      vi.advanceTimersByTime(FORWARD_EDIT_MAX_HOLD_MS - 1);
      expect(undoRefusedReason('undo')).toContain('agent edit is still landing');
      vi.advanceTimersByTime(2);
      expect(undoRefusedReason('undo')).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("released an agent edit's hold"));
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });

  it('a hold released after a test reset cannot drive the count below zero', () => {
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    const stale = beginForwardEdit();
    _resetHistoryContexts();
    stale(); // from before the reset: a no-op
    pushAction({ label: 'Move', undo: () => {}, redo: () => {} });
    const fresh = beginForwardEdit();
    try {
      expect(undoRefusedReason('undo')).toContain('agent edit is still landing');
    } finally { fresh(); }
  });
});
