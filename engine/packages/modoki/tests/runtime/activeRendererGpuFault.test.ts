/** GPU fault recording in `runtime/core/activeRenderer.ts` — WebGPU device.lost, WebGPU
 *  uncapturederror, and the WebGL `webglcontextlost` fallback. This is the CAUSE channel that
 *  used to not exist at all: a lost/hung GPU device made the frame loop stall, and the stall
 *  watchdog reported only the symptom ("wedged, relaunch") with no idea why. Log-only — no
 *  recovery attempt is exercised or expected here.
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

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
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

    expect(getGpuFaultState()).toEqual({ deviceLost: true, reason: 'webglcontextlost', uncapturedErrors: 0 });
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
    expect(errSpy).toHaveBeenCalled();
  });
});
