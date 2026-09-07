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
 *  make the EIGHTH copy loud. (The idiom is separately fragile on Windows — `clonePort.mjs:69` is
 *  the one site that realpaths both sides — but that is a different defect and not this guard's.)
 *
 *  **NOT banned: the case-folding hand-rolls** in `userDataDir.cloneId`, `userDataDir.multiProfileKey`
 *  and `instanceToken.rootKey`. They do not match this shape, and that is correct: those HASH the
 *  path into a PERSISTED identity (a userData profile dir, a per-project auth token), so
 *  re-normalising them relocates every existing user's profile and 403s them against their own
 *  editor. See docs/windows.md § Paths. Do not "finish the migration" by sweeping them in.
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
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** The roots whose code answers "same directory?" about a repo/project/clone root. Floored well
 *  under what each measures today, so a glob that stops matching goes RED rather than vacuous.
 *
 *  ⚠️ `engine/plugins` is in scope because `samePath` is reachable from there and three of its
 *  files answer this question (`deviceClaims.ts`, `buildLock.ts`, `editorBackendRouter.ts`).
 *  Leaving it out was a scope restriction that claimed the defect could only live in two of the
 *  three surfaces the SSOT serves (close-out review). Adding it cost nothing — measured 0 new
 *  offenders. `engine/app` is still outside: it is renderer code that does not derive repo roots. */
const ROOTS = ['engine/electron', 'engine/scripts', 'engine/plugins'];

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
});
