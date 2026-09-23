/** App activity timeline (#1475) — WHEN the game was not in front of the player.
 *
 *  "Nothing responds" at launch has several readings: the engine wedged, the GPU is compiling, or
 *  the OS put a system alert or a sign-in sheet in front of the game, which takes every tap until it
 *  is answered. ⚠️ An alert does NOT necessarily stop frames: measured on the iPad mini 5 (iOS
 *  26.6.2, fresh install, 2026-09-24), the ATT alert was up for 190 s with the app inactive the whole
 *  time, and rAF kept firing at ~58 fps. The boot timeline already records the stall itself (the
 *  `frame-interval` span); this records the other half, so the read can intersect them instead of
 *  guessing. #1475 is the case that needed it: a 6.9 s rAF gap on a first launch, with the page
 *  reporting itself `visible` throughout, and nothing on record to say whether a native prompt was up.
 *
 *  Three independent signals, each its own span, because they disagree in exactly the cases that
 *  matter:
 *    - `app-inactive` — the native app resigned active (iOS `willResignActiveNotification`, via
 *      `@capacitor/app`'s `appStateChange`). A system alert does this with the page still visible.
 *    - `page-hidden` — `document.visibilityState === 'hidden'`.
 *    - `window-blur` — the webview's window lost focus.
 *
 *  Edges only, never polled, and nothing here runs per frame. The Capacitor edge is fed in by the
 *  app shell (`noteAppActive`) because the runtime does not import native plugins. */

import { beginBootSpan, endBootSpan } from './bootTimeline';

let appInactiveSpan = -1;
let appInactive = false;
let pageHiddenSpan = -1;
let windowBlurSpan = -1;
let windowBlurred = false;

/** Feed the native app-active edge. Unpaired edges are normal — Android fires `isActive: true`
 *  with no preceding `false` on every resume (see `useBackgroundFlush`) — so a repeat of the
 *  current state is a no-op rather than a second span. */
export function noteAppActive(isActive: boolean): void {
  if (!isActive && !appInactive) {
    appInactive = true;
    appInactiveSpan = beginBootSpan('app-inactive');
  } else if (isActive && appInactive) {
    appInactive = false;
    endBootSpan(appInactiveSpan);
    appInactiveSpan = -1;
  }
}

interface ActivityDocument extends EventTarget { visibilityState: string }

/** Record `page-hidden` and `window-blur` spans from the DOM's own edges. Returns the uninstall.
 *  The targets are injectable so the edge logic is testable without a browser. */
export function installPageActivityTimeline(
  doc: ActivityDocument = document,
  win: EventTarget = window,
): () => void {
  const syncVisibility = () => {
    const hidden = doc.visibilityState === 'hidden';
    if (hidden && pageHiddenSpan < 0) pageHiddenSpan = beginBootSpan('page-hidden');
    else if (!hidden && pageHiddenSpan >= 0) { endBootSpan(pageHiddenSpan); pageHiddenSpan = -1; }
  };
  const onBlur = () => {
    if (windowBlurred) return;
    windowBlurred = true;
    windowBlurSpan = beginBootSpan('window-blur');
  };
  const onFocus = () => {
    if (!windowBlurred) return;
    windowBlurred = false;
    endBootSpan(windowBlurSpan);
    windowBlurSpan = -1;
  };
  // Visibility is reliable at install time, so its initial state counts. Focus is NOT — a webview
  // with no keyboard focus can report `hasFocus() === false` at launch with nothing covering it — so
  // only a real `blur` edge opens that span.
  syncVisibility();
  doc.addEventListener('visibilitychange', syncVisibility);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  return () => {
    doc.removeEventListener('visibilitychange', syncVisibility);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    // ⚠️ Open spans and flags are deliberately LEFT as they are. The app shell's root never unmounts in a
    // shipped build, so the only uninstall is Fast Refresh / StrictMode, which re-installs at once — and the
    // window is still blurred then, with no new `blur` coming. Closing here cut the span short at the save
    // and cleared the flag for the rest of the blur (#1477 close-out, second review). The re-installed
    // listeners close them on the real `focus` / `visibilitychange` edge instead.
  };
}

/** A clause for a stall report naming what the OS was doing, or `''` when nothing is known. A small
 *  FIXED set of strings, never interpolated: the stall log is deduped by text (see frameDriver's
 *  stall message), so a varying suffix would defeat that. */
export function describeAppActivity(): string {
  if (appInactive) {
    return ' The app was INACTIVE at the time (the OS resigned it — a system prompt or native sheet ' +
      'is likely up, and it takes every tap until answered).';
  }
  if (windowBlurred) return ' The window had lost focus at the time.';
  return '';
}

/** Test reset — module state is per realm, and a test that leaves a span open poisons the next. */
export function resetAppActivity(): void {
  appInactive = false;
  appInactiveSpan = -1;
  pageHiddenSpan = -1;
  windowBlurred = false;
  windowBlurSpan = -1;
}
