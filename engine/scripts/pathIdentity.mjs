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
 *   | site | recipe | status |
 *   |---|---|---|
 *   | `buildClaimsStore.sameProjectRoot`     | `resolve` + `===` (its own docblock admitted the hole) | migrated #869 |
 *   | `connectClaude.canonical`              | `resolve` → `realpathSync.native` → lowercase | became this module #869 |
 *   | `projectGames.norm`                    | slash-collapse + strip LEADING slash + lowercase | gone (no such function) |
 *   | `devServer.samePath`                   | slash-collapse + trim, fold on **win32 only** | migrated #899 |
 *   | `instanceToken.rootKey`                | `resolve` + trim + lowercase | migrated #899 |
 *   | `userDataDir.cloneId`                  | byte-identical to `rootKey` | migrated #899 |
 *   | `userDataDir.multiProfileKey`          | `rootKey` minus the trailing-slash trim | migrated #899 |
 *
 * The body below is `connectClaude.canonical`'s, adopted verbatim because it was the strongest
 * of the seven and already guarded the repo's most safety-critical boundary (the `$HOME/.mcp.json`
 * write). It is not new code; it is the copy that was already right, promoted.
 *
 * ⚠️ **The table above was written in the past tense while four of its rows were still LIVE, and
 * that is what hid them for two more fixes** (#899). #869 replaced three; the remaining four were
 * `.replace()`/`.toLowerCase()` chains, so `pathIdentityIsShared.test.ts` could see none of them —
 * none matches any of its three banned shapes, and the comparison or the hash happens on a later
 * line. All four are migrated as of #899, and the status column exists so the next reader does not
 * have to re-derive which rows are history and which are a to-do list.
 *
 * ⚠️ **`multiProfileKey`'s "already drifted" note (it lost the trailing-slash trim, so `…/x/` and
 * `…/x` mint two profiles) was FALSE and is retired.** `path.resolve` strips a trailing separator
 * itself, so the trim its siblings carried was dead code and its absence changed nothing —
 * measured, and an existing test (`userDataDir.test.ts` → *"a trailing slash is the SAME project
 * (stable key)"*) had been green on exactly that point the whole time. It was scoped as work twice
 * on the strength of this line.
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
 * ## TWO canonicalisers, split by what the answer is FOR (#892)
 *
 *     canonicalPath             → a spelling you KEEP    (a human reads it, a record stores it)
 *     canonicalWithMissingTail  → a space you COMPARE in (nothing keeps it)
 *
 * **Every predicate in this module compares in the second one.** `canonicalPath` cannot be the
 * comparison canonicaliser: for a path that does not exist it falls back to bare `path.resolve`,
 * which resolves no links, so two spellings of a missing path — one reached through a symlinked
 * ancestor — come back different. `isUnderOrSame` was moved off it in #881 and `samePath` was
 * left on it until #892, which is exactly the shape a later reader takes for a deliberate
 * asymmetry. **A third predicate added here uses `canonicalWithMissingTail`.**
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
 *    - `devServer.classifyPortHolder` reads equal as "our own install", and an equal verdict plus a
 *      dead holder editor is a **process KILL** (`reclaimPort`). ⚠️ **Added to this list by #899**,
 *      which routed that function here from a hand-rolled recipe that folded on win32 ONLY — so on
 *      darwin this site is newly exposed. It is the caller the polarity note in the header uses as
 *      its example ("a port-holder check that over-matches would kill the wrong process"), and it
 *      was NOT in the enumeration #905's acceptance was ruled against. Narrowest of the set: it
 *      also needs the holder's editor to be dead.
 *  The exposure is narrow (it needs a case-sensitive volume AND two clones differing only by
 *  case), and it is **accepted rather than fixed — owner ruling, 2026-09-08 (#905)**. The standing
 *  reason is a cost/benefit call: the fix is a syscall with a platform-specific answer and a cache
 *  to get right, bought against a hazard that has never been observed outside a volume created
 *  deliberately to produce one.
 *
 *  ⚠️ **The reason it USED to give here was "a stat per comparison", and that one is DEAD** — see
 *  the #892 note below. It is kept rather than deleted because a dead rationale still reading as a
 *  live one is what made this need a ticket at all.
 *
 *  ⚠️ **#892 WIDENED this, and claimed the opposite while doing so.** The two spellings used to
 *  have to differ only by case; now `samePath` canonicalises through symlinks for a missing path,
 *  so `<vol>/target/ABC` (existing) and `<vol>/link/abc` (missing, `link -> target`) also collide
 *  here. Measured on a case-sensitive APFS volume. The terms are unchanged — same narrow exposure,
 *  same accepted cost — but the set of colliding pairs is larger than this paragraph was written
 *  for, and `samePath`'s docblock asserted the change could not reach it at all.
 *
 *  ⚠️ **And #892 INVALIDATED the reason given above for not fixing it.** "A stat per comparison"
 *  was a real cost when `samePath` did one `.native` per side; it now walks, and measured on this
 *  tree a `samePath` costs 2 syscalls for two existing roots and 10-12 for a nested or missing
 *  pair — one more is not a cost class. The second half ("must work for paths which do not
 *  exist") is defused too: `canonicalWithMissingTail` already locates the longest EXISTING
 *  ancestor, which is a real directory a per-volume probe could run against. The rationale
 *  survives only for `pathCaseKey` used standalone (`editorPorts.backendPortForClone` folds a
 *  bare directory SEGMENT, where there is no path to probe).
 *
 *  ⚠️ **So the acceptance above no longer rests on that cost argument — do not repeat it.** #905
 *  put the three ways out (probe per volume / narrow the fold / re-accept explicitly) to the
 *  owner, who ruled **re-accept** on 2026-09-08 and closed it. The reason that stands is the one
 *  on the acceptance above, not this retracted one.
 *
 *  ⚠️ **That ruling is a cost/benefit call, NOT a proof it cannot happen** — and when it does
 *  happen it is fail-OPEN. `sameClone` is the single comparison behind all four device-claim
 *  sites, so what is at stake is the machine-wide serialization of #149/#285. The three
 *  preconditions (a case-sensitive volume, two clone dirs differing only by case, and post-#892 a
 *  symlink) are what make the odds acceptable; if a case-sensitive volume ever comes into ordinary
 *  use here, this gets RE-OPENED rather than re-argued. */
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
 *  Falls back to `path.resolve` when the path does not exist — "the directory is gone" is a normal
 *  state for a persisted path, and the caller still needs something to show.
 *
 *  ⚠️ **That fallback is why this is not the canonicaliser a PREDICATE uses** (#892). `resolve`
 *  resolves no symlinks, so two spellings of a missing path come back different and any comparison
 *  built on this inherits that. `canonicalWithMissingTail` below is the one for that. */
export function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved; /* does not exist (yet, or any more) — `resolve` is the best available */
  }
}

/** The canonical spelling of `p`, resolving symlinks in the longest ANCESTOR that exists and
 *  re-appending the part that does not. **The canonicaliser both predicates below compare in.**
 *
 *  ⚠️ **Why this is not `canonicalPath`, and why `canonicalPath` must not become this.** A
 *  predicate compares two paths against each other, so both must be expressed in the same space —
 *  and `canonicalPath` falls back to bare `path.resolve` for a path that does not exist, which
 *  resolves no symlinks at all. On macOS that is not an edge case: `os.tmpdir()` is `/var/…`, a
 *  symlink to `/private/var/…`. The same miss was then found once per predicate, a fix apart:
 *    - `isUnderOrSame` (#881) — an EXISTING parent canonicalises to `/private/var` while a
 *      not-yet-created child under it falls back to `/var`, the two share no prefix, and the child
 *      is reported OUTSIDE a directory it is plainly inside. Found by the regression test for the
 *      `..bak` fix, which failed on its second assertion for this entirely separate reason.
 *    - `samePath` (#892) — `samePath('<base>/link/gone', '<base>/real/gone')` was `false` with
 *      `link -> real`, and so was `os.tmpdir() + '/nope'` against its own realpath + `'/nope'`.
 *      Filed rather than fixed alongside #881, on a fear about the call sites that the measurement
 *      in `samePath`'s docblock below retired.
 *
 *  `canonicalPath` keeps its #869 contract — a single path in, the best available spelling out,
 *  with an existing test pinning the resolve fallback — because its callers hand the result to
 *  humans and to persisted records.
 *
 *  ⚠️ **Not exported, and that is a decision.** A caller asking "the same directory?" wants
 *  `samePath`; one wanting a value to show or store wants `canonicalPath`. Exporting this would
 *  offer a third thing that is neither, and the header's whole argument is that this module ends
 *  recipes rather than adding them. */
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
      // only ENOENT. Both predicates below apply this to BOTH operands, and symmetrically that is
      // harmless: they step up to the same accessible ancestor and the comparison is unchanged.
      // The one wrong-answer shape needs an INACCESSIBLE component that is itself a symlink
      // pointing outside the parent, which would read as inside. Unreproducible without root
      // here, so: stated, not fixed.
    }
    const parent = path.dirname(head);
    if (parent === head) return resolved; // reached the root having found nothing that exists
    tail.unshift(path.basename(head));
    head = parent;
  }
}

/** Do `a` and `b` name the same directory or file?
 *
 *  Both sides go through `canonicalWithMissingTail`, so a `subst`ed, junctioned or symlinked
 *  spelling matches **whether or not the path exists** — and then through `pathCaseKey`, because
 *  `.native` normalises drive-letter case only for the part of the path it could resolve.
 *
 *  ⚠️ **The fold is not redundant with the realpath, and must not be "simplified" away.** The
 *  missing TAIL is re-appended literally — no realpath ever touches it — so the fold is the only
 *  thing normalising its case. A stale recents entry and a stale device claim are both exactly
 *  that, and they are the case this predicate is most often asked about.
 *
 *  ⚠️ **This was `canonicalPath` on both sides until #892, which closed the CASE half of #865's
 *  hole and not the SYMLINK half.** What the change is safe on, and what it is not:
 *    - **New false NEGATIVES are impossible.** A pair that matched before still matches: `.native`
 *      output contains no symlink component, so it cannot equal a spelling that does.
 *    - **On a case-INSENSITIVE volume, a new equality needs BOTH operands absent from disk.** If
 *      `a` exists, `cwmt(a)` is `.native(a)`; for `cwmt(b)` to equal it, `join(real(ancestor),
 *      tail)` would have to exist — the same directory entry as `join(ancestor, tail)`, which does
 *      not, by construction.
 *
 *  ⚠️ **That second argument DOES NOT HOLD on a case-SENSITIVE volume, and three copies of this
 *  paragraph asserted that it did** (#892 close-out review). It reasons about the raw `cwmt`
 *  strings and never applies `pathCaseKey` — and `samePath` compares the FOLDED keys.
 *  `CASE_INSENSITIVE` is platform-derived, so on a case-sensitive volume mounted on darwin or
 *  win32 the fold still runs. Measured there, with `link -> target`:
 *
 *      a = <vol>/target/ABC   exists          b = <vol>/link/abc   does NOT exist
 *      pre-#892  false        post-#892  true        …and ABC ≠ abc on that volume.
 *
 *  So: a new equality with ONE operand present, and a genuine false POSITIVE. It reaches
 *  `sameClone`, the one comparison behind all four fail-open sites.
 *
 *  This is a WIDENING of the hazard `CASE_INSENSITIVE` above already documents and accepts, not a
 *  new one — the two spellings previously had to differ only by case, and may now also differ by a
 *  symlink — and STRICTLY HARDER to hit, which is the part that makes accepting it honest: if
 *  `cwmt(a) === cwmt(b)` as raw strings the match is genuine, so every post-#892 false positive
 *  needs the FOLD to have done work, i.e. a case difference. The symlink is a requirement ON TOP
 *  of the old hazard's precondition, not a substitute for it. **What is not accepted is claiming
 *  it cannot happen**, which is what stood here.
 *
 *  ⚠️ The retracted paragraph also called `isEditorsOwnTree` and `sameProjectRoot` fail-OPEN. They
 *  are fail-CLOSED — see the polarity list on `CASE_INSENSITIVE` above. Four sites read equal as
 *  "allow", and all reach it through `deviceClaimsStore.sameClone` — plus a fifth of that polarity
 *  that does not: `editorPorts.mjs`'s `invokedDirectly`, where an over-match runs the CLI block on
 *  a mere import. Near-unreachable (it needs the importer's `argv[1]` to be a variant spelling of
 *  `editorPorts.mjs` itself), but "all four go through `sameClone`" was an enumeration, and
 *  enumerations are claims.
 *
 *  ⚠️ Both sides are canonicalised. If one side is UNTRUSTED (read off disk, out of an env var)
 *  and must be qualified before it is believed, gate it separately and gate it FIRST —
 *  `deviceClaimsStore`'s `isFullyQualified` is the worked example. This answers sameness, not
 *  trust: handed `"."` it will happily resolve against the cwd. */
export function samePath(a, b) {
  return pathCaseKey(canonicalWithMissingTail(a)) === pathCaseKey(canonicalWithMissingTail(b));
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
