/**
 * Device connection manager — P3 control plane (real TCP, no native dependency to unit-test).
 *
 * The backend-side owner of the device link. Wraps the pure {@link DeviceLeaseClient} (P0) over a
 * real TCP {@link LeaseTransport}, and exposes connect/disconnect/status for the `/api/device/*`
 * routes. One instance per backend process → one per clone (each clone's editor has its own
 * pinned `MODOKI_BACKEND` port), so two clones never share a manager. See
 * `docs/debug-tools-mcp.md`.
 *
 * The GUID is Modoki-generated and PERSISTED per clone (`.modoki/device-guid`), so restarting the
 * editor re-presents the same token and the device (within its grace window) accepts it — the
 * whole reason Modoki, not the device, mints it.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFileSync, execFile as execFileDevice } from 'child_process';
import { promisify } from 'node:util';
import {
  adbArgs, adbBinary, describeAndroidDevice, forwardOwner, listAndroidDevices, resolveAndroidSerial,
  withFriendlyNames,
} from './androidDevices';
import { adbDeviceId, claimDevice, releaseDevice, releaseAllForThisProcess, sweepStaleClaims, wifiDeviceId } from './deviceClaims';
import { DeviceLeaseClient, type LeaseTransport, type LeaseRequest, type LeaseReply, type LeaseState } from './deviceLease';
import { resetDeviceCdpSession, resolveDeviceCdpPort } from './deviceCdp';
import { parseBoundBridgePort } from './deviceAndroidDiag';

/** Async exec for the one adb call whose caller can await it — see `adbRunner.logcatDump`. */
const execFileAsyncDevice = promisify(execFileDevice);

/** The device plugin's TCP port (matches `GameDebugPlugin` default). This is the port ON THE PHONE
 *  — it is a property of the app, shared by every Modoki game, and deliberately NOT per-clone. */
export const DEVICE_PORT = 9095;

/** Base of the derived band for the HOST side of the adb tunnel. See {@link resolveDeviceHostPort}. */
export const DEVICE_HOST_PORT_BASE = 9095;

function isValidPort(raw: unknown): boolean {
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536;
}

/** Resolve the LOCAL port this clone forwards the device bridge to — `9095 + (backendPort − 5179)`,
 *  the repo's per-clone port idiom (backend 5179+, Vite 5173+, editor CDP 9222+, device CDP 9333+;
 *  see root CLAUDE.md's Clones table). `MODOKI_DEVICE_HOST_PORT` overrides; a missing/invalid
 *  `MODOKI_BACKEND_PORT` falls back to the hub's 5179, same as `launch-editor.sh`.
 *
 *  WHY (#158). The device CLAIM (#149) arbitrates the phone; it cannot arbitrate the host port, and
 *  that port used to be a hardcoded machine-wide 9095. So two clones leasing two DIFFERENT phones
 *  both passed the claim — correctly, different `deviceId`s — and then silently fought over one
 *  forward. Measured 2026-08-07: the second `adb forward` won, and the first clone's lease was
 *  pointed at the wrong handset with no error on either side, while its editor still displayed
 *  `connected` to the phone it thought it held. The failure the claim exists to prevent, reached by
 *  a path it structurally cannot see.
 *
 *  Only the HOST side varies — the device side stays {@link DEVICE_PORT}, so nothing on the phone
 *  changes and two clones can hold two phones at once:
 *  `adb -s <serial> forward tcp:<hostPort> tcp:9095`.
 *
 *  ⚠️ KNOWN GAP, shared with `resolveDeviceCdpPort` and inherited deliberately rather than
 *  half-fixed: under `MODOKI_MULTI=1` the backend auto-picks its port and `MODOKI_BACKEND_PORT` is
 *  unset, so every editor in that clone derives the same 9095. Two MULTI editors leasing two phones
 *  would collide exactly as two clones used to. It needs the backend's ACTUALLY-BOUND port threaded
 *  in rather than read from env, which both derivations would have to adopt together.
 *
 *  Until then, `removeForward`'s ownership check NARROWS that case but does not close it: `--list`
 *  and `--remove` are two adb calls, not one atomic operation, so a sibling can re-forward the same
 *  host port in the window between them and still lose its rule. Per-clone ports are the real fix;
 *  the check is a backstop, and describing it as more than that would be wrong. */
export function resolveDeviceHostPort(env: NodeJS.ProcessEnv = process.env): number {
  if (isValidPort(env.MODOKI_DEVICE_HOST_PORT)) return Number(env.MODOKI_DEVICE_HOST_PORT);
  const backendPort = isValidPort(env.MODOKI_BACKEND_PORT) ? Number(env.MODOKI_BACKEND_PORT) : 5179;
  return DEVICE_HOST_PORT_BASE + (backendPort - 5179);
}

/** Turn a bare `ECONNREFUSED` on the DEFAULT port into the answer to the question it actually
 *  raises (#95).
 *
 *  `ECONNREFUSED` reads as "the app isn't running" or "the debug bridge is off". On this surface
 *  that is frequently WRONG, and misleadingly so: 9095 is a fixed default shared by every Modoki
 *  game, so if another one already holds it the app you just launched binds an OS-assigned port
 *  instead (#88) and is perfectly healthy — just not here. Nothing discovers that port, so the
 *  session dead-ends on a message pointing the wrong way. Measured 2026-08-02: this cost about an
 *  hour on the iPhone Air, where a resident Modoki app held 9095 through repeated relaunches, and
 *  the fix was to read the real port out of the device console and pass it explicitly.
 *
 *  Apps built after #95 release the port when they background, so the common case resolves itself.
 *  This message is for the rest: an older build, or two apps racing on a switch. Left as a pure
 *  string transform so it is trivially testable.
 *
 *  **`useAdb` exists because over a tunnel there IS no ECONNREFUSED** (#164). `adb forward` accepts
 *  the connection on this clone's local port and only then discovers the device end is dead, so
 *  `transport.open()` SUCCEEDS and it is the handshake that gets no reply — which
 *  `DeviceLeaseClient.connect` reads, correctly for WiFi, as "reachable but owned" and reports as
 *  `busy` / `refused`. The result is that the single most common failure on USB (nothing listening,
 *  because the native debug gate is off) is reported as the one thing it is NOT: another Modoki
 *  holding the lease. The advice above — the one message that would have said "nothing is
 *  listening" — is unreachable on that path by construction, since its ECONNREFUSED never arrives.
 *
 *  This does NOT try to tell the two apart, because from here they are genuinely
 *  indistinguishable: a first-wins plugin refuses an extra client by dropping the socket without a
 *  reply, which is byte-for-byte what a dead device end looks like through a forward. It names both
 *  and gives the one command that settles it. Reporting two candidates honestly beats reporting one
 *  confidently and wrongly. */
export function explainConnectFailure(
  detail: string | undefined, port: number, useAdb = false, debugBuild?: boolean,
  fallbackPort?: number | null,
): string | undefined {
  // ⭐ A KNOWN FALLBACK PORT OUTRANKS EVERY GUESS BELOW, because it is not a guess: the app
  // PRINTED the port it bound. 9095 is shared by every Modoki game, so when a second one still
  // holds it the app under test takes an OS-assigned port exactly as designed — and this message
  // used to describe that state as "the native debug gate is off … rebuild", which is an
  // expensive wrong turn and, on a device case, reads as a product defect in the project under
  // test. Measured on a Galaxy A23 carrying 20 Modoki apps (bug `OikQcN8V5NMH0xUr9UnK`): a
  // backgrounded `com.apiary.court` released 9095 0.3s after the app under test had already
  // fallen back, and the diagnosis cost a pass through gradle, node_modules, capacitor config and
  // module DCE before logcat gave it away.
  if (fallbackPort && fallbackPort !== port) {
    return `refused on port ${port} — but the app is RUNNING and listening on ${fallbackPort}. `
      + `${port} is shared by every Modoki game, so when another one still holds it the app you `
      + `just launched falls back to an OS-assigned port (#88) and logs which. Nothing is wrong `
      + `with the build, the debug gate, or the lease. Fix, either way round: reconnect with `
      + `\`device_connect {..., port: ${fallbackPort}}\`, or force-stop the app squatting `
      + `${port} (\`adb shell ps -A | grep modoki\`, then \`adb shell am force-stop <pkg>\`) and `
      + `relaunch, after which it binds ${port} first try.`;
  }
  // ⭐ A KNOWN-OFF FLAG IS THE LEADING SUSPECT (#239) — but only ECONNREFUSED lets it be the
  // ONLY one, and that asymmetry is the whole of this branch.
  //
  // `build.debugBuild: false` means no TCP server was compiled in, so a project with it off
  // explains "nothing is listening" completely. Six of twenty projects shipped without the flag
  // and each cost a hunt, because the adb advice below leads with a HEAL problem — and healing a
  // `false` flag writes it off again, so its one suggested fix could not work.
  //
  // ⚠️ **BUT THE FLAG IS THE OPEN PROJECT'S, AND THE PHONE MAY BE RUNNING A DIFFERENT APP.** The
  // running app is only knowable AFTER a lease opens (`device_status` reports the socket holder
  // for exactly this reason, #88), so at this moment it is unknown. That matters because
  // `refused` means the socket OPENED and the handshake got no reply — something ACCEPTED the
  // connection, which is proof a server is listening and therefore proof it is not simply absent.
  // A backgrounded sibling app squatting the shared 9095 produces precisely that, and it is not
  // hypothetical: it was hit on a Galaxy A23 on 2026-08-19, where `sling` answered a connect
  // aimed at `postfx-demo`. So `refused` keeps the second cause; only ECONNREFUSED — where
  // nothing accepted at all — gets to be definitive.
  const flagOff = debugBuild === false;
  if (flagOff && detail && /ECONNREFUSED/i.test(detail)) {
    return `${detail} — this project has \`build.debugBuild: false\`, so the app was built with `
      + `NO debug bridge: there is no TCP server on the device to connect to, and no lease to `
      + `take. Nothing about the network, the port, or another Modoki holding the lease is `
      + `involved. Fix: set Project Settings → Developer → "Debug build" (or \`build.debugBuild: `
      + `true\` in project.config.json), then REBUILD and redeploy — reopening the project alone `
      + `is not enough, because heal syncs the flag's current value into the native project and `
      + `that value is off.`;
  }
  if (flagOff && detail === 'refused') {
    return `refused — the socket opened but the app never answered the lease handshake. This `
      + `project has \`build.debugBuild: false\`, so it ships NO debug bridge, which is the `
      + `likeliest cause and the one to rule out first: set Project Settings → Developer → `
      + `"Debug build" (or \`build.debugBuild: true\`), then REBUILD and redeploy — reopening the `
      + `project alone is not enough, because heal syncs the flag's current value and that value `
      + `is off.\n  It is NOT the only cause, because something accepted the connection: over adb `
      + `the forward accepts on this clone's end even when the device port is dead, and over WiFi `
      + `an accepted socket means some app IS listening on ${port} — a backgrounded sibling Modoki `
      + `game squatting the shared port answers exactly like this. Find the REAL holder by its `
      + `socket, not by its name — \`adb shell 'cat /proc/net/tcp /proc/net/tcp6' | awk '$4=="0A"'\` `
      + `lists every listener with its uid — then force-stop that app, or relaunch this one. `
      + `Grepping for "modoki" misses games whose package is not named that (com.apiary.court is `
      + `one, and it cost a session an hour — #283).`;
  }
  // `refused` is the sentinel `DeviceLeaseClient.connect` sets when the socket opened but the
  // handshake produced nothing (deviceLease.ts). A GENUINE busy reply from the device always names
  // its reason — `busy` / `no-lease` / `not-owner` — so this branch cannot swallow a real lease
  // conflict; it only catches the case the device never answered at all.
  if (useAdb && detail === 'refused') {
    return `refused — the adb tunnel opened but the app never answered the lease handshake, which `
      + `over USB has TWO causes and this end cannot tell them apart:\n`
      + `  1. Nothing is listening on the device's port ${port} at all. Most likely the native `
      + `debug gate is off for this build — the JS bridge and the native plugin read build.debugBuild `
      + `through SEPARATE channels, and a project scaffolded without a heal has the first, not the `
      + `second (#112/#164). Check: \`adb shell cat /proc/net/tcp | grep -i ${port.toString(16)}\` `
      + `(hex, uppercase or lower) — no row means nothing is bound. Then reopen the project in the `
      + `editor (heal-on-open) and rebuild.\n`
      + `  2. Another Modoki genuinely owns the lease — it refuses an extra client by dropping the `
      + `socket, which looks identical from here. Disconnect it there, or relaunch the app.\n`
      + `  3. The app IS running, but listening on a DIFFERENT port — check this one FIRST on `
      + `a phone with several Modoki apps installed, because causes 1 and 2 both send you `
      + `somewhere expensive and wrong while the bridge is perfectly healthy. ${port} is shared by `
      + `every Modoki game, so launching this app while another was still releasing the port makes `
      + `it fall back to an OS-assigned one and never reclaim ${port} afterwards (#88/#283). `
      + `\`adb logcat -d | grep "Native TCP server listening on port"\` names the real port `
      + `— the "Native" is load-bearing, since a \`foregrounded — TCP server listening on port `
      + `${port}\` line is the HOLDER announcing itself, not this app. Pass it as `
      + `\`device_connect {useAdb:true, port:<actual>}\` — or force-stop the other apps and `
      + `relaunch. Builds carrying the #283 retry only fall back when the other app holds the `
      + `port for over 2s.`;
  }
  if (!detail || !/ECONNREFUSED/i.test(detail) || port !== DEVICE_PORT) return detail;
  return `${detail} — nothing is listening on the default port ${DEVICE_PORT}. The app may be `
    + 'running FINE on another port: 9095 is shared by every Modoki game, so if a second one still '
    + 'holds it, the app you just launched falls back to an OS-assigned port (#88/#283). Close the '
    + 'other Modoki app and relaunch — but find it by its SOCKET, not its name: '
    + '`adb shell \'cat /proc/net/tcp /proc/net/tcp6\' | awk \'$4=="0A"\'` lists every listener with '
    + 'its uid, and a grep for "modoki" misses games whose package is not named that '
    + '(com.apiary.court is one). Or read the real port off the device — '
    + '`adb logcat -d | grep "TCP server listening"`, or the in-game debug menu — and pass it '
    + 'directly: device_connect {ip:"…", port:<actual>}.';
}

// `adbBinary()` moved to `androidDevices.ts` (#149) — one module now owns "how to talk to adb",
// because the serial resolution needs to run adb itself and importing it from here would have made
// the two modules import each other. Re-exported so the several call sites that resolve adb the
// SAME way (never a bare `adb` on PATH) keep one import path.
export { adbBinary } from './androidDevices';
import { discoverBridgePort } from './androidBridgePort';

/** The `adb forward` calls behind an overridable seam, so tests can inject a spy without mocking the
 *  `child_process` module (which fights vitest's per-file module cache in the full suite).
 *
 *  `serial` targets a specific device with `-s` (#149). It is REQUIRED to be passed by the caller
 *  rather than resolved here, and the caller is the lease: with two phones on USB, a forward that
 *  picks its own device could tunnel to a different handset than the one the lease then talks to,
 *  and both calls would report success. Undefined means "no serial known" and reproduces the old
 *  un-targeted behaviour, which is correct only when adb has exactly one device. */
export const adbRunner = {
  /** `hostPort` is this clone's derived local port; `devicePort` is the app's own (9095 unless it
   *  fell back). They are separate because only the host side is per-clone — see
   *  {@link resolveDeviceHostPort}. */
  forward(hostPort: number, serial?: string, devicePort: number = DEVICE_PORT): void {
    execFileSync(adbBinary(), adbArgs(serial, ['forward', `tcp:${hostPort}`, `tcp:${devicePort}`]), { timeout: 4000, stdio: 'pipe' });
  },
  /** A logcat dump, for mining the port the debug bridge actually bound (see the sniff at the
   *  failed-connect site). Behind this seam like every other adb call, so the unit tests never
   *  reach the real binary — and it returns '' rather than throwing, because this only ever
   *  IMPROVES an error message and must not become a second failure on top of the first. */
  async logcatDump(serial?: string): Promise<string> {
    // ⚠️ ASYNC, unlike its `execFileSync` siblings above, and that is deliberate rather than
    // inconsistent. This backend runs INSIDE the Electron main process, so a sync spawn blocks the
    // whole editor's input for as long as the command takes — the exact regression #168 fixed by
    // moving the device LISTINGS off `execFileSync` (measured 1.3-1.4 s per call, freezing drags
    // mid-gesture). A `logcat -d` dump is bounded at 6 s here, and 6 s of frozen editor on a
    // failed connect would be a worse bug than the confusing error message this exists to improve.
    // The siblings stay sync because their callers are sync; this one's caller already awaits.
    try {
      const { stdout } = await execFileAsyncDevice(adbBinary(), adbArgs(serial, ['logcat', '-d', '-t', '4000']), { timeout: 6000, encoding: 'utf8', maxBuffer: 32 << 20 });
      return stdout;
    } catch { return ''; }
  },
  /** Every forward rule adb currently holds, across ALL devices — `--list` is daemon-wide and takes
   *  no `-s`, which is precisely why {@link forwardOwner} can answer "whose rule is this?". */
  listForwards(): string {
    return execFileSync(adbBinary(), ['forward', '--list'], { timeout: 4000, encoding: 'utf8' });
  },
  /** Remove the rule on `hostPort` — but ONLY if it belongs to `serial`.
   *
   *  ⚠️ `adb forward --remove` matches on the HOST PORT SPEC, not on `-s` (#158). Measured: with two
   *  phones leased by two clones, `adb -s RFDEADBEEF1 forward --remove tcp:9095` deleted the rule
   *  owned by `RFDEADBEEF2`, leaving that clone's live lease with no tunnel and no error — the same
   *  cross-clone reach the `pkill -f` scoping rule exists to prevent, in a different mechanism.
   *  Per-clone host ports make the collision unreachable; this check means a mismatched removal
   *  refuses rather than reaches across even if something else ever re-introduces one. */
  removeForward(hostPort: number, serial?: string): void {
    if (serial) {
      // FAIL CLOSED when the ownership question cannot be answered. This `catch` used to set
      // `owner = undefined` and fall through to the removal, which reproduced #158 exactly under a
      // narrower trigger: `adb forward --list` timing out on a cold-daemon start (4s budget) or
      // erroring transiently leaves `owner` undefined, the guard short-circuits, and the
      // un-targeted `--remove` deletes whatever rule holds that port — including a sibling clone's.
      // The costs are asymmetric, which is what decides it: skipping leaks a rule that is benign
      // and self-healing (`connect()` re-forwards idempotently, and per #160 nothing reaps these
      // anyway), while proceeding can strip a live lease from another clone.
      let owner: string | undefined;
      try { owner = forwardOwner(adbRunner.listForwards(), hostPort); }
      catch (e) {
        console.warn(`[device] skipping \`adb forward --remove tcp:${hostPort}\`: could not verify the rule's owner (${e instanceof Error ? e.message : String(e)}) — refusing to delete a rule that may belong to another clone (#158)`);
        return;
      }
      if (owner && owner !== serial) {
        console.warn(`[device] skipping \`adb forward --remove tcp:${hostPort}\`: that rule belongs to ${owner}, not ${serial} (#158)`);
        return;
      }
    }
    execFileSync(adbBinary(), adbArgs(serial, ['forward', '--remove', `tcp:${hostPort}`]), { timeout: 4000, stdio: 'pipe' });
  },
};
const REQUEST_TIMEOUT_MS = 5000;
/** Hard ceiling on a PER-REQUEST deadline (#153). The per-request override exists so a slow op can
 *  outlive the connection default, not so a caller can wedge the socket: a device that never
 *  answers must still fail in bounded time, or a hung request holds the link open past the point
 *  where reconnect logic would have noticed the phone was gone. Generous enough that every real op
 *  budget (the 25s editor eval ceiling and anything the device is likely to grow) fits under it. */
const MAX_REQUEST_TIMEOUT_MS = 60_000;
/** Fail a hung TCP connect fast instead of waiting ~75s for the OS to time out — a silent packet
 *  drop (wrong IP / not same WiFi / server not listening / firewall) otherwise looks "stuck". */
const CONNECT_TIMEOUT_MS = 6000;

// ── Real TCP transport (WiFi to a typed IP, or adb-forwarded 127.0.0.1) ───────

/** Newline-delimited-JSON control link to the device. Reuses the device's existing
 *  `{id, method, params}` → `{id, result|error}` envelope; lease methods carry `{guid}`. */
export class TcpLeaseTransport implements LeaseTransport {
  private socket: net.Socket | null = null;
  private buf = '';
  private nextId = 0;
  private pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private dropCb: () => void = () => {};
  private opened = false;
  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(host: string, port: number, opts?: { connectTimeoutMs?: number; requestTimeoutMs?: number }) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  onDrop(cb: () => void): void { this.dropCb = cb; }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.buf = ''; // fresh socket → discard any partial frame left from a prior drop (L9)
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.opened = true;
        resolve();
      });
      // Bound the connect: a silent drop (unreachable / not listening) otherwise hangs ~75s.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`connect to ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms — check the device is on the same WiFi, running a debug build, and not firewalled`));
      }, this.connectTimeoutMs);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => { this.buf += chunk; this.processBuffer(); });
      socket.on('close', () => this.handleClose());
      socket.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); } // pre-connect failure
        socket.destroy();
      });
    });
  }

  private processBuffer(): void {
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      let msg: { id?: string; result?: LeaseReply; error?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.id) continue; // ignore console pushes / unsolicited frames
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result ?? null);
    }
  }

  /** Resolve the deadline for one request: the caller's, clamped, or the connection default.
   *
   *  WHY PER-REQUEST (#153). `requestTimeoutMs` was fixed per CONNECTION and nothing in production
   *  ever passed it, so every device op — a heavy `get_scene_state`, a big-screen `screenshot`, an
   *  eval — shared one 5000ms budget. Worse, that clock starts HOST-side, before the request even
   *  reaches the phone, so a device-side op budget equal to it could never be the deadline that
   *  fires: you got `device request timed out after 5000ms` instead of the op's own, far more
   *  useful message ("the code did not finish"). That is why `DEVICE_EVAL_MAX_TIMEOUT_MS` sat at
   *  4500 with a comment telling you not to raise it. Raising the CONNECTION default instead would
   *  have slowed dead-device detection for every op, which is the wrong trade — this is the right
   *  shape: the op that needs longer asks for longer, and nothing else changes. */
  private deadlineFor(timeoutMs?: number): number {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return this.requestTimeoutMs;
    return Math.max(this.requestTimeoutMs, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(timeoutMs)));
  }

  /** Low-level RPC over the socket — one `{id, method, params}` → `{id, result|error}` round-trip. */
  private rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) { reject(new Error('not connected')); return; }
      const id = String(++this.nextId);
      const deadline = this.deadlineFor(timeoutMs);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`device request timed out after ${deadline}ms`));
      }, deadline);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Control-plane lease message (connect/ping/disconnect). `timeoutMs` overrides the connection
   *  default for this one request; it can only EXTEND it (see `deadlineFor`) — shortening has no
   *  caller and would quietly fail ops that were fine. */
  request(msg: LeaseRequest, timeoutMs?: number): Promise<LeaseReply> {
    return this.rpc(msg.type, { guid: msg.guid }, timeoutMs) as Promise<LeaseReply>;
  }

  /** Data-plane request proxied on behalf of Claude (eval/screenshot/tap/…) — reuses the same
   *  owned socket, so the device's existing JS bridge handles it and replies on this socket.
   *  `timeoutMs` is the per-request deadline (#153): the op that legitimately takes longer than
   *  5s asks for longer, instead of every op sharing one budget sized for the fastest. */
  send(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.rpc(method, params, timeoutMs);
  }

  close(): void {
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }

  private handleClose(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('device link closed')); }
    this.pending.clear();
    this.buf = ''; // drop any partial frame so it can't corrupt the first reply after reconnect (L9)
    const wasOpen = this.opened && !!this.socket;
    this.socket = null;
    if (wasOpen) this.dropCb(); // unexpected drop → client auto-reconnects
  }
}

// ── GUID persistence (per clone) ──────────────────────────────────────────────

/** Where this backend keeps its small persistent state (device GUID, last connect target).
 *
 *  A dev clone gets `<cwd>/.modoki`, so each checkout keeps its own stable token — that is the
 *  "per clone" property the GUID doc below describes.
 *
 *  ⚠️ A PACKAGED editor must not use cwd: it is `REPO_ROOT`, which is
 *  `<Resources>/app.asar.unpacked` — INSIDE the signed .app. Writing there breaks the bundle's
 *  code signature, and `codesign --verify` / `spctl --assess` both start failing with "a sealed
 *  resource is missing or invalid" (measured 2026-08-22: `.modoki/device-guid` was one of the two
 *  files `codesign` named after a single build). There is also no "clone" to be per, so the
 *  machine-wide `~/.modoki` is both safe and correct — it is already where `device-claims.json`
 *  and `editor-launches.log` live. */
export function modokiStateDir(): string {
  return process.env.MODOKI_PACKAGED === '1'
    ? path.join(os.homedir(), '.modoki')
    : path.join(process.cwd(), '.modoki');
}

/** Load the clone's persistent device GUID, minting + saving one on first use. Keyed on the
 *  backend process's cwd (the clone root) so each checkout keeps its own stable token — except
 *  when packaged, see `modokiStateDir`. `dir` is injectable for tests. */
export function loadOrCreateGuid(dir: string = modokiStateDir()): string {
  const file = path.join(dir, 'device-guid');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* not created yet */ }
  const guid = crypto.randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, guid);
  } catch { /* non-fatal: fall back to an in-memory guid for this process */ }
  return guid;
}

/** The last connect target the user chose, remembered across editor restarts (per clone). The IP
 *  persists even across an adb connect, so switching back to WiFi re-fills it.
 *
 *  `serial` is remembered for the same reason the IP is (#149): on a machine with several phones,
 *  re-picking the right one every session is the friction the device picker exists to remove. It is
 *  a PREFERENCE, not a pin — a remembered serial that is no longer attached must not hard-fail the
 *  reconnect, because the common cause is simply that the phone was unplugged. See `connect()`. */
export interface LastTarget { ip: string; useAdb: boolean; serial?: string }

function lastTargetFile(dir: string): string {
  return path.join(dir, 'device-target.json');
}

export function loadLastTarget(dir: string = modokiStateDir()): LastTarget | null {
  try {
    const t = JSON.parse(fs.readFileSync(lastTargetFile(dir), 'utf8'));
    if (typeof t?.ip === 'string' || typeof t?.useAdb === 'boolean') {
      // `serial` round-trips too, or the picker's remembered phone is written and never read back
      // (#149): `saveLastTarget` persists it, so dropping it here made the memory die with the
      // process. Blank normalises to absent so the field is either a real serial or missing —
      // a cosmetic tidy, not load-bearing (every consumer already tests it for truthiness).
      const serial = typeof t?.serial === 'string' && t.serial ? t.serial : undefined;
      return { ip: String(t.ip ?? ''), useAdb: Boolean(t.useAdb), ...(serial ? { serial } : {}) };
    }
  } catch { /* not created yet */ }
  return null;
}

export function saveLastTarget(t: LastTarget, dir: string = modokiStateDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lastTargetFile(dir), JSON.stringify(t));
  } catch { /* non-fatal */ }
}

/** Parse a bridge reply that MAY be a JSON string, returning null rather than throwing. The device
 *  bridge answers some ops with a raw string (including its `Error: …` failure convention), so a
 *  bare `JSON.parse` on the hot path would turn an old bridge into an exception. */
function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Connection manager (the singleton the routes drive) ───────────────────────

export interface DeviceConnectStatus {
  state: LeaseState;
  guid: string;
  /** `serial` is the adb device this lease resolved at connect time (#149). It is on the STATUS,
   *  not re-derived per call, so every later adb call — the CDP tunnel, `device_screenshot` —
   *  targets the phone the lease actually holds. Absent for a WiFi lease. */
  target: { host: string; port: number; useAdb: boolean; serial?: string } | null;
  /** Last chosen IP/adb, remembered across restarts, so the panel can pre-fill the field. */
  lastTarget: LastTarget | null;
  detail?: string;
}

/** What the leased device's own hardware reports about itself. `deviceModel` is the product type
 *  (`hw.machine` — `iPhone18,4`), `osVersion` the system version (`26.5.2`). Null = the bridge did
 *  not say, which is "unknown" and never a mismatch.
 *
 *  The CONSUMER is `LeaseHardware` in `wdaLauncher.ts`, declared separately on purpose (that module
 *  is import-free so its selection rule stays testable in isolation) — its doc carries the full
 *  reasoning and how the two are kept in step. Semantics live THERE, with the rule that reads them;
 *  do not restate them here. */
export interface DeviceHardware { deviceModel: string | null; osVersion: string | null }

/** Everything one `app-identity` probe answers. */
interface DeviceIdentity extends DeviceHardware { platform: string | null; appId: string | null }

const UNKNOWN_IDENTITY: DeviceIdentity = { platform: null, appId: null, deviceModel: null, osVersion: null };

export interface ConnectRequest {
  /** Device LAN IP (WiFi). Ignored when `useAdb` is true. */
  ip?: string;
  /** Tunnel over USB via `adb forward` and connect to 127.0.0.1 (Android only). */
  useAdb?: boolean;
  port?: number;
  /** WHICH Android, when several are attached (#149). adb serial, as listed by `device_list` /
   *  `adb devices`. Only meaningful with `useAdb`; a serial that matches nothing attached is an
   *  error, never a fall-through to another phone. */
  serial?: string;
  /** The OPEN PROJECT's `build.debugBuild`, supplied by the router — never by the caller (#239).
   *  When it is `false` the app has no debug bridge compiled in at all, which turns the handshake
   *  failure below from two guesses into one certainty. */
  debugBuild?: boolean;
}

export class DeviceConnectionManager {
  private client: DeviceLeaseClient | null = null;
  private transport: TcpLeaseTransport | null = null;
  private state: LeaseState = 'disconnected';
  private detail?: string;
  private target: { host: string; port: number; useAdb: boolean; serial?: string } | null = null;
  private lastTarget: LastTarget | null;
  /** The machine-wide hardware claim this lease holds (#149), so `disconnect` can hand back exactly
   *  what `connect` took. Kept separately from `target` because it must survive the same failure
   *  paths that clear `target` — a claim that outlives the thing that released it blocks a phone. */
  private claimedDeviceId: string | null = null;
  /** The connected device's Capacitor platform, asked once per lease. See `devicePlatform()`. */
  private platform: string | null = null;
  /** The leased app's package/bundle id, latched by the same probe as `platform` — see
   *  `deviceAppId()`. Guards the CDP route against driving a different device (#142). */
  private appId: string | null = null;
  /** The leased device's hardware model + OS version, latched by the same probe — see
   *  `deviceHardware()`. Ties the WDA launch to the leased phone (#146). */
  private hardware: DeviceHardware = { deviceModel: null, osVersion: null };
  /** The bridge ANSWERED the identity probe — including answering "I have no platform" (an old
   *  bridge). Separate from `platform` so a stable null latches but a failed ASK does not. */
  private platformResolved = false;
  private platformInFlight: Promise<DeviceIdentity> | null = null;
  /** Bumped every time this manager's SESSION IDENTITY changes — by a `connect()` (inside its own
   *  `disconnect()`, see below) and by a bare `disconnect()`. Nothing serializes
   *  `POST /api/device/connect` — a double-clicked Connect button, or an agent retrying a slow
   *  `device_connect`, can put two calls in flight on this one manager — and
   *  `claimedDeviceId`/`client`/`transport`/`target` are all SHARED state, so a stale continuation
   *  resuming after an await can act on a session that is no longer its own. This counter covers a
   *  `disconnect()` (bare, or another `connect()`'s own internal teardown) landing while a
   *  `connect()` is suspended on an await — teardown-during-connect, both in the #283 rediscovery
   *  block and via the `onState` callbacks below (the #506 case). What it does NOT cover is the
   *  PRIMARY path's own client install (`this.transport`/`this.client`/`this.target` at
   *  `:700-713`) — those are still assigned un-gated, so which client two truly racing `connect()`s
   *  leave installed is decided by assignment order, not by this generation. That primary-path
   *  assignment race is pre-existing and out of scope here. It also does NOT serialize
   *  `POST /api/device/connect` itself — that gap predates this field. */
  private sessionGeneration = 0;
  private readonly guid: string;
  private readonly stateDir: string;

  /** `stateDir` is the per-clone `.modoki` dir the last-target file lives in — injectable so tests
   *  isolate their persisted state instead of scribbling on the real repo's `.modoki`. */
  constructor(guid = loadOrCreateGuid(), stateDir: string = modokiStateDir()) {
    this.guid = guid;
    this.stateDir = stateDir;
    this.lastTarget = loadLastTarget(stateDir);
  }

  /** Connect (or reconnect) to a device. Tears down any prior link first, so a re-Connect with a
   *  new IP is clean. `useAdb` runs `adb forward` and targets 127.0.0.1; otherwise the typed IP.
   *  With NEITHER `ip` nor `useAdb` (a "bare" reconnect), reuse the last target this clone used. */
  async connect(req: ConnectRequest): Promise<DeviceConnectStatus> {
    // Capture AFTER the teardown, not before: `disconnect()` bumps `sessionGeneration` itself (as
    // its first statement), so capturing here before calling it would read a generation that is
    // stale the instant `disconnect()` returns — on EVERY connect, not just a raced one. That
    // would silently disable the #164 guard below (`generation === this.sessionGeneration` would
    // never be true), leaving a failed connect's claim standing forever. Two racing connects still
    // separate correctly this way: each captures only after ITS OWN `disconnect()` has bumped the
    // counter, so the loser's capture is strictly behind the winner's.
    await this.disconnect();
    const generation = ++this.sessionGeneration;
    // A bare call (no ip, no explicit useAdb) reconnects the last target — all-or-nothing, so that
    // supplying just an ip still means WiFi (never adb) and supplying useAdb still means USB. Capture
    // the prior target BEFORE we overwrite this.lastTarget below.
    const reqIp = req.ip?.trim();
    const bareReconnect = !reqIp && req.useAdb === undefined && !!this.lastTarget;
    const useAdb = bareReconnect ? !!this.lastTarget!.useAdb : !!req.useAdb;
    const ip = reqIp || (bareReconnect ? this.lastTarget!.ip : undefined);
    // The serial the CALLER asked for, else the one this clone used last. Remembered rather than
    // re-picked, so a two-phone machine does not ask again every session — but only as a preference:
    // `resolveSerial` below downgrades a remembered-and-now-unplugged serial to "no preference"
    // instead of failing, because a phone being unplugged is not a typo (see its doc).
    const reqSerial = req.serial?.trim();
    const wantSerial = reqSerial || (req.serial === undefined ? this.lastTarget?.serial : undefined);
    // Remember what we chose (even if the connect then fails), so the panel pre-fills it next time.
    // Keep the last typed IP across an adb connect (so toggling back to WiFi re-fills).
    this.lastTarget = { ip: ip || this.lastTarget?.ip || '', useAdb, ...(wantSerial ? { serial: wantSerial } : {}) };
    saveLastTarget(this.lastTarget, this.stateDir);
    // `req.port` is the port ON THE PHONE (the #88/#95 escape hatch for an app that fell back off
    // 9095). Over adb the port we CONNECT to is this clone's derived host end of the tunnel; over
    // WiFi the two are the same port, because there is no tunnel.
    const devicePort = req.port ?? DEVICE_PORT;
    const debugBuild = req.debugBuild;
    let port = devicePort;
    let host: string;
    let serial: string | undefined;
    if (useAdb) {
      // WHICH phone, decided ONCE — before any adb call, so the forward and everything that later
      // reuses this lease's serial cannot disagree (#149). A refusal here names the candidates.
      const resolved = this.resolveSerial(wantSerial, !!reqSerial);
      if ('error' in resolved) {
        this.state = 'error';
        this.detail = resolved.error;
        return this.status();
      }
      serial = resolved.serial;
      // Claim the HARDWARE before touching it — the socket lease cannot arbitrate adb, which is one
      // machine-wide daemon a sibling clone shares (#149 part 2). Refuse naming the holder.
      const claim = claimDevice({
        deviceId: adbDeviceId(serial),
        guid: this.guid,
        label: resolved.label,
        purpose: 'holding a device lease over USB',
      });
      if (!claim.ok) {
        this.state = 'error';
        this.detail = claim.message;
        return this.status();
      }
      this.claimedDeviceId = adbDeviceId(serial);
      port = resolveDeviceHostPort();
      try {
        adbRunner.forward(port, serial, devicePort);
      } catch (e) {
        // Give the claim straight back: we never got as far as using the device, and a claim left
        // behind by a failed connect blocks hardware until the TTL — the exact stale-lock failure
        // this design set out to avoid.
        this.releaseClaim();
        this.state = 'error';
        this.detail = `adb forward failed: ${e instanceof Error ? e.message : String(e)}`;
        return this.status();
      }
      host = '127.0.0.1';
    } else {
      if (!ip) {
        this.state = 'error';
        this.detail = 'no IP provided (uncheck "Use adb" and enter the device IP, or check it for USB)';
        return this.status();
      }
      // A WiFi lease can only be claimed by ADDRESS — the phone reports its model over the bridge,
      // but not until the lease is already open, and a model is not unique anyway. Weaker than a
      // serial, and namespaced so nothing mistakes it for one; see `wifiDeviceId`.
      const claim = claimDevice({
        deviceId: wifiDeviceId(ip),
        guid: this.guid,
        purpose: 'holding a device lease over WiFi',
      });
      if (!claim.ok) {
        this.state = 'error';
        this.detail = claim.message;
        return this.status();
      }
      this.claimedDeviceId = wifiDeviceId(ip);
      host = ip;
    }

    this.transport = new TcpLeaseTransport(host, port);
    this.client = new DeviceLeaseClient({
      guid: this.guid,
      transport: this.transport,
      // The advice keys off the DEVICE port, not the host end of the tunnel: an ECONNREFUSED on a
      // derived 127.0.0.1:9097 still means "nothing is listening on 9095 over there".
      //
      // Guarded on the generation: this callback is live from construction, not from when
      // `connect()` resolves, so a `disconnect()` landing while `client.connect()` below is still
      // in flight must not have this stale callback write status onto the manager AFTER the
      // teardown already ran (#506).
      onState: (s, d) => { if (generation !== this.sessionGeneration) return; this.state = s; this.detail = explainConnectFailure(d, devicePort, useAdb, debugBuild); },
    });
    this.target = { host, port, useAdb, ...(serial ? { serial } : {}) };
    let landed = await this.client.connect();
    // #283 — the app may be up and listening on a port that is NOT the default. Ask the DEVICE
    // where its bridge actually is and try once more.
    //
    // Only after a failed landing (this costs three `adb shell` reads, and the happy path must not
    // pay for them), only over adb (the reads need a shell), and only when the caller did not name
    // a port — an explicit port is an instruction, and second-guessing it would take the escape
    // hatch away from the very case it exists for.
    //
    // `discoverBridgePort` resolves the FOREGROUND app's uid and returns the socket that uid owns,
    // so this cannot wander onto a backgrounded sibling — which is #88, and is a worse outcome than
    // the refusal it would be replacing.
    if (useAdb && req.port === undefined) {
      const found = discoverBridgePort(serial);
      // The test is PORT OWNERSHIP, not an identity self-report. An earlier cut asked the connected
      // app to name itself and only re-targeted on a mismatch — which was inert against exactly the
      // app most likely to be squatting: `court`'s older bridge answers no `app-identity` at all,
      // so the check saw "could not look" and stood down (the docs already say the squatter is
      // usually the build that cannot answer). uid ownership is ground truth and needs nobody's
      // cooperation: if the FOREGROUND app owns a listening socket that is not the one we reached,
      // we are on the wrong app whether or not anyone will admit it.
      if (found && found.port !== devicePort) {
        if (landed === 'connected') {
          console.warn(`[device] connected on ${devicePort}, but ${found.pkg} is in the foreground and `
            + `owns ${found.port} — re-targeting, since every device_* call would otherwise drive the `
            + `wrong app (#88/#283).`);
        }
        // #506 — an external `disconnect()` can land while any of the awaits below (this client's
        // own hangup, the retry's `client.connect()`) are in flight. It already bumped
        // `sessionGeneration`, tore down `this.client`/`this.transport`/`this.target` and released
        // the claim; resuming past this point must not undo any of that. So the WHOLE rediscovery
        // — including the retarget and the old client's hangup, not just the new client's install —
        // is gated on the generation still matching: stale, skip it entirely (no retarget, no
        // hangup, no forward, no new client) and leave `landed` exactly as it was. The retarget and
        // hangup below could not be shown to race in practice (whatever wakes this continuation is
        // `disconnect()` tearing down `this.client`, which is what this block is about to touch
        // anyway) — this is a defensive placement, not a reproduced bug.
        if (generation === this.sessionGeneration) {
          this.retargetIdentity();
          try {
            // Hang up on the wrong app BEFORE re-targeting. Two live lease clients over one host
            // port would both hold sockets through the same forward rule, and the one we are
            // abandoning is exactly the app we do not want driven.
            try { await this.client.disconnect(); } catch { /* already dead is fine */ }
            adbRunner.forward(port, serial, found.port);
            // Built into LOCALS and published only after the generation is re-checked below — see
            // there. Assigning straight onto `this.transport`/`this.client` here would leave a
            // window where a concurrent `disconnect()` sees a half-installed session, and (per the
            // trap this whole fix exists for) would lose the local handle needed to hang this
            // client up if it turns out superseded.
            const transport = new TcpLeaseTransport(host, port);
            const client = new DeviceLeaseClient({
              guid: this.guid,
              transport,
              // Same reasoning as the primary `onState` above: live from construction, so a
              // superseded client must not write status onto a manager that has already moved on.
              onState: (st, d) => { if (generation !== this.sessionGeneration) return; this.state = st; this.detail = explainConnectFailure(d, found.port, useAdb, debugBuild); },
            });
            const landedRetry = await client.connect();
            if (generation === this.sessionGeneration) {
              this.transport = transport;
              this.client = client;
              this.target = { host, port, useAdb, ...(serial ? { serial } : {}) };
              landed = landedRetry;
              if (landed === 'connected') {
                console.warn(`[device] the app is listening on ${found.port}, not the default ${devicePort} `
                  + `(${found.pkg} — it lost the bind race, #283). Connected there.`);
                // Verify the app that ANSWERED is the one we aimed at. The port already belongs to
                // the foreground app's uid, so this should always agree — but "should" is what #88
                // was too, and a lease pointed at a sibling game answers every later call plausibly
                // and wrongly.
                //
                // Only when the bridge NAMES itself: a pre-#88 build reports null, and refusing or
                // crying mismatch on "could not look" would break every older build for no signal.
                const answering = await this.deviceAppId();
                if (answering && answering !== found.pkg) {
                  console.warn(`[device] ⚠️ discovered port ${found.port} for ${found.pkg}, but the app `
                    + `answering is ${answering}. device_* calls will drive ${answering} — disconnect and `
                    + `relaunch the app you meant (#88/#283).`);
                }
              }
            } else {
              // Superseded while `client.connect()` was in flight. Unwind what we just built
              // rather than publish it: hang up the local client only. Do NOT also remove the
              // forward rule (`tcp:<port>`, the host-port-scoped constant this whole manager
              // shares) — `port`/`serial` are the SAME for every connect on this manager, so
              // whoever superseded us has, by construction, already re-forwarded that exact rule
              // to their own live session; removing it here would tear down a WINNER's tunnel out
              // from under it (every `device_*` call then fails against a session that still
              // reports 'connected'), which is strictly worse than the leak this unwind exists to
              // avoid. Reclaiming the forward belongs to whoever OWNS the session — `disconnect()`
              // already does that for its own — never to a superseded continuation.
              try { await client.disconnect(); } catch { /* already dead is fine */ }
            }
          } catch (e) {
            // Keep the ORIGINAL failure as the reported one: this retry is a bonus attempt, and
            // replacing "the app never answered" with "adb forward failed" would hide the real cause.
            console.warn(`[device] port rediscovery failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    // A connect that did NOT land must hand the hardware back (#164). The adb-forward failure above
    // already does this; the handshake failure did not, so the commonest failure of all — the app
    // is not listening — left a machine-wide claim standing. The visible symptom is the nastiest
    // kind: the RETRY is refused as busy, naming this very clone as the holder, so the caller's own
    // dead attempt looks like a sibling clone hogging the phone, and only an explicit
    // device_disconnect (which nobody thinks to run after a failed connect) clears it.
    //
    // Deliberately keyed on "not connected" rather than on a specific state: `connect()` is
    // one-shot and returns 'error' or 'busy' with no retry behind it, so any non-connected outcome
    // means this lease holds nothing and is entitled to nothing. (The reconnect loop only ever runs
    // from a lease that DID connect, and that one keeps its claim, correctly.)
    //
    // Guarded on the generation because `claimedDeviceId` is manager state, not this call's: with
    // two connects in flight, the LOSER resumes here holding a `landed` of its own but pointing at
    // the WINNER's claim (same deviceId string, so `releaseClaim` cannot tell them apart), and would
    // free the hardware out from under a live, connected session — a sibling clone could then claim
    // a phone this editor is actively driving, which is the exact collision #149 exists to stop.
    // Whether the event loop really orders it that way is delicate and I did not reproduce it; the
    // guard costs one integer compare and makes the question moot, which is the right trade for a
    // failure whose blast radius is "two clones drive one phone".
    if (landed !== 'connected' && generation === this.sessionGeneration) this.releaseClaim();
    // The app may be alive on a FALLBACK port. Ask the phone before leaving the caller with a
    // message that guesses — this is the one cause `explainConnectFailure` cannot infer from a
    // socket outcome, and the app prints it (bug `OikQcN8V5NMH0xUr9UnK`). Done HERE rather than in
    // `onState` because it needs an await, and only on a failed adb connect so the happy path pays
    // nothing. Best-effort: the sniffer swallows its own errors, so a wedged adb leaves the
    // original message rather than replacing one failure with two.
    // Guarded on the generation too (#506): without it, a superseded continuation whose external
    // `disconnect()` already settled `state:'disconnected', detail:undefined` would still run the
    // logcat dump and write a stale "nothing is listening" detail back onto a manager that has
    // already moved on. `this.state !== 'connected'` alone only shields a LIVE session's detail
    // from this write, not a torn-down one's.
    if (landed !== 'connected' && useAdb && this.state !== 'connected' && generation === this.sessionGeneration) {
      const sniffed = parseBoundBridgePort(await adbRunner.logcatDump(serial), devicePort);
      if (sniffed) this.detail = explainConnectFailure(this.detail, devicePort, useAdb, debugBuild, sniffed);
    }
    // Learn the platform NOW, while the lease is healthy, rather than on first use. The WDA
    // screenshot path is reached precisely when the app has been SUSPENDED (lease 'reconnecting',
    // native capture 502s) — asking then would fail and refuse the feature in its motivating case.
    // Best-effort by construction: `devicePlatform` swallows its own errors and returns null.
    await this.devicePlatform();
    this.stampClaimIdentity(landed);
    return this.status();
  }

  /** Which adb device this lease means, and a human label for the claim/message.
   *
   *  `strict` distinguishes the two ways a serial arrives, which must fail differently:
   *   - the caller ASKED for one (`device_connect {serial}`, the panel's picker) — a value matching
   *     nothing attached is an ERROR, since silently using another phone is the bug this prevents;
   *   - it came from `lastTarget` — a REMEMBERED preference. The overwhelmingly likely reason it no
   *     longer matches is that the phone was unplugged, so falling back to the normal rule (which
   *     still refuses if it is genuinely ambiguous) beats refusing a single-phone reconnect over a
   *     stale memory the user never typed. */
  private resolveSerial(want: string | undefined, strict: boolean): { serial: string; label?: string } | { error: string } {
    // Named, so a refusal says "Galaxy A23 5G" rather than "SC_56C" — the names are memoized, so
    // this is one extra shell per phone per process, not per connect.
    const devices = withFriendlyNames(listAndroidDevices());
    let picked = resolveAndroidSerial(devices, { explicit: want });
    if ('error' in picked && want && !strict && !devices.some((d) => d.serial === want)) {
      picked = resolveAndroidSerial(devices, { explicit: undefined });
    }
    if ('error' in picked) return picked;
    const hit = devices.find((d) => d.serial === picked.serial);
    return { serial: picked.serial, ...(hit ? { label: describeAndroidDevice(hit) } : {}) };
  }

  /** Remove ONLY this lease's own adb forward, without the async `disconnect()` around it — the
   *  exit path needs the machine-wide resource back but cannot await a lease round trip. Leaves
   *  `this.target` intact: on the exit path nothing reads it afterwards, and a half-cleared lease
   *  would be worse than a stale one if the process somehow continues. */
  releaseAdbForwardSync(): void {
    if (!this.target?.useAdb) return;
    try { adbRunner.removeForward(this.target.port, this.target.serial); }
    catch { /* forward may already be gone / adb absent — non-fatal */ }
  }

  /** Stamp what the phone says it IS onto this lease's claim (#285).
   *
   *  Only for a WiFi (`ip:`) claim, and the asymmetry is the whole point. An adb claim already names
   *  a hardware SERIAL, which is exactly the id a raw `adb -s …` uses — a reader can match those
   *  exactly. A WiFi claim can only name an ADDRESS, while every raw iOS CLI (`devicectl --device`,
   *  `ideviceinstaller -u`, `xcodebuild -destination id=…`, go-ios `--udid`) names a UDID, and the
   *  app is deliberately not allowed to report its UDID (see `deviceHardware`). So the two
   *  namespaces cannot be joined directly, and the product type is the only fact that appears on
   *  BOTH sides — the phone reports it here, and `xcrun`'s listing carries it for a given UDID.
   *  Recording it lets the CLI guard say "the UDID you are about to install to is an iPhone18,4, and
   *  another clone is holding an iPhone18,4 over WiFi" instead of shrugging.
   *
   *  Costs nothing on the connect path: `devicePlatform()` above has already run the one identity
   *  probe, and `deviceHardware()` reads its latched result. Re-claiming with the same pid is a
   *  refreshing no-op success by construction, so this can never turn a healthy lease into a refusal.
   *  Best-effort throughout — a phone that does not report a model (a bridge older than #146) simply
   *  leaves the field absent, which every reader is required to treat as "cannot tell". */
  private stampClaimIdentity(landed: string): void {
    if (landed !== 'connected') return;
    const deviceId = this.claimedDeviceId;
    if (!deviceId || !deviceId.startsWith('ip:')) return;
    // Read the LATCHED identity; never call `deviceHardware()` here. That accessor ASKS, and a
    // failed ask is deliberately not latched so it can be retried (see `deviceIdentity`) — so
    // asking here would add a SECOND probe on precisely the connects where the first one already
    // failed. Not hypothetical: it broke `deviceConnection.test.ts`'s "a FAILED ask is retried"
    // (expected 1 call, got 2), which is the test that pins that rule. Nothing is lost by reading
    // the latch: `devicePlatform()` immediately above has already run the one probe there is.
    if (!this.platformResolved) return;
    try {
      const { deviceModel, osVersion } = this.hardware;
      if (!deviceModel) return;
      claimDevice({
        deviceId,
        guid: this.guid,
        purpose: 'holding a device lease over WiFi',
        model: deviceModel,
        ...(osVersion ? { osVersion } : {}),
      });
    } catch { /* the claim is already held and usable; a missing model is never worth failing over */ }
  }

  /** Hand back the hardware claim, if this lease holds one. Idempotent — a second call after the
   *  claim is gone is a no-op, which matters because `disconnect()` is called on every connect. */
  private releaseClaim(): void {
    if (!this.claimedDeviceId) return;
    try { releaseDevice(this.claimedDeviceId); } catch { /* a claims file we cannot write must never block a disconnect */ }
    this.claimedDeviceId = null;
  }

  async disconnect(): Promise<DeviceConnectStatus> {
    // Bumped FIRST, before any await below, so anything already suspended on this manager's prior
    // session (a racing `connect()`'s rediscovery block, its `onState` callback) is superseded
    // immediately rather than after this call's own awaits land.
    this.sessionGeneration++;
    if (this.client) { try { await this.client.disconnect(); } catch { /* */ } }
    // Reclaim the adb-forward rule this connection created (L10) — an un-removed `tcp:<port>`
    // forward outlives the editor and can mask a device swap (127.0.0.1 keeps answering the old
    // tunnel). Best-effort; a re-connect re-adds the idempotent rule anyway. Targeted at the SAME
    // serial the forward was created with (#149): un-targeted, this errors out on a two-phone Mac
    // and leaves the rule behind — the mask it exists to prevent.
    if (this.target?.useAdb) {
      try { adbRunner.removeForward(this.target.port, this.target.serial); }
      catch { /* forward may already be gone / adb absent — non-fatal */ }
    }
    // The CDP session is reached through a SECOND, separate adb forward (its own per-clone port),
    // and the lease used to leave both it and its socket standing — so releasing the phone left a
    // cached session and a tunnel still aimed at it (#160). Unconditional, not gated on `useAdb`:
    // the cache is process-global and keyed by serial (#149), so a lease that swaps to another
    // phone — or to one reached by IP — must not inherit the previous device's route. Cheap when
    // there is nothing to drop, and `disconnect()` runs at the head of every connect.
    resetDeviceCdpSession();
    this.releaseClaim();
    this.client = null;
    this.transport = null;
    this.state = 'disconnected';
    this.detail = undefined;
    this.target = null;
    this.platform = null;
    this.appId = null;
    this.hardware = { deviceModel: null, osVersion: null };
    this.platformResolved = false;
    this.platformInFlight = null;
    return this.status();
  }

  /** Which PLATFORM the app holding this lease runs on (`'ios'` / `'android'` / `'web'`), or null
   *  when it cannot be determined.
   *
   *  Exists because the lease's own fields cannot answer it and a WRONG guess is expensive: the
   *  WebDriverAgent route is iOS-only, and without this gate an Android device reached by IP (no
   *  adb ⇒ no CDP route) fell through to it. What that cost, as measured, is in
   *  docs/trusted-device-input.md § "WebDriverAgent lifecycle" (#99) — not restated here, so the
   *  two cannot drift. `useAdb` cannot stand in for this: it proves Android when true, but proves
   *  nothing when false.
   *
   *  Asked ONCE per lease and cached — the answer cannot change without a reconnect, and this sits
   *  on the input hot path. Concurrent callers share one in-flight request rather than each firing
   *  their own.
   *
   *  A null answer is latched only when the bridge ANSWERED with one (an old bridge that has no
   *  `app-identity` — a stable fact for the life of the lease, so re-asking on every call would be
   *  a round trip that can never change its mind). A failure to ASK at all (lease dropped mid-probe)
   *  is transient and is retried. Either way the caller sees null and must treat it as "not
   *  confirmed iOS", never as "assume iOS". */
  async devicePlatform(): Promise<string | null> {
    return (await this.deviceIdentity()).platform;
  }

  /** The leased app's package/bundle id, from the SAME `app-identity` probe as `devicePlatform()`
   *  — so asking for it costs no extra round trip, and the two answers can never describe
   *  different moments.
   *
   *  Needed because the CDP route discovers its target through adb, which knows nothing about this
   *  lease: with an iPhone leased over WiFi and any Android plugged into the same Mac, input was
   *  dispatched into the ANDROID and reported success (#142). `discoverDeviceCdpTarget` can already
   *  match a `preferPackage` against CDP's `Android-Package`; this is the value to give it, so the
   *  route can prove the webview it found is the app the lease is actually holding. */
  async deviceAppId(): Promise<string | null> {
    return (await this.deviceIdentity()).appId;
  }

  /** The leased device's HARDWARE, from the same `app-identity` probe — `deviceModel` is the
   *  product type (`iPhone18,4`) and `osVersion` the system version (`26.5.2`). Either may be null.
   *
   *  Exists so a WebDriverAgent launch can be tied to the phone the lease is actually holding
   *  (#146): the device list comes from `xcrun`, which knows nothing about this lease, and with one
   *  non-leased iPhone connected it would confidently start a signed agent on THAT phone. These two
   *  strings are the only facts an iOS app is allowed to report that also appear in devicectl's
   *  listing (`hardwareProperties.productType` / `deviceProperties.osVersionNumber`) — a UDID is
   *  not, and `identifierForVendor` appears in no listing at all. See `resolveIosDevice`.
   *
   *  Null when the bridge is older than #146 and does not report them, which the caller must treat
   *  as "unverified", never as a mismatch. */
  async deviceHardware(): Promise<DeviceHardware> {
    const { deviceModel, osVersion } = await this.deviceIdentity();
    return { deviceModel, osVersion };
  }

  /** Should `connect` go looking for the bridge on another port? (#283)
   *
   *  TWO cases, and the second is the one that matters more in practice:
   *
   *   1. **The connect FAILED.** Nothing answered on the default port — the app may be up and
   *      listening elsewhere.
   *   2. **The connect SUCCEEDED, with the WRONG APP.** This is #88, and it is the commoner shape:
   *      a backgrounded sibling that still holds the default port answers the handshake perfectly,
   *      so there is no failure to notice. Measured on a Galaxy A23 — `court` held 9095 while
   *      `skin-test` sat on 39213, and a bare `device_connect` landed on Court and reported
   *      success. Every later `device_*` call would have driven the wrong game.
   *
   *  The mismatch test requires BOTH names to be known: a pre-#88 bridge reports a null appId, and
   *  a phone with nothing in focus reports no package. "Could not look" is never a mismatch — that
   *  would send every older build off rediscovering for no reason. */
  private retargetIdentity(): void {
    // The identity is LATCHED per lease, so it must be cleared before re-targeting or the new app
    // would be reported under the OLD app's name — a wrong answer dressed as a verified one.
    this.platformResolved = false;
    this.platformInFlight = null;
    this.platform = null;
    this.appId = null;
  }

  /** One probe, every fact. Latching rules are unchanged (see `devicePlatform`'s doc): a null is
   *  latched only when the bridge ANSWERED with one; a failure to ASK is transient and retried. */
  private async deviceIdentity(): Promise<DeviceIdentity> {
    if (this.platformResolved) return { platform: this.platform, appId: this.appId, ...this.hardware };
    if (this.state !== 'connected') return UNKNOWN_IDENTITY;
    if (this.platformInFlight) return this.platformInFlight;
    this.platformInFlight = (async () => {
      try {
        const raw = await this.proxy('app-identity', {});
        // The bridge signals a failed/unknown handler by RETURNING a string, not throwing, so a
        // non-object reply is "unknown", never a platform.
        const info = (typeof raw === 'string' ? safeJsonParse(raw) : raw) as
          { platform?: unknown; appId?: unknown; deviceModel?: unknown; osVersion?: unknown } | null;
        const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
        this.platform = str(info?.platform);
        this.appId = str(info?.appId);
        this.hardware = { deviceModel: str(info?.deviceModel), osVersion: str(info?.osVersion) };
        this.platformResolved = true;
        return { platform: this.platform, appId: this.appId, ...this.hardware };
      } catch {
        return UNKNOWN_IDENTITY;   // could not ask (lease dropped) — deliberately NOT latched
      } finally {
        this.platformInFlight = null;
      }
    })();
    return this.platformInFlight;
  }

  status(): DeviceConnectStatus {
    return { state: this.state, guid: this.guid, target: this.target, lastTarget: this.lastTarget, ...(this.detail ? { detail: this.detail } : {}) };
  }

  /** Proxy a data-plane request (eval/screenshot/tap/console-logs/…) through the held socket —
   *  the controlled-comms path: Claude's device_* tools go through Modoki, not their own socket.
   *
   *  `timeoutMs` sizes THIS request's transport deadline (#153). The caller supplies it from the
   *  op's OWN budget plus headroom — the same nested-deadline discipline `/api/eval` follows — so
   *  the deadline that fires is the innermost one, and the error names what the code was doing
   *  rather than reporting a dead link. Omit it and the connection default (5s) applies. */
  async proxy(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.state !== 'connected' || !this.transport) {
      // Keep the "no device connected" prefix: the device MCP's caughtFailure() matches on it to
      // build the NOT_AVAILABLE_HERE envelope that names device_connect/device_status. The advice
      // here is the fallback an agent sees when it reads the raw message (curl, logs), so it names
      // the tool path too — "the AI panel" alone was stale advice once device_connect shipped.
      throw new Error(
        `no device connected (state: ${this.state}) — open the lease with device_connect `
        + `{ip:"<device IP from the game's debug menu>"} or {useAdb:true}, or the editor AI panel → `
        + `"Connect a Device"; device_status reports the current state`,
      );
    }
    return this.transport.send(method, params, timeoutMs);
  }
}

/** Process-global device connection (one per backend → one per clone). */
export const deviceConnection = new DeviceConnectionManager();

// NOTE: `reclaimStaleDeviceStateAtStartup()` is deliberately NOT called at module scope. It shells out
// to `adb forward --list`, and module load happens before any test's `beforeEach` can stub the
// seam — so every suite that merely imports this file would run a real adb command whose result
// depends on what is plugged into the machine. That is precisely the half-injectable-seam trap
// `deviceConnectAdb.test.ts` documents. The two real backend hosts call it explicitly instead.

/** Give back every MACHINE-WIDE resource this process holds on a device: both adb forwards (the
 *  lease's own, and the CDP tunnel's) and this pid's device claims.
 *
 *  Exists because `disconnect()` is not enough, which the #160 fix missed. Its only production
 *  caller is the explicit `/api/device/disconnect` route — so the resources were released when a
 *  human clicked Disconnect, and leaked on the far more common ending: quitting the editor with a
 *  device still connected. That is exactly the state #160 was reported from ("no editor was running
 *  for any of the three"), and it survived the fix that closed it. Re-measured after the fix:
 *  connect, one trusted tap, quit — `tcp:9097` and `tcp:9335` both still standing, claim still held.
 *
 *  SYNCHRONOUS on purpose, and that is the whole design constraint. `process.on('exit')` cannot
 *  await, and Electron's `before-quit` does not reliably run for a signal (see devServer.ts, which
 *  reaps its Vite child the same way and for the same reason). Every step here is sync underneath —
 *  `execFileSync` for adb, a lock+`writeFileSync` for the claims file — so all of it survives that
 *  constraint. What is deliberately SKIPPED is the polite lease-protocol `disconnect()` round trip:
 *  it is async and the device times the lease out on its own, whereas an adb rule has no expiry at
 *  all and outlives the machine's session.
 *
 *  Best-effort and never throws: this runs on the exit path, where a throw would abort the steps
 *  after it and could take the exit code with it.
 *
 *  ⚠️ **It was named `OnExit` and wired to no exit at all until #225** — the only callers were
 *  tests, so the leak it was written to close was still open, invisibly, and the comment below
 *  ("the exit hooks pass nothing") described hooks that did not exist. Its production caller is now
 *  Electron's awaited `before-quit` teardown in `electron/main.ts`, which covers a normal quit
 *  (⌘Q, Quit, an app-driven `app.quit()`). It does NOT cover a SIGTERM — `stop-editor.sh` sends
 *  one and Chromium takes the signal, measured — nor a crash or `kill -9`. Those endings are closed
 *  at the other end instead, by `reclaimStaleDeviceStateAtStartup()`, which no manner of dying can
 *  skip. Do not add a SIGTERM listener here to "finish the job": it would suppress Node's default
 *  terminate-on-signal and change how the editor shuts down, which is the trade `deviceClaims.ts`
 *  already declined. */
export function releaseDeviceResourcesOnExit(conn: DeviceConnectionManager = deviceConnection): void {
  // `conn` is a seam for tests only — production has exactly one manager (the singleton below), and
  // the before-quit caller passes nothing. Without it a test can only assert against process-global state.
  // Order matters only in that each step must not be able to prevent the next.
  try { conn.releaseAdbForwardSync(); } catch { /* adb gone / rule already removed */ }
  try { resetDeviceCdpSession(); } catch { /* already torn down */ }
  try { releaseAllForThisProcess(); } catch { /* an unwritable claims file must never block exit */ }
}

/** Reclaim any adb forward left on THIS clone's ports by a previous run — called once when the
 *  backend starts.
 *
 *  This, not an exit hook, is what actually fixes the dangling rules #160 was reported from, and
 *  the reason is measured rather than assumed. A process-exit teardown looked like the obvious
 *  answer and does not work here: `process.on('exit')` / `SIGINT` / `SIGTERM` handlers installed in
 *  the backend DO get registered under Electron and then never fire — Chromium's browser process
 *  takes the signal and terminates. Probed directly on this Mac: connect a device, one trusted tap,
 *  `stop-editor.sh` (a SIGTERM), and the log shows `[hooks installed]` with no handler line after
 *  it, `Electron exited with signal SIGTERM`, and both rules still standing. And even if it did
 *  fire, `kill -9`, an OOM and a crash all skip it — the three ways an editor most often dies badly.
 *
 *  So the lifetime is closed at STARTUP instead, which no manner of dying can skip. It is the same
 *  shape the claims file already uses (a claim is expired by pid-liveness ON READ rather than by a
 *  polite release), applied to the resource that had no expiry at all: an adb rule outlives the
 *  machine's session entirely, with nothing to sweep it.
 *
 *  Safe because both ports are DERIVED PER CLONE — the lease host port (`resolveDeviceHostPort`)
 *  and the CDP port (`resolveDeviceCdpPort`) are `base + (backend − 5179)`. At startup this process
 *  holds no lease, so a rule sitting on one of our own ports can only be our own leftover. It is
 *  emphatically not a sweep of "stale-looking" rules in general: reaching across to a port we do
 *  not own is #158, and this never does. */
export function reclaimStaleDeviceStateAtStartup(): void {
  // Claims first — it is pure fs and cannot be blocked by a missing adb. A dead-pid claim never
  // BLOCKED anyone (every reader applies `isStale`), but it sits in `~/.modoki/device-claims.json`,
  // which CLAUDE.md tells an agent to read as the answer to "did I give the phone back" — so a
  // corpse there reads as a live hold and cost the #225 reporter two hand-edits. Startup is the
  // one point neither a crash nor `stop-editor.sh`'s SIGTERM can skip; see `sweepStaleClaims`.
  try {
    for (const c of sweepStaleClaims()) {
      console.log(`[device] swept a stale claim on ${c.deviceId} left by ${c.clone} (pid ${c.pid}, gone)`);
    }
  } catch { /* an unwritable claims file must never block startup */ }
  for (const port of [resolveDeviceHostPort(), resolveDeviceCdpPort()]) {
    try {
      const owner = forwardOwner(adbRunner.listForwards(), port);
      if (!owner) continue;                       // nothing there — the normal case
      adbRunner.removeForward(port, owner);
      console.log(`[device] reclaimed a stale adb forward on tcp:${port} (${owner}) left by a previous run`);
    } catch { /* no adb, no device, unreadable list — never block startup over a cleanup */ }
  }
}
