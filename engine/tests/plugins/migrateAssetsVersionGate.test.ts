/** `engine/scripts/migrate-assets.mjs` must not rewrite or re-stamp a document a NEWER build wrote
 *  (#1468, found by the close-out sweep of the same defect in `migrate-anchor-zindex.mjs`).
 *
 *  The script had both halves of it:
 *
 *   - the scene stamp was `json.version !== SCENE_FORMAT_VERSION`, so a scene written by a newer
 *     build was stamped back DOWN to this build's number — the file then claims a shape this build
 *     cannot produce, and a later reader migrates it as something it is not;
 *   - prefabs are rewritten here too (`TRANSFORMS` runs on them; the docblock says so), with no
 *     version check at all, so a newer prefab was run through this build's understanding of its
 *     fields.
 *
 *  Until this file `npm run verify` ran the script ZERO times. It runs the REAL script as a
 *  subprocess against a THROWAWAY repo built at the relative depth the script expects, exactly as
 *  `migrateAnchorZIndex.test.ts` does — never against the real corpus.
 *
 *  ⚠️ The script has no git dependency (it enumerates through `repoCorpus.mjs`), but the harness
 *  still `git init`s, because `repoFiles` reads the index. */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

import { SCENE_FORMAT_VERSION, PREFAB_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';

const REAL_SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const REAL_REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION_TS = path.join('engine', 'packages', 'modoki', 'src', 'runtime', 'core', 'version.ts');
const SCRIPT_REL = path.join('engine', 'scripts', 'migrate-assets.mjs');

let tmp: string | undefined;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

function git(repo: string, args: string[]): void {
  const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
}

/** The whole scripts directory, not a hand-named import list — the same reasoning
 *  `migrateAnchorZIndex.test.ts` records: a per-file list drifts the day the script gains an
 *  import, and that is the failure this family of changes exists to remove. */
function makeRepo(): string {
  const dir = makeScratchDir('modoki-migrate-assets-');
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
  fs.cpSync(REAL_SCRIPTS_DIR, path.join(dir, 'engine', 'scripts'), { recursive: true });
  // ⚠️ The REAL version.ts, copied, not a stub with literals: the script regex-reads both constants
  // out of it precisely so a stale literal cannot silently downgrade what it stamps. Stubbing it
  // here would make this harness the second copy of the constants and reintroduce that drift one
  // level out.
  fs.mkdirSync(path.join(dir, path.dirname(VERSION_TS)), { recursive: true });
  fs.copyFileSync(path.join(REAL_REPO_ROOT, VERSION_TS), path.join(dir, VERSION_TS));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function writeJson(repo: string, rel: string, data: unknown): string {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2));
  git(repo, ['add', '--', rel]);
  return full;
}
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;

/** ⚠️ The script's two `repoFiles` calls each carry a non-vacuity `floor: 20` — a deliberate guard
 *  (a codemod that matches nothing and reports success is this family's own recorded failure), and
 *  it means a one-file fixture repo makes the script ABORT rather than run. So the harness seeds 20
 *  already-current documents of each kind beside the fixture. They are at the current version, so
 *  they are rewritten by nothing and cannot contribute to any assertion below. */
function seedFloor(repo: string): void {
  for (let i = 0; i < 20; i++) {
    writeJson(repo, `games/x/runtime/assets/scenes/filler${i}.scene.json`, sceneDoc(SCENE_FORMAT_VERSION));
    writeJson(repo, `games/x/runtime/assets/prefabs/filler${i}.prefab.json`, prefabDoc(PREFAB_FORMAT_VERSION));
  }
}
const run = (repo: string, args: string[] = []): string =>
  execFileSync('node', [path.join(repo, SCRIPT_REL), ...args], { cwd: repo, encoding: 'utf8' });

const SCENE = 'games/x/runtime/assets/scenes/a.scene.json';
const PREFAB = 'games/x/runtime/assets/prefabs/p.prefab.json';
/** A prefab is what has a `rootLocalId`; a scene is what does not. That is the script's own test. */
const prefabDoc = (version: number) => ({ version, rootLocalId: 1, entities: [{ localId: 1, traits: {} }] });
const sceneDoc = (version: number) => ({ version, entities: [{ id: 1, traits: {} }] });

describe('migrate-assets refuses a document a newer build wrote (#1468)', () => {
  it('leaves a too-new SCENE untouched instead of stamping it DOWN', () => {
    tmp = makeRepo();
    seedFloor(tmp);
    const file = writeJson(tmp, SCENE, sceneDoc(SCENE_FORMAT_VERSION + 1));
    const out = run(tmp);
    expect(out).toMatch(/SKIP .*a\.scene\.json: format/);
    expect(out).toMatch(/1 file\(s\) SKIPPED/);
    expect(readJson(file).version).toBe(SCENE_FORMAT_VERSION + 1);
  });

  it('leaves a too-new PREFAB untouched — it is rewritten here too, and had no check at all', () => {
    tmp = makeRepo();
    seedFloor(tmp);
    const file = writeJson(tmp, PREFAB, prefabDoc(PREFAB_FORMAT_VERSION + 1));
    const out = run(tmp);
    expect(out).toMatch(/SKIP .*p\.prefab\.json: format/);
    expect(readJson(file).version).toBe(PREFAB_FORMAT_VERSION + 1);
  });

  it('compares a PREFAB against the prefab ladder, not the scene one', () => {
    // The two numbers are unrelated and the prefab one is much lower, so a single shared constant
    // would let a too-new prefab through (or refuse every scene). Pinned because the script derives
    // `target` from the document's own kind, and that line is easy to simplify wrongly.
    expect(PREFAB_FORMAT_VERSION).toBeLessThan(SCENE_FORMAT_VERSION); // fixture premise, stated
    tmp = makeRepo();
    seedFloor(tmp);
    const file = writeJson(tmp, PREFAB, prefabDoc(SCENE_FORMAT_VERSION));
    run(tmp);
    expect(readJson(file).version).toBe(SCENE_FORMAT_VERSION); // refused, not stamped to the prefab number
  });

  it('still stamps an OLDER scene forward — the refusal is one-sided', () => {
    // The whole corpus is below the current number; an exact-match check would refuse all of it.
    tmp = makeRepo();
    seedFloor(tmp);
    const file = writeJson(tmp, SCENE, sceneDoc(1));
    expect(run(tmp)).toMatch(/1 file\(s\) would be |migrated/);
    expect(readJson(file).version).toBe(SCENE_FORMAT_VERSION);
  });

  it('leaves a scene ALREADY at the current version alone, and does not report it as skipped', () => {
    tmp = makeRepo();
    seedFloor(tmp);
    const file = writeJson(tmp, SCENE, sceneDoc(SCENE_FORMAT_VERSION));
    const out = run(tmp);
    expect(out).not.toMatch(/SKIPPED/);
    expect(readJson(file).version).toBe(SCENE_FORMAT_VERSION);
  });
});
