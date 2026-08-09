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

// ── Input fidelity (#32) ──────────────────────────────────────────────────
// The literals a device_* reply / device_status line can report. Kept as named constants (rather
// than inline string literals) so `deviceInputMechanismParity.test.ts` can regex-match them by
// name — this MCP server, the in-page device bridge (`engine/app/debug/bridge.ts`, a bundled
// browser script shipped inside the game), and the backend's two trusted routes
// (`engine/plugins/backend/deviceCdp.ts` / `deviceWda.ts`) are separate runtimes/packages with no
// shared module graph, so the values are necessarily duplicated rather than imported. What they
// must agree on is the STATEMENT: 'synthetic' is bridge.ts's `INPUT_MECHANISM` (the in-page
// dispatch every input handler falls back to), 'trusted-cdp' is deviceCdp.ts's Android route,
// 'trusted-wda' is deviceWda.ts's iOS route. Phase 0 shipped a single hardcoded 'synthetic'
// reported unconditionally; from Phase 1 the value is a LIVE probe (the backend's
// `/api/device/status` reports which mechanism is actually available right now).
export const SYNTHETIC_MECHANISM = 'synthetic' as const;
export const TRUSTED_CDP_MECHANISM = 'trusted-cdp' as const;
export const TRUSTED_WDA_MECHANISM = 'trusted-wda' as const;

/** The device-lease status from `/api/device/status` (and returned by connect/disconnect). */
export interface LeaseStatus {
  state: string;
  target: { host: string; port: number; useAdb: boolean } | null;
  lastTarget: { ip: string; useAdb: boolean } | null;
  detail?: string;
  /** LIVE probe result (#32) — present only when `state === 'connected'` (a disconnected lease has
   *  no mechanism to report). 'trusted-cdp' when Android CDP injection is reachable right now,
   *  'trusted-wda' when iOS WebDriverAgent is (Phase 2), 'synthetic' otherwise (no adb, no matching
   *  webview socket, WDA not running, …). Never a hardcoded constant — see
   *  `deviceInputMechanismParity.test.ts`.
   *
   *  Typed to admit a value this build does not know (`string & {}`) on purpose. It arrives off the
   *  wire from a backend that can be NEWER than this MCP process — `.mcp.json` runs the server from
   *  source via tsx, so a long-lived session holds whatever the file said when it started, while the
   *  editor backend is relaunched freely. Narrowing the type to the three known literals would let
   *  the reporter treat a future mechanism as impossible; it isn't (#107). */
  inputMechanism?: typeof SYNTHETIC_MECHANISM | typeof TRUSTED_CDP_MECHANISM | typeof TRUSTED_WDA_MECHANISM | (string & {});
  /** Which ops the reported mechanism actually covers. Only the WDA route sets it, because iOS
   *  routes a NARROWER set than Android (tap/drag only) — naming them is what keeps `device_status`
   *  from implying every input op is trusted when three of them are not. */
  trustedOps?: string[];
}

/** One-line human summary of the lease status — shared by device_status / device_connect /
 *  device_disconnect so they report the lease identically. */
export function describeLease(s: LeaseStatus): string {
  if (s.state === 'connected' && s.target) {
    // ⚠️ On adb the port is the HOST end of the tunnel, derived per clone since #158
    // (`9095 + (backend−5179)`), NOT the port the app listens on — those were the same number
    // until then, and this string still read as if they were. The label matters because
    // `device_connect {port}` means the DEVICE port: an agent that read `adb (USB):9097` here and
    // passed 9097 back would forward `tcp:9097 → tcp:9097` on the phone, where nothing is
    // listening — and `explainConnectFailure`'s advice stays silent, because it only fires on the
    // default 9095. Naming the side is what stops the round trip.
    const where = s.target.useAdb
      ? `adb (USB) — host tunnel 127.0.0.1:${s.target.port}`
      : `WiFi ${s.target.host}:${s.target.port}`;
    return `Device connected via ${where}. device_* tools proxy through Modoki's lease.`;
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

/** The `Input mechanism:` line device_status prints, from the backend's LIVE probe (#32).
 *
 *  Split out of the tool handler and made pure for #107, which reported `device_status` printing
 *  `synthetic` while `/api/device/status` said `trusted-wda` at the same moment. The literals were
 *  guarded for parity across all four surfaces and agreed; what nothing asserted was what the
 *  REPORTER does with a given value — so the defect sat in the one layer with no test. Rendering is
 *  now a pure function of the status, and `deviceInputFidelity.test.ts` renders every case.
 *
 *  The residual defect that fix exposed, and the reason the disconnected case is decided by `state`
 *  here rather than by falling off the end of the mechanism chain: an UNRECOGNISED mechanism used
 *  to land in the final else and print "no device is connected" — flatly contradicting the lease
 *  line printed directly above it, and doing so in exactly the version-skew case (an older MCP
 *  process against a newer backend) that this class of bug comes from. An unknown value is now
 *  reported AS unknown, naming what the backend actually said, because an agent asking "may I
 *  trust input here?" is better served by "this build cannot tell you" than by a confident lie in
 *  either direction. */
export function describeInputFidelity(s: LeaseStatus): string {
  // "A refusal never claims a mechanism" — the same rule the input handlers follow. Decided by the
  // lease state, which is the fact that makes it true, not by the absence of a mechanism string.
  if (s.state !== 'connected') {
    return 'Input mechanism: unknown — no device is connected, so there is nothing to probe (connect first; device_connect).';
  }
  switch (s.inputMechanism) {
    case TRUSTED_CDP_MECHANISM:
      return `Input mechanism: ${TRUSTED_CDP_MECHANISM} for device_tap/drag/press_key/hover/scroll (OS-level trusted input via CDP — #32 Phase 1). device_pointer/type_text are still ${SYNTHETIC_MECHANISM}.`;
    // #32 Phase 2 (iOS/WebDriverAgent) routes a NARROWER set than Android — only tap and drag,
    // because a trusted key reaches just a focused element, WDA has no wheel action, and a
    // touchscreen has no hover (all measured on the iPhone Air). So the ops are named from the
    // backend's own `trustedOps` rather than assumed: reporting "trusted" for the whole surface
    // when three of its ops are synthetic is the false-fidelity claim this line exists to stop.
    case TRUSTED_WDA_MECHANISM:
      return `Input mechanism: ${TRUSTED_WDA_MECHANISM} for ${(s.trustedOps ?? ['tap', 'drag']).map((o) => `device_${o}`).join('/')} (OS-level trusted input via WebDriverAgent — #32 Phase 2). Every OTHER input op is still ${SYNTHETIC_MECHANISM} on iOS, and says so in its reply.`;
    case SYNTHETIC_MECHANISM:
      return `Input mechanism: ${SYNTHETIC_MECHANISM} (device_tap/drag/pointer/press_key/hover/scroll/type_text dispatch synthetic DOM events, not OS-level trusted input — see #32).`;
    case undefined:
      // Connected, and the backend named no mechanism at all — an OLDER backend, pre-#32-Phase-1.
      return 'Input mechanism: unreported — this editor backend predates the live input-fidelity probe (#32 Phase 1), so it cannot say. Treat input as synthetic unless a device_* reply says otherwise; its own `[input:…]` stamp is authoritative.';
    default:
      // Connected, and the backend named something this build has never heard of — it is NEWER
      // than this MCP process (which tsx snapshots at session start). Say exactly that, and point
      // at the fix, rather than guessing a bucket.
      return `Input mechanism: ${s.inputMechanism} — reported by the backend but unknown to this MCP build, which is therefore older than the editor it is driving. Restart the MCP server (or the Claude session) to pick up the current source; until then trust each device_* reply's own \`[input:…]\` stamp over this line.`;
  }
}

/** Decode a screenshot reply — a bare `data:` URL, or `{image, imageWidth, ...}` — into the data
 *  URL + a human info string, or an error.
 *
 *  `warning` is carried through UNCHANGED when present (#102): the backend's WebDriverAgent capture
 *  attaches the coordinate-space caveat there, and this decoder is the only thing between it and
 *  the reply text. Dropping it would leave a full-DEVICE-screen image looking exactly like a page
 *  capture whose pixels are safe to feed to `device_tap` — which they are not. */
export function decodeScreenshotReply(raw: unknown): { dataUrl: string; info: string; warning?: string; isWholeDevice?: boolean } | { error: string } {
  if (isDeviceError(raw)) return { error: raw }; // a bare `Error: …` reply (e.g. no canvas mounted)
  let dataUrl: string;
  let info: string;
  let warning: string | undefined;
  // Whether this image's pixels are the DEVICE screen rather than the page — the fact every caller
  // needs before it tells anyone to aim with them. Reported explicitly instead of leaving each
  // caller to sniff the info string.
  let isWholeDevice = false;
  if (typeof raw === 'string' && raw.startsWith('data:')) {
    dataUrl = raw;
    info = 'Screenshot via device lease.';
  } else {
    const r = parseReply<Record<string, unknown>>(raw);
    dataUrl = r.image as string;
    warning = typeof r.warning === 'string' ? r.warning : undefined;
    isWholeDevice = r.source === 'trusted-wda';
    info = isWholeDevice
      // A WDA capture has ONE resolution — the device screen — so the native path's "AxB (from CxD)"
      // scale line would print the same pair twice and imply a page-to-screen mapping that is
      // exactly what this capture does not have.
      ? `[wda] ${r.imageWidth}x${r.imageHeight} full device screen.`
      : `${r.imageWidth}x${r.imageHeight} (from ${r.screenWidth}x${r.screenHeight}).`;
  }
  if (!dataUrl || (typeof dataUrl === 'string' && dataUrl.startsWith('Error:'))) {
    return { error: (typeof dataUrl === 'string' && dataUrl) || 'No image data' };
  }
  return { dataUrl, info, ...(warning ? { warning } : {}), ...(isWholeDevice ? { isWholeDevice } : {}) };
}
