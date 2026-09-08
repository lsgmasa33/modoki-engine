import { WebPlugin } from '@capacitor/core';

import type { AppsFlyerPlugin } from './definitions';

export class AppsFlyerWeb extends WebPlugin implements AppsFlyerPlugin {
  async initialize(): Promise<{ ok: boolean }> {
    console.log('[AppsFlyer] Not available on web');
    return { ok: false };
  }
  async start(): Promise<{ ok: boolean }> { return { ok: false }; }
  async logEvent(): Promise<{ ok: boolean }> { return { ok: false }; }
  async setCustomerUserId(): Promise<{ ok: boolean }> { return { ok: false }; }
  async getAppsFlyerUID(): Promise<{ uid: string }> { return { uid: '' }; }
  // No advertising id on the web, and `available: false` says so — matching the shape a real
  // device returns when consent is absent, rather than inventing a separate failure mode.
  async getAdvertisingId(): Promise<{
    id: string; kind: 'idfa' | 'gaid' | 'none'; available: boolean; limitAdTracking: boolean;
  }> {
    return { id: '', kind: 'none', available: false, limitAdTracking: false };
  }
  async getConversionData(): Promise<{ data: Record<string, unknown> }> { return { data: {} }; }
  async setConsent(): Promise<{ ok: boolean }> { return { ok: false }; }
  async stop(): Promise<{ ok: boolean }> { return { ok: false }; }
  async requestTrackingAuthorization(): Promise<{ status: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'notSupported' }> {
    return { status: 'notSupported' };
  }
}
