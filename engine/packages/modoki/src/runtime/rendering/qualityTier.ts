/** Quality tiers (#121 P3) — TWO tiers, `low` and `high`.
 *
 *  Two, not three, because three demanded evidence for two boundaries and we had it for zero.
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
 *  starting low is the recoverable mistake. Calibration promotes anything with the headroom. */

import { BUDGET_30FPS_MS, type FrameProfile } from '../core/frameProfiler';

export type QualityTier = 'low' | 'high';
/** What a PROJECT may ask for. `'auto'` delegates to the allowlist + calibration. */
export type QualityTierSetting = 'auto' | QualityTier;

/** See "`auto` IS THE DEFAULT". A project may still pin `'low'`/`'high'` to opt out. */
export const DEFAULT_TIER_SETTING: QualityTierSetting = 'auto';

/** How a tier was arrived at — reported so a surprising tier is explainable without an eval. */
export type TierSource = 'player' | 'project' | 'allowlist' | 'desktop' | 'calibrating' | 'measured';

export interface TierResolution {
  tier: QualityTier;
  source: TierSource;
  /** One human-readable clause. Shown in `diagnose` and the debug menu. */
  reason: string;
}

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
  postFX: boolean;
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
    pixelRatioCap: 1, antialias: false, shadows: false, shadowMapCeiling: 512, postFX: false,
    maxDirectional: 1, maxLocal: 1,
    ibl: false, iblOffAmbientBoost: 4, iblOffExposure: 1.25,
  },
  high: {
    pixelRatioCap: 2, antialias: true, shadows: true, shadowMapCeiling: 0, postFX: true,
    maxDirectional: 0, maxLocal: 0,
    ibl: true, iblOffAmbientBoost: 1, iblOffExposure: 1,
  },
};

/** May the post-process stack run on this tier? A named accessor rather than a raw
 *  `TIER_SETTINGS[t].postFX` at the call site, so the render loop reads as intent. */
export function tierAllowsPostFX(tier: QualityTier): boolean {
  return TIER_SETTINGS[tier].postFX;
}

/** The subset of `ThreeRenderSettings` a tier touches. Declared STRUCTURALLY rather than
 *  imported so this module keeps its one-way dependency (`renderSettings` imports here, never the
 *  reverse) and stays pure + trivially testable. */
export interface TierClampableThree {
  pixelRatioCap: number;
  antialias: boolean;
  shadows: boolean;
}

/** Apply a tier to the project's authored three settings.
 *
 *  A TIER CLAMPS, IT DOES NOT REPLACE. `high` must be exactly today's behaviour, so a project
 *  that deliberately authored `pixelRatioCap: 1` or `shadows: false` keeps it — being on the high
 *  tier is not a reason to start doing MORE work than the project asked for. Only `low` can take
 *  things away. (`high` clamps against the same values as the engine defaults, so it changes
 *  nothing — which is what keeps the desktop carve-out and any allowlisted device on exactly
 *  today's behaviour. Before #155 that was true of every device, because the default was `high`.)
 *
 *  Returns a NEW object; the caller's settings are never mutated. */
export function applyTierToThree<T extends TierClampableThree>(three: T, tier: QualityTier): T {
  const t = TIER_SETTINGS[tier];
  return {
    ...three,
    pixelRatioCap: Math.min(three.pixelRatioCap, t.pixelRatioCap),
    antialias: three.antialias && t.antialias,
    shadows: three.shadows && t.shadows,
  };
}

/** Devices known to be fine at `high`, so they skip calibration.
 *
 *  Keyed per platform because the two hide opposite things (see `deviceCaps`): iOS by hardware
 *  MODEL (`iPhone10,1` — the GPU string is masked), Android by GPU RENDERER string
 *  (`Adreno (TM) 610` — the model is ambiguous, one name can ship two GPUs).
 *
 *  EMPTY ON PURPOSE — see the module header. Add an entry only after MEASURING that device. */
export const TIER_ALLOWLIST: {
  iosModels: readonly string[];
  androidGpuPatterns: readonly RegExp[];
} = {
  iosModels: [],
  androidGpuPatterns: [],
};

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
}

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

  if (input.platform === 'ios' && input.deviceModel
      && TIER_ALLOWLIST.iosModels.includes(input.deviceModel)) {
    return { tier: 'high', source: 'allowlist', reason: `${input.deviceModel} is allowlisted` };
  }
  if (input.gpuRenderer
      && TIER_ALLOWLIST.androidGpuPatterns.some((re) => re.test(input.gpuRenderer!))) {
    return { tier: 'high', source: 'allowlist', reason: `${input.gpuRenderer} is allowlisted` };
  }

  // The one carve-out (#155). A desktop is not the hardware this guard exists for: the failure
  // it prevents is a mobile GPU losing its context under a desktop-grade load. Identified by
  // `formFactor` and NEVER by `platform` — a phone browser reports `platform: 'web'` exactly
  // like a desktop does, and the demos publish web-only, so keying on platform would hand the
  // demos' whole mobile-web audience the tier that bricked the Y6.
  if (input.formFactor === 'desktop') {
    return { tier: 'high', source: 'desktop', reason: 'desktop-class host — not the hardware the low default guards' };
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

export type TierDecision =
  | { action: 'none' }
  /** Enough sustained headroom. APPLY AT A SCENE BOUNDARY where possible — a tier switch
   *  recompiles shaders, and boot on the Y6 already produced a 6.65 s stall, so a mid-play
   *  promotion can freeze longer than the low tier it escapes. */
  | { action: 'promote'; reason: string }
  /** Over budget. Apply IMMEDIATELY — this is an emergency, not an upgrade. */
  | { action: 'demote'; reason: string };

/** Does this profile show room to spare?
 *
 *  THE SIGNAL HAS TO SWITCH WITH THE REGIME, which is the whole reason `FrameProfile` carries
 *  `vsyncBound`. When the renderer is finishing early, `frameMs` is PINNED at the display
 *  interval and cannot go lower — so it reports "barely making 60" and "trivially making 60"
 *  identically, and judging headroom by it would promote a device that has none. While
 *  vsync-bound the honest question is how much of the frame the CPU is actually eating; only
 *  when frames run long does `frameMs` regain meaning. */
function hasHeadroom(p: FrameProfile): boolean {
  if (p.samples < MIN_SAMPLES_TO_JUDGE) return false;
  if (p.vsyncBound) {
    const interval = p.frameMs.median;
    return interval > 0 && p.cpuMs.median <= interval * PROMOTION_CPU_RATIO;
  }
  return p.frameMs.median <= BUDGET_30FPS_MS * PROMOTION_HEADROOM_RATIO;
}

/** Pure tier-change decision. Owns no state and reads no clock — the caller supplies both, so
 *  every branch is reachable in a test without waiting real seconds. */
export function evaluateTierChange(
  tier: QualityTier,
  profile: FrameProfile,
  state: TierChangeState,
  now: number,
): { decision: TierDecision; state: TierChangeState } {
  const next = { ...state };

  // ── Demotion: only from `high`, and only when frames genuinely run long. ──
  if (tier === 'high') {
    next.headroomSince = 0;
    if (profile.samples >= MIN_SAMPLES_TO_JUDGE && profile.overBudget) {
      if (next.overBudgetSince === 0) next.overBudgetSince = now;
      if (now - next.overBudgetSince >= DEMOTION_HOLD_MS) {
        return {
          decision: {
            action: 'demote',
            reason: `median frame ${profile.frameMs.median.toFixed(1)}ms over the `
              + `${BUDGET_30FPS_MS.toFixed(1)}ms budget for ${DEMOTION_HOLD_MS / 1000}s`,
          },
          state: { ...next, overBudgetSince: 0, demoted: true },
        };
      }
    } else {
      next.overBudgetSince = 0;
    }
    return { decision: { action: 'none' }, state: next };
  }

  // ── Promotion: only from `low`, and never after a demotion. ──
  next.overBudgetSince = 0;
  if (next.demoted) return { decision: { action: 'none' }, state: next };

  if (hasHeadroom(profile)) {
    if (next.headroomSince === 0) next.headroomSince = now;
    if (now - next.headroomSince >= PROMOTION_HOLD_MS) {
      const detail = profile.vsyncBound
        ? `cpu ${profile.cpuMs.median.toFixed(1)}ms of a ${profile.frameMs.median.toFixed(1)}ms frame`
        : `median frame ${profile.frameMs.median.toFixed(1)}ms`;
      return {
        decision: { action: 'promote', reason: `${detail} sustained for ${PROMOTION_HOLD_MS / 1000}s` },
        state: { ...next, headroomSince: 0 },
      };
    }
  } else {
    next.headroomSince = 0;
  }
  return { decision: { action: 'none' }, state: next };
}

/** Clamp an authored shadow-map size to the tier's ceiling. `Light.shadowMapSize` is a per-light
 *  trait field with no global cap, so without this a tier cannot enforce "shadows, but smaller". */
/** May IBL light the scene on this tier? A named accessor rather than a raw
 *  `TIER_SETTINGS[t].ibl` at the call site, mirroring {@link tierAllowsPostFX}. */
export function tierAllowsIBL(tier: QualityTier): boolean {
  return TIER_SETTINGS[tier].ibl;
}

/** Ambient intensity multiplier that compensates for IBL being off on this tier (1 when IBL is on,
 *  so the authored value passes through untouched). */
export function tierAmbientBoost(tier: QualityTier): number {
  return TIER_SETTINGS[tier].ibl ? 1 : TIER_SETTINGS[tier].iblOffAmbientBoost;
}

/** Exposure multiplier that compensates for IBL being off on this tier (1 when IBL is on). */
export function tierExposureBoost(tier: QualityTier): number {
  return TIER_SETTINGS[tier].ibl ? 1 : TIER_SETTINGS[tier].iblOffExposure;
}

export function tierShadowMapSize(authored: number, tier: QualityTier): number {
  const ceiling = TIER_SETTINGS[tier].shadowMapCeiling;
  if (!ceiling) return authored;
  return Math.min(authored, ceiling);
}
