// @vitest-environment jsdom
/** #1514 — a boot `startServer` that FAILS must still leave the debug bridge able to recover.
 *
 *  `initNativeBridge` used to rethrow the boot start's rejection before registering anything, so
 *  neither the `appStateChange` lifecycle handler nor the `request` listener existed: no later
 *  foreground could retry the bind, and the bridge stayed dead until relaunch. Native now bounds
 *  every start (a 10s deadline on iOS turns a hung start into a reject), which makes this path the
 *  COMMON ending of a bad start rather than a rare one — so without this, the native fix would turn
 *  a hang into a permanent failure.
 *
 *  Module state is reset per scenario via vi.resetModules() + dynamic import, as in
 *  bridgeJournalGate.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  gameDebugListeners: {} as Record<string, (data: unknown) => void>,
  appListeners: {} as Record<string, (data: unknown) => void>,
  startResults: [] as Array<'reject' | 'resolve'>,
  startCalls: 0,
  getStatusCalls: 0,
}));

vi.mock('capacitor-game-debug', () => ({
  GameDebug: {
    startServer: async () => {
      h.startCalls++;
      const next = h.startResults.shift() ?? 'resolve';
      if (next === 'reject') throw new Error('TCP server was not ready within 10s (last state: waiting)');
      return { port: 9095 };
    },
    stopServer: async () => ({ ok: true }),
    getStatus: async () => {
      h.getStatusCalls++;
      return { running: false, clientConnected: false, port: 9095 };
    },
    addListener: async (name: string, fn: (data: unknown) => void) => {
      h.gameDebugListeners[name] = fn;
      return { remove() {} };
    },
    sendResponse: async () => ({ ok: true }),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, fn: (data: unknown) => void) => {
      h.appListeners[name] = fn;
      return { remove() {} };
    },
    getInfo: async () => ({ id: 'test', name: 'test', version: '0', build: '0' }),
  },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

async function boot() {
  vi.resetModules();
  h.gameDebugListeners = {};
  h.appListeners = {};
  h.startCalls = 0;
  h.getStatusCalls = 0;
  const errors: unknown[][] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  const { initDebugBridge } = await import('../../app/debug/bridge');
  initDebugBridge();
  // getStatus is initNativeBridge's last step on every path — failed boot start included.
  await vi.waitFor(() => expect(h.getStatusCalls).toBeGreaterThan(0));
  return { errors, errSpy };
}

describe('debug bridge: a failed boot start still registers the recovery path (#1514)', () => {
  beforeEach(() => {
    h.startResults = [];
  });

  it('registers the lifecycle handler and the request listener when the boot start rejects', async () => {
    h.startResults = ['reject'];
    const { errSpy } = await boot();
    expect(h.appListeners['appStateChange'], 'no lifecycle handler — no foreground can ever retry the bind').toBeTypeOf('function');
    expect(h.gameDebugListeners['request'], 'no request listener — a later successful bind could answer nothing').toBeTypeOf('function');
    errSpy.mockRestore();
  });

  it('the next foreground retries the bind', async () => {
    h.startResults = ['reject', 'resolve'];
    const { errSpy } = await boot();
    expect(h.startCalls).toBe(1);
    h.appListeners['appStateChange']({ isActive: true });
    await vi.waitFor(() => expect(h.startCalls).toBe(2));
    errSpy.mockRestore();
  });

  it('still reports the boot failure loudly, and only after the recovery path exists', async () => {
    h.startResults = ['reject'];
    const { errors, errSpy } = await boot();
    await vi.waitFor(() => expect(errors.some((a) => String(a[0]).includes('FAILED to start'))).toBe(true));
    expect(h.appListeners['appStateChange']).toBeTypeOf('function');
    errSpy.mockRestore();
  });

  it('a successful boot start is unchanged: one start, listeners registered, no FAILED line', async () => {
    const { errors, errSpy } = await boot();
    expect(h.startCalls).toBe(1);
    expect(h.appListeners['appStateChange']).toBeTypeOf('function');
    expect(errors.some((a) => String(a[0]).includes('FAILED to start'))).toBe(false);
    errSpy.mockRestore();
  });
});
