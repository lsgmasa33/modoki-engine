/**
 * iOS trusted input via WebDriverAgent (#32 Phase 2).
 *
 * The Android sibling is `deviceCdp.ts`; this is the same idea over a different transport. A page
 * cannot dispatch a TRUSTED event to itself, so injection happens HOST-SIDE while aim resolution
 * stays in-page (`resolve-aim`) — both routes share that seam via `deviceAim.ts`.
 *
 * ## Everything below was MEASURED on the iPhone Air against games/sling, 2026-08-02
 *
 * Do not re-derive these; re-run the probe if you doubt one.
 *
 *  - **A W3C Actions touch delivers `isTrusted: true`.** A tap produced the full native sequence —
 *    `pointerdown` → `touchstart` → `pointerup` → `touchend` → `click` — all trusted, on the CANVAS.
 *  - **The coordinate transform is IDENTITY.** Requested (210,473) arrived as `clientX:210,
 *    clientY:473` on a 420×912 dpr:3 viewport. No DPR, safe-area or letterbox math. Same conclusion
 *    as the CDP route. Do NOT add a transform.
 *  - **WDA supports ONLY `pointer` and `key` action types.** A `wheel` action is rejected outright:
 *    *"Only actions of '(pointer, key)' types are supported."* So there is no trusted `wheel` on iOS.
 *  - **WDA interpolates a drag itself.** One `pointerMove` with a duration produced 14 intermediate
 *    trusted `pointermove` events — finer than the synthetic path's stepping.
 *  - **A session created with NO `bundleId` does not restart the app.** (The spike's note that
 *    "creating a session activates the target app" applies only when one is passed.) That matters
 *    because a restart would rebind the debug bridge's port and invalidate the lease mid-run.
 *  - **A wrong endpoint returns HTTP 200 with the error in the BODY.** `/wda/tap/0` — the endpoint
 *    every older guide names — answers `unknown command` with a 200. So every reply is inspected
 *    for `value.error`; trusting the status code alone silently reports success for input that was
 *    never delivered. This cost three no-op taps during the spike before the body was read.
 *
 * ## Why only tap and drag are routed
 *
 * The five ops Android routes do NOT map 1:1 onto iOS, and the owner's call (2026-08-02) was to
 * route only what iOS can genuinely deliver AS THAT OP, rather than stamp `trusted` on something
 * weaker:
 *  - `press_key` — WDA accepts it and it IS trusted, but only reaches a FOCUSED element. Measured:
 *    with the canvas focused WDA answered `ok` and the page received nothing; with an input focused
 *    the same call delivered trusted `keydown`s and the field's value became "hi". Routing it would
 *    silently break agent workflows that use `device_press_key` for debug shortcuts, so it stays
 *    synthetic (where it reaches `window` regardless of focus).
 *  - `scroll` — there is no `wheel` action type. A trusted scroll could only be a touch DRAG, which
 *    fires touch events rather than `wheel`, and on a game canvas would be a real gameplay gesture
 *    (on sling, a drag flings the puck). Stays synthetic.
 *  - `hover` — a touchscreen has no hover state. Nothing to route to.
 * Each of those still gets the loud synthetic banner, so the weaker mechanism is never quiet.
 */

import { decodeAimReply, resolveAimViaDevice, aimAsResolved, STALE_APP_REASON, type RouteOutcome } from './deviceAim';
// TYPE-ONLY, and it must stay that way: `wdaLauncher` is loaded through a dynamic import below so
// an iOS-free session never pays for it. A type import is erased, so this costs nothing at runtime.
import type { LeaseHardware } from './wdaLauncher';

/** The literal this module reports for input actually delivered via WebDriverAgent. Third member of
 *  the mechanism set alongside `trusted-cdp` (Android) and `synthetic` (the in-page fallback). */
export const TRUSTED_WDA_MECHANISM = 'trusted-wda' as const;

/** WebDriverAgent's fixed HTTP port. It binds `0.0.0.0:8100` on the device, so the editor reaches it
 *  over the SAME Wi-Fi address the debug lease already uses — no `iproxy`/libimobiledevice, and no
 *  Mac-side install (measured: `devicectl` has no port-forward subcommand, so USB would have needed
 *  one). Overridable for an unusual setup; there is no per-clone derivation because the port lives
 *  on the DEVICE, and two clones driving one phone is already serialized by the lease. */
export const DEFAULT_WDA_PORT = 8100;

export function resolveWdaPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MODOKI_WDA_PORT;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_WDA_PORT;
}

/** A WDA reply. `value` is null on success for the action endpoints; a FAILED call still returns
 *  HTTP 200 with an error object here, which is why every response is decoded rather than
 *  status-checked. `/screenshot` is the one endpoint whose `value` is a payload — a base64 PNG
 *  string — so the union carries it rather than forcing a cast at that callsite. */
interface WdaReply { value?: { error?: string; message?: string } | string | null; sessionId?: string }

/** Minimal HTTP surface, injectable so routing tests never open a socket. */
export type WdaFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** POST/GET a WDA endpoint and RAISE on an error carried in the body.
 *
 *  The whole point of this helper: `res.ok` is not evidence. WDA answers a bad endpoint or a
 *  rejected action type with 200 + `{"value":{"error":…}}`, so a fire-and-forget call looks like it
 *  worked. Every caller goes through here. */
async function wdaCall(
  fetchImpl: WdaFetch, baseUrl: string, path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<WdaReply> {
  const url = `${baseUrl}${path}`;
  const res = await fetchImpl(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WDA ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  let reply: WdaReply;
  try { reply = JSON.parse(text) as WdaReply; }
  catch { throw new Error(`WDA ${path} → unparseable reply: ${text.slice(0, 200)}`); }
  // Only an OBJECT `value` can carry an error; `/screenshot` answers with a plain base64 string,
  // which is a payload, not a failure.
  const errValue = reply.value && typeof reply.value === 'object' ? reply.value : undefined;
  if (errValue?.error) throw new Error(`WDA ${path} → ${errValue.error}: ${String(errValue.message ?? '').slice(0, 200)}`);
  return reply;
}

/** A live WDA session: the device's agent URL plus the session id every actions call needs. */
export interface WdaSession {
  baseUrl: string;
  sessionId: string;
  /** Send a W3C Actions payload. */
  actions(payload: unknown): Promise<void>;
  /** Release any pointers left down (W3C `DELETE /actions`). Best-effort. */
  releaseActions(): Promise<void>;
  /** Capture the WHOLE DEVICE SCREEN as base64 PNG (W3C `GET /screenshot`). Not the app's own
   *  capture — see `tryDeviceWdaScreenshot` for what that difference buys and what it costs. */
  screenshot(): Promise<string>;
}

export function makeWdaSession(fetchImpl: WdaFetch, baseUrl: string, sessionId: string): WdaSession {
  return {
    baseUrl, sessionId,
    async actions(payload: unknown) { await wdaCall(fetchImpl, baseUrl, `/session/${sessionId}/actions`, { body: payload }); },
    async screenshot() {
      const reply = await wdaCall(fetchImpl, baseUrl, `/session/${sessionId}/screenshot`, { method: 'GET' });
      // `wdaCall` has already raised on a body-carried error; anything but a string here means WDA
      // answered a shape we do not understand, which must not be passed off as an image.
      if (typeof reply.value !== 'string' || !reply.value) throw new Error('WDA /screenshot returned no image data');
      return reply.value;
    },
    async releaseActions() {
      try { await wdaCall(fetchImpl, baseUrl, `/session/${sessionId}/actions`, { method: 'DELETE' }); }
      catch { /* best-effort: this runs on a path that already failed */ }
    },
  };
}

/** One touch pointer's action list, wrapped in the W3C envelope. */
function pointerActions(actions: unknown[]): unknown {
  return { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }] };
}

/** A trusted tap: move → down → hold → up, as ONE actions call.
 *
 *  The hold mirrors the synthetic path's ~90ms so per-frame Input sampling sees the down edge. */
export async function wdaTap(session: WdaSession, x: number, y: number, holdMs = 90): Promise<void> {
  await session.actions(pointerActions([
    { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: holdMs },
    { type: 'pointerUp', button: 0 },
  ]));
}

/** A trusted drag. WDA interpolates the move over `durationMs` itself (measured: 14 intermediate
 *  trusted `pointermove`s), so no manual stepping is needed — unlike the synthetic path, which must
 *  emit each step. `steps` is therefore accepted-and-ignored by the caller, not passed on. */
export async function wdaDrag(
  session: WdaSession,
  from: { x: number; y: number }, to: { x: number; y: number },
  durationMs = 300,
): Promise<void> {
  await session.actions(pointerActions([
    { type: 'pointerMove', duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: Math.max(1, Math.round(durationMs)), x: Math.round(to.x), y: Math.round(to.y) },
    { type: 'pointerUp', button: 0 },
  ]));
}

// ── Session discovery ─────────────────────────────────────────────────────────

let cached: WdaSession | null = null;
/** Why the last auto-launch attempt failed, so the fallback banner names the REAL cause ("no iOS
 *  device is connected", "not built — install it from Build Support") instead of the generic
 *  "WDA is not answering", which would send the reader looking in the wrong place. */
let lastLaunchFailure: string | null = null;

/** Reach WDA on the device and open a session, reusing a live one.
 *
 *  `platformName` alone, deliberately NO `bundleId`: passing one makes WDA ACTIVATE that app, which
 *  restarts it and rebinds the debug bridge's port out from under the lease. Measured — omitting it
 *  attaches without touching the foreground app. */
export async function getDeviceWdaSession(
  opts: {
    host?: string; port?: number; fetchImpl?: WdaFetch; autoLaunch?: boolean;
    /** What the leased device says its own hardware is, so the lazy launch below targets THAT
     *  phone rather than whatever is plugged into this Mac (#146). */
    lease?: LeaseHardware;
  } = {},
): Promise<WdaSession | null> {
  const host = opts.host;
  // No WiFi lease target ⇒ nothing to reach (adb/USB leases are Android). Dropping the cache here
  // is the second half of #519: `host` goes undefined exactly when the lease moved to an Android
  // device, so a session kept across that move would be handed to the next iOS call for a phone
  // this machine no longer holds.
  if (!host) { resetDeviceWdaSession(); return null; }
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as WdaFetch);
  const port = opts.port ?? resolveWdaPort();
  const baseUrl = `http://${host}:${port}`;
  // A cache hit must still be a session for the DEVICE THE CALLER ASKED FOR (#519) — the lease can
  // move (e.g. iPad → iPhone Air) between calls, and a stale `cached` would silently drive the WRONG
  // PHONE. `deviceCdp.ts` needed the identical fix one device down (#142 `cachedPackage`, #149
  // `cachedSerial`); this module simply never got it. No network teardown here — we've already lost
  // the lease on the old device by the time we notice, so reaching for it would only hang.
  if (cached && cached.baseUrl === baseUrl) return cached;
  if (cached) resetDeviceWdaSession();
  // Lazy launch (Phase 2b, Decision 1) — only on the INPUT path. `device_status` passes
  // autoLaunch:false because a status READ must not start a multi-second agent as a side effect;
  // it reports what is true now, and the first tap is what pays the spin-up.
  if (opts.autoLaunch) {
    const { ensureWdaRunning } = await import('./wdaLauncher');
    const r = await ensureWdaRunning({ host, port, ...(opts.lease ? { lease: opts.lease } : {}) });
    if (!r.running) { lastLaunchFailure = r.reason ?? null; return null; }
    lastLaunchFailure = null;
  }
  try {
    await wdaCall(fetchImpl, baseUrl, '/status');
    const reply = await wdaCall(fetchImpl, baseUrl, '/session', {
      body: { capabilities: { alwaysMatch: { platformName: 'iOS' }, firstMatch: [{}] } },
    });
    const sessionId = reply.sessionId ?? (reply.value as unknown as { sessionId?: string })?.sessionId;
    if (!sessionId) return null;
    cached = makeWdaSession(fetchImpl, baseUrl, sessionId);
    return cached;
  } catch {
    return null;   // WDA not running / unreachable — the caller falls back and says why
  }
}

export function resetDeviceWdaSession(): void { cached = null; }

/** Test seam — drop any cached session so one test cannot leak into the next. */
export function _resetDeviceWdaStateForTests(): void { resetDeviceWdaSession(); lastLaunchFailure = null; }

// ── Routing ───────────────────────────────────────────────────────────────────

/** The ops WDA can genuinely deliver AS THAT OP on iOS. See the module header for why press_key,
 *  scroll and hover are excluded — each was measured, not assumed. */
const WDA_ROUTABLE_METHODS = new Set(['tap', 'drag']);

export function isWdaRoutableMethod(method: string): boolean { return WDA_ROUTABLE_METHODS.has(method); }

/** Why no WDA route exists. Actionable: the fix is to install/start the agent. */
export const WDA_NOT_RUNNING_REASON =
  'no trusted input route to this device — WebDriverAgent is not answering on the phone. Install it '
  + 'from Build Support (iOS), then start it; it runs only while its xcodebuild test process is alive';

/** The device holding the lease is not an iPhone/iPad, so there is no agent to reach (#99).
 *
 *  A DISTINCT reason on purpose. Without the platform gate, a non-iOS device fell into the iOS
 *  path and was told "cannot start WebDriverAgent — cannot tell which iPhone to use — 4 are
 *  paired… set MODOKI_IOS_DEVICE_UDID", which is advice an Android user cannot act on and that
 *  points at the wrong machine entirely. Measured on a Samsung reached by IP, 2026-08-03.
 *
 *  For INPUT this reason is never the one shown — the CDP layer's `NO_SESSION_REASON` already
 *  names the real fix for Android ("needs adb + a debug build") and is kept instead. This is for
 *  the screenshot route, where an explicit `source:'wda'` deserves a direct answer. */
export const WDA_NOT_IOS_REASON =
  'WebDriverAgent is an iOS agent and this lease is not holding an iOS device, so there is no '
  + 'out-of-app capture route here — use the ordinary device_screenshot (native capture)';

/** The pre-built "no agent on this device" outcome, so the non-iOS branches read as a value rather
 *  than a call that has to be skipped. */
export const NO_WDA_ON_THIS_DEVICE: WdaShotOutcome = { handled: false, reason: WDA_NOT_IOS_REASON };

/** Abandoned before dispatching anything. */
export const WDA_SESSION_LOST_REASON =
  'the trusted WebDriverAgent route failed before dispatching (session dropped); it will be re-established on the next call';

export interface WdaRouteDeps {
  proxy(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** The device's LAN address, from the lease target. Absent ⇒ no WDA route (adb/USB is Android). */
  host?: string;
  /** The leased device's own hardware report, so a lazy launch can be tied to it (#146). */
  lease?: LeaseHardware;
  getSession?: (opts: { host?: string; autoLaunch?: boolean; lease?: LeaseHardware }) => Promise<WdaSession | null>;
}

/** Route ONE device-input method through WebDriverAgent. Same contract as `tryDeviceCdpInput`.
 *
 *  Failure handling differs from CDP in one deliberate way. A CDP gesture is several sends, so a
 *  mid-gesture failure can leave a finger down and falling back would double-dispatch — CDP has to
 *  REFUSE. A WDA gesture is ONE actions call carrying the whole sequence, and W3C defines
 *  `DELETE /actions` to release any pointers left down. So here we release first and then fall back
 *  safely, which is strictly better than refusing: the user still gets their input. */
export async function tryDeviceWdaInput(method: string, params: Record<string, unknown>, deps: WdaRouteDeps): Promise<RouteOutcome> {
  if (!isWdaRoutableMethod(method)) return { handled: false, reason: null };

  const getSession = deps.getSession ?? getDeviceWdaSession;
  // autoLaunch: this IS the "first input op" Decision 1 starts the agent on.
  const session = await getSession({ host: deps.host, autoLaunch: true, ...(deps.lease ? { lease: deps.lease } : {}) });
  if (!session) return { handled: false, reason: lastLaunchFailure ?? WDA_NOT_RUNNING_REASON };

  try {
    if (method === 'tap') {
      const r = await resolveAimViaDevice(deps, params, 'selector', 'x', 'y');
      if (r.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
      if (r.kind === 'refusal') return { handled: true, reply: r.error };
      await wdaTap(session, r.aim.x, r.aim.y);
      return { handled: true, reply: `ok (wda touch) css(${Math.round(r.aim.x)},${Math.round(r.aim.y)}) @ ${aimAsResolved(r.aim.label)} [input:${TRUSTED_WDA_MECHANISM}]` };
    }
    // drag
    const from = await resolveAimViaDevice(deps, params, 'fromSelector', 'fromX', 'fromY');
    if (from.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
    if (from.kind === 'refusal') return { handled: true, reply: from.error };
    const to = await resolveAimViaDevice(deps, params, 'toSelector', 'toX', 'toY');
    if (to.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
    if (to.kind === 'refusal') return { handled: true, reply: to.error };
    // The synthetic path expresses a drag as steps×delay; WDA interpolates from a DURATION. Convert
    // rather than ignore, so a caller that slowed a drag down still gets a slow drag.
    const steps = (params.steps as number) || 5;
    const delayMs = (params.delayMs as number) || 20;
    await wdaDrag(session, from.aim, to.aim, steps * delayMs);
    return { handled: true, reply: `ok (wda touch) css(${Math.round(from.aim.x)},${Math.round(from.aim.y)})→(${Math.round(to.aim.x)},${Math.round(to.aim.y)}) [input:${TRUSTED_WDA_MECHANISM}]` };
  } catch {
    // Release any pointer the failed gesture may have left down, THEN let the caller fall back.
    await session.releaseActions();
    resetDeviceWdaSession();
    return { handled: false, reason: WDA_SESSION_LOST_REASON };
  }
}

// ── Screenshot (#102) ─────────────────────────────────────────────────────────

/** Why a WDA capture could not be taken. Actionable, and distinct from the INPUT reasons above so a
 *  reader is not sent to Build Support for a problem that is really "no WiFi lease". */
export const WDA_SHOT_NO_SESSION_REASON =
  'WebDriverAgent is not answering on the phone, so the out-of-app capture is unavailable — install '
  + 'it from Build Support (iOS) and make sure the lease is a WiFi one (adb/USB leases are Android)';

/** The coordinate-space warning every WDA capture carries.
 *
 *  THIS IS THE POINT OF THE FEATURE'S RISK, not boilerplate. Screenshot pixels are an AIM SPACE:
 *  the device sets `lastScreenInfo` on its NATIVE capture and `device_tap {x,y}` scales through it.
 *  A WDA capture is the whole DEVICE screen — status bar, letterboxing, possibly a system dialog
 *  over the app — so its pixels are not page pixels, and a stale mapping from an earlier native
 *  capture would silently mis-scale a tap aimed off this image. Loud text is the mitigation,
 *  because the failure is quiet by construction: wrong coordinates still "work". */
export const WDA_SHOT_COORDINATE_WARNING =
  '⚠️  DEVICE-SCREEN pixels, not page coordinates. This is WebDriverAgent\'s full-screen capture '
  + '(status bar and any system UI included), so these x/y do NOT map to device_tap/device_drag — '
  + 'aim by selector/entity instead, or take a normal (native) screenshot first.';

/** Width/height straight out of a PNG's IHDR chunk — bytes 16..24 of the file.
 *
 *  WDA reports no dimensions with the image, and the reply shape the MCP decodes wants them. Read
 *  from the header rather than decoding the image: dependency-free, and a handful of bytes. Returns
 *  null for anything that is not a PNG, so a surprise payload degrades to "no dimensions" instead
 *  of confidently reporting nonsense. */
export function pngDimensions(base64: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.from(base64.slice(0, 64), 'base64');
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

/** The outcome of trying to capture through WDA. Mirrors `RouteOutcome`'s split, but carries an
 *  object reply (the screenshot envelope) rather than a status line. */
export type WdaShotOutcome =
  | { handled: true; reply: Record<string, unknown> }
  | { handled: false; reason: string };

/** Capture the device screen via WebDriverAgent (#102).
 *
 *  WHY THIS EXISTS AT ALL, given the native iOS capture is faithful: the native path is the APP'S
 *  OWN capture, so it can only ever show the app. A system permission/ATT prompt is a different
 *  window — the native capture comes back showing the app UNDERNEATH it, which looks like a
 *  perfectly good screenshot of the wrong thing. Same for springboard after a background or a
 *  crash. Those are the moments a picture is worth most, and there was no way to get one.
 *
 *  `autoLaunch` is deliberately the caller's choice: an explicit `source:'wda'` request may pay the
 *  ~6s agent spin-up, but the automatic fallback from a failed native capture must NOT — a
 *  screenshot that silently takes six seconds because the app crashed is a worse experience than
 *  one that says why it could not help. */
export async function tryDeviceWdaScreenshot(
  deps: { host?: string; lease?: LeaseHardware; getSession?: WdaRouteDeps['getSession'] },
  opts: { autoLaunch?: boolean } = {},
): Promise<WdaShotOutcome> {
  const getSession = deps.getSession ?? getDeviceWdaSession;
  const session = await getSession({
    host: deps.host, autoLaunch: opts.autoLaunch ?? false, ...(deps.lease ? { lease: deps.lease } : {}),
  });
  if (!session) return { handled: false, reason: lastLaunchFailure ?? WDA_SHOT_NO_SESSION_REASON };
  try {
    const base64 = await session.screenshot();
    const dims = pngDimensions(base64);
    return {
      handled: true,
      reply: {
        image: `data:image/png;base64,${base64}`,
        source: TRUSTED_WDA_MECHANISM,
        warning: WDA_SHOT_COORDINATE_WARNING,
        ...(dims
          ? { imageWidth: dims.width, imageHeight: dims.height, screenWidth: dims.width, screenHeight: dims.height }
          : {}),
      },
    };
  } catch (e) {
    // Drop the cached session: the usual cause is that the agent died (its xcodebuild test process
    // is not running), and a stale session id would fail every later call the same way.
    resetDeviceWdaSession();
    return { handled: false, reason: `the WebDriverAgent capture failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** "Is a trusted iOS route available right now" probe for `device_status`, dispatching nothing.
 *
 *  Exercises the WHOLE chain like its CDP twin: a WDA session AND an app build whose page answers
 *  `resolve-aim`. Checking only the session is what made `device_status` claim `trusted-cdp` on
 *  Android while every tap came back synthetic. */
export async function isDeviceWdaAvailable(
  opts: { host?: string; getSession?: WdaRouteDeps['getSession']; proxy?: WdaRouteDeps['proxy'] } = {},
): Promise<boolean> {
  const getSession = opts.getSession ?? getDeviceWdaSession;
  // Explicitly NO autoLaunch: a status read reports what is true right now. Starting a 30-second
  // agent because someone asked a question would make `device_status` an action with a side effect.
  const session = await getSession({ host: opts.host, autoLaunch: false });
  if (!session) return false;
  if (!opts.proxy) return true;
  try {
    const outcome = decodeAimReply(await opts.proxy('resolve-aim', { selKey: 'selector', xKey: 'x', yKey: 'y', x: 0, y: 0 }));
    return outcome.kind !== 'unsupported';
  } catch {
    return false;
  }
}
