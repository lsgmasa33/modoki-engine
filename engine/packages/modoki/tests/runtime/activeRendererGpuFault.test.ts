/** GPU fault recording in `runtime/core/activeRenderer.ts` — WebGPU device.lost, WebGPU
 *  uncapturederror, and the WebGL `webglcontextlost` fallback. This is the CAUSE channel that
 *  used to not exist at all: a lost/hung GPU device made the frame loop stall, and the stall
 *  watchdog reported only the symptom ("wedged, relaunch") with no idea why. Recovery policy
 *  (#121 P1) is exercised in the third describe block below.
 *
 *  Every test does `vi.resetModules()` + a fresh dynamic import so the module-level
 *  `gpuFaultState`/`attachedRenderer` singletons start clean — this file's own state would
 *  otherwise leak between tests exactly like the fault-state leak it's testing for. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Flush BOTH the `.then()` microtask on `device.lost` and its `.catch()` continuation —
 *  a single `await Promise.resolve()` only advances one hop. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A minimal fake `GPUDevice`: a controllable `lost` promise + an `uncapturederror`
 *  event target, matching the two hooks `attachWebGpuDeviceListeners` reads. */
function makeGpuDevice() {
  let resolveLost!: (info: { reason: string; message?: string }) => void;
  const lost = new Promise<{ reason: string; message?: string }>((res) => { resolveLost = res; });
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    lost,
    addEventListener: vi.fn((type: string, cb: (e: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
    }),
    resolveLost,
    emit: (type: string, evt: unknown) => { for (const cb of listeners[type] ?? []) cb(evt); },
  };
}

function makeRenderer(device?: ReturnType<typeof makeGpuDevice>, domElement?: unknown) {
  return { backend: device ? { device } : undefined, domElement: domElement ?? { addEventListener: vi.fn() } };
}

let errSpy: ReturnType<typeof vi.spyOn>;
/** A RECOVERABLE loss logs `warn`, not `error` — the severity now carries meaning: `warn` is
 *  "rebuilding, expect a hitch", `error` is "recovery abandoned, nothing will render". */
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('activeRenderer GPU fault channel', () => {
  it('starts healthy: getGpuFaultState() is null before any renderer registers', async () => {
    vi.resetModules();
    const { getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    expect(getGpuFaultState()).toBeNull();
  });

  it('records a lost device with its reason + message', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const device = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(device) as never);

    device.resolveLost({ reason: 'unknown', message: 'driver reset' });
    await flush();

    expect(getGpuFaultState()).toEqual({
      deviceLost: true, reason: 'unknown', message: 'driver reset', uncapturedErrors: 0,
      losses: 1, unrecoverable: false,
    });
  });

  it('caps LOGGING of uncaptured errors at MAX_REPORTED_GPU_ERRORS but keeps counting past it', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState, MAX_REPORTED_GPU_ERRORS } =
      await import('../../src/runtime/core/activeRenderer');
    const device = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(device) as never);

    const total = MAX_REPORTED_GPU_ERRORS + 3;
    for (let i = 0; i < total; i++) device.emit('uncapturederror', { error: { message: `err${i}` } });

    // The COUNT is never suppressed — only the console.error call is.
    expect(getGpuFaultState()?.uncapturedErrors).toBe(total);
    expect(errSpy).toHaveBeenCalledTimes(MAX_REPORTED_GPU_ERRORS);
  });

  it('resets fault state when a NEW renderer handle replaces the old one', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const deviceA = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(deviceA) as never);
    deviceA.resolveLost({ reason: 'unknown' });
    await flush();
    expect(getGpuFaultState()?.deviceLost).toBe(true);

    const deviceB = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(deviceB) as never); // a fresh renderer handle — clean slate
    expect(getGpuFaultState()).toBeNull();
  });

  it('is idempotent: attaching the SAME renderer handle twice does not double-attach listeners', async () => {
    vi.resetModules();
    const { setActiveRendererHandle } = await import('../../src/runtime/core/activeRenderer');
    const device = makeGpuDevice();
    const renderer = makeRenderer(device);
    setActiveRendererHandle(renderer as never);
    setActiveRendererHandle(renderer as never); // same object reference — must be a no-op re-attach
    expect(device.addEventListener).toHaveBeenCalledTimes(1); // only the 'uncapturederror' listener
  });

  it('records a WebGL context loss (the non-WebGPU fallback)', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    let handler: (() => void) | undefined;
    const domElement = { addEventListener: vi.fn((type: string, cb: () => void) => { if (type === 'webglcontextlost') handler = cb; }) };
    setActiveRendererHandle(makeRenderer(undefined, domElement) as never);

    handler?.();

    expect(getGpuFaultState()).toEqual({
      deviceLost: true, reason: 'webglcontextlost', uncapturedErrors: 0,
      losses: 1, unrecoverable: false,
    });
  });

  it('NEVER throws for a bare {} renderer (no backend, no device, no domElement)', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    expect(() => setActiveRendererHandle({} as never)).not.toThrow();
    expect(getGpuFaultState()).toBeNull();
  });

  it('NEVER throws for a WebGL-ish stub (domElement present, backend/device absent)', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const domElement = { addEventListener: vi.fn() };
    expect(() => setActiveRendererHandle({ domElement } as never)).not.toThrow();
    expect(getGpuFaultState()).toBeNull();
    expect(domElement.addEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
  });
});

/**
 * FALSE-POSITIVE FILTERS (owner, 2026-08-01). Within minutes of this channel shipping it
 * reported a HEALTHY editor as dead — `reason=destroyed` logged as an error while the editor
 * rendered at 61 FPS, telling the owner to relaunch something that was fine. Both causes are
 * pinned here because this state OUTRANKS the frame-loop stall in `explainCaptureFailure`: a
 * false loss does not merely add noise, it MASKS every other explanation of a capture failure.
 */
describe('activeRenderer GPU fault channel — false-positive filters', () => {
  it('a deliberate device.destroy() (reason=destroyed) is NOT a fault', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const device = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(device) as never);

    // What three does when a renderer is disposed — i.e. every HMR reload / viewport remount.
    device.resolveLost({ reason: 'destroyed', message: 'Device was destroyed.' });
    await flush();

    expect(getGpuFaultState()).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('a SUPERSEDED renderer\'s late device.lost cannot overwrite the live renderer\'s state', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    const oldDevice = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(oldDevice) as never);

    // A new renderer takes over (reload / remount) BEFORE the old device's promise resolves.
    const newDevice = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(newDevice) as never);

    // The corpse of the old renderer speaks — with a REAL loss reason, so only the
    // superseded-renderer check can suppress it.
    oldDevice.resolveLost({ reason: 'unknown', message: 'stale' });
    await flush();

    expect(getGpuFaultState()).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('the LIVE renderer losing its device is still reported (the filters are not a mute button)', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getGpuFaultState } = await import('../../src/runtime/core/activeRenderer');
    setActiveRendererHandle(makeRenderer(makeGpuDevice()) as never);
    const live = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(live) as never);

    live.resolveLost({ reason: 'unknown', message: 'driver reset' });
    await flush();

    expect(getGpuFaultState()).toMatchObject({ deviceLost: true, reason: 'unknown' });
    // A first loss is RECOVERABLE, so it warns rather than errors. The filters are still not a
    // mute button — the point of this test — but the severity moved with the behaviour.
    expect(warnSpy).toHaveBeenCalled();
  });
});

/**
 * RECOVERY POLICY (#121 P1). A lost context used to be permanent — measured on a Huawei Y6 2019,
 * where the WebGL2 context died ~4s into boot and the game stayed black for the process lifetime.
 *
 * This module cannot rebuild a renderer (it has no container and no render loop) and three cannot
 * revive one (`_isDeviceLost` gates `render()` and is never cleared). So the contract under test
 * is narrow and exact: decide whether a loss is worth recovering from, and ASK. The rebuild
 * itself belongs to the viewport that owns the renderer.
 */
describe('activeRenderer recovery policy', () => {
  const load = async () => {
    vi.resetModules();
    return await import('../../src/runtime/core/activeRenderer');
  };

  it('asks a subscriber to rebuild on the first loss, with the backend that died', async () => {
    const { setActiveRendererHandle, onRendererLost } = await load();
    const seen: Array<Record<string, unknown>> = [];
    onRendererLost((info) => seen.push(info as unknown as Record<string, unknown>));

    const device = makeGpuDevice();
    const renderer = makeRenderer(device);
    setActiveRendererHandle(renderer as never);
    device.resolveLost({ reason: 'unknown', message: 'driver reset' });
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ api: 'WebGPU', reason: 'unknown', message: 'driver reset', attempt: 1 });
    // WHICH renderer died, by identity. The editor mounts two viewports and this notification is
    // a broadcast, so without this a healthy viewport cannot tell that the loss wasn't its own —
    // and would tear its own working renderer down in sympathy.
    expect(seen[0].renderer).toBe(renderer);
  });

  it('reports a WebGL context loss as api:WebGL — the path a low-end phone actually takes', async () => {
    const { setActiveRendererHandle, onRendererLost } = await load();
    const seen: Array<{ api: string }> = [];
    onRendererLost((info) => seen.push(info));

    let handler: (() => void) | undefined;
    const domElement = { addEventListener: vi.fn((t: string, cb: () => void) => { if (t === 'webglcontextlost') handler = cb; }) };
    setActiveRendererHandle(makeRenderer(undefined, domElement) as never);
    handler?.();

    expect(seen).toHaveLength(1);
    expect(seen[0].api).toBe('WebGL');
  });

  it('COUNTS LOSSES ACROSS RENDERER REPLACEMENTS — the whole basis of loop detection', async () => {
    // The subtle one. Every recovery installs a NEW renderer, and `attachGpuFaultListeners`
    // deliberately clears `gpuFaultState` so the new renderer reports cleanly. If the loss
    // HISTORY were cleared on the same path, a hard rebuild loop would present as an endless
    // series of "first" losses and the budget would never trip. The history must outlive the
    // renderer; the reported state must not.
    const { setActiveRendererHandle, onRendererLost, getGpuFaultState } = await load();
    const attempts: number[] = [];
    onRendererLost((info) => attempts.push(info.attempt));

    const a = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(a) as never);
    a.resolveLost({ reason: 'unknown' });
    await flush();

    // The rebuild the listener would have performed: a fresh renderer registers.
    const b = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(b) as never);
    expect(getGpuFaultState()).toBeNull();      // reporting state IS reset for the new renderer
    b.resolveLost({ reason: 'unknown' });
    await flush();

    expect(attempts).toEqual([1, 2]);            // ...but the loss history is NOT
  });

  it('abandons recovery past MAX_RECOVERY_ATTEMPTS and stops asking', async () => {
    const { setActiveRendererHandle, onRendererLost, isRecoveryAbandoned, getGpuFaultState, MAX_RECOVERY_ATTEMPTS } = await load();
    const attempts: number[] = [];
    onRendererLost((info) => attempts.push(info.attempt));

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS + 2; i++) {
      const d = makeGpuDevice();
      setActiveRendererHandle(makeRenderer(d) as never);
      d.resolveLost({ reason: 'unknown' });
      await flush();
    }

    // Asked exactly up to the budget, then went quiet — no rebuild request on the 4th or 5th.
    expect(attempts).toEqual([1, 2, 3]);
    expect(isRecoveryAbandoned()).toBe(true);
    expect(getGpuFaultState()).toMatchObject({ unrecoverable: true, deviceLost: true });
    expect(errSpy).toHaveBeenCalled(); // giving up is an ERROR, unlike a recoverable loss
  });

  it('a loss OUTSIDE the window does not count toward the budget', async () => {
    const { setActiveRendererHandle, onRendererLost, RECOVERY_WINDOW_MS } = await load();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    const attempts: number[] = [];
    onRendererLost((info) => attempts.push(info.attempt));

    const a = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(a) as never);
    a.resolveLost({ reason: 'unknown' });
    await flush();

    // Two unrelated transient faults an hour apart are not a loop; the window must forget.
    advanceManual(RECOVERY_WINDOW_MS + 1);
    const b = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(b) as never);
    b.resolveLost({ reason: 'unknown' });
    await flush();

    expect(attempts).toEqual([1, 1]);
  });

  it('a listener that THROWS cannot stop the other subscribers from rebuilding', async () => {
    const { setActiveRendererHandle, onRendererLost } = await load();
    const survived: number[] = [];
    onRendererLost(() => { throw new Error('bad subscriber'); });
    onRendererLost((info) => survived.push(info.attempt));

    const d = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(d) as never);
    d.resolveLost({ reason: 'unknown' });
    await flush();

    expect(survived).toEqual([1]);
  });

  it('unsubscribing stops delivery (a remounted viewport must not be asked twice)', async () => {
    const { setActiveRendererHandle, onRendererLost } = await load();
    const seen: number[] = [];
    const off = onRendererLost((info) => seen.push(info.attempt));
    off();

    const d = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(d) as never);
    d.resolveLost({ reason: 'unknown' });
    await flush();

    expect(seen).toEqual([]);
  });

  it('a SUPERSEDED renderer\'s canvas losing its context does not request a rebuild', async () => {
    // The WebGL twin of the existing device.lost false-positive filter. A replaced renderer's
    // canvas is torn down as a matter of course, and that must not read as a live fault — this
    // module's whole credibility problem was crying wolf on orderly teardown.
    const { setActiveRendererHandle, onRendererLost, getGpuFaultState } = await load();
    const seen: unknown[] = [];
    onRendererLost((info) => seen.push(info));

    let oldHandler: (() => void) | undefined;
    const oldEl = { addEventListener: vi.fn((t: string, cb: () => void) => { if (t === 'webglcontextlost') oldHandler = cb; }) };
    setActiveRendererHandle(makeRenderer(undefined, oldEl) as never);
    setActiveRendererHandle(makeRenderer(undefined, { addEventListener: vi.fn() }) as never);

    oldHandler?.(); // the corpse's canvas fires

    expect(seen).toEqual([]);
    expect(getGpuFaultState()).toBeNull();
  });

  it('resetRecoveryState() clears the history and re-enables recovery', async () => {
    const { setActiveRendererHandle, onRendererLost, resetRecoveryState, isRecoveryAbandoned, MAX_RECOVERY_ATTEMPTS } = await load();
    const attempts: number[] = [];
    onRendererLost((info) => attempts.push(info.attempt));

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS + 1; i++) {
      const d = makeGpuDevice();
      setActiveRendererHandle(makeRenderer(d) as never);
      d.resolveLost({ reason: 'unknown' });
      await flush();
    }
    expect(isRecoveryAbandoned()).toBe(true);

    resetRecoveryState();
    expect(isRecoveryAbandoned()).toBe(false);

    const d = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(d) as never);
    d.resolveLost({ reason: 'unknown' });
    await flush();

    expect(attempts.at(-1)).toBe(1); // counting starts over
  });
});
