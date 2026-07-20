/**
 * Electron preload (ELECTRON_PLAN Phase 2). Two jobs, both in the main world via
 * contextBridge (contextIsolation stays on — no nodeIntegration):
 *
 *   1. `window.__modokiBackendBase` — the localhost URL of the main-hosted
 *      backend, read by editorBackend.ts's `backendBase()` so every editor →
 *      backend call targets main instead of the renderer's Vite origin.
 *   2. `window.__modokiElectron.bridge` — the IPC transport agentBridge uses
 *      under Electron in place of the Vite HMR socket (schema push, request/
 *      response, scene-changed / manifest-updated notifications).
 */

import { contextBridge, ipcRenderer } from 'electron';

// Renderer → main request/response channels the editor may `invoke`. Whitelisted so
// the bridge never exposes arbitrary ipcRenderer.invoke to the renderer. These back
// the "Connect Claude Code" AI panel (docs/connect-claude-code.md).
const INVOKE_CHANNELS = new Set<string>([
  'modoki:connect-claude',
  'modoki:connect-claude-status',
  'modoki:set-cdp-enabled',
]);

// Backend base handed in via additionalArguments (`--modoki-backend-base=...`).
const baseArg = process.argv.find((a) => a.startsWith('--modoki-backend-base='));
const backendBase = baseArg ? baseArg.slice('--modoki-backend-base='.length) : '';

contextBridge.exposeInMainWorld('__modokiBackendBase', backendBase);

contextBridge.exposeInMainWorld('__modokiElectron', {
  isElectron: true,
  backendBase,
  // Host OS ('darwin' | 'win32' | 'linux'). The renderer uses this to gray out
  // platform-impossible actions (e.g. iOS builds off macOS) — process.platform is
  // the authoritative source and isn't otherwise reachable from the renderer.
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** Renderer → main request/response for the whitelisted channels above. */
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    INVOKE_CHANNELS.has(channel)
      ? ipcRenderer.invoke(channel, payload)
      : Promise.reject(new Error(`invoke channel not allowed: ${channel}`)),
  bridge: {
    /** Renderer → main: push schema or a request reply. */
    send: (event: string, data: unknown) => ipcRenderer.send('modoki:bridge-send', { event, data }),
    /** Main → renderer: subscribe to 'request' / 'scene-changed' / 'manifest-updated'.
     *  Returns an unsubscribe fn so a re-subscribing renderer (HMR) doesn't leak
     *  listeners on ipcRenderer. */
    on: (event: string, cb: (data: unknown) => void): (() => void) => {
      const channel = `modoki:bridge-${event}`;
      const handler = (_e: unknown, data: unknown) => cb(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
});
