/** useAudioResumeRearm — keeps the shared AudioContext resumable for the app's whole lifetime.
 *
 *  Its own module (rather than a local effect in App.tsx) so the re-arm contract below can be
 *  pinned by a test without rendering the whole app shell (App itself is not exported and drags
 *  in routing + the lazy editor chunk). */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { audioResume, noteAudioForeground } from '@modoki/engine/runtime';

/** Unlock/re-arm the AudioContext (mobile/WebView autoplay policy suspends it
 *  until a user gesture). This stays armed for the component's lifetime, NOT
 *  one-shot: an iOS audio-session interruption (e.g. a Music.app takeover) can
 *  suspend the context long after the first gesture, and audioResume() is the
 *  only place that ever calls ctx.resume(). We also re-arm on foreground —
 *  visibilitychange on web, appStateChange on native — since that's the common
 *  case; the gesture listeners stay as the reliable fallback because WebKit may
 *  refuse a resume() that isn't inside a user gesture. audioResume() self-guards
 *  (no-ops when already running), so calling it repeatedly is cheap and safe. */
export function useAudioResumeRearm() {
  useEffect(() => {
    const unlock = () => { audioResume(); };
    for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
      window.addEventListener(evt, unlock, { once: false });
    }
    // How long the app was away — the axis #1455 turns on and the one nothing had ever recorded.
    // `Date.now()` directly, not the engine's `rawNow()`: that wrapper is package-internal to
    // `runtime/**` on purpose (see `core/clock.ts`), and the determinism guard does not scan here.
    let hiddenAt: number | null = null;
    /** Whether we have already NOTED the current foreground. On iOS both the native
     *  `appStateChange` and the web `visibilitychange` fire for one transition, so this is what
     *  keeps one transition to one trace entry. */
    let noted = false;
    /** Foreground: note the state the OS left behind BEFORE resuming it, then resume.
     *
     *  ⚠️ **The note is deduped; the RESUME is not.** Both native `appStateChange` and web
     *  `visibilitychange` land here for a single iOS foreground. Noting on both wrote a second
     *  entry with `backgroundedMs` of 0 and a post-resume state — and since a reader is told to
     *  take the MOST RECENT foreground, that second entry said "no long background, context
     *  healthy" on exactly the platform and the exact axis #1455 is about. `audioResume()` still
     *  runs on every event: it self-guards, a second attempt is a real retry opportunity, and
     *  suppressing it would trade a recovery for a tidier trace. */
    const onForeground = () => {
      if (!noted) {
        noted = true;
        noteAudioForeground(hiddenAt === null ? null : Date.now() - hiddenAt);
        hiddenAt = null;
      }
      audioResume();
    };
    const onHidden = () => {
      // Only the FIRST hide counts: iOS can fire more than once on the way down, and taking the
      // last one would report a long background as a short one.
      if (hiddenAt === null) hiddenAt = Date.now();
      noted = false;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onForeground();
      else onHidden();
    };
    document.addEventListener('visibilitychange', onVisibility);
    let appListener: { remove: () => void } | undefined;
    let cancelled = false; // cleanup may run before the async addListener resolves
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) onForeground();
        else onHidden();
      }).then((h) => { if (cancelled) h.remove(); else appListener = h; })
      // A rejected registration must not become an unhandledrejection:
      // runtime/core/globalErrors.ts
      // reports those to Crashlytics, so an absent/stripped plugin would file one per
      // launch. Same treatment as capacitorStore.ts's listener (see its .catch).
      .catch(() => {});
    }
    return () => {
      cancelled = true;
      for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
        window.removeEventListener(evt, unlock);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      appListener?.remove();
    };
  }, []);
}
