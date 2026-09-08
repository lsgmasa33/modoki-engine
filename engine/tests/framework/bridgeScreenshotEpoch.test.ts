/** Regression for docs/async-lifetime.md: the native `request` listener's `screenshot` branch
 *  writes the module-level `lastScreenInfo` after `await GameDebug.captureScreen()` with no
 *  liveness check.
 *
 *  PRODUCTION DRIVER: the MCP client (`device_screenshot`) times out waiting for a slow native
 *  capture and retries — a SECOND `screenshot` request lands on the same TCP connection while the
 *  FIRST request's native `captureScreen()` is still running. Native capture time is exactly the
 *  kind of thing that varies (a cold GPU readback, a large device screen), so this is a real,
 *  externally-triggerable retry, not a hypothetical. If the two responses resolve out of order —
 *  the newer (retried) request's native call finishes first, the older one straggles in after —
 *  the straggler's `await` resumes LAST and, without a guard, overwrites `lastScreenInfo` with
 *  stale dimensions (e.g. pre-rotation), corrupting every later screenshot-pixel→CSS conversion
 *  (`resolveAim`/`handleResolveAim`, which every `device_tap`/`device_drag` pixel aim goes through)
 *  until the next screenshot lands.
 *
 *  Module state (bridge `initialized` guard) is reset per test via vi.resetModules() + dynamic
 *  imports, matching bridgeJournalGate.test.ts's shape for the same file. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: {} as Record<string, (data: unknown) => void>,
  pending: [] as Array<{ resolve: (v: unknown) => void }>,
  responses: [] as Array<{ id: unknown; result?: string; error?: string }>,
}));

vi.mock('capacitor-game-debug', () => ({
  GameDebug: {
    startServer: async () => ({ port: 9095 }),
    getStatus: async () => ({ running: true, clientConnected: false, port: 9095 }),
    addListener: async (name: string, fn: (data: unknown) => void) => {
      h.listeners[name] = fn;
      return { remove() {} };
    },
    captureScreen: () => new Promise((resolve) => { h.pending.push({ resolve }); }),
    sendResponse: async (r: { id: unknown; result?: string; error?: string }) => { h.responses.push(r); },
  },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));

async function bootNativeBridge() {
  vi.resetModules();
  h.listeners = {};
  h.pending = [];
  h.responses = [];
  const { initDebugBridge } = await import('../../app/debug/bridge');
  initDebugBridge();
  await vi.waitFor(() => expect(h.listeners['request']).toBeDefined());
  return await import('../../app/debug/bridge');
}

describe('debug bridge — screenshot lastScreenInfo supersession', () => {
  beforeEach(() => { vi.stubGlobal('devicePixelRatio', 1); });

  it('a straggling OLDER capture must not overwrite a NEWER one\'s lastScreenInfo', async () => {
    const bridge = await bootNativeBridge();
    const request = h.listeners['request'];

    // Request #1 (the original), then #2 (the client's retry) — both in flight together.
    const r1 = request({ id: 'req-1', method: 'screenshot', params: '{}' });
    const r2 = request({ id: 'req-2', method: 'screenshot', params: '{}' });
    await vi.waitFor(() => expect(h.pending.length).toBe(2));

    // The NEWER request's native capture resolves FIRST (post-rotation dimensions)...
    h.pending[1].resolve({ image: 'b', imageWidth: 600, imageHeight: 1000, screenWidth: 300, screenHeight: 500 });
    await r2;
    // ...then the OLDER, straggling one resolves LAST (stale pre-rotation dimensions).
    h.pending[0].resolve({ image: 'a', imageWidth: 1200, imageHeight: 2000, screenWidth: 300, screenHeight: 500 });
    await r1;

    // Both requests still get THEIR OWN answer regardless of staleness.
    expect(h.responses.find((r) => r.id === 'req-1')?.result).toContain('"imageWidth":1200');
    expect(h.responses.find((r) => r.id === 'req-2')?.result).toContain('"imageWidth":600');

    // But the SHARED `lastScreenInfo` must reflect the NEWER capture (scale 300/600=0.5), not the
    // straggling older one (scale 300/1200=0.25) that resumed last.
    const aim = await bridge.handleResolveAim({ x: 200, y: 200 });
    if ('error' in aim) throw new Error(`unexpected aim error: ${aim.error}`);
    expect(aim.x).toBeCloseTo(100); // 200 * (300/600)
    expect(aim.y).toBeCloseTo(100);
  });
});
