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

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let child: ChildProcess | null = null;
let currentRoot: string | null = null;
let intentionalStop = false;
let exitHookInstalled = false;

/** Last-resort reaper: if main is SIGKILL'd / crashes / quits for an update,
 *  `before-quit` may not run and the spawned Vite child would orphan (holding its
 *  port). A synchronous process-exit hook force-kills it. Exit handlers must be
 *  synchronous, so we SIGKILL. Installed once, on first spawn. (E2) */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const kill = () => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } };
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
export function findFreePort(preferred?: number, allowFallback = true): Promise<number> {
  const probe = (p: number, fallback: boolean): Promise<number> =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', (err: NodeJS.ErrnoException) => {
        if (fallback && err.code === 'EADDRINUSE') resolve(probe(0, false));
        else reject(err);
      });
      srv.listen(p, '127.0.0.1', () => {
        const { port } = srv.address() as net.AddressInfo;
        srv.close(() => resolve(port));
      });
    });
  const want = preferred && preferred > 0 ? preferred : 0;
  return probe(want, allowFallback && want !== 0);
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
 *  --strictPort clash), so there's no point polling for the full timeout. (E7) */
async function waitForServer(url: string, timeoutMs = 30000, abort?: () => boolean): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (abort?.()) throw new Error(`dev server process exited before becoming reachable at ${url} (port clash? — see the vite log)`);
    if (await reachable(url)) return;
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
  // ::1/IPv6). findFreePort probes 127.0.0.1, so a second editor only detects a
  // 5173 clash — and the renderer only loads the right server — if Vite binds the
  // SAME IPv4 interface. Without this, two editors silently split across
  // 127.0.0.1:5173 / [::1]:5173 and load each other's project.
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
    c.kill('SIGTERM');
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* already gone */ } finish(); }, 3000);
  });
}
