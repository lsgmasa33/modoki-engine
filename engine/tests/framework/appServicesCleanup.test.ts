/** #511 — `clearAppServices()` (a game-swap teardown) used to be `registered = {}` and nothing
 *  more, so an `AdsService`'s `cleanup()` was never reached on a swap — only on `App.tsx`'s
 *  `[]`-deps unmount effect. The fix captures the outgoing `ads`, clears the registry FIRST, then
 *  calls `cleanup()` on the capture inside a `try/catch` so a game's cleanup can never break the
 *  swap. These tests pin that order and the failure-tolerance directly against the real module —
 *  see `engine/packages/modoki/src/runtime/core/appServices.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  registerAppServices,
  appServices,
  clearAppServices,
  type AdsService,
} from '@modoki/engine/runtime';

function fakeAds(cleanup: () => void): AdsService {
  return {
    init: () => {},
    cleanup,
  };
}

describe('clearAppServices() (#511)', () => {
  afterEach(() => {
    // Leave no registration behind for the next test/file — this module's state is process-level.
    clearAppServices();
  });

  it('calls a registered ads.cleanup() exactly once', () => {
    const cleanup = vi.fn();
    registerAppServices({ ads: fakeAds(cleanup) });

    clearAppServices();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('leaves appServices() empty after clearing', () => {
    registerAppServices({ ads: fakeAds(() => {}) });

    clearAppServices();

    expect(appServices()).toEqual({});
  });

  it('an ads.cleanup() that throws still leaves appServices() empty and does not propagate', () => {
    registerAppServices({
      ads: fakeAds(() => {
        throw new Error('cleanup blew up');
      }),
    });

    expect(() => clearAppServices()).not.toThrow();
    expect(appServices()).toEqual({});
  });

  it('an ads.cleanup() that throws is warned, not silently swallowed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerAppServices({
        ads: fakeAds(() => {
          throw new Error('cleanup blew up');
        }),
      });

      clearAppServices();

      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not throw with no ads registered', () => {
    registerAppServices({ crashlytics: { recordError: () => {}, log: () => {} } });

    expect(() => clearAppServices()).not.toThrow();
    expect(appServices()).toEqual({});
  });
});
