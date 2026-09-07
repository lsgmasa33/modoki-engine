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
 *  #865's fix still had a hole, and this fold closes the CASE half of it.
 *
 *  ⚠️ **It does NOT close the SYMLINK half, and an earlier version of this paragraph implied it
 *  did.** `resolve` resolves no links either, so two spellings of a path that does not exist —
 *  one reached through a symlinked ancestor — still compare UNEQUAL here. Measured on darwin:
 *  `samePath('<base>/link/gone', '<base>/real/gone')` is `false` with `link -> real`.
 *  `isUnderOrSame` fixes this for itself with `canonicalWithMissingTail` below; `samePath` does
 *  not, because it has eight production call sites whose polarity differs and #865's suite pins
 *  the current fallback. Tracked separately rather than changed inside #881's finishing pass.
 *
 *  ⚠️ Both sides are canonicalised. If one side is UNTRUSTED (read off disk, out of an env var)
 *  and must be qualified before it is believed, gate it separately and gate it FIRST —
 *  `deviceClaimsStore`'s `isFullyQualified` is the worked example. This answers sameness, not
 *  trust: handed `"."` it will happily resolve against the cwd. */
export function samePath(a, b) {
  return pathCaseKey(canonicalPath(a)) === pathCaseKey(canonicalPath(b));
}

/** The COMPARISON KEY for an already-canonical path (or a single path segment) on this platform:
 *  case-folded where the filesystem is, identity where it is not.
 *
 *  Exported (#881) because the fold is not only needed by `samePath`. `backendPortForClone` looks a
 *  clone directory NAME up in a table — a lookup, not a comparison — and was case-SENSITIVE, so
 *  `E:/Projects/MODOKI` found no pinned port and fell to auto ports (the #349 class). A second
 *  `platform === 'win32' || 'darwin'` test written at that call site would have been the ninth
 *  hand-rolled recipe this module exists to end, so the rule lives here once and the lookup asks
 *  for it.
 *
 *  ⚠️ **Not a canonicaliser.** It folds case and nothing else — no resolve, no realpath. Feed it
 *  `canonicalPath()` output, or a single path segment taken from one. Handed a raw `../x` it
 *  returns a lower-cased `../x`, which compares equal to nothing useful. */
export function pathCaseKey(s) {
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

/** The canonical spelling of `p`, resolving symlinks in the longest ANCESTOR that exists and
 *  re-appending the part that does not.
 *
 *  ⚠️ **Why this is not `canonicalPath`, and why `canonicalPath` must not become this.** A
 *  containment check compares two paths against each other, so both must be expressed in the same
 *  space — and `canonicalPath` falls back to bare `path.resolve` for a path that does not exist,
 *  which resolves no symlinks at all. On macOS that is not an edge case: `os.tmpdir()` is
 *  `/var/…`, a symlink to `/private/var/…`. So an EXISTING parent canonicalises to `/private/var`
 *  while a not-yet-created child under it falls back to `/var`, the two share no prefix, and the
 *  child is reported OUTSIDE a directory it is plainly inside. Found by the regression test for
 *  the `..bak` fix, which failed on its second assertion for this entirely separate reason.
 *
 *  `canonicalPath` keeps its #869 contract — a single path in, the best available spelling out,
 *  with an existing test pinning the resolve fallback — because its callers hand the result to
 *  humans and to persisted records. This one exists only for the comparison below. */
function canonicalWithMissingTail(p) {
  const resolved = path.resolve(p);
  let head = resolved;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      // Every throw is treated as "not there" and steps up — including EACCES/EPERM/ELOOP, not
      // only ENOENT. Applied to BOTH operands symmetrically that is harmless: they step up to the
      // same accessible ancestor and the comparison is unchanged. The one wrong-answer shape needs
      // an INACCESSIBLE component that is itself a symlink pointing outside the parent, which
      // would read as inside. Unreproducible without root here, so: stated, not fixed.
    }
    const parent = path.dirname(head);
    if (parent === head) return resolved; // reached the root having found nothing that exists
    tail.unshift(path.basename(head));
    head = parent;
  }
}

/** Is `child` the same path as `parent`, or inside it? (#881)
 *
 *  The third recipe in this space, and the one `===`-plus-`startsWith` gets wrong. Both operands
 *  are canonicalised (so a `subst`ed or symlinked spelling matches) and then FOLDED BEFORE
 *  `path.relative`, which is what makes this correct on both case-insensitive platforms:
 *
 *  ⚠️ **`path.relative` folds case on win32 but NOT on darwin** — it is `node:path`'s posix
 *  implementation there, so `relative('/A/b', '/a/b/c')` is `'../../a/b/c'` and a raw containment
 *  check reports a path as OUTSIDE a root it is plainly inside. Folding both sides first is what
 *  closes that; it is not redundant with the win32 behaviour, it is the darwin half of it.
 *
 *  `electron/projects.ts`'s `isUnderRepo` is deliberately NOT migrated onto this (docs/windows.md
 *  § Paths): it answers STRICT containment — `rel !== ''`, so the root itself is not "under" itself
 *  — and it is correct as it stands. This one includes equality because its caller needs it: the
 *  `/api/unused-assets` filter must keep an asset that IS the project root's own path. Two
 *  questions, two functions; do not collapse them. */
export function isUnderOrSame(parent, child) {
  const P = pathCaseKey(canonicalWithMissingTail(parent));
  const C = pathCaseKey(canonicalWithMissingTail(child));
  if (P === C) return true; // `path.relative(P, P)` is '', which the escape test below would reject
  const rel = path.relative(P, C);
  // ⚠️ **`rel.startsWith('..')` is WRONG and this function shipped it once.** It also rejects a
  // child whose NAME begins with two dots — `path.relative('/proj', '/proj/..bak')` is `'..bak'`,
  // which is inside the project and has a perfectly good relative form. Only the `..` SEGMENT
  // means escaped. `projectPaths.ts:47` already carried this spelling with the same comment, and
  // `projectPaths.test.ts` has a case named for it; the SSOT was written with the version that
  // test exists to forbid, and review caught it.
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`);
  return rel !== '' && !escapes && !path.isAbsolute(rel);
}
