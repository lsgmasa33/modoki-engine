/** Pins `createRealmDeathBackstop` (#611) — the decision core for the `pagehide` backstop in
 *  `useBackgroundFlush.ts`'s flush effect. See `../../app/realmDeathBackstop.ts` for the full reasoning: the
 *  `event.persisted === false` gate is an Android measurement shipped on iOS, where `pagehide` can
 *  fire on a mere backgrounding, so a false-alarm shutdown must be recoverable rather than guessed
 *  away with a narrower gate.
 *
 *  ⚠️ This file MUST stay `.test.tsx`. `engine/vite.config.ts`'s include list carries
 *  `tests/app/**\/*.test.tsx` and NO `.ts` sibling for this directory, so the same file named
 *  `.test.ts` is collected by nothing and reports green by being absent (see
 *  `resumeReloadThreshold.test.tsx` beside this file, which hit the same trap). The module under
 *  test is still plain `.ts` — only the test file's extension is forced by the vitest config. */
import { describe, it, expect, vi } from 'vitest';
import { createRealmDeathBackstop, type RealmDeathBackstopDeps } from '../../app/realmDeathBackstop';

function rig(overrides: Partial<RealmDeathBackstopDeps> = {}) {
  const runShutdown = vi.fn();
  const notifySurvived = vi.fn();
  const deps: RealmDeathBackstopDeps = { runShutdown, notifySurvived, ...overrides };
  return { backstop: createRealmDeathBackstop(deps), runShutdown, notifySurvived };
}

describe('createRealmDeathBackstop', () => {
  it('onPageHide(true) does nothing — a bfcache/background transition is not a death signal', () => {
    const { backstop, runShutdown, notifySurvived } = rig();
    backstop.onPageHide(true);
    expect(runShutdown).not.toHaveBeenCalled();
    expect(notifySurvived).not.toHaveBeenCalled();
  });

  it('onPageHide(false) runs shutdown', () => {
    const { backstop, runShutdown } = rig();
    backstop.onPageHide(false);
    expect(runShutdown).toHaveBeenCalledTimes(1);
  });

  it('onPageHide(undefined) does nothing — only an EXPLICIT false may trigger shutdown', () => {
    // A `pagehide` dispatched as a plain `Event` (not a `PageTransitionEvent`) carries
    // `persisted: undefined`. The gate must stay `!== false`, matching the pre-#611 behaviour
    // exactly — a truthiness check would treat `undefined` as "not persisted" and widen what
    // triggers a shutdown, which #611's ruling says the trigger gate must not do.
    const { backstop, runShutdown } = rig();
    backstop.onPageHide(undefined as unknown as boolean);
    expect(runShutdown).not.toHaveBeenCalled();
  });

  it('onRealmVisible() with NO prior pagehide shutdown does nothing — an ordinary foreground must never re-arm the seam', () => {
    const { backstop, notifySurvived } = rig();
    backstop.onRealmVisible();
    backstop.onRealmVisible();
    expect(notifySurvived).not.toHaveBeenCalled();
  });

  it('onRealmVisible() after onPageHide(false) notifies survival', () => {
    const { backstop, runShutdown, notifySurvived } = rig();
    backstop.onPageHide(false);
    backstop.onRealmVisible();
    expect(runShutdown).toHaveBeenCalledTimes(1);
    expect(notifySurvived).toHaveBeenCalledTimes(1);
  });

  it('a second consecutive onRealmVisible() does not notify twice', () => {
    const { backstop, notifySurvived } = rig();
    backstop.onPageHide(false);
    backstop.onRealmVisible();
    backstop.onRealmVisible();
    expect(notifySurvived).toHaveBeenCalledTimes(1);
  });

  it('onRealmVisible() after onPageHide(true) does nothing — persisted transitions never arm recovery', () => {
    const { backstop, notifySurvived } = rig();
    backstop.onPageHide(true);
    backstop.onRealmVisible();
    expect(notifySurvived).not.toHaveBeenCalled();
  });

  it('shutdown runs again after a survival episode — the flag is per-episode, not once-ever', () => {
    const { backstop, runShutdown, notifySurvived } = rig();
    backstop.onPageHide(false);
    backstop.onRealmVisible();
    expect(runShutdown).toHaveBeenCalledTimes(1);
    expect(notifySurvived).toHaveBeenCalledTimes(1);

    backstop.onPageHide(false);
    expect(runShutdown).toHaveBeenCalledTimes(2);
    backstop.onRealmVisible();
    expect(notifySurvived).toHaveBeenCalledTimes(2);
  });
});
