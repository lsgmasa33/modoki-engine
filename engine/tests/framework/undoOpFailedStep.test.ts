/** #1681 — the agent `undo`/`redo` op tells a FAILED step from an empty stack.
 *
 *  A step whose closure throws is dropped from both stacks (#310), and the op used to answer the same bare
 *  `{did:false}` an empty stack gives — so an agent that applied, saved the prefab and undid (#1664's refusal) concluded
 *  there was nothing left to undo. Now: an empty stack is `ok` with `did:false`; a refused step (`UndoRefusedError`,
 *  nothing applied) is REFUSED_BY_OP; any other throw is PARTIAL. Each failure names the entry and says it was dropped.
 *
 *  Mutations, each checked: drop the `failed` branch in the op (both failure cases go red); map every failure to one
 *  code (the PARTIAL case goes red); build `failed` without the refusal's toast (the refused-message case goes red). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, pushAction } from '@modoki/engine/editor';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
beforeEach(() => { game = createTestWorld({}); setPlayState('stopped'); clearHistory(); markSceneSaved(); });
afterEach(() => game.dispose());

const refusing = (label: string) => ({ label, undo: async () => { throw new UndoRefusedError(`${label}: file changed`, 'x.prefab.json changed on disk since, and was left as it is'); }, redo: async () => {} });
const throwing = (label: string) => ({ label, undo: async () => { throw new Error('disk exploded'); }, redo: async () => {} });

describe('undoStep reports a throwing step as `failed`', () => {
  it('a refusal carries its user-facing reason; a throw its message; an empty stack neither', async () => {
    pushAction(refusing('Make prefab'));
    expect(await undoStep('undo')).toEqual({ did: false, label: 'Make prefab', refused: null, failed: { label: 'Make prefab', refused: true, error: 'x.prefab.json changed on disk since, and was left as it is' }, shortfall: null, dropped: false });
    pushAction(throwing('Delete x.png'));
    expect(await undoStep('undo')).toEqual({ did: false, label: 'Delete x.png', refused: null, failed: { label: 'Delete x.png', refused: false, error: 'disk exploded' }, shortfall: null, dropped: false });
    expect(await undoStep('undo')).toEqual({ did: false, label: null, refused: null, failed: null, shortfall: null, dropped: false });
  });
});

describe('the agent undo op', () => {
  it('an EMPTY stack is still ok with did:false', async () => {
    expect(await runAgentOp('undo', {})).toMatchObject({ did: false });
  });

  it('a REFUSED step is REFUSED_BY_OP, naming the entry, the reason, and that it was dropped', async () => {
    pushAction(refusing('Make prefab "Rig"'));
    const err = await runAgentOp('undo', {}).then(() => null, (e: unknown) => e as { code?: string; message: string });
    expect(err?.code).toBe('REFUSED_BY_OP');
    expect(err?.message).toContain('Make prefab "Rig"');
    expect(err?.message).toContain('changed on disk since');
    expect(err?.message).toContain('DROPPED');
    // It really is gone: the next undo reaches an empty stack, not the same refusal again.
    expect(await runAgentOp('undo', {})).toMatchObject({ did: false });
  });

  it('a step that THREW is PARTIAL — it may have applied part of itself', async () => {
    pushAction(throwing('Delete x.png'));
    const err = await runAgentOp('undo', {}).then(() => null, (e: unknown) => e as { code?: string; message: string });
    expect(err?.code).toBe('PARTIAL');
    expect(err?.message).toContain('disk exploded');
    expect(err?.message).toContain('DROPPED');
  });
});
