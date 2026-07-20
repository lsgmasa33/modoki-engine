/** Pure helpers for decoding the device bridge's replies — no MCP-SDK dependency, so they're
 *  directly unit-testable (the device-MCP twin of result.ts). */

/** Parse a device reply that may already be an object or a `safeStringify`'d JSON string. */
export function parseReply<T>(raw: unknown): T {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
  }
  return raw as T;
}

/** The device's JS bridge signals a FAILED handler by RETURNING an error string (not throwing) —
 *  `handleEval` returns `Error: …`, the router default returns `Unknown method: …` — which the
 *  transport resolves as a normal `result`. Detect that convention so `device_eval`/`device_tap`/
 *  `device_drag` flag `isError` instead of reporting success (F9/F15). */
export function isDeviceError(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith('Error:') || v.startsWith('Unknown method:'));
}

/** The device-lease status from `/api/device/status` (and returned by connect/disconnect). */
export interface LeaseStatus {
  state: string;
  target: { host: string; port: number; useAdb: boolean } | null;
  lastTarget: { ip: string; useAdb: boolean } | null;
  detail?: string;
}

/** One-line human summary of the lease status — shared by device_status / device_connect /
 *  device_disconnect so they report the lease identically. */
export function describeLease(s: LeaseStatus): string {
  if (s.state === 'connected' && s.target) {
    const how = s.target.useAdb ? 'adb (USB)' : `WiFi ${s.target.host}`;
    return `Device connected via ${how}:${s.target.port}. device_* tools proxy through Modoki's lease.`;
  }
  if (s.state === 'disconnected' || s.state === 'error') {
    const hint = s.lastTarget?.ip ? ` (last: ${s.lastTarget.useAdb ? 'adb' : s.lastTarget.ip})` : '';
    return (
      `No device connected (state: ${s.state}${s.detail ? `, ${s.detail}` : ''})${hint}. ` +
      `Connect with device_connect (ip="<device IP from the game's debug menu>" or useAdb:true for ` +
      `Android over USB; bare = reconnect the last target), or the editor AI panel → Connect a Device.`
    );
  }
  return `Device lease is ${s.state}${s.detail ? ` (${s.detail})` : ''} — Modoki is handling it; retry shortly.`;
}

/** Decode a native screenshot reply — a bare `data:` URL, or `{image, imageWidth, ...}` — into the
 *  data URL + a human info string, or an error. */
export function decodeScreenshotReply(raw: unknown): { dataUrl: string; info: string } | { error: string } {
  if (isDeviceError(raw)) return { error: raw }; // a bare `Error: …` reply (e.g. no canvas mounted)
  let dataUrl: string;
  let info: string;
  if (typeof raw === 'string' && raw.startsWith('data:')) {
    dataUrl = raw;
    info = 'Screenshot via device lease.';
  } else {
    const r = parseReply<Record<string, unknown>>(raw);
    dataUrl = r.image as string;
    info = `${r.imageWidth}x${r.imageHeight} (from ${r.screenWidth}x${r.screenHeight}).`;
  }
  if (!dataUrl || (typeof dataUrl === 'string' && dataUrl.startsWith('Error:'))) {
    return { error: (typeof dataUrl === 'string' && dataUrl) || 'No image data' };
  }
  return { dataUrl, info };
}
