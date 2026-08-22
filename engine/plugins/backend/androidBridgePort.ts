/** Find the debug bridge's REAL port on an Android device (#283).
 *
 *  ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *  The bridge binds a fixed default (9095) so the host can dial it without discovery. When another
 *  Modoki app still holds that port, the incoming app falls back to an OS-assigned one and never
 *  reclaims the default — so it is unreachable by every `device_*` tool for the rest of its life,
 *  while looking perfectly healthy. `bindWithRetry` in the plugin now waits out the common
 *  handover, but that is a narrowing, not a closure: the outgoing app does not always release at
 *  all (measured — Court held 9095 through a whole `skin-test` launch with no `Server stopped`
 *  ever logged), and no retry window helps when the port is simply never freed.
 *
 *  ── WHY IT IDENTIFIES THE APP, NOT JUST THE PORT ─────────────────────────────────────────────
 *  Connecting to "whatever is listening" is a WORSE failure than refusing: that is #88, where a
 *  backgrounded sibling answered every call for the app you had just launched, and the answers
 *  looked real. So discovery does not scan for an open port and hope. It asks which app is in the
 *  FOREGROUND, resolves that package to a uid, and returns the listening socket owned by THAT uid.
 *  The port is then correct by construction, and the result carries the package so the caller can
 *  check it against the lease's own `app-identity` afterwards.
 *
 *  ── ADB ONLY ─────────────────────────────────────────────────────────────────────────────────
 *  Every input here comes from `adb shell`, so this is Android-over-USB only. A WiFi lease has no
 *  such channel and keeps the explicit-`port` escape hatch. Saying so is the honest degrade: the
 *  alternative would be a "discovery" that silently answers for one transport and not the other. */

import { execFileSync } from 'child_process';
import { adbBinary, adbArgs } from './androidDevices';

/** A listening TCP socket on the device, as `/proc/net/tcp` reports it. */
export interface DeviceListener {
  port: number;
  uid: number;
}

/** `/proc/net/tcp` state code for LISTEN. Every other state is a live or dying CONNECTION — a
 *  TIME_WAIT remnant on the default port reads identically to a listener if you do not check, and
 *  that is exactly the row that made an earlier diagnosis conclude "nothing is bound" when a
 *  listener was simply elsewhere. */
const TCP_STATE_LISTEN = '0A';

/** Parse LISTEN rows out of `/proc/net/tcp` and/or `/proc/net/tcp6`, concatenated in any order.
 *
 *  The local-address column is `HEXADDR:HEXPORT` — IPv4 is 8 hex digits, IPv6 is 32, so the port is
 *  taken after the LAST colon rather than by a fixed offset. The uid is column 8 (0-based 7). */
export function parseListeningSockets(procNetTcp: string): DeviceListener[] {
  const out: DeviceListener[] = [];
  const seen = new Set<string>();
  for (const line of procNetTcp.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // sl local_address rem_address st tx_queue:rx_queue tr:when retrnsmt uid …
    if (cols.length < 8 || cols[3] !== TCP_STATE_LISTEN) continue;
    const local = cols[1];
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const port = Number.parseInt(local.slice(colon + 1), 16);
    const uid = Number.parseInt(cols[7], 10);
    if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(uid)) continue;
    // A dual-stack listener appears in BOTH files on the same port+uid; one row is the answer.
    const key = `${port}:${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, uid });
  }
  return out;
}

/** The foreground app's package, from `dumpsys window`.
 *
 *  ⚠️ **`mFocusedApp` first, `mCurrentFocus` only as a fallback** — and that ordering is the whole
 *  correctness of this function. `mCurrentFocus` is the focused WINDOW, which is frequently a
 *  SYSTEM window rather than the app: with the notification shade pulled down it reads
 *  `Window{… NotificationShade}` while `mFocusedApp` still correctly names the app underneath.
 *  Measured on the A23 mid-test, where keying off `mCurrentFocus` alone made discovery answer "no
 *  foreground app" for a phone that plainly had one. An IME or the lock screen does the same.
 *
 *    mFocusedApp=ActivityRecord{hash u0 com.example.app/.MainActivity} t422}
 *    mCurrentFocus=Window{hash u0 com.example.app/com.example.app.MainActivity}
 *
 *  Returns undefined when neither names an app (`mFocusedApp=null` on an empty home screen), which
 *  is a real answer — "no app is on screen" — not a parse failure to paper over. */
export function parseForegroundPackage(dumpsysWindow: string): string | undefined {
  const fromApp = /mFocusedApp=\S*\{[^}]*?\s+(\S+?)\/\S*\}/.exec(dumpsysWindow)?.[1];
  const fromWindow = /mCurrentFocus=\S*\{[^}]*?\s+(\S+?)\/\S*\}/.exec(dumpsysWindow)?.[1];
  const pkg = fromApp ?? fromWindow;
  if (!pkg || pkg === 'null') return undefined;
  return pkg;
}

/** The uid `dumpsys package <pkg>` reports (`userId=10406`). Undefined when the package is not
 *  installed, which `dumpsys` reports by simply printing no such line. */
export function parsePackageUid(dumpsysPackage: string): number | undefined {
  const m = /\buserId=(\d+)/.exec(dumpsysPackage);
  if (!m) return undefined;
  const uid = Number.parseInt(m[1], 10);
  return Number.isFinite(uid) ? uid : undefined;
}

export interface DiscoveredBridge {
  port: number;
  /** The package the port belongs to — the foreground app, by construction. */
  pkg: string;
}

/** Resolve the bridge port from already-collected device output. Pure, so the whole decision is
 *  testable without a phone.
 *
 *  Returns undefined rather than guessing whenever the chain breaks — no foreground app, an
 *  unresolvable uid, or no listener owned by it. A wrong port here means talking to another app,
 *  so "I could not tell" must never be rendered as an answer (mcp-tool-conventions §5). */
export function resolveBridgePort(
  procNetTcp: string,
  dumpsysWindow: string,
  uidOf: (pkg: string) => number | undefined,
): DiscoveredBridge | undefined {
  const pkg = parseForegroundPackage(dumpsysWindow);
  if (!pkg) return undefined;
  const uid = uidOf(pkg);
  if (uid === undefined) return undefined;
  const owned = parseListeningSockets(procNetTcp).filter((l) => l.uid === uid);
  if (owned.length === 0) return undefined;
  // An app may hold more than one listening socket (a webview devtools socket is a UNIX socket, not
  // TCP, so it does not appear here — but nothing guarantees uniqueness). Prefer the default port
  // when it is among them, since that is the bridge's own preference; otherwise take the lowest,
  // deterministically, so two reads of an unchanged device agree.
  const preferred = owned.find((l) => l.port === DEFAULT_BRIDGE_PORT);
  const chosen = preferred ?? owned.slice().sort((a, b) => a.port - b.port)[0];
  return { port: chosen.port, pkg };
}

/** The bridge's fixed default. Duplicated from `deviceConnection`'s `DEVICE_PORT` deliberately:
 *  importing it would make these two modules import each other (that module already re-exports
 *  `adbBinary` from `androidDevices` for exactly that reason). Guarded by a test that asserts the
 *  two agree. */
export const DEFAULT_BRIDGE_PORT = 9095;

/** The `adb shell` reads behind an overridable seam, so tests inject output instead of mocking
 *  `child_process` (which fights vitest's per-file module cache). */
export const bridgePortExec = {
  procNetTcp(serial?: string): string {
    // Both files in ONE shell: a dual-stack phone lists the socket in tcp6 and an IPv4-only bind in
    // tcp, and which one it is is not knowable in advance.
    return execFileSync(adbBinary(), adbArgs(serial, ['shell', 'cat /proc/net/tcp /proc/net/tcp6']),
      { timeout: 4000, encoding: 'utf8' });
  },
  dumpsysWindow(serial?: string): string {
    // Both lines, filtered ON THE DEVICE rather than dumping the whole window service: the full
    // output is hundreds of KB and all of it crosses USB. `head -2` rather than `grep -m1` because
    // BOTH keys are wanted — see `parseForegroundPackage` for why `mCurrentFocus` alone is wrong.
    return execFileSync(adbBinary(), adbArgs(serial, ['shell',
      'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -2']),
      { timeout: 4000, encoding: 'utf8' });
  },
  packageUid(pkg: string, serial?: string): string {
    return execFileSync(adbBinary(), adbArgs(serial, ['shell', `dumpsys package ${pkg} | grep -m1 userId=`]),
      { timeout: 4000, encoding: 'utf8' });
  },
};

/** The package currently in the foreground, or undefined when that cannot be established. Never
 *  throws — a caller uses this to CHECK a lease it already has, and an adb hiccup must not turn a
 *  working connection into an error. */
export function foregroundPackage(serial?: string): string | undefined {
  try { return parseForegroundPackage(bridgePortExec.dumpsysWindow(serial)); }
  catch { return undefined; }
}

/** Ask the device where its bridge is actually listening. Undefined when the answer cannot be
 *  established — see `resolveBridgePort`. Never throws: this runs on a failure path, and an adb
 *  hiccup here must not replace the caller's real error with this one. */
export function discoverBridgePort(serial?: string): DiscoveredBridge | undefined {
  try {
    const proc = bridgePortExec.procNetTcp(serial);
    const win = bridgePortExec.dumpsysWindow(serial);
    return resolveBridgePort(proc, win, (pkg) => {
      try { return parsePackageUid(bridgePortExec.packageUid(pkg, serial)); }
      catch { return undefined; }
    });
  } catch {
    return undefined;
  }
}
