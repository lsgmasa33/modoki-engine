/** The generated `modoki` scripting object injected into `modoki_eval` code (#19). Built from
 *  the live op registry so it cannot drift — this proves GENERATION, not a hardcoded op list:
 *  every assertion registers a throwaway op and checks it shows up, rather than asserting a
 *  fixed name that happens to exist today. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerAgentOp, listAgentOps } from '../../app/debug/agentBridge';
import { kebabToCamel, makeEvalApi } from '../../app/editor/evalApi';
import { handleEval } from '../../app/debug/bridgeHelpers';

const mockBackendFetch = vi.fn();
vi.mock('@modoki/engine/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modoki/engine/editor')>();
  return { ...actual, backendFetch: (...args: unknown[]) => mockBackendFetch(...args) };
});

// withEditorActor/readEditorJournal/composite are exercised for real (registerAllTraits gives
// the ECS world compositeAction.test.ts's own runAsCompositeAction needs).
import { readEditorJournal, clearEditorJournal, editorEmit, setEditorJournalEnabled } from '@modoki/engine/editor';

registerAllTraits();

beforeEach(() => {
  mockBackendFetch.mockReset();
  clearEditorJournal();
  setEditorJournalEnabled(true);
});

describe('kebabToCamel', () => {
  it('maps real op names to their camelCase method name', () => {
    expect(kebabToCamel('layout-bounds')).toBe('layoutBounds');
    expect(kebabToCamel('set-timescale')).toBe('setTimescale');
    expect(kebabToCamel('editor-journal')).toBe('editorJournal');
    expect(kebabToCamel('scene-state')).toBe('sceneState');
  });
  it('is a no-op on a name with no hyphen', () => {
    expect(kebabToCamel('diagnose')).toBe('diagnose');
  });
});

describe('makeEvalApi().ops()', () => {
  it('lists every currently-registered op, including one just registered in this test', () => {
    registerAgentOp('probe-eval-api-op', () => 42);
    const api = makeEvalApi();
    const names = api.ops().map((o) => o.op);
    for (const op of listAgentOps()) expect(names).toContain(op);
    const entry = api.ops().find((o) => o.op === 'probe-eval-api-op');
    expect(entry?.method).toBe('modoki.probeEvalApiOp(params)');
  });
});

describe('makeEvalApi().call / generated methods', () => {
  it('call(op, params) invokes the registered handler with those params and returns its result', async () => {
    const handler = vi.fn((params: unknown) => ({ echoed: params }));
    registerAgentOp('probe-eval-api-call', handler);
    const api = makeEvalApi();
    const result = await api.call('probe-eval-api-call', { x: 1 });
    expect(handler).toHaveBeenCalledWith({ x: 1 });
    expect(result).toEqual({ echoed: { x: 1 } });
  });

  it('a generated camelCase method calls through to the SAME op as .call(...)', async () => {
    const handler = vi.fn((params: unknown) => ({ via: 'generated', params }));
    registerAgentOp('probe-generated-method', handler);
    const api = makeEvalApi();
    const result = await (api.probeGeneratedMethod as (p?: unknown) => Promise<unknown>)({ y: 2 });
    expect(handler).toHaveBeenCalledWith({ y: 2 });
    expect(result).toEqual({ via: 'generated', params: { y: 2 } });
  });

  it('a call is journaled with actor "agent" (withEditorActor wrapping)', async () => {
    registerAgentOp('probe-eval-api-actor', () => {
      editorEmit('!probe');
      return 'ok';
    });
    const api = makeEvalApi();
    await api.call('probe-eval-api-actor', {});
    const events = readEditorJournal();
    const probe = events.find((e) => e.type === '!probe');
    expect(probe?.source).toBe('agent');
  });
});

describe('makeEvalApi().api', () => {
  it('routes through backendFetch, not a raw fetch', async () => {
    mockBackendFetch.mockResolvedValue(new Response('{"ok":true}'));
    const api = makeEvalApi();
    await api.api('/api/list-assets', { method: 'GET' });
    expect(mockBackendFetch).toHaveBeenCalledWith('/api/list-assets', { method: 'GET' });
  });
});

describe('makeEvalApi().composite', () => {
  it('collapses fn()\'s edits into one undo entry (real runAsCompositeAction, real undo manager)', async () => {
    const { getAllEntities, findEntity } = await import('@modoki/engine/runtime');
    const {
      createEntityWithUndo, setActionCallback, pushAction, undo, clearHistory,
    } = await import('@modoki/engine/editor');
    setActionCallback(pushAction);
    clearHistory();
    const noSelect = () => {};

    const api = makeEvalApi();
    const created: number[] = [];
    await api.composite('spawn two', () => {
      const a = createEntityWithUndo('Create', 0, [
        { name: 'Transform', data: { x: 0 } },
        { name: 'EntityAttributes', data: { name: 'evalApiCompA' } },
      ], noSelect);
      const b = createEntityWithUndo('Create', 0, [
        { name: 'Transform', data: { x: 0 } },
        { name: 'EntityAttributes', data: { name: 'evalApiCompB' } },
      ], noSelect);
      if (a !== null) created.push(a);
      if (b !== null) created.push(b);
    });

    expect(created.every((id) => findEntity(id))).toBe(true);
    const before = getAllEntities().length;
    const undone = await undo();
    expect(undone).toBe(true); // one undo call reverts BOTH spawns
    expect(getAllEntities().length).toBe(before - created.length);
    expect(created.some((id) => findEntity(id))).toBe(false);
  });
});

describe('handleEval injection (bridgeHelpers)', () => {
  it('a passed second arg is visible inside the function body as `modoki`', async () => {
    const result = await handleEval('return modoki.ops().length', { ops: () => [1, 2, 3] });
    expect(result).toBe('3');
  });

  it('with no second arg, `modoki` is undefined (device-path shape, unchanged)', async () => {
    const result = await handleEval('return typeof modoki');
    expect(result).toBe('undefined');
  });
});

/** #19 x #28 interaction. `wait_for_edit` parks until the HUMAN does something, filtering on
 *  source:'human'. If the eval façade brackets that call in withEditorActor('agent'), the
 *  ambient actor is 'agent' for the whole park — so the very edit it waits for is tagged
 *  'agent', fails the filter, and the wait can never wake. An op that OBSERVES attribution
 *  must not itself be attributed (same reason agentEditorOps registers wait-for-edit and
 *  actor-lease via the unwrapped _registerAgentOp). */
describe('attribution-observing ops are not bracketed by the eval façade', () => {
  it('a human edit during modoki.waitForEdit() stays source:human and wakes the wait', async () => {
    const { waitForEditorJournal } = await import('@modoki/engine/editor');
    registerAgentOp('wait-for-edit', (p) => {
      void p;
      return waitForEditorJournal({ source: 'human' }, 2000);
    });
    const api = makeEvalApi();
    const parked = (api.waitForEdit as (p?: unknown) => Promise<unknown>)({});
    await new Promise((r) => setTimeout(r, 30));
    editorEmit('!select', { id: 1 });                       // the human clicks something
    const res = (await parked) as { events?: Array<{ source: string }>; timedOut?: boolean };
    expect(res.timedOut).not.toBe(true);
    expect(res.events?.length).toBeGreaterThan(0);
    expect(res.events?.[0]?.source).toBe('human');
  });
});
