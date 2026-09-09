/** Unit: the wrong-clone predicate behind `/api/identity`.
 *
 *  Two clones of this repo run side by side, each with an editor on its own port. Pointed
 *  at the wrong one, every MCP call succeeds and drives the OTHER checkout — the calls
 *  return 200, the scene comes back, the undo stack grows, and nothing the agent expects
 *  to change changes. There is no natural error to catch. This predicate is the only
 *  signal, so its false-negative and false-positive behaviour both matter:
 *    - a missed mismatch costs a whole session of misattributed failures;
 *    - a spurious warning on every legitimate DMG session trains the reader to ignore it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityMismatch, tokenMismatchWarning, describeIdentity, isWithin, type BackendIdentity } from '../../tools/shared/identity';
import { makeDirLink } from '../helpers/linkFixture';

const URL_ = 'http://127.0.0.1:5180';

const identity = (over: Partial<BackendIdentity> = {}): BackendIdentity => ({
  repoRoot: '/Users/x/Projects/modoki-ai',
  projectRoot: '/Users/x/Projects/modoki-ai/games/3d-test',
  backendPort: 5180,
  pid: 123,
  branch: 'work-ai',
  packaged: false,
  ...over,
});

describe('isWithin', () => {
  it('accepts an identical path and a true descendant', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b')).toBe(true);
  });

  it('is segment-aware: a sibling sharing a name PREFIX is not inside', () => {
    // The bug a naive startsWith would have: `modoki-ai2` "inside" `modoki-ai`, which is
    // exactly the pair of clones this whole feature exists to distinguish.
    expect(isWithin('/Users/x/Projects/modoki-ai2', '/Users/x/Projects/modoki-ai')).toBe(false);
  });

  it('ignores a trailing separator on either side', () => {
    expect(isWithin('/a/b/', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/')).toBe(true);
  });

  // ── Windows path shapes (#30 close-out) ────────────────────────────────────────────
  // These are pure string comparisons, so they run identically on either OS — a Linux CI
  // leg catches a Windows-only regression here.

  it('REGRESSION: a backslash descendant is inside its parent', () => {
    // The bug: norm() stripped only '/' and isWithin joined only with '/', so EVERY
    // Windows session run from a subdirectory warned "WRONG EDITOR" against its own
    // editor. It was visible as far back as the Run 1 Windows log, where the MCP's own
    // `npm --prefix engine/tools/modoki-mcp` smoke was written off as a benign
    // "cwd artifact" — it was this (closed as #30).
    expect(isWithin('E:\\Projects\\modoki\\games\\3d-test', 'E:\\Projects\\modoki')).toBe(true);
    expect(isWithin('E:\\Projects\\modoki\\engine\\tools\\modoki-mcp', 'E:\\Projects\\modoki')).toBe(true);
  });

  it('folds drive-letter case, which spells the same dir two ways', () => {
    expect(isWithin('e:\\Projects\\modoki\\games', 'E:\\Projects\\modoki')).toBe(true);
    expect(isWithin('E:\\Projects\\modoki\\games', 'e:\\Projects\\modoki')).toBe(true);
  });

  it('treats mixed separators as the same path', () => {
    expect(isWithin('E:/Projects/modoki/games', 'E:\\Projects\\modoki')).toBe(true);
  });

  it('stays segment-aware on Windows: the sibling clone is still NOT inside', () => {
    // The fix must not buy the subdirectory case by widening into a naive prefix match —
    // this is the pair the whole feature exists to tell apart.
    expect(isWithin('E:\\Projects\\modoki-ai2', 'E:\\Projects\\modoki-ai')).toBe(false);
  });

  it('does NOT fold case beyond the drive letter (Linux is case-sensitive)', () => {
    expect(isWithin('/a/B', '/a/b')).toBe(false);
  });

  it('a genuinely different Windows checkout is still outside', () => {
    expect(isWithin('E:\\Projects\\other', 'E:\\Projects\\modoki')).toBe(false);
  });
});

describe('identityMismatch', () => {
  it('REGRESSION: warns when the backend serves the SIBLING clone', () => {
    // The exact configuration that cost a session: MODOKI_BACKEND=5180 (modoki-ai) while
    // working in modoki-ai2.
    const warning = identityMismatch(identity(), '/Users/x/Projects/modoki-ai2', URL_);
    expect(warning).toBeTruthy();
    expect(warning).toContain('WRONG EDITOR');
    expect(warning).toContain('/Users/x/Projects/modoki-ai'); // whose editor it is
    expect(warning).toContain('/Users/x/Projects/modoki-ai2'); // where we are
    expect(warning).toContain('work-ai'); // the branch, so the reader recognises it
  });

  it('stays silent when the backend serves THIS checkout', () => {
    expect(identityMismatch(identity({ repoRoot: '/Users/x/Projects/modoki-ai2', branch: 'work-ai2' }), '/Users/x/Projects/modoki-ai2', URL_)).toBeNull();
  });

  it('stays silent when the cwd is a SUBDIRECTORY of the served repo', () => {
    // Running the MCP from games/3d-test is correct, not a mismatch.
    expect(identityMismatch(identity(), '/Users/x/Projects/modoki-ai/games/3d-test', URL_)).toBeNull();
  });

  it('stays silent when the served repo is inside the cwd', () => {
    expect(identityMismatch(identity({ repoRoot: '/Users/x/Projects/modoki-ai' }), '/Users/x/Projects', URL_)).toBeNull();
  });

  // ── Windows, through the predicate production actually calls (#30 close-out) ────────
  // isWithin is the unit; identityMismatch is the seam the MCP servers drive
  // (modoki-mcp/src/context.ts, game-debug-mcp/src/mcp-tools.ts) on every tool result.

  it('REGRESSION: a Windows DEV editor run from a subdirectory does not cry wolf', () => {
    // Pre-fix this warned on every Windows session, which trains the reader to ignore the
    // one warning that matters. A dev (NOT packaged) editor is required to reach the path
    // compare at all — `if (id.packaged) return null` short-circuits before it.
    const win = identity({ repoRoot: 'E:\\Projects\\modoki', branch: 'win' });
    expect(identityMismatch(win, 'E:\\Projects\\modoki\\games\\3d-test', URL_)).toBeNull();
    expect(identityMismatch(win, 'E:\\Projects\\modoki\\engine\\tools\\modoki-mcp', URL_)).toBeNull();
    expect(identityMismatch(win, 'E:\\Projects\\modoki', URL_)).toBeNull();
  });

  it('still warns for a genuinely different Windows checkout', () => {
    // The false-positive fix must not cost the true positive.
    const win = identity({ repoRoot: 'E:\\Projects\\modoki', branch: 'win' });
    const warning = identityMismatch(win, 'E:\\Projects\\modoki-other', URL_);
    expect(warning).toContain('WRONG EDITOR');
  });

  it('never warns for a PACKAGED editor, whose repoRoot is inside the .app bundle', () => {
    // Comparing an app.asar.unpacked path to a source checkout would warn on every
    // legitimate DMG session — the cry-wolf case.
    const packaged = identity({ repoRoot: '/Applications/Modoki.app/Contents/Resources/app.asar.unpacked', packaged: true });
    expect(identityMismatch(packaged, '/Users/x/Projects/modoki-ai2', URL_)).toBeNull();
  });

  it('stays silent rather than guessing when either path is unknown', () => {
    expect(identityMismatch(identity({ repoRoot: '' }), '/Users/x/Projects/modoki-ai2', URL_)).toBeNull();
    expect(identityMismatch(identity(), '', URL_)).toBeNull();
  });

  it('the warning names the backend URL, so the fix is actionable', () => {
    expect(identityMismatch(identity(), '/Users/x/Projects/modoki-ai2', URL_)).toContain(URL_);
  });
});

describe('describeIdentity', () => {
  it('reads as a one-line "you are here"', () => {
    expect(describeIdentity(identity(), URL_)).toBe('[modoki] backend http://127.0.0.1:5180 → /Users/x/Projects/modoki-ai (work-ai)');
  });

  it('omits the branch on a detached HEAD, and marks a packaged editor', () => {
    expect(describeIdentity(identity({ branch: null }), URL_)).toBe('[modoki] backend http://127.0.0.1:5180 → /Users/x/Projects/modoki-ai');
    expect(describeIdentity(identity({ packaged: true }), URL_)).toContain('[packaged]');
  });
});

/** C6 — the token verdict. Unlike identityMismatch (a cwd heuristic), this is the
 *  editor's OWN answer, so it's authoritative: it fires even for a packaged editor, where
 *  the heuristic deliberately stays silent. */
describe('tokenMismatchWarning', () => {
  it('mismatch → a loud, actionable warning naming the project that rejected us', () => {
    const w = tokenMismatchWarning(identity({ tokenCheck: 'mismatch' }), URL_);
    expect(w).toMatch(/WRONG EDITOR/);
    expect(w).toMatch(/3d-test/);
    expect(w).toMatch(/Connect Claude Code/);
  });

  it('ok / absent / a pre-C6 backend (field missing) → silent', () => {
    expect(tokenMismatchWarning(identity({ tokenCheck: 'ok' }), URL_)).toBeNull();
    expect(tokenMismatchWarning(identity({ tokenCheck: 'absent' }), URL_)).toBeNull();
    expect(tokenMismatchWarning(identity(), URL_)).toBeNull();
  });

  it('fires for a PACKAGED editor too — the cwd heuristic is silent there by design', () => {
    // A DMG's repoRoot is inside the .app, so identityMismatch can never speak. The token
    // is the only wrong-editor signal a packaged session has.
    const id = identity({ packaged: true, tokenCheck: 'mismatch' });
    expect(identityMismatch(id, '/somewhere/else', URL_)).toBeNull();
    expect(tokenMismatchWarning(id, URL_)).toMatch(/WRONG EDITOR/);
  });
});

/** #913 — the OBSERVED member. The two operands are `process.cwd()` and a repoRoot that arrived
 *  over the wire from another process, so they are two INDEPENDENTLY PRODUCED spellings that may
 *  name one directory. Reached through a symlinked clone they differ as strings, the containment
 *  test failed in both directions, and `identityMismatch` printed a confident WRONG EDITOR banner
 *  at a correctly-configured session.
 *
 *  ⚠️ The polarity is the opposite of #908's: this fails CLOSED, into a FALSE alarm. That is the
 *  outcome this file's header ranks worst — "a banner nobody can act on trains the reader to
 *  ignore banners" — and it is the shape that was mis-logged as a benign cwd artifact for months
 *  in the Windows drive-letter case.
 *
 *  ⚠️ The symlink is MANUFACTURED here, deliberately. No clone on this machine is reached through
 *  one today, so a test that merely used ordinary paths would pass with the mechanism deleted —
 *  this repo's dominant defect class. Both controls below are what make the positive case mean
 *  anything: without them, a predicate that returned `null` unconditionally would look fixed. */
describe('a symlinked clone spells one directory two ways (#913)', () => {
  let tmpRoot: string, real: string, link: string, other: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
    real = path.join(tmpRoot, 'modoki-qa');
    link = path.join(tmpRoot, 'clone-link');
    other = path.join(tmpRoot, 'modoki-ai');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    // ⚠️ #949's shape, unfiled — found by sweeping the class rather than by the ticket. A bare
    // `'dir'` link in a `beforeAll` with no skip: on an unelevated Windows box this throws EPERM
    // and every case in the describe ERRORS. A junction needs no privilege and resolves the same.
    makeDirLink(real, link);
  });

  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it('isWithin sees the link and its target as the same directory, in BOTH directions', () => {
    expect(isWithin(link, real)).toBe(true);
    expect(isWithin(real, link)).toBe(true);
  });

  it('identityMismatch stays SILENT when cwd is the link spelling of the served repo', () => {
    expect(identityMismatch(identity({ repoRoot: real }), link, URL_)).toBeNull();
  });

  it('CONTROL: silent too when cwd is spelled exactly as the backend reported it', () => {
    // The case that already worked. A fix that canonicalises only one side would break it.
    expect(identityMismatch(identity({ repoRoot: real }), real, URL_)).toBeNull();
  });

  it('CONTROL: a genuinely different checkout still WARNS — the guard is not just off', () => {
    expect(identityMismatch(identity({ repoRoot: real }), other, URL_)).toContain('WRONG EDITOR');
  });

  it('CONTROL: a sibling whose name is a PREFIX of the served repo is still outside', () => {
    // Segment-awareness must survive canonicalisation: ~/Projects/modoki is a prefix of
    // ~/Projects/modoki-qa on the real machine, and conflating them is the #69 shape.
    const prefix = path.join(tmpRoot, 'modoki-qa-2');
    fs.mkdirSync(prefix, { recursive: true });
    expect(identityMismatch(identity({ repoRoot: real }), prefix, URL_)).toContain('WRONG EDITOR');
  });
});
