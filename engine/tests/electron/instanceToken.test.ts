import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOKEN_FILE,
  newToken,
  readToken,
  ensureToken,
  checkToken,
  tokenMismatchError,
  _resetTokenCache,
  rootKey,
} from '../../electron/instanceToken';

/**
 * C6 unit gate — the instance token (docs/connect-claude-code.md, C6).
 *
 * The property under test: a port names a SOCKET, not an EDITOR. If a `.mcp.json` targets
 * a port that a DIFFERENT editor now holds, every MCP call succeeds while driving the
 * wrong project — silently. `checkToken` is the ONE function that decides, so the
 * validate-if-present policy is pinned here before it ships.
 */
describe('checkToken — validate if present', () => {
  it('no token presented → absent (ACCEPTED: curl / game-debug / pre-C6 configs)', () => {
    expect(checkToken(undefined, 'tok-a')).toBe('absent');
    expect(checkToken(null, 'tok-a')).toBe('absent');
    expect(checkToken('', 'tok-a')).toBe('absent');
  });

  it('matching token → ok', () => {
    expect(checkToken('tok-a', 'tok-a')).toBe('ok');
  });

  it('THE BUG: a token from another editor → mismatch (rejected, not silently obeyed)', () => {
    expect(checkToken('tok-b', 'tok-a')).toBe('mismatch');
  });

  it('a token presented to an editor that has NONE → mismatch, deliberately', () => {
    // This config was written for some OTHER editor and reached us only because it targets
    // a port we now hold. That IS the bug — accepting it would be the silent failure.
    expect(checkToken('tok-b', null)).toBe('mismatch');
  });

  it('an editor with no token still accepts an un-tokened request (no lockout)', () => {
    expect(checkToken(undefined, null)).toBe('absent');
  });

  it('a repeated header (string[]) is judged on its first value, never accepted blindly', () => {
    expect(checkToken(['tok-a'], 'tok-a')).toBe('ok');
    expect(checkToken(['tok-b', 'tok-a'], 'tok-a')).toBe('mismatch'); // no "any match" smuggling
  });
});

describe('token store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-token-'));
    _resetTokenCache();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetTokenCache();
  });

  it('newToken mints distinct values', () => {
    expect(newToken()).not.toBe(newToken());
  });

  it('readToken is null before anything is minted', () => {
    expect(readToken(dir, '/a/project')).toBeNull();
  });

  it('ensureToken mints once and is STABLE across calls (a relaunch must not invalidate)', () => {
    const first = ensureToken(dir, '/a/project');
    expect(first).toBeTruthy();
    expect(ensureToken(dir, '/a/project')).toBe(first);
    _resetTokenCache(); // simulate a relaunch: re-read from disk
    expect(readToken(dir, '/a/project')).toBe(first);
  });

  it('different projects get different tokens', () => {
    expect(ensureToken(dir, '/a/one')).not.toBe(ensureToken(dir, '/a/two'));
  });

  it('different INSTALLS get different tokens for the SAME project (dev vs DMG)', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-token2-'));
    try {
      const a = ensureToken(dir, '/a/project');
      _resetTokenCache();
      expect(ensureToken(other, '/a/project')).not.toBe(a);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('minting one project does not clobber another already in the file', () => {
    const a = ensureToken(dir, '/a/one');
    ensureToken(dir, '/a/two');
    _resetTokenCache();
    expect(readToken(dir, '/a/one')).toBe(a);
  });

  it('a trailing slash is the same project (must not mint a second token)', () => {
    expect(ensureToken(dir, '/a/project/')).toBe(ensureToken(dir, '/a/project'));
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'case-insensitive FS: a differently-cased path is the SAME project (no self-403)',
    () => {
      expect(ensureToken(dir, '/Users/me/Game')).toBe(ensureToken(dir, '/Users/me/game'));
    },
  );

  it('creates the userData dir if missing', () => {
    const nested = path.join(dir, 'sub', 'user-data');
    const t = ensureToken(nested, '/a/project');
    expect(readToken(nested, '/a/project')).toBe(t);
  });

  it('a corrupt store reads as EMPTY, not a throw (an editor must still open)', () => {
    fs.writeFileSync(path.join(dir, TOKEN_FILE), '{ not json');
    expect(readToken(dir, '/a/project')).toBeNull();
    _resetTokenCache();
    expect(() => ensureToken(dir, '/a/project')).not.toThrow();
  });

  it('a non-string value is ignored rather than fed into a header comparison', () => {
    fs.writeFileSync(path.join(dir, TOKEN_FILE), JSON.stringify({ '/a/project': 42 }));
    expect(readToken(dir, '/a/project')).toBeNull();
  });

  it('an empty projectRoot has no token (never mints for "no project")', () => {
    expect(readToken(dir, '')).toBeNull();
  });

  // ── The store can have MULTIPLE CONCURRENT WRITERS: editors sharing a userData dir share
  //    this file, and several run at once by design (MODOKI_MULTI in one clone; and before
  //    userDataDir.ts scoped them, EVERY dev clone shared one dir — that's how this was
  //    found). ensureToken is a read-modify-write over the whole map, so a cached snapshot
  //    would erase a sibling's work.
  describe('a sibling editor sharing this userData', () => {
    /** What another process wrote since we last looked (it does NOT touch our cache). */
    const siblingWrites = (map: Record<string, string>) =>
      fs.writeFileSync(path.join(dir, TOKEN_FILE), JSON.stringify(map, null, 2));

    it('minting does NOT erase a token a sibling added since we cached', () => {
      const t1 = ensureToken(dir, '/a/one');            // us: file={one}, cache={one}
      siblingWrites({ [rootKey('/a/one')]: t1, [rootKey('/a/two')]: 'sibling-tok' });
      ensureToken(dir, '/a/three');                     // us: Open Project → read-modify-write
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8'));
      // Without a fresh read this wrote {one, three} and /a/two vanished — the sibling then
      // re-mints on its next launch, its .mcp.json reads as drifted, and the user gets a
      // "restart Claude Code" dialog + 403s caused by an unrelated window opening a project.
      expect(onDisk[rootKey('/a/two')]).toBe('sibling-tok');
      expect(onDisk[rootKey('/a/one')]).toBe(t1);
      expect(onDisk[rootKey('/a/three')]).toBeTruthy();
    });

    it('ADOPTS a token a sibling already minted for OUR project (no competing mint)', () => {
      ensureToken(dir, '/a/one'); // prime the cache so a stale read is possible
      siblingWrites({ [rootKey('/a/mine')]: 'minted-by-sibling' });
      expect(ensureToken(dir, '/a/mine')).toBe('minted-by-sibling');
    });
  });
});

describe('tokenMismatchError', () => {
  it('names the port and the project actually open — a bare "forbidden" is undebuggable', () => {
    const msg = tokenMismatchError('/Users/me/moge', 5182);
    expect(msg).toMatch(/5182/);
    expect(msg).toMatch(/moge/);
    expect(msg).toMatch(/Connect Claude Code/); // the action that fixes it
  });

  it('survives a missing port / project without throwing', () => {
    expect(() => tokenMismatchError('', null)).not.toThrow();
  });
});
