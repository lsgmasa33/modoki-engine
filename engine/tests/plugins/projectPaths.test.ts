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
import { relativiseUnderProject } from '../../plugins/backend/projectPaths';

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
