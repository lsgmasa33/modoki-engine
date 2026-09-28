import { WebPlugin } from '@capacitor/core';
import type { DebugFileInfo, GameDebugPlugin } from './definitions';

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
  /** No device folder to write into — a web build has nothing to pull files from. Rejects rather than
   *  resolving, so a caller cannot mistake "accepted" for "written". */
  async writeDebugFile(): Promise<{ ok: boolean }> {
    throw this.unavailable('writeDebugFile is native-only — a web build has no debug-files folder.');
  }
  async listDebugFiles(): Promise<{ files: DebugFileInfo[] }> {
    throw this.unavailable('listDebugFiles is native-only — a web build has no debug-files folder.');
  }
  async deleteDebugFile(): Promise<{ ok: boolean }> {
    throw this.unavailable('deleteDebugFile is native-only — a web build has no debug-files folder.');
  }
  async getNativeLogs(): Promise<{ logs: string[] }> { return { logs: [] }; }
  async getDeviceIp(): Promise<{ ip: string }> { return { ip: '' }; }
  /** Empty, not invented: the web build has no hardware identity a host could compare against,
   *  and a fabricated model would be read as a real one (#146). */
  async getDeviceHardware(): Promise<{ model: string; osVersion: string }> { return { model: '', osVersion: '' }; }
}
