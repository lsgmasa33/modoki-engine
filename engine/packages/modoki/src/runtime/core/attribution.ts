/**
 * The AppsFlyer attribution LIFECYCLE — the init latch, the ATT ordering, the consent retry rule and the
 * iOS crash guard, with no SDK and no game in it. Written in Court (#263), copied into Weaveling (#632
 * tier 3), and promoted here when the two copies had become byte-identical (#1332).
 *
 * ⚠️ **Imports nothing SDK-specific and nothing Capacitor-specific, and must stay that way.** The plugin
 * (`capacitor-appsflyer`) is vendored into each GAME's own `node_modules`, so the engine cannot import it:
 * it arrives as an `AttributionSdk` (the game passes `AppsFlyerCap`). The platform arrives too (the game
 * passes `Capacitor`), so a game test's `vi.mock('@capacitor/core')` steers this module whichever copy of
 * `@capacitor/core` the engine would have resolved. Each game's `packages/app-services/src/attribution.ts`
 * is the few lines that wire the two in with its own config.
 *
 * The rules, each paid for on hardware:
 * - **Call order is initialize → requestTrackingAuthorization → start**, and NOTHING but `initAppsFlyer`
 *   enforces it. The v6 SDK queued events until ATT resolved; v7 deprecated `waitForATTUserAuthorization`
 *   ("the SDK no longer manages ATT timing internally"). Calling start() before consent resolves sends
 *   every install and event without IDFA on iOS 14+ — silently. The order test in
 *   `tests/runtime/core/attribution.test.ts` is the only thing that can catch a regression. Detail:
 *   `games/court/attribution.md` § Phase 3.
 * - **The latch (`starting`) is taken before the first await** (#458). Measured on an iPhone 8,
 *   2026-08-19: `initialized` is set only after three awaited plugin calls, so two callers in the same
 *   tick both passed it and the ATT prompt was requested TWICE (syslog, 21:49:33.175 and 21:49:35.364).
 *   The engine-side double call was fixed in #267 (`docs/architecture.md` § "The boot effect runs
 *   EXACTLY ONCE per `gameId`"); the latch stays, because React `<StrictMode>` still double-invokes
 *   effects in dev and a once-ever consent prompt must not rest on a caller's discipline.
 * - **The latch is released on failure ONLY if consent was never asked** (`attPrompted`). Holding it
 *   blindly would disable attribution for the run over a transient bridge failure; releasing it blindly
 *   would re-prompt. `attPrompted` is armed after the consent call RESOLVES, because a rejection means
 *   the bridge failed and no dialog was shown.
 * - **A configured dev key with NO `appleAppId` is FATAL on iOS**: the SDK throws
 *   NSInternalInconsistencyException right after the player answers the ATT prompt (iPhone 8,
 *   2026-08-19). The native side refuses too; this is the second guard, because the cost is a launch crash.
 * - **`whenTrackingPromptSettled()`** settles once this run's ATT request has returned (or at once when
 *   none is under way). Each game's `ads.ts` waits on it before Google's UMP consent form (#1309/#1312):
 *   the engine starts attribution and ads in the same tick (`engine/app/App.tsx`), so the two launch-time
 *   full-screen asks would race. It is armed synchronously, before the first await.
 * - **An iOS `notDetermined` answer means NO PROMPT WAS SHOWN** (#1510). iOS draws the ATT prompt only
 *   while the app is active and otherwise answers `notDetermined` at once. The plugin now holds an
 *   UNANSWERED request until the app is active (`capacitor-appsflyer/att-core`; an answered status runs
 *   at once, #1532), so this answer should not come back. If it does, iOS did not show the prompt for that request and AppsFlyer starts unanswered anyway,
 *   so `warnIfPromptNotShown` says so in the log instead of passing it off as an answer.
 * - **An ATT answer other than `authorized` means NO TRACKING for the run** (#1920, App Store guideline
 *   5.1.1(iv): Court 0.1.0 was rejected for tracking after "Ask App Not to Track"). Here that is
 *   AppsFlyer's anonymous mode, `anonymizeUser` BEFORE `start()` (owner ruling on #1522): the SDK still
 *   starts and reports installs and events in aggregate (SKAdNetwork keeps working), with the device ids
 *   dropped and its own id and the IP hashed. Ads and analytics read the same answer from
 *   `trackingStatus()` — each game's `ads.ts` and its `attribution.ts` wiring. `notDetermined` counts as
 *   a denial too: Apple's rule is "ask first", and no answer is not permission. ⚠️ **A failing
 *   `anonymizeUser` keeps AppsFlyer OFF** for the run: it throws before `start()`, and past the prompt
 *   nothing retries. Losing one run's attribution is the price of never tracking someone who said no.
 * - **No method rejects into a caller.** Every failure is a `console.warn` and a resolved sentinel.
 */

import { beginBootSpan, endBootSpan } from './bootTimeline';

/**
 * Warns when iOS answered the ATT request without showing the prompt (#1510). A player's answer is
 * always `authorized`, `denied` or `restricted`. `notDetermined` means the system declined to draw the
 * prompt for THIS request. Whether something else (UMP's IDFA explainer, say) asks later in the run is
 * not known here, so the message does not claim the player is never asked.
 */
function warnIfPromptNotShown(att: unknown, os: string): void {
  if (os !== 'ios') return;
  const status = (att as { status?: unknown } | null | undefined)?.status;
  if (status !== 'notDetermined') return;
  console.warn(
    '[AppsFlyer] ATT answered notDetermined: iOS did not show the tracking prompt for this request, ' +
      'so AppsFlyer starts without the player having answered (#1510).',
  );
}

/**
 * This run's ATT answer, as `capacitor-appsflyer`'s `requestTrackingAuthorization` spells it, plus
 * `unknown`: on iOS, no answer came back (attribution is off, its init failed, or nobody asked yet).
 * `notSupported` is every platform without ATT — Android, the editor, the web.
 */
export type TrackingStatus = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'notSupported' | 'unknown';

const TRACKING_STATUSES: readonly TrackingStatus[] = ['authorized', 'denied', 'restricted', 'notDetermined', 'notSupported'];

/**
 * May this run track the player — personalized ads, a consent form for them, device-level attribution?
 * (#1920) Only on an explicit `authorized`, or where ATT does not exist. Everything else on iOS — a
 * denial, `restricted`, `notDetermined` (no prompt was shown, #1510) and `unknown` — is a no: tracking
 * needs the player's permission, and the absence of an answer is not one.
 */
export function isTrackingAllowed(status: TrackingStatus): boolean {
  return status === 'authorized' || status === 'notSupported';
}

function statusOf(att: unknown): TrackingStatus {
  const status = (att as { status?: unknown } | null | undefined)?.status;
  return TRACKING_STATUSES.find((s) => s === status) ?? 'unknown';
}

/** iOS IDFA / Android GAID, with `kind` naming which — see the plugin's own doc comment. */
export type AdvertisingId = {
  id: string;
  kind: 'idfa' | 'gaid' | 'none';
  available: boolean;
  limitAdTracking: boolean;
};

/** The slice of `capacitor-appsflyer`'s `AppsFlyerPlugin` this module drives. */
export interface AttributionSdk {
  initialize(options: { devKey: string; appleAppId: string; isDebug: boolean; waitForAttTimeoutSec: number }): Promise<unknown>;
  requestTrackingAuthorization(): Promise<unknown>;
  /** AppsFlyer's anonymous mode. Must come before `start()` to cover the install itself. */
  anonymizeUser(options: { anonymize: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
  logEvent(options: { eventName: string; eventValues?: Record<string, string | number> }): Promise<unknown>;
  setCustomerUserId(options: { userId: string }): Promise<unknown>;
  getAppsFlyerUID(): Promise<{ uid: string }>;
  getAdvertisingId(): Promise<AdvertisingId>;
}

/** The slice of Capacitor's `Capacitor` object this module reads. Read per call, never cached. */
export interface AttributionPlatform {
  isNativePlatform(): boolean;
  getPlatform(): string;
}

export interface AttributionConfig {
  /** Blank disables attribution entirely. */
  devKey: string;
  /** The numeric App Store id. Blank disables attribution on iOS (see the header). */
  appleAppId: string;
  isDebug: boolean;
  waitForAttTimeoutSec: number;
}

export interface AttributionOptions {
  /** Read ONCE, when the service is created — as the per-game module used to read it at import time. */
  config: AttributionConfig;
  sdk: AttributionSdk;
  platform: AttributionPlatform;
  /** The bundle id, named in the blank-`appleAppId` error so it says which App Store record to create. */
  bundleId: string;
}

export interface Attribution {
  /** Initialize AppsFlyer. A no-op without a dev key or off native (no SDK in the editor/web preview). */
  initAppsFlyer(): Promise<void>;
  whenTrackingPromptSettled(): Promise<void>;
  /**
   * This run's ATT answer, once the prompt has settled (#1920) — what `isTrackingAllowed` judges. Waits
   * exactly as long as `whenTrackingPromptSettled`. `notSupported` off iOS and off native; `unknown` on
   * iOS when no answer came back.
   */
  trackingStatus(): Promise<TrackingStatus>;
  /** Log a custom AppsFlyer event. */
  logEvent(eventName: string, eventValues?: Record<string, string | number>): Promise<void>;
  /** Associate a customer/user id with this install. */
  setCustomerUserId(userId: string): Promise<void>;
  /** The AppsFlyer device id (UID), or `''`. */
  getAppsFlyerUID(): Promise<string>;
  /**
   * This device's advertising id — the IDFA on iOS, the GAID on Android.
   *
   * ⚠️ **Exists so a native failure cannot reach a caller**, like every other method here. `available`
   * is what a caller branches on: Android 12+ returns the all-zero UUID, not null, once the user deletes
   * the id. `available:false` does NOT tell "no IDFA" from "not supported here" — a caller that needs
   * consent state should ask `requestTrackingAuthorization()`.
   */
  getAdvertisingId(): Promise<AdvertisingId>;
}

const NO_ADVERTISING_ID: AdvertisingId = { id: '', kind: 'none', available: false, limitAdTracking: false };

export function createAttribution({ config, sdk, platform, bundleId }: AttributionOptions): Attribution {
  const enabled = config.devKey !== '';
  const live = () => enabled && platform.isNativePlatform();

  let initialized = false;
  let starting = false;
  let attPrompted = false;
  let attSettled: Promise<void> = Promise.resolve();
  /** The answer this run's ATT request returned; `null` until one has. */
  let attStatus: TrackingStatus | null = null;

  async function initAppsFlyer(): Promise<void> {
    if (initialized || starting) return;
    if (!enabled) {
      console.log('[AppsFlyer] Disabled — no dev key configured');
      return;
    }
    if (!platform.isNativePlatform()) {
      console.log('[AppsFlyer] Skipping — not on native platform');
      return;
    }
    if (platform.getPlatform() === 'ios' && config.appleAppId === '') {
      console.error(
        '[AppsFlyer] appleAppId is EMPTY — iOS attribution DISABLED for this run. ' +
          'Starting the SDK without it crashes the app. Set the numeric App Store id in ' +
          `config.ts (needs an App Store Connect record for ${bundleId} first).`,
      );
      return;
    }

    starting = true;
    let settleAtt: () => void = () => {};
    attSettled = new Promise<void>((resolve) => { settleAtt = resolve; });

    try {
      await sdk.initialize({
        devKey: config.devKey,
        appleAppId: config.appleAppId,
        isDebug: config.isDebug,
        waitForAttTimeoutSec: config.waitForAttTimeoutSec,
      });
      // Retrying this call is safe: iOS shows the system dialog ONCE EVER, and a second request returns
      // the cached answer without UI. Not retrying would leave attribution off for the whole run.
      // A boot-timeline span (#1475): on a fresh iOS install this is the system ATT alert, which takes
      // the screen and withholds frames — the read has to be able to see that it was up.
      const attSpan = beginBootSpan('att-prompt');
      let att: unknown;
      try {
        att = await sdk.requestTrackingAuthorization();
        attStatus = statusOf(att);   // before the settle, so `trackingStatus()` can never read it unset
      } finally {
        endBootSpan(attSpan);
        settleAtt();
      }
      warnIfPromptNotShown(att, platform.getPlatform());
      attPrompted = true;
      // #1920: anonymous mode on anything but a yes, set every run where ATT exists (`false` on a yes, so a
      // player who allows tracking later is not left anonymized). Off iOS the call is never made, which
      // keeps Android's start-up exactly as it shipped.
      if (attStatus !== 'notSupported') await sdk.anonymizeUser({ anonymize: !isTrackingAllowed(attStatus) });
      await sdk.start();
      initialized = true;
      console.log(`[AppsFlyer] Initialized for ${platform.getPlatform()}`);
    } catch (e) {
      console.warn('[AppsFlyer] Init failed:', e);
      settleAtt();   // an `initialize()` failure never reached the prompt; idempotent after the finally above
      // Past the consent prompt a retry could ask twice, which is worse than losing attribution.
      if (!attPrompted) starting = false;
    }
  }

  return {
    initAppsFlyer,
    whenTrackingPromptSettled: () => attSettled,
    trackingStatus: () => attSettled.then(() =>
      attStatus ?? (platform.isNativePlatform() && platform.getPlatform() === 'ios' ? 'unknown' : 'notSupported')),

    async logEvent(eventName, eventValues) {
      if (!live()) return;
      try {
        await sdk.logEvent({ eventName, eventValues });
      } catch (e) {
        console.warn('[AppsFlyer] logEvent failed:', e);
      }
    },

    async setCustomerUserId(userId) {
      if (!live()) return;
      try {
        await sdk.setCustomerUserId({ userId });
      } catch (e) {
        console.warn('[AppsFlyer] setCustomerUserId failed:', e);
      }
    },

    async getAppsFlyerUID() {
      if (!live()) return '';
      try {
        return (await sdk.getAppsFlyerUID()).uid;
      } catch (e) {
        console.warn('[AppsFlyer] getAppsFlyerUID failed:', e);
        return '';
      }
    },

    async getAdvertisingId() {
      if (!live()) return { ...NO_ADVERTISING_ID };
      try {
        return await sdk.getAdvertisingId();
      } catch (e) {
        console.warn('[AppsFlyer] getAdvertisingId failed:', e);
        return { ...NO_ADVERTISING_ID };
      }
    },
  };
}
