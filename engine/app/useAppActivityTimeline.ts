/** useAppActivityTimeline — records when the game was not in front of the player (#1475) as
 *  boot-timeline spans: the page's own visibility/focus edges, plus the native app-active edge
 *  (iOS `willResignActive`, which a system alert or a sign-in sheet fires with the page still
 *  "visible"). The runtime cannot import `@capacitor/app`, so the native edge is fed from here.
 *  See `runtime/core/appActivity.ts` for what the spans are for. */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { installPageActivityTimeline, noteAppActive } from '@modoki/engine/runtime';

export function useAppActivityTimeline() {
  useEffect(() => {
    const uninstall = installPageActivityTimeline();
    let handle: { remove: () => void } | undefined;
    let cancelled = false; // cleanup may run before the async addListener resolves
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => noteAppActive(isActive))
        .then((h) => { if (cancelled) void h.remove(); else handle = h; })
        // Diagnostics only: a missing plugin loses the span, nothing else — so a warning, and never
        // an unhandled rejection (globalErrors.ts would report one per launch).
        .catch((e: unknown) => console.warn('[modoki] appStateChange listener for the activity timeline failed to register', e));
    }
    return () => {
      cancelled = true;
      uninstall();
      void handle?.remove();
      // No `noteAppActive(true)` here: the only unmount is a Fast Refresh remount, and the remounted listener
      // closes `app-inactive` on the real `isActive: true` edge (see `installPageActivityTimeline`'s uninstall).
    };
  }, []);
}
