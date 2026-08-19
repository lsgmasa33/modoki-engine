/**
 * Machine-wide device claims — "is another clone already using this phone?" (#149 part 2).
 *
 * The debug-bridge lease already arbitrates the SOCKET: the device enforces one owner GUID with a
 * 5s grace window, so two clones cannot both hold it and the second is refused `busy`. That works,
 * and nothing here replaces it. What it cannot cover is everything OUTSIDE the socket, all of which
 * two concurrent Claude sessions on this machine can do to the same phone unimpeded:
 *
 *   - **adb** — one machine-wide daemon. A sibling clone's `adb forward` on the same port, or any
 *     `adb shell`, is completely unaffected by the lease.
 *   - **`xcodebuild` install / launch** — two clones can install over each other on one device.
 *   - **The WebDriverAgent launch** — one agent per device on port 8100. `wdaLauncher` guards
 *     against a second launch by the SAME process; nothing stopped a second CLONE spawning a rival
 *     signed agent on the same phone.
 *   - **The physical device** — the screen shows one thing, and two agents tapping it interleave.
 *
 * So this is a claim on the HARDWARE, not on the socket, and it has to be machine-wide for the same
 * reason `~/.modoki/editor-launches.log` is: **the sibling that caused the collision is exactly what
 * a per-clone file cannot see.** It lives beside that log, in the same directory, for that reason.
 *
 * ── Why not extend the lease GUID instead? ──
 * The issue asks the right question — one arbitrator beats two that can disagree — and the answer is
 * that the lease GUID cannot reach these cases even in principle. It is presented over a TCP socket
 * to a running app; an `xcodebuild install` happens when no app is running, an `adb shell` bypasses
 * the app entirely, and a WDA launch targets a phone by UDID with no socket involved. A claim has to
 * be checkable BEFORE and WITHOUT any connection to the device, which means it has to live on this
 * machine's filesystem. The two are kept from disagreeing by construction instead: the lease OWNS
 * the claim (acquired in `connect`, released in `disconnect`), so a held lease always implies a held
 * claim, and the claim record carries the lease GUID so a reader can tell they are the same holder.
 *
 * ── Staleness is the real design risk ──
 * `docs/task-claiming.md` records that nothing expiring a `wip/*` label is a genuine cost, and a
 * dead session's device lock would be strictly worse: it blocks HARDWARE, not a ticket, and the
 * human it blocks is not the one who left it. So a claim is expired by BOTH tests, either of which
 * is sufficient:
 *   - **pid liveness** — the claiming backend process is gone (the common case: an editor was
 *     quit, or crashed, without releasing). Instant, exact, and needs no clock.
 *   - **a TTL** — a wall-clock backstop for the case pid liveness cannot see: a recycled pid, or a
 *     claim written by a machine whose clock jumped. Deliberately generous (12h), because expiring
 *     a LIVE claim silently re-opens the collision this module exists to prevent, whereas holding a
 *     dead one for an extra hour merely produces a refusal that names a pid the human can check.
 *
 * A refusal always NAMES the holder (`docs/mcp-tool-conventions.md` §5) — "clone work-ai has held
 * RFDEADBEEF2 since 14:02 (pid 8123)" is actionable; "device busy" is not.
 *
 * ── KNOWN GAP: one phone can hold two claim ids ──
 * A device is claimed under the id it was REACHED by, and an iPhone can be reached two ways: a WiFi
 * lease claims `ip:<host>` (the address is the only identity available at connect time), while the
 * WebDriverAgent launch claims `ios:<udid>` (that path knows the UDID, since it picked the device
 * out of `xcrun`). Nothing here can tell that those two ids are the same handset, so on paper two
 * clones could hold one iPhone — one by address, one by UDID.
 *
 * It is not reachable in practice, and the reason is worth stating rather than trusting: a WDA
 * launch only ever happens UNDER a lease, and the device's own socket lease is exclusive (first
 * wins, 5s grace), so a second clone cannot obtain the lease that would let it launch the agent.
 * The socket lease closes the hole that this file structurally cannot.
 *
 * What would REOPEN it is giving anything a way to launch WDA, install, or drive a phone without
 * first holding the lease. If that ever happens, the fix is to re-key the WiFi claim once the
 * bridge reports the device's identity (`deviceHardware()` arrives a round trip after connect) —
 * not to add a second arbitrator.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the claims live: beside `editor-launches.log`, machine-wide by design (see the header).
 *
 *  **Under vitest, NEVER the real `~/.modoki`.** This file is machine-wide state that blocks
 *  HARDWARE: a test that claims a device and does not release it would leave the developer's own
 *  phone refused by their editor, with a message naming a vitest worker that exited hours ago. Every
 *  test that touches claims is expected to set `MODOKI_HOME` itself (and they do), but "expected to"
 *  is not a guarantee — a test that merely CONNECTS a lease reaches this code without ever
 *  mentioning claims, which is exactly how the trap gets sprung by someone who never read this file.
 *  So the interlock lives here, where it cannot be forgotten, rather than in each test.
 *
 *  Deliberately NOT the usual "seam injectable only halfway" mistake: this does not change the RULE
 *  under test — the resolution order, the conflict, the expiry all behave identically — only the
 *  directory those rules operate on, and only when no explicit one was given. */
export function claimsDir(): string {
  if (process.env.MODOKI_HOME) return process.env.MODOKI_HOME;
  if (process.env.VITEST) return path.join(os.tmpdir(), `modoki-claims-vitest-${process.pid}`);
  return path.join(os.homedir(), '.modoki');
}

function claimsFile(): string {
  return path.join(claimsDir(), 'device-claims.json');
}

/** Wall-clock backstop for a claim whose pid check cannot settle it. Generous on purpose — see the
 *  header: expiring a live claim re-opens the collision, expiring a dead one late costs a message. */
export const CLAIM_TTL_MS = 12 * 60 * 60 * 1000;

/** A device id is namespaced by HOW the device is addressed, because the namespaces genuinely have
 *  different identity guarantees and silently mixing them would let a strong id and a weak one
 *  collide:
 *    - `adb:<serial>`  — a hardware serial. Stable, unique, the real thing.
 *    - `ios:<udid>`    — a hardware UDID from `xcrun`. Same strength.
 *    - `ip:<host>`     — a WiFi lease, where the ADDRESS is the only identity available at connect
 *                        time (the phone reports its model over the bridge, but not until the lease
 *                        is already open, and a model is not unique anyway). Weaker: DHCP can move
 *                        it. Namespaced so nobody mistakes it for a hardware id, and so the same
 *                        phone reached two ways yields two claims rather than one false match. */
export type DeviceId = string;

export function adbDeviceId(serial: string): DeviceId { return `adb:${serial}`; }
export function iosDeviceId(udid: string): DeviceId { return `ios:${udid}`; }
export function wifiDeviceId(host: string): DeviceId { return `ip:${host}`; }

/** Who holds a device, and enough to find them. `label` is the human-facing device name when the
 *  claimer knew one (`SC_56C`, `Masaki iPhone Air`) — a serial alone is hard to match to the phone
 *  on the desk. */
export interface DeviceClaim {
  deviceId: DeviceId;
  /** Absolute path of the claiming clone — the thing that identifies WHICH checkout, since branch
   *  alone repeats across machines and pid alone says nothing about where to go look. */
  clone: string;
  branch: string;
  pid: number;
  /** The lease GUID this claim belongs to, when it was taken by a lease. Lets a reader see that the
   *  claim and the socket lease are the same holder rather than two mechanisms that agree by luck. */
  guid?: string;
  /** Epoch ms. Formatted only at the point a human reads it — a stored ISO string would invite
   *  string comparison for the TTL. */
  at: number;
  label?: string;
  /** What the holder is doing: a held lease, a WDA launch, an install. Purely for the message —
   *  "holding a device lease" and "installing a build" call for different patience. */
  purpose?: string;
}

interface ClaimsFileShape { claims: DeviceClaim[] }

/** Is that process still alive? `kill(pid, 0)` signals nothing and throws ESRCH when it is gone.
 *  EPERM means it EXISTS but belongs to another user — alive, and emphatically not ours to expire. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Is this claim dead — either its process is gone, or it has outlived the TTL? PURE (the liveness
 *  probe and the clock are injectable) so both expiry rules are testable without spawning anything. */
export function isStale(
  claim: DeviceClaim,
  opts: { now?: number; alive?: (pid: number) => boolean } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? isPidAlive;
  if (!alive(claim.pid)) return true;
  // A NEGATIVE age (a claim stamped in the future — a clock skew between two machines sharing a
  // network home dir) is not an expiry: it is a live claim with a bad clock, and expiring it would
  // hand the device to a second session. Only genuine age counts.
  return now - claim.at > CLAIM_TTL_MS;
}

// ── File I/O ─────────────────────────────────────────────────────────────────

function readClaims(): DeviceClaim[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimsFile(), 'utf8')) as ClaimsFileShape;
    return Array.isArray(parsed?.claims) ? parsed.claims.filter((c) => c && typeof c.deviceId === 'string') : [];
  } catch {
    return []; // not created yet, or corrupt — an unreadable claims file must never block hardware
  }
}

/** Write via a temp file + rename, so a reader never sees a half-written file. The rename is atomic
 *  within a directory on every platform we run on. */
function writeClaims(claims: DeviceClaim[]): void {
  const dir = claimsDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.device-claims-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ claims }, null, 2));
  fs.renameSync(tmp, claimsFile());
}

/** Serialize read-modify-write across PROCESSES with an O_EXCL lock dir.
 *
 *  Four clones acquiring at once is the whole premise of this module, so a bare read→write really
 *  can interleave and lose a claim — and the claim it loses is the one that would have refused the
 *  collision. `mkdir` is the classic exclusive primitive (atomic on every filesystem we care about,
 *  unlike `open(O_EXCL)` over NFS).
 *
 *  A lock older than `LOCK_STALE_MS` is broken rather than waited on: a process killed mid-claim
 *  would otherwise wedge every clone on this machine permanently, which is a far worse failure than
 *  the vanishingly unlikely race breaking it re-opens. The whole critical section is a read, a
 *  filter and a write of a file with single-digit entries — microseconds, so 5s is enormous. */
const LOCK_STALE_MS = 5000;

function withLock<T>(fn: () => T): T {
  const lock = path.join(claimsDir(), '.device-claims.lock');
  fs.mkdirSync(claimsDir(), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      let age: number;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; /* vanished — retry */ }
      if (age > LOCK_STALE_MS) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) break; // give up waiting and proceed: never block hardware on a lock
      // Busy-wait deliberately: this is a microsecond critical section and the caller is sync.
      const until = Date.now() + 15;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── The API ──────────────────────────────────────────────────────────────────

/** Every LIVE claim, stale ones dropped. The read behind `device_list` and the AI panel. */
export function listClaims(opts: { now?: number; alive?: (pid: number) => boolean } = {}): DeviceClaim[] {
  return readClaims().filter((c) => !isStale(c, opts));
}

export interface ClaimRequest {
  deviceId: DeviceId;
  clone?: string;
  branch?: string;
  guid?: string;
  label?: string;
  purpose?: string;
}

export type ClaimResult =
  | { ok: true; claim: DeviceClaim }
  | { ok: false; held: DeviceClaim; message: string };

/** Take a device, or refuse naming who has it.
 *
 *  Re-claiming a device THIS process already holds is a no-op success, not a conflict: the lease
 *  reconnects, the WDA launcher and an install all legitimately claim the same phone within one
 *  session, and making them coordinate amongst themselves would put the arbitration back in the
 *  place this module took it out of. The claim is refreshed (a new timestamp, the latest purpose)
 *  so a long session cannot age out of its own TTL. */
export function claimDevice(req: ClaimRequest, opts: { now?: number; alive?: (pid: number) => boolean } = {}): ClaimResult {
  const now = opts.now ?? Date.now();
  return withLock(() => {
    const live = readClaims().filter((c) => !isStale(c, opts));
    const existing = live.find((c) => c.deviceId === req.deviceId);
    if (existing && existing.pid !== process.pid) {
      return { ok: false, held: existing, message: describeConflict(existing, now) };
    }
    const claim: DeviceClaim = {
      deviceId: req.deviceId,
      clone: req.clone ?? process.cwd(),
      branch: req.branch ?? currentBranch(),
      pid: process.pid,
      at: now,
      ...(req.guid ? { guid: req.guid } : {}),
      ...(req.label ? { label: req.label } : {}),
      ...(req.purpose ? { purpose: req.purpose } : {}),
    };
    writeClaims([...live.filter((c) => c.deviceId !== req.deviceId), claim]);
    held.add(req.deviceId);
    heldDir = claimsDir();
    installExitHook();
    return { ok: true, claim };
  });
}

/** Give a device back. Only THIS process's claim is dropped — a release must never be able to
 *  revoke a sibling clone's hold, which would turn a stop-my-own-session action into a way to seize
 *  hardware from someone else. Stale entries are swept in the same write, since we hold the lock. */
export function releaseDevice(deviceId: DeviceId, opts: { now?: number; alive?: (pid: number) => boolean } = {}): void {
  withLock(() => {
    const all = readClaims();
    const next = all
      .filter((c) => !isStale(c, opts))
      .filter((c) => !(c.deviceId === deviceId && c.pid === process.pid));
    // Write when anything went — our claim, or stale entries swept while we hold the lock. Compared
    // against the file as READ, so a pure stale-sweep still persists rather than being discarded.
    if (next.length !== all.length) writeClaims(next);
    held.delete(deviceId);
  });
}

/** Drop every claim held by this process — the editor is shutting down. Best-effort by design: a
 *  crash skips it entirely, which is exactly what pid-liveness expiry is for. */
export function releaseAllForThisProcess(opts: { now?: number; alive?: (pid: number) => boolean } = {}): void {
  withLock(() => {
    const all = readClaims();
    const next = all.filter((c) => !isStale(c, opts)).filter((c) => c.pid !== process.pid);
    // Write ONLY when something actually goes. Unconditionally writing would make merely IMPORTING
    // this module (a test, a tool) create `~/.modoki/device-claims.json` on exit — a module with no
    // claims must leave no trace.
    if (next.length !== all.length) writeClaims(next);
    held.clear();
  });
}

/** Drop every claim whose holder is provably gone — from the FILE, not merely from a read.
 *
 *  Every reader already applies `isStale`, so a dead-pid claim never actually blocks anyone. That
 *  is measured, not assumed, and it is the half of #225 that was wrong: the report described a
 *  phone "locked out for the rest of a working day", and a probe with a synthetic dead-pid claim
 *  showed `listClaims()` returning `[]` and a sibling clone claiming the same device unrefused.
 *
 *  What a corpse in the file DOES do is lie to a human. `~/.modoki/device-claims.json` is a
 *  documented read surface — CLAUDE.md tells an agent to check it is clear of this clone after a
 *  session — and an entry naming this clone, this branch and a purpose reads exactly like a live
 *  hold. Twice that cost the reporter a hand-edit, and then an issue. So the fix is to make the
 *  file agree with the rule, rather than to change a rule that was already right.
 *
 *  Called at backend STARTUP, the same lifetime hook `reclaimStaleDeviceStateAtStartup` uses for
 *  adb forwards and for exactly the same reason: startup is the one teardown point that a crash, a
 *  `kill -9`, or the SIGTERM `stop-editor.sh` sends cannot skip. Writes only when something
 *  actually goes, so importing this module — or starting a backend on a machine with no claims —
 *  never creates the file.
 *
 *  Returns what it swept, so the caller can say so rather than cleaning up silently. */
export function sweepStaleClaims(opts: { now?: number; alive?: (pid: number) => boolean } = {}): DeviceClaim[] {
  return withLock(() => {
    const all = readClaims();
    // Partition ONCE. Calling isStale twice — once to collect, once to filter the write — reads
    // the clock and probes the pid twice, so a claim that expires BETWEEN the two calls is dropped
    // from the file by the second and missing from the list returned by the first. The write would
    // still be right; the caller's "swept N" line would not, and a cleanup that misreports what it
    // cleaned is exactly the class of message #225 was filed about.
    const stale: DeviceClaim[] = [];
    const live: DeviceClaim[] = [];
    for (const c of all) (isStale(c, opts) ? stale : live).push(c);
    if (!stale.length) return [];
    writeClaims(live);
    return stale;
  });
}

/** Exactly what this process took, and from which claims dir — so the exit hook gives back what it
 *  holds rather than "whatever in the current file bears my pid".
 *
 *  The distinction is not theoretical: `claimsDir()` is read dynamically (that is how tests point it
 *  at a temp dir), so a hook that re-resolved it at exit would run against whatever `MODOKI_HOME`
 *  happened to be by then — a test process could reach the developer's REAL claims file and delete a
 *  live claim that merely shared a pid. Recording the pair makes that unreachable. */
const held = new Set<string>();
let heldDir: string | null = null;

/** Give every claim back when this process exits — registered LAZILY, on the first successful claim,
 *  so a process that never claims anything never installs a hook and never touches the claims file.
 *
 *  `exit` only, deliberately. Adding SIGINT/SIGTERM listeners would SUPPRESS Node's default
 *  terminate-on-signal behaviour, changing how the editor shuts down to buy a tidier claims file —
 *  a bad trade. The uncovered cases (a signal, a crash, a `kill -9`) are exactly what pid-liveness
 *  expiry is for: the next clone to ask sees a dead pid and takes the device immediately. */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    if (!held.size || !heldDir) return;
    // Everything below is synchronous fs — the only kind of work an `exit` handler can do. Pinned to
    // the dir the claims were TAKEN in, for the reason on `heldDir`.
    const prev = process.env.MODOKI_HOME;
    try {
      process.env.MODOKI_HOME = heldDir;
      for (const id of [...held]) releaseDevice(id);
    } catch { /* nothing left to do at exit */ } finally {
      if (prev === undefined) delete process.env.MODOKI_HOME; else process.env.MODOKI_HOME = prev;
    }
  });
}

/** The refusal text. Names the clone, the branch, when, and the pid — every one of which is a
 *  different way for the human to find the session that is holding their phone. */
export function describeConflict(held: DeviceClaim, now: number = Date.now()): string {
  const where = held.label ? `${held.label} (${held.deviceId})` : held.deviceId;
  const when = new Date(held.at).toLocaleTimeString();
  const mins = Math.max(0, Math.round((now - held.at) / 60000));
  const doing = held.purpose ? ` ${held.purpose}` : '';
  return `${where} is already claimed by clone ${held.clone} on branch ${held.branch}${doing} — `
    + `since ${when} (${mins} min ago, pid ${held.pid}). Two sessions driving one phone interleave `
    + 'taps and install over each other, so this is refused rather than shared. Release it there '
    + '(device_disconnect, or quit that editor), or use a different device.';
}

/** This clone's branch, for the claim record. Read from `.git/HEAD` rather than by spawning git:
 *  claiming sits on the connect path and must not pay a process spawn, and a detached HEAD (or no
 *  git at all) is an unknown branch, never an error. */
function currentBranch(): string {
  try {
    const head = fs.readFileSync(path.join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 12);
  } catch {
    return 'unknown';
  }
}
