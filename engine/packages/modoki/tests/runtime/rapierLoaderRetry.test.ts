/** A FAILED Rapier2D WASM load must not poison physics for the rest of the session (#541),
 *  and a load that keeps failing must not retry at frame rate forever, silently (#541 follow-up).
 *
 *  `initRapier2D()` memoises `initPromise` so N callers (the physics system calls it on
 *  every tick that sees a body) share one load. The trap: a *rejected* promise is just as
 *  memoisable as a resolved one, so one transient chunk-fetch/init failure would leave
 *  `isRapierReady()` false and the SAME rejection re-firing every frame for the rest of the
 *  session — physics never starts. `threeLoaderModulesRetry.test.ts` states the same rule
 *  for the sibling GLB/HDR/KTX2 loaders.
 *
 *  The follow-up trap: dropping the memo unconditionally makes a PERMANENT failure (not a
 *  transient one) re-enter the dynamic `import()` on every tick forever, with the rejection
 *  handled silently (attached to the very promise the caller awaits) — physics dies with zero
 *  console output. So retries are capped at `RAPIER_INIT_MAX_ATTEMPTS`, each rejection warns,
 *  and the terminal one errors loudly exactly once.
 *
 *  This lives in its OWN file for the same reason `threeLoaderModulesRetry.test.ts` does: the
 *  assertion is about the FIRST import of the module, so a sibling test resolving it first
 *  would memoise success and make this vacuous. Each `it` here gets its OWN fresh loader
 *  module AND its own freshly (re-)mocked `@dimforge/rapier2d-compat` via `vi.doMock` +
 *  `vi.resetModules()`, so the cap/warn/error assertions aren't polluted by a previous test's
 *  memoised state — `vi.resetModules()` alone does not force a module that already resolved
 *  successfully in an earlier test to re-run its (mocked) import.
 */

import { describe, it, expect, vi } from 'vitest';

/** Fresh loader module + a freshly (re-)mocked rapier2d-compat that fails while
 *  `calls <= failUntilCall`, then succeeds. Returns a `calls()` accessor so each test can
 *  assert on ITS OWN import count without cross-test pollution. */
async function freshLoader(failUntilCall: number) {
  let calls = 0;
  vi.resetModules();
  vi.doMock('@dimforge/rapier2d-compat', async () => {
    calls++;
    if (calls <= failUntilCall) throw new Error('wasm chunk fetch failed');
    return { default: { init: vi.fn(async () => {}) } };
  });
  const mod = await import('../../src/runtime/physics/rapierLoader');
  return { ...mod, calls: () => calls };
}

describe('rapierLoader — a rejected initPromise is not memoised (#541)', () => {
  it('drops the memo on failure so the next tick retries, and a success stays memoised', async () => {
    const { initRapier2D, isRapierReady, getRapier, calls } = await freshLoader(1);

    expect(isRapierReady()).toBe(false);

    // First attempt: the WASM chunk fetch fails. With the old bare `if (!initPromise)`
    // shape this rejection would be cached forever. Vitest wraps a factory throw in its own
    // "error when mocking a module" message, so assert on the REJECTION, not on the text —
    // the text belongs to vitest, the rejection to us (same as threeLoaderModulesRetry.test.ts).
    await expect(initRapier2D()).rejects.toThrow();
    expect(isRapierReady()).toBe(false);

    // The retry is the whole point: with the rejection memoised this call rejects too, and
    // physics stays permanently dead after one bad WASM-fetch moment.
    await initRapier2D();
    expect(isRapierReady()).toBe(true);
    expect(getRapier()).toBeDefined();
    expect(calls()).toBe(2); // re-imported exactly once, not on every call

    // ...and the successful result IS memoised — dropping the memo on failure must not cost
    // the single-flight property `initRapier2D` exists for (the physics system calls it
    // every tick that sees a body).
    expect(initRapier2D()).toBe(initRapier2D());
    await initRapier2D();
    expect(calls()).toBe(2);
  });

  it('caps retries at RAPIER_INIT_MAX_ATTEMPTS and warns, then errors loudly exactly once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { initRapier2D, isRapierReady, calls } = await freshLoader(Infinity); // never resolves

      // The caller (physics2DSystem.ts) re-enters `initRapier2D()` on EVERY tick that sees a
      // body with no backoff of its own — call it more times than the cap.
      for (let i = 0; i < 6; i++) {
        await expect(initRapier2D()).rejects.toThrow();
      }

      // Capped: the underlying import factory ran exactly RAPIER_INIT_MAX_ATTEMPTS times, not
      // once per call (6 calls above, only 3 imports).
      // ⚠️ MOCK-ONLY NUMBER. In a real browser three attempts against a failing
      // import() produce ONE module fetch, not three: a failed module fetch is cached per
      // specifier and re-calling import() issues no further request (measured in Chromium,
      // WebKit and Firefox — see docs/architecture.md). vitest re-invokes a factory that
      // threw, which the real loader does not. What this pins is the CAP, not import behaviour.

      expect(calls()).toBe(3);
      expect(isRapierReady()).toBe(false);

      // The first two rejections (still under the cap) warn and retry; the third is terminal.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/Rapier2D init failed permanently/);

      // Further calls past the cap must return the SAME memoised rejection — no further
      // import, no further console.error.
      await expect(initRapier2D()).rejects.toThrow();
      await expect(initRapier2D()).rejects.toThrow();
      expect(calls()).toBe(3);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('a success after one transient failure still works, and a fresh run gets the full retry budget', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { initRapier2D, isRapierReady, getRapier, calls } = await freshLoader(1);

      await expect(initRapier2D()).rejects.toThrow();
      await initRapier2D();
      expect(isRapierReady()).toBe(true);
      expect(getRapier()).toBeDefined();
      expect(calls()).toBe(2);

      // One retry under the cap warns once; success means the terminal error never fires —
      // the failed-attempt counter must not have been left sitting near the cap.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();

      // A later, independent run (a fresh module instance, standing in for the counter having
      // been reset to 0 on success rather than carried over) gets the FULL retry budget again
      // rather than being penalised by the earlier transient failure.
      const fresh = await freshLoader(Infinity);
      for (let i = 0; i < 3; i++) {
        await expect(fresh.initRapier2D()).rejects.toThrow();
      }
      expect(fresh.calls()).toBe(3); // got all RAPIER_INIT_MAX_ATTEMPTS, not fewer
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
