/** #2033: no vitest test reaches the OS trash by accident. `moveToTrash` (`plugins/asset-fs-ops.ts`) hands a delete to
 *  Finder on darwin, to the Recycle Bin on win32 and to `trash-put` elsewhere, so a test that drives the backend's delete
 *  route without stubbing it sends its scratch files to the owner's real Trash, with the trash sound per delete. That
 *  happened through two fuzz files and `moveFileRouter.test.ts`; a per-file stub is a discipline nothing enforced.
 *
 *  So `tests/setup.ts` installs {@link installRealTrashGuard}: the BUILTIN `child_process.execFileSync` (the one call
 *  `moveToTrash` makes) is replaced on the module object vitest hands every module it transforms (not a native-ESM dependency, which no trash
 *  route is: `moveToTrash` is the only one, and vitest inlines it), so each sees it — a named or a default
 *  import, a jsdom file, and a file whose own `vi.mock('child_process', …)` spreads the original (a setup-file `vi.mock`
 *  reached none of those three; close-out review). A trash command is NOT run, it is recorded, and the setup's hooks fail
 *  the test (or the file) that made it. Not running it matters twice: nothing reaches the Trash, and Finder's own side
 *  effects stay out of the scratch tree (its `.DS_Store` failed fuzz steps as an outside write, and was the only way the
 *  fold oracle reached rule D). The throw itself cannot be the signal: on darwin `moveToTrash` reads a failed exec as a
 *  refusal and answers `failed`, so it would be swallowed.
 *
 *  The builtin outlives a test file in its worker, so the state lives on `globalThis` and the setup resets it per file.
 *  A test that MEANS to reach the real trash (the live win32 tests) calls {@link allowRealTrash} at its top level. The
 *  per-file `vi.mock('…/asset-fs-ops', …moveToTrash…)` stubs stay: they give the fuzz an `rmSync` that succeeds, which the
 *  guard's refusal would not. */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Is `command args` an OS trash delete, in any of the shapes `trashCommand` builds? */
export function isRealTrashCall(command: string, args: readonly string[]): boolean {
  const base = command.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '');
  if (base === 'osascript') return args.some((a) => /\btell application "Finder" to delete\b/.test(a));
  if (base === 'powershell' || base === 'pwsh') return args.some((a) => a.includes('SendToRecycleBin'));
  return base === 'trash-put';
}

const KEY = Symbol.for('modoki.realTrashGuard');
type GuardState = { reached: string[]; allowed: boolean };
const state = (): GuardState => ((globalThis as Record<symbol, GuardState>)[KEY] ??= { reached: [], allowed: false });

/** A new test file: nothing reached, nothing allowed (the setup calls it before the file's own code). */
export function resetRealTrashGuard(): void { const s = state(); s.reached.length = 0; s.allowed = false; takeRealGcloudCalls(); }

/** This test file reaches the real OS trash on purpose. */
export function allowRealTrash(): void { state().allowed = true; }

/** The trash commands blocked since the last call, emptied. */
export function takeRealTrashCalls(): string[] { return state().reached.splice(0); }

/** #2068: the gcloud binary `command args` would run and the argv it would get, when it is a REAL one, else null. A REAL
 *  gcloud is one outside the OS temp dir: a test's own fake lives in a scratch dir (`otaStatusRoute.test.ts`), and a
 *  gcloud on no directory of the PATH fails ENOENT, which reaches nothing. `toSpawn` hands `gcloud` over bare on POSIX
 *  (looked up on `env`'s PATH, where `withGcloudOnPath` put the resolver's dir FIRST — so a fake prepended to the test
 *  run's PATH is shadowed by Homebrew's), and as `gcloud.cmd` inside a caret-escaped `cmd.exe /c` line on Windows. */
export function realGcloudTarget(command: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): { bin: string; argv: string[] } | null {
  const base = command.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(exe|cmd)$/, '');
  let bin: string | null = null;
  let argv: string[] = [...args];
  if (base === 'gcloud') {
    if (/[\\/]/.test(command)) bin = command;
    else {
      const e = env ?? process.env;
      const pathVar = e.PATH ?? e.Path;
      // No PATH key at all: libuv searches its default (`/usr/bin:/bin` on POSIX), where ubuntu's gcloud lives.
      const dirs = pathVar === undefined ? (process.platform === 'win32' ? [] : ['/usr/bin', '/bin']) : pathVar.split(path.delimiter).filter(Boolean);
      const names = process.platform === 'win32' ? ['gcloud.cmd', 'gcloud.exe', 'gcloud'] : ['gcloud'];
      for (const d of dirs) { const hit = names.map((n) => path.join(d, n)).find((f) => fs.existsSync(f)); if (hit) { bin = hit; break; } }
    }
  } else if (base === 'cmd') {
    // One level of cmd.exe caret escaping undone (`^x` → `x`, so a literal `^` in a path survives as `^^` → `^`).
    const line = args.join(' ').replace(/\^(.)/g, '$1');
    const m = /"([^"]*gcloud\.cmd)"|([^\s"]*gcloud\.cmd)/i.exec(line);
    if (m) {
      bin = m[1] ?? m[2];
      // The gcloud args follow it, still escaped once more (`toSpawn` escapes an argument twice): recorded, not run.
      argv = line.slice(m.index + m[0].length).replace(/[\^"]/g, '').split(/\s+/).filter(Boolean);
    }
  }
  if (!bin || !fs.existsSync(bin)) return null;
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const rel = path.relative(real(os.tmpdir()), real(bin));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? null : { bin, argv };
}

const GCLOUD_KEY = Symbol.for('modoki.realGcloudGuard');
/** The real gcloud calls blocked since the last call, emptied. The setup resets it per file with the trash list. */
export function takeRealGcloudCalls(): string[] {
  return ((globalThis as Record<symbol, string[]>)[GCLOUD_KEY] ??= []).splice(0);
}

type Exec = ((...a: unknown[]) => unknown) & { [KEY]?: true };

/** Replaces the builtin `child_process.execFileSync` with one refusing a trash command (unless {@link allowRealTrash});
 *  anything else runs as before. Once per worker. */
export function installRealTrashGuard(): void {
  const req = createRequire(import.meta.url);
  const cp = req('node:child_process') as { execFileSync: Exec; spawn: Exec };
  if (cp.execFileSync[KEY]) return;
  const actual = cp.execFileSync;
  const guarded: Exec = function (this: unknown, ...a: unknown[]) {
    const [command, args] = a;
    const argv = Array.isArray(args) ? (args as string[]) : [];
    if (typeof command === 'string' && !state().allowed && isRealTrashCall(command, argv)) {
      state().reached.push(`${command} ${argv.filter((x) => x.startsWith('/') || /^[A-Za-z]:\\/.test(x)).join(' ')}`.trim());
      throw new Error('realTrashGuard (#2033): a test reached the OS trash; stub moveToTrash (see tests/realTrashGuard.ts)');
    }
    refuseRealGcloud(a);
    return actual.apply(this, a);
  };
  guarded[KEY] = true;
  cp.execFileSync = guarded;
  // `spawn` too: the build steps run gcloud through it (`spawnBuildStep` — the web deploy's `storage rsync
  // --delete-unmatched-destination-objects`, the CDN steps). Nothing else is checked there.
  const actualSpawn = cp.spawn;
  const guardedSpawn: Exec = function (this: unknown, ...a: unknown[]) { refuseRealGcloud(a); return actualSpawn.apply(this, a); };
  guardedSpawn[KEY] = true;
  cp.spawn = guardedSpawn;
}

/** #2068: a real gcloud runs under this machine's own credentials, against whatever bucket the fixture names. Blocked
 *  and recorded; the setup fails the test, since a route may read the throw as a non-fatal gcloud failure. */
function refuseRealGcloud(a: unknown[]): void {
  const [command, args, opts] = a;
  if (typeof command !== 'string') return;
  const argv = Array.isArray(args) ? (args as string[]) : [];
  const env = (Array.isArray(args) ? opts : args) as { env?: NodeJS.ProcessEnv } | undefined;
  const gcloud = realGcloudTarget(command, argv, env?.env);
  if (!gcloud) return;
  ((globalThis as Record<symbol, string[]>)[GCLOUD_KEY] ??= []).push(`${gcloud.bin} ${gcloud.argv.slice(0, 3).join(' ')}`);
  throw new Error('realGcloudGuard (#2068): a test reached a real gcloud; stub execGcloudSync / spawnBuildStep, or point sdk.gcloudPath at a fake in a scratch dir');
}
