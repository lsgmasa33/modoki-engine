/** renderSettings — project-configured renderer knobs injected at boot.
 *
 *  The app pushes `projectConfig.rendering` in here via {@link setRenderSettings}
 *  (mirrors the `setPhysicsLayers` / `setTargetFPS` pattern in app/ecs/register.ts).
 *  The engine renderers then READ these instead of hardcoding values:
 *   - `makeWebGPURenderer` (scene3DSync)  → backend, antialias, pixelRatioCap,
 *     shadows, toneMapping, exposure
 *   - `canvas2DPool`                       → pixi backend, antialias, resolution
 *   - `canvas2DSizing.computeBackingSize`  → pixi.pixelRatioCap, the AUTO-path
 *     counterpart of `three.pixelRatioCap` (issue #55) — applied to every 2D
 *     surface, editor viewports included, NOT opt-in like the `max` sizeMode
 *     clamp below. Defaults to 2 to match `three.pixelRatioCap`'s default so
 *     the two render layers agree on DPR out of the box.
 *   - web canvas sizing                    → web.{sizeMode,width,height}, read by
 *     App.tsx (the letterbox container, every mode), the 3D `max` buffer clamp
 *     (makeWebGPURenderer for the first buffer + Scene3D's ResizeObserver for every
 *     later one) and Canvas2DMount (the 2D `max` buffer clamp). Both renderer-side
 *     clamps are opt-in via `applyWebSizeMode` so the editor viewports are excluded.
 *
 *  The defaults here MUST equal the pre-wiring hardcoded behavior so that when
 *  no project injects settings (tests, standalone imports) nothing regresses:
 *  ACESFilmic @ 1.2 exposure, antialias on, DPR capped at 2, shadows on, auto
 *  backend, free canvas sizing. */

import * as THREE from 'three';
import {
  DEFAULT_TIER_SETTING, applyTierToThree, applyTierToPixi, applyTierToTargetFps,
  resolveTierOverrides, TIER_DEFAULT_FIELDS,
  type QualityTier, type QualityTierSetting, type TierResolution,
  type TierRenderOverrides, type AuthoredTiers, type TierDefaultOverrides,
} from './qualityTier';
import { publishQualityTierChange } from './tierChangeNotify';

export interface ThreeRenderSettings {
  backend: 'auto' | 'webgpu' | 'webgl';
  antialias: boolean;
  pixelRatioCap: number;
  shadows: boolean;
  /** Quality tier (#121 P3). `'auto'` delegates to the allowlist + on-device calibration;
   *  `'low'`/`'high'` pin it. Defaults to `DEFAULT_TIER_SETTING`, which is **`'auto'` since
   *  #155** — so an unpinned project resolves LOW on anything not allowlisted (desktops
   *  excepted, by `formFactor`). This used to read "`'high'` — today's behaviour, so wiring the
   *  tier up changes nothing until a project opts in", and both halves are now false: the
   *  default IS the behaviour change. See `qualityTier.ts`. */
  qualityTier: QualityTierSetting;
  /** 'ACESFilmic' | 'AgX' | 'Neutral' | 'Linear' | 'None' */
  toneMapping: string;
  exposure: number;
  // ── The project's authored DEFAULT-tier fields (#403) ──────────────────────────────────────
  // Fed to `resolveTierOverrides` as `TierDefaultOverrides`, which is what makes them the base a
  // `mid`/`low` config completes against. Each defaults to the engine identity, so a project that
  // authors none of them resolves exactly as it did before these existed. See that type's doc for
  // why they were tier-only until now.
  /** May IBL light the scene at the default tier? Identity: `true`. */
  ibl: boolean;
  /** Ambient multiplier applied while `ibl` is false. Identity: `1`. */
  iblOffAmbientBoost: number;
  /** Exposure multiplier applied while `ibl` is false. Identity: `1`. */
  iblOffExposure: number;
  /** Ceiling on `Light.shadowMapSize` at the default tier. Identity: `0` (no ceiling). */
  shadowMapCeiling: number;
  /** Most directional lights an object may be lit by. Identity: `0` (unlimited). */
  maxDirectional: number;
  /** Most point/spot lights an object may be lit by. Identity: `0` (unlimited). */
  maxLocal: number;
  /** Light-selection hysteresis margin. Identity: `0` (off). */
  hysteresisMargin: number;
  /** Most lights that may render a shadow map per frame. Identity: `0` (unlimited). */
  maxShadowCasters: number;
  /** A project's authored `mid`/`low` degradation configs (docs/rendering.md § "Quality tiers")
   *  — ABSENT, not an empty object, when the project has authored neither. Presence is the
   *  signal `configCount` (and, from A2, the boot-probe gate) reads. Fed straight through from
   *  `project-config.ts`'s `rendering.three.tiers` by `setRenderSettings`. */
  tiers?: AuthoredTiers;
}

export interface PixiRenderSettings {
  backend: 'auto' | 'webgpu' | 'webgl';
  antialias: boolean;
  /** Backing-buffer resolution multiplier; 0 = auto (devicePixelRatio), a positive value
   *  PINS it. Applied by `canvas2DSizing.computeBackingSize`, not handed to Pixi (Pixi's
   *  own renderer stays at its default resolution of 1 — see canvas2DPool.ts). */
  resolution: number;
  /** Upper bound on devicePixelRatio for the AUTO path only (mirrors `three.pixelRatioCap`,
   *  issue #55). A pinned `resolution` (above) is never capped — capping an explicit pin
   *  would make the pin a lie. Applied by `canvas2DSizing.computeBackingSize`. */
  pixelRatioCap: number;
}

export interface WebRenderSettings {
  sizeMode: 'free' | 'fixed' | 'max';
  width: number;
  height: number;
}

export interface RenderSettings {
  /** `rendering.targetFps` — the rAF loop's frame cap. 0 = uncapped (display refresh).
   *
   *  ⚠️ **IT LIVES HERE SO A TIER CAN CLAMP IT (#202).** It used to reach the engine only through
   *  `setTargetFPS(projectConfig.rendering.targetFps)` at boot — one call, never re-read, so the
   *  frame cap was the one renderer knob no tier could touch. Holding the AUTHORED value in the
   *  settings registry is what lets {@link getEffectiveTargetFps} answer "what should the cap be
   *  *now*" every time the tier moves, instead of the tier having to remember what the project
   *  originally asked for. The frame driver's own `targetFPS` remains the live value. */
  targetFps: number;
  /** Player-facing copy shown over the overlay while a live tier promotion is applied (#227).
   *  Authored per project (`rendering.tierSwitchMessage`) because it needs the game's voice and
   *  its language; `''` means the project did not author one and
   *  {@link getTierSwitchMessage} answers with the engine default.
   *
   *  ⚠️ It lives at the ROOT, not under `three`. A 2D-only project promotes too — `tierBoot.ts`
   *  drives the same calibration loop with no `Scene3D` — so hanging it off the Three block
   *  would put the copy out of reach of exactly the projects whose tier changes are cheapest to
   *  apply. */
  tierSwitchMessage: string;
  three: ThreeRenderSettings;
  pixi: PixiRenderSettings;
  web: WebRenderSettings;
}

/** Defaults = the exact hardcoded behavior that existed before wiring. ONE literal:
 *  the initial value and `resetRenderSettings` used to carry separate copies, which
 *  is a drift waiting to happen (a default changed in one place would silently apply
 *  everywhere EXCEPT tests, or vice versa). Frozen + cloned on use so a caller
 *  mutating the live settings object can't corrupt the baseline. */
const DEFAULTS: Readonly<RenderSettings> = Object.freeze({
  // Matches `project-config.ts`'s own default AND the frame driver's historical `targetFPS = 60`,
  // so an unset project and a standalone import agree.
  targetFps: 60,
  // Empty, not the default copy itself — see `getTierSwitchMessage`. Holding the AUTHORED value
  // (absent included) is what lets the fallback stay in one place instead of being baked in here
  // and re-checked at every reader.
  tierSwitchMessage: '',
  three: {
    backend: 'auto',
    antialias: true,
    pixelRatioCap: 2,
    shadows: true,
    // The six #403 default-tier fields, each at the engine IDENTITY — the same value
    // `UNCLAMPED_OVERRIDES` carries, which is what makes them a no-op until a project authors one.
    ibl: true,
    iblOffAmbientBoost: 1,
    iblOffExposure: 1,
    shadowMapCeiling: 0,
    maxDirectional: 0,
    maxLocal: 0,
    hysteresisMargin: 0,
    maxShadowCasters: 0,
    qualityTier: DEFAULT_TIER_SETTING,
    toneMapping: 'ACESFilmic',
    exposure: 1.2,
  },
  pixi: { backend: 'auto', antialias: true, resolution: 0, pixelRatioCap: 2 },
  web: { sizeMode: 'free', width: 1280, height: 720 },
} as RenderSettings);

const cloneDefaults = (): RenderSettings => ({
  targetFps: DEFAULTS.targetFps,
  tierSwitchMessage: DEFAULTS.tierSwitchMessage,
  three: { ...DEFAULTS.three },
  pixi: { ...DEFAULTS.pixi },
  web: { ...DEFAULTS.web },
});

let settings: RenderSettings = cloneDefaults();

/** A patch: any sub-block may be partial, matching what the merge below actually does.
 *
 *  `Partial<RenderSettings>` would only make the three BLOCKS optional, not their fields — so
 *  `{three:{qualityTier:'low'}}` failed to typecheck even though the merge handles it, and every
 *  such caller had to cast. The type now says what the function does. */
export type PartialRenderSettings = {
  [K in keyof RenderSettings]?: Partial<RenderSettings[K]>;
};

/** Inject the project's rendering config. Called once at app boot (register.ts).
 *  Partial input is deep-merged over the current settings so a missing sub-block
 *  keeps its default. */
export function setRenderSettings(next: PartialRenderSettings | undefined): void {
  if (!next) return;
  settings = {
    // A scalar, so `??` rather than a spread — and `??` not `||`, because `0` is a MEANINGFUL
    // value here (uncapped), not an absent one.
    targetFps: next.targetFps ?? settings.targetFps,
    // `??` for the same reason as `targetFps` above: `''` is a MEANINGFUL authored value here
    // ("I did not write copy, use the engine's"), not an absent one.
    tierSwitchMessage: next.tierSwitchMessage ?? settings.tierSwitchMessage,
    three: { ...settings.three, ...next.three },
    pixi: { ...settings.pixi, ...next.pixi },
    web: { ...settings.web, ...next.web },
  };
}

export function getRenderSettings(): RenderSettings {
  return settings;
}

/** Reset to hardcoded defaults — for test isolation. */
export function resetRenderSettings(): void {
  settings = cloneDefaults();
  activeTier = null;
  // Must clear with it, or the previous session's ASSESSMENT survives the reset and caps a
  // promotion in a world that never made it. `activeTier` is cleared here rather than through
  // `setActiveQualityTier(null)`, so the pairing has to be maintained in both places.
  assessedTier = null;
  // And the debug override — see the block below. Without this a test that pins one leaks it
  // into the next, exactly like `activeTier`/`assessedTier` above.
  // Cleared THROUGH the setter so a mounted panel is notified, rather than by assigning the
  // object directly — a reset that silently leaves the panel showing an override nothing holds
  // any more is the same stale-display defect the notification exists for.
  setDebugPixelRatioCapOverride('pixi', null);
  setDebugPixelRatioCapOverride('three', null);
}

// ── Debug pixelRatioCap override (the debug menu's "Backing resolution" row) ──────────────────
// The Device tab's Backing-resolution row writes `settings.{pixi,three}.pixelRatioCap` (the
// AUTHORED value), which `getEffectivePixiSettings`/`getEffectiveThreeSettings` then clamp
// through the active tier just like a project's own config would. On any device below `high`
// that clamp eats the pick right back — tapping "3" on an iPhone 8 (tier `mid`,
// `pixiPixelRatioCap: 1`) writes authored 3, effective 1, canvas unchanged. The row exists to
// A/B backing resolution on real hardware, so it needs a way to go ABOVE the tier's ceiling.
//
// This is a SEPARATE, debug-only channel rather than a bigger authored value, because raising the
// authored cap would raise it for the project too — this must affect only what the debug menu is
// currently probing, and must never survive a reload (no PlayerPrefs, no project.config.json)
// like the existing `previewTier`.
//
// ⚠️ `null` MEANS "no override, tier governs" — NOT `0`. `0` is already a meaningful value on this
// API: `computeBackingSize`/`applyTierToPixi`/`applyTierToThree` all treat an authored
// `pixelRatioCap` of `0` as UNCAPPED (devicePixelRatio, no ceiling), and `CAP_OPTIONS` in
// DeviceTab includes an "Off" button whose value literally IS `0`. If `0` also meant "cleared",
// picking "Off" from the debug menu would be indistinguishable from handing control back to the
// tier — two different intents collapsing into the same falsy value. `number | null` keeps them
// apart.
let debugPixelRatioCapOverride: { pixi: number | null; three: number | null } = { pixi: null, three: null };

/** Fired whenever the override changes, so a MOUNTED panel can re-read it.
 *
 *  ⚠️ Not ceremony: the Device tab reads the override at RENDER time and re-renders only when one
 *  of its own buttons was pressed. The setter above is exported from `runtime/index.ts` precisely
 *  so an agent can drive the override from `device_eval` without touching the panel — and that
 *  path bumped nothing, so the open panel went on showing its pre-override marks (wrong button
 *  highlighted, caption absent) until an unrelated resize happened to re-render it. A debug
 *  surface that silently disagrees with the renderer is the false-success class this panel exists
 *  to prevent, so the notification is part of the feature, not polish. */
const overrideListeners = new Set<() => void>();

/** Subscribe to override changes; returns the unsubscribe. */
export function onDebugPixelRatioCapOverrideChange(cb: () => void): () => void {
  overrideListeners.add(cb);
  return () => { overrideListeners.delete(cb); };
}

/** Iterate a COPY — a listener that unsubscribes itself during the callback must not corrupt the
 *  live Set's iteration or skip a sibling (same rule as `resizeBus`). */
function notifyOverrideChanged(): void {
  for (const cb of [...overrideListeners]) cb();
}

/** Set (or clear, with `null`) the debug override for one surface's `pixelRatioCap`. Debug-only,
 *  non-persistent — see the block comment above. */
export function setDebugPixelRatioCapOverride(surface: 'pixi' | 'three', value: number | null): void {
  if (debugPixelRatioCapOverride[surface] === value) return; // no listener work for a no-op set
  debugPixelRatioCapOverride = { ...debugPixelRatioCapOverride, [surface]: value };
  notifyOverrideChanged();
}

/** The current override for one surface, or `null` if the tier is governing it. */
export function getDebugPixelRatioCapOverride(surface: 'pixi' | 'three'): number | null {
  return debugPixelRatioCapOverride[surface];
}

// ── Active quality tier (#121 P3) ──────────────────────────────────────────────────────────
// The RESOLVED tier lives here, beside the settings it modifies, for one reason: every consumer
// must read the tier-adjusted value from the SAME place. `pixelRatioCap` in particular is read
// twice — once by `makeWebGPURenderer` when it allocates the first drawing buffer, and again by
// Scene3D's ResizeObserver on every resize. If one applied the tier and the other read the raw
// setting, the first resize would silently undo the tier. That is exactly the
// code-shadows-the-source-of-truth failure this repo warns about, so there is one accessor and
// both call it.

let activeTier: TierResolution | null = null;
let assessedTier: TierResolution | null = null;

/** Publish the resolved tier. Called once at renderer bring-up, and again by the calibration
 *  loop on a promote/demote (P3b). */
export function setActiveQualityTier(res: TierResolution | null): void {
  const prev = activeTier?.tier ?? null;
  activeTier = res;
  // ⚠️ THE FIRST RESOLUTION OF A SESSION IS KEPT SEPARATELY, and it is not the same fact as the
  // active one. `applyQualityTier` re-publishes here on every live promote/demote with
  // `source: 'measured'`, so from the second call onward the ORIGINAL source — was this device
  // measured by the boot probe, answered from the iOS model table, or never assessed at all? — is
  // gone, and `'measured'` is asserted about devices nothing ever measured. `promotionCeiling`
  // needs precisely that lost fact (#188).
  //
  // ⚠️ A PLAYER CHOICE IS NOT AN ASSESSMENT, AND LATCHING IT AS ONE TRAPPED THE CEILING (#208).
  // A pin persists in `PlayerPrefs`, so the NEXT launch boots straight into
  // `{source:'player'}` — the probe never runs (`resolveActiveTierOnce` early-returns above it) —
  // and that resolution latched here. Switching back to "Auto" then correctly re-resolved and
  // applied `mid`/`measured`, but `assessedTier` still read `low`/`player`, so `promotionCeiling`
  // stayed at the pinned tier for the whole process: the player handed control back and the
  // engine kept their old answer as the ceiling. Observed on the A23.
  //
  // The fix is at the source rather than at the Auto path, because `player` is the one source
  // that is not a statement about the HARDWARE — it is a human preference, and nothing measured
  // this device. So it never latches, `assessedTier` stays whatever really assessed the device
  // (or null: honestly "nothing did"), and the first non-player resolution after the pin clears
  // latches normally. `project` is deliberately NOT excluded — calibration does not run at all
  // unless the setting is `'auto'`, so a project pin can never consult the ceiling.
  if (res === null) assessedTier = null;
  else if (assessedTier === null && res.source !== 'player') assessedTier = res;

  // Tell any game that asked (#241). AFTER the latching above, so a listener reading
  // `getAssessedQualityTier()` sees the same world the rest of the engine does. Only on an
  // actual CHANGE of tier: a re-publish carrying a new `reason` for the tier already active
  // is not something a game degrades itself over, and clearing the tier (`res === null`) is
  // teardown, not a tier a game could act on.
  if (res !== null && res.tier !== prev) publishQualityTierChange(res, prev);
}

/** The resolved tier + WHY, or null before a renderer has brought one up. Surfaced in
 *  `diagnose` so a surprising tier is explainable without an eval. */
export function getActiveQualityTier(): TierResolution | null {
  return activeTier;
}

/** The tier this device was ASSESSED at when the session started, before any live change — the
 *  boot probe's band, the iOS model table's answer, the allowlist's, or `calibrating` for a device
 *  nothing recognised. Feeds {@link promotionCeiling}; see it for why live promotion may not
 *  exceed it. Distinct from {@link getActiveQualityTier}, which is wherever calibration has since
 *  moved the tier to. */
export function getAssessedQualityTier(): TierResolution | null {
  return assessedTier;
}

/** The project's three settings with the active tier applied — what every renderer-side
 *  consumer should read instead of `getRenderSettings().three`.
 *
 *  Falls back to the raw settings when no tier has been resolved yet, so a call before bring-up
 *  behaves exactly as it did before tiers existed.
 *
 *  A non-null debug override (see the block above `debugPixelRatioCapOverride`) SKIPS the tier
 *  clamp entirely for `pixelRatioCap` — every other field still flows through the tier — and wins
 *  even before a tier has resolved, so the debug menu is never at the mercy of bring-up ordering. */
export function getEffectiveThreeSettings(): ThreeRenderSettings {
  const three = settings.three;
  const base = activeTier ? applyTierToThree(three, getActiveTierOverrides()) : three;
  const override = debugPixelRatioCapOverride.three;
  return override === null ? base : { ...base, pixelRatioCap: override };
}

/** The project's pixi settings with the active tier applied — the 2D twin of
 *  {@link getEffectiveThreeSettings}, and what every 2D consumer of a tier-clampable field must
 *  read instead of `getRenderSettings().pixi` (#202).
 *
 *  ⚠️ **THE 2D LAYER WAS ENTIRELY UNTIERED BEFORE THIS.** `qualityTier.ts` held zero references to
 *  `pixi` and the clamp was named `applyTierToThree`, so `pixi.pixelRatioCap` and `pixi.antialias`
 *  passed through untouched at every tier — meaning the whole tier system, boot probe included,
 *  changed nothing for a project that renders no 3D. The measurement behind `low`'s DPR of 1 (a
 *  Huawei Y6 paying ~4x for 2x DPR) is a FILL-RATE fact, not a Three.js fact; it applies to a Pixi
 *  canvas identically.
 *
 *  Falls back to the raw settings when no tier has been resolved yet, exactly as its 3D twin does.
 *
 *  Same debug override as {@link getEffectiveThreeSettings} — see the block above
 *  `debugPixelRatioCapOverride`. Kept symmetric with the 3D accessor on purpose. */
export function getEffectivePixiSettings(): PixiRenderSettings {
  const pixi = settings.pixi;
  const base = activeTier ? applyTierToPixi(pixi, getActiveTierOverrides()) : pixi;
  const override = debugPixelRatioCapOverride.pixi;
  return override === null ? base : { ...base, pixelRatioCap: override };
}

/** The frame cap in force: the project's authored `rendering.targetFps` clamped by the active
 *  tier's. `0` = uncapped, on the authored side, the tier side, and in the answer.
 *
 *  ⚠️ **READ THIS, NEVER `getRenderSettings().targetFps`, when you are about to call
 *  `setTargetFPS`.** The authored value is what the project asked for on capable hardware; this is
 *  what the device should actually run at. The two are the same until a tier resolves, which is
 *  exactly why reading the wrong one looks correct in the editor and on a desktop. */
export function getEffectiveTargetFps(): number {
  const authored = settings.targetFps;
  return activeTier ? applyTierToTargetFps(authored, getActiveTierOverrides()) : authored;
}

/** The engine's own copy for the tier-switch overlay, used when a project authored none.
 *
 *  Deliberately vague about DIRECTION ("adjusting", not "improving"): the same overlay would be
 *  reused if a demotion ever needed covering, and copy that promises an upgrade would then be a
 *  lie at the worst possible moment. Deliberately not a brand voice either — a project that wants
 *  one authors `rendering.tierSwitchMessage`. */
export const DEFAULT_TIER_SWITCH_MESSAGE = 'Adjusting graphics quality…';

/** Copy to show over the tier-switch overlay: the project's if it authored one, else the engine's.
 *
 *  ⚠️ **READ THIS, NEVER `getRenderSettings().tierSwitchMessage`.** The authored field is `''` on
 *  every project that did not write copy — which is nearly all of them — so a caller reading it
 *  directly renders an EMPTY overlay: a spinner over a blank label, on the one surface whose whole
 *  job is to explain an unexpected pause. The fallback belongs in one place, and this is it. */
export function getTierSwitchMessage(): string {
  return settings.tierSwitchMessage.trim() || DEFAULT_TIER_SWITCH_MESSAGE;
}

/** The tier a caller should assume when none has been resolved. Keeps "no tier yet" from
 *  meaning "no ceiling" at the `Light.shadowMapSize` call site. */
export function getActiveTierOrDefault(): QualityTier {
  return activeTier?.tier ?? 'high';
}

/** THE ONE RESOLUTION POINT (docs/rendering.md § "Quality tiers"). Every render-loop
 *  consumer that used to read `TIER_SETTINGS[tier]` — `tierAllowsIBL`, `tierAmbientBoost`,
 *  `tierExposureBoost`, `tierShadowMapSize`, `tierAllowsEffect`, `applyTierToThree`, the light-cap
 *  arming — reads THIS instead, so what a project authored (or didn't) is what decides, never a
 *  code table looked up by tier name. A new field can only be half-wired if some consumer reads
 *  around this accessor rather than through it — that is the failure this exists to make
 *  impossible ("prefer binding the whole thing over enumerating fields"). */
export function getActiveTierOverrides(): TierRenderOverrides {
  return resolveTierOverridesFor(getActiveTierOrDefault());
}

/** {@link getActiveTierOverrides} for a tier that is NOT the active one — what the settings *would*
 *  be if the device moved there. Calibration asks this about the tier above before promoting.
 *
 *  It exists so that question also goes through the one resolution point: calling
 *  `resolveTierOverrides(up, settings.three.tiers)` directly would skip the project's authored
 *  DEFAULT-tier fields (#403), and the resulting overrides would be a config no tier actually
 *  resolves to — the exact "reads around this accessor" failure {@link getActiveTierOverrides}'s
 *  doc calls out. */
export function resolveTierOverridesFor(tier: QualityTier): TierRenderOverrides {
  const s = getRenderSettings();
  return resolveTierOverrides(tier, s.three.tiers, projectTierDefaults(s));
}

/** Memo for {@link projectTierDefaults}, keyed on the `three` block the defaults were read from.
 *  `setRenderSettings` REPLACES `settings.three` rather than mutating it, so the key changes
 *  exactly when the values do.
 *
 *  ⚠️ That holds only because **every field this memo reads lives on `three`** — which is now true
 *  by construction (`TIER_DEFAULT_FIELDS`), not by coincidence. An earlier draft also lifted
 *  `textureMaxSize` from the settings ROOT while keying on `three`; it was correct only via the
 *  unrelated fact that `setRenderSettings` rebuilds `three` unconditionally, so an obvious future
 *  optimisation (skip the spread when `next.three` is undefined) would have frozen that value at
 *  its first-seen reading with no test failing. If a default-tier field is ever added OUTSIDE
 *  `three`, this key must widen with it. */
const tierDefaultsBySettings = new WeakMap<object, TierDefaultOverrides>();

/** The project's authored DEFAULT-tier fields (#403), as the patch `resolveTierOverrides` takes.
 *
 *  ⚠️ **MEMOIZED, AND THAT IS LOAD-BEARING, NOT AN OPTIMISATION.** `resolveTierOverrides` keys its
 *  own base memo on THIS OBJECT'S IDENTITY, so returning a fresh literal per call would miss that
 *  cache every frame and re-merge the whole override set — in the render loop, on the weak hardware
 *  the tier system exists for. One object per config load, reused for the life of that config.
 *
 *  ⚠️ `textureMaxSize` is deliberately ABSENT — it is the one tier field a project may not author
 *  as a default, because the BUILD emits a downscaled variant only for a cap a `mid`/`low` tier
 *  names. See the `textureMaxSize` row in `editor/panels/qualityTiersModel.ts` for the full
 *  reasoning; authoring it here would store a number that changes nothing. */
function projectTierDefaults(s: RenderSettings): TierDefaultOverrides {
  let defaults = tierDefaultsBySettings.get(s.three);
  if (!defaults) {
    // Built from `TIER_DEFAULT_FIELDS`, never a written-out literal — see that constant for why.
    // Every field it names lives on `three`, which is what lets the memo key be `s.three` alone.
    defaults = Object.fromEntries(
      TIER_DEFAULT_FIELDS.map((k) => [k, s.three[k]]),
    ) as TierDefaultOverrides;
    tierDefaultsBySettings.set(s.three, defaults);
  }
  return defaults;
}

/** Map a tone-mapping name to the THREE constant. Unknown → ACESFilmic. */
export function resolveToneMapping(name: string): THREE.ToneMapping {
  switch (name) {
    case 'None': return THREE.NoToneMapping;
    case 'Linear': return THREE.LinearToneMapping;
    case 'AgX': return THREE.AgXToneMapping;
    case 'Neutral': return THREE.NeutralToneMapping;
    case 'ACESFilmic':
    default: return THREE.ACESFilmicToneMapping;
  }
}
