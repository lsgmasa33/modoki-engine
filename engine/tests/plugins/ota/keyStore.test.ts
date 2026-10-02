/** `keyStore.mjs` (#1983) on the edges the route and CLI tests do not reach: the folder ignores itself in
 *  any project, the adopted copy is restricted even when its source is not, a key that appears between
 *  the check and the copy is never overwritten, and a copy that does not match its source is removed
 *  while the original stays. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { adoptLegacyKey, ensureKeyDir, projectKeyPath } from '../../../scripts/ota/keyStore.mjs';
import { generateKeypair } from '../../../scripts/ota/signing.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const KEY = generateKeypair();
let scratch: string;
let projectRoot: string;
let editorRoot: string;
const quiet = () => {};
const plant = (root: string, mode = 0o600) => {
  const file = projectKeyPath(root, 'default');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(KEY), { mode });
  fs.chmodSync(file, mode);
  return fs.readFileSync(file);
};
const adopt = (log: (line: string) => void = quiet) => adoptLegacyKey({ projectRoot, editorRoot, name: 'default', expectedPublicKey: KEY.publicKey, configReadable: true, log });

beforeEach(() => {
  scratch = makeScratchDir('modoki-ota-keystore-');
  projectRoot = path.join(scratch, 'outside-project');
  editorRoot = path.join(scratch, 'editor');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(editorRoot, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true }); });

describe('keyStore (#1983)', () => {
  it('the key folder ignores itself, in a git project with no ignore rules of its own', () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: projectRoot }).status).toBe(0);
    plant(editorRoot);
    const { keyPath, copiedFrom } = adopt();
    expect(copiedFrom).not.toBeNull();
    expect(fs.existsSync(path.join(projectRoot, '.gitignore'))).toBe(false);
    const rel = path.relative(projectRoot, keyPath);
    const r = spawnSync('git', ['check-ignore', '-q', rel], { cwd: projectRoot });
    expect(r.status, 'the adopted key is NOT ignored').toBe(0);
  });

  it('a key placed by hand (a second machine) is healed on the next read: its folder then ignores itself', () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: projectRoot }).status).toBe(0);
    plant(projectRoot);
    const rel = path.relative(projectRoot, projectKeyPath(projectRoot, 'default'));
    expect(spawnSync('git', ['check-ignore', '-q', rel], { cwd: projectRoot }).status).toBe(1); // committable
    adopt();
    expect(spawnSync('git', ['check-ignore', '-q', rel], { cwd: projectRoot }).status).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('a heal that cannot write is a warning: the key is there and valid, so a publish still gets it', () => {
    const original = plant(projectRoot);
    const dir = path.dirname(projectKeyPath(projectRoot, 'x'));
    fs.chmodSync(dir, 0o500);
    try {
      const lines: string[] = [];
      const r = adopt((l) => lines.push(l));
      expect(r.keyPath).toBe(projectKeyPath(projectRoot, 'default'));
      expect(lines.join('\n')).toMatch(/warning: could not write .*\.gitignore/);
      expect(fs.readFileSync(r.keyPath).equals(original)).toBe(true);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('a SYMLINKED key folder (a backup repo, say) is never given a .gitignore', () => {
    const backup = path.join(scratch, 'key-backup');
    plant(backup);
    fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true });
    fs.symlinkSync(path.join(backup, 'build', 'ota-keys'), path.join(projectRoot, 'build', 'ota-keys'), 'junction');
    adopt();
    expect(fs.existsSync(path.join(backup, 'build', 'ota-keys', '.gitignore'))).toBe(false);
  });

  it('a symlinked build/ (not just build/ota-keys) is a folder outside the project too: no .gitignore lands in it (#1994 A)', () => {
    const backup = path.join(scratch, 'build-backup');
    fs.mkdirSync(path.join(backup, 'ota-keys'), { recursive: true });
    fs.writeFileSync(path.join(backup, 'ota-keys', 'default.json'), JSON.stringify(KEY));
    fs.symlinkSync(backup, path.join(projectRoot, 'build'), 'junction');
    adopt();
    expect(fs.existsSync(path.join(backup, 'ota-keys', '.gitignore'))).toBe(false);
  });

  it('the COPY path writes no .gitignore through a symlinked key folder either (#1994 B)', () => {
    const backup = path.join(scratch, 'key-backup');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true });
    fs.symlinkSync(backup, path.join(projectRoot, 'build', 'ota-keys'), 'junction');
    plant(editorRoot);
    const { copiedFrom } = adopt();
    expect(copiedFrom).not.toBeNull();
    expect(fs.existsSync(path.join(backup, 'default.json'))).toBe(true); // the backup still receives the key
    expect(fs.existsSync(path.join(backup, '.gitignore'))).toBe(false);
  });

  it('ensureKeyDir — what keygen\'s mint calls — leaves a symlinked folder alone, and still ignores a real one (#1994 B)', () => {
    const backup = path.join(scratch, 'key-backup');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true });
    fs.symlinkSync(backup, path.join(projectRoot, 'build', 'ota-keys'), 'junction');
    ensureKeyDir(projectRoot);
    expect(fs.existsSync(path.join(backup, '.gitignore'))).toBe(false);
    const other = path.join(scratch, 'other-project');
    fs.mkdirSync(other);
    ensureKeyDir(other);
    expect(fs.existsSync(path.join(other, 'build', 'ota-keys', '.gitignore'))).toBe(true);
  });

  it('a link to a sibling folder in the SAME work tree still gets the `*`: git would see the key there (#1994 review)', () => {
    const repo = path.join(scratch, 'repo');
    const game = path.join(repo, 'games', 'foo');
    fs.mkdirSync(game, { recursive: true });
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    fs.mkdirSync(path.join(repo, 'games', 'foo-build'));
    fs.symlinkSync(path.join(repo, 'games', 'foo-build'), path.join(game, 'build'), 'junction');
    ensureKeyDir(game);
    fs.writeFileSync(path.join(repo, 'games', 'foo-build', 'ota-keys', 'default.json'), JSON.stringify(KEY));
    expect(spawnSync('git', ['check-ignore', '-q', 'games/foo-build/ota-keys/default.json'], { cwd: repo }).status).toBe(0);
  });

  it('a backup that is its OWN repo nested (gitignored) inside the project\'s tree gets no `*`: same tree, different repo (#1994 re-review)', () => {
    const repo = path.join(scratch, 'repo');
    const game = path.join(repo, 'games', 'foo');
    const backup = path.join(repo, '.ota-backup');
    fs.mkdirSync(game, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    expect(spawnSync('git', ['init', '-q'], { cwd: backup }).status).toBe(0);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.ota-backup/\n');
    fs.symlinkSync(backup, path.join(game, 'build'), 'junction');
    ensureKeyDir(game);
    expect(fs.existsSync(path.join(backup, 'ota-keys', '.gitignore'))).toBe(false);
  });

  it('a project IN git whose key folder links OUT of its work tree gets no `*` there', () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: projectRoot }).status).toBe(0);
    const backup = path.join(scratch, 'key-backup');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true });
    fs.symlinkSync(backup, path.join(projectRoot, 'build', 'ota-keys'), 'junction');
    ensureKeyDir(projectRoot);
    expect(fs.existsSync(path.join(backup, '.gitignore'))).toBe(false);
  });

  it('a hand-copied key of ANOTHER name is healed by a read of default (#1994: the docs promise "the first OTA Keys read")', () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: projectRoot }).status).toBe(0);
    const release = projectKeyPath(projectRoot, 'release');
    fs.mkdirSync(path.dirname(release), { recursive: true });
    fs.writeFileSync(release, JSON.stringify(KEY));
    const rel = path.relative(projectRoot, release);
    expect(spawnSync('git', ['check-ignore', '-q', rel], { cwd: projectRoot }).status).toBe(1); // committable
    adopt(); // asks about `default`, which does not exist
    expect(spawnSync('git', ['check-ignore', '-q', rel], { cwd: projectRoot }).status).toBe(0);
  });

  it('a file that only CLAIMS the project\'s public half is passed over, and the real key further up is adopted (#1993)', () => {
    // The editor root is searched first: the planted file shadowed the real key there.
    fs.mkdirSync(path.dirname(projectKeyPath(editorRoot, 'default')), { recursive: true });
    fs.writeFileSync(projectKeyPath(editorRoot, 'default'), JSON.stringify({ publicKey: KEY.publicKey, privateKey: generateKeypair().privateKey }));
    const real = plant(scratch); // an ancestor of the project
    const lines: string[] = [];
    const r = adopt((l) => lines.push(l));
    expect(r.copiedFrom).toBe(projectKeyPath(scratch, 'default'));
    expect(fs.readFileSync(r.keyPath).equals(real)).toBe(true);
    expect(lines.join('\n')).toMatch(/not copying .*privateKey does not derive its publicKey/);
  });

  it('configReadable is required: forgetting it cannot silently mean "no public key"', () => {
    expect(() => adoptLegacyKey({ projectRoot, editorRoot, name: 'default', expectedPublicKey: KEY.publicKey } as unknown as Parameters<typeof adoptLegacyKey>[0]))
      .toThrow(/configReadable is required/);
  });

  it('two first reads at once: the loser of the .gitignore write does not throw', () => {
    const dir = path.dirname(projectKeyPath(projectRoot, 'x'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'the winner\'s\n');
    const real = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === path.join(dir, '.gitignore') ? false : real(p)));
    expect(() => ensureKeyDir(projectRoot)).not.toThrow();
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('the winner\'s\n');
  });

  it('ensureKeyDir never replaces a .gitignore already in the folder', () => {
    const dir = path.dirname(projectKeyPath(projectRoot, 'x'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'mine\n');
    ensureKeyDir(projectRoot);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it.skipIf(process.platform === 'win32')('the adopted copy is owner-only even when its source was not', () => {
    plant(editorRoot, 0o644);
    const { keyPath } = adopt();
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('a key that appears between the check and the copy is never overwritten', () => {
    plant(editorRoot);
    const keyPath = projectKeyPath(projectRoot, 'default');
    ensureKeyDir(projectRoot);
    fs.writeFileSync(keyPath, 'the racing writer\'s key');
    const real = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === keyPath ? false : real(p)));
    const r = adopt();
    expect(r.copiedFrom).toBeNull();
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('the racing writer\'s key');
  });

  it('a copy that does not match its source is removed, the original stays, and the error says what to do', () => {
    const original = plant(editorRoot);
    const keyPath = projectKeyPath(projectRoot, 'default');
    vi.spyOn(fs, 'copyFileSync').mockImplementation((_src, dest) => { fs.writeFileSync(String(dest), 'truncated'); });
    expect(() => adopt()).toThrow(/not byte-identical.*original is untouched.*Copy it there yourself/s);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.readFileSync(projectKeyPath(editorRoot, 'default')).equals(original)).toBe(true);
  });
});
