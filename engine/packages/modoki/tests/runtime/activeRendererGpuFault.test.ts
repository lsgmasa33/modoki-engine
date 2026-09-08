/** GPU fault recording in `runtime/core/activeRenderer.ts` — WebGPU device.lost, WebGPU
 *  uncapturederror, and the WebGL `webglcontextlost` fallback. This is the CAUSE channel that
 *  used to not exist at all: a lost/hung GPU device made the frame loop stall, and the stall
 *  watchdog reported only the symptom ("wedged, relaunch") with no idea why. Recovery policy
 *  (#121 P1) is exercised in the third describe block below.
 *
 *  #802 moved DETECTION off this module's single-slot `attachedRenderer` (a second registrant —
 *  e.g. the Particle Editor — silently disarmed the first, e.g. SceneView) and onto the shared
 *  per-renderer contract `rendererLossHandling.ts` (#795): a "viewport" here is simulated by
 *  composing `attachRendererLossHandling` + `makeViewportLossPolicy` + `attachUncapturedErrorListener`
 *  — see `attachViewport` below — rather than by calling `setActiveRendererHandle` alone, which
 *  now arms NOTHING fault-related (it keeps only its texture/KTX2-caps + registrants-stack role;
 *  that role is covered separately by the `activeRenderer disposer (#720)` describe block).
 *
 *  Every test does `vi.resetModules()` + a fresh dynamic import so the module-level
 *  `gpuFaultState`/loss-history singletons start clean — this file's own state would otherwise
 *  leak between tests exactly like the fault-state leak it's testing for. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Flush BOTH the `.then()` microtask on `device.lost` and its `.catch()` continuation —
 *  a single `await Promise.resolve()` only advances one hop. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A minimal fake `GPUDevice`: a controllable `lost` promise + an `uncapturederror`
 *  event target, matching what `attachDeviceLostListener`/`attachUncapturedErrorListener` read. */
function makeGpuDevice() {
  let resolveLost!: (info: { reason: string; message?: string }) => void;
  const lost = new Promise<{ reason: string; message?: string }>((res) => { resolveLost = res; });
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    lost,
    addEventListener: vi.fn((type: string, cb: (e: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((fn) => fn !== cb);
    }),
    resolveLost,
    emit: (type: string, evt: unknown) => { for (const cb of listeners[type] ?? []) cb(evt); },
  };
}

function makeRenderer(device?: ReturnType<typeof makeGpuDevice>, domElement?: unknown) {
  return { backend: device ? { device } : undefined, domElement: domElement ?? { addEventListener: vi.fn() } };
}

/** A `domElement` fake that actually tracks + removes listeners (unlike the bare `vi.fn()` stub
 *  above), so the disposer tests can prove `removeEventListener` was really called and that
 *  a subsequent dispatch no longer reaches the handler. */
function makeDomElement() {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    addEventListener: vi.fn((type: string, cb: (e: unknown) => void) => { (listeners[type] ??= []).push(cb); }),
    removeEventListener: vi.fn((type: string, cb: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((fn) => fn !== cb);
    }),
    // `attachContextLossListeners` (`rendererLossHandling.ts`) unconditionally calls
    // `e.preventDefault()` on the WebGL path (finding (c) of #802's design) — a bare `{}` event
    // would throw there, so every emitted event carries a stub.
    emit: (type: string, evt: Record<string, unknown> = {}) => {
      for (const cb of [...(listeners[type] ?? [])]) cb({ preventDefault: () => {}, ...evt });
    },
  };
}

/** Loads a fresh `activeRenderer` + `rendererLossHandling` pair (mirrors `vi.resetModules()` +
 *  a dynamic import, done once for both modules that now cooperate to detect a loss). */
async function load() {
  vi.resetModules();
  const activeRenderer = await import('../../src/runtime/core/activeRenderer');
  const rendererLossHandling = await import('../../src/runtime/rendering/rendererLossHandling');
  return { activeRenderer, rendererLossHandling };
}

/** Simulates what a viewport (`SceneView.tsx`/`scene3DSync.ts`'s `createRenderer`/`Scene3D.tsx`
 *  via that) now wires per-renderer: context-loss detection (`attachRendererLossHandling` +
 *  `makeViewportLossPolicy`) AND the independent `uncapturederror` counter. Returns one composed
 *  detach, matching the shape every real call site uses. */
function attachViewport(
  mod: Awaited<ReturnType<typeof load>>,
  renderer: ReturnType<typeof makeRenderer>,
  isStale: () => boolean = () => false,
  label = 'test-viewport',
): () => void {
  const detachLoss = mod.rendererLossHandling.attachRendererLossHandling(
    { canvas: renderer.domElement as HTMLCanvasElement, device: renderer.backend?.device },
    { label, isStale, ...mod.activeRenderer.makeViewportLossPolicy({ renderer: renderer as never, isStale }) },
  );
  const detachUncaptured = mod.activeRenderer.attachUncapturedErrorListener(renderer as never);
  return () => { detachLoss(); detachUncaptured(); };
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
    const { activeRenderer } = await load();
    expect(activeRenderer.getGpuFaultState()).toBeNull();
  });

  it('a WEBGL viewport attach takes a clean slate, so a rebuild does not inherit the dead renderer\'s loss (#802)', async () => {
    // Regression guard for the #802 refactor, NOT a new capability. The clean-slate reset used to
    // live in `attachGpuFaultListeners`, which ran for every renderer; it now lives in
    // `attachUncapturedErrorListener`, whose body bails early when there is no WebGPU device. If
    // that reset sits BELOW the bail-out, the WebGL path never resets — and three's WebGL2 fallback
    // is the path every low-end device we ship to actually takes. A stale `deviceLost: true`
    // OUTRANKS every other explanation in `explainCaptureFailure`, so a recovered editor would go
    // on reporting itself dead forever.
    const mod = await load();
    const dead = makeDomElement();
    const detach = attachViewport(mod, makeRenderer(undefined, dead) as never);
    dead.emit('webglcontextlost');
    expect(mod.activeRenderer.getGpuFaultState()?.deviceLost).toBe(true);
    detach();

    // The rebuild: a fresh WebGL renderer, no WebGPU device anywhere in sight.
    attachViewport(mod, makeRenderer(undefined, makeDomElement()) as never);
    expect(mod.activeRenderer.getGpuFaultState()).toBeNull();
  });

  it('records a lost device with its reason + message', async () => {
    const mod = await load();
    const device = makeGpuDevice();
    attachViewport(mod, makeRenderer(device));

    device.resolveLost({ reason: 'unknown', message: 'driver reset' });
    await flush();

    expect(mod.activeRenderer.getGpuFaultState()).toEqual({
      deviceLost: true, reason: 'unknown', message: 'driver reset', uncapturedErrors: 0,
      losses: 1, unrecoverable: false,
    });
  });

  it('caps LOGGING of uncaptured errors at MAX_REPORTED_GPU_ERRORS but keeps counting past it', async () => {
    const { activeRenderer } = await load();
    const device = makeGpuDevice();
    activeRenderer.attachUncapturedErrorListener(makeRenderer(device) as never);

    const total = activeRenderer.MAX_REPORTED_GPU_ERRORS + 3;
    for (let i = 0; i < total; i++) device.emit('uncapturederror', { error: { message: `err${i}` } });

    // The COUNT is never suppressed — only the console.error call is.
    expect(activeRenderer.getGpuFaultState()?.uncapturedErrors).toBe(total);
    expect(errSpy).toHaveBeenCalledTimes(activeRenderer.MAX_REPORTED_GPU_ERRORS);
  });

  it('resets fault state when a NEW renderer\'s uncaptured-error listener attaches', async () => {
    const mod = await load();
    const deviceA = makeGpuDevice();
    attachViewport(mod, makeRenderer(deviceA));
    deviceA.resolveLost({ reason: 'unknown' });
    await flush();
    expect(mod.activeRenderer.getGpuFaultState()?.deviceLost).toBe(true);

    const deviceB = makeGpuDevice();
    attachViewport(mod, makeRenderer(deviceB)); // a fresh renderer attaches — clean slate
    expect(mod.activeRenderer.getGpuFaultState()).toBeNull();
  });

  it('records a WebGL context loss (the non-WebGPU fallback)', async () => {
    const mod = await load();
    const domElement = makeDomElement();
    attachViewport(mod, makeRenderer(undefined, domElement));

    domElement.emit('webglcontextlost');

    // `reason` stays the literal `'webglcontextlost'` across the #802 migration. An earlier cut of
    // this test pinned `undefined` and argued nothing reads the literal — true of the literal,
    // false of the FIELD: `frameDriver` renders `GPU fault: ${reason ?? 'unknown reason'}` in its
    // stall escalation, so dropping it degraded the diagnostic on exactly the WebGL devices this
    // channel exists for. `attachContextLossListeners` carries it, and `statusMessage`, through.
    expect(mod.activeRenderer.getGpuFaultState()).toEqual({
      deviceLost: true, reason: 'webglcontextlost', message: undefined, uncapturedErrors: 0,
      losses: 1, unrecoverable: false,
    });
  });

  it('NEVER throws for a bare {} renderer (no backend, no device, no domElement)', async () => {
    const { activeRenderer } = await load();
    expect(() => activeRenderer.setActiveRendererHandle({} as never)).not.toThrow();
    expect(() => activeRenderer.attachUncapturedErrorListener({} as never)).not.toThrow();
    expect(activeRenderer.getGpuFaultState()).toBeNull();
  });

  it('NEVER throws for a WebGL-ish stub (domElement present, backend/device absent)', async () => {
    const mod = await load();
    const domElement = { addEventListener: vi.fn() };
    const renderer = makeRenderer(undefined, domElement);
    expect(() => attachViewport(mod, renderer)).not.toThrow();
    expect(mod.activeRenderer.getGpuFaultState()).toBeNull();
    expect(domElement.addEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
  });
});

/**
 * FALSE-POSITIVE FILTERS (owner, 2026-08-01). Within minutes of this channel shipping it
 * reported a HEALTHY editor as dead — `reason=destroyed` logged as an error while the editor
 * rendered at 61 FPS, telling the owner to relaunch something that was fine. Both causes are
 * pinned here because this state OUTRANKS the frame-loop stall in `explainCaptureFailure`: a
 * false loss does not merely add noise, it MASKS every other explanation of a capture failure.
 *
 * #802 moved these filters from the old single-slot `attachedRenderer` identity guard onto
 * `makeViewportLossPolicy`'s `describe`/`onLost` (filter 2, reason==='destroyed') and each
 * viewport's own `isStale` closure (filter 1, superseded renderer) — pinned here against the
 * SAME shape of regression: a refactor of the detection path silently dropping a filter.
 */
describe('activeRenderer GPU fault channel — false-positive filters', () => {
  it('a deliberate device.destroy() (reason=destroyed) is NOT a fault — reports AND logs nothing', async () => {
    const mod = await load();
    const device = makeGpuDevice();
    attachViewport(mod, makeRenderer(device));

    // What three does when a renderer is disposed — i.e. every HMR reload / viewport remount.
    device.resolveLost({ reason: 'destroyed', message: 'Device was destroyed.' });
    await flush();

    expect(mod.activeRenderer.getGpuFaultState()).toBeNull();
    // `attachDeviceLostListener` logs BEFORE calling `onLost` — a naive migration would print a
    // false alarm here even with an early return in `onLost` alone. `describe` returning `null`
    // for this reason is what suppresses the log itself.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('a SUPERSEDED renderer\'s late device.lost cannot report once its viewport is stale', async () => {
    const mod = await load();
    const oldDevice = makeGpuDevice();
    let oldStale = false;
    attachViewport(mod, makeRenderer(oldDevice), () => oldStale);

    // A new renderer/viewport takes over (reload / remount) BEFORE the old device's promise
    // resolves — the old viewport's `isStale` flips, exactly as its own teardown would set it.
    oldStale = true;
    const newDevice = makeGpuDevice();
    attachViewport(mod, makeRenderer(newDevice));

    // The corpse of the old renderer speaks — with a REAL loss reason, so only the
    // superseded-renderer (`isStale`) check can suppress it.
    oldDevice.resolveLost({ reason: 'unknown', message: 'stale' });
    await flush();

    expect(mod.activeRenderer.getGpuFaultState()).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('the LIVE renderer losing its device is still reported (the filters are not a mute button)', async () => {
    const mod = await load();
    attachViewport(mod, makeRenderer(makeGpuDevice()));
    const live = makeGpuDevice();
    attachViewport(mod, makeRenderer(live));

    live.resolveLost({ reason: 'unknown', message: 'driver reset' });
    await flush();

    expect(mod.activeRenderer.getGpuFaultState()).toMatchObject({ deviceLost: true, reason: 'unknown' });
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
  it('asks a subscriber to rebuild on the first loss, with the backend AND renderer that died', async () => {
    const mod = await load();
    const seen: Array<Record<string, unknown>> = [];
    mod.activeRenderer.onRendererLost((info) => seen.push(info as unknown as Record<string, unknown>));

    const device = makeGpuDevice();
    const renderer = makeRenderer(device);
    attachViewport(mod, renderer);
    device.resolveLost({ reason: 'unknown', message: 'driver reset' });
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ api: 'WebGPU', reason: 'unknown', message: 'driver reset', attempt: 1 });
    // WHICH renderer died, by identity. The editor mounts multiple viewports and this notification
    // is a BROADCAST, so without this a healthy viewport cannot tell that the loss wasn't its own
    // — and would tear its own working renderer down in sympathy.
    expect(seen[0].renderer).toBe(renderer);
  });

  it('reports a WebGL context loss as api:WebGL — the path a low-end phone actually takes', async () => {
    const mod = await load();
    const seen: Array<{ api: string }> = [];
    mod.activeRenderer.onRendererLost((info) => seen.push(info));

    const domElement = makeDomElement();
    attachViewport(mod, makeRenderer(undefined, domElement));
    domElement.emit('webglcontextlost');

    expect(seen).toHaveLength(1);
    expect(seen[0].api).toBe('WebGL');
  });

  it('COUNTS LOSSES ACROSS RENDERER REPLACEMENTS — the whole basis of loop detection', async () => {
    // The subtle one. Every recovery installs a NEW renderer, and `attachUncapturedErrorListener`
    // deliberately clears `gpuFaultState` so the new renderer reports cleanly. If the loss
    // HISTORY were cleared on the same path, a hard rebuild loop would present as an endless
    // series of "first" losses and the budget would never trip. The history must outlive the
    // renderer; the reported state must not.
    const mod = await load();
    const attempts: number[] = [];
    mod.activeRenderer.onRendererLost((info) => attempts.push(info.attempt));

    const a = makeGpuDevice();
    attachViewport(mod, makeRenderer(a));
    a.resolveLost({ reason: 'unknown' });
    await flush();

    // The rebuild the listener would have performed: a fresh renderer registers.
    const b = makeGpuDevice();
    attachViewport(mod, makeRenderer(b));
    expect(mod.activeRenderer.getGpuFaultState()).toBeNull(); // reporting state IS reset for the new renderer
    b.resolveLost({ reason: 'unknown' });
    await flush();

    expect(attempts).toEqual([1, 2]); // ...but the loss history is NOT
  });

  it('abandons recovery past MAX_RECOVERY_ATTEMPTS and stops asking', async () => {
    const mod = await load();
    const attempts: number[] = [];
    mod.activeRenderer.onRendererLost((info) => attempts.push(info.attempt));

    for (let i = 0; i < mod.activeRenderer.MAX_RECOVERY_ATTEMPTS + 2; i++) {
      const d = makeGpuDevice();
      attachViewport(mod, makeRenderer(d));
      d.resolveLost({ reason: 'unknown' });
      await flush();
    }

    // Asked exactly up to the budget, then went quiet — no rebuild request on the 4th or 5th.
    expect(attempts).toEqual([1, 2, 3]);
    expect(mod.activeRenderer.isRecoveryAbandoned()).toBe(true);
    expect(mod.activeRenderer.getGpuFaultState()).toMatchObject({ unrecoverable: true, deviceLost: true });
    expect(errSpy).toHaveBeenCalled(); // giving up is an ERROR, unlike a recoverable loss
  });

  it('a loss OUTSIDE the window does not count toward the budget', async () => {
    const mod = await load();
    const { setManualNow, advanceManual } = await import('../../src/runtime/core/clock');
    setManualNow(0);
    const attempts: number[] = [];
    mod.activeRenderer.onRendererLost((info) => attempts.push(info.attempt));

    const a = makeGpuDevice();
    attachViewport(mod, makeRenderer(a));
    a.resolveLost({ reason: 'unknown' });
    await flush();

    // Two unrelated transient faults an hour apart are not a loop; the window must forget.
    advanceManual(mod.activeRenderer.RECOVERY_WINDOW_MS + 1);
    const b = makeGpuDevice();
    attachViewport(mod, makeRenderer(b));
    b.resolveLost({ reason: 'unknown' });
    await flush();

    expect(attempts).toEqual([1, 1]);
  });

  it('a listener that THROWS cannot stop the other subscribers from rebuilding', async () => {
    const mod = await load();
    const survived: number[] = [];
    mod.activeRenderer.onRendererLost(() => { throw new Error('bad subscriber'); });
    mod.activeRenderer.onRendererLost((info) => survived.push(info.attempt));

    const d = makeGpuDevice();
    attachViewport(mod, makeRenderer(d));
    d.resolveLost({ reason: 'unknown' });
    await flush();

    expect(survived).toEqual([1]);
  });

  it('unsubscribing stops delivery (a remounted viewport must not be asked twice)', async () => {
    const mod = await load();
    const seen: number[] = [];
    const off = mod.activeRenderer.onRendererLost((info) => seen.push(info.attempt));
    off();

    const d = makeGpuDevice();
    attachViewport(mod, makeRenderer(d));
    d.resolveLost({ reason: 'unknown' });
    await flush();

    expect(seen).toEqual([]);
  });

  it('a SUPERSEDED renderer\'s canvas losing its context does not request a rebuild', async () => {
    // The WebGL twin of the existing device.lost false-positive filter. A replaced renderer's
    // canvas is torn down as a matter of course, and that must not read as a live fault — this
    // module's whole credibility problem was crying wolf on orderly teardown.
    const mod = await load();
    const seen: unknown[] = [];
    mod.activeRenderer.onRendererLost((info) => seen.push(info));

    const oldEl = makeDomElement();
    let oldStale = false;
    attachViewport(mod, makeRenderer(undefined, oldEl), () => oldStale);
    oldStale = true;
    attachViewport(mod, makeRenderer(undefined, { addEventListener: vi.fn() }));

    oldEl.emit('webglcontextlost'); // the corpse's canvas fires

    expect(seen).toEqual([]);
    expect(mod.activeRenderer.getGpuFaultState()).toBeNull();
  });

  it('resetRecoveryState() clears the history and re-enables recovery', async () => {
    const mod = await load();
    const attempts: number[] = [];
    mod.activeRenderer.onRendererLost((info) => attempts.push(info.attempt));

    for (let i = 0; i < mod.activeRenderer.MAX_RECOVERY_ATTEMPTS + 1; i++) {
      const d = makeGpuDevice();
      attachViewport(mod, makeRenderer(d));
      d.resolveLost({ reason: 'unknown' });
      await flush();
    }
    expect(mod.activeRenderer.isRecoveryAbandoned()).toBe(true);

    mod.activeRenderer.resetRecoveryState();
    expect(mod.activeRenderer.isRecoveryAbandoned()).toBe(false);

    const d = makeGpuDevice();
    attachViewport(mod, makeRenderer(d));
    d.resolveLost({ reason: 'unknown' });
    await flush();

    expect(attempts.at(-1)).toBe(1); // counting starts over
  });

  /** #802's whole point: TWO viewports attached at once, neither disarming the other. Red before
   *  the fix — the old single-slot `attachedRenderer` meant B's attach silently stole detection
   *  away from A, so a loss on A's canvas reported nothing. */
  it('#802: renderer A stays watched after renderer B attaches — A\'s loss IS reported, with A named', async () => {
    const mod = await load();
    const seen: Array<{ renderer: unknown }> = [];
    mod.activeRenderer.onRendererLost((info) => seen.push(info));

    const elA = makeDomElement();
    const rendererA = makeRenderer(undefined, elA);
    attachViewport(mod, rendererA, () => false, 'A');

    const elB = makeDomElement();
    const rendererB = makeRenderer(undefined, elB);
    attachViewport(mod, rendererB, () => false, 'B');

    elA.emit('webglcontextlost');

    expect(seen).toHaveLength(1);
    expect(seen[0].renderer).toBe(rendererA);
  });

  /** #802, continued: B tearing down must not disarm A either — the permanent half of the old
   *  bug (closing the Particle Editor deafened SceneView for the rest of the session). */
  it('#802: A is still watched after B is DISPOSED, not just after B attaches', async () => {
    const mod = await load();
    const seen: Array<{ renderer: unknown }> = [];
    mod.activeRenderer.onRendererLost((info) => seen.push(info));

    const elA = makeDomElement();
    const rendererA = makeRenderer(undefined, elA);
    attachViewport(mod, rendererA, () => false, 'A');

    const elB = makeDomElement();
    const rendererB = makeRenderer(undefined, elB);
    let bStale = false;
    const detachB = attachViewport(mod, rendererB, () => bStale, 'B');
    bStale = true;
    detachB();

    elA.emit('webglcontextlost');

    expect(seen).toHaveLength(1);
    expect(seen[0].renderer).toBe(rendererA);
  });

  /** A preview panel (`makePreviewLossPolicy`, #795) tears itself down instead of calling
   *  `reportRendererLoss` — so its losses must never touch the global recovery budget.
   *  `rendererLossHandling.ts`'s own header names this hazard: feeding editor preview panels
   *  into the shared 3-losses-per-60s budget would let a flapping preview permanently disarm
   *  real gameplay recovery. */
  it('losses from a makePreviewLossPolicy-attached renderer do not count against the global budget', async () => {
    const mod = await load();
    const { makePreviewLossPolicy } = await import('../../src/editor/panels/previewLossPolicy');

    for (let i = 0; i < 3; i++) {
      const device = makeGpuDevice();
      const renderer = makeRenderer(device);
      mod.rendererLossHandling.attachRendererLossHandling(
        { canvas: renderer.domElement as HTMLCanvasElement, device: renderer.backend?.device },
        { label: 'PreviewPanel', isStale: () => false, ...makePreviewLossPolicy({ label: 'PreviewPanel', teardown: () => {} }) },
      );
      device.resolveLost({ reason: 'unknown' });
      await flush();
    }

    expect(mod.activeRenderer.isRecoveryAbandoned()).toBe(false);
    expect(mod.activeRenderer.getGpuFaultState()).toBeNull(); // never reached reportRendererLoss at all
  });
});

/**
 * REGISTRANTS + KTX2-caps role (#720, #802). `setActiveRendererHandle` keeps ONLY this role after
 * #802 — the GPU-fault channel above no longer runs through it at all. Before #720,
 * `activeRenderer`/`attachedRenderer` were assigned and never cleared — a teardown left
 * `getActiveRenderer()` handing consumers (the GPU particle backend, tier calibration, the memory
 * report, the draw-call probe) a DISPOSED renderer. `setActiveRendererHandle` returns a disposer
 * pairing every register with an unregister, matching the convention `onRendererLost` already uses.
 */
describe('activeRenderer disposer (#720)', () => {
  it('clears getActiveRenderer() to null after the disposer runs', async () => {
    const { activeRenderer } = await load();
    const renderer = makeRenderer();
    const dispose = activeRenderer.setActiveRendererHandle(renderer as never);

    expect(activeRenderer.getActiveRenderer()).toBe(renderer);
    dispose();
    expect(activeRenderer.getActiveRenderer()).toBeNull();
  });

  it('identity guard: an OLD renderer\'s disposer must not clear a NEWER renderer\'s handle', async () => {
    const { activeRenderer } = await load();
    const r1 = makeRenderer();
    const r2 = makeRenderer();
    const disposeR1 = activeRenderer.setActiveRendererHandle(r1 as never);
    activeRenderer.setActiveRendererHandle(r2 as never);

    disposeR1(); // a late disposer from the SUPERSEDED renderer

    expect(activeRenderer.getActiveRenderer()).toBe(r2);
  });

  it('is idempotent: calling a disposer twice does not throw and does not clear a newer renderer', async () => {
    const { activeRenderer } = await load();
    const r1 = makeRenderer();
    const disposeR1 = activeRenderer.setActiveRendererHandle(r1 as never);
    disposeR1();
    expect(activeRenderer.getActiveRenderer()).toBeNull();

    // A newer renderer takes over after the first disposed cleanly.
    const r2 = makeRenderer();
    activeRenderer.setActiveRendererHandle(r2 as never);

    expect(() => disposeR1()).not.toThrow();
    expect(activeRenderer.getActiveRenderer()).toBe(r2); // the second (stale) call must not clear r2
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
    const { activeRenderer } = await load();
    const sceneView = makeRenderer();
    const gameView = makeRenderer();
    const particleEditor = makeRenderer();

    activeRenderer.setActiveRendererHandle(sceneView as never);
    activeRenderer.setActiveRendererHandle(gameView as never);
    const closePanel = activeRenderer.setActiveRendererHandle(particleEditor as never);

    closePanel(); // the Particle Editor panel closes; the other two are still drawing

    expect(activeRenderer.getActiveRenderer()).toBe(gameView);
    expect(activeRenderer.getActiveRenderer()).not.toBeNull();
  });

  it('only reaches null once the LAST registrant is gone', async () => {
    const { activeRenderer } = await load();
    const a = makeRenderer();
    const b = makeRenderer();
    const disposeA = activeRenderer.setActiveRendererHandle(a as never);
    const disposeB = activeRenderer.setActiveRendererHandle(b as never);

    disposeB();
    expect(activeRenderer.getActiveRenderer()).toBe(a);
    disposeA();
    expect(activeRenderer.getActiveRenderer()).toBeNull();
  });

  /** A repeat registration of the SAME renderer must leave ONE entry — two would mean its disposer
   *  removes only one and the corpse stays reachable through the survivor fallback. */
  it('re-seats rather than duplicating when the same renderer registers twice', async () => {
    const { activeRenderer } = await load();
    const older = makeRenderer();
    const repeat = makeRenderer();
    activeRenderer.setActiveRendererHandle(older as never);
    activeRenderer.setActiveRendererHandle(repeat as never);
    const disposeRepeat = activeRenderer.setActiveRendererHandle(repeat as never); // registered TWICE

    disposeRepeat();

    expect(activeRenderer.getActiveRenderer()).toBe(older); // not `repeat` again from a duplicate entry
  });

  /** Pins the `disposed` latch specifically. Review found the old idempotence test passed with the
   *  latch deleted (the identity guard alone satisfied it), so it named a flag it did not cover.
   *  This is the case only the latch can survive: a renderer that is disposed and then REGISTERS
   *  AGAIN. Without the latch, the stale first disposer removes the live re-registration and the
   *  handle falls back past a renderer that is still drawing. */
  it('a stale disposer cannot unregister its renderer\'s LATER re-registration', async () => {
    const { activeRenderer } = await load();
    const r = makeRenderer();
    const staleDispose = activeRenderer.setActiveRendererHandle(r as never);
    staleDispose();
    expect(activeRenderer.getActiveRenderer()).toBeNull();

    // The SAME renderer comes back (a viewport remount reusing the renderer lease).
    activeRenderer.setActiveRendererHandle(r as never);
    expect(activeRenderer.getActiveRenderer()).toBe(r);

    staleDispose(); // the first disposer fires late — it must be inert now

    expect(activeRenderer.getActiveRenderer()).toBe(r);
  });

  it('removes the webglcontextlost listener — a dispatch after the viewport detaches reports nothing', async () => {
    const mod = await load();
    const domElement = makeDomElement();
    const renderer = makeRenderer(undefined, domElement);
    const detach = attachViewport(mod, renderer);

    detach();
    domElement.emit('webglcontextlost');

    // A live listener would call reportRendererLoss(), which warns. No warn ⇒ nothing fired.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(domElement.removeEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
  });

  it('does NOT reset lossTimes on a viewport detach — loss count keeps counting across the teardown', async () => {
    const mod = await load();
    const attempts: number[] = [];
    mod.activeRenderer.onRendererLost((info) => attempts.push(info.attempt));

    const a = makeGpuDevice();
    const rendererA = makeRenderer(a);
    const detachA = attachViewport(mod, rendererA);
    a.resolveLost({ reason: 'unknown' });
    await flush();
    expect(attempts).toEqual([1]);

    detachA(); // teardown of the viewport that owned the now-dead renderer

    const b = makeGpuDevice();
    attachViewport(mod, makeRenderer(b)); // the recovery rebuild
    b.resolveLost({ reason: 'unknown' });
    await flush();

    // If the detach had reset lossTimes, this would read back as attempt 1 again.
    expect(attempts).toEqual([1, 2]);
  });
});
