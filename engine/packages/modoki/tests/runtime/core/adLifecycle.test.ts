/**
 * The SDK-neutral ad lifecycle (#1309, promoted in #1312), driven through a FAKE adapter — no plugin mock, because the
 * lifecycle never sees a plugin. Each block names the Court incident the rule was paid for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getActiveReloadBlockers } from '../../../src/runtime/core/resumeReload';
import { getBootTimeline, resetBootTimeline } from '../../../src/runtime/core/bootTimeline';
import {
  createAdLifecycle, onFullscreenAdChange, type AdEventSink, type AdLifecycle, type AdLifecycleHooks, type AdSdk,
  type FullscreenKind,
} from '../../../src/runtime/core/adLifecycle';

const BLOCKER = 'test.fullscreenAd';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake SDK. `live` counts listeners currently registered — the number a leak inflates. */
function fakeSdk(over: Partial<AdSdk> = {}) {
  const state = {
    enabled: true,
    live: 0,
    sink: null as AdEventSink | null,
    registerFailsAt: -1,
  };
  const sdk = {
    enabled: vi.fn(() => state.enabled),
    has: vi.fn((_k: FullscreenKind | 'banner') => true),
    start: vi.fn(async () => {}),
    listeners: vi.fn((sink: AdEventSink) => {
      state.sink = sink;
      return [0, 1, 2].map((i) => async () => {
        if (i === state.registerFailsAt) throw new Error('bridge not ready');
        state.live++;
        let removed = false;
        return { remove: () => { if (!removed) { removed = true; state.live--; } } };
      });
    }),
    preload: vi.fn(async (_k: FullscreenKind) => {}),
    // Like AdMob's rewarded show on iOS: never settles unless a test says so.
    present: vi.fn((_k: FullscreenKind) => new Promise<unknown>(() => {})),
    showBanner: vi.fn(async () => {}),
    hideBanner: vi.fn(async () => {}),
    teardown: vi.fn(() => {}),
    ...over,
  };
  return { sdk, state, sink: () => state.sink! };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

let life: AdLifecycle | null = null;
function make(sdk: AdSdk, hooks: AdLifecycleHooks = {}, now = () => 0) {
  life = createAdLifecycle(sdk, hooks, { blockerId: BLOCKER, tag: 'test', now, presentTimeoutMs: 1000, retryMs: 5000 });
  return life;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  life?.cleanup();
  life = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('init', () => {
  it('latches before the first await: two same-tick inits start the SDK once (Court #458)', async () => {
    const { sdk } = fakeSdk();
    const l = make(sdk);
    await Promise.all([l.init(), l.init()]);
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(l.isInitialized()).toBe(true);
  });

  it('start() is an `ads-start` boot span, open exactly while it runs (#1475)', async () => {
    // start() can put a native consent form in front of the game; the timeline has to show when.
    resetBootTimeline();
    const gate = deferred();
    const { sdk } = fakeSdk({ start: vi.fn(() => gate.promise) });
    const l = make(sdk);
    const done = l.init();
    const open = getBootTimeline().spans.filter((s) => s.name === 'ads-start');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ endMs: -1, detail: 'test' });
    gate.resolve();
    await done;
    // Closed — `-1` is the open sentinel. Not `>= 0`: this suite fakes timers, which moves the clock
    // under the timeline's real-time origin, so a closed span's timestamps can read negative here.
    expect(getBootTimeline().spans.find((s) => s.name === 'ads-start')!.endMs).not.toBe(-1);
  });

  it('a disabled SDK is never called — not by init, a show, or the banner (the crash guard)', async () => {
    const { sdk, state } = fakeSdk();
    state.enabled = false;
    const l = make(sdk);
    await l.init();
    l.setBannerVisible(true);
    expect(await l.showFullscreen('rewarded', 'p')).toBe(false);
    for (const fn of [sdk.start, sdk.listeners, sdk.preload, sdk.present, sdk.showBanner, sdk.hideBanner]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('a registration failing midway unwinds the ones before it, and a retry leaves exactly one set live', async () => {
    const { sdk, state } = fakeSdk();
    state.registerFailsAt = 2;
    const l = make(sdk);
    await l.init();
    expect(l.isInitialized()).toBe(false);
    expect(state.live).toBe(0);
    state.registerFailsAt = -1;
    await l.init();
    expect(l.isInitialized()).toBe(true);
    expect(state.live).toBe(3);
  });

  it('a cleanup landing during start() supersedes the init: nothing published, no blocker, no listeners', async () => {
    const gate = deferred();
    const { sdk, state } = fakeSdk({ start: vi.fn(() => gate.promise) });
    const l = make(sdk);
    const pending = l.init();
    l.cleanup();
    gate.resolve();
    await pending;
    expect(l.isInitialized()).toBe(false);
    expect(state.live).toBe(0);
    expect(sdk.preload).not.toHaveBeenCalled();
    // …and the latch was released, so a later init can still run.
    await l.init();
    expect(l.isInitialized()).toBe(true);
    expect(state.live).toBe(3);
  });

  it('a cleanup landing between registrations removes the ones already made', async () => {
    const gate = deferred();
    const { sdk, state } = fakeSdk();
    const base = sdk.listeners;
    sdk.listeners = vi.fn((sink: AdEventSink) => {
      const thunks = base(sink);
      return [thunks[0], async () => { await gate.promise; return thunks[1](); }, thunks[2]];
    });
    const l = make(sdk);
    const pending = l.init();
    await flush();
    expect(state.live).toBe(1);
    l.cleanup();
    gate.resolve();
    await pending;
    expect(state.live).toBe(0);
    expect(l.isInitialized()).toBe(false);
  });

  it('a failed start releases the latch so a retry can run', async () => {
    const { sdk } = fakeSdk({ start: vi.fn().mockRejectedValueOnce(new Error('consent')).mockResolvedValue(undefined) });
    const l = make(sdk);
    await l.init();
    expect(l.isInitialized()).toBe(false);
    await l.init();
    expect(l.isInitialized()).toBe(true);
  });
});

describe('cleanup', () => {
  it('is idempotent and total: listeners gone, blocker gone, native teardown, safe to call twice', async () => {
    const { sdk, state } = fakeSdk();
    const l = make(sdk);
    await l.init();
    l.cleanup();
    l.cleanup();
    expect(state.live).toBe(0);
    expect(l.isInitialized()).toBe(false);
    expect(sdk.teardown).toHaveBeenCalled();
    expect(getActiveReloadBlockers()).not.toContain(BLOCKER);
  });

  it('unregisters its reload blocker, so a re-init holds exactly ONE entry, not one per init', async () => {
    const { sdk } = fakeSdk();
    const l = make(sdk);
    await l.init();
    l.cleanup();
    await l.init();
    await flush();
    void l.showFullscreen('rewarded', 'p');
    // The flag clears on cleanup, so a leaked entry reads blocked only once a new show sets it again.
    expect(getActiveReloadBlockers().filter((n) => n === BLOCKER)).toHaveLength(1);
  });

  it('a listener whose remove() throws does not stop the rest being removed', async () => {
    const { sdk, state } = fakeSdk();
    const base = sdk.listeners;
    sdk.listeners = vi.fn((sink: AdEventSink) => {
      const thunks = base(sink);
      return [async () => ({ remove: () => { throw new Error('boom'); } }), ...thunks];
    });
    const l = make(sdk);
    await l.init();
    expect(state.live).toBe(3);
    l.cleanup();
    expect(state.live).toBe(0);
  });
});

describe('fullscreen shows', () => {
  async function ready(l: AdLifecycle) {
    await l.init();
    await flush();
  }

  it('refuses a kind that has not loaded, without calling the SDK', async () => {
    const gate = deferred();
    const { sdk } = fakeSdk({ preload: vi.fn(() => gate.promise) });
    const l = make(sdk);
    await l.init();
    expect(l.isReady('rewarded')).toBe(false);
    expect(await l.showFullscreen('rewarded', 'p')).toBe(false);
    expect(sdk.present).not.toHaveBeenCalled();
  });

  it('resolves on the PRESENTED event even though the SDK show call never settles (AdMob rewarded on iOS)', async () => {
    const { sdk, sink } = fakeSdk();
    const shown = vi.fn();
    const l = make(sdk, { shown });
    await ready(l);
    const result = l.showFullscreen('rewarded', 'shortfall');
    sink().presented('rewarded');
    expect(await result).toBe(true);
    expect(shown).toHaveBeenCalledWith('rewarded', 'shortfall');
  });

  it('pays only from the reward EVENT — a presented-and-dismissed video with no reward pays nothing', async () => {
    const { sdk, sink } = fakeSdk();
    const pay = vi.fn();
    const l = make(sdk);
    l.onRewardEarned(pay);
    await ready(l);
    const result = l.showFullscreen('rewarded', 'p');
    sink().presented('rewarded');
    await result;
    sink().dismissed('rewarded');
    expect(pay).not.toHaveBeenCalled();
    sink().rewardEarned({ kind: 'rewarded', type: 'coins', amount: 1 });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('holds the reload blocker from BEFORE the SDK call until dismissal (Court #587)', async () => {
    const { sdk, sink } = fakeSdk();
    sdk.present = vi.fn(() => {
      // Sampled while the call is in flight — the moment useResumeReload reads it.
      expect(getActiveReloadBlockers()).toContain(BLOCKER);
      return new Promise<unknown>(() => {});
    });
    const l = make(sdk);
    await ready(l);
    const result = l.showFullscreen('interstitial', 'p');
    expect(sdk.present).toHaveBeenCalled();
    sink().presented('interstitial');
    await result;
    expect(getActiveReloadBlockers()).toContain(BLOCKER);
    sink().dismissed('interstitial');
    expect(getActiveReloadBlockers()).not.toContain(BLOCKER);
  });

  it('reports a fullscreen ad as showing from the show until its dismissal — the reward lands in between (#1379)', async () => {
    const { sdk, sink } = fakeSdk();
    sdk.present = vi.fn(() => new Promise<unknown>(() => {}));
    const l = make(sdk);
    await ready(l);
    expect(l.isFullscreenShowing()).toBe(false);
    const result = l.showFullscreen('rewarded', 'p');
    sink().presented('rewarded');
    await result;
    sink().rewardEarned({ kind: 'rewarded', type: 'coins', amount: 1 });
    expect(l.isFullscreenShowing(), 'AdMob pays while the video is still up').toBe(true);
    sink().dismissed('rewarded');
    expect(l.isFullscreenShowing()).toBe(false);
  });

  it.each([
    ['the SDK rejects', (_s: AdEventSink) => {}, true],
    ['failedToPresent arrives', (s: AdEventSink) => s.failedToPresent('interstitial'), false],
    ['nothing arrives before the timeout', (_s: AdEventSink) => { vi.advanceTimersByTime(1000); }, false],
  ])('a show where %s resolves false and releases the blocker', async (_label, act, rejects) => {
    const { sdk, sink } = fakeSdk();
    if (rejects) sdk.present = vi.fn(() => Promise.reject(new Error('Ad wasn\'t ready')));
    const l = make(sdk);
    await ready(l);
    const result = l.showFullscreen('interstitial', 'p');
    act(sink());
    expect(await result).toBe(false);
    expect(getActiveReloadBlockers()).not.toContain(BLOCKER);
  });

  it('one fullscreen ad at a time: a second show is refused and leaves the live ad\'s blocker alone', async () => {
    const { sdk, sink } = fakeSdk();
    const l = make(sdk);
    await ready(l);
    const first = l.showFullscreen('rewarded', 'p');
    expect(await l.showFullscreen('interstitial', 'q')).toBe(false);
    sink().presented('rewarded');
    await first;
    expect(await l.showFullscreen('interstitial', 'q')).toBe(false);
    expect(sdk.present).toHaveBeenCalledTimes(1);
    expect(getActiveReloadBlockers()).toContain(BLOCKER);
  });

  it('a cleanup while a show is pending resolves it false and drops the blocker', async () => {
    const { sdk } = fakeSdk();
    const l = make(sdk);
    await ready(l);
    const result = l.showFullscreen('rewarded', 'p');
    l.cleanup();
    expect(await result).toBe(false);
    expect(getActiveReloadBlockers()).not.toContain(BLOCKER);
  });

  it('consumes the loaded ad, and loads the next on DISMISSAL — not on presentation (AdMob drops the unit id on dismiss)', async () => {
    const { sdk, sink } = fakeSdk();
    const l = make(sdk);
    await ready(l);
    expect(sdk.preload).toHaveBeenCalledTimes(2);   // one per kind
    const result = l.showFullscreen('rewarded', 'p');
    expect(l.isReady('rewarded')).toBe(false);
    sink().presented('rewarded');
    await result;
    await flush();
    expect(sdk.preload).toHaveBeenCalledTimes(2);
    sink().dismissed('rewarded');
    await flush();
    expect(sdk.preload).toHaveBeenCalledTimes(3);
    expect(l.isReady('rewarded')).toBe(true);
  });

  it('a load that resolves after a cleanup does not mark the NEXT session ready', async () => {
    const loads: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const { sdk } = fakeSdk({ preload: vi.fn(() => { const d = deferred<void>(); loads.push({ promise: d.promise, resolve: () => d.resolve() }); return d.promise; }) });
    sdk.has = vi.fn((k: FullscreenKind | 'banner') => k === 'rewarded');
    const l = make(sdk);
    await l.init();
    l.cleanup();
    await l.init();
    expect(loads).toHaveLength(2);
    loads[0].resolve();   // the torn-down session's load
    await flush();
    expect(l.isReady('rewarded')).toBe(false);
    loads[1].resolve();
    await flush();
    expect(l.isReady('rewarded')).toBe(true);
  });

  it('a failed load is retried after the back-off, not at once', async () => {
    const { sdk } = fakeSdk();
    sdk.preload = vi.fn()
      .mockRejectedValueOnce(new Error('no fill'))
      .mockResolvedValue(undefined);
    sdk.has = vi.fn((k: FullscreenKind | 'banner') => k === 'interstitial');
    const l = make(sdk);
    await ready(l);
    expect(l.isReady('interstitial')).toBe(false);
    expect(sdk.preload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4999);
    expect(sdk.preload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(sdk.preload).toHaveBeenCalledTimes(2);
    expect(l.isReady('interstitial')).toBe(true);
  });
});

describe('the reward slot across a realm-survived recovery (Court #631)', () => {
  it('restoreAfterRealmSurvived puts the handler back; a plain init after cleanup does not', async () => {
    const { sdk, sink } = fakeSdk();
    const pay = vi.fn();
    const l = make(sdk);
    l.onRewardEarned(pay);
    await l.init();
    l.cleanup();
    await l.init();
    sink().rewardEarned({ kind: 'rewarded', type: 'c', amount: 1 });
    expect(pay).not.toHaveBeenCalled();
    l.cleanup();
    await l.restoreAfterRealmSurvived();
    sink().rewardEarned({ kind: 'rewarded', type: 'c', amount: 1 });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('a reward the SDK RETAINED is paid when it is handed over during listener registration — restore only (#1496)', async () => {
    // The MAX plugin retains `adRewardEarned` until a listener subscribes and hands it to the first one, so
    // a reward earned while cleanup() had removed the listeners arrives INSIDE init()'s registration loop.
    const retained: Array<{ kind: 'rewarded'; type: string; amount: number }> = [];
    const base = fakeSdk();
    const sdk = {
      ...base.sdk,
      listeners: vi.fn((s: AdEventSink) => base.sdk.listeners(s).map((register, i) => async () => {
        const handle = await register();
        if (i === 0) for (const r of retained.splice(0)) s.rewardEarned(r);
        return handle;
      })),
    };
    const pay = vi.fn();
    const l = make(sdk);
    l.onRewardEarned(pay);
    await l.init();
    l.cleanup();
    retained.push({ kind: 'rewarded', type: 'c', amount: 1 });
    await l.init();   // a plain init (a boot, a game swap) never inherits a payout
    expect(pay).not.toHaveBeenCalled();
    l.cleanup();
    retained.push({ kind: 'rewarded', type: 'c', amount: 1 });
    await l.restoreAfterRealmSurvived();
    expect(pay).toHaveBeenCalledTimes(1);
  });
});

describe('the banner is a desired state', () => {
  it('waits for init, applies once, ignores repeats, and applies a change', async () => {
    const { sdk } = fakeSdk();
    const l = make(sdk);
    l.setBannerVisible(true);
    expect(sdk.showBanner).not.toHaveBeenCalled();
    await l.init();
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(1);
    l.setBannerVisible(false);
    await flush();
    expect(sdk.hideBanner).toHaveBeenCalledTimes(1);
  });

  it('a change made while a call is in flight is applied when it settles', async () => {
    const gate = deferred();
    const { sdk } = fakeSdk({ showBanner: vi.fn(() => gate.promise) });
    const l = make(sdk);
    l.setBannerVisible(true);
    await l.init();
    l.setBannerVisible(false);
    expect(sdk.hideBanner).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(sdk.hideBanner).toHaveBeenCalledTimes(1);
  });

  it('a failed show is retried after the back-off, not every frame', async () => {
    let t = 0;
    const { sdk } = fakeSdk({ showBanner: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined) });
    const l = make(sdk, {}, () => t);
    await l.init();
    l.setBannerVisible(true);
    await flush();
    for (let i = 0; i < 5; i++) { l.setBannerVisible(true); await flush(); }
    expect(sdk.showBanner).toHaveBeenCalledTimes(1);
    t = 5000;
    l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(2);
  });

  it('after a cleanup the next init re-applies the banner the game still wants', async () => {
    const { sdk } = fakeSdk();
    const l = make(sdk);
    await l.init();
    l.setBannerVisible(true);
    await flush();
    l.cleanup();
    await l.init();
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(2);
  });
});

describe('review findings (#1309 close-out)', () => {
  it('a failed init retries on a doubling back-off, and a cleanup cancels the retry', async () => {
    const { sdk } = fakeSdk({
      start: vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(undefined),
    });
    const l = make(sdk);
    await l.init();
    expect(sdk.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);        // first wait: retryMs
    expect(sdk.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);        // second wait doubled: 10000
    expect(sdk.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.start).toHaveBeenCalledTimes(3);
    expect(l.isInitialized()).toBe(true);

    const { sdk: sdk2 } = fakeSdk({ start: vi.fn().mockRejectedValue(new Error('offline')) });
    const l2 = createAdLifecycle(sdk2, {}, { blockerId: 'test.other', tag: 't', retryMs: 5000 });
    await l2.init();
    l2.cleanup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sdk2.start).toHaveBeenCalledTimes(1);
  });

  it('a banner load FAILURE (the plugin removes the view, rejects nothing) re-shows after the back-off', async () => {
    let t = 0;
    const { sdk, sink } = fakeSdk();
    const l = make(sdk, {}, () => t);
    await l.init();
    l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(1);
    sink().bannerFailed();
    l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner, 'not before the back-off').toHaveBeenCalledTimes(1);
    t = 5000;
    l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(2);
  });

  it('bannerFailures counts every way a banner fails to come up, and nothing else (#1477)', async () => {
    // A caller compares against its own baseline, so the count must move on a real failure and ONLY there:
    // a stray increment donates a strip the banner was about to fill.
    let t = 0;
    const { sdk, sink } = fakeSdk({ showBanner: vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(undefined) });
    const l = make(sdk, {}, () => t);
    await l.init();
    expect(l.bannerFailures()).toBe(0);
    l.setBannerVisible(true);
    await flush();
    expect(l.bannerFailures(), 'a refused show').toBe(1);
    t = 5000;
    l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(2);
    expect(l.bannerFailures(), 'a show that resolves is not a failure').toBe(1);
    sink().bannerLoaded();
    expect(l.bannerFailures(), 'nor a load').toBe(1);
    // Before the load failure below: that marks the banner down, and a hide of a banner already down is never called.
    (sdk.hideBanner as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('gone'));
    l.setBannerVisible(false);
    await flush();
    expect(sdk.hideBanner, 'setup: the hide really ran, and failed').toHaveBeenCalled();
    expect(l.bannerFailures(), 'a failed HIDE is not a banner failing to come up').toBe(1);
    sink().bannerFailed();
    expect(l.bannerFailures(), 'a load failure — a no-fill, or a refresh').toBe(2);
  });

  it('an init that fails counts as a banner failure: no banner can come up until one succeeds (#1477)', async () => {
    const { sdk } = fakeSdk({ start: vi.fn().mockRejectedValue(new Error('consent does not allow ad requests')) });
    const l = make(sdk);
    await l.init();
    expect(l.bannerFailures()).toBe(1);
  });

  it('a banner that finishes loading after the game hid it is removed again (iOS adds the view late)', async () => {
    const { sdk, sink } = fakeSdk();
    const l = make(sdk);
    l.setBannerVisible(true);
    await l.init();
    await flush();
    l.setBannerVisible(false);
    await flush();
    expect(sdk.hideBanner).toHaveBeenCalledTimes(1);
    sink().bannerLoaded();
    expect(sdk.hideBanner).toHaveBeenCalledTimes(2);
    l.setBannerVisible(true);
    await flush();
    sink().bannerLoaded();
    expect(sdk.hideBanner, 'a wanted banner loading is left alone').toHaveBeenCalledTimes(2);
  });

  it('a banner call that never settles stops blocking changes after the timeout', async () => {
    let t = 0;
    const { sdk } = fakeSdk({ showBanner: vi.fn().mockImplementationOnce(() => new Promise<void>(() => {})).mockResolvedValue(undefined) });
    const l = make(sdk, {}, () => t);
    l.setBannerVisible(true);
    await l.init();
    l.setBannerVisible(false);
    await flush();
    expect(sdk.hideBanner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sdk.hideBanner, 'the timed-out show is removed defensively').toHaveBeenCalledTimes(1);
    // …and the busy flag is free again: after the back-off a new show goes out.
    t = 1000 + 5000;
    l.setBannerVisible(true);
    await flush();
    expect(sdk.showBanner).toHaveBeenCalledTimes(2);
  });

  it('a restore whose init FAILS still pays once the back-off retry succeeds', async () => {
    const { sdk, sink } = fakeSdk({ start: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined) });
    const pay = vi.fn();
    const l = make(sdk);
    l.onRewardEarned(pay);
    await l.init();
    l.cleanup();
    await l.restoreAfterRealmSurvived();
    expect(l.isInitialized()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(l.isInitialized()).toBe(true);
    sink().rewardEarned({ kind: 'rewarded', type: 'c', amount: 1 });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('a cleanup after a failed restore cancels its claim — the next plain init does not inherit the payout', async () => {
    const { sdk, sink } = fakeSdk({ start: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined) });
    const pay = vi.fn();
    const l = make(sdk);
    l.onRewardEarned(pay);
    await l.init();
    l.cleanup();
    await l.restoreAfterRealmSurvived();   // fails; its claim is pending
    l.cleanup();                           // e.g. a game swap
    await l.init();
    expect(l.isInitialized()).toBe(true);
    sink().rewardEarned({ kind: 'rewarded', type: 'c', amount: 1 });
    expect(pay).not.toHaveBeenCalled();
  });

  it('a plain init retry after a plain failed init does NOT inherit the payout', async () => {
    const { sdk, sink } = fakeSdk({ start: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined) });
    const pay = vi.fn();
    const l = make(sdk);
    l.onRewardEarned(pay);
    await l.init();
    l.cleanup();
    await l.init();
    await vi.advanceTimersByTimeAsync(5000);
    expect(l.isInitialized()).toBe(true);
    sink().rewardEarned({ kind: 'rewarded', type: 'c', amount: 1 });
    expect(pay).not.toHaveBeenCalled();
  });

  it('a new lifetime removes the banner once even when the game wants none (an old load may still land)', async () => {
    const { sdk } = fakeSdk();
    const l = make(sdk);
    l.setBannerVisible(false);
    await l.init();
    await flush();
    expect(sdk.hideBanner).toHaveBeenCalledTimes(1);
    l.setBannerVisible(false);
    await flush();
    expect(sdk.hideBanner, 'once removed, a hidden banner is not re-removed every frame').toHaveBeenCalledTimes(1);
    l.cleanup();
    l.setBannerVisible(true);
    await l.init();
    await flush();
    expect(sdk.hideBanner, 'a lifetime that WANTS a banner does not remove first').toHaveBeenCalledTimes(1);
  });

  it('an ad presenting AFTER its show timed out consumes the loaded ad, and the reload waits', async () => {
    const { sdk, sink } = fakeSdk();
    sdk.has = vi.fn((k: FullscreenKind | 'banner') => k === 'rewarded');
    const l = make(sdk);
    await l.init();
    await flush();
    const result = l.showFullscreen('rewarded', 'p');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(false);
    expect(sdk.preload, 'no reload while the timed-out ad may still present').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);   // the deferred reload runs and lands
    expect(sdk.preload).toHaveBeenCalledTimes(2);
    expect(l.isReady('rewarded')).toBe(true);
    // …then the timed-out ad presents after all: AdMob deletes the replacement on its dismissal.
    sink().presented('rewarded');
    expect(l.isReady('rewarded'), 'the replacement is not trusted any more').toBe(false);
    sink().dismissed('rewarded');
    await flush();
    expect(sdk.preload).toHaveBeenCalledTimes(3);
  });

  it('a banner call from before a cleanup cannot free the NEXT lifetime\'s in-flight call', async () => {
    const gates: Array<() => void> = [];
    const { sdk } = fakeSdk({
      showBanner: vi.fn(() => new Promise<void>((resolve) => { gates.push(resolve); })),
      hideBanner: vi.fn(() => new Promise<void>((resolve) => { gates.push(resolve); })),
    });
    const l = make(sdk);
    l.setBannerVisible(true);
    await l.init();                        // call A, in flight
    l.cleanup();
    await l.init();
    await flush();                         // call B (the re-applied show), in flight
    expect(sdk.showBanner).toHaveBeenCalledTimes(2);
    gates[0]();                            // A settles late
    await flush();
    l.setBannerVisible(true);              // the per-frame call, while B is still in flight
    await flush();
    expect(sdk.showBanner, 'B still owns the banner; no concurrent native call').toHaveBeenCalledTimes(2);
  });

  it('a loaded ad past its age is discarded and reloaded, not shown', async () => {
    let t = 0;
    const { sdk } = fakeSdk();
    sdk.has = vi.fn((k: FullscreenKind | 'banner') => k === 'interstitial');
    const l = createAdLifecycle(sdk, {}, { blockerId: BLOCKER, tag: 't', now: () => t, maxAdAgeMs: 1000, presentTimeoutMs: 1000, retryMs: 5000 });
    life = l;
    await l.init();
    await flush();
    t = 999;
    expect(l.isReady('interstitial')).toBe(true);
    t = 1000;
    expect(await l.showFullscreen('interstitial', 'p')).toBe(false);
    expect(sdk.present).not.toHaveBeenCalled();
    expect(sdk.preload).toHaveBeenCalledTimes(2);
  });
});


describe('the fullscreen-ad edge the audio hold listens to (#1455)', () => {
  async function ready(l: AdLifecycle) {
    await l.init();
    await flush();
  }
  let unhook: (() => void) | null = null;
  afterEach(() => { unhook?.(); unhook = null; });

  it('goes UP before the SDK call (our audio is down before the ad\'s player starts) and DOWN on dismissal, once each', async () => {
    const edges: boolean[] = [];
    unhook = onFullscreenAdChange((showing) => edges.push(showing));
    const { sdk, sink } = fakeSdk();
    sdk.present = vi.fn(() => {
      expect(edges, 'already announced while the native call is in flight').toEqual([true]);
      return new Promise<unknown>(() => {});
    });
    const l = make(sdk);
    await ready(l);
    const result = l.showFullscreen('interstitial', 'p');
    expect(sdk.present).toHaveBeenCalled();
    sink().presented('interstitial');   // already up: no second edge
    await result;
    sink().dismissed('interstitial');
    expect(edges).toEqual([true, false]);
  });

  it('comes down on a failure to present, and on a cleanup with an ad up — never left held', async () => {
    const edges: boolean[] = [];
    unhook = onFullscreenAdChange((showing) => edges.push(showing));
    const { sdk, sink } = fakeSdk();
    const l = make(sdk);
    await ready(l);
    const first = l.showFullscreen('interstitial', 'p');
    sink().failedToPresent('interstitial');
    expect(await first).toBe(false);
    expect(edges).toEqual([true, false]);
    await flush();
    const second = l.showFullscreen('rewarded', 'p');
    sink().presented('rewarded');
    await second;
    l.cleanup();
    expect(edges).toEqual([true, false, true, false]);
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const fn = vi.fn();
    const off = onFullscreenAdChange(fn);
    off();
    const { sdk, sink } = fakeSdk();
    const l = make(sdk);
    await ready(l);
    void l.showFullscreen('interstitial', 'p');
    sink().dismissed('interstitial');
    expect(fn).not.toHaveBeenCalled();
  });
});
