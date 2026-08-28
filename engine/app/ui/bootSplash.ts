/** Dismissing the web boot splash (#396).
 *
 *  The element is injected into `index.html` at build time by `plugins/bootSplash.ts`, so that the
 *  project's splash art covers the boot from the browser's FIRST PAINT — before this bundle has
 *  been fetched, let alone mounted. Nothing here creates it; this only takes it away.
 *
 *  It is absent in dev, in the editor, in a playable, and in any project that has authored no
 *  `app.splashSource` — so every function here is a no-op by default and must stay safe to call
 *  unconditionally.
 */

const BOOT_SPLASH_ID = 'modoki-boot-splash';
/** Matches the `transition` in the injected markup; the node is removed once it has faded. */
const FADE_MS = 260;

/** The backstop deadline. A launch image that never goes away is the worst thing this feature can
 *  do — it turns a crash, a hang, or an error message into an app that merely looks slow — and the
 *  paths that reach it are the ones nobody enumerates: a render-time throw caught by an error
 *  boundary whose fallback paints UNDERNEATH this element, or a boot awaiting rAFs that never fire
 *  because the tab is backgrounded.
 *
 *  Generous on purpose: a cold install on a slow device legitimately takes several seconds, and
 *  dismissing early shows the dark loading overlay the splash exists to replace. This is a
 *  DEADLINE, not a schedule — the normal path dismisses long before it. */
export const BOOT_SPLASH_TIMEOUT_MS = 20_000;

let dismissed = false;

/** Fade the boot splash out and remove it. Idempotent, and safe when there is no boot splash.
 *
 *  Called when the game has rendered its first frame — and ALSO whenever something needs to be
 *  seen underneath it (a boot error, an OTA download's progress). The splash outranks every other
 *  boot surface by z-index, so leaving it up over an error would turn a visible, explained failure
 *  into an apparent hang. */
export function dismissBootSplash(): void {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById(BOOT_SPLASH_ID);
  if (!el) return;
  el.style.opacity = '0';
  window.setTimeout(() => el.remove(), FADE_MS);
}

/** Whether a boot splash is currently on screen. Lets a caller decide whether its own loading
 *  chrome would be visible at all. */
export function hasBootSplash(): boolean {
  return !dismissed && document.getElementById(BOOT_SPLASH_ID) != null;
}
