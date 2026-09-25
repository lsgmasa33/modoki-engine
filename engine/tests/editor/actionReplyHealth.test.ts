/** Every health FAULT rides on every action reply; the expected non-fault states do not (#1553).
 *
 *  Action replies carry only the fields they changed — but a stale build, a stalled frame loop, a
 *  failed renderer, a lost GPU, a degraded boot and dropped edits must still reach the agent in the
 *  reply it is reading (a Play on a stale editor used to say `staleGameCode:true` there, and the first
 *  cut of #1553 silenced it). Each source is faulted here at the module the op reads it from, so
 *  dropping ANY key from `ACTION_HEALTH_KEYS` goes red — the review found a test named for
 *  `staleGameCode` that only checked `frameLoop`. The second half pins the inverse: a hidden window
 *  and a `pending` renderer are expected states, and must not ride as faults. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fault = vi.hoisted(() => ({ on: false }));

vi.mock('../../app/debug/hmrStaleness', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getHmrStatus: () => (fault.on
      ? { updates: 2, staleGameCode: true, discardedUnsavedEdits: true }
      : (orig.getHmrStatus as () => unknown)()),
  };
});
vi.mock('../../app/editor/gameBootFaults', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getGameBootFaults: () => (fault.on ? [{ file: 'g.ts', message: 'boom' }] : []) };
});
vi.mock('@modoki/engine/runtime', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const frame = orig.getFrameLoopHealth as () => Record<string, unknown>;
  const gate = orig.getRendererGateHealth as () => Record<string, unknown>;
  const gpu = orig.getGpuFaultState as () => unknown;
  return {
    ...orig,
    getFrameLoopHealth: () => ({ ...frame(), status: fault.on ? 'stalled' : 'hidden', recovered: 1 }),
    getRendererGateHealth: () => ({ ...gate(), status: fault.on ? 'failed' : 'pending', progress: '' }),
    getGpuFaultState: () => (fault.on ? { lost: true, reason: 'test' } : gpu()),
  };
});

import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps, ACTION_HEALTH_KEYS } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
beforeEach(() => { game = createTestWorld({}); setPlayState('stopped'); clearHistory(); markSceneSaved(); });
afterEach(() => { fault.on = false; game.dispose(); });

const ACTIONS = [
  ['set-gizmo', { mode: 'rotate' }],
  ['set-selection', { guids: [] }],
  ['stop', {}],
  ['undo', {}],
] as const;

describe('faulted: every health key rides on every action reply', () => {
  it.each(ACTIONS)('%s', async (op, params) => {
    fault.on = true;
    const reply = await runAgentOp(op, params) as Record<string, unknown>;
    for (const k of ACTION_HEALTH_KEYS) expect(reply, `${op} dropped ${k}`).toHaveProperty(k);
    expect(reply.staleGameCode).toBe(true);
  });
});

describe('healthy-but-unusual: a hidden window and a pending renderer are not faults', () => {
  it.each(ACTIONS)('%s', async (op, params) => {
    const reply = await runAgentOp(op, params) as Record<string, unknown>;
    expect(reply).not.toHaveProperty('frameLoop');
    expect(reply).not.toHaveProperty('rendererGate');
    expect(reply).not.toHaveProperty('staleGameCode');
  });

  it('…while get_editor_state still reports both, where they ARE useful', async () => {
    const state = await runAgentOp('editor-state', {}) as Record<string, unknown>;
    expect(state).toHaveProperty('frameLoop');
    expect(state).toHaveProperty('rendererGate');
  });
});
