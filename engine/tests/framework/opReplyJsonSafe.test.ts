/** #1068 — an `Error` anywhere in an op result reaches the agent as TEXT on BOTH editor transports.
 *
 *  Both transports end in a bare `JSON.stringify` the renderer does not own (Vite's `hot.send`; the
 *  backend's response write after Electron's IPC). So every assertion here JSON-encodes the reply the
 *  way the wire does and reads THAT string. Asserting on the reply object would pass with the raw
 *  Error still inside it, which is exactly the state that serialized to `{}`.
 *
 *  The Electron case drives the REAL `bridge.on('request')` handler with a fake bridge
 *  (`opRefusalRelay.test.ts`'s pattern), because a fix wired into only one transport passes every test
 *  that drives the other. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, emit, clearJournal, setJournalEnabled } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { opReplyFor } from '../../app/debug/opRefusal';
import { registerAgentOp, relayResponseFor } from '../../app/debug/agentBridge';

registerAllTraits();

/** What the wire carries: the reply, JSON-encoded with no replacer. */
const wire = (reply: unknown): string => JSON.stringify(reply);

describe('opReplyFor renders an Error inside a result as text (#1068)', () => {
  it('a nested Error survives a bare JSON.stringify', async () => {
    const out = wire(await opReplyFor(() => ({ events: [{ payload: { error: new Error('nested boom') } }] })));
    expect(out).toContain('Error: nested boom');
    expect(out).not.toContain('"error":{}');
  });

  it("hands a root toJSON the key 'result', which is what the transport's stringify passes", async () => {
    const seen: string[] = [];
    await opReplyFor(() => ({ toJSON: (k: string) => { seen.push(k); return 1; } }));
    expect(seen).toEqual(['result']);
  });

  it('a result with nothing to render is sent as the SAME object (accept side)', async () => {
    const result = { ok: true, list: [1, { a: 'b' }] };
    const reply = await opReplyFor(() => result) as { result: unknown };
    expect(reply.result).toBe(result);
  });
});

describe('the HMR transport — relayResponseFor over the real journal-events op', () => {
  let game: TestWorld | undefined;
  beforeEach(() => { game = createTestWorld({}); clearJournal(); setJournalEnabled(true); });
  afterEach(() => { clearJournal(); game?.dispose(); game = undefined; });

  it('a journal payload carrying an Error reads as text, not {}', async () => {
    emit('probe.caught-failure', { tag: 't', error: new Error('probe error inside payload') });
    const out = wire(await relayResponseFor({ id: 1, op: 'journal-events', params: {} }));
    expect(out).toContain('"tag":"t"');
    expect(out).toContain('Error: probe error inside payload');
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
    fire: (event: string, payload: unknown) => {
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

  it('an Error in a result is sent as text', async () => {
    registerAgentOp('test-1068-ipc-error-in-result', () => ({ caught: new Error('ipc boom') }));
    const { bridge, fire } = fakeBridge();
    win.__modokiElectron = { bridge };
    const { initAgentBridge } = await import('../../app/debug/agentBridge');
    initAgentBridge();
    fire('request', { id: 7, op: 'test-1068-ipc-error-in-result', params: {} });
    await vi.waitFor(() => {
      expect(bridge.send.mock.calls.some(([event]) => event === 'response')).toBe(true);
    });
    const response = bridge.send.mock.calls.find(([event]) => event === 'response')![1];
    expect(wire(response)).toContain('Error: ipc boom');
  });
});
