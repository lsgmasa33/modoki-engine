/** #394 — a path picked through Project Settings' Browse… must not reach the TRACKED
 *  `project.config.json` as `/Users/<name>/…`. The route that does this (`POST /api/pick-path`)
 *  blocks on a modal chooser and so can never be driven from a test; the decision it makes lives
 *  in `relativiseUnderProject`, and this is that decision's cover.
 *
 *  The companion guard is `architecture/trackedConfigPaths.test.ts`, which asserts the OUTCOME on
 *  the committed files — a value typed by hand into the text box never passes through here. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relativiseUnderProject, planDroppedFileDest } from '../../plugins/backend/projectPaths';

describe('relativiseUnderProject (#394)', () => {
  it('relativises a file inside the project', () => {
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', '/Users/x/Projects/modoki/games/court/art/icon-app-master.png'))
      .toBe('art/icon-app-master.png');
  });

  it('keeps an absolute path that escapes the project (a machine-local SDK path)', () => {
    const jdk = '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home';
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', jdk)).toBe(jdk);
  });

  it('keeps absolute a sibling that merely SHARES a prefix with the project root', () => {
    // A plain `startsWith` check reads `…/court-art/icon.png` as inside `…/court`.
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', '/Users/x/Projects/modoki/games/court-art/icon.png'))
      .toBe('/Users/x/Projects/modoki/games/court-art/icon.png');
  });

  it('relativises a directory whose NAME begins with two dots', () => {
    // `rel.startsWith('..')` reads `..art/icon.png` as an escape. It is inside the project.
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', '/Users/x/Projects/modoki/games/court/..art/icon.png'))
      .toBe('..art/icon.png');
  });

  it('keeps absolute a path that escapes to a real ancestor', () => {
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', '/Users/x/Projects/modoki/games/icon.png'))
      .toBe('/Users/x/Projects/modoki/games/icon.png');
  });

  it('keeps absolute when the project root ITSELF is picked (no relative spelling of it)', () => {
    // `path.relative` returns '' here, which as a stored value reads as "unset" — not the same
    // thing as "the project folder", so it must not be written.
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', '/Users/x/Projects/modoki/games/court'))
      .toBe('/Users/x/Projects/modoki/games/court');
  });

  it('drops the chooser\'s trailing slash on a folder pick', () => {
    expect(relativiseUnderProject('/Users/x/Projects/modoki/games/court', '/Users/x/Projects/modoki/games/court/art/'))
      .toBe('art');
  });

  describe('with real symlinks on disk', () => {
    let tmp: string;
    let projectRoot: string;

    beforeAll(() => {
      // `realpathSync` on macOS resolves /var → /private/var, so mkdtemp's own path is already
      // a symlinked one — exactly the shape this guards against.
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pickpath-')));
      projectRoot = path.join(tmp, 'real', 'court');
      fs.mkdirSync(path.join(projectRoot, 'art'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'art', 'icon.png'), 'x');
      fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'outside', 'icon.png'), 'x');
      // A symlinked route to the SAME project — what a chooser navigating through an aliased
      // folder hands back. Without resolving the containing dir this reads as "outside", and the
      // absolute path lands in the tracked file.
      fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'link'));
    });

    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('relativises a path reached through a symlinked ancestor', () => {
      expect(relativiseUnderProject(projectRoot, path.join(tmp, 'link', 'court', 'art', 'icon.png')))
        .toBe('art/icon.png');
    });

    it('relativises when the PROJECT ROOT is the symlinked spelling', () => {
      expect(relativiseUnderProject(path.join(tmp, 'link', 'court'), path.join(projectRoot, 'art', 'icon.png')))
        .toBe('art/icon.png');
    });

    it('does NOT follow a symlink at the leaf out of the project', () => {
      // The link lives inside the project, so the project-relative spelling is the right answer;
      // resolving the leaf would store the target's absolute path instead.
      fs.symlinkSync(path.join(tmp, 'outside', 'icon.png'), path.join(projectRoot, 'art', 'aliased.png'));
      expect(relativiseUnderProject(projectRoot, path.join(projectRoot, 'art', 'aliased.png')))
        .toBe('art/aliased.png');
    });
  });
});

/** The naming half of the Project Settings drop (#408 follow-up). The owner's rule is "copy a
 *  dropped file in, but not one that is already in the project" — the already-inside half is
 *  `relativiseUnderProject` above; this is what happens once a copy IS needed. */
describe('planDroppedFileDest', () => {
  const probeFrom = (state: Record<string, 'same' | 'different'>) =>
    (rel: string) => state[rel] ?? 'absent';

  it('writes to the requested folder when the name is free', () => {
    expect(planDroppedFileDest('art', 'icon.png', probeFrom({})))
      .toEqual({ path: 'art/icon.png', write: true });
  });

  it('RE-USES a byte-identical file already there instead of copying again', () => {
    // Dropping the same PNG on the icon field and then the splash-title field, or simply
    // re-dropping after a mis-click. Without this every re-drop mints another full copy.
    expect(planDroppedFileDest('art', 'icon.png', probeFrom({ 'art/icon.png': 'same' })))
      .toEqual({ path: 'art/icon.png', write: false });
  });

  it('never overwrites a DIFFERENT file that owns the name', () => {
    expect(planDroppedFileDest('art', 'icon.png', probeFrom({ 'art/icon.png': 'different' })))
      .toEqual({ path: 'art/icon-1.png', write: true });
  });

  it('keeps suffixing past several different files, and still re-uses a match further along', () => {
    const state = { 'art/icon.png': 'different', 'art/icon-1.png': 'different', 'art/icon-2.png': 'same' } as const;
    expect(planDroppedFileDest('art', 'icon.png', probeFrom(state)))
      .toEqual({ path: 'art/icon-2.png', write: false });
  });

  it('keeps only the LEAF of an OS-supplied name', () => {
    // The name comes from the drop, not from us. A separator or a `..` in it must not steer the
    // write out of the destination folder.
    expect(planDroppedFileDest('art', '../../etc/passwd.png', probeFrom({})))
      .toEqual({ path: 'art/passwd.png', write: true });
    expect(planDroppedFileDest('art', 'C:\\Users\\x\\icon.png', probeFrom({})))
      .toEqual({ path: 'art/icon.png', write: true });
  });

  it('handles a name with no extension, and a dotfile', () => {
    expect(planDroppedFileDest('art', 'LICENSE', probeFrom({ 'art/LICENSE': 'different' })))
      .toEqual({ path: 'art/LICENSE-1', write: true });
    // A leading dot is not an extension separator — `.gitignore` must not become `-1.gitignore`.
    expect(planDroppedFileDest('art', '.gitignore', probeFrom({ 'art/.gitignore': 'different' })))
      .toEqual({ path: 'art/.gitignore-1', write: true });
  });

  it('normalises the destination folder rather than doubling its slashes', () => {
    expect(planDroppedFileDest('/art/', 'icon.png', probeFrom({})).path).toBe('art/icon.png');
    expect(planDroppedFileDest('', 'icon.png', probeFrom({})).path).toBe('icon.png');
  });
});
