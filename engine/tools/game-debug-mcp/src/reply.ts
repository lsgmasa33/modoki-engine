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
  // Not a bare `startsWith`: the backend fronts a synthetic-fallback reply with a banner line, a
  // refusal included, and the prefix test read every such refusal as a success (#1223 P3).
  return isDeviceFailureText(v);
}

// ── device_native_logs reply shape (#648) ──────────────────────────────────
export type NativeLogsReply =
  | { ok: true; logs: string[]; error?: string }
  | { ok: false; got: string };

/** Decode `nativeLogs`. The app side answers a BARE ARRAY on the happy path and
 *  `{logs, error}` only when the native plugin had something extra to say — because the value
 *  originates in Swift/Kotlin in the INSTALLED BINARY while this MCP and the JS bundle version
 *  independently, so both shapes are live on the wire at once (the #644 lesson, one layer down).
 *
 *  The `error` half is the point: `bridge.ts` used to destructure `{ logs }` and drop the
 *  declared `error` field, so `{logs: [], error: 'OSLogStore denied'}` reached the reader as
 *  "No logs." — *could not look* rendered as *nothing is there*. Those are opposite findings.
 *  #670 is the sibling case where the same tool answers about the WRONG DEVICE. */
export function parseNativeLogsReply(raw: unknown): NativeLogsReply {
  const v = parseReply<unknown>(raw);
  if (v == null) return { ok: true, logs: [] }; // a quiet log is an ANSWER, not a failure
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return { ok: true, logs: v as string[] };
  if (typeof v === 'object' && 'logs' in v) {
    const o = v as { logs: unknown; error?: unknown };
    if (Array.isArray(o.logs) && o.logs.every((s) => typeof s === 'string')) {
      return { ok: true, logs: o.logs as string[], ...(typeof o.error === 'string' && o.error ? { error: o.error } : {}) };
    }
  }
  return { ok: false, got: describeShape(v) };
}

// `describeShape` moved to `engine/tools/shared/mcpResult.ts` (#648) once the editor MCP and the
// backend router needed the same refusal vocabulary. Re-exported so this module's existing
// importers are unchanged. `mcpResult.ts` has ZERO imports of its own, so pulling it in here does
// not cost this file the "no MCP-SDK dependency" property its header promises.
export { describeShape } from '../../shared/mcpResult.js';
import { describeShape } from '../../shared/mcpResult.js';
import { isDeviceFailureText } from '../../shared/deviceRefusal.js';
import type { BackendIdentity } from '../../shared/identity.js';

// ── device_list reply shape (#1211 C-21) ───────────────────────────────────
/** `clone` is typed as the route sends it, but the decoder does not require it: the claims file is
 *  hand-editable, and `describeClaim` renders a record without one as unreadable. */
export type DeviceListClaim = { deviceId: string; clone: string; branch: string; pid: number; guid?: string; at: number; label?: string; purpose?: string; owner?: string };

export type DeviceListReply = {
  /** `name` is what the PHONE calls itself ("Galaxy A23 5G"); `model` is only ever the model CODE
   *  ("SC_56C"), which is the string a human cannot match to a handset on the desk. Prefer `name`
   *  wherever one is shown, and fall back to `model` — a device that would not answer has neither. */
  android: Array<{ serial: string; state: string; model?: string; name?: string; transportId?: string; usable: boolean; claim: DeviceListClaim | null }>;
  /** `devicectl` is set when `xcrun devicectl` itself listed the device (iOS 17+/CoreDevice) —
   *  absent for one only the legacy `xctrace` listing can see (#143). It is what the editor's
   *  Build-menu target picker reads to decide a hands-free install vs an Xcode handoff (#170). */
  ios: Array<{ udid: string; name: string; connected: boolean; productType?: string; osVersion?: string; devicectl?: boolean; claim: DeviceListClaim | null }>;
  /** Claims keyed by WiFi address (`ip:<host>`) — no hardware row exists for these, so they would be
   *  invisible in either list above without being surfaced separately. */
  otherClaims: DeviceListClaim[];
  adb: { present: boolean; path?: string };
  /** Present only when adb is absent — "no adb" and "no Android devices" are different problems
   *  with different fixes, so this is a field, not folded into an empty `android` array. */
  note?: string;
  /** The iOS counterpart (#1096): present only when `ios` is EMPTY *and* a listing source broke, so
   *  an empty list is never reported as "no iPhone attached" when nobody actually managed to look. */
  iosNote?: string;
  /** WHO ASKED — the editor process answering the route. Absent from a backend older than the field;
   *  without it a claim cannot be told apart from a sibling's, so it is rendered as one. */
  self?: { clone: string; pid: number };
};

/** Decode `/api/device/list` (§9-bis, #1211 C-21). Only the keys the renderer dereferences without a
 *  guard are required — a missing one used to throw into `caughtFailure` ("relaunch the app") or,
 *  worse, read as an empty listing. `self` and the notes are optional because older backends omit them. */
export function decodeDeviceListReply(raw: unknown): { ok: true; reply: DeviceListReply } | { ok: false; got: string } {
  const v = parseReply<unknown>(raw);
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  // A claim only has to be an OBJECT: the claims file is hand-editable and `readClaims` checks only
  // `deviceId`, so one corrupt record must not turn the whole listing into "restart the editor".
  // `describeClaim` renders a record with no `clone` as unreadable instead.
  const claimOk = (c: unknown) => c === null || isObj(c);
  if (
    isObj(v)
    && Array.isArray(v.android) && v.android.every((d) => isObj(d) && typeof d.serial === 'string' && claimOk(d.claim ?? null))
    && Array.isArray(v.ios) && v.ios.every((d) => isObj(d) && typeof d.udid === 'string' && claimOk(d.claim ?? null))
    && Array.isArray(v.otherClaims) && v.otherClaims.every((c) => isObj(c) && typeof c.deviceId === 'string' && claimOk(c))
    && isObj(v.adb) && typeof v.adb.present === 'boolean'
  ) {
    const self = isObj(v.self) && typeof v.self.clone === 'string' && typeof v.self.pid === 'number'
      ? { clone: v.self.clone, pid: v.self.pid } : undefined;
    return { ok: true, reply: { ...(v as unknown as DeviceListReply), self } };
  }
  return { ok: false, got: describeShape(v) };
}

// ── Every editor-backend reply is DECODED (#1313, §9-bis) ────────────────────
/** What a backend decoder returns. `got` describes the shape it could not read, for the refusal. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; got: string };
export type Decoder<T> = (raw: unknown) => Decoded<T>;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** `device_list`'s decoder in the shape the backend helpers take. */
export const deviceListDecoder: Decoder<DeviceListReply> = (raw) => {
  const d = decodeDeviceListReply(raw);
  return d.ok ? { ok: true, value: d.reply } : d;
};

/** Decode `/api/device/status` — and `/api/device/connect` / `/api/device/disconnect`, which answer
 *  the same `DeviceConnectStatus`. The fields required are the ones a MISREAD turns into a wrong
 *  answer rather than a crash: an absent `useAdb` read as "not adb" sent an adb lease down the native
 *  screenshot path, and an absent `target` on a connected lease read as "no lease". A disconnected
 *  status may omit `target`: that is the same answer as `null`. */
export function decodeLeaseStatus(raw: unknown): Decoded<LeaseStatus> {
  const v = parseReply<unknown>(raw);
  if (!isObject(v) || typeof v.state !== 'string') return { ok: false, got: describeShape(v) };
  const t = v.target;
  const targetOk = t === null || t === undefined
    ? v.state !== 'connected'
    : isObject(t) && typeof t.port === 'number' && typeof t.useAdb === 'boolean'
      && (t.serial === undefined || typeof t.serial === 'string')
      && (t.udid === undefined || typeof t.udid === 'string');
  const last = v.lastTarget;
  if (!targetOk || !(last === null || last === undefined || isObject(last))) {
    return { ok: false, got: `${describeShape(v)}; target: ${describeShape(t)}` };
  }
  return { ok: true, value: { ...(v as unknown as LeaseStatus), target: (t ?? null) as LeaseStatus['target'], lastTarget: (last ?? null) as LeaseStatus['lastTarget'] } };
}

/** The `/api/device/request` envelope: the device's own reply under `result`, with any sibling
 *  fields the route adds about the read itself (truncation, `unverified`). Every 2xx the route sends
 *  carries a `result` KEY — without one, `deviceRequest` handed `undefined` to all the relay tools,
 *  which read it as a successful empty answer. */
export type DeviceRequestReply = Record<string, unknown> & { result: unknown };
export function decodeDeviceRequestReply(raw: unknown): Decoded<DeviceRequestReply> {
  return isObject(raw) && 'result' in raw
    ? { ok: true, value: raw as DeviceRequestReply }
    : { ok: false, got: describeShape(raw) };
}

/** Decode `/api/identity`. Only `repoRoot` is load-bearing: the wrong-clone check compares it. */
export function decodeIdentity(raw: unknown): Decoded<BackendIdentity> {
  return isObject(raw) && typeof raw.repoRoot === 'string'
    ? { ok: true, value: raw as unknown as BackendIdentity }
    : { ok: false, got: describeShape(raw) };
}

/** Decode `/api/toolchain` down to the one part this MCP reads. A missing `adb.present` used to read
 *  as "adb is not installed". */
export function decodeToolchain(raw: unknown): Decoded<{ adb: { present: boolean; path?: string } }> {
  if (isObject(raw) && isObject(raw.adb) && typeof raw.adb.present === 'boolean'
    && (raw.adb.path === undefined || raw.adb.path === null || typeof raw.adb.path === 'string')) {
    return { ok: true, value: { adb: { present: raw.adb.present, ...(typeof raw.adb.path === 'string' ? { path: raw.adb.path } : {}) } } };
  }
  return { ok: false, got: isObject(raw) ? `${describeShape(raw)}; adb: ${describeShape(raw.adb)}` : describeShape(raw) };
}

/** The claim half of a `device_list` row. The route's `self` is what tells YOUR clone's claim from a
 *  sibling's — ignoring it rendered the lease this session holds as "CLAIMED by <some path>", which
 *  reads as a collision and sends the agent off to find another phone. Same `clone ===` rule as the
 *  editor's Build-menu `claimNote`. */
export function describeClaim(c: DeviceListClaim | null, self: DeviceListReply['self']): string {
  if (!c) return '';
  if (typeof c.clone !== 'string') return ' — CLAIMED by an unreadable claim record (no clone; check ~/.modoki/device-claims.json)';
  const why = c.purpose ? `, ${c.purpose}` : '';
  const trim = (p: string) => p.replace(/[\\/]+$/, '');
  if (self && trim(c.clone) === trim(self.clone)) {
    // A CLI claim (#285) carries `pid: 0` and an `owner` token — "pid 0" would name no process.
    if (c.owner) return ` — held by this clone's CLI (owner ${c.owner}${why})`;
    return c.pid === self.pid
      ? ` — held by THIS editor (your lease${why})`
      : ` — held by this clone, another process (pid ${c.pid}${why})`;
  }
  return ` — CLAIMED by ${c.clone} (${c.branch})${why}`;
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
  /** `useUsb`/`udid`: an iOS lease tunnelled over USB by go-ios (#1065). */
  guid?: string;
  /** `serial` (#149): the adb serial the LEASE resolved at connect time — present only for an adb
   *  target, so a screenshot can be aimed at the SAME phone the lease drives rather than a guessed
   *  one. `DEVICE_STATUS_TARGET_FIELDS` (mcp-tools.ts) is type-checked equal to these keys, and
   *  `deviceStatusShape.test.ts` compares that list against `DeviceConnectStatus`. */
  target: { host: string; port: number; useAdb: boolean; serial?: string; useUsb?: boolean; udid?: string } | null;
  lastTarget: { ip: string; useAdb: boolean; useUsb?: boolean } | null;
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
    const where = s.target.useUsb
      ? `USB (iOS, go-ios forward${s.target.udid ? ` to ${s.target.udid}` : ''}) — host tunnel 127.0.0.1:${s.target.port}`
      : s.target.useAdb
        ? `adb (USB) — host tunnel 127.0.0.1:${s.target.port}`
        : `WiFi ${s.target.host}:${s.target.port}`;
    return `Device connected via ${where}. device_* tools proxy through Modoki's lease.`;
  }
  if (s.state === 'disconnected' || s.state === 'error') {
    const last = s.lastTarget?.useUsb ? 'USB (iOS)' : s.lastTarget?.useAdb ? 'adb' : s.lastTarget?.ip;
    const hint = last ? ` (last: ${last})` : '';
    return (
      `No device connected (state: ${s.state}${s.detail ? `, ${s.detail}` : ''})${hint}. ` +
      `Connect with device_connect (ip="<device IP from the game's debug menu>", useAdb:true for ` +
      `Android over USB, or useUsb:true for iOS over USB; bare = reconnect the last target), or the ` +
      `editor AI panel → Connect a Device.`
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
