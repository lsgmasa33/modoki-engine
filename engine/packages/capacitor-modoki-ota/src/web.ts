import { WebPlugin } from '@capacitor/core';
import type { ModokiOtaPlugin } from './definitions';

/** Web has no native OTA mechanism to hand content-swapping to (there is no
 *  WebView.setServerBasePath equivalent for a plain browser tab — a web build is already
 *  served fresh from the CDN on every load). Every method is a documented no-op so
 *  calling code can run unmodified on web without special-casing the platform. */
export class ModokiOtaWeb extends WebPlugin implements ModokiOtaPlugin {
  async stageUpdate(): Promise<{ ok: boolean }> {
    console.log('[ModokiOta] Web: stageUpdate is a no-op (web has no OTA mechanism)');
    return { ok: false };
  }
  async activate(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
  async confirmBoot(): Promise<{ ok: boolean }> {
    return { ok: true }; // harmless no-op — nothing to confirm on a platform with no pending state
  }
  async getState(): Promise<{ stateJSON: string }> {
    return { stateJSON: 'null' };
  }
}
