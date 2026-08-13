/**
 * Dev-only Vite dev-server lifecycle owner (C4c-3 — live "Open Project").
 *
 * In the DEV editor the renderer loads three project-specific things from the
 * Vite dev server (5173): its shell, the open project's game CODE (`/@fs/<proj>/
 * game.ts`), and the project's ASSETS (`/assets/...`, served by the asset-scanner
 * middleware). All three are rooted at `MODOKI_PROJECT`, which Vite reads ONCE at
 * startup (it drives the asset scanner's projectRoot, `server.fs.allow`, the
 * host-shared-deps plugin, and `resolve.dedupe`). main's own asset backend only
 * serves `/api/*`.
 *
 * So switching projects live means re-rooting that Vite server — and the only
 * reliable way to re-root it (every `MODOKI_PROJECT`-derived value is captured at
 * config time) is to OWN its process and restart it with the new project. main
 * spawns it here and restarts it on `setProject`; the renderer then reloads and
 * pulls shell + game + assets from the freshly-rooted server.
 *
 * C4c-3b ("run Vite in prod") makes the PACKAGED editor use this module too: main
 * spawns Vite there as well, so the packaged app == the dev app (one Vite origin
 * serves shell + game + assets). The only difference is `repoRoot` — in a packaged
 * build it's <Resources>/app.asar.unpacked (engine/** + node_modules/** are
 * asarUnpack'd to real files; Vite can't run inside the asar). See main.ts REPO_ROOT
 * and electron-builder.yml.
 *
 * THE INVARIANT THIS MODULE EXISTS TO HOLD (#190): the server on the port is the one we
 * started, rooted at the project the editor says is open. Break it and nothing looks broken
 * — the editor reports the new project, the renderer loads the OLD one's code and assets,
 * and edits save against the wrong tree. It is enforced three ways, because each covers a
 * hole the others don't:
 *   1. `intentionallyStopped` + `exitDisposition` — a dying predecessor can never clear the
 *      state describing its replacement (that clobber is what orphaned the live Vite).
 *   2. `stopDevServer` waits for the real `exit`, so the port is free before the respawn.
 *   3. `probeDevServerPort` — identity, not timing. Checked BEFORE spawning (reclaim our own
 *      stray, refuse anyone else's) and again in `waitForServer` (the pid on the port must be
 *      the pid we spawned). This is the one that also survives a crashed previous launch.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { winKillTreeArgs } from '../plugins/buildStepShell';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let child: ChildProcess | null = null;
let currentRoot: string | null = null;
let exitHookInstalled = false;

/** Children we killed on purpose.
 *
 *  Per-child, NOT the module-global `intentionalStop` flag this replaces (#190). A stopped
 *  child's `exit` event arrives ASYNCHRONOUSLY — on Windows reliably AFTER the replacement
 *  has already been spawned, because `killTreeWin32` returns the moment `taskkill` does — and
 *  by then a global flag has been reset to `false` by the new `startDevServer` and is
 *  describing the wrong process. The predecessor's handler therefore logged a false "dev
 *  server exited unexpectedly" AND nulled `child`, orphaning the live Vite: the next project
 *  switch had nothing to stop, so the old server kept the port, the new one died on
 *  `--strictPort`, and the editor silently served the OLD project under the new one's name. */
const intentionallyStopped = new WeakSet<ChildProcess>();

/** Whether a force-kill of `c` must go through the Windows TREE kill rather than `child.kill()`.
 *  Pure + exported so the decision is unit-testable from any host — the same reason
 *  `winKillTreeArgs` is. `platform` defaults to the running process; override it only in tests. */
export function needsWinTreeKill(
  c: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'> | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  // Never taskkill a REAPED pid: the number may have been reused by an unrelated process, and
  // /T would take its whole tree with it. Same guard as killBuildProcess.
  if (!c || !c.pid || c.exitCode !== null || c.signalCode !== null) return false;
  return true;
}

/** Kill the Vite child AND its descendants, synchronously, on Windows only (#185).
 *  Returns false on posix, where the caller's own `child.kill(sig)` is correct and sufficient (the
 *  signal runs Vite's handlers, which reap the build children themselves). */
function killTreeWin32(c: ChildProcess | null): boolean {
  if (!needsWinTreeKill(c)) return false;
  // Reuses buildStepShell's argv so the taskkill form — and the "BY PID, never /IM" rule that
  // keeps it off another clone's processes — is defined in exactly one place.
  try { execFileSync('taskkill', winKillTreeArgs(c!.pid!), { stdio: 'ignore' }); } catch { /* already gone */ }
  return true;
}

/** Force-kill the Vite child: the whole tree on Windows, a plain SIGKILL elsewhere. */
function killTree(c: ChildProcess | null): void {
  if (killTreeWin32(c)) return;
  c?.kill('SIGKILL');
}

/** Last-resort reaper: if main is SIGKILL'd / crashes / quits for an update,
 *  `before-quit` may not run and the spawned Vite child would orphan (holding its
 *  port). A synchronous process-exit hook force-kills it. Exit handlers must be
 *  synchronous, so we SIGKILL. Installed once, on first spawn. (E2)
 *
 *  ⚠️ On Windows that must be a TREE kill, not `child.kill()` (#185). There, `kill()` is a
 *  `TerminateProcess` on the Vite pid ALONE — Vite runs no handler, so `buildStepShell`'s own
 *  shutdown hook never fires, and an in-flight build's grandchildren are orphaned. Measured: a
 *  `gradlew --no-daemon` JVM outlived a hard-killed parent by 60s+. posix is already fine and is
 *  deliberately left alone: SIGTERM/SIGKILL there DO run Vite's handlers, which reap the build
 *  children properly, and signalling a group from here would reach the wrong processes (the Vite
 *  child is not `detached`, so it shares Electron's group). */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const kill = () => { try { killTree(child); } catch { /* already gone */ } };
  process.on('exit', kill);
  process.once('SIGINT', () => { kill(); process.exit(130); });
  process.once('SIGTERM', () => { kill(); process.exit(143); });
}

/**
 * Resolve a free loopback port, PREFERRING `preferred` (so the first editor still
 * lands on the conventional port — a stable MCP target / Vite origin) but falling
 * back to an OS-assigned ephemeral port when it's already taken. This is what lets
 * a SECOND editor launch instead of hard-failing on a port clash. `preferred` ≤ 0
 * (or omitted) ⇒ ephemeral straight away.
 *
 * There is an inherent (tiny) TOCTOU window between closing this probe socket and
 * the real listener binding; for a localhost dev tool that's acceptable.
 *
 * `allowFallback=false` makes an occupied `preferred` REJECT instead of drifting to
 * an ephemeral port — used when the port is an explicitly-pinned, stable contract
 * (MODOKI_BACKEND_PORT, the MCP target) that must not silently change. (E6)
 */
/** Addresses to bind-probe before calling a port free.
 *
 *  ONE bind probe is not enough, because `SO_REUSEADDR` (which Node sets on every
 *  `net.Server`) lets a bind succeed alongside an existing one on a DIFFERENT
 *  address. Measured on macOS — rows are who already holds the port, columns are
 *  what a probe reports:
 *
 *      held        probe 0.0.0.0   probe 127.0.0.1   probe ::1
 *      0.0.0.0     EADDRINUSE      free              free
 *      127.0.0.1   free            EADDRINUSE        free
 *      ::          EADDRINUSE      free              free
 *      ::1         free            free              EADDRINUSE
 *
 *  Note there is no superset: probing only `127.0.0.1` (what we did before #67)
 *  is blind to a sibling clone's `vite --host 0.0.0.0`, and probing only
 *  `0.0.0.0` would be blind to our OWN `--host 127.0.0.1` dev server, which is
 *  the far more common clash. A port is free only when EVERY probe says so.
 *  Full rule + the ownership guard: docs/editor.md § "Port selection". */
const PROBE_HOSTS = ['0.0.0.0', '127.0.0.1', '::1'] as const;

/** Bind-probe one address. Resolves 'in-use' ONLY for a real clash: any other
 *  error (no IPv6 stack → EADDRNOTAVAIL/EAFNOSUPPORT, a sandbox refusing the
 *  wildcard → EACCES) means this address can't testify, and treating that as a
 *  clash would make the editor refuse a perfectly free port. */
function probeHost(port: number, host: string): Promise<'free' | 'in-use'> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' ? 'in-use' : 'free');
    });
    srv.listen(port, host, () => srv.close(() => resolve('free')));
  });
}

/** OS-assigned ephemeral port. */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export async function findFreePort(preferred?: number, allowFallback = true): Promise<number> {
  const want = preferred && preferred > 0 ? preferred : 0;
  // Ephemeral is asked of the OS, which won't hand out a port it has bound — no
  // multi-host probe needed (and nothing to prefer if it did clash).
  if (want === 0) return ephemeralPort();

  // SEQUENTIALLY, never Promise.all. The probes bind the SAME port on overlapping addresses
  // (0.0.0.0 covers 127.0.0.1), so run concurrently they collide with EACH OTHER: on Linux,
  // binding a specific address while the wildcard is held needs SO_REUSEPORT, and SO_REUSEADDR
  // — which is what Node sets — only covers TIME_WAIT reuse. macOS is permissive here, so the
  // bug was invisible on every dev machine while making findFreePort report EVERY port as
  // in-use on Linux, i.e. silently never honouring a preferred port and always falling back to
  // an ephemeral one. That is the E6 pinned-port contract failing quietly on that platform.
  // Measured via CI (run 30700447503): an identically-shaped concurrent probe in the test
  // helper found all 40 ports of a fresh 61000-61039 band "occupied".
  let inUse = false;
  for (const h of PROBE_HOSTS) {
    if (await probeHost(want, h) === 'in-use') { inUse = true; break; }
  }
  if (!inUse) return want;
  if (!allowFallback) {
    const err: NodeJS.ErrnoException = new Error(`listen EADDRINUSE: address already in use ${want}`);
    err.code = 'EADDRINUSE';
    throw err;
  }
  return ephemeralPort();
}

/** Single reachability probe — resolves true if the dev server answers `url`. */
function reachable(url: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.on('error', () => { req.destroy(); resolve(false); });
  });
}

/** What a Modoki Vite dev server answers on `/api/dev-server-identity`. That route exists
 *  ONLY on our dev server, so a well-formed answer is itself proof of what holds the port. */
export interface DevServerIdentity {
  /** The dev server's own pid — the one to kill when reclaiming the port. */
  pid: number;
  /** The editor process that spawned it. Distinguishes a LEAKED server (its editor is gone)
   *  from one a second live editor of the same install is legitimately using. */
  ppid: number;
  /** The project it is rooted at (its `MODOKI_PROJECT`). */
  projectRoot: string;
  /** The editor tree it serves. Scopes a reclaim to OUR install — a sibling clone's dev
   *  server answers this route too, and killing it is the one thing we must never do. */
  repoRoot: string;
}

/** Tri-state, because "nothing is listening" and "something is listening but it isn't ours"
 *  demand OPPOSITE actions (spawn vs. refuse) and collapsing them into a nullable identity
 *  is how a foreign server gets silently adopted. */
export type PortProbe =
  | { state: 'empty' }
  | { state: 'foreign' }
  | { state: 'modoki'; identity: DevServerIdentity };

const IDENTITY_PATH = '/api/dev-server-identity';

/** Pure half of the probe, so "is this really ours" is testable without a socket.
 *  Rejects anything that isn't our exact payload: Vite's SPA fallback (HTML), the JSON
 *  404 an older build's `/api/*` catch-all emits, and a partial/foreign body. */
export function parseDevServerIdentity(raw: string): DevServerIdentity | null {
  try {
    const j = JSON.parse(raw) as Partial<DevServerIdentity> & { modoki?: unknown };
    if (j.modoki !== true) return null;
    const pid = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
    if (!pid(j.pid) || !pid(j.ppid)) return null;
    if (typeof j.projectRoot !== 'string' || !j.projectRoot) return null;
    if (typeof j.repoRoot !== 'string' || !j.repoRoot) return null;
    return { pid: j.pid as number, ppid: j.ppid as number, projectRoot: j.projectRoot, repoRoot: j.repoRoot };
  } catch {
    return null;
  }
}

/** The most identity JSON we will read before giving up on it. Our own answer is ~200 bytes;
 *  Vite's SPA fallback (the realistic wrong answer) is ~6KB. Anything past this is a server
 *  streaming at us, and buffering it unbounded to decide "not ours" would be the only way this
 *  probe could hurt the editor. */
const IDENTITY_MAX_BYTES = 64 * 1024;

/** Ask whatever is listening at `url` who it is. Never throws.
 *
 *  The three outcomes are NOT interchangeable — 'empty' authorises a spawn, 'foreign' refuses
 *  one — so the mapping matters more than it looks:
 *    - connection error (ECONNREFUSED) ⇒ 'empty'. Nothing is on the port.
 *    - a TIMEOUT ⇒ 'foreign', NOT 'empty'. A timeout means the connection was ACCEPTED and the
 *      answer never came, i.e. something IS there and is hung or not speaking HTTP. Calling
 *      that "empty" told the caller to spawn into an occupied port, where `--strictPort` kills
 *      the new Vite and the editor then reports "dev server not reachable" about a port that is
 *      plainly answering — the wrong diagnosis, which is the whole failure mode of #190.
 *    - anything else that answers but will not identify ⇒ 'foreign'. */
export function probeDevServerPort(url: string, timeoutMs = 1500): Promise<PortProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (p: PortProbe) => { if (!settled) { settled = true; resolve(p); } };
    const req = http.get(new URL(IDENTITY_PATH, url), (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (raw.length > IDENTITY_MAX_BYTES) return; // keep reading, stop buffering
        raw += c;
      });
      res.on('end', () => {
        const identity = res.statusCode === 200 && raw.length <= IDENTITY_MAX_BYTES
          ? parseDevServerIdentity(raw)
          : null;
        done(identity ? { state: 'modoki', identity } : { state: 'foreign' });
      });
      res.on('error', () => done({ state: 'foreign' }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ state: 'foreign' }); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      req.destroy();
      // A refused connection is the only error that proves the port is free. Anything else
      // (a reset mid-answer, a TLS/protocol mismatch) means something is there.
      done(e.code === 'ECONNREFUSED' ? { state: 'empty' } : { state: 'foreign' });
    });
  });
}

/** Compare two filesystem paths for identity. Windows is case-insensitive and mixes
 *  separators (`C:\a\b` vs `C:/a/b` — the two sides of this comparison come from
 *  `path` and from JSON respectively), so a raw `===` would refuse to recognise our own
 *  install and turn every reclaim into a refusal. `platform` is injectable for tests, the
 *  same convention `needsWinTreeKill` uses. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

export type PortVerdict =
  | { action: 'free' }
  | { action: 'reclaim'; pid: number; projectRoot: string }
  | { action: 'refuse'; why: string };

/** Is `pid` a live process? EPERM means it exists but isn't ours to signal, which is still
 *  ALIVE — reading that as dead is what would make an ownership check authorise a kill. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Decide what to do about whatever already holds the port we are about to bind.
 *
 *  Pure (given its injected deps), because this is the safety-critical judgement in the
 *  module: `reclaim` KILLS a process. Two questions gate it, and BOTH must pass —
 *
 *  1. Is it this install's? (`repoRoot`.) Four clones share this machine; taking a port from
 *     one of them is the failure this repo already bans for `pkill` patterns, and being
 *     handed a pid by the process itself does not make it ours to kill.
 *  2. Is it UNOWNED? (`ppid`.) Same install is not enough: a second editor window of the same
 *     install is legitimately using its own dev server. Reclaim only a server whose editor is
 *     GONE (a leak), or one spawned by US (a child we lost track of — the #190 case).
 *
 *  Anything else is refused and reported, never taken. */
export function classifyPortHolder(
  probe: PortProbe,
  self: { repoRoot: string; pid: number },
  deps: { platform?: NodeJS.Platform; isAlive?: (pid: number) => boolean } = {},
): PortVerdict {
  const platform = deps.platform ?? process.platform;
  const isAlive = deps.isAlive ?? isProcessAlive;
  if (probe.state === 'empty') return { action: 'free' };
  if (probe.state === 'foreign') {
    return { action: 'refuse', why: 'a server that is not a Modoki dev server is already on this port' };
  }
  const { pid, ppid, projectRoot, repoRoot } = probe.identity;
  if (!samePath(repoRoot, self.repoRoot, platform)) {
    return {
      action: 'refuse',
      why: `another Modoki editor is already on this port (pid ${pid}, editor ${repoRoot}, project ${projectRoot}) — it belongs to a different install/clone, so it will not be taken`,
    };
  }
  // Our own child, whatever the bookkeeping says. This is the #190 stray: spawned by this very
  // process and then lost track of, so nothing else will ever clean it up.
  if (ppid !== self.pid && isAlive(ppid)) {
    return {
      action: 'refuse',
      why: `another editor of this install is running on this port (dev server pid ${pid}, its editor pid ${ppid}, project ${projectRoot}) — it is in use, so it will not be taken`,
    };
  }
  return { action: 'reclaim', pid, projectRoot };
}

/** Kill a stray dev server of OUR OWN install by pid, then wait for the port to go quiet.
 *  Returns false if it is still answering when the deadline passes — the caller must then
 *  fail loudly rather than spawn into a port it cannot have.
 *
 *  The pid is self-reported by the process we just talked to, so the reused-pid hazard that
 *  `needsWinTreeKill` guards against is bounded here by having verified, moments earlier,
 *  that this pid is a Modoki dev server serving our own editor tree. */
async function reclaimPort(url: string, pid: number, deadlineMs = 8000): Promise<boolean> {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', winKillTreeArgs(pid), { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch { /* already gone — still confirm the port below */ }
  const free = async () => (await probeDevServerPort(url, 500)).state === 'empty';
  const pollUntil = async (until: number): Promise<boolean> => {
    for (;;) {
      if (await free()) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  if (await pollUntil(Date.now() + deadlineMs)) return true;
  // posix got a polite SIGTERM and ignored it; escalate. Then KEEP POLLING rather than probing
  // once — a SIGKILLed process still takes a moment to be reaped and release its socket, and a
  // single probe that raced that teardown would report the port unreclaimable when another
  // 200ms would have had it, turning a recoverable state into "could not open the project".
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    return pollUntil(Date.now() + 2000);
  }
  return free();
}

/**
 * Take the conventional port back from a dev server this install LEAKED — one whose editor is
 * gone. Call it at startup, BEFORE the port is chosen (#190).
 *
 * Without this the leak is permanent and quietly expensive. `findFreePort` sees the squatter,
 * politely drifts the new editor onto an ephemeral port, and everything appears fine — while
 * the leaked server keeps running with its asset scanner WATCHING the repo, so it goes on
 * rewriting `.meta.json` sidecars under a project nobody has open (the write-behind-your-back
 * hazard #18 exists for), and the editor never sits on its conventional port again.
 *
 * Returns what it did, for the caller to log. Refuses in exactly the cases `classifyPortHolder`
 * refuses — another clone's server, or another live editor of this install.
 */
export async function reclaimLeakedDevServer(
  url: string,
  self: { repoRoot: string; pid: number },
): Promise<{ reclaimed: false } | { reclaimed: true; pid: number; projectRoot: string; freed: boolean }> {
  const verdict = classifyPortHolder(await probeDevServerPort(url), self);
  if (verdict.action !== 'reclaim') return { reclaimed: false };
  const freed = await reclaimPort(url, verdict.pid);
  return { reclaimed: true, pid: verdict.pid, projectRoot: verdict.projectRoot, freed };
}

/** What a child's `exit` event may do to the module-level state.
 *
 *  Pure so the ORDERING that caused #190 is testable without spawning Vite. `isCurrent` is
 *  the load-bearing input: a superseded child must never clear state that now describes its
 *  replacement. */
export function exitDisposition(
  opts: { intentional: boolean; isCurrent: boolean },
): { logUnexpected: boolean; clearState: boolean } {
  if (opts.intentional) return { logUnexpected: false, clearState: false };
  return { logUnexpected: true, clearState: opts.isCurrent };
}

/** Poll `url` until it answers (the dev server finished booting) or we time out.
 *  `abort()` lets the caller fail fast — e.g. the Vite child already exited (a
 *  --strictPort clash), so there's no point polling for the full timeout. (E7)
 *  Exported for tests: the #67 adoption guard below is otherwise only reachable by
 *  racing a real Vite spawn against a foreign server. */
export async function waitForServer(
  url: string,
  timeoutMs = 30000,
  abort?: () => boolean,
  expect?: { pid?: number },
): Promise<void> {
  const start = Date.now();
  let heldBy: DevServerIdentity | null = null;
  let answeredByStranger = false;
  for (;;) {
    if (abort?.()) throw new Error(`dev server process exited before becoming reachable at ${url} (port clash? — see the vite log)`);
    if (await reachable(url)) {
      // Re-check AFTER the probe, not just before it. `reachable` only proves that
      // SOMETHING answers on this port — and if our own Vite has exited in the
      // meantime (--strictPort clash), that something is ANOTHER server: a sibling
      // clone's dev server, or a stray `npm run dev`. Returning here would load the
      // renderer against a foreign project root, which surfaces much later as a
      // baffling "dev server can't serve code outside its allowed roots" for a path
      // that plainly exists. Fail loudly instead. (#67)
      if (abort?.()) {
        throw new Error(
          `something is answering at ${url}, but it is NOT our dev server — our Vite exited ` +
          `(port clash with another editor or clone? — see the vite log)`,
        );
      }
      if (!expect?.pid) return;
      // The abort check above is necessary but NOT sufficient, and #190 is the proof: it can
      // only catch a child that has ALREADY died, while a stale server answers in <50ms and a
      // fresh Vite takes ~2s to fail its bind. So it reported success against somebody else's
      // server on every project switch. Settle it by IDENTITY instead of by timing — keep
      // polling until the pid on the port is the pid we spawned.
      const probe = await probeDevServerPort(url);
      if (probe.state === 'modoki' && probe.identity.pid === expect.pid) return;
      heldBy = probe.state === 'modoki' ? probe.identity : null;
      // Remember that SOMETHING answered even when it would not identify itself. Without this
      // the timeout below reports "not reachable" — which flatly contradicts the `reachable`
      // check we just passed to get here, and points the reader at the wrong problem.
      answeredByStranger = probe.state !== 'modoki';
    }
    if (Date.now() - start > timeoutMs) {
      if (heldBy) {
        throw new Error(
          `${url} is still held by a DIFFERENT Modoki dev server after ${timeoutMs}ms ` +
          `(pid ${heldBy.pid}, project ${heldBy.projectRoot}) — ours never got the port, so the ` +
          `editor would have served that project's code and assets under the open project's name`,
        );
      }
      if (answeredByStranger) {
        throw new Error(
          `${url} is answering after ${timeoutMs}ms, but not as our dev server — something else ` +
          `holds the port (ours never bound it, or exited on --strictPort; see the vite log)`,
        );
      }
      throw new Error(`dev server not reachable at ${url} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The project the running dev server is rooted at (null if none). */
export function devServerRoot(): string | null {
  return currentRoot;
}

/**
 * Start (or restart) the Vite dev server rooted at `projectRoot`. Spawns the Vite
 * binary directly (not `npm run dev`) so SIGTERM reaches Vite, not an npm wrapper
 * that would orphan it. `--strictPort` makes a port clash fail loudly instead of
 * silently drifting to another port the renderer wouldn't be loaded from.
 */
export async function startDevServer(opts: { repoRoot: string; projectRoot: string; url: string }): Promise<void> {
  await stopDevServer();

  const { repoRoot, projectRoot, url } = opts;
  const port = new URL(url).port || '5173';
  // Spawn Vite's JS ENTRY with the Electron binary running as Node — NOT
  // node_modules/.bin/vite. electron-builder strips the .bin symlinks from the
  // packaged asarUnpack tree, so spawning .bin/vite → ENOENT in a dmg. vite/bin/
  // vite.js is a real file present in BOTH dev and packaged; process.execPath is
  // the node-capable binary in both (dev: the electron dev binary, packaged: the
  // app binary), and ELECTRON_RUN_AS_NODE=1 makes it behave as plain node.
  const viteEntry = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  // Cross-platform temp path — NEVER a hardcoded '/tmp' (absent on Windows, so
  // fs.openSync('/tmp/...') throws ENOENT synchronously, which the caller's open
  // flow turns into app.quit() → the packaged editor "crashes" on every Windows
  // launch). os.tmpdir() = /tmp on Unix, %LOCALAPPDATA%\Temp on Windows.
  // …and PER EDITOR, not one shared name. The temp dir is machine-wide, so a bare
  // `modoki-vite.log` is written by every clone's editor at once (opened 'a', so they
  // interleave rather than truncate) — and line ~595 below hands that path to whoever is
  // diagnosing a dead dev server, which is exactly when reading a sibling clone's output
  // costs the most. Key it on the pinned backend port, the same anchor the launcher's
  // editor log and the derived Vite/CDP ports use; fall back to the pid when the port is
  // auto-picked (MULTI mode), which is what the launcher does too.
  const logTag = process.env.MODOKI_BACKEND_PORT || String(process.pid);
  const logPath = process.env.MODOKI_VITE_LOG || path.join(os.tmpdir(), `modoki-vite-${logTag}.log`);

  // Nothing may be on this port before we spawn — `--strictPort` means a holder doesn't make
  // our Vite pick another port, it makes our Vite DIE, and the holder then keeps serving its
  // own project to our renderer. Two ways one gets there, and this covers both: a stray from a
  // previous launch that outlived its editor (a crash, or the state clobber this commit fixes),
  // and a sibling clone's server. Only the first is ours to take.
  const holder = await probeDevServerPort(url);
  const verdict = classifyPortHolder(holder, { repoRoot, pid: process.pid });
  if (verdict.action === 'refuse') {
    throw new Error(`cannot start the dev server on ${url}: ${verdict.why}`);
  }
  if (verdict.action === 'reclaim') {
    console.warn(
      `[modoki-electron] ${url} was held by a stray dev server of this editor ` +
      `(pid ${verdict.pid}, project ${verdict.projectRoot}) — reclaiming the port.`,
    );
    if (!await reclaimPort(url, verdict.pid)) {
      throw new Error(
        `cannot start the dev server on ${url}: a stray dev server of this editor (pid ${verdict.pid}) ` +
        `is still holding the port after being asked to stop — quit it and try again`,
      );
    }
  }

  const logFd = fs.openSync(logPath, 'a');

  // Pin Vite to 127.0.0.1 (NOT the default `localhost`, which Node resolves to
  // ::1/IPv6), so the interface we bind is the one the renderer loads and the one
  // findFreePort probed. Without this, two editors silently split across
  // 127.0.0.1:5173 / [::1]:5173 and load each other's project. findFreePort probes
  // every address a clash could hide behind (see PROBE_HOSTS), so it now also sees
  // a server bound to the wildcard — e.g. another CLONE's `vite --host 0.0.0.0`,
  // which used to read as "free" and cost us this whole class of bug. (#67)
  // `--configLoader runner` loads vite.config.ts via Vite's module runner (on the
  // fly, in memory) instead of the default `bundle` loader, which esbuild-bundles the
  // config and WRITES it to `<root>/node_modules/.vite-temp/…mjs`. Under a packaged
  // app installed to a read-only location (Windows `C:\Program Files\…`, where the
  // whole app.asar.unpacked tree is read-only), that mkdir throws EPERM and Vite dies
  // before the config even loads — the packaged editor never starts. Worse, Vite only
  // falls back for EACCES (Unix), not Windows EPERM, and its fallback target is still
  // inside the read-only tree. `runner` writes NOTHING into the app tree (optimizeDeps
  // cache is already redirected to a writable userData dir via MODOKI_VITE_CACHEDIR),
  // so the editor runs regardless of where it was installed. Same loader in dev +
  // packaged keeps the two identical.
  // Hold the child in a LOCAL too. Every use below must be about THIS child, not about
  // whatever the module-level `child` happens to be by the time an async event fires.
  const proc = spawn(process.execPath, [viteEntry, '--config', 'engine/vite.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, MODOKI_PROJECT: projectRoot, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', logFd, logFd],
  });
  child = proc;
  currentRoot = projectRoot;
  installExitHook();

  let earlyExit = false;
  proc.on('exit', (code) => {
    fs.close(logFd, () => {});
    earlyExit = true; // let THIS call's waitForServer fail fast instead of polling 30s
    const { logUnexpected, clearState } = exitDisposition({
      intentional: intentionallyStopped.has(proc),
      isCurrent: child === proc,
    });
    if (logUnexpected) console.error(`[modoki-electron] dev server exited unexpectedly (code ${code}) — see ${logPath}`);
    if (clearState) { child = null; currentRoot = null; }
  });

  await waitForServer(url, 30000, () => earlyExit, { pid: proc.pid });
  console.log(`[modoki-electron] dev server up at ${url} (project ${projectRoot})`);
}

/** Kill a child and WAIT for it to actually be gone — soft kill, then a force kill after
 *  `graceMs`, then a bounded wait for the `exit` event that the force kill provokes.
 *
 *  Pure (given its injected kills + timings), because the ORDERING is the whole point and the
 *  real path takes 3 seconds to reach its interesting branch — the same reason
 *  `exitDisposition` is pure. Returns which way it ended so the caller can say so.
 *
 *  The load-bearing rule, and the one #190 was about: **a kill returning is not a process
 *  being gone, and is certainly not its listening socket being released.** That is true of
 *  `taskkill` (which only INITIATES termination) and equally true of `SIGKILL`, which is
 *  uncatchable but still leaves the kernel a moment to reap the process and close its
 *  sockets. Resolving the instant a kill is *issued* is what let the caller respawn into a
 *  port the predecessor still held — and `--strictPort` turns that into a dead new server
 *  and a live stale one.
 *
 *  So the force-kill branch does NOT resolve immediately. It resolves on `exit`, and only
 *  gives up after `reapMs` — which is the difference between waiting ~1ms for the reap and
 *  handing the caller a port that is still occupied. 'abandoned' means we never saw the exit:
 *  the caller's pre-spawn probe is then the thing standing between it and #190 again. */
export function stopChild(
  // The narrowest thing this needs: a one-shot `exit` subscription. `Pick<ChildProcess,'once'>`
  // would drag in the full overload set (whose listener is `(code, signal) => void` returning
  // `this`), so every caller — including a test's fake — would have to satisfy an EventEmitter
  // it never uses. A real ChildProcess satisfies this as-is.
  c: { once(event: 'exit', listener: () => void): unknown },
  kill: { initial: () => void; force: () => void },
  timings: { graceMs?: number; reapMs?: number } = {},
): Promise<'exited' | 'abandoned'> {
  const graceMs = timings.graceMs ?? 3000;
  const reapMs = timings.reapMs ?? 1000;
  return new Promise((resolve) => {
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (how: 'exited' | 'abandoned') => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve(how);
    };
    c.once('exit', () => finish('exited'));
    kill.initial();
    timers.push(setTimeout(() => {
      try { kill.force(); } catch { /* already gone */ }
      // Keep waiting. This is the branch the pre-#190 code resolved from synchronously.
      timers.push(setTimeout(() => finish('abandoned'), reapMs));
    }, graceMs));
  });
}

/** Stop the owned dev server (SIGTERM, then SIGKILL after a grace period). */
export async function stopDevServer(): Promise<void> {
  const c = child;
  child = null;
  currentRoot = null;
  if (!c || c.killed) return;
  intentionallyStopped.add(c);
  if (c.exitCode !== null || c.signalCode !== null) return; // already reaped
  // Windows has no real SIGTERM — `kill('SIGTERM')` is already a hard TerminateProcess on the
  // Vite pid alone, so there is no graceful phase to wait out and nothing would reap the build
  // grandchildren. Go straight to the tree kill (#185). posix keeps the graceful path: SIGTERM
  // there runs Vite's handlers, which reap in-flight build children before it exits.
  const outcome = await stopChild(c, {
    initial: () => { if (!killTreeWin32(c)) c.kill('SIGTERM'); },
    force: () => killTree(c),
  });
  if (outcome === 'abandoned') {
    // Worth a line: the caller is about to respawn, and the port may still be held. It will be
    // refused by the pre-spawn probe rather than adopted, but this says WHY that happened.
    console.warn(
      `[modoki-electron] dev server (pid ${c.pid ?? '?'}) did not exit after being force-killed — ` +
      `its port may still be held`,
    );
  }
}
