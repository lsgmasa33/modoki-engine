/** The active-renderer handle — extracted out of `loaders/textureResolver.ts` (P7 C7) since it's
 *  a plain global registry (same shape as `core/playState.ts`), not something owned by texture
 *  loading. `loaders/textureResolver.ts` keeps its own `setActiveRenderer` wrapper (it still runs
 *  the KTX2 `detectSupport` side effect there) but delegates the handle + ready-state bookkeeping
 *  here, so the GPU particle backend (`particles/particleBackend.ts`) can read `getActiveRenderer`
 *  directly instead of reaching into `loaders/` for a renderer handle it has nothing else to do
 *  with. */

import type { WebGPURenderer } from 'three/webgpu';
import type * as THREE from 'three';
// The sanctioned wall-clock wrapper — a direct `Date.now()`/`performance.now()` here would fail
// the determinism guard, and routing through it also makes the recovery WINDOW testable
// (`setManualNow`/`advanceManual`) instead of needing real elapsed seconds in a unit test.
import { rawNow } from './clock';

let activeRenderer: WebGPURenderer | THREE.WebGLRenderer | null = null;

/** Every renderer currently registered, oldest first; `activeRenderer` is always the LAST entry.
 *
 *  ⚠️ **A STACK, not a single slot, because three surfaces register through one global** —
 *  `SceneView`, `Scene3D` (GameView) and `ParticleEditor` — and they are alive at the same time.
 *  The obvious teardown ("null it if it is still mine") is WRONG here, and worse than the leak it
 *  fixes: closing the Particle Editor panel would null the handle while SceneView and GameView are
 *  still drawing every frame, and nothing re-registers (`setActiveRenderer` runs only at renderer
 *  CREATION). Everything reading the handle then degrades silently — `gpuEligible` routes every
 *  `simulation: 'gpu'` effect onto the CPU sim, `applyLightMask` stops masking, and
 *  `gpuMemoryReport` reports zero GPU bytes, i.e. **a live leak reads as no leak**. Before the
 *  disposer existed the stale handle at least still answered `isWebGPUBackend === true`.
 *
 *  So a disposer removes its OWN entry and hands the handle back to the most recent survivor,
 *  reaching null only when the last registrant goes. Membership is by identity, so a repeat
 *  registration re-seats rather than duplicating. */
const registrants: Array<WebGPURenderer | THREE.WebGLRenderer> = [];

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

/** Which GRAPHICS API a renderer is actually drawing through — the single source of truth for
 *  that question (#147). `deviceCaps` and the perf HUD both report it, and both used to derive it
 *  independently from the same wrong signal.
 *
 *  ⚠️ **`isWebGPURenderer` is the renderer CLASS, not the API.** `makeWebGPURenderer` always
 *  constructs a `WebGPURenderer`, and three runs its WebGL2 backend *inside that same class* when
 *  there is no adapter or the project set `rendering.three.backend: 'webgl'`. So that flag is
 *  `true` on every device we ship to, and reading it made `'WebGL'` unreachable: an iPhone 8
 *  reported `'WebGPU'` next to `webgpu: false` in the same payload while genuinely running WebGL2.
 *  `backend.isWebGLBackend` is the real signal — `Scene3D.tsx` already plans FXAA off it.
 *
 *  three assigns `.backend` in the renderer CONSTRUCTOR (it picks the class from `forceWebGL` /
 *  adapter availability), so this is safe to read before `init()`. The class fall-through covers
 *  only a renderer-like with no `.backend` at all: a test double, or a classic `WebGLRenderer`. */
export function readRendererBackend(renderer: unknown): 'WebGPU' | 'WebGL' | null {
  const r = renderer as { isWebGPURenderer?: boolean; backend?: { isWebGLBackend?: boolean } } | null;
  if (!r) return null;
  if (r.backend) return r.backend.isWebGLBackend === true ? 'WebGL' : 'WebGPU';
  return r.isWebGPURenderer ? 'WebGPU' : 'WebGL';
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
 *  implies KTX2 caps are ready too; mark that channel alongside this one.
 *
 *  Texture/KTX2-caps role ONLY (#802) — this no longer arms any GPU-fault detection. That moved
 *  to `makeViewportLossPolicy` + `attachUncapturedErrorListener`, wired per-viewport instead of
 *  through this shared handle: the old single-slot detection meant closing one registrant (e.g.
 *  the Particle Editor) silently disarmed another's (SceneView's) detection, and this handle's
 *  own re-seating disposer below exists for exactly the analogous reason on the texture side —
 *  see `registrants`.
 *
 *  Returns a disposer: on teardown it re-seats the handle onto the most recent survivor,
 *  reaching null only when the last registrant goes. Idempotent; never throws. */
export function setActiveRendererHandle(renderer: WebGPURenderer | THREE.WebGLRenderer): () => void {
  // Re-seat rather than duplicate: a repeat registration of the same renderer must leave ONE entry,
  // or its disposer would remove only one of them and the corpse would stay reachable.
  const existing = registrants.indexOf(renderer);
  if (existing >= 0) registrants.splice(existing, 1);
  registrants.push(renderer);
  activeRenderer = renderer;
  if (!rendererReadyFired) {
    rendererReadyFired = true;
    _rendererReadyResolve();
  }
  markKtx2CapsReady('viewport');

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Drop THIS renderer and hand the handle to the most recent survivor — null only when the
    // last registrant goes. See `registrants`: nulling unconditionally breaks the viewports that
    // are still drawing.
    const at = registrants.indexOf(renderer);
    if (at >= 0) registrants.splice(at, 1);
    activeRenderer = registrants[registrants.length - 1] ?? null;
  };
}

// ── GPU fault channel ──────────────────────────────────────────────────────────────────────
// WebGPU device loss and uncaptured errors were handled NOWHERE in the repo before this: the
// symptom (the frame loop stops pumping) was reported by `frameDriver`'s stall watchdog, but the
// CAUSE — the GPU device itself dying, or a driver-level error Chromium couldn't route to a
// specific pipeline call — went unlogged. A reader saw "the frame loop is STALLED... relaunch the
// editor" with no way to tell "the renderer is wedged" (recoverable-in-place, sometimes) from "the
// GPU device is gone". This channel records the cause AND drives recovery (see the recovery
// section below) — it was log-only until #121 P1.
//
// #802 moved DETECTION out of this module's own single-slot `attachedRenderer` (see history in
// git blame if needed) and onto the shared per-renderer contract `rendererLossHandling.ts`
// established for the editor preview panels (#795): `makeViewportLossPolicy` below builds the
// `{describe, onLost}` half, and each viewport wires it through `attachRendererLossHandling` +
// its own `isStale` closure. A single global slot meant a second registrant (the Particle Editor)
// silently disarmed the first (SceneView) — the exact #802 bug. This module still OWNS policy
// (the recovery window/budget in `reportRendererLoss`, below) and the two false-positive filters
// that shipping this channel already paid for once (see `makeViewportLossPolicy`'s doc) — only
// the per-renderer identity/attach mechanics moved.

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
  /** How many losses have been seen inside the current recovery window (§ recovery below).
   *  1 on a first, expected-recoverable loss. Counts ACROSS renderer replacements, so a
   *  rebuild that immediately dies again reads 2 — that is the signal loop detection needs. */
  losses?: number;
  /** True once loss has repeated past `MAX_RECOVERY_ATTEMPTS` inside the window: recovery has
   *  been abandoned and no further rebuild will be requested. A permanently-black surface. */
  unrecoverable?: boolean;
}

let gpuFaultState: GpuFaultState | null = null;

/** Current GPU fault, or null when nothing has gone wrong. Read by the editor-state payload
 *  (`agentEditorOps.ts`) and by `explainCaptureFailure` via the same channel `frameLoop`/
 *  `rendererGate` use — omitted entirely while healthy (see those two for the convention). */
export function getGpuFaultState(): GpuFaultState | null {
  return gpuFaultState;
}

// ── Recovery (#121 P1) ─────────────────────────────────────────────────────────────────────
// Before this, a lost context was PERMANENT: detected, logged, and nothing rendered again for
// the process lifetime. Measured on a Huawei Y6 2019 — the WebGL2 context died ~4s into boot,
// before any scene mesh had finished uploading, and the game showed a black screen forever.
//
// THE LOAD-BEARING FACT, checked against three r0.184 rather than assumed:
//
//   A lost three renderer CANNOT be revived. `WebGLBackend.onContextLost` already calls
//   `event.preventDefault()` (so the browser WILL restore the underlying context) and routes to
//   `renderer.onDeviceLost()`, whose default sets the private `_isDeviceLost = true`. That flag
//   gates `render()` at three separate sites and is NEVER cleared anywhere in three. So even a
//   fully restored GL context renders nothing through the old renderer object.
//
// Recovery therefore means BUILDING A NEW RENDERER, and only the viewport that created one can
// do that — it owns the container, the DOM node, and the render-loop closure. This module owns
// DETECTION and POLICY and asks; it cannot rebuild, and must not pretend to. Viewports subscribe
// via `onRendererLost`.
//
// The plan's P1 called for `preventDefault()` here. It is already three's, not ours — adding a
// second one would have been a no-op mistaken for the fix.

/** Losses tolerated inside `RECOVERY_WINDOW_MS` before recovery is abandoned. The 4th loss in a
 *  window stops asking: a rebuild loop on a device that cannot sustain a context burns battery
 *  and buries the first real error, and the honest outcome is a visible failure. */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Sliding window for `MAX_RECOVERY_ATTEMPTS`. Long enough that two unrelated transient faults
 *  minutes apart are each treated as a fresh, recoverable event rather than a "loop". */
export const RECOVERY_WINDOW_MS = 60_000;

export interface RendererLostInfo {
  /** Which backend died. Both are recoverable by the same rebuild. */
  api: 'WebGL' | 'WebGPU';
  reason?: string;
  message?: string;
  /** 1-based index of this loss within the window — i.e. which rebuild attempt this asks for. */
  attempt: number;
  /** WHICH renderer died. Present so a subscriber can ignore a loss that isn't its own.
   *
   *  This matters because the notification is a BROADCAST and the editor mounts TWO viewports
   *  (SceneView + GameView), each owning its own renderer. Without this, one viewport's context
   *  loss would tear down and rebuild the other viewport's perfectly healthy renderer — a
   *  gratuitous shader-prewarm stall, and a fresh chance to fail, on a surface that never had a
   *  problem. Compare by identity and return early when it isn't yours.
   *
   *  Comes from the attachment's own closure (`makeViewportLossPolicy`'s `renderer` argument),
   *  not a shared global — #802 fixed the pre-existing limit noted here before this comment was
   *  updated: every attached viewport is watched now, not only the one most recently registered
   *  through the old single-slot `attachedRenderer`. */
  renderer: WebGPURenderer | THREE.WebGLRenderer | null;
}

/** Loss timestamps inside the current window.
 *
 *  DELIBERATELY NOT reset when a viewport attaches. `attachUncapturedErrorListener` clears
 *  `gpuFaultState` so a new renderer starts clean (it took over that job from the deleted
 *  `attachGpuFaultListeners` in #802), which is right for REPORTING and would be fatal here: every
 *  recovery installs a new renderer, so resetting the history on attach would zero the counter on
 *  the very event it exists to count, and a hard rebuild loop would look like an unbroken series
 *  of first-time losses and never trip. Only `resetRecoveryState()` clears it. */
let lossTimes: number[] = [];
let recoveryAbandoned = false;
const lostListeners = new Set<(info: RendererLostInfo) => void>();

/** Subscribe to "your renderer is dead — build a new one". Returns an unsubscribe function.
 *
 *  Fires only while recovery is still viable; once `MAX_RECOVERY_ATTEMPTS` is exceeded inside the
 *  window it goes quiet permanently (`getGpuFaultState().unrecoverable`). A listener must NEVER
 *  throw — one bad subscriber cannot be allowed to stop the others from rebuilding. */
export function onRendererLost(fn: (info: RendererLostInfo) => void): () => void {
  lostListeners.add(fn);
  return () => { lostListeners.delete(fn); };
}

/** True once repeated loss has exhausted the recovery budget. */
export function isRecoveryAbandoned(): boolean {
  return recoveryAbandoned;
}

/** Clear loss history + the abandoned flag. For tests, and for a deliberate fresh start (a new
 *  project/scene session) — NOT for a routine renderer swap, which must keep the history. */
export function resetRecoveryState(): void {
  lossTimes = [];
  recoveryAbandoned = false;
}

/** Record a real device/context loss and, if the budget allows, ask viewports to rebuild.
 *  Every attached viewport's `onLost` funnels here (via `makeViewportLossPolicy`) so the policy
 *  exists in exactly one place. Module-private: `renderer` comes from the CALLER's closure
 *  (the attachment that detected the loss), not from a shared global — #802 replaced the old
 *  single-slot `attachedRenderer` this used to read, which a second registrant could silently
 *  overwrite. */
function reportRendererLoss(
  renderer: WebGPURenderer | THREE.WebGLRenderer | null,
  api: 'WebGL' | 'WebGPU',
  reason?: string,
  message?: string,
): void {
  const now = rawNow();
  lossTimes = lossTimes.filter((t) => now - t < RECOVERY_WINDOW_MS);
  lossTimes.push(now);
  const attempt = lossTimes.length;

  gpuFaultState = {
    deviceLost: true,
    reason,
    message,
    uncapturedErrors: gpuFaultState?.uncapturedErrors ?? 0,
    losses: attempt,
    unrecoverable: attempt > MAX_RECOVERY_ATTEMPTS,
  };

  if (attempt > MAX_RECOVERY_ATTEMPTS) {
    recoveryAbandoned = true;
    console.error(
      `[activeRenderer] ${api} device lost ${attempt}x within ${RECOVERY_WINDOW_MS / 1000}s — ` +
      'giving up on recovery. Nothing will render. This usually means the device cannot sustain ' +
      'this scene; try a lower quality tier.',
    );
    return;
  }

  console.warn(
    `[activeRenderer] ${api} device/context LOST (${attempt}/${MAX_RECOVERY_ATTEMPTS})` +
    `${reason ? ` reason=${reason}` : ''}${message ? ` message=${message}` : ''} — ` +
    'rebuilding the renderer. Expect a visible hitch.',
  );

  for (const fn of lostListeners) {
    // A listener that throws must not prevent the others from rebuilding. Reported, not swallowed
    // silently: a viewport that cannot rebuild is exactly the fault worth seeing.
    try { fn({ api, reason, message, attempt, renderer }); }
    catch (e) { console.error('[activeRenderer] a renderer-lost listener threw', e); }
  }
}

/** Structural (not imported) twin of `runtime/rendering/rendererLossHandling.ts`'s
 *  `RendererLossHandlers` — `{describe, isStale, label, onLost}`. This file is L0 core
 *  (`engine/eslint.config.js`'s layer contract: "L0 core may import: nothing"), and
 *  `rendererLossHandling.ts` lives in `rendering/`, an L2 subsystem — so the real interface
 *  cannot be imported here even for a type. Callers (viewports — all L3/editor code, so
 *  unrestricted) spread this return value into an object typed against the real interface,
 *  the same composition `editor/panels/previewLossPolicy.ts`'s `makePreviewLossPolicy` already
 *  uses for the preview-panel family. */
export interface ViewportLossPolicyOptions {
  /** The renderer this policy watches — reported as `RendererLostInfo.renderer` so a subscriber
   *  (`onRendererLost`) can tell which viewport's renderer actually died. */
  renderer: WebGPURenderer | THREE.WebGLRenderer;
  /** This ATTACHMENT's own stale check — true once its renderer has been superseded or disposed.
   *  Replaces the old single-slot `renderer !== attachedRenderer` guard (#802): each viewport
   *  supplies its own closure now, so tearing one down can never disarm a survivor's detection —
   *  the bug this issue exists to fix. */
  isStale: () => boolean;
}

/** Build the `{label, isStale, describe, onLost}` policy a viewport passes to
 *  `attachRendererLossHandling` — the per-renderer detection contract #795 established for the
 *  editor preview panels, now also the way `SceneView`/`Scene3D`/`scene3DSync`'s GameView detect
 *  loss (#802 deleted the old single-slot `attachedRenderer` these three shared).
 *
 *  Preserves the two false-positive filters this channel already paid for once (owner,
 *  2026-08-01: a `reason=destroyed` loss logged as an error while the editor rendered at a
 *  healthy 61 FPS):
 *   1. SUPERSEDED RENDERER — the caller's `isStale` closure, checked by
 *      `attachRendererLossHandling` before anything else runs.
 *   2. DELIBERATE TEARDOWN (`reason === 'destroyed'`, WebGPU-only) — three calls
 *      `device.destroy()` when disposing a renderer, which is exactly what a reload/remount
 *      looks like, not a fault. `describe` returns `null` to suppress the log (needed because
 *      `attachDeviceLostListener` logs BEFORE calling `onLost`, so an early return in `onLost`
 *      alone would still print a false alarm) and `onLost` early-returns to suppress the report.
 *
 *  ⚠️ `attachContextLossListeners` calls `e.preventDefault()` unconditionally on the WebGL path;
 *  the old `attachWebGlContextLostListener` here deliberately did not, because three's own
 *  `WebGLBackend` listener already does (that's what makes the browser willing to restore the
 *  context at all). A second `preventDefault()` on the same event changes nothing — this is a
 *  known, harmless behaviour change from the pre-#802 code, not an oversight. */
export function makeViewportLossPolicy({ renderer, isStale }: ViewportLossPolicyOptions): {
  describe: (e: { api: 'WebGL' | 'WebGPU'; reason?: string; message?: string }) => string | null;
  onLost: (e: { api: 'WebGL' | 'WebGPU'; reason?: string; message?: string }) => void;
} {
  // Only `describe`/`onLost` are returned here — never `label`/`isStale` — because a caller
  // spreads this straight into its own `RendererLossHandlers` object alongside its OWN `label`/
  // `isStale` (see `SceneView.tsx`/`Scene3D.tsx`); returning those fields here too would silently
  // overwrite the caller's choice on the very next spread key, and TS rightly flags the resulting
  // duplicate-property spread as an error. `isStale` is still re-checked in `onLost` below as a
  // defensive redundant guard — `attachRendererLossHandling` already checks it before calling
  // `onLost` at all, but a `renderer`-scoped policy should not depend on that being the ONLY gate.
  return {
    describe: (e) => (
      e.reason === 'destroyed'
        ? null // filter 2: an orderly teardown must log NOTHING, not just report nothing
        : `[activeRenderer] ${e.api} context/device LOST${e.reason ? ` (reason: ${e.reason})` : ''} — every ` +
          'draw into it is now a no-op and the surface will stay BLANK until it recovers.'
    ),
    onLost: (e) => {
      if (e.reason === 'destroyed') return; // filter 2, matching the describe() suppression above
      if (isStale()) return; // defensive: see the doc above
      reportRendererLoss(renderer, e.api, e.reason, e.message);
    },
  };
}

/** Reach through three's WebGPU backend to the raw `GPUDevice` and count `uncapturederror`
 *  events into `gpuFaultState`. Independent of the loss-detection wiring above — the shared
 *  `rendererLossHandling.ts` contract covers `webglcontextlost`/`device.lost` only, not this
 *  event — so a viewport calls this alongside `attachRendererLossHandling`.
 *
 *  Every property access is optional-chained: `renderer.backend.device` is three-internal (not
 *  exported in its public types) and has moved before. A WebGL renderer, or a WebGPU renderer
 *  that fell back to WebGL internally, simply has none of these and this is a silent no-op.
 *
 *  Returns a detach fn. Before #802 this listener was attached with no removal path at all and
 *  outlived every renderer it was attached to — folded in here while this function was open. */
export function attachUncapturedErrorListener(renderer: WebGPURenderer | THREE.WebGLRenderer): () => void {
  // ⚠️ The clean slate is taken for EVERY viewport renderer, BEFORE the WebGPU-only bail-out
  // below — not after it. Until #802 this reset lived in `attachGpuFaultListeners`, which ran for
  // any renderer regardless of backend; moving it past the `device?.addEventListener` guard would
  // leave the WEBGL path with no reset at all, and that is the path three's WebGL2 fallback takes
  // on every low-end device we ship to. The consequence is the false positive this channel was
  // burned by once: after a WebGL context loss and a successful rebuild, `gpuFaultState.deviceLost`
  // would still read true from the DEAD renderer, and a stale loss OUTRANKS every other
  // explanation in `explainCaptureFailure` — so a recovered editor would keep reporting itself
  // dead. Reset first, then attach whatever this backend actually has.
  gpuFaultState = null;
  const device = (renderer as unknown as { backend?: { device?: GPUDevice } })?.backend?.device;
  if (!device?.addEventListener) return () => {};

  const handler = (e: Event): void => {
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
  };
  device.addEventListener('uncapturederror', handler);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    try { device.removeEventListener?.('uncapturederror', handler); } catch { /* never throw out of a teardown */ }
  };
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
let ktx2CapsSource: Ktx2CapsSource = 'none';

/** True once KTX2 transcoder caps are known, whether from a real viewport or a probe. */
export function areKtx2CapsReady(): boolean {
  return ktx2CapsReadyFired;
}

/** Where KTX2 transcoder caps came from.
 *   - `'viewport'` — a real renderer registered (`setActiveRenderer`).
 *   - `'probe'`    — the throwaway probe renderer ran (`ensureKtx2Caps`).
 *   - `'no-3d'`    — this build excluded the 3D renderer (`build.modules.render3d: false`), so
 *                    there is nothing to detect and the gate opened without probing. NOT a
 *                    failure: three's KTX2Loader is a 3D-only consumer (PixiJS transcodes the 2D
 *                    path itself) and `selectVariant`'s '2d' branch never reads the caps.
 *   - `'none'`     — not resolved yet. */
export type Ktx2CapsSource = 'viewport' | 'probe' | 'no-3d' | 'none';

/** Mark KTX2 caps ready without implying a live renderer. Idempotent — first call wins the
 *  recorded `source`, e.g. if a probe and a real viewport race, whichever settles first sticks. */
export function markKtx2CapsReady(source: Exclude<Ktx2CapsSource, 'none'>): void {
  if (!ktx2CapsReadyFired) {
    ktx2CapsReadyFired = true;
    ktx2CapsSource = source;
    _ktx2CapsReadyResolve();
  }
}

/** Which path resolved KTX2 caps — surfaced in `RendererGateHealth` for agent diagnosis. */
export function getKtx2CapsSource(): Ktx2CapsSource {
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
   *  (`ensureKtx2Caps`), a build with no 3D renderer to probe, or neither yet. Independent of
   *  `status` — a viewport-less layout can sit at `status: 'pending'` while `capsSource` is
   *  already `'probe'`. See `Ktx2CapsSource`. */
  capsSource: Ktx2CapsSource;
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
