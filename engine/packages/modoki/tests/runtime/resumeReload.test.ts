// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  registerReloadBlocker,
  getActiveReloadBlockers,
  createResumeReloadHandler,
  markResumeReload,
  consumeResumeReload,
  __clearReloadBlockersForTest,
  type ResumeReloadDeps,
} from '../../src/runtime/core/resumeReload';
import {
  registerRealmShutdownTask,
  runRealmShutdownTasks,
  __resetRealmShutdownForTest,
} from '../../src/runtime/core/realmShutdown';

afterEach(() => {
  __clearReloadBlockersForTest();
  __resetRealmShutdownForTest();
  vi.restoreAllMocks();
});

const MINUTE = 60_000;

/** A controllable rig for the decision core. Every dep is a spy so a test can assert on what the
 *  handler DID, not merely on what it returned — the handler returns nothing, and "did not
 *  reload" is the assertion that matters most here. */
function rig(overrides: Partial<ResumeReloadDeps> = {}) {
  let clock = 1_000_000; // arbitrary wall-clock origin
  const reload = vi.fn();
  const markResumed = vi.fn();
  const flush = vi.fn(async () => {});
  const pendingKeys = vi.fn(() => [] as string[]);
  const blockedBy = vi.fn(() => [] as string[]);
  const log = vi.fn();

  const deps: ResumeReloadDeps = {
    now: () => clock,
    thresholdMs: () => 10 * MINUTE,
    blockedBy,
    flush,
    pendingKeys,
    reload,
    markResumed,
    log,
    ...overrides,
  };

  return {
    handler: createResumeReloadHandler(deps),
    advance: (ms: number) => { clock += ms; },
    reload, markResumed, flush, pendingKeys, blockedBy, log,
  };
}

describe('reload blockers', () => {
  it('reports nothing active when none is registered', () => {
    expect(getActiveReloadBlockers()).toEqual([]);
  });

  it('names only the blockers currently reading blocked', () => {
    let purchasing = false;
    registerReloadBlocker('purchase', () => purchasing);
    registerReloadBlocker('signin', () => false);

    expect(getActiveReloadBlockers()).toEqual([]);
    purchasing = true;
    expect(getActiveReloadBlockers()).toEqual(['purchase']);
  });

  it('treats a THROWING predicate as blocked, not as safe', () => {
    // The opposite of uiBusySources, deliberately: there a throw degrades to "not busy" so a bad
    // predicate cannot brick every button; here a throw must not become permission to destroy
    // the realm. Declining costs nothing; reloading over an unknown state can strand a purchase.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerReloadBlocker('exploding', () => { throw new Error('nope'); });
    expect(getActiveReloadBlockers()).toEqual(['exploding']);
  });

  it('logs a throwing predicate once per streak, not once per call', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let broken = true;
    registerReloadBlocker('flaky', () => { if (broken) throw new Error('nope'); return false; });

    getActiveReloadBlockers();
    getActiveReloadBlockers();
    expect(err).toHaveBeenCalledTimes(1);

    broken = false;
    getActiveReloadBlockers();      // recovers, silently
    broken = true;
    getActiveReloadBlockers();      // a NEW streak logs again
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("each disposer removes only its OWN registration, even under a shared name", () => {
    const disposeA = registerReloadBlocker('account', () => true);
    registerReloadBlocker('account', () => true);

    expect(getActiveReloadBlockers()).toEqual(['account', 'account']);
    disposeA();
    expect(getActiveReloadBlockers()).toEqual(['account']);
    disposeA(); // idempotent — must not remove the survivor
    expect(getActiveReloadBlockers()).toEqual(['account']);
  });
});

describe('resume-reload decision', () => {
  it('reloads once the time away passes the threshold', async () => {
    const r = rig();
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).toHaveBeenCalledTimes(1);
    expect(r.markResumed).toHaveBeenCalledWith(11 * MINUTE);
  });

  it('announces the armed threshold on the first background edge, once per realm', async () => {
    // Measured on an S22: a mount-time log never reaches `device_console_logs`, because the debug
    // bridge installs its console capture from an async dynamic import — so every boot-time line
    // in the app is dropped. A background edge is long after boot, which is why the announcement
    // lives here and not at mount.
    const r = rig();
    r.handler.onBackground();
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('600s away'));

    r.log.mockClear();
    r.advance(1000);
    r.handler.onBackground();
    expect(r.log, 'once per realm, not once per edge').not.toHaveBeenCalled();
  });

  it('does not reload for a short trip away', async () => {
    const r = rig();
    r.handler.onBackground();
    r.advance(9 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
  });

  it('does nothing on a resume with no recorded background (cold launch)', async () => {
    const r = rig();
    r.advance(60 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
  });

  it('is disabled when the threshold is 0, however long the absence', async () => {
    const r = rig({ thresholdMs: () => 0 });
    r.handler.onBackground();
    r.advance(24 * 60 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
  });

  it('does not reload on a BACKWARDS clock', async () => {
    // A user time change or an NTP step can make the delta negative. That is not a stale
    // session, it is an uninterpretable number — and reloading on it would be indistinguishable
    // from a bug to whoever hit it.
    const r = rig();
    r.handler.onBackground();
    r.advance(-30 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
  });

  it('flushes prefs BEFORE reloading', async () => {
    const order: string[] = [];
    const r = rig({
      flush: vi.fn(async () => { order.push('flush'); }),
      reload: vi.fn(() => { order.push('reload'); }),
    });
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    expect(order).toEqual(['flush', 'reload']);
  });

  it('declines when a pref write did not land, even though flush() resolved', async () => {
    // `drain()` catches every write error and re-queues it, so the flush promise resolves
    // whether or not anything reached the backend. `pendingKeys()` is the only real gate, and a
    // reload here would discard the re-queued writes.
    const r = rig({ pendingKeys: () => ['court.progress'] });
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    expect(r.flush).toHaveBeenCalled();
    expect(r.reload).not.toHaveBeenCalled();
  });

  it('declines while something is in flight at resume time', async () => {
    const r = rig({ blockedBy: () => ['court.purchase'] });
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('court.purchase'));
  });

  it('declines when something was in flight at BACKGROUND time, even if it looks clear now', async () => {
    // The case a resume-time check alone cannot see: the app deliberately sent the player out
    // (a rewarded video opening the App Store, an OAuth hop), the SDK cleared its own in-flight
    // flag while we were away, and its completion callback is about to fire into the realm we
    // would be destroying.
    //
    // ⚠️ Driven by STATE, not by call order. An earlier version of this test used
    // `mockReturnValueOnce([...]).mockReturnValue([])`, which passes whether or not the
    // background sample exists: delete the sample and the resume-time call simply becomes the
    // first call, returning the blocked value anyway. It has to be possible for the resume-time
    // check to genuinely see "clear", or this asserts nothing.
    let adShowing = true;
    const r = rig({ blockedBy: () => (adShowing ? ['court.rewardedAd'] : []) });

    r.handler.onBackground();
    adShowing = false;          // the SDK cleared its own in-flight flag while we were away
    r.advance(20 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('court.rewardedAd'));
  });

  it('declines when a blocker appears DURING the flush', async () => {
    // capture-before-await / re-check-after-await. The flush is the only await on this path, and
    // it is the last point at which declining is still free.
    let started = false;
    const r = rig({
      flush: vi.fn(async () => { started = true; }),
      blockedBy: () => (started ? ['court.purchase'] : []),
    });
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('during the flush'));
  });

  it('re-arms after declining: a later background/resume cycle can still reload', async () => {
    // A refusal must not be permanent — but it also must not latch, or a player who was busy
    // once gets reloaded mid-session much later on a short absence.
    let blocked = true;
    const r = rig({ blockedBy: () => (blocked ? ['busy'] : []) });

    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();
    expect(r.reload).not.toHaveBeenCalled();

    // A SHORT absence after the refusal must NOT reload — proving the stale timestamp was
    // dropped rather than latched.
    blocked = false;
    r.handler.onBackground();
    r.advance(1 * MINUTE);
    await r.handler.onResume();
    expect(r.reload).not.toHaveBeenCalled();

    // A fresh long absence does.
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();
    expect(r.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at most once when two resume edges race', async () => {
    // `visibilitychange` and `appStateChange` both fire on a native foreground, so this is the
    // normal case on device, not a contrived one.
    const r = rig();
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await Promise.all([r.handler.onResume(), r.handler.onResume()]);

    expect(r.reload).toHaveBeenCalledTimes(1);
  });

  it('declines when the app is backgrounded AGAIN during the flush', async () => {
    // The flush is the only await, and a background edge inside it makes this resume stale: the
    // player is no longer looking at the app, and `onBackground` has recorded a fresh sample that
    // this in-flight call captured neither of. Reloading would fire into a hidden webview.
    // `flush` has to reach back into the handler that `rig()` has not returned yet, so the edge
    // is injected through a slot rather than a forward-declared binding.
    let duringFlush = () => {};
    const r = rig({ flush: vi.fn(async () => { duringFlush(); }) });
    duringFlush = () => r.handler.onBackground();

    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    expect(r.reload).not.toHaveBeenCalled();
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining('during the flush'));
  });

  it('is NOT wedged off permanently when reload() throws', async () => {
    // The latch exists to stop a double reload, but if `reload()` itself fails the realm is not
    // dying and the latch would disable the trigger for the rest of the session — a
    // permanent-off state from one transient failure, whose only symptom is something never
    // happening again.
    let boom = true;
    const reload = vi.fn(() => { if (boom) throw new Error('navigation blocked'); });
    // The REAL `markResumeReload`, not the rig's spy — the breadcrumb assertion below is about
    // sessionStorage actually holding a marker, and against the spy it would pass whether or not
    // the catch cleans up.
    const r = rig({ reload, markResumed: markResumeReload });

    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await expect(r.handler.onResume()).rejects.toThrow('navigation blocked');

    // The breadcrumb was written a line before `reload()` threw. Surviving the throw means
    // surviving with it, and a stale one-shot makes the next ordinary navigation look like a
    // resume-reload — so un-latching and taking it back belong together.
    expect(consumeResumeReload()).toBeNull();

    boom = false;
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('is NOT wedged off permanently when reload() returns a REJECTED promise', async () => {
    // Same recovery as the synchronous-throw case above, but for the async contract added when
    // `useResumeReload.ts` started running realm-shutdown tasks before the actual
    // `window.location.reload()` (#587): `deps.reload()` can now fail asynchronously, and the
    // handler must `await` it for this `catch` to ever see that failure.
    let boom = true;
    const reload = vi.fn(() => (boom
      ? Promise.reject(new Error('shutdown task failed'))
      : Promise.resolve()));
    const r = rig({ reload, markResumed: markResumeReload });

    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await expect(r.handler.onResume()).rejects.toThrow('shutdown task failed');

    // Same two recovery behaviours as the sync case: the breadcrumb is taken back...
    expect(consumeResumeReload()).toBeNull();

    // ...and the latch is un-stuck, so a second resume edge still reloads.
    boom = false;
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('re-arms the realm-shutdown seam when reload() fails, so a LATER reload still runs teardown', async () => {
    // Mirrors the production wiring (`engine.reload`, `useResumeReload`): `deps.reload()` runs the
    // realm-shutdown tasks and then the actual navigation. `runRealmShutdownTasks()`'s own latch
    // means the shutdown task must not run a second time UNLESS the first reload attempt failed.
    const shutdownTask = vi.fn();
    registerRealmShutdownTask('task', shutdownTask);

    let boom = true;
    const reload = vi.fn(() => runRealmShutdownTasks().then(() => {
      if (boom) throw new Error('navigation blocked');
    }));
    const r = rig({ reload, markResumed: markResumeReload });

    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await expect(r.handler.onResume()).rejects.toThrow('navigation blocked');
    expect(shutdownTask).toHaveBeenCalledTimes(1);

    boom = false;
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();

    // Without `notifyRealmSurvived()` in the recovery `catch`, `runRealmShutdownTasks()`'s latch
    // would still be spent from the failed attempt and this second call would be a no-op.
    expect(shutdownTask).toHaveBeenCalledTimes(2);
  });

  it('ignores a background edge that arrives after the reload was committed', async () => {
    const r = rig();
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();
    expect(r.reload).toHaveBeenCalledTimes(1);

    // The realm is dying but has not died yet; a late edge must not re-arm anything.
    r.handler.onBackground();
    r.advance(11 * MINUTE);
    await r.handler.onResume();
    expect(r.reload).toHaveBeenCalledTimes(1);
  });
});

describe('resume breadcrumb', () => {
  it('round-trips the time away and is one-shot', () => {
    markResumeReload(11 * MINUTE);
    expect(consumeResumeReload()).toEqual({ awayMs: 11 * MINUTE });
    // One-shot: a second consumer must not also believe it is handling the resume, and a
    // leftover breadcrumb would make every later navigation look like a resume-reload.
    expect(consumeResumeReload()).toBeNull();
  });

  it('reads as absent when nothing was written', () => {
    expect(consumeResumeReload()).toBeNull();
  });

  it('treats a corrupt breadcrumb as absent AND clears it', () => {
    sessionStorage.setItem('modoki.resumeReload', '{not json');
    expect(consumeResumeReload()).toBeNull();
    expect(sessionStorage.getItem('modoki.resumeReload')).toBeNull();
  });

  it('survives sessionStorage throwing, without stopping the reload', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    expect(() => markResumeReload(MINUTE)).not.toThrow();
    setItem.mockRestore();
  });
});
