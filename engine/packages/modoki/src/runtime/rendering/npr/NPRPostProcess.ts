/** NPR Post-Process — TSL-based edge detection and composite.
 *
 *  Pipeline (one geometry pass with MRT + one screen-space composite):
 *    pass(scene, camera) → { output: lit color, normal: view-space normal }
 *    composite samples color + normal + viewZ, runs Sobel, paints black lines
 *    over either a flat-white sheet or a luminance-remapped grayscale fill.
 *
 *  Requires a `WebGPURenderer` instance (which itself can run on top of
 *  WebGL2 if WebGPU is unavailable — see GameConfig.preferWebGPU). */

// HMR: TSL node instances are baked into compiled WGSL pipelines. When this
// module hot-reloads, new TSL node instances reference symbols that the old
// compiled shaders still hold — three.js raises `unresolved type 'OutputType'`
// because the new outputStruct's identity doesn't match the old one in cache.
// Opt out of HMR with a full page reload; it's a fair price for a stable repl.
if (import.meta.hot) import.meta.hot.invalidate();

import * as THREE from 'three';
import { RenderPipeline } from 'three/webgpu';
import { pass, mrt, output, normalView, uniform, rtt, materialReference, outputStruct, vec4 } from 'three/tsl';
import { buildCompositeNode, type NPRUniforms } from './compositeNodes';
import { buildFXAANode } from './fxaaNode';
import { ParticlePassNode } from './ParticlePassNode';
import { PARTICLE_LAYER } from '../layers';

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

// Default supersampling factor for the MRT and composite passes. 1 = native
// (relies on FXAA for AA, cheapest), 2 = 4× pixels (sharpest), 4 = 16× pixels
// (overkill). Caller can override via NPRConfig.superSampleScale; changing it
// requires a pipeline rebuild (NPRPostProcess.setConfig returns true to
// signal that).
const DEFAULT_SS_SCALE = 1;

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

// Scratch vector for per-frame size queries (avoid per-frame allocation).
const _size = new THREE.Vector2();

/** Texel size for the Sobel/FXAA kernels (F1). They sample the SUPERSAMPLED pass
 *  textures — scene pass + composite RTT are sized to drawing-buffer pixels ×
 *  superSampleScale — so the per-texel step must use that resolution, NOT CSS pixels.
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
function ensureLineColorOnMaterials() {
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

const DEFAULTS: NPRConfig = {
  fillMode: 'grayscale',
  depthThreshold: 0.005,
  normalThreshold: 0.4,
  colorThreshold: 0.15,
  lineThickness: 1,
  lineStrength: 1,
  grayscaleGamma: 0.7,
  grayscaleLift: 0.3,
  fxaa: true,
  fxaaEdgeThreshold: 0.125,
  fxaaEdgeThresholdMin: 0.0312,
  fxaaBlendStrength: 4.0,
  superSampleScale: DEFAULT_SS_SCALE,
  clearColor: 0x000000,
};

/** Owner of the RenderPipeline + uniforms for one Scene3D instance. */
export class NPRPostProcess {
  /** Stage 1: scene MRT → composite (+FXAA) → stylizedRT (working space). */
  private readonly pipeline: RenderPipeline;
  /** Stage 2: ParticlePassNode (prefill stylized + geometry depth, render particles) → swapchain. */
  private readonly particlePipeline: RenderPipeline;
  private readonly particlePass: ParticlePassNode;
  /** Owned target holding stage 1's stylized color (no tone map — applied in stage 2). */
  private readonly stylizedRT: THREE.RenderTarget;
  /** Stage-1 MRT geometry PassNode — owns a render target the pipeline's own
   *  dispose() does not recurse into, so we free it explicitly on teardown. */
  private readonly scenePass: { dispose?(): void };
  /** Supersampled composite RTTNode — present only in the FXAA / SS path; owns a
   *  render target not freed by the pipeline dispose. Unlike PassNode, RTTNode's
   *  inherited dispose() only fires an event (it does NOT free `renderTarget`), so
   *  we hold the target itself and dispose it directly. Null in the fast path. */
  private readonly compositeRTT: { dispose?(): void; renderTarget?: THREE.RenderTarget } | null;
  private readonly renderer: {
    getSize(v: THREE.Vector2): THREE.Vector2; getPixelRatio(): number;
    getRenderTarget(): THREE.RenderTarget | null; setRenderTarget(rt: THREE.RenderTarget | null): void;
  };
  private readonly uniforms: NPRUniforms;
  /** Cached so setConfig can detect when a pipeline rebuild is needed. */
  private superSampleScale: number;
  /** True if the graph includes the composite RTT + FXAA stage. False when
   *  built in fast-path mode (scale=1 + fxaa=off), where compositeNode goes
   *  straight to the swapchain. Turning fxaa back on in fast-path mode
   *  requires a rebuild. */
  private hasFxaaPath: boolean;
  /** True when the renderer runs on the WebGL2 backend (WebGPU unavailable).
   *  The FXAA stage is a raw-WGSL `wgslFn` that the WebGL backend's GLSL parser
   *  can't compile, so it's skipped entirely there — see constructor. */
  private readonly isWebGLBackend: boolean;

  constructor(
    renderer: unknown,
    scene: THREE.Scene,
    camera: THREE.Camera,
    initial: Partial<NPRConfig> = {},
  ) {
    const config = { ...DEFAULTS, ...initial };
    this.superSampleScale = Math.max(1, config.superSampleScale);
    // The renderer is a WebGPURenderer that may run on WebGL2 (forceWebGL) when
    // WebGPU is unavailable. The FXAA stage (fxaaNode.ts) is a raw-WGSL wgslFn
    // that the WebGL backend's GLSL parser can't compile — building it crashes
    // the whole pipeline. Detect the backend so we can skip FXAA on WebGL while
    // keeping the pure-TSL MRT + composite (outlines still render).
    this.isWebGLBackend = (renderer as { backend?: { isWebGLBackend?: boolean } }).backend?.isWebGLBackend === true;
    this.renderer = renderer as typeof this.renderer;
    ensureLineColorOnMaterials();

    const scenePass = pass(scene, camera);
    // Stage 1 renders geometry only — particles (PARTICLE_LAYER) are excluded here so
    // they aren't Sobel-outlined / grayscaled, then composited on top in stage 2.
    const geometryLayers = new THREE.Layers();
    geometryLayers.enableAll();
    geometryLayers.disable(PARTICLE_LAYER);
    (scenePass as unknown as { setLayers(l: THREE.Layers): void }).setLayers(geometryLayers);
    scenePass.setMRT(mrt({
      output,
      normal: normalView,
      // Per-material line color (rgb) + color-preserve amount (a). materialReference
      // reads material.lineColor / material.nprColorPreserve at fragment time; the
      // prototype patch above guarantees every material answers to both (defaults
      // black / 0). Custom fragmentNode shaders write this target themselves via
      // nprFragmentOutput, which packs the same two fields.
      lineColor: vec4(
        materialReference('lineColor', 'color'),
        materialReference('nprColorPreserve', 'float'),
      ),
    }));
    // Supersample the source MRT pass — color/normal/depth buffers get
    // scale² pixels, so Sobel samples bilinear-filtered higher-frequency data.
    // Reduces source-buffer aliasing at silhouettes and creases.
    (scenePass as unknown as { setResolutionScale(s: number): void }).setResolutionScale(this.superSampleScale);

    const colorNode  = scenePass.getTextureNode('output');
    const normalNode = scenePass.getTextureNode('normal');
    const lineColorNode = scenePass.getTextureNode('lineColor');
    const depthTextureNode = scenePass.getTextureNode('depth');

    this.uniforms = {
      fillMode:        uniform(config.fillMode === 'flat' ? 0 : 1).setName('nprFillMode'),
      depthThreshold:  uniform(config.depthThreshold).setName('nprDepthThreshold'),
      normalThreshold: uniform(config.normalThreshold).setName('nprNormalThreshold'),
      colorThreshold:  uniform(config.colorThreshold).setName('nprColorThreshold'),
      lineThickness:   uniform(config.lineThickness).setName('nprLineThickness'),
      lineStrength:    uniform(config.lineStrength).setName('nprLineStrength'),
      grayscaleGamma:  uniform(config.grayscaleGamma).setName('nprGrayscaleGamma'),
      grayscaleLift:   uniform(config.grayscaleLift).setName('nprGrayscaleLift'),
      texelSize:       uniform(new THREE.Vector2(1, 1)).setName('nprTexelSize'),
      fxaaEnabled:          uniform(config.fxaa ? 1 : 0).setName('nprFxaaEnabled'),
      fxaaEdgeThreshold:    uniform(config.fxaaEdgeThreshold).setName('nprFxaaEdgeThreshold'),
      fxaaEdgeThresholdMin: uniform(config.fxaaEdgeThresholdMin).setName('nprFxaaEdgeThresholdMin'),
      fxaaBlendStrength:    uniform(config.fxaaBlendStrength).setName('nprFxaaBlendStrength'),
      clearColor:           uniform(new THREE.Color(config.clearColor)).setName('nprClearColor'),
    };

    const compositeNode = buildCompositeNode({
      colorNode,
      normalNode,
      lineColorNode,
      depthTextureNode,
      // F10: ortho cameras have a linear depth buffer — sobelDepth must use
      // orthographicDepthToViewZ, not the perspective (1/z) reconstructor.
      isOrthographic: (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true,
      uniforms: this.uniforms,
    });

    // FXAA's wgslFn can't run on the WebGL backend — force it off there. The
    // composite/edge/MRT nodes are pure TSL and transpile to GLSL fine, so NPR
    // outlines still render; we just lose the final edge-AA pass on WebGL.
    //
    // F7: also gate FXAA off whenever we're supersampling (scale>1). With SS>1
    // the composite RTT is sized to scale× the swapchain, and FXAA — wired as the
    // pipeline's outputNode — would execute at that supersampled resolution
    // (scale² fragments) *before* the downsample, paying its cost on 4×/16×
    // pixels. FXAA is a cheap silhouette pass meant to run AFTER SSAA at display
    // res; SSAA already removes most aliasing, so running FXAA on top buys little
    // for a lot. Restricting it to scale===1 also means its display-res texel
    // size (computeNprTexelSize with superSampleScale=1) is exactly right.
    const useFxaa = config.fxaa && !this.isWebGLBackend && this.superSampleScale === 1;

    // Fast path: when there's no supersampling AND FXAA is off, route the
    // composite straight to the swapchain. Saves one offscreen render + sample
    // per frame. Trade-off: re-enabling FXAA later requires a pipeline rebuild
    // (since we'd need to add the RTT + sampler), which setConfig signals.
    this.hasFxaaPath = !(this.superSampleScale === 1 && !useFxaa);

    let finalOutput: unknown;
    let compositeRTTOwned: { dispose?(): void; renderTarget?: THREE.RenderTarget } | null = null;
    if (this.hasFxaaPath) {
      // SSAA: composite renders to a scale×-sized RT, FXAA samples from it.
      const compositeRTT = rtt(compositeNode);
      compositeRTTOwned = compositeRTT as { dispose?(): void; renderTarget?: THREE.RenderTarget };
      (compositeRTT as unknown as { setPixelRatio(p: number): void }).setPixelRatio(this.superSampleScale);
      if (useFxaa) {
        // FXAA on top — three.js's built-in FXAANode crashes on a setLayout/Fn
        // build bug, so we route through a raw-WGSL wgslFn in fxaaNode.ts. The
        // live toggle is a uniform branch inside the shader; once this path is
        // wired, setConfig({fxaa}) is instant.
        finalOutput = buildFXAANode({
          inputTex: compositeRTT,
          texelSize: this.uniforms.texelSize,
          enabled: this.uniforms.fxaaEnabled,
          edgeThreshold: this.uniforms.fxaaEdgeThreshold,
          edgeThresholdMin: this.uniforms.fxaaEdgeThresholdMin,
          blendStrength: this.uniforms.fxaaBlendStrength,
        });
      } else {
        // WebGL with supersampling: output the downsampled composite RTT
        // directly (SSAA but no FXAA).
        finalOutput = compositeRTT;
      }
    } else {
      finalOutput = compositeNode;
    }

    this.pipeline = new RenderPipeline(renderer as ConstructorParameters<typeof RenderPipeline>[0]);
    this.pipeline.outputNode = finalOutput as never;
    // Stage 1 outputs WORKING-space stylized color into stylizedRT (no tone map /
    // color encode); particles blend in linear and stage 2 applies the output
    // transform once. So disable the pipeline's automatic output transform here.
    (this.pipeline as unknown as { outputColorTransform: boolean }).outputColorTransform = false;

    // HalfFloat to hold the working-space (pre-tone-map) HDR-ish stylized color.
    this.stylizedRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.stylizedRT.texture.name = 'nprStylized';

    // Stage 2: particle pass prefills (stylized color + geometry depth) and renders
    // particles over it; its own pipeline tone-maps + encodes the result to the swapchain.
    this.particlePass = new ParticlePassNode(scene, camera, this.stylizedRT.texture, depthTextureNode);
    this.particlePipeline = new RenderPipeline(renderer as ConstructorParameters<typeof RenderPipeline>[0]);
    this.particlePipeline.outputNode = (this.particlePass as unknown as { getTextureNode(): never }).getTextureNode();

    // Track the render-target-owning nodes so dispose() can free them (the
    // RenderPipeline's own dispose does not recurse into the node graph). (T3)
    this.scenePass = scenePass as { dispose?(): void };
    this.compositeRTT = compositeRTTOwned;
  }

  /** Render one frame. Replaces `renderer.render(scene, camera)`.
   *  Two explicitly-sequenced stages (deterministic ordering — no reliance on node-graph
   *  scheduling): stage 1 renders the stylized scene into stylizedRT; stage 2's
   *  ParticlePassNode prefills from it + the geometry depth and renders particles over
   *  it, then tone-maps to the swapchain. */
  render(): void {
    const r = this.renderer;
    // stylizedRT must match the drawing buffer so stage-1's composite samples the
    // scene pass 1:1 and stage-2 prefills the full screen.
    r.getSize(_size);
    const pr = r.getPixelRatio();
    const w = Math.max(1, Math.floor(_size.x * pr));
    const h = Math.max(1, Math.floor(_size.y * pr));
    if (this.stylizedRT.width !== w || this.stylizedRT.height !== h) this.stylizedRT.setSize(w, h);

    // Derive texelSize from the supersampled pass resolution every frame (F1/F2) —
    // the sole authority (DPR / SS can change between frames with no resize hook),
    // so there's no separate resize() prime to drift out of sync.
    const ts = computeNprTexelSize(_size.x, _size.y, pr, this.superSampleScale);
    (this.uniforms.texelSize as unknown as { value: THREE.Vector2 }).value.set(ts.x, ts.y);

    const prevRT = r.getRenderTarget();
    r.setRenderTarget(this.stylizedRT);
    this.pipeline.render(); // composite (+FXAA) → stylizedRT (working space)
    r.setRenderTarget(prevRT);

    this.particlePipeline.render(); // prefill + particles → swapchain (tone-mapped)
  }

  /** Push new config values into live uniforms. Returns `true` if a structural
   *  change was requested (e.g. superSampleScale) that needs a full rebuild —
   *  the caller should dispose() this instance and recreate it. */
  setConfig(config: Partial<NPRConfig>): boolean {
    if (config.fillMode !== undefined) {
      this.uniforms.fillMode.value = config.fillMode === 'flat' ? 0 : 1;
    }
    if (config.depthThreshold !== undefined)  this.uniforms.depthThreshold.value = config.depthThreshold;
    if (config.normalThreshold !== undefined) this.uniforms.normalThreshold.value = config.normalThreshold;
    if (config.colorThreshold !== undefined)  this.uniforms.colorThreshold.value = config.colorThreshold;
    if (config.lineThickness !== undefined)   this.uniforms.lineThickness.value = config.lineThickness;
    if (config.lineStrength !== undefined)    this.uniforms.lineStrength.value = config.lineStrength;
    if (config.grayscaleGamma !== undefined)  this.uniforms.grayscaleGamma.value = config.grayscaleGamma;
    if (config.grayscaleLift !== undefined)   this.uniforms.grayscaleLift.value = config.grayscaleLift;
    if (config.fxaa !== undefined)                 this.uniforms.fxaaEnabled.value = config.fxaa ? 1 : 0;
    if (config.fxaaEdgeThreshold !== undefined)    this.uniforms.fxaaEdgeThreshold.value = config.fxaaEdgeThreshold;
    if (config.fxaaEdgeThresholdMin !== undefined) this.uniforms.fxaaEdgeThresholdMin.value = config.fxaaEdgeThresholdMin;
    if (config.fxaaBlendStrength !== undefined)    this.uniforms.fxaaBlendStrength.value = config.fxaaBlendStrength;
    if (config.clearColor !== undefined) (this.uniforms.clearColor.value as THREE.Color).setHex(config.clearColor);

    // superSampleScale change can't be applied to an existing pipeline (it
    // affects render-target sizes). Caller should rebuild.
    if (config.superSampleScale !== undefined && config.superSampleScale !== this.superSampleScale) {
      return true;
    }
    // If we're in the no-RTT fast path and FXAA is being turned on, we need
    // to rebuild to wire in the FXAA stage. The reverse (true→false) keeps
    // working via the live uniform toggle inside the shader. On the WebGL
    // backend FXAA can never be wired (wgslFn won't compile), so skip the
    // rebuild — it would just crash again.
    if (!this.isWebGLBackend && !this.hasFxaaPath && config.fxaa === true) {
      return true;
    }
    return false;
  }

  dispose(): void {
    this.pipeline.dispose();
    this.particlePipeline.dispose();
    (this.particlePass as unknown as { dispose?(): void }).dispose?.();
    this.stylizedRT.dispose();
    // The MRT geometry pass + supersampled composite RTT each own a render target
    // that the pipeline dispose() above does NOT recurse into; free them so an
    // SS-scale rebuild (dispose() + new NPRPostProcess) can't leak them. PassNode's
    // own dispose() frees its renderTarget; RTTNode's does not, so dispose its
    // renderTarget directly (and fire its node dispose for any listeners). (T3)
    this.scenePass.dispose?.();
    this.compositeRTT?.renderTarget?.dispose();
    this.compositeRTT?.dispose?.();
  }
}
