/** Unit: `isEditorsOwnTree` — the guard that stops the editor healing / `npm install`-ing into
 *  its OWN checkout (#869).
 *
 *  Two `main.ts` actions consult it: `healProjectOnOpen` (rewrites native config) and
 *  `ensureProjectDeps` (runs `npm install`). Both used to read
 *  `path.resolve(projectRoot) === REPO_ROOT`, which FAILS OPEN — a differently-spelled but
 *  equivalent path misses, the early return does not happen, and the action runs against the
 *  editor's own repo. Reachable in one step: `MODOKI_PROJECT=e:/Projects/modoki`.
 *
 *  ⚠️ It lives in `projects.ts` rather than at the two call sites BECAUSE of this file:
 *  `main.ts` imports `electron` at module scope and cannot be loaded under vitest, so a guard
 *  inlined there is a guard with no test. Extracting the decision is what makes it assertable —
 *  the same reasoning as `projectDeps.ts`. Coverage of the two CALL SITES (that they consult it
 *  at all) is the e2e/packaged lane's; what is pinned here is the decision itself.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `projects.ts` imports `electron` at module scope for the picker/menu half. The guard under test
// touches none of it, so a minimal stub is honest here rather than a fake of the mechanism.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
}));

const { isEditorsOwnTree, isUnderRepo } = await import('../../electron/projects');

const onWin = process.platform === 'win32';

describe('isEditorsOwnTree', () => {
  it('recognises the repo root spelled the same way', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-own-'));
    try {
      expect(isEditorsOwnTree(repo, repo)).toBe(true);
      expect(isEditorsOwnTree(repo + path.sep, repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT fire for a game inside the repo — that is the normal case', () => {
    // The guard must not swallow the ordinary open. `games/<id>` lives under the repo root and
    // absolutely does want healing and dep installation.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-own-'));
    try {
      const game = path.join(repo, 'games', 'sling');
      fs.mkdirSync(game, { recursive: true });
      expect(isEditorsOwnTree(game, repo)).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT fire for a name-PREFIX sibling clone', () => {
    // `modoki` / `modoki-ai` / `modoki-ai2` are real sibling clones on this machine.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-own-'));
    try {
      const repo = path.join(base, 'modoki');
      const sibling = path.join(base, 'modoki-ai');
      fs.mkdirSync(repo); fs.mkdirSync(sibling);
      expect(isEditorsOwnTree(sibling, repo)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.runIf(onWin)('win32: fires for a lower-cased drive letter — the #869 defect', () => {
    // `MODOKI_PROJECT=e:/Projects/modoki` reaches chooseInitialProject, which returns
    // `path.resolve(envProject)`, which reaches these guards as `state.root`.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-own-'));
    try {
      const flipped = repo[0].toLowerCase() === repo[0]
        ? repo[0].toUpperCase() + repo.slice(1)
        : repo[0].toLowerCase() + repo.slice(1);
      expect(flipped, 'premise: a different spelling').not.toBe(repo);
      expect(path.resolve(flipped) === path.resolve(repo), 'premise: the OLD guard missed it').toBe(false);
      expect(isEditorsOwnTree(flipped, repo)).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('isUnderRepo is NOT the same defect', () => {
  it.runIf(onWin)('win32: path.relative already folds case, so the two-clone guard holds', () => {
    // Pinned because it is the asymmetry that made #869 confusing: the correct comparison was
    // sitting ~130 lines above the two broken ones. If someone "fixes" this to use samePath,
    // this test says what it would be changing and why it was already right.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-under-'));
    try {
      const repo = path.join(base, 'modoki');
      const game = path.join(repo, 'games', 'sling');
      fs.mkdirSync(game, { recursive: true });
      const flippedGame = game[0].toLowerCase() === game[0]
        ? game[0].toUpperCase() + game.slice(1)
        : game[0].toLowerCase() + game.slice(1);
      expect(isUnderRepo(repo, flippedGame)).toBe(true);
      // …and it still rejects a name-prefix sibling, which is the thing it exists to reject.
      expect(isUnderRepo(repo, path.join(base, 'modoki-ai', 'games', 'sling'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
