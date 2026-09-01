/** The #548 auto-ducking mechanism is actually WIRED — unprovable any other way.
 *
 *  `useAudioDucking()` (`engine/app/useAudioDucking.ts`) lives in its own module so its contract
 *  can be driven without mounting the whole app shell (`App` is not exported and drags in routing
 *  + the lazy editor chunk). That split is the same shape that has bitten this repo before (#489,
 *  #517, #225): a hook that works in isolation proves NOTHING about whether the shipped app ever
 *  calls it. Delete the `useAudioDucking();` line from `App.tsx` and every other gate stays green
 *  while the shipped game never ducks — the whole point of the feature, silently gone.
 *
 *  Deliberately a source grep: what fails in this class is not the logic (covered by the hook's
 *  own unit test and by `audioSessionPolicy.test.ts`) but the WIRING, and a test that imports the
 *  module cannot see whether production calls it. Sibling of `audioResumeRearmReachable.test.ts`. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('useAudioDucking is reached from production code (#548)', () => {
  it('App.tsx imports useAudioDucking from its own module', () => {
    // Comments stripped first (#419's shared scanner): a call COMMENTED OUT rather than deleted
    // is exactly the class of bug this guard exists to catch, and a naive regex would sail past it.
    const app = stripComments(read('engine/app/App.tsx'));
    // Match any path ENDING in the module name, not a pinned './useAudioDucking' — moving the hook
    // into engine/app/hooks/ changes nothing about reachability and must not turn this guard red.
    expect(app, 'App.tsx must import useAudioDucking')
      .toMatch(/import\s*\{[^}]*\buseAudioDucking\b[^}]*\}\s*from\s*'[^']*useAudioDucking'/);
  });

  it('App.tsx actually CALLS useAudioDucking(), not just imports it', () => {
    // A dangling import satisfies the check above but wires nothing.
    const app = stripComments(read('engine/app/App.tsx'));
    expect(app, 'App.tsx must call useAudioDucking()').toMatch(/\buseAudioDucking\(\);/);
  });

  it('the hook drives the duck through the POLICY, not by writing the bus volume', () => {
    // The duck node exists precisely so ducking and the player's music slider compose instead of
    // clobbering each other (#548: the slider is the only manual override the owner asked for).
    // A hook that reached for setAudioBusVolume('music', 0) would pass every other gate here and
    // silently desync that slider — the mix store is updated only by the setBusVolume UIAction.
    const hook = stripComments(read('engine/app/useAudioDucking.ts'));
    expect(hook, 'ducking must go through setAudioMusicDucked').toMatch(/\bsetAudioMusicDucked\(/);
    // Match the IDENTIFIER anywhere, not a call site: `import { setAudioBusVolume as setBus }`
    // followed by `setBus('music', 0)` defeats a call-shaped regex, and an alias is exactly what a
    // careless fix reaches for. The import clause still spells the real name, so this catches it.
    expect(hook, 'ducking must not write the music bus volume directly (aliased imports included)')
      .not.toMatch(/\bsetAudioBusVolume\b/);
  });
});
