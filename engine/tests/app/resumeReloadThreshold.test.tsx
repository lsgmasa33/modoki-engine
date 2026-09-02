/** Pins `resolveThresholdMs` — the one piece of #574 that lives in the app shell rather than the
 *  runtime package, because it reads the project config.
 *
 *  ⚠️ This file MUST stay `.test.tsx`. `engine/vite.config.ts`'s include list carries
 *  `tests/app/**\/*.test.tsx` and NO `.ts` sibling for this directory, so the same file named
 *  `.test.ts` is collected by nothing and reports green by being absent. */
import { describe, it, expect, vi } from 'vitest';

// The subject imports `virtual:modoki-project-config` (resolved by a Vite plugin that does not
// run here) plus Capacitor and the engine runtime. Stub them so the module can load; the function
// under test takes its config as an argument, so none of these stubs feed the assertions.
vi.mock('virtual:modoki-project-config', () => ({ default: {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock('@modoki/engine/runtime', () => ({
  PlayerPrefs: { flush: vi.fn(), pendingKeys: () => [] },
  createResumeReloadHandler: vi.fn(),
  getActiveReloadBlockers: () => [],
  markResumeReload: vi.fn(),
}));

const { resolveThresholdMs } = await import('../../app/useResumeReload');

const MINUTE = 60_000;

describe('resolveThresholdMs', () => {
  it('is disabled when the project has authored nothing', () => {
    expect(resolveThresholdMs({})).toBe(0);
    expect(resolveThresholdMs({ runtime: {} })).toBe(0);
  });

  it('converts authored minutes to ms', () => {
    expect(resolveThresholdMs({ runtime: { reloadAfterBackgroundMinutes: 10 } })).toBe(10 * MINUTE);
  });

  it('treats every malformed value as DISABLED, never as "reload constantly"', () => {
    for (const bad of [null, undefined, '10', NaN, Infinity, -5, 0, {}, []]) {
      expect(resolveThresholdMs({ runtime: { reloadAfterBackgroundMinutes: bad } })).toBe(0);
    }
  });

  it('caps the threshold at 1 minute in a debug build', () => {
    // Waiting ten real minutes per iteration means the trigger gets exercised once and assumed
    // correct thereafter (owner, 2026-09-02).
    expect(resolveThresholdMs({
      runtime: { reloadAfterBackgroundMinutes: 10 },
      build: { debugBuild: true },
    })).toBe(MINUTE);
  });

  it('caps rather than overrides — a shorter authored value survives a debug build', () => {
    expect(resolveThresholdMs({
      runtime: { reloadAfterBackgroundMinutes: 0.5 },
      build: { debugBuild: true },
    })).toBe(0.5 * MINUTE);
  });

  it('does not let a debug build switch an opted-OUT project ON', () => {
    // The cap is applied after the disabled check, so 0 stays 0. Getting this backwards would
    // turn the trigger on for every game that never asked for it, in exactly the builds used for
    // playtesting — including the ones that persist nothing and would lose the session.
    expect(resolveThresholdMs({ build: { debugBuild: true } })).toBe(0);
    expect(resolveThresholdMs({
      runtime: { reloadAfterBackgroundMinutes: 0 },
      build: { debugBuild: true },
    })).toBe(0);
  });

  it('leaves a release build at the authored value', () => {
    expect(resolveThresholdMs({
      runtime: { reloadAfterBackgroundMinutes: 10 },
      build: { debugBuild: false },
    })).toBe(10 * MINUTE);
  });
});
