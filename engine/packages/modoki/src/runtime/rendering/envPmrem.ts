/** Environment PMREM/cube derivation (#739, #779, #775) — why the engine generates these instead
 *  of letting three do it lazily, and the measured before/after, are in docs/rendering.md § "The
 *  engine owns the environment PMREM/cube, not three". This header covers only why the code sits
 *  HERE rather than beside the env cache.
 *
 *  `runtime/rendering/**` is 3D-only and already imports `three/webgpu` freely (see
 *  `postfx/PostFXStack.ts`, `flameMeshSync.ts`) — `runtime/loaders/**`, where this used to live, is
 *  reachable from the 2D boot path, so a top-level `three/webgpu` import there would ship the whole
 *  Three node pipeline (~546 KB) into a `render3d:false` 2D-only build
 *  (`tests/runtime/render3dBoundary.test.ts`, #214). `meshTemplateCache.ts` still needs these to
 *  die with their source; it does that through `registerEnvDisposeHook` instead of importing this
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
import { PMREMGenerator as WebGPUPMREMGenerator, CubeRenderTarget } from 'three/webgpu';
import { registerEnvDisposeHook } from '../loaders/meshTemplateCache';

// ── Environment PMREM/cube derivation (#739, #779, #775) ─────────────────────────────
//
// Every scene swap that changes the env texture's OBJECT IDENTITY previously made three build a
// fresh conversion via a fresh internal node on every `syncEnvironment`/`syncBackground` frame
// that observed the texture change (`NodeManager.getBackgroundNode`, `PMREMNode.updateBefore`,
// `CubeMapNode.updateBefore`), reached because a raw equirectangular texture satisfies neither
// `isPMREMTexture`/`CubeUVReflectionMapping` (the PMREM door) nor a non-equirect mapping (the cube
// door). `NodeManager.getBackgroundNode` forks on `backgroundBlurriness`: `> 0` (or the mapping is
// already `CubeUVReflectionMapping`) routes through `pmremTexture()` → `PMREMNode`, which builds
// its own `PMREMGenerator` per node (#779 — #739's exact defect through a second door #739 did not
// close); `=== 0` routes through `cubeMapNode()` → `CubeMapNode`, which builds its own
// `CubeRenderTarget` via `fromEquirectangularTexture`, cached in a module-level WeakMap keyed on
// the SOURCE TEXTURE ONLY — not per renderer, a latent cross-renderer correctness bug in a
// multi-renderer editor (#775). Three frees only the derived *output* texture via a dispose
// listener on the SOURCE texture — none of the generator/render-target scratch state three builds
// along the way is freed by anything on the scene-swap path.
//
// The fix: the ENGINE owns both derivations instead of leaving them to three's lazy per-node path.
// `PMREMNode.js` uses a texture DIRECTLY — skipping its own generator entirely — when it already
// carries `isPMREMTexture === true` or `mapping === CubeUVReflectionMapping`; `CubeMapNode.js`
// passes a node straight through when its texture's mapping is not equirectangular
// ("envNode already refers to a cube map"). `fromEquirectangular()`'s PMREM output and
// `CubeRenderTarget.fromEquirectangularTexture()`'s cube output both satisfy the door they feed.
// So: generate whichever kind is needed ourselves, once per (renderer, source, kind) triple, bind
// ITS texture, and never hand three a raw equirect to convert. The generator/target's lifetime is
// exactly one call: build, take the texture, dispose scratch state immediately. No generator
// instance is ever kept alive.
//
// Keyed by renderer too: derived output is renderer-specific (three's own internal PMREM cache is
// per-renderer for the same reason, and this file's cube cache fixes exactly the bug that three's
// own source-only cube cache has), and this engine can have more than one live renderer at once
// (SceneView + GameView + ParticleEditor — see `activeRenderer.ts`).

/** The two derivations three needs depending on `backgroundBlurriness`: `'pmrem'` for a blurred
 *  background (and for `scene.environment`, always), `'cube'` for a sharp one. See the module
 *  comment above for which door in `NodeManager` each one satisfies. */
export type EnvDerivedKind = 'pmrem' | 'cube';

const envDerivedCache = new WeakMap<object, Record<EnvDerivedKind, Map<THREE.DataTexture, THREE.RenderTarget>>>();
// Reverse lookup (derived texture → its source equirect), maintained rather than scanned, so the
// retired-env sweep (`sweepRetiredEnvironments`) can resolve what a bound `scene.environment`/
// `scene.background` (now a derived texture, not the equirect) keeps alive. See that function's
// comment for why this matters for correctness, not just cleanup. Shared across both kinds: a
// texture identity is never ambiguous between them.
const envDerivedSources = new Map<THREE.Texture, THREE.DataTexture>();
// Every target built from a given source, with the per-renderer map that holds it, so disposal
// can reach them all. Deliberately NOT a Set of renderers: holding a renderer strongly would pin
// a DISPOSED renderer (and everything it retains) for the process lifetime — #720's defect
// re-created inside the fix for #739. A per-renderer Map is a plain object with no path back to
// its renderer, so keeping one costs nothing.
type EnvDerivedEntry = {
  rt: THREE.RenderTarget;
  perRenderer: Map<THREE.DataTexture, THREE.RenderTarget>;
  kind: EnvDerivedKind;
};
const envDerivedBySource = new Map<THREE.DataTexture, EnvDerivedEntry[]>();

// Negative cache, same per-renderer shape as the success cache above: a (renderer, source, kind)
// triple that has already failed (a lost/broken GPU context, a malformed source) must not retry
// every frame — `syncEnvironment` calls this at up to 60fps, so an unguarded retry allocates a
// doomed generator/target (and warns) once per frame forever. `envDerivedFailuresBySource` mirrors
// `envDerivedBySource`'s trick of holding the per-renderer Set rather than the renderer itself, so
// a failure record never pins a disposed renderer alive (#720's shape, see that field's comment).
const envDerivedFailureCache = new WeakMap<object, Record<EnvDerivedKind, Set<THREE.DataTexture>>>();
const envDerivedFailuresBySource = new Map<THREE.DataTexture, Set<THREE.DataTexture>[]>();

function emptyPerKind<T>(make: () => T): Record<EnvDerivedKind, T> {
  return { pmrem: make(), cube: make() };
}

/** Build the render target for `kind`. The only place the two derivations differ — everything
 *  else (caching, failure handling, disposal) is shared. Throws on failure; the caller catches. */
function buildEnvDerivedTarget(renderer: object, source: THREE.DataTexture, kind: EnvDerivedKind): THREE.RenderTarget {
  if (kind === 'pmrem') {
    // Constructed OUTSIDE the try, so `finally` can always reach it: if
    // `fromEquirectangular` throws, three has already allocated the ~6 MB ping-pong render
    // target, 11 LOD meshes and their materials, and `generator.dispose()` freeing them (plus
    // three's own `_cleanup()` restoring the renderer's previous render target) must still run,
    // or the renderer is left pointing at the PMREM's internal cube target and the NEXT frame
    // renders into it instead of the canvas. PMREMGenerator accepts WebGLRenderer or
    // WebGPURenderer; `renderer` here is typed loosely to avoid pulling the WebGPU renderer type
    // into this file's public signature.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generator = new WebGPUPMREMGenerator(renderer as any);
    try {
      return generator.fromEquirectangular(source);
    } finally {
      generator.dispose(); // frees the generator's scratch target + LOD meshes; NOT the rt (by design)
    }
  }
  // 'cube': no generator to dispose — `fromEquirectangularTexture` disposes its own scratch
  // geometry/material internally (`CubeRenderTarget.js`). It DOES temporarily mutate
  // `source.minFilter`/`generateMipmaps` and the renderer's render target/MRT/XR-enabled state,
  // restoring all of them — but NOT in a `finally` upstream (`CubeRenderTarget.js` and
  // `CubeCamera.update`, which it calls, both restore only on the normal-return path). So a throw
  // mid-render (a lost/broken GPU context) leaves the renderer bound to the cube target's internal
  // render target with MRT null and XR disabled — the exact "next frame renders into the wrong
  // place" failure the PMREM branch's own `finally` exists to prevent — so we wrap the same
  // guarantee around it here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = renderer as any;
  const prevTarget = typeof r.getRenderTarget === 'function' ? r.getRenderTarget() : undefined;
  const prevMRT = typeof r.getMRT === 'function' ? r.getMRT() : undefined;
  const prevXrEnabled = r.xr ? r.xr.enabled : undefined;
  const prevMinFilter = source.minFilter;
  const prevGenerateMipmaps = source.generateMipmaps;
  try {
    const rt = new CubeRenderTarget(source.image.height);
    rt.fromEquirectangularTexture(r, source);
    return rt;
  } finally {
    if (typeof r.setRenderTarget === 'function') r.setRenderTarget(prevTarget);
    if (typeof r.setMRT === 'function') r.setMRT(prevMRT);
    if (r.xr && prevXrEnabled !== undefined) r.xr.enabled = prevXrEnabled;
    source.minFilter = prevMinFilter;
    source.generateMipmaps = prevGenerateMipmaps;
  }
}

/** Get (or lazily build) the derived texture of `kind` for `source`, rendered with `renderer`.
 *  Returns `undefined` when there is no renderer yet (first frames), generation fails, or that
 *  (renderer, source, kind) triple already failed once — callers must degrade to binding `source`
 *  directly (a sharp equirect is a fine one-frame fallback; a later `disposeEnvDerivedFor` clears
 *  the failure and lets a legitimate retry happen). Never throws into the render loop. */
function getEnvDerivedTexture(renderer: object | null | undefined, source: THREE.DataTexture, kind: EnvDerivedKind): THREE.Texture | undefined {
  if (!renderer) return undefined;

  // Not-ready is transient, not a failure: `source.image` can still be mid-load (no `image`, or an
  // `image.height` of 0) on the frame `syncEnvironment` first observes a new source — mirrors
  // three's own `isEquirectangularMapReady` guard (`CubeMapNode.js`), which binds a placeholder and
  // retries next frame rather than treating it as broken. Both derivations need the same thing
  // (`buildEnvDerivedTarget`'s 'cube' branch reads `source.image.height` directly and would throw),
  // so this check applies before either kind and, critically, BEFORE the failure cache below — a
  // one-frame gap must not turn into a permanent degrade the way a real failure does.
  const img = source.image as { height?: number } | undefined;
  if (!img || typeof img.height !== 'number' || !(img.height > 0)) return undefined;

  let perRenderer = envDerivedCache.get(renderer);
  const existing = perRenderer?.[kind].get(source);
  if (existing) return existing.texture;

  let perRendererFailures = envDerivedFailureCache.get(renderer);
  if (perRendererFailures?.[kind].has(source)) return undefined; // already failed for this triple — don't retry every frame

  try {
    const rt = buildEnvDerivedTarget(renderer, source, kind);
    if (!perRenderer) {
      perRenderer = emptyPerKind(() => new Map());
      envDerivedCache.set(renderer, perRenderer);
    }
    perRenderer[kind].set(source, rt);
    envDerivedSources.set(rt.texture, source);
    const entries = envDerivedBySource.get(source);
    if (entries) entries.push({ rt, perRenderer: perRenderer[kind], kind });
    else envDerivedBySource.set(source, [{ rt, perRenderer: perRenderer[kind], kind }]);
    return rt.texture;
  } catch (e) {
    // Warn once per (renderer, source, kind): the failure is cached below, so every later call
    // for this triple returns early above and never reaches this branch again.
    console.warn(`[envPmrem] ${kind} generation failed for env texture:`, e);
    if (!perRendererFailures) {
      perRendererFailures = emptyPerKind(() => new Set());
      envDerivedFailureCache.set(renderer, perRendererFailures);
    }
    perRendererFailures[kind].add(source);
    const failureEntries = envDerivedFailuresBySource.get(source);
    if (failureEntries) failureEntries.push(perRendererFailures[kind]);
    else envDerivedFailuresBySource.set(source, [perRendererFailures[kind]]);
    return undefined;
  }
}

/** PMREM texture for `source` — the `scene.environment` door, and the `scene.background` door
 *  when `backgroundBlurriness > 0` (#779). Kept as its own export (rather than folded into a
 *  single `kind`-taking call) because callers name it directly and several tests mock it by
 *  name. */
export function getEnvPMREMTexture(renderer: object | null | undefined, source: THREE.DataTexture): THREE.Texture | undefined {
  return getEnvDerivedTexture(renderer, source, 'pmrem');
}

/** Cube texture for `source` — the `scene.background` door when `backgroundBlurriness === 0`
 *  (#775): a sharp background must not be handed a PMREM (whose level 0 is not the sharp
 *  original), so it gets three's OTHER conversion instead, built by us instead of by three's
 *  own source-only-keyed (not per-renderer) cache. */
export function getEnvCubeTexture(renderer: object | null | undefined, source: THREE.DataTexture): THREE.Texture | undefined {
  return getEnvDerivedTexture(renderer, source, 'cube');
}

/** Reverse lookup for {@link sweepRetiredEnvironments}: given a texture bound to
 *  `scene.environment`/`scene.background` (a derived PMREM or cube output since #739/#775/#779),
 *  find the equirect it was built from. Undefined for anything that isn't a tracked derived
 *  output (e.g. the raw equirect itself, or a fallback bind when generation failed). */
export function sourceForEnvDerived(tex: THREE.Texture): THREE.DataTexture | undefined {
  return envDerivedSources.get(tex);
}

/** Dispose every derived render target (both kinds) built from `source`, across every renderer
 *  that built one. Called when `source` itself is disposed (retired-env sweep) or evicted
 *  wholesale, so a derived texture never outlives the equirect it was generated from. */
export function disposeEnvDerivedFor(source: THREE.DataTexture): void {
  const entries = envDerivedBySource.get(source);
  if (entries) {
    for (const { rt, perRenderer } of entries) {
      envDerivedSources.delete(rt.texture);
      perRenderer.delete(source); // or a later lookup for this (renderer, source, kind) hands back a DISPOSED target
      rt.dispose();
    }
    envDerivedBySource.delete(source);
  }
  // Clear any cached FAILURE for this source too, or a source that failed once (e.g. during a
  // transient context loss) would return undefined forever even after a legitimate retry becomes
  // possible.
  const failureEntries = envDerivedFailuresBySource.get(source);
  if (failureEntries) {
    for (const perRendererFailures of failureEntries) perRendererFailures.delete(source);
    envDerivedFailuresBySource.delete(source);
  }
}

// Register with `meshTemplateCache`'s three-free hook registry so derived textures die with their
// source without that module importing anything three/webgpu-shaped (#214's render3d:false
// boundary). A 2D-only build never imports THIS module at all, so the hook set over there stays
// empty and nothing three-shaped is pulled in.
// Keyed ('envPmrem') rather than added to a bare Set: this line runs again on every HMR of this
// module, and the key makes each re-registration REPLACE the previous closure instead of piling
// one on top of another (see `registerEnvDisposeHook`'s comment). The key string stays 'envPmrem'
// (unrelated to the export rename above) — it's an HMR de-dup key, not part of the public API.
registerEnvDisposeHook('envPmrem', disposeEnvDerivedFor);
