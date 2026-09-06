/** ⚠️ **No test or script may hand-roll a repo file corpus — there is ONE producer (#799/#771/#805).**
 *
 *  Phase 1 (`5a3672cf5`, #805) added `engine/scripts/repoCorpus.mjs` — the one shared way to turn
 *  "give me a repo file corpus" into a real file list, git-backed rather than filesystem-walked,
 *  with the root/enumeration-source/exclusion/separator questions answered ONCE. Its own docblock
 *  names the two mistakes every private producer independently re-makes:
 *
 *   1. `execSync` with a shell string instead of `execFileSync` with an argv array — on Windows
 *      `execSync` spawns `cmd.exe`, which does not strip single quotes, so a quoted pathspec like
 *      `'*.scene.json'` reaches git literally and matches nothing. MEASURED live in
 *      `migrate-assets.mjs`.
 *   2. A hand-rolled `readdirSync` walker drifting from what the repo's own gates consider "the
 *      corpus" — `show-refs.mjs` rooted its walk at the wrong directory AND keyed scenes by
 *      DIRECTORY rather than extension, so files outside a `scenes/` folder were invisible
 *      regardless of the root.
 *
 *  This is Phase 2: the enforcement half. It does not migrate anyone — every file that currently
 *  hand-rolls either mistake is on the `EXEMPT` ledger below, which IS the Phase 3/4 migration
 *  backlog. The rule this enforces already lives in `docs/verify-and-ci.md` § "Source-scanning
 *  guards" (the sibling sentence for comment strippers, "Never write one. Import the shared
 *  helper.") — before this file it applied to corpus production with no test checking it, which
 *  is exactly the gap `commentStripperIsShared.test.ts` (#419) closed for comment stripping. This
 *  file is that guard's direct structural twin, one mechanism over.
 *
 *  ⚠️ **SCOPE — this guard covers `engine/tests/**` and `engine/scripts/**` ONLY, and that is a
 *  real hole, not a tidy boundary.** A close-out sweep with this file's own detector found **15**
 *  recursive walkers outside it, and the notable ones are the same mechanism, not lookalikes:
 *  five source-scanning guards in `engine/packages/modoki/tests/**` — a SECOND vitest project this
 *  never reads, including `determinismGuard` which `CLAUDE.md` calls load-bearing — and
 *  `scripts/scan-publish-safety.mjs`, which is what `npm run verify:publish` runs, walking the
 *  FILESYSTEM with its own hand-maintained skip list while `publish-engine-oss.sh` ships from
 *  `git ls-files`. Two definitions of "the corpus" for the one gate that keeps private values out
 *  of a public repo.
 *
 *  Tracked as **#814** rather than widened here: widening `under` turns this guard red until all
 *  of them are migrated, which is a phase of work, not a close-out edit. **Do not read a green run
 *  of this file as "no hand-rolled producers exist"** — it means none exist in the two trees named
 *  above. A documented gap becomes a licence exactly when nobody writes the gap down.
 *
 *  Scanned via `repoFiles()` itself — a hand-rolled walk in THIS guard would be the exact
 *  violation it exists to police, one level up. Comments are stripped with the shared
 *  `stripComments` (not a private stripper — that is `commentStripperIsShared.test.ts`'s own
 *  rule) before either pattern is matched, and `assertScanIsSane` is run on every file: these are
 *  files whose own PROSE discusses `ls-files` and `readdirSync` at length (this docblock included),
 *  so an unproven stripper here would be scanning its own false positives. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import ts from 'typescript';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** Rule 1's target, assembled from two halves rather than written as one literal — the same
 *  reason `commentStripperIsShared.test.ts`'s `BLOCK_LAZY` is split: spelling it out would make
 *  every sentence in THIS file discussing the rule (this docblock, every `reason` string below
 *  that says what a producer spawns) an offender of the rule it defines. See the self-exemption
 *  below for the one place that split still isn't enough. */
const LS_FILES_MARKER = 'ls' + '-files';

/* ------------------------------------------------------------------------------- Rule 2: AST */

/** A function found in a file, by its own binding name — a `function walk(d) {}`, a
 *  `const walk = (d) => {}`, or a `const walk = function (d) {}`. `node` is the function/arrow
 *  itself (params + body), so walking its subtree reaches nested arrow functions inside it too. */
interface FnInfo { name: string; node: ts.Node; }

function collectNamedFunctions(sf: ts.SourceFile): FnInfo[] {
  const out: FnInfo[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      out.push({ name: node.name.text, node });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        out.push({ name: node.name.text, node: init });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** True if `fnNode`'s own subtree calls `readdir`/`readdirSync`, in any member-expression form
 *  (`fs.readdirSync(...)`, bare `readdirSync(...)`, `await readdir(...)`). */
function bodyCallsReaddir(fnNode: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      if (ts.isIdentifier(expr) && (expr.text === 'readdir' || expr.text === 'readdirSync')) found = true;
      else if (
        ts.isPropertyAccessExpression(expr)
        && (expr.name.text === 'readdir' || expr.name.text === 'readdirSync')
      ) found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return found;
}

/** True if `fnNode`'s own subtree calls a function named `name` — i.e. calls itself. */
function bodyCallsOwnName(fnNode: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(fnNode);
  return found;
}

/** True if `code` contains a function that both reads a directory AND recurses into itself —
 *  the shape of a hand-rolled corpus walker, regardless of what it is named. Parses `code`
 *  (comment-stripped, so a docblock discussing this shape is not itself a hit) with the
 *  TypeScript compiler, the same tool `mjsTypeSidecars.test.ts` uses to read a plain `.mjs`. */
function hasRecursiveReaddirWalker(code: string, label: string): boolean {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      label, code, ts.ScriptTarget.Latest, /* setParentNodes */ true,
      label.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch {
    return false;
  }
  return collectNamedFunctions(sf).some((fn) => bodyCallsReaddir(fn.node) && bodyCallsOwnName(fn.node, fn.name));
}

/* ------------------------------------------------------------------------------- The ledger */

/** Every file that currently trips Rule 1 or Rule 2 — the Phase 3/4 migration backlog this guard
 *  makes visible rather than fixing. `file` is the repo-relative POSIX path `repoFiles()` itself
 *  returns as `rel` — the self-consistency is deliberate: an allowlist keyed by a `path.relative`
 *  round-trip is the very class of bug #799/#771 were filed about (see `repoCorpus.mjs`'s own
 *  docblock point 1 — the round-trip back through `node:path` is the hazard, not the join TO it).
 *
 *  Grouped by the handful of real reasons, not written per-file:
 *
 *  - ~~**PROJECT_CORPUS**~~ — **empty: Phase 3 is complete (#771).** Every producer that reached
 *    the `games/`/`demos/` project tree has been migrated onto `repoCorpus.mjs`, including the
 *    three implementations it was originally lifted from (`migrate-anchor-zindex.mjs`,
 *    `docCitations.test.ts`, `helpers/repoLayout.ts`). The bucket's constant is deleted rather
 *    than kept at zero uses — an unused reason is a category that quietly comes back.
 *  - ~~**ENGINE_SOURCE**~~ — **empty: Phase 4 batch B is complete.** The producer's root was
 *    entirely inside `engine/` (a package's `src/`, `app/`, `editor/`, `scripts/`, a tool's own
 *    `src/`, or `engine/tests` itself) — never a project — and every one of them is now migrated
 *    onto `repoCorpus.mjs`. Its constant is deleted rather than kept at zero uses, same reasoning
 *    as PROJECT_CORPUS above.
 *  - A handful of genuinely NEITHER, each with its own one-line reason below.
 */

const EXEMPT: ReadonlyArray<{ file: string; rule: 'ls-files' | 'walker'; reason: string }> = [
  /* ---------------------------------------------------------------- Rule 1: git ls-files spawns.
   * `engine/scripts/repoCorpus.mjs` itself is EXCLUDED STRUCTURALLY below (the filter that builds
   * `files`), not listed here — it is the one sanctioned caller, not a producer awaiting
   * migration onto itself. */
  {
    file: 'engine/tests/architecture/corpusProducerIsShared.test.ts', rule: 'ls-files',
    reason: 'This file. Its own rule-1 docblock and `reason` strings necessarily discuss '
      + `"${LS_FILES_MARKER}" in prose that is NOT a comment (a JS string literal, unlike a `
      + 'comment, is not blanked by stripComments) — the same self-reference '
      + 'docCitations.test.ts\'s own DOC_CITATION_EXEMPT entry explains for its rule.',
  },
  {
    file: 'engine/tests/architecture/repoCorpus.test.ts', rule: 'ls-files',
    reason: 'The POSITIVE CONTROL in its nested-checkout test must spawn raw `git ls-files` to '
      + 'establish that git surfaces a nested checkout as a bare directory entry at all — that is '
      + 'the input repoFiles() then filters, so proving it with repoFiles() would be circular and '
      + 'the test would pass whether or not the entry was ever enumerated. Not awaiting migration: '
      + 'this spawn is the assertion, not a corpus producer.',
  },

  /* --------------------------------------------------------- Rule 2: hand-rolled readdir walkers,
   * project-corpus-shaped (reach games/demos). */
  {
    file: 'engine/tests/electron/newProject.test.ts', rule: 'walker',
    reason: 'walk(target) walks an mkdtemp SCRATCH dir the test scaffolds into and deletes — '
      + 'ephemeral test output, not repo/tracked content at all.',
  },
  /* -------------------------------------------------------------- Rule 2: genuinely neither — walks
   * build output, a cache, a packaged bundle, or scratch output, none of which are repo/tracked
   * content at all. repoCorpus.mjs enumerates git-tracked-or-untracked-but-not-ignored files, so
   * it could never stand in for any of these even after a hypothetical Phase 5 — the corpus these
   * walk simply isn't the kind repoCorpus.mjs produces. */
  {
    file: 'engine/scripts/assertBundleUnchanged.mjs', rule: 'walker',
    reason: 'Walks a packaged app BUNDLE dir (a CLI arg, e.g. a signed .app) to diff its file list '
      + 'before/after a run — not repo content.',
  },
  {
    file: 'engine/scripts/clean-texture-cache.mjs', rule: 'walker',
    reason: 'Walks the local BUILD CACHE (.cache/modoki-textures) — not tracked/repo content.',
  },
  {
    file: 'engine/scripts/generate-icons.mjs', rule: 'walker',
    reason: 'Walks a project\'s own native ios/android OUTPUT tree to snapshot build collateral '
      + 'for equality-checking around the generator\'s product dir — not a source corpus.',
  },
  {
    file: 'engine/scripts/ota/buildManifest.mjs', rule: 'walker',
    reason: 'Walks a built dist/ directory (build output) to hash files for the OTA manifest — '
      + 'not repo/tracked content.',
  },
  {
    file: 'engine/scripts/scaffold-project.mjs', rule: 'walker',
    reason: 'Walks the freshly-scaffolded PROJECT OUTPUT it just copied, to token-substitute — '
      + 'ephemeral and not yet tracked at the point this runs.',
  },
  {
    file: 'engine/scripts/smoke-debug-build-flag.mjs', rule: 'walker',
    reason: 'Walks a project\'s build dist/ output for a debug-marker sweep — build output, not '
      + 'repo/tracked content.',
  },
  {
    file: 'engine/scripts/upload-dsyms.mjs', rule: 'walker',
    reason: 'Walks a depth-capped (3) DerivedData/build-product tree hunting `.dSYM` bundles — '
      + 'build output, not repo content, and already bounded rather than a general corpus walk.',
  },
];

describe('corpus producers use the shared repoFiles()/repoCorpus.mjs (#799/#771/#805 Phase 2)', () => {
  const files = repoFiles({
    under: ['engine/tests', 'engine/scripts'],
    match: /\.(ts|mjs)$/,
    exclude: ['node_modules', 'dist'],
    floor: 400,
  }).map(({ rel, abs }) => {
    const raw = fs.readFileSync(abs, 'utf8');
    return { rel, raw, code: stripComments(raw) };
  });

  it('scans a substantial, floored set of files across BOTH engine/tests and engine/scripts', () => {
    // The floor sits far under the real count (572 measured), so only a broken enumeration
    // (a wrong `under`, a `match` that stops matching) can turn this red — never ordinary churn.
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => f.rel.startsWith('engine/tests/'))).toBe(true);
    expect(files.some((f) => f.rel.startsWith('engine/scripts/'))).toBe(true);
  });

  it('the comment strip is length- and line-exact for every scanned file', () => {
    for (const f of files) assertScanIsSane(f.raw, f.code, f.rel);
  });

  it(
    'Rule 1: no file spawns `git ls-files` directly, outside the one sanctioned caller',
    () => {
      const exempt = new Set(
        EXEMPT.filter((e) => e.rule === 'ls-files').map((e) => e.file),
      );
      const offenders = files
        // repoCorpus.mjs is the ONE sanctioned caller — excluded structurally, not via EXEMPT,
        // because it is not a producer awaiting migration onto itself.
        .filter((f) => f.rel !== 'engine/scripts/repoCorpus.mjs')
        .filter((f) => !exempt.has(f.rel))
        .filter((f) => f.code.includes(LS_FILES_MARKER))
        .map((f) => f.rel);
      expect(
        offenders,
        `these files spawn \`git ${LS_FILES_MARKER}\` directly instead of importing repoFiles() `
          + `from engine/scripts/repoCorpus.mjs (#799/#771/#805):\n${offenders.join('\n')}`,
      ).toEqual([]);
    },
  );

  it('Rule 2: no file hand-rolls a recursive readdir walker', () => {
    const exempt = new Set(EXEMPT.filter((e) => e.rule === 'walker').map((e) => e.file));
    const offenders = files
      .filter((f) => !exempt.has(f.rel))
      .filter((f) => hasRecursiveReaddirWalker(f.code, f.rel))
      .map((f) => f.rel);
    expect(
      offenders,
      'these files hand-roll a recursive readdirSync walker instead of importing repoFiles() '
        + `from engine/scripts/repoCorpus.mjs (#799/#771/#805):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /* ---------------------------------------------------------- The load-bearing property (⚠️). */

  it('every EXEMPT entry is still ACTUALLY FLAGGED by the rule it claims (#799/#771/#805 Phase 2)', () => {
    // This is the mechanism that keeps the ledger honest. When Phase 3/4 migrates a walker onto
    // repoFiles(), its entry here goes STALE — the file no longer trips the rule — and this test
    // must go RED until the entry is deleted. Without this check the ledger degrades into
    // decoration: an entry that once meant something keeps "exempting" a file that would pass on
    // its own, exactly like a `docs/` allowlist entry nobody re-checks (#578's whole lesson).
    // Deliberately re-runs the REAL detectors (not a private re-implementation of the pattern) —
    // two matchers free to disagree is how a load-bearing check ends up checking nothing.
    const byRel = new Map(files.map((f) => [f.rel, f]));
    const stale: string[] = [];
    for (const e of EXEMPT) {
      const f = byRel.get(e.file);
      if (!f) {
        stale.push(`${e.file} — no longer exists in the scanned corpus; drop this entry`);
        continue;
      }
      const stillFlags = e.rule === 'ls-files'
        ? f.code.includes(LS_FILES_MARKER)
        : hasRecursiveReaddirWalker(f.code, f.rel);
      if (!stillFlags) {
        stale.push(`${e.file} (rule: ${e.rule}) — no longer trips this rule; drop this entry`);
      }
    }
    expect(
      stale,
      'a Phase 3/4 migration landed and its EXEMPT entry is now stale bookkeeping — delete the '
        + `entry (that IS the migration ledger updating itself):\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  /* ---------------------------------------------------------------------------- Non-vacuity. */

  /* Both detectors are proven alive against SYNTHETIC input, not against a floor on how many real
   * offenders remain.
   *
   * ⚠️ They were floors once (">= 5 real ls-files offenders", ">= 10 real walkers"), and Phase 3
   * broke them by SUCCEEDING: migrating the producers is the point, so the population those floors
   * measured shrinks toward zero by design, and the guard would eventually go red for having
   * nothing left to find. A pin whose premise the project is actively trying to falsify is not a
   * pin — it is a countdown. Worse, the obvious repair (lower the floor) walks it down to `>= 0`,
   * which asserts nothing at all.
   *
   * A fixed input the detector must flag holds forever, and it fails for exactly one reason: the
   * detector stopped detecting. */

  it('Rule 1\'s detector is provably alive (synthetic input, not a count of survivors)', () => {
    const offending = `const out = execFileSync('git', ['${LS_FILES_MARKER}', '-z'], { cwd: root });`;
    expect(offending.includes(LS_FILES_MARKER)).toBe(true);
    // And the negative half: something structurally similar that must NOT match.
    expect(`execFileSync('git', ['rev-parse', '--show-toplevel'])`.includes(LS_FILES_MARKER)).toBe(false);
  });

  it('Rule 2\'s detector is provably alive (synthetic input, not a count of survivors)', () => {
    // All three function shapes the detector claims to handle, each recursive AND reading a dir.
    const decl = 'function walk(d) { for (const e of fs.readdirSync(d)) { if (e.isDirectory()) walk(e); } }';
    const arrow = 'const walk = (d) => { for (const e of readdirSync(d)) { if (e.x) walk(e); } };';
    const expr = 'const walk = function (d) { const es = fs.readdirSync(d); es.forEach((e) => walk(e)); };';
    for (const [label, src] of [['decl', decl], ['arrow', arrow], ['expr', expr]] as const) {
      expect(hasRecursiveReaddirWalker(src, `synthetic-${label}.ts`), label).toBe(true);
    }

    // The negative halves — each drops exactly ONE of the two required properties, so a detector
    // that had quietly degraded to "mentions readdir" or "recurses" would fail here rather than
    // sail through on the positives above.
    const readsButNotRecursive = 'function listOnce(d) { return fs.readdirSync(d); }';
    const recursesButNoReaddir = 'function count(n) { return n <= 0 ? 0 : count(n - 1); }';
    expect(hasRecursiveReaddirWalker(readsButNotRecursive, 'synthetic-flat.ts')).toBe(false);
    expect(hasRecursiveReaddirWalker(recursesButNoReaddir, 'synthetic-norecurse.ts')).toBe(false);
  });

  /* ------------------------------------------------------------------------ Public-snapshot note.
   * `engine/tests/**` ships in the public OSS snapshot, so a floor here has to clear the
   * SNAPSHOT's count, not this clone's. It does: measured by assembling a real stage, this guard
   * scans 567 files there against `floor: 400`.
   *
   * ⚠️ An earlier version of this note said the publisher "excludes only games/". That is WRONG,
   * and the wrong model cost three red gates elsewhere in this change:
   * `scripts/publish-engine-oss.sh` is INCLUDE-ONLY — `git ls-files -- engine build docs`, ~10
   * named root files, plus `--with-demos` — and it additionally drops five named `engine/tests/**`
   * files with a `grep -vE`. The snapshot is a small explicit subset, not a subtraction, which is
   * why `engine/` surviving nearly whole is a fact to MEASURE rather than to reason to.
   */
  it('both `under` roots are really scanned, and neither has been carved up', () => {
    // Replaces a test that asserted `typeof hasInternalGames === 'function'` — which could not
    // fail, and so vouched for the note above without checking any part of it. The concrete edit
    // it missed: adding 'fixtures' to `exclude` drops the scan from 567 files to ~500 and the old
    // assertion stayed green.
    //
    // This one is falsifiable by exactly that edit. Every subdirectory below contributes real
    // files today, so carving any one of them out of the scan — by an `exclude` entry, a narrowed
    // `under`, or a `match` that stops covering an extension — turns this red and names the
    // missing one.
    const scanned = new Set(files.map((f) => f.rel.split('/').slice(0, 3).join('/')));
    const REQUIRED = [
      'engine/tests/architecture', 'engine/tests/assets', 'engine/tests/editor',
      'engine/tests/electron', 'engine/tests/fixtures', 'engine/tests/helpers',
      'engine/tests/plugins', 'engine/tests/tools',
    ];
    const missing = REQUIRED.filter((d) => ![...scanned].some((s) => s.startsWith(d)));
    expect(
      missing,
      'these directories contribute no scanned file — the corpus has been narrowed, so the '
        + '"engine/ ships whole, no gating needed" reasoning above needs re-checking',
    ).toEqual([]);
    expect(files.some((f) => f.rel.startsWith('engine/scripts/'))).toBe(true);
  });
});
