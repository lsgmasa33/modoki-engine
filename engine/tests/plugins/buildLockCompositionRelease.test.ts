/** `acquireBuildSlot`'s composed release, tested with the cross-process half fully mocked (#799
 *  follow-up to BLOCKER 1) — a companion to `buildLock.test.ts`'s own
 *  "acquireBuildSlot — release() never throws…" describe block, which exercises the SAME property
 *  end to end through a real `denyBuildClaimsLockMkdir()` failure. That end-to-end test alone is
 *  not enough to prove `buildLock.ts`'s own `try { cross.release() } finally { local.release() }`
 *  does anything: `buildClaimsStore.mjs`'s own fix (the sibling BLOCKER 1 fix) makes
 *  `releaseBuildClaimByToken` warn-and-swallow internally, so in that end-to-end test
 *  `cross.release()` never actually throws any more — a regression that DELETED `buildLock.ts`'s
 *  `try/finally` (reverting to a bare `cross.release(); local.release();`) would leave that other
 *  test GREEN, because there is nothing left to catch. Measured while writing this fix.
 *
 *  This file closes that gap by mocking `buildClaimsStore.mjs` entirely, so `cross.release()` can
 *  be made to throw deterministically regardless of what the real module does — isolating
 *  `buildLock.ts`'s OWN defensive composition from the module it composes. A regression to EITHER
 *  side (this file's mock proves `buildLock.ts`'s own `finally`; `buildClaimsStore.test.ts` proves
 *  `releaseBuildClaimByToken` itself never throws for a REAL failure) is still caught by ONE of the
 *  two suites, which is the point of separating them. */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../scripts/buildClaimsStore.mjs', () => ({
  acquireBuildClaim: vi.fn(() => ({
    ok: true,
    release: () => { throw new Error('cross-process release boom (mocked)'); },
  })),
}));

import { acquireBuildSlot, acquireBuild, activeBuild, resetBuildLockForTests } from '../../plugins/backend/buildLock';

afterEach(() => resetBuildLockForTests());

describe('acquireBuildSlot — the in-process slot is freed via `finally` even when the cross-process release throws (#799 follow-up, isolated)', () => {
  it('local.release() still runs — the in-process slot is free again — even though cross.release() throws', () => {
    const r = acquireBuildSlot('ios build', '/proj/mock-a');
    if (!r.ok) throw new Error('unreachable');
    expect(activeBuild()?.label).toBe('ios build');

    // The composed release does not SWALLOW a throw from the cross-process side (only
    // `buildClaimsStore.mjs`'s own release is documented to do that, for a REAL failure) — it only
    // guarantees the in-process half still runs first. So the mocked error is expected to
    // propagate out of `release()` itself.
    expect(() => r.release()).toThrow('cross-process release boom (mocked)');

    // The load-bearing assertion: the in-process slot is free again regardless — this is what
    // `try { cross.release() } finally { local.release() }` buys over two bare statements, which
    // would have skipped `local.release()` entirely and left `active` set for the life of this
    // backend process.
    expect(activeBuild()).toBeNull();
    expect(acquireBuild('android build').ok).toBe(true);
  });
});
