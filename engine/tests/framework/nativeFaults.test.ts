/** The app shell's `faultProvider` installation over capacitor-game-debug (#278).
 *
 *  Three things here are worth a test and none of them is visible from the plugin's own types:
 *
 *  1. **Registration is native-only.** On the web/editor nothing must be provided — a provider that
 *     registered everywhere would give the Device tab buttons that resolve cheerfully and do
 *     nothing, which is the false-success shape the fault probes exist to avoid.
 *  2. **iOS advertises `crash` alone.** It has no ANR, and Crashlytics does not report foreground
 *     hangs at all, so offering `anr`/`uncaught` there would be a probe that cannot pass.
 *  3. **The plugin object is never awaited.** A Capacitor plugin proxy is THENABLE: `await GameDebug`
 *     calls `then` on the native side and resolves to something that is not the plugin, so the
 *     feature silently sends nothing. The mock below is a Proxy for exactly that reason — a plain
 *     object mock cannot reproduce the hazard and would pass either way. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  platform: 'android',
  faults: [] as Array<{ kind: string; blockMs?: number }>,
  thenReads: 0,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => h.platform !== 'web',
    getPlatform: () => h.platform,
  },
}));

vi.mock('capacitor-game-debug', () => ({
  // A Proxy, mirroring what `registerPlugin` actually returns: reading ANY property yields
  // something callable, `then` included. If the code under test ever awaits this object, the read
  // is counted and the test fails.
  GameDebug: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'then') {
        h.thenReads++;
        return (resolve: (v: unknown) => void) => resolve(undefined);
      }
      if (prop === 'triggerFault') {
        return async (opts: { kind: string; blockMs?: number }) => { h.faults.push(opts); return { ok: true }; };
      }
      return async () => ({});
    },
  }),
}));

async function loadWithPlatform(platform: string) {
  h.platform = platform;
  h.faults.length = 0;
  h.thenReads = 0;
  vi.resetModules();
  const { faultProvider } = await import('@modoki/engine/runtime');
  faultProvider.reset();
  await import('../../app/debug/nativeFaults');
  return faultProvider;
}

let restore: (() => void) | null = null;
beforeEach(() => { restore = null; });
afterEach(async () => {
  restore?.();
  const { faultProvider } = await import('@modoki/engine/runtime');
  faultProvider.reset();
});

describe('nativeFaults — the app-side faultProvider', () => {
  it('registers nothing on the web, so the Device tab reports "no provider"', async () => {
    const faultProvider = await loadWithPlatform('web');
    expect(faultProvider.isProvided()).toBe(false);
  });

  it('offers all three kinds on Android', async () => {
    const faultProvider = await loadWithPlatform('android');
    expect(faultProvider.get()?.supported()).toEqual(['crash', 'anr', 'uncaught']);
  });

  it('offers ONLY crash on iOS — it has no ANR and Crashlytics does not report hangs', async () => {
    const faultProvider = await loadWithPlatform('ios');
    expect(faultProvider.get()?.supported()).toEqual(['crash']);
  });

  it('passes the kind through to the plugin without awaiting the plugin proxy', async () => {
    const faultProvider = await loadWithPlatform('android');
    await faultProvider.get()?.trigger('anr', { blockMs: 12000 });
    expect(h.faults).toEqual([{ kind: 'anr', blockMs: 12000 }]);
    // The whole point of the Proxy mock: awaiting the plugin object would have read `then`.
    expect(h.thenReads).toBe(0);
  });

  it('omits blockMs entirely when not given, so the native default decides', async () => {
    const faultProvider = await loadWithPlatform('android');
    await faultProvider.get()?.trigger('crash');
    expect(h.faults).toEqual([{ kind: 'crash' }]);
  });
});
