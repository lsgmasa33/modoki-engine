// Device-connect model — the AI panel's "connect to a physical device" surface.
//
// A DELIBERATE, human-initiated device connection owned by Modoki (not auto-discovery): the user
// types the device IP (shown in the on-device debug menu) or checks "Use adb (USB)", clicks
// Connect, and the backend holds the lease. See docs/debug-tools-mcp.md.

import { backendFetch, backendPostJson } from '../backend/editorBackend';

export type DeviceLeaseState =
  | 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'busy' | 'error';

export interface DeviceStatus {
  state: DeviceLeaseState;
  guid: string;
  target: { host: string; port: number; useAdb: boolean } | null;
  /** Last chosen IP/adb (persisted server-side per clone) — used to pre-fill the form. */
  lastTarget?: { ip: string; useAdb: boolean } | null;
  detail?: string;
}

export interface DeviceConnectRequest {
  ip?: string;
  useAdb?: boolean;
  port?: number;
}

// ── Backend calls (sanctioned renderer→backend path, dev + packaged) ──────────

export async function fetchDeviceStatus(signal?: AbortSignal): Promise<DeviceStatus | null> {
  try {
    const res = await backendFetch('/api/device/status', signal ? { signal } : undefined);
    if (!res.ok) return null;
    return (await res.json()) as DeviceStatus;
  } catch {
    return null; // backend not reachable (e.g. no editor host) — panel degrades gracefully
  }
}

/** Read a DeviceStatus body, or THROW with the backend's error detail on a non-2xx — otherwise a
 *  500 `{error}` body would cast to a `state:undefined` status and render the benign "Not connected",
 *  swallowing the real failure (L6). fetchDeviceStatus already guards this way. */
async function statusOrThrow(res: Response): Promise<DeviceStatus> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = (await res.json()) as { error?: string }; if (b?.error) msg = String(b.error); } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  return (await res.json()) as DeviceStatus;
}

export async function deviceConnect(req: DeviceConnectRequest): Promise<DeviceStatus> {
  return statusOrThrow(await backendPostJson('/api/device/connect', req));
}

export async function deviceDisconnect(): Promise<DeviceStatus> {
  return statusOrThrow(await backendPostJson('/api/device/disconnect', {}));
}

// ── Pure presentation helpers (unit-tested) ───────────────────────────────────

export type DeviceLevel = 'ok' | 'action' | 'error' | 'off';

export interface DeviceSummary {
  level: DeviceLevel;
  message: string;
  /** true when a live lease is held (button should show "Disconnect"). */
  connected: boolean;
}

/** Map a device status to a headline for the panel. */
export function deviceSummary(status: DeviceStatus | null): DeviceSummary {
  if (!status || status.state === 'disconnected') {
    return { level: 'off', message: 'Not connected to a device.', connected: false };
  }
  const via = status.target?.useAdb ? 'USB (adb)' : status.target ? status.target.host : '';
  switch (status.state) {
    case 'connecting':
      return { level: 'action', message: 'Connecting…', connected: false };
    case 'connected':
      return { level: 'ok', message: via ? `Connected via ${via}.` : 'Connected.', connected: true };
    case 'reconnecting':
      return { level: 'action', message: 'Link lost — reconnecting… (a game relaunch is normal)', connected: true };
    case 'busy':
      return { level: 'error', message: 'Device is in use by another editor. Disconnect it there, or relaunch the game.', connected: false };
    case 'error':
      return { level: 'error', message: status.detail ? `Couldn’t connect: ${status.detail}` : 'Couldn’t connect to the device.', connected: false };
    default:
      return { level: 'off', message: 'Not connected to a device.', connected: false };
  }
}

/** The connect/disconnect button label for a status + in-flight flag. */
export function deviceButtonLabel(status: DeviceStatus | null, busy: boolean): string {
  if (busy) return 'Working…';
  return deviceSummary(status).connected ? 'Disconnect' : 'Connect';
}

/** Rudimentary IPv4 check so Connect can gate an obviously-empty/bad address (WiFi mode only). */
export function looksLikeIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}
