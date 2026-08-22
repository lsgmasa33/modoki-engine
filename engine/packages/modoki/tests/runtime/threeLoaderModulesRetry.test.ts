/** A FAILED on-demand loader import must not poison every later one (#254).
 *
 *  The accessors in `threeLoaderModules` memoise their promise so N callers share one chunk
 *  fetch. The trap in that shape is that a *rejected* promise is just as memoisable as a
 *  resolved one — so one transient failure (offline, a half-deployed CDN, a killed request)
 *  would leave every future GLB/HDR/KTX2 load rejecting for the life of the page, with nothing
 *  in the app able to recover short of a reload. `textureResolver`'s texture cache states the
 *  same rule for the same reason ("Don't cache a rejected load forever").
 *
 *  This lives in its OWN file because the assertion is about the FIRST import of the module:
 *  a sibling test that resolves it first would memoise success and make this vacuous. Same
 *  reason it uses `HDRLoader` — nothing else here touches it.
 */

import { describe, it, expect, vi } from 'vitest';

const hdr = vi.hoisted(() => ({ calls: 0 }));

// Fails the first evaluation, succeeds after. Vitest re-invokes a mock factory that threw
// (verified: the counter reaches 2), which is what makes the retry observable at all.
vi.mock('three/examples/jsm/loaders/HDRLoader.js', async () => {
  hdr.calls++;
  if (hdr.calls === 1) throw new Error('chunk fetch failed');
  return { HDRLoader: class {} };
});

import { hdrLoaderCtor } from '../../src/runtime/loaders/threeLoaderModules';

describe('threeLoaderModules — a rejected import is not memoised (#254)', () => {
  it('drops the memo on failure so the next caller retries', async () => {
    // Vitest wraps a factory throw in its own "error when mocking a module" message, so assert
    // on the REJECTION, not on the text — the text belongs to vitest, the rejection to us.
    await expect(hdrLoaderCtor()).rejects.toThrow();

    // The retry is the whole point: with the rejection memoised this call rejects too, and an
    // HDR environment stays permanently unloadable after one bad network moment.
    const Ctor = await hdrLoaderCtor();
    expect(typeof Ctor).toBe('function');
    expect(hdr.calls).toBe(2); // re-imported exactly once, not on every call

    // ...and the successful result IS memoised — dropping the memo must not cost the
    // single-flight property the accessor exists for.
    expect(hdrLoaderCtor()).toBe(hdrLoaderCtor());
    await hdrLoaderCtor();
    expect(hdr.calls).toBe(2);
  });
});
