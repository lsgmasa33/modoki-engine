/**
 * "Is this the same directory?" — the ONE implementation (#869).
 *
 * Sibling of `pathPosix.mjs`, and deliberately NOT part of it: that one owns the *separator*
 * class (#798), this one owns *root derivation + case*. A path can be perfectly forward-slashed
 * and still be a second spelling of the same directory.
 *
 * ## Why `===` on two resolved paths is the wrong comparison
 *
 * `path.resolve` normalises separators, `.`/`..` and a trailing slash. It does NOT normalise:
 *   - **drive-letter case** — `path.resolve('e:\\x') !== path.resolve('E:\\x')`, and both are the
 *     same directory. Typing `e:/Projects/...` is an entirely ordinary thing to do on Windows: a
 *     shell completes it, a tool lower-cases it, a path is copied out of a log.
 *   - **`subst` drive mappings** — `Y:\` standing in for `D:\some\dir`.
 *   - **symlinks / junctions** — a clone reached through one has two names.
 *
 * A guard written as `if (resolve(a) === B) return;` therefore FAILS OPEN on all three: the
 * comparison misses, the early return does not happen, and the thing the guard existed to
 * prevent proceeds. That is #869's shape — two `engine/electron/main.ts` guards compared a
 * `__dirname` repo root against a project root that arrives from `MODOKI_PROJECT` (typed by a
 * human) or `getRecentProjects()` (read off disk), neither normalised against the other.
 *
 * ## Why this is a shared module rather than a fix at those two lines
 *
 * Because the repo had already hand-rolled this comparison **seven** times, in four mutually
 * inconsistent recipes, and patching in place would have made eight and nine:
 *
 *   | site | recipe |
 *   |---|---|
 *   | `buildClaimsStore.sameProjectRoot`     | `resolve` + `===` (its own docblock admits the hole) |
 *   | `devServer.samePath`                   | slash-collapse + trim + lowercase |
 *   | `connectClaude.canonical`              | `resolve` → `realpathSync.native` → lowercase |
 *   | `instanceToken.rootKey`                | `resolve` + trim + lowercase |
 *   | `userDataDir.cloneId`                  | byte-identical to `rootKey` |
 *   | `userDataDir.multiProfileKey`          | `rootKey` **minus** the trailing-slash trim (already drifted) |
 *   | `projectGames.norm`                    | slash-collapse + strip LEADING slash + lowercase |
 *
 * The body below is `connectClaude.canonical`'s, adopted verbatim because it was the strongest
 * of the seven and already guarded the repo's most safety-critical boundary (the `$HOME/.mcp.json`
 * write). It is not new code; it is the copy that was already right, promoted.
 *
 * ## The two subtleties
 *
 * ⚠️ **`fs.realpathSync` is NOT the one you want — `.native` is.** The JS lstat-walk resolves
 * symlinks and junctions but neither `subst` nor drive-letter case. See docs/windows.md § Paths.
 *
 * ⚠️ **`.native` only normalises a path that EXISTS**, and throws otherwise — a stale recents
 * entry is exactly that. So the case-fold is not redundant with the realpath: it is what carries
 * the comparison when the realpath cannot run. Dropping it reintroduces the bug for every
 * missing path.
 *
 * ## Polarity belongs to the CALLER
 *
 * `samePath` answers a question; it does not decide what to do about it. The callers genuinely
 * disagree: `main.ts`'s heal/deps guards want over-matching to be safe (skip a tree we should not
 * have opened), `deviceClaimsStore.sameClone` deliberately REFUSES an unqualified stored path,
 * and a port-holder check that over-matches would kill the wrong process. Do not add a polarity
 * to this module.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Is this platform's filesystem case-insensitive for path comparison purposes?
 *
 *  The platform's DEFAULT, not a fact about the specific volume — a case-sensitive volume can be
 *  mounted on either (APFS can be formatted that way; `fsutil file setCaseSensitiveInfo`, which
 *  WSL sets, does it per-directory on Windows). On such a volume two genuinely different
 *  directories compare EQUAL here.
 *
 *  ⚠️ **That is not uniformly the safe direction, and an earlier version of this comment claimed
 *  it was** (close-out review). Which way an over-match fails is a property of the CALLER, not of
 *  this module — see the polarity note in the header:
 *    - `isEditorsOwnTree` and `buildClaimsStore.sameProjectRoot` read equal as "mine, don't touch
 *      / already claimed" → over-matching REFUSES an action. Fail-closed.
 *    - `deviceClaimsStore.foreignClaimFor` returns `null` for "not foreign", and
 *      `claim-guard.mjs`'s `heldByThisClone` returns true for "allow" → over-matching PROCEEDS.
 *      **Fail-open**: two clone directories differing only by case, on a case-sensitive volume,
 *      would let one clone drive a phone the other holds.
 *  The exposure is narrow (it needs a case-sensitive volume AND two clones differing only by
 *  case), and it is accepted rather than fixed: making this per-volume would mean a stat per
 *  comparison on a predicate that must work for paths which do not exist. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** The canonical SPELLING of `p`: resolved, and realpath'd where the path exists.
 *
 *  ⚠️ **Returns a usable path, deliberately NOT a case-folded comparison key.** An earlier draft
 *  folded here and it was wrong: callers keep this value (`deviceClaimsStore.canonicalClonePath`
 *  hands it to a refusal message that names the holding clone to a human), and a lower-cased path
 *  is worse to read and no longer round-trips. The fold belongs to the COMPARISON, so it lives in
 *  `samePath` below. An existing #865 test caught this — it pins that the on-disk spelling comes
 *  back, and it was right to.
 *
 *  Falls back to `path.resolve` when the path does not exist — a comparison must never depend on a
 *  stat succeeding, and "the directory is gone" is a normal state for a persisted path. */
export function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved; /* does not exist (yet, or any more) — `resolve` is the best available */
  }
}

/** Do `a` and `b` name the same directory or file?
 *
 *  The case-fold lives HERE rather than in `canonicalPath`, and it is not redundant with the
 *  realpath: `.native` fixes drive-letter case only for a path that EXISTS, and throws otherwise.
 *  A persisted path naming a directory that is gone — a stale recents entry, a stale device claim —
 *  falls back to bare `resolve`, which does no folding at all. That fallback is precisely where
 *  #865's fix still had a hole, and this fold is what closes it.
 *
 *  ⚠️ Both sides are canonicalised. If one side is UNTRUSTED (read off disk, out of an env var)
 *  and must be qualified before it is believed, gate it separately and gate it FIRST —
 *  `deviceClaimsStore`'s `isFullyQualified` is the worked example. This answers sameness, not
 *  trust: handed `"."` it will happily resolve against the cwd. */
export function samePath(a, b) {
  const A = canonicalPath(a);
  const B = canonicalPath(b);
  return CASE_INSENSITIVE ? A.toLowerCase() === B.toLowerCase() : A === B;
}
