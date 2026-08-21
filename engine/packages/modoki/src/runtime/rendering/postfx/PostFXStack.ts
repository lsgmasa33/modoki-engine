/** Post-process stack — the ONE composable TSL node chain for the 3D path.
 *  See docs/rendering.md "Post-Process Stack" for the full design. It replaced
 *  the one-effect-at-a-time `BloomPostProcess` in Phase 1, and in Phase 3
 *  absorbed NPR too — so `NPRPostFX` + `BloomPostFX` (+ vignette + DOF) now
 *  COMPOSE instead of the NPR branch winning and bloom being silently skipped.
 *
 *  See `stackPlan.ts` for the (pure, tested) decisions this class must not
 *  re-derive: stage order, MRT union, rebuild-vs-live, FXAA legality.
 *
 *  ── Invariant I1 (docs/rendering.md): ONE terminal color transform ─────────
 *  Every stage works in linear/working space. `this.pipeline` is the SOLE
 *  terminal pipeline and keeps `outputColorTransform` at its default `true`
 *  (tone map + sRGB encode applied exactly once, here). The 'npr-particles'
 *  stage owns an INTERNAL `RenderPipeline` — it must therefore set
 *  `outputColorTransform = false`. Before Phase 3 that internal pipeline was
 *  the one doing the transform; getting this backwards double-encodes the
 *  frame (washed-out or crushed), which is the single most likely visual
 *  regression in this workstream.
 *
 *  ── Stage shapes ──────────────────────────────────────────────────────────
 *  Most stages are pure color-node transforms: color in, color out. Two are not,
 *  and both are NPR's:
 *   - 'npr' STYLIZE reads extra MRT targets (normal + lineColor) and the depth
 *     texture, so it forces the scene pass's MRT layout (I2).
 *   - 'npr-particles' is a REAL scene draw, not a filter: `ParticlePassNode`
 *     renders the particle layer with `autoClear=false` over a prefilled
 *     color+depth buffer, and needs a concrete *texture* to prefill from. Rather
 *     than teaching the generic stack about scene-injecting stages, that stage
 *     keeps NPR's original stage-2 shape internally (own RT + own pipeline) and
 *     hands the chain `particlePass.getTextureNode()` — a plain texture node the
 *     rest of the stack filters like any other color. Smaller blast radius. */

// HMR: this module's TSL nodes bake into compiled WGSL pipelines, so an edit here needs a full
// RELOAD, not a hot patch. The dev server forces one by path (isShaderGraphFile in
// plugins/vite-asset-scanner.ts). Do NOT re-add `import.meta.hot.invalidate()` — it only
// propagates to importers and was silently swallowed by Scene3D.tsx's Fast Refresh boundary,
// which is exactly how a correct shader fix ended up looking broken.

import * as THREE from 'three';
import { RenderPipeline } from 'three/webgpu';
import { pass, mrt, output, normalView, add, mul, mix, float, vec3, uniform, rtt, materialReference, vec4 } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { dof } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js';
import { vignette } from 'three/examples/jsm/tsl/display/CRT.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { buildViewZNode } from './dofViewZ';
import { buildCompositeNode, type NPRCompositeUniforms } from '../npr/compositeNodes';
import { buildFXAANode } from '../npr/fxaaNode';
import { ParticlePassNode } from '../npr/ParticlePassNode';
import { ensureLineColorOnMaterials, computeNprTexelSize } from '../npr/NPRPostProcess';
import { PARTICLE_LAYER } from '../layers';
import {
  planStages, requiredMrtTargets, needsRebuild,
  type PostFXRequest, type StageKind,
} from './stackPlan';
import { pinPassCallDepth, observePassCallDepth, getPassCallDepth } from './passCompileContext';

/** One assembled stage.
 *  - `applyConfig` pushes this stage's own config into live uniforms (a no-op
 *    if the stage's key is absent from a later `setConfig` call — can't happen
 *    in practice since `needsRebuild` catches a stage being removed, but kept
 *    defensive since `req` is caller-supplied).
 *  - `prepare` is an optional per-frame PROLOGUE run before the terminal
 *    pipeline renders, in stage order — for resolution-derived uniforms and for
 *    'npr-particles', whose internal pipeline must have filled its texture
 *    before the terminal pipeline samples it.
 *  - `dispose` frees any render target this stage owns (`RenderPipeline.dispose`
 *    does NOT recurse into the node graph). */
interface StageHandle {
  readonly kind: StageKind;
  applyConfig(req: PostFXRequest): void;
  prepare?(): void;
  dispose?(): void;
}

// TSL node types are statically narrow but a stage chain is dynamic — a color
// node arriving into one stage may leave as a different concrete node class
// (TextureNode → a bloom/dof/vignette Fn's return type). Relax at this
// boundary rather than fight the type system (same convention as edgeNodes.ts).
type ColorNode = any;

interface RendererLike {
  getSize(v: THREE.Vector2): THREE.Vector2;
  getPixelRatio(): number;
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(rt: THREE.RenderTarget | null): void;
  samples: number;
  getOutputBufferType?(): THREE.TextureDataType;
}

/** The part of three's `PassNode` this class drives directly. `compileAsync` is three's own
 *  precompile entry point (r184): it points the renderer at the pass's render target + MRT,
 *  compiles the pass's scene, and restores both. */
interface ScenePassLike {
  dispose?(): void;
  renderTarget: THREE.RenderTarget;
  compileAsync(renderer: unknown): Promise<void>;
  /** three calls this from inside the terminal pipeline's quad draw, and it is where the pass
   *  renders the scene. Wrapped once per app to read the renderer's call depth AT that moment —
   *  see `observePassCallDepth` in `passCompileContext`. */
  updateBefore(frame: unknown): void;
}

/** Everything a stage may need beyond the incoming color node. */
interface StageCtx {
  scene: THREE.Scene;
  camera: THREE.Camera;
  depthTextureNode: unknown;
  normalTextureNode: unknown;
  lineColorTextureNode: unknown;
  isOrthographic: boolean;
}

// Scratch vector for per-frame size queries (avoid per-frame allocation). Safe
// to share across stage `prepare()` closures — they run sequentially and each
// consumes the value before the next call.
const _size = new THREE.Vector2();

/** Owner of the terminal RenderPipeline + assembled stage chain for one
 *  Scene3D instance. `render()` replaces `renderer.render(scene, camera)`. */
export class PostFXStack {
  private readonly pipeline: RenderPipeline;
  private readonly renderer: RendererLike;
  private readonly rawRenderer: unknown;
  private readonly scenePass: ScenePassLike;
  private readonly stages: StageHandle[];
  private req: PostFXRequest;

  constructor(renderer: unknown, scene: THREE.Scene, camera: THREE.Camera, req: PostFXRequest) {
    this.req = req;
    this.rawRenderer = renderer;
    this.renderer = renderer as RendererLike;
    const scenePass = pass(scene, camera);

    const targets = requiredMrtTargets(req);
    // 'output' is always present and needs no MRT call — a bare pass() already
    // exposes it. Only build an MRT dict when a stage needs a second target.
    // I2: this is the UNION for the whole chain, computed once — never a
    // per-effect target set (changing the layout is a global cost, and a
    // material that doesn't write every target has its draw silently dropped).
    if (targets.length > 1) {
      const mrtDict: Record<string, unknown> = { output };
      if (targets.includes('normal')) mrtDict.normal = normalView;
      if (targets.includes('lineColor')) {
        // Per-material outline color (rgb) + color-preserve amount (a).
        // `materialReference` reads material.lineColor / material.nprColorPreserve
        // at fragment time; the prototype patch guarantees EVERY material answers
        // to both (defaults black / 0). Custom fragmentNode shaders write this
        // target themselves via `nprFragmentOutput`, which packs the same fields.
        ensureLineColorOnMaterials();
        mrtDict.lineColor = vec4(
          materialReference('lineColor', 'color'),
          materialReference('nprColorPreserve', 'float'),
        );
      }
      (scenePass as unknown as { setMRT(m: unknown): void }).setMRT(mrt(mrtDict as never));
    }

    if (req.npr) {
      // NPR's geometry pass renders geometry ONLY — particles are excluded here
      // so they aren't Sobel-outlined / grayscaled, then composited on top by
      // the 'npr-particles' stage. (On the plain path the camera's own layer
      // mask already includes PARTICLE_LAYER, so particles render inline.)
      const geometryLayers = new THREE.Layers();
      geometryLayers.enableAll();
      geometryLayers.disable(PARTICLE_LAYER);
      (scenePass as unknown as { setLayers(l: THREE.Layers): void }).setLayers(geometryLayers);
      // Supersample the source MRT pass — color/normal/depth get scale² pixels,
      // so Sobel samples bilinear-filtered higher-frequency data (less
      // silhouette/crease aliasing at the source).
      (scenePass as unknown as { setResolutionScale(s: number): void })
        .setResolutionScale(Math.max(1, req.npr.superSampleScale));
    }

    // getTextureNode('depth') is free on any pass() (PassNode always allocates
    // a depth texture) — fetching it unconditionally here avoids threading a
    // "does any stage need depth" check through the stage-build loop.
    const ctx: StageCtx = {
      scene,
      camera,
      depthTextureNode: scenePass.getTextureNode('depth'),
      normalTextureNode: targets.includes('normal') ? scenePass.getTextureNode('normal') : null,
      lineColorTextureNode: targets.includes('lineColor') ? scenePass.getTextureNode('lineColor') : null,
      isOrthographic: (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true,
    };

    let color = scenePass.getTextureNode('output') as ColorNode;
    const stages: StageHandle[] = [];
    for (const kind of planStages(req)) {
      const built = this.buildStage(kind, color, req, ctx);
      color = built.color;
      stages.push(built.handle);
    }
    this.stages = stages;

    this.pipeline = new RenderPipeline(renderer as ConstructorParameters<typeof RenderPipeline>[0]);
    this.pipeline.outputNode = color as never;
    // outputColorTransform stays default `true` — see the class doc's I1 note.

    this.scenePass = scenePass as unknown as ScenePassLike;
    // Read the pass's real call depth off the first frame it draws — what `compileSceneAsync`
    // pins depends on it. See `passCompileContext`.
    observePassCallDepth(this.scenePass, renderer);
  }

  private buildStage(
    kind: StageKind, color: ColorNode, req: PostFXRequest, ctx: StageCtx,
  ): { color: ColorNode; handle: StageHandle } {
    switch (kind) {
      case 'npr': {
        const cfg = req.npr;
        if (!cfg) throw new Error('PostFXStack: "npr" stage planned but req.npr is missing');
        const ss = Math.max(1, cfg.superSampleScale);
        const uniforms: NPRCompositeUniforms = {
          fillMode:        uniform(cfg.fillMode === 'flat' ? 0 : 1).setName('nprFillMode'),
          depthThreshold:  uniform(cfg.depthThreshold).setName('nprDepthThreshold'),
          normalThreshold: uniform(cfg.normalThreshold).setName('nprNormalThreshold'),
          colorThreshold:  uniform(cfg.colorThreshold).setName('nprColorThreshold'),
          lineThickness:   uniform(cfg.lineThickness).setName('nprLineThickness'),
          lineStrength:    uniform(cfg.lineStrength).setName('nprLineStrength'),
          grayscaleGamma:  uniform(cfg.grayscaleGamma).setName('nprGrayscaleGamma'),
          grayscaleLift:   uniform(cfg.grayscaleLift).setName('nprGrayscaleLift'),
          texelSize:       uniform(new THREE.Vector2(1, 1)).setName('nprTexelSize'),
          clearColor:      uniform(new THREE.Color(cfg.clearColor)).setName('nprClearColor'),
        };
        const compositeNode = buildCompositeNode({
          colorNode: color,
          normalNode: ctx.normalTextureNode,
          lineColorNode: ctx.lineColorTextureNode,
          depthTextureNode: ctx.depthTextureNode,
          // F10: ortho cameras have a linear depth buffer — sobelDepth must use
          // orthographicDepthToViewZ, not the perspective (1/z) reconstructor.
          isOrthographic: ctx.isOrthographic,
          uniforms,
        });

        // At SS>1 resolve the composite through an RTT so the SSAA downsample
        // happens ONCE here rather than being re-evaluated by each downstream
        // stage. The supersampling itself comes from the scene pass's
        // setResolutionScale above — this RTT lands at DISPLAY resolution and
        // bilinear-downsamples the scale×-sized MRT textures it samples.
        // ⚠️ `setPixelRatio` below does NOT size it: RTTNode.setPixelRatio calls
        // setSize(this.width, this.height), which are still null, so `autoResize`
        // stays on and updateBefore sizes the target to the renderer's own pixel
        // ratio regardless. Kept because it is harmless and matches upstream
        // usage — but do not read it as "this RTT is scale× sized". It is not.
        // At SS=1 the composite node flows on unwrapped — no extra offscreen pass.
        let out: ColorNode = compositeNode;
        let ownedRtt: { dispose?(): void; renderTarget?: THREE.RenderTarget } | null = null;
        if (ss > 1) {
          const compositeRTT = rtt(compositeNode);
          (compositeRTT as unknown as { setPixelRatio(p: number): void }).setPixelRatio(ss);
          ownedRtt = compositeRTT as { dispose?(): void; renderTarget?: THREE.RenderTarget };
          out = compositeRTT as ColorNode;
        }

        return {
          color: out,
          handle: {
            kind,
            // F1/F2: derive texelSize from the SUPERSAMPLED pass resolution every
            // frame — the sole authority, since DPR/SS can change between frames
            // with no resize hook. Using CSS pixels gave DPR-2 phones 2× lines.
            prepare: () => {
              this.renderer.getSize(_size);
              const ts = computeNprTexelSize(_size.x, _size.y, this.renderer.getPixelRatio(), ss);
              (uniforms.texelSize as { value: THREE.Vector2 }).value.set(ts.x, ts.y);
            },
            applyConfig: (r) => {
              const c = r.npr;
              if (!c) return;
              uniforms.fillMode.value = c.fillMode === 'flat' ? 0 : 1;
              uniforms.depthThreshold.value = c.depthThreshold;
              uniforms.normalThreshold.value = c.normalThreshold;
              uniforms.colorThreshold.value = c.colorThreshold;
              uniforms.lineThickness.value = c.lineThickness;
              uniforms.lineStrength.value = c.lineStrength;
              uniforms.grayscaleGamma.value = c.grayscaleGamma;
              uniforms.grayscaleLift.value = c.grayscaleLift;
              (uniforms.clearColor.value as THREE.Color).setHex(c.clearColor);
            },
            // RTTNode's inherited dispose() only fires an event — it does NOT
            // free `renderTarget` — so dispose the target directly too. (T3)
            dispose: () => {
              ownedRtt?.renderTarget?.dispose();
              ownedRtt?.dispose?.();
            },
          },
        };
      }
      case 'npr-particles': {
        // Scene-injecting stage (see the class doc). Keeps NPR's original
        // stage-2 shape internally so the generic stack never has to model
        // "a stage that draws the scene".
        const stylizedRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
        stylizedRT.texture.name = 'nprStylized';
        const inner = new RenderPipeline(this.rawRenderer as ConstructorParameters<typeof RenderPipeline>[0]);
        inner.outputNode = color as never;
        // I1: the chain so far is working-space stylized color. Particles blend
        // in linear and the TERMINAL pipeline applies the output transform once,
        // so this internal pipeline must NOT tone-map/encode.
        (inner as unknown as { outputColorTransform: boolean }).outputColorTransform = false;

        const particlePass = new ParticlePassNode(
          ctx.scene, ctx.camera, stylizedRT.texture, ctx.depthTextureNode,
        );

        return {
          color: (particlePass as unknown as { getTextureNode(): ColorNode }).getTextureNode(),
          handle: {
            kind,
            applyConfig: () => { /* no tunables — presence is driven by req.npr */ },
            prepare: () => {
              // stylizedRT must match the drawing buffer so the prefill covers
              // the full screen 1:1.
              this.renderer.getSize(_size);
              const pr = this.renderer.getPixelRatio();
              const w = Math.max(1, Math.floor(_size.x * pr));
              const h = Math.max(1, Math.floor(_size.y * pr));
              if (stylizedRT.width !== w || stylizedRT.height !== h) stylizedRT.setSize(w, h);
              const prevRT = this.renderer.getRenderTarget();
              this.renderer.setRenderTarget(stylizedRT);
              inner.render(); // everything upstream → stylizedRT (working space)
              this.renderer.setRenderTarget(prevRT);
            },
            dispose: () => {
              inner.dispose();
              (particlePass as unknown as { dispose?(): void }).dispose?.();
              stylizedRT.dispose();
            },
          },
        };
      }
      case 'ao': {
        const cfg = req.ao;
        if (!cfg) throw new Error('PostFXStack: "ao" stage planned but req.ao is missing');
        // Always pass a REAL normal — `requiredMrtTargets` forces 'normal' for
        // AO too (same target NPR already forces; whether AO is alone or
        // combined with NPR, ctx.normalTextureNode is populated either way).
        // GTAONode's alternative — `ao(depth, null, camera)` reconstructing
        // normals from depth — was tried and is BROKEN under this renderer:
        // `getNormalFromDepth` compiles `textureDimensions(depthTex, 0)`, and
        // our depth attachment is multisampled, where WGSL's multisampled
        // overload takes no level argument (confirmed via the browser's
        // native WGSL compiler diagnostic — see stackPlan.ts's requiredMrtTargets
        // doc for the full trail). Not a wiring choice; the null path doesn't work here.
        const aoPass = ao(ctx.depthTextureNode as never, ctx.normalTextureNode as never, ctx.camera);
        aoPass.radius.value = cfg.radius;
        const aoTex = (aoPass as unknown as { getTextureNode(): ColorNode }).getTextureNode();
        // GTAONode outputs a raw 0..1 occlusion factor with no strength control
        // of its own (three's own doc example multiplies it straight into
        // color) — lerp toward it by `intensity` so a low setting doesn't crush
        // shadows, matching every other stage's artist-facing knob.
        const intensityU = uniform(cfg.intensity);
        const occlusion = mix(float(1), aoTex.r, intensityU);
        return {
          color: mul(color, vec4(vec3(occlusion), 1)) as ColorNode,
          handle: {
            kind,
            applyConfig: (r) => {
              const c = r.ao;
              if (!c) return;
              aoPass.radius.value = c.radius;
              intensityU.value = c.intensity;
            },
            // GTAONode owns its own render target + material (GTAONode.js's
            // dispose() frees `_aoRenderTarget` + `_material`) — not reachable
            // from RenderPipeline.dispose(). Same leak class as bloom/dof above.
            dispose: () => (aoPass as unknown as { dispose?(): void }).dispose?.(),
          },
        };
      }
      case 'bloom': {
        const cfg = req.bloom;
        if (!cfg) throw new Error('PostFXStack: "bloom" stage planned but req.bloom is missing');
        const bloomPass = bloom(color, cfg.strength, cfg.radius, cfg.threshold);
        return {
          color: add(color, bloomPass) as ColorNode,
          handle: {
            kind,
            applyConfig: (r) => {
              const c = r.bloom;
              if (!c) return;
              bloomPass.strength.value = c.strength;
              bloomPass.radius.value = c.radius;
              bloomPass.threshold.value = c.threshold;
            },
            // BloomNode owns a whole MIP PYRAMID — 1 bright-pass + 5 horizontal +
            // 5 vertical HalfFloat targets, plus 7 materials — and none of it is
            // reachable from RenderPipeline.dispose(). Because this stack rebuilds
            // on ANY stage-set change (toggling vignette/DOF/NPR/FXAA in the
            // Inspector), skipping this leaks the entire pyramid per checkbox click.
            dispose: () => (bloomPass as unknown as { dispose?(): void }).dispose?.(),
          },
        };
      }
      case 'vignette': {
        const cfg = req.vignette;
        if (!cfg) throw new Error('PostFXStack: "vignette" stage planned but req.vignette is missing');
        // vignette() is a bare TSL `Fn`, not a Node class with its own live
        // uniforms — pass `uniform()` nodes for intensity/smoothness ourselves,
        // or the values freeze at graph-build time and setConfig can't reach them.
        const intensityU = uniform(cfg.intensity);
        const smoothnessU = uniform(cfg.smoothness);
        return {
          color: vignette(color, intensityU, smoothnessU) as ColorNode,
          handle: {
            kind,
            applyConfig: (r) => {
              const c = r.vignette;
              if (!c) return;
              intensityU.value = c.intensity;
              smoothnessU.value = c.smoothness;
            },
          },
        };
      }
      case 'dof': {
        const cfg = req.dof;
        if (!cfg) throw new Error('PostFXStack: "dof" stage planned but req.dof is missing');
        // ⚠️ dof()'s viewZ must NOT come from PassNode.getViewZNode() — it
        // hardcodes perspectiveDepthToViewZ (see dofViewZ.ts's doc comment).
        // Near/far MUST come from the SCENE camera, as uniforms we own — see
        // dofViewZ.ts. TSL's global cameraNear/cameraFar would resolve to the DOF
        // CoC pass's own full-screen quad camera and yield a constant viewZ.
        const dofCam = ctx.camera as unknown as { near: number; far: number };
        const nearU = uniform(dofCam.near);
        const farU = uniform(dofCam.far);
        const viewZ = buildViewZNode(ctx.depthTextureNode, ctx.isOrthographic, nearU, farU);
        const focusDistanceU = uniform(cfg.focusDistance);
        const focalLengthU = uniform(cfg.focalLength);
        const bokehScaleU = uniform(cfg.bokehScale);
        // ⚠️ dof() runs its input through `convertToTexture`, which mints an RTTNode
        // when the input is not ALREADY a texture node — and DepthOfFieldNode.dispose()
        // does not free that RTT. Today it always is one (planStages puts 'dof'
        // straight after the scene color / the NPR particle texture, with nothing
        // between), so nothing leaks. If a stage is ever inserted directly BEFORE dof
        // (e.g. Phase 4's 'ao'), wrap the input explicitly the way 'fxaa' does and
        // dispose that RTT here, or this starts leaking a full-screen target per rebuild.
        const dofNode = dof(color, viewZ, focusDistanceU, focalLengthU, bokehScaleU);
        return {
          color: dofNode as ColorNode,
          handle: {
            kind,
            applyConfig: (r) => {
              const c = r.dof;
              if (!c) return;
              focusDistanceU.value = c.focusDistance;
              focalLengthU.value = c.focalLength;
              bokehScaleU.value = c.bokehScale;
            },
            // Track the live camera's near/far — they are NOT part of PostFXRequest (so a
            // change wouldn't reach applyConfig), and an Inspector edit to Camera.near
            // must not silently leave the depth reconstruction on stale values.
            prepare: () => {
              if (nearU.value !== dofCam.near) nearU.value = dofCam.near;
              if (farU.value !== dofCam.far) farU.value = dofCam.far;
            },
            // DepthOfFieldNode owns 6 render targets + 5 materials (CoC, blurred CoC,
            // blur64, blur16 near/far, composite) — same non-recursing-dispose hazard
            // as bloom above.
            dispose: () => (dofNode as unknown as { dispose?(): void }).dispose?.(),
          },
        };
      }
      case 'fxaa': {
        const cfg = req.fxaa;
        if (!cfg) throw new Error('PostFXStack: "fxaa" stage planned but req.fxaa is missing');
        // The wgslFn samples its input with textureSample, so it needs a real
        // TEXTURE node. When the previous stage already produced one (the NPR
        // particle pass's texture node, or an SS composite RTT) use it directly;
        // otherwise resolve the chain into an RTT first. Skipping the redundant
        // wrap saves a full-screen blit on the common NPR path.
        const alreadyTexture = (color as { isTextureNode?: boolean } | null)?.isTextureNode === true;
        const inputTex = alreadyTexture ? color : rtt(color);
        const ownedRtt = alreadyTexture
          ? null
          : inputTex as unknown as { dispose?(): void; renderTarget?: THREE.RenderTarget };

        // Display-resolution texel size (superSampleScale 1): `planFxaaEnabled`
        // only admits this stage at SS=1, and it runs at the tail — after the SS
        // composite has already been downsampled.
        const texelSize = uniform(new THREE.Vector2(1, 1)).setName('fxaaTexelSize');
        const edgeThreshold = uniform(cfg.edgeThreshold).setName('fxaaEdgeThreshold');
        const edgeThresholdMin = uniform(cfg.edgeThresholdMin).setName('fxaaEdgeThresholdMin');
        const blendStrength = uniform(cfg.blendStrength).setName('fxaaBlendStrength');

        return {
          color: buildFXAANode({
            inputTex, texelSize, edgeThreshold, edgeThresholdMin, blendStrength,
          }) as ColorNode,
          handle: {
            kind,
            prepare: () => {
              this.renderer.getSize(_size);
              const ts = computeNprTexelSize(_size.x, _size.y, this.renderer.getPixelRatio(), 1);
              (texelSize as unknown as { value: THREE.Vector2 }).value.set(ts.x, ts.y);
            },
            applyConfig: (r) => {
              const c = r.fxaa;
              if (!c) return;
              edgeThreshold.value = c.edgeThreshold;
              edgeThresholdMin.value = c.edgeThresholdMin;
              blendStrength.value = c.blendStrength;
            },
            dispose: () => {
              ownedRtt?.renderTarget?.dispose();
              ownedRtt?.dispose?.();
            },
          },
        };
      }
      default:
        throw new Error(`PostFXStack: stage "${kind}" is not implemented yet`);
    }
  }

  /** Render one frame → swapchain (tone-mapped). Stage prologues run first, in
   *  chain order, so any stage that renders into its own target (today:
   *  'npr-particles') has filled it before the terminal pipeline samples it. */
  render(): void {
    for (const stage of this.stages) stage.prepare?.();
    this.pipeline.render();
  }

  /** Compile the pipelines the SCENE PASS will need, without drawing a frame (#238).
   *
   *  This is the half of the boot stall no prewarm can reach. A material's pipeline key includes
   *  the render context it is drawn into, and with a stack up the scene is drawn into this pass's
   *  target — a different colour-target COUNT (up to three, with the NPR/AO MRT layout) from the
   *  canvas context `renderer.compileAsync(scene, camera)` would compile against. Measured on
   *  `demos/postfx-demo`: prewarm `targets: ["rgba16float"]`, render
   *  `targets: ["rgba16float","rgba16float","rgba16float"]`, so not one prewarmed pipeline was
   *  reusable. Delegates to three's `PassNode.compileAsync`, which does the render-target/MRT
   *  swap and restores it.
   *
   *  ⚠️ The two lines before it are NOT optional and NOT tidiness. `PassNode.setup()` is what
   *  normally stamps the target's sample count and texture type onto it, and `setup()` runs when
   *  the node graph is first BUILT — i.e. during the first `render()`, which is precisely the
   *  frame this call exists to get ahead of. Compiling before that leaves `samples` at the
   *  RenderTarget default, and a sample-count mismatch is a different pipeline key: the compile
   *  would succeed, warm the wrong set, and look exactly like a fix that did not work. */
  async compileSceneAsync(): Promise<void> {
    const rt = this.scenePass.renderTarget;
    rt.samples = this.renderer.samples;
    if (this.renderer.getOutputBufferType) rt.texture.type = this.renderer.getOutputBufferType();
    // ⚠️ The pin is the difference between this call warming the render's cache and warming a
    // parallel one nothing reads. `Renderer.compile()` takes the depth-0 render context; the pass
    // draws at depth 1, and `context.id` is part of every material's node-builder cache key — so
    // without it the first frame rebuilds every shader graph synchronously (513 ms of an 807 ms
    // block on the A23). Full mechanism + measurement: `passCompileContext.ts`.
    await pinPassCallDepth(
      this.rawRenderer, rt, getPassCallDepth(),
      () => this.scenePass.compileAsync(this.rawRenderer),
    );
  }

  /** Push live config into every stage's uniforms, OR report that the
   *  request needs a structural rebuild (stage set / MRT layout / an NPR
   *  structural field changed — the caller must `dispose()` this instance and
   *  construct a new one). */
  setConfig(req: PostFXRequest): boolean {
    if (needsRebuild(this.req, req)) {
      this.req = req;
      return true;
    }
    for (const stage of this.stages) stage.applyConfig(req);
    this.req = req;
    return false;
  }

  dispose(): void {
    this.pipeline.dispose();
    // Hand-free every node-owned render target: RenderPipeline.dispose() does
    // NOT recurse into the node graph, so without this an SS-scale rebuild
    // (dispose + reconstruct) leaks a target per rebuild.
    for (const stage of this.stages) stage.dispose?.();
    this.scenePass.dispose?.();
  }
}
