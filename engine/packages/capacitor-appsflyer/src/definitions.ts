export interface AppsFlyerPlugin {
  /**
   * Initialize the AppsFlyer SDK.
   *
   * On iOS this ALSO arms `waitForATTUserAuthorization(timeoutInterval:)` (unless
   * `waitForAttTimeoutSec` is 0) — see `start()` for why that ordering matters.
   */
  initialize(options: {
    devKey: string;
    /** Required for iOS install-conversion attribution. */
    appleAppId?: string;
    isDebug?: boolean;
    /**
     * Seconds to wait for the ATT prompt to resolve before AppsFlyer sends events
     * without IDFA. Default 60. Set 0 to skip the wait entirely (NOT recommended —
     * see the `start()` doc comment).
     */
    waitForAttTimeoutSec?: number;
  }): Promise<{ ok: boolean }>;

  /**
   * Start the AppsFlyer SDK. Must be called AFTER `initialize()`.
   *
   * ⚠️ On iOS 14+, if `initialize()` did not arm `waitForATTUserAuthorization`
   * before this fires, every install and event goes out WITHOUT IDFA and nothing
   * errors — postbacks still arrive, the dashboard still fills up, the attribution
   * is just silently blind. `initialize()` handles the ordering.
   *
   * ⚠️ **ONCE PER PROCESS (#607).** The first call registers the SDK's session-ready listener; every
   * later call in the same OS process resolves `{ok:true}` and does NOTHING. A caller cannot detect
   * the no-op from the reply, and must not read `{ok:true}` as "the SDK started just now".
   *
   * ⚠️ **The justification for that guard was MEASURED and is weaker than this comment used to
   * claim (#654, 2026-09-04, Galaxy S22, SDK v7.0.1.386).** It said each registration "posts its own
   * Launch event, so a webview reload calling this a second time inflated sessions". Both halves are
   * refuted. Run unguarded, a second `start()` across a real `location.reload()` in one process
   * posted NO extra Launch event and no POST at all; the extra Launch that #607 attributed to the
   * reload came from the app RESUME that followed it. AppsFlyer's Launch is driven by the foreground
   * transition (`onBecameForeground`), not by `start()` — and with two listeners registered, the
   * resume still produced exactly ONE Launch, so stacking did not inflate anything either.
   * The guard is therefore INERT for Launch counts. It is kept because it still prevents a second
   * `registerSessionReadyListener`, which is cheap and harmless — not because it stops inflation.
   * **iOS was measured too** (2026-09-05, SDK 7.0.2): with this guard disabled, calling `start()`
   * a second time — via a webview reload AND by invoking the plugin method outright — produced no
   * Launch and no server-side row at all. The OUTCOME therefore matches Android, and the guard is
   * inert for Launch counts on both.
   * ⚠️ WHERE that no-op happens is NOT established. This plugin's `start()` registers a
   * session-ready listener whose BODY calls `AppsFlyerLib.start()`, so "nothing happened" is
   * equally consistent with the SDK ignoring the second call and with the second listener never
   * firing. Full run, both arms, and the ATT prompt that gates a fresh install:
   * `games/court/attribution.md` § "#607/#654 — the iOS leg measured, and both platforms agree".
   * ⚠️ Consequence for a future `stop({stopped:false})` opt-back-in: the follow-up `start()` may
   * ALSO no-op, so treat re-enabling the SDK mid-process as UNPROVEN through this API rather than
   * impossible — if the listener is the cause, calling `AppsFlyerLib.start()` directly on that
   * path would work. Nothing calls `stop` from JS, so this is a trap for the next author, not a
   * live bug.
   */
  start(): Promise<{ ok: boolean }>;

  /**
   * Log a custom in-app event for campaign optimisation.
   */
  logEvent(options: { eventName: string; eventValues?: Record<string, string | number> }): Promise<{ ok: boolean }>;

  /**
   * Associate a customer/user id with this install.
   */
  setCustomerUserId(options: { userId: string }): Promise<{ ok: boolean }>;

  /**
   * Get the AppsFlyer device id (the "AppsFlyer UID").
   */
  getAppsFlyerUID(): Promise<{ uid: string }>;

  /**
   * This device's advertising identifier — the **IDFA** on iOS, the **GAID/AAID** on Android.
   *
   * `kind` says which, so a caller never has to branch on the platform to read `id`. Its main use
   * is registering a TEST DEVICE in the AppsFlyer dashboard, which is keyed on exactly this value
   * (`AID` for Android, IDFA for iOS) and otherwise needs AppsFlyer's utility app just to read it.
   *
   * ⚠️ **`limitAdTracking` is ALWAYS `false` on iOS, and is not a consent signal there.** iOS has
   * no separate limit-ad-tracking flag post-ATT — ATT authorization is the gate — so the field
   * exists only to keep the shape identical across platforms. A caller that reads
   * `limitAdTracking === false` as "the user allowed tracking" would be wrong on iOS whenever ATT
   * is merely unresolved. Ask `requestTrackingAuthorization()` for consent state; use this field
   * only on Android, where it reflects the real setting.
   *
   * ⚠️ **Branch on `available`, not on `id` being non-empty.** Android hands back the all-zero
   * UUID rather than null when the user deletes their advertising id, which passes a naive check.
   * `available: false` is the NORMAL answer for: ATT not authorized (iOS), limit-ad-tracking or a
   * deleted id (Android), no Play Services, or the web. It is never an error — pair it with
   * `requestTrackingAuthorization()` when you need to tell "denied" from "not yet resolved".
   */
  getAdvertisingId(): Promise<{
    id: string;
    kind: 'idfa' | 'gaid' | 'none';
    available: boolean;
    limitAdTracking: boolean;
  }>;

  /**
   * Get the current attribution/conversion data for this install.
   */
  getConversionData(): Promise<{ data: Record<string, unknown> }>;

  /**
   * Set DMA/GDPR consent flags.
   */
  setConsent(options: { hasConsentForDataUsage?: boolean; hasConsentForAdsPersonalization?: boolean }): Promise<{ ok: boolean }>;

  /**
   * Stop (or resume) the SDK — GDPR/CCPA opt-out.
   */
  stop(options: { stopped: boolean }): Promise<{ ok: boolean }>;

  /**
   * Request iOS App Tracking Transparency authorization. Resolves once the
   * player has answered the system prompt (or immediately if already decided).
   * Android and iOS < 14 resolve `notSupported` — ATT is iOS-only.
   */
  requestTrackingAuthorization(): Promise<{ status: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'notSupported' }>;
}
