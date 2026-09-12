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
  target: { host: string; port: number; useAdb: boolean; useUsb?: boolean; serial?: string; udid?: string } | null;
  /** Last chosen IP/adb/usb/serial/udid (persisted server-side per clone) — used to pre-fill the form. */
  lastTarget?: { ip: string; useAdb: boolean; useUsb?: boolean; serial?: string; udid?: string } | null;
  detail?: string;
}

export interface DeviceConnectRequest {
  ip?: string;
  useAdb?: boolean;
  /** iOS over USB through go-ios `ios forward` (#1065). */
  useUsb?: boolean;
  port?: number;
  /** WHICH Android, when several are attached (#149) — an adb serial from `fetchDeviceList()`.
   *  Only meaningful with `useAdb`; omitted lets the backend fall back to its own preference. */
  serial?: string;
  /** WHICH iOS device, when several are attached over USB — a UDID. Only meaningful with `useUsb`. */
  udid?: string;
}

/** How the panel connects. One field, because the three are mutually exclusive — two checkboxes
 *  could both be ticked, and the backend refuses that combination. */
export type DeviceConnectMode = 'wifi' | 'adb' | 'usb';

/** The mode a remembered target implies, for the one-shot form hydration. */
export function modeOfTarget(t: { useAdb: boolean; useUsb?: boolean } | null | undefined): DeviceConnectMode {
  return t?.useUsb ? 'usb' : t?.useAdb ? 'adb' : 'wifi';
}

/** The panel's connect decision: the request to send, or the note that says why not (#149, #1065).
 *  A PURE function so the rule is unit-tested — the section only renders it. `iosAttached`/
 *  `androidAttached` are the SELECTABLE rows; with several attached and none picked the choice is
 *  ambiguous, and connecting anyway would leave the backend to refuse (or, before #149, to guess). */
export function connectRequestFor(o: {
  mode: DeviceConnectMode; ip: string; serial: string | null; udid: string | null;
  androidAttached: number; iosAttached: number;
}): { request: DeviceConnectRequest } | { note: string } {
  if (o.mode === 'adb') {
    if (o.androidAttached > 1 && !o.serial) return { note: 'Pick which Android to connect to.' };
    return { request: { useAdb: true, ...(o.serial ? { serial: o.serial } : {}) } };
  }
  if (o.mode === 'usb') {
    if (o.iosAttached > 1 && !o.udid) return { note: 'Pick which iPhone/iPad to connect to.' };
    return { request: { useUsb: true, ...(o.udid ? { udid: o.udid } : {}) } };
  }
  if (!looksLikeIp(o.ip)) return { note: 'Enter the device IP shown in its debug menu (or connect over USB).' };
  return { request: { ip: o.ip.trim() } };
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
  /** `devicectl` itself listed this device (iOS 17+/CoreDevice) — so it can be installed to
   *  hands-free. Absent for a device only the legacy `xctrace` listing sees (#143), which builds
   *  via an Xcode handoff instead. The Build-menu picker writes `iosDevicectlId` from exactly this
   *  (#170); see the field's note in `wdaLauncher.ts` for why it isn't inferred from `productType`. */
  devicectl?: boolean;
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
  /** The iOS counterpart of `note` (#1096): set only when `ios` came back EMPTY *and* a listing
   *  source (devicectl / xctrace / go-ios) failed, so a picker can say "could not check" instead of
   *  "no iPhone is paired". Every consumer of `note` must render this too — an empty iOS list with
   *  a reason nobody shows is the same silent absence #1096 exists to remove. */
  iosNote?: string;
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

/** One row of the device pull-down, whichever platform it lists. The picker renders these and knows
 *  nothing about adb serials or UDIDs — so the Android and iOS pickers are one component, and the
 *  per-platform rules stay here where they are tested. */
export interface PickerRow { id: string; label: string; note: string | null; selectable: boolean }

export function androidPickerRows(rows: AndroidDeviceRow[], thisClone?: string): PickerRow[] {
  return rows.map((row) => ({
    id: row.serial, label: androidRowLabel(row), note: androidRowNote(row, thisClone), selectable: androidRowSelectable(row, thisClone),
  }));
}

/** The iOS rows for "Use USB (iOS)" (#1065). These come from `/api/device/list`'s Apple listing, which
 *  is NOT what the USB connect resolves through — the backend picks from go-ios's usbmuxd list and
 *  refuses a UDID usbmuxd cannot see. So a row here is a CANDIDATE; a phone Xcode lists but usbmuxd
 *  lost is refused at connect with "replug it", which is the honest place to find that out. */
export function iosPickerRows(rows: IosDeviceRow[], thisClone?: string): PickerRow[] {
  return rows.map((row) => {
    const own = !!row.claim && row.claim.clone === thisClone;
    return {
      id: row.udid,
      label: `${row.name} — ${row.udid}`,
      note: own ? 'in use by this editor'
        : row.claim ? `held by ${cloneName(row.claim.clone)} (pid ${row.claim.pid})`
          : row.connected ? null : 'not connected',
      selectable: row.connected && (!row.claim || own),
    };
  });
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
