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
  /** `serial` is the adb device THIS lease resolved at connect time (#149) — carried on the status
   *  so a UI showing "connected" can also say which of several attached phones it means. */
  target: { host: string; port: number; useAdb: boolean; serial?: string } | null;
  /** Last chosen IP/adb/serial (persisted server-side per clone) — used to pre-fill the form. */
  lastTarget?: { ip: string; useAdb: boolean; serial?: string } | null;
  detail?: string;
}

export interface DeviceConnectRequest {
  ip?: string;
  useAdb?: boolean;
  port?: number;
  /** WHICH Android, when several are attached (#149) — an adb serial from `fetchDeviceList()`.
   *  Only meaningful with `useAdb`; omitted lets the backend fall back to its own preference. */
  serial?: string;
}

// ── Device picker (#149) — "Use adb" with several Androids attached needs a way to say WHICH one.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Who holds a device already — mirrors the backend's `DeviceClaim` (`deviceClaims.ts`). Kept as a
 *  separate type rather than imported: this package has no dependency on the Electron-only backend
 *  plugin, so the shape is duplicated at the wire boundary like the rest of this file's types. */
export interface DeviceClaim {
  deviceId: string;
  clone: string;
  branch: string;
  pid: number;
  guid?: string;
  at: number;
  label?: string;
  purpose?: string;
}

/** One Android from `adb devices -l`. `state` is adb's own word (`device`/`unauthorized`/`offline`)
 *  kept raw rather than reduced to a boolean — see `androidDevices.ts` for why: `unauthorized` and
 *  `offline` are each fixable from the phone, and collapsing them into "not usable" hides the fix. */
export interface AndroidDeviceRow {
  serial: string;
  state: string;
  model?: string;
  /** What the PHONE calls itself — "Galaxy A23 5G" rather than the model code "SC_56C" (#149).
   *  Absent when the device would not answer (unauthorized, or a vendor that reports nothing). */
  name?: string;
  transportId?: string;
  usable: boolean;
  claim: DeviceClaim | null;
}

export interface IosDeviceRow {
  udid: string;
  name: string;
  connected: boolean;
  productType?: string;
  osVersion?: string;
  claim: DeviceClaim | null;
}

export interface DeviceListReply {
  android: AndroidDeviceRow[];
  ios: IosDeviceRow[];
  /** A WiFi lease claims by IP, so it can't sit in `android[]`/`ios[]` — surfaced separately so a
   *  picker can still show "someone already holds 192.168.1.42" (see the backend route comment). */
  otherClaims: DeviceClaim[];
  adb: { present: boolean; path?: string };
  /** WHO IS ASKING — this backend's own clone path + pid (#149). Needed to tell your OWN claim from
   *  a sibling clone's: the common case is that THIS editor holds the device, and without `self` a
   *  picker renders the phone you are connected to as "held by someone" and refuses to select it. */
  self?: { clone: string; pid: number };
  /** Set when adb itself is missing, so the panel can say THAT instead of rendering an empty list
   *  that reads as "no devices attached". */
  note?: string;
}

export async function fetchDeviceList(signal?: AbortSignal): Promise<DeviceListReply | null> {
  try {
    const res = await backendFetch('/api/device/list', signal ? { signal } : undefined);
    if (!res.ok) return null;
    return (await res.json()) as DeviceListReply;
  } catch {
    return null; // backend not reachable — same degrade-gracefully contract as fetchDeviceStatus
  }
}

/** The row's display label — the model when adb could read one, else the serial alone (an
 *  `unauthorized` device has no model, since adb can't query properties before the phone trusts
 *  this Mac's key). */
export function androidRowLabel(row: AndroidDeviceRow): string {
  // The phone's own name first: `adb devices -l` only knows MODEL CODES, and `SC_56C` vs
  // `SM_S901U1` is exactly the pair a human with two Samsungs on the desk cannot tell apart.
  const human = row.name ?? row.model;
  return human ? `${human} — ${row.serial}` : row.serial;
}

/** The last path segment of a clone root — `modoki-ai3`, not `/Users/…/Projects/modoki-ai3`.
 *
 *  The claim stores the ABSOLUTE path, and it should: a backend refusal is read in a terminal where
 *  the full path is the thing you act on. This row is a ~250px strip in a side panel, where the same
 *  string wraps onto two lines and pushes the device name out of view (measured in the running
 *  editor) — and the leading directories are identical across every clone on this machine, so they
 *  are the part carrying no information. Same fact, sized for where it is read. */
function cloneName(clone: string): string {
  const parts = clone.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clone;
}

/** A short note on who holds the row, or why it can't be picked — null when it's free and usable.
 *  Distinct from `androidRowSelectable` because a non-`device` state and a foreign claim are two
 *  different reasons to show as unavailable, and this is the text that explains either one. */
export function androidRowNote(row: AndroidDeviceRow, thisClone?: string): string | null {
  // Your own claim is not a warning — it is you, and naming your own clone path back at yourself
  // reads as a collision that isn't one.
  if (row.claim && row.claim.clone === thisClone) return 'in use by this editor';
  if (row.claim) return `held by ${cloneName(row.claim.clone)} (pid ${row.claim.pid})`;
  if (!row.usable) return row.state;
  return null;
}

/** Selectable = adb reports it as `device` AND no other clone already claims it. A device claimed
 *  by THIS clone (e.g. a stale claim from an earlier connect) is still selectable — only a FOREIGN
 *  claim blocks the row. */
export function androidRowSelectable(row: AndroidDeviceRow, thisClone?: string): boolean {
  if (!row.usable) return false;
  if (!row.claim) return true;
  return thisClone !== undefined && row.claim.clone === thisClone;
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
