/** The #619 background-flush edges AND #611's realm-death backstop are actually WIRED —
 *  unprovable any other way.
 *
 *  `useBackgroundFlush()` (`engine/app/useBackgroundFlush.ts`) lives in its own module for exactly
 *  the reason `useAudioResumeRearm.ts` gives in its own header (see
 *  `audioResumeRearmReachable.test.ts`, the template this file copies): so
 *  `backgroundFlush.test.tsx` can drive it without mounting the whole app shell (`App` itself is
 *  not exported and drags in routing + the lazy editor chunk). That split is exactly the shape
 *  that has bitten this repo before (#517, #225, and the since-reverted
 *  `appTeardownReachable.test.ts` — deleted with `teardownAll()` in `2d6d72b46`, recoverable via
 *  `git show`): a hook that works in isolation proves nothing about whether the shipped app ever
 *  calls it.
 *
 *  This one is load-bearing for TWO separate mechanisms, not one — a merge from `main` moved
 *  #611's entire realm-death backstop (native ad SDK teardown ahead of an over-trigger-safe
 *  `pagehide` reload) into this same hook, on top of the #619 durability flush (PlayerPrefs writes
 *  surviving an OS kill) it already owned. Delete the `useBackgroundFlush();` line from `App.tsx`
 *  and its now-unused import in one refactor, and every existing gate stays green —
 *  `backgroundFlush.test.tsx` renders its own probe, `realmDeathBackstop.test.tsx` tests a pure
 *  decision core with no rendering at all, and typecheck/lint see no dangling import because both
 *  halves went together — while shipping an app that never flushes PlayerPrefs on background AND
 *  never runs #611's `pagehide` realm-shutdown backstop.
 *
 *  Deliberately a source grep, for the reason `deviceTeardownReachable.test.ts` gives: what fails
 *  in this class is not the logic (covered by the hook's own unit tests) but the WIRING, and a
 *  test that imports the module cannot see whether production calls it. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Comments blanked at the READ (#812): this guard's own sources document the flush rule it
 *  looks for, so raw text lets prose satisfy a required-pattern match. */
const read = (rel: string) => readScannedSource(path.join(repoRoot, rel)).code;

describe('useBackgroundFlush is reached from production code (#619, #611)', () => {
  it('App.tsx imports useBackgroundFlush from its own module', () => {
    // Comments stripped first (the shared scanner, #419 — a private regex stripper here would be
    // exactly the class of bug this test exists to catch: a call COMMENTED OUT, not deleted, must
    // not slip past the regexes below).
    const app = stripComments(read('engine/app/App.tsx'));
    // Match any path ENDING in the module name, not a pinned './useBackgroundFlush' — moving the
    // hook into engine/app/hooks/ (which already exists, for useKeyboardShift) changes nothing
    // about reachability and must not turn this guard red.
    expect(app, 'App.tsx must import useBackgroundFlush')
      .toMatch(/import\s*\{[^}]*\buseBackgroundFlush\b[^}]*\}\s*from\s*'[^']*useBackgroundFlush'/);
  });

  it('App.tsx actually CALLS useBackgroundFlush(), not just imports it', () => {
    // A dangling import satisfies the check above but wires nothing — the mechanism is one
    // deleted (or commented-out) call away from being dead, and the hook's own unit tests cannot
    // see the gap.
    const app = stripComments(read('engine/app/App.tsx'));
    expect(app, 'App.tsx must call useBackgroundFlush()').toMatch(/\buseBackgroundFlush\(\);/);
  });
});
