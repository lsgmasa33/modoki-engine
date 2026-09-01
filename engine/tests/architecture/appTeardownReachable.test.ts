/** The app-teardown path is actually WIRED — the whole point of #534, and unprovable any other way.
 *
 *  #534 exists because six teardown halves were written for an app lifetime this codebase did not
 *  have: `registerAll()` sat behind a once-only latch, nothing unmounted the app, and so every one
 *  of them was unreachable BY CONSTRUCTION. `teardownAll()` (`engine/app/ecs/register.ts`) closes
 *  that, but only while something calls it. A `teardownAll()` nobody calls is not a smaller version
 *  of the bug — it is the same bug with a longer call chain, and it would look fixed from inside
 *  the module.
 *
 *  ⚠️ AND THIS GUARD IS STILL NOT ENOUGH TO EMPTY `APP_LIFETIME_BY_DESIGN` — say so plainly,
 *  because the tempting argument is that it is. `appManagerDisposeReachable.test.ts` proves the
 *  three app-scoped managers have a production `unregisterManagers([...])` caller; this file proves
 *  that caller is itself called. Both are TEXTUAL. Neither can ask the only question that matters:
 *  does the call ever run with something registered? Measured, it does not — the sole trigger is
 *  StrictMode's synchronous remount, which always precedes both `registerAll()` sites, so
 *  `teardownAll()` returns at its own `if (!registered)` every time
 *  (`tests/app/appTeardownStrictMode.test.tsx` pins it). A third guard of the same KIND would not
 *  help; what closes this is a trigger that fires after registration. Until then the allowlist
 *  stays populated — emptying it on the strength of these two would be the same inert-guard shape
 *  #517's close-out found in that very file, just with a longer chain.
 *
 *  Deliberately a source grep, for the reason `deviceTeardownReachable.test.ts` gives: what fails in
 *  this class is not the logic (covered by `tests/ecs/appTeardownRearm.test.ts` and
 *  `tests/ecs/register.test.ts`) but the WIRING, and a test that imports the module cannot see
 *  whether production calls it. Test files are excluded from the scan for that exact reason — the
 *  dead versions in #517 and #225 both had test callers, and that is what made them look alive. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('the app teardown path is reached from production code (#534)', () => {
  it('App.tsx calls teardownAll() from an effect CLEANUP, not from the effect body', () => {
    const app = read('engine/app/App.tsx');
    expect(app, 'App.tsx must import the teardown').toMatch(/import\s*\{[^}]*\bteardownAll\b[^}]*\}\s*from\s*'\.\/ecs\/register'/);
    // Inside a returned cleanup specifically. Calling it in the effect BODY would tear the app down
    // at boot — green on an import check, catastrophic in practice — so the arrow-return shape is
    // the part worth asserting, not the mere presence of the identifier.
    expect(app, 'teardownAll() must be called from a `return () => { ... }` effect cleanup')
      .toMatch(/return\s*\(\)\s*=>\s*\{[^}]*\bteardownAll\(\)/);
  });

  it('teardownAll() re-arms the latch, so the trigger is a cycle and not a one-way kill', () => {
    // The re-arm is the entire reason wiring this is safe at all — #517 declined to wire
    // `unregisterManager('Input')` precisely because a teardown with no re-register leaves input
    // permanently dead. A `teardownAll` that lost this line would still satisfy the test above.
    const reg = read('engine/app/ecs/register.ts');
    const fn = reg.slice(reg.indexOf('export function teardownAll'));
    expect(fn.slice(0, fn.indexOf('\n}\n')), 'teardownAll must clear the `registered` latch')
      .toMatch(/registered\s*=\s*false/);
  });

  it('teardownAll() reaches the audio context, which is the symptom #534 named', () => {
    // `disposeAudioContext`'s own docstring names "app teardown / error-boundary recovery" and had
    // zero callers; App.tsx's cleanup meanwhile claimed to dispose the audio CONTEXT while calling
    // `audioDispose()`, which only drops the node graph. If this stops holding, that comment is a
    // lie again.
    const reg = read('engine/app/ecs/register.ts');
    const fn = reg.slice(reg.indexOf('export function teardownAll'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/disposeAudioContext\(\)/);
    // Order is load-bearing: the node graph and the decoded buffers both hang off the context.
    expect(body.indexOf('audioDispose()')).toBeLessThan(body.indexOf('disposeAllAudioBuffers()'));
    expect(body.indexOf('disposeAllAudioBuffers()')).toBeLessThan(body.indexOf('disposeAudioContext()'));
  });
});
