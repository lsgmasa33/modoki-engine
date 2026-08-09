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
  DEFAULT_TIER_SETTING, applyTierToThree,
  type QualityTier, type QualityTierSetting, type TierResolution,
} from './qualityTier';

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
  three: {
    backend: 'auto',
    antialias: true,
    pixelRatioCap: 2,
    shadows: true,
    qualityTier: DEFAULT_TIER_SETTING,
    toneMapping: 'ACESFilmic',
    exposure: 1.2,
  },
  pixi: { backend: 'auto', antialias: true, resolution: 0, pixelRatioCap: 2 },
  web: { sizeMode: 'free', width: 1280, height: 720 },
} as RenderSettings);

const cloneDefaults = (): RenderSettings => ({
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

/** Publish the resolved tier. Called once at renderer bring-up, and again by the calibration
 *  loop on a promote/demote (P3b). */
export function setActiveQualityTier(res: TierResolution | null): void {
  activeTier = res;
}

/** The resolved tier + WHY, or null before a renderer has brought one up. Surfaced in
 *  `diagnose` so a surprising tier is explainable without an eval. */
export function getActiveQualityTier(): TierResolution | null {
  return activeTier;
}

/** The project's three settings with the active tier applied — what every renderer-side
 *  consumer should read instead of `getRenderSettings().three`.
 *
 *  Falls back to the raw settings when no tier has been resolved yet, so a call before bring-up
 *  behaves exactly as it did before tiers existed. */
export function getEffectiveThreeSettings(): ThreeRenderSettings {
  const three = settings.three;
  return activeTier ? applyTierToThree(three, activeTier.tier) : three;
}

/** The tier a caller should assume when none has been resolved. Keeps "no tier yet" from
 *  meaning "no ceiling" at the `Light.shadowMapSize` call site. */
export function getActiveTierOrDefault(): QualityTier {
  return activeTier?.tier ?? 'high';
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
