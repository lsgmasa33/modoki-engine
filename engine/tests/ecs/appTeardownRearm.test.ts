/** `registerAll()` → `teardownAll()` → `registerAll()` puts the whole app-scoped surface back (#534).
 *
 *  THE POINT OF THIS FILE. #517 declined to wire `unregisterManager('Input')` into a teardown path
 *  and documented why: `registered` was a once-only latch, so a teardown left nothing to
 *  re-register, and for `'Input'` that meant permanently dead input rather than a leak fixed. That
 *  objection is a property of the LATCH, and `teardownAll()` clears it — so the thing that has to
 *  be proven is not that teardown runs, but that the cycle CLOSES. A test that only asserted the
 *  teardown half would pass just as happily on the version of this that kills input forever.
 *
 *  Deliberately UNMOCKED, unlike `register.test.ts` next door. That file mocks the whole runtime to
 *  assert the call sequence, which is the right tool for "does registerAll call X" and the wrong one
 *  here: a mocked `unregisterManagers` cannot show that a real manager's `dispose` unhooked its real
 *  read sources, and a mocked registry re-arms trivially. These assertions read the real registries.
 *
 *  The observations are chosen to be DISTINGUISHING — each one is state a manager's own
 *  `init`/`dispose` owns, so it cannot be true unless that manager really cycled:
 *    - `deltaTime` / `timeSinceGameStart` / `timeSinceSceneLoad` — registered by TimeManager.init,
 *      unregistered by its dispose.
 *    - `canGoBack` — the same for NavigationManager.
 *    - `engine.loadScene` / `engine.navigateBack` — NavigationManager's OWN actions, added by the
 *      registry's `addActions` on activate and dropped on deactivate. They are the half that proves
 *      the manager was deactivated rather than merely forgotten.
 *
 *  jsdom gives `window` (so the input sources really attach) and no Web Audio (so the audio trio is
 *  a live no-op here — `getAudioContext()` returns null). The audio ORDER is asserted by
 *  `register.test.ts`'s mocked suite, which can see the call sequence; this file cannot. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getReadSourceNames, hasUIAction, setGameConfig } from '@modoki/engine/runtime';
import { registerAll, teardownAll } from '../../app/ecs/register';

const TIME_SOURCES = ['deltaTime', 'timeSinceGameStart', 'timeSinceSceneLoad'];
const NAV_SOURCE = 'canGoBack';
const NAV_ACTIONS = ['engine.loadScene', 'engine.navigateBack'];

describe('the app-scoped registration cycles (#534)', () => {
  beforeEach(() => {
    // ⚠️ Static imports and `teardownAll()`, NOT `vi.resetModules()` + dynamic import. Resetting
    // modules would hand `register.ts` a SECOND copy of `@modoki/engine/runtime`, so it would write
    // its managers into registries this file never reads — every assertion below would then be
    // measuring the wrong module instance, and the failures would look like teardown bugs.
    // Normalising with the function under test is safe: it is inert when nothing is registered,
    // which the last case here asserts directly.
    setGameConfig({ name: 'teardown-rearm-fixture', sceneSetup: () => {}, initWorld: () => {} });
    teardownAll();
  });

  afterEach(() => { teardownAll(); });

  it('registerAll installs the app-scoped read sources and manager actions', () => {
    registerAll();
    for (const n of [...TIME_SOURCES, NAV_SOURCE]) expect(getReadSourceNames()).toContain(n);
    for (const a of NAV_ACTIONS) expect(hasUIAction(a)).toBe(true);
  });

  it('teardownAll removes them', () => {
    registerAll();
    teardownAll();
    for (const n of [...TIME_SOURCES, NAV_SOURCE]) expect(getReadSourceNames()).not.toContain(n);
    // The actions are the sharp half: a manager merely dropped from the registry map without being
    // deactivated would leave these behind.
    for (const a of NAV_ACTIONS) expect(hasUIAction(a)).toBe(false);
  });

  it('registerAll AFTER a teardown puts everything back — the re-arm #517 said was impossible', () => {
    registerAll();
    teardownAll();
    registerAll();
    for (const n of [...TIME_SOURCES, NAV_SOURCE]) expect(getReadSourceNames()).toContain(n);
    for (const a of NAV_ACTIONS) expect(hasUIAction(a)).toBe(true);
  });

  it('survives more than one cycle', () => {
    // Two cycles, not one. A re-arm that flips the latch but leaves some other module-level
    // `installed` flag set typically works exactly once and then stops — the shape that would let
    // a StrictMode remount pass while a second teardown in the same session does not.
    for (let i = 0; i < 3; i++) { registerAll(); teardownAll(); }
    registerAll();
    for (const n of [...TIME_SOURCES, NAV_SOURCE]) expect(getReadSourceNames()).toContain(n);
    for (const a of NAV_ACTIONS) expect(hasUIAction(a)).toBe(true);
  });

  it('teardownAll is inert when nothing is registered', () => {
    // Called on a cold module (or twice in a row), it must not throw or half-tear-down a surface
    // some other caller owns.
    expect(() => teardownAll()).not.toThrow();
    registerAll();
    teardownAll();
    expect(() => teardownAll()).not.toThrow();
  });
});
