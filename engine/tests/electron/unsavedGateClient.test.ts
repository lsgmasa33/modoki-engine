/** Main's side of the unsaved-work gate (#1419): the two-phase ask that lets a human take as long
 *  as they like over the modal while a HUNG renderer can never make the window unclosable. */

import { describe, it, expect, vi } from 'vitest';
import { createUnsavedGateClient, type UnsavedGateRequest } from '../../electron/unsavedGateClient';

function harness(opts: { deliver?: boolean } = {}) {
  const sent: UnsavedGateRequest[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const client = createUnsavedGateClient({
    send: (req) => { sent.push(req); return opts.deliver ?? true; },
    ackTimeoutMs: 3000,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const fireAckTimeout = () => { for (const t of timers) if (!t.cleared) t.fn(); };
  return { client, sent, timers, fireAckTimeout };
}

describe('unsaved-gate client (Electron main)', () => {
  it('proceeds at once when there is no renderer to ask', async () => {
    const { client } = harness({ deliver: false });
    expect(await client.ask('quit Modoki')).toBe(true);
    expect(client.pending()).toBe(false);
  });

  it('proceeds when the renderer never ACKs (hung) — the window must stay closable', async () => {
    const { client, fireAckTimeout } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = client.ask('close the editor window');
    expect(client.pending()).toBe(true);
    fireAckTimeout();
    expect(await p).toBe(true);
    warn.mockRestore();
  });

  it('once ACKed, waits for the human with no deadline, and honours Cancel', async () => {
    const { client, sent, timers, fireAckTimeout } = harness();
    const p = client.ask('quit Modoki');
    const { id } = sent[0];
    client.onReply({ id, stage: 'ack' });
    expect(timers[0].cleared).toBe(true);
    fireAckTimeout(); // nothing left armed — a slow human must not be overruled
    expect(client.pending()).toBe(true);
    client.onReply({ id, stage: 'final', proceed: false });
    expect(await p).toBe(false);
    expect(client.pending()).toBe(false);
  });

  it('a final proceed:true proceeds; a malformed final keeps the window', async () => {
    const { client, sent } = harness();
    const yes = client.ask('a');
    client.onReply({ id: sent[0].id, stage: 'ack' });
    client.onReply({ id: sent[0].id, stage: 'final', proceed: true });
    expect(await yes).toBe(true);

    const bad = client.ask('b');
    client.onReply({ id: sent[1].id, stage: 'final' });
    expect(await bad).toBe(false);
  });

  it('the renderer going away mid-question (releaseAll) proceeds', async () => {
    const { client, sent } = harness();
    const p = client.ask('open another project');
    client.onReply({ id: sent[0].id, stage: 'ack' });
    client.releaseAll();
    expect(await p).toBe(true);
  });

  it('ignores replies for unknown ids and non-objects', async () => {
    const { client, sent } = harness();
    const p = client.ask('a');
    client.onReply(null);
    client.onReply({ id: 999, stage: 'final', proceed: true });
    expect(client.pending()).toBe(true);
    client.onReply({ id: sent[0].id, stage: 'final', proceed: true });
    expect(await p).toBe(true);
  });
});
