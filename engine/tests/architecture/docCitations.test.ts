/** Guard: a path cited in prose or in a docblock actually resolves on disk (#194).
 *
 *  `docs/doc-conventions.md` already states the rule — a landed plan gets folded into its
 *  feature doc and the tracker deleted, and where source cites it by path, *every citation is
 *  repointed in the same commit*, verified with `grep -rl <old-name>`. Twenty plans went the
 *  first three steps and skipped the last. Nothing caught it, which is why it recurred: #193
 *  found one instance (`docs/todo.md`), #194 generalized it to 20 dead doc paths cited by 42
 *  files, 21 of them source.
 *
 *  The SAME defect has a second, larger face that #194's query could not see: docs citing
 *  SOURCE paths that no longer exist. The runtime/ -> runtime/core/ layering reorg
 *  (docs/architecture-layers.md) moved dozens of files, and 12 docs were left pointing at the
 *  pre-move paths — three of them contradicting themselves, citing the old path in one section
 *  and the new one in another. A guard covering only the doc->doc half would let the doc->source
 *  half refill on the next reorg, so both are enforced here.
 *
 *  Why a test and not a lint rule: the citation lives in prose, not in an import, so nothing in
 *  the module graph can see it. A stale pointer costs an agent a wrong-file read and, worse,
 *  reads as authoritative — CLAUDE.md's "observe, don't infer" rule assumes the pointer is at
 *  least aimed at a real file.
 *
 *  SCOPE, deliberately:
 *  - Rule 1 (doc paths) scans the WHOLE repo, because the #194 finding was that most offenders
 *    are `.ts`/`.tsx` docblocks, not prose.
 *  - Rule 2 (source paths) scans `docs/**` only, and skips `docs/reviews/**`: a review is a
 *    dated point-in-time snapshot, so citing the tree as it stood is correct by construction.
 *    Deleting a file a review discussed must not turn that review red.
 *  - Neither rule checks LINE numbers, only paths. A `file.ts:123` citation rots silently on
 *    every edit above line 123; the fix for that is to cite the symbol, not to guard the number.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasInternalGames } from '../helpers/repoLayout';

const repoRoot = path.resolve(__dirname, '../../..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'ios', 'android', 'coverage', '.agent-memory',
  'build', 'ads', 'Pods', '.next', 'out', 'test-results', 'playwright-report',
]);

const TEXT_EXT = /\.(md|ts|tsx|mjs|cjs|js|sh|yml|yaml)$/;

/** Enumerate through GIT, not the filesystem, so BUILD OUTPUT can never be mistaken for the repo.
 *
 *  A hand-maintained `SKIP_DIRS` cannot win this: a packaged `.app` under `release/` embeds a
 *  whole copy of `engine/` at `Contents/Resources/app.asar.unpacked/`, frozen at whenever that
 *  build ran, so every citation the repo has since repointed reappears as an offender — five of
 *  them here, on a clone whose tracked tree was clean. Worse, it is MACHINE-DEPENDENT: the guard
 *  is green on a clone that has never run `dist:mac` and red on one that has, which reads as
 *  "the merge broke it" rather than "the guard is looking outside the repo".
 *
 *  `--cached --others --exclude-standard` = tracked files PLUS new untracked ones, minus
 *  everything `.gitignore` covers. The `--others` half matters: a citation you just wrote and
 *  have not staged is exactly when this guard is most useful, so enumerating only `--cached`
 *  would defer every finding to after the `git add`. Nested worktrees/submodules would need
 *  `--recurse-submodules`; this repo has none (the clones are independent, see CLAUDE.md).
 */
function repoFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean);
  return out
    .filter((p) => TEXT_EXT.test(p))
    .filter((p) => !p.split('/').some((seg) => SKIP_DIRS.has(seg)))
    .map((p) => path.join(repoRoot, p))
    // A tracked file can be absent from the working tree mid-rebase or after a manual delete;
    // reading it would throw and fail the guard for a reason that has nothing to do with citations.
    .filter((p) => fs.existsSync(p));
}

const rel = (p: string) => path.relative(repoRoot, p).split(path.sep).join('/');
const exists = (p: string) => fs.existsSync(path.join(repoRoot, p));

/* ------------------------------------------------------------------ Rule 1 */

/** Files whose `docs/**.md` mentions are NOT citations. Each needs a reason — an entry here is
 *  a hole in the guard, so it should be obviously-correct, not merely convenient. */
const DOC_CITATION_EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'engine/tests/assets/scanPublishSafety.test.ts',
    reason:
      'Writes temp FIXTURE files under a scratch dir to exercise the publish scanner. Those are '
      + 'inputs it creates, not pointers to real docs.',
  },
  {
    file: 'engine/tests/architecture/docCitations.test.ts',
    reason:
      'This file. Its exemption reasons and error strings necessarily quote doc paths, including '
      + 'absent ones — a guard that fails on its own explanation of why something is absent.',
  },
];

/** Retired docs that are still NAMED on purpose, and the doc that absorbed each.
 *
 *  `doc-conventions.md` says a landed plan is folded into its feature doc and the tracker deleted,
 *  with git as the archive. The feature doc that absorbs it routinely says so — "graduated from X",
 *  "folded from X when that tracker closed", "the original plan (see the deleted X)". That
 *  provenance is worth keeping: it tells the next reader which git history to go read. It is the
 *  opposite of the defect this guard exists for, which is a live `see X` POINTER aimed at nothing.
 *
 *  So the rule is not "never name a deleted doc" — it is "naming one is a deliberate act you
 *  record here". Adding an entry is cheap; the list existing is what keeps the deletion visible
 *  instead of silent. If you find yourself adding an entry for a citation that reads as a live
 *  pointer ("see X for the details"), repoint it instead — that is the #194 defect, not history. */
const RETIRED_DOCS_NAMED_ON_PURPOSE: ReadonlyArray<{ cited: string; absorbedBy: string }> = [
  { cited: 'docs/cloud-editor.md', absorbedBy: 'nothing — cloud cancelled 2026-07-01, GCP torn down; the teardown plan (docs/plans/cloud-teardown-and-migration-plan.md) was itself the deletion record and is now deleted too, folded rationale living in docs/site-hosting.md' },
  { cited: 'docs/cloud-editor-embedded-claude.md', absorbedBy: 'nothing — same' },
  { cited: 'docs/cloud-editor-typescript-editor-plan.md', absorbedBy: 'nothing — same' },
  { cited: 'docs/plans/cloud-teardown-and-migration-plan.md', absorbedBy: 'docs/site-hosting.md — landed (cloud cancelled, GCP torn down, load balancer retired); tracker deleted per doc-conventions.md' },
  { cited: 'docs/plans/court-art-direction.md', absorbedBy: 'games/court/art.md' },
  { cited: 'docs/plans/court-tray-readability-plan.md', absorbedBy: 'games/court/art.md' },
  { cited: 'games/court/art-direction.md', absorbedBy: 'games/court/art.md' },
  { cited: 'docs/plans/court-prototype-plan.md', absorbedBy: 'games/court/{hints,levels,tutorial}.md — each says which phases it absorbed' },
  { cited: 'docs/plans/forest-camp-demo-plan.md', absorbedBy: 'demos/forest-camp/CLAUDE.md' },
  { cited: 'docs/plans/engine-oss-public-repo.md', absorbedBy: 'docs/engine-oss-publishing.md (its own "Graduated from" line)' },
  { cited: 'docs/plans/gcp-lb-retirement-plan.md', absorbedBy: 'docs/site-hosting.md § "Why a Worker"' },
  { cited: 'docs/plans/scene-view-gizmo-plan.md', absorbedBy: 'docs/scene-view-gizmo.md (its own "Graduated from" line)' },
  { cited: 'docs/plans/trusted-device-input-plan.md', absorbedBy: 'docs/trusted-device-input.md (its own "replaced" line)' },
  { cited: 'docs/plans/advideo-playable-export-plan.md', absorbedBy: 'docs/playable-export.md; docs/bundle-new-tools.md names it as the origin of that playbook' },
  { cited: 'docs/plans/low-end-device-support.md', absorbedBy: 'docs/rendering.md § "Quality tiers" (landed rationale — GPU identity, the boot ramp probe, the cpuLimited promotion licence) + docs/plans/texture-lod-by-tier.md (the unstarted remainder); the superseded plan is preserved in git at 4fc02890' },
  // Not retired — NEVER WRITTEN. A plan proposing a doc it did not get to, or a code comment
  // that cited a write-up nobody ever wrote. The latter is its own small hazard: it reads exactly
  // like a live pointer, so an agent spends a search before concluding there is nothing to find.
  { cited: 'docs/environment-maps.md', absorbedBy: 'nothing — never created; Phase 5 folded the HDR/UltraHDR pipeline into docs/textures.md § "Environment maps (HDR / UltraHDR)" instead of a standalone doc' },
  { cited: 'docs/plans/asset-inspector-plan.md', absorbedBy: 'docs/textures.md + docs/model-pipeline.md — landed (all 5 phases); tracker deleted per doc-conventions.md' },
  { cited: 'docs/profiler.md', absorbedBy: 'nothing: docs/plans/profiler.md proposes creating it as its own fold-in target' },
  { cited: 'docs/percept-plan.md', absorbedBy: 'nothing — never existed. docs/todo.md § Deferred decisions names it as the provenance of the build-mode-enum entry, whose pointer in engine/app/main.tsx aimed here (#194)' },
];

/** Directories whose mentions are not citations by this repo's own rules. */
function isNonCitingSource(relFile: string): boolean {
  // A review is a DATED point-in-time snapshot (docs/README.md § Reviews). Citing the tree as it
  // stood is the whole point, so deleting a doc a review discussed must not turn that review red.
  if (relFile.startsWith('docs/reviews/')) return true;
  // site/docs/reference/ is GENERATED and gitignored — site/sync-reference.mjs copies the public
  // subset of docs/ there on every build. It therefore carries whatever staleness docs/ has, and
  // fixing it means fixing the source doc. Failing on the copy would report every defect twice
  // and, worse, invite someone to "fix" a file the next build overwrites.
  if (relFile.startsWith('site/docs/reference/')) return true;
  return false;
}

/** Roots a `docs/…` path may legitimately resolve under. `site/` carries the published docs
 *  site, where `docs/guide/*.md` really lives at `site/docs/guide/*.md`. */
const DOC_ROOTS = ['', 'site'];

/** True only where the FULL `docs/` tree is present.
 *
 *  The OSS snapshot trims docs as well as games: `docs/plans/`, `docs/reviews/`, and the three
 *  private top-level docs (`todo`, `doc-conventions`, `engine-oss-publishing`) are all dropped by
 *  publish-engine-oss.sh. A shipped doc citing `docs/todo.md` is therefore CORRECT here and
 *  unresolvable there — measured: the snapshot flagged exactly that, from five call sites.
 *
 *  Gated on the docs tree rather than on project presence deliberately. Both happen to be false in
 *  the snapshot, but "are the private docs here" is what this rule actually depends on, and the
 *  repoLayout helpers warn in as many words against gating on a proxy that merely correlates. */
function hasFullDocsTree(): boolean {
  return fs.existsSync(path.join(repoRoot, 'docs/todo.md'))
    && fs.existsSync(path.join(repoRoot, 'docs/plans'));
}

describe('cited doc paths resolve (#194)', () => {
  it('the enumeration found the repo — a vacuous pass is a failure', () => {
    // Both rules below iterate `repoFiles()`, so if git returns nothing (run outside a checkout,
    // an `ls-files` flag that stops matching) every assertion passes by checking zero files and
    // the green tick is indistinguishable from an honest one. The floors sit far under the real
    // counts — thousands of text files, ~90 citing markdown ones — so only a broken enumeration
    // trips them, never ordinary churn.
    expect(repoFiles().length).toBeGreaterThan(200);
    expect(citingMarkdownFiles().length).toBeGreaterThan(20);
  });

  it('every docs/**.md path mentioned anywhere in the repo exists', (ctx) => {
    if (!hasFullDocsTree()) {
      ctx.skip();
      return;
    }
    const exempt = new Set(DOC_CITATION_EXEMPT.map((e) => e.file));
    const historical = new Set(RETIRED_DOCS_NAMED_ON_PURPOSE.map((e) => e.cited));
    const offenders = new Map<string, Set<string>>();

    for (const file of repoFiles()) {
      const relFile = rel(file);
      if (exempt.has(relFile) || isNonCitingSource(relFile)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const m of line.match(/docs\/[A-Za-z0-9._/-]+\.md/g) ?? []) {
          const cited = m.replace(/[.,)]+$/, '');
          if (historical.has(cited)) continue;
          if (DOC_ROOTS.some((r) => exists(r ? `${r}/${cited}` : cited))) continue;
          if (!offenders.has(cited)) offenders.set(cited, new Set());
          offenders.get(cited)!.add(`${relFile}:${i + 1}`);
        }
      });
    }

    const report = [...offenders.entries()]
      .sort()
      .map(([p, sites]) => `${p}\n    cited by: ${[...sites].sort().join(', ')}`);

    expect(
      report,
      'these docs were deleted or renamed without repointing their citations. '
        + 'doc-conventions.md: repoint every citation in the SAME commit that moves the doc — '
        + 'fold the content into the feature doc and point there, or drop the pointer if the '
        + 'surrounding text stands on its own.',
    ).toEqual([]);
  });

  it('every retired-doc entry names a doc that is still absent', () => {
    // Same reason as the source-path version below: a revived doc leaves behind an entry that
    // silently stops guarding, and nobody dares delete an entry they cannot explain.
    const stale = RETIRED_DOCS_NAMED_ON_PURPOSE
      .filter((e) => DOC_ROOTS.some((r) => exists(r ? `${r}/${e.cited}` : e.cited)))
      .map((e) => `${e.cited} — now exists; drop this entry (absorbed by: ${e.absorbedBy})`);
    expect(stale, 'RETIRED_DOCS_NAMED_ON_PURPOSE has entries that are no longer needed').toEqual([]);
  });
});

/* ------------------------------------------------------------------ Rule 2 */

/** Roots a source-path citation in a doc may resolve under. Docs write these relative to the
 *  package src (`runtime/core/version.ts`), the repo (`engine/scripts/foo.mjs`), or a project
 *  (`runtime/systems.ts` inside a game) — all are idiomatic here, so all are tried. */
const SOURCE_ROOTS = [
  '',
  'engine/packages/modoki/src',
  'engine/packages/modoki',
  'engine/tests',
  'engine/app',
  'engine',
  'node_modules', // three/examples/jsm/... — docs cite three.js internals by their import path
];

function projectRoots(): string[] {
  const out: string[] = [];
  for (const container of ['games', 'demos']) {
    const dir = path.join(repoRoot, container);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(`${container}/${e.name}`);
    }
  }
  return out;
}

/** Citations that intentionally name a file that does not exist. Every entry states why —
 *  without the reason this list becomes the place stale pointers go to hide.
 *
 *  `in` scopes an entry to ONE citing file. Use it whenever the exemption is a property of the
 *  sentence rather than of the path: a doc that names `runtime/setup.ts` to say the project
 *  *has no such file* is asserting its ABSENCE, which is both true and useful — but exempting
 *  that path repo-wide would green-light a genuinely stale pointer to it in some other doc. */
const SOURCE_CITATION_EXEMPT: ReadonlyArray<{ cited: string; reason: string; in?: string }> = [
  // --- Named to assert the file is ABSENT. The claim is true; there is nothing to repoint.
  {
    cited: 'runtime/setup.ts',
    in: 'demos/2d-physics-demo/CLAUDE.md',
    reason: '"No runtime/setup.ts, systems.ts, traits.ts, or ui/" — the demo is stock engine traits '
      + 'only, and saying so is the point of the line',
  },

  // --- Deleted ON PURPOSE, and the doc's subject IS the deletion.
  { cited: 'app/cloudAuth.tsx', reason: 'cloud-teardown plan: names what it deleted (2026-07-01 cancellation)' },
  { cited: 'app/debug/cloudBridge.ts', reason: 'cloud-teardown plan: names what it deleted' },
  { cited: 'app/backendBaseBoot.ts', reason: 'cloud-teardown plan: names what it deleted' },
  { cited: 'scripts/build-cloud.mjs', reason: 'cloud-teardown plan: names what it deleted' },
  { cited: 'engine/tests/editor/cloudEditorEnv.test.ts', reason: 'cloud-teardown plan: names what it deleted' },
  { cited: 'engine/tests/ui/cloudAuthGate.test.tsx', reason: 'cloud-teardown plan: names what it deleted' },
  { cited: 'tests/editor/cloudEditorEnv.test.ts', reason: 'cloud-teardown plan: names what it deleted' },
  { cited: 'tests/ui/cloudAuthGate.test.tsx', reason: 'cloud-teardown plan: names what it deleted' },

  // --- Not built yet. A plan naming its future file is the plan doing its job.
  { cited: 'editor/inspectorRegistry.ts', reason: 'custom-editor-windows-inspectors plan: proposed, unbuilt' },
  { cited: 'electron/toolchainHost.ts', reason: 'editor-toolchain-layer plan: proposed, unbuilt' },
  { cited: 'scripts/stage-node.cjs', reason: 'editor-toolchain-layer plan: proposed, unbuilt' },
  { cited: 'tests/sling-trait-hygiene.test.ts', reason: 'entity-id-guard plan: proposed, unbuilt' },
  // #288 (mcp-five-capability-gaps plan). Scoped with `in` so the exemption cannot silently
  // cover a second doc later. DELETE BOTH once the phases land — the plan says so in its
  // handoff, because an exemption that outlives its file is how this guard goes blind.
  {
    cited: 'editor/animation/poseClip.ts',
    in: 'docs/plans/mcp-five-capability-gaps-plan.md',
    reason: '#288 Phase 4: the pose path extracted out of AnimationEditor.tsx — proposed, unbuilt',
  },
  {
    cited: 'editor/panels/createRegisteredAsset.ts',
    in: 'docs/plans/mcp-five-capability-gaps-plan.md',
    reason: "#288 Phase 5: runCreate's body extracted out of Assets.tsx — proposed, unbuilt",
  },

  // --- A worked example, not a pointer.
  { cited: 'scripts/stage-foo.cjs', reason: 'bundle-new-tools.md: placeholder name in a how-to template' },
];

/** Every `.md` whose source-path citations must resolve: the engine docs, plus every `CLAUDE.md`
 *  and its generated `AGENTS.md` mirror (#195).
 *
 *  `CLAUDE.md` earns the stricter treatment, not the looser one: it is loaded into an agent's
 *  context AUTOMATICALLY at session start, so a wrong path there is believed by default rather
 *  than merely followed once. The root file was found citing `runtime/traits/Time.ts` — moved to
 *  `runtime/core/traits/Time.ts` by the layering reorg — precisely because the #194 rule stopped
 *  at `docs/**`. */
function citingMarkdownFiles(): string[] {
  return repoFiles().filter((f) => {
    const r = rel(f);
    if (!r.endsWith('.md')) return false;
    if (isNonCitingSource(r)) return false;
    if (r.startsWith('docs/')) return true;
    return r === 'CLAUDE.md' || r.endsWith('/CLAUDE.md') || r === 'AGENTS.md' || r.endsWith('/AGENTS.md');
  });
}

/** Which roots a citation in `relFile` may resolve under.
 *
 *  A PROJECT's `CLAUDE.md` writes paths relative to that project (`runtime/systems.ts` means
 *  `games/sling/runtime/systems.ts`), so it resolves against its own directory plus the engine —
 *  deliberately NOT against sibling projects. Nearly every project has a `runtime/systems.ts`, so
 *  allowing siblings would let sling's doc cite a file only chess has and still pass, which is a
 *  guard that reports green on the exact mistake it exists to catch. `docs/**` keeps the wide list
 *  because an engine doc legitimately cites any project by full path. */
function rootsFor(relFile: string): string[] {
  const m = /^((?:games|demos)\/[^/]+)\//.exec(relFile);
  if (m) return [m[1], ...SOURCE_ROOTS];
  return [...SOURCE_ROOTS, ...projectRoots()];
}

describe('source paths cited in docs and CLAUDE.md resolve (#194, second face; #195)', () => {
  it('every runtime/editor/engine source path cited in docs/** or a CLAUDE.md exists', (ctx) => {
    // An engine doc legitimately cites a GAME's file by its project-relative path —
    // `runtime/services/CapacitorLLMService.ts` (llm-test), `runtime/shaders/planet.ts`
    // (space-console), `tests/haptics.test.ts`. Those resolve on a real clone and CANNOT in the
    // OSS snapshot, which ships no `games/`. Running the rule there asks a question whose answer
    // depends on the checkout rather than on whether the doc is right: measured, the snapshot
    // reported 11 such "missing" paths, every one present and correct here.
    //
    // `hasInternalGames()` rather than an inline `games/` check — project presence is asked in
    // exactly ONE place (#98, projectPresencePredicate.test.ts, which caught the inline version of
    // this). It is also the STRICT predicate, which is the one this rule wants: the snapshot ships
    // demos, so `hasAnyProject()` would be true there and skip nothing.
    if (!hasInternalGames()) {
      ctx.skip();
      return;
    }
    // AGENTS.md is a GENERATED mirror of the CLAUDE.md beside it (npm run sync:agent-configs), so
    // it reproduces that file's sentences verbatim. Match a scoped exemption against the SOURCE
    // file, or every `in:` entry would need a near-duplicate for its mirror — and the mirror is
    // regenerated, so the two can never legitimately disagree.
    const asSource = (f: string) => f.replace(/(^|\/)AGENTS\.md$/, '$1CLAUDE.md');
    const isExempt = (cited: string, citingFile: string) => SOURCE_CITATION_EXEMPT.some(
      (e) => e.cited === cited && (e.in === undefined || e.in === asSource(citingFile)),
    );
    const offenders = new Map<string, Set<string>>();

    // Anchored at a known top-level segment so ordinary prose ("the .ts file") cannot match.
    // `tsx` precedes `ts` and the trailing look-ahead is load-bearing: `ts|tsx` would match the
    // `.ts` inside `.tsx`, and `js` would match the `.js` inside `.json` — both produce
    // confident, entirely fictional "missing file" reports.
    const RE = /(?:runtime|editor|three|app|electron|plugins|scripts|tools|tests)\/[A-Za-z0-9._/-]+\.(?:tsx|ts|mjs|cjs|js)(?![A-Za-z0-9])/g;

    for (const file of citingMarkdownFiles()) {
      const relFile = rel(file);
      const roots = rootsFor(relFile);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const m of line.match(RE) ?? []) {
          const cited = m.replace(/[.,)]+$/, '');
          if (isExempt(cited, relFile)) continue;
          if (roots.some((r) => exists(r ? `${r}/${cited}` : cited))) continue;
          if (!offenders.has(cited)) offenders.set(cited, new Set());
          offenders.get(cited)!.add(`${relFile}:${i + 1}`);
        }
      });
    }

    const report = [...offenders.entries()]
      .sort()
      .map(([p, sites]) => `${p}\n    cited by: ${[...sites].sort().join(', ')}`);

    expect(
      report,
      'these docs point at source files that have moved or gone. Repoint them to the real path '
        + '(the layering reorg moved much of runtime/* under runtime/core/*), or — if the file '
        + 'is absent on purpose (a plan naming an unbuilt file, a doc describing its own '
        + 'deletion) — add it to SOURCE_CITATION_EXEMPT above WITH a reason.',
    ).toEqual([]);
  });

  it('every exemption names a path that is still absent', () => {
    // An exemption whose file came back is dead weight that silently stops guarding. Fail so the
    // list stays honest rather than accumulating entries nobody dares delete.
    // Resolve each entry the way the rule above would resolve it — a file-scoped entry against
    // ITS citing file's roots. Checking a scoped entry against the wide root list would call
    // `runtime/setup.ts` "back" the moment any project has one, which most do.
    const stale = SOURCE_CITATION_EXEMPT
      .filter((e) => rootsFor(e.in ?? '').some((r) => exists(r ? `${r}/${e.cited}` : e.cited)))
      .map((e) => `${e.cited}${e.in ? ` (in ${e.in})` : ''} — now exists; drop this exemption (${e.reason})`);
    expect(stale, 'exemption list has entries that are no longer needed').toEqual([]);
  });
});

/* ------------------------------------------------------------------ Rule 3 */

/** Rule 3: a cited SECTION (`… test-cost.md § 8a-bis`) names a heading that exists.
 *
 *  Rules 1 and 2 check that a cited PATH resolves. That is not enough where a doc is cited by
 *  section: `games/court/test-cost.md` is pointed at by 15 source files, several of them by
 *  section number (`§ 6`, `§ 7b`, `§ 8a-bis`), because the sections carry the reasoning the
 *  code depends on. Renumbering one breaks every citation of it and NOTHING notices — the path
 *  still resolves, so rule 1 stays green while the pointer now aims at different prose. That is
 *  the same defect #194 was about, one level finer, and the doc itself asks callers not to
 *  renumber precisely because nothing enforced it.
 *
 *  SCOPE, deliberately narrow so this cannot cry wolf:
 *  - Only a `§` that FOLLOWS a doc path within a short window is attributed to that doc. A bare
 *    `§ 5` elsewhere in a file usually refers to the file's own sections, and guessing at those
 *    would fail on correct prose.
 *  - Only NUMERIC-style ids (`6`, `7b`, `8a-bis`) are checked. Citations by quoted title
 *    (`§ "a gate that still pays is not a gate"`) or by word (`§ Phase 5`) are skipped: they are
 *    rarer, and matching them on prose would be guesswork rather than a check.
 *  - ⚠️ Only docs that NUMBER their headings are checked at all. Measured when this rule was
 *    added: `docs/connect-claude-code.md`, `docs/ui-system.md`, `docs/audio-plan.md` and
 *    `CLAUDE.md` are all cited as `§ N` while defining zero numbered headings, so there the `§`
 *    means something else (a legacy scheme, a subsection like `§5.3`, a line). Checking those
 *    would fail on prose this guard has no business judging. The cost of that narrowing is
 *    real and is stated in the report rather than hidden: a dangling `§` in an UNNUMBERED doc
 *    is not caught here.
 */
const SECTION_CITE = /([A-Za-z0-9_./-]+\.md)\)?[^\n§]{0,60}§\s*([0-9]+[a-z]*(?:-bis)?)(?![.\d])/g;

/** Heading ids a markdown doc actually defines: `## 6. …`, `### 8a-bis. …`, `## ⚠️ 0. …`. */
function headingIds(absDoc: string): Set<string> {
  const ids = new Set<string>();
  for (const line of fs.readFileSync(absDoc, 'utf8').split('\n')) {
    const m = /^#{2,4}\s+(?:[^\w\s]+\s+)*([0-9]+[a-z]*(?:-bis)?)\./.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

describe('cited doc SECTIONS resolve', () => {
  it('every `<doc>.md § N` names a heading that doc defines', () => {
    if (!hasFullDocsTree()) return; // OSS snapshot trims docs/plans + games; nothing to check.

    const offenders: string[] = [];
    let checked = 0;

    for (const abs of repoFiles()) {
      const relFile = rel(abs);
      if (isNonCitingSource(relFile)) continue;
      if (relFile === 'engine/tests/architecture/docCitations.test.ts') continue; // this file
      const text = fs.readFileSync(abs, 'utf8');

      for (const m of text.matchAll(SECTION_CITE)) {
        const [, citedPath, section] = m;
        // Resolve the cited doc relative to the citing file first (most citations are relative),
        // then from the repo root (bare `docs/…` form).
        const candidates = [
          path.resolve(path.dirname(abs), citedPath),
          path.join(repoRoot, citedPath),
        ];
        const target = candidates.find((c) => fs.existsSync(c) && c.endsWith('.md'));
        if (!target) continue; // rule 1 owns unresolvable paths; don't double-report them.
        const ids = headingIds(target);
        if (ids.size === 0) continue; // doc does not number its headings — see the scope note.
        checked++;
        if (!ids.has(section)) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${relFile}:${line} cites ${rel(target)} § ${section} — no such heading`);
        }
      }
    }

    // Vacuity floor: the repo really does carry dozens of these, so a regex that stops matching
    // must fail loudly rather than pass by checking nothing.
    expect(checked, 'no section citations found at all — the matcher is broken').toBeGreaterThan(10);
    expect(
      [...new Set(offenders)].sort(),
      'these citations name a section that does not exist. Either the heading was renumbered '
        + '(repoint the citation) or the section was renamed away — see docs/doc-conventions.md.',
    ).toEqual([]);
  });
});
