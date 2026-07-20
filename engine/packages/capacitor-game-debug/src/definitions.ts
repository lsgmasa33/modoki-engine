import type { PluginListenerHandle } from '@capacitor/core';

export interface GameDebugPlugin {
  /** Start the TCP server + UDP beacon */
  startServer(options?: { port?: number }): Promise<{ port: number }>;

  /** Stop the server */
  stopServer(): Promise<{ ok: boolean }>;

  /** Check if server is running and has a connected client */
  getStatus(): Promise<{ running: boolean; clientConnected: boolean; port: number }>;

  /** Send a response back to the connected MCP client */
  sendResponse(options: { id: string; result?: string; error?: string }): Promise<{ ok: boolean }>;

  /** Capture full screen as JPEG (native rendering, not just canvas) */
  captureScreen(): Promise<{
    image: string;
    imageWidth: number;
    imageHeight: number;
    screenWidth: number;
    screenHeight: number;
  }>;

  /** Get recent native logs (os_log on iOS, logcat on Android) */
  getNativeLogs(options?: { limit?: number; seconds?: number; filter?: string; subsystem?: string }): Promise<{ logs: string[]; error?: string }>;

  /** The device's WiFi IPv4 address (empty string if WiFi is down) — shown in the in-game
   *  debug menu so the user can type it into Modoki's device Connect field. */
  getDeviceIp(): Promise<{ ip: string }>;

  /** Listen for incoming requests from MCP */
  addListener(
    eventName: 'request',
    handler: (data: { id: string; method: string; params: string }) => void,
  ): Promise<PluginListenerHandle>;

  /** Listen for connection state changes */
  addListener(
    eventName: 'connectionChanged',
    handler: (data: { connected: boolean; remoteAddress?: string }) => void,
  ): Promise<PluginListenerHandle>;
}
