/** The ONE set of uncaught-error / unhandledrejection listeners for the shared console ring
 *  (#596/#597 Stage 3a).
 *
 *  BEFORE THIS STAGE there were TWO: `deviceConsoleCapture.ts` and `agentBridge.ts` each registered
 *  their own `window` `error`/`unhandledrejection` listeners, writing a near-identical line. Before
 *  Stage 2 that duplication was invisible — each fed a separate private buffer. Once both started
 *  feeding the ONE shared ring, every uncaught error in the editor produced TWO ring entries. This
 *  module is the single registration; `deviceConsoleCapture.ts` re-exports `CONSOLE_CAPTURE_MARKER`
 *  from here so its existing importers (tests, `smoke-debug-build-flag.mjs`'s grep) keep working
 *  unchanged, and `agentBridge.ts`'s own copy is deleted outright rather than left inert.
 *
 *  REGISTERED FROM `installConsoleRing.ts`'s SUPERSET GATE, deliberately NOT
 *  `installDeviceConsoleCapture.ts`'s narrower one. The device gate requires
 *  `DEV || VITE_DEBUG_BRIDGE || (__MODOKI_DEBUG_BUILD__ && Capacitor.isNativePlatform())`, so a
 *  packaged (non-dev) editor or a debug WEB build would never register these listeners while
 *  `agentBridge.ts` — which used to carry its own copy — was fully active there: an INERT MECHANISM,
 *  the exact trap #596/#597 exists to end. The shared ring's gate is the widest one in the app for
 *  exactly this reason; riding it here keeps this module active everywhere the ring itself is.
 *
 *  ⚠️ Records via `recordConsoleRingEntry('error', …)` — NEVER `console.error(...)`. Do not
 *  "simplify" this into a `console.error(...)` call: `runtime/core/globalErrors.ts:490` wraps
 *  `console.error` and reports to Crashlytics, and its de-duplication (`:385-389`) only recognises a
 *  call whose SOLE argument is an `Error` OBJECT, keyed in a WeakSet — a synthetic STRING can't match
 *  it, so routing an already-reported uncaught error back through `console.error` files a SECOND
 *  Crashlytics issue for the same fault (the "two issues per fault" symptom measured and documented
 *  at `globalErrors.ts:366-377`, 2026-08-20). Writing straight into the ring keeps the diagnostic
 *  line and reports nothing new.
 */

import { recordConsoleRingEntry } from '@modoki/engine/runtime/core/consoleRing';

/** Prefixes the two synthetic ring entries below, and doubles as the bundle-leak marker
 *  `smoke-debug-build-flag.mjs` greps for — this module rides `installConsoleRing.ts`'s side-effect
 *  import, so it is in `main.tsx`'s STATIC import graph, not a lazy chunk, and its stripping from a
 *  release build is not guaranteed by lazy-chunking alone. */
export const CONSOLE_CAPTURE_MARKER = '[console-capture]';

let installed = false;

/** Register the `window` `error`/`unhandledrejection` listeners. Idempotent — a second call is a
 *  no-op, so `installConsoleRing.ts`'s eager call and any test/tooling calling this directly can
 *  never double-register. */
export function installUncaughtCapture(): void {
  if (installed) return;
  installed = true;

  if (typeof window === 'undefined') return;

  // Each wrapped in try/catch — "never let capture break logging" matters MORE here: this handler
  // runs INSIDE the window error handler, so a throw while describing an error becomes another
  // error event. `e.error` is attacker-shaped in the general case — a value whose `stack` getter
  // throws, or a Proxy — and `String(e.message)` can throw on an object with a hostile `toString`.
  // Without the guard the entry is lost AND an exception escapes into the host, at precisely the
  // moment something is already going wrong.
  window.addEventListener('error', (e) => {
    try {
      const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
      const msg = e.error instanceof Error ? (e.error.stack || e.error.message) : String(e.message);
      recordConsoleRingEntry('error', [`${CONSOLE_CAPTURE_MARKER} [uncaught] ${msg}${where}`]);
    } catch { /* ignore — a capture failure must never amplify the error it is reporting */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = (e as PromiseRejectionEvent).reason;
      const msg = r instanceof Error ? (r.stack || r.message) : String(r);
      recordConsoleRingEntry('error', [`${CONSOLE_CAPTURE_MARKER} [unhandledrejection] ${msg}`]);
    } catch { /* ignore */ }
  });
}
