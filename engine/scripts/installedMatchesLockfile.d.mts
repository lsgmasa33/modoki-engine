/** Type sidecar for `installedMatchesLockfile.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (imported by `build-electron.mjs`, a Node script),
 *  while `tests/electron/installedMatchesLockfile.test.ts` imports it and IS typechecked. */

/** Why `dir`'s `node_modules` no longer matches its `package-lock.json` — empty when it does.
 *  Never throws: an unreadable package.json or lockfile is itself a reason. Capped at a few. */
export declare function staleAgainstLockfile(dir: string): string[];

/** Run `io.install` when `dir` is stale, then throw if npm left it stale (#685's state, which npm
 *  reports as "up to date"). Returns why it installed — empty when it was already current. */
export declare function ensureInstalledMatchesLockfile(
  dir: string,
  label: string,
  io: { install: () => void; log: (message: string) => void },
): string[];
