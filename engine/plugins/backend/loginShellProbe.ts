/** Ask the user's LOGIN shell where a command lives (macOS/Linux). A Finder-launched packaged
 *  editor inherits a minimal PATH that omits ~/.local/bin, /opt/homebrew/bin, npm-global, the
 *  Cloud SDK…, so a real install looks absent until the user's profile has run. Shared by the
 *  `claude` probe (electron/connectClaude.ts) and the `gcloud` probe (./gcloud.ts). Rules:
 *  docs/connect-claude-code.md § detectClaudeCli. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

/** `timedOut` means UNKNOWN, not absent: the probe was killed at its bound before it answered. */
export interface LoginShellAnswer { path: string | null; timedOut: boolean }

/** Did spawnSync KILL the child at its timeout? ETIMEDOUT alone is not enough. A process that had
 *  already exited still reports ETIMEDOUT when a grandchild held its pipe past the bound (#1449),
 *  and then its own exit status is the answer. */
export function spawnTimedOut(r: { error?: Error; status: number | null }): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' && r.status === null;
}

/** `command -v <name>` in `env.SHELL -lic`. The user's profile runs inside this probe, so two
 *  things a timeout relies on are not ours to assume (#1449, both observed on macOS):
 *  - an interactive zsh/bash IGNORES SIGTERM — a `sleep 10` profile held spawnSync for 10s
 *    against a 4s bound. SIGKILL cannot be ignored.
 *  - anything the profile backgrounds inherits stdout, so a pipe would not reach EOF until the
 *    timeout: a ~10ms miss cost the full 4s and read as timed out. The answer goes to a file
 *    instead, and with no pipes spawnSync waits only for the shell itself.
 *  - `detached` puts the shell in its OWN session. An interactive zsh launched from a terminal
 *    otherwise takes the terminal's foreground and hands it back only on a normal exit, so a
 *    SIGKILLed one left the editor's terminal pointing at a dead process group (^C stopped
 *    reaching the dev server). The own group is also what lets a timeout kill whatever the
 *    profile left in it: its foreground child, and its `&` jobs (with no tty there is no job
 *    control, so they share the group). True daemons setsid themselves and survive; a bash
 *    profile that runs `set -m` gives its children their own groups, which escape.
 *  The name travels in the env, never in the command string, so it is not shell-parsed. */
export function loginShellCommandPath(name: string, env: NodeJS.ProcessEnv, timeoutMs: number): LoginShellAnswer {
  if (process.platform === 'win32') return { path: null, timedOut: false };
  const shell = env.SHELL || '/bin/zsh';
  let dir: string | null = null;
  let spawned = false;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-shell-probe-'));
    const out = path.join(dir, 'path');
    spawned = true;
    // `detached` is missing from @types/node's SpawnSyncOptions, but spawnSync normalizes it the
    // same way spawn does and libuv applies it (observed: the shell gets its own pgid/sid). The
    // orphan test in connectClaudeProbeTimeout.test.ts goes red without it.
    const opts: SpawnSyncOptions & { detached: boolean } = {
      env: { ...env, MODOKI_PROBE_NAME: name, MODOKI_PROBE_OUT: out },
      stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL', detached: true,
    };
    const r = spawnSync(shell, ['-lic', 'command -v "$MODOKI_PROBE_NAME" > "$MODOKI_PROBE_OUT"'], opts);
    if (spawnTimedOut(r) && r.pid > 1) { // never kill(-1)/kill(-0): those reach far more than the probe
      try { process.kill(-r.pid, 'SIGKILL'); } catch { /* ESRCH: the group is already gone */ }
    }
    if (r.status === 0) {
      // Last line, absolute only: `command -v` prints an alias or function DEFINITION for those.
      const p = fs.readFileSync(out, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
      if (p && p.startsWith('/')) return { path: p, timedOut: false };
    }
    return { path: null, timedOut: spawnTimedOut(r) };
  } catch { /* ignore */ } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // A throw before the shell ran (an unwritable tmpdir) never asked the question: unknown, not
  // absent, so the panel does not tell a user who has the tool to install it.
  return { path: null, timedOut: !spawned };
}
