/** `shareTierResolution`'s `finally` now identity-checks before nulling `sharedResolution`.
 *
 *  ⚠️ HONESTY CHECK ON THE DRIVER, per docs/async-lifetime.md: `shareTierResolution` has exactly
 *  one production caller (`tierResolve.ts`'s `resolveActiveTier`), and its own `if (sharedResolution)
 *  return sharedResolution;` early return means two production calls can never both install a
 *  promise while one is in flight — the check-then-set is fully synchronous, with no `await`
 *  between them, so nothing can interleave. The only thing that currently REPLACES
 *  `sharedResolution` out from under an in-flight run is `resetProbeInFlightForTest()` (a test seam
 *  — see its own doc comment). This test therefore does NOT pin a proven production regression; it
 *  pins the identity guard against the one mechanism in this codebase, today, that can actually
 *  drive the race — the same honest caveat `probeReentrancy.ts`'s `sessionLiveness` token states
 *  for the sibling guard right above this one. Kept anyway (see that file's comment) because a
 *  future second caller or a mid-flight production reset would reach exactly this path. */

import { describe, it, expect, afterEach } from 'vitest';
import { shareTierResolution, resetProbeInFlightForTest } from '../../src/runtime/rendering/probeReentrancy';

afterEach(() => resetProbeInFlightForTest());

describe('shareTierResolution — finally only clears the slot if still the current occupant', () => {
  it('does not clear a NEWER promise when an older, reset-orphaned run settles later', async () => {
    let releaseOld!: () => void;
    const oldRun = () => new Promise<void>((r) => { releaseOld = r; });

    const oldPromise = shareTierResolution(oldRun); // installs sharedResolution = oldPromise

    // A mid-flight reset (the one mechanism that can currently orphan an in-flight run — see the
    // file doc above) clears the slot while `oldRun` is still pending.
    resetProbeInFlightForTest();

    let newRuns = 0;
    const newPromise = shareTierResolution(() => { newRuns += 1; return Promise.resolve(); });
    await newPromise; // the NEW run settles (and its own finally leaves the slot null, correctly)
    expect(newRuns).toBe(1);

    // Now the OLD, orphaned run finally settles. Without the identity check its `finally` would
    // unconditionally null `sharedResolution` — a no-op here since it's already null, so this
    // specific interleaving needs a THIRD run in flight to observe corruption. Install one.
    let thirdRuns = 0;
    const thirdPromise = shareTierResolution(() => { thirdRuns += 1; return new Promise<void>(() => {}); });
    expect(thirdRuns).toBe(1);

    releaseOld();
    await oldPromise;

    // The old run's `finally` must NOT have cleared the slot out from under the third, still-running
    // one — a fresh `shareTierResolution` call right now must coalesce onto it, not start a FOURTH.
    let fourthRuns = 0;
    const stillThird = shareTierResolution(() => { fourthRuns += 1; return Promise.resolve(); });
    expect(stillThird).toBe(thirdPromise);
    expect(fourthRuns).toBe(0);
  });
});
