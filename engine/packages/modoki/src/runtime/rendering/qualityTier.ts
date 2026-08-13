/** Quality tiers (#121 P3) — THREE tiers, `low`, `mid` and `high`.
 *
 *  ⚠️ It was TWO for most of this workstream, and the reason was honest: three tiers demand
 *  evidence for two boundaries and we had it for zero. That is no longer true. The boot ramp probe
 *  (#188, `rampProbe.ts`) was run on five real devices and the population falls into three bands,
 *  ~10x and ~2.5x apart — both gaps far outside the estimator's ~3x resolution:
 *
 *      weak     Huawei Y6 2019                  ~0.35 Mpx/ms   ~1.4 draw calls/ms
 *      middle   Galaxy A23 5G · iPhone 8 (A11)  ~4.0           ~16
 *      capable  iPad mini 5 (A12) · Galaxy S22  ~9.7           ~28
 *
 *  The A23 is the case that forced it: a two-tier split files it with the Y6, and that is wrong by
 *  this project's own measurement — forest-camp's IBL costs +2.9 ms of GPU there and fits inside
 *  60 fps, on hardware ~10x the Y6. Each band also mixes vendors and platforms (the A23 and the
 *  iPhone 8 landed on top of each other from opposite ecosystems, on measurement alone), so the
 *  bands are a property of the hardware population rather than of one vendor's naming.
 *
 *  **`mid` LOOSENS ONLY WHAT WAS MEASURED.** See `TIER_SETTINGS.mid` — IBL and shadows are on
 *  because a mid-band device was measured affording them; resolution, AA and the FX stack stay at
 *  `low`'s values because nothing has measured them there yet, and inventing a number is exactly
 *  what ossifies. That makes `mid` a strict improvement on what those devices get today (they all
 *  resolve `low`), never a regression.
 *
 *  ── MEASUREMENT IS THE GROUND TRUTH; THE ALLOWLIST IS A SHORTCUT ──────────────────────────
 *  One authoritative mechanism, so two classifiers can never disagree. Known-good hardware
 *  skips calibration via `TIER_ALLOWLIST`; everything else measures. The valuable property is
 *  how it fails: a STALE allowlist degrades into "promotes one calibration later", never into a
 *  wrong tier. That also covers the Android renderer string being masked for fingerprinting
 *  reasons someday (already deprecated in Firefox) — the shortcut stops matching and
 *  measurement still answers.
 *
 *  ── WHY THE ALLOWLIST IS EMPTY ────────────────────────────────────────────────────────────
 *  Deliberately. We own neither target device yet, and an unvalidated threshold copied into
 *  code is exactly what ossifies — this issue's own first draft shipped a tier table whose two
 *  signals both turned out to be dead. An empty allowlist is not an unfinished feature; it is
 *  the correct state until a real iPhone 8 and Galaxy A23 5G have been measured. Everything
 *  still works: every device simply calibrates.
 *
 *  ── `auto` IS THE DEFAULT, AND UNRECOGNISED MEANS `low` (#155) ────────────────────────────
 *  Owner decision, 2026-08-07: **a game launches in low-end spec unless the device is
 *  allowlisted.** `resolveTier` always started an unknown device at `low`; nothing supplied
 *  `auto`, because `DEFAULT_TIER_SETTING` was pinned `'high'` as an explicit placeholder.
 *
 *  What the placeholder cost, measured on a Huawei Y6 2019 (#156): booting `'high'` gave one
 *  `submit-postfx` of **6388 ms**, the GPU watchdog killed the WebGL context, and recovery
 *  failed — blank for the process lifetime. The SAME device holds 27–33 fps under `auto`, which
 *  resolves `low` and drops the post-FX stack. That is the whole distance between "runs" and
 *  "bricked", and it is the asymmetry this resolver was designed around: booting high and
 *  guessing wrong is a lost context and a permanent black screen; booting low and guessing wrong
 *  is a beat of uglier rendering (see `core/activeRenderer`).
 *
 *  **Desktops are the one carve-out**, and they are identified by `formFactor`, NOT by platform
 *  — see `DeviceCaps.formFactor` for why `platform === 'web'` cannot mean "desktop" (a phone
 *  browser says exactly that, and the demos publish web-only). A desktop keeps today's `high`;
 *  everything else starts low and measures. The editor's own viewports are desktop by this test,
 *  so authoring is unaffected.
 *
 *  Note what this does NOT claim: that `low` is right for every phone. It claims only that
 *  starting low is the recoverable mistake. Calibration promotes anything with the headroom —
 *  ⚠️ **up to the tier the device was ASSESSED at, and no further** (#188). See
 *  {@link promotionCeiling}: once the boot probe measures a device, a CPU-only inference does not
 *  get to overrule the measurement. */

import { BUDGET_30FPS_MS, type FrameProfile } from '../core/frameProfiler';
import { probeVerdictStore } from '../core/probeVerdictStore';
import { probeFingerprint, classifyMedianOf, type DeviceClass, type ProbeVerdict } from './rampProbe';
// The GPU-identity layer (#210). Its import back to here is TYPE-ONLY (`QualityTier`), so it is
// erased at compile time and this stays a one-way runtime dependency — the same shape, and for the
// same reason, as the `PostFXRequest` import below.
import { gpuIdentityTier } from './gpuIdentity';
// TYPE-ONLY, so this module keeps its one-way dependency and stays runtime-pure (`stackPlan.ts`
// imports nothing at all). It buys the exhaustiveness check on `POSTFX_KEY_PERMISSION` — the whole
// point of which is that a stage added there cannot silently escape the tier mask again.
import type { PostFXRequest } from './postfx/stackPlan';

export type QualityTier = 'low' | 'mid' | 'high';
/** What a PROJECT may ask for. `'auto'` delegates to the allowlist + calibration. */
export type QualityTierSetting = 'auto' | QualityTier;

/** The tiers, WEAKEST FIRST. The single source of the ordering — promotion and demotion move one
 *  step along this array rather than naming tiers, so adding a fourth tier could never leave a
 *  ladder branch behind (which is precisely the bug shape a two-tier `if (tier === 'high')` would
 *  have become the moment `mid` existed). */
export const TIER_ORDER: readonly QualityTier[] = ['low', 'mid', 'high'];

/** Is this a tier the engine knows? Exported so every VALIDATION site (persisted player prefs, a
 *  project config, a debug-menu payload) narrows through one function — a second hand-written
 *  `x === 'low' || x === 'high'` is how a new tier silently fails to round-trip. */
export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (TIER_ORDER as readonly string[]).includes(value);
}

/** The next tier up, or `null` at the top. */
export function tierAbove(tier: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null;
}

/** The next tier down, or `null` at the bottom. */
export function tierBelow(tier: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i > 0 ? TIER_ORDER[i - 1] : null;
}

/** See "`auto` IS THE DEFAULT". A project may still pin `'low'`/`'high'` to opt out. */
export const DEFAULT_TIER_SETTING: QualityTierSetting = 'auto';

/** How a tier was arrived at — reported so a surprising tier is explainable without an eval. */
export type TierSource =
  | 'player' | 'project' | 'allowlist' | 'model' | 'desktop' | 'calibrating' | 'measured'
  /** The GPU renderer string named hardware we have throughput data for (#210). Distinct from
   *  `'allowlist'` (a hand-written override) and from `'measured'` (this device was benchmarked
   *  at boot): this is a LOOKUP, correct on launch #1 and costing no launch time. */
  | 'gpu-benchmark'
  /** The GPU is a generation NEWER than anything in the table, so it inherited the top entry's
   *  band. Reported apart from `'gpu-benchmark'` because it carries different confidence — see
   *  `gpuIdentity.ts`. */
  | 'gpu-generation'
  /** The project authored ONE config, so nothing was measured and nothing needed to be — see
   *  `configCount`. Distinct from `'project'` (an explicit pin) and from `'desktop'` (a
   *  device judgement): this says the QUESTION did not arise, which is a different fact from any
   *  answer to it, and `diagnose` should be able to say so. */
  | 'single-config';

export interface TierResolution {
  tier: QualityTier;
  source: TierSource;
  /** One human-readable clause. Shown in `diagnose` and the debug menu. */
  reason: string;
  /** Set only on `source: 'measured'` — the boot probe found this device short of the next band
   *  on the CPU axis alone, with the GPU axis already clear. Read by {@link promotionCeiling},
   *  which uses it to allow exactly one live promotion step. See {@link ProbeVerdict.cpuLimited}
   *  for why that is sound here and nowhere else. */
  cpuLimited?: boolean;
}

/** The five composable post-process effects, named with `PostFXRequest`'s OWN keys
 *  (`postfx/stackPlan.ts`) rather than a parallel vocabulary — the tier mask is applied by
 *  DELETING keys from that request, so any renaming here would silently stop matching.
 *
 *  A tier gates post-FX per effect rather than all-or-nothing (owner, 2026-08-11) because the
 *  effects are not remotely comparable: on one iPhone 8, NPR takes a 27 ms frame to 56 ms (~+29),
 *  where vignette costs ~6 ms and bloom ~4. Seven to one, and the single boolean treated them
 *  identically — which is why postfx-demo's degraded config shows no post-FX at all, when it could
 *  drop NPR and AO and stay recognisably itself. */
export type PostFXEffect = 'npr' | 'ao' | 'dof' | 'bloom' | 'vignette';
export type PostFXMask = Readonly<Record<PostFXEffect, boolean>>;
/** Iteration order for UI and for masking. Exported so a fifth effect cannot be added to the
 *  request without this list failing to compile against `PostFXMask`. */
export const POSTFX_EFFECTS: readonly PostFXEffect[] = ['npr', 'ao', 'dof', 'bloom', 'vignette'];

/** Every effect on / every effect off. Built from {@link POSTFX_EFFECTS} rather than written out,
 *  so a sixth effect cannot be half-added: the literal would still compile, these cannot go stale. */
const maskOf = (on: boolean): PostFXMask =>
  Object.fromEntries(POSTFX_EFFECTS.map((e) => [e, on])) as unknown as PostFXMask;
export const ALL_POSTFX: PostFXMask = maskOf(true);
export const NO_POSTFX: PostFXMask = maskOf(false);

/** Render settings a tier imposes. `low` mirrors the hand-tune that got sling rendering on the
 *  Y6 2019 (`8e85b7b3`) — the per-game workaround this phase exists to replace. */
export interface TierRenderOverrides {
  pixelRatioCap: number;
  antialias: boolean;
  shadows: boolean;
  /** Ceiling on `Light.shadowMapSize`. The trait has no global cap today, so a tier saying
   *  "shadows at 1024" could not otherwise enforce it. 0 = no ceiling. */
  shadowMapCeiling: number;
  /** May the post-process stack run at all?
   *
   *  `low` says NO — the whole stack, not a selection. Post-FX is the dominant remaining cost on
   *  a weak device and it is screen-space, so its price is paid per pixel regardless of how
   *  simple the scene is. Measured on an iPhone 8 at one frozen shot: a 27 ms baseline goes to
   *  56 ms with NPR alone.
   *
   *  Dropping ALL of it is deliberately blunter than the measurements strictly require — bloom
   *  costs only ~4 ms there and vignette ~6 ms, so a project could afford those and still clear
   *  30 fps. A per-effect tier policy is a real future refinement (the interesting knob is NPR
   *  specifically, at ~7x bloom); this is the simple, guaranteed win, and a project that wants
   *  its effects on a weak device can still pin `qualityTier: 'high'`. */
  postFX: PostFXMask;
  /** Most DIRECTIONAL lights an object may be lit by. 0 = unlimited.
   *
   *  Directional is where our actual light cost lives: a census of every project found 3d-test
   *  running SEVEN directional lights and zero point/spot, and forward shading pays the full BRDF
   *  per light per fragment — a directional only skips distance attenuation. Capping point/spot
   *  alone (the usual mobile rule) would have been a no-op on every project we have. */
  maxDirectional: number;
  /** Most POINT+SPOT ("local") lights an object may be lit by. 0 = unlimited. */
  maxLocal: number;
  /** May image-based lighting (an HDR `Environment`) light the scene on this tier?
   *
   *  MEASURED on a Huawei Y6 2019 (#154): IBL costs **~26 ms of a ~53 ms frame** — half of it,
   *  and entirely GPU (`restMs` 36.7 -> 4.6). Switching it off takes sling 18.7 -> 36.5 fps.
   *
   *  It is the env LOOKUP that costs, not the texture: downsampling the source HDR from
   *  2048x1024 to 256x128 (16 MB -> 0.25 MB) moved the frame 53.4 -> 53.2 ms, i.e. nothing,
   *  because three's PMREM converts the source once into a fixed-size CubeUV cubemap and the
   *  fragment shader samples THAT. So this cannot be fixed by shrinking the asset — the only
   *  lever is not doing it. Scene BACKGROUND is left alone; it was measured not to be the cost. */
  ibl: boolean;
  /** Multiplier applied to AMBIENT light intensity when `ibl` is false, to put back the fill
   *  light the environment was providing. Without it the scene goes visibly dark and flat. */
  iblOffAmbientBoost: number;
  /** Multiplier applied to tone-mapping exposure when `ibl` is false — the second half of the
   *  same compensation. Measured together: 30.4 ms / 32.9 fps, against 27.4 / 36.5 uncompensated
   *  and 53.4 / 18.7 shipped. Clears the 33.3 ms budget WITH the lighting put back. */
  iblOffExposure: number;

  // ── The 2D layer and the frame cap (#202) ────────────────────────────────────────────────
  // Flat, with a `pixi` prefix, rather than nesting `{three:…, pixi:…}`. Nesting reads better but
  // would re-shape a config already seeded into 22 projects and pinned by
  // `engine/tests/architecture/qualityTierSeed.test.ts`. Not worth it for two fields; revisit if a
  // fourth 2D knob appears.

  /** Frame-rate cap this tier imposes, in fps. **0 = no tier cap.**
   *
   *  ⚠️ **THIS CANNOT CLAMP WITH A BARE `Math.min`** — `0` means *uncapped* on both sides (the
   *  project's own `rendering.targetFps` uses the same sentinel), so `min(0, 30)` would be 0 and
   *  the field would read as wired while doing nothing on exactly the projects that left the
   *  default alone. Go through `applyTierToTargetFps`, which treats 0 as `Infinity` on both
   *  sides before comparing and maps back.
   *
   *  Why this is plausibly the biggest lever in the tier system: capping a weak device to 30
   *  halves per-second GPU *and* CPU work and cuts thermal throttling — the effect that took an
   *  iPhone 8 to 30 Hz under twenty stacked probe runs. It also buys FEEL: a device that cannot
   *  hold 60 judders between 40 and 55, where a 30 cap is a stable 30. */
  targetFps: number;
  /** The 2D analogue of {@link pixelRatioCap} — an upper bound on the PixiJS backing-buffer DPR,
   *  applied by `canvas2DSizing.computeBackingSize` via `getEffectivePixiSettings()`.
   *
   *  Same sentinel problem as `targetFps`, from the other direction: `pixi.pixelRatioCap` treats
   *  **0 or negative as UNCAPPED** (see `computeBackingSize`, which warns that 0 is the value a
   *  human types by analogy with `pixi.resolution`'s "0 = auto"). So this clamps through
   *  `applyTierToPixi`, never a bare `Math.min`.
   *
   *  ⚠️ `pixi.resolution` is deliberately NOT tiered. It is a PIN (0 = auto), and the existing
   *  rule is that a pinned resolution is never capped — *"capping an explicit pin would make the
   *  pin a lie"* (`renderSettings.ts`). There is no analogue on the `three` side, so tiering it
   *  would be a new philosophy rather than a symmetric addition; it is also theoretical today
   *  (only `games/sling` pins it, at `1`, already the floor). If a project ever pins it high, that
   *  is the moment to ask the owner whether a tier may overrule a pin. */
  pixiPixelRatioCap: number;
  /** The 2D analogue of {@link antialias}.
   *
   *  ⚠️ Carries the SAME live-change limitation as its 3D twin, for the same reason: it is passed
   *  to `Application.init()` when a `canvas2DPool` slot is created, so a tier resolved or changed
   *  after that slot exists cannot walk it back. A demotion applies the DPR cap (which is
   *  re-measured through the resize bus) and AA catches up on the next slot creation. */
  pixiAntialias: boolean;
}

/** Treat the shared "0 = no cap" sentinel as no ceiling, so two caps can be compared with
 *  `Math.min`. Used by both `applyTierToTargetFps` and `applyTierToPixi` — the two
 *  fields whose stored `0` means the OPPOSITE of what `Math.min` would make of it. */
const asCeiling = (v: number): number => (v > 0 ? v : Infinity);
/** Map a ceiling back to the stored convention (`Infinity` → the `0` sentinel), so an uncapped
 *  result round-trips to the value a project config actually holds. */
const asStored = (v: number): number => (Number.isFinite(v) ? v : 0);

/** The frame cap in force: the tighter of what the project authored and what the tier imposes,
 *  with `0` meaning "no cap" on BOTH sides and in the result. See {@link TierRenderOverrides.targetFps}
 *  for why this exists rather than a `Math.min` at the call site. */
export function applyTierToTargetFps(authored: number, o: TierRenderOverrides): number {
  return asStored(Math.min(asCeiling(authored), asCeiling(o.targetFps)));
}

/** Ambient is deliberately NOT capped: three sums every `AmbientLight` into one constant term, so
 *  N of them cost the same as one and none of them run a BRDF. Capping them would buy nothing and
 *  visibly flatten the scene. */
export const TIER_SETTINGS: Record<QualityTier, TierRenderOverrides> = {
  low: {
    // pixelRatioCap STAYS 1 — spending the IBL saving on resolution was TRIED AND MEASURED, and
    // it does not fit. On the Huawei Y6 (#154), with IBL already suppressed:
    //     1x   (360x753)    22 ms   45 fps
    //     1.4x (503x1054)   72 ms   14 fps
    //     2x   (720x1506)   69 ms   14 fps
    // A fill-bound GPU pays ~4x for 2x DPR, which the ~11 ms of headroom cannot come close to
    // covering — and 1.4x is no cheaper, its odd 503x1054 buffer being worse for a tile-based
    // renderer than the aligned 2x one. So the low tier keeps the resolution guard and spends the
    // IBL saving on FRAME RATE, which is where it actually lands.
    pixelRatioCap: 1, antialias: false, shadows: false, shadowMapCeiling: 512, postFX: NO_POSTFX,
    maxDirectional: 1, maxLocal: 1,
    ibl: false, iblOffAmbientBoost: 4, iblOffExposure: 1.25,
    // ⚠️ **30 IS A DELIBERATE BEHAVIOUR CHANGE, not a carry-forward** (owner, 2026-08-11). Every
    // other seeded value preserves what the fleet already did; this one does not. A4 seeded 22
    // projects on the promise that nothing regresses, and `0` (authorable-and-inert) was the
    // option that kept it — the owner chose the useful value instead, so a seeded project on weak
    // hardware goes from uncapped to capped at 30. That is the point: a device that cannot hold
    // 60 currently judders between 40 and 55, where a 30 cap is a stable 30, and halving the
    // per-second work is the largest single saving in this table.
    targetFps: 30,
    // CARRY-FORWARD of `pixelRatioCap` above, on the SAME Y6 measurement — not a second one. The
    // ~4x cost for 2x DPR is a fill-rate fact about a tile-based mobile GPU, so it applies to a
    // Pixi canvas identically. Say so rather than implying the 2D layer was measured separately.
    pixiPixelRatioCap: 1, pixiAntialias: false,
  },
  /** #188. Every field here is either MEASURED on a mid-band device or deliberately left at
   *  `low`'s value; none of them is a number invented to fill the row.
   *
   *  ── WHAT IS LOOSENED, AND ON WHAT EVIDENCE ────────────────────────────────────────────────
   *    ibl: true            forest-camp's IBL costs **+2.9 ms of GPU on a Galaxy A23** (8.2 ->
   *                         11.2 ms) and holds 60 fps. This is the single measurement that made
   *                         `mid` necessary: the Y6's +26 ms does not transfer to a device 10x
   *                         its speed, so filing the A23 with it was measurably wrong.
   *    shadows: true        with a map-size FLOOR, not a bias multiplier — see
   *                         `shadowBiasScale`'s warning, which is the measured finding that a
   *                         512 map renders a dithered mess on the Y6 whatever the bias.
   *    shadowMapCeiling     1024. ⚠️ THE ONE FIELD HERE WITH NEITHER A MEASUREMENT NOR A
   *                         carry-forward: 512 is measured unusable and 2048 is what `high`
   *                         authors, so this is the step between, chosen for cost (a quarter of
   *                         2048's texels) and not verified to look clean on a mid device. It is
   *                         also the safe direction — worst case a mid device renders shadows
   *                         that are coarser than intended, which costs quality, not the frame.
   *
   *  ── `pixelRatioCap: 1.5` — THE MEASUREMENT THAT EARNED IT (owner, 2026-08-12) ─────────────
   *    This row said 1 for months, correctly, because the plan demanded "its own measurement; do
   *    not guess it" and the only datum was the Y6 paying ~4x for 2x DPR — not a curve that
   *    extrapolates by eye. It has now been measured on the band's own anchor, a Galaxy A23
   *    (`sling`, uncapped, driven through the tier path so every resize is real):
   *
   *      DPR 1      384x801   0.31 Mpx   61.7 fps   16.2ms   GPU 4.9ms
   *      DPR 1.5    576x1201  0.69 Mpx   59.5 fps   16.8ms   GPU 6.2ms   <- 2.2x the pixels, holds 60
   *      DPR 1.875  720x1501  1.08 Mpx   54.6 fps   18.3ms   GPU 7.2ms   <- misses 60
   *
   *    The curve bends hard BETWEEN the integers, which is why the answer was invisible while the
   *    only options anyone tried were 1 and 2. 1.5 buys 2.2x the pixels for +1.3ms of GPU and stays
   *    inside the frame; 2 costs 3.5x and does not.
   *
   *    ⚠️ MEASURED ON ONE PROJECT, and `sling` is LIGHT — 38 draw calls, 112k triangles. A
   *    fill-heavy scene (forest-camp, postfx-demo) has not been measured at 1.5 on this band, and
   *    a project that cannot afford it should author its own `tiers.mid.pixelRatioCap: 1`. The
   *    number here is the seed, not a law.
   *    ⚠️ It was also measured on a DEBUG build carrying ~10.5ms of CPU; a release build has more
   *    margin, not less, so this errs safe.
   *
   *  ── WHAT IS DELIBERATELY STILL AT `low`, AND WHY THAT IS NOT LAZINESS ─────────────────────
   *    antialias: false     Baked into the swapchain at renderer construction (see
   *                         `tierCalibration`'s header), so a wrong guess here cannot be walked
   *                         back live. Unmeasured on this band.
   *    postFX: false        MEASURED against it: an iPhone 8 — squarely mid-band, 3.9 Mpx/ms —
   *                         goes 27 ms -> 56 ms with NPR alone, i.e. straight past the 33.3 ms
   *                         budget on one effect. The FX stack stays off until a per-effect
   *                         policy exists (bloom at ~4 ms is affordable; NPR at ~7x bloom is not).
   *
   *  ── THE LIGHT CAPS ARE ANCHORED ON THE A23 LADDER — AND ARE NOT ENFORCED YET ──────────────
   *  Measured on the A23 at native DPR, one frozen viewpoint, no shadows or post-FX: 1
   *  directional = 21 ms (47 fps), +3 point = 34 ms (29 fps), +8 point = 165 ms (6 fps). The cost
   *  is SUPERLINEAR in count with a cliff between 5 and 10, so the cap has to sit below the cliff
   *  rather than scale smoothly. 2 directional + 3 local puts a mid device at the measured
   *  ~30 fps edge of that ladder on desktop-authored content, with the DPR-1 clamp (worth ~2.7x
   *  there) still in hand — and well clear of the collapse.
   *
   *  ✅ **`maxDirectional`/`maxLocal` ARE LIVE** — wired in `1631ac8a` ("the tier's light caps stop
   *  being decorative — 9.24ms to 3.80ms of GPU on an A23"), applied per frame by
   *  `armAutoLightCap(_maskedLights, getActiveTierOverrides())` in `scene3DSync`. This docblock
   *  said "INERT — on EVERY tier" for a further day after that landed, and so did the tier table in
   *  rendering.md and — worst — the Project Settings help text the author reads while choosing the
   *  number. Two fields that work, labelled dead, so nobody tunes them (review 2026-08-12). The
   *  mechanism lives in `rendering/autoLightCap.ts` + `autoLightCapFrame.ts`; the ladder above is
   *  the measurement behind these two values and is the part worth carrying. */
  mid: {
    pixelRatioCap: 1.5, antialias: false, shadows: true, shadowMapCeiling: 1024, postFX: NO_POSTFX,
    maxDirectional: 2, maxLocal: 3,   // enforced per frame — see above
    ibl: true, iblOffAmbientBoost: 1, iblOffExposure: 1,
    // NO frame cap on `mid`, and that is the same discipline as the four fields above it: a mid
    // device has never been measured missing 60, so capping it to 30 would be inventing a number
    // to fill the row. `low` gets 30 because the Y6 was measured at 14-45 fps; nothing here was.
    targetFps: 0,
    // ⚠️ NOT carried forward with the 3D cap. `pixelRatioCap` moved to 1.5 on a THREE.js
    // measurement (see above); the 2D DPR is a separate instrument on a separate renderer and
    // #204 is still open on what it should be for Android. Raising this one by analogy is the
    // guess that measurement replaced — it stays at 1 until a Pixi ramp says otherwise. AA the same.
    pixiPixelRatioCap: 1, pixiAntialias: false,
  },
  high: {
    pixelRatioCap: 2, antialias: true, shadows: true, shadowMapCeiling: 0, postFX: ALL_POSTFX,
    maxDirectional: 0, maxLocal: 0,
    ibl: true, iblOffAmbientBoost: 1, iblOffExposure: 1,
    // Mirrors the 3D row above it. ⚠️ This row is NOT what `high` resolves to — that is
    // `UNCLAMPED_OVERRIDES`, and the difference is live (see its header). This row survives only
    // as documentation of the old table; `seedTier` offers `mid`/`low` alone.
    targetFps: 0, pixiPixelRatioCap: 2, pixiAntialias: true,
  },
};

// ── Authored tier configs (docs/rendering.md § "Quality tiers") ────────────────────────────
// Owner decision, 2026-08-11: a project starts with ONE config — the DEFAULT, which is what it
// authored — and ADDS a `mid`/`low` only if it wants degradation. `TIER_SETTINGS` above stops
// being the live policy and becomes the SEED an added config starts from, so "Add low" gives a
// project today's measured behaviour rather than ten blank fields.

/** The identity: what you get when nothing clamps. This IS the default config — not an object a
 *  project stores, but the absence of one.
 *
 *  ⚠️ **`TIER_SETTINGS.high` IS NOT THIS, AND THE DIFFERENCE IS LIVE.** That row carries
 *  `pixelRatioCap: 2`, and `applyTierToThree` takes `Math.min(authored, 2)` — so the module
 *  header's claim that "`high` is provably a no-op" holds for the booleans and is FALSE for that
 *  number. `games/court` authors `pixelRatioCap: 3` and has been silently rendering at 2 on every
 *  device that resolves `high`. `Infinity` is what makes the default an actual identity, and it
 *  gives Court back the value it asked for. */
export const UNCLAMPED_OVERRIDES: TierRenderOverrides = {
  pixelRatioCap: Infinity, antialias: true, shadows: true, shadowMapCeiling: 0, postFX: ALL_POSTFX,
  maxDirectional: 0, maxLocal: 0,
  ibl: true, iblOffAmbientBoost: 1, iblOffExposure: 1,
  // `0` (not `Infinity`) is the identity for these two, because both fields carry the "0 = no cap"
  // sentinel rather than a numeric ceiling — `applyTierToTargetFps`/`applyTierToPixi` widen it to
  // `Infinity` internally and narrow it back. Writing `Infinity` here would still behave, but it
  // would be a value no project config can hold, and this object doubles as the fill-in for a
  // config authored before a field existed (see {@link resolveTierOverrides}).
  targetFps: 0, pixiPixelRatioCap: 0, pixiAntialias: true,
};

/** What a project authors, if anything. Both keys ABSENT rather than null when unauthored —
 *  presence is the signal the probe gate reads (no configs ⇒ one config ⇒ nothing to choose
 *  between ⇒ no probe), and `null` would make "authored an empty config" indistinguishable from
 *  "did not author one". */
export interface AuthoredTiers {
  mid?: TierRenderOverrides;
  low?: TierRenderOverrides;
}

/** How many configs this project has. 1 (the default alone) means the boot probe cannot change
 *  any outcome and must not run — the owner's rule, and the whole launch-time win. */
export function configCount(authored: AuthoredTiers | undefined): number {
  return 1 + (authored?.mid ? 1 : 0) + (authored?.low ? 1 : 0);
}

/** The overrides in force for a tier, given what the project authored.
 *
 *  Falls DOWN, never up: a `low` on a project that only authored `mid` gets `mid`, because the
 *  author's most conservative config is the closest thing to what they meant. Reaching for the
 *  unclamped default there would hand the weakest hardware the settings the author was explicitly
 *  degrading away from.
 *
 *  ⚠️ A consequence worth stating rather than discovering: on a project that has authored NOTHING,
 *  every tier resolves to the same unclamped default — so **pinning `qualityTier: 'low'` does
 *  nothing**. That is correct under this model (you cannot select a config that does not exist)
 *  and it is why the Project Settings dropdown must offer only `auto` plus the tiers actually
 *  authored, instead of all four unconditionally. */
export function resolveTierOverrides(
  tier: QualityTier,
  authored: AuthoredTiers | undefined,
): TierRenderOverrides {
  if (tier === 'high') return UNCLAMPED_OVERRIDES;
  if (tier === 'mid') return complete(authored?.mid);
  return complete(authored?.low ?? authored?.mid);
}

/** Memo for {@link complete}, keyed on the AUTHORED object. `getActiveTierOverrides()` is called
 *  per frame by the render loop (`reconcileToneExposure`, `syncLights`), so completing by spread on
 *  every read would allocate two objects per frame per call site — GC pressure on precisely the
 *  weak hardware these tiers exist for. A `WeakMap` makes the steady state allocation-free and
 *  drops the entry with the config. */
const completed = new WeakMap<object, TierRenderOverrides>();

/** Fill in fields an authored config does not carry, from {@link UNCLAMPED_OVERRIDES}.
 *
 *  ⚠️ **THIS IS NOT DEFENSIVE PADDING — 22 project configs are missing fields RIGHT NOW.** A4
 *  seeded the fleet with the ten fields that existed then, and the seed is idempotent (it skips a
 *  project that already authors `tiers`). So every seeded project's `low` reached #202 with no
 *  `targetFps`/`pixiPixelRatioCap`/`pixiAntialias`, and `Math.min(3, undefined)` is `NaN` — a
 *  backing buffer of `NaN` pixels, silently, on the projects the feature is aimed at. Backfilling
 *  the configs (see `engine/scripts/seed-quality-tiers.mjs`) fixes the fleet; this fixes the
 *  CLASS, including a hand-edited config and every field added after today.
 *
 *  Absent means UNCLAMPED, never "0"/"false": a config written before a field existed cannot have
 *  meant to clamp it. `postFX` is merged one level deeper for the same reason — a partial
 *  `{npr:false}` must not read as "every other effect off". */
function complete(o: TierRenderOverrides | undefined): TierRenderOverrides {
  if (!o) return UNCLAMPED_OVERRIDES;
  let full = completed.get(o);
  if (!full) {
    // A config that already carries every field is returned AS ITSELF, not copied. That keeps the
    // identity `resolveTierOverrides` has always had (its tests assert `toBe`, and a caller may
    // reasonably compare references to detect "same config"), and means the completion path only
    // exists for the configs that actually need it.
    full = hasEveryField(o) ? o : { ...UNCLAMPED_OVERRIDES, ...o, postFX: { ...ALL_POSTFX, ...o.postFX } };
    completed.set(o, full);
  }
  return full;
}

/** Does this config carry every field the engine knows about? Keyed off `UNCLAMPED_OVERRIDES`
 *  rather than a written-out list, so a field added to `TierRenderOverrides` is covered the moment
 *  it gets an identity value — a hand-maintained list here would go stale invisibly, which is the
 *  exact failure {@link complete} exists to absorb. */
function hasEveryField(o: TierRenderOverrides): boolean {
  for (const k of Object.keys(UNCLAMPED_OVERRIDES) as (keyof TierRenderOverrides)[]) {
    if (o[k] === undefined) return false;
  }
  return POSTFX_EFFECTS.every((e) => o.postFX?.[e] !== undefined);
}

/** May this ONE post-process effect run, under the RESOLVED overrides? Takes the resolved object
 *  (never a `QualityTier`) so a project's authored config is what decides, not a code table — see
 *  `getActiveTierOverrides` (renderSettings.ts), the one resolution point every caller reads. The
 *  caller masks a `PostFXRequest` per effect rather than gating the whole stack (owner,
 *  2026-08-11): the effects are not remotely comparable in cost (NPR ~+29ms on an iPhone 8 vs.
 *  bloom ~4ms), so an all-or-nothing switch was blunter than the measurements require. */
export function tierAllowsEffect(o: TierRenderOverrides, effect: PostFXEffect): boolean {
  return o.postFX[effect];
}

/** Every key a `PostFXRequest` can carry — **which is NOT the same set as {@link POSTFX_EFFECTS}**,
 *  and the difference was a real leak (review 2026-08-12).
 *
 *  ⚠️ `fxaa` is a full member of `PostFXRequest` (`postfx/stackPlan.ts`) but is not a TIER field, so
 *  the old mask — which looped over `POSTFX_EFFECTS` — could not reach it. `Scene3D` populates
 *  `req.fxaa` inside its `if (nprSnap)` block, so masking `npr` off deleted `req.npr` and left
 *  `req.fxaa` behind: `planStages` still returned a non-empty stack, and a tier whose authored
 *  config says every post-FX effect is OFF still allocated a full-screen render target and ran an
 *  FXAA pass every frame. WebGPU-only (`planFxaaEnabled` refuses on WebGL2), which is exactly why it
 *  was invisible on the Y6 and iPhone 8 where most of this was measured.
 *
 *  Typed as `keyof PostFXRequest` so **a stage added to that interface is a compile error here**
 *  until someone decides whether a tier may drop it. That is the property worth having: deriving
 *  `fxaa`'s permission from `npr` inside `Scene3D`'s request builder would have fixed today's leak
 *  and re-created the same class one level down. */
type PostFXRequestKey = keyof PostFXRequest;

/** Which tier permission governs each request key. Exhaustive by type — see
 *  {@link PostFXRequestKey}.
 *
 *  `fxaa` maps to `antialias` rather than to a post-FX effect because that is what it IS: the
 *  anti-aliasing the tier already has an authored field for. So a tier that turned AA off gets no
 *  FXAA pass, and `high` (`antialias: true` in {@link UNCLAMPED_OVERRIDES}) keeps it — the no-op
 *  guarantee holds. */
const POSTFX_KEY_PERMISSION: Record<PostFXRequestKey, (o: TierRenderOverrides) => boolean> = {
  npr: (o) => tierAllowsEffect(o, 'npr'),
  ao: (o) => tierAllowsEffect(o, 'ao'),
  dof: (o) => tierAllowsEffect(o, 'dof'),
  bloom: (o) => tierAllowsEffect(o, 'bloom'),
  vignette: (o) => tierAllowsEffect(o, 'vignette'),
  fxaa: (o) => o.antialias,
};

const POSTFX_REQUEST_KEYS = Object.keys(POSTFX_KEY_PERMISSION) as PostFXRequestKey[];

/** Delete every key the RESOLVED overrides disallow from a post-FX request, in place — the
 *  mechanism {@link POSTFX_EFFECTS}'s header promises ("the tier mask is applied by DELETING keys
 *  from that request"). Generic over the request shape (rather than importing `PostFXRequest`
 *  from `postfx/stackPlan.ts`) so this module's one-way dependency holds — see the layer-contract
 *  note on {@link TierClampableThree}. A plain function rather than inlined at its one caller
 *  (Scene3D.tsx) because that caller is a `.tsx` render loop this repo does not unit-test; the
 *  DECISION belongs in a plain, tested module beside it.
 *
 *  Returns `req` for convenience; the caller already owns its lifetime for the frame. */
export function maskPostFXRequest<T extends Partial<Record<PostFXRequestKey, unknown>>>(
  req: T,
  o: TierRenderOverrides,
): T {
  for (const key of POSTFX_REQUEST_KEYS) {
    if (!POSTFX_KEY_PERMISSION[key](o)) delete req[key];
  }
  return req;
}

/** The subset of `ThreeRenderSettings` a tier touches. Declared STRUCTURALLY rather than
 *  imported so this module keeps its one-way dependency (`renderSettings` imports here, never the
 *  reverse) and stays pure + trivially testable. */
export interface TierClampableThree {
  pixelRatioCap: number;
  antialias: boolean;
  shadows: boolean;
}

/** Apply the RESOLVED overrides to the project's authored three settings.
 *
 *  A TIER CLAMPS, IT DOES NOT REPLACE. `high` must be exactly today's behaviour, so a project
 *  that deliberately authored `pixelRatioCap: 1` or `shadows: false` keeps it — being on the high
 *  tier is not a reason to start doing MORE work than the project asked for. Only a clamping
 *  override can take things away. (The DEFAULT config — `UNCLAMPED_OVERRIDES` — is a true
 *  identity here, `pixelRatioCap: Infinity` included, which is what keeps the desktop carve-out
 *  and any allowlisted device on exactly today's behaviour, and what stops this from silently
 *  reintroducing the old `TIER_SETTINGS.high` clamp to 2 that Court's authored 3 was quietly
 *  losing to.)
 *
 *  Takes `o: TierRenderOverrides` — the resolved object, never a `QualityTier` — so a project's
 *  authored config decides, not a code table. See `getActiveTierOverrides` (renderSettings.ts).
 *
 *  Returns a NEW object; the caller's settings are never mutated. */
export function applyTierToThree<T extends TierClampableThree>(three: T, o: TierRenderOverrides): T {
  return {
    ...three,
    // ⚠️ THROUGH `asCeiling`, NOT A BARE `Math.min` — `three.pixelRatioCap` carries the SAME
    // "0 (or negative) = uncapped" sentinel as its 2D twin. `basePixelRatio` reads it that way
    // (`cap > 0 ? min(dpr, cap) : dpr`) and Project Settings tells the author so, in as many
    // words: the field's placeholder is `2 (0 = uncapped)`.
    //
    // This was a bare `Math.min` until #202's close-out, and the consequence was total: a project
    // authoring `0` to get native DPR on capable hardware had `min(0, 1) = 0` on `low` — still
    // uncapped — so the tier's DPR clamp, the single measured saving behind the whole `low` row
    // (a Y6 paying ~4x for 2x DPR), did nothing on exactly the devices it exists for. The sentinel
    // helpers were written for `targetFps` and `pixiPixelRatioCap` in the same change and this
    // third field with identical semantics was not swept for.
    pixelRatioCap: asStored(Math.min(asCeiling(three.pixelRatioCap), asCeiling(o.pixelRatioCap))),
    antialias: three.antialias && o.antialias,
    shadows: three.shadows && o.shadows,
  };
}

/** The subset of `PixiRenderSettings` a tier touches — declared structurally, exactly like
 *  {@link TierClampableThree} and for the same one-way-dependency reason.
 *
 *  `resolution` and `backend` are absent DELIBERATELY: `resolution` is a pin a tier may not
 *  overrule (see {@link TierRenderOverrides.pixiPixelRatioCap}), and forcing a backend on a weak
 *  device is a correctness risk rather than a saving. */
export interface TierClampablePixi {
  antialias: boolean;
  pixelRatioCap: number;
}

/** Apply the RESOLVED overrides to the project's authored pixi settings — the 2D twin of
 *  {@link applyTierToThree}, with the same contract: a tier CLAMPS, it does not replace, and the
 *  unclamped default is a true identity.
 *
 *  ⚠️ The one asymmetry, and it is why this is not a copy of `applyTierToThree`: on the 2D side a
 *  `pixelRatioCap` of **0 (or negative) means UNCAPPED**, not "ratio 0" — `computeBackingSize`
 *  says so, and warns that 0 is the value a human types by analogy with `pixi.resolution`. A bare
 *  `Math.min` would therefore read an authored "uncapped" as the tightest possible cap and shrink
 *  the buffer to nothing. Both sides widen through {@link asCeiling} first, and the result narrows
 *  back so an uncapped outcome round-trips to the `0` a config actually stores.
 *
 *  Returns a NEW object; the caller's settings are never mutated. */
export function applyTierToPixi<T extends TierClampablePixi>(pixi: T, o: TierRenderOverrides): T {
  return {
    ...pixi,
    pixelRatioCap: asStored(Math.min(asCeiling(pixi.pixelRatioCap), asCeiling(o.pixiPixelRatioCap))),
    antialias: pixi.antialias && o.pixiAntialias,
  };
}

/** Android devices known to be fine at `high`, so they skip calibration.
 *
 *  ANDROID ONLY since 2026-08-09. It used to carry an `iosModels` list too, which was both empty
 *  and dead in production (#146 — it read a plugin no project installs, so `deviceModel` was
 *  always `undefined`); iOS now answers from the model id directly, via
 *  {@link IOS_TIER_MIN_GENERATION}, which is a threshold rather than a list and so cannot
 *  go stale against hardware that does not exist yet.
 *
 *  Keyed by GPU RENDERER string (`Adreno (TM) 610`) because on Android the model name is
 *  ambiguous — one name can ship two GPUs. See `deviceCaps`.
 *
 *  ⚠️ **EACH ENTRY CARRIES ITS OWN TIER since #188**, and that is not cosmetic. It used to be a
 *  bare list of patterns that all meant `'high'` — which was fine with two tiers and became a trap
 *  with three: the first GPU anyone measures into the MIDDLE band could only be added as `'high'`,
 *  i.e. the shortcut would have to lie to be usable. The list is still empty, so this changes no
 *  behaviour today; it changes what the next person is able to express. (The same gap in the iOS
 *  table was not latent — it was live, and is fixed in {@link IOS_TIER_MIN_GENERATION}.)
 *
 *  EMPTY ON PURPOSE — see the module header. Add an entry only after MEASURING that device. */
export const TIER_ALLOWLIST: {
  androidGpuPatterns: readonly { pattern: RegExp; tier: QualityTier }[];
} = {
  androidGpuPatterns: [],
};

// ── iOS: the model id IS the tier (owner, 2026-08-09) ──────────────────────────────────────

/** Lowest hardware GENERATION that gets `high`, per Apple device family.
 *
 *  ── WHY iOS GETS A TABLE AND ANDROID GETS A PROBE ─────────────────────────────────────────
 *  Because the two platforms expose opposite things. Apple's hardware set is small, enumerable,
 *  and — the property that actually matters — the generation is ENCODED IN THE IDENTIFIER, so
 *  `iPhone10,1` sorts against `iPhone14,6` without a lookup. Android's only comparable signal is
 *  the GPU renderer string, which is ambiguous (one name ships two GPUs), is already deprecated
 *  in Firefox for fingerprinting, and is the model-keyed value this plan predicted would
 *  ossify. So iOS answers statically and Android has to measure — see `rampProbe.ts`.
 *
 *  ── A THRESHOLD, NOT A LIST — AND THAT IS THE WHOLE POINT ─────────────────────────────────
 *  An enumerated allowlist ossifies in the WORST direction: a phone that does not exist yet is
 *  absent from it, so next year's hardware is classified `low` by a table written today. A
 *  `>= N` rule cannot fail that way, because newer Apple silicon is only ever faster. This is
 *  the same shortcut `TIER_ALLOWLIST` was reaching for, expressed so that being out of date
 *  makes it conservative on OLD hardware rather than wrong on new.
 *
 *  ── WHY THE MAJOR NUMBER IS A SOC BOUNDARY, NOT JUST A YEAR ───────────────────────────────
 *  It tracks the chip: `iPhone10,x` is A11 — and that covers the iPhone 8 AND the iPhone X, which
 *  genuinely share the SoC, so grouping them is correct rather than a rounding error.
 *  `iPhone11,x` is A12, `iPhone12,x` A13, and so on.
 *
 *  ── TWO FLOORS SINCE #188, AND THE `mid` ONE IS A CORRECTION ──────────────────────────────
 *  ⚠️ This carried ONE floor and said "below it means `low`". With `mid` that became a
 *  CONTRADICTION between the engine's own two classifiers, on hardware both had measured: an
 *  iPhone 8 (`iPhone10,1`, A11) reads 3.9 Mpx/ms + 15.8 calls/ms on the ramp probe, which is the
 *  MIDDLE band — the same band as the Galaxy A23, and one of the two devices that DEFINE it. So a
 *  native build resolved `low` from this table while the same phone on iOS *web* (no model id,
 *  hence the probe) resolved `mid`. Same hardware, two answers, from a module whose header
 *  promises "one authoritative mechanism, so two classifiers can never disagree".
 *
 *  What the iPhone 8 measurement actually shows is 27 ms -> 56 ms **with NPR**, i.e. it cannot
 *  afford POST-FX — which is exactly the knob `mid` turns off. It has never been shown unable to
 *  afford IBL or shadows at DPR 1, and the band it measures into was measured affording them.
 *
 *  ⚠️ **`iPhone.high` (11 = A12) REMAINS THE ONE GENUINELY UNMEASURED NUMBER.** That A12 clears
 *  the budget is an INFERENCE — though the probe now corroborates it from an unrelated method
 *  (an A12 iPad mini 5 measures ~2.5x the A11 iPhone, into the `capable` band). It errs in the
 *  recoverable direction if wrong (see the module header) and should still be confirmed.
 *
 *  ⚠️ **The iPad row is deliberately `mid === high`, so iPads keep exactly their old behaviour**
 *  — no iPad below A12 has been measured, and giving the row a `mid` floor would invent the very
 *  kind of number this table's design exists to avoid. `iPad: 8` itself is still a straight
 *  guess; iPad majors run on their own sequence (`iPad11,x` is A12), so the iPhone number cannot
 *  be borrowed.
 *
 *  A family absent from this table resolves `null` and falls through to the normal path. */
export const IOS_TIER_MIN_GENERATION: Readonly<Record<string, { mid: number; high: number }>> = {
  /** A11 (iPhone 8 / X) measures into the MIDDLE band; A12+ inferred `high`. */
  iPhone: { mid: 10, high: 11 },
  /** No `mid` band: nothing below A12 has been measured, so this row stays a single boundary. */
  iPad: { mid: 8, high: 8 },
  // iPod is deliberately absent: no iPod touch can run the iOS 16.4 floor, so any that appears
  // is out of scope and should fall through rather than be classified by a number we invented.
};

/** `iPhone10,1` -> `{ family: 'iPhone', generation: 10 }`. `null` for anything unrecognised —
 *  a masked, spoofed or simulator model string must not be coerced into a tier. */
export function parseAppleModel(model: string): { family: string; generation: number } | null {
  const m = /^([A-Za-z]+)(\d+),(\d+)$/.exec(model.trim());
  if (!m) return null;
  const generation = Number(m[2]);
  return Number.isFinite(generation) ? { family: m[1], generation } : null;
}

/** The tier an iOS model id implies, or `null` when the id says nothing usable (unknown family,
 *  unparseable string). Pure, and exported so the boundary is directly testable. */
export function iosModelTier(model: string | undefined): QualityTier | null {
  if (!model) return null;
  const parsed = parseAppleModel(model);
  if (!parsed) return null;
  const floors = IOS_TIER_MIN_GENERATION[parsed.family];
  if (!floors) return null;
  if (parsed.generation >= floors.high) return 'high';
  return parsed.generation >= floors.mid ? 'mid' : 'low';
}

/** Facts `resolveTier` needs. A subset of `DeviceCaps` so this stays pure and trivially
 *  testable — it takes data, not a probe. */
export interface TierResolveInput {
  platform: string;
  deviceModel?: string;
  gpuRenderer?: string;
  /** Player's explicit choice, if they have made one. Wins over everything. */
  playerChoice?: QualityTier | null;
  /** The project's `rendering.three.qualityTier`. */
  projectSetting?: QualityTierSetting;
  /** Desktop-class host, or a handheld? Absent = treat as a handheld, which is the safe side
   *  (see `DeviceCaps.formFactor`). A probe that failed therefore lands on `low`, not `high`. */
  formFactor?: 'mobile' | 'desktop';
  /** What the boot ramp probe measured, if it ran (#188). Absent means it did not run, could not
   *  run, or produced nothing usable — all of which must land on today's behaviour, never on a
   *  guess. See `rampProbe.ts`. */
  probeClass?: DeviceClass;
  /** Companion to {@link TierResolveInput.probeClass} — see {@link ProbeVerdict.cpuLimited}.
   *  Absent whenever `probeClass` is, and ignored on every branch that answers before the probe. */
  probeCpuLimited?: boolean;
}

/** The device facts a tier resolution is built from — the shape `DeviceCaps` supplies, narrowed to
 *  what {@link resolveTier} reads. Structural rather than an import of `DeviceCaps`, so this module
 *  stays free of the caps probe. */
export interface TierDeviceFacts {
  platform?: string;
  deviceModel?: string;
  gpuRenderer?: string;
  formFactor?: 'mobile' | 'desktop';
}

/** The cached boot-probe verdict for THIS device, or `undefined` when there is none that applies.
 *
 *  Checked against {@link probeFingerprint} so a verdict measured on different hardware — or under
 *  a different `CLASSIFIER_VERSION` — is never reused. Synchronous: the probe ran at renderer
 *  bring-up, so by the time any later caller asks, the answer is in `PlayerPrefs`.
 *
 *  ⚠️ `cpuLimited` is RECOMPUTED from the stored samples rather than stored beside the band,
 *  through the same `classifyMedianOf` the live path uses. Two reasons, and the second is the one
 *  that matters: a stored derived field would have to be migrated every time the thresholds move,
 *  and a device that cached a verdict under an old table would then carry a promotion licence
 *  derived from boundaries that no longer exist. Recomputing costs three medians. */
export function readCachedProbeVerdict(
  caps: TierDeviceFacts | null | undefined,
): { deviceClass: DeviceClass; cpuLimited: boolean } | undefined {
  const cached = probeVerdictStore.get()?.read();
  if (!cached) return undefined;
  // Through `globalThis`, not `window` — this module is compiled without the DOM lib on purpose
  // (it is the pure policy half, unit-tested headless), and the viewport is the one fact the
  // fingerprint needs that only the host has. `0` in a headless program matches what
  // `probeFingerprint` already does with an absent viewport.
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const fingerprint = probeFingerprint({
    platform: caps?.platform,
    deviceModel: caps?.deviceModel,
    gpuRenderer: caps?.gpuRenderer,
    viewportPx: (g.innerWidth ?? 0) * (g.innerHeight ?? 0),
  });
  // `CachedProbeVerdict.deviceClass` excludes `'unknown'` by type — an unusable reading is never
  // written (`rampProbe`), so a cache hit is always a real band.
  if (cached.fingerprint !== fingerprint) return undefined;
  // ⚠️ `'3d'`, and it is not an assumption: the fingerprint built above omits the `':2d'` platform
  // suffix that `resolveProbeClass` appends for a 2D probe, so a 2D record can never match here in
  // the first place. A 2D project reaches its verdict through the live path, which knows its own
  // shape. Stated rather than left implicit, because reading the axis wrong is silent — it would
  // judge a shade reading against a fill floor.
  return { deviceClass: cached.deviceClass, cpuLimited: classifyMedianOf(cached.samples, '3d').cpuLimited };
}

/** Build the input for {@link resolveTier} from the device facts — **the ONE builder both the boot
 *  path and a later re-resolution go through.**
 *
 *  ⚠️ **THIS EXISTS BECAUSE THE TWO CALLERS DRIFTED, AND THE DRIFT WAS INVISIBLE** (review
 *  2026-08-12, found independently by six review dimensions). `choosePlayerQualityTier(null)` —
 *  a game's "Auto" button — hand-assembled its own input and omitted `probeClass`, the one field
 *  carrying the boot measurement. `TIER_ALLOWLIST.androidGpuPatterns` is empty, so on Android
 *  nothing else can answer: a Galaxy A23 the probe had measured as `middle` dropped to
 *  `calibrating → low` the moment its player tapped Auto, and (before the frame-cap fix in
 *  `hasHeadroom`) could never climb back. Relaunching cleared it, so it read as a glitch.
 *
 *  Adding the field to the one caller that forgot it would have fixed today's bug and left the
 *  shape that produced it. A single builder means a field added to {@link TierResolveInput} cannot
 *  be supplied by only one caller — that is the property, not the deduplication.
 *
 *  The two knobs exist because boot genuinely needs both behaviours, and BOTH must stay in the one
 *  builder or the drift comes straight back:
 *  - `probeClass` — an explicit override for the moment boot has just measured a FRESHER value than
 *    the cache holds. Every other caller omits it and gets the cached verdict.
 *  - `useProbe: false` — boot's deliberate FIRST pass, which resolves without any probe answer at
 *    all so it can find out whether something cheaper (a player choice, a project pin, an iOS model
 *    id, an allowlisted GPU, desktop) already decides the tier, and only pay for the probe when
 *    nothing did. `'calibrating'` is exactly the state that means "nothing here decided". */
export function buildTierResolveInput(
  caps: TierDeviceFacts | null | undefined,
  projectSetting: QualityTierSetting | undefined,
  opts: {
    playerChoice?: QualityTier | null;
    probeClass?: DeviceClass;
    /** See {@link ProbeVerdict.cpuLimited}. Threaded THROUGH THIS BUILDER rather than read at the
     *  call site for the reason the builder exists at all: the two callers drifted once already,
     *  and a promotion licence that only one of them passed would be a tier that promotes on the
     *  boot path and not after a player picks "Auto" again. */
    probeCpuLimited?: boolean;
    useProbe?: boolean;
  } = {},
): TierResolveInput {
  const useProbe = opts.useProbe ?? true;
  const cached = useProbe && opts.probeClass === undefined ? readCachedProbeVerdict(caps) : null;
  return {
    platform: caps?.platform ?? '',
    deviceModel: caps?.deviceModel,
    gpuRenderer: caps?.gpuRenderer,
    formFactor: caps?.formFactor,
    playerChoice: opts.playerChoice,
    projectSetting,
    probeClass: useProbe ? (opts.probeClass ?? cached?.deviceClass) : undefined,
    probeCpuLimited: useProbe ? (opts.probeCpuLimited ?? cached?.cpuLimited) : undefined,
  };
}

/** What each MEASURED device class means for the tier. Kept as a table rather than a chain of
 *  `if`s so the mapping is one readable line per band, and so a new class cannot be added to
 *  `DeviceClass` without the compiler pointing here. `'unknown'` is absent on purpose — it is the
 *  absence of a measurement, not a band, and `resolveTier` handles it as such. */
const PROBE_CLASS_TIER: Record<Exclude<DeviceClass, 'unknown'>, QualityTier> = {
  weak: 'low',
  middle: 'mid',
  capable: 'high',
};

/** Decide the starting tier. Pure.
 *
 *  Precedence — player > project > allowlist > calibrate. The player wins outright because they
 *  can see the screen and we cannot: they are the escape hatch for anything the allowlist or
 *  the calibration gets wrong on hardware nobody tested. */
export function resolveTier(input: TierResolveInput): TierResolution {
  if (input.playerChoice) {
    return { tier: input.playerChoice, source: 'player', reason: 'player selected this tier' };
  }

  const setting = input.projectSetting ?? DEFAULT_TIER_SETTING;
  if (setting !== 'auto') {
    return { tier: setting, source: 'project', reason: `project pinned qualityTier: '${setting}'` };
  }

  // iOS answers from the model id and never measures — see IOS_TIER_MIN_GENERATION for why
  // that is sound here and is NOT sound on Android. It supersedes `TIER_ALLOWLIST.iosModels`,
  // which was both empty and (per #146) dead in production: it read `@capacitor/device`, a plugin
  // no Modoki project installs, so `deviceModel` was `undefined` on every real phone. That is
  // fixed — the id now comes from the `GameDebug` bridge, which every debuggable build has.
  //
  // ⚠️ NATIVE ONLY. Mobile Safari has no such plugin and reports no model, so iOS WEB — which is
  // how every published demo ships — falls straight through this branch to the measured path.
  if (input.platform === 'ios') {
    const modelTier = iosModelTier(input.deviceModel);
    if (modelTier) {
      const gen = parseAppleModel(input.deviceModel!)!;
      const floors = IOS_TIER_MIN_GENERATION[gen.family];
      // Name the floor the tier was decided AGAINST, not always the high one. Saying "below the
      // high-tier floor of 11" for a device that landed on `mid` would be true and useless — the
      // reason has to answer "why THIS tier", which is the boundary it actually cleared or missed.
      const against = modelTier === 'high'
        ? `at or past the high-tier floor of ${floors.high}`
        : modelTier === 'mid'
          ? `at or past the mid-tier floor of ${floors.mid}, below high's ${floors.high}`
          : `below the mid-tier floor of ${floors.mid}`;
      return {
        tier: modelTier,
        source: 'model',
        reason: `${input.deviceModel} is ${gen.family} generation ${gen.generation}, ${against}`,
      };
    }
  }
  const allowed = input.gpuRenderer
    ? TIER_ALLOWLIST.androidGpuPatterns.find((e) => e.pattern.test(input.gpuRenderer!))
    : undefined;
  if (allowed) {
    return {
      tier: allowed.tier,
      source: 'allowlist',
      reason: `${input.gpuRenderer} is allowlisted for '${allowed.tier}'`,
    };
  }

  // The one carve-out (#155). A desktop is not the hardware this guard exists for: the failure
  // it prevents is a mobile GPU losing its context under a desktop-grade load. Identified by
  // `formFactor` and NEVER by `platform` — a phone browser reports `platform: 'web'` exactly
  // like a desktop does, and the demos publish web-only, so keying on platform would hand the
  // demos' whole mobile-web audience the tier that bricked the Y6.
  if (input.formFactor === 'desktop') {
    return { tier: 'high', source: 'desktop', reason: 'desktop-class host — not the hardware the low default guards' };
  }

  // ⭐ GPU IDENTITY (#210) — the layer that makes a first impression correct on launch #1.
  //
  // Placed AFTER the desktop carve-out and BEFORE the probe, and both halves of that matter:
  //
  //   - After `desktop`, because the vendored table is MOBILE and includes mobile Intel/NVIDIA
  //     parts (`intel hd graphics 5500`, `tegra x1`). A desktop reporting an integrated Intel GPU
  //     would otherwise match a row reading 30 and be DEMOTED to `mid` — an authoring machine
  //     downgraded by a phone table.
  //   - Before `measured`, because this is the whole point: a table hit costs ~0 ms and is right
  //     the first time, where the probe blocks launch 0.5-2.6 s and needs three launches to settle
  //     (so its verdict is wrong on launches 1 and 2 — the ones a first impression is made on).
  //
  // Identity returns `null` rather than guessing on a masked string, an unknown vendor, or a
  // generation it cannot place, which lands exactly where this device already landed: the probe,
  // and failing that `calibrating` -> `low`. So adding this layer can only move a device that had
  // no confident answer, never overrule one that did.
  const identified = gpuIdentityTier(input.gpuRenderer);
  if (identified) {
    return { tier: identified.tier, source: identified.via, reason: identified.reason };
  }

  // The boot ramp probe (#188), if it ran. It sits BELOW the desktop carve-out deliberately —
  // a desktop already has its answer and there is no reason to pay a launch-blocking probe in
  // the editor — and below the iOS model id, which answers statically and for free.
  //
  // Three measured classes, three tiers (#188). `'unknown'` is NOT a fourth: it lands on `low`
  // like `'weak'` does, but it is not the same statement and the reason says which — `weak` is a
  // measurement, `unknown` is the absence of one. Conflating them would make an inert probe
  // indistinguishable from a probe that ran and found weak hardware.
  const measured = input.probeClass && input.probeClass !== 'unknown'
    ? PROBE_CLASS_TIER[input.probeClass]
    : null;
  if (measured) {
    return {
      tier: measured,
      source: 'measured',
      cpuLimited: input.probeCpuLimited,
      reason: `boot ramp probe measured this device as ${input.probeClass}`
        + (input.probeCpuLimited ? ' — cpu-limited, so live calibration may promote one step' : ''),
    };
  }

  // Unknown hardware: start conservative and let measurement promote. Booting high and being
  // wrong is a permanent black screen; booting low and being wrong costs a beat of ugliness.
  return {
    tier: 'low',
    source: 'calibrating',
    reason: 'unrecognised device — starting low, measuring for promotion',
  };
}

// ── Promotion / demotion ───────────────────────────────────────────────────────────────────

/** Sustained headroom required before promotion is armed. Expressed as a RATIO of the budget,
 *  never as a device property, so it cannot ossify against hardware nobody has measured. */
export const PROMOTION_HEADROOM_RATIO = 0.5;
/** Fraction of the frame interval CPU may occupy and still count as headroom while vsync-bound
 *  (see `evaluateTierChange` for why the signal has to switch). */
export const PROMOTION_CPU_RATIO = 0.4;
/** Headroom must hold this long before promoting — one lucky second is not evidence. */
export const PROMOTION_HOLD_MS = 5_000;
/** Over budget this long triggers demotion. Shorter than promotion on purpose: promotion is an
 *  upgrade and can wait, demotion is an emergency. */
export const DEMOTION_HOLD_MS = 2_000;
/** Samples below which a profile is not worth judging. */
export const MIN_SAMPLES_TO_JUDGE = 30;

export interface TierChangeState {
  /** When the current qualifying streak began, or 0 if not currently qualifying. */
  headroomSince: number;
  overBudgetSince: number;
  /** Set once demoted. A demotion is STICKY for the session — without this the tier oscillates
   *  between a tier that is too slow and one that is too pretty, which is worse than either. */
  demoted: boolean;
}

export function freshTierChangeState(): TierChangeState {
  return { headroomSince: 0, overBudgetSince: 0, demoted: false };
}

/** The highest tier live calibration may promote to, given how this device's tier was ARRIVED AT.
 *
 *  ⚠️ **PROMOTION EXISTS TO ESCAPE "NOBODY KNEW", NOT TO OVERRULE A MEASUREMENT (#188).** The rule
 *  it guards is {@link evaluateTierChange}'s `hasHeadroom`, which judges from `cpuMs` alone — and
 *  that proxy is wrong in BOTH directions on the one device class this work exists for. On a
 *  Galaxy A23, `games/3d-test` runs the GPU at 13.9 of every 16.6 ms (84% of the frame) with
 *  `presentIdleMs: 0`, while the CPU sits low enough to read as headroom. A CPU-only rule cannot
 *  see that, and there is no live signal that can on the target hardware: `frameMs` is pinned at
 *  the display interval whenever the renderer finishes early, `restMs` mixes GPU with idle, and
 *  GPU timestamps report `unsupported` on WebGL2 mobile — i.e. on most of the low-end Android
 *  field the tiers exist for.
 *
 *  What CAN see GPU cost there is the boot ramp probe, which measures `shade` (heavy shaded
 *  fragments/ms) and `cpu` on the real hardware and lands seven measured devices in the right band
 *  across two platforms. So once something has assessed this device, that assessment is the
 *  ceiling: a five-second CPU streak does not get to raise a tier that a GPU measurement set.
 *
 *  Per source, and every one of them is the same argument:
 *
 *    `measured`     the boot probe measured cpu + shade on THIS hardware — the best GPU evidence
 *                   obtainable on a WebGL2 phone. Nothing live improves on it.
 *                   ⭐ **ONE EXCEPTION, and it is the only crack in this rule (#205, owner
 *                   2026-08-13): a `cpuLimited` measurement gets ONE step.** That flag means the
 *                   reading missed the next band on the CPU axis ALONE, with the GPU axis already
 *                   clear — so the objection above (a CPU streak cannot see a GPU-bound frame)
 *                   does not arise: there is no GPU verdict to overrule. And the boot cpu number
 *                   is a MEASURED under-estimate, 20-30% below what the same device sustains in
 *                   game across three Androids, because the probe runs while the launch boost is
 *                   decaying and nothing inside the probe closes that (two fixes tried, both
 *                   refuted — see `CPU_WARMUP_RAMPS`). The owner's decision was to accept the
 *                   under-estimate rather than inflate the floors and let calibration promote;
 *                   this is that decision, scoped to the axis it is true of.
 *    `model`        the iOS model-generation table answered statically.
 *    `allowlist`    a known-good GPU string answered.
 *    `desktop`      already `high`; stated uniformly rather than special-cased, so a fourth tier
 *                   could never quietly make desktop promotable.
 *    `project`      a HUMAN decided. Calibration already refuses to run (`tickTierCalibration`
 *                   early-returns unless the setting is `'auto'`), so this is belt-and-braces —
 *                   but an inference overriding an explicit choice is the one thing those controls
 *                   exist to prevent, and the cap says so in the place that would have to be wrong.
 *    `player`       ⚠️ NEVER ARRIVES HERE (#208). A pin is not a statement about the hardware, so
 *                   `setActiveQualityTier` does not latch it as the assessment — it used to, and a
 *                   pin that survived into the next launch then capped promotion at the player's
 *                   old choice for the whole process, even after they chose "Auto" again. The
 *                   clause is kept in this table because the ARGUMENT still holds if one ever
 *                   reaches here; what changed is that one no longer does.
 *    `calibrating`  NOTHING assessed it — the probe produced no usable reading, or never ran. This
 *                   is the only case with room to climb, and it gets exactly ONE step: enough that
 *                   `auto` cannot pin unrecognised hardware to `low` forever (#155's stated cost),
 *                   and not enough to reach `high` on a device nobody has ever measured.
 *
 *  ⚠️ The honest consequence, and it is deliberate: on a device the probe classified as anything
 *  other than `cpuLimited`, live promotion becomes a no-op. That is the probe's job done, not a
 *  mechanism gone missing — and a
 *  project that knows it is cheap enough to outrun its hardware's band pins `qualityTier: 'high'`,
 *  while a player who can see the screen overrides everything via `choosePlayerQualityTier`.
 *  Demotion is UNAFFECTED: it stays live, immediate and sticky, because being wrong downward is
 *  the recoverable direction. */
export function promotionCeiling(assessed: TierResolution | null): QualityTier {
  // No resolution yet. Unreachable through `tickTierCalibration` (it early-returns on a null
  // active tier), so this is the defensive answer rather than a live path — and it is the
  // un-assessed rule applied to the tier an unrecognised device starts at.
  if (!assessed) return tierAbove('low') ?? 'low';
  if (assessed.source === 'calibrating') return tierAbove(assessed.tier) ?? assessed.tier;
  // ⭐ The CPU-LIMITED exception (#205, owner 2026-08-13) — see the table above for why it is the
  // ONLY crack in "a measurement is the ceiling", and `ProbeVerdict.cpuLimited` for why it is
  // sound. In short: the boot cpu reading is a measured under-estimate (20-30% below what the same
  // device sustains in game, on three Androids), the owner's decision was to accept that rather
  // than inflate the floors, and `hasHeadroom` measures the SAME quantity the probe under-read.
  // It applies only where the GPU axis has already cleared the band above, so the "a CPU streak
  // cannot see a GPU-bound frame" objection never comes into play.
  if (assessed.source === 'measured' && assessed.cpuLimited) {
    return tierAbove(assessed.tier) ?? assessed.tier;
  }
  return assessed.tier;
}

/** Is `tier` at or below `ceiling` on the ladder? Through `TIER_ORDER` rather than a comparison
 *  on the strings, for the reason the ladder exists at all: a fourth tier must not need this
 *  function edited. */
function withinCeiling(tier: QualityTier, ceiling: QualityTier): boolean {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(ceiling);
}

export type TierDecision =
  | { action: 'none' }
  /** Sustained headroom, and {@link promotionCeiling} caps it — the device would have been
   *  promoted if its own assessment allowed. Carries the tier it WOULD have moved to.
   *
   *  This is not a no-op dressed up: without it, a device that holds five seconds of CPU headroom
   *  and does not move is indistinguishable from one whose streak never started, and "why is my
   *  A23 not promoting" has no answer short of an eval. The consumer logs it once per session. */
  | { action: 'hold'; tier: QualityTier; reason: string }
  /** Enough sustained headroom. APPLY AT A SCENE BOUNDARY where possible — a tier switch
   *  recompiles shaders, and boot on the Y6 already produced a 6.65 s stall, so a mid-play
   *  promotion can freeze longer than the low tier it escapes. */
  | { action: 'promote'; tier: QualityTier; reason: string }
  /** Over budget. Apply IMMEDIATELY — this is an emergency, not an upgrade. */
  | { action: 'demote'; tier: QualityTier; reason: string };

/** Does this profile show room to spare?
 *
 *  THE SIGNAL HAS TO SWITCH WITH THE REGIME, which is the whole reason `FrameProfile` carries
 *  `vsyncBound`. When the renderer is finishing early, `frameMs` is PINNED at the display
 *  interval and cannot go lower — so it reports "barely making 60" and "trivially making 60"
 *  identically, and judging headroom by it would promote a device that has none. While
 *  vsync-bound the honest question is how much of the frame the CPU is actually eating; only
 *  when frames run long does `frameMs` regain meaning.
 *
 *  ⚠️ **`vsyncBound` COVERS THE ENGINE'S OWN FRAME CAP, and it did not until 2026-08-12.** A loop
 *  pacing to `targetFps` is finishing early and waiting — the same regime as vsync — but the
 *  profiler's interval list held only DISPLAY intervals, so a 30-capped device (which is every
 *  project's `low` since #202 seeded `targetFps: 30`) read `frameMs.median ≈ 33.3 ms`, went
 *  `vsyncBound: false`, and fell to the branch below asking for <= 16.67 ms — **unreachable under
 *  the tier's own cap**. Live promotion out of `low` was therefore impossible fleet-wide, which
 *  silently voided #155's promised escape for a `calibrating` device. The cap is now pushed into
 *  `frameProfiler` from `setTargetFPS`, so a capped-and-comfortable device takes the CPU-ratio
 *  branch — the regime it is genuinely in. Any test for this must derive `vsyncBound` from a real
 *  profile; the hand-set `profileOf(10, 4)` fixtures describe a frame the `low` tier cannot
 *  produce and stayed green throughout the defect. */
function hasHeadroom(p: FrameProfile): boolean {
  if (p.samples < MIN_SAMPLES_TO_JUDGE) return false;
  if (p.vsyncBound) {
    const interval = p.frameMs.median;
    return interval > 0 && p.cpuMs.median <= interval * PROMOTION_CPU_RATIO;
  }
  return p.frameMs.median <= BUDGET_30FPS_MS * PROMOTION_HEADROOM_RATIO;
}

/** Pure tier-change decision. Owns no state and reads no clock — the caller supplies both, so
 *  every branch is reachable in a test without waiting real seconds.
 *
 *  `ceiling` is REQUIRED and has no default, deliberately: an optional one would mean a call site
 *  that forgot it silently got the old unguarded behaviour, which is the failure shape this whole
 *  workstream keeps producing. Callers get it from {@link promotionCeiling}. */
export function evaluateTierChange(
  tier: QualityTier,
  profile: FrameProfile,
  state: TierChangeState,
  now: number,
  ceiling: QualityTier,
): { decision: TierDecision; state: TierChangeState } {
  const next = { ...state };

  // ONE STEP AT A TIME, ALONG `TIER_ORDER`. With three tiers `mid` is the first tier that can move
  // in BOTH directions, so neither branch may be written as "only from high" / "only from low" any
  // more — the ladder is asked where it can go, and a tier at the end of it simply cannot go there.
  const down = tierBelow(tier);
  const up = tierAbove(tier);

  // ── Demotion: from any tier that has one below it, when frames genuinely run long. ──
  if (down) {
    // NOTE: the headroom streak is NOT cleared here. It was, while `high` was the only tier that
    // could demote and no tier could do both — carrying that line over would have quietly made
    // `mid` un-promotable, since every pass would reset the streak it needs to accumulate. The
    // promotion branch below clears it for a tier that cannot promote (`high`), which is the same
    // guarantee expressed where it belongs.
    if (profile.samples >= MIN_SAMPLES_TO_JUDGE && profile.overBudget) {
      if (next.overBudgetSince === 0) next.overBudgetSince = now;
      if (now - next.overBudgetSince >= DEMOTION_HOLD_MS) {
        return {
          decision: {
            action: 'demote',
            tier: down,
            // The budget the profile ACTUALLY judged itself against, never `BUDGET_30FPS_MS` —
            // which stopped being the threshold once `overBudget` started reading the frame cap
            // in force. At the fleet's `targetFps: 60` this is 20 ms, and the old literal made
            // the log read "22.0ms over the 33.3ms budget" (close-out 2026-08-12).
            reason: `median frame ${profile.frameMs.median.toFixed(1)}ms over the `
              + `${profile.budgetMs.toFixed(1)}ms budget for ${DEMOTION_HOLD_MS / 1000}s`,
          },
          state: { ...next, overBudgetSince: 0, demoted: true },
        };
      }
    } else {
      next.overBudgetSince = 0;
    }
  } else {
    next.overBudgetSince = 0;
  }

  // ── Promotion: from any tier that has one above it, and never after a demotion. ──
  //
  // ⚠️ DEMOTION IS EVALUATED FIRST AND IT MATTERS, because on a MIDDLE tier both streaks run at
  // once and the two conditions are not mutually exclusive. On a 30 Hz display a frame can be
  // vsync-pinned at 33.4 ms — over the 33.3 ms budget, so `overBudget` — while the CPU sits at
  // 10 ms of that interval, so `hasHeadroom` is also true. Letting demotion own the earlier
  // deadline (2 s against 5 s) resolves that in the safe direction every time: the device gets
  // relief rather than an upgrade, and the sticky `demoted` flag then stops the pair from
  // arguing for the rest of the session.
  if (!up || next.demoted) {
    next.headroomSince = 0;
    return { decision: { action: 'none' }, state: next };
  }

  if (hasHeadroom(profile)) {
    if (next.headroomSince === 0) next.headroomSince = now;
    if (now - next.headroomSince >= PROMOTION_HOLD_MS) {
      const detail = profile.vsyncBound
        ? `cpu ${profile.cpuMs.median.toFixed(1)}ms of a ${profile.frameMs.median.toFixed(1)}ms frame`
        : `median frame ${profile.frameMs.median.toFixed(1)}ms`;
      // ⚠️ THE CEILING IS CHECKED HERE, at the moment of promotion, and NOT at the top beside
      // `!up`. Both would suppress the promotion; only this one can say the device HELD the
      // headroom and was capped anyway, which is the entire difference between a diagnosable
      // decision and silence. `headroomSince` resets either way, so a capped device re-reports
      // every PROMOTION_HOLD_MS rather than once and never again — the consumer dedupes.
      if (!withinCeiling(up, ceiling)) {
        return {
          decision: {
            action: 'hold',
            tier: up,
            reason: `${detail} sustained for ${PROMOTION_HOLD_MS / 1000}s, but '${ceiling}' is the `
              + 'tier this device was assessed at — a CPU-only streak does not overrule it',
          },
          state: { ...next, headroomSince: 0 },
        };
      }
      return {
        decision: {
          action: 'promote',
          tier: up,
          reason: `${detail} sustained for ${PROMOTION_HOLD_MS / 1000}s`,
        },
        state: { ...next, headroomSince: 0 },
      };
    }
  } else {
    next.headroomSince = 0;
  }
  return { decision: { action: 'none' }, state: next };
}

/** Clamp an authored shadow-map size to the RESOLVED overrides' ceiling. `Light.shadowMapSize` is
 *  a per-light trait field with no global cap, so without this a tier cannot enforce "shadows, but
 *  smaller". */
/** May IBL light the scene, under the RESOLVED overrides? Takes `o: TierRenderOverrides` (never a
 *  `QualityTier`), mirroring {@link tierAllowsEffect} — see `getActiveTierOverrides`
 *  (renderSettings.ts), the one resolution point every caller reads. */
export function tierAllowsIBL(o: TierRenderOverrides): boolean {
  return o.ibl;
}

/** Ambient intensity multiplier that compensates for IBL being off (1 when IBL is on, so the
 *  authored value passes through untouched). */
export function tierAmbientBoost(o: TierRenderOverrides): number {
  return o.ibl ? 1 : o.iblOffAmbientBoost;
}

/** Exposure multiplier that compensates for IBL being off (1 when IBL is on). */
export function tierExposureBoost(o: TierRenderOverrides): number {
  return o.ibl ? 1 : o.iblOffExposure;
}

export function tierShadowMapSize(authored: number, o: TierRenderOverrides): number {
  const ceiling = o.shadowMapCeiling;
  if (!ceiling) return authored;
  return Math.min(authored, ceiling);
}

/** Bias multiplier for a shadow map that a tier clamped smaller than authored. See
 *  docs/plans/low-end-device-support.md §0b "Shadows on `low` would render ACNE":
 *  `tierShadowMapSize` shrinks `Light.shadowMapSize` to fit a tier's ceiling but leaves
 *  `shadowBias`/`shadowNormalBias` untouched, and bias is TEXEL-FOOTPRINT-relative (a fixed
 *  bias is calibrated against `(2 * cameraSize) / mapSize`, the world-space size of one
 *  shadow-map texel). Shrinking the map without scaling the bias grows that footprint —
 *  forest-camp's 2048→512 clamp grows it 15.6mm to 62.5mm — so the same bias under-covers the
 *  new, coarser texels and the surface self-shadows.
 *
 *  ⚠️ MEASURED ON A HUAWEI Y6: scaling the bias alone does NOT make a 512 map usable. At 2048
 *  the scene renders clean, correct, soft shadows. At 512 with the AUTHORED bias it renders
 *  real but catastrophically under-sampled — a dithered/speckled mess (this light also runs
 *  `shadowRadius` 4 soft filtering) with self-shadowing mixed in. Applying this ×4 scale
 *  improved that only marginally — a darkened test region went from -33.0% to -27.5% against a
 *  -34.9% reference — and it still looks dithered: bias was never the dominant term, MAP
 *  RESOLUTION is. (An earlier version of this fix also shrank `shadowCameraSize` to recover
 *  density; that removed the artifact by removing the shadow — distant casters simply fell
 *  outside the shrunk box — which is a coverage trade we won't ship silently. See §0b.)
 *  So treat this as a CORRECTNESS fix (the bias that ships is texel-correct for whatever map
 *  size actually renders), not a quality fix — a genuinely usable `mid` tier needs a shadow
 *  map size floor, not a bias multiplier. */
export function shadowBiasScale(authoredMapSize: number, actualMapSize: number): number {
  if (authoredMapSize <= 0 || actualMapSize <= 0) return 1;
  // No clamp (the common case, and always true on `high`) — exactly 1 so `high` is provably a
  // no-op.
  if (actualMapSize >= authoredMapSize) return 1;
  return authoredMapSize / actualMapSize;
}
