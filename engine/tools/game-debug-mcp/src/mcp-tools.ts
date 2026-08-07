/**
 * Device MCP tools — a THIN CLIENT of Modoki's device lease.
 *
 * These tools do NOT talk to the device directly. They proxy every request through the editor
 * backend's `/api/device/request`, which forwards it over Modoki's held lease socket. The device
 * connection is DELIBERATE + owned by Modoki (the human clicks Connect in the AI panel); this MCP
 * never discovers, never auto-connects, and never holds the lease GUID (it stays server-side).
 * See docs/debug-tools-mcp.md.
 *
 * Because the connection is owned by one backend per clone, there is a single device — no
 * `target: android|ios` param and no platform in the tool name. `device_status` reflects the
 * lease; if it isn't connected, the human connects in the editor.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDeviceToolDef, type DeviceToolResult } from './registry.js';
import { identityMismatch, tokenMismatchWarning, describeIdentity, type BackendIdentity } from '../../shared/identity.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, unlinkSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';

const pExecFile = promisify(execFile);
import {
  encodeEvalResult, encodeStructuredResult, extFor, describeScreenshot, isFailureBody,
  deviceFail, caughtFailure, deviceReplyFailure,
} from './result.js';
import { parseReply, isDeviceError, decodeScreenshotReply, describeLease, describeInputFidelity, SYNTHETIC_MECHANISM, type LeaseStatus } from './reply.js';

const BACKEND = (process.env.MODOKI_BACKEND ?? 'http://127.0.0.1:5179').replace(/\/$/, '');

// ── Input fidelity (#32) ──────────────────────────────────────────────────
// The literals + the line that renders them live in `reply.ts` (with `describeLease`, the other
// half of what device_status prints), because a pure module is testable by RENDERING it and this
// file is not. That move is #107's actual fix: the constants were always guarded for parity, but
// nothing ever asserted what the reporter DOES with a given value, which is the layer the bug
// was in. See `describeInputFidelity` there.

// ── The device eval surface's BOUNDARY (#101) ────────────────────────────────
// Input and screenshot are NOT agent ops: they are bridge-level switch cases
// (`engine/app/debug/bridge.ts`), and trusted input is dispatched HOST-SIDE by the backend
// (deviceCdp.ts / deviceWda.ts) because a page cannot dispatch a trusted event to itself. So
// `modoki.call('tap')` inside device_eval hits the router's `Unknown method:` default — and with
// no `api()` on the device surface there is no escape hatch either.
//
// The trap this text exists to close: `resolve-dom-point` / `resolve-entity-point` ARE ops, so a
// script can compute exactly where to tap and is then unable to tap. Today you learn that by
// writing the script and watching it fail.
//
// WHY THIS TEXT LIVES HERE rather than in the device's own `deviceEvalApi.ts` (whose editor twin
// carries its usage lines in the `eval-api` op): the editor renderer is always the current build,
// but the device app is a SHIPPED ARTIFACT that can be older than this server. Guidance kept
// on-device would report the old build's wording, and probing for a newer method (`modoki.describe()`)
// would hard-fail against every already-installed build. The ops LIST still comes from the device —
// it must, being generated from that build's registry — and only the guidance is composed here.
const DEVICE_EVAL_UNREACHABLE_OPS = ['tap', 'drag', 'pointer', 'press-key', 'hover', 'scroll', 'type-text', 'screenshot'] as const;
const DEVICE_EVAL_UNREACHABLE_SUMMARY =
  'NOT reachable from eval: input (tap/drag/pointer/press-key/hover/scroll/type-text) and screenshot are '
  + 'bridge-level methods, not agent ops — `modoki.call(\'tap\')` fails with `Unknown method:`. Use the '
  + 'device_* tools for those; they route trusted input host-side (CDP on Android, WebDriverAgent on iOS), '
  + 'which is exactly what an in-page call could not do.';

/** The guidance `device_eval_api` wraps around the device's own op list. */
function deviceEvalApiGuidance(): {
  usage: string[];
  absent: Record<string, string>;
  notReachable: { methods: string[]; why: string };
  note: string;
} {
  return {
    usage: [
      'modoki.call(op, params) — invoke any op above by its raw kebab-case name',
      'modoki.<camelCaseName>(params) — generated shortcut for each op above',
      'modoki.ops() — the same {op, method} listing, from inside eval code',
    ],
    absent: {
      'modoki.api(path, init)': 'editor-only — there is no editor backend for the device page to fetch; every device op already funnels through the lease',
      'modoki.composite(label, fn)': 'editor-only — there is no undo stack on device',
    },
    notReachable: { methods: [...DEVICE_EVAL_UNREACHABLE_OPS], why: DEVICE_EVAL_UNREACHABLE_SUMMARY },
    note: 'The op list comes from the CONNECTED BUILD\'s registry, so an older app reports fewer ops. Call device_eval_api again any time.',
  };
}

// ── WHICH editor is this pointed at? (S2.39) ─────────────────────────────────
// `.mcp.json` defaults MODOKI_BACKEND to 5179 for EVERY clone, and this server had no identity
// check whatsoever — so a `device_*` call from the work-ai2 clone drove the MAIN clone's editor,
// and therefore the MAIN clone's device lease, with every call reporting success. The editor MCP
// has warned about this since C6; the device MCP is the surface where it matters MORE, because a
// tap or a dispatch lands on a physical phone somebody else is using.
//
// Memoize only SUCCESS (the same lesson as the editor server's S2.1): a probe made while the
// editor is still booting must not disarm the warning for the life of the process.
let identityWarning: string | null = null;
let _identityProbe: Promise<void> | null = null;
/** The identity of the backend that answered, for `device_status` to report (S2.39). A lease
 *  summary that never says WHICH editor holds the lease is unusable when clones run side by side:
 *  every call succeeds while driving somebody else's device. The banner covers the MISMATCH case;
 *  this covers the ordinary one — "which backend am I on?" should not require a second tool. */
let backendIdentityLine: string | null = null;

async function ensureDeviceIdentity(): Promise<void> {
  if (_identityProbe) return _identityProbe;
  _identityProbe = (async () => {
    let identified = false;
    try {
      const id = (await backendGet('/api/identity')) as BackendIdentity;
      if (!id || typeof id.repoRoot !== 'string') return;
      backendIdentityLine = describeIdentity(id, BACKEND);
      identityWarning = tokenMismatchWarning(id, BACKEND) ?? identityMismatch(id, process.cwd(), BACKEND);
      if (identityWarning) console.error(identityWarning);
      identified = true;
    } catch { /* editor down / older backend — the real call reports it */ }
    finally { if (!identified) _identityProbe = null; }
  })();
  return _identityProbe;
}

/** Prepend the wrong-editor warning to a result. It makes every other byte a lie — the calls
 *  succeed, they just drive somebody else's device — so it is never the part that gets trimmed. */
function withIdentityBanner<T extends { content: Array<{ type: string; text?: string }> }>(r: T): T {
  if (!identityWarning) return r;
  const first = r.content[0];
  if (first && first.type === 'text') first.text = `${identityWarning}\n\n${first.text ?? ''}`;
  else r.content.unshift({ type: 'text', text: identityWarning } as T['content'][number]);
  return r;
}

// ── Android screenshots go through adb (NOT the lease) ───────────────────────
// A WebGL/WebGPU (Dawn/Vulkan) canvas inside an Android WebView is composited in a separate GPU
// surface, so the device's native `captureScreen` (rootView.draw / PixelCopy of the window) renders
// it BLACK — only the DOM HUD survives. `adb screencap` reads the post-composition framebuffer, so it
// captures the 3D scene + HUD together. It's a read-only side channel (no game commands), so it
// doesn't touch the lease. Used ONLY when the LEASE ITSELF is the adb-connected device (F2) — never
// just because some Android is on USB (that would screenshot the wrong device when the lease is a
// WiFi iPhone). iOS captures fine natively through the lease.

/** Screenshot dims from the last adb capture, so `device_tap`/`device_drag` can convert coordinates
 *  (the device's own `lastScreenInfo` is only set by native `captureScreen`, which Android skips). */
let adbScreenInfo: { imgW: number; imgH: number; nativeW: number; nativeH: number; lease: string } | null = null;

/** The fields `/api/device/status` actually returns — a local mirror of `DeviceConnectStatus`
 *  (`engine/plugins/backend/deviceConnection.ts`). This MCP is a separate package and cannot import
 *  that type, so the mirror is kept honest by a drift guard: `deviceStatusShape.test.ts` parses the
 *  real interface and fails if the two disagree.
 *
 *  WHY A MIRROR AND A GUARD (independent review, 2026-07-30). Two helpers here read fields that do
 *  not exist on the status payload — `target.platform` and `target.serial`/`target.deviceId` — each
 *  inside a `as {…}` cast that invented them. TypeScript cannot object to a cast, so both guards
 *  compiled, shipped, and could never fire, while their comments told every later reader the cases
 *  were covered. Reading the status through THIS type instead means an invented field is a compile
 *  error, and a field that disappears upstream is a red test. */
type DeviceStatusReply = {
  state?: string;
  guid?: string;
  target?: { host?: string; port?: number; useAdb?: boolean } | null;
  lastTarget?: { ip?: string; port?: number; useAdb?: boolean } | null;
  detail?: string;
};

/** The `target` keys the mirror above claims. Exported so the drift guard can compare them against
 *  the real interface without re-parsing this file's type declaration. */
export const DEVICE_STATUS_TARGET_FIELDS = ['host', 'port', 'useAdb'] as const;

/** Which device the lease currently points at, as a comparable key ("adb" / "192.168.1.5:8095"),
 *  or null when nothing is connected.
 *
 *  `adbScreenInfo` converts screenshot pixels to device pixels for `device_tap`/`device_drag`, and
 *  it was only invalidated by taking ANOTHER screenshot. So a lease that changed in between — the
 *  human reconnecting to a different phone in the AI panel, or device_connect to another IP — left
 *  the PREVIOUS device's dimensions in place, and a coordinate tap was scaled by the wrong ratio:
 *  it landed somewhere else entirely and reported success. Stamping the dims with the lease they
 *  were measured under makes that detectable rather than silent, and covers the human path too
 *  (this MCP is not told when the panel reconnects). */
async function leaseKey(): Promise<string | null> {
  try {
    const s = (await backendGet('/api/device/status')) as DeviceStatusReply;
    if (s?.state !== 'connected' || !s.target) return null;
    // NOTE the honest limit here (independent review, 2026-07-30). This used to read
    // `t.serial ?? t.deviceId` and claim it closed the USB-device-swap case — but neither field
    // exists on `DeviceConnectStatus` (see DEVICE_STATUS_TARGET_FIELDS below, drift-guarded), so
    // every adb lease keyed to the literal string 'adb:' and the check it feeds could never fire.
    // A guard that cannot fire is worse than none: its comment tells the next reader the case is
    // covered. The status route does not carry a device identity, so the stamp cannot distinguish
    // two adb leases; say so rather than imply otherwise. Swapping the USB phone WITHOUT
    // reconnecting can still leave the previous device's capture dims live — to close that
    // properly the lease has to report a serial, which is a deviceConnection change, not one here.
    return s.target.useAdb ? 'adb' : `${s.target.host}:${s.target.port}`;
  } catch { return null; }
}

/** The adb screenshot dims IF they were measured under the lease that is live right now.
 *  A mismatch drops them: aiming with no `screenInfo` is handled by the device (it falls back to
 *  its own last capture), whereas aiming with the WRONG one silently mis-scales. */
async function currentScreenInfo(): Promise<{ imgW: number; imgH: number; nativeW: number; nativeH: number } | null> {
  if (!adbScreenInfo) return null;
  const key = await leaseKey();
  if (key !== adbScreenInfo.lease) { adbScreenInfo = null; return null; }
  const { imgW, imgH, nativeW, nativeH } = adbScreenInfo;
  return { imgW, imgH, nativeW, nativeH };
}

/** Resolve the adb binary the editor PROVISIONS, not a bare `adb` on PATH. The packaged editor's adb
 *  is the provisioned SDK's `platform-tools/adb(.exe)`, which is NOT on PATH — a bare `adb` spawn
 *  ENOENTs there, so `adbAvailable()` reports false and Android WebGPU screenshots silently fall back
 *  to the native captureScreen (which renders the 3D canvas BLACK). The backend already resolves it
 *  via `detectAdb()` and reports it at `GET /api/toolchain` (`adb.path`) — mirrors the server-side
 *  fix in deviceConnection.ts. Cached once resolved (a device session doesn't swap SDKs); falls back
 *  to bare `adb` when the backend is unreachable or reports it absent (dev machines with adb on PATH). */
let adbBinCache: string | undefined;
async function resolveAdb(): Promise<string> {
  if (adbBinCache) return adbBinCache;
  try {
    const tc = (await backendGet('/api/toolchain')) as { adb?: { present?: boolean; path?: string } };
    if (tc?.adb?.present && tc.adb.path) return (adbBinCache = tc.adb.path);
  } catch { /* backend unreachable → PATH fallback below */ }
  return 'adb'; // uncached: a later probe (once the SDK resolves) can still find the provisioned path
}

async function adbAvailable(): Promise<boolean> {
  try {
    const { stdout } = await pExecFile(await resolveAdb(), ['devices'], { timeout: 2000 });
    return stdout.split('\n').some((l) => l.includes('\tdevice'));
  } catch { return false; }
}

async function sipsDims(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await pExecFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 2000 });
  return {
    w: parseInt(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? '0'),
    h: parseInt(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? '0'),
  };
}

/** PNG intrinsic size from the IHDR chunk (width@16, height@20, big-endian) — pure Node, so it works
 *  where `sips` (macOS-only) is absent. `adb … screencap -p` always emits a PNG, so this suffices. */
function pngDims(buf: Buffer): { w: number; h: number } {
  return buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR'
    ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    : { w: 0, h: 0 };
}

/** Monotonic per-process counter so concurrent captures (and sibling clones sharing this machine)
 *  don't collide on a fixed temp filename (L11). */
let capCounter = 0;

/** Full-framebuffer capture via adb. `adb exec-out` streams the PNG on stdout (no CRLF translation vs
 *  `adb shell`). On macOS we downscale to a light JPEG with `sips`; elsewhere (Windows/Linux — no
 *  `sips`) we ship the full-resolution PNG straight from screencap, reading dims from the PNG header so
 *  no external image tool is needed. `base64` is computed only when `inline` is set (P2). */
async function adbScreencap(savePath?: string, inline = false): Promise<{ path: string; base64: string; mimeType: string; bytes: number; imgW: number; imgH: number; nativeW: number; nativeH: number }> {
  const { stdout: pngBuf } = (await pExecFile(await resolveAdb(), ['exec-out', 'screencap', '-p'],
    { timeout: 8000, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })) as unknown as { stdout: Buffer };
  const native = pngDims(pngBuf);

  if (process.platform === 'darwin') {
    const png = join(tmpdir(), `_device_screencap-${process.pid}-${++capCounter}.png`);
    writeFileSync(png, pngBuf);
    const out = savePath ?? join(tmpdir(), `device-screenshot-${process.pid}.jpg`);
    await pExecFile('sips', ['-s', 'format', 'jpeg', '--resampleWidth', '600', png, '--out', out], { timeout: 3000 });
    const img = await sipsDims(out);
    const bytes = statSync(out).size;                              // size without reading the file
    const base64 = inline ? readFileSync(out).toString('base64') : ''; // encode only when needed (P2)
    try { unlinkSync(png); } catch { /* */ }
    return { path: out, base64, mimeType: 'image/jpeg', bytes, imgW: img.w, imgH: img.h, nativeW: native.w, nativeH: native.h };
  }

  // No `sips` (Windows/Linux): ship the full-resolution PNG as-is (screencap already gave us the bytes).
  const out = savePath ? savePath.replace(/\.jpe?g$/i, '.png') : join(tmpdir(), `device-screenshot-${process.pid}.png`);
  writeFileSync(out, pngBuf);
  const base64 = inline ? pngBuf.toString('base64') : '';
  return { path: out, base64, mimeType: 'image/png', bytes: pngBuf.length, imgW: native.w, imgH: native.h, nativeW: native.w, nativeH: native.h };
}

/** F2 gate: is the LEASE connected via adb? (Not "is any Android on USB?".) When the lease is adb,
 *  `adb forward` already succeeded — so there is exactly one usable adb device and it IS the leased
 *  one; a bare `adb screencap` targets it. When the lease is WiFi (iOS, or Android-over-WiFi) we must
 *  NOT touch adb — a plugged-in sibling Android would be the wrong device. */
/** Could the leased device be an Android — i.e. must the black-canvas caveat be stated?
 *
 *  It used to claim to KNOW, by reading `target.platform` / `platform` off `/api/device/status`
 *  (independent review, 2026-07-30). Neither field exists on `DeviceConnectStatus`, so the only
 *  branch that could ever return true was `target.useAdb` — a lease that has already taken the adb
 *  screenshot path and never reaches the warning. The caveat was therefore DEAD in exactly the case
 *  its own comment named: an Android connected over WiFi.
 *
 *  The lease genuinely cannot know the platform of a WiFi device (nothing in the handshake carries
 *  it), so this no longer pretends to. It answers the question the caller can actually act on —
 *  "is the platform unknown, so the caveat applies?" — and the warning is phrased as a
 *  conditional. An honest hedge that fires is worth more than a confident silence that never does.
 *  If the lease ever reports a platform, this becomes a real test again. */
async function nativeCaptureMayBeBlank(): Promise<boolean> {
  try {
    const s = (await backendGet('/api/device/status')) as DeviceStatusReply;
    // An adb lease takes the true-framebuffer path and never gets here; anything else is a native
    // capture on a device whose platform we do not know.
    return !s?.target?.useAdb;
  } catch { return true; } // could not check → state the caveat rather than suppress it
}

async function leaseUsesAdb(): Promise<boolean> {
  try {
    const s = (await backendGet('/api/device/status')) as DeviceStatusReply;
    return s?.target?.useAdb === true;
  } catch { return false; }
}

// ── Backend HTTP helpers ─────────────────────────────────────

class BackendError extends Error {}

async function backendGet(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}${path}`);
  } catch (e) {
    throw new BackendError(
      `Can't reach the Modoki backend at ${BACKEND} — is the editor running for this clone? ` +
        `(${(e as Error).message}). The MCP targets $MODOKI_BACKEND; each clone pins its own port.`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(String((body as { error?: string }).error ?? `HTTP ${res.status}`));
  return body;
}

async function backendPost(path: string, payload: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new BackendError(
      `Can't reach the Modoki backend at ${BACKEND} — is the editor running for this clone? ` +
        `(${(e as Error).message}).`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(String((body as { error?: string }).error ?? `HTTP ${res.status}`));
  return body;
}

/** Save a decoded capture, open it in Preview (macOS), and render the tool reply.
 *
 *  Shared by the native path and the WDA path (#102) so both save, name and size-report a capture
 *  identically. `aimHint` is a PARAMETER rather than baked in, because it is the one line the two
 *  paths must not share: a native capture's pixels ARE the aim space for `device_tap`, and a WDA
 *  capture's are the whole device screen and must never be used that way. */
function renderScreenshot(
  decoded: { dataUrl: string; info: string },
  opts: { savePath?: string; inline?: boolean; prefix?: string; aimHint?: string },
): DeviceToolResult {
  const base64 = decoded.dataUrl.includes(',') ? decoded.dataUrl.split(',')[1] : decoded.dataUrl;
  const mimeType = decoded.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  const info = decoded.info + (opts.aimHint ?? '');
  const buf = Buffer.from(base64, 'base64');
  const outPath = opts.savePath ?? join(tmpdir(), `device-screenshot.${extFor(mimeType)}`);
  writeFileSync(outPath, buf);
  // fire-and-forget (macOS). `VITEST` guard: this is the first code path a test drives end-to-end,
  // and a suite that opens a GUI app on the developer's machine is a suite people stop running —
  // same reason autoUpdate.ts and native-dynamic-import.ts check it.
  if (process.platform === 'darwin' && !process.env.VITEST) void pExecFile('open', ['-a', 'Preview', outPath]).catch(() => {});
  const prefix = opts.prefix ?? '';
  return opts.inline
    ? { content: [{ type: 'image' as const, data: base64, mimeType }, { type: 'text' as const, text: prefix + info }] }
    : { content: [{ type: 'text' as const, text: prefix + describeScreenshot(info, outPath, buf.length) }] };
}

/** Proxy one data-plane request through Modoki's held lease. Returns the device's `result`
 *  (usually a JSON string — the device `safeStringify`s its replies). */
async function deviceRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const body = (await backendPost('/api/device/request', { method, params })) as { result?: unknown };
  return body.result;
}

// ── Tool registration ────────────────────────────────────────

export function registerTools(server: McpServer) {
  // Every tool goes through this definer: STRICT validation on the wire (an unknown key is
  // refused, not silently stripped into a different operation) and an entry a test can call.
  // See `registry.ts` for the two defects this closes.
  const rawTool = createDeviceToolDef(server);
  // WRAP every tool: probe the backend's identity once, and banner the result if it turns out to
  // be another clone's editor. Done HERE rather than per-tool so a new tool cannot forget it —
  // the same reason the editor server stamps its error envelopes centrally.
  const tool: typeof rawTool = ((name: string, description: string, shape: Record<string, unknown>, handler: (a: unknown) => Promise<DeviceToolResult> | DeviceToolResult) =>
    (rawTool as unknown as (n: string, d: string, sh: unknown, h: (a: unknown) => Promise<DeviceToolResult>) => void)(
      name, description, shape,
      async (args: unknown) => {
        await ensureDeviceIdentity();
        return withIdentityBanner(await handler(args) as DeviceToolResult);
      },
    )) as typeof rawTool;


  // ── Status ─────────────────────────────────────────────────

  tool('device_status',
    'Report the Modoki device lease (connected device, or how to connect) AND which editor backend '
    + 'holds it — repo + branch, since clones run side by side and every call would otherwise succeed '
    + "against another clone's device without saying so. When connected, also reports the app "
    + 'package/bundle id the SOCKET is actually held by (#88) — a fixed shared port means a stale '
    + "backgrounded app can silently answer every device_* call instead of the one you just "
    + 'launched, and this is the one-call check for that instead of a logcat hunt. Also reports the '
    + 'input FIDELITY every device_tap/drag/pointer/press_key/hover/scroll/type_text call uses, so '
    + 'an agent can ask before it acts rather than discover it from a tool description.',
    {}, async () => {
    try {
      const status = (await backendGet('/api/device/status')) as LeaseStatus;
      const lease = describeLease(status);
      // #32: the backend LIVE-PROBES this whenever a lease is connected — Android CDP
      // reachability, then iOS WebDriverAgent. `pointer`/`type_text` stay synthetic-only
      // regardless of the probe — neither is routed through a trusted path on either platform.
      // Rendering lives in reply.ts so it can be tested by rendering it (#107).
      const fidelity = describeInputFidelity(status);
      // App identity (#88): asked of the device itself, over the SAME lease socket every other
      // device_* call proxies through — so the answer comes from whichever app actually holds the
      // socket, and cannot lie the way a locally-derived value could. Only probed when a lease is
      // actually connected (no point asking a socket that isn't there, and a stale disconnected
      // reply must never be reported as if it were live). Any other failure degrades to no app
      // line rather than a thrown error — this is a bonus fact device_status adds to the lease
      // report, not a new way for it to fail.
      //
      // The `Unknown method:` case is reported rather than swallowed, and that is the case that
      // MATTERS. Measured on the Samsung (#88 close-out): the app you are wrongly driving is BY
      // DEFINITION an older build — it is the one that was already resident and won the race for
      // the shared port — so it predates this handler and cannot answer. Swallowing that left
      // device_status silent in the exact scenario the probe exists for. An old bridge on the
      // socket is itself the strongest available signal that it is not the app you just launched.
      // WHICH PHONE, reported as its own line (#146). Kept separate from the app line on purpose
      // (conventions §2, one name one meaning): that line answers "which app holds this socket",
      // this one answers "which handset is it running on" — a wrong-device session and a wrong-app
      // session are different failures with different fixes, and merging them would hide that.
      //
      // It is the same string the host compares against `xcrun devicectl` to decide where to launch
      // WebDriverAgent, so showing it turns "the agent went to the wrong phone" from an inference
      // into a one-call read. Absent for a bridge/plugin older than #146 — omitted rather than
      // guessed, since "could not look" is never reported as an answer (§5).
      let deviceLine: string | null = null;
      let appLine: string | null = null;
      if (status.state === 'connected') {
        try {
          const info = parseReply<{
            platform?: string; appId?: string; appName?: string; deviceModel?: string; osVersion?: string;
          }>(await deviceRequest('app-identity'));
          if (isDeviceError(info)) {
            appLine = 'App: UNKNOWN — the app holding this socket runs a debug bridge that predates '
              + '#88, so it cannot report its identity. That is itself a warning: a stale backgrounded '
              + 'app can win the shared port and answer every device_* call. Check with '
              + '`adb shell ps -A | grep modoki` and force-stop the ones you do not mean to drive.';
          } else if (info && typeof info.appId === 'string' && info.appId) {
            const label = info.appName ? `${info.appName} (${info.appId})` : info.appId;
            appLine = `App: ${label}${info.platform ? ` [${info.platform}]` : ''} — reported by the device holding the socket.`;
          }
          if (!isDeviceError(info) && info && typeof info.deviceModel === 'string' && info.deviceModel) {
            const os = typeof info.osVersion === 'string' && info.osVersion ? ` / ${info.osVersion}` : '';
            deviceLine = `Device: ${info.deviceModel}${os} — the hardware this lease is holding, `
              + 'self-reported over the lease. On iOS this is what selects the phone a WebDriverAgent '
              + 'launch targets (it matches `xcrun devicectl`\'s productType).';
          }
        } catch { /* older bridge without app-identity, or the lease dropped mid-probe */ }
      }
      const text = [lease, backendIdentityLine, appLine, deviceLine, fidelity].filter(Boolean).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      return caughtFailure('device_status', 'read the Modoki device lease state', e);
    }
  });

  // ── Connect / Disconnect ───────────────────────────────────
  // Open/close the Modoki device lease — the same backend action as the AI panel's "Connect a Device"
  // (the panel controls have no stable selectors, so a tool is the robust path; the panel reflects the
  // lease change reactively). This is a DELIBERATE, explicit connect — it is NOT the removed Bonjour
  // auto-connect, and the lease is first-wins, so it can't storm a device another editor holds.

  tool('device_connect',
    'Connect the editor to a device (open the Modoki lease) — the same action as the AI panel\'s ' +
      '"Connect a Device". Pass `ip` (WiFi — the IP shown in the game\'s debug menu → Device tab) or ' +
      '`useAdb:true` (Android over USB via `adb forward`). With NEITHER, reconnects to the last target ' +
      'this clone used. `port` overrides the fixed 9095 when the app fell back to an OS-assigned one. ' +
      'Bounded (~6s); on failure it reports why (wrong IP / not same WiFi / not a Debug ' +
      'build / firewalled). Then device_* tools proxy through the lease.',
    {
      ip: z.string().optional().describe('Device LAN IP (WiFi). Omit when useAdb, or to reuse the last IP.'),
      useAdb: z.boolean().optional().describe('Android over USB via adb forward (ignores ip).'),
      // The device port is a FIXED 9095 by design; this is the escape hatch for the fallback case.
      // When another Modoki app already holds 9095 the app you just launched binds an OS-assigned
      // port instead (#88) and is perfectly healthy — just unreachable at the default. The lease,
      // `/api/device/connect` and `explainConnectFailure`'s own advice ("pass it directly:
      // device_connect {ip:"…", port:<actual>}") all supported this already; only THIS schema did
      // not, so the error message dead-ended the session it was written to rescue (#122).
      port: z.number().int().positive().optional()
        .describe('Bound TCP port, when the app fell back off the default 9095 — read it from the device log ("TCP server listening on port N") or the in-game debug menu.'),
    },
    async ({ ip, useAdb, port }) => {
      try {
        // A new lease means the old device's screenshot scale is meaningless. `currentScreenInfo`
        // also catches this lazily (the human can reconnect from the AI panel without telling us),
        // but dropping it here makes the tool path immediate rather than merely eventually right.
        adbScreenInfo = null;
        const s = (await backendPost('/api/device/connect', {
          ...(ip ? { ip } : {}),
          ...(useAdb !== undefined ? { useAdb } : {}),
          ...(port !== undefined ? { port } : {}),
        })) as LeaseStatus;
        if (s.state !== 'connected') {
          return deviceFail({
            code: 'REFUSED_BY_OP',
            tool: 'device_connect',
            what: ip ? `open a device lease to ${ip}` : 'open a device lease over adb',
            why: `the lease did not reach the connected state (state: ${s.state}). ${describeLease(s)}`,
            got: s,
            options: [
              'the device app must be RUNNING and on the same network — check the IP in its debug menu',
              'for Android over USB pass useAdb:true instead of an ip',
              'another clone may already hold the lease — device_status says who',
            ],
          });
        }
        return { content: [{ type: 'text' as const, text: describeLease(s) }] };
      } catch (e) {
        return caughtFailure('device_connect', ip ? `open a device lease to ${ip}` : 'open a device lease over adb', e);
      }
    },
  );

  tool('device_disconnect',
    'Close the Modoki device lease (release the device so another editor can connect) — the same action ' +
      'as the AI panel\'s Disconnect.',
    {},
    async () => {
      try {
        adbScreenInfo = null;
        return { content: [{ type: 'text' as const, text: describeLease((await backendPost('/api/device/disconnect', {})) as LeaseStatus) }] };
      } catch (e) {
        return caughtFailure('device_disconnect', 'release the Modoki device lease', e);
      }
    },
  );

  // ── Eval ───────────────────────────────────────────────────

  tool('device_eval',
    'Execute JavaScript in the connected game page context. `code` sees an injected `modoki` ' +
      'scripting object (#83) — the device\'s live agent-op registry as `modoki.call(op, params)` ' +
      'plus a generated `modoki.<camelCase>(params)` method per op (see device_eval_api for the ' +
      'full list). Narrower than the editor\'s: no `modoki.api()`/`modoki.composite()` (device has ' +
      'no editor backend to fetch and no undo stack). ' + DEVICE_EVAL_UNREACHABLE_SUMMARY,
    {
      code: z.string().describe('JavaScript code. Use `return` for a value.'),
      timeoutMs: z.number().int().positive().optional().describe(
        'How long the body may run before it is abandoned. Default 4000, max 4500 (clamped, not ' +
        'refused). The ceiling is LOWER than the editor twin\'s 25000 and is not a policy choice: ' +
        'the device TCP transport has a fixed 5s per-REQUEST deadline whose clock starts host-side, ' +
        'so a larger budget could never be the deadline that fires — you would get a generic ' +
        'transport error instead of what the code was doing.',
      ),
    },
    async ({ code, timeoutMs }) => {
      try {
        const result = await deviceRequest('eval', timeoutMs == null ? { code } : { code, timeoutMs });
        // A device-side eval failure comes back as an `Error: …` string, not a thrown error — flag
        // it so the caller sees a tool error, not a success with error text (F15).
        if (isDeviceError(result)) {
          return deviceFail({
            code: 'REFUSED_BY_OP',
            tool: 'device_eval',
            what: 'evaluate JS in the device webview',
            why: `the code threw on the device: ${encodeEvalResult(result)}`,
            got: code.length > 400 ? code.slice(0, 400) + '…' : code,
            options: [
              'the device runs `code` as a FUNCTION BODY — a bare expression needs an explicit `return`',
              'a circular/huge value cannot be serialized back — return a projection, e.g. `return {w: innerWidth}`',
            ],
          });
        }
        return { content: [{ type: 'text' as const, text: encodeEvalResult(result) }] };
      } catch (e) {
        return caughtFailure('device_eval', 'evaluate JS in the device webview', e);
      }
    },
  );

  tool('device_eval_api',
    'Discovery for device_eval: lists every op the injected `modoki` scripting object exposes, as ' +
      'its generated `modoki.<camelCase>(params)` method — plus `modoki.call(op, params)` and ' +
      '`modoki.ops()`, what is deliberately ABSENT (no `api`/`composite`), and what cannot be ' +
      'reached from eval at all (input + screenshot). Read this before writing a device_eval script.',
    {},
    async () => {
      try {
        const result = await deviceRequest('eval', { code: 'return modoki.ops();' });
        if (isDeviceError(result)) {
          return deviceFail({
            code: 'REFUSED_BY_OP',
            tool: 'device_eval_api',
            what: 'list the device eval scripting surface',
            why: `the device eval threw: ${encodeEvalResult(result)}`,
            options: ['confirm a device is connected (device_status)'],
          });
        }
        // The ops come from the device (that build's registry); the guidance is composed here — see
        // DEVICE_EVAL_UNREACHABLE_SUMMARY's header for why it is not shipped on-device. `parseReply`
        // returns the raw value unchanged if it is not JSON, so an unexpected reply is REPORTED as
        // `ops` rather than being dropped on the floor by a parse this tool could not do.
        return {
          content: [{
            type: 'text' as const,
            text: encodeStructuredResult({ ops: parseReply<unknown>(result), ...deviceEvalApiGuidance() }),
          }],
        };
      } catch (e) {
        return caughtFailure('device_eval_api', 'list the device eval scripting surface', e);
      }
    },
  );

  // ── Percept (read-by-data) ─────────────────────────────────
  // Verify game state by DATA, not pixels — critical on device, where Claude is weak at pixels AND
  // Android WebGPU screenshots come back black (only the adb framebuffer has the scene). These proxy
  // the SAME summary-first, GUID-addressed, float-rounded ops the editor MCP uses (agentBridge), now
  // reachable on the device path. See docs/plans/device-percept-enact-plan.md.

  /** Run a structured op over the lease and shape its reply (compact JSON, or `isError` for a device
   *  `Error:` reply). Shared by the Percept tools. */
  /** Ops whose `ok` is a VERDICT, not a success flag — `isFailureBody` must not run on them.
   *
   *  `diagnose` answers `{ok:false}` to mean "this scene is unhealthy", which is precisely the
   *  thing it was called to find out. Running the shared failure check over it turned the one tool
   *  built to report problems into an `isError` / REFUSED_BY_OP envelope exactly when it had
   *  something to report — so the agent saw a broken tool instead of a broken scene, and the
   *  diagnosis it asked for was thrown away. The editor MCP deliberately does not check this op
   *  (`getJson` runs no failure check, for this reason); the device twin applied it to every
   *  Percept reply uniformly. Found independently by both passes of the 2026-07-30 review.
   *
   *  A SET rather than an inline `method !== 'diagnose'`, so the next verdict-shaped op is a
   *  one-line addition next to the reasoning instead of a second scattered special case. */
  const OK_IS_A_VERDICT = new Set(['diagnose']);

  async function perceptCall(tool: string, method: string, params: Record<string, unknown> = {}) {
    const what = `read ${method} from the connected device`;
    try {
      const parsed = parseReply<unknown>(await deviceRequest(method, params));
      if (isDeviceError(parsed)) {
        return deviceReplyFailure(tool, what, parsed, [
          'device_status — confirm the lease is still held and the game is running',
          'device_diagnose — the structured "why is the frame wrong" read',
        ]);
      }
      // C7, and it was MISSING on this server entirely: a reply that answers `{ok:false, error}`
      // says the op DID NOT HAPPEN, and reporting that as a successful tool call is the worst
      // outcome on an agent surface — the agent builds on it. The editor MCP has run this check
      // since the C7 audit; all six device Percept tools went without it.
      // (`ok` is a success FLAG for these ops — EXCEPT the ones in OK_IS_A_VERDICT above, where it
      // is the answer. The shared helper also honours an explicit `ok:true` over a non-empty
      // `errors[]`, so a documented partial success still passes.)
      const failure = OK_IS_A_VERDICT.has(method) ? null : isFailureBody(parsed);
      if (failure) {
        return deviceFail({
          code: 'REFUSED_BY_OP',
          tool, what,
          why: failure.split('\n\nfull response:')[0],
          got: parsed,
        });
      }
      return { content: [{ type: 'text' as const, text: encodeStructuredResult(parsed) }] };
    } catch (e) {
      return caughtFailure(tool, what, e);
    }
  }

  tool('device_get_scene_state',
    'Read the live ECS world on the connected device as DATA (no screenshot). Bare call = a compact ' +
      'INDEX (entity id/guid/name/traits, no values); drill down with a filter or enricher. Address ' +
      'entities by guid (stable across reloads), never by id. Floats are rounded — verify with a ' +
      'tolerance, not ===. RESOURCE entities (mesh/material/prefab/env holders + config singletons ' +
      'Time/Physics/NPRPostFX) are excluded from the untargeted listing — pass resources:true (or any ' +
      'filter) to include them.',
    {
      id: z.number().int().optional().describe('Only the entity with this runtime id — reassigned on every scene hot-reload, so PREFER guid. Useful to resolve a numeric id pulled from a journal/contact payload.'),
      guid: z.string().optional().describe('Only the entity with this stable guid.'),
      name: z.string().optional().describe('Filter to entities whose name CONTAINS this (case-insensitive).'),
      trait: z.string().optional().describe('Only include this trait\'s data (still lists all entities).'),
      where: z.string().optional().describe('Predicate "Trait.field <op> value", op ∈ = != > >= < <= ~ (~ = contains).'),
      full: z.boolean().optional().describe('Every persistent trait field, not just the curated Inspector subset.'),
      world: z.boolean().optional().describe('Add resolved WORLD transform + activeInHierarchy per entity.'),
      bounds: z.boolean().optional().describe('Add each entity\'s screen-space rect + onScreen flag.'),
      contacts: z.boolean().optional().describe('Add current physics contacts/overlaps (GUID arrays) per body.'),
      resources: z.boolean().optional().describe('Force-include resource entities (mesh/material/prefab/env holders + config singletons Time/Physics/NPRPostFX). Excluded from the DEFAULT untargeted listing only — any id/guid/trait/name/where filter already includes them.'),
      limit: z.number().optional().describe('Cap entities returned (sets truncated/totalCount).'),
      precision: z.number().optional().describe('Significant digits for floats (default 9; 0 = exact).'),
    },
    async (args) => perceptCall('device_get_scene_state', 'scene-state', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
  );

  tool('device_diagnose',
    'Structured render/scene health on the connected device — the CAUSES behind a black or wrong ' +
      'frame, as data (recent console errors, off-screen entities, missing renderers, …). Use this ' +
      'instead of a screenshot on Android, where the native screenshot is black on WebGPU.',
    {},
    async () => perceptCall('device_diagnose', 'diagnose'),
  );

  tool('device_journal',
    'Read the tick-stamped game-event trace on the device (match/score/win/@contact/…) — the ' +
      'screenshot-free way to verify game LOGIC. Returns the last 100 events + byType counts over the ' +
      'whole ring, plus `captures` (Tier-2 diagnostic state). Narrow with type= and/or level=, raise ' +
      'limit=N; pair with device_dispatch_action to drive the game.\n' +
      'LEVEL: every event carries a triage severity, `info` (default) / `warn` / `error`. ' +
      'level:"warn" returns warn AND error, skipping normal-gameplay noise.\n' +
      'TIERS: lean events (semantic + @collision/@sensor/@zone transitions) are always recorded. ' +
      'High-frequency DIAGNOSTIC events (@contact) are WATCH-GATED — they record NOTHING until you ' +
      'open a capture and only from that point forward. Open/close with action:"start"/"stop" + ' +
      'type:"@contact" (do this BEFORE the moment you want to trace), then read, then stop.',
    {
      type: z.string().optional().describe('Read: only events of this type. With action: the watch-gated type to start/stop (e.g. "@contact").'),
      level: z.enum(['info', 'warn', 'error']).optional().describe('Read: only events at this severity OR ABOVE (e.g. "warn" returns warn + error).'),
      action: z.enum(['start', 'stop']).optional().describe('Open ("start") or close ("stop") a Tier-2 capture window for type=. Omit to just read.'),
      limit: z.number().optional().describe('Return the last N events (default 100).'),
      clear: z.boolean().optional().describe('Clear the journal after reading. REFUSED when combined with type=/level= — the ring has no selective clear, so clearing a FILTERED read would destroy every other event too.'),
    },
    async (args) => perceptCall('device_journal', 'journal-events', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
  );

  tool('device_resolve_refs',
    'Resolve journal/contact refs (GUIDs and/or numeric ids from @contact/@collision/@sensor/@zone ' +
      'payloads) to entity display NAMES — the deliberate second hop that keeps names OUT of the ' +
      'journal stream. Batch every ref you care about into one call. Names resolve even for entities ' +
      'that have since DESPAWNED (captured at emit time). Returns { resolved: { ref: {name, alive} }, ' +
      'unresolved: [...] } — an unresolved ref was never seen named (nameless/stale).',
    {
      refs: z.array(z.union([z.string(), z.number()])).describe('Refs to resolve — GUIDs and/or numeric ids.'),
    },
    async (args) => perceptCall('device_resolve_refs', 'resolve-refs', args),
  );

  tool('device_introspect',
    'Discover what the game on the device exposes: dispatchable action names (+ param schemas) and ' +
      'live named read-values (e.g. canGoBack, timeSinceGameStart). Use before device_dispatch_action.',
    {},
    async () => perceptCall('device_introspect', 'game-introspect'),
  );

  tool('device_layout_bounds',
    'Numeric screen-space layout on the device (viewport CSS px) — UI DOM rects, 2D, and 3D world ' +
      'AABBs projected through the game camera. Use instead of eyeballing a screenshot to check ' +
      'alignment/overlap/clipping. Bare = COUNTS + the cheap offScreen/zeroSize id lists; pass ids/layer ' +
      'for per-entity rects, overlaps=true for the O(n²) pair list. Floats rounded — verify by tolerance.',
    {
      layer: z.enum(['ui', '2d', '3d']).optional().describe('Limit to one layer (implies per-entity rects).'),
      ids: z.array(z.number()).optional().describe('Limit to these entity ids (implies per-entity rects).'),
      entities: z.boolean().optional().describe('Force the per-entity rect list on an untargeted call.'),
      overlaps: z.boolean().optional().describe('Materialize the overlapping-pair list (O(n²); default off).'),
      limit: z.number().optional().describe('Cap per-entity rects (sets truncated/totalCount).'),
      precision: z.number().optional().describe('Significant digits for floats (default 9; 0 = exact).'),
    },
    async (args) => perceptCall('device_layout_bounds', 'layout-bounds', Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
  );

  tool('device_watch',
    'Percept WATCH on the device — a standing, change-detected numeric time-series over the live ' +
      'world (jump overshoot, spring settle, velocity decay), the feel questions a screenshot can\'t ' +
      'answer. action:start opens a focused watch (one component, optional guids/names/fields); a value ' +
      'records only when it moves > epsilon. action:read returns per-field STATS (first/last/min/max/' +
      'delta/settled) — pass samples=true for the raw curve. action:list/clear manage them.',
    {
      action: z.enum(['start', 'read', 'list', 'clear']).describe('start | read | list | clear'),
      component: z.string().optional().describe('(start) Component whose numeric fields to sample, e.g. Transform, RigidBody2D.'),
      guids: z.array(z.string()).optional().describe('(start) Restrict to these guids. (read) Filter returned series to these guids.'),
      names: z.array(z.string()).optional().describe('(start) Scope to entities whose NAME contains any of these (case-insensitive; new spawns auto-join).'),
      fields: z.array(z.string()).optional().describe('(start) Restrict to these numeric fields; omit for all.'),
      epsilon: z.number().optional().describe('(start) Change threshold (default 1e-4).'),
      everyNFrames: z.number().optional().describe('(start) Sample every Nth frame (default 1).'),
      maxSamples: z.number().optional().describe('(start) Ring cap per series (default 600).'),
      maxSeries: z.number().optional().describe('(start) Cap on moving series (default 512).'),
      expireFrames: z.number().optional().describe('(start) Auto-remove after N frames (0 = never).'),
      id: z.string().optional().describe('(read/clear) Watch id from start/list. Omit on clear to clear ALL.'),
      name: z.string().optional().describe('(read) Filter returned series to entities whose name contains this.'),
      limit: z.number().optional().describe('(read) Cap the number of series returned.'),
      clear: z.boolean().optional().describe('(read) Clear the series THIS CALL RETURNED (not the whole watch — a read is capped/filterable, so series you did not see keep their samples). The reply echoes `cleared` + `clearedScope`.'),
      samples: z.boolean().optional().describe('(read) Include the RAW time-series (default false — stats only).'),
      precision: z.number().optional().describe('Significant digits for floats (default 9; 0 = exact).'),
    },
    async (args) => {
      const { action, id } = args;
      // PER-ACTION ALLOWLIST, mirroring the editor twin (independent review, 2026-07-30). Two
      // defects here, both silent:
      //   · `guids` is a documented START-time scope, but the old signature destructured it OUT
      //     before spreading `...start` — so it never reached watch-start, and `startWatch()` with
      //     no scope watches EVERY entity carrying the component and answers ok:true. A watch the
      //     caller believes is scoped to one entity, reported as success.
      //   · the device twin had NONE of the editor's cross-action refusal, so a read-time key on a
      //     start call (or vice versa) was dropped with no complaint at all.
      // An allowlist cannot have a gap: a key is accepted by this action or refused.
      const ACCEPTS: Record<string, readonly string[]> = {
        start: ['component', 'guids', 'names', 'fields', 'epsilon', 'everyNFrames', 'maxSamples', 'maxSeries', 'expireFrames'],
        read: ['id', 'name', 'guids', 'limit', 'clear', 'samples', 'precision'],
        list: [],
        clear: ['id'],
      };
      const accepted = new Set<string>([...(ACCEPTS[action] ?? []), 'action']);
      const stray = Object.keys(args).filter((k) => (args as Record<string, unknown>)[k] !== undefined && !accepted.has(k));
      if (stray.length) {
        return deviceFail({
          code: 'UNKNOWN_PARAM',
          tool: 'device_watch',
          what: action === 'start' ? 'open a device watch' : `${action} a device watch`,
          why:
            `${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} not accepted by action:'${action}' — ` +
            `${stray.length > 1 ? 'they' : 'it'} would be silently dropped, and the call would ` +
            (action === 'start' ? 'watch EVERY entity carrying the component.'
              : action === 'clear' ? 'clear EVERY watch, not the scope you named.'
                : 'return EVERY series, unfiltered.'),
          got: Object.fromEntries(stray.map((k) => [k, (args as Record<string, unknown>)[k]])),
          expected: `action:'${action}' accepts: ${ACCEPTS[action]?.length ? ACCEPTS[action].join(', ') : '(no params beyond action)'}`,
          options: stray.map((k) => {
            if (k === 'name' && action === 'start') return 'names:["…"] — the START-time scope you meant';
            if (k === 'names' && action === 'read') return 'name:"…" — the READ-time filter you meant';
            const other = Object.entries(ACCEPTS).filter(([a, keys]) => a !== action && keys.includes(k)).map(([a]) => `action:'${a}'`);
            return other.length ? `${k} — pass it on ${other.join(' or ')} instead` : `${k} — not a parameter of this action`;
          }),
        });
      }
      const forward = (keys: readonly string[]) => Object.fromEntries(
        keys.map((k) => [k, (args as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined));
      if (action === 'list') return perceptCall('device_watch', 'watch-list');
      if (action === 'clear') return perceptCall('device_watch', 'watch-clear', id ? { id } : {});
      if (action === 'read') return perceptCall('device_watch', 'watch-read', forward(ACCEPTS.read));
      return perceptCall('device_watch', 'watch-start', forward(ACCEPTS.start));
    },
  );

  tool('device_input_watch',
    'Input WATCH on the device — a bounded record of what the POINTER actually did, and what it ' +
      'resolved to. The one tool that can tell "the press hit nothing" (an authority looked and ' +
      'found nothing there) apart from "nothing could answer" (nobody who could look was asked), ' +
      'which is the whole evidence gap a failed gesture otherwise leaves (no journal event, no ' +
      'commit, no coordinates). action:start opens the window and RECORDS NOTHING BEFORE THAT CALL. ' +
      'action:read returns the most-recent presses; action:stop closes the window but KEEPS what was ' +
      'recorded; action:clear drops recorded presses without closing the window.',
    {
      action: z.enum(['start', 'read', 'stop', 'clear']).describe('open the window | read presses | close (keeps presses) | drop recorded presses'),
      max: z.number().optional().describe('(start) Ring capacity — most recent N presses kept (default 40, ceiling 500).'),
      limit: z.number().optional().describe('(read) Most-recent N presses to return (default 20).'),
      unresolvedOnly: z.boolean().optional().describe("(read) Keep only presses whose resolved.by is 'none' or 'unknown' — presses NOTHING could explain. THE diagnostic filter."),
      precision: z.number().optional().describe('(read) Significant digits for float fields (default 9; 0 = exact).'),
    },
    async (args) => {
      const { action } = args;
      // PER-ACTION ALLOWLIST, mirroring the editor twin and device_watch above — a key belonging
      // to a different action is refused by name, never silently dropped.
      const ACCEPTS: Record<string, readonly string[]> = {
        start: ['max'],
        read: ['limit', 'unresolvedOnly', 'precision'],
        stop: [],
        clear: [],
      };
      const accepted = new Set<string>([...(ACCEPTS[action] ?? []), 'action']);
      const stray = Object.keys(args).filter((k) => (args as Record<string, unknown>)[k] !== undefined && !accepted.has(k));
      if (stray.length) {
        return deviceFail({
          code: 'UNKNOWN_PARAM',
          tool: 'device_input_watch',
          what: `${action} the device input watch`,
          why: `${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} not accepted by action:'${action}'.`,
          got: Object.fromEntries(stray.map((k) => [k, (args as Record<string, unknown>)[k]])),
          expected: `action:'${action}' accepts: ${ACCEPTS[action]?.length ? ACCEPTS[action].join(', ') : '(no params beyond action)'}`,
          options: stray.map((k) => {
            const other = Object.entries(ACCEPTS).filter(([a, keys]) => a !== action && keys.includes(k)).map(([a]) => `action:'${a}'`);
            return other.length ? `${k} — pass it on ${other.join(' or ')} instead` : `${k} — not a parameter of this action`;
          }),
        });
      }
      const forward = (keys: readonly string[]) => Object.fromEntries(
        keys.map((k) => [k, (args as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined));
      if (action === 'stop') return perceptCall('device_input_watch', 'input-watch-stop');
      if (action === 'clear') return perceptCall('device_input_watch', 'input-watch-clear');
      if (action === 'read') return perceptCall('device_input_watch', 'input-watch-read', forward(ACCEPTS.read));
      return perceptCall('device_input_watch', 'input-watch-start', forward(ACCEPTS.start));
    },
  );

  // ── Screenshot ─────────────────────────────────────────────

  tool('device_screenshot',
    'Take a screenshot of the connected device. Saves it to a file, opens it in Preview, and ' +
      'returns the PATH + dimensions as text. Those pixel coordinates are aimable with ' +
      'device_tap/device_drag — EXCEPT on a wda capture, see below. ' +
      'The image is NOT inlined by default (a full-res base64 blob crowds out the task). Pass ' +
      'inline:true if you actually need to look at it. ' +
      'iOS only: `source:"wda"` captures the WHOLE DEVICE SCREEN via WebDriverAgent instead of the ' +
      'app\'s own capture — the only way to see a system permission/ATT dialog, springboard, or ' +
      'anything outside the app. Its pixels are DEVICE-screen coordinates and must NOT be fed to ' +
      'device_tap/device_drag (aim by selector/entity instead).',
    {
      savePath: z.string().optional().describe('Where to save (e.g., /tmp/screenshot.jpg). Defaults to a temp file.'),
      inline: z.boolean().optional().describe('Also embed the image in the response. Large — only when you need to SEE it.'),
      source: z.enum(['auto', 'wda']).optional().describe('auto (default): adb framebuffer / the app\'s native capture, falling back to WebDriverAgent only if that errors. wda: force the iOS full-device capture — use it when the thing you need to see is OUTSIDE the app, which does not make the native capture fail.'),
    },
    async ({ savePath, inline, source }) => {
      try {
        // #102 — an explicit `source:'wda'` skips BOTH normal paths. It is an iOS-only capability
        // (the backend refuses when the lease has no WiFi host), and it must not be quietly
        // downgraded to an adb or native capture: the caller asked for it precisely because those
        // two cannot see what they are looking for.
        if (source === 'wda') {
          // Deliberately NOT clearing `adbScreenInfo`: a WDA capture is no evidence about the adb
          // screen mapping either way, and a stale-mapping tap is guarded by the loud coordinate
          // warning this reply carries — not by silently dropping state a later native capture
          // would still want.
          const decoded = decodeScreenshotReply(await deviceRequest('screenshot', { source: 'wda' }));
          if ('error' in decoded) {
            return deviceFail({
              code: 'REFUSED_BY_OP',
              tool: 'device_screenshot',
              what: 'capture the full device screen via WebDriverAgent',
              why: decoded.error,
              options: [
                'WDA is iOS-only and needs a WiFi lease — an adb/USB lease is Android (device_status)',
                'install WebDriverAgent from Build Support (iOS); it runs only while its xcodebuild test process is alive',
                'drop source:"wda" for the app\'s own capture, which cannot see outside the app',
              ],
            });
          }
          return renderScreenshot(decoded, { savePath, inline, prefix: decoded.warning ? `${decoded.warning}\n\n` : '' });
        }
        // Android over adb: full framebuffer via adb (captures the WebGL/WebGPU canvas the native path
        // can't). ONLY when the LEASE itself is the adb device (F2) — never just because some Android
        // is on USB, which would screenshot the wrong device when the lease is a WiFi iPhone.
        if (await leaseUsesAdb() && await adbAvailable()) {
          const cap = await adbScreencap(savePath, inline);
          adbScreenInfo = { imgW: cap.imgW, imgH: cap.imgH, nativeW: cap.nativeW, nativeH: cap.nativeH, lease: (await leaseKey()) ?? 'adb' };
          // Same VITEST guard as `renderScreenshot` — this branch needs adb + an adb lease, so no
          // test reaches it TODAY, but it is the identical defect and one adb-path test away from
          // opening Preview windows during `npm test`.
          if (process.platform === 'darwin' && !process.env.VITEST) void pExecFile('open', ['-a', 'Preview', cap.path]).catch(() => {}); // fire-and-forget (macOS)
          const info = `[adb] ${cap.imgW}x${cap.imgH} (from ${cap.nativeW}x${cap.nativeH}). Use these pixel coordinates for device_tap/device_drag.`;
          return inline
            ? { content: [{ type: 'image' as const, data: cap.base64, mimeType: cap.mimeType }, { type: 'text' as const, text: info }] }
            : { content: [{ type: 'text' as const, text: describeScreenshot(info, cap.path, cap.bytes) }] };
        }
        // The lease is WiFi (or no adb): clear any stale adb dims so a later tap doesn't send the wrong
        // device's screenInfo (the iOS device sets its own lastScreenInfo on native capture).
        adbScreenInfo = null;
        // S2.6 — SAY when the capture cannot see the 3D canvas. Both helpers above swallow every
        // failure and return false, so an Android lease over WiFi (or with adb unreachable) drops
        // silently to the device's native captureScreen — which this codebase documents as
        // rendering the WebGL/WebGPU canvas BLACK, keeping only the DOM HUD. Returned as an
        // ordinary successful screenshot, that sends the reader off to debug a "black screen"
        // rendering bug that is really a capture-path limitation.
        const blackCanvasWarning = (await nativeCaptureMayBeBlank())
          ? '⚠️  NATIVE capture over WiFi. IF this device is an ANDROID, a WebGL/WebGPU canvas ' +
            'composites in a separate GPU surface, so the 3D scene renders BLACK here and only the DOM ' +
            'HUD is real — that would be the CAPTURE PATH, not the game. (On iOS the native capture is ' +
            'faithful; the lease does not report which platform this is.) If the scene looks black: ' +
            'connect over adb (device_connect {useAdb:true}) for a true framebuffer, or read the scene ' +
            'as DATA (device_get_scene_state / device_diagnose).\n\n'
          : '';

        // Otherwise (iOS / no adb) go through the lease → the device's native captureScreen.
        const decoded = decodeScreenshotReply(await deviceRequest('screenshot'));
        if ('error' in decoded) {
          return deviceFail({
            code: 'REFUSED_BY_OP',
            tool: 'device_screenshot',
            what: 'capture the device screen',
            why: decoded.error,
            options: [
              'on Android a WebGL/WebGPU canvas captures BLACK natively — connect over adb (device_connect {useAdb:true}) so the capture reads the composited framebuffer',
              'device_status — confirm the lease is still held',
            ],
          });
        }
        // The backend falls back to a WDA capture when the native one ERRORS (#102). That image is
        // the whole device screen, so the aim hint below would be a lie — and this is the path
        // where nobody ASKED for a WDA capture, which is exactly when a wrong hint gets believed.
        return renderScreenshot(decoded, {
          savePath, inline,
          prefix: (decoded.warning ? `${decoded.warning}\n\n` : '') + blackCanvasWarning,
          aimHint: decoded.isWholeDevice ? '' : ' Use these pixel coordinates for device_tap/device_drag.',
        });
      } catch (e) {
        return caughtFailure('device_screenshot', 'capture the device screen', e);
      }
    },
  );

  // ── Tap ────────────────────────────────────────────────────

  tool('device_tap',
    'Tap a target on the connected device. Prefer selector aiming — pass a CSS `selector` (e.g. a ' +
      'button) and the device resolves it to the element center, occlusion-checked, with NO ' +
      'screenshot needed (the fix for tapping DOM chrome like a debug-menu close button). Otherwise ' +
      'pass screenshot pixel `x`/`y` (take a device_screenshot first). Selector wins if both are given. ' +
      'TRUSTED OS-level input when a route is available — CDP on Android, WebDriverAgent on iOS ' +
      '(#32) — else a synthetic DOM event, which is fronted by a loud banner saying so. Check ' +
      'device_status\'s input-mechanism line to know which you will get.',
    {
      selector: z.string().optional().describe('CSS selector to aim at (resolved on-device to the element center; refuses if occluded). Preferred for DOM targets.'),
      x: z.number().optional().describe('X (screenshot pixels) — used when no selector.'),
      y: z.number().optional().describe('Y (screenshot pixels) — used when no selector.'),
    },
    async ({ selector, x, y }) => {
      if (!selector && (x == null || y == null)) {
        return deviceFail({
          code: 'REFUSED_BY_OP',
          tool: 'device_tap',
          what: 'tap the device screen with no usable aim',
          why: 'no `selector` was given and the coordinates were incomplete, so there is nowhere to tap. Guessing a point would tap something arbitrary and report success.',
          got: { selector, x, y },
          expected: 'either selector:"<css>" (preferred — resolved on-device, refuses when occluded) or BOTH x and y in screenshot pixels',
        });
      }
      const aim = `tap ${selector ? `selector ${JSON.stringify(selector)}` : `(${x},${y})`} on the device`;
      try {
        const info = selector ? null : await currentScreenInfo();
        // On the ADB path the device has NO screenInfo of its own (it is only set by the native
        // captureScreen, which Android skips), so sending raw screenshot pixels without ours means
        // the tap is scaled by nothing and lands somewhere else — answered as `Tapped (x,y) — ok`.
        // Dropping stale dims (the S2.i fix) made that reachable whenever the lease changed. If we
        // cannot supply the scale for a COORDINATE aim on an adb lease, refuse and say how to get it.
        if (!selector && !info && await leaseUsesAdb()) {
          return deviceFail({
            code: 'NOT_AVAILABLE_HERE',
            tool: 'device_tap',
            what: `tap (${x},${y}) on the adb-connected device`,
            why: 'no screenshot scale is available for this lease, and an adb device has none of its own — the coordinates would be sent unscaled and the tap would land somewhere else. Nothing was sent.',
            options: [
              'take a device_screenshot first: it measures the framebuffer and stamps the scale for this lease',
              'aim by `selector` instead — it resolves on-device and needs no scale at all',
            ],
          });
        }
        const params = selector ? { selector } : { x, y, ...(info ? { screenInfo: info } : {}) };
        const reply = await deviceRequest('tap', params);
        // The device returns an `Error: …` string (no canvas, selector miss/occluded) as a normal
        // result — don't report a phantom tap as success (F9).
        if (isDeviceError(reply)) {
          return deviceReplyFailure('device_tap', aim, reply, [
            'a selector miss or an OCCLUDED target is refused here rather than tapping something else — re-read the screen and aim again',
            'device_layout_bounds gives the on-screen rects; device_screenshot shows what covers the target',
          ]);
        }
        return { content: [{ type: 'text' as const, text: `Tapped ${selector ? JSON.stringify(selector) : `(${x},${y})`} — ${String(reply)}` }] };
      } catch (e) {
        return caughtFailure('device_tap', aim, e);
      }
    },
  );

  // ── Drag ───────────────────────────────────────────────────

  tool('device_drag',
    'Drag between two points on the connected device. Aim each end by CSS selector ' +
      '(`fromSelector`/`toSelector`, resolved + occlusion-checked on-device) or by screenshot pixel ' +
      'coords (`fromX/fromY`→`toX/toY`; take a device_screenshot first). A selector wins over coords ' +
      'for that endpoint. TRUSTED OS-level input when a route is available — CDP on Android, ' +
      'WebDriverAgent on iOS (#32) — else synthetic DOM events, fronted by a loud banner. Check ' +
      'device_status\'s input-mechanism line to know which you will get.',
    {
      fromSelector: z.string().optional().describe('CSS selector for the start point.'),
      toSelector: z.string().optional().describe('CSS selector for the end point.'),
      fromX: z.number().optional(), fromY: z.number().optional(),
      toX: z.number().optional(), toY: z.number().optional(),
      steps: z.number().optional().describe('Intermediate steps (default: 5)'),
      delayMs: z.number().optional().describe('Delay per step ms (default: 20)'),
      dom: z.boolean().optional().describe('Drag DOM chrome (a debug widget, slider) by dispatching the pointer sequence ON the grabbed element instead of the game canvas. Auto-engages when the grab lands on a non-canvas element; pass false to force the canvas/world path.'),
    },
    async ({ fromSelector, toSelector, fromX, fromY, toX, toY, steps, delayMs, dom }) => {
      const haveFrom = fromSelector != null || (fromX != null && fromY != null);
      const haveTo = toSelector != null || (toX != null && toY != null);
      if (!haveFrom || !haveTo) {
        return deviceFail({
          code: 'REFUSED_BY_OP',
          tool: 'device_drag',
          what: 'drag on the device with an incomplete endpoint',
          why: `${!haveFrom ? 'the START' : 'the END'} endpoint has neither a selector nor both coordinates, so the gesture has no defined path.`,
          got: { fromSelector, fromX, fromY, toSelector, toX, toY },
          expected: 'each endpoint as a selector OR both coords: (fromSelector | fromX+fromY) and (toSelector | toX+toY)',
        });
      }
      try {
        // Only coordinate endpoints need the scale; a selector resolves on-device.
        const screenInfo = fromSelector && toSelector ? null : await currentScreenInfo();
        if (!(fromSelector && toSelector) && !screenInfo && await leaseUsesAdb()) {
          return deviceFail({
            code: 'NOT_AVAILABLE_HERE',
            tool: 'device_drag',
            what: 'drag by coordinates on the adb-connected device',
            why: 'no screenshot scale is available for this lease, and an adb device has none of its own — the endpoints would be sent unscaled. Nothing was sent.',
            options: ['take a device_screenshot first to stamp the scale', 'aim BOTH endpoints by selector, which needs no scale'],
          });
        }
        const reply = await deviceRequest('drag', {
          ...(fromSelector ? { fromSelector } : { fromX, fromY }),
          ...(toSelector ? { toSelector } : { toX, toY }),
          steps: steps ?? 5, delayMs: delayMs ?? 20,
          ...(dom !== undefined ? { dom } : {}),
          ...(screenInfo ? { screenInfo } : {}),
        });
        if (isDeviceError(reply)) {
          return deviceReplyFailure('device_drag', 'drag on the device', reply, [
            'a missed/occluded endpoint is refused here rather than dragging from somewhere else — re-read the screen and aim again',
            'device_layout_bounds gives the on-screen rects',
          ]);
        }
        return { content: [{ type: 'text' as const, text: `Dragged — ${String(reply)}` }] };
      } catch (e) {
        return caughtFailure('device_drag', 'drag on the device', e);
      }
    },
  );

  // ── Sustained pointer (held across calls) ──────────────────

  tool('device_pointer',
    'Sustained/HELD pointer on the connected device — the stateful twin of device_drag, split into ' +
      'separate calls. `action:"down"` presses at a point and LEAVES the button held (no matching up ' +
      'is sent); `action:"move"` re-aims the held pointer (a drag-move); `action:"up"` releases. ' +
      'Between calls the press PHYSICALLY persists, so you can read state that exists only WHILE the ' +
      'button is held — a slingshot pull preview, a charge-up meter — with device_get_scene_state / ' +
      'device_eval / device_screenshot mid-gesture (the atomic device_drag can\'t expose it). Typical ' +
      'loop: down → (read) → move → (read) → up. Aim each call by CSS `selector` (resolved on-device) ' +
      'or screenshot pixel `x`/`y` (take a device_screenshot first) — same aiming as device_tap, no ' +
      '`entity` addressing on this surface. move/up reuse the button from the down; a move/up with ' +
      'nothing held, or a down while already held, is REFUSED rather than silently re-pressing/re-aiming. ' +
      'Always dispatches synthetic DOM events, never OS-level trusted input — this op is not ' +
      'routed through the trusted paths on either platform (#32), and says so on every reply.',
    {
      action: z.enum(['down', 'move', 'up']).describe("'down' press+hold, 'move' re-aim the held pointer, 'up' release."),
      selector: z.string().optional().describe('CSS selector to aim at (resolved on-device; refuses if occluded). Preferred.'),
      x: z.number().optional().describe('X (screenshot pixels) — used when no selector.'),
      y: z.number().optional().describe('Y (screenshot pixels) — used when no selector.'),
      button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button for 'down' (default 'left'); ignored on move/up (the held button is reused)."),
    },
    async ({ action, selector, x, y, button }) => {
      if (!selector && (x == null || y == null)) {
        return deviceFail({
          code: 'REFUSED_BY_OP',
          tool: 'device_pointer',
          what: `pointer ${action} on the device with no usable aim`,
          why: 'no `selector` was given and the coordinates were incomplete, so there is nowhere to aim. Guessing a point would act on something arbitrary and report success.',
          got: { action, selector, x, y },
          expected: 'either selector:"<css>" (preferred) or BOTH x and y in screenshot pixels',
        });
      }
      const aim = `pointer ${action} ${selector ? `selector ${JSON.stringify(selector)}` : `(${x},${y})`} on the device`;
      try {
        const scale = await coordScaleOrRefusal('device_pointer', `pointer ${action} at (${x},${y}) on the adb-connected device`, !!selector);
        if ('content' in scale) return scale;
        const params = selector ? { action, selector } : { action, x, y, ...(scale.screenInfo ? { screenInfo: scale.screenInfo } : {}) };
        const reply = await deviceRequest('pointer', { ...params, ...(button && action === 'down' ? { button } : {}) });
        // The device signals "nothing held" / "already held" / a selector miss the same way every
        // other Enact op does — an `Error: …` reply, not a thrown error (F9/F15's convention).
        if (isDeviceError(reply)) {
          return deviceReplyFailure('device_pointer', aim, reply, [
            "a 'move'/'up' with nothing held, or a 'down' while already held, is refused rather than acting on a stray/duplicate gesture",
            'a selector miss or an OCCLUDED target is refused rather than pressing something else — re-read the screen and aim again',
          ]);
        }
        return { content: [{ type: 'text' as const, text: `Pointer ${action} — ${String(reply)}` }] };
      } catch (e) {
        return caughtFailure('device_pointer', aim, e);
      }
    },
  );

  // ── Enact: dispatch a game action directly ─────────────────

  tool('device_dispatch_action',
    'Trigger a game intent directly on the device (no pixel-hunting a button) — dispatches a UI/game ' +
      'action from the action vocabulary. An unknown name comes back with the known list; a stale ' +
      'targetGuid or a not-playing game is reported as an error, not a phantom success.',
    {
      name: z.string().describe('Action name (e.g. engine.playClip). Unknown → the reply lists known names.'),
      payload: z.union([z.string(), z.number()]).optional().describe('Simple scalar payload.'),
      targetGuid: z.string().optional().describe('Stable guid of the entity the action targets.'),
      params: z.record(z.string(), z.any()).optional().describe('Structured params (e.g. { clip: "Walk" }).'),
    },
    async ({ name, payload, targetGuid, params }) => {
      try {
        const sent = { name, ...(payload !== undefined ? { payload } : {}), ...(targetGuid ? { targetGuid } : {}), ...(params ? { params } : {}) };
        const parsed = parseReply<{ dispatched?: boolean; ok?: boolean; reason?: string }>(await deviceRequest('dispatch-action', sent));
        const what = `dispatch the action "${name}" on the device`;
        if (isDeviceError(parsed)) {
          return deviceReplyFailure('device_dispatch_action', what, parsed, [
            'an UNKNOWN action name comes back with the list of known names — read it and pick one',
          ]);
        }
        // The op signals a no-op via {dispatched:false, reason} at a 200 — flag it rather than
        // reporting a phantom success (the device twin of editor finding F8).
        const failed = parsed && typeof parsed === 'object' && (parsed.dispatched === false || parsed.ok === false);
        if (failed) {
          return deviceFail({
            code: 'REFUSED_BY_OP',
            tool: 'device_dispatch_action',
            what,
            why: `the action was NOT dispatched${parsed.reason ? `: ${parsed.reason}` : ' and the device gave no reason'}. Nothing happened in the game.`,
            got: parsed,
            options: [
              'a stale targetGuid is the usual cause — re-read it with device_get_scene_state',
              'the game must be PLAYING for gameplay actions to have an effect',
            ],
          });
        }
        return { content: [{ type: 'text' as const, text: encodeStructuredResult(parsed) }] };
      } catch (e) {
        return caughtFailure('device_dispatch_action', `dispatch the action "${name}" on the device`, e);
      }
    },
  );

  // ── Enact: keyboard / hover / scroll ───────────────────────

  /** Send a device method whose reply is a bare `ok …` / `Error: …` string, flagging errors. */
  async function enactCall(tool: string, method: string, params: Record<string, unknown>, ok: (reply: string) => string) {
    const what = `send ${method} to the connected device`;
    try {
      const reply = await deviceRequest(method, params);
      if (isDeviceError(reply)) {
        return deviceReplyFailure(tool, what, reply, [
          'a selector miss / occluded target is reported here rather than as a phantom success — re-read the screen (device_layout_bounds) and aim again',
          'device_screenshot to see what is actually on screen',
        ]);
      }
      return { content: [{ type: 'text' as const, text: ok(String(reply)) }] };
    } catch (e) {
      return caughtFailure(tool, what, e);
    }
  }

  tool('device_press_key',
    'Press a key chord (keydown, brief hold, keyup) on the connected device — open the debug menu ' +
      '(key "F12"), Escape a modal, or drive gameplay keys. Dispatched on the focused element and ' +
      'bubbles to window, where the menu and input sources listen. The hold lets per-frame input ' +
      'sampling catch the down edge. Trusted-CDP on Android when a session is reachable; on iOS this ' +
      'stays SYNTHETIC by design — a WebDriverAgent key reaches only a FOCUSED element, so it would ' +
      'do nothing with a game canvas focused (#32). Check device_status\'s input-mechanism line.',
    {
      key: z.string().describe('KeyboardEvent.key, e.g. "F12", "Escape", "ArrowLeft", "a".'),
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional().describe('Held modifiers, e.g. ["meta"] for Cmd+key.'),
    },
    async ({ key, modifiers }) => enactCall('device_press_key', 'press-key', { key, ...(modifiers ? { modifiers } : {}) }, (r) => r.replace(/^ok /, 'Pressed ')),
  );

  // ── Type text ────────────────────────────────────────────

  /** The shape `handleType` (bridge.ts) returns — the device's local twin of `typeText`'s
   *  return type in `rendererOps.ts` (`engine/electron/rendererOps.ts`), plus an explicit `ok`. */
  // type-text is synthetic-only on BOTH platforms (never routed through CDP or WebDriverAgent), so
  // its reply's `inputMechanism` field is always SYNTHETIC_MECHANISM.
  interface TypeTextReply { ok: boolean; typed: number; activeElement: string | null; valueAfter?: string | null; error?: string; inputMechanism?: typeof SYNTHETIC_MECHANISM }

  tool('device_type_text',
    'Type text into the CURRENTLY-FOCUSED element on the connected device. FOCUS THE TARGET FIRST ' +
      'with device_tap on the input. `clearFirst` empties the field before typing (replace vs ' +
      'append); `submitKey` DISPATCHES a terminal key chord afterward (keydown+keyup). Note what ' +
      'that does and does not do — MEASURED on a real iPhone: the chord fires, so a handler ' +
      'listening for the key runs, but a synthetic KeyboardEvent does NOT drive the browser\'s own ' +
      'focus management, so \'Tab\'/\'Escape\' do NOT actually blur the field and \'Enter\' does not ' +
      'natively submit a form. Use it to trigger the app\'s OWN key handler; do not rely on it for ' +
      'focus movement. `typed` is MEASURED (whether the requested text actually landed in ' +
      'the field afterward), not the length of what you asked for, and `valueAfter` echoes the field ' +
      '— a short/failed insert is reported as a FAILURE naming what landed, never a phantom success. ' +
      'UNLIKE the editor\'s modoki_type_text, this dispatches a SYNTHETIC value-set + `input` event ' +
      '(a device WebView has no equivalent of Electron\'s trusted `sendInputEvent`) — a React ' +
      'controlled input still fires its real onChange (the native property setter is used, not a ' +
      'plain assignment), but this is not OS-level trusted input; see #32.',
    {
      text: z.string().describe('Text to type into the focused input.'),
      clearFirst: z.boolean().optional().describe('Empty the field before typing (replace vs append).'),
      submitKey: z.string().optional().describe("Terminal key chord dispatched after typing: 'Enter', 'Tab', or 'Escape'. Fires the app's key handlers; does NOT move focus or submit natively (synthetic events don't drive the browser's focus management) — measured on-device."),
    },
    async ({ text, clearFirst, submitKey }) => {
      const what = 'type text into the focused element on the device';
      try {
        const parsed = parseReply<TypeTextReply>(await deviceRequest('type-text', {
          text, ...(clearFirst !== undefined ? { clearFirst } : {}), ...(submitKey ? { submitKey } : {}),
        }));
        if (isDeviceError(parsed)) {
          return deviceReplyFailure('device_type_text', what, parsed, [
            'device_status — confirm the lease is still held and the game is running',
          ]);
        }
        if (!parsed?.ok) {
          return deviceFail({
            code: 'REFUSED_BY_OP',
            tool: 'device_type_text',
            what,
            why: parsed?.error ?? 'the device reported the type as unsuccessful with no reason.',
            got: parsed,
            options: [
              'nothing focused → device_tap the target input first, then type',
              'a readOnly/disabled/non-text control (checkbox, select, button) cannot receive typed text — aim at a real text field',
            ],
          });
        }
        return { content: [{ type: 'text' as const, text: encodeStructuredResult(parsed) }] };
      } catch (e) {
        return caughtFailure('device_type_text', what, e);
      }
    },
  );

/** The screenshot->CSS scale a COORDINATE aim needs, or a refusal when it cannot be supplied.
 *
 *  `device_tap` and `device_drag` both did this and `device_hover`/`device_scroll` did not
 *  (independent review, 2026-07-30) — they documented `x`/`y` as "screenshot pixels" and went
 *  through the same on-device `resolveAim` -> `screenshotToCSS`, but passed the coordinates RAW:
 *  no `screenInfo`, no adb check, no refusal. With `lastScreenInfo` null (an adb lease never runs
 *  the native captureScreen) `screenshotToCSS` returns the pixels unchanged as CSS coordinates, so
 *  the action landed at the wrong point and answered ok. Extracted so the four tools cannot drift
 *  again — the divergence existed because each wrote its own version. */
async function coordScaleOrRefusal(
  tool: string, what: string, bySelector: boolean,
): Promise<{ screenInfo: { imgW: number; imgH: number; nativeW: number; nativeH: number } | null } | DeviceToolResult> {
  if (bySelector) return { screenInfo: null }; // a selector resolves on-device; no scale needed
  const info = await currentScreenInfo();
  if (!info && await leaseUsesAdb()) {
    return deviceFail({
      code: 'NOT_AVAILABLE_HERE',
      tool,
      what,
      why: 'no screenshot scale is available for this lease, and an adb device has none of its own — the coordinates would be sent unscaled and the action would land somewhere else. Nothing was sent.',
      options: [
        'take a device_screenshot first: it measures the framebuffer and stamps the scale for this lease',
        'aim by `selector` instead — it resolves on-device and needs no scale at all',
      ],
    });
  }
  return { screenInfo: info };
}

  tool('device_hover',
    'Hover the pointer over a target on the device (pointerover/enter/move) so :hover styles, ' +
      'tooltips, and hover-gated UI activate. Aim by CSS `selector` (resolved on-device) or ' +
      'screenshot pixel `x`/`y`. Trusted-CDP on Android when a session is reachable; on iOS this ' +
      'stays SYNTHETIC by design — a touchscreen has no hover state to deliver (#32). Check ' +
      'device_status\'s input-mechanism line to know which.',
    {
      selector: z.string().optional().describe('CSS selector to hover (preferred).'),
      x: z.number().optional().describe('X (screenshot pixels) — used when no selector.'),
      y: z.number().optional().describe('Y (screenshot pixels) — used when no selector.'),
    },
    async ({ selector, x, y }) => {
      if (!selector && (x == null || y == null)) {
        return deviceFail({
          code: 'REFUSED_BY_OP',
          tool: 'device_hover',
          what: 'hover on the device with no usable aim',
          why: 'no `selector` was given and the coordinates were incomplete, so there is nowhere to hover.',
          got: { selector, x, y },
          expected: 'either selector:"<css>" (preferred) or BOTH x and y in screenshot pixels',
        });
      }
      const scale = await coordScaleOrRefusal('device_hover', `hover at (${x},${y}) on the adb-connected device`, !!selector);
      if ('content' in scale) return scale;
      return enactCall('device_hover', 'hover',
        selector ? { selector } : { x, y, ...(scale.screenInfo ? { screenInfo: scale.screenInfo } : {}) }, (r) => r);
    },
  );

  // TWIN PARITY (§8, found by the Phase-8 device sweep): this took `dx`/`dy` while its editor twin
  // `modoki_scroll` takes `deltaX`/`deltaY` — the same operation under two names, so an agent that
  // learned one surface got a strict-schema refusal on the other. `deltaX`/`deltaY` are now
  // canonical (the twin is the older, more-used spelling and the DOM's own), with `dx`/`dy` kept as
  // accepted aliases so no existing call breaks. The device-side op still speaks dx/dy on the wire.
  //
  // The zero-delta refusal is S3.15's twin: without it, a scroll with no delta dispatched a
  // zero-delta wheel and answered ok — nothing moved, reported as success.
  tool('device_scroll',
    'Scroll on the device by dispatching a wheel event. Aim by CSS `selector` or screenshot pixel ' +
      '`x`/`y` (defaults to viewport center). Positive `deltaY` scrolls down, positive `deltaX` ' +
      'scrolls right; ~120 ≈ one wheel tick. `dx`/`dy` are accepted aliases (the editor twin ' +
      'modoki_scroll uses deltaX/deltaY, so those are canonical here too). A call whose deltas both ' +
      'resolve to 0 is REFUSED rather than dispatched as a silent no-op. Trusted-CDP on Android when ' +
      'a session is reachable; on iOS this stays SYNTHETIC by design — WebDriverAgent has no wheel ' +
      'action at all (#32). Check device_status\'s input-mechanism line to know which.',
    {
      deltaX: z.number().optional().describe('Horizontal wheel delta (default 0). Canonical name — same as modoki_scroll.'),
      deltaY: z.number().optional().describe('Vertical wheel delta (default 0; positive = down). Canonical name — same as modoki_scroll.'),
      dx: z.number().optional().describe('Alias for deltaX, kept for existing callers.'),
      dy: z.number().optional().describe('Alias for deltaY, kept for existing callers.'),
      selector: z.string().optional().describe('CSS selector to scroll over.'),
      x: z.number().optional().describe('X (screenshot pixels) — the point to scroll over.'),
      y: z.number().optional().describe('Y (screenshot pixels).'),
    },
    async ({ deltaX, deltaY, dx, dy, selector, x, y }) => {
      const ex = deltaX ?? dx;
      const ey = deltaY ?? dy;
      if (!ex && !ey) {
        return deviceFail({
          code: 'REFUSED_BY_OP',
          tool: 'device_scroll',
          what: 'scroll on the device',
          why: 'neither deltaY nor deltaX is a non-zero number, so no wheel movement would be delivered.',
          expected: 'deltaY (~120 ≈ one wheel tick down, negative = up) and/or deltaX',
          options: ['deltaX/deltaY are canonical (dx/dy are accepted aliases)'],
        });
      }
      // A coordinate-aimed scroll needs the same screenshot->CSS scale a tap does; without it an
      // adb lease scrolls over the wrong point and reports ok. (A scroll with NEITHER selector nor
      // coords is aimed at the viewport centre on-device, which needs no scale.)
      const byCoords = !selector && (x != null || y != null);
      const scale = await coordScaleOrRefusal('device_scroll', `scroll at (${x},${y}) on the adb-connected device`, !byCoords);
      if ('content' in scale) return scale;
      return enactCall('device_scroll', 'scroll', {
        ...(ex != null ? { dx: ex } : {}), ...(ey != null ? { dy: ey } : {}),
        ...(selector ? { selector } : {}), ...(x != null ? { x } : {}), ...(y != null ? { y } : {}),
        ...(scale.screenInfo ? { screenInfo: scale.screenInfo } : {}),
      }, (r) => r);
    },
  );

  // ── Console Logs ───────────────────────────────────────────

  tool('device_console_logs',
    'Return captured console.log/warn/error/info from the game.',
    {
      limit: z.number().optional().describe('Max entries (default: 50)'),
      level: z.enum(['log', 'warn', 'error', 'info']).optional(),
    },
    async ({ limit, level }) => {
      try {
        const raw = await deviceRequest('consoleLogs', { limit: limit ?? 50, ...(level ? { level } : {}) });
        // The device signals a handler failure by RETURNING an `Error: …` STRING, which the transport
        // resolves as a normal result (that is why `isDeviceError` exists). Without this check the
        // string fell through to `result.map(...)`, threw "result.map is not a function", and
        // `caughtFailure` classified the throw as a TRANSPORT failure — so a device-side refusal was
        // reported as "the device app may have been backgrounded or killed; relaunch it". Wrong
        // cause, wrong remedy. Found by the Phase-8 table-driven device sweep.
        if (isDeviceError(raw)) return deviceReplyFailure('device_console_logs', 'read the captured console output from the device', raw);
        const result = parseReply<Array<{ level: string; args: string[]; timestamp: number }>>(raw);
        const text = !result || result.length === 0
          ? 'No console logs.'
          : result.map((l) => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level}] ${l.args.join(' ')}`).join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return caughtFailure('device_console_logs', 'read the captured console output from the device', e);
      }
    },
  );

  // ── Native Logs ────────────────────────────────────────────

  tool('device_native_logs',
    'Return native logs from the device (logcat on Android, os_log on iOS).',
    {
      limit: z.number().optional().describe('Max lines (default: 50)'),
      filter: z.string().optional().describe('Text filter (case-insensitive). Only return lines containing this string.'),
      seconds: z.number().optional().describe('Time window in seconds (default: 60)'),
    },
    async ({ limit, filter, seconds }) => {
      try {
        const raw = await deviceRequest('nativeLogs', {
          limit: limit ?? 50,
          seconds: seconds ?? 60,
          ...(filter ? { filter } : {}),
        });
        // Same class as device_console_logs above: an `Error: …` reply would be String()'d straight
        // into the payload and read as log CONTENT.
        if (isDeviceError(raw)) return deviceReplyFailure('device_native_logs', 'read the native device logs', raw);
        const result = parseReply<string[]>(raw);
        return { content: [{ type: 'text' as const, text: (Array.isArray(result) ? result.join('\n') : String(result)) || 'No logs.' }] };
      } catch (e) {
        return caughtFailure('device_native_logs', 'read the native device logs (logcat / os_log)', e);
      }
    },
  );
}
