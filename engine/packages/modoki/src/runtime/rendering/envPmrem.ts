/** Environment PMREM (#739) — why the engine generates it instead of letting three do it lazily,
 *  and the measured before/after, are in docs/rendering.md § "The engine owns the PMREM, not
 *  three". This header covers only why the code sits HERE rather than beside the env cache.
 *
 *  `runtime/rendering/**` is 3D-only and already imports `three/webgpu` freely (see
 *  `postfx/PostFXStack.ts`, `flameMeshSync.ts`) — `runtime/loaders/**`, where this used to live, is
 *  reachable from the 2D boot path, so a top-level `three/webgpu` import there would ship the whole
 *  Three node pipeline (~546 KB) into a `render3d:false` 2D-only build
 *  (`tests/runtime/render3dBoundary.test.ts`, #214). `meshTemplateCache.ts` still needs a PMREM to
 *  die with its source; it does that through `registerEnvDisposeHook` instead of importing this
 *  module directly. */

import * as THREE from 'three';
// ⚠️ NOT `THREE.PMREMGenerator`. There are TWO: the core one (`three/src/extras`) is built on
// `ShaderMaterial` and only works with `WebGLRenderer`, and the node one (`three/webgpu`) is the
// one a `WebGPURenderer` can render with — and `makeWebGPURenderer` ALWAYS constructs a
// `WebGPURenderer` (the WebGL2 backend runs inside it), so it is ALWAYS this one we need.
// Getting this wrong does not throw: three logs `NodeBuilder: Material "ShaderMaterial" is not
// compatible` and hands back a target that rendered nothing, so a silently BLACK environment
// gets bound and every unit test still passes. Caught in review on #739, before it was committed
// — by the two console errors, not by any test.
import { PMREMGenerator as WebGPUPMREMGenerator } from 'three/webgpu';
import { registerEnvDisposeHook } from '../loaders/meshTemplateCache';

// ── Environment PMREM (#739) ─────────────────────────────
//
// Every scene swap that changes the env texture's OBJECT IDENTITY previously made three build a
// fresh PMREM via a fresh internal `PMREMGenerator` on every `syncEnvironment` frame that observed
// `scene.environment` change (`PMREMNode.updateBefore`, reached because a raw equirectangular
// texture is neither `isPMREMTexture` nor `CubeUVReflectionMapping`). Three frees only the PMREM
// *output* texture, via a dispose listener on the SOURCE texture — the generator's own scratch
// state (an internal `_pingPongRenderTarget`, ~6 MB of half-float, plus 11 LOD-mesh geometries) is
// freed only by `PMREMGenerator.dispose()`, which is reachable only through `PMREMNode.dispose()`,
// and nothing on the scene-swap path ever calls that. Unbounded leak, one generator's worth per
// environment change.
//
// The fix: the ENGINE owns PMREM generation instead of leaving it to three's lazy per-node path.
// `PMREMNode.js` (three 0.185.1, `updateBefore`) uses a texture DIRECTLY — skipping its own generator
// entirely — when the texture already carries `isPMREMTexture === true` or
// `mapping === CubeUVReflectionMapping`. `fromEquirectangular()`'s output texture satisfies that.
// So: generate the PMREM ourselves, once per (renderer, source) pair, bind ITS texture to
// `scene.environment`, and never hand three a raw equirect to convert. `PMREMGenerator.dispose()`
// frees the scratch target + LOD meshes but NOT the output render target — so the generator's
// lifetime is exactly one call: build, take the texture, dispose the generator immediately. No
// generator instance is ever kept alive.
//
// Keyed by renderer too: PMREM output is renderer-specific (three's own internal PMREM cache is
// per-renderer for the same reason), and this engine can have more than one live renderer at once
// (SceneView + GameView + ParticleEditor — see `activeRenderer.ts`).
const envPmremCache = new WeakMap<object, Map<THREE.DataTexture, THREE.RenderTarget>>();
// Reverse lookup (PMREM texture → its source equirect), maintained rather than scanned, so the
// retired-env sweep (`sweepRetiredEnvironments`) can resolve what a bound `scene.environment` (now
// the PMREM texture, not the equirect) keeps alive. See that function's comment for why this
// matters for correctness, not just cleanup.
const envPmremSources = new Map<THREE.Texture, THREE.DataTexture>();
// Every target built from a given source, with the per-renderer map that holds it, so disposal
// can reach them all. Deliberately NOT a Set of renderers: holding a renderer strongly would pin
// a DISPOSED renderer (and everything it retains) for the process lifetime — #720's defect
// re-created inside the fix for #739. A per-renderer Map is a plain object with no path back to
// its renderer, so keeping one costs nothing.
type EnvPmremEntry = { rt: THREE.RenderTarget; perRenderer: Map<THREE.DataTexture, THREE.RenderTarget> };
const envPmremBySource = new Map<THREE.DataTexture, EnvPmremEntry[]>();

// Negative cache, same per-renderer shape as the success cache above: a (renderer, source) pair
// that has already failed (a lost/broken GPU context, a malformed source) must not retry every
// frame — `syncEnvironment` calls this at up to 60fps, so an unguarded retry allocates a doomed
// generator (and warns) once per frame forever. `envPmremFailuresBySource` mirrors
// `envPmremBySource`'s trick of holding the per-renderer Set rather than the renderer itself, so a
// failure record never pins a disposed renderer alive (#720's shape, see that field's comment).
const envPmremFailureCache = new WeakMap<object, Set<THREE.DataTexture>>();
const envPmremFailuresBySource = new Map<THREE.DataTexture, Set<THREE.DataTexture>[]>();

/** Get (or lazily build) the PMREM texture for `source`, rendered with `renderer`. Returns
 *  `undefined` when there is no renderer yet (first frames), generation fails, or that
 *  (renderer, source) pair already failed once — callers must degrade to binding `source` directly
 *  (a sharp equirect is a fine one-frame fallback; a later `disposeEnvPMREMFor` clears the failure
 *  and lets a legitimate retry happen). Never throws into the render loop. */
export function getEnvPMREMTexture(renderer: object | null | undefined, source: THREE.DataTexture): THREE.Texture | undefined {
  if (!renderer) return undefined;
  let perRenderer = envPmremCache.get(renderer);
  const existing = perRenderer?.get(source);
  if (existing) return existing.texture;

  let perRendererFailures = envPmremFailureCache.get(renderer);
  if (perRendererFailures?.has(source)) return undefined; // already failed for this pair — don't retry every frame

  // Constructed BEFORE the try so `finally` can always reach it: if `fromEquirectangular` throws,
  // three has already allocated the ~6 MB ping-pong render target, 11 LOD meshes and their
  // materials, and `generator.dispose()` freeing them (plus three's own `_cleanup()` restoring the
  // renderer's previous render target) must still run, or the renderer is left pointing at the
  // PMREM's internal cube target and the NEXT frame renders into it instead of the canvas.
  // PMREMGenerator accepts WebGLRenderer or WebGPURenderer; `renderer` here is typed loosely
  // to avoid pulling the WebGPU renderer type into this file's public signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generator = new WebGPUPMREMGenerator(renderer as any);
  try {
    const rt = generator.fromEquirectangular(source);
    if (!perRenderer) {
      perRenderer = new Map();
      envPmremCache.set(renderer, perRenderer);
    }
    perRenderer.set(source, rt);
    envPmremSources.set(rt.texture, source);
    const entries = envPmremBySource.get(source);
    if (entries) entries.push({ rt, perRenderer });
    else envPmremBySource.set(source, [{ rt, perRenderer }]);
    return rt.texture;
  } catch (e) {
    // Warn once per (renderer, source): the failure is cached below, so every later call for this
    // pair returns early above and never reaches this branch again.
    console.warn('[envPmrem] PMREM generation failed for env texture:', e);
    if (!perRendererFailures) {
      perRendererFailures = new Set();
      envPmremFailureCache.set(renderer, perRendererFailures);
    }
    perRendererFailures.add(source);
    const failureEntries = envPmremFailuresBySource.get(source);
    if (failureEntries) failureEntries.push(perRendererFailures);
    else envPmremFailuresBySource.set(source, [perRendererFailures]);
    return undefined;
  } finally {
    generator.dispose(); // frees the generator's scratch target + LOD meshes; NOT `rt` (by design)
  }
}

/** Reverse lookup for {@link sweepRetiredEnvironments}: given a texture bound to
 *  `scene.environment` (a PMREM output since #739), find the equirect it was built from. Undefined
 *  for anything that isn't a tracked PMREM output (e.g. the raw equirect itself, or a fallback
 *  bind when generation failed). */
export function sourceForEnvPMREM(tex: THREE.Texture): THREE.DataTexture | undefined {
  return envPmremSources.get(tex);
}

/** Dispose the PMREM render target(s) built from `source`, across every renderer that built one.
 *  Called when `source` itself is disposed (retired-env sweep) or evicted wholesale, so a PMREM
 *  never outlives the equirect it was generated from. */
export function disposeEnvPMREMFor(source: THREE.DataTexture): void {
  const entries = envPmremBySource.get(source);
  if (entries) {
    for (const { rt, perRenderer } of entries) {
      envPmremSources.delete(rt.texture);
      perRenderer.delete(source); // or a later lookup for this (renderer, source) hands back a DISPOSED target
      rt.dispose();
    }
    envPmremBySource.delete(source);
  }
  // Clear any cached FAILURE for this source too, or a source that failed once (e.g. during a
  // transient context loss) would return undefined forever even after a legitimate retry becomes
  // possible.
  const failureEntries = envPmremFailuresBySource.get(source);
  if (failureEntries) {
    for (const perRendererFailures of failureEntries) perRendererFailures.delete(source);
    envPmremFailuresBySource.delete(source);
  }
}

// Register with `meshTemplateCache`'s three-free hook registry so a PMREM dies with its source
// without that module importing anything three/webgpu-shaped (#214's render3d:false boundary). A 2D-only build never imports
// THIS module at all, so the hook set over there stays empty and nothing three-shaped is pulled in.
// Keyed ('envPmrem') rather than added to a bare Set: this line runs again on every HMR of this
// module, and the key makes each re-registration REPLACE the previous closure instead of piling
// one on top of another (see `registerEnvDisposeHook`'s comment).
registerEnvDisposeHook('envPmrem', disposeEnvPMREMFor);
