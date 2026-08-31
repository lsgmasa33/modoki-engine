/**
 * Android trusted input via Chrome DevTools Protocol (#32 Phase 1).
 *
 * The mechanism, proven on hardware BEFORE this module existed (on a physical Samsung handset, see
 * docs/trusted-device-input.md):
 *   1. The debug WebView exposes an abstract socket `webview_devtools_remote_<pid>`
 *      (`adb shell cat /proc/net/unix`).
 *   2. `adb forward tcp:<local> localabstract:webview_devtools_remote_<pid>` then
 *      `GET /json/version` / `GET /json/list` over that forwarded port gives the page target's
 *      `webSocketDebuggerUrl`.
 *   3. `Input.dispatchTouchEvent` over that socket delivers `isTrusted: true` to the page's
 *      `pointerdown`/`touchstart` listeners. Coordinate space is 1:1 CSS px — CDP CSS px ==
 *      page CSS px, no DPR/letterbox transform (measured: css(180,353) → clientX:180,
 *      clientY:353 on a 360×705 dpr:3 viewport). Do NOT add one.
 *
 * A page cannot dispatch a TRUSTED event to itself, so injection happens HOST-SIDE (here), while
 * aim resolution (selector lookup, occlusion check, screenshot-pixel→CSS) stays in-page — that's
 * why `engine/app/debug/bridge.ts` grew a resolve-ONLY `resolve-aim` op alongside its existing
 * resolve-and-dispatch handlers.
 *
 * This module owns: discovery (adb → forwarded port → CDP target), a minimal CDP client (global
 * `WebSocket`, no `ws` dependency — same as `engine/electron/cdp.ts`'s renderer CDP), per-clone
 * port derivation, and the dispatch helpers. `tryDeviceCdpInput` is the seam
 * `editorBackendRouter.ts`'s `/api/device/request` handler calls: routable methods get trusted
 * CDP injection when a session is available. No device input is ever reported as `trusted-cdp`
 * unless it was actually delivered that way.
 *
 * Falling back to synthetic is ALLOWED but never QUIET. `tryDeviceCdpInput` returns why it could
 * not use the trusted path, and the router fronts the synthetic reply with a loud banner naming
 * the cause and its concrete consequence (no `isTrusted`). On iOS the router tries the
 * WebDriverAgent route (`deviceWda.ts`) before falling back at all. The owner's call, 2026-08-02:
 * keep device testing working everywhere rather than refusing,
 * but make a weaker mechanism impossible to skim past — a trailing ` [input:synthetic]` suffix was
 * too easy to miss on a long reply.
 *
 * Failure handling is deliberately NOT uniform, because "retry via synthetic" is only safe when
 * nothing landed:
 *   - no session / an app predating `resolve-aim` / nothing dispatched → fall back, WITH a reason;
 *   - the page refused the aim (bad selector, occluded)                → that `Error: …`, verbatim;
 *   - a CDP failure AFTER at least one event landed                    → a refusal naming the risk,
 *     never a fallback: a half-sent gesture leaves a finger down, and falling back would deliver a
 *     second complete gesture on top of it.
 */

import { execFileSync } from 'child_process';
import { adbArgs, adbBinary, forwardOwner } from './androidDevices';

import {
  decodeAimReply, resolveAimViaDevice, aimAsResolved, STALE_APP_REASON,
  type RouteOutcome, type AimOutcome,
} from './deviceAim';

// Re-exported so existing importers (router, tests) keep one import site while the definitions live
// in the shared module — both trusted transports must agree on these.
export { decodeAimReply, resolveAimViaDevice, STALE_APP_REASON };
export type { RouteOutcome, AimOutcome };

/** The literal this module reports for input actually delivered via CDP. Mirrors `INPUT_MECHANISM`
 *  in `engine/app/debug/bridge.ts` (the synthetic in-page fallback) — together they are the full
 *  set of mechanisms a `device_*` reply can report. See `deviceInputMechanismParity.test.ts`,
 *  which keeps this literal, bridge.ts's, and the MCP surface's copy in the game-debug-mcp package
 *  in sync (three separate runtimes/packages, no shared module graph — the same reason
 *  `INPUT_MECHANISM` is duplicated rather than imported). */
export const TRUSTED_CDP_MECHANISM = 'trusted-cdp' as const;

// ── Per-clone port derivation ──────────────────────────────────────────────

/** The base of the derived-port band this module uses for the adb-forwarded local port that talks
 *  to the device's CDP endpoint. Chosen to sit outside the existing bands already spoken for by
 *  this repo's convention (backend 5179+, Vite 5173+, editor-renderer CDP 9222+ — see root
 *  CLAUDE.md's Clones table and `engine/electron/cdp.ts`'s `resolveCdpPort`). */
export const DEFAULT_DEVICE_CDP_PORT = 9333;

function isValidPort(raw: unknown): boolean {
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536;
}

/** Resolve the LOCAL port this clone forwards the device's webview devtools socket to, and then
 *  speaks CDP over. Pure (env-injectable) so it's unit-testable without touching adb. Mirrors the
 *  repo's per-clone port convention exactly: `9333 + (backendPort - 5179)`, so two clones' backend
 *  ports (5179/5180/5181/…) never collide on this port either. `MODOKI_DEVICE_CDP_PORT` is an
 *  explicit override (parity with `MODOKI_CDP_PORT` for the editor-renderer CDP port), tried
 *  first; a missing/invalid `MODOKI_BACKEND_PORT` falls back to the hub's own default (5179), same
 *  fallback `launch-editor.sh` uses. */
export function resolveDeviceCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  if (isValidPort(env.MODOKI_DEVICE_CDP_PORT)) return Number(env.MODOKI_DEVICE_CDP_PORT);
  const backendPort = isValidPort(env.MODOKI_BACKEND_PORT) ? Number(env.MODOKI_BACKEND_PORT) : 5179;
  return DEFAULT_DEVICE_CDP_PORT + (backendPort - 5179);
}

// ── Discovery: adb → webview devtools socket → CDP target ─────────────────

/** One `webview_devtools_remote_<pid>` abstract socket name found in `/proc/net/unix`. */
export interface WebviewSocket {
  name: string;
  pid: string;
}

/** Pure parser for `adb shell cat /proc/net/unix` output — pulled out so discovery is testable
 *  without shelling to adb. Each debuggable WebView registers an abstract socket whose name ends
 *  `_<pid>`; `/proc/net/unix` lines carry the name as the last whitespace-separated field,
 *  prefixed `@` for an abstract socket. */
export function parseWebviewSockets(procNetUnixOutput: string): WebviewSocket[] {
  const out: WebviewSocket[] = [];
  for (const line of procNetUnixOutput.split('\n')) {
    const m = /@?(webview_devtools_remote_(\d+))\s*$/.exec(line.trim());
    if (m) out.push({ name: m[1], pid: m[2] });
  }
  return out;
}

/** `GET /json/version` reply shape (the fields we read). */
interface JsonVersion { 'Android-Package'?: string }
/** One entry of `GET /json/list` — the page target we dispatch input to. */
interface JsonListEntry { type?: string; webSocketDebuggerUrl?: string }

/** Budget for ONE discovery HTTP call. Matches the 4s the `adb` calls in `deviceCdpAdb` already
 *  use — they are halves of the same discovery step, so one budget covers it.
 *
 *  It MUST be bounded. Found sweeping for siblings of #99's unbounded WDA probe: every other I/O
 *  boundary in this module is deliberately capped (three `execFileSync` at 4s, the WebSocket
 *  connect on a timer, `send()` on the pending-map timer) and this was the one that was not. That
 *  asymmetry is the tell. The calls go to `127.0.0.1` through an `adb forward`, which looks safe
 *  and is not: the forward LISTENS whether or not anything is behind it, so with WiFi-adb or a
 *  sleeping device the socket can accept and then never answer — and this sits on the input path
 *  via `getDeviceCdpSession`, so an unbounded wait there hangs `device_tap` outright rather than
 *  merely making it slow. */
const CDP_DISCOVERY_TIMEOUT_MS = 4000;

async function httpGetJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(CDP_DISCOVERY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A resolved CDP target: the page's `webSocketDebuggerUrl`, plus which Android package it
 *  belongs to (when the devtools endpoint reports one) so callers can log/verify the match. */
export interface DeviceCdpTarget {
  webSocketDebuggerUrl: string;
  androidPackage?: string;
}

/** adb calls behind an overridable seam (mirrors `adbRunner` in deviceConnection.ts) so discovery
 *  is unit-testable without a real device. */
export const deviceCdpAdb = {
  listUnixSockets(serial?: string): string {
    return execFileSync(adbBinary(), adbArgs(serial, ['shell', 'cat', '/proc/net/unix']), { timeout: 4000, encoding: 'utf8' });
  },
  forward(localPort: number, socketName: string, serial?: string): void {
    execFileSync(adbBinary(), adbArgs(serial, ['forward', `tcp:${localPort}`, `localabstract:${socketName}`]), { timeout: 4000, stdio: 'pipe' });
  },
  listForwards(): string {
    return execFileSync(adbBinary(), ['forward', '--list'], { timeout: 4000, encoding: 'utf8' });
  },
  /** Remove this clone's CDP tunnel — but ONLY if the rule on `localPort` belongs to `serial`.
   *  `adb forward --remove` matches on the host port spec and ignores `-s`, so a serial-targeted
   *  removal can delete a SIBLING clone's live rule (#158). `localPort` is already per-clone
   *  (`resolveDeviceCdpPort`), which makes that unreachable here; this mirrors
   *  `adbRunner.removeForward` in deviceConnection.ts, including its FAIL-CLOSED handling of a
   *  list that cannot be read.
   *
   *  Called via `releaseCdpForward` — from `resetDeviceCdpSession` (which every teardown path,
   *  including a lease `disconnect()`, now goes through) and from `discoverDeviceCdpTarget` for a
   *  candidate that failed its probe (#160). */
  removeForward(localPort: number, serial?: string): void {
    if (serial) {
      let owner: string | undefined;
      try { owner = forwardOwner(deviceCdpAdb.listForwards(), localPort); }
      catch (e) {
        console.warn(`[device-cdp] skipping \`adb forward --remove tcp:${localPort}\`: could not verify the rule's owner (${e instanceof Error ? e.message : String(e)}) — refusing to delete a rule that may belong to another clone (#158)`);
        return;
      }
      if (owner && owner !== serial) {
        console.warn(`[device-cdp] skipping \`adb forward --remove tcp:${localPort}\`: that rule belongs to ${owner}, not ${serial} (#158)`);
        return;
      }
    }
    execFileSync(adbBinary(), adbArgs(serial, ['forward', '--remove', `tcp:${localPort}`]), { timeout: 4000, stdio: 'pipe' });
  },
};

/** The forward this module currently owns, latched when one is left standing so teardown can name
 *  the port AND serial it was created with — `removeForward`'s ownership check needs the serial,
 *  and by teardown time the caller's `opts` are long gone (#160). Null when no tunnel is open. */
let ownedForward: { port: number; serial?: string } | null = null;

/** Drop the forward this module owns, if any. Best-effort and never throws: a tunnel that is
 *  already gone (phone unplugged, adb dead) must not fail the teardown that was cleaning it up —
 *  the failure mode this closes is a rule LEFT standing, and throwing here would strand the
 *  callers that follow. Clears the latch either way, since a rule we cannot remove is not one we
 *  can keep claiming to own. */
function releaseCdpForward(): void {
  const owned = ownedForward;
  ownedForward = null;
  if (!owned) return;
  try { deviceCdpAdb.removeForward(owned.port, owned.serial); }
  catch (e) {
    console.warn(`[device-cdp] could not remove the CDP forward on tcp:${owned.port}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Discover the ONE Modoki webview's CDP target on the connected Android device: enumerate
 *  `webview_devtools_remote_<pid>` sockets, forward each candidate to `localPort` in turn, and
 *  probe `/json/version` for its `Android-Package`. When `preferPackage` is given (the app the
 *  Modoki device lease already knows it's holding, via `app-identity`), the FIRST socket whose
 *  package matches wins; otherwise the single socket found wins (ambiguous with >1 candidate and
 *  no preference: refuse rather than guess which app to drive). Returns `null` — never throws —
 *  on any failure (no adb, no device, no matching socket, port already in another use): the
 *  caller (`getDeviceCdpSession`) treats `null` as "no trusted route available", which is exactly
 *  the fallback-to-synthetic signal, not an error to surface. */
export async function discoverDeviceCdpTarget(opts: { localPort: number; preferPackage?: string; serial?: string }): Promise<DeviceCdpTarget | null> {
  try {
    const sockets = parseWebviewSockets(deviceCdpAdb.listUnixSockets(opts.serial));
    if (sockets.length === 0) return null;

    // With a preference, try every candidate (in discovery order) until one's package matches;
    // without one, more than one socket is ambiguous — refuse rather than guess which app to
    // drive (checked BEFORE any adb forward is attempted).
    if (!opts.preferPackage && sockets.length > 1) return null;

    for (const sock of sockets) {
      // A candidate that does NOT pan out must take its forward with it (#160). Each `forward`
      // overwrites the rule on `localPort`, so a rejected candidate is invisible while another
      // follows it — but the LAST one to fail used to survive the whole discovery, leaving a rule
      // pointing at a socket this function just declined. `keep` is what distinguishes the
      // returned tunnel (deliberately left standing — it IS the session's route) from every other
      // exit; `finally` runs on `continue` and on the `return` alike, which is the point.
      let forwarded = false;
      let keep = false;
      try {
        deviceCdpAdb.forward(opts.localPort, sock.name, opts.serial);
        forwarded = true;
        const version = await httpGetJson<JsonVersion>(`http://127.0.0.1:${opts.localPort}/json/version`);
        const pkg = version['Android-Package'];
        if (opts.preferPackage && pkg !== opts.preferPackage) continue;
        const list = await httpGetJson<JsonListEntry[]>(`http://127.0.0.1:${opts.localPort}/json/list`);
        const page = list.find((e) => e.type === 'page' && e.webSocketDebuggerUrl);
        if (!page?.webSocketDebuggerUrl) continue;
        keep = true;
        ownedForward = { port: opts.localPort, ...(opts.serial ? { serial: opts.serial } : {}) };
        return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, androidPackage: pkg };
      } catch {
        continue; // this candidate didn't pan out — try the next, or fall through to null
      } finally {
        if (forwarded && !keep) {
          // Not `releaseCdpForward()`: this rule is not the latched one, and clearing a latch that
          // belongs to a still-live session would strand ITS tunnel.
          try { deviceCdpAdb.removeForward(opts.localPort, opts.serial); } catch { /* already gone / adb absent */ }
        }
      }
    }
    return null;
  } catch {
    return null; // adb missing/unreachable, no device, etc. — no trusted route, not an error
  }
}

// ── Minimal CDP client (global WebSocket, no `ws` dep) ─────────────────────

/** One JSON-RPC round trip over a live CDP socket — the interface the dispatch helpers below need
 *  (and the seam tests inject a fake implementation of, so they never open a real socket). */
export interface CdpSender {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

const CDP_REQUEST_TIMEOUT_MS = 8000;

/** A live CDP session to the device's webview devtools socket. Modeled on the proven feasibility
 *  probe (`/tmp/cdp-trust-probe.mjs`): a global `WebSocket` (Node 22+), an incrementing id, and a
 *  pending-map keyed by id. `onClose` fires when the socket drops for ANY reason (error, remote
 *  close) so the owning session cache can drop its reference — a dead socket must never wedge a
 *  later call into an 8s timeout-then-fail when it could instead re-discover immediately. */
export class DeviceCdpSession implements CdpSender {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private onCloseCb: (() => void) | null = null;
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: unknown };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id == null) return; // an unsolicited CDP event, not a reply
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    const onDrop = () => this.handleClose();
    ws.addEventListener('close', onDrop);
    ws.addEventListener('error', onDrop);
  }

  static connect(url: string, timeoutMs = CDP_REQUEST_TIMEOUT_MS): Promise<DeviceCdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP connect to ${url} timed out`)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new DeviceCdpSession(ws)); }, { once: true });
      ws.addEventListener('error', (e: Event) => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${String((e as { message?: string }).message ?? e)}`)); }, { once: true });
    });
  }

  /** Register a callback for "this session is gone" — the session cache uses it to drop its
   *  reference so the NEXT call re-discovers rather than reusing a dead socket. */
  onClose(cb: () => void): void { this.onCloseCb = cb; }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP session is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP request timed out: ${method}`)); }, CDP_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('CDP session closed')); }
    this.pending.clear();
    this.onCloseCb?.();
  }

  isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.closed) return;
    try { this.ws.close(); } catch { /* already gone */ }
    this.handleClose();
  }
}

// ── Dispatch helpers (pure over a CdpSender — unit-testable with a fake sender) ────────────────

/** Tap = touchStart, ~90ms hold, touchEnd. The hold matters: per-frame Input sampling must see the
 *  down edge (measured on-device — mirrors `dispatchTapAt`'s 50ms synthetic hold, held slightly
 *  longer here since a real touch sequence has more listeners to reach). */
export async function cdpTap(sender: CdpSender, x: number, y: number, holdMs = 90): Promise<void> {
  await sender.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
  await new Promise((r) => setTimeout(r, holdMs));
  await sender.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

export async function cdpDrag(
  sender: CdpSender,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 5,
  delayMs = 20,
): Promise<void> {
  await sender.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, radiusX: 12, radiusY: 12, force: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    await new Promise((r) => setTimeout(r, delayMs));
    await sender.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
  }
  await sender.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** e.code for a bare key: single letters → `KeyX`, else the key itself — same convention as
 *  bridge.ts's `keyToCode` (duplicated rather than imported: bridge.ts is a browser bundle that
 *  pulls in `@capacitor/core`, which does not resolve in this Node backend). */
function keyToCdpCode(key: string): string {
  return key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
}

/** CDP `Input.dispatchKeyEvent`'s modifier bitmask: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
function cdpModifierBits(modifiers: string[]): number {
  return (modifiers.includes('alt') ? 1 : 0)
    | (modifiers.includes('ctrl') ? 2 : 0)
    | (modifiers.includes('meta') ? 4 : 0)
    | (modifiers.includes('shift') ? 8 : 0);
}

export async function cdpPressKey(sender: CdpSender, key: string, modifiers: string[] = [], code?: string): Promise<void> {
  const init = { key, code: code || keyToCdpCode(key), modifiers: cdpModifierBits(modifiers) };
  await sender.send('Input.dispatchKeyEvent', { type: 'keyDown', ...init });
  await sender.send('Input.dispatchKeyEvent', { type: 'keyUp', ...init });
}

export async function cdpHover(sender: CdpSender, x: number, y: number): Promise<void> {
  await sender.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

export async function cdpScroll(sender: CdpSender, x: number, y: number, dx = 0, dy = 0): Promise<void> {
  await sender.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
}

// ── Session lifecycle: lazy connect, reuse, clean teardown ─────────────────

let cachedSession: DeviceCdpSession | null = null;
/** The `Android-Package` the cached session was discovered FOR — the cache key that makes
 *  `preferPackage` meaningful across calls (#142). Null when discovery reported no package. */
let cachedPackage: string | null = null;
/** The adb SERIAL the cached session was discovered through (#149) — a second cache key, for the
 *  same reason `cachedPackage` is one. The `Android-Package` cannot stand in for it: two phones
 *  running the SAME app (the ordinary case when testing a build on two handsets) report an identical
 *  package, so a session discovered against phone A would satisfy a `preferPackage` check made by a
 *  lease holding phone B and drive the wrong device while reporting trusted input. */
let cachedSerial: string | null = null;
let inFlight: Promise<DeviceCdpSession | null> | null = null;

/** Get a live CDP session — reusing the cached one when it's still open, else discovering +
 *  connecting fresh. Returns `null` (never throws) when no trusted route is available for ANY
 *  reason: no adb, no device, no matching webview socket, ambiguous sockets with no preference, a
 *  connect failure. `null` is the fallback-to-synthetic signal, not an error. Concurrent callers
 *  share one in-flight discovery/connect rather than racing separate `adb forward`s. */
/** Test-only stand-in for discovery+connect. Set by `_setDeviceCdpSessionProbeForTests`, consulted
 *  HERE rather than injected per call site because the router deliberately does not thread a
 *  `getSession` through — and the thing #142's tests must observe is precisely whether the router
 *  reaches this function at all, and with which `preferPackage`. Never set in production. */
let sessionProbeForTests: ((opts: CdpSessionOpts) => Promise<DeviceCdpSession | null>) | null = null;

/** Test-only. Pass null to restore real discovery. */
export function _setDeviceCdpSessionProbeForTests(
  fn: ((opts: CdpSessionOpts) => Promise<DeviceCdpSession | null>) | null,
): void { sessionProbeForTests = fn; }

/** What identifies the session a caller needs: WHICH app (`preferPackage`, #142) and WHICH phone
 *  (`serial`, #149). Both are cache keys — see `cachedSerial` for why the package alone is not
 *  enough once two handsets run the same build. */
export interface CdpSessionOpts { preferPackage?: string; serial?: string }

export async function getDeviceCdpSession(opts: CdpSessionOpts = {}): Promise<DeviceCdpSession | null> {
  if (sessionProbeForTests) return sessionProbeForTests(opts);
  // A cache hit must still satisfy the CALLER's package requirement (#142). The cache used to be
  // consulted before `preferPackage` was looked at, so a session discovered by an earlier
  // unconstrained call was handed to a later constrained one — silently defeating the identity
  // check that exists to stop input reaching the wrong app/device. Mismatch ⇒ drop and rediscover.
  // The serial (#149) is keyed the same way and for the same reason, one device down.
  const satisfies = (!opts.preferPackage || cachedPackage === opts.preferPackage)
    && (!opts.serial || cachedSerial === opts.serial);
  if (cachedSession && !cachedSession.isClosed() && satisfies) return cachedSession;
  if (cachedSession && !satisfies) resetDeviceCdpSession();
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const localPort = resolveDeviceCdpPort();
        const target = await discoverDeviceCdpTarget({ localPort, preferPackage: opts.preferPackage, serial: opts.serial });
        if (!target) return null;
        let session: DeviceCdpSession;
        try { session = await DeviceCdpSession.connect(target.webSocketDebuggerUrl); }
        catch (e) {
          // Discovery left a forward standing for a session that never opened — nothing else will
          // ever reference it, so release it here rather than leaking it until the next reset.
          releaseCdpForward();
          throw e;
        }
        session.onClose(() => { if (cachedSession === session) { cachedSession = null; cachedPackage = null; cachedSerial = null; } });
        cachedSession = session;
        cachedPackage = target.androidPackage ?? null;
        cachedSerial = opts.serial ?? null;
        return session;
      } catch {
        return null;
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

/** Drop the cached session (closing it first) — used after a dispatch throws, so a session that
 *  went bad mid-call doesn't wedge every subsequent one behind the same broken socket.
 *
 *  It also removes the `adb forward` the session was reached through (#160). This is the ONE place
 *  that already means "this session is over", so it is where the tunnel's lifetime ends: for a long
 *  time nothing removed a CDP forward at all, and stale rules outlived the editor pointing at dead
 *  webview pids — the same *mask a device swap* hazard the lease's own forward-removal exists to
 *  prevent. Closing the socket without removing the forward is half a teardown. */
export function resetDeviceCdpSession(): void {
  cachedSession?.close();
  cachedSession = null;
  cachedPackage = null;
  cachedSerial = null;
  inFlight = null;
  releaseCdpForward();
}

/** Test-only reset — module state otherwise leaks between test files (vitest keeps the module
 *  instance alive). Not called by production code. */
export function _resetDeviceCdpStateForTests(): void { resetDeviceCdpSession(); }

// ── Routing: the seam editorBackendRouter.ts's /api/device/request handler calls ──────────────

/** The five ops this phase routes through CDP when a session is available. `type-text` stays
 *  synthetic in this phase (per the plan). */
const CDP_ROUTABLE_METHODS = new Set(['tap', 'drag', 'press-key', 'hover', 'scroll']);

export function isCdpRoutableMethod(method: string): boolean {
  return CDP_ROUTABLE_METHODS.has(method);
}

/** Every method that DELIVERS INPUT, routable or not.
 *
 *  The distinction that matters is not "did CDP handle it" but "is this input at all". `eval` and
 *  `screenshot` have no fidelity to report, so they must stay silent. `pointer` and `type-text`
 *  DO deliver input and Phase 1 deliberately leaves them synthetic — which, once `tap` started
 *  reporting `trusted-cdp` on the same device, became actively misleading: an agent that sees one
 *  input op come back trusted has every reason to assume its siblings are too. They earn the
 *  banner for the same reason a fallback does. (Found in the #32 close-out sweep — they were
 *  bucketed with `eval` and warned about nothing.) */
const DEVICE_INPUT_METHODS = new Set([...CDP_ROUTABLE_METHODS, 'pointer', 'type-text']);

/** Why an input op that CDP could route in principle was not routed in this phase. */
export const NOT_ROUTED_REASON =
  'this op is not routed through trusted input yet — #32 Phase 1 covers tap/drag/press_key/hover/'
  + 'scroll only, so pointer and type_text stay synthetic even where a trusted route exists';

/** @deprecated name kept for existing imports — the type is transport-agnostic now (`RouteOutcome`
 *  in deviceAim.ts), since the WDA route returns the identical shape. */
export type CdpRouteOutcome = RouteOutcome;

/** Why no trusted route exists at all. Names what to DO, since "unavailable" alone is not actionable. */
export const NO_SESSION_REASON =
  'no trusted input route for this op — on Android the debug WebView devtools socket is not reachable '
  + '(needs adb + a debug build); on iOS WebDriverAgent routes ONLY tap and drag, because press_key '
  + 'reaches just a focused element, WDA has no wheel action, and a touchscreen has no hover (#32)';



/** Why the trusted route was abandoned before dispatching anything. */
export const SESSION_LOST_REASON =
  'the trusted CDP route failed before dispatching (session dropped); it will be re-discovered on the next call';

/** Build the LOUD banner that fronts a synthetic reply when trusted input was possible in principle
 *  but unavailable in fact.
 *
 *  Deliberately a PREFIX, not a suffix: the existing ` [input:synthetic]` marker sits at the end of
 *  a long reply and is easy to skim past, which is exactly how an agent ends up believing a
 *  fidelity-sensitive check passed on a weaker mechanism. The banner also states the concrete
 *  consequence, so the reader does not have to know the backstory to judge whether it matters.
 *
 *  It used to cite a SECOND consequence — dispatch landing on the FIRST canvas in the document
 *  rather than the aimed-at one (#93). That is fixed: the bridge hit-tests for the canvas under the
 *  aim point and reports how it got there (`canvas:hit` | `only` | `contains` | `ambiguous`), so the
 *  banner points at that marker instead of warning blanket-style. Only `ambiguous` is still a guess. */
export function synthFallbackBanner(reason: string): string {
  return `\u26a0\ufe0f SYNTHETIC INPUT (NOT TRUSTED) — ${reason}. This input does NOT set isTrusted, so an `
    + 'isTrusted-gated handler will ignore it. Treat a pass here as weaker evidence than a trusted-input '
    + "pass, and check the reply's `canvas:` marker (#93) — `ambiguous` means the target canvas was a guess.";
}

/** What `tryDeviceCdpInput` needs from the caller: the device-lease proxy (to reach the page's
 *  `resolve-aim` op) and, for tests, an injectable session getter so a routing-choice test never
 *  opens a real socket. */
export interface CdpRouteDeps {
  proxy(method: string, params: Record<string, unknown>): Promise<unknown>;
  preferPackage?: string;
  /** The adb serial the LEASE resolved (#149) — so discovery targets the phone the lease is holding
   *  rather than whichever one adb lists first. Undefined reproduces the old behaviour and is only
   *  correct with exactly one device attached. */
  serial?: string;
  /** Overridable for tests. Defaults to the real `getDeviceCdpSession`. */
  getSession?: (opts: CdpSessionOpts) => Promise<DeviceCdpSession | null>;
}

/** Route ONE device-input method through CDP. Returns the same string shape the in-page synthetic
 *  handler would (suffixed ` [input:trusted-cdp]` on success — never on an `Error:` refusal,
 *  matching `withMechanismSuffix`'s rule in bridge.ts), or `null` to signal "not routable / no
 *  session available here" so the caller falls back to the existing synthetic proxy path
 *  unchanged. An aim-resolution failure (bad selector, occluded target) is a legitimate refusal —
 *  it returns the `Error: …` string directly, NOT `null`, since retrying via synthetic would hit
 *  the identical resolution failure. Only a genuine CDP/transport failure (thrown) resets the
 *  session and returns `null`. */
/** Drop a sustained `device_pointer` press before dispatching a TRUSTED gesture (#305).
 *
 *  The synthetic path supersedes a held press inside `handleTap`/`handleDrag`; this route never
 *  reaches them — it resolves the aim in-page, then injects host-side — so it has to ask. Without
 *  it the bridge keeps reporting `held:true` after a trusted tap while `pointerSource` has already
 *  handed the gesture over via #299's takeover: measured on an S22, where the next `device_pointer`
 *  `down` was then refused as "already held" with nothing actually held.
 *
 *  BEST-EFFORT BY CONSTRUCTION. An app built before this op exists answers with an error, and a
 *  device running an older build is the normal case — a stale bridge must not turn a working tap
 *  into a failure. So every outcome except a real release is swallowed and the gesture proceeds:
 *  the bookkeeping is worth fixing, never worth refusing input over. */
async function releaseHeldBeforeTrustedGesture(deps: CdpRouteDeps): Promise<string> {
  try {
    const raw = await deps.proxy('release-held-pointer', {});
    // ⚠️ DECODE THE WIRE SHAPE. The bridge answers over a TCP/JSON transport, so a handler that
    // returns an OBJECT arrives here as a JSON **string** — the exact trap `decodeAimReply` exists
    // for, and the one that once had `device_status` reporting `trusted-cdp` while every tap came
    // back synthetic. Reading `.released` off the string would silently yield undefined: the
    // release would still happen on-device, and the reply would just never mention it. That is a
    // quiet wrong answer, not a loud one.
    const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { released?: string | null } | null;
    const released = obj && typeof obj === 'object' ? obj.released : null;
    return released ? ` — released a pointer left held (${released}); a new gesture cannot coexist with it` : '';
  } catch {
    return ''; // op absent (older app build), unparseable, or a transport hiccup — never fail input
  }
}

export async function tryDeviceCdpInput(method: string, params: Record<string, unknown>, deps: CdpRouteDeps): Promise<CdpRouteOutcome> {
  // Not an input op at all (eval, screenshot, journal, …). There is no fidelity claim to make and
  // nothing to warn about — `reason: null` tells the caller to stay silent.
  if (!isCdpRoutableMethod(method)) {
    // An input op we simply do not route yet still warns; a non-input op (eval, screenshot, a
    // Percept read) has no mechanism to report and must stay silent.
    return { handled: false, reason: DEVICE_INPUT_METHODS.has(method) ? NOT_ROUTED_REASON : null };
  }
  const getSession = deps.getSession ?? getDeviceCdpSession;
  const session = await getSession({ preferPackage: deps.preferPackage, serial: deps.serial });
  if (!session) return { handled: false, reason: NO_SESSION_REASON };

  // How many CDP events actually LANDED. The distinction matters and a boolean set before the call
  // gets it wrong: `cdpTap`/`cdpDrag` send touchStart, hold, then touchEnd, so
  //   - a failure on the FIRST send dispatched nothing  → synthetic fallback is safe and correct;
  //   - a failure AFTER one landed leaves a finger DOWN → falling back would deliver a second,
  //     complete gesture on top of a stuck one (two inputs for one call).
  // Counting successful sends is the only way to tell those apart from out here, since the helpers
  // are opaque. `landed` is read in the catch below.
  let landed = 0;
  const counting: CdpSender = {
    send: async (m: string, p?: Record<string, unknown>) => {
      const r = await session.send(m, p);
      landed++;   // only on success — a throw propagates without incrementing
      return r;
    },
  };

  try {
    switch (method) {
      case 'tap': {
        const r = await resolveAimViaDevice(deps, params, 'selector', 'x', 'y');
        if (r.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
        if (r.kind === 'refusal') return { handled: true, reply: r.error };
        // After the aim resolves (a refused aim dispatches nothing, so it must steal nothing).
        const supersededTap = await releaseHeldBeforeTrustedGesture(deps);
        await cdpTap(counting, r.aim.x, r.aim.y);
        return { handled: true, reply: `ok (cdp touch) css(${Math.round(r.aim.x)},${Math.round(r.aim.y)}) @ ${aimAsResolved(r.aim.label)} [input:${TRUSTED_CDP_MECHANISM}]${supersededTap}` };
      }
      case 'drag': {
        const from = await resolveAimViaDevice(deps, params, 'fromSelector', 'fromX', 'fromY');
        if (from.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
        if (from.kind === 'refusal') return { handled: true, reply: from.error };
        const to = await resolveAimViaDevice(deps, params, 'toSelector', 'toX', 'toY');
        if (to.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
        if (to.kind === 'refusal') return { handled: true, reply: to.error };
        const steps = (params.steps as number) || 5;
        const delayMs = (params.delayMs as number) || 20;
        const supersededDrag = await releaseHeldBeforeTrustedGesture(deps);
        await cdpDrag(counting, from.aim, to.aim, steps, delayMs);
        return { handled: true, reply: `ok (cdp touch) css(${Math.round(from.aim.x)},${Math.round(from.aim.y)})→(${Math.round(to.aim.x)},${Math.round(to.aim.y)}) [input:${TRUSTED_CDP_MECHANISM}]${supersededDrag}` };
      }
      case 'press-key': {
        const key = params.key as string;
        if (!key) return { handled: true, reply: 'Error: press-key needs a key' };
        const modifiers = (params.modifiers as string[]) ?? [];
        await cdpPressKey(counting, key, modifiers, params.code as string | undefined);
        return { handled: true, reply: `ok (cdp key ${key}${modifiers.length ? ' +' + modifiers.join('+') : ''}) [input:${TRUSTED_CDP_MECHANISM}]` };
      }
      case 'hover': {
        const r = await resolveAimViaDevice(deps, params, 'selector', 'x', 'y');
        if (r.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
        if (r.kind === 'refusal') return { handled: true, reply: r.error };
        await cdpHover(counting, r.aim.x, r.aim.y);
        return { handled: true, reply: `ok (cdp hover) @ ${aimAsResolved(r.aim.label)} [input:${TRUSTED_CDP_MECHANISM}]` };
      }
      case 'scroll': {
        const r = await resolveAimViaDevice(deps, params, 'selector', 'x', 'y', true);
        if (r.kind === 'unsupported') return { handled: false, reason: STALE_APP_REASON };
        if (r.kind === 'refusal') return { handled: true, reply: r.error };
        const dx = (params.dx as number) ?? 0;
        const dy = (params.dy as number) ?? 0;
        await cdpScroll(counting, r.aim.x, r.aim.y, dx, dy);
        return { handled: true, reply: `ok (cdp scroll dx=${dx} dy=${dy}) @ ${aimAsResolved(r.aim.label)} [input:${TRUSTED_CDP_MECHANISM}]` };
      }
      default:
        return { handled: false, reason: null };
    }
  } catch (e) {
    // The session is suspect either way — drop it so the NEXT call re-discovers rather than
    // retrying the same broken socket. Never report trusted-cdp for input that may not have landed.
    resetDeviceCdpSession();
    if (landed > 0) {
      // Mid-gesture failure: refuse, and SAY the device may be mid-touch. Silently falling back
      // here would double-dispatch on top of a possibly-stuck finger.
      return { handled: true, reply:
        `Error: trusted CDP input failed mid-dispatch (${(e as Error).message}); the device may `
        + 'have a touch still down. Not retried via synthetic input — that would deliver the gesture '
        + 'twice. Re-run once the session re-establishes.' };
    }
    return { handled: false, reason: SESSION_LOST_REASON }; // nothing dispatched — synthetic is safe
  }
}

/** "Is a trusted route available right now" probe for `device_status`, without dispatching anything.
 *
 *  It must exercise the WHOLE chain, not the convenient half. The trusted route needs BOTH a CDP
 *  session (host → adb → webview devtools socket) AND an app build whose page answers `resolve-aim`
 *  — the host has no way to resolve a selector or an entity by itself. Checking only the session is
 *  what made `device_status` report `inputMechanism: "trusted-cdp"` on the Samstung while every tap
 *  came back `[input:synthetic]` (measured 2026-08-02, against an app predating `resolve-aim`).
 *  Claiming a fidelity the next call will not deliver is precisely the false-success class this
 *  surface exists to close, so the probe round-trips `resolve-aim` too.
 *
 *  `proxy` is optional so a caller with no lease can still ask the cheap question; without it this
 *  reports only whether a SESSION exists, and callers that can reach the device should pass it. */
export async function isDeviceCdpAvailable(
  opts: { preferPackage?: string; serial?: string; getSession?: CdpRouteDeps['getSession']; proxy?: CdpRouteDeps['proxy'] } = {},
): Promise<boolean> {
  const getSession = opts.getSession ?? getDeviceCdpSession;
  const session = await getSession({ preferPackage: opts.preferPackage, serial: opts.serial });
  if (!session) return false;
  if (!opts.proxy) return true;
  try {
    // A pure resolve — no input is dispatched. Any coordinate resolves, so this asks only
    // "does this build have the handler?", never "is this a valid target?".
    const outcome = decodeAimReply(await opts.proxy('resolve-aim', { selKey: 'selector', xKey: 'x', yKey: 'y', x: 0, y: 0 }));
    return outcome.kind !== 'unsupported';
  } catch {
    return false;
  }
}
