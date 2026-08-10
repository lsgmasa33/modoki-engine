/**
 * #190 — the renderer's explanation for a failed game-code import.
 *
 * The browser reports `Failed to fetch dynamically imported module` for BOTH causes, so the
 * exception cannot tell them apart and the old message simply asserted one of them:
 * "the dev server can't serve code outside its allowed roots… restart it rooted at the
 * project". In the field the real cause was the other one — a stale dev server that kept the
 * port across a project switch, so Vite answered its SPA fallback (200 + index.html) for a
 * path that was perfectly legal, just not under the root that server was started at. That
 * advice sent the reader to re-root a dev server they never started, while the editor went on
 * showing project B and serving project A's code and assets.
 */
import { describe, it, expect } from 'vitest';
import { gameLoadFailureMessage } from '../../app/projectGames';

const URL_ = '/@fs/E:/Projects/modoki/demos/video-demo/game.ts';

describe('gameLoadFailureMessage', () => {
  it('names the OTHER project when the dev server is rooted somewhere else', () => {
    const msg = gameLoadFailureMessage(URL_, 'E:\\Projects\\modoki\\games\\court');
    expect(msg).toContain('rooted at a DIFFERENT project');
    expect(msg).toContain('E:\\Projects\\modoki\\games\\court');
    // The actionable half: a stale server is not something the reader can fix by re-rooting.
    expect(msg).toContain('relaunch the editor');
    expect(msg).not.toContain('allowed roots');
  });

  it('warns that the ASSETS are coming from that project too — not just the code', () => {
    // This is the damaging part and the reason the message must be loud: with the wrong
    // server on the port, saves land against the wrong tree.
    expect(gameLoadFailureMessage(URL_, 'E:\\Projects\\modoki\\games\\court'))
      .toContain('every asset you see is coming from that other project');
  });

  it('keeps the allowed-roots advice when the server IS rooted at the open project', () => {
    // Same root ⇒ the stale-server story is ruled out and fs.allow is the live theory again.
    const msg = gameLoadFailureMessage(URL_, 'E:\\Projects\\modoki\\demos\\video-demo');
    expect(msg).toContain('allowed roots');
    expect(msg).not.toContain('DIFFERENT project');
  });

  it('falls back to the allowed-roots advice when the server would not say', () => {
    // An older build with no identity route: we must not invent a diagnosis we cannot support.
    const msg = gameLoadFailureMessage(URL_, null);
    expect(msg).toContain('allowed roots');
    expect(msg).not.toContain('DIFFERENT project');
  });

  it('matches the root across separator and case differences, as Windows produces them', () => {
    // The URL carries forward slashes, the identity carries native backslashes. Comparing them
    // raw would report a mismatch for the very project that IS open, and cry stale-server on a
    // healthy editor — the same false alarm in the opposite direction.
    for (const root of [
      'E:/Projects/modoki/demos/video-demo',
      'e:\\projects\\modoki\\demos\\video-demo',
      'E:\\Projects\\modoki\\demos\\video-demo\\',
    ]) {
      expect(gameLoadFailureMessage(URL_, root), root).toContain('allowed roots');
    }
  });

  it('does not treat a sibling directory as a prefix match', () => {
    // `…/video-demo` must not satisfy a root of `…/video`; a substring test would say it does.
    expect(gameLoadFailureMessage(URL_, 'E:\\Projects\\modoki\\demos\\video'))
      .toContain('DIFFERENT project');
  });

  it('always names the URL it failed on, in every branch', () => {
    for (const root of [null, 'E:\\Projects\\modoki\\games\\court', 'E:/Projects/modoki/demos/video-demo']) {
      expect(gameLoadFailureMessage(URL_, root), String(root)).toContain(URL_);
    }
  });
});
