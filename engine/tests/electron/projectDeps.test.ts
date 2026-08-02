/** Unit: `composeDepsInstallError` — what a failed dependency install actually TELLS you.
 *
 *  This is a diagnosability guard, not a behaviour guard: the install fails either way. It
 *  exists because the un-composed version shipped and cost a real user (and their agent) a
 *  long session — the dialog said only "npm install exited with code 1" while the true cause
 *  (a 120s plugin-vendoring timeout on a read-only Program Files install) sat unread in
 *  main.log. They chased npm, the registry, and a phantom stale process first.
 *
 *  The causal link is not a guess: vendoring is what rewrites an engine plugin's dep from
 *  the placeholder `"*"` to `file:plugins/<name>-<hash>.tgz`, and those plugins are not on
 *  the public npm registry — so if vendoring threw, the install CANNOT succeed. */

import { describe, it, expect } from 'vitest';
import { composeDepsInstallError } from '../../electron/projectDeps';

const VENDOR_ERR = '[vendor] timed out waiting for a concurrent build of capacitor-game-debug dist';

describe('composeDepsInstallError', () => {
  it('names the vendoring failure as the cause, keeping the install error first', () => {
    const out = composeDepsInstallError(new Error('npm install exited with code 1'), VENDOR_ERR);
    // The install failure stays the headline (it's what the user's action produced)…
    expect(out.message.startsWith('npm install exited with code 1')).toBe(true);
    // …but the actual cause is now IN the message, not just in main.log.
    expect(out.message).toContain(VENDOR_ERR);
    expect(out.message).toMatch(/CONSEQUENCE/);
  });

  it('leaves a genuine install failure untouched when vendoring succeeded', () => {
    // Guards the inverse mistake: blaming vendoring for an unrelated npm failure (offline,
    // a bad user dependency) would be its own misdirection. Same Error identity, so the
    // original stack survives for a real npm fault.
    const original = new Error('npm install exited with code 1');
    const out = composeDepsInstallError(original, null);
    expect(out).toBe(original);
    expect(out.message).not.toMatch(/CONSEQUENCE/);
  });

  it('handles a non-Error throw without producing "[object Object]"', () => {
    // runNpm/spawn paths can reject with a non-Error; the dialog must stay readable.
    const out = composeDepsInstallError({ code: 'EPERM' }, VENDOR_ERR);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain(VENDOR_ERR);
    const out2 = composeDepsInstallError('spawn ENOENT', null);
    expect(out2).toBeInstanceOf(Error);
    expect(out2.message).toBe('spawn ENOENT');
  });
});
