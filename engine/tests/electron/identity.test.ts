/** Unit: the wrong-clone predicate behind `/api/identity`.
 *
 *  Two clones of this repo run side by side, each with an editor on its own port. Pointed
 *  at the wrong one, every MCP call succeeds and drives the OTHER checkout — the calls
 *  return 200, the scene comes back, the undo stack grows, and nothing the agent expects
 *  to change changes. There is no natural error to catch. This predicate is the only
 *  signal, so its false-negative and false-positive behaviour both matter:
 *    - a missed mismatch costs a whole session of misattributed failures;
 *    - a spurious warning on every legitimate DMG session trains the reader to ignore it. */

import { describe, it, expect } from 'vitest';
import { identityMismatch, tokenMismatchWarning, describeIdentity, isWithin, type BackendIdentity } from '../../tools/modoki-mcp/src/identity';

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
