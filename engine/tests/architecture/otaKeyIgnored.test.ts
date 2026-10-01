/** #1983: a project's OTA signing key (`<project>/build/ota-keys/<name>.json`, a private Ed25519 key)
 *  can never be committed. A leaked key lets anyone sign updates every installed build trusts; it
 *  cannot be revoked, because the public half is baked into the binaries.
 *
 *  First line of defence, tested in ota/keyStore.test.ts: the key folder ignores itself (a `.gitignore`
 *  of `*` written whenever it is created), so a key is ignored in ANY project. Then four more, because
 *  the key travels four ways:
 *  - inside this repo: every project under every root in `PROJECT_ROOT_DIRS` is ignored by a TRACKED
 *    `.gitignore` (the repo's, or the project's own), and the repo's names each root explicitly;
 *  - in a project scaffolded anywhere (File → New Project, or the CLI): the template's `gitignore`,
 *    which both scaffolders rename to `.gitignore`;
 *  - in a project copied out of the repo (#29): an OTA-enabled project carries its own rule;
 *  - in a published demo snapshot: `publish-demo.sh` writes the stage's `.gitignore`.
 *  And nothing under a `build/ota-keys/` is tracked today (the scan in scan-publish-safety.mjs refuses
 *  one in a snapshot too). */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readJsonFile } from '../../scripts/jsonFile.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { scaffoldProject } from '../../electron/newProject';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { hasInternalGames, hasPublishScripts } from '../helpers/repoLayout';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RULE = 'build/ota-keys/';
/** An ignore file's rules (or a script's text) ARE the data here, comments and all. */
const text = (file: string) => readScannedSource(file, { comments: 'include', reason: 'ignore rules and a heredoc are the data, not code' }).raw;
const lines = (file: string) => text(file).split(/\r?\n/).map((l) => l.trim());

const git = (args: string[]) => {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status === null) throw new Error(`git ${args.join(' ')} did not run: ${r.error}`);
  return r;
};
const tracked = new Set(repoFiles({ includeUntracked: false, floor: 1000 }).map((f: { rel: string }) => f.rel));

/** The tracked `.gitignore` that ignores `rel`, or null when nothing does. Only a TRACKED source counts:
 *  a machine's global excludes would keep this green here and leave the hole open in every other clone.
 *  A status other than 0/1 is a broken instrument and throws. */
function trackedIgnoreSource(rel: string): string | null {
  const r = git(['check-ignore', '-v', '--no-index', rel]);
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed for ${rel}: status=${r.status} ${r.stderr}`);
  if (r.status === 1) return null;
  const source = r.stdout.split(':')[0];
  return tracked.has(source) ? source : null;
}

const projects = PROJECT_ROOT_DIRS.flatMap((root) => {
  const dir = path.join(REPO_ROOT, root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'project.config.json')))
    .map((e) => `${root}/${e.name}`);
});

describe('a project\'s OTA key path can never be committed (#1983)', () => {
  it('finds the projects (a scan that found none would pass vacuously)', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  // The public engine snapshot ships no games/ (repoLayout.ts), so these two hold only here.
  it.skipIf(!hasInternalGames())('finds the internal games, the OTA fixture among them', () => {
    expect(projects.length).toBeGreaterThan(10);
    expect(projects).toContain('games/ota-test');
  });

  it('every project\'s build/ota-keys is ignored by a tracked .gitignore', () => {
    const open = projects.filter((p) => trackedIgnoreSource(`${p}/${RULE}default.json`) === null);
    expect(open, 'these projects could commit their OTA signing key').toEqual([]);
  });

  it('the repo\'s .gitignore names every project root, so deleting a project\'s own rule cannot open it', () => {
    const root = lines(path.join(REPO_ROOT, '.gitignore'));
    for (const dir of PROJECT_ROOT_DIRS) expect(root, `${dir}/*/${RULE}`).toContain(`${dir}/*/${RULE}`);
    // The pre-#1983 location stays ignored: editors before #1983 wrote keys there, and they are kept.
    expect(root).toContain(`/${RULE}`);
  });

  it('nothing under a build/ota-keys/ is tracked', () => {
    expect([...tracked].filter((f) => /(^|\/)build\/ota-keys\//.test(f))).toEqual([]);
  });

  it.skipIf(!hasInternalGames())('an OTA-enabled project carries its own rule, so a copy taken out of the repo keeps it', () => {
    const enabled = projects.filter((p) => {
      const cfg = readJsonFile(path.join(REPO_ROOT, p, 'project.config.json')) as { ota?: { enabled?: unknown } };
      return cfg.ota?.enabled === true;
    });
    expect(enabled.length).toBeGreaterThan(0);
    for (const p of enabled) {
      const own = path.join(REPO_ROOT, p, '.gitignore');
      expect(fs.existsSync(own) && lines(own).includes(RULE), `${p}/.gitignore must list ${RULE}`).toBe(true);
    }
  });

  it('a scaffolded project gets the rule as its own .gitignore', () => {
    expect(lines(path.join(REPO_ROOT, 'engine', 'templates', 'starter', 'gitignore'))).toContain(RULE);
    const dest = path.join(makeScratchDir('modoki-ota-key-scaffold-'), 'proj');
    try {
      scaffoldProject(dest, { name: 'Key Test', templateDir: path.join(REPO_ROOT, 'engine', 'templates', 'starter') });
      expect(fs.existsSync(path.join(dest, 'gitignore'))).toBe(false);
      expect(lines(path.join(dest, '.gitignore'))).toContain(RULE);
    } finally {
      fs.rmSync(path.dirname(dest), { recursive: true, force: true });
    }
  });

  it('the CLI scaffolder renames it the same way', () => {
    const scratch = makeScratchDir('modoki-ota-key-scaffold-cli-');
    try {
      const dest = path.join(scratch, 'proj');
      const r = spawnSync('node', [path.join(REPO_ROOT, 'engine', 'scripts', 'scaffold-project.mjs'), dest, 'Key Test'], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(lines(path.join(dest, '.gitignore'))).toContain(RULE);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // The snapshot ships no scripts/ (publishExclusions.test.ts), so the demo publisher is checked here only.
  it.skipIf(!hasPublishScripts())('a published demo snapshot ignores it too', () => {
    const script = text(path.join(REPO_ROOT, 'scripts', 'publish-demo.sh'));
    const heredoc = script.match(/cat > "\$\{STAGE\}\/\.gitignore" <<'EOF'\n([\s\S]*?)\nEOF/);
    expect(heredoc, 'publish-demo.sh no longer writes the stage .gitignore from a heredoc').not.toBeNull();
    expect(heredoc![1].split('\n').map((l) => l.trim())).toContain(RULE);
  });
});
