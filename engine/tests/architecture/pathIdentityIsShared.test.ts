/** ARCHITECTURE GUARD — "is this the same directory?" goes through `samePath`, not `===` (#869).
 *
 *  This is the guard that did not exist, which is the whole reason the comparison reached SEVEN
 *  hand-rolled copies in four mutually inconsistent recipes before anyone noticed. Two of them
 *  (`engine/electron/main.ts`'s heal and dep-install guards) were `path.resolve(x) === REPO_ROOT`,
 *  which normalises separators, `.`/`..` and a trailing slash but NOT drive-letter case, `subst`
 *  mappings, or symlinks. They FAILED OPEN: the comparison missed, the early return did not
 *  happen, and the editor ran `npm install` into its own checkout.
 *
 *  ## What is banned, and what is deliberately not
 *
 *  Banned: comparing a `path.resolve(...)` result with `===`/`!==`. That is the exact shape of the
 *  defect, and `engine/scripts/pathIdentity.mjs` exists to replace it.
 *
 *  **NOT banned — exempted by SHAPE, not by a file list:** `path.resolve(process.argv[1]) ===
 *  fileURLToPath(import.meta.url)`, the "was this module run directly?" idiom. It is a different
 *  question (module identity, not directory identity) and a `samePath` there would be a category
 *  error. Exempting by shape rather than by an allowlist of paths is deliberate: a hand-maintained
 *  list goes stale on the first file somebody adds, invisibly, and the point of this guard is to
 *  make the EIGHTH copy loud. (The idiom is separately fragile on Windows: `clonePort.mjs`'s
 *  `isEntryPoint` canonicalises both sides, and since #881 so does `editorPorts.mjs`'s
 *  `invokedDirectly` — so it is no longer "the one site". Cited by SYMBOL because the line
 *  citation that stood here rotted inside a single change. A different defect, not this guard's.)
 *
 *  **NO LONGER an exemption: the case-folding hand-rolls** in `userDataDir.cloneId`,
 *  `userDataDir.multiProfileKey` and `instanceToken.rootKey`. This docblock used to exempt them
 *  ("those HASH the path into a PERSISTED identity … Do not 'finish the migration' by sweeping
 *  them in"), and the reason it gave was that re-normalising "relocates every existing user's
 *  profile and 403s them against their own editor".
 *
 *  ⚠️ **That reason was measurably false, and it is what kept three live defects parked** (#899).
 *  Measured 2026-09-08 over the six real clone and project roots on a developer machine: the key
 *  is BYTE-IDENTICAL under the old and new recipes for every one of them. The only paths that move
 *  are those traversing a symlink — exactly the ones that were already split across two identities,
 *  which was the defect. All three are migrated; `instanceToken` carries a legacy-key read-through
 *  so a pre-#899 `.mcp.json` keeps working (with ONE
 *  exception: a user who connected through BOTH spellings loses one of the two tokens and is 403d
 *  once — inherent to unifying two identities, recorded on `rootKey`), and `userDataDir` deliberately carries none
 *  (there is no write-forward moment for a directory — see the note on `cloneId`).
 *
 *  ⚠️ **They still do not MATCH any pattern here**, because they are `.replace()`/`.toLowerCase()`
 *  chains that hash on a later line — so this guard did not catch them, did not fail when they were
 *  fixed, and would not notice an eighth written tomorrow. That gap is real and is the floor this
 *  file already admits to. An import-level rule ("a file in these roots deriving path identity
 *  imports pathIdentity.mjs") is the candidate fix and is deliberately NOT bundled with #899: it is
 *  a new corpus rule with its own false-positive surface, and landing it alongside the migration
 *  would hide whether the migration itself was sound.
 *
 *  ## Why this guard scans stripped source
 *
 *  Per #812, a raw text scan can be satisfied OR hidden by a comment — and this very file's
 *  docblock quotes the banned pattern in order to describe it. `stripComments` is load-bearing,
 *  and `assertScanIsSane` pins that the stripping itself did not go vacuous.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments, assertScanIsSane, readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** The roots whose code answers "same directory?" about a repo/project/clone root. Floored well
 *  under what each measures today, so a glob that stops matching goes RED rather than vacuous.
 *
 *  ⚠️ `engine/plugins` is in scope because `samePath` is reachable from there and three of its
 *  files answer this question (`deviceClaims.ts`, `buildLock.ts`, `editorBackendRouter.ts`).
 *  Leaving it out was a scope restriction that claimed the defect could only live in two of the
 *  three surfaces the SSOT serves (close-out review). Adding it cost nothing — measured 0 new
 *  offenders. `engine/app` is still outside — but ⚠️ **the reason given for that is not quite true**, and the
 *  close-out sweep found the counter-example: `projectGames.ts`'s `gameLoadFailureMessage` DOES
 *  compare a dev-server root against a file path, with its own hand-rolled recipe. It stays out
 *  because the stakes are different, not because the shape is absent — it only picks which of two
 *  DIAGNOSTIC MESSAGES to print, so a wrong answer is a less accurate error string rather than a
 *  wrong action, and it full-case-folds on purpose for a documented reason. Do not repeat "app
 *  does not derive repo roots" as though it were a fact about the code.
 *
 *  ⚠️ `engine/tools` added for the same reason one release later (#913): it holds
 *  `shared/identity.ts`, which answers "am I driving the wrong clone's editor?" — the question
 *  `CLAUDE.md` tells every session to ask FIRST — and it sat outside every source-scanning guard.
 *  Measured before adding: 36 files, 0 banned shapes, 0 bare `realpathSync`, so it costs nothing
 *  today, exactly as `engine/plugins` did.
 *
 *  ⚠️ **Claim this widening as a FLOOR for the next site, and nothing more.** It does NOT catch the
 *  defect that prompted it: `identity.ts`'s `norm` is a `.replace()` chain, which matches neither
 *  regex below. A guard that cannot see the instance that motivated it is worth having and must
 *  not be described as having closed the hole.
 *
 *  ⚠️ **`scripts/` (the repo-root one) is still outside, and not by oversight.** It holds 3 files
 *  against `sourceFiles`' `floor: 10`, so adding it would fail the corpus floor rather than police
 *  anything. It needs a per-root floor before it can join; filed rather than bodged. */
const ROOTS = ['engine/electron', 'engine/scripts', 'engine/plugins', 'engine/tools'];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(path.join(repoRoot, dir))) return [];
  return repoFiles({
    under: dir,
    match: (rel: string) => (rel.endsWith('.ts') || rel.endsWith('.mjs')) && !rel.endsWith('.test.ts') && !rel.endsWith('.d.mts'),
    exclude: ['dist', 'node_modules'],
    floor: 10,
  }).map(({ rel }: { rel: string }) => rel);
}

/** `resolve(…)` on either side of a `===`/`!==`.
 *
 *  ⚠️ Three escapes the first version had, all found by the close-out review and all reachable
 *  by ordinary house style — the point of a guard is that it cannot be sidestepped by accident:
 *    - **`(?:path\.)?`** — `import { resolve } from 'node:path'` is already the style in five
 *      files inside these roots (`clean-texture-cache.mjs`, `install-git-hooks.mjs`,
 *      `migrate-anchor-zindex.mjs`, `migrate-font-family-refs.mjs`, `show-refs.mjs`), so a
 *      `path.`-anchored pattern was blind to all of them.
 *    - **`[^;]*` rather than `[^)]*`** — `path.resolve(path.join(a, b)) === X` has nested parens,
 *      so `[^)]*` stopped at the inner `)` and missed the whole LEFT-operand form. The eighth
 *      site #869 found was only caught because it happened to be written with `resolve()` on the
 *      RIGHT; operands swapped, the guard reproduced the blind spot it is credited with closing.
 *    - **`(?:^|[^.\w])`** — so a member call like `foo.resolve(x)` (a Promise helper, a DI
 *      container) is not swept in.
 *  ⚠️ **What it does NOT catch, stated plainly because an earlier docstring overclaimed it as
 *  un-sidesteppable.** The regex needs `resolve(` ADJACENT to the operator, so the commonest
 *  house form — assign first, compare later — escapes it entirely:
 *
 *      const root = path.resolve(x);   // …later…   if (root !== state.root) …
 *
 *  That is not an accident-level sidestep; it is the normal way to write it, and the review that
 *  found this turned up three live instances of exactly that shape (`main.ts`'s Open-Recent
 *  handler, `projects.ts`'s ✓-marker, `editorBackendRouter`'s `abs === ctx.projectRoot`). Two
 *  were migrated; the third is a CONTAINMENT check tracked in #881. Catching the assignment form
 *  needs dataflow, not a line regex — so this guard is a **floor**, and #881 carries the question
 *  of whether it should also ban bare `fs.realpathSync` in these roots.
 *
 *  Also per-LINE, so a comparison split across two lines escapes. Same accepted limit. */
const BANNED = /(?:^|[^.\w])(?:path\.)?resolve\s*\([^;]*\)\s*[!=]==|[!=]==\s*(?:path\.)?resolve\s*\(/;

/** The "was this module run directly?" idiom — a different question, exempt by shape. */
const ENTRYPOINT_IDIOM = /import\.meta\.url|process\.argv\[1\]/;

/** A bare `fs.realpathSync(...)` — the JS lstat-walk — anywhere in these roots (#881).
 *
 *  #869's docblock left this as an open question for #881; the answer is yes, and the census that
 *  decided it found **nine** calls in **six** files (`projectPaths.ts`, `claim-guard.mjs`,
 *  `clonePort.mjs` ×2, `context-cost-guard.mjs`, `device.mjs` ×3, `editorPorts.mjs`). The walk resolves symlinks and junctions
 *  but neither a `subst` mapping nor drive-letter case, so it is never the right canonicaliser on
 *  Windows — measured in docs/windows.md § Paths, where `realpathSync('e:\Projects\modoki')`
 *  comes back unchanged and `.native` returns `E:\Projects\modoki`.
 *
 *  ⚠️ **`.native` is NOT banned, only the bare walk.** `\brealpathSync\s*\(` requires the paren
 *  to follow immediately, so `fs.realpathSync.native(x)` does not match — a `.` sits where the
 *  `(` would have to be. That is deliberate rather than incidental: `.native` throws on a path
 *  that does not exist, which is occasionally exactly what a caller wants, and `canonicalPath`
 *  is built out of it. The regex-table below pins both directions so a later "simplification"
 *  cannot quietly widen this to the shape that would ban the SSOT's own body.
 *
 *  The word boundary also lets `import { realpathSync } from 'node:fs'` through at the IMPORT
 *  (no paren follows) while still catching the call — the same destructured-import escape the
 *  `resolve` regex above had to be widened for.
 *
 *  ⚠️ **This is a SOURCE-TEXT guard, so an ALIAS defeats it — measured, not reasoned (#893).**
 *  `const rp = fs.realpathSync; return rp(resolved);` is the banned walk with identical behaviour
 *  and no literal match, and this guard goes green on it. That is the same class as the async twin
 *  conceded in the table below ("an accepted gap, not an endorsement"), reached by a second route.
 *  Deliberately NOT widened: the shapes are unbounded, and a regex chasing them starts failing the
 *  honest spellings. The OUTCOME is covered instead, spelling-independently, by
 *  `pathIdentity.test.ts` → *"win32: an 8.3 SHORT path is the same directory"*, which asserts the
 *  ANSWER and fails on the aliased mutation this one misses. **Two complementary guards: this bans
 *  a spelling, that pins the result — do not delete either as redundant.** */
const BANNED_REALPATH = /\brealpathSync\s*\(/;

/** `canonicalPath(...)` on either side of a `===`/`!==` (#892).
 *
 *  The third shape, and the one the first two guards were structurally unable to see. #869 banned
 *  the RAW recipe (`resolve(x) === y`) and #881 banned the wrong realpath, so the remaining way to
 *  write this defect is with the SSOT's own export — `canonicalPath(a) === canonicalPath(b)` reads
 *  as maximally correct and is the exact body `samePath` had to be moved OFF.
 *
 *  ⚠️ **`canonicalPath` is the SPELLING canonicaliser, and a comparison built on it inherits its
 *  `path.resolve` fallback for a path that does not exist** — which resolves no symlinks, so two
 *  spellings of a missing path compare unequal. That was #892 in `samePath` itself and #881 in
 *  `isUnderOrSame`: the same mistake, found once per predicate, a fix apart. Nothing was stopping
 *  a third.
 *
 *  ⚠️ **Zero live offenders when this landed** — measured, and stated because a guard's first run
 *  finding nothing is the case where a silently-broken pattern is indistinguishable from a clean
 *  repo. The `it.each` table below and the non-vacuity assertion are what carry it instead.
 *
 *  ⚠️ **`ARG` allows ONE level of nested parens, and dropping it reintroduces a blind spot this
 *  file already has a scar for.** A first cut used a flat `[^;()]*` to keep the false positives
 *  below out, and went blind to every argument that is not a bare identifier — including the
 *  literal house spelling at `deviceClaimsStore.mjs:626` and `:660`:
 *
 *      canonicalClonePath(opts.clone ?? process.cwd()) === held.clone   // MISSED
 *      canonicalPath(process.cwd()) === own                             // MISSED
 *      pathCaseKey(canonicalPath(path.dirname(p))) === key              // MISSED
 *
 *  That is exactly why `BANNED` above uses `[^;]*` rather than `[^)]*` — its docblock records the
 *  fix, and docs/windows.md § Paths records the census grep that missed #869's eighth site the
 *  same way. Third time; hence `ARG` rather than a flat class. A `(?:^|[^.\w])` prefix would be
 *  pointless here (`canonicalPath` is not a method name on anything) and is omitted rather than
 *  copied without a reason.
 *
 *  ⚠️ **This does NOT ban `canonicalPath`.** Assigning it, returning it, storing it and using it
 *  as a Map key are all correct and untouched — `context-cost-guard`'s budget key and
 *  `deviceClaimsStore.canonicalClonePath`'s refusal message are exactly what it is for. Only
 *  putting it in a `===` is banned, and the fix is `samePath`, never deleting the canonicalisation
 *  (the "a guard can push the fix the wrong way" hazard the realpath table above pins).
 *
 *  ⚠️ **The compared value must BE the canonicalisation, not merely contain it** — which is why
 *  this is two explicit alternatives rather than `BANNED`'s `[^;]*`. Copying that pattern here
 *  matched two shapes that are correct, and one of them is live code (close-out review):
 *
 *      path.relative(canonicalPath(repoRoot), p) !== ''   // projects.ts `isUnderRepo`
 *      path.basename(canonicalPath(p)) === 'games'        // one `===` from editorPorts.mjs:130
 *
 *  `isUnderRepo` answers STRICT containment and docs/windows.md says explicitly it must NOT
 *  migrate to `isUnderOrSame` — so the guard's own message would have offered no valid fix, and
 *  the cheapest green would have been deleting the `canonicalPath(...)`. That is precisely the
 *  hazard the paragraph above claims to avoid, committed in the guard that claims it. So the
 *  wrapper whitelist is exactly `pathCaseKey`, the one wrapper that preserves the question.
 *
 *  ⚠️ **The entry-point idiom is EXEMPT here too, as it already was for `BANNED`** (#910). The
 *  shared `entryPoint.mjs` compares `canonicalPath(fileURLToPath(moduleUrl))` against
 *  `canonicalPath(process.argv[1])`, which is this exact banned shape — and is CORRECT, because
 *  the ban's rationale is that `canonicalPath` falls back to `path.resolve` for a path that does
 *  not exist. Both operands of an entry-point check exist BY CONSTRUCTION (the module is running;
 *  `argv[1]` is what started it), so the fallback is unreachable and no missing-path comparison
 *  can occur. Exempting by SHAPE rather than by filename keeps that judgement re-checkable, and
 *  matches how the same idiom is already handled for `resolve(x) === y` above. The rows below pin
 *  both directions of the exemption, because an exemption nobody tests is just a hole.
 *
 *  ⚠️ **`canonicalClonePath` is in the pattern too** — `deviceClaimsStore` exports it as a thin
 *  alias for `canonicalPath`, so `canonicalClonePath(a) === canonicalClonePath(b)` is the same
 *  defect under a second name.
 *
 *  ⚠️ **Per-LINE, so the assign-then-compare form escapes — this is a FLOOR, exactly as `BANNED`
 *  is.** The commonest house spelling is not caught:
 *
 *      const A = pathCaseKey(canonicalPath(a));   // …later…   return A === B;
 *
 *  and `isUnderOrSame` ten lines away in the SSOT is written that way. `BANNED`'s docblock has
 *  said this since #869; this one omitted it, and commit `80c5536f8`'s "a third had no guard in
 *  front of it" overstated what landed. Catching it needs dataflow, not a line regex. */
const CANONICALISER = String.raw`(?:canonicalPath|canonicalClonePath)`;
/** An argument list with ONE level of nesting — `process.cwd()`, `path.dirname(p)`,
 *  `opts.clone ?? process.cwd()`. Deeper nesting is an accepted gap; a flat class is not. */
const ARG = String.raw`(?:[^;()]|\([^;()]*\))*`;
/** The entry-point exemption for the CANONICALISER shape — deliberately TIGHTER than
 *  `ENTRYPOINT_IDIOM` above, which `BANNED` uses (#910 close-out review).
 *
 *  ⚠️ **`ENTRYPOINT_IDIOM` matches `import.meta.url` ALONE, and that is too loose here.**
 *  `path.dirname(fileURLToPath(import.meta.url))` is this repo's dominant idiom for deriving a
 *  repo root, so exempting on that token would have exempted
 *
 *      if (canonicalPath(projectRoot) === canonicalPath(path.dirname(fileURLToPath(import.meta.url))))
 *
 *  — a textbook #892 defect (one operand can be missing, so the `resolve` fallback resolves no
 *  symlinks), which the guard caught before this exemption existed. Measured on a probe file: the
 *  loose form let it through.
 *
 *  So the discriminator is `process.argv[1]`, not `import.meta.url`: an entry-point check
 *  necessarily compares against the path Node was INVOKED with, and a comparison of two directory
 *  roots does not mention it. (`entryPoint.mjs` names its other operand `moduleUrl` — a
 *  parameter — so requiring `import.meta.url` on the line would have excluded the one line this
 *  exemption exists for. That was the first attempt, and the rows below caught it.)
 *
 *  ⚠️ **Accepted looseness, stated:** `canonicalPath(process.argv[1]) === canonicalPath(stored)`
 *  is exempt too. That is still the entry-point family — `argv[1]` exists by construction — and
 *  narrowing further would need the shape of the OTHER operand, which is where a regex stops being
 *  honest. Today `entryPoint.mjs` is the only exempt line in the three scanned roots. */
const ENTRYPOINT_ARGV = /process\.argv\[1\]/;

const BANNED_CANONICAL_COMPARE = new RegExp(
  // the canonicalisation IS the left operand, bare or folded by `pathCaseKey`
  `${CANONICALISER}\\s*\\(${ARG}\\)\\s*[!=]==`
  + `|pathCaseKey\\s*\\(\\s*${CANONICALISER}\\s*\\(${ARG}\\)\\s*\\)\\s*[!=]==`
  // …or the right operand, same two shapes
  + `|[!=]==\\s*(?:pathCaseKey\\s*\\(\\s*)?${CANONICALISER}\\s*\\(`,
);

const files = ROOTS.flatMap(sourceFiles);

describe('same-directory comparisons go through pathIdentity (#869)', () => {
  it('scans a non-empty set of source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('the comment scan is sane over every scanned file', () => {
    for (const rel of files) {
      const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assertScanIsSane(raw, stripComments(raw), rel);
    }
  });

  it('the SSOT exists and exports both halves', async () => {
    const mod = await import('../../scripts/pathIdentity.mjs');
    expect(typeof mod.samePath).toBe('function');
    expect(typeof mod.canonicalPath).toBe('function');
  });

  /** The guard's own falsifiability. Without this, "I widened the regex" is a claim about a
   *  regex nobody ran against the shapes it was widened for — and the first version passed its
   *  suite while missing three forms that are ordinary house style here. */
  it.each([
    ['plain', 'if (path.resolve(projectRoot) === REPO_ROOT) return;', true],
    ['nested parens, LEFT operand', 'if (path.resolve(path.join(a, b)) === REPO_ROOT) return;', true],
    ['destructured import', "if (resolve(projectRoot) === REPO_ROOT) return;", true],
    ['RIGHT operand', 'const differs = a !== path.resolve(path.join(b, c));', true],
    ['!== form', 'if (path.resolve(x) !== y) return;', true],
    // …and shapes it must NOT claim, or the guard becomes noise someone silences.
    // ⚠️ `foo.path.resolve(...)` is the case that actually exercises the `(?:^|[^.\w])`
    // narrowing — the other three negatives below are rejected by the ORIGINAL regex too, so
    // on their own they measure nothing about the widening (close-out review).
    ['a nested member .path.resolve()', 'if (foo.path.resolve(a) === b) return;', false],
    ['a member .resolve()', 'if (container.resolve(token) === other) return;', false],
    ['an unrelated await', 'const v = await resolve(x);', false],
    ['samePath, the fix itself', 'if (samePath(projectRoot, repoRoot)) return;', false],
  ])('regex: %s', (_label, line, shouldMatch) => {
    expect(BANNED.test(line)).toBe(shouldMatch);
  });

  it('no file compares a path.resolve() result with === / !==', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (BANNED.test(line) && !ENTRYPOINT_IDIOM.test(line)) offenders.push(`  ${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'A `path.resolve(x) === y` comparison answers "same directory?" WITHOUT normalising\n'
      + 'drive-letter case, `subst` mappings or symlinks, so it fails OPEN on Windows (#869).\n'
      + 'Use `samePath` from engine/scripts/pathIdentity.mjs instead:\n'
      + offenders.join('\n'),
    ).toHaveLength(0);
  });

  /** The realpath regex's own falsifiability. The negative rows are the load-bearing ones here:
   *  a version of this that also matched `.native` would ban `canonicalPath`'s own body, and the
   *  cheapest way to make THAT green is to delete the SSOT's realpath — the exact "a guard can
   *  push the fix the wrong way" hazard. */
  it.each([
    ['bare member call', 'return fs.realpathSync(p);', true],
    ['bare, wrapped in resolve', 'try { return fs.realpathSync(path.resolve(raw)); } catch {}', true],
    ['destructured call', 'const real = realpathSync(dir);', true],
    ['space before paren', 'return fs.realpathSync (p);', true],
    // …and what it must NOT claim.
    ['.native — the SSOT\'s own body', 'return fs.realpathSync.native(resolved);', false],
    ['.native, destructured', 'const r = realpathSync.native(resolved);', false],
    ['the destructured IMPORT itself', "import fs, { realpathSync } from 'node:fs';", false],
    // ⚠️ NOT a blessing — `fs.promises.realpath` is the SAME JS walk and has its own `.native`.
    // It is an ACCEPTED GAP: no caller uses it today, and widening the regex to cover a second
    // spelling with zero live instances is how a guard grows false positives it later gets
    // silenced for. If one appears, widen this rather than reading the row as permission.
    ['the async twin — an accepted gap, not an endorsement', 'await fs.promises.realpath(p);', false],
  ])('realpath regex: %s', (_label, line, shouldMatch) => {
    expect(BANNED_REALPATH.test(line)).toBe(shouldMatch);
  });

  it('no file canonicalises with the bare fs.realpathSync walk (#881)', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (BANNED_REALPATH.test(line)) offenders.push(`  ${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      '`fs.realpathSync` is the JS lstat-walk: it resolves symlinks and junctions but NOT a\n'
      + '`subst` mapping or drive-letter case, so it is not a canonicaliser on Windows (#881).\n'
      + 'Use `canonicalPath` from engine/scripts/pathIdentity.mjs — it is `.native` with a\n'
      + '`path.resolve` fallback for a path that does not exist:\n'
      + offenders.join('\n'),
    ).toHaveLength(0);
  });

  it.each([
    ['plain, both sides', 'if (canonicalPath(a) === canonicalPath(b)) return;', true],
    ['the pre-#892 body, wrapped in the fold', 'return pathCaseKey(canonicalPath(a)) === pathCaseKey(canonicalPath(b));', true],
    ['RIGHT operand only', 'const differs = state.root !== canonicalPath(chosen);', true],
    ['LEFT operand only', 'if (canonicalPath(stored) === own) return null;', true],
    ['space before paren', 'if (canonicalPath (a) === b) return;', true],
    // ⚠️ The three nested-argument rows. A flat `[^;()]*` missed all three, and the second is
    // live house style at `deviceClaimsStore.mjs:626`. Deleting `ARG` reddens exactly these.
    ['a nested call as the argument', 'if (canonicalPath(process.cwd()) === own) return;', true],
    ['the alias, with a ?? default', 'if (canonicalClonePath(opts.clone ?? process.cwd()) === held.clone) return;', true],
    ['nested, and folded', 'if (pathCaseKey(canonicalPath(path.dirname(p))) === key) go();', true],
    ['the canonicalClonePath alias', 'return canonicalClonePath(stored) === canonicalClonePath(own);', true],
    ['alias on the right', 'if (own !== canonicalClonePath(c.clone)) continue;', true],
    // ⚠️ The two rows that made this regex two alternatives instead of `BANNED`'s `[^;]*`. The
    // first is live code (`projects.ts` `isUnderRepo`), and it must NOT become `isUnderOrSame`.
    ['canonicalPath as an ARGUMENT, result compared', "if (path.relative(canonicalPath(root), p) !== '') return false;", false],
    ['…and the basename form, one edit from editorPorts.mjs:130', "if (path.basename(canonicalPath(p)) === 'games') go();", false],
    // ⚠️ NOT a blessing — this is the assign-then-compare FLOOR, stated in the docblock. If you
    // are reading this row as permission to write it that way, you have it backwards.
    ['assign-then-compare — an accepted gap, not an endorsement', 'const A = canonicalPath(a); const B = canonicalPath(b);', false],
    ['a DERIVED value on the left — not this question', 'if (x === path.dirname(canonicalPath(p))) go();', false],
    // …and the shapes it must NOT claim. `canonicalPath` is a legitimate, load-bearing export;
    // a guard that banned every use of it would push the cheapest green towards deleting the
    // canonicalisation, which is the failure the realpath table above exists to prevent.
    ['a plain assignment', 'const normalizedPath = canonicalPath(p);', false],
    ['a return', 'return canonicalPath(raw);', false],
    ['a Map key', 'seen.set(canonicalPath(p), entry);', false],
    ['composed into a join', 'return path.join(canonicalPath(path.dirname(p)), path.basename(p));', false],
    ['samePath, the fix itself', 'if (samePath(projectRoot, repoRoot)) return;', false],
  ])('canonicalPath-compare regex: %s', (_label, line, shouldMatch) => {
    expect(BANNED_CANONICAL_COMPARE.test(line)).toBe(shouldMatch);
  });

  /** The EXEMPTION's own falsifiability (#910). The negative row is the load-bearing one: if this
   *  matched an ordinary comparison, the guard would silently stop banning the shape it exists for. */
  /** Rows assert the SCAN's verdict — `banned && !exempt` — not the token regex in isolation.
   *  An earlier version tested `ENTRYPOINT_IDIOM` alone, and one of its rows contained no `===`
   *  at all, so it could not have said anything about the shape being exempted (close-out review). */
  it.each([
    ['the real entry-point line is exempt',
      'return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(process.argv[1]);', false],
    ['⚠️ a repo root derived from import.meta.url is NOT exempt — the #892 defect the loose form let through',
      'if (canonicalPath(projectRoot) === canonicalPath(path.dirname(fileURLToPath(import.meta.url)))) return;', true],
    ['an ordinary directory comparison is caught',
      'if (canonicalPath(projectRoot) === canonicalPath(repoRoot)) return;', true],
    ['the accepted looseness: an argv[1] comparison is exempt, and that is stated not hidden',
      'if (canonicalPath(process.argv[1]) === canonicalPath(stored)) return;', false],
  ])('canonicalPath scan: %s', (_label, line, shouldFlag) => {
    expect(BANNED_CANONICAL_COMPARE.test(line) && !ENTRYPOINT_ARGV.test(line)).toBe(shouldFlag);
  });

  it('no file compares two canonicalPath() results (#892)', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (BANNED_CANONICAL_COMPARE.test(line) && !ENTRYPOINT_ARGV.test(line)) offenders.push(`  ${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      '`canonicalPath` is the SPELLING canonicaliser: for a path that does not exist it falls\n'
      + 'back to `path.resolve`, which resolves no symlinks — so a comparison built on it says\n'
      + '"different" about two spellings of one missing path (#892, and #881 before it).\n'
      + 'Use `samePath` / `isUnderOrSame` from engine/scripts/pathIdentity.mjs, which compare in\n'
      + '`canonicalWithMissingTail`. Do NOT fix this by removing the canonicalisation:\n'
      + offenders.join('\n'),
    ).toHaveLength(0);
  });

  /** Non-vacuity for ALL THREE scans, and the half that is easy to forget: a guard collecting offenders
   *  and asserting the list is empty goes GREEN when its matching silently breaks (docs/windows.md
   *  § Paths — "the loud failure is the lucky one"). `files.length > 0` above proves we read
   *  something; this proves the two regexes still FIND the shapes in a real repo file when they
   *  are present, rather than having been narrowed into never matching anything. */
  it('both scans still detect their shape in real source (non-vacuity)', () => {
    // ⚠️ Through `readScannedSource`, not `fs.readFileSync` — `commentStripperIsShared` (#812)
    // bans a raw read of repo source that is then pattern-matched, and this assertion is exactly
    // that shape. The first draft used `fs.readFileSync` and reddened that guard, correctly.
    //
    // ⚠️ An earlier version of this comment "measured" that the SSOT's prose could not satisfy
    // the pattern, and the measurement was FALSE TWICE OVER: it counted `.native` (5) and reported
    // it as `realpathSync.native` (3), and the very next commit in the same change added a second
    // parenthesised occurrence, invalidating the "only once" half. That is the defect this whole
    // change is about, committed in prose — twice, in a commit whose message claimed the opposite.
    // The rule needs no count: read code as code, because prose that satisfies a pattern is always
    // one edit away and nothing announces that edit.
    const ssot = readScannedSource(path.join(repoRoot, 'engine/scripts/pathIdentity.mjs')).code;
    // The SSOT's body is the one place `.native` legitimately appears — it must be found by a
    // `realpathSync` search and NOT by the ban.
    expect(ssot).toMatch(/realpathSync\.native\(/);
    expect(BANNED_REALPATH.test('fs.realpathSync.native(resolved)')).toBe(false);
    expect(BANNED_REALPATH.test('fs.realpathSync(resolved)')).toBe(true);
    expect(BANNED.test('if (path.resolve(a) === b) return;')).toBe(true);
    // (#892) The third scan, held to the same bar: it must find the shape in the SSOT's OWN
    // history — this is `samePath`'s body as it stood before #892 — and must not fire on the body
    // that replaced it, which is what the file really contains now.
    expect(BANNED_CANONICAL_COMPARE.test('return pathCaseKey(canonicalPath(a)) === pathCaseKey(canonicalPath(b));')).toBe(true);
    expect(BANNED_CANONICAL_COMPARE.test('return pathCaseKey(canonicalWithMissingTail(a)) === pathCaseKey(canonicalWithMissingTail(b));')).toBe(false);
    expect(ssot).toMatch(/canonicalWithMissingTail\(a\)/);
  });
});
