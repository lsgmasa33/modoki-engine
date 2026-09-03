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
 *  - Rule 1b (markdown LINK targets, #578) scans the whole repo too, and for the same reason —
 *    a markdown link in a `.ts` docblock is rendered into the generated API reference, so it is
 *    a live link wherever it sits. It excludes `oss/**`, an overlay whose files are copied to
 *    the PUBLIC repo root and whose relative paths therefore resolve against a different tree.
 *    This is the rule that carries the CONTEXT test the allowlist never had: a retired doc may
 *    be NAMED in prose (provenance) but never LINKED (a live pointer), decided by form rather
 *    than by guessing at wording.
 *  - Rule 2 (source paths) scans `docs/**` only, and skips `docs/reviews/**`: a review is a
 *    dated point-in-time snapshot, so citing the tree as it stood is correct by construction.
 *    Deleting a file a review discussed must not turn that review red.
 *  - Both exemption lists are checked in BOTH directions (#578): the thing exempted must still
 *    be absent, AND the entry must still be exempting a real citation. An entry that has stopped
 *    covering anything reads as enforcement and enforces nothing, which is how 9 of 22 and 10 of
 *    14 entries came to be pure bookkeeping before anything asked.
 *  - No rule checks LINE numbers, only paths. A `file.ts:123` citation rots silently on
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
 *  pointer ("see X for the details"), repoint it instead — that is the #194 defect, not history.
 *
 *  `absorbedByPaths` is the CHECKED existence-claim(s) for each entry — usually the doc(s) that
 *  entry's OWN `absorbedBy` prose names as still live, so a fold into a doc that was ITSELF later
 *  deleted gets caught (#578) instead of silently reading as historical bookkeeping forever. It is
 *  a separate, explicit field rather than something parsed out of `absorbedBy` — that prose is
 *  free-form ("X — landed…", "X + Y; the superseded plan is preserved…",
 *  "games/court/{hints,levels,tutorial}.md"), and regex-guessing the live target back out of it
 *  would be exactly the kind of "merely convenient, not obviously correct" hole the comment on
 *  `DOC_CITATION_EXEMPT` above warns against.
 *
 *  ⚠️ NOT the same shape as `absorbedBy` itself — an entry whose prose STARTS "nothing" (no doc
 *  directly absorbed this one) can still have a non-empty `absorbedByPaths`, when the prose goes on
 *  to name a doc the claim actually rests on ("nothing: docs/plans/profiler.md proposes creating it
 *  as its own fold-in target"). A secondary "named as provenance in X" / "X names it as the origin"
 *  mention elsewhere in the prose is EXCLUDED whenever the entry already has a primary target next
 *  to it (`docs/bundle-new-tools.md` on the advideo-playable-export entry; `games/court/menu.md` and
 *  its siblings on the ui-scroll-view entry) — those are citing files, not fold targets, and
 *  checking them would couple this list to churn in files this guard has no business tracking. The
 *  ONE case a provenance mention IS included is the ONE case there is no primary target to check
 *  instead: `docs/percept-plan.md` "never existed", so `docs/todo.md` — the only doc the prose names
 *  that should currently exist — is the whole claim, not an addition to a fuller one. Every entry
 *  below has at least one path for exactly this reason; see the "shape" test below.
 *
 *  `citedBy` is the third checked field, and the one that makes "a deliberate act you record here"
 *  true rather than aspirational (#578). `cited` is a bare path, so without it an entry exempts
 *  every mention of that doc in every file forever, including files written years later that never
 *  passed a human's judgement about whether the mention is provenance or a live pointer. With it,
 *  a new citing file goes red and somebody decides. Keep it in sync by running the guard: its
 *  failure message names the exact file to add or drop, so nothing here is transcribed by hand.
 *
 *  A `docs/plans/*.md` tracker is a legitimate target (e.g. an unlanded plan proposing to create the
 *  retired doc's replacement) — when that plan itself later lands and its tracker is deleted per
 *  `doc-conventions.md`, THIS test is expected to go red on the entry pointing at it, exactly like
 *  the "still absent" check below expects a revived `cited` doc to go red. That is the mechanism
 *  working, not a false positive: fix the entry in the same commit that deletes the tracker. */
const RETIRED_DOCS_NAMED_ON_PURPOSE: ReadonlyArray<{
  cited: string; absorbedBy: string; absorbedByPaths: string[]; citedBy: string[];
}> = [
  { cited: 'docs/plans/court-store-plan.md', absorbedBy: 'games/court/ads.md — §§ 2-4 folded in (the catalog, the standing rules, the grant hook); the condensed § "A guard whose premise can lie" carries three of the ten close-out-catalogue instances, the rest preserved only in git history', absorbedByPaths: ['games/court/ads.md'], citedBy: ['games/court/accounts.md', 'games/court/ads.md', 'games/court/runtime/store.ts', 'games/court/runtime/storeUi.ts', 'games/court/runtime/systems.ts', 'games/court/tests/store.test.ts', 'games/court/tests/storeUi.test.ts'] },
  { cited: 'docs/plans/court-prototype-plan.md', absorbedBy: 'games/court/{hints,levels,tutorial}.md — each says which phases it absorbed', absorbedByPaths: ['games/court/hints.md', 'games/court/levels.md', 'games/court/tutorial.md'], citedBy: ['games/court/hints.md', 'games/court/levels.md', 'games/court/tutorial.md'] },
  { cited: 'docs/plans/forest-camp-demo-plan.md', absorbedBy: 'demos/forest-camp/CLAUDE.md', absorbedByPaths: ['demos/forest-camp/CLAUDE.md'], citedBy: ['demos/forest-camp/AGENTS.md', 'demos/forest-camp/CLAUDE.md'] },
  { cited: 'docs/plans/engine-oss-public-repo.md', absorbedBy: 'docs/engine-oss-publishing.md (its own "Graduated from" line)', absorbedByPaths: ['docs/engine-oss-publishing.md'], citedBy: ['docs/engine-oss-publishing.md'] },
  { cited: 'docs/plans/gcp-lb-retirement-plan.md', absorbedBy: 'docs/site-hosting.md § "Why a Worker"', absorbedByPaths: ['docs/site-hosting.md'], citedBy: ['docs/site-hosting.md'] },
  { cited: 'docs/plans/scene-view-gizmo-plan.md', absorbedBy: 'docs/scene-view-gizmo.md (its own "Graduated from" line)', absorbedByPaths: ['docs/scene-view-gizmo.md'], citedBy: ['docs/scene-view-gizmo.md'] },
  { cited: 'docs/plans/trusted-device-input-plan.md', absorbedBy: 'docs/trusted-device-input.md (its own "replaced" line)', absorbedByPaths: ['docs/trusted-device-input.md'], citedBy: ['docs/trusted-device-input.md'] },
  { cited: 'docs/plans/advideo-playable-export-plan.md', absorbedBy: 'docs/playable-export.md; docs/bundle-new-tools.md names it as the origin of that playbook', absorbedByPaths: ['docs/playable-export.md'], citedBy: ['docs/bundle-new-tools.md'] },
  { cited: 'docs/plans/low-end-device-support.md', absorbedBy: 'docs/rendering.md § "Quality tiers" (landed rationale — GPU identity, the boot ramp probe, the cpuLimited promotion licence) + docs/plans/texture-lod-by-tier.md (the unstarted remainder); the superseded plan is preserved in git at 4fc02890', absorbedByPaths: ['docs/rendering.md', 'docs/plans/texture-lod-by-tier.md'], citedBy: ['docs/plans/texture-lod-by-tier.md', 'engine/packages/modoki/tests/runtime/qualityTier.test.ts'] },
  { cited: 'docs/plans/per-group-sync.md', absorbedBy: 'docs/cloud-sync.md (the rulings, the ordering fix for the first-solve payout, the still-open narrowed-dialog note) + games/court/accounts.md/ads.md (the worked Court-specific detail, already current); #532 landed, tracker deleted per doc-conventions.md', absorbedByPaths: ['docs/cloud-sync.md', 'games/court/accounts.md', 'games/court/ads.md'], citedBy: ['docs/cloud-sync.md', 'games/court/accounts.md'] },
  { cited: 'docs/plans/ui-scroll-view-plan.md', absorbedBy: 'docs/ui-system.md § "Scroll views and recycled entries" — all 11 steps landed (#250 + #316); tracker deleted per doc-conventions.md (#319). Named as provenance in games/court/runtime/levelSelect.ts and games/court/runtime/systems.ts (predictions the plan got wrong) and entriesLayout.test.ts (the step-0 spike history); games/court/menu.md named it too until that mention was dropped, which is why citedBy is the checked field and this prose is not', absorbedByPaths: ['docs/ui-system.md'], citedBy: ['engine/packages/modoki/tests/runtime/entriesLayout.test.ts', 'games/court/runtime/levelSelect.ts', 'games/court/runtime/systems.ts'] },
  { cited: 'docs/cloud-editor.md', absorbedBy: 'docs/connect-claude-code.md § "What happened to the cloud editor" — cancelled 2026-07-01; that doc IS the replacement (the user\'s own Claude Code, not a hosted one). Recoverable only from tag archive/feat-cloud-editor, never merged to this history', absorbedByPaths: ['docs/connect-claude-code.md'], citedBy: ['docs/connect-claude-code.md'] },
  { cited: 'docs/cloud-editor-typescript-editor-plan.md', absorbedBy: 'docs/connect-claude-code.md § "What happened to the cloud editor" — same cancellation; also only on tag archive/feat-cloud-editor', absorbedByPaths: ['docs/connect-claude-code.md'], citedBy: ['docs/connect-claude-code.md'] },
  { cited: 'docs/plans/cloud-teardown-and-migration-plan.md', absorbedBy: 'docs/connect-claude-code.md § "What happened to the cloud editor" — the one cloud doc that WAS on this history (deleted in c9ebdb38d, so --diff-filter=D finds it); it was itself the record of what the teardown deleted', absorbedByPaths: ['docs/connect-claude-code.md'], citedBy: ['docs/connect-claude-code.md'] },
  { cited: 'docs/plans/court-art-direction.md', absorbedBy: 'games/court/art.md (its own "Folded from" line)', absorbedByPaths: ['games/court/art.md'], citedBy: ['games/court/art.md'] },
  { cited: 'docs/plans/court-tray-readability-plan.md', absorbedBy: 'games/court/art.md (its own "Folded from" line)', absorbedByPaths: ['games/court/art.md'], citedBy: ['games/court/art.md'] },
  { cited: 'docs/plans/asset-inspector-plan.md', absorbedBy: 'docs/textures.md + docs/model-pipeline.md, each carrying its own half. Phases 1-4b landed; Phase 5 ("Docs + polish") did NOT — the tracker was deleted in c9ebdb38d with all three of its items unchecked, the first being the fold-in this entry records', absorbedByPaths: ['docs/textures.md', 'docs/model-pipeline.md'], citedBy: ['docs/model-pipeline.md', 'docs/textures.md'] },
  // Not retired — NEVER WRITTEN. A plan proposing a doc it did not get to, or a code comment
  // that cited a write-up nobody ever wrote. The latter is its own small hazard: it reads exactly
  // like a live pointer, so an agent spends a search before concluding there is nothing to find.
  { cited: 'docs/cloud-editor-embedded-claude.md', absorbedBy: 'nothing — NEVER WRITTEN. Cited by the teardown record, but present in no commit on any ref, so there is nothing to recover; docs/connect-claude-code.md says so in as many words', absorbedByPaths: ['docs/connect-claude-code.md'], citedBy: ['docs/connect-claude-code.md'] },
  { cited: 'docs/environment-maps.md', absorbedBy: 'nothing — never created. docs/plans/asset-inspector-plan.md Phase 5 PROPOSED it ("a new docs/environment-maps.md for the HDR pipeline") and that phase never ran; the pipeline is documented in docs/textures.md § "Environment maps (HDR / UltraHDR)", written by c9ebdb38d rather than by the phase', absorbedByPaths: ['docs/textures.md'], citedBy: ['docs/textures.md'] },
  { cited: 'docs/profiler.md', absorbedBy: 'nothing: docs/plans/profiler.md proposes creating it as its own fold-in target', absorbedByPaths: ['docs/plans/profiler.md'], citedBy: ['docs/plans/profiler.md'] },
  { cited: 'docs/percept-plan.md', absorbedBy: 'nothing — never existed. docs/todo.md § Deferred decisions names it as the provenance of the build-mode-enum entry, whose pointer in engine/app/main.tsx aimed here (#194)', absorbedByPaths: ['docs/todo.md'], citedBy: ['docs/todo.md'] },
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

/** Roots a `docs/…` path cited BY `relFile` may resolve under.
 *
 *  A PROJECT may carry its OWN `docs/` folder — `games/wordweave/docs/feel.md` — and its
 *  `CLAUDE.md` cites it project-relatively as `docs/feel.md`, exactly as that file writes every
 *  other path. Resolving only against the repo root would make every correct link into a project's
 *  own docs an offender, since the literal substring `docs/feel.md` is unavoidable in a working
 *  relative link. This is the same project-relative rule `rootsFor` applies to source paths.
 *
 *  Siblings are deliberately excluded, for `rootsFor`'s reason: most projects would come to have a
 *  `docs/feel.md`, so allowing them would let one project cite a doc only another has and still
 *  pass — green on the exact mistake the rule exists to catch.
 *
 *  ⚠️ KNOWN BLIND SPOT, measured and deliberately accepted. This is a UNION, so a citation passes
 *  if the name resolves under EITHER root — and a project doc whose name collides with a repo-root
 *  one (`architecture.md`, `build.md`, `rendering.md`, `save.md`) is therefore satisfied by the
 *  root twin even when the project's own file is gone. Verified: deleting
 *  `games/wordweave/docs/architecture.md` leaves this rule GREEN, while deleting `docs/feel.md`
 *  (no root twin) fails it correctly.
 *
 *  Both stricter rules were tried and both are WRONG, which is why the union stands. Ordering the
 *  roots fixes nothing — `.some()` asks "does this exist anywhere", so which root answers first is
 *  invisible to a boolean. Resolving a project's citations against the project ALONE breaks real,
 *  correct ones: `games/wordweave/runtime/screen.ts` cites the engine's `docs/editor.md`, and a
 *  path relative to `runtime/` cannot express a repo-root doc readably.
 *
 *  So the collision case is covered where it can be — by the PROJECT, in its own test, asserting
 *  the docs its `CLAUDE.md` points at exist (see `games/wordweave/tests/docs.test.ts`). A guard
 *  that cannot tell two identical strings apart is the wrong place to fix an ambiguity in them. */
function docRootsFor(relFile: string): string[] {
  const m = /^((?:games|demos)\/[^/]+)\//.exec(relFile);
  return m ? [...DOC_ROOTS, m[1]] : DOC_ROOTS;
}

/** True only where the FULL `docs/` tree is present.
 *
 *  The OSS snapshot trims docs as well as games: `docs/plans/`, `docs/reviews/`, and the three
 *  private top-level docs (`todo`, `doc-conventions`, `engine-oss-publishing`, `devices`,
 *  `apple-signing`, `projects`, `model-routing` — seven, and the list grows) are all dropped by
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

/** Every markdown link target on `line` that names a `.md` file the filesystem can answer for.
 *
 *  Both link forms, because handling only the inline one would leave a hole that the reference
 *  form silently fits through. The repo has exactly one reference definition today
 *  (`docs/iap.md`'s `[tn3186]: https://…`), which this correctly ignores as external — covering
 *  the form now costs one regex and means a relative one added later is seen on arrival.
 *
 *  Excluded, each because the filesystem is not the right authority for it:
 *  - `http(s):`/`mailto:` and bare `#anchor` — not file paths at all.
 *  - A leading `/` — URL-absolute for the published docs site, where the root is `site/docs/`, not
 *    the repo. Resolving it here would answer a question nobody asked. None exist today.
 *  - Any target not ending `.md` (after the anchor is stripped) — images, source files and
 *    directories are rule 2's and the asset guards' business, not this one's. */
function markdownLinkTargets(line: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const target = raw.replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(https?:|mailto:|\/)/.test(target)) return;
    if (!target.endsWith('.md')) return;
    // A PLACEHOLDER is not a path, and the filesystem has no opinion on one. Two live shapes:
    // a documented template (`](games/<id>/CLAUDE.md)` in projectDocs.test.ts, describing a link
    // FORM) and a generated one (`](${m.slug}.md)` in gen-memory-index.mjs, which writes the real
    // link at run time). Checking either asks whether a file named `<id>` exists.
    if (/[<>]|\$\{|\$\(/.test(target)) return;
    out.push(target);
  };
  for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) push(m[1]);
  const refDef = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
  if (refDef) push(refDef[1]);
  return out;
}

/** Rule 1's scan, factored out so the load-bearing check (#578) can run the SAME matcher with
 *  the allowlist emptied.
 *
 *  Deliberately not a second, private matcher: two would be free to disagree, and the
 *  disagreement would be SILENT in the direction that matters — an entry would read as
 *  load-bearing here while rule 1 never actually needed it, which is the exact "reads as
 *  enforcement, enforces nothing" defect #578 was filed about, reintroduced by the fix for it.
 *
 *  Returns cited-path → the `file:line` sites that named it. */
function scanDocPathCitations(historical: ReadonlySet<string>): Map<string, Set<string>> {
  const exempt = new Set(DOC_CITATION_EXEMPT.map((e) => e.file));
  const offenders = new Map<string, Set<string>>();
  for (const file of repoFiles()) {
    const relFile = rel(file);
    if (exempt.has(relFile) || isNonCitingSource(relFile)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // The match keeps any PREFIX the citation carries, because a `docs/…` tail can be the end
      // of a longer, perfectly good relative path — `docs/projects.md` cites
      // `../games/wordweave/docs/feel.md`, and reading only the `docs/feel.md` tail out of it
      // asks whether a file exists at the repo root that was never claimed to be there.
      for (const m of line.match(/(?:[A-Za-z0-9._-]+\/)*docs\/[A-Za-z0-9._/-]+\.md/g) ?? []) {
        const full = m.replace(/[.,)]+$/, '');
        const cited = full.slice(full.indexOf('docs/'));
        if (historical.has(cited)) continue;
        // A prefixed citation is relative to the CITING file's own directory. `path.relative`
        // back to a repo-relative path so `exists` (which is repo-root-anchored) can answer.
        if (full !== cited) {
          const resolved = path.relative(
            repoRoot, path.resolve(path.dirname(path.join(repoRoot, relFile)), full),
          );
          const ok = !resolved.startsWith('..') && exists(resolved);
          // ⚠️ An EXPLICITLY relative citation (`./` or `../`) is judged only by that
          // resolution — it names a path, and a path that does not exist is wrong however many
          // other files share its tail. Falling through to the root union here was the whole
          // defect this branch was added to fix, restored one line later: a bogus
          // `../games/wordweave/docs/rendering.md` in `docs/projects.md` passed, satisfied by
          // the repo-root `docs/rendering.md` twin. Unlike the documented bare-name blind spot
          // below, nothing about this case is ambiguous.
          //
          // A NON-relative prefix keeps the fallback: `docs/multi-ai-cli-support.md` writes
          // `site/docs/guide/ai-assistants.md` repo-anchored, which resolves under a root rather
          // than beside the citing file.
          if (/^\.\.?\//.test(full)) {
            if (ok) continue;
            if (!offenders.has(full)) offenders.set(full, new Set());
            offenders.get(full)!.add(`${relFile}:${i + 1}`);
            continue;
          }
          if (ok) continue;
        }
        if (docRootsFor(relFile).some((r) => exists(r ? `${r}/${cited}` : cited))) continue;
        if (!offenders.has(cited)) offenders.set(cited, new Set());
        offenders.get(cited)!.add(`${relFile}:${i + 1}`);
      }
    });
  }
  return offenders;
}

/** A fence OPENER or CLOSER, allowing the list marker that made the first version of this wrong.
 *
 *  ⚠️ The list-marker alternative is load-bearing, and omitting it is worse than tracking no
 *  fences at all. A fence opened inside a list item (`  - ```js`) does not match a
 *  leading-whitespace-only pattern, but its indented CLOSE does — so the toggle flips ON at the
 *  close and never flips back, and the link rule goes silent for the rest of the file while still
 *  reporting green. Two `qa/cases/particles/*.md` files have exactly that shape, and the first
 *  version of this skip blinded the rule to the last 51 lines of one and the last 50 of the other.
 *
 *  Known limit: a docblock fence closed as ` *``` ` (no space after the asterisk) would match the
 *  opener pattern and not the closer, reproducing the same leak. None exist today. */
const FENCE_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:```|~~~)/;

/** Markdown link targets in a document, with fenced blocks skipped.
 *
 *  A doc demonstrating link syntax inside a fence is showing an example, not citing — the failure
 *  this prevents is a confident false red in the one place someone documents this very rule.
 *
 *  Extracted from the rule below so the fence handling can be unit-tested on a synthetic fixture.
 *  It could not be before, and that mattered: the broken first version passed the whole suite,
 *  because the 101 lines it suppressed happened to contain no link targets. Reverting the fix
 *  left `checked` at exactly its usual value and `offenders` empty, so neither the vacuity floor
 *  nor any real-repo assertion could tell. A guard whose own regression is invisible to the gate
 *  is the thing this file exists to prevent.
 *
 *  ⚠️ Deliberately DIFFERENT from rule 1, which counts a path named inside a fence as a citation.
 *  That is not a contradiction — they ask different questions. A path in a shell example
 *  (`git show <tag>:docs/x.md`) is a real reference and should resolve; a markdown LINK in a fence
 *  is syntax being displayed. `docs/connect-claude-code.md` relies on the first half: the only
 *  citation sites for two retirement entries are the `git show` lines in its fenced block. */
function documentLinkTargets(lines: string[]): Array<{ line: number; target: string }> {
  const out: Array<{ line: number; target: string }> = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (FENCE_LINE.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    for (const target of markdownLinkTargets(line)) out.push({ line: i + 1, target });
  });
  return out;
}

/** Every site naming `cited`, across BOTH key spaces `scanDocPathCitations` produces.
 *
 *  ⚠️ The scan has two. An EXPLICITLY relative citation (`../../docs/plans/foo.md`) is keyed by the
 *  full written path, because that is what the reader must fix; everything else is keyed by the
 *  bare `docs/…` tail. The retirement allowlist, though, is checked against the TAIL either way
 *  (`historical.has(cited)`, before the relative branch) — so a relative citation of a retired doc
 *  is exempted under one key and reported under another.
 *
 *  Looking up `wouldFlag.get(e.cited)` alone therefore misses it, and misses it in the direction
 *  that matters: a NEW file citing a retired doc relatively would inherit the exemption without
 *  anyone deciding, which is verbatim the defect #578 was filed about. The mirror-image failure is
 *  worse than a miss — an entry whose citations all became relative would be reported "nothing
 *  cites it; drop this entry", and following that instruction turns rule 1 red.
 *
 *  Found in close-out review, not by the six mutations that shipped with the first draft: every
 *  one of them perturbed a NON-relative citation, so all six agreed with the bug. */
function sitesNaming(scanned: Map<string, Set<string>>, cited: string): Set<string> {
  const out = new Set<string>();
  for (const [key, sites] of scanned) {
    const i = key.indexOf('docs/');
    if (i === -1 || key.slice(i) !== cited) continue;
    for (const s of sites) out.add(s);
  }
  return out;
}

describe('cited doc paths resolve (#194)', () => {
  it('the enumeration found the repo — a vacuous pass is a failure', () => {
    // Both rules below iterate `repoFiles()`, so if git returns nothing (run outside a checkout,
    // an `ls-files` flag that stops matching) every assertion passes by checking zero files and
    // the green tick is indistinguishable from an honest one. The floors sit far under the real
    // counts — thousands of text files, well over a hundred citing markdown ones — so only a broken enumeration
    // trips them, never ordinary churn.
    expect(repoFiles().length).toBeGreaterThan(200);
    expect(citingMarkdownFiles().length).toBeGreaterThan(20);
  });

  it('every docs/**.md path mentioned anywhere in the repo exists', (ctx) => {
    if (!hasFullDocsTree()) {
      ctx.skip();
      return;
    }
    const offenders = scanDocPathCitations(
      new Set(RETIRED_DOCS_NAMED_ON_PURPOSE.map((e) => e.cited)),
    );

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

  it('documentLinkTargets: a fence hides its own contents and nothing after it (#578)', () => {
    // The regression test the fence fix did not have. Reverting FENCE_LINE to a
    // leading-whitespace-only pattern leaves the real-repo assertions green — the lines that
    // version suppressed contain no link targets — so this synthetic fixture is the only thing
    // standing between that one-character mistake and a silently half-dead rule.
    // ⚠️ The fence OPENER must sit on the list-marker line (`   - ```js`), closed by a
    // whitespace-only line — that is the shape in qa/cases/particles/*.md, and it is the only
    // shape that distinguishes the two regexes. The first draft of this fixture put the marker on
    // its OWN line above an indented fence, which BOTH versions handle identically: it passed
    // under the broken regex too, so it pinned nothing. A fixture that cannot fail is the same
    // defect as a guard that cannot fail, one level down.
    const doc = [
      '[a](one.md)',
      '```',
      '[b](inside-a-plain-fence.md)',
      '```',
      '[c](two.md)',
      '   - ```js',
      '     [d](inside-a-list-fence.md)',
      '     ```',
      '[e](three.md)',       // ← invisible to the broken regex: the close latched the fence ON
      '   1. ~~~',
      '     [f](inside-a-tilde-fence.md)',
      '     ~~~',
      '[g](four.md)',
      // The JSDoc asterisk is the marker shape with real VOLUME here (12 lines across
      // scene3DSync/gizmo3dAim/decomposeTrs/…), and it was the one arm the fixture missed:
      // mutating `[-*+]` to `[-+]` left the test green. Harmless today — all 12 are balanced and
      // hold no links — but an unbalanced one would latch the fence exactly as `- ` did.
      ' * ```ts',
      ' * [h](inside-a-docblock-fence.md)',
      ' * ```',
      '[i](five.md)',
    ];
    expect(documentLinkTargets(doc)).toEqual([
      { line: 1, target: 'one.md' },
      { line: 5, target: 'two.md' },
      { line: 9, target: 'three.md' },
      { line: 13, target: 'four.md' },
      { line: 17, target: 'five.md' },
    ]);
  });

  it('every retired-doc entry is still LOAD-BEARING (#578)', (ctx) => {
    // The list's stated purpose is that naming a deleted doc is "a deliberate act you record
    // here" — which reads as a two-way claim and was only ever checked one way. The sibling test
    // below asks "is the cited doc still absent"; nothing asked the other half: is this entry
    // still EXEMPTING anything? Measured when #578 was written: 9 of 22 entries matched no
    // mention anywhere in the repo, their only occurrence being this file. That is the same
    // defect the issue was filed about — an entry that reads as enforcement and enforces nothing —
    // just pointed at the list itself, and 41% of it had drifted there unnoticed.
    //
    // ⚠️ Eight of those nine are BACK, and the round trip is the lesson. Deleting them was right
    // and incomplete: their `absorbedBy` prose was, for four of them, the only written record that
    // the cloud editor was cancelled and its docs deleted — and doc-conventions.md says that
    // rationale belongs in the doc that absorbed it, which did not have it. Writing it into
    // connect-claude-code.md / art.md / textures.md / model-pipeline.md made those retired docs CITED
    // again, so the entries are load-bearing now for the right reason. An entry earning its place
    // back is this check passing, not failing. (The ninth, `games/court/art-direction.md`, carries
    // no `docs/` segment, so rule 1's regex can never match it and no entry can ever be
    // load-bearing for it — the documented bare-name blind spot, not drift.)
    //
    // The check runs the REAL rule-1 scan with the allowlist emptied, rather than a private
    // string search, so "would rule 1 have flagged this" is answered by rule 1's own matching.
    // A second matcher here could disagree with it, and the disagreement would be invisible: this
    // test would report an entry as load-bearing that rule 1 never actually needed.
    // hasInternalGames() as well as the docs tree: many citations these entries cover live under
    // games/** and demos/forest-camp/, neither of which the OSS snapshot ships, so
    // without games/ those entries read as inert and this goes red. It is masked in the snapshot
    // today only because publish-engine-oss.sh ALSO strips docs/todo.md — i.e. by a hand-maintained
    // grep list in a shell script, in another language, that nobody here would think to check
    // before editing. (The first draft omitted this and its commit message claimed otherwise; the
    // staged-snapshot check could not tell, because the snapshot fails both predicates at once.)
    if (!hasFullDocsTree() || !hasInternalGames()) {
      ctx.skip();
      return;
    }
    const wouldFlag = scanDocPathCitations(new Set());
    const inert = RETIRED_DOCS_NAMED_ON_PURPOSE
      .filter((e) => sitesNaming(wouldFlag, e.cited).size === 0)
      .map((e) => `${e.cited} — nothing in the repo cites it; drop this entry (absorbed by: ${e.absorbedBy})`);
    expect(
      inert,
      'a RETIRED_DOCS_NAMED_ON_PURPOSE entry exempts no citation — the last mention it covered '
        + 'was edited away, so it is bookkeeping that reads as enforcement. Delete it; git holds '
        + 'the history the entry was preserving.',
    ).toEqual([]);
  });


  it('every retired-doc entry\'s citedBy names exactly the files that cite it (#578)', (ctx) => {
    // The allowlist's second unchecked half. `cited` is a bare path, so an entry exempts EVERY
    // mention of that doc, everywhere, in any wording and in any file — including a file that did
    // not exist when the entry was written. That is what "path-level allowlist with no context
    // test" means in practice: the deliberate act the list claims to record happened once, for the
    // citations that existed then, and every citation added since inherited the exemption silently.
    //
    // Pinning the citing FILES makes the act recur. A new file citing a retired doc goes red, and
    // whoever wrote it decides then — is this provenance (record the file) or a live pointer
    // (repoint it)? — which is the decision the list was always supposed to be capturing.
    //
    // Files, deliberately, not line numbers or mention counts:
    // - LINE numbers rot on every edit above them, and this guard already refuses to check them
    //   (see the SCOPE note at the top of the file).
    // - A COUNT would be a frozen measurement of prose in files five other clones edit
    //   concurrently, going red at the hub on a merge where both branches were green alone, and
    //   saying nothing about whether any citation is wrong.
    //   ⚠️ A file list does NOT escape that shape — it only coarsens the trigger, and this is
    //   worth stating plainly because the first draft of this comment implied immunity. One
    //   branch reflowing the last `court-store-plan.md` docblock out of `systems.ts` while
    //   another pins it is still red at a hub that wrote neither side. The defence is not that it
    //   cannot happen; it is that when it does, the red names a file and a decision a human
    //   should actually make, where a count would name a number nobody can act on.
    //
    // ⚠️ KNOWN LIMIT, stated because the shape of it is not obvious from the assertion: this
    // cannot see a live `see X` pointer added to a file that ALREADY legitimately cites X. The
    // link rule below covers the linked form of that; a new backticked prose pointer inside one of
    // the listed files stays invisible. Distinguishing it would mean guessing at prose, which is
    // the approach measured and rejected in that rule's comment.
    if (!hasFullDocsTree() || !hasInternalGames()) {
      ctx.skip();
      return;
    }
    // Gated on games/ as well as docs/: many pinned files live under `games/**`, and some under
    // `demos/forest-camp/` — neither ships in the OSS snapshot (it carries only the two demos
    // `verify:publish` names). Ungated, every one of those would report there as "no longer cites
    // it" — the same trap the absorbedByPaths test fell into. No count is quoted on purpose: three
    // rounds of review on this file have now found a stale one, and the argument never needed it.
    const wouldFlag = scanDocPathCitations(new Set());
    const drift: string[] = [];
    for (const e of RETIRED_DOCS_NAMED_ON_PURPOSE) {
      const actual = [...new Set(
        [...sitesNaming(wouldFlag, e.cited)].map((site) => site.replace(/:\d+$/, '')),
      )].sort();
      const listed = [...e.citedBy].sort();
      const dupes = listed.filter((f, i) => listed.indexOf(f) !== i);
      for (const f of new Set(dupes)) {
        drift.push(`${e.cited}: citedBy lists ${f} twice — an exact-match list that compares by `
          + 'membership cannot see the second one, so it is silent dead weight');
      }
      for (const f of actual) {
        if (!listed.includes(f)) {
          drift.push(`${e.cited}: ${f} cites it and is NOT in citedBy — add it if the mention is `
            + 'provenance, repoint the mention if it is a live pointer');
        }
      }
      for (const f of listed) {
        if (!actual.includes(f)) {
          drift.push(`${e.cited}: citedBy lists ${f}, which no longer cites it — drop it`);
        }
      }
    }
    expect(
      drift,
      'RETIRED_DOCS_NAMED_ON_PURPOSE.citedBy has drifted from the files that actually name these '
        + 'retired docs. The list exists to make naming a deleted doc a deliberate act; an '
        + 'unrecorded citing file is that act happening by default instead.',
    ).toEqual([]);
  });

  it('every markdown LINK target resolves — a link is a live pointer (#578)', (ctx) => {
    // Rule 1 above matches a `docs/…` PATH wherever it appears, which leaves two holes #578 was
    // filed for. This closes both, by matching the one citation FORM that cannot be anything but
    // a live pointer.
    //
    // ① The form is the context test. `RETIRED_DOCS_NAMED_ON_PURPOSE` exempts every mention of a
    //    path in any wording, so "folded from X" (provenance, correct) and "see X for the details"
    //    (the #194 defect) are indistinguishable to it. Distinguishing them by PROSE means guessing
    //    at marker words — measured across every mention those entries cover, a "retired|folded|
    //    deleted" heuristic misfires on prose that is already correct (`docs/bundle-new-tools.md`'s
    //    "(X) is the reason this playbook was written", `levelSelect.ts`'s "X predicted this module
    //    would be DELETED. It was wrong"), and it invites keyword-stuffing to get green. A LINK
    //    needs no heuristic: you do not link a doc you are describing as gone. So the rule is
    //    NAME a retired doc freely, never LINK one — and the allowlist deliberately does not
    //    exempt this test.
    // ② It sees citation forms rule 1's regex cannot. That regex requires a literal `docs/`
    //    segment, so every doc-to-doc link written relative from inside `docs/` is invisible to it.
    //    That is not hypothetical: `docs/build.md` carried `[plans/low-end-device-support.md]
    //    (./plans/low-end-device-support.md)` — "The intended split, per X" aimed at a tracker
    //    retired into `docs/rendering.md` — and rule 1 was green on it for as long as it stood.
    //
    // Deliberately NOT the other shape #578 listed (match the BARE filename): measured, that
    // surfaces 37 dangling names of which the overwhelming majority are noise — docblock path
    // tails split across a line wrap (`plan.md`, `persistence-plan.md`), test fixtures
    // (`nope.md`, `unread.md`), generated transients (`release-notes.md`) — and it cannot tell the
    // retired `docs/profiler.md` from the live `docs/plans/profiler.md`, so 10 correct pointers
    // flag too. Resolving a link target is the same idea with none of the guessing.
    if (!hasFullDocsTree() || !hasInternalGames()) {
      ctx.skip();
      return;
    }
    // ⚠️ GATED, and the gate is load-bearing — the sibling absorbedByPaths test learned this the
    // expensive way. publish-engine-oss.sh strips `docs/{plans,reviews}/`, seven private top-level
    // docs (todo, doc-conventions, engine-oss-publishing, devices, apple-signing, projects,
    // model-routing) and all of `games/`. Measured against that trim list: 59 links in files that
    // SURVIVE the snapshot point at targets that do not, so ungated this would fail
    // oss-ci-snapshot.yml on every push to main. Those 59 are a real publishing concern — a public
    // reader follows them into a 404 — but that belongs to the publish scanner, not here.
    const offenders: string[] = [];
    let checked = 0;
    // DOC_CITATION_EXEMPT applies here for the reason each of its entries already states: a file
    // that must QUOTE broken citations to explain them. This rule proved that immediately — the
    // paragraph below explaining why `oss/**` is excluded quotes `](CLA.md)`, and the guard
    // reported its own explanation as a defect.
    const exempt = new Set(DOC_CITATION_EXEMPT.map((e) => e.file));
    for (const file of repoFiles()) {
      const relFile = rel(file);
      if (exempt.has(relFile) || isNonCitingSource(relFile)) continue;
      // ⚠️ NOT `.md`-only. A markdown link in a `.ts` docblock is a real link — TypeDoc renders
      // it into the generated API reference — and scoping this to markdown files would leave the
      // rule's own claim ("the allowlist does not excuse a link") false everywhere source lives.
      // Markdown-link targets already sit in non-`.md` files here and resolve, so this is an
      // established convention rather than an edge case. The demonstration
      // that made it worth covering: a link to a retired doc added to `games/court/runtime/
      // store.ts` is exempted by rule 1, invisible to `citedBy`, and shipped green by a
      // `.md`-only link rule — all three holes at once.
      //
      // `oss/**` is excluded because it is an OVERLAY: its files are copied to the root of the
      // PUBLIC repo, so `](CLA.md)` in a workflow there resolves beside the file it becomes, not
      // beside the file it is. That is a different tree, and this repo cannot answer for it.
      if (relFile.startsWith('oss/')) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const { line: lineNo, target } of documentLinkTargets(lines)) {
        checked += 1;
        const resolved = path.relative(
          repoRoot, path.resolve(path.dirname(file), target),
        );
        // A target escaping the repo is wrong for the same reason a missing one is: nothing a
        // reader can follow. Reported rather than skipped, so `../../../../etc/x.md` cannot hide.
        if (!resolved.startsWith('..') && exists(resolved)) continue;
        offenders.push(`${relFile}:${lineNo} → ${target}`);
      }
    }
    // Vacuity floor, like every other rule in this file. `offenders` is only ever appended from
    // inside the `markdownLinkTargets` loop, so breaking the MATCHER makes this check zero targets
    // and report green, indistinguishable from an honest pass. The six mutations that shipped with
    // the first draft all perturbed the DATA, so not one of them could have caught that.
    //
    // ⚠️ What it does NOT catch is PARTIAL suppression — the fence bug above suppressed most of two
    // files and the count did not move at all, because the lines it ate held no link targets.
    // An aggregate floor answers "is the matcher alive", never "is it reaching everything", and
    // reading it as the stronger claim is how that bug survived its own review. (This comment
    // asserted the stronger claim in its first draft, which is the same mistake one level up.)
    expect(checked, 'the link scan matched almost nothing — the matcher is dead, not the repo')
      .toBeGreaterThan(200);
    expect(
      offenders,
      'a markdown link points at a file that does not exist. A LINK is a live pointer, so '
        + 'RETIRED_DOCS_NAMED_ON_PURPOSE does not excuse one: repoint it at whatever absorbed the '
        + 'target, or demote it to a plain backticked NAME if the mention is historical.',
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

  it('every retired-doc entry\'s absorbedByPaths still exist (#578)', (ctx) => {
    // Several absorbedByPaths targets live under games/** and demos/** (and docs/plans/**,
    // docs/todo.md, docs/engine-oss-publishing.md) — all trimmed from the public OSS snapshot by
    // publish-engine-oss.sh, same as the OTHER GATED test in this block (the one above this reads
    // only `e.cited`, asserting ABSENCE — which the snapshot satisfies just as well, gated or not).
    // Gate on BOTH here: the targets span the private docs tree AND games/, and hasFullDocsTree()
    // alone would still fail on a snapshot-shaped checkout (no games/) while it happens to keep the
    // full docs/ tree.
    if (!hasFullDocsTree() || !hasInternalGames()) {
      ctx.skip();
      return;
    }
    // The free-text `absorbedBy` prose is honest bookkeeping, but nothing checked it: a fold into
    // a doc that was itself later deleted (or renamed) would leave the ORIGINAL retirement entry
    // green forever, pointing at a target that is now just as gone as the doc it absorbed.
    //
    // Shape floor, not a count: an entry whose absorbedByPaths silently emptied out (the "nothing"
    // misreading the comment above warns against) is a hole this test can no longer see, however
    // many OTHER entries still carry paths. A total-count floor is the wrong instrument for that —
    // it measures the aggregate and the hole is per-entry, so every "nothing"-prefixed entry could
    // empty at once and still clear any floor loose enough to survive ordinary churn. (Figures used to be
    // quoted here and went stale twice in two rounds — first when the list was pruned, then when
    // entries came back. The argument never depended on them; quoting them was the mistake, and
    // the fix is not fresher numbers.)
    // Every entry has ≥1 path today for the reason stated above the array; this keeps that true.
    const emptied = RETIRED_DOCS_NAMED_ON_PURPOSE
      .filter((e) => e.absorbedByPaths.length === 0)
      .map((e) => `${e.cited}: absorbedByPaths is empty (absorbedBy: ${e.absorbedBy})`);
    expect(emptied, 'an entry\'s absorbedByPaths emptied out — it now guards nothing').toEqual([]);
    const missing = RETIRED_DOCS_NAMED_ON_PURPOSE
      .flatMap((e) => e.absorbedByPaths.map((docPath) => ({ entry: e, docPath })))
      .filter(({ docPath }) => !exists(docPath))
      .map(({ entry, docPath }) => `${entry.cited}: absorbedByPaths names "${docPath}", which does not exist (absorbedBy: ${entry.absorbedBy})`);
    expect(missing, 'a doc named in absorbedByPaths no longer exists — repoint it or fold further').toEqual([]);
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

  // --- Not built yet. A plan naming its future file is the plan doing its job.
  { cited: 'editor/inspectorRegistry.ts', reason: 'custom-editor-windows-inspectors plan: proposed, unbuilt' },
  { cited: 'tests/sling-trait-hygiene.test.ts', reason: 'entity-id-guard plan: proposed, unbuilt' },

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
    if (/^(?:games|demos)\/[^/]+\/docs\//.test(r)) return true;
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

/** AGENTS.md is a GENERATED mirror of the CLAUDE.md beside it (npm run sync:agent-configs), so it
 *  reproduces that file's sentences verbatim. Match a scoped exemption against the SOURCE file, or
 *  every `in:` entry would need a near-duplicate for its mirror — and the mirror is regenerated, so
 *  the two can never legitimately disagree. */
const asSource = (f: string) => f.replace(/(^|\/)AGENTS\.md$/, '$1CLAUDE.md');

const isExemptBySourceList = (cited: string, citingFile: string) => SOURCE_CITATION_EXEMPT.some(
  (e) => e.cited === cited && (e.in === undefined || e.in === asSource(citingFile)),
);

/** Rule 2's scan, factored out for the same reason as `scanDocPathCitations` above: the
 *  "is this exemption still load-bearing" check (#578, close-out sweep) has to ask rule 2's OWN
 *  matcher, not a lookalike.
 *
 *  The two really can disagree, and not subtly: rule 2's regex anchors at a known top-level
 *  segment, so it keys `engine/tests/editor/cloudEditorEnv.test.ts` as
 *  `tests/editor/cloudEditorEnv.test.ts` — a plain substring search would look for the engine-
 *  prefixed string rule 2 never produces. (Scoping an exemption to one citing file, and the
 *  AGENTS.md mirroring below, are two more places to get it independently wrong.) Both methods
 *  happened to agree on the 10 inert entries this found; the extraction is here so agreement is
 *  structural rather than lucky, since a divergence would be silent in the worse direction —
 *  reporting an exemption inert while rule 2 is still using it, and inviting its deletion.
 *
 *  `isExempt` is a parameter so the load-bearing check can pass a predicate that exempts nothing.
 *  Returns cited-path → the `file:line` sites that named it. */
function scanSourcePathCitations(
  isExempt: (cited: string, citingFile: string) => boolean,
): Map<string, Set<string>> {
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
  return offenders;
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
    const offenders = scanSourcePathCitations(isExemptBySourceList);

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

  it('every exemption is still LOAD-BEARING (#578 sweep)', (ctx) => {
    // The #578 defect, one list down. The sibling test below asks whether the exempted path is
    // still absent; nothing asked whether anything still CITES it. Measured when this landed:
    // 10 of 14 entries exempted nothing — worse than the 9-of-22 in RETIRED_DOCS_NAMED_ON_PURPOSE
    // that #578 was filed about, and for a traceable reason. Six named files that the retired
    // `docs/plans/cloud-teardown-and-migration-plan.md` listed as deleted; when that plan was
    // itself deleted the citations went with it, and the exemptions stayed. Nothing could see it,
    // because "the file is still absent" stays true forever once a file is gone.
    //
    // Same gate as the rule it mirrors — an entry can only be seen as load-bearing where the
    // citing docs and projects it is exempted in are actually present.
    if (!hasInternalGames()) {
      ctx.skip();
      return;
    }
    const wouldFlag = scanSourcePathCitations(() => false);
    const inert = SOURCE_CITATION_EXEMPT
      .filter((e) => {
        const sites = wouldFlag.get(e.cited);
        if (!sites) return true;
        if (e.in === undefined) return false;
        // A scoped entry is load-bearing only where IT is scoped, not wherever the path is named.
        return ![...sites].some((s) => asSource(s.replace(/:\d+$/, '')) === e.in);
      })
      .map((e) => `${e.cited}${e.in ? ` (scoped to ${e.in})` : ''} — nothing cites it; drop this exemption (${e.reason})`);
    expect(
      inert,
      'SOURCE_CITATION_EXEMPT has entries that exempt no citation — the doc that named the absent '
        + 'path was itself edited or deleted, so the entry is bookkeeping that reads as '
        + 'enforcement. Delete it; git holds the history.',
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

/** Rule 4: a `<doc>.md § "Quoted Title"` citation names a heading that doc really defines.
 *
 *  Rule 3 above checks only NUMBERED sections, and says so — which leaves every doc that titles
 *  its headings instead of numbering them (`CLAUDE.md`, `art.md`, `hints.md`, the game-local docs)
 *  unchecked. The quoted form is the commoner one: ~95 citations at the time this was added, and
 *  #328 compressed `games/court/CLAUDE.md` by 135 lines with two other docs citing its section
 *  TITLES — a rename there would have dangled silently, because rule 1 checks the path and rule 3
 *  skips unnumbered docs. That gap had to be closed by hand during that change, which is the
 *  argument for closing it here.
 *
 *  Matching is SUBSTRING, not equality: a citation legitimately quotes a fragment of a long
 *  heading — `§ "The hint system"` -> `## The hint system — the standard is not negotiable`, and
 *  `§ "BOARD space is Pixi…"` -> `## The split, now that the migration is done: BOARD space is
 *  Pixi…`. Prefix matching was tried first and produced false offenders on the second shape.
 *  Markup and leading sigils are stripped before comparing (`## ⚠️ Foo` is cited as `§ "Foo"`).
 */
const TITLE_CITE = /([A-Za-z0-9_./-]+\.md)\)?[^\n§]{0,60}§\s*[""]([^""\n]{4,80})[""]/g;

/** Normalize a heading or a cited title so prefix comparison ignores markup and sigils. */
function normHeading(t: string): string {
  return t
    .replace(/[`*_]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function headingTitles(absDoc: string): string[] {
  const out: string[] = [];
  for (const line of fs.readFileSync(absDoc, 'utf8').split('\n')) {
    const m = /^#{1,4}\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(normHeading(m[1]));
  }
  return out;
}

/** Titled section citations that dangle TODAY, ratcheted so no NEW one can land (#328).
 *
 *  ⚠️ **EMPTY, and it must stay that way — the burn-down is done (#329).** All eleven original
 *  entries were repointed rather than deleted, per `docs/doc-conventions.md`: "if the citation
 *  reads as a live pointer, repoint it instead, because that is the defect and not the exception."
 *
 *  What #329 found, which is worth knowing before adding an entry here: **the sections had NOT
 *  been "renamed substantially or folded away" — nine of the eleven pointed at material that was
 *  right there**, written as a **bold lead-in** rather than as a `#### heading`. This guard only
 *  reads headings, so an accurate citation of a bold-styled section dangles. Those were repointed
 *  to the enclosing real heading with the specific phrase kept in prose
 *  (`§ "How it works" (the "A stranded synthetic press" note)`) — the house style already used by
 *  the ABSORBED_BY table above. The other two were not citation defects at all: one was a line
 *  naming TWO docs before the `§` (the regex attributes it to the first, a human reads the
 *  second), and one was a code comment QUOTING a known-bad citation as a historical example,
 *  which rule 4 cannot tell from a live one.
 *
 *  So before ratcheting anything: check whether the target exists as non-heading text, and whether
 *  the citing line names more than one `.md`. Adding an entry to get a rename past the gate is
 *  explicitly forbidden by `docs/doc-conventions.md`; this list only ever shrinks, and the
 *  meta-test below fails if an entry stops dangling.
 */
const KNOWN_DANGLING_TITLES: ReadonlyArray<{ doc: string; title: string }> = [];

function isKnownDangling(citedDocRel: string, rawTitle: string): boolean {
  const want = normHeading(rawTitle);
  return KNOWN_DANGLING_TITLES.some(
    (e) => citedDocRel.endsWith(e.doc) && normHeading(e.title) === want,
  );
}

describe('cited doc SECTION TITLES resolve (#328)', () => {
  it('every `<doc>.md § "Title"` names a heading that doc defines', () => {
    if (!hasFullDocsTree()) return; // OSS snapshot trims docs/plans + games.

    const offenders: string[] = [];
    let checked = 0;

    for (const abs of repoFiles()) {
      const relFile = rel(abs);
      if (isNonCitingSource(relFile)) continue;
      if (relFile === 'engine/tests/architecture/docCitations.test.ts') continue; // this file
      const text = fs.readFileSync(abs, 'utf8');

      for (const m of text.matchAll(TITLE_CITE)) {
        const [, citedPath, rawTitle] = m;
        const candidates = [
          path.resolve(path.dirname(abs), citedPath),
          path.join(repoRoot, citedPath),
        ];
        const target = candidates.find((c) => fs.existsSync(c) && c.endsWith('.md'));
        if (!target) continue; // rule 1 owns unresolvable paths.
        const want = normHeading(rawTitle);
        if (want.length < 4) continue;
        checked++;
        if (isKnownDangling(rel(target), rawTitle)) continue;
        if (!headingTitles(target).some((h) => h.includes(want))) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${relFile}:${line} cites ${rel(target)} § "${rawTitle}" — no such heading`);
        }
      }
    }

    expect(checked, 'no titled section citations found — the matcher is broken').toBeGreaterThan(10);
    expect(
      [...new Set(offenders)].sort(),
      'these citations name a section TITLE that does not exist. Either the heading was renamed '
        + '(repoint the citation in the same commit) or the section was folded away — see '
        + 'docs/doc-conventions.md.',
    ).toEqual([]);
  });

  it('every KNOWN_DANGLING_TITLES entry still dangles — fixed ones must be removed', () => {
    if (!hasFullDocsTree()) return;
    const stale: string[] = [];
    for (const e of KNOWN_DANGLING_TITLES) {
      const abs = path.join(repoRoot, e.doc);
      if (!fs.existsSync(abs)) continue; // rule 1 owns missing docs.
      const want = normHeading(e.title);
      if (headingTitles(abs).some((h) => h.includes(want))) {
        stale.push(`${e.doc} § "${e.title}" resolves now — drop it from KNOWN_DANGLING_TITLES`);
      }
    }
    expect(stale.sort(), 'the ratchet only goes one way').toEqual([]);
  });
});

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
