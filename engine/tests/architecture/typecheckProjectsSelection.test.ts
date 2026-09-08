/**
 * `typecheck-projects.mjs` decides WHICH projects get the scoped typecheck that closes #24's
 * gate hole, and it runs on every `npm run verify` (#967). A bug in that decision is a SILENTLY
 * DISABLED GATE — it reports PASS having checked nothing — which this repo treats as worse than
 * a gate that is deliberately off.
 *
 * These drive the real CLI with `--list` against THROWAWAY REPOS rather than importing a pure
 * function, because the thing under test is a fact about git topology and a working tree: what
 * `--first-parent` does to a merged commit, and whether an untracked file is visible at all.
 * Nothing short of real commits can prove either. Same reasoning as `sweepGate.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { MACHINERY_PATHS, countProgramFiles, foreignProjects, stripFileList, KNOWN_CROSS_PROJECT }
  from '../../scripts/scopedTypecheckLib.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPTS = join(REPO, 'engine', 'scripts');

const tmpRepos: string[] = [];
afterAll(() => {
  for (const d of tmpRepos) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** A repo with `games/alpha` + `games/beta` + `demos/gamma`, one commit, and an `origin/main`
 *  pointing at it — i.e. a worker clone that has not diverged yet.
 *
 *  ⚠️ The REAL script is COPIED IN and driven, not re-implemented — the script's `repoRoot` is
 *  derived from its own location (#944), so the copy's placement is what names the fixture as its
 *  repo. Same harness shape as gateEmptyResultReporting.test.ts, and the same reason: these
 *  scripts have no build step, so the file on disk IS the artifact.
 *
 *  ⚠️ The copied scripts are COMMITTED in the base commit. `typecheck-projects.mjs` is itself in
 *  MACHINERY_PATHS, so leaving it untracked would make every fixture look like "the machinery
 *  changed" and escalate to a full sweep — every selection assertion below would then pass for
 *  the wrong reason. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tcp-sel-'));
  tmpRepos.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');

  const scripts = join(dir, 'engine', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const f of ['typecheck-projects.mjs', 'scopedTypecheckLib.mjs', 'projectRoots.mjs',
      'scopedTsconfig.mjs']) {
    copyFileSync(join(SCRIPTS, f), join(scripts, f));
  }
  // A stand-in tsc, so the module-load check passes. Safe: every assertion here is about the
  // SELECTION, which `--list` resolves before any project is compiled.
  const tscBin = join(dir, 'node_modules', 'typescript', 'bin');
  mkdirSync(tscBin, { recursive: true });
  writeFileSync(join(tscBin, 'tsc'), 'process.exit(0);\n');

  for (const p of ['games/alpha', 'games/beta', 'demos/gamma']) {
    mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, p, 'game.ts'), 'export const x = 1;\n');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  // The remote-tracking ref the selection measures against. Created by hand because a throwaway
  // repo has no remote — this is exactly the ref a real clone gets from `git fetch`.
  git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD').trim());
  return dir;
}

/** Run the CLI's selection only. Returns its stdout + exit code; `--list` checks nothing, so this
 *  never spawns `tsc` and needs no `node_modules` in the throwaway repo. */
function select(cwd: string, ...args: string[]) {
  try {
    const out = execFileSync(process.execPath,
      [join(cwd, 'engine', 'scripts', 'typecheck-projects.mjs'), '--list', ...args], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('the scoped-typecheck project selection', () => {
  it('picks ONLY the projects the branch committed to', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-qb', 'work');
    writeFileSync(join(dir, 'games/alpha/game.ts'), 'export const x = 2;\n');
    git(dir, 'commit', '-qam', 'touch alpha');

    const { out } = select(dir);
    expect(out).toContain('games/alpha');
    // ⚠️ The assertion that matters is the NEGATIVE one. A selection that returned everything
    // would satisfy the line above while making the whole touched-only design a no-op, and the
    // gate would silently pay the full-sweep cost on every verify instead of a per-project one.
    expect(out).not.toContain('games/beta');
    expect(out).not.toContain('demos/gamma');
  });

  it('sees an UNCOMMITTED edit — the session editing right now', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-qb', 'work');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'diverge');
    writeFileSync(join(dir, 'games/beta/game.ts'), 'export const x = 3;\n');

    const { out } = select(dir);
    expect(out).toContain('games/beta');
    expect(out).not.toContain('games/alpha');
  });

  it('sees a BRAND NEW untracked project, which has no tracked file to diff', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-qb', 'work');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'diverge');
    mkdirSync(join(dir, 'games/delta'), { recursive: true });
    writeFileSync(join(dir, 'games/delta/game.ts'), 'export const x = 4;\n');

    // A gate that only reads commits is blind to exactly the project most likely to be broken.
    expect(select(dir).out).toContain('games/delta');
  });

  it('does NOT re-check a project that arrived by MERGING someone else\'s branch', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-qb', 'other');
    writeFileSync(join(dir, 'games/beta/game.ts'), 'export const x = 5;\n');
    git(dir, 'commit', '-qam', 'beta on another branch');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-qb', 'work');
    writeFileSync(join(dir, 'games/alpha/game.ts'), 'export const x = 6;\n');
    git(dir, 'commit', '-qam', 'alpha here');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge other', 'other');

    // `--first-parent --no-merges`: beta's commit hangs off the merge's SECOND parent. The clone
    // that wrote it already scoped-checked it before pushing — CLAUDE.md's "merging is not
    // re-testing AT THE HUB".
    const { out } = select(dir);
    expect(out).toContain('games/alpha');
    expect(out).not.toContain('games/beta');
  });

  it('sweeps EVERYTHING when the scoped-config machinery changed', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-qb', 'work');
    // ⚠️ The branch MUST have a commit of its own. Without it `merge-base === HEAD`, the
    // degenerate-range fail-safe fires, and this test passes with the escalation DELETED — it
    // then pins the fail-safe instead of the thing it names. Caught by mutation check, #967.
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'diverge');
    // ⚠️ `engine/tsconfig.app.json`, NOT one of the .mjs machinery files: the fixture now carries
    // real copies of those and the CLI IMPORTS them, so overwriting one with placeholder text
    // breaks the script's own import rather than exercising the escalation. (It did exactly that
    // — the assertion saw a module-resolution stack trace instead of a selection line.)
    writeFileSync(join(dir, 'engine/tsconfig.app.json'), '{"include":["app"]}\n');

    const { out } = select(dir);
    expect(out).toContain('sweeping ALL');
    // That file changes the scoped SHAPE for projects nobody touched, so touched-only is unsound.
    for (const p of ['games/alpha', 'games/beta', 'demos/gamma']) expect(out).toContain(p);
  });

  it('FAILS SAFE toward sweeping everything on a DEGENERATE range', () => {
    // `merge-base(HEAD, origin/main) === HEAD` is true of any fresh checkout of `main`. The branch
    // has no commits of its own, so it CANNOT be asked what it changed — and answering "nothing"
    // there is this gate's worst failure, indistinguishable from a clean branch.
    const dir = makeRepo();
    const { out } = select(dir);
    expect(out).toContain('sweeping ALL');
    for (const p of ['games/alpha', 'games/beta', 'demos/gamma']) expect(out).toContain(p);
  });

  it('FAILS SAFE toward sweeping everything when there is no git repo at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcp-nogit-'));
    tmpRepos.push(dir);
    const scripts = join(dir, 'engine', 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const f of ['typecheck-projects.mjs', 'scopedTypecheckLib.mjs', 'projectRoots.mjs',
      'scopedTsconfig.mjs']) {
      copyFileSync(join(SCRIPTS, f), join(scripts, f));
    }
    const tscBin = join(dir, 'node_modules', 'typescript', 'bin');
    mkdirSync(tscBin, { recursive: true });
    writeFileSync(join(tscBin, 'tsc'), 'process.exit(0);\n');
    for (const p of ['games/alpha', 'games/beta']) {
      mkdirSync(join(dir, p), { recursive: true });
      writeFileSync(join(dir, p, 'game.ts'), 'export const x = 1;\n');
    }
    const { out } = select(dir);
    expect(out).toContain('sweeping ALL');
    expect(out).toContain('games/alpha');
    expect(out).toContain('games/beta');
  });

  it('treats an unknown project name as an ERROR, never an empty green run', () => {
    const dir = makeRepo();
    const { code, out } = select(dir, 'alfa');
    // A typo'd name resolving to "checked nothing, all good" is the same silent-gate failure as
    // an under-selecting detector, just triggered by a human instead of by git.
    expect(code).toBe(1);
    expect(out).toContain('unknown project');
  });

  it('--all overrides a narrow touched-set', () => {
    const dir = makeRepo();
    git(dir, 'checkout', '-qb', 'work');
    writeFileSync(join(dir, 'games/alpha/game.ts'), 'export const x = 7;\n');
    git(dir, 'commit', '-qam', 'touch alpha');

    const { out } = select(dir, '--all');
    for (const p of ['games/alpha', 'games/beta', 'demos/gamma']) expect(out).toContain(p);
  });
});

describe('MACHINERY_PATHS', () => {
  it('names only files that exist — a stale entry stops escalating, silently', () => {
    // Pure string data, matched against git's changed-file list. Rename or move one of these
    // (updating its importers, so nothing else breaks) and `verify` stays green while a change to
    // the scoped-config GENERATOR — the one thing that makes touched-only unsound — quietly stops
    // triggering the full sweep from that commit onward. Nothing else in the repo mentions the
    // list except a prose reason string in an allowlist.
    for (const rel of MACHINERY_PATHS as string[]) {
      expect(existsSync(join(REPO, rel)), `MACHINERY_PATHS names a file that does not exist: ${rel}`)
        .toBe(true);
    }
  });

  it('includes THIS script, which is where the scoped include shape is actually built', () => {
    // buildInclude() lives in typecheck-projects.mjs, not scopedTsconfig.mjs. Without this entry
    // a change to the program's shape is validated against only the branch's touched projects,
    // and breaks the untouched ones on somebody else's unrelated verify.
    expect(MACHINERY_PATHS as string[]).toContain('engine/scripts/typecheck-projects.mjs');
  });
});

/** `tsc --listFiles` emits absolute paths with FORWARD slashes on every platform. */
const POSIX_DUMP = [
  '/repo/engine/app/main.ts',
  '/repo/games/court/game.ts',
  '/repo/games/court/runtime/systems.ts',
  '/repo/games/court/node_modules/@capacitor/core/types.d.ts',
  '/repo/games/court/packages/x/dist/index.d.ts',
  '/repo/games/court-adjacent/other.ts',
  '/repo/games/llm-test/runtime/services/LLMService.ts',
].join('\n');

describe('the coverage predicate', () => {
  it('counts a project\'s own AUTHORED files', () => {
    // node_modules + dist are installed/built, not authored: 2, not 4.
    expect(countProgramFiles(POSIX_DUMP, '/repo/games/court')).toBe(2);
  });

  it('matches a WINDOWS-shaped project path against tsc\'s forward-slash output', () => {
    // ⚠️ THE `win` CLONE'S REGRESSION, pinned from a Mac. tsc always prints '/'; path.join gives
    // 'C:\\repo\\games\\court' on Windows. Comparing them raw made EVERY sourced project report
    // "0 of its own files" — a guaranteed false RED on a correct tree. No Windows runner reaches
    // this suite, so without this case the fix ships unpinned.
    const winDump = POSIX_DUMP.replace(/\/repo/g, 'C:/repo');
    expect(countProgramFiles(winDump, 'C:\\repo\\games\\court')).toBe(2);
  });

  it('does not let one project name swallow another that shares its prefix', () => {
    // 'games/court' must not match 'games/court-adjacent'.
    expect(countProgramFiles(POSIX_DUMP, '/repo/games/court-adjacent')).toBe(1);
  });
});

describe('the scoping proof', () => {
  const projects = [
    { root: 'games', name: 'court', dir: '/repo/games/court' },
    { root: 'games', name: 'llm-test', dir: '/repo/games/llm-test' },
    { root: 'games', name: 'chess', dir: '/repo/games/chess' },
  ];

  it('names the OTHER projects that reached the program', () => {
    // ⚠️ Counting only a project's OWN files proves inclusion, never exclusion — so widening the
    // include shape to the wide program leaves every project reporting a healthy count and all
    // 29 green, with this leg reduced to `npm run typecheck` run once per project and #24's mask
    // fully restored. Measured: that mutation passed 29/29 against the inclusion check alone.
    expect(foreignProjects(POSIX_DUMP, projects, 'games/court')).toEqual(['games/llm-test']);
  });

  it('reports nothing when the program really is scoped', () => {
    const scoped = '/repo/engine/app/main.ts\n/repo/games/court/game.ts';
    expect(foreignProjects(scoped, projects, 'games/court')).toEqual([]);
  });
});

describe('KNOWN_CROSS_PROJECT', () => {
  it('agrees with gamePortability.test.ts KNOWN_ESCAPES — a hand-kept copy, guarded', () => {
    // The allowance exists so chess->llm-test does not false-red the scoping proof. It duplicates
    // knowledge that already has an owner, so it is DERIVED here and compared: extract the escape
    // (issue is open) or add another, and this reddens instead of the gate silently widening.
    // #812: guards read source through the shared reader, which strips comments by extension and
    // runs assertScanIsSane. Correct here rather than merely compliant — KNOWN_ESCAPES is CODE, so
    // a commented-out entry must not be picked up as a live one.
    const { code: src } = readScannedSource(join(REPO, 'engine/tests/assets/gamePortability.test.ts'));
    const block = src.match(/const KNOWN_ESCAPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(block, 'KNOWN_ESCAPES not found — gamePortability.test.ts changed shape').toBeTruthy();

    const derived: Record<string, Set<string>> = {};
    for (const m of block![1].matchAll(/'((?:games|demos)\/[^/]+)\/[^']*?\s::\s([^']+)'/g)) {
      const consumer = m[1];
      const provider = m[2].match(/(?:\.\.\/)+([^/]+)\//);
      if (provider) (derived[consumer] ??= new Set()).add(`games/${provider[1]}`);
    }
    const asPlain = Object.fromEntries(
      Object.entries(derived).map(([k, v]) => [k, [...v].sort()]));
    expect(asPlain).toEqual(KNOWN_CROSS_PROJECT);
  });
});

describe('failure output', () => {
  it('drops the --listFiles dump so one real error is not buried under 2400 paths', () => {
    const noisy = [
      '/repo/node_modules/typescript/lib/lib.es5.d.ts',
      'C:/repo/engine/app/main.ts',
      'games/wordweave/runtime/x.ts(2,35): error TS2304: Cannot find name.',
    ].join('\n');
    const out = stripFileList(noisy);
    expect(out).toContain('error TS2304');
    expect(out).not.toContain('lib.es5.d.ts');
    expect(out).not.toContain('C:/repo/engine');
  });
});
