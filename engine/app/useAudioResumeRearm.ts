/** useAudioResumeRearm — keeps the shared AudioContext resumable for the app's whole lifetime.
 *
 *  Its own module (rather than a local effect in App.tsx) so the re-arm contract below can be
 *  pinned by a test without rendering the whole app shell (App itself is not exported and drags
 *  in routing + the lazy editor chunk). */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { audioResume } from '@modoki/engine/runtime';

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
    const onVisibility = () => {
      if (document.visibilityState === 'visible') audioResume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    let appListener: { remove: () => void } | undefined;
    let cancelled = false; // cleanup may run before the async addListener resolves
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) audioResume();
      }).then((h) => { if (cancelled) h.remove(); else appListener = h; })
      // A rejected registration must not become an unhandledrejection: globalErrors.ts
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
