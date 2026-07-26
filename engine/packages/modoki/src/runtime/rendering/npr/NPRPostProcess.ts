/** NPR shared vocabulary — the material-prototype patch, the public
 *  custom-shader helpers, the config shape, and the supersampled texel math.
 *
 *  ⚠️ This file NO LONGER owns a render pipeline. It used to export an
 *  `NPRPostProcess` class that owned its own two `RenderPipeline`s and was
 *  mutually exclusive with bloom — see docs/rendering.md "NPR Outline
 *  Post-Process" for the full history. That class dissolved into ordinary
 *  stages of `postfx/PostFXStack` ('npr' →
 *  'npr-particles', with AA as the stack's own tail 'fxaa' stage), so NPR now
 *  COMPOSES with bloom/vignette/DOF. What survives here is everything that was
 *  never really about the pipeline:
 *
 *   - `nprFragmentOutput` / `applyNprFragmentOutput` — the public helpers games
 *     call from custom shaders (`games/space-console/runtime/shaders/*`). Their
 *     signatures and behaviour are load-bearing; do not change them.
 *   - `ensureLineColorOnMaterials` — the permanent, global `THREE.Material`
 *     prototype patch, now also called by the stack when it builds the
 *     lineColor MRT target.
 *   - `NPRConfig` / `computeNprTexelSize` — the trait-facing config shape and
 *     the supersample-aware texel math the stylize stage reads. */

// HMR: TSL node instances are baked into compiled WGSL pipelines. When this
// module hot-reloads, new TSL node instances reference symbols that the old
// compiled shaders still hold — three.js raises `unresolved type 'OutputType'`
// because the new outputStruct's identity doesn't match the old one in cache.
// So an edit here needs a full RELOAD, not a hot patch. The dev server forces one by path
// (isShaderGraphFile in plugins/vite-asset-scanner.ts). Do NOT re-add
// `import.meta.hot.invalidate()` — it only propagates to importers and was silently
// swallowed by Scene3D.tsx's Fast Refresh boundary.

import * as THREE from 'three';
import { normalView, materialReference, outputStruct, vec4 } from 'three/tsl';

/** Helper for custom NodeMaterial shaders rendered into the NPR pass. Wraps
 *  a fragment color expression into an outputStruct that writes to all three
 *  MRT targets (output / normal / lineColor). Without this, NodeMaterial's
 *  fragmentNode path only writes target[0] and WebGPU validation discards
 *  the draw because targets[1]/[2] have no fragment output.
 *
 *  The lineColor target's ALPHA carries `nprColorPreserve` (0..1) — the
 *  composite blends the grayscale fill toward this fragment's true color by
 *  that amount, so shaders can keep their hue through NPR (see compositeNodes).
 *  `preserve` defaults to the material's `nprColorPreserve` property (0), so a
 *  shader that doesn't care stays fully NPR. A shader can pass a per-pixel node
 *  (e.g. a fresnel rim mask) to preserve color only where it wants.
 *
 *  Use from a shader file:
 *    mat.fragmentNode = nprFragmentOutput(vec4(myColorRgb, 1.0));
 *    mat.fragmentNode = nprFragmentOutput(vec4(rgb, 1.0), rimMask); // per-pixel
 *
 *  ⚠️ FOG HAZARD: if the scene has fog (`Fog` trait / `syncFog`), leaving this
 *  material's default `fog = true` breaks the draw. `NodeMaterial.setupOutput()`
 *  runs `setupFog()` on this outputStruct regardless of `fragmentNode`, and
 *  `setupFog` REPLACES the whole struct with a single `vec4` — collapsing the 3 MRT
 *  targets down to 1, which is exactly the "targets[1]/[2] have no fragment output"
 *  case above, so WebGPU discards the draw. Prefer `applyNprFragmentOutput` below,
 *  which sets `fog = false` for you; only call this directly if you intend to
 *  handle fog yourself.
 */
export function nprFragmentOutput(colorRGBA: unknown, preserve?: unknown): unknown {
  // Baking materialReference('lineColor'/'nprColorPreserve') into this material's
  // fragmentNode means it MUST be compilable on its own — e.g. shader prewarm
  // (prewarmShadersForWorld) compiles custom-shader materials before the NPR
  // pipeline (and thus its constructor's ensureLineColorOnMaterials) ever runs.
  // Patch the prototype here so material.lineColor resolves to a real Color
  // (not undefined → updateColor reads `.r` of undefined → compile throws).
  ensureLineColorOnMaterials();
  const preserveNode = preserve ?? materialReference('nprColorPreserve', 'float');
  return outputStruct(
    colorRGBA as any,
    vec4(normalView, 1.0) as any,
    vec4(materialReference('lineColor', 'color') as any, preserveNode as any) as any,
  );
}

/** Set a custom NPR shader's `fragmentNode` AND disable the material's `fog` flag
 *  in one call — the safe way to wire a shader into the NPR MRT pass. See the fog
 *  hazard note on `nprFragmentOutput` above: without `fog = false`, three's
 *  `setupFog` collapses the 3-target outputStruct to a single vec4 and the draw
 *  gets discarded by WebGPU whenever the scene has fog enabled. Prefer this over
 *  calling `nprFragmentOutput` + assigning `fragmentNode` by hand.
 *
 *  Use from a shader file:
 *    applyNprFragmentOutput(mat, vec4(myColorRgb, 1.0));
 *    applyNprFragmentOutput(mat, vec4(rgb, 1.0), rimMask); // per-pixel preserve
 */
export function applyNprFragmentOutput(mat: { fragmentNode: unknown; fog: boolean }, colorRGBA: unknown, preserve?: unknown): void {
  mat.fragmentNode = nprFragmentOutput(colorRGBA, preserve);
  mat.fog = false;
}

// Default outline color for materials that don't explicitly set one. Shared so
// the prototype getter doesn't allocate per access — which means EVERY material
// without an explicit `lineColor` returns the SAME Color instance (F8). If a
// caller mutated it in place (e.g. `mat.lineColor.setHex(...)` instead of
// `mat.lineColor = new Color(...)`), it would shift the default for all
// materials process-wide. `Object.freeze` makes that aliasing footgun throw
// (in strict mode) / no-op instead of silently corrupting the shared default.
// THREE.Color's mutators write `.r/.g/.b` directly, so freezing the instance
// blocks every in-place edit path. Read-only use (passing it to the Sobel/MRT
// node graph, copying via `.clone()`/`new Color().copy(default)`) is unaffected.
const _DEFAULT_LINE_COLOR = Object.freeze(new THREE.Color(0x000000)) as THREE.Color;

/** Texel size for the Sobel kernel (F1). It samples the SUPERSAMPLED scene-pass
 *  textures — sized to drawing-buffer pixels × superSampleScale by the pass's
 *  `setResolutionScale` — so the per-texel step must use that resolution, NOT CSS
 *  pixels. (The stack's FXAA stage calls this with superSampleScale 1: it runs at
 *  the tail, after the composite has already resolved to display resolution.)
 *  Using CSS pixels made outline thickness + FXAA spacing scale with DPR (and SS),
 *  so a DPR-2 phone got ~2× too-thick lines. Pure so the resize math is unit-tested. */
export function computeNprTexelSize(
  cssW: number, cssH: number, pixelRatio: number, superSampleScale: number,
): { x: number; y: number } {
  const w = Math.max(1, Math.floor(cssW * pixelRatio * superSampleScale));
  const h = Math.max(1, Math.floor(cssH * pixelRatio * superSampleScale));
  return { x: 1 / w, y: 1 / h };
}

// Augment THREE.Material with `lineColor` + `nprColorPreserve` properties —
// every material answers to them, defaulting to black / 0. This lets us write
// `materialReference('lineColor','color')` and `materialReference('nprColorPreserve',
// 'float')` into the MRT and have them work for ALL materials (including ones
// imported from GLB) without patching every creation site. A material that
// wants a custom outline or to keep its color through NPR just assigns its own.
//
// PERMANENT, GLOBAL & IRREVERSIBLE (F8): this defines accessors on
// `THREE.Material.prototype` — the single shared prototype for EVERY material
// in the process. The patch is:
//   - global: it affects materials in other renderers/scenes, not just this
//     NPR instance, the moment any NPRPostProcess is constructed (or
//     nprFragmentOutput is called during prewarm);
//   - permanent: it is NEVER removed — `dispose()` does not (and cannot safely)
//     undo it, because other live materials may already depend on the accessors;
//   - idempotent: guarded by the module-level `_lineColorPatched` flag so it
//     runs exactly once regardless of how many NPR instances exist.
// Accept this as a one-time, process-lifetime contract. The accessors are
// `configurable: true` only so a future redefinition isn't fatal; do not rely
// on re-defining them. The shared default returned by the getter is frozen
// (see `_DEFAULT_LINE_COLOR`) so no consumer can mutate it through the alias.
let _lineColorPatched = false;
export function ensureLineColorOnMaterials() {
  if (_lineColorPatched) return;
  _lineColorPatched = true;
  Object.defineProperty(THREE.Material.prototype, 'lineColor', {
    get(this: THREE.Material & { _lineColor?: THREE.Color }) {
      return this._lineColor ?? _DEFAULT_LINE_COLOR;
    },
    set(this: THREE.Material & { _lineColor?: THREE.Color }, v: THREE.Color) {
      this._lineColor = v;
    },
    configurable: true,
  });
  // Per-material NPR color-preserve amount (0..1). 0 = full NPR (grayscale fill),
  // 1 = keep the material's true color. Read into the lineColor MRT target's
  // alpha; the composite uses it to lerp the fill toward the lit color.
  Object.defineProperty(THREE.Material.prototype, 'nprColorPreserve', {
    get(this: THREE.Material & { _nprColorPreserve?: number }) {
      return this._nprColorPreserve ?? 0;
    },
    set(this: THREE.Material & { _nprColorPreserve?: number }, v: number) {
      this._nprColorPreserve = v;
    },
    configurable: true,
  });
}

export type NPRFillMode = 'flat' | 'grayscale';

export interface NPRConfig {
  fillMode: NPRFillMode;
  depthThreshold: number;
  normalThreshold: number;
  colorThreshold: number;
  lineThickness: number;
  lineStrength: number;
  grayscaleGamma: number;
  grayscaleLift: number;
  /** Enable FXAA post-AA on the composite output. */
  fxaa: boolean;
  /** Relative-contrast threshold for FXAA edge detection (typical 0.05–0.25). */
  fxaaEdgeThreshold: number;
  /** Absolute luma floor — pixels below this are treated as flat. */
  fxaaEdgeThresholdMin: number;
  /** Blur strength multiplier on detected edges (typical 2.0–8.0). */
  fxaaBlendStrength: number;
  /** Supersampling factor on the MRT + composite RTT (1 = native, 2 = 4× pixels).
   *  Changing this requires a pipeline rebuild (cheap but not free). */
  superSampleScale: number;
  /** Camera clear color (RGB, hex) shown wherever no geometry was drawn — the
   *  composite shader covers every pixel, so without this the swapchain stays
   *  pure black/white regardless of the scene's background. Owner reads this
   *  from the active Camera trait each frame and pushes via setConfig. */
  clearColor: number;
}
