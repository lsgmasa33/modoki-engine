/**
 * Debug-build ad overrides — the state and decisions behind each game's Ads debug tab. Written for
 * Weaveling (#1474), promoted here when Court became the second consumer (#1501), and extended with the
 * SDK's mediation debugger (#1500).
 *
 * Why it exists: an interstitial comes round every ~10 minutes of play, so an ad bug (#1473 — no close
 * button; #1455 — audio after an ad) could not be reproduced on demand. The tab shows any kind NOW and
 * switches each kind on or off for the rest of the process — through the game's own lifecycle, never the
 * raw plugin, so the game's dismiss and payout handling is what gets exercised.
 *
 * A FACTORY, not module state: each game's `ads.ts` owns its own instance, so an override set while one
 * project is open cannot carry into the next project the editor opens. Within a game it is still process
 * state, not a pref — an override is a test session's switch, and a relaunch returning to the real
 * behaviour is the safe default. The defaults are "no override", so a build whose tab never registers
 * (release) behaves exactly as if the wrapper were not there.
 *
 * Like `./adLifecycle`, this imports nothing SDK-specific: the mediation debugger arrives as a hook,
 * because the plugin is a per-game dependency. Tests: `tests/runtime/core/adDebug.test.ts`, plus each
 * game's `ads.test.ts` for the wiring. The tab that drives it: `../debug/adsDebugTab.tsx`.
 */

import type { AdLifecycle, FullscreenKind } from './adLifecycle';

/** `auto` = whatever the game asks for each frame; `on`/`off` pin it regardless. */
export type BannerMode = 'auto' | 'on' | 'off';

export interface AdDebugOverride {
  banner: BannerMode;
  /** false = the game's own interstitials are withheld (reported not-ready). Show now still works. */
  interstitial: boolean;
  /** false = rewarded videos are withheld (reported not-ready). Show now still works. */
  rewarded: boolean;
}

export const AD_DEBUG_DEFAULT: Readonly<AdDebugOverride> = Object.freeze({
  banner: 'auto', interstitial: true, rewarded: true,
});

/** The banner visibility actually requested, given what the game wants this frame. */
export function bannerWanted(gameWants: boolean, mode: BannerMode): boolean {
  return mode === 'auto' ? gameWants : mode === 'on';
}

export interface AdDebugHooks {
  /** Open the ad SDK's own mediation debugger (AppLovin MAX's: which networks are integrated, initialized
   *  and serving). Resolves `ok: false` where the plugin cannot — its web implementation. Absent for an SDK
   *  that has none, and the tab then hides the button. */
  openMediationDebugger?: () => Promise<{ ok: boolean }>;
}

export interface DebugAdStatus {
  initialized: boolean;
  interstitialLoaded: boolean;
  rewardedLoaded: boolean;
  fullscreenShowing: boolean;
  gameWantsBanner: boolean;
  override: Readonly<AdDebugOverride>;
}

export interface MediationDebuggerResult {
  opened: boolean;
  /** What the tab prints — why nothing opened, when nothing did. */
  message: string;
}

export interface AdDebug {
  // ── The game's calls, with the override applied. Each game's `ads.ts` routes its own through these. ──
  /** What the game wants on screen, every frame. `auto` passes it through unchanged. */
  setBannerVisible(visible: boolean): void;
  /** The game's show: a withheld kind resolves `false` without reaching the SDK. */
  showFullscreen(kind: FullscreenKind, placement: string): Promise<boolean>;
  /** The game's readiness: a withheld kind reads not-ready, so the game offers nothing it would refuse. */
  isReady(kind: FullscreenKind): boolean;

  // ── The tab's calls. ──
  /** Change an override, and apply a banner change NOW rather than on the game's next frame. */
  setOverride(patch: Partial<AdDebugOverride>): void;
  /** Show a fullscreen ad now, bypassing both the game's pacing and the kind's on/off override — the
   *  button is an explicit ask. Still refused when none is loaded or another ad is up. A rewarded one pays
   *  through whatever handler the game has registered, if any. */
  showNow(kind: FullscreenKind): Promise<boolean>;
  /** What the tab polls. `*Loaded` is the lifecycle's own readiness, ignoring the on/off override. */
  status(): DebugAdStatus;
  /** Does this SDK have a mediation debugger to open at all? */
  readonly hasMediationDebugger: boolean;
  /** Open it. Never throws: every way it cannot open resolves with the reason. */
  openMediationDebugger(): Promise<MediationDebuggerResult>;
}

/** The placement a debug show reports on `ad_*_shown` — distinct from every real one. */
export const DEBUG_PLACEMENT = 'debug';

export function createAdDebug(lifecycle: AdLifecycle, hooks: AdDebugHooks = {}): AdDebug {
  let current: AdDebugOverride = { ...AD_DEBUG_DEFAULT };
  /** The game's last banner wish, kept so an override change can re-apply it without waiting a frame. */
  let gameWantsBanner = false;

  return {
    setBannerVisible(visible) {
      gameWantsBanner = visible;
      lifecycle.setBannerVisible(bannerWanted(visible, current.banner));
    },
    showFullscreen(kind, placement) {
      if (!current[kind]) return Promise.resolve(false);
      return lifecycle.showFullscreen(kind, placement);
    },
    isReady(kind) {
      return current[kind] && lifecycle.isReady(kind);
    },

    setOverride(patch) {
      current = { ...current, ...patch };
      lifecycle.setBannerVisible(bannerWanted(gameWantsBanner, current.banner));
    },
    showNow(kind) {
      return lifecycle.showFullscreen(kind, DEBUG_PLACEMENT);
    },
    status() {
      return {
        initialized: lifecycle.isInitialized(),
        interstitialLoaded: lifecycle.isReady('interstitial'),
        rewardedLoaded: lifecycle.isReady('rewarded'),
        fullscreenShowing: lifecycle.isFullscreenShowing(),
        gameWantsBanner,
        override: current,
      };
    },
    hasMediationDebugger: hooks.openMediationDebugger !== undefined,
    async openMediationDebugger() {
      const open = hooks.openMediationDebugger;
      if (!open) return { opened: false, message: 'this ad SDK has no mediation debugger' };
      // The native call reaches the SDK singleton whether or not it was initialized, and an uninitialized
      // MAX shows nothing useful (or nothing). Not initialized also covers web and the editor, where the
      // adapter's `enabled()` is false and init never runs.
      if (!lifecycle.isInitialized()) {
        return { opened: false, message: 'ad SDK not initialized — off-device, no SDK key, or init has not finished (see the console)' };
      }
      try {
        const r = await open();
        return r.ok
          ? { opened: true, message: 'mediation debugger opened' }
          : { opened: false, message: 'the plugin could not open it on this platform' };
      } catch (e) {
        return { opened: false, message: `mediation debugger failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}
