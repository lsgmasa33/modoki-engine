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

/** A `domElement` fake that actually tracks + removes listeners (unlike the bare `vi.fn()` stub
 *  above), so `#720`'s disposer tests can prove `removeEventListener` was really called and that
 *  a subsequent dispatch no longer reaches the handler. */
function makeDomElement() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    addEventListener: vi.fn((type: string, cb: (e: unknown) => void) => { (listeners[type] ??= []).push(cb); }),
    removeEventListener: vi.fn((type: string, cb: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((fn) => fn !== cb);
    }),
    emit: (type: string, evt: unknown = {}) => { for (const cb of [...(listeners[type] ?? [])]) cb(evt); },
  };
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

/**
 * DISPOSER (#720). Before this, `activeRenderer`/`attachedRenderer` were assigned and never
 * cleared — a teardown left `getActiveRenderer()` handing consumers (the GPU particle backend,
 * tier calibration, the memory report, the draw-call probe) a DISPOSED renderer, and the
 * `webglcontextlost` listener from `attachWebGlContextLostListener` had no removal path at all.
 * `setActiveRendererHandle` now returns a disposer pairing every register with an unregister,
 * matching the convention `onRendererLost` already uses.
 */
describe('activeRenderer disposer (#720)', () => {
  it('clears getActiveRenderer() to null after the disposer runs', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const renderer = makeRenderer();
    const dispose = setActiveRendererHandle(renderer as never);

    expect(getActiveRenderer()).toBe(renderer);
    dispose();
    expect(getActiveRenderer()).toBeNull();
  });

  it('identity guard: an OLD renderer\'s disposer must not clear a NEWER renderer\'s handle', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const r1 = makeRenderer();
    const r2 = makeRenderer();
    const disposeR1 = setActiveRendererHandle(r1 as never);
    setActiveRendererHandle(r2 as never);

    disposeR1(); // a late disposer from the SUPERSEDED renderer

    expect(getActiveRenderer()).toBe(r2);
  });

  it('is idempotent: calling a disposer twice does not throw and does not clear a newer renderer', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const r1 = makeRenderer();
    const disposeR1 = setActiveRendererHandle(r1 as never);
    disposeR1();
    expect(getActiveRenderer()).toBeNull();

    // A newer renderer takes over after the first disposed cleanly.
    const r2 = makeRenderer();
    setActiveRendererHandle(r2 as never);

    expect(() => disposeR1()).not.toThrow();
    expect(getActiveRenderer()).toBe(r2); // the second (stale) call must not clear r2
  });

  /** ⚠️ THE SEAM THE DISPOSER ACTUALLY LIVES ON, and the regression it nearly shipped.
   *
   *  THREE surfaces register through the ONE `activeRenderer` global — `SceneView`, `Scene3D`
   *  (GameView) and `ParticleEditor` — and they are alive simultaneously. A disposer that nulls the
   *  handle whenever it still points at its own renderer is WRONG: closing the Particle Editor
   *  panel would null it while two renderers are still drawing, and nothing re-registers
   *  (`setActiveRenderer` runs only at renderer CREATION). Consumers then degrade silently —
   *  `gpuEligible` routes every GPU particle effect onto the CPU sim, and `gpuMemoryReport` reads
   *  zero, i.e. a live leak reports as no leak. That is strictly worse than the stale handle the
   *  fix replaced, which at least still answered `isWebGPUBackend === true`.
   *
   *  The handle must fall back to the most recent SURVIVOR, reaching null only when the last
   *  registrant goes. */
  it('hands the handle to the surviving registrant when a LATER one tears down (3 live surfaces)', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const sceneView = makeRenderer();
    const gameView = makeRenderer();
    const particleEditor = makeRenderer();

    setActiveRendererHandle(sceneView as never);
    setActiveRendererHandle(gameView as never);
    const closePanel = setActiveRendererHandle(particleEditor as never);

    closePanel(); // the Particle Editor panel closes; the other two are still drawing

    expect(getActiveRenderer()).toBe(gameView);
    expect(getActiveRenderer()).not.toBeNull();
  });

  it('only reaches null once the LAST registrant is gone', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const a = makeRenderer();
    const b = makeRenderer();
    const disposeA = setActiveRendererHandle(a as never);
    const disposeB = setActiveRendererHandle(b as never);

    disposeB();
    expect(getActiveRenderer()).toBe(a);
    disposeA();
    expect(getActiveRenderer()).toBeNull();
  });

  /** A repeat registration of the SAME renderer must leave ONE entry — two would mean its disposer
   *  removes only one and the corpse stays reachable through the survivor fallback. */
  it('re-seats rather than duplicating when the same renderer registers twice', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const older = makeRenderer();
    const repeat = makeRenderer();
    setActiveRendererHandle(older as never);
    setActiveRendererHandle(repeat as never);
    const disposeRepeat = setActiveRendererHandle(repeat as never); // registered TWICE

    disposeRepeat();

    expect(getActiveRenderer()).toBe(older); // not `repeat` again from a duplicate entry
  });

  /** Pins the `disposed` latch specifically. Review found the old idempotence test passed with the
   *  latch deleted (the identity guard alone satisfied it), so it named a flag it did not cover.
   *  This is the case only the latch can survive: a renderer that is disposed and then REGISTERS
   *  AGAIN. Without the latch, the stale first disposer removes the live re-registration and the
   *  handle falls back past a renderer that is still drawing. */
  it('a stale disposer cannot unregister its renderer\'s LATER re-registration', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, getActiveRenderer } = await import('../../src/runtime/core/activeRenderer');
    const r = makeRenderer();
    const staleDispose = setActiveRendererHandle(r as never);
    staleDispose();
    expect(getActiveRenderer()).toBeNull();

    // The SAME renderer comes back (a viewport remount reusing the renderer lease).
    setActiveRendererHandle(r as never);
    expect(getActiveRenderer()).toBe(r);

    staleDispose(); // the first disposer fires late — it must be inert now

    expect(getActiveRenderer()).toBe(r);
  });

  it('removes the webglcontextlost listener — a dispatch after dispose() reports nothing', async () => {
    vi.resetModules();
    const { setActiveRendererHandle } = await import('../../src/runtime/core/activeRenderer');
    const domElement = makeDomElement();
    const renderer = makeRenderer(undefined, domElement);
    const dispose = setActiveRendererHandle(renderer as never);

    dispose();
    domElement.emit('webglcontextlost');

    // A live listener would call reportRendererLoss(), which warns. No warn ⇒ nothing fired.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(domElement.removeEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
  });

  it('does NOT reset lossTimes on dispose — loss count keeps counting across the teardown', async () => {
    vi.resetModules();
    const { setActiveRendererHandle, onRendererLost } = await import('../../src/runtime/core/activeRenderer');
    const attempts: number[] = [];
    onRendererLost((info) => attempts.push(info.attempt));

    const a = makeGpuDevice();
    const rendererA = makeRenderer(a);
    const disposeA = setActiveRendererHandle(rendererA as never);
    a.resolveLost({ reason: 'unknown' });
    await flush();
    expect(attempts).toEqual([1]);

    disposeA(); // teardown of the viewport that owned the now-dead renderer

    const b = makeGpuDevice();
    setActiveRendererHandle(makeRenderer(b) as never); // the recovery rebuild
    b.resolveLost({ reason: 'unknown' });
    await flush();

    // If the disposer had reset lossTimes, this would read back as attempt 1 again.
    expect(attempts).toEqual([1, 2]);
  });
});
