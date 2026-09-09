#!/usr/bin/env node
/** Per-project scoped typecheck sweep — closes the gate hole in #24.
 *
 *  `npm run typecheck` compiles ONE WIDE program: engine/tsconfig.app.json includes
 *  `app` + ALL of `../games` + `../demos`. A browser-side file can typecheck ONLY
 *  because a SIBLING project leaks ambient types into that wide program (the #24
 *  case: some other project pulled in `@types/node`, which made `node:*` resolve
 *  repo-wide) — and then fail a per-project web build, which typechecks a SCOPED
 *  config with only the active project (`build-web.mjs`). That's the gate hole: CI
 *  ran only the wide config, so the mask went uncaught until a release build hit it.
 *
 *  This script re-generates that SAME scoped-config shape (via scopedTsconfig.mjs —
 *  shared with build-web.mjs so the two can't drift) and runs `tsc -p` against each
 *  selected project INDIVIDUALLY, so a masked error surfaces here instead of in a
 *  release build.
 *
 *  ── WHICH PROJECTS (#967) ──────────────────────────────────────────────────────
 *
 *  This used to sweep all of them, always, and ran in exactly one place: the private
 *  `ci.yml`, which is `workflow_dispatch`-only and billed. Once that stopped being
 *  run the scoped typecheck ran NOWHERE and #24's hole was open again. Measured on
 *  the `work-ai` Mac clone, 2026-09-08: **~5.4s per project (Court 8.2s), ~163-170s for a full
 *  sweep** (two runs) — not payable on `npm run verify`, which is 82-86s total. ⚠️ This header is
 *  the ONE place those numbers live; verify.mjs and docs/verify-and-ci.md point here rather than
 *  restating them.
 *
 *  ⚠️ **The PROJECT COUNT is a per-CLONE fact, not a repo fact — do not publish "29".**
 *  `discoverProjects` is a filesystem readdir, and this clone has 29 directories under the two
 *  roots while `git ls-files` knows only 25: four (`games/2d-physics-demo`,
 *  `games/3d-physics-demo`, `games/agy`, `games/particle`) exist on disk with nothing tracked
 *  under them. A clean checkout sweeps 25. The per-project timings travel between clones; the
 *  count does not.
 *
 *  ⚠️ **On `main`, this leg roughly DOUBLES `verify`.** A clean checkout of `main` has
 *  `merge-base(HEAD, origin/main) === HEAD`, which is the degenerate case, which fails safe to a
 *  full sweep — so lane 2 becomes the pole and verify's documented 82-86s wall-clock does not
 *  hold there. Owner's call, taken deliberately 2026-09-08 ("keep sweeping all"): a fresh clone
 *  checking nothing and reporting green is the failure this gate exists to prevent. The
 *  compensating case is the hub's normal one — right after `git merge origin/<branch>` the
 *  `--first-parent --no-merges` walk sees nothing, so the leg selects 0 projects and costs ~0.
 *
 *  So the default is now the projects this branch actually TOUCHED, which lets it
 *  live in `verify` (see verify.mjs lane 2). That is not merely a cost dodge — the
 *  mask can only bite the project you touched:
 *
 *    - a project gains the offending import  -> checking THAT project catches it.
 *    - the sibling DROPS the leaking dep     -> the WIDE program stops resolving too,
 *                                               so `npm run typecheck` goes red first.
 *    - a new project is added                -> it is "touched" by definition.
 *    - engine `app/**` changes               -> present in the wide program AND in
 *                                               every scoped one; already covered.
 *
 *  The one thing that changes the scoped SHAPE for projects you did not touch is the
 *  scoped-config machinery itself, so touching any of MACHINERY_PATHS escalates to a
 *  full sweep.
 *
 *  ⚠️ **FAILS TOWARD SWEEPING EVERYTHING.** git unavailable, unparseable, or a
 *  degenerate `merge-base === HEAD` range (true of any checkout sitting AT
 *  `origin/main`, which a fast-forward merge produces) all mean "cannot tell", and
 *  that maps to `--all`. A detector that cannot answer must never be
 *  indistinguishable from one answering "nothing changed" — same contract, and same
 *  reasoning, as `courtTouched()` in `courtAuthored.mjs`.
 *
 *  ⚠️ **The two are told apart in the REPORT (#826).** They map to the same action, so
 *  the split buys nothing operationally — it buys the reader a true sentence. The
 *  degenerate range is not a failure and is the commonest position on the fleet, and
 *  a line reading "git could not answer" over a git that answered fine cost a session
 *  a turn of the owner's attention on the Court copy of this same code.
 *
 *  ── Other properties ───────────────────────────────────────────────────────────
 *
 *  - Distinct temp config path per project (never `tsconfig.app.scoped.json`, which a
 *    concurrent `npm run build` may be using) so this can run alongside a build.
 *    Cleaned up after itself, including on failure.
 *  - Runs ALL selected projects even after a failure — fail-fast would hide N-1 OTHER
 *    breakages — and exits non-zero if any project failed.
 *  - SERIAL on purpose. Each `tsc` compiles `app` plus one project, so N concurrent
 *    ones hold N copies of the app program in memory; this runs inside `verify`'s
 *    lane 2 alongside two vitest pools, and verify.mjs's header documents what
 *    happened last time two unbudgeted pools fought over this machine.
 *  - Prints WHY it selected what it did. A green run that silently checked nothing is
 *    the failure this script exists to prevent.
 *
 *  Usage:
 *    node engine/scripts/typecheck-projects.mjs                  # touched projects (default)
 *    node engine/scripts/typecheck-projects.mjs --all            # every project
 *    node engine/scripts/typecheck-projects.mjs wordweave court  # named projects
 *    node engine/scripts/typecheck-projects.mjs games/wordweave  # ...or root-qualified
 *    node engine/scripts/typecheck-projects.mjs --list           # print the selection, check nothing
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects, PROJECT_ROOT_DIRS } from './projectRoots.mjs';
import { MACHINERY_PATHS, countProgramFiles, foreignProjects, stripFileList,
  KNOWN_CROSS_PROJECT } from './scopedTypecheckLib.mjs';
import { scopedTsconfigContent } from './scopedTsconfig.mjs';

/** Derived from THIS FILE, never `process.cwd()` (#944, from main). The old `cwd` form made the
 *  script's subject depend on where it was invoked from: run from anywhere but the repo root it
 *  discovered zero projects, and the empty-set branch below reported that as a clean pass. A gate
 *  must always typecheck the same tree, whoever spawned it and from where.
 *
 *  ⚠️ This is also what lets a test COPY this script into a fixture tree and drive the real thing
 *  (gateEmptyResultReporting.test.ts, and typecheckProjectsSelection.test.ts here) — the copy's
 *  own location names its repo. Do not "restore" cwd to make a test easier; the test follows. */
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const engineDir = path.join(repoRoot, 'engine');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tscBin)) {
  console.error('[typecheck-projects] typescript not installed (node_modules/typescript missing) — run npm install.');
  process.exit(1);
}


/** Runs a git command in the repo, or `null` if it cannot. `null` is "could not tell",
 *  never "nothing changed" — every caller maps it to a full sweep. */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Split git's `-z` output into paths.
 *
 *  ⚠️ `-z` is load-bearing, not a style choice: without it git QUOTES any path with a
 *  space or a non-ASCII byte (`core.quotePath`), and the prefix-matching below would
 *  then fail to recognise its own project — silently checking FEWER projects, which is
 *  this gate's worst failure mode. `-z` emits raw NUL-separated paths with no quoting.
 *
 *  ⚠️ So is `--no-renames` on every caller. `--name-only` reports a rename as the DESTINATION
 *  path only, so `git mv games/alpha/globals.d.ts games/beta/globals.d.ts` selects beta and
 *  NOT alpha — while alpha's remaining files still consume that `declare global`, the wide
 *  program stays green because beta is still a root, and alpha's own web build breaks. That is
 *  precisely the #24 class this gate exists for, walking straight past it. `--no-renames` reports
 *  the pair as a delete plus an add, so both sides are seen. This is the surviving half of the
 *  warning in courtAuthored.mjs's `authoredInRange` — "prefix-matching path strings … diverges on
 *  renames, quoted paths and core.quotePath escaping". `-z` answers the quoting half; this
 *  answers the rename half. */
function zsplit(out) {
  return out.split('\0').filter((s) => s !== '');
}

/**
 * Every repo-relative path this branch changed relative to `origin/main`, or `null` if
 * git cannot answer.
 *
 * Three sources, unioned, because a project can be touched in three ways and missing any
 * one of them under-selects:
 *   1. uncommitted edits to tracked files (`diff HEAD`) — the session editing right now;
 *   2. untracked files (`ls-files --others`) — a BRAND NEW project, which has no tracked
 *      file to diff and would otherwise be invisible to a gate that only reads commits;
 *   3. commits authored on this branch's own first-parent line.
 *
 * ⚠️ (3) is `--first-parent --no-merges`, matching `authoredInRange()` in
 * courtAuthored.mjs: a commit AUTHORED here sits on that chain, while one that arrived by
 * MERGING someone else's branch hangs off a second parent and is invisible to the walk.
 * That is deliberate and it is what makes the hub cheap — CLAUDE.md's "merging is not
 * re-testing AT THE HUB" — because the clone that wrote a project's change already
 * scoped-checked it before pushing.
 */
function changedPaths() {
  const pathspec = ['games', 'demos', ...MACHINERY_PATHS];

  const dirty = git('diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...pathspec);
  if (dirty === null) return 'git-failed';

  const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec);
  if (untracked === null) return 'git-failed';

  const base = git('merge-base', 'HEAD', 'origin/main');
  if (base === null) return 'git-failed';

  // ⚠️ A branch with NO commits of its own cannot be asked what it changed, and answering
  // "nothing" there is this gate's worst failure: `merge-base(HEAD, origin/main) === HEAD`
  // on any checkout of `main` itself. That is the degenerate case, not a negative answer,
  // so it maps to "could not tell" and therefore to a FULL sweep.
  //
  // ⚠️ **#826: it returns WHICH, not a bare `null`.** The direction is unchanged — this still
  // sweeps ALL — but the printed reason used to offer the reader three candidate causes and no
  // way to tell them apart, on a line that fires for every clone sitting at `origin/main`.
  const head = git('rev-parse', 'HEAD');
  if (head === null) return 'git-failed';
  if (base.trim() === head.trim()) return 'no-own-commits';

  const committed = git('log', '--first-parent', '--no-merges', '--format=', '--name-only',
    '--no-renames', '-z', `${base.trim()}..HEAD`, '--', ...pathspec);
  if (committed === null) return 'git-failed';

  return [...zsplit(dirty), ...zsplit(untracked), ...zsplit(committed)];
}

/** Map changed paths onto projects. Returns `{ projects, reason }`; `projects === null`
 *  means "sweep everything". */
function selectTouched(all) {
  const paths = changedPaths();
  if (!Array.isArray(paths)) {
    // ⚠️ `Array.isArray`, not `=== null`: `changedPaths` returns a REASON string now, and a string
    // is truthy — a `=== null` check here would read a "cannot tell" as a real answer and then
    // treat the string's characters as paths.
    const why = paths === 'no-own-commits'
      ? 'HEAD has no commits beyond origin/main'
      : 'git could not answer (no repo, or no origin/main)';
    return { projects: null, reason: `${why} — sweeping ALL` };
  }

  const machinery = paths.filter((p) => MACHINERY_PATHS.includes(p));
  if (machinery.length > 0) {
    return { projects: null, reason: `scoped-config machinery changed (${[...new Set(machinery)].join(', ')}) — sweeping ALL` };
  }

  const touched = all.filter((proj) => {
    const prefix = `${proj.root}/${proj.name}/`;
    return paths.some((p) => p.startsWith(prefix));
  });
  return { projects: touched, reason: `projects touched vs origin/main (${touched.length} of ${all.length})` };
}


/** The scoped program's `include`: the app shell plus exactly one project. ⚠️ Changing this
 *  changes the shape for EVERY project, which is why this file is in MACHINERY_PATHS. */
function buildInclude(proj) {
  return ['app', path.relative(engineDir, proj.dir).split(path.sep).join('/')];
}

/** Which of `dirs` have at least one TypeScript source git knows about — tracked OR untracked.
 *  Used to tell "this project contributed nothing because the config is broken" (a dead gate)
 *  from "this project has no TypeScript" (games/agy), which `tsc` reports identically: exit 0.
 *  Returns `null` if git cannot answer, and the caller then declines to make that distinction
 *  rather than guessing. */
function projectsWithSources(projects) {
  const out = git('ls-files', '--cached', '--others', '--exclude-standard', '-z',
    '--', ...projects.map((p) => `${p.root}/${p.name}`));
  if (out === null) return null;
  const files = zsplit(out);
  const have = new Set();
  for (const proj of projects) {
    const prefix = `${proj.root}/${proj.name}/`;
    // ⚠️ `tools/` is excluded from the scoped program ON PURPOSE (build-time Node code — see
    // SCOPED_EXCLUDE), so a project whose only TypeScript lives there contributes 0 files
    // legitimately. Counting it here would make that project a permanent false RED. Latent
    // today: no project in the corpus is in that state, and a latent false red still fires.
    if (files.some((f) => f.startsWith(prefix) && !f.startsWith(`${prefix}tools/`)
      && (f.endsWith('.ts') || f.endsWith('.tsx')))) {
      have.add(`${proj.root}/${proj.name}`);
    }
  }
  return have;
}

function main() {
  const argv = process.argv.slice(2);
  const wantAll = argv.includes('--all');
  const wantList = argv.includes('--list');
  const selectors = argv.filter((a) => !a.startsWith('--'));

  // ⚠️ **Zero projects is TWO different states and they must not share an exit code** (#944, from
  //  main). This is a GATE, so "found nothing" and "there is nothing" cannot both be a green pass:
  //  a discovery miss would be a typecheck over zero projects reporting success. But an empty
  //  result is not always wrong — `discoverProjects`' docblock records that a checkout may ship
  //  neither root ("the public OSS repo ships neither"). So the floor keys on the ROOTS being on
  //  disk, not on the project count, which is the actual question: did discovery miss?
  const all = discoverProjects(repoRoot);
  if (all.length === 0) {
    const rootsOnDisk = PROJECT_ROOT_DIRS.filter((r) => existsSync(path.join(repoRoot, r)));
    if (rootsOnDisk.length === 0) {
      console.log(`[typecheck-projects] no ${PROJECT_ROOT_DIRS.map((r) => `${r}/`).join(' or ')} `
        + `directory in ${repoRoot} — nothing to typecheck.`);
      process.exit(0);
    }
    console.error(`[typecheck-projects] ${rootsOnDisk.map((r) => `${r}/`).join(' and ')} present `
      + `under ${repoRoot}, but discovery returned ZERO projects. That is a discovery miss, not an `
      + 'empty checkout — a pass here would have typechecked nothing.');
    process.exit(1);
  }

  let projects;
  let reason;
  if (wantAll) {
    projects = all;
    reason = '--all';
  } else if (selectors.length > 0) {
    // An unknown selector is a hard error, never an empty run: a typo'd project name
    // must not read as "checked, and clean".
    const unknown = selectors.filter((sel) =>
      !all.some((p) => p.name === sel || `${p.root}/${p.name}` === sel));
    if (unknown.length > 0) {
      console.error(`[typecheck-projects] unknown project(s): ${unknown.join(', ')}`);
      console.error(`[typecheck-projects] known: ${all.map((p) => `${p.root}/${p.name}`).join(', ')}`);
      process.exit(1);
    }
    projects = all.filter((p) => selectors.includes(p.name) || selectors.includes(`${p.root}/${p.name}`));
    reason = `named on the command line (${selectors.join(', ')})`;
  } else {
    const sel = selectTouched(all);
    projects = sel.projects ?? all;
    reason = sel.reason;
  }

  console.log(`[typecheck-projects] selection: ${reason}`);
  if (projects.length === 0) {
    console.log('[typecheck-projects] no project touched on this branch — nothing to check.');
    process.exit(0);
  }
  console.log(`[typecheck-projects] checking ${projects.length} project(s): ${projects.map((p) => `${p.root}/${p.name}`).join(', ')}`);

  // `--list` answers "what would the gate check?" without paying for it. Worth its four lines:
  // the selection is now the interesting part of this script, and the only other way to see it
  // was to start a run that might be a full sweep and read its first line.
  if (wantList) process.exit(0);

  const results = [];
  const overallStart = Date.now();
  const withSources = projectsWithSources(projects);

  for (const proj of projects) {
    const label = `${proj.root}/${proj.name}`;
    // Paths relative to engineDir, where the generated config is written — same
    // convention build-web.mjs uses so `extends`/`include` resolve correctly.
    const include = buildInclude(proj);
    // ⚠️ The pid is not decoration. This used to run nowhere; it is now a `verify` leg, so a
    // second run IS routine (a developer's own `npm run typecheck:projects` beside a running
    // gate) and the same branch always selects the SAME projects. Without the suffix, whichever
    // finishes first unlinks the shared path in its `finally` and the other's tsc — if it has not
    // read its config yet — dies with TS5083, a false RED nobody can reproduce. `.gitignore`'s
    // `engine/tsconfig.app.scoped*.json` glob already covers this name.
    const configPath = path.join(engineDir,
      `tsconfig.app.scoped.${proj.root}-${proj.name}.${process.pid}.json`);
    writeFileSync(configPath, JSON.stringify(scopedTsconfigContent(include), null, 2) + '\n');

    const start = Date.now();
    let ok = true;
    let output = '';
    let listed = '';
    try {
      // `--listFiles` prints every file in the program alongside the normal check. It is what
      // turns "exit 0" into evidence — see the contributed-count below.
      listed = execFileSync(process.execPath, [tscBin, '-p', configPath, '--listFiles'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      ok = false;
      output = stripFileList(`${err.stdout ?? ''}${err.stderr ?? ''}`);
    } finally {
      try {
        unlinkSync(configPath);
      } catch {
        // best-effort cleanup — a leaked temp config doesn't affect correctness
      }
    }
    const ms = Date.now() - start;

    // ⚠️ EXIT 0 IS NOT COVERAGE. `app` alone makes the program non-empty, so tsc never raises
    // TS18003 ("no inputs were found") and a scoped run that compiled NOTHING of the project
    // reports PASS — indistinguishable from one that checked it thoroughly. Break buildInclude()
    // above (drop 'app', mis-derive the project path) and all 29 runs go green in a plausible
    // ~170s with #24's gate dead again and nothing red anywhere.
    // ⚠️ Measured 2026-09-08: widening scopedTsconfig.mjs's SCOPED_EXCLUDE does NOT do this,
    // though it looks like it should — tsc still pulls a file in when an included file IMPORTS
    // it, so an exclude only strips what nothing reaches. Do not cite it as the trigger.
    //
    // This is the rule stated in docs/verify-and-ci.md § Typecheck traps — "a config can be wrong
    // in a way that looks clean … which is why the guard checks coverage, not just errors" — and
    // this leg was the one place it was not applied.
    const contributed = ok ? countProgramFiles(listed, proj.dir) : -1;
    // A project with no TypeScript at all (games/agy is one) legitimately contributes nothing, and
    // tsc reports it identically. `withSources === null` means git could not tell us, and we
    // decline to make the distinction rather than inventing a red.
    const hasSources = withSources === null ? null : withSources.has(label);
    let empty = false;

    // The scoping's own proof — see foreignProjects(). Checked BEFORE the empty case: when the
    // include shape goes wide, every project contributes files and the empty check is silent.
    if (ok) {
      const allowed = KNOWN_CROSS_PROJECT[label] ?? [];
      const foreign = foreignProjects(listed, all, label).filter((f) => !allowed.includes(f));
      if (foreign.length > 0) {
        ok = false;
        output = `[typecheck-projects] ${label}'s scoped program is NOT SCOPED.\n`
          + `  It also compiled files from: ${foreign.join(', ')}.\n`
          + '  A scoped program is the app shell plus ONE project — that is the whole mechanism,\n'
          + '  because #24 is about a file typechecking only thanks to a SIBLING project. With\n'
          + '  siblings back in the program this leg is just `npm run typecheck` run once per\n'
          + '  project, and it would report all-green while proving nothing.\n'
          + '  Start at buildInclude() in this file. If the import is a deliberate escape, it\n'
          + '  belongs in KNOWN_ESCAPES (gamePortability.test.ts) and KNOWN_CROSS_PROJECT here.\n';
      }
    }

    if (ok && contributed === 0 && hasSources === true) {
      ok = false;
      empty = true;
      output = `[typecheck-projects] ${label} typechecked ZERO of its own files.\n`
        + '  tsc exited 0, but the scoped program contained only the app shell — so this PASS\n'
        + '  proves nothing about this project. git reports it HAS TypeScript sources, so the\n'
        + '  scoped program is not reaching them. Start at buildInclude() in this file, then\n'
        + '  scopedTsconfig.mjs.\n'
        + '  ⚠️ NOT SCOPED_EXCLUDE on its own: measured 2026-09-08, widening it does NOT empty\n'
        + '  the program, because tsc still pulls a file in when an included file IMPORTS it.\n'
        + '  An exclude can only strip files nothing reaches — the include shape is the lever.\n';
    }
    const note = empty ? ', 0 of its own files' : !ok ? ''
      : contributed === 0 ? ', no TypeScript' : `, ${contributed} files`;
    results.push({ label, ok, ms, output, contributed, empty });
    console.log(`[typecheck-projects] ${ok ? 'PASS' : 'FAIL'} ${label} (${ms}ms${note})`);
    if (!ok) console.log(output);
  }

  const totalMs = Date.now() - overallStart;
  console.log(`\n[typecheck-projects] ${results.length} project(s) in ${totalMs}ms:`);
  for (const r of results) {
    const n = r.empty ? '  (0 of its own files)' : !r.ok ? ''
      : r.contributed === 0 ? '  (no TypeScript)' : `  ${r.contributed} files`;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(28)} ${r.ms}ms${n}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[typecheck-projects] ${failed.length}/${results.length} project(s) FAILED: ${failed.map((r) => r.label).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n[typecheck-projects] all ${results.length} project(s) passed.`);
  process.exit(0);
}

// ⚠️ Guarded: this module EXPORTS (MACHINERY_PATHS) and would otherwise run the whole sweep on
// import. That exact shape has bitten this repo before — importing a constant ran a CLI body and
// re-encoded 24 committed assets.
main();
