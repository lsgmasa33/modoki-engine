/** Shared live GL/GPU-context counter — Phase 3 of #590
 *  (docs/rendering.md).
 *
 *  Was private to `rendering/canvas2DPool.ts` and counted ONLY its own PixiJS `Application`
 *  contexts. Phase 4's static reading found the gap that made it useless as a real budget:
 *  `noteContextCreated`/`noteContextDestroyed` were called nowhere else, so the main Three
 *  renderer (`rendering/scene3DSync.ts`'s `makeWebGPURenderer`), the raw-WebGL2 boot probes
 *  (`rendering/rampWorkloadGL.ts`, `rendering/deviceCaps.ts`) and the KTX2 caps probe
 *  (`rendering/capsProbeRenderer.ts`, which itself creates no context — see below) were all
 *  invisible to it. A soft cap measured against a partial count cannot warn before the browser's
 *  real one (~8-16 live WebGL contexts) evicts the oldest — exactly the failure mode #590's
 *  freeze is now at least as consistent with as a memory-pressure kill.
 *
 *  Fix 3 of #590's adversarial review found the SAME gap in three shipped editor sites, which had
 *  been left out of the sweep above: `editor/panels/previewScene.ts` and
 *  `editor/panels/ModelPreview.tsx` (each a standalone `THREE.WebGLRenderer`) and
 *  `editor/panels/ShaderPreview.tsx` (a standalone PixiJS `Application`). All three are `src/editor`
 *  — dev-only, never shipped in a game build — but they are exactly the surface an editor session
 *  actually approaches `SOFT_CONTEXT_LIMIT` on (SceneView + GameView + a couple of asset previews
 *  open at once), so they are now wired the same way as everything else here.
 *
 *  This is L0 (`runtime/core/`) so it is reachable from every context-creating site in `rendering/`
 *  (L2) AND from the L3 GPU-memory sampler (`loaders/gpuMemoryReport.ts`) that reports the total
 *  alongside real byte estimates. See `docs/architecture-layers.md`.
 *
 *  `capsProbeRenderer.ts` needs no call of its own: it creates its renderer via
 *  `makeWebGPURenderer`, whose `dispose()` this module's caller wraps once, at the source — every
 *  downstream disposer (Scene3D's unmount/rebuild, the KTX2 probe's `probe?.dispose()`, the
 *  editor's SceneView/ParticleEditor) is then correct for free, with no second call site to keep
 *  in sync.
 *
 *  ── CUMULATIVE TOTALS, NOT JUST THE LIVE COUNT ────────────────────────────────────────────────
 *  A second device measurement (docs/ios-gpu-memory.md) found `fps` and every
 *  JS-visible resource count — including the LIVE context count — reading perfectly FLAT for 16
 *  minutes up to a confirmed ~296 MB jetsam of the GPU process. A live snapshot cannot see churn:
 *  a context that is repeatedly created and destroyed (e.g. `canvas2DPool`'s rebuild-on-context-
 *  loss path) can hold the LIVE count at 2-3 forever while the browser/OS fails to fully reclaim
 *  each one — which is exactly the "orphaned allocation" shape a flat live count is blind to.
 *  `totalGpuContextsCreated`/`totalGpuContextsDestroyed` are monotonic (never reset except by the
 *  test helper) so that churn is visible even when the live gauge is not: a created total climbing
 *  much faster than the live count would suggest is the create/destroy CYCLE happening, which the
 *  live count alone cannot distinguish from "nothing is happening". */

/** Browsers cap live WebGL contexts (~8-16) and evict the oldest past that; WebGPU has its own
 *  limits. A healthy session — one Canvas2D pool, one 3D viewport, the occasional boot probe —
 *  stays well under this. Not a hard cap: allocation is never blocked on it, only warned once. */
const SOFT_CONTEXT_LIMIT = 8;

let liveContexts = 0;
let warned = false;
let totalCreated = 0;
let totalDestroyed = 0;

/** Call once a GL/GPU context has actually been created (after a successful `init()`/
 *  `getContext()` — never before, and never speculatively: creating a context purely to COUNT it
 *  would cause the exhaustion this module exists to warn about). */
export function noteGpuContextCreated(): void {
  liveContexts++;
  totalCreated++;
  if (liveContexts > SOFT_CONTEXT_LIMIT && !warned) {
    warned = true;
    console.warn(
      `[gpuContextTracking] ${liveContexts} live GL/GPU contexts (soft limit ${SOFT_CONTEXT_LIMIT}). ` +
      `Browsers evict the oldest WebGL context past their cap. This counts every tracked context: ` +
      `the PixiJS Canvas2D pool, the main Three renderer, the boot-time GL probes, and (editor-only) ` +
      `the previewScene/ModelPreview/ShaderPreview asset-inspector previews. Check for un-reclaimed ` +
      `contexts or an unusually context-heavy scene. (Warned once; not a hard limit.)`,
    );
  }
}

/** Call once a previously-noted context is actually gone (disposed / explicitly lost). Floors at
 *  zero rather than going negative, so a stray double-call can't corrupt the count. Deliberately
 *  NOT re-armed past the warn threshold — see the original rationale this carries over from
 *  `canvas2DPool.ts`: a genuine leak climbs monotonically and is caught by the one-shot warn; a
 *  session hovering at the limit (scene swaps that acquire-new-then-release-old) would otherwise
 *  be re-spammed the identical warning every cycle. */
export function noteGpuContextDestroyed(): void {
  // Guarded together so `totalGpuContextsCreated() - totalGpuContextsDestroyed() ===
  // liveGpuContextCount()` always holds — a stray double-dispose call must not inflate the
  // cumulative destroyed total past what was actually created.
  if (liveContexts > 0) { liveContexts--; totalDestroyed++; }
}

/** Live GL/GPU-context count across every tracked site (test/diagnostics/the GPU-memory report). */
export function liveGpuContextCount(): number {
  return liveContexts;
}

/** Cumulative contexts created this session, never decremented — see the module header on why
 *  this exists alongside the live count. */
export function totalGpuContextsCreated(): number {
  return totalCreated;
}

/** Cumulative contexts destroyed (JS-side — i.e. `dispose()`/`loseContext()` was CALLED; whether
 *  the browser/OS actually reclaimed the GPU allocation is exactly what this module cannot see). */
export function totalGpuContextsDestroyed(): number {
  return totalDestroyed;
}

/** Test-only: reset the module-level counters without going through `vi.resetModules()`. */
export function __resetGpuContextTrackingForTest(): void {
  liveContexts = 0;
  warned = false;
  totalCreated = 0;
  totalDestroyed = 0;
}
