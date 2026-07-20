/** recent-projects persistence — the editor's "remember last project" history.
 *
 *  Verifies the shared (dev+packaged) recents file under a fixed "modoki-app" dir,
 *  the prepend/dedup/cap of addRecentProject, the existence filter on read, and the
 *  one-time migration that folds the legacy dev location (…/Electron/) in ahead of
 *  the shared file. `electron` is mocked; fs is real, rooted at a temp dir. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// app.getPath('appData') → <tmp>/appData ; app.getPath('userData') → <tmp>/userData.
const root = { dir: '' };
vi.mock('electron', () => ({
  app: { getPath: (name: string) => path.join(root.dir, name) },
  dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
}));

import { getRecentProjects, addRecentProject, migrateLegacyRecents, setRecentsScope, chooseInitialProject, isUnderRepo, projectFolderKind } from '../../electron/projects';

const sharedFile = () => path.join(root.dir, 'appData', 'modoki-app', 'recent-projects.json');
// The legacy DEV recents location is the literal appData/"Electron" dir — dev's userData
// USED to be that, but userDataDir.ts now scopes userData per clone, so the migration source
// is pinned to the old path rather than re-derived from getPath('userData') (which would
// point at the new, empty dir and silently disable the migration).
const legacyFile = () => path.join(root.dir, 'appData', 'Electron', 'recent-projects.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

let counter = 0;
/** Make a real, existing project dir so the existence filter keeps it. */
function mkProj(name: string): string {
  const p = path.join(root.dir, 'projects', name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  root.dir = fs.mkdtempSync(path.join(os.tmpdir(), `modoki-recents-${counter++}-`));
  setRecentsScope(''); // reset to the unscoped (global) default; scoped tests opt in
});

describe('recent projects', () => {
  it('writes to the shared modoki-app dir, prepends newest, dedups', () => {
    const a = mkProj('a'), b = mkProj('b');
    addRecentProject(a);
    addRecentProject(b);
    addRecentProject(a); // re-open a → moves to front, no duplicate
    expect(getRecentProjects()).toEqual([a, b]);
    expect(fs.existsSync(sharedFile())).toBe(true); // NOT under userData
  });

  it('drops entries whose folder no longer exists', () => {
    const a = mkProj('a');
    const gone = path.join(root.dir, 'projects', 'gone');
    fs.mkdirSync(path.dirname(sharedFile()), { recursive: true });
    fs.writeFileSync(sharedFile(), JSON.stringify([gone, a]));
    expect(getRecentProjects()).toEqual([a]); // `gone` filtered out
  });

  it('caps the list at 10', () => {
    const projs = Array.from({ length: 12 }, (_, i) => mkProj(`p${i}`));
    for (const p of projs) addRecentProject(p);
    const list = read(sharedFile());
    expect(list).toHaveLength(10);
    expect(list[0]).toBe(projs[11]); // most-recent first
  });

  it('migrates legacy dev recents ahead of the shared file, once', () => {
    const sling = mkProj('sling'), threeD = mkProj('3d-test'), space = mkProj('space');
    // Legacy (dev/Electron) history — actively used, sling on top.
    fs.mkdirSync(path.dirname(legacyFile()), { recursive: true });
    fs.writeFileSync(legacyFile(), JSON.stringify([sling, threeD]));
    // Stale shared file from earlier packaged runs.
    fs.mkdirSync(path.dirname(sharedFile()), { recursive: true });
    fs.writeFileSync(sharedFile(), JSON.stringify([space, threeD]));

    migrateLegacyRecents();

    // Legacy order wins (prepended), dedup keeps first occurrence.
    expect(read(sharedFile())).toEqual([sling, threeD, space]);
    expect(getRecentProjects()[0]).toBe(sling);
    // Legacy file renamed → migration is one-time.
    expect(fs.existsSync(legacyFile())).toBe(false);
    expect(fs.existsSync(`${legacyFile()}.migrated`)).toBe(true);

    // Running again is a no-op (legacy already gone).
    migrateLegacyRecents();
    expect(read(sharedFile())).toEqual([sling, threeD, space]);
  });

  it('migration is a no-op when there is no legacy file', () => {
    const a = mkProj('a');
    addRecentProject(a);
    migrateLegacyRecents();
    expect(getRecentProjects()).toEqual([a]);
  });
});

describe('per-editor-identity recents scoping', () => {
  const recentsDir = () => path.join(root.dir, 'appData', 'modoki-app', 'recents');

  it('a scoped editor writes under recents/, NOT the global file', () => {
    const a = mkProj('a');
    setRecentsScope('/Applications/Modoki Editor.app');
    addRecentProject(a);
    expect(getRecentProjects()).toEqual([a]);
    expect(fs.existsSync(sharedFile())).toBe(false);        // global untouched
    const files = fs.readdirSync(recentsDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^Modoki-Editor\.app-[0-9a-f]{8}\.json$/); // sanitized basename + hash
  });

  it('two editor identities keep independent histories', () => {
    const a = mkProj('a'), b = mkProj('b');
    setRecentsScope('/Applications/Modoki Editor.app'); // packaged install
    addRecentProject(a);
    setRecentsScope('/Users/x/Projects/modoki-ai');      // a dev clone
    addRecentProject(b);
    expect(getRecentProjects()).toEqual([b]);            // dev clone sees only its own
    setRecentsScope('/Applications/Modoki Editor.app');
    expect(getRecentProjects()).toEqual([a]);            // packaged sees only its own
    expect(fs.readdirSync(recentsDir())).toHaveLength(2);
  });

  it('does NOT seed a scoped file from the global junk-drawer (no other-instance projects)', () => {
    const a = mkProj('a'), b = mkProj('b');
    // Pre-scoping global history — a mix of THIS + OTHER instances' projects.
    fs.mkdirSync(path.dirname(sharedFile()), { recursive: true });
    fs.writeFileSync(sharedFile(), JSON.stringify([a, b]));
    setRecentsScope('/Applications/Modoki Editor.app');
    migrateLegacyRecents(); // must NOT copy the global into the scoped file
    expect(getRecentProjects()).toEqual([]); // scoped recents start empty
    // Only what THIS instance opens lands in its recents.
    addRecentProject(a);
    expect(getRecentProjects()).toEqual([a]);
    // A different identity is independent and likewise starts from nothing.
    setRecentsScope('/Users/x/Projects/modoki');
    migrateLegacyRecents();
    expect(getRecentProjects()).toEqual([]);
  });
});

describe('chooseInitialProject — two-clone auto-open guard', () => {
  const cloneA = '/Users/x/Projects/modoki';
  const cloneB = '/Users/x/Projects/modoki-ai';
  const base = { repoRoot: cloneB, packaged: false, devFallback: `${cloneB}/games/3d-test` };

  it('isUnderRepo: only paths inside the repo root', () => {
    expect(isUnderRepo(cloneB, `${cloneB}/games/skin-test`)).toBe(true);
    expect(isUnderRepo(cloneB, `${cloneA}/games/skin-test`)).toBe(false); // sibling clone
    expect(isUnderRepo(cloneB, cloneB)).toBe(false);                       // the root itself
    expect(isUnderRepo(cloneB, `${cloneB}-other/games/x`)).toBe(false);    // prefix, not under
  });

  it('MODOKI_PROJECT hard override always wins', () => {
    const c = chooseInitialProject({ ...base, envProject: `${cloneB}/games/chess`, recents: [`${cloneA}/games/skin-test`] });
    // The hard override is path.resolve'd by the code (absolutizes MODOKI_PROJECT) — on Windows
    // that stamps a drive + backslashes onto these POSIX fixtures, so resolve the expected too.
    expect(c).toEqual({ kind: 'path', path: path.resolve(`${cloneB}/games/chess`) });
  });

  it('dev: reopens the most-recent recent UNDER this clone, skipping a sibling clone on top', () => {
    // Sibling clone's project is newest in the SHARED recents, but must NOT be reopened.
    const c = chooseInitialProject({ ...base, recents: [`${cloneA}/games/skin-test`, `${cloneB}/games/skin-test`] });
    expect(c).toEqual({ kind: 'path', path: `${cloneB}/games/skin-test` });
  });

  it('dev: falls to the soft default when NO recent is under this clone (never a sibling)', () => {
    const c = chooseInitialProject({ ...base, envDefault: `${cloneB}/games/space-console`, recents: [`${cloneA}/games/skin-test`] });
    // envDefault is path.resolve'd by the code — resolve the expected too (Windows drive/backslash).
    expect(c).toEqual({ kind: 'path', path: path.resolve(`${cloneB}/games/space-console`) });
  });

  it('dev: falls to the repo devFallback with no same-clone recent and no seed', () => {
    const c = chooseInitialProject({ ...base, recents: [`${cloneA}/games/skin-test`] });
    expect(c).toEqual({ kind: 'path', path: `${cloneB}/games/3d-test` });
  });

  it('single-clone dev: unchanged — reopens the global most-recent (all recents are under repo)', () => {
    const c = chooseInitialProject({ ...base, recents: [`${cloneB}/games/chess`, `${cloneB}/games/skin-test`] });
    expect(c).toEqual({ kind: 'path', path: `${cloneB}/games/chess` });
  });

  it('packaged: skips the clone guard — reopens the global most-recent wherever it lives', () => {
    const c = chooseInitialProject({ ...base, packaged: true, recents: ['/Volumes/work/MyGame', `${cloneB}/games/x`] });
    expect(c).toEqual({ kind: 'path', path: '/Volumes/work/MyGame' });
  });

  it('packaged: prompts (pick) when there are no recents', () => {
    expect(chooseInitialProject({ ...base, packaged: true, recents: [] })).toEqual({ kind: 'pick' });
  });
});

describe('projectFolderKind — first-run open-vs-scaffold decision', () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pfk-'));
  const dirs: string[] = [];
  const fresh = () => { const d = mk(); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('is "project" when the folder has a project.config.json (→ open it)', () => {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'project.config.json'), '{}');
    expect(projectFolderKind(d)).toBe('project');
  });

  it('is "empty" for an empty folder (→ scaffold a new game)', () => {
    expect(projectFolderKind(fresh())).toBe('empty');
  });

  it('is "empty" for a nonexistent folder (→ scaffoldable)', () => {
    expect(projectFolderKind(path.join(fresh(), 'does-not-exist'))).toBe('empty');
  });

  it('is "occupied" for a non-empty folder without a project.config.json (→ reject)', () => {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'random.txt'), 'hi');
    expect(projectFolderKind(d)).toBe('occupied');
  });
});
