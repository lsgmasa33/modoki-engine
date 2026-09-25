/**
 * The ONE way to spawn a resolved command with arguments that may hold variable data (#1537).
 *
 * Why this exists: a Windows `.cmd`/`.bat` cannot be spawned without a shell (`spawn EINVAL` since
 * CVE-2024-27980), and `shell:true` makes Node CONCATENATE argv into one string that cmd.exe then
 * parses. cmd expands `%VAR%` even INSIDE double quotes, and an unquoted `&`/`|` starts a second
 * command, so a project, asset or folder name like `My%OS%Game` or `A&B` changed the command that
 * ran (observed on the win clone: `%OS%` arrived as `Windows_NT` through the old quote-only helper).
 * Quoting cannot fix `%` — there is no escape for it inside quotes — so the args are `^`-escaped
 * OUTSIDE quotes instead, and cmd is spawned directly with the finished line verbatim.
 *
 * Everything that is not a Windows batch file spawns with no shell at all, argv untouched.
 *
 * ⚠️ `cross-spawn` does the same thing and was rejected after probing (#1537): it merges an arg
 * ending in `\` into the next one, its `^%` trick fails when a variable named `OS^` exists, and it
 * double-escapes only shims under `node_modules/.bin` (not `gcloud.cmd`/`gradlew.bat`/`sdkmanager.bat`).
 *
 * Pure and platform-injectable, so the command line is unit-testable from any host; the round trip
 * through a real cmd.exe is `engine/tests/plugins/winSpawn.test.ts` (win32 only).
 */

import fs from 'node:fs';
import path from 'node:path';

/** A Windows batch file: the only thing that needs cmd.exe to run it. */
export function needsWinShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/** Resolve a BARE binary name to an absolute path the way a shell would, or null if it isn't on PATH.
 *
 *  This exists because `execFile`/`spawn` WITHOUT a shell do no PATHEXT resolution on Windows: the OS
 *  looks for a file named exactly `npm`, and npm ships `npm.cmd` / `npm.ps1` / a `npm` bash script.
 *  So probing a PATH tool by bare name threw ENOENT and the Build-Support dialog reported a perfectly
 *  installed npm (and toktx, gltfpack, …) as "not found" even with "Use system-installed SDKs" ON.
 *  Resolving here also gives every PATH-found tool an absolute `path`/`dir`, which is what
 *  `withToolOnPath` and the spawn sites need. (Moved here from engine/toolchain in #1537 so `toSpawn`
 *  — and the plain scripts — can resolve a bare name without a shell; the toolchain re-exports it.)
 *
 *  Windows tries only the PATHEXT extensions (never the extension-less file — that's the bash shim,
 *  which Windows cannot run); POSIX requires the execute bit. Pure/injectable for host-agnostic tests. */
export function whichSync(bin, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  // PATHEXT is conventionally UPPER-CASE (".COM;.EXE;…"); lower-case it so a resolved path reads
  // `npm.cmd`, not `npm.CMD`, in the Build-Support UI and logs. Windows paths are case-insensitive,
  // so this never changes what resolves.
  const exts = win
    ? (opts.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  const runnable = (p) => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      if (!win) fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const dir of pathEnv.split(win ? ';' : ':')) {
    if (!dir) continue;
    // Strip the quotes Windows PATH entries sometimes carry ("C:\Program Files\x";…).
    const base = path.join(dir.replace(/^"|"$/g, ''), bin);
    for (const ext of exts) {
      const cand = base + ext;
      if (runnable(cand)) return cand;
    }
  }
  return null;
}

/** The PATH a child will search, read case-insensitively on win32 (`Path` is what a real Windows
 *  environment carries). An exact `PATH` wins — it is what a caller prepends to. */
function pathOf(env, platform) {
  if (platform !== 'win32' || env.PATH !== undefined) return env.PATH ?? '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] ?? '' : '';
}

/** Every character cmd.exe treats specially outside quotes. `%` is the reason this file exists;
 *  the rest are the separators and operators a `^` neutralises. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** CommandLineToArgvW/MSVCRT quoting: the program (node, java, …) splits its command line back into
 *  argv with these rules, so this is what makes the arg arrive byte-exact. Backslashes are literal
 *  except in a run that ends at a `"` (or at the closing quote), where they double. */
function quoteArg(arg) {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

function caretEscape(s, times) {
  for (let i = 0; i < times; i++) s = s.replace(CMD_META, '^$1');
  return s;
}

/**
 * The command line cmd.exe must receive to run `command` with exactly `args`.
 *
 * The ARGS are escaped TWICE because they are parsed twice: once by the `cmd /c` line, and again
 * when the batch file expands `%*` into its own command (the npm cmd-shim, gradlew.bat and
 * sdkmanager.bat all forward `%*` exactly once). The COMMAND is parsed once — the batch reads its
 * own path through `%~dp0`, whose expansion cmd does not re-scan.
 *
 * ⚠️ Residuals, documented in docs/windows.md:
 *  - A batch that forwards `%*` WHILE delayed expansion is on expands `!VAR!` in the args and drops a
 *    lone `!` (measured with a synthetic batch; `&`, `%`, `^`, `"` still arrive exact). Escaping `!`
 *    for it would leave a stray `^` in every arg of an ordinary batch. No batch the engine runs does
 *    this — gcloud.cmd turns it back OFF before its `%*` line.
 *  - A batch that reads `%1` directly instead of forwarding `%*` sees the caret-escaped token.
 *  - A batch that re-parses `%*` a second time (`set X=%*` then `%X%`) undoes one escape.
 *  - An environment variable whose name is literally a token followed by carets could still match.
 *  None exists in anything the engine runs.
 */
export function winBatchCommandLine(command, args) {
  return [caretEscape(quoteArg(command), 1), ...args.map((a) => caretEscape(quoteArg(a), 2))].join(' ');
}

/**
 * `command` + `args` → what to hand `spawn`/`spawnSync`/`execFile`/`execFileSync`:
 *
 *   const s = toSpawn(cmd, args);
 *   spawn(s.command, s.args, { ...s.options, cwd, env });
 *
 * `options` always carries `shell: false` — callers spread it and never pass `shell` themselves
 * (guarded by engine/tests/architecture/noShellSpawn.test.ts).
 *
 * On win32 a BARE name (`npm`, `npx`, `gcloud`) is first resolved on `env`'s PATH — the lookup a
 * shell used to do — so it lands on `npm.cmd` and takes the batch route. Pass the child's `env` when
 * it differs from this process's (a prepended tool dir); an unresolvable name is spawned as given
 * and fails as a plain ENOENT naming it.
 *
 * `opts.platform`/`opts.comspec` exist for host-agnostic tests only.
 */
export function toSpawn(command, args = [], opts = {}) {
  const platform = opts.platform ?? process.platform;
  const comspec = opts.comspec ?? (process.env.ComSpec || 'cmd.exe');
  if (platform === 'win32' && !/[\\/]/.test(command)) {
    command = whichSync(command, { platform, pathEnv: pathOf(opts.env ?? process.env, platform) }) ?? command;
  }
  if (!needsWinShell(command, platform)) return { command, args, options: { shell: false } };
  // /d: skip AutoRun (a user's registry AutoRun would run first); /v:off: no `!VAR!` delayed
  // expansion; /s /c "<line>": strip exactly the outer quotes and run the rest verbatim.
  return {
    command: comspec,
    args: ['/d', '/v:off', '/s', '/c', `"${winBatchCommandLine(command, args)}"`],
    options: { shell: false, windowsVerbatimArguments: true },
  };
}
