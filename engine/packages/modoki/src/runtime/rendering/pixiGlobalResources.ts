/** Pixi's PROCESS-GLOBAL resource pools, and who is allowed to release them (#1000).
 *
 *  ⚠️ **Cited by SYMBOL, never by line** (#966, cf. #680, and `glContextRelease.test.ts`'s own
 *  header). Every claim below was read in the installed `pixi.js`, but a dependency's line numbers
 *  move on every bump and no guard watches them — `docCitations.test.ts` covers repo paths, which
 *  these are not. An earlier revision of this file cited five ranges; two were already wrong when
 *  it landed.
 *
 *  ## The defect this exists for
 *
 *  `app.destroy(true)` reads as "tear this Application down thoroughly". It is not. The `true`
 *  travels into `AbstractRenderer.destroy`, whose test is
 *  `options === true || (typeof options === 'object' && options.releaseGlobalResources)` — so the
 *  BOOLEAN form always trips `GlobalResourceRegistry.release()`, which calls `clear()` on every
 *  registered pool. `TexturePoolClass.clear` then destroys the render textures it holds.
 *
 *  `TexturePool` is a module-level singleton whose pool is keyed by packed dimensions alone —
 *  **there is no renderer identity anywhere in it**. So one surface's slot teardown reaches into a
 *  pool every other live surface draws from, and the surface that WARNS
 *  (`BindGroup.onResourceChange`) is not the one that did it. That is why the reports never pointed
 *  at the viewport responsible.
 *
 *  ⚠️ **Scoped honestly: `clear()` destroys the pool's FREE LIST, not every render texture in the
 *  process.** A texture currently checked out has been popped off that list and is untouched. The
 *  reported crash is still explained — a RETURNED texture can sit in a renderer's cached
 *  `BindGroup` while another surface's teardown destroys it — but this sweep is narrower than
 *  "everything", and an earlier revision of this comment said "everything".
 *
 *  Five registrants share that one sweep: `BigPool` (`utils/pool/PoolGroup`), `CanvasPool`,
 *  `TexturePool`, the `canvasCache` map (`.../texture/utils/getCanvasTexture`), and an anonymous
 *  registrant in `rendering/batcher/shared/Batcher` that destroys pooled `Batch` objects.
 *
 *  ⚠️ **`Assets` is NOT among them**, so decoded sprite textures survive it. The refcount in
 *  `Scene2D.tsx` (`spriteTextureRefs`) therefore never protected against any of this, and a session
 *  that goes looking there will find a correctly-guarded cache and no defect.
 *
 *  ⚠️ **`GlobalResourceRegistry.release()` has exactly ONE caller in the whole installed lib** —
 *  `AbstractRenderer.destroy`. There is no resize trigger, no GC trigger, no RenderTexture-system
 *  trigger. So this sweep is never Pixi doing housekeeping on its own: it is only ever a renderer
 *  WE destroyed with `true`.
 *
 *  ## The rule
 *
 *  Releasing the pools is still correct — skipping it forever would trade a crash for a leak. It is
 *  correct exactly once, when the LAST live Pixi `Application` in the process goes away, because
 *  only then is there provably no other `BindGroup` holding a pooled texture. That is the identical
 *  rule `Scene2D.tsx` already applies to the shared `Assets` cache via its `liveRenderers` count —
 *  this module is that rule, applied to the pools `Scene2D` does not own.
 *
 *  ⚠️ **The count MUST be Pixi-Application-specific, and `liveGpuContextCount()` is not it.** That
 *  counter is process-wide across the Three.js renderer and the boot-time GL probes
 *  (`core/gpuContextTracking.ts`), so in any real editor session it never reaches zero and the pools
 *  would never be released at all.
 *
 *  ⚠️ **"Last one out" is an argument about TERMINAL teardowns, and a REBUILD is not one** — pass
 *  `mayReleaseGlobals: false` there. `rebuildSlotApp` destroys an Application and immediately
 *  replaces it, deliberately keeping the whole `slot.container` subtree alive across the swap, so
 *  the premise ("nothing else is bound") is false even though the count momentarily reads zero.
 *  This is not hypothetical: the shipped-game shape is ONE Canvas2D surface, i.e. one Application,
 *  which is exactly when the count hits zero on a rebuild — and the old bare `destroy(false)` could
 *  never release anything, so routing it through here silently widened it. Caught in review.
 *
 *  ## Who is live
 *
 *  Registration is paired with the GPU CONTEXT, not with `new Application()`. A constructed but
 *  never-`init()`ed Application holds no context and no bind groups, and `canvas2DPool`'s
 *  `teardownSlot` never destroys one (it is gated on `slot.initialized`) — so counting at
 *  construction would strand the count above zero forever and disarm the release.
 *
 *  ⚠️ **The dangerous direction is the count reading LOW, not high**, and it has exactly one door:
 *  an Application that was never registered must pass `null` for `deregister`, or it spends a
 *  registration belonging to a LIVE surface. That happens on `initSlotApp`'s orphan bail-out, where
 *  a rebuild superseded an in-flight init — by the time the abandoned init resolves, the successor
 *  has registered, and handing that back would let the next teardown of any other surface release
 *  the pools underneath it. #1000, restored through this fix's own back door. Guarded by
 *  `canvas2DContextLoss.test.ts`'s orphan case; do not "tidy" that `null` away.
 *
 *  (An earlier revision of this header claimed the accepted risk ran the other way — that a
 *  timed-out `init()` strands its registration forever. It cannot: registration happens AFTER
 *  `await app.init()` resolves, so a timed-out init has registered nothing to strand.) */

import { GlobalResourceRegistry } from 'pixi.js';
import type { Application } from 'pixi.js';

let liveApps = 0;

/** Register a live Pixi `Application` — call where its GPU context is noted. Returns the one-shot
 *  deregister; hand it to {@link destroyPixiApplication} when that Application is destroyed.
 *  Idempotent on the returned function, so a teardown path that runs twice cannot double-decrement
 *  and release the pools while another surface is live. */
export function notePixiApplicationCreated(): () => void {
  liveApps++;
  let handedBack = false;
  return () => {
    if (handedBack) return;
    handedBack = true;
    if (liveApps > 0) liveApps--;
  };
}

/** Destroy a Pixi `Application`, releasing Pixi's process-global pools only if this is the last
 *  live one AND this teardown is terminal.
 *
 *  - `deregister` — the one-shot from {@link notePixiApplicationCreated}, or `null` for an
 *    Application that was never registered. Passing a live surface's deregister here is the one way
 *    to reopen #1000; see the header.
 *  - `removeView` (default `true`) — matches the `destroy(true)` this replaces; `ViewSystem.destroy`
 *    resolves it from a boolean or from this object identically, so the canvas element is removed
 *    exactly as before. Pass `false` where the canvas must survive.
 *  - `mayReleaseGlobals` (default `true`) — `false` for a NON-terminal teardown (a rebuild), where
 *    "nothing else is bound" is false however the count reads.
 *
 *  ⚠️ **Never call `app.destroy(true)` directly** — the boolean form is what forces the global
 *  sweep. Enforced by `engine/tests/architecture/pixiApplicationTeardown.test.ts`, because this
 *  repo has already shipped a renderer that missed a documented-but-unguarded teardown seam (#776,
 *  recorded in `glContextRelease.test.ts`). */
export function destroyPixiApplication(
  app: Application,
  deregister: (() => void) | null | undefined,
  opts: { removeView?: boolean; mayReleaseGlobals?: boolean } = {},
): void {
  deregister?.();
  // Read AFTER the deregister: the question is whether any OTHER Application is still live.
  const releaseGlobalResources = (opts.mayReleaseGlobals ?? true) && liveApps === 0;
  app.destroy({ removeView: opts.removeView ?? true, releaseGlobalResources });
}

/** Release Pixi's process-global pools IF no Application is live — the deferred half of the rule.
 *
 *  ⚠️ **This exists because `mayReleaseGlobals: false` DEFERS a release rather than cancelling one,
 *  and a deferral nobody redeems is a leak.** `rebuildSlotApp` is the only path that destroys an
 *  Application without a terminal teardown behind it, so it suppresses the sweep on the assumption
 *  that a replacement is coming. When every bring-up then REJECTS, no replacement ever arrives:
 *  `slot.initialized` stays false, `teardownSlot`'s `if (slot.initialized)` never runs another
 *  destroy, and the process ends with zero live Applications and the pools never cleared. That is
 *  the Huawei-Y6 shape `rendererRecovery.ts` records — a device that has just run out of GPU
 *  resources is exactly where retaining every pooled render texture hurts most. Found in review;
 *  before `mayReleaseGlobals` existed, that same call released them.
 *
 *  Call it wherever the assumption can be known false: when recovery gives up, and as a backstop
 *  when an uninitialized slot is torn down for good. Safe to call at any time — it is a no-op while
 *  anything is live, and clearing already-empty pools costs nothing. */
export function releasePixiGlobalsIfIdle(): void {
  if (liveApps > 0) return;
  GlobalResourceRegistry.release();
}

/** How many Pixi `Application`s are registered as live.
 *
 *  Surfaced in the GPU memory report beside `liveGpuContextCount()` — this fix's own stated failure
 *  mode is a count that DRIFTS, so a number nobody can read in a live session is the one number
 *  that most needs reading. */
export function livePixiApplicationCount(): number {
  return liveApps;
}

/** Test-only reset — module state outlives a test file otherwise. */
export function __resetPixiApplicationTrackingForTest(): void {
  liveApps = 0;
}
