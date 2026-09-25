/**
 * Cross-platform build-step execution (W-6, #1537). A step is one of three kinds:
 *
 * - **`exec`** — a program and its argv, spawned with NO shell. Almost every step is this. Paths,
 *   project names and config strings travel as argv, so no shell ever parses them: on Windows a
 *   `.cmd`/`.bat` (gradlew.bat, npx.cmd, gcloud.cmd) goes through `toSpawn`'s escaped cmd.exe line.
 * - **`shell`** — the few steps that are genuinely compound (`$(…)`, `&&`, `||`). The script text is
 *   built ONLY by the `sh` tagged template, whose slots accept a `ShellRef`, never a raw string: the
 *   ref's value rides in the child's ENV and the text holds a quoted `"$NAME"` / `"%NAME%"`
 *   reference. Posix runs it through `bash -c`, Windows through cmd.exe.
 * - **`inproc`** — work done in this process (a reveal in Explorer/Finder, a directory clear).
 *
 * Why (#1537): steps used to be one command STRING with paths interpolated, run through `bash -c`
 * or `shell:true`. cmd expands `%VAR%` even inside quotes and bash evaluates `$(…)` inside double
 * quotes, so a folder named `My%OS%Game` or `a$(x)b` changed the command that ran. Variable data
 * never appears in shell text now — the `sh` slot type makes the old shape a TYPE error.
 *
 * The one exception is `authoredShell` — a project author's own custom deploy command, which is
 * shell text by definition and runs as written (owner ruling on #1537).
 *
 * This module is also the ONLY place that knows how a build child is torn down (#176).
 * Aborting a build means killing the whole process TREE, not the shell we spawned — see
 * `killBuildProcess` for why a plain `proc.kill()` silently orphans the real work.
 */
import { spawn, execFile, execFileSync } from 'child_process';
import { toSpawn } from '../scripts/winSpawn.mjs';

/** A value a `shell` step's script refers to. Only `ref()` makes one, so a raw string cannot be
 *  interpolated into `sh` — the brand is what the type check keys on. */
declare const shellRefBrand: unique symbol;
export interface ShellRef { readonly [shellRefBrand]: true; readonly envName: string; readonly value: string }

/** Shell text plus the env its refs read from. Built by `sh` (or `authoredShell`), never by hand. */
export interface ShellScript { readonly posix: string; readonly win: string; readonly env: Readonly<Record<string, string>> }

/** `name` becomes the env var `MODOKI_ARG_<name>`; the script refers to it, quoted, wherever the
 *  ref is interpolated. `name` is an identifier because it is spliced into the script text. */
export function ref(name: string, value: string): ShellRef {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`shell ref name must be UPPER_SNAKE: ${JSON.stringify(name)}`);
  return { envName: `MODOKI_ARG_${name}`, value } as ShellRef;
}

function isShellScript(x: ShellRef | ShellScript): x is ShellScript {
  return typeof (x as ShellScript).posix === 'string';
}

/** The ONLY way to write a `shell` step's script. Each slot is a `ShellRef` (rendered as a quoted
 *  env reference) or a nested `ShellScript` fragment (its text spliced, its env merged). A raw
 *  string in a slot does not typecheck — that is the whole guard. */
export function sh(parts: TemplateStringsArray, ...slots: (ShellRef | ShellScript)[]): ShellScript {
  let posix = parts[0];
  let win = parts[0];
  const env: Record<string, string> = {};
  const bind = (name: string, value: string) => {
    if (name in env && env[name] !== value) throw new Error(`shell ref ${name} bound to two different values`);
    env[name] = value;
  };
  slots.forEach((slot, i) => {
    if (isShellScript(slot)) {
      posix += slot.posix;
      win += slot.win;
      for (const [k, v] of Object.entries(slot.env)) bind(k, v);
    } else {
      // Quoted: bash word-splits and globs an unquoted "$X"; cmd runs an unquoted %X% holding `&`.
      // Neither re-scans the expanded value, so a `$(…)` or `%OS%` inside it stays literal.
      posix += `"$${slot.envName}"`;
      win += `"%${slot.envName}%"`;
      bind(slot.envName, slot.value);
    }
    posix += parts[i + 1];
    win += parts[i + 1];
  });
  return { posix, win, env };
}

/** A project author's own shell text (the custom web deploy command), run exactly as written on
 *  both platforms. The ONE sanctioned way to put non-`sh` text in a shell step — do not reach for
 *  it for engine-authored steps. */
export function authoredShell(text: string): ShellScript {
  return { posix: text, win: text, env: {} };
}

interface StepCommon {
  label: string;
  /** Evaluated when the step is reached, not when the plan is made — e.g. "does dist/ hold a .glb"
   *  after the build that produces dist/ has run. False skips the step. */
  when?: () => boolean;
}

/** A program + argv, spawned with no shell. `winCommand` replaces `command` on win32 (gradlew →
 *  gradlew.bat); a BARE name there is resolved on the step env's PATH by toSpawn, since no shell will. */
export interface ExecStep extends StepCommon {
  kind: 'exec';
  command: string;
  args: string[];
  winCommand?: string;
  cwd: string;
  env?: Record<string, string>;
}

/** A compound command. See the module header — build `script` with `sh`. */
export interface ShellStep extends StepCommon {
  kind: 'shell';
  script: ShellScript;
  cwd: string;
  env?: Record<string, string>;
}

/** Work done in this process. `log` streams to the same place a child's output would. */
export interface InprocStep extends StepCommon {
  kind: 'inproc';
  run: (log: (line: string) => void) => void | Promise<void>;
}

export type BuildStep = ExecStep | ShellStep | InprocStep;
export type SpawnedStep = ExecStep | ShellStep;

/** Shorthand for the common case. */
export function execStep(label: string, cwd: string, command: string, args: string[], extra: Pick<ExecStep, 'env' | 'winCommand' | 'when'> = {}): ExecStep {
  return { kind: 'exec', label, cwd, command, args, ...extra };
}

/** What `spawnBuildStep` will actually spawn — pure, so the platform branching is unit-testable from
 *  any host. `env` is the full child env (the shared build env, the step's own, and a script's refs). */
export function planBuildStep(
  step: SpawnedStep,
  buildEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; options: { shell: false; windowsVerbatimArguments?: true }; env: NodeJS.ProcessEnv } {
  if (step.kind === 'exec') {
    const env = step.env ? { ...buildEnv, ...step.env } : buildEnv;
    const command = platform === 'win32' && step.winCommand ? step.winCommand : step.command;
    // No shell does the PATHEXT lookup any more: toSpawn resolves a bare `npx` to `npx.cmd` on the
    // CHILD's PATH (the step may prepend a tool dir), not this process's.
    return { ...toSpawn(command, step.args, { platform, env }), env };
  }
  const env = { ...buildEnv, ...step.env, ...step.script.env };
  if (platform === 'win32') {
    // ⚠️ A ref is safe in cmd ONLY without a `"`: `"%X%"` expands to the value between those
    // quotes, and a `"` inside it closes them, making the rest of the value — `&` included — live
    // command text (observed on the win clone: `x"&echo INJ&"y` ran `echo INJ`). Refused loudly
    // rather than quoted around, because cmd has no escape for a quote inside a quoted string.
    // A Windows path cannot contain `"`, and no engine-authored shell step runs on win32 today.
    for (const [name, value] of Object.entries(step.script.env)) {
      if (value.includes('"')) throw new Error(`build step "${step.label}": ${name} holds a double quote, which cmd.exe cannot carry safely`);
    }
    // cmd.exe run directly (the same thing `shell:true` does, minus Node's concatenation): /d skips
    // AutoRun, /v:off pins delayed expansion OFF (a registry `DelayedExpansion=1` would otherwise
    // re-expand `!X!` inside a ref's value), /s /c strips exactly the outer quotes. `%X%` refs expand
    // once, quoted; the expanded value is not re-scanned for `%`.
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `"${step.script.win}"`],
      options: { shell: false, windowsVerbatimArguments: true },
      env,
    };
  }
  return { command: 'bash', args: ['-c', step.script.posix], options: { shell: false }, env };
}

/** Spawn one build/scaffold step. `platform` defaults to the running process; override it only in
 *  tests.
 *
 *  `detached: true` on posix puts the child in its OWN process group, so `killBuildProcess`
 *  can signal the group and reach the grandchildren a compound `bash -c` forks (#176). It is
 *  deliberately NOT set on Windows: there `detached` allocates a new CONSOLE, which a GUI
 *  Electron editor would flash on screen for every build step — and `taskkill /T` walks the
 *  tree by parent pid, so Windows needs no group to begin with.
 *
 *  We never `unref()` the child: stdio stays piped (the SSE log depends on it) and the step
 *  loop still awaits its `close`. Detaching changes WHO gets a signal, not the lifetime. */
export function spawnBuildStep(
  step: SpawnedStep,
  buildEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ReturnType<typeof spawn> {
  const plan = planBuildStep(step, buildEnv, platform);
  const proc = spawn(plan.command, plan.args, {
    ...plan.options, cwd: step.cwd, env: plan.env, ...(platform === 'win32' ? {} : { detached: true }),
  });
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
 * gcloud storage objects update …; done` (the last two are exec steps since #1537; a `shell` step
 * still forks). Signalling the shell there kills the shell and leaves `devicectl`/`gcloud` running, orphaned, holding no build slot — free to race the
 * retry that the freed slot immediately admits.
 *
 * posix: signal the process GROUP (`-pid`), which `spawnBuildStep`'s `detached` created.
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

/**
 * The synchronous twin of `killBuildProcess`, for the `exit` hook — which cannot await anything,
 * so it cannot use the async `execFile`/escalation path.
 *
 * ⚠️ The win32 branch here used to be a bare `continue`, commented "no synchronous tree-kill on
 * Windows". That was wrong twice over. `execFileSync('taskkill', …)` is perfectly usable inside an
 * `exit` handler; and the gap it left was not theoretical — **measured (#185): two real
 * `gradlew … --no-daemon` JVMs outlived their hard-killed parent by 60s+ with nothing reaping
 * them, while `taskkill /T` cleared the same tree in 1s.**
 *
 * Why that hid for so long: every OTHER build step here is a `node` process writing to the stdout
 * pipe it inherited for the SSE log, and node exits when that pipe breaks. So a web/playable build
 * LOOKED like it came down cleanly on shutdown. It was the tool dying of EPIPE, not the shutdown
 * path doing its job — a JVM's `PrintStream` swallows the failed write and keeps running. Measured
 * both cells: node+piped+writing dies in 718ms; `ping`+piped survives indefinitely.
 *
 * Cost: `execFileSync` blocks the exit for as long as `taskkill` takes (~100ms), and only when a
 * build is actually in flight. That is the right trade against leaking a gradle JVM.
 */
export function killBuildProcessSync(
  proc: ReturnType<typeof spawn> | null | undefined,
  opts: { platform?: NodeJS.Platform } = {},
): void {
  const platform = opts.platform ?? process.platform;
  const pid = proc?.pid;
  // Same reaped-pid guard as `killBuildProcess`, for the same reason: killing a REAPED pid shoots
  // whatever unrelated process inherited the number, and killing a reaped GROUP/TREE multiplies it.
  if (!proc || !pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (platform === 'win32') {
    try { execFileSync('taskkill', winKillTreeArgs(pid), { stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
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
  // `exit` handlers must be synchronous, so this path kills outright (SIGKILL / `taskkill /T`,
  // no grace, no escalation timer that would never fire) via `killBuildProcessSync`. The signal
  // paths can afford the ordinary graceful kill before re-raising.
  process.on('exit', () => {
    for (const e of live) killBuildProcessSync(e.proc, { platform: e.platform });
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
