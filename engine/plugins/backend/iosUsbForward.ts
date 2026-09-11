/**
 * iOS over USB (#1065) — the device lease tunnelled through usbmuxd with go-ios `ios forward`, the
 * iOS twin of `useAdb`'s `adb forward`.
 *
 * ## Why go-ios, and the three things it does that `adb forward` does not
 *
 * go-ios is already provisioned on every Mac (`engine/toolchain/goIosProvision.ts`); `iproxy` is not
 * (it comes from Homebrew's libusbmuxd). The owner picked go-ios (#1065). What it does differently,
 * each checked on 2026-09-11:
 *
 *  1. **A phone can be listed TWICE.** With WiFi sync on, usbmuxd lists the same UDID once as `USB`
 *     and once as `Network` (`ios list --details`; the iPhone 8 here). go-ios's device lookup takes the
 *     FIRST entry matching the serial — observed: `ios forward --udid=<iPhone 8> --trace` bound
 *     usbmuxd DeviceID 1657, which usbmuxd's own `ListDevices` lists as `USB`, ahead of 1656 `Network`.
 *     That order is usbmuxd's, not a promise, so {@link pickUsbIosDevice} refuses when a device's
 *     first entry is `Network`: the tunnel would run over WiFi while the lease says USB.
 *  2. **It is a long-lived PROCESS, not a rule.** `adb forward` installs a rule and returns; `ios
 *     forward` runs until killed, and does not exit when the phone goes away. So the lease owns the
 *     child: `DeviceConnectionManager.disconnect()` stops it (that runs at the head of every connect,
 *     so a superseding connect stops it too), the exit path stops it synchronously, and startup reaps
 *     one a crashed editor left behind ({@link reapRecordedIosForward}) — #160's lesson, where a forward
 *     with no teardown caller outlived every session.
 *  3. **It listens on every interface** (`0.0.0.0:<hostPort>`; no bind option). Accepted: a debug
 *     build's bridge already listens on the phone's own WiFi interface, so the relay exposes nothing
 *     the local network could not already reach.
 *
 * ## Resolve through the transport that will be used
 *
 * The device is picked from go-ios's own list, never from devicectl: usbmuxd can lose a wired device
 * that CoreDevice still reports as `available (paired)` (seen on the hub, #1065), and a pick that
 * trusts devicectl would forward to a phone go-ios cannot reach. Same rule as `goIosDevice.ts`.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveGoIos } from './deviceSyslog';

const execFileAsync = promisify(execFile);

/** `ios list` is a usbmuxd round trip (~100ms); the ceiling is for a wedged daemon. */
const LIST_TIMEOUT_MS = 10_000;

/** How long `ios forward` gets to say it is listening. It prints within a few ms of starting. */
export const FORWARD_READY_TIMEOUT_MS = 5_000;

/** How often to look for the child's LISTEN socket once go-ios says it is starting. */
const BIND_POLL_MS = 50;

/** `lsof` answers in ~100ms (measured); the ceiling is for one stuck on an unresponsive network mount. */
const LSOF_TIMEOUT_MS = 3_000;

/** How long a disconnect waits for a stopped forward to exit — go-ios exits on SIGTERM within milliseconds. */
export const FORWARD_EXIT_WAIT_MS = 2_000;

/** One usbmuxd entry, in usbmuxd's own order. */
export interface UsbmuxEntry {
  udid: string;
  /** `USB` or `Network`. */
  connectionType: string;
  productType?: string;
  productVersion?: string;
}

/** The entries in `ios list --details` output, in order — or null when no device-list line was found
 *  (go-ios prints its own status lines on the same stream). */
export function parseGoIosListDetails(stdout: string): UsbmuxEntry[] | null {
  for (const line of stdout.split('\n')) {
    let o: { deviceList?: unknown };
    try { o = JSON.parse(line) as { deviceList?: unknown }; } catch { continue; }
    if (!Array.isArray(o?.deviceList)) continue;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    return o.deviceList.flatMap((d): UsbmuxEntry[] => {
      const e = (d ?? {}) as Record<string, unknown>;
      const udid = str(e.Udid);
      if (!udid) return [];
      return [{
        udid,
        connectionType: str(e.ConnectionType) ?? '',
        ...(str(e.ProductType) ? { productType: str(e.ProductType) } : {}),
        ...(str(e.ProductVersion) ? { productVersion: str(e.ProductVersion) } : {}),
      }];
    });
  }
  return null;
}

function describeEntry(e: UsbmuxEntry): string {
  return `${e.productType ?? 'iOS device'}${e.productVersion ? ` (iOS ${e.productVersion})` : ''} ${e.udid}`;
}

/**
 * WHICH iOS device a USB lease tunnels to, as a pure decision over usbmuxd's entries.
 *
 * `want` is a UDID; `strict` says whether the CALLER named it (a value matching nothing is an error)
 * or it was REMEMBERED from the last connect (a phone no longer attached falls back to the normal
 * rule, since the likely cause is that it was unplugged) — the same split as the adb serial (#149).
 * A remembered device that IS attached but unusable is still refused: that is not a stale memory.
 */
export function pickUsbIosDevice(o: { entries: UsbmuxEntry[]; want?: string; strict: boolean }): { udid: string; label: string } | { error: string } {
  const byUdid = new Map<string, UsbmuxEntry[]>();
  for (const e of o.entries) byUdid.set(e.udid, [...(byUdid.get(e.udid) ?? []), e]);

  const networkFirst = (list: UsbmuxEntry[]): string =>
    `${describeEntry(list[0])} is listed by usbmuxd over the NETWORK before USB, and go-ios forwards `
    + 'through the first entry — so this "USB" lease would really run over WiFi. Turn off "Show this '
    + 'iPhone when on Wi-Fi" for it in Finder (that removes the Network entry), or connect over WiFi '
    + 'with device_connect {ip} instead.';
  const verdict = (list: UsbmuxEntry[]): { udid: string; label: string } | { error: string } => {
    if (list[0].connectionType === 'USB') return { udid: list[0].udid, label: describeEntry(list[0]) };
    if (list.some((e) => e.connectionType === 'USB')) return { error: networkFirst(list) };
    return {
      error: `${describeEntry(list[0])} is reachable only over the NETWORK (WiFi sync), not USB — plug in `
        + 'the cable, or replug it (usbmuxd can lose a wired device that Xcode still lists), or connect '
        + 'over WiFi with device_connect {ip}.',
    };
  };

  if (o.want) {
    const list = byUdid.get(o.want);
    if (list) return verdict(list);
    if (o.strict) {
      const seen = [...byUdid.keys()];
      return {
        error: `usbmuxd does not see ${o.want} (go-ios sees: ${seen.length ? seen.join(', ') : 'nothing'}). `
          + 'If Xcode or devicectl still lists it as wired, unplug and replug it — usbmuxd can lose a '
          + 'wired device that CoreDevice still sees.',
      };
    }
  }

  const lists = [...byUdid.values()];
  const usable = lists.filter((l) => l[0].connectionType === 'USB');
  if (usable.length === 1) return verdict(usable[0]);
  if (usable.length > 1) {
    return {
      error: `${usable.length} iOS devices are attached over USB — pass udid to say which: `
        + usable.map((l) => describeEntry(l[0])).join(', '),
    };
  }
  const blocked = lists.filter((l) => l.some((e) => e.connectionType === 'USB'));
  if (blocked.length) return { error: networkFirst(blocked[0]) };
  return {
    error: 'usbmuxd sees no iOS device over USB (go-ios `ios list` shows none) — check the cable, unlock '
      + 'the device and trust this Mac. If Xcode still lists it as wired, unplug and replug it.',
  };
}

/** The go-ios calls behind an overridable seam, like `adbRunner` — tests replace these rather than
 *  mocking `child_process`. */
export const goIosForwardRunner = {
  /** The go-ios binary, or null when it is not installed — the same resolution every go-ios op uses. */
  resolveBinary(): string | null {
    return resolveGoIos();
  },
  async listDetails(goIos: string): Promise<string> {
    return (await execFileAsync(goIos, ['list', '--details'], { timeout: LIST_TIMEOUT_MS })).stdout;
  },
  spawnForward(goIos: string, hostPort: number, devicePort: number, udid: string): ChildProcess {
    return spawn(goIos, ['forward', String(hostPort), String(devicePort), `--udid=${udid}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  },
  /** EVERY process holding a LISTEN socket on `port` on this Mac, from the socket table (`lsof`) — or why
   *  the table could not be read, which a caller must treat as a refusal, never as "nobody listens".
   *
   *  Readiness can be neither a log line nor "the child bound it". go-ios logs "start listening" BEFORE
   *  `net.Listen` (`ios/forward/forward.go`, v1.3.2). And its `0.0.0.0` listen is an IPv6 wildcard on
   *  macOS, which COEXISTS with another process's IPv4 socket on the same port — measured 2026-09-11:
   *  Python on IPv4 `*:19779` and go-ios on IPv6 `*:19779` both LISTEN, go-ios runs on, and
   *  `127.0.0.1:19779` — what the lease dials — is answered by Python. So the tunnel is ready only when
   *  the child holds the port and NOBODY ELSE does (#1065 close-out review).
   *
   *  ASYNC with a timeout: under Electron this runs in the MAIN process, where a synchronous `lsof` on
   *  every poll stalled the editor, and one stuck on a dead mount would hang it (close-out re-review).
   *
   *  ⚠️ Blind spot, accepted: a non-root `lsof` cannot see a listener owned by root (measured: launchd's
   *  `*:22`, screensharingd's `*:5900`). The host port is this clone's derived 909x, which no root daemon
   *  holds. */
  async listenersOn(port: number): Promise<ListenerScan> {
    // `execFile`'s own timeout only SIGTERMs lsof and then waits for it to close, so one stuck in an
    // uninterruptible wait would never settle — and the pre-spawn check has no readiness timer around it.
    // This bound does not depend on lsof cooperating.
    const bound = LSOF_TIMEOUT_MS + 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<ListenerScan>((resolve) => {
      timer = setTimeout(() => resolve({
        ok: false,
        error: `the socket table read for host port ${port} did not finish within ${bound}ms — refusing rather than risk the lease dialing another process`,
      }), bound);
    });
    try { return await Promise.race([scanWithLsof(port), hardStop]); }
    finally { clearTimeout(timer); }
  },
};

/** The `lsof` call behind a seam, so a test can make it hang without mocking `child_process`. */
export const lsofRunner = {
  exec(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('lsof', args, { timeout: timeoutMs });
  },
};

async function scanWithLsof(port: number): Promise<ListenerScan> {
  try {
    const { stdout } = await lsofRunner.exec(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'], LSOF_TIMEOUT_MS);
    return { ok: true, listeners: parseLsofListeners(stdout) };
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stdout?: string };
    // lsof exits 1 when nothing matches — an answer ("nobody listens"), not a failure.
    if (err.code === 1 && !err.killed) return { ok: true, listeners: parseLsofListeners(err.stdout ?? '') };
    return {
      ok: false,
      error: `could not read the socket table to check host port ${port} (lsof: ${e instanceof Error ? e.message : String(e)}) — `
        + 'refusing rather than risk the lease dialing another process',
    };
  }
}

export type ListenerScan =
  | { ok: true; listeners: Array<{ pid: number; command: string }> }
  | { ok: false; error: string };

/** `lsof -F pc` output → one entry per process. The lines are `p<pid>`, `c<command>`, then `f<fd>` (format
 *  captured 2026-09-11 from two listeners on one port). */
export function parseLsofListeners(stdout: string): Array<{ pid: number; command: string }> {
  const found = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); if (!found.has(pid)) found.set(pid, ''); }
    else if (line.startsWith('c') && pid !== null) found.set(pid, line.slice(1));
  }
  return [...found].map(([p, command]) => ({ pid: p, command }));
}

/** A running `ios forward`, owned by one lease. */
export interface IosForward {
  /** Undefined until the child is spawned — the port check comes first. */
  readonly pid: number | undefined;
  readonly hostPort: number;
  readonly udid: string;
  /** Settles once: this child — and only this child — holds the port's LISTEN sockets, or why not (the
   *  port is held, the socket table could not be read, the child exited or failed to spawn, or it was not
   *  bound by the timeout). */
  readonly ready: Promise<ForwardReady>;
  /** Resolves once the child has exited — or at once, when no child was ever spawned. */
  readonly exited: Promise<void>;
  /** Kill it, or stop it spawning at all. Synchronous and idempotent, so the exit path can call it. */
  stop(): void;
}

export type ForwardReady = { ok: true } | { ok: false; error: string };

/** Refusal text for a host port another process listens on — see `listenersOn` for why it matters. */
function portHeldMessage(port: number, holders: Array<{ pid: number; command: string }>): string {
  return `this clone's device host port ${port} is also listened on by `
    + `${holders.map((h) => `${h.command || 'a process'} (pid ${h.pid})`).join(', ')} — the lease dials 127.0.0.1 `
    + 'and would reach that instead of the go-ios tunnel. Stop it (a go-ios forward another editor left '
    + 'behind can be killed), or set MODOKI_DEVICE_HOST_PORT to a free port.';
}

export function startIosForward(o: {
  goIos: string; hostPort: number; devicePort: number; udid: string; readyTimeoutMs?: number;
  /** Called with the child's pid the moment it is spawned — before readiness — so a crash while it starts
   *  still leaves the startup reap a record. */
  onSpawn?: (pid: number) => void;
  /** Called when the child exits AFTER it was ready — the tunnel is gone mid-lease. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}): IosForward {
  let child: ChildProcess | null = null;
  let stopped = false;
  let isReady = false;
  let tail = '';
  let resolveExited!: () => void;
  const exited = new Promise<void>((r) => { resolveExited = r; });
  const lastLine = (): string => {
    const line = tail.trim().split('\n').pop()?.trim();
    return line ? ` — last output: ${line}` : '';
  };
  const ready = (async (): Promise<ForwardReady> => {
    // A port someone already listens on is refused BEFORE spawning: go-ios would coexist with an IPv4
    // holder, and the lease would dial the holder. A table that cannot be read is refused too — reading
    // it as "nobody" would wave the same hijack through.
    const pre = await goIosForwardRunner.listenersOn(o.hostPort);
    const refusal = !pre.ok ? pre.error
      : pre.listeners.length ? portHeldMessage(o.hostPort, pre.listeners)
        : stopped ? 'the go-ios forward was stopped before it started' : null;
    if (refusal) { resolveExited(); return { ok: false, error: refusal }; }
    const c = goIosForwardRunner.spawnForward(o.goIos, o.hostPort, o.devicePort, o.udid);
    child = c;
    if (c.pid !== undefined) o.onSpawn?.(c.pid);
    return new Promise<ForwardReady>((resolve) => {
      let settled = false;
      let polling = false;
      let poll: ReturnType<typeof setTimeout> | undefined;
      const done = (r: ForwardReady): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(poll);
        isReady = r.ok;
        resolve(r);
      };
      // The log line only STARTS the check — see `listenersOn` for why it cannot end it, and why a holder
      // that is not this child fails the tunnel even when the child bound too.
      const checkBound = async (): Promise<void> => {
        if (settled) return;
        const scan = await goIosForwardRunner.listenersOn(o.hostPort);
        if (settled) return;
        if (!scan.ok) { done({ ok: false, error: scan.error }); return; }
        const others = scan.listeners.filter((h) => h.pid !== c.pid);
        if (others.length) { done({ ok: false, error: portHeldMessage(o.hostPort, others) }); return; }
        if (scan.listeners.length) { done({ ok: true }); return; }
        poll = setTimeout(() => { void checkBound(); }, BIND_POLL_MS);
      };
      const onData = (chunk: Buffer | string): void => {
        tail = (tail + String(chunk)).slice(-4000);
        if (!polling && /start listening/.test(tail)) { polling = true; void checkBound(); }
      };
      c.stdout?.on('data', onData);
      c.stderr?.on('data', onData);
      c.on('error', (e) => { resolveExited(); done({ ok: false, error: `could not start go-ios forward: ${e.message}` }); });
      c.on('exit', (code, signal) => {
        resolveExited();
        // Only a tunnel that was UP can be lost; an exit after a failed start is the stop that followed it.
        if (settled) { if (isReady) o.onExit?.(code, signal); return; }
        done({ ok: false, error: `go-ios forward exited (${code ?? signal}) before it was listening${lastLine()}` });
      });
      const ms = o.readyTimeoutMs ?? FORWARD_READY_TIMEOUT_MS;
      const timer = setTimeout(() => done({ ok: false, error: `go-ios forward was not listening on ${o.hostPort} within ${ms}ms${lastLine()}` }), ms);
    });
  })();
  return {
    get pid() { return child?.pid; },
    hostPort: o.hostPort,
    udid: o.udid,
    ready,
    exited,
    stop() {
      stopped = true;
      const c = child;
      if (c && c.exitCode === null && c.signalCode === null && !c.killed) {
        try { c.kill(); } catch { /* already gone */ }
      }
    },
  };
}

/** Wait for `forward` to exit, at most `ms`. */
export async function waitForForwardExit(forward: IosForward, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([forward.exited, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

// ── A forward left behind by an editor that died without stopping it ──────────────────────────────
//
// SIGTERM from `stop-editor.sh`, a crash and `kill -9` all skip the exit path (see
// `releaseDeviceResourcesOnExit`), and a child the editor spawned is not killed with it on macOS — it is
// re-parented and keeps holding this clone's host port, so the next connect's forward fails to bind.
// The pid is recorded per clone and reaped at startup, the same shape the adb forward reclaim uses.

const RECORD_FILE = 'ios-forward.json';

interface ForwardRecord {
  pid: number;
  hostPort: number;
  bin: string;
  /** The backend process that owns the lease. While it lives the forward is NOT an orphan, whoever runs
   *  the startup reap — Electron's Vite child, respawned on every project open, runs it too. */
  owner: number;
  /** WHICH load of this module inside `owner` — see `OWNER_INSTANCE`. */
  instance?: string;
}

/** This module load's identity. A standalone Vite dev server re-evaluates the plugin's imports on a config
 *  restart IN THE SAME PROCESS (Vite 8.2; the close-out re-review measured a second singleton), building a
 *  new device-connection manager and abandoning the old one with its forward still running. A pid alone
 *  cannot tell that abandoned forward from a live one. */
const OWNER_INSTANCE = randomUUID();

/** Record a forward as owned by THIS process and module load (`owner`/`instance` default to both). */
export function recordIosForward(dir: string, rec: Omit<ForwardRecord, 'owner' | 'instance'> & Partial<Pick<ForwardRecord, 'owner' | 'instance'>>): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify({ owner: process.pid, instance: OWNER_INSTANCE, ...rec }));
  } catch { /* non-fatal: only the startup reap loses its evidence */ }
}

/** Drop the record — only if it still describes `pid`, so a newer forward's record survives. */
export function clearIosForwardRecord(dir: string, pid: number | undefined): void {
  const file = path.join(dir, RECORD_FILE);
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ForwardRecord>;
    if (rec.pid === pid) fs.rmSync(file, { force: true });
  } catch { /* no record */ }
}

export const reapDeps = {
  commandOf(pid: number): string | null {
    try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null; }
    catch { return null; }   // not running (ps exits 1), or no ps
  },
  kill(pid: number): void { process.kill(pid); },
  /** When `pid` started (`ps -o lstart=`), or null. The WDA reap's defence against pid reuse (#1077). Pinned to
   *  the C locale and UTC: `lstart` is formatted by both (measured: `金  9/11 21:00:15 2026` under ja_JP, the
   *  hour moves with TZ), and the record is written by one editor run and compared by a later one. */
  startTimeOf(pid: number): string | null {
    try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim() || null; }
    catch { return null; }
  },
  isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  },
};

/** Kill the forward a previous run of THIS clone recorded, if that pid is still that forward and the
 *  backend that owned it is gone. Returns a log line when it killed one.
 *
 *  The pid is only trusted while its command line is still the recorded go-ios binary running
 *  `forward <hostPort>` — a recycled pid belonging to anything else is left alone. */
export function reapRecordedIosForward(dir: string): string | null {
  const file = path.join(dir, RECORD_FILE);
  let rec: Partial<ForwardRecord>;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ForwardRecord>; } catch { return null; }
  // A LIVE owner means a live lease's forward: leave the child AND its record, or that lease loses its
  // tunnel now and its crash evidence later. "Live" is another process that is still running, or THIS
  // module load. The same pid through an EARLIER load (a standalone Vite config restart) is an abandoned
  // manager's forward — nothing can stop it, and it would refuse every new connect until the process
  // exits — so it is reaped. A record with no owner predates the rule and counts as orphaned.
  const liveElsewhere = typeof rec.owner === 'number' && rec.owner !== process.pid && reapDeps.isAlive(rec.owner);
  const liveHere = rec.owner === process.pid && rec.instance === OWNER_INSTANCE;
  if (liveElsewhere || liveHere) return null;
  try { fs.rmSync(file, { force: true }); } catch { /* */ }
  if (typeof rec.pid !== 'number' || typeof rec.hostPort !== 'number' || typeof rec.bin !== 'string') return null;
  const command = reapDeps.commandOf(rec.pid);
  if (!command || !command.startsWith(rec.bin) || !command.includes(` forward ${rec.hostPort} `)) return null;
  try { reapDeps.kill(rec.pid); } catch { return null; }
  return `[device] reaped a go-ios forward (pid ${rec.pid}) on tcp:${rec.hostPort} left by a previous run`;
}
