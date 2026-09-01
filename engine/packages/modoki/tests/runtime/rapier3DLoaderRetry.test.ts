/** rapier3DLoader.ts — the 3D half of the retry rule `rapierLoaderRetry.test.ts` states for 2D.
 *
 *  ⚠️ **Its own file for the reason that one gives: the assertion is about the FIRST import of the
 *  module**, so a sibling test resolving the loader first would memoise success and make this
 *  vacuous. The 2D file cannot simply grow a 3D `describe` for the same reason.
 *
 *  A failed WASM import/init must not poison `initPromise` for the rest of the process: before the
 *  fix it was assigned once and never reset, so one flaky dynamic import (a network blip, a
 *  mid-deploy asset swap) memoised the REJECTION and every later `initRapier3D()` re-awaited the
 *  same dead promise forever — 3D physics dead for the session even though the browser would
 *  happily retry. Reset lives in a `.catch` (not `.finally`) so a failed attempt retries while a
 *  SUCCESSFUL init stays memoised; `initPromise` IS the memo, there is no separate ready-check.
 *
 *  Both halves of the rule are pinned here: the RESET (a transient failure retries) and the CAP
 *  (#541's `RAPIER_INIT_MAX_ATTEMPTS`, so a PERMANENT failure stops re-entering `import()` on every
 *  tick and says so loudly exactly once). #541's follow-up landed on `main` covering 2D only; the
 *  3D loader carries the identical code and had nothing pinning it until this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('initRapier3D — retry after a failed import/init', () => {
  it('rejects on first failure, retries and succeeds on second call, memoizes after success', async () => {
    let calls = 0;
    // See `rapierLoaderRetry.test.ts` for why the failure is decided fresh inside `mod.init()`
    // on every call, rather than at the (cached, single-eval) import() factory.
    vi.doMock('@dimforge/rapier3d-compat', () => ({
      default: { init: vi.fn(() => { calls++; return calls === 1 ? Promise.reject(new Error('network blip')) : Promise.resolve(); }) },
    }));
    vi.doMock('../../src/runtime/core/warnSuppress', () => ({
      beginSuppressRapierInitWarning: vi.fn(),
      endSuppressRapierInitWarning: vi.fn(),
    }));

    const { initRapier3D, isRapier3DReady } = await import('../../src/runtime/physics/rapier3DLoader');

    await expect(initRapier3D()).rejects.toThrow('network blip');
    expect(isRapier3DReady()).toBe(false);

    await expect(initRapier3D()).resolves.toBeUndefined();
    expect(isRapier3DReady()).toBe(true);
    expect(calls).toBe(2); // retried — mod.init() ran a SECOND time

    await initRapier3D();
    expect(calls).toBe(2); // successful init stays memoized — no third init() call
  });
});

/** Fresh loader module with a mock that fails the first `failUntilCall` imports — mirrors
 *  `rapierLoaderRetry.test.ts`'s helper of the same name, against the 3D package. */
async function freshLoader(failUntilCall: number) {
  let calls = 0;
  vi.resetModules();
  vi.doMock('@dimforge/rapier3d-compat', async () => {
    calls++;
    if (calls <= failUntilCall) throw new Error('wasm chunk fetch failed');
    return { default: { init: vi.fn(async () => {}) } };
  });
  const mod = await import('../../src/runtime/physics/rapier3DLoader');
  return { ...mod, calls: () => calls };
}

describe('initRapier3D — the retry CAP (#541 follow-up, 3D half)', () => {
  it('caps retries at RAPIER_INIT_MAX_ATTEMPTS and warns, then errors loudly exactly once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { initRapier3D, isRapier3DReady, calls } = await freshLoader(Infinity); // never resolves

      // The caller re-enters on EVERY tick that sees a body, with no backoff of its own — call it
      // more times than the cap, exactly as the physics system would.
      for (let i = 0; i < 6; i++) {
        await expect(initRapier3D()).rejects.toThrow();
      }

      // ⚠️ MOCK-ONLY NUMBER, same caveat the 2D file states: in a real browser three attempts
      // against a failing `import()` produce ONE module fetch, because a failed module fetch is
      // cached per specifier. vitest re-invokes a factory that threw; the real loader does not.
      // What this pins is the CAP, not import behaviour.
      expect(calls()).toBe(3);
      expect(isRapier3DReady()).toBe(false);

      // The first two rejections (under the cap) warn and retry; the third is terminal.
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/Rapier3D init failed permanently/);

      // Past the cap the memoised rejection is returned as-is — no further import, no second error.
      await expect(initRapier3D()).rejects.toThrow();
      expect(calls()).toBe(3);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
