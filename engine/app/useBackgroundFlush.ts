/** useBackgroundFlush — makes pending PlayerPrefs writes durable across every backgrounding edge
 *  (native `pause`/`appStateChange`, web `visibilitychange`/`pagehide`) and, on what looks like a
 *  real page teardown, runs the registered realm-shutdown tasks (#587) behind #611's
 *  over-trigger-safe backstop.
 *
 *  Its own module (rather than a local effect in App.tsx) so the listener contract below can be
 *  pinned by a test without rendering the whole app shell (App itself is not exported and drags
 *  in routing + the lazy editor chunk). */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { createRealmDeathBackstop } from './realmDeathBackstop';
import { PlayerPrefs, runRealmShutdownTasks, notifyRealmSurvived } from '@modoki/engine/runtime';

export function useBackgroundFlush() {
  // Make pending PlayerPrefs writes durable when the app is backgrounded/hidden —
  // debounced writes would otherwise be lost to an OS kill. Native fires
  // appStateChange; web fires visibilitychange/pagehide. (atomic ≠ durable; this
  // closes the durability gap the store documents.)
  useEffect(() => {
    const flush = () => { void PlayerPrefs.flush(); };
    // The decision core for the shutdown-or-not call below, with `runRealmShutdownTasks`/
    // `notifyRealmSurvived` injected — see `realmDeathBackstop.ts` for the full #611 reasoning.
    const backstop = createRealmDeathBackstop({
      runShutdown: () => { void runRealmShutdownTasks(); },
      notifySurvived: notifyRealmSurvived,
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else backstop.onRealmVisible();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // `pagehide` fires both for a real page teardown AND for a bfcache/background transition
    // (tab-switch, home-button on mobile Safari) — `event.persisted` is meant to tell them apart:
    // true means the page may resume from the cache, false means it is actually going away.
    //
    // ⚠️ #611: `persisted === false` is only an ANDROID-measured signal, and it ships here on iOS
    // too, where `pagehide` firing on a mere backgrounding is documented real-world behaviour. A
    // false trigger there would run the shutdown tasks (native ad SDK teardown, #587) on a still-
    // live banner/interstitial the player is about to see again — a regression, not a fix. Rather
    // than guess at a narrower iOS-specific gate (which risks the OPPOSITE failure: suppressing a
    // genuine teardown), the gate stays as-is and `backstop.onRealmVisible()` below is what makes
    // an over-trigger SAFE — a later foreground re-arms the seam and lets each shutdown task's own
    // `onRealmSurvived` recovery undo whatever it needs to (see `realmShutdown.ts`).
    const onPageHide = (event: PageTransitionEvent) => {
      flush();
      backstop.onPageHide(event.persisted);
    };
    window.addEventListener('pagehide', onPageHide);
    // `pageshow` is the other "we're back" signal, alongside `visibilitychange` above. Both are
    // wired deliberately, not redundantly: `pageshow` is only guaranteed to fire for a page that
    // was actually bfcached (or on a fresh navigation), not for every foreground transition, so
    // relying on it alone would miss a plain tab-switch back; `visibilitychange` alone would miss
    // a bfcache restore on a platform that does not also flip visibility. Both call the same
    // idempotent `onRealmVisible()`, so seeing both for one real resume is harmless.
    const onPageShow = () => { backstop.onRealmVisible(); };
    window.addEventListener('pageshow', onPageShow);
    const appListeners: { remove: () => void }[] = [];
    let cancelled = false; // cleanup may run before the async addListener resolves
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) flush();
      }).then((h) => { if (cancelled) h.remove(); else appListeners.push(h); })
        // A rejected registration must not become an unhandledrejection: globalErrors.ts reports
        // those to Crashlytics, so an absent/stripped plugin would file one per launch. Same
        // treatment as capacitorStore.ts's listener (see its .catch).
        //
        // But this one is NOT swallowed silently, unlike the siblings. A rejection here means the
        // background-flush listener never registered, so pending PlayerPrefs writes stop being
        // flushed on background — save-data loss on an OS kill, which is worse than the noise the
        // catch exists to suppress. Degraded rather than dead (visibilitychange/pagehide above are
        // registered unconditionally and cover most native background transitions), so it warns
        // rather than throws.
        .catch((e: unknown) => {
          console.warn('[modoki] appStateChange listener failed to register — PlayerPrefs will not '
            + 'flush on background; relying on visibilitychange/pagehide', e);
        });

      // `appStateChange`'s BACKGROUND edge is fired from one place only —
      // `BridgeActivity.onStop():118`, itself gated on `activityDepth == 0` — and never from
      // `onPause`. (The FOREGROUND edge is a different story; see the unpaired-resume note below.) Play Billing's `ProxyBillingActivity` is TRANSLUCENT, so opening a
      // purchase sheet pauses the host Activity without ever stopping it: no background edge fires
      // while the sheet is up, even though the app is live and killable the whole time.
      // `visibilitychange`/`pagehide` don't fill the gap either — measured on a Galaxy A23 with a
      // billing sheet open, `document.visibilityState` stayed `"visible"` the entire time, with 46
      // requestAnimationFrame ticks in 1010 ms. `@capacitor/app`'s `pause` event, dispatched from
      // `Bridge.onPause()` on every Activity pause, is the edge that actually fires here.
      //
      // ⚠️ That last sentence is MEASURED, not derived (A23, 2026-09-03): with a translucent
      // Activity over the running game, `pause` fired exactly once while `appStateChange` and
      // `visibilitychange` fired not at all — against a HOME-press control on the same probe that
      // showed all three. Full table in docs/native-and-sdks.md. One asymmetry worth knowing
      // before you touch this: DISMISSING a translucent Activity fires an unpaired
      // `appStateChange(isActive:true)`, a foreground with no preceding background. That is NOT
      // specific to translucent Activities — `fireStatusChange(true)` at `BridgeActivity.onResume():97`
      // is unconditional, so a permission dialog, a system alert, and the app's own cold-launch
      // resume all produce one too (the last is merely dropped, since `notifyListeners(..., false)`
      // does not retain). So an `appStateChange` consumer must never assume a `(true)` is preceded
      // by a `(false)`.
      //
      // iOS asymmetry: there, `pause` maps to `didEnterBackgroundNotification`
      // (AppPlugin.swift:33-34), which fires LATER than the `willResignActiveNotification` that
      // already drives `appStateChange(false)` above (AppPlugin.swift:27-28) — so on iOS this
      // listener is a harmless duplicate flush, not the primary path. Additive only, on both
      // platforms: it never replaces the appStateChange listener above.
      //
      // Flushing on every pause is free WHEN NOTHING IS PENDING, which is the overwhelmingly
      // common case: PlayerPrefs.flush() cancels the debounce and calls drain(), whose callback
      // early-returns when nothing is dirty (`if (dirty.size === 0) return`, pinned by
      // engine/packages/modoki/tests/runtime/playerPrefs.test.ts:237) before touching the
      // backend. Android fires onPause far more often than onStop, and that costs nothing.
      //
      // It is NOT free while a write is failing: `flush()` also cancels any pending `retryTimer`
      // (`playerPrefs.ts`'s `flush()`), so a burst of pause edges with no intervening `set()`
      // spends the bounded retry budget (`MAX_RETRY_DRAINS`) faster than its backoff intends —
      // more attempts sooner, then silence until the next `set()`/`del()`/`clear()` or an
      // explicit `flush()` re-arms it. That is not a durability regression (more attempts, not
      // fewer) and not a reason to change this mechanism — just don't read "free" as "free in
      // every case".
      //
      // What deliberately does NOT get this edge, so a later reader doesn't "complete" the change:
      // `useResumeReload`'s `onBackground()` — arming a resume-reload on every translucent dialog
      // would reload the app the moment a purchase sheet closes, a regression, not a fix — and
      // `engine/app/debug/bridge.ts`'s port-lifecycle handler — a translucent dialog doesn't change
      // which app owns the foreground, and the debug bridge staying alive through a sheet is the
      // measurement instrument that proved onStop doesn't run.
      void CapacitorApp.addListener('pause', flush)
        .then((h) => { if (cancelled) h.remove(); else appListeners.push(h); })
        .catch((e: unknown) => {
          console.warn('[modoki] pause listener failed to register — PlayerPrefs will not flush '
            + 'while a translucent activity (e.g. a billing sheet) is open', e);
        });
    }
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      for (const h of appListeners) h.remove();
      flush(); // final flush on teardown (HMR / error-boundary recovery)
    };
  }, []);
}
