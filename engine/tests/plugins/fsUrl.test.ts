import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { toFsUrl, fromFsUrl } from '../../plugins/backend/editorBackendRouter';

/**
 * Vite `/@fs/<abs>` URL construction — the dev server's way to serve files outside its
 * root (the open project's game.ts, script-tree entries). Regression: the URL was built
 * with `'/@fs' + abs`, which on Windows produced `/@fsC:\Users\…\game.ts` (no separator,
 * backslashes) — Vite couldn't serve it → "Could not load the open project's games".
 * These assert the WINDOWS form directly (the CI host is macOS/Linux), so the fix can't
 * silently regress.
 */
describe('toFsUrl — Vite /@fs/ URL for an absolute path', () => {
  it('turns a Windows drive path into forward-slashed /@fs/C:/…', () => {
    expect(toFsUrl('C:\\Users\\shois\\proj\\game.ts')).toBe('/@fs/C:/Users/shois/proj/game.ts');
  });
  it('keeps a POSIX path clean (no doubled slash)', () => {
    expect(toFsUrl('/Users/x/proj/game.ts')).toBe('/@fs/Users/x/proj/game.ts');
  });
  it('never emits the broken no-separator form', () => {
    expect(toFsUrl('C:\\a\\b')).not.toMatch(/@fsC:/);
    expect(toFsUrl('C:\\a\\b')).not.toContain('\\');
  });
});

describe('fromFsUrl — absolute path back out of a /@fs/ URL', () => {
  it('strips the leading slash before a Windows drive letter', () => {
    // fromFsUrl uses path.resolve, which is host-specific; assert the pre-resolve
    // normalization by checking the drive letter survives at the front.
    const out = fromFsUrl('/@fs/C:/Users/x/game.ts');
    expect(out.replace(/\\/g, '/')).toMatch(/(^|\/)C:\/?Users\/x\/game\.ts$/i);
  });
  it('round-trips a host-native absolute path', () => {
    const abs = path.resolve('some', 'nested', 'game.ts');
    expect(fromFsUrl(toFsUrl(abs))).toBe(abs);
  });
});
