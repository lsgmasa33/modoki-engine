/** `check-prefab-churn.mjs` reads a reference row's STATEMENT, not its raw fields (#2001 S6): a prefab v10 row states on
 *  `members` what an older row stated in `overrides`, so a re-save moves every row from one field to the other. Compared
 *  raw, each of them prints two NESTED lines and a row whose statement really changed is one more pair among them.
 *
 *  The script is run for real, in a throwaway git repo (it diffs the working tree against HEAD).
 *
 *  Mutations (each measured): `rowStatement` keying every localId's bag on `"/"` (no root test) — the member case of
 *  'the same statement' is listed as changed; the gate not skipping the statement fields (`sameStatement && …` →
 *  `false`) — both 'same statement' cases list NESTED lines; `members` out of `NESTED_FIELDS` — the 'v10 row whose
 *  statement changed' case prints nothing, and 'a statement that changed on the way' prints one field. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
// @ts-expect-error a plain .mjs script module, no types
import { rowStatement, canonicalJson } from '../../scripts/prefabRowStatement.mjs';

const REAL_SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const SCRIPT_REL = path.join('engine', 'scripts', 'check-prefab-churn.mjs');

let tmp: string | undefined;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

function git(repo: string, args: string[]): void {
  const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
}
function makeRepo(): string {
  const dir = makeScratchDir('modoki-prefab-churn-');
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
  fs.cpSync(REAL_SCRIPTS_DIR, path.join(dir, 'engine', 'scripts'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}
const write = (repo: string, rel: string, data: unknown): void => {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
};
/** `nodeArgs` lets a test run the script under a path spelling git does not report (#2126). */
const run = (repo: string, nodeArgs: string[] = []): { status: number; out: string } => {
  const r = spawnSync('node', [...nodeArgs, path.join(repo, SCRIPT_REL), 'games/x'], { cwd: repo, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const gA = 'bbbbbbbb-0000-4000-8000-000000000002';
const inner = {
  id: P, version: 5, name: 'P', rootLocalId: 1,
  entities: [
    { localId: 1, nodeGuid: 'bbbbbbbb-0000-4000-8000-000000000001', name: 'R', traits: {} },
    { localId: 2, nodeGuid: gA, name: 'A', traits: {} },
  ],
};
type Row = Record<string, unknown>;
const outer = (version: number, row: Row) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000002', version, name: 'O', rootLocalId: 1,
  entities: [{ localId: 1, name: 'Root', traits: {} }, { localId: 2, name: 'N', prefab: P, traits: {}, ...row }],
});
const P_REL = 'games/x/runtime/assets/prefabs/p.prefab.json';
const O_REL = 'games/x/runtime/assets/prefabs/o.prefab.json';
/** Commit O with `before`, rewrite it with `after`, and run the gate. */
function churn(before: Row, after: Row, versions: [number, number] = [5, 10]) {
  tmp = makeRepo();
  write(tmp, P_REL, inner);
  write(tmp, O_REL, outer(versions[0], before));
  git(tmp, ['add', '-A']);
  git(tmp, ['commit', '-q', '-m', 'base']);
  write(tmp, O_REL, outer(versions[1], after));
  return run(tmp);
}

describe('check-prefab-churn reads a reference row\'s statement', () => {
  it.each([
    ['the nested root', { overrides: { 1: { EntityAttributes: { name: 'N', sortOrder: 2 } } } }, { members: { '/': { traits: { EntityAttributes: { sortOrder: 2, name: 'N' } } } } }],
    ['a member', { overrides: { 2: { Transform: { x: 3 } } } }, { members: { [`/${gA}`]: { traits: { Transform: { x: 3 } } } } }],
  ])('the same statement in the member-row form is counted, not listed (%s)', (_who, before, after) => {
    const { status, out } = churn(before, after);
    expect(out).not.toMatch(/NESTED/);
    expect(out).toMatch(/rewritten: 1 {2}with semantic changes: 0/);
    expect(out).toMatch(/restated in the member-row form with the same statement: 1$/m);
    expect(status).toBe(0);
  });

  it('a statement that changed on the way is listed, both fields', () => {
    const { out } = churn({ overrides: { 2: { Transform: { x: 3 } } } }, { members: { [`/${gA}`]: { traits: { Transform: { x: 4 } } } } });
    expect(out).toMatch(/NESTED N#2\.overrides \{"2":\{"Transform":\{"x":3\}\}\} -> absent/);
    expect(out).toMatch(/NESTED N#2\.members absent -> .*"x":4/);
    expect(out).not.toMatch(/restated/);
  });

  it('a statement the row lost is listed', () => {
    const { out } = churn({ overrides: { 2: { Transform: { x: 3 } } } }, {});
    expect(out).toMatch(/NESTED N#2\.overrides .* -> absent/);
  });

  it('a v10 row whose statement changed is listed', () => {
    const { out } = churn({ members: { [`/${gA}`]: { traits: { Transform: { x: 3 } } } } }, { members: { [`/${gA}`]: { traits: { Transform: { x: 4 } } } } }, [10, 10]);
    expect(out).toMatch(/NESTED N#2\.members .*"x":3.* -> .*"x":4/);
  });

  it('a row it cannot restate falls back to the raw fields', () => {
    // An `added` list (its nodes become `own` under an anchor row, which needs the parser), and a localId the nested
    // document does not have.
    for (const before of [{ overrides: { 2: { Transform: { x: 3 } } }, added: [{ name: 'X' }] }, { overrides: { 9: { Transform: { x: 3 } } } }]) {
      expect(rowStatement(before, inner)).toBeNull();
    }
    expect(rowStatement({ overrides: { 2: { Transform: { x: 3 } } } }, undefined)).toBeNull();
    // Stated in both forms for one member: which wins is the parser's rule, not this module's.
    expect(rowStatement({ overrides: { 1: { Transform: { x: 3 } } }, members: { '/': { traits: { Transform: { x: 4 } } } } }, inner)).toBeNull();
    expect(canonicalJson(rowStatement({ prefab: P }, inner))).toBe('{}');
  });
});

/** #2126: the script ran from a path spelled differently from git's toplevel — on the Windows runner `os.tmpdir()` is the
 *  8.3 short name (`C:\\Users\\RUNNER~1`) and git reports the long one. The script recomputed each file's repo path as
 *  `path.relative(ROOT, abs)` between the two spellings, got `../../../../runneradmin/…`, and `git show HEAD:<that>` failed
 *  — read as "not in HEAD", so every committed prefab printed NEW FILE (untracked) and its diff was skipped. A Mac has no
 *  short names, so the same mechanism is driven here by a symlink: `--preserve-symlinks-main` keeps the script's own path
 *  (its ROOT) in the link's spelling, while git reports the real directory.
 *
 *  Mutation (measured): `rel` recomputed as `path.relative(ROOT, abs)` again — this test prints NEW FILE (untracked)
 *  and `rewritten: 0`. */
describe('check-prefab-churn under a path spelling git does not report (#2126)', () => {
  it('diffs a committed prefab instead of reporting it untracked', () => {
    tmp = makeRepo();
    write(tmp, P_REL, inner);
    write(tmp, O_REL, outer(5, { overrides: { 2: { Transform: { x: 3 } } } }));
    git(tmp, ['add', '-A']);
    git(tmp, ['commit', '-q', '-m', 'base']);
    write(tmp, O_REL, outer(10, { members: { [`/${gA}`]: { traits: { Transform: { x: 4 } } } } }));
    // The link lives in its own scratch dir so the afterEach's rm of `tmp` and the scratch cleanup each own one thing.
    const link = path.join(makeScratchDir('modoki-prefab-churn-link-'), 'repo');
    fs.symlinkSync(tmp, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { out } = run(link, ['--preserve-symlinks-main']);
    expect(out).not.toMatch(/NEW FILE|outside repository/);
    expect(out).toMatch(/rewritten: 1 /);
    expect(out).toMatch(/NESTED N#2\.members absent -> .*"x":4/);
  });
});
