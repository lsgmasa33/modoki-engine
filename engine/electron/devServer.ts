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
let intentionalStop = false;
let exitHookInstalled = false;

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

/** Poll `url` until it answers (the dev server finished booting) or we time out.
 *  `abort()` lets the caller fail fast — e.g. the Vite child already exited (a
 *  --strictPort clash), so there's no point polling for the full timeout. (E7)
 *  Exported for tests: the #67 adoption guard below is otherwise only reachable by
 *  racing a real Vite spawn against a foreign server. */
export async function waitForServer(url: string, timeoutMs = 30000, abort?: () => boolean): Promise<void> {
  const start = Date.now();
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
      return;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`dev server not reachable at ${url} within ${timeoutMs}ms`);
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
  const logPath = process.env.MODOKI_VITE_LOG || path.join(os.tmpdir(), 'modoki-vite.log');
  const logFd = fs.openSync(logPath, 'a');

  intentionalStop = false;
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
  child = spawn(process.execPath, [viteEntry, '--config', 'engine/vite.config.ts', '--configLoader', 'runner', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, MODOKI_PROJECT: projectRoot, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', logFd, logFd],
  });
  currentRoot = projectRoot;
  installExitHook();

  let earlyExit = false;
  child.on('exit', (code) => {
    fs.close(logFd, () => {});
    if (!intentionalStop) {
      earlyExit = true; // let waitForServer fail fast instead of polling 30s
      console.error(`[modoki-electron] dev server exited unexpectedly (code ${code}) — see ${logPath}`);
      child = null;
      currentRoot = null;
    }
  });

  await waitForServer(url, 30000, () => earlyExit);
  console.log(`[modoki-electron] dev server up at ${url} (project ${projectRoot})`);
}

/** Stop the owned dev server (SIGTERM, then SIGKILL after a grace period). */
export async function stopDevServer(): Promise<void> {
  const c = child;
  child = null;
  currentRoot = null;
  if (!c || c.killed) return;
  intentionalStop = true;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    c.once('exit', finish);
    // Windows has no real SIGTERM — `kill('SIGTERM')` is already a hard TerminateProcess on the
    // Vite pid alone, so there is no graceful phase to wait out and nothing would reap the build
    // grandchildren. Go straight to the tree kill (#185). posix keeps the graceful path: SIGTERM
    // there runs Vite's handlers, which reap in-flight build children before it exits.
    if (killTreeWin32(c)) { finish(); return; }
    c.kill('SIGTERM');
    setTimeout(() => { try { killTree(c); } catch { /* already gone */ } finish(); }, 3000);
  });
}
