/** #944 — a lookup that found nothing must not be reported as a completed operation.
 *
 *  The class: a script prints its success message and exits 0 on an EMPTY result set, so "did the
 *  work" and "matched nothing" are indistinguishable to the caller. #908 was the first instance
 *  (`dev:stop` printed `Done.` whether it had killed a dev server or matched none); #129 named the
 *  cost before that — the failure *"presents as the app is broken, not as something was stopped."*
 *
 *  This file covers the two members that sit inside a GATE (a third reachable member,
 *  `migrate-private-config.mjs`, is an ordinary `npm run` script and is pinned in
 *  `engine/tests/plugins/migratePrivateConfig.test.ts` instead):
 *
 *    - `typecheck-projects.mjs` — a discovery miss was a green typecheck over ZERO projects.
 *    - `install-git-hooks.mjs`  — a missing hook SOURCE inherited a message `verify.mjs` filters.
 *
 *  ⚠️ **Both scripts are COPIED into a fixture tree and run, rather than re-implemented here.**
 *  That is deliberate and is the whole point: #945 records four verifications in this repo that read
 *  the source or rebuild their own copy and therefore cannot fail. These scripts have no build step,
 *  so the file on disk IS the artifact, and copying it verbatim is driving the real thing. Nothing
 *  below restates the logic under test.
 *
 *  ⚠️ **Every case here has an ACCEPT side**, not just a reject side — proving a floor REJECTS an
 *  empty result never proves it ACCEPTS a populated one, and a floor that rejects everything would
 *  pass a reject-only suite while breaking the gate for real. */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPTS = path.resolve(__dirname, '..', '..', 'scripts');
const made: string[] = [];

afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/** A checkout-shaped tree holding the REAL script plus the two modules it imports, and a stand-in
 *  `tsc` that exits 0. The stand-in is safe: every assertion here is about the floor, which runs
 *  BEFORE any project is compiled — and the accept-side case must be able to reach the end of the
 *  script without spending a real typecheck. */
function typecheckFixture(opts: { roots?: string[]; projects?: string[] }): string {
  const dir = tmp('tcproj-');
  const scripts = path.join(dir, 'engine', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  // scopedTypecheckLib.mjs joins this list with #967: typecheck-projects.mjs now IMPORTS it, so
  // a fixture without it fails module resolution instead of exercising the floor.
  for (const f of ['typecheck-projects.mjs', 'scopedTypecheckLib.mjs', 'projectRoots.mjs',
    'scopedTsconfig.mjs']) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(scripts, f));
  }
  const tscBin = path.join(dir, 'node_modules', 'typescript', 'bin');
  fs.mkdirSync(tscBin, { recursive: true });
  fs.writeFileSync(path.join(tscBin, 'tsc'), 'process.exit(0);\n');
  for (const r of opts.roots ?? []) fs.mkdirSync(path.join(dir, r), { recursive: true });
  for (const p of opts.projects ?? []) fs.mkdirSync(path.join(dir, p), { recursive: true });
  return dir;
}

function runTypecheck(dir: string, cwd: string = dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'engine', 'scripts', 'typecheck-projects.mjs')],
    { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('typecheck-projects: an empty discovery is not a pass (#944)', () => {
  it('REJECTS: a root dir on disk that yields zero projects is a discovery miss, and fails', () => {
    // The defect: `games/` populated (or merely present) while discovery returns nothing meant a
    // GREEN typecheck that compiled zero projects — the gate reporting success for doing nothing.
    const r = runTypecheck(typecheckFixture({ roots: ['games'] }));
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('ZERO projects');
    expect(r.out).toContain('discovery miss');
  });

  it('ACCEPTS: a checkout with NO project roots at all is a clean exit 0, not a failure', () => {
    // Load-bearing, and the reason the floor keys on the ROOTS rather than on the project count:
    // `discoverProjects` docblock records that a checkout may legitimately ship neither root ("the
    // public OSS repo ships neither"). A blanket "empty set is fatal" would redden a correct tree.
    const r = runTypecheck(typecheckFixture({}));
    expect(r.status).toBe(0);
    expect(r.out).toContain('nothing to typecheck');
    expect(r.out).not.toContain('discovery miss');
  });

  it('ACCEPTS: a populated root runs the projects it found', () => {
    const r = runTypecheck(typecheckFixture({ roots: ['games'], projects: ['games/alpha', 'games/beta'] }));
    expect(r.status).toBe(0);
    expect(r.out).toContain('alpha');
    expect(r.out).toContain('beta');
  });

  it('the subject is derived from the SCRIPT, not from the cwd it was spawned in', () => {
    // `repoRoot` was `process.cwd()`. Run from anywhere but the repo root, discovery found zero
    // projects and the old empty branch reported that as success — so WHERE the gate was invoked
    // from silently decided WHAT it checked. Spawned from an unrelated directory here.
    const fixture = typecheckFixture({ roots: ['games'], projects: ['games/alpha'] });
    const elsewhere = tmp('elsewhere-');
    const r = runTypecheck(fixture, elsewhere);
    expect(r.status).toBe(0);
    expect(r.out).toContain('alpha');
    // With a cwd-derived root this would have found no roots at all and printed the exit-0 line.
    expect(r.out).not.toContain('nothing to typecheck');
  });
});

describe('install-git-hooks: a missing hook SOURCE is not "no git hooks dir" (#944)', () => {
  function runHooks(): { status: number | null; out: string } {
    // No `git-hooks/` sibling — the missing-SOURCE condition, which used to share its message with
    // the ordinary non-git-checkout case.
    const dir = tmp('hooks-');
    const scripts = path.join(dir, 'engine', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS, 'install-git-hooks.mjs'), path.join(scripts, 'install-git-hooks.mjs'));
    const r = spawnSync(process.execPath, [path.join(scripts, 'install-git-hooks.mjs')],
      { cwd: dir, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  /** The exact prefix `verify.mjs` filters out of the gate's own output. Read from that file rather
   *  than typed here, so this test goes red if the deny-list moves — the coupling is invisible
   *  otherwise, and it is the entire reason the two conditions had to be split. */
  const DENY_PREFIX = (() => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'verify.mjs'), 'utf8');
    const m = src.match(/startsWith\('(\[hooks\][^']*)'\)/);
    if (!m) throw new Error('verify.mjs no longer filters a [hooks] prefix — re-derive this coupling');
    return m[1];
  })();

  it('reports the missing sources on its own line, and does NOT fail an npm install', () => {
    const r = runHooks();
    expect(r.out).toContain('hook SOURCES missing');
    // Exit 0 is deliberate: `prepare` runs this on EVERY npm install, so a non-zero exit would turn
    // a cosmetic repo-state problem into an install that cannot complete, including on the mirror.
    expect(r.status).toBe(0);
  });

  it('that line SURVIVES the filter verify.mjs applies to the installer output', () => {
    // The defect in one assertion: the old message began with this exact prefix, so the gate that
    // runs the installer stripped the only report a broken checkout ever produced.
    const line = runHooks().out.split('\n').find((l) => l.includes('hook SOURCES missing'));
    expect(line).toBeDefined();
    expect(line!.startsWith(DENY_PREFIX)).toBe(false);
  });

  it('ACCEPTS: the ordinary non-git checkout still prints the filtered line and exits 0', () => {
    // The accept side. This case is NORMAL — a tarball extract has no .git — and it must stay
    // quiet in the gate, or the fix trades a silent failure for a line of noise on every run.
    const dir = tmp('hooks-ok-');
    const scripts = path.join(dir, 'engine', 'scripts');
    fs.mkdirSync(path.join(scripts, 'git-hooks'), { recursive: true });
    fs.copyFileSync(path.join(SCRIPTS, 'install-git-hooks.mjs'), path.join(scripts, 'install-git-hooks.mjs'));
    fs.writeFileSync(path.join(scripts, 'git-hooks', 'prepare-commit-msg'), '#!/bin/sh\nexit 0\n');
    const r = spawnSync(process.execPath, [path.join(scripts, 'install-git-hooks.mjs')],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } });
    expect(r.status).toBe(0);
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).not.toContain('hook SOURCES missing');
  });
});
