import { WebPlugin } from '@capacitor/core';
import type { ApplovinMaxPlugin } from './definitions';

export class ApplovinMaxWeb extends WebPlugin implements ApplovinMaxPlugin {
  async showBanner(): Promise<{ ok: boolean }> { return { ok: false }; }
  async hideBanner(): Promise<{ ok: boolean }> { return { ok: false }; }
  async destroyBanner(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setBannerBackgroundColor(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setBannerPlacement(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showMRec(): Promise<{ ok: boolean }> { return { ok: false }; }
  async hideMRec(): Promise<{ ok: boolean }> { return { ok: false }; }
  async destroyMRec(): Promise<{ ok: boolean }> { return { ok: false }; }
  async loadInterstitial(): Promise<{ ok: boolean }> { return { ok: false }; }
  async destroyInterstitial(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showInterstitial(): Promise<{ shown: boolean }> { return { shown: false, reason: 'web' } as any; }
  async setInterstitialExtraParameter(): Promise<{ ok: boolean }> { return { ok: false }; }
  async loadRewardedAd(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showRewardedAd(): Promise<{ shown: boolean }> { return { shown: false, reason: 'web' } as any; }
  async setRewardedExtraParameter(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setHasUserConsent(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setDoNotSell(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setIsAgeRestrictedUser(): Promise<{ ok: boolean }> { return { ok: false }; }
  async initialize(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setUserId(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setMuted(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setVerboseLogging(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setTestDeviceAdvertisingIds(): Promise<{ ok: boolean }> { return { ok: false }; }
  async showMediationDebugger(): Promise<{ ok: boolean }> { return { ok: false }; }
  async isReady() { return { initialized: false, interstitialReady: false, rewardedReady: false }; }
}
