/**
 * The ad's format as this plugin reports it. MAX serves a LEADER (728x90) through a banner ad unit on a
 * tablet; that is reported as `'banner'` too, because to the caller it is the same slot.
 */
export type AdFormat = 'banner' | 'mrec' | 'interstitial' | 'rewarded' | 'unknown';

export interface AdInfo {
  adUnitId: string;
  format: AdFormat;
  networkName: string;
  /** In `currency`'s MAJOR units (dollars, not micros). 0 when MAX has no value yet, and in test mode. */
  revenue: number;
  /** Always `'USD'` — MAX reports every network's revenue in US dollars. */
  currency: 'USD';
  /** `'exact'`, `'estimated'`, `'publisher_defined'`, `'undefined'`, or `''` when there is none (test mode). */
  revenuePrecision: string;
  creativeId: string;
  placement: string;
}

export interface AdLoadFailedInfo {
  adUnitId: string;
  /** Mapped from the unit id through this plugin's own ad instances — the native callback carries only the id. */
  format: AdFormat;
  errorCode: number;
  errorMessage: string;
}

/** A loaded fullscreen ad could not be put on screen. Distinct from `adLoadFailed`: the ad HAD loaded. */
export interface AdDisplayFailedInfo {
  adUnitId: string;
  format: AdFormat;
  errorCode: number;
  errorMessage: string;
}

export interface AdRewardInfo {
  adUnitId: string;
  label: string;
  amount: number;
}

/**
 * The banner's laid-out size, in CSS px (iOS points / Android dp). Sent every time the size the plugin
 * actually laid out changes — first layout, rotation, a window resize — and never for a load or a refresh,
 * which do not change it. The height is the AD's own; the safe-area inset under it is not included.
 */
export interface BannerLayoutInfo {
  heightPx: number;
  widthPx: number;
}

/** Google UMP's consent status, spelled as `@capacitor-community/admob` spells it. */
export type ConsentStatus = 'REQUIRED' | 'NOT_REQUIRED' | 'OBTAINED' | 'UNKNOWN';

export interface ConsentInfo {
  status: ConsentStatus;
  /** Whether a form exists to show. Only `requestConsentInfo` reports it. */
  isConsentFormAvailable?: boolean;
  /** UMP's verdict: may ads be requested now? */
  canRequestAds: boolean;
  /** Does this player need a way back into their choice (a "Privacy choices" row in Settings)? */
  privacyOptionsRequired: boolean;
}

export interface ApplovinMaxPlugin {
  // --- Banner ---

  /**
   * Show the banner: an ANCHORED ADAPTIVE banner spanning the safe area's width, pinned to its bottom (or
   * top) edge. Idempotent — the first call creates and loads the view, later calls un-hide it and resume
   * auto-refresh (and re-load it when its last load failed). Resolves once the view is laid out, with the
   * height it took; a change after that arrives as `bannerLayout`. The AD arrives later, as `adLoaded`.
   */
  showBanner(options: { adUnitId: string; position?: 'top' | 'bottom' }): Promise<{ ok: boolean; heightPx: number }>;

  /** Hide the banner and stop its auto-refresh. The view is kept for the next `showBanner`.
   *  A banner load that FAILS does the same by itself (and reports `adLoadFailed` with `format: 'banner'`),
   *  so a failed banner is never left on screen for a caller that now believes it is gone. */
  hideBanner(): Promise<{ ok: boolean }>;

  /** Destroy the banner ad and free resources. */
  destroyBanner(): Promise<{ ok: boolean }>;

  /** Set banner background color. */
  setBannerBackgroundColor(options: { color: string }): Promise<{ ok: boolean }>;

  /** Set banner placement name for analytics. */
  setBannerPlacement(options: { placement: string }): Promise<{ ok: boolean }>;

  // --- MREC (300x250) ---

  /** Show a MREC ad. */
  showMRec(options: { adUnitId: string; position?: 'top' | 'bottom' | 'center' }): Promise<{ ok: boolean }>;

  /** Hide the MREC ad. */
  hideMRec(): Promise<{ ok: boolean }>;

  /** Destroy the MREC ad. */
  destroyMRec(): Promise<{ ok: boolean }>;

  // --- Interstitial ---

  /**
   * Load an interstitial. **Resolves when the ad has LOADED and rejects when the load failed** (the error's
   * `code` is MAX's error code). A second call while one is still loading rejects the first with code
   * `'superseded'`; a call while this ad is ON SCREEN rejects at once with code `'showing'` (MAX would
   * silently ignore it, and the call would never settle). Nothing reloads by itself after a dismissal — the caller owns when to load the next one.
   */
  loadInterstitial(options: { adUnitId: string }): Promise<{ ok: boolean }>;

  /**
   * Show the loaded interstitial. `shown: true` means the show was STARTED, not that it reached the screen:
   * `adDisplayed` / `adDisplayFailed` / `adHidden` say what happened.
   */
  showInterstitial(options?: { placement?: string }): Promise<{ shown: boolean; reason?: string }>;

  /** Set extra parameter for interstitial. */
  setInterstitialExtraParameter(options: { key: string; value: string }): Promise<{ ok: boolean }>;

  /** Destroy the interstitial instance and free resources. A pending load is rejected. */
  destroyInterstitial(): Promise<{ ok: boolean }>;

  // --- Rewarded ---

  /** Load a rewarded ad. Same settle rules as `loadInterstitial`. */
  loadRewardedAd(options: { adUnitId: string }): Promise<{ ok: boolean }>;

  /** Show the loaded rewarded ad. Same meaning of `shown` as `showInterstitial`; the reward is `adRewardEarned`. */
  showRewardedAd(options?: { placement?: string }): Promise<{ shown: boolean; reason?: string }>;

  /** Set extra parameter for rewarded ad. */
  setRewardedExtraParameter(options: { key: string; value: string }): Promise<{ ok: boolean }>;

  // --- Consent (Google UMP, run by this plugin — not MAX's own Terms and Privacy Policy flow) ---

  /**
   * Ask Google UMP for this player's consent status. MAX and its networks read the answer from the IAB TCF
   * string UMP stores on the device, so nothing else has to be passed to MAX. Rejects when UMP could not be
   * reached (offline). `debugGeography` forces a region for the listed test devices only.
   */
  requestConsentInfo(options?: {
    debugGeography?: 'eea' | 'not_eea';
    testDeviceIdentifiers?: string[];
    tagForUnderAgeOfConsent?: boolean;
  }): Promise<ConsentInfo>;

  /** Load and show the consent form if UMP says one is required. Rejects when no form is available. */
  showConsentForm(): Promise<ConsentInfo>;

  /** Re-open the consent form so the player can change their choice (Settings → Privacy choices). */
  showPrivacyOptionsForm(): Promise<void>;

  /** Set user consent status (GDPR) directly — only for a caller that runs NO consent form. */
  setHasUserConsent(options: { consent: boolean }): Promise<{ ok: boolean }>;

  /** Set "Do Not Sell" flag (CCPA). */
  setDoNotSell(options: { doNotSell: boolean }): Promise<{ ok: boolean }>;

  // --- SDK Settings ---

  /**
   * Initialise MAX. Run consent first: an ad requested before the player answered is requested without it.
   * `testDeviceAdvertisingIds` (IDFA / GAID) get test ads — SDK 13 accepts them only here, at init.
   */
  initialize(options: { sdkKey: string; testDeviceAdvertisingIds?: string[] }): Promise<{ ok: boolean }>;

  /** Set user ID for analytics. */
  setUserId(options: { userId: string }): Promise<{ ok: boolean }>;

  /** Mute/unmute ad audio. */
  setMuted(options: { muted: boolean }): Promise<{ ok: boolean }>;

  /** Enable/disable verbose logging. */
  setVerboseLogging(options: { enabled: boolean }): Promise<{ ok: boolean }>;

  /** Open the mediation debugger. */
  showMediationDebugger(): Promise<{ ok: boolean }>;

  /** Check SDK and ad readiness status. */
  isReady(): Promise<{
    initialized: boolean;
    interstitialReady: boolean;
    rewardedReady: boolean;
  }>;

  // --- Event Listeners ---

  /** Add listener for ad events. */
  addListener(eventName: 'adLoaded', handler: (info: AdInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adLoadFailed', handler: (info: AdLoadFailedInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adDisplayed', handler: (info: AdInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adDisplayFailed', handler: (info: AdDisplayFailedInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adHidden', handler: (info: AdInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adClicked', handler: (info: AdInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adRevenuePaid', handler: (info: AdInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'adRewardEarned', handler: (info: AdRewardInfo) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'bannerLayout', handler: (info: BannerLayoutInfo) => void): Promise<{ remove: () => Promise<void> }>;
}
