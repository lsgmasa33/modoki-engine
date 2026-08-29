/** The ONE enumeration of "which ECS traits mean a post-FX stage, and is it on" (#324b).
 *
 *  ⚠️ **Two consumers, and they must never grow separate lists.** `Scene3D`'s `buildReq` turns this
 *  into the live `PostFXRequest` that builds the stack; `prewarmShadersForWorld` asks the much
 *  smaller question "will the incoming world be drawn through a stack at all", so it can skip a
 *  per-(mesh, material) placeholder walk that a stack makes worthless. Those two used to be one
 *  inline block in `Scene3D.tsx` and one hand-maintained copy — and a copy is exactly the thing
 *  that goes stale, invisibly, the first time somebody adds a sixth post-FX trait. Whoever adds
 *  that trait adds it HERE, once, and both consumers follow.
 *
 *  Deliberately NOT in `stackPlan.ts`: that module is plain-data with zero `three` and zero ECS
 *  imports so its planning rules stay unit-testable without a world. This one owns the ECS read,
 *  and hands `stackPlan` the plain request it already knows how to plan. */
import type { World } from 'koota';
import { NPRPostFX } from '../../traits/NPRPostFX';
import { BloomPostFX } from '../../traits/BloomPostFX';
import { VignettePostFX } from '../../traits/VignettePostFX';
import { DepthOfFieldPostFX } from '../../traits/DepthOfFieldPostFX';
import { AmbientOcclusionPostFX } from '../../traits/AmbientOcclusionPostFX';
import type { NprTraitSnapshot } from '../npr/nprConfigFromTrait';
import { maskPostFXRequest } from '../qualityTier';
import { getActiveTierOverrides } from '../renderSettings';
import { planStages, type PostFXRequest, type BloomStageConfig, type VignetteStageConfig, type DofStageConfig, type AoStageConfig } from './stackPlan';

/** What one scan of the world found. Every field is a SNAPSHOT copied out of the trait row —
 *  koota's `updateEach` reuses the row object, so holding a reference would alias live data. */
export interface PostFXTraitScan {
  /** NPR is the odd one out: its trait carries a dozen tunables the caller re-derives through
   *  `nprConfigFromTrait`, so the raw snapshot is handed back rather than a stage config. `null`
   *  when the trait is absent OR disabled. */
  npr: NprTraitSnapshot | null;
  bloom: BloomStageConfig | null;
  vignette: VignetteStageConfig | null;
  dof: DofStageConfig | null;
  ao: AoStageConfig | null;
  /** Which post-FX traits EXIST on an entity in this world, enabled or not.
   *
   *  ⚠️ Separate from the fields above on purpose, and it is the half `worldWillUseStack` reads —
   *  see its own note. `enabled` is a RUNTIME value that game logic flips; presence is a property
   *  of the authored scene, and only the second one is knowable before the swap. */
  present: PostFXPresence;
}

/** Presence flags, one per post-FX trait. A record rather than loose booleans so a new trait
 *  cannot be added to the scan and forgotten by the predicate — TypeScript requires the key. */
export interface PostFXPresence {
  npr: boolean;
  bloom: boolean;
  vignette: boolean;
  dof: boolean;
  ao: boolean;
}

/** Read the world's post-FX singleton traits. **First entity carrying each trait wins, enabled or
 *  not** — a DISABLED first entity beats an enabled second one.
 *
 *  ⚠️ That matches the loops this replaced for `bloom`/`vignette`/`dof`/`ao`, which each used a
 *  `<x>Found` flag exactly like this. It does NOT match the old NPR loop, and saying otherwise
 *  would be a lie in a comment: NPR's loop returned early on `nprEnabled`, not on "seen one", so
 *  it walked PAST a disabled first entity and a second ENABLED `NPRPostFX` used to win. NPR is now
 *  the same shape as the other four.
 *
 *  The change is accepted deliberately rather than preserved. Every one of these traits is a
 *  singleton by contract, so two carriers is malformed authoring either way; of the two possible
 *  readings, "the first one you authored is the one that counts" is the one an author can predict
 *  and debug, while "whichever happens to be enabled wins" silently repairs the mistake and hides
 *  it. Uniform across all five beats bug-compatible with one outlier. Nothing in `games/**` or
 *  `demos/**` authors two carriers of any of them. */
export function scanPostFXTraits(world: World): PostFXTraitScan {
  const scan: PostFXTraitScan = {
    npr: null, bloom: null, vignette: null, dof: null, ao: null,
    present: { npr: false, bloom: false, vignette: false, dof: false, ao: false },
  };

  let nprFound = false;
  world.query(NPRPostFX).updateEach(([fx]: [NprTraitSnapshot & { enabled: boolean }]) => {
    if (nprFound) return;
    nprFound = true;
    scan.present.npr = true;
    if (!fx.enabled) return;
    scan.npr = {
      fillMode: fx.fillMode,
      depthThreshold: fx.depthThreshold,
      normalThreshold: fx.normalThreshold,
      colorThreshold: fx.colorThreshold,
      lineThickness: fx.lineThickness,
      lineStrength: fx.lineStrength,
      grayscaleGamma: fx.grayscaleGamma,
      grayscaleLift: fx.grayscaleLift,
      fxaa: fx.fxaa,
      fxaaEdgeThreshold: fx.fxaaEdgeThreshold,
      fxaaEdgeThresholdMin: fx.fxaaEdgeThresholdMin,
      fxaaBlendStrength: fx.fxaaBlendStrength,
      superSampleScale: fx.superSampleScale,
    };
  });

  let bloomFound = false;
  world.query(BloomPostFX).updateEach(([fx]: [BloomStageConfig & { enabled: boolean }]) => {
    if (bloomFound) return;
    bloomFound = true;
    scan.present.bloom = true;
    if (fx.enabled) scan.bloom = { strength: fx.strength, radius: fx.radius, threshold: fx.threshold };
  });

  let vignetteFound = false;
  world.query(VignettePostFX).updateEach(([fx]: [VignetteStageConfig & { enabled: boolean }]) => {
    if (vignetteFound) return;
    vignetteFound = true;
    scan.present.vignette = true;
    if (fx.enabled) scan.vignette = { intensity: fx.intensity, smoothness: fx.smoothness };
  });

  let dofFound = false;
  world.query(DepthOfFieldPostFX).updateEach(([fx]: [DofStageConfig & { enabled: boolean }]) => {
    if (dofFound) return;
    dofFound = true;
    scan.present.dof = true;
    if (fx.enabled) scan.dof = { focusDistance: fx.focusDistance, focalLength: fx.focalLength, bokehScale: fx.bokehScale };
  });

  let aoFound = false;
  world.query(AmbientOcclusionPostFX).updateEach(([fx]: [AoStageConfig & { enabled: boolean }]) => {
    if (aoFound) return;
    aoFound = true;
    scan.present.ao = true;
    if (fx.enabled) scan.ao = { radius: fx.radius, intensity: fx.intensity };
  });

  return scan;
}

/** Stands in for the NPR stage config in the presence-only request below. Its values reach no
 *  pipeline and no uniform — `planStages` and `maskPostFXRequest` both key off the field's
 *  PRESENCE. Frozen so a caller cannot mutate the shared instance. */
const NPR_PRESENCE_PLACEHOLDER = Object.freeze({
  isOrthographic: false,
  superSampleScale: 1,
  fillMode: 'flat',
  depthThreshold: 0,
  normalThreshold: 0,
  colorThreshold: 0,
  lineThickness: 0,
  lineStrength: 0,
  grayscaleGamma: 1,
  grayscaleLift: 0,
  clearColor: 0,
}) as PostFXRequest['npr'];

/** Could this world be drawn through a post-FX stack? Asked by the shader prewarm, BEFORE the
 *  swap, to decide whether its per-(mesh, material) placeholder walk is worth anything (#324b).
 *
 *  ⚠️ **Keyed on trait PRESENCE, not on `enabled` — and that is the whole design, not a shortcut.**
 *  An `enabled`-based predicate was written first and measured as INERT on the one project it
 *  exists for. `demos/postfx-demo` authors all five post-FX traits with `enabled` left at its
 *  default of **false** and turns them on from game logic (`postfx.showOnly`, driven by the
 *  Director's tour) — which runs AFTER the world swap. So at before-swap time the world honestly
 *  reports "no stage enabled", the prewarm walks every renderable, and one beat later the stack
 *  exists and every placeholder it just built is in the wrong render context. Measured on that
 *  project: 9 node-builder builds in the canvas context (`ctx 0`, 163 ms) that no frame ever reads,
 *  against 22 the live post-swap compile then builds in the stack's own context.
 *
 *  Presence is the strongest thing that IS knowable before the swap: `enabled` is runtime state
 *  any system may flip on the first tick, while carrying the trait at all is a property of the
 *  authored scene. The predicate is therefore deliberately CONSERVATIVE — it says "cannot predict
 *  the render context, do not gamble" rather than "a stack is certain".
 *
 *  The cost of that conservatism, stated plainly: a scene that authors a post-FX trait and never
 *  enables it loses its pre-swap placeholder walk, and its pipelines are instead built by
 *  `compileLiveScene` after the swap — later, and behind the first-frame hold, but still ahead of
 *  the first draw, so it is a hold-duration regression and not a stall. No project in the fleet has
 *  that shape today (checked 2026-08-26 across every `games/**` and `demos/**` scene: `space-console`
 *  and `demos/particle-demo` author theirs `enabled: true`, `demos/postfx-demo` flips them at
 *  runtime, and nothing else authors one at all). If one ever does and its boot regresses, the fix
 *  is to author the trait only when it is wanted — not to weaken this back to `enabled`.
 *
 *  FXAA is deliberately not modelled: it is never a stage on its own (`buildReq` only ever adds it
 *  alongside NPR, and its legality depends on a supersample scale the prewarm has no business
 *  knowing), so it cannot turn a false into a true.
 *
 *  Both of the OTHER gates the live path applies are kept, because both can legitimately say "no
 *  stack" and restore the walk's value:
 *   - the active tier, through the same `maskPostFXRequest` + `planStages` pair `Scene3D`'s
 *     `hasStages` uses, so a tier that drops every effect prewarms normally;
 *   - `isWebGPU`, because `Scene3D` builds a stack only under `hasStages && isWebGPU`. A WebGL2
 *     fallback draws straight to the canvas, so the placeholders ARE right there — and dropping
 *     this half would skip the walk on exactly the devices that fell back, i.e. buy a first-frame
 *     stall on the slowest hardware in the fleet. */
export function worldWillUseStack(world: World, opts: { isWebGPU: boolean }): boolean {
  if (!opts.isWebGPU) return false;
  const { present } = scanPostFXTraits(world);
  const req: PostFXRequest = {};
  // Presence-only, so every stage gets a placeholder config: `planStages` and `maskPostFXRequest`
  // both read which KEYS exist and never their values. Using placeholders rather than the scanned
  // configs also keeps this honest — a disabled trait has no config worth reading.
  if (present.npr) req.npr = NPR_PRESENCE_PLACEHOLDER;
  if (present.ao) req.ao = PRESENCE_PLACEHOLDER_AO;
  if (present.dof) req.dof = PRESENCE_PLACEHOLDER_DOF;
  if (present.bloom) req.bloom = PRESENCE_PLACEHOLDER_BLOOM;
  if (present.vignette) req.vignette = PRESENCE_PLACEHOLDER_VIGNETTE;
  return planStages(maskPostFXRequest(req, getActiveTierOverrides())).length > 0;
}

const PRESENCE_PLACEHOLDER_AO: AoStageConfig = Object.freeze({ radius: 0, intensity: 0 });
const PRESENCE_PLACEHOLDER_DOF: DofStageConfig = Object.freeze({ focusDistance: 0, focalLength: 0, bokehScale: 0 });
const PRESENCE_PLACEHOLDER_BLOOM: BloomStageConfig = Object.freeze({ strength: 0, radius: 0, threshold: 0 });
const PRESENCE_PLACEHOLDER_VIGNETTE: VignetteStageConfig = Object.freeze({ intensity: 0, smoothness: 0 });
