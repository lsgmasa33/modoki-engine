/** The #489 audio re-arm mechanism is actually WIRED — unprovable any other way.
 *
 *  `useAudioResumeRearm()` (`engine/app/useAudioResumeRearm.ts`) lives in its own module
 *  specifically so `audioResumeRearm.test.tsx` can drive it without mounting the whole app shell
 *  (`App` itself is not exported and drags in routing + the lazy editor chunk). That split is
 *  exactly the shape that has bitten this repo before (#517, #225, and `appTeardownReachable.test.ts`
 *  above): a hook that works in isolation proves nothing about whether the shipped app ever calls
 *  it. Delete the `useAudioResumeRearm();` line from `App.tsx` and every existing gate — including
 *  `audioResumeRearm.test.tsx` — stays green while shipped audio never re-arms after an iOS
 *  interruption, which is the exact #489 symptom the hook was written to fix.
 *
 *  Deliberately a source grep, for the reason `deviceTeardownReachable.test.ts` gives: what fails in
 *  this class is not the logic (covered by the hook's own unit test) but the WIRING, and a test
 *  that imports the module cannot see whether production calls it. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('useAudioResumeRearm is reached from production code (#489)', () => {
  it('App.tsx imports useAudioResumeRearm from its own module', () => {
    // Comments stripped first (the shared scanner, #419 — a private regex stripper here would be
    // exactly the class of bug this test exists to catch: a call COMMENTED OUT, not deleted, must
    // not slip past the regexes below).
    const app = stripComments(read('engine/app/App.tsx'));
    // Match any path ENDING in the module name, not a pinned './useAudioResumeRearm' — moving the
    // hook into engine/app/hooks/ (which already exists, for useKeyboardShift) changes nothing
    // about reachability and must not turn this guard red.
    expect(app, 'App.tsx must import useAudioResumeRearm')
      .toMatch(/import\s*\{[^}]*\buseAudioResumeRearm\b[^}]*\}\s*from\s*'[^']*useAudioResumeRearm'/);
  });

  it('App.tsx actually CALLS useAudioResumeRearm(), not just imports it', () => {
    // A dangling import satisfies the check above but wires nothing — the mechanism is one
    // deleted (or commented-out) call away from being dead, and the hook's own unit test cannot
    // see the gap.
    const app = stripComments(read('engine/app/App.tsx'));
    expect(app, 'App.tsx must call useAudioResumeRearm()').toMatch(/\buseAudioResumeRearm\(\);/);
  });
});
