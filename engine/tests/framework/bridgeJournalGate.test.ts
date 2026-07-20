/** N12 — journaling must turn ON when a debug client attaches, not on the first
 *  `journal-events` read. A shipped game boots with `setJournalEnabled(false)`
 *  (main.tsx), so events before that first read were silently lost — and a full page
 *  reload (`engine.reload` → window.location.reload) re-ran main.tsx and re-disabled
 *  recording WITHOUT firing `connectionChanged` (the native TCP socket persists across
 *  the reload). The bridge now enables journaling on `connectionChanged {connected}`
 *  AND on init when `getStatus()` reports a client already attached (the reload case).
 *
 *  Module state (bridge `initialized` guard, journal `_enabled`) is reset per scenario
 *  via vi.resetModules() + dynamic imports, so both imports land in the same fresh
 *  registry generation and share one journal-module instance. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: {} as Record<string, (data: unknown) => void>,
  clientConnectedAtInit: false,
  getStatusCalls: 0,
}));

vi.mock('capacitor-game-debug', () => ({
  GameDebug: {
    startServer: async () => ({ port: 9095 }),
    getStatus: async () => {
      h.getStatusCalls++;
      return { running: true, clientConnected: h.clientConnectedAtInit, port: 9095 };
    },
    addListener: async (name: string, fn: (data: unknown) => void) => {
      h.listeners[name] = fn;
      return { remove() {} };
    },
    sendResponse: async () => ({ ok: true }),
  },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

/** Fresh module generation: journal disabled (as a shipped game's main.tsx does), then
 *  the bridge initialized. Returns the journal module for assertions. */
async function bootShippedGame() {
  vi.resetModules();
  h.listeners = {};
  h.getStatusCalls = 0;
  const journal = await import('@modoki/engine/runtime');
  journal.setJournalEnabled(false); // shipped-game boot (main.tsx)
  const { initDebugBridge } = await import('../../app/debug/bridge');
  initDebugBridge();
  // initNativeBridge runs fire-and-forget; getStatus is its last step.
  await vi.waitFor(() => expect(h.getStatusCalls).toBeGreaterThan(0));
  return journal;
}

describe('debug bridge journal gate (N12)', () => {
  beforeEach(() => {
    h.clientConnectedAtInit = false;
  });

  it('stays disabled on a shipped game when no debug client is attached', async () => {
    const journal = await bootShippedGame();
    expect(journal.isJournalEnabled()).toBe(false); // zero-overhead default intact
  });

  it('enables journaling the moment a debug client connects', async () => {
    const journal = await bootShippedGame();
    expect(journal.isJournalEnabled()).toBe(false);
    h.listeners['connectionChanged']({ connected: true, remoteAddress: '192.168.1.2' });
    expect(journal.isJournalEnabled()).toBe(true);
  });

  it('does NOT enable on a disconnect event', async () => {
    const journal = await bootShippedGame();
    h.listeners['connectionChanged']({ connected: false });
    expect(journal.isJournalEnabled()).toBe(false);
  });

  it('enables at init when a client is already attached (page reload over a live lease)', async () => {
    h.clientConnectedAtInit = true;
    const journal = await bootShippedGame();
    await vi.waitFor(() => expect(journal.isJournalEnabled()).toBe(true));
  });
});
