export interface AdInfo {
  adUnitId: string;
  networkName: string;
  revenue: number;
  revenuePrecision: string;
  creativeId: string;
  placement: string;
}

export interface AdLoadFailedInfo {
  adUnitId: string;
  errorCode: number;
  errorMessage: string;
}

export interface AdRewardInfo {
  adUnitId: string;
  label: string;
  amount: number;
}

export interface ApplovinMaxPlugin {
  // --- Banner ---

  /** Show a banner ad. */
  showBanner(options: { adUnitId: string; position?: 'top' | 'bottom' }): Promise<{ ok: boolean }>;

  /** Hide the banner ad. */
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

  /** Pre-load an interstitial ad. */
  loadInterstitial(options: { adUnitId: string }): Promise<{ ok: boolean }>;

  /** Show the pre-loaded interstitial ad. */
  showInterstitial(options?: { placement?: string }): Promise<{ shown: boolean; reason?: string }>;

  /** Set extra parameter for interstitial. */
  setInterstitialExtraParameter(options: { key: string; value: string }): Promise<{ ok: boolean }>;

  /** Destroy the pre-loaded interstitial ad and free resources. */
  destroyInterstitial(): Promise<{ ok: boolean }>;

  // --- Rewarded ---

  /** Pre-load a rewarded ad. */
  loadRewardedAd(options: { adUnitId: string }): Promise<{ ok: boolean }>;

  /** Show the pre-loaded rewarded ad. */
  showRewardedAd(options?: { placement?: string }): Promise<{ shown: boolean; reason?: string }>;

  /** Set extra parameter for rewarded ad. */
  setRewardedExtraParameter(options: { key: string; value: string }): Promise<{ ok: boolean }>;

  // --- Privacy / Consent ---

  /** Set user consent status (GDPR). */
  setHasUserConsent(options: { consent: boolean }): Promise<{ ok: boolean }>;

  /** Set "Do Not Sell" flag (CCPA). */
  setDoNotSell(options: { doNotSell: boolean }): Promise<{ ok: boolean }>;

  /** Set age-restricted user flag (COPPA). */
  setIsAgeRestrictedUser(options: { ageRestricted: boolean }): Promise<{ ok: boolean }>;

  // --- SDK Settings ---

  /** Initialize MAX SDK from JS (alternative to native init). */
  initialize(options: { sdkKey: string }): Promise<{ ok: boolean }>;

  /** Set user ID for analytics. */
  setUserId(options: { userId: string }): Promise<{ ok: boolean }>;

  /** Mute/unmute ad audio. */
  setMuted(options: { muted: boolean }): Promise<{ ok: boolean }>;

  /** Enable/disable verbose logging. */
  setVerboseLogging(options: { enabled: boolean }): Promise<{ ok: boolean }>;

  /** Set test device advertising IDs. */
  setTestDeviceAdvertisingIds(options: { ids: string[] }): Promise<{ ok: boolean }>;

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
  addListener(eventName: 'adLoaded', handler: (info: AdInfo) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'adLoadFailed', handler: (info: AdLoadFailedInfo) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'adDisplayed', handler: (info: AdInfo) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'adHidden', handler: (info: AdInfo) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'adClicked', handler: (info: AdInfo) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'adRevenuePaid', handler: (info: AdInfo) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'adRewardEarned', handler: (info: AdRewardInfo) => void): Promise<{ remove: () => void }>;
}
