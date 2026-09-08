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
 *  shared with build-web.mjs so the two can't drift) for EVERY project under
 *  PROJECT_ROOT_DIRS (games/ + demos/, discovered via projectRoots.mjs — the single
 *  source of truth) and runs `tsc -p` against each one INDIVIDUALLY, so a masked
 *  error surfaces here instead of in a release build.
 *
 *  - Distinct temp config path per project (never `tsconfig.app.scoped.json`, which a
 *    concurrent `npm run build` may be using) so this can run alongside a build.
 *    Cleaned up after itself, including on failure.
 *  - Runs ALL projects even after a failure — fail-fast would hide N-1 OTHER
 *    breakages — and exits non-zero if any project failed.
 *  - Prints per-project pass/fail + wall-clock, and the total wall-clock. */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects, PROJECT_ROOT_DIRS } from './projectRoots.mjs';
import { scopedTsconfigContent } from './scopedTsconfig.mjs';

/** Derived from THIS FILE, never `process.cwd()` (#944). The old `cwd` form made the script's
 *  subject depend on where it was invoked from: run from anywhere but the repo root it discovered
 *  zero projects, and the empty-set branch below reported that as a clean pass. A gate must always
 *  typecheck the same tree, whoever spawned it and from where. */
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const engineDir = path.join(repoRoot, 'engine');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tscBin)) {
  console.error('[typecheck-projects] typescript not installed (node_modules/typescript missing) — run npm install.');
  process.exit(1);
}

/** ⚠️ **Zero projects is TWO different states and they must not share an exit code** (#944).
 *
 *  This is a GATE, so "found nothing" and "there is nothing" cannot both be a green pass: a
 *  discovery miss would be a typecheck over zero projects that reports success. But an empty result
 *  is NOT always wrong — `discoverProjects`' own docblock records that a checkout may legitimately
 *  ship neither root ("the public OSS repo ships neither"), and failing there would break a tree
 *  that is behaving correctly.
 *
 *  So the floor keys on the ROOTS being on disk, not on the project count — which is the actual
 *  question ("did discovery miss?"), and the one #944 says a gate owes an answer to. Deliberately
 *  NOT "every empty set is fatal": that issue names the property wanted as *distinguishable*, not
 *  *fatal*. */
const projects = discoverProjects(repoRoot);
if (projects.length === 0) {
  const rootsOnDisk = PROJECT_ROOT_DIRS.filter((r) => existsSync(path.join(repoRoot, r)));
  if (rootsOnDisk.length === 0) {
    console.log(`[typecheck-projects] no ${PROJECT_ROOT_DIRS.map((r) => `${r}/`).join(' or ')} directory `
      + `in ${repoRoot} — nothing to typecheck.`);
    process.exit(0);
  }
  console.error(`[typecheck-projects] ${rootsOnDisk.map((r) => `${r}/`).join(' and ')} present under `
    + `${repoRoot}, but discovery returned ZERO projects. That is a discovery miss, not an empty `
    + 'checkout — a pass here would have typechecked nothing.');
  process.exit(1);
}

const results = [];
const overallStart = Date.now();

for (const proj of projects) {
  const label = `${proj.root}/${proj.name}`;
  // Paths relative to engineDir, where the generated config is written — same
  // convention build-web.mjs uses so `extends`/`include` resolve correctly.
  const include = ['app', path.relative(engineDir, proj.dir).split(path.sep).join('/')];
  const configPath = path.join(engineDir, `tsconfig.app.scoped.${proj.root}-${proj.name}.json`);
  writeFileSync(configPath, JSON.stringify(scopedTsconfigContent(include), null, 2) + '\n');

  const start = Date.now();
  let ok = true;
  let output = '';
  try {
    execFileSync(process.execPath, [tscBin, '-p', configPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    ok = false;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      // best-effort cleanup — a leaked temp config doesn't affect correctness
    }
  }
  const ms = Date.now() - start;
  results.push({ label, ok, ms, output });
  console.log(`[typecheck-projects] ${ok ? 'PASS' : 'FAIL'} ${label} (${ms}ms)`);
  if (!ok) console.log(output);
}

const totalMs = Date.now() - overallStart;
console.log(`\n[typecheck-projects] ${results.length} project(s) in ${totalMs}ms:`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(28)} ${r.ms}ms`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n[typecheck-projects] ${failed.length}/${results.length} project(s) FAILED: ${failed.map((r) => r.label).join(', ')}`);
  process.exit(1);
}
console.log(`\n[typecheck-projects] all ${results.length} project(s) passed.`);
process.exit(0);
