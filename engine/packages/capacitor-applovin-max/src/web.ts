import { WebPlugin } from '@capacitor/core';
import type { ApplovinMaxPlugin, ConsentInfo } from './definitions';

/** No ads on the web. Every call is inert; a load or a consent request REJECTS, as a failed one would natively. */
export class ApplovinMaxWeb extends WebPlugin implements ApplovinMaxPlugin {
  async showBanner(): Promise<{ ok: boolean; heightPx: number }> { return { ok: false, heightPx: 0 }; }
  async hideBanner(): Promise<{ ok: boolean }> { return { ok: false }; }
  async destroyBanner(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setBannerBackgroundColor(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setBannerPlacement(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showMRec(): Promise<{ ok: boolean }> { return { ok: false }; }
  async hideMRec(): Promise<{ ok: boolean }> { return { ok: false }; }
  async destroyMRec(): Promise<{ ok: boolean }> { return { ok: false }; }
  async loadInterstitial(): Promise<{ ok: boolean }> { throw this.unavailable('AppLovin MAX is not available on the web'); }
  async destroyInterstitial(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showInterstitial(): Promise<{ shown: boolean; reason?: string }> { return { shown: false, reason: 'web' }; }
  async setInterstitialExtraParameter(): Promise<{ ok: boolean }> { return { ok: false }; }
  async loadRewardedAd(): Promise<{ ok: boolean }> { throw this.unavailable('AppLovin MAX is not available on the web'); }
  async showRewardedAd(): Promise<{ shown: boolean; reason?: string }> { return { shown: false, reason: 'web' }; }
  async setRewardedExtraParameter(): Promise<{ ok: boolean }> { return { ok: false }; }
  async requestConsentInfo(): Promise<ConsentInfo> { throw this.unavailable('Google UMP is not available on the web'); }
  async showConsentForm(): Promise<ConsentInfo> { throw this.unavailable('Google UMP is not available on the web'); }
  async showPrivacyOptionsForm(): Promise<void> { throw this.unavailable('Google UMP is not available on the web'); }
  async setHasUserConsent(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setDoNotSell(): Promise<{ ok: boolean }> { return { ok: false }; }
  async initialize(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setUserId(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setMuted(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setVerboseLogging(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showMediationDebugger(): Promise<{ ok: boolean }> { return { ok: false }; }
  async isReady() { return { initialized: false, interstitialReady: false, rewardedReady: false }; }
}
