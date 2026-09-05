/** End-to-end tests for engine/scripts/migrate-anchor-zindex.mjs (#762 follow-up, 4th review round).
 *
 *  Before this file, `npm run verify` ran this script ZERO times — the only file mentioning it
 *  (`anchorZIndexMigrated.test.ts`) asserts the CORPUS is already migrated, which stays green
 *  precisely when the codemod's own SELECTION silently breaks (three fix rounds each introduced a
 *  defect of exactly that shape: migrate nothing, report a clean sweep, exit 0). So this suite runs
 *  the REAL script as a subprocess (`node`) against a THROWAWAY temp git repo built at the same
 *  relative depth the script expects (`<tmp>/engine/scripts/migrate-anchor-zindex.mjs`, so its own
 *  `resolve(__dirname, '../..')` resolves to `<tmp>`, not this repo) — never the real repo.
 *
 *  Each `it` below pins one of the four fix-round regressions plus the data-loss carrier fix, so a
 *  reviewer can mutate the corresponding source behaviour and watch exactly one case go red:
 *   1. happy path (baseline — a truthy UIAnchor.zIndex migrates onto UIElement.zIndex)
 *   2. case desync between the git index and the worktree (root segment case) — FIX 2's regression pin
 *   3. the path pattern matching nothing while files exist elsewhere — FIX 1's regression pin
 *   4. two case-variant index entries for one physical file — FIX 3's regression pin
 *   5. not a git work tree at all — the git-failure abort path
 *   6. an override bag with no sibling UIElement — the value must be CARRIED, not dropped (b1c548954)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REAL_SCRIPT = path.resolve(__dirname, '../../scripts/migrate-anchor-zindex.mjs');
const REAL_PROJECT_ROOTS = path.resolve(__dirname, '../../scripts/projectRoots.mjs');

/** Whether this filesystem collapses two paths differing only in case onto the same file —
 *  macOS (APFS default) and Windows do; Linux ext4 does not. Tests 2 and 4 reproduce a defect
 *  that is ONLY reachable on a case-insensitive filesystem (a case-variant git index entry still
 *  has to pass `existsSync` to be processed at all — see the script's own `filesMatching` note),
 *  so they `skipIf` on a case-sensitive one rather than fail for an unrelated reason. */
const CASE_INSENSITIVE_FS = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-case-probe-'));
  try {
    const lower = path.join(dir, 'caseprobe.txt');
    fs.writeFileSync(lower, 'x');
    return fs.existsSync(path.join(dir, 'CASEPROBE.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

let tmp: string;

/** Sets up `<tmp>/engine/scripts/{migrate-anchor-zindex.mjs,projectRoots.mjs}` — the exact
 *  relative depth the real script expects from its own location, so `ROOT` inside the copy
 *  resolves to `tmp`, not this repo. `gitInit` is skippable for the "not a work tree" case. */
function makeRepo({ gitInit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-migrate-anchor-'));
  fs.mkdirSync(path.join(dir, 'engine', 'scripts'), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(dir, 'engine', 'scripts', 'migrate-anchor-zindex.mjs'));
  fs.copyFileSync(REAL_PROJECT_ROOTS, path.join(dir, 'engine', 'scripts', 'projectRoots.mjs'));
  if (gitInit) {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
  }
  return dir;
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

function writeJson(repo: string, relPath: string, data: unknown) {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2));
  return full;
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

const SCRIPT_REL = path.join('engine', 'scripts', 'migrate-anchor-zindex.mjs');

function run(repo: string, args: string[] = []): string {
  return execFileSync('node', [path.join(repo, SCRIPT_REL), ...args], { cwd: repo, encoding: 'utf8' });
}

function runAllowFail(repo: string, args: string[] = []): { status: number; out: string } {
  const r = spawnSync('node', [path.join(repo, SCRIPT_REL), ...args], { cwd: repo, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** A minimal scene: one entity carrying a truthy `UIAnchor.zIndex` with a sibling `UIElement`. */
const sceneWithAnchorZIndex = (zIndex: number) => ({
  version: 9,
  entities: [
    {
      name: 'Node',
      localId: 1,
      traits: { UIAnchor: { zIndex }, UIElement: {} },
    },
  ],
});

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migrate-anchor-zindex (end-to-end, throwaway repo)', () => {
  it('happy path: migrates UIAnchor.zIndex onto UIElement.zIndex, bumps version, reports 1 in 1', () => {
    tmp = makeRepo();
    const file = writeJson(tmp, 'games/x/runtime/assets/scenes/a.scene.json', sceneWithAnchorZIndex(5));

    const out = run(tmp, ['--write']);
    expect(out).toMatch(/1 UIAnchor\.zIndex key\(s\) in 1 file\(s\) rewritten/);

    const after = readJson(file);
    expect(after.version).toBe(13);
    expect(after.entities[0].traits.UIElement.zIndex).toBe(5);
    expect(after.entities[0].traits.UIAnchor).not.toHaveProperty('zIndex');
  });

  it('dry-run (no --write) reports the same count and writes nothing', () => {
    tmp = makeRepo();
    const file = writeJson(tmp, 'games/x/runtime/assets/scenes/a.scene.json', sceneWithAnchorZIndex(5));
    const before = fs.readFileSync(file, 'utf8');

    const out = run(tmp);
    expect(out).toMatch(/1 UIAnchor\.zIndex key\(s\) in 1 file\(s\) would be rewritten/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  // FIX 2's regression pin: the git index holds a different-CASE root segment than the worktree
  // (`Games/...` vs the real `games/...`), reproducing the exact failure #762 exists to fix — the
  // path pattern is a case-sensitive literal and matches nothing, so the script silently skips a
  // real project. Forced with plumbing (`hash-object` + `update-index --cacheinfo`) because an
  // ordinary case-only rename does not reliably desync the index on every git config.
  it.skipIf(!CASE_INSENSITIVE_FS)(
    'migrates a project even when the git index case-desyncs from the worktree (root segment)',
    () => {
      tmp = makeRepo();
      const rel = 'games/sling/runtime/assets/scenes/x.scene.json';
      const file = writeJson(tmp, rel, sceneWithAnchorZIndex(7));
      const sha = git(tmp, ['hash-object', '-w', file]).trim();
      // Same file, but the INDEX entry names the root "Games" (capital G) — the worktree directory
      // stays "games" the whole time.
      const indexPath = 'Games/sling/runtime/assets/scenes/x.scene.json';
      git(tmp, ['update-index', '--add', '--cacheinfo', `100644,${sha},${indexPath}`]);

      const out = run(tmp, ['--write']);
      expect(out).toMatch(/1 UIAnchor\.zIndex key\(s\) in 1 file\(s\) rewritten/);
      expect(readJson(file).entities[0].traits.UIElement.zIndex).toBe(7);
    },
  );

  // FIX 1's regression pin: files exist and are enumerable, but NONE of them sit under
  // `runtime/assets` — the pattern matches zero of a nonzero enumeration. Must abort loudly
  // (rc=1) naming both counts, not report "0 keys in 0 files" and exit 0.
  it('aborts when the path pattern matches nothing, naming matched-vs-enumerated counts', () => {
    tmp = makeRepo();
    const file = writeJson(tmp, 'games/x/loose.scene.json', sceneWithAnchorZIndex(9));
    const before = fs.readFileSync(file, 'utf8');

    const { status, out } = runAllowFail(tmp);
    expect(status).toBe(1);
    expect(out).toMatch(/ABORT/);
    expect(out).toMatch(/matched 0 of 1 enumerated/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  // FIX 3's regression pin: two index entries differing only in case point at the SAME physical
  // file. Before the fix, dry-run counted it twice (`existsSync` passes on both on a
  // case-insensitive filesystem) while `--write` then counted it once on a second read — the
  // dry-run report and the write disagreeing is the actual bug, since the dry-run is what an
  // operator reads before deciding to run `--write`.
  it.skipIf(!CASE_INSENSITIVE_FS)(
    'a physical file indexed under two case-variant paths is reported exactly once',
    () => {
      tmp = makeRepo();
      const rel = 'games/y/runtime/assets/scenes/b.scene.json';
      const file = writeJson(tmp, rel, sceneWithAnchorZIndex(3));
      const sha = git(tmp, ['hash-object', '-w', file]).trim();
      git(tmp, ['update-index', '--add', '--cacheinfo', `100644,${sha},games/y/runtime/assets/scenes/b.scene.json`]);
      git(tmp, ['update-index', '--add', '--cacheinfo', `100644,${sha},games/y/runtime/assets/scenes/B.scene.json`]);

      const dry = run(tmp);
      expect(dry).toMatch(/1 UIAnchor\.zIndex key\(s\) in 1 file\(s\) would be rewritten/);

      const written = run(tmp, ['--write']);
      expect(written).toMatch(/1 UIAnchor\.zIndex key\(s\) in 1 file\(s\) rewritten/);
      expect(readJson(file).entities[0].traits.UIElement.zIndex).toBe(3);
    },
  );

  it('aborts with the git-failure message when the root is not a git work tree, writes nothing', () => {
    tmp = makeRepo({ gitInit: false });
    const file = writeJson(tmp, 'games/x/runtime/assets/scenes/a.scene.json', sceneWithAnchorZIndex(5));
    const before = fs.readFileSync(file, 'utf8');

    const { status, out } = runAllowFail(tmp);
    expect(status).toBe(1);
    expect(out).toMatch(/ABORT: could not enumerate files through git/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  // The data-loss fix (b1c548954): a prefab-instance OVERRIDE bag with a truthy UIAnchor.zIndex
  // and no sibling UIElement must CARRY the value onto a newly created UIElement, not just delete
  // the key — unlike the `traits` case, "no UIElement here" only means this override hasn't
  // touched UIElement yet, not that the entity lacks the trait.
  it('an override bag with no sibling UIElement CARRIES the value onto a created UIElement', () => {
    tmp = makeRepo();
    const file = writeJson(tmp, 'games/z/runtime/assets/scenes/inst.scene.json', {
      version: 9,
      entities: [
        {
          name: 'Inst',
          localId: 1,
          traits: { PrefabInstance: { rootInstanceId: 'a'.repeat(8) + '-0000-4000-8000-000000000000' } },
          overrides: {
            '2': { UIAnchor: { zIndex: 7 } },
          },
        },
      ],
    });

    run(tmp, ['--write']);

    const after = readJson(file);
    const overrideBag = after.entities[0].overrides['2'];
    expect(overrideBag.UIElement).toBeDefined();
    expect(overrideBag.UIElement.zIndex).toBe(7);
    expect(overrideBag.UIAnchor).not.toHaveProperty('zIndex');
  });
});
