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
 *  **SCOPE — the WHOLE REPO, as of #814.** It covered `engine/tests/**` and `engine/scripts/**`
 *  only, and its own docblock called that "a real hole, not a tidy boundary" while nothing acted
 *  on the admission. Widening found **18** producers outside the old scope — including the five
 *  source-scanning guards in `engine/packages/modoki/tests/**` (a SECOND vitest project this never
 *  read, `determinismGuard` among them, which `CLAUDE.md` calls load-bearing) and two `ls-files`
 *  spawns the issue had not noticed at all. All are now migrated or on the EXEMPT ledger below.
 *
 *  ⚠️ **`scripts/scan-publish-safety.mjs` is NOT "a second definition of the corpus"** — #814
 *  filed it that way and the claim is disproved. `publish-engine-oss.sh:568` invokes it over
 *  `$STAGE`, which `:167` rsyncs from that script's OWN `git ls-files` manifest, so it is
 *  downstream of the enumeration rather than a rival to it. Measured 2026-09-06: tracked=9243,
 *  walked=24099, tracked-but-NOT-walked = **0**.
 *
 *  ⚠️ **A green run still does not mean "no hand-rolled producers exist" in one direction: the
 *  OSS snapshot.** It ships no `games/`, `site/` or `scripts/` rows, so the per-root pins and six
 *  EXEMPT entries are gated on `repoLayout`'s predicates there — see `ROOT_PRESENT`. In this repo
 *  the claim is unqualified.
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
import { hasInternalGames, hasPublishScripts } from '../helpers/repoLayout';

/** ⚠️ **The OSS snapshot ships `engine build docs` and a few root files — NO `games/`, `site/` or
 *  `scripts/` rows at all**, and it runs `npm test` on every push to `main`. So a per-root pin or
 *  an EXEMPT row naming one of those roots is definitionally unsatisfiable there, and #814's
 *  widening turned this file from "ships and passes" into "ships and fails". Gated on the thing
 *  each check actually needs, per `repoLayout.ts`'s own note about proxies. */
const ROOT_PRESENT: Record<string, boolean> = {
  'games/': hasInternalGames(),
  'site/': hasPublishScripts(),
  'scripts/': hasPublishScripts(),
};

/** True when this checkout carries the root a path lives under. Anything not listed is under
 *  `engine/`, which the snapshot always ships. */
const rootIsPresent = (rel: string): boolean =>
  Object.entries(ROOT_PRESENT).every(([root, present]) => present || !rel.startsWith(root));

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

  /* ═══════════════════════════════════════════════════════ #814: the roots the widening exposed.
   * Rule 1 first. Neither of these enumerates a corpus — both ask git a single, bounded question,
   * which repoFiles() is the wrong tool for. */
  {
    file: 'engine/electron/connectClaude.ts', rule: 'ls-files',
    reason: 'Asks `--error-unmatch` about ONE named file to answer "is this tracked?" — a '
      + 'predicate, not an enumeration. repoFiles() would list the repo to answer a yes/no about a '
      + 'single path, and its own git failure handling is the opposite of what this wants (it '
      + 'returns \'unknown\' rather than falling back to a corpus).',
  },
  {
    file: 'games/court/tests/sweepGate.test.ts', rule: 'ls-files',
    reason: 'A POSITIVE CONTROL inside a mkdtemp THROWAWAY repo the test builds commit by commit: '
      + 'it proves the merge actually carried the Court file, so the skip assertion after it is '
      + 'not vacuous. repoFiles() reads THIS repo and could not see that one. Same shape as the '
      + 'repoCorpus.test.ts entry above — the spawn IS the assertion.',
  },

  /* ─────────────────────────────────────────── Rule 2: a GAME cannot import engine/scripts (#29).
   * These three walk tracked repo content and would otherwise be straightforward migrations. They
   * are structurally barred: `games/<id>` is opened standalone and COPIED OUT of the monorepo, so
   * a relative path from a game into `engine/scripts/` resolves only while it sits here —
   * `engine/tests/assets/gamePortability.test.ts` forbids exactly that reach. It is the same
   * forced duplication that makes `courtAuthored.mjs` and `sweepGate.ts` carry two copies of
   * WATCHED, and the same one `projectRoots.mjs` documents. Not a backlog: there is nothing to
   * migrate TO from inside a game. */
  {
    file: 'games/court/tests/courtCache.ts', rule: 'walker',
    reason: 'Hashes Court\'s own source to key the sweep cache. Tracked content, but a game '
      + 'cannot import engine/scripts/repoCorpus.mjs (#29 portability, gamePortability.test.ts). '
      + 'Its HASH_ROOTS scope is a separate open question — see #830.',
  },
  {
    file: 'games/court/tests/uiFontRoots.test.ts', rule: 'walker',
    reason: 'Walks Court\'s asset tree to resolve font GUIDs. Same #29 bar as courtCache.ts.',
  },
  {
    file: 'games/sling/tests/sling-assets.test.ts', rule: 'walker',
    reason: 'Walks games/sling/runtime/assets to build a GUID->path map. Same #29 bar.',
  },

  /* ───────────────────────────────────────── Rule 2: BUILD-TIME or RUNTIME walks of a PROJECT dir
   * or of build output — not the repo corpus. repoFiles() enumerates git-tracked-or-untracked-
   * but-not-ignored files in THIS checkout, so it could not stand in for any of these even in
   * principle: the directory each one walks is handed to it at build/run time and is frequently
   * outside the repo entirely (an opened project, a dist/, a scaffold target). */
  {
    file: 'engine/electron/newProject.ts', rule: 'walker',
    reason: 'Walks the freshly-scaffolded project OUTPUT it just copied, to token-substitute — '
      + 'ephemeral and not yet tracked. Production twin of the newProject.test.ts entry above.',
  },
  {
    file: 'engine/plugins/asset-tree-shaker.ts', rule: 'walker',
    reason: 'Build-time walk of the OPEN PROJECT\'s asset tree to decide what ships. The project '
      + 'may live outside this repo (a game copied out, #29), where repoFiles() sees nothing.',
  },
  {
    file: 'engine/plugins/backend/editorBackendRouter.ts', rule: 'walker',
    reason: 'walkScripts() serves the editor backend at RUNTIME over the open project\'s dir — '
      + 'again possibly outside this repo. A git enumeration is the wrong instrument for "what is '
      + 'on disk right now" in a live editor.',
  },
  {
    file: 'engine/plugins/detect-modules.ts', rule: 'walker',
    reason: 'Build-time collectSceneFiles() over the open project\'s scenes/ subtree, to decide '
      + 'which engine modules to bundle. Project dir, not repo corpus.',
  },
  {
    file: 'engine/plugins/inlinePlayable.ts', rule: 'walker',
    reason: 'Walks the playable BUILD OUTPUT to inline and then prune it — build output, never '
      + 'tracked.',
  },
  {
    file: 'engine/plugins/vite-asset-scanner.ts', rule: 'walker',
    reason: 'Build-time scanDir() over the open project\'s assets to emit the manifest. Project '
      + 'dir, not repo corpus.',
  },
  {
    file: 'scripts/scan-publish-safety.mjs', rule: 'walker',
    reason: 'Walks the assembled SNAPSHOT STAGE, not the repo — publish-engine-oss.sh:568 invokes '
      + 'it as `scan-publish-safety.mjs "$STAGE"`, and $STAGE is rsynced (:167) from that script\'s '
      + 'OWN `git ls-files` manifest. So it is downstream of the enumeration, not a second one. '
      + '⚠️ #814 filed this as "a SECOND definition of the corpus"; that was DISPROVED and the '
      + 'issue body corrected — measured 2026-09-06, tracked=9243 walked=24099, and files tracked '
      + 'but NOT walked = 0.',
  },
  {
    file: 'site/gen-sitemap.mjs', rule: 'walker',
    reason: 'Walks site/.vitepress/dist — VitePress BUILD OUTPUT, gitignored, to emit sitemap.xml.',
  },
];

describe('corpus producers use the shared repoFiles()/repoCorpus.mjs (#799/#771/#805 Phase 2)', () => {
  const files = repoFiles({
    // ⚠️ **THE WHOLE REPO (#814).** This was `['engine/tests', 'engine/scripts']`, and that scope
    // was not a tidy boundary — it was 16 unexamined producers, including `determinismGuard`,
    // which CLAUDE.md calls load-bearing, and the publish-safety scanner. A green run used to mean
    // "no hand-rolled producers in two trees"; it now means what the rule says.
    match: /\.(ts|mjs)$/,
    exclude: ['node_modules', 'dist'],
    floor: 1500,
  }).map(({ rel, abs }) => {
    const raw = fs.readFileSync(abs, 'utf8');
    return { rel, raw, code: stripComments(raw) };
  });

  it('scans a substantial, floored set of files across EVERY root a producer can live in', () => {
    // The floor sits far under the real count (2831 measured 2026-09-06), so only a broken
    // enumeration (a `match` that stops matching, a collapsed corpus) can turn this red — never
    // ordinary churn. The per-root pins are the half that matters: an aggregate floor is satisfied
    // by `engine/` alone while `games/`, `site/` and `scripts/` contribute nothing, which is
    // exactly the shape of the scope bug this widening fixes (#814).
    expect(files.length).toBeGreaterThan(1500);
    for (const root of ['engine/tests/', 'engine/scripts/', 'engine/packages/modoki/tests/',
      'engine/plugins/', 'engine/electron/', 'games/', 'site/', 'scripts/']) {
      // Skipped in the OSS snapshot, which ships none of these roots — see ROOT_PRESENT.
      if (!rootIsPresent(root)) continue;
      expect(files.some((f) => f.rel.startsWith(root)), `no files scanned under ${root} — the `
        + 'enumeration has narrowed and this guard is silently back to covering a subset').toBe(true);
    }
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
        // ⚠️ ABSENT-BY-LAYOUT is not STALE. Six rows name files under games//site//scripts/,
        // which the OSS snapshot does not ship — reporting those as stale there would demand
        // deleting rows that are load-bearing in the private repo. Only a file whose ROOT is
        // present and which has nonetheless vanished is a real stale entry.
        if (rootIsPresent(e.file)) {
          stale.push(`${e.file} — no longer exists in the scanned corpus; drop this entry`);
        }
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
  it('the engine/tests subtree is scanned SUBDIRECTORY by subdirectory, not carved up', () => {
    // ⚠️ Renamed at #814: there is no `under` any more (the scan is the whole repo), so the old
    // title "both `under` roots" described a filter that no longer exists. The assertion still
    // earns its place and is NOT redundant with the per-root pin above: that one proves each ROOT
    // contributes, this one proves each engine/tests SUBDIRECTORY does — a finer grain, and the
    // one an `exclude` entry actually breaks.
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
