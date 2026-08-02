/** The active-renderer handle — extracted out of `loaders/textureResolver.ts` (P7 C7) since it's
 *  a plain global registry (same shape as `core/playState.ts`), not something owned by texture
 *  loading. `loaders/textureResolver.ts` keeps its own `setActiveRenderer` wrapper (it still runs
 *  the KTX2 `detectSupport` side effect there) but delegates the handle + ready-state bookkeeping
 *  here, so the GPU particle backend (`particles/particleBackend.ts`) can read `getActiveRenderer`
 *  directly instead of reaching into `loaders/` for a renderer handle it has nothing else to do
 *  with. */

import type { WebGPURenderer } from 'three/webgpu';
import type * as THREE from 'three';

let activeRenderer: WebGPURenderer | THREE.WebGLRenderer | null = null;

/** Resolves on the FIRST `setActiveRendererHandle` call. Editor bootstrap awaits this before
 *  calling `sceneManager.loadScene()` so the KTX2 transcoder has the GPU caps it needs before
 *  any texture load fires — without that ordering, scene preload races renderer init and
 *  KTX2Loader.loadAsync throws "Missing initialization with .detectSupport()" on the first
 *  ASTC-variant material. Public so callers can await it directly. */
let _rendererReadyResolve: () => void;
export const rendererReady: Promise<void> = new Promise((r) => { _rendererReadyResolve = r; });
let rendererReadyFired = false;

/** The most recently activated renderer, or null before init. Used by the GPU
 *  particle backend to dispatch compute passes (the CPU backend needs no renderer
 *  ref — it uploads via instanced attributes at render time). */
export function getActiveRenderer(): WebGPURenderer | THREE.WebGLRenderer | null {
  return activeRenderer;
}

/** True once the renderer has been activated at least once. Callers that need to run a
 *  detection side effect exactly once on first activation gate on this. */
export function isRendererReadyFired(): boolean {
  return rendererReadyFired;
}

/** Store the active renderer handle and, on the FIRST call only, resolve `rendererReady`.
 *  Idempotent + cheap — safe to call from every renderer creation site. Every call site
 *  (`loaders/textureResolver.ts`'s `setActiveRenderer` wrapper — the only caller) runs
 *  `KTX2Loader.detectSupport` before reaching here, so a real viewport registering always
 *  implies KTX2 caps are ready too; mark that channel alongside this one. */
export function setActiveRendererHandle(renderer: WebGPURenderer | THREE.WebGLRenderer): void {
  activeRenderer = renderer;
  if (!rendererReadyFired) {
    rendererReadyFired = true;
    _rendererReadyResolve();
  }
  markKtx2CapsReady('viewport');
  attachGpuFaultListeners(renderer);
}

// ── GPU fault channel ──────────────────────────────────────────────────────────────────────
// WebGPU device loss and uncaptured errors were handled NOWHERE in the repo before this: the
// symptom (the frame loop stops pumping) was reported by `frameDriver`'s stall watchdog, but the
// CAUSE — the GPU device itself dying, or a driver-level error Chromium couldn't route to a
// specific pipeline call — went unlogged. A reader saw "the frame loop is STALLED... relaunch the
// editor" with no way to tell "the renderer is wedged" (recoverable-in-place, sometimes) from "the
// GPU device is gone" (never self-recovers, and relaunching IS the only fix — now at least the
// right one). This channel exists to record the cause; it deliberately does NOT attempt recovery.

/** How many `uncapturederror` events we LOG before going quiet — mirrors `frameDriver`'s
 *  `MAX_REPORTED_ATTEMPTS`. An uncaptured-error flood (a single bad frame can fire dozens) is
 *  exactly the kind of noise that buried a real first error before (see main.ts's
 *  `render-process-gone` history) — only the log is capped, the recording of the count is not. */
export const MAX_REPORTED_GPU_ERRORS = 5;

export interface GpuFaultState {
  deviceLost: boolean;
  reason?: string;
  message?: string;
  uncapturedErrors: number;
}

let gpuFaultState: GpuFaultState | null = null;
/** Which renderer we last attached listeners to — lets a NEW renderer handle (a relaunch, or a
 *  viewport remount) get a clean slate instead of inheriting a previous renderer's fault state,
 *  and lets attaching to the SAME renderer twice stay a no-op (idempotent). */
let attachedRenderer: WebGPURenderer | THREE.WebGLRenderer | null = null;

/** Current GPU fault, or null when nothing has gone wrong. Read by the editor-state payload
 *  (`agentEditorOps.ts`) and by `explainCaptureFailure` via the same channel `frameLoop`/
 *  `rendererGate` use — omitted entirely while healthy (see those two for the convention). */
export function getGpuFaultState(): GpuFaultState | null {
  return gpuFaultState;
}

/** Attach GPU fault listeners to a newly-activated renderer. NEVER throws into the caller — the
 *  device/backend shape is version-dependent (three's WebGPU internals are not a stable public
 *  API), so every hop is guarded; a failure here just means faults go unreported, not that
 *  `setActiveRendererHandle` fails. */
function attachGpuFaultListeners(renderer: WebGPURenderer | THREE.WebGLRenderer): void {
  if (renderer === attachedRenderer) return; // already attached — idempotent
  attachedRenderer = renderer;
  gpuFaultState = null; // a new renderer starts with a clean slate

  try {
    attachWebGpuDeviceListeners(renderer);
  } catch { /* must never throw into setActiveRendererHandle */ }

  try {
    attachWebGlContextLostListener(renderer);
  } catch { /* must never throw into setActiveRendererHandle */ }
}

/** Reach through three's WebGPU backend to the raw `GPUDevice` and attach `device.lost` +
 *  `uncapturederror`. Every property access is optional-chained: `renderer.backend.device` is
 *  three-internal (not exported in its public types) and has moved before. A WebGL renderer, or
 *  a WebGPU renderer that fell back to WebGL internally, simply has none of these and this is a
 *  silent no-op. */
function attachWebGpuDeviceListeners(renderer: WebGPURenderer | THREE.WebGLRenderer): void {
  const device = (renderer as unknown as { backend?: { device?: GPUDevice } })?.backend?.device;
  if (!device) return;

  device.lost?.then((info: GPUDeviceLostInfo) => {
    // ── TWO FALSE-POSITIVE FILTERS, both found by this code reporting a HEALTHY editor as dead
    //    within minutes of shipping (owner, 2026-08-01: a `reason=destroyed` error logged at
    //    61 FPS, telling them to relaunch an editor that was rendering fine). A diagnostic that
    //    cries wolf is worse than none: this one OUTRANKS the frame-loop stall in
    //    `explainCaptureFailure`, so a false loss would mask every other explanation.
    //
    // 1. SUPERSEDED RENDERER. `device.lost` is a promise that can resolve long after its renderer
    //    was replaced (an HMR reload, a viewport remount). By then `attachGpuFaultListeners` has
    //    already reset the state for the NEW renderer, and this late callback would overwrite it
    //    with the corpse of the old one. Only the renderer we are still attached to may speak.
    if (renderer !== attachedRenderer) return;
    // 2. DELIBERATE TEARDOWN. Per the WebGPU spec `reason === 'destroyed'` means someone called
    //    `device.destroy()` — three does this when disposing a renderer, which is exactly what a
    //    reload/remount looks like. That is an orderly shutdown, not a fault: the replacement
    //    renderer brings its own device. Only 'unknown' is a REAL loss (driver reset, TDR, the OS
    //    reclaiming the GPU), and only that is worth a word.
    if (info.reason === 'destroyed') return;
    // A real loss: nothing renders again on THIS device. Recovery would mean re-creating the whole
    // renderer, which is explicitly out of scope here (log-only).
    gpuFaultState = {
      deviceLost: true,
      reason: info.reason,
      message: info.message,
      uncapturedErrors: gpuFaultState?.uncapturedErrors ?? 0,
    };
    console.error(
      `[activeRenderer] WebGPU DEVICE LOST reason=${info.reason} message=${info.message} — ` +
      'nothing will render again on this device. This does NOT self-recover; relaunch the editor.',
    );
  }).catch(() => { /* device.lost rejecting is not itself a fault worth reporting */ });

  device.addEventListener?.('uncapturederror', (e: Event) => {
    const message = (e as unknown as { error?: { message?: string } })?.error?.message;
    const count = (gpuFaultState?.uncapturedErrors ?? 0) + 1;
    gpuFaultState = { ...(gpuFaultState ?? { deviceLost: false }), uncapturedErrors: count };
    if (count <= MAX_REPORTED_GPU_ERRORS) {
      console.error(
        `[activeRenderer] WebGPU uncaptured error (#${count}): ${message}` +
        (count === MAX_REPORTED_GPU_ERRORS
          ? ' Further uncaptured errors will be counted but NOT logged (suppressed to avoid ' +
            'burying the real first error under a flood).'
          : ''),
      );
    }
  });
}

/** WebGL fallback: `webglcontextlost` is the WebGL equivalent of a lost GPU device — fired on the
 *  canvas, not a device object. Recorded into the same `GpuFaultState` shape so callers don't
 *  need to know which backend is active. */
function attachWebGlContextLostListener(renderer: WebGPURenderer | THREE.WebGLRenderer): void {
  const el = (renderer as unknown as { domElement?: EventTarget })?.domElement;
  el?.addEventListener?.('webglcontextlost', () => {
    gpuFaultState = {
      deviceLost: true,
      reason: 'webglcontextlost',
      uncapturedErrors: gpuFaultState?.uncapturedErrors ?? 0,
    };
    console.error(
      '[activeRenderer] WebGL CONTEXT LOST — nothing will render again on this context. ' +
      'This does NOT self-recover; relaunch the editor.',
    );
  });
}

// ── KTX2 transcoder-caps channel ───────────────────────────────────────────────────────────
// Independent of `rendererReady` ("a real viewport renderer is live"). A viewport registering
// always implies caps are ready (see the comment above), but caps can ALSO become ready via a
// throwaway probe renderer (`ensureKtx2Caps` in `loaders/textureResolver.ts`) when no viewport
// ever mounts. The probe deliberately does NOT call `setActiveRendererHandle` / resolve
// `rendererReady` — the GPU particle backend (`particles/particleBackend.ts`) and shader
// prewarm genuinely need a *rendering* renderer, not just transcoder capability booleans, so a
// probe masquerading as one would be silently wrong for those consumers.

let _ktx2CapsReadyResolve: () => void;
export const ktx2CapsReady: Promise<void> = new Promise((r) => { _ktx2CapsReadyResolve = r; });
let ktx2CapsReadyFired = false;
let ktx2CapsSource: 'viewport' | 'probe' | 'none' = 'none';

/** True once KTX2 transcoder caps are known, whether from a real viewport or a probe. */
export function areKtx2CapsReady(): boolean {
  return ktx2CapsReadyFired;
}

/** Mark KTX2 caps ready without implying a live renderer. Idempotent — first call wins the
 *  recorded `source`, e.g. if a probe and a real viewport race, whichever settles first sticks. */
export function markKtx2CapsReady(source: 'viewport' | 'probe'): void {
  if (!ktx2CapsReadyFired) {
    ktx2CapsReadyFired = true;
    ktx2CapsSource = source;
    _ktx2CapsReadyResolve();
  }
}

/** Which path resolved KTX2 caps — surfaced in `RendererGateHealth` for agent diagnosis. */
export function getKtx2CapsSource(): 'viewport' | 'probe' | 'none' {
  return ktx2CapsSource;
}

// ── Renderer-init failure channel ─────────────────────────────────────────────────────────
// `rendererReady` alone can only ever say "not yet". It cannot distinguish a renderer that is
// STILL WARMING UP (a cold Vite dep-optimize / first WGSL compile, legitimately slow) from one
// whose init has definitively FAILED — so every waiter had to assume the optimistic case and
// sit out the full 120s cold-start budget before saying anything. Measured: a renderer whose
// creation threw at t≈1.5s still left the editor blank and silent for two minutes.
//
// These two states are distinguishable at the source, so they get separate channels: the
// viewport reports a definitive failure here and waiters give up in milliseconds, while the
// generous timeout stays reserved for the genuinely-slow-but-fine case it was written for.

/** Progress note from the viewport, purely for diagnosis — the last thing renderer bring-up
 *  managed to do. Lets a timeout report FACTS instead of guessing "SceneView never mounted". */
const NO_VIEWPORT_NOTE = 'no viewport has begun renderer init';
let progressNote = NO_VIEWPORT_NOTE;
let viewportBegan = false;
let initFailure: Error | null = null;
const failWaiters = new Set<(e: Error) => void>();

/** Record how far renderer bring-up has got (`'creating renderer (attempt 2)'`, …). */
export function noteRendererProgress(note: string): void {
  progressNote = note;
  viewportBegan = true;
}

/** Has ANY viewport even started trying to create a renderer?
 *
 *  This is the load-bearing distinction behind the two timeout budgets. "Renderer is slow"
 *  and "no viewport ever ran" are completely different faults that used to be indistinguishable
 *  — both just looked like `rendererReady` not settling — so both had to wait out the 120s
 *  budget sized for the slowest legitimate cold start. If nothing has even BEGUN after a few
 *  seconds, no amount of further waiting will help, and that case can be failed fast. */
export function hasViewportBegunInit(): boolean {
  return viewportBegan;
}

/** The latest progress note — included in timeout diagnostics. */
export function getRendererProgress(): string {
  return progressNote;
}

/** Report that renderer init has definitively failed (all retries exhausted). Wakes every
 *  waiter immediately instead of leaving them on the cold-start timeout. */
export function reportRendererInitFailure(err: Error): void {
  if (rendererReadyFired) return; // a renderer is already live; a later failure is not fatal
  initFailure = err;
  for (const fn of failWaiters) { try { fn(err); } catch { /* a bad waiter must not block others */ } }
  failWaiters.clear();
}

/** Clear a previous failure because a fresh attempt is starting — so a viewport that
 *  remounts and succeeds is not permanently poisoned by an earlier failure. */
export function clearRendererInitFailure(): void {
  initFailure = null;
}

/** Resolves ONLY if renderer init definitively fails. Raced against `rendererReady` by
 *  waiters that want the real cause fast. Never resolves on the happy path. */
export function rendererInitFailedPromise(): Promise<Error> {
  if (initFailure) return Promise.resolve(initFailure);
  return new Promise<Error>((resolve) => { failWaiters.add(resolve); });
}

/** Health of the 3D-viewport renderer gate — the companion to `frameLoop`. They fail
 *  INDEPENDENTLY and neither implies the other: a renderer that never initialised leaves the
 *  frame loop pumping happily at 60fps (GameView drives it) while the scene never loads —
 *  measured — which is exactly why `fps` alone could not tell this wedge from a healthy editor.
 *
 *  `status`:
 *   - `'ready'`   — a renderer is registered; scenes can load.
 *   - `'pending'` — bring-up still in progress. Normal for the first seconds of a cold start.
 *   - `'failed'`  — init definitively failed after all retries. Does NOT self-recover;
 *                   nothing renders and no scene loads until the editor relaunches. */
export interface RendererGateHealth {
  status: 'ready' | 'pending' | 'failed';
  progress: string;
  error?: string;
  /** Which path resolved KTX2 transcoder caps: a real viewport, the demand-driven probe
   *  (`ensureKtx2Caps`), or neither yet. Independent of `status` — a viewport-less layout can
   *  sit at `status: 'pending'` while `capsSource` is already `'probe'`. */
  capsSource: 'viewport' | 'probe' | 'none';
}

export function getRendererGateHealth(): RendererGateHealth {
  const capsSource = getKtx2CapsSource();
  if (rendererReadyFired) return { status: 'ready', progress: progressNote, capsSource };
  if (initFailure) return { status: 'failed', progress: progressNote, error: initFailure.message, capsSource };
  return { status: 'pending', progress: progressNote, capsSource };
}

/** Subscribe to the FIRST renderer activation. Used by callers that need to react once the
 *  renderer is known, without keeping their own ready-state bookkeeping. */
export function onRendererReady(fn: () => void): void {
  if (rendererReadyFired) { fn(); return; }
  rendererReady.then(fn);
}
