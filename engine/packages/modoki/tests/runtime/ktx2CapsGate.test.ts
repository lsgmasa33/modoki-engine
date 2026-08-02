/** `ensureKtx2Caps` (`runtime/loaders/textureResolver.ts`) — the demand-driven KTX2
 *  transcoder-caps gate that replaced the editor's up-front "wait for ANY 3D viewport"
 *  scene-load gate (see docs/textures.md, "Runtime resolution"). Resolves immediately
 *  once a real viewport registers (`setActiveRenderer` → `setActiveRendererHandle`), or —
 *  after a short delay with no viewport — via a single-flight throwaway probe renderer. Must
 *  never mutate `activeRenderer`/`rendererReady`: those mean "a real, RENDERING renderer is
 *  live" for the GPU particle backend and shader prewarm, which a caps-only probe is not.
 *
 *  Every test resets the module registry: `ktx2CapsReadyFired`/`probePromise` are
 *  module-monotonic singletons (by design — see activeRenderer.ts), so a fresh import per
 *  test is the only way to exercise the "no renderer has registered yet" cold path more
 *  than once. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

/** Fake, controllable setTimeout/clearTimeout — fires synchronously when `advance()` is
 *  called by delay, so tests don't need real wall-clock waits. */
function makeFakeTimers() {
  const pending = new Map<number, { cb: () => void; delay: number }>();
  let nextId = 1;
  const setTimeout = vi.fn((cb: () => void, delay: number) => {
    const id = nextId++;
    pending.set(id, { cb, delay });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  });
  const clearTimeout = vi.fn((id: unknown) => { pending.delete(id as number); });
  const advance = (delay: number) => {
    for (const [id, entry] of pending) {
      if (entry.delay === delay) { pending.delete(id); entry.cb(); }
    }
  };
  return { setTimeout, clearTimeout, advance };
}

describe('ensureKtx2Caps', () => {
  it('resolves synchronously when caps are already ready — no probe attempted', async () => {
    const { setActiveRenderer } = await import('../../src/runtime/loaders/textureResolver');
    const { ensureKtx2Caps } = await import('../../src/runtime/loaders/textureResolver');
    setActiveRenderer({} as never); // a real viewport already registered
    const probeFactory = vi.fn();
    await ensureKtx2Caps({ probeFactory });
    expect(probeFactory).not.toHaveBeenCalled();
  });

  it('resolves via the probe after the delay when no viewport ever registers', async () => {
    const { ensureKtx2Caps } = await import('../../src/runtime/loaders/textureResolver');
    const { getActiveRenderer, rendererReady } = await import('../../src/runtime/core/activeRenderer');
    const timers = makeFakeTimers();
    const fakeProbe = { isWebGPURenderer: true, hasFeature: () => false, dispose: vi.fn() };
    const probeFactory = vi.fn(async () => fakeProbe as never);

    const p = ensureKtx2Caps({ delayMs: 2000, timers: { setTimeout: timers.setTimeout as never, clearTimeout: timers.clearTimeout as never }, probeFactory });
    timers.advance(2000);
    await p;

    expect(probeFactory).toHaveBeenCalledTimes(1);
    expect(fakeProbe.dispose).toHaveBeenCalledTimes(1);
    // The probe must NOT masquerade as a real viewport renderer.
    expect(getActiveRenderer()).toBeNull();
    // rendererReady must still be pending — only a real viewport resolves it.
    const raced = await Promise.race([rendererReady.then(() => 'renderer-ready'), Promise.resolve('still-pending')]);
    expect(raced).toBe('still-pending');
  });

  it('single-flight — N concurrent waiters trigger exactly ONE probe', async () => {
    const { ensureKtx2Caps } = await import('../../src/runtime/loaders/textureResolver');
    const timers = makeFakeTimers();
    const fakeProbe = { isWebGPURenderer: true, hasFeature: () => false, dispose: vi.fn() };
    const probeFactory = vi.fn(async () => fakeProbe as never);
    const opts = { delayMs: 2000, timers: { setTimeout: timers.setTimeout as never, clearTimeout: timers.clearTimeout as never }, probeFactory };

    const waiters = [ensureKtx2Caps(opts), ensureKtx2Caps(opts), ensureKtx2Caps(opts)];
    timers.advance(2000); // fires all three timers, but only one probe must start
    await Promise.all(waiters);

    expect(probeFactory).toHaveBeenCalledTimes(1);
  });

  it('a viewport that registers DURING the delay wins — the probe is never created', async () => {
    const { ensureKtx2Caps, setActiveRenderer } = await import('../../src/runtime/loaders/textureResolver');
    const timers = makeFakeTimers();
    const probeFactory = vi.fn();

    const p = ensureKtx2Caps({ delayMs: 2000, timers: { setTimeout: timers.setTimeout as never, clearTimeout: timers.clearTimeout as never }, probeFactory });
    setActiveRenderer({} as never); // a real viewport wins the race before the delay fires
    await p;

    expect(probeFactory).not.toHaveBeenCalled();
  });

  it('a THROWING probe still resolves the gate (no eternal hang) and logs an actionable error', async () => {
    const { ensureKtx2Caps } = await import('../../src/runtime/loaders/textureResolver');
    const timers = makeFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const probeFactory = vi.fn(async () => { throw new Error('adapter request failed'); });

    const p = ensureKtx2Caps({ delayMs: 2000, timers: { setTimeout: timers.setTimeout as never, clearTimeout: timers.clearTimeout as never }, probeFactory });
    timers.advance(2000);
    await expect(p).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('KTX2 caps probe failed'), expect.any(Error));
    errorSpy.mockRestore();

    // A second call must resolve immediately now (caps marked ready despite the failure).
    const probeFactory2 = vi.fn();
    await ensureKtx2Caps({ probeFactory: probeFactory2 });
    expect(probeFactory2).not.toHaveBeenCalled();
  });

  it('exports KTX2_PROBE_DELAY_MS = 2000 (decided value, not a knob)', async () => {
    const { KTX2_PROBE_DELAY_MS } = await import('../../src/runtime/loaders/textureResolver');
    expect(KTX2_PROBE_DELAY_MS).toBe(2000);
  });
});
