/**
 * The ad LIFECYCLE — every concurrency and teardown rule an ad service needs, with no ad SDK and no game
 * in it. Written for Weaveling (#1309), promoted here when Court became the second consumer (#1312).
 *
 * ⚠️ **Imports nothing SDK-specific and nothing game-specific, and must stay that way.** The SDK arrives
 * as an `AdSdk` adapter (each game's `packages/app-services/src/ads.ts` is its AdMob one — the plugin is a
 * per-game dependency, so the adapter cannot live here), and everything a game decides — placements, the
 * analytics taxonomy, pacing numbers — arrives through `AdLifecycleHooks` or stays in the caller. When to
 * show an interstitial is `./adPacing.ts`.
 *
 * Each rule below was paid for in Court's `ads.ts` (AppLovin MAX), and none of them is AppLovin's:
 * - **The init latch** (`starting` + a teardown token), taken BEFORE the first await — Court #458, ported
 *   from AppsFlyer's measured iPhone-8 double-init.
 * - **Listener handles are published only after EVERY registration succeeded**, with an idempotent
 *   unwind on the supersede and failure paths — a half-registered init once left a duplicate revenue
 *   listener that counted every impression twice.
 * - **The fullscreen reload blocker, owned by generation** (Court #587/#611). A fullscreen ad runs
 *   outside the Capacitor bridge activity on Android and reads as a backgrounding on both platforms, so
 *   `useResumeReload` would reload the webview out from under the video.
 * - **Idempotent `cleanup()`** — the engine calls it from BOTH a game swap and realm shutdown.
 * - **The reward is paid from the SDK's reward EVENT, never from a show call resolving.**
 *
 * What is NEW here rather than ported:
 * - **Presentation is judged by EVENTS, not by the show call's promise.** AdMob's
 *   `showRewardVideoAd()` resolves only when a reward is EARNED (iOS `AdRewardExecutor.swift`), so a
 *   player who quits the video leaves it pending forever; awaiting it would hang the caller. The
 *   adapter's `present()` only has to REJECT when it cannot show; `presented`/`failedToPresent`/
 *   `dismissed` decide the rest, with a timeout for an SDK that says nothing.
 * - **Readiness is tracked here** (AdMob has no `isReady` call): a preload resolving marks a kind
 *   ready, a show consumes it, and the NEXT preload starts on dismissal — never on presentation,
 *   because AdMob's iOS executor removes `preparedAds[adUnitId]` when the showing ad dismisses, which
 *   would delete a replacement loaded under the same unit id while the first one was on screen.
 * - **The banner is a desired STATE, not a command.** The game calls `setBannerVisible` every frame;
 *   this applies the difference once initialised, one native call at a time, with a back-off after a
 *   failure. That replaces Court's `bannerWasShowing` latch: after a cleanup the next frame simply
 *   re-applies what the game wants, so a realm-survived restore needs no banner memory at all.
 */

import { registerReloadBlocker } from './resumeReload';
import { createSupersessionToken, createTeardownToken } from './liveness';
import { withTimeout } from './abandonment';
import { rawEpochNow } from './clock';

export type FullscreenKind = 'interstitial' | 'rewarded';

/** A registered native listener. */
export interface AdListenerHandle {
  remove(): unknown;
}

/** An impression's paid value, in the SDK's own terms. */
export interface AdRevenue {
  kind: FullscreenKind | 'banner';
  adUnitId: string;
  /** Major currency units (not micros). */
  value: number;
  currency: string;
  precision: string;
  network: string;
}

export interface AdReward {
  kind: FullscreenKind;
  type: string;
  amount: number;
}

/** What an adapter reports from its native listeners. */
export interface AdEventSink {
  presented(kind: FullscreenKind): void;
  failedToPresent(kind: FullscreenKind): void;
  dismissed(kind: FullscreenKind): void;
  rewardEarned(reward: AdReward): void;
  revenue(revenue: AdRevenue): void;
  /** The banner's ad arrived, AFTER `showBanner` resolved. iOS adds the view only now (Android added it
   *  before the load), so a remove issued in between removed nothing there. */
  bannerLoaded(): void;
  /** The banner's load failed — including a refresh. Both native SDKs REMOVE the view on this, without
   *  rejecting anything, so the lifecycle must stop believing a banner is up. */
  bannerFailed(): void;
}

/** The SDK, as the lifecycle sees it. */
export interface AdSdk {
  /** The CRASH GUARD — false whenever a native call could reach the SDK with nothing valid to load
   *  (not native, no ids). Every native call is behind it. */
  enabled(): boolean;
  /** Is `kind` configured at all (a non-blank unit id)? A kind that is not is never loaded or shown. */
  has(kind: FullscreenKind | 'banner'): boolean;
  /** Consent + SDK initialisation. Resolves once ads may be requested; rejects on failure. */
  start(): Promise<void>;
  /** One thunk per native listener, each registering it and resolving its handle. */
  listeners(sink: AdEventSink): Array<() => Promise<AdListenerHandle>>;
  /** Load one ad of `kind`. Resolves when it is ready, rejects when it could not load. */
  preload(kind: FullscreenKind): Promise<void>;
  /** Put a loaded ad on screen. May resolve at any point (or never); must REJECT when it cannot show. */
  present(kind: FullscreenKind): Promise<unknown>;
  showBanner(): Promise<void>;
  hideBanner(): Promise<void>;
  /** Destroy native ad views/instances. Fire-and-forget; must not throw. */
  teardown(): void;
}

export interface AdLifecycleHooks {
  /** A fullscreen ad reached the screen, for the `placement` the game asked for. */
  shown?(kind: FullscreenKind, placement: string): void;
  /** Every earned reward, whether or not a handler is registered. */
  rewardEarned?(reward: AdReward): void;
  revenue?(revenue: AdRevenue): void;
}

export interface AdLifecycleOptions {
  /** Reload-blocker id (`registerReloadBlocker`), e.g. `'wordweave.fullscreenAd'`. */
  blockerId: string;
  /** Console prefix. */
  tag: string;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** How long a show waits for `presented`/`failedToPresent` before calling it not shown. */
  presentTimeoutMs?: number;
  /** Wait before re-trying a failed preload, and before re-trying a failed banner call. Also the first
   *  wait before re-trying a failed init, which then doubles up to `maxInitRetryMs`. */
  retryMs?: number;
  /** Ceiling of the init retry back-off. Default 10 min. */
  maxInitRetryMs?: number;
  /** A loaded fullscreen ad older than this is discarded and reloaded. AdMob's expire after an hour, and
   *  an expired one fails to show or does not count. Default 55 min. */
  maxAdAgeMs?: number;
}

export type RewardHandler = (reward: AdReward) => void;

export interface AdLifecycle {
  init(): Promise<void>;
  cleanup(): void;
  restoreAfterRealmSurvived(): Promise<void>;
  /** Called every frame with what the game wants; cheap when nothing changes. */
  setBannerVisible(visible: boolean): void;
  /** Resolves whether the ad was PRESENTED — never whether it was rewarded. */
  showFullscreen(kind: FullscreenKind, placement: string): Promise<boolean>;
  isReady(kind: FullscreenKind): boolean;
  /** The single payout slot. A second registration REPLACES the first; two would pay twice. */
  onRewardEarned(handler: RewardHandler | null): void;
  isInitialized(): boolean;
}

interface PendingShow {
  kind: FullscreenKind;
  /** This show's own ownership check — also its identity, for the timeout and the SDK's rejection. */
  owns: () => boolean;
  settle: (shown: boolean) => void;
}

export function createAdLifecycle(sdk: AdSdk, hooks: AdLifecycleHooks, opts: AdLifecycleOptions): AdLifecycle {
  // Wall-clock, not the sim clock: an ad's age and a retry back-off are real time that keeps passing while
  // the app is backgrounded. `rawEpochNow` is the sanctioned wrapper (the determinism guard).
  const now = opts.now ?? rawEpochNow;
  const presentTimeoutMs = opts.presentTimeoutMs ?? 10_000;
  const retryMs = opts.retryMs ?? 30_000;
  const maxInitRetryMs = opts.maxInitRetryMs ?? 600_000;
  const maxAdAgeMs = opts.maxAdAgeMs ?? 55 * 60_000;
  /** The next init retry's wait; reset by a successful init. */
  let initRetryMs = retryMs;

  let initialized = false;
  // Latched BEFORE the first await; see the file banner. Released on failure (unless superseded) and by
  // `cleanup()`, so an unmount/remount cycle can init again.
  let starting = false;
  // Invalidated by every `init()` and every `cleanup()`: an init that resumes after either publishes
  // nothing, and a preload/banner call resuming after either writes nothing. The engine's shared token
  // (#573), not a hand-rolled counter.
  const lifetime = createTeardownToken();
  let listenerHandles: AdListenerHandle[] = [];

  /** The live payout slot, nulled by `cleanup()` so a torn-down realm cannot pay. */
  let rewardHandler: RewardHandler | null = null;
  /** What a realm-SURVIVED recovery puts back. Untouched by `cleanup()`, read only by the recovery. */
  let lastRewardHandler: RewardHandler | null = null;
  /** A recovery is waiting on an init that has not succeeded yet — its own, or the back-off retry that
   *  follows a failed one. Without it a retry that succeeds later offers rewarded videos with nobody to pay
   *  (review of #1309's close-out). Set by the recovery, consumed by a successful init, cleared by cleanup. */
  let restorePayoutOnInit = false;

  const ready: Record<FullscreenKind, boolean> = { interstitial: false, rewarded: false };
  const loading: Record<FullscreenKind, boolean> = { interstitial: false, rewarded: false };
  const loadedAt: Record<FullscreenKind, number> = { interstitial: 0, rewarded: 0 };
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();

  // The reload blocker's state. `fullscreenShowing` has several writers, so each show takes ownership
  // (`begin()`) and writes only while it still owns it; every authoritative "no ad is up" signal begins a
  // new generation, which disowns the show in flight.
  // ⚠️ DEFENSIVE, and deliberately untested beyond the clear itself: a show's only post-await write is a
  // CLEAR, shows are serialised (`pending`), and `settle` cancels the timeout — so neither the disowning
  // `begin()` on dismissal nor the timeout's identity check has an observable consumer today (both
  // mutated away with the suite green, 2026-09-17). Court's `fullscreenAdGen` carries the same note. They
  // stay because one added post-await write would make them load-bearing silently.
  let fullscreenShowing = false;
  const showOwnership = createSupersessionToken();
  let pending: PendingShow | null = null;
  let unregisterBlocker: (() => void) | null = null;

  let bannerWanted = false;
  let bannerShown = false;
  let bannerBusy = false;
  let bannerRetryAt = 0;

  function settlePending(shown: boolean): void {
    const p = pending;
    if (!p) return;
    pending = null;
    p.settle(shown);
  }

  /** A timer `cleanup()` cancels. */
  function schedule(fn: () => void, delayMs: number = retryMs): void {
    const t = setTimeout(() => {
      retryTimers.delete(t);
      fn();
    }, delayMs);
    retryTimers.add(t);
  }

  /** Is the loaded ad of `kind` still usable? A stale one is dropped and a fresh one requested. */
  function freshReady(kind: FullscreenKind): boolean {
    if (!ready[kind]) return false;
    if (now() - loadedAt[kind] < maxAdAgeMs) return true;
    ready[kind] = false;
    preload(kind);
    return false;
  }

  function preload(kind: FullscreenKind): void {
    if (!initialized || !sdk.enabled() || !sdk.has(kind) || ready[kind] || loading[kind]) return;
    loading[kind] = true;
    const live = lifetime.capture();
    sdk.preload(kind).then(
      () => {
        if (!live()) return;
        loading[kind] = false;
        ready[kind] = true;
        loadedAt[kind] = now();
      },
      (e: unknown) => {
        if (!live()) return;
        loading[kind] = false;
        console.warn(`[${opts.tag}] ${kind} failed to load:`, e);
        schedule(() => { if (live()) preload(kind); });
      },
    );
  }

  const sink: AdEventSink = {
    presented(kind) {
      // Authoritative: an ad IS up, whoever's show it was.
      fullscreenShowing = true;
      if (pending?.kind === kind) settlePending(true);
      // Whatever was loaded for this kind is what went up — even for a show that already timed out.
      else ready[kind] = false;
    },
    failedToPresent(kind) {
      showOwnership.begin();
      fullscreenShowing = false;
      if (pending?.kind === kind) settlePending(false);
      preload(kind);
    },
    dismissed(kind) {
      showOwnership.begin();
      fullscreenShowing = false;
      // A dismissal with the show still pending means `presented` never arrived, yet the ad was up.
      if (pending?.kind === kind) settlePending(true);
      preload(kind);
    },
    rewardEarned(reward) {
      hooks.rewardEarned?.(reward);
      rewardHandler?.(reward);
    },
    revenue(revenue) {
      hooks.revenue?.(revenue);
    },
    bannerLoaded() {
      // A hide that landed while the ad was still loading removed nothing (iOS adds the view only now),
      // so the banner appears after the game asked for it gone. Remove it again.
      if (!initialized || bannerWanted) return;
      sdk.hideBanner().catch((e: unknown) => console.warn(`[${opts.tag}] late hideBanner failed:`, e));
    },
    bannerFailed() {
      if (!initialized) return;
      bannerShown = false;
      bannerRetryAt = now() + retryMs;
      const live = lifetime.capture();
      schedule(() => { if (live()) void applyBanner(); });
    },
  };

  /** A native banner call that never settles must not hold `bannerBusy` for the session: past the timeout it
   *  counts as a failure. Two real paths: iOS with no root view controller, and Android `showBanner` while
   *  `mAdView` is still set — reachable when `removeBanner` resolved before its UI-thread task nulled it,
   *  then a quick re-show — which calls `updateExistingAdView` and never resolves the call. */
  function bounded(call: Promise<void>): Promise<void> {
    // A late result owns nothing here: a show that lands after all is caught by `bannerLoaded`/the
    // defensive hide, and a late hide only confirms what was asked.
    return withTimeout(call, presentTimeoutMs, 'native banner call', {
      discard: 'a late banner result is reconciled by bannerLoaded / the defensive hide, not by this call',
    });
  }

  async function applyBanner(): Promise<void> {
    if (bannerBusy || !initialized || !sdk.enabled() || !sdk.has('banner')) return;
    if (bannerWanted === bannerShown || now() < bannerRetryAt) return;
    bannerBusy = true;
    const target = bannerWanted;
    const live = lifetime.capture();
    try {
      await bounded(target ? sdk.showBanner() : sdk.hideBanner());
      if (live()) bannerShown = target;
    } catch (e) {
      console.warn(`[${opts.tag}] ${target ? 'showBanner' : 'hideBanner'} failed:`, e);
      if (live()) {
        bannerRetryAt = now() + retryMs;
        // A failed or timed-out SHOW may still put a view up later, and the game may have asked for none
        // meanwhile — `bannerShown` is still false, so the diff below would do nothing. Remove defensively.
        if (target && !bannerWanted) {
          sdk.hideBanner().catch((err: unknown) => console.warn(`[${opts.tag}] defensive hideBanner failed:`, err));
        }
      }
    } finally {
      // Only this lifetime's flag: `cleanup()` already cleared it, and a newer call may hold it now.
      if (live()) bannerBusy = false;
    }
    // The game may have changed its mind while the call was in flight.
    if (live() && bannerWanted !== bannerShown) void applyBanner();
  }

  async function init(): Promise<void> {
    if (initialized || starting) return;
    if (!sdk.enabled()) {
      console.log(`[${opts.tag}] Disabled — not native, or no ad ids configured`);
      return;
    }
    starting = true;
    lifetime.invalidateAll();
    const live = lifetime.capture();
    // Declared OUTSIDE the try so the catch can unwind it; `splice(0)` keeps both unwinds idempotent.
    const handles: AdListenerHandle[] = [];
    try {
      await sdk.start();
      // Sequential and STOPS on the first failure — the `registration` kind in `notifyIsShared.test.ts`'s
      // EXEMPT: isolating each call would publish a half-registered set that reports success.
      for (const register of sdk.listeners(sink)) {
        if (!live()) break;
        handles.push(await register());
      }
      // Supersede check: a `cleanup()` that landed during the awaits has already reset everything and
      // considers every handle removed, so publishing now would leak listeners it believes are gone.
      if (!live()) {
        for (const h of handles.splice(0)) h.remove();
        return;
      }
      listenerHandles = handles;
      initialized = true;
      initRetryMs = retryMs;
      if (restorePayoutOnInit) {
        restorePayoutOnInit = false;
        if (lastRewardHandler) rewardHandler = lastRewardHandler;
      }
      fullscreenShowing = false;
      unregisterBlocker = registerReloadBlocker(opts.blockerId, () => fullscreenShowing);
      preload('interstitial');
      preload('rewarded');
      // A previous lifetime's banner may still be loading natively and land after its listeners were
      // dropped (iOS adds the view late), so a lifetime that wants NO banner removes once regardless —
      // the diff below would skip it as "already hidden". `removeBanner` resolves with nothing to remove.
      if (!bannerWanted && sdk.has('banner')) {
        sdk.hideBanner().catch((e: unknown) => console.warn(`[${opts.tag}] initial hideBanner failed:`, e));
      }
      void applyBanner();
    } catch (e) {
      for (const h of handles.splice(0)) h.remove();
      console.warn(`[${opts.tag}] Init failed:`, e);
      // Only this run's own latch: clearing a newer run's would let two inits race again.
      if (live()) {
        starting = false;
        // Nothing else calls `init()` again before the next cold start (the engine calls it at boot and on
        // a realm-survived recovery), so a transient failure — offline at launch — would mean no ads for
        // the session. Back off, doubling, and let `cleanup()` cancel it.
        const wait = initRetryMs;
        initRetryMs = Math.min(initRetryMs * 2, maxInitRetryMs);
        schedule(() => { if (live()) void init(); }, wait);
      }
    }
  }

  function cleanup(): void {
    for (const h of listenerHandles.splice(0)) {
      try { h.remove(); } catch (e) { console.warn(`[${opts.tag}] listener remove failed:`, e); }
    }
    rewardHandler = null;
    initialized = false;
    starting = false;
    lifetime.invalidateAll();
    unregisterBlocker?.();
    unregisterBlocker = null;
    showOwnership.begin();
    fullscreenShowing = false;
    settlePending(false);
    for (const t of retryTimers) clearTimeout(t);
    retryTimers.clear();
    ready.interstitial = ready.rewarded = false;
    initRetryMs = retryMs;
    loading.interstitial = loading.rewarded = false;
    // The native banner is destroyed below; `bannerWanted` is the game's intent and stays, so the next
    // init re-applies it. A realm that did not survive takes this whole module with it anyway.
    bannerShown = false;
    bannerBusy = false;
    bannerRetryAt = 0;
    restorePayoutOnInit = false;
    if (sdk.enabled()) {
      try { sdk.teardown(); } catch (e) { console.warn(`[${opts.tag}] teardown failed:`, e); }
    }
  }

  async function restoreAfterRealmSurvived(): Promise<void> {
    // Deliberately NOT part of a plain `init()`: a boot or a game swap must never inherit a previous boot's
    // payout. Flagged BEFORE the await, so the init this recovery starts — or the back-off retry after it
    // fails — puts the handler back whenever it finally succeeds.
    restorePayoutOnInit = true;
    await init();
    if (initialized && lastRewardHandler) {
      restorePayoutOnInit = false;
      rewardHandler = lastRewardHandler;
    }
  }

  async function showFullscreen(kind: FullscreenKind, placement: string): Promise<boolean> {
    if (!initialized || !sdk.enabled() || !sdk.has(kind) || !freshReady(kind)) return false;
    // One fullscreen ad at a time. The SDK would refuse the second anyway; refusing here means a refused
    // show never touches the blocker another, live ad owns.
    if (pending || fullscreenShowing) return false;
    ready[kind] = false;
    const owns = showOwnership.begin();
    // Set BEFORE the native call: the ad's activity is up while the call is in flight, and
    // `useResumeReload` samples the blockers at background time (Court #587).
    fullscreenShowing = true;
    let timedOut = false;
    const shown = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pending?.owns !== owns) return;
        timedOut = true;
        settlePending(false);
      }, presentTimeoutMs);
      pending = {
        kind, owns,
        settle: (value) => { clearTimeout(timer); resolve(value); },
      };
      sdk.present(kind).catch((e: unknown) => {
        console.warn(`[${opts.tag}] ${kind} show failed:`, e);
        if (pending?.owns === owns) settlePending(false);
      });
    });
    if (!shown) {
      // Clear only what this show set: a dismissal or cleanup already moved the generation on. When in
      // doubt, don't block — a flag stuck true blocks every reload for the rest of the realm.
      if (owns()) fullscreenShowing = false;
      // A refusal or a failure to present leaves nothing on screen, so reload now. A TIMEOUT may still
      // present late, and a replacement loaded under the same unit id meanwhile would be deleted on its
      // dismissal — so wait; a late `presented` + `dismissed` reloads first if it comes.
      const live = lifetime.capture();
      if (timedOut) schedule(() => { if (live()) preload(kind); });
      else preload(kind);
      return false;
    }
    hooks.shown?.(kind, placement);
    return true;
  }

  return {
    init,
    cleanup,
    restoreAfterRealmSurvived,
    setBannerVisible(visible) {
      bannerWanted = visible;
      void applyBanner();
    },
    showFullscreen,
    isReady: (kind) => initialized && sdk.enabled() && freshReady(kind),
    onRewardEarned(handler) {
      rewardHandler = handler;
      lastRewardHandler = handler;
    },
    isInitialized: () => initialized,
  };
}
