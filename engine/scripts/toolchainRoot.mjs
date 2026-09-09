/**
 * Is a directory safe to recursively delete AS A TOOLCHAIN ROOT? (#1005)
 *
 * Shared by the repo's TWO destructive toolchain sites so they refuse alike — `uninstallAll()` in
 * `engine/toolchain/index.ts` (Build Support's "Remove all tools", one click) and
 * `clean-packaged-cache.mjs --toolchain`. Lives here rather than in `toolchain/index.ts` because
 * the cache cleaner is plain-node `.mjs` and cannot import a `.ts`; the dependency already runs
 * this way (`index.ts` imports `deleteBoundary.mjs` and `pathIdentity.mjs`).
 *
 * ⚠️ **This asks about CONTENTS, and the property matters.** The guard it replaces was
 * `path.basename(dir) !== 'toolchain'` — a question about the NAME — and it was wrong in BOTH
 * directions: it rejected every legitimate `MODOKI_TOOLCHAIN_DIR` whose basename differs (measured
 * on the `win` clone, whose override is named `modoki-toolchain`, so "Remove all tools" could not
 * work there at all), and it ACCEPTED any unrelated directory that happened to be named
 * `toolchain`.
 *
 * ⚠️ **Do NOT "fix" this by comparing against `process.env.MODOKI_TOOLCHAIN_DIR`.** That is the
 * obvious replacement and it is VACUOUS: `uninstallAll`'s only production caller (the
 * `/api/toolchain/uninstall` route) passes `process.env.MODOKI_TOOLCHAIN_DIR` as the argument, so
 * such a check compares the value with itself and can never fail. A guard that cannot fire is worse
 * than the wrong guard it replaced, because it reads as protection.
 *
 * ⚠️ **This is the LAST line of defence, not the only one, and it is deliberately narrow.**
 * `findDeleteBoundaries` (deleteBoundary.mjs) already refuses a link at the root, a link nested
 * below it, a mount, and a filesystem root — #883/#989/#990/#1004. What is left for this check is
 * exactly one case those cannot see: an ordinary, self-contained directory that is simply not a
 * toolchain (`MODOKI_TOOLCHAIN_DIR` pointed at a home directory or a repo root). Both checks run;
 * neither subsumes the other.
 */

import fs from 'node:fs';

/**
 * Top-level entries the toolchain provisions into its own root.
 *
 * ⚠️ **This set is mirrored by `toolOwnedDirs()` in `engine/toolchain/index.ts`**, which is the
 * typed `ToolId -> dirs` map and cannot be imported from a `.mjs`. It is NOT trusted to stay in
 * step by hand: `toolchainResolve.test.ts` enumerates `TOOL_IDS`, calls the REAL `toolOwnedDirs`,
 * and asserts every basename it can return appears here — so adding a tool with a new top-level
 * directory turns that test red rather than silently making this guard refuse a real toolchain.
 */
export const TOOLCHAIN_OWNED_ENTRIES = new Set([
  'node',           // npm  (toolOwnedDirs 'npm')
  'jdk',            // java
  'android-sdk',    // android-sdk
  'cocoapods-gems', // cocoapods, dir 1 of 2
  'ruby',           // cocoapods, dir 2 of 2 — the portable ruby it runs on
  'wda',            // webdriveragent (fetched source + our DerivedData)
  'go-ios',         // go-ios
  'npm-tools',      // the SHARED npm package the CLI tools install into (npmToolsDir)
  'settings.json',  // the "Use system-installed SDKs" toggle
]);

/**
 * Filenames the OS writes into any directory a user has merely LOOKED at. They are not evidence of
 * a foreign directory, and treating them as such would make a real toolchain root un-removable the
 * first time Explorer or Finder rendered it.
 */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Why this directory must not be removed as a toolchain root, or `null` if it may be.
 *
 * Mirrors `deleteBoundary.mjs`'s `findDeleteBoundaries` / `describeBoundary` pair on purpose: a
 * predicate that returns a REASON, and a separate function that turns it into a sentence a human
 * has to act on. The two refusals are different kinds and must not share wording.
 *
 * - `not-a-directory` — the path exists and is a file (or a device, socket, …).
 * - `foreign`         — it is a directory holding top-level entries the toolchain does not own.
 *                       `entries` is SORTED, so a truncated message names the same ones every run.
 *
 * ⚠️ **ABSENT and UNREADABLE both return `null` (accept), and that is deliberate.** Absence is not
 * evidence of a foreign directory, and the callers already handle it — `forceRemoveDir` returns
 * early on `!existsSync`, and `clean-packaged-cache.mjs` skips a candidate its `lstat` cannot see.
 * An unreadable directory is backstopped by `findDeleteBoundaries`, which reports `unreadable` and
 * refuses the run: something unreadable must never authorise a delete, but neither should it be
 * reported here as a foreign NAME the caller could not have seen.
 *
 * ⚠️ **`not-a-directory` exists because the first version of this predicate ACCEPTED a plain file,
 * and nothing downstream caught it** (#1005 close-out review). `readdirSync` on a file throws
 * `ENOTDIR`, the bare `catch` returned `[]`, and `[]` meant accept; `findDeleteBoundaries` bails at
 * `if (!rootStat.isDirectory()) return out` because a file has no subtree. Measured end to end:
 * `MODOKI_TOOLCHAIN_DIR=<...>\notes.txt` produced `unexpectedEntries = []`, `boundaries = []`, and
 * `rmSync` deleted the file. The guard this replaced would have REJECTED that (a file is virtually
 * never named `toolchain`), so the rewrite had traded a false-reject class for a false-ACCEPT one on
 * a destructive path — strictly the worse direction. `statSync` is used rather than trusting the
 * `ENOTDIR` errno so the decision does not depend on which call happens to fail first.
 */
export function toolchainRootRefusal(dir) {
  let st;
  try {
    st = fs.statSync(dir, { throwIfNoEntry: false });
  } catch {
    return null; // unreadable — see above; findDeleteBoundaries owns this case
  }
  if (!st) return null;                                    // absent
  if (!st.isDirectory()) return { kind: 'not-a-directory', entries: [] };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null; // unreadable — as above
  }
  // ⚠️ NOT sorted here — see describeToolchainRootRefusal, which owns presentation order.
  // Sorting in the predicate is UNTESTABLE on this repo: NTFS readdir already returns sorted names,
  // so a test comparing the result to its own sort passes with the sort deleted (measured — the
  // mutation stayed green). Ordering the entries where they are RENDERED can be driven with a
  // hand-built refusal, so that is where it lives.
  const entries = names.filter((n) => !TOOLCHAIN_OWNED_ENTRIES.has(n) && !OS_JUNK.has(n));
  return entries.length > 0 ? { kind: 'foreign', entries } : null;
}

/** One refusal message a human can act on. ⚠️ It must NOT tell them to delete the thing — the
 *  realistic subject here is a home directory or a repo root, and `deleteBoundary.mjs` already
 *  records what a careless remedy line costs (#883's "lost a user their provision AND left them
 *  still blocked"). Say what is wrong and how to re-aim the setting; nothing else. */
export function describeToolchainRootRefusal(dir, r) {
  if (r.kind === 'not-a-directory') {
    return `Refusing to remove ${dir} — it is not a directory. MODOKI_TOOLCHAIN_DIR must point at `
      + 'the toolchain root Modoki provisioned.';
  }
  // SORTED here, not by the caller: a truncated message must name the same eight every run, and
  // readdir order is not an order. Falsifiable because this function can be handed an unsorted list.
  const sorted = [...r.entries].sort();
  const shown = sorted.slice(0, 8).join(', ');
  return `Refusing to remove ${dir} — it does not look like a Modoki toolchain root. It holds `
    + `${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'} the toolchain does not own: `
    + `${shown}${r.entries.length > 8 ? ', …' : ''}. Point MODOKI_TOOLCHAIN_DIR at the directory `
    + 'Modoki provisioned (its own root — not a parent of it, and not a directory you keep other '
    + 'things in).';
}
