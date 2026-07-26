/** Pure post-FX stack planning — see docs/rendering.md "Post-Process Stack"
 *  ("Planning is pure") for the full design.
 *
 *  Every decision about WHICH stages run, in WHAT order, WHAT MRT layout the
 *  scene pass needs, and WHETHER a config change requires a pipeline rebuild
 *  (vs. a live uniform update) lives here — a plain-data module with zero
 *  `three`/TSL imports, so it's unit-testable without mocking the renderer.
 *  `PostFXStack` (the runtime that actually builds TSL node graphs) is the
 *  only consumer; it must not re-derive any of these decisions itself. */

export interface BloomStageConfig {
  strength: number;
  radius: number;
  threshold: number;
}

export interface VignetteStageConfig {
  intensity: number;
  smoothness: number;
}

export interface DofStageConfig {
  focusDistance: number;
  focalLength: number;
  bokehScale: number;
}

/** Always forces the scene pass's 'normal' MRT target (see `requiredMrtTargets`)
 *  — the cheaper "nullable normalNode, no MRT" GTAO path is broken under this
 *  renderer's multisampled depth buffer, not merely skipped for cost reasons. */
export interface AoStageConfig {
  /** World-space sample radius for the occlusion horizon search. */
  radius: number;
  /** 0 = no darkening, 1 = full raw AO. GTAONode has no strength control of its
   *  own (it outputs a raw 0..1 occlusion factor) — this lerps toward it so the
   *  effect doesn't crush shadows at full strength by default. */
  intensity: number;
}

/** FXAA tail-AA stage. Phase 3 moved FXAA OUT of NPR (where it reasoned about
 *  "I am the pipeline output") into a normal stack stage, so its tunables live
 *  here rather than inside the NPR config. Today only the `NPRPostFX` trait
 *  surfaces these knobs; the driver decides whether the stage is legal at all
 *  via `planFxaaEnabled`. */
export interface FxaaStageConfig {
  edgeThreshold: number;
  edgeThresholdMin: number;
  blendStrength: number;
}

/** The NPR stylize stage's full config. `isOrthographic` + `superSampleScale`
 *  are STRUCTURAL (they change the depth reconstructor / every render-target
 *  size, so `needsRebuild` returns true for them); everything else is a live
 *  uniform write. */
export interface NprStageConfig {
  isOrthographic: boolean;
  superSampleScale: number;
  fillMode: 'flat' | 'grayscale';
  depthThreshold: number;
  normalThreshold: number;
  colorThreshold: number;
  lineThickness: number;
  lineStrength: number;
  grayscaleGamma: number;
  grayscaleLift: number;
  /** Camera clear color (hex) shown where the MRT pass drew no geometry. */
  clearColor: number;
}

/** What the caller wants enabled this frame. A field's presence means that
 *  stage is on; its value carries the tunables the signature/rebuild logic
 *  needs to compare. */
export interface PostFXRequest {
  npr?: NprStageConfig;
  ao?: AoStageConfig;
  dof?: DofStageConfig;
  bloom?: BloomStageConfig;
  vignette?: VignetteStageConfig;
  fxaa?: FxaaStageConfig;
}

export type StageKind = 'npr' | 'npr-particles' | 'ao' | 'dof' | 'bloom' | 'vignette' | 'fxaa';

export type MrtTarget = 'output' | 'normal' | 'lineColor';

/** The enabled stages, in the fixed canonical order — NPR stylize + its
 *  particle-injection stage lead when enabled (they generate the base color
 *  everything downstream filters), then AO → DOF → bloom → vignette → AA.
 *  Never the request's own key order (plain object key order is not a
 *  decision we want to depend on). */
export function planStages(req: PostFXRequest): StageKind[] {
  const stages: StageKind[] = [];
  if (req.npr) {
    stages.push('npr', 'npr-particles');
  }
  if (req.ao) stages.push('ao');
  if (req.dof) stages.push('dof');
  if (req.bloom) stages.push('bloom');
  if (req.vignette) stages.push('vignette');
  if (req.fxaa) stages.push('fxaa');
  return stages;
}

/** The minimal MRT target union the scene pass must expose for the enabled
 *  stages. `'output'` is always required. `'lineColor'` is NPR-only.
 *
 *  `'normal'` is required for NPR **or** AO — NOT the "nullable normalNode,
 *  no MRT needed" v1 the plan doc originally sketched for GTAO. That path
 *  (`ao(depth, null, camera)` reconstructing normals via `getNormalFromDepth`)
 *  was tried and is BROKEN under this renderer: `getNormalFromDepth` compiles
 *  `textureDimensions(depthTex, 0)`, but our depth attachment is
 *  multisampled, and WGSL's multisampled-texture overload of
 *  `textureDimensions` takes NO level argument — a genuine upstream
 *  three.js/WGSL codegen gap, not a wiring bug (confirmed via the browser's
 *  native WGSL compiler diagnostic, not just the app-level console). So AO
 *  always gets a REAL normal buffer instead — the same MRT target NPR
 *  already forces and that Phase 3 already proved correct; this just widens
 *  when it's forced. Caveat: a custom-shader `NodeMaterial` on the
 *  previously MRT-free plain/AO-only path must now emit BOTH MRT targets
 *  (see `NPRPostProcess.ts`'s `nprFragmentOutput` for the pattern) or its
 *  draw is silently dropped — inert today since `AmbientOcclusionPostFX`
 *  defaults off and no shipped game enables it. */
export function requiredMrtTargets(req: PostFXRequest): MrtTarget[] {
  const targets: MrtTarget[] = ['output'];
  if (req.npr || req.ao) targets.push('normal');
  if (req.npr) targets.push('lineColor');
  return targets;
}

function serializeBloom(c: BloomStageConfig): string {
  return `${c.strength}:${c.radius}:${c.threshold}`;
}

function serializeVignette(c: VignetteStageConfig): string {
  return `${c.intensity}:${c.smoothness}`;
}

function serializeDof(c: DofStageConfig): string {
  return `${c.focusDistance}:${c.focalLength}:${c.bokehScale}`;
}

function serializeAo(c: AoStageConfig): string {
  return `${c.radius}:${c.intensity}`;
}

function serializeNpr(c: NprStageConfig): string {
  return [
    c.isOrthographic, c.superSampleScale, c.fillMode,
    c.depthThreshold, c.normalThreshold, c.colorThreshold,
    c.lineThickness, c.lineStrength, c.grayscaleGamma, c.grayscaleLift,
    c.clearColor,
  ].join(':');
}

function serializeFxaa(c: FxaaStageConfig): string {
  return `${c.edgeThreshold}:${c.edgeThresholdMin}:${c.blendStrength}`;
}

/** The FXAA stage's THREE hard preconditions, in one pure place (Phase 3
 *  blocker 2). They used to live inside `NPRPostProcess`'s constructor as
 *  `useFxaa`; the stack owns AA now, so the driver asks this before putting
 *  `fxaa` in the request at all:
 *   - the trait/caller asked for it;
 *   - we are NOT on the WebGL2 backend — `fxaaNode` is a raw-WGSL `wgslFn`
 *     that the WebGL backend's GLSL parser cannot compile (it crashes the
 *     whole pipeline build, not just the stage);
 *   - supersampling is off (F7). At SS>1 the SSAA already removes the
 *     aliasing FXAA targets, and the stage's texel size is derived at display
 *     resolution, so running it would cost scale² fragments for ~nothing. */
export function planFxaaEnabled(o: {
  requested: boolean; isWebGLBackend: boolean; superSampleScale: number;
}): boolean {
  if (!o.requested) return false;
  if (o.isWebGLBackend) return false;
  return o.superSampleScale === 1;
}

/** Stable string signature of every request value, in a fixed field order,
 *  so the render loop can edge-trigger `setConfig` the same way NPR does
 *  (`nprConfigSignature`) — skip the uniform-write pass entirely on a
 *  static scene. Two requests with equal values (any key order) produce an
 *  identical signature. */
export function stackSignature(req: PostFXRequest): string {
  return [
    `npr:${req.npr ? serializeNpr(req.npr) : '0'}`,
    `ao:${req.ao ? serializeAo(req.ao) : '0'}`,
    `dof:${req.dof ? serializeDof(req.dof) : '0'}`,
    `bloom:${req.bloom ? serializeBloom(req.bloom) : '0'}`,
    `vignette:${req.vignette ? serializeVignette(req.vignette) : '0'}`,
    `fxaa:${req.fxaa ? serializeFxaa(req.fxaa) : '0'}`,
  ].join('|');
}

/** The NPR fields that can only be honoured by rebuilding the graph: the
 *  camera projection (picks the depth→viewZ reconstructor, baked into the
 *  composite node) and the supersample scale (sizes every render target). */
function nprStructuralKey(req: PostFXRequest): string {
  return req.npr ? `${req.npr.isOrthographic}:${req.npr.superSampleScale}` : '-';
}

/** `true` iff the enabled STAGE SET, the required MRT LAYOUT, or an NPR
 *  STRUCTURAL field changed between two requests — the only things that force
 *  `PostFXStack` to dispose + reconstruct (a shader recompile). A param-only
 *  edit (e.g. a bloom strength drag, an NPR threshold slider) must return
 *  `false` so the driver applies it as a live uniform write instead — this is
 *  the rebuild-vs-live-update contract NPR's own `setConfig` used to own.
 *
 *  NOTE the `superSampleScale` half of that is DEBOUNCED by the driver
 *  (`SuperSampleRebuildDebouncer`), not here: a slider drag sweeps the value
 *  every frame and each distinct value would otherwise recompile. This
 *  function answers "does this pair of requests differ structurally", and the
 *  driver decides *when* to hand it a changed scale. Do not fold the debounce
 *  in here — it exists because of a real thrashing bug (npr-F9). */
export function needsRebuild(prev: PostFXRequest, next: PostFXRequest): boolean {
  if (planStages(prev).join(',') !== planStages(next).join(',')) return true;
  if (requiredMrtTargets(prev).join(',') !== requiredMrtTargets(next).join(',')) return true;
  if (nprStructuralKey(prev) !== nprStructuralKey(next)) return true;
  return false;
}
