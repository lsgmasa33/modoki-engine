/** The playable-ad build actually WIRES the boot-probe refusal (#221 W2 item 5).
 *
 *  ⚠️ **THE GUARD EXISTS BECAUSE THE UNIT TESTS CANNOT SEE THE WIRING.** `bootProbeAllowed.test.ts`
 *  proves both call sites obey the flag — mutation-checked, both fail when the guard is removed —
 *  but nothing there proves anyone ever SETS it. `main.tsx` is the only setter, it runs at module
 *  scope during app bootstrap, and it is not reachable from a jsdom unit test. Delete that line and
 *  every test in this repo stays green while every playable ad silently pays 1.6-1.8 s of blocked
 *  launch again. That is precisely the "mechanism that cannot fire" shape this codebase keeps
 *  producing, so the wiring gets a guard of its own.
 *
 *  ⚠️ It also pins the ARGUMENT, not just the call. `setBootProbeAllowed(true)` would satisfy a
 *  "the function is called" assertion and mean the opposite of the feature.
 *
 *  ⚠️ And it pins that the call is SYNCHRONOUS at module scope rather than inside `bootPlayable`:
 *  that module arrives through a dynamic import, and `App.tsx`'s boot effect resolves the tier
 *  without waiting for it — so a flag set from there would land after the probe had already run.
 *  A source-text check is the only cheap way to hold that ordering.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mainTsx = readFileSync(resolve(repoRoot, 'engine/app/main.tsx'), 'utf8');

describe('a playable ad refuses the boot ramp probe', () => {
  it('⭐ main.tsx sets the flag from __MODOKI_PLAYABLE__, negated', () => {
    expect(mainTsx).toMatch(/setBootProbeAllowed\(\s*!__MODOKI_PLAYABLE__\s*\)/);
  });

  it('⚠️ and does it at module scope, not inside a dynamic import callback', () => {
    // `bootPlayable` is loaded with `import('./playable/bootPlayable').then(...)`. Anything set in
    // that callback lands too late for the tier resolution, so the setter must not appear inside
    // one. Cheap approximation: the setter's line must not be indented (module scope).
    const line = mainTsx.split('\n').find((l) => l.includes('setBootProbeAllowed('));
    expect(line).toBeDefined();
    expect(line!.startsWith('setBootProbeAllowed(')).toBe(true);
  });
});
