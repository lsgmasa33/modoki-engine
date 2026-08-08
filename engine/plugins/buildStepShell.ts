/**
 * Cross-platform build-step execution (W-6). The `/api/build` pipeline authors each
 * step as a POSIX/bash one-liner; on macOS/Linux we run it through `bash -c`
 * (byte-identical to the original pipeline, so `$(…)`, `~`, gcloud/xcode bash steps
 * keep working). Windows has no `bash` by default, so there we run through the
 * platform shell (cmd.exe via ComSpec) — steps whose bash form isn't portable carry a
 * `winCmd` override, and env vars come via the spawn `env` (never an inline bash
 * `export …;` / `FOO=bar cmd` prefix, which is bash-only).
 *
 * ⚠️ The Windows command forms (`winCmd`) are UNVALIDATED against a real Windows shell —
 *    verify them on an actual Windows box (see the plan's Phase W checklist).
 *
 * This module is also the ONLY place that knows how a build child is torn down (#176).
 * Aborting a build means killing the whole process TREE, not the shell we spawned — see
 * `killBuildProcess` for why a plain `proc.kill()` silently orphans the real work.
 */
import { spawn, execFile } from 'child_process';

/** One build/scaffold step: a shell command run from `cwd`. `env` is merged over the
 *  shared build env (replaces bash `export`/`FOO=bar` prefixes). `winCmd` is a
 *  Windows-shell equivalent used when the bash `cmd` isn't portable (posix file-op
 *  builtins, the `android/gradlew` path, `open`). */
export interface BuildStep {
  label: string;
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
  winCmd?: string;
}

/** Spawn one build/scaffold command, cross-platform: `bash -c` on posix, the default
 *  shell (cmd.exe) on Windows. `platform` defaults to the running process; override it
 *  only in tests.
 *
 *  `detached: true` on posix puts the child in its OWN process group, so `killBuildProcess`
 *  can signal the group and reach the grandchildren a compound `bash -c` forks (#176). It is
 *  deliberately NOT set on Windows: there `detached` allocates a new CONSOLE, which a GUI
 *  Electron editor would flash on screen for every build step — and `taskkill /T` walks the
 *  tree by parent pid, so Windows needs no group to begin with.
 *
 *  We never `unref()` the child: stdio stays piped (the SSE log depends on it) and the step
 *  loop still awaits its `close`. Detaching changes WHO gets a signal, not the lifetime. */
export function spawnBuildCommand(
  cmd: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  platform: NodeJS.Platform = process.platform,
): ReturnType<typeof spawn> {
  const proc = platform === 'win32'
    ? spawn(cmd, { cwd: opts.cwd, env: opts.env, shell: true })
    : spawn('bash', ['-c', cmd], { cwd: opts.cwd, env: opts.env, detached: true });
  track(proc, platform);
  return proc;
}

/** The `taskkill` argv that kills pid AND its descendants on Windows. Pure + exported so
 *  the Windows form is unit-testable from a Mac (the same reason `winKillCommand` is).
 *
 *  `/T` is the whole point — it walks the tree, which is how Windows reaches what posix
 *  reaches with a process group. `/F` because there is no graceful equivalent anyway:
 *  Node's `proc.kill('SIGTERM')` on Windows is already a hard `TerminateProcess`, so this
 *  is not a loss of gentleness. Scoped BY PID — never `/IM`, the machine-wide image-name
 *  form that would reach another clone's build (see packagedAppPaths.test.ts). */
export function winKillTreeArgs(pid: number): string[] {
  return ['/T', '/F', '/PID', String(pid)];
}

/**
 * Abort one build child — the whole tree, not just the shell we spawned (#176).
 *
 * ⚠️ Why `proc.kill()` is not enough, measured rather than reasoned: `bash -c` EXEC-REPLACES
 * itself for a simple command (so `node build-web.mjs`, `xcodebuild`, `gradlew` are the
 * spawned pid and do get the signal) but FORKS for a compound one — and several real steps
 * are compound: the iOS `Installing on device...` (`APP_PATH=$(…) && { xcrun devicectl … }`),
 * icon generation (`mkdir && cp && … && printf`), and the web deploy's `for ext in …; do
 * gcloud storage objects update …; done`. Signalling the shell there kills the shell and
 * leaves `devicectl`/`gcloud` running, orphaned, holding no build slot — free to race the
 * retry that the freed slot immediately admits.
 *
 * posix: signal the process GROUP (`-pid`), which `spawnBuildCommand`'s `detached` created.
 * A group signal also reaches a tool's own workers (xcodebuild's clang/swift-frontend,
 * gradle's `--no-daemon` single-use JVM) without depending on that tool to forward it.
 * win32: `taskkill /T`, which walks the tree by parent pid instead.
 *
 * SIGTERM first, then SIGKILL to the group after `graceMs` if anything is still alive —
 * a build tool that ignores SIGTERM must not be able to outlive the build.
 */
export function killBuildProcess(
  proc: ReturnType<typeof spawn> | null | undefined,
  opts: { platform?: NodeJS.Platform; graceMs?: number } = {},
): void {
  const platform = opts.platform ?? process.platform;
  const graceMs = opts.graceMs ?? 5000;
  const pid = proc?.pid;
  // `exitCode === null && signalCode === null` ⇒ still running. Killing a REAPED pid is how
  // you shoot an unrelated process that inherited the number; killing a whole reaped GROUP
  // is that hazard multiplied, so this guard is load-bearing, not defensive noise.
  if (!proc || !pid || proc.exitCode !== null || proc.signalCode !== null) return;

  if (platform === 'win32') {
    execFile('taskkill', winKillTreeArgs(pid), () => { /* already gone / no such tree */ });
    return;
  }

  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      // ESRCH: the group is already gone, or was never formed (a `detached` spawn that
      // failed before exec). Fall back to the single pid so an abort still does SOMETHING.
      try { proc.kill(sig); } catch { /* gone */ }
      return false;
    }
  };
  if (!signalGroup('SIGTERM')) return;

  const escalate = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, graceMs);
  // Never hold the backend open just to escalate a kill.
  escalate.unref?.();
  proc.once('close', () => clearTimeout(escalate));
}

/* ── Backend shutdown: don't let detaching CREATE an orphan path ──────────────────────
 * Detaching is not free. A child in the terminal's foreground group used to receive the
 * Ctrl-C that stops `npm run dev`; in its own group it no longer does. So the backend
 * kills whatever it still owns on the way out, which turns detach from a regression into
 * a net win. (Same shape as devServer.ts's Vite reaper.)
 *
 * Bounded by what a dying process can run: a SIGKILL'd backend executes no hook and still
 * orphans. That is unchanged from before #176, not a new hole.
 */
const live = new Set<{ proc: ReturnType<typeof spawn>; platform: NodeJS.Platform }>();
let shutdownHookInstalled = false;

/** How long a shutdown waits for an in-flight build child to honour SIGTERM before the
 *  `exit` hook SIGKILLs it. Only paid when a build is actually running. */
const SHUTDOWN_GRACE_MS = 2000;

function track(proc: ReturnType<typeof spawn>, platform: NodeJS.Platform): void {
  const entry = { proc, platform };
  live.add(entry);
  proc.once('close', () => live.delete(entry));
  proc.once('error', () => live.delete(entry));
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  // `exit` handlers must be synchronous, so that path signals the group directly (SIGKILL,
  // no grace, no escalation timer that would never fire). The signal paths can afford the
  // ordinary graceful kill before re-raising.
  process.on('exit', () => {
    for (const e of live) {
      const p = e.proc.pid;
      if (!p || e.proc.exitCode !== null || e.proc.signalCode !== null) continue;
      if (e.platform === 'win32') continue; // no synchronous tree-kill on Windows
      try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ }
    }
  });
  // ⚠️ The delay is the point, and the first version of this did not have it: it SIGTERM'd with
  // `graceMs: 0` and called `process.exit` on the next line, so the `exit` hook's SIGKILL landed
  // in the SAME TICK as the SIGTERM. That is not "graceful then forceful", it is just forceful —
  // a gradle or xcodebuild killed mid-write leaves a lock file or a torn artifact for the next
  // build to trip over. So when something of ours is in flight, hold the exit open long enough
  // for the SIGTERM to be honoured; the `exit` SIGKILL stays as the backstop for whatever
  // ignores it. Nothing in flight ⇒ exit immediately, so an idle Ctrl-C is not slowed down.
  const onSignal = (code: number) => () => {
    const inFlight = live.size > 0;
    for (const e of live) killBuildProcess(e.proc, { platform: e.platform });
    if (!inFlight) { process.exit(code); return; }
    // `unref` so an otherwise-empty event loop still exits at once (the hook then SIGKILLs).
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref?.();
  };
  process.once('SIGINT', onSignal(130));
  process.once('SIGTERM', onSignal(143));
}

/** The command + env to actually run for a step on `platform` (picks `winCmd` on
 *  Windows when present; merges the step's `env` over the shared build env). Pure, so
 *  the platform branching is unit-testable from any host. */
export function resolveBuildStep(
  step: BuildStep,
  buildEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; env: NodeJS.ProcessEnv } {
  const cmd = platform === 'win32' && step.winCmd ? step.winCmd : step.cmd;
  const env = step.env ? { ...buildEnv, ...step.env } : buildEnv;
  return { cmd, env };
}
