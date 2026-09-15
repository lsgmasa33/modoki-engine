/** #1259's mechanism on the device bridge: the native `request` listener is async, and a throw that
 *  escapes it sends NO response, so the host (game-debug MCP) waits out its whole deadline. The
 *  `params` parse used to sit above the listener's try. Native always re-serialises params today
 *  (GameDebugPlugin.swift / .java), so this pins the listener's contract rather than a live input:
 *  every request gets an answer for its own id, including a non-Error throw.
 *
 *  Harness shape follows bridgeScreenshotEpoch.test.ts (same file under test). */

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: {} as Record<string, (data: unknown) => Promise<void>>,
  responses: [] as Array<{ id: unknown; result?: string; error?: string }>,
  captureThrows: undefined as unknown,
}));

vi.mock('capacitor-game-debug', () => ({
  GameDebug: {
    startServer: async () => ({ port: 9095 }),
    getStatus: async () => ({ running: true, clientConnected: false, port: 9095 }),
    addListener: async (name: string, fn: (data: unknown) => Promise<void>) => {
      h.listeners[name] = fn;
      return { remove() {} };
    },
    captureScreen: async () => { throw h.captureThrows; },
    sendResponse: async (r: { id: unknown; result?: string; error?: string }) => { h.responses.push(r); },
  },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

async function bootNativeBridge() {
  vi.resetModules();
  h.listeners = {};
  h.responses = [];
  const { initDebugBridge } = await import('../../app/debug/bridge');
  initDebugBridge();
  await vi.waitFor(() => expect(h.listeners['request']).toBeDefined());
  return h.listeners['request'];
}

describe('debug bridge — every request gets a response, even when handling throws', () => {
  it('answers malformed string params with an error for that id (the listener does not reject)', async () => {
    const request = await bootNativeBridge();
    await expect(request({ id: 'bad-params', method: 'ping', params: '{ "x": ' })).resolves.toBeUndefined();
    const reply = h.responses.find((r) => r.id === 'bad-params');
    expect(reply?.error).toMatch(/JSON/);
    expect(reply?.result).toBeUndefined();
  });

  it('carries a non-Error throw as its string rather than an undefined error', async () => {
    const request = await bootNativeBridge();
    h.captureThrows = 'native capture failed';
    await request({ id: 'shot', method: 'screenshot', params: '{}' });
    expect(h.responses.find((r) => r.id === 'shot')?.error).toBe('native capture failed');
  });
});
