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
export function resetRealTrashGuard(): void { const s = state(); s.reached.length = 0; s.allowed = false; }

/** This test file reaches the real OS trash on purpose. */
export function allowRealTrash(): void { state().allowed = true; }

/** The trash commands blocked since the last call, emptied. */
export function takeRealTrashCalls(): string[] { return state().reached.splice(0); }

type Exec = ((...a: unknown[]) => unknown) & { [KEY]?: true };

/** Replaces the builtin `child_process.execFileSync` with one refusing a trash command (unless {@link allowRealTrash});
 *  anything else runs as before. Once per worker. */
export function installRealTrashGuard(): void {
  const req = createRequire(import.meta.url);
  const cp = req('node:child_process') as { execFileSync: Exec };
  if (cp.execFileSync[KEY]) return;
  const actual = cp.execFileSync;
  const guarded: Exec = function (this: unknown, ...a: unknown[]) {
    const [command, args] = a;
    const argv = Array.isArray(args) ? (args as string[]) : [];
    if (typeof command === 'string' && !state().allowed && isRealTrashCall(command, argv)) {
      state().reached.push(`${command} ${argv.filter((x) => x.startsWith('/') || /^[A-Za-z]:\\/.test(x)).join(' ')}`.trim());
      throw new Error('realTrashGuard (#2033): a test reached the OS trash; stub moveToTrash (see tests/realTrashGuard.ts)');
    }
    return actual.apply(this, a);
  };
  guarded[KEY] = true;
  cp.execFileSync = guarded;
}
