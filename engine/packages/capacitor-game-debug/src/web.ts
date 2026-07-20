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
  async getNativeLogs(): Promise<{ logs: string[] }> { return { logs: [] }; }
  async getDeviceIp(): Promise<{ ip: string }> { return { ip: '' }; }
}
