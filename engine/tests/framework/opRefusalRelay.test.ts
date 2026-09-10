/** #1012 — a refusal thrown as `OpRefusal` reaches the backend as a CODED envelope, on BOTH relay
 *  transports.
 *
 *  ⚠️ The transport half is the one worth testing hardest. The HMR relay answers through
 *  `relayResponseFor`; the Electron IPC handler inside `initAgentBridge` has its own reply code and
 *  cannot share `relayResponseFor`. A conversion wired into only one of them passes every test that
 *  drives the other — so the Electron case below goes through the REAL `bridge.on('request')`
 *  handler, with a fake bridge (the `agentBridgeManifestAdditiveLoad.test.ts` pattern), rather than
 *  calling `opReplyFor` directly. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { OpRefusal, opReplyFor } from '../../app/debug/opRefusal';
import { registerAgentOp, relayResponseFor } from '../../app/debug/agentBridge';

registerAllTraits();

describe('opReplyFor — what one op run sends back', () => {
  it('an OpRefusal is a RESULT carrying its code and options, not an error', async () => {
    const r = await opReplyFor(() => { throw new OpRefusal('NOT_FOUND', 'gone', { options: ['a', 'b'] }); });
    expect(r).toEqual({ result: { ok: false, code: 'NOT_FOUND', error: 'gone', options: ['a', 'b'] } });
  });

  it('omits `options` when the refusal has none, rather than sending an undefined key', async () => {
    const r = await opReplyFor(() => { throw new OpRefusal('REQUIRES_SAVE', 'save first'); });
    expect(r).toEqual({ result: { ok: false, code: 'REQUIRES_SAVE', error: 'save first' } });
    expect(Object.keys((r as { result: object }).result)).not.toContain('options');
  });

  it('a plain Error stays an ERROR — it names no code, so it must not be dressed as one', async () => {
    expect(await opReplyFor(() => { throw new Error('boom'); })).toEqual({ error: 'boom' });
  });

  it('an awaited rejection is caught the same way as a synchronous throw', async () => {
    expect(await opReplyFor(async () => { throw new OpRefusal('PARTIAL', 'half'); }))
      .toEqual({ result: { ok: false, code: 'PARTIAL', error: 'half' } });
  });

  it('a normal return is the result, untouched', async () => {
    expect(await opReplyFor(() => ({ ok: true, n: 1 }))).toEqual({ result: { ok: true, n: 1 } });
  });
});

describe('the HMR transport — relayResponseFor', () => {
  it('relays an OpRefusal as a coded result, not an error', async () => {
    const r = await relayResponseFor({ id: 3, op: 'x' }, () => true,
      async () => { throw new OpRefusal('AMBIGUOUS', 'pick one'); });
    expect(r).toEqual({ id: 3, result: { ok: false, code: 'AMBIGUOUS', error: 'pick one' } });
  });
});

type Handler = (data: unknown) => void;

function fakeBridge() {
  const handlers = new Map<string, Handler[]>();
  return {
    bridge: {
      on: (event: string, cb: Handler) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      send: vi.fn(),
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of handlers.get(event) ?? []) cb(payload);
    },
  };
}

describe('the Electron IPC transport — the real bridge.on("request") handler', () => {
  let win: typeof window & { __modokiElectron?: { bridge?: unknown } };

  beforeEach(() => {
    win = window as typeof window & { __modokiElectron?: { bridge?: unknown } };
    delete win.__modokiElectron;
  });
  afterEach(() => { delete win.__modokiElectron; });

  async function answer(op: string) {
    const { bridge, emit } = fakeBridge();
    win.__modokiElectron = { bridge };
    const { initAgentBridge } = await import('../../app/debug/agentBridge');
    initAgentBridge();
    emit('request', { id: 41, op, params: {} });
    await vi.waitFor(() => {
      expect(bridge.send.mock.calls.some(([event]) => event === 'response')).toBe(true);
    });
    return bridge.send.mock.calls.find(([event]) => event === 'response')![1];
  }

  it('sends an OpRefusal back as a coded RESULT — the packaged editor sees the code too', async () => {
    registerAgentOp('test-1012-ipc-refusal', () => { throw new OpRefusal('NOT_FOUND', 'stale guid', { options: ['g1'] }); });
    expect(await answer('test-1012-ipc-refusal'))
      .toEqual({ id: 41, result: { ok: false, code: 'NOT_FOUND', error: 'stale guid', options: ['g1'] } });
  });

  it('still sends a plain Error back as an error (accept side)', async () => {
    registerAgentOp('test-1012-ipc-plain', () => { throw new Error('internal'); });
    expect(await answer('test-1012-ipc-plain')).toEqual({ id: 41, error: 'internal' });
  });
});
