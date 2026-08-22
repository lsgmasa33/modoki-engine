import { WebPlugin } from '@capacitor/core';
import type { GameDebugPlugin } from './definitions';

export class GameDebugWeb extends WebPlugin implements GameDebugPlugin {
  async startServer(): Promise<{ port: number }> {
    console.log('[GameDebug] Web: no-op (use WebSocket bridge for Chrome)');
    return { port: 0 };
  }
  async stopServer(): Promise<{ ok: boolean }> { return { ok: false }; }
  async getStatus(): Promise<{ running: boolean; clientConnected: boolean; port: number }> {
    return { running: false, clientConnected: false, port: 0 };
  }
  async sendResponse(): Promise<{ ok: boolean }> { return { ok: false }; }
  async captureScreen(): Promise<{ image: string; imageWidth: number; imageHeight: number; screenWidth: number; screenHeight: number }> {
    return { image: '', imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  }
  /** No native runtime to fault. Rejects rather than resolving: a resolved call reads as
   *  "accepted", and a probe that silently accepts and does nothing is exactly the false success
   *  the fault triggers exist to avoid. */
  async triggerFault(): Promise<{ ok: boolean }> {
    throw this.unavailable('triggerFault is native-only — there is no native runtime to fault on the web.');
  }
  async getNativeLogs(): Promise<{ logs: string[] }> { return { logs: [] }; }
  async getDeviceIp(): Promise<{ ip: string }> { return { ip: '' }; }
  /** Empty, not invented: the web build has no hardware identity a host could compare against,
   *  and a fabricated model would be read as a real one (#146). */
  async getDeviceHardware(): Promise<{ model: string; osVersion: string }> { return { model: '', osVersion: '' }; }
}
