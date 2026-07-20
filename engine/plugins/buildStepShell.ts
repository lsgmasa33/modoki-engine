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
 */
import { spawn } from 'child_process';

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
 *  only in tests. */
export function spawnBuildCommand(
  cmd: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  platform: NodeJS.Platform = process.platform,
): ReturnType<typeof spawn> {
  return platform === 'win32'
    ? spawn(cmd, { cwd: opts.cwd, env: opts.env, shell: true })
    : spawn('bash', ['-c', cmd], { cwd: opts.cwd, env: opts.env });
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
