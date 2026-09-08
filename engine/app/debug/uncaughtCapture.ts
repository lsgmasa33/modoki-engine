/** The ONE set of uncaught-error / unhandledrejection listeners for the shared console ring
 *  (#596/#597 Stage 3a; extended by #626).
 *
 *  BEFORE STAGE 3a there were TWO: `deviceConsoleCapture.ts` and `agentBridge.ts` each registered
 *  their own `window` `error`/`unhandledrejection` listeners, writing a near-identical line. Before
 *  Stage 2 that duplication was invisible — each fed a separate private buffer. Once both started
 *  feeding the ONE shared ring, every uncaught error in the editor produced TWO ring entries. This
 *  module is the single registration; `deviceConsoleCapture.ts` re-exports `CONSOLE_CAPTURE_MARKER`
 *  from here so its existing importers (tests, `smoke-debug-build-flag.mjs`'s grep) keep working
 *  unchanged, and `agentBridge.ts`'s own copy is deleted outright rather than left inert.
 *
 *  #626 added a SECOND `error` listener, CAPTURE phase, ported from the editor Console panel's own
 *  wrapper (`packages/modoki/src/editor/consoleCapture.ts`, now retired to a projection — see its own
 *  doc comment). It exists for two things the plain listener below structurally cannot see:
 *
 *    1. A resource-load failure (a `<img>`/`<script>`/`<link>` that failed to fetch) fires as a
 *       plain `Event` on the FAILING ELEMENT, not an `ErrorEvent` on `window` — and it does not
 *       bubble, so only a listener registered in the CAPTURE phase (which runs top-down, reaching
 *       `window` before the dispatch gets down to the element) ever observes it.
 *    2. The "ResizeObserver loop completed with undelivered notifications" browser warning, which
 *       DOES arrive as a genuine `ErrorEvent` on `window` — this listener swallows it via
 *       `stopImmediatePropagation()` before the plain listener below gets a chance to record it as a
 *       real uncaught error (see the ⚠️ paragraph just below for why registration ORDER is what
 *       makes that actually work). Matched on the message STARTING WITH the ResizeObserver prefix
 *       AND carrying no real `.error` (F4, #626/#633 adversarial review) — a substring match alone
 *       also swallowed a game's own thrown error that merely mentioned the same words, and the
 *       suppression is counted + surfaced once via a ring notice rather than dropped with no trace.
 *
 *  ⚠️ REGISTERED **BEFORE** the plain `error` listener below, and that ORDER IS LOAD-BEARING, not
 *  incidental. For an event whose `target` IS `window` — every genuine `ErrorEvent`, including the
 *  ResizeObserver one — the DOM spec's AT_TARGET phase invokes ALL of `window`'s listeners
 *  regardless of their capture flag, in REGISTRATION order (capture vs. bubble only matters when the
 *  event's target is some OTHER node `window` merely sees on the way past). So registering the
 *  capture-phase listener first is what lets its `stopImmediatePropagation()` pre-empt the plain
 *  listener for the ResizeObserver case, and its own `instanceof ErrorEvent` guard is what stops it
 *  from ALSO recording every other real `ErrorEvent` a second time — double-recording every uncaught
 *  error is the exact regression #596/#597 Stage 3a already fixed once (two ring entries per fault),
 *  and this must not reintroduce it.
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

/** Prefixes the synthetic ring entries below, and doubles as the bundle-leak marker
 *  `smoke-debug-build-flag.mjs` greps for — this module rides `installConsoleRing.ts`'s side-effect
 *  import, so it is in `main.tsx`'s STATIC import graph, not a lazy chunk, and its stripping from a
 *  release build is not guaranteed by lazy-chunking alone. */
export const CONSOLE_CAPTURE_MARKER = '[console-capture]';

/** The exact prefix Chromium/WebKit's benign "ResizeObserver loop ..." browser warning message
 *  always STARTS with. Matched at the START (F4, #626/#633 adversarial review), never via
 *  `.includes` — a game-authored error whose message merely CONTAINS this substring elsewhere
 *  (measured: `ErrorEvent{message:'Uncaught Error: ResizeObserver loop guard tripped in my game'}`)
 *  used to be swallowed here just as silently as the real warning. */
const RESIZE_OBSERVER_LOOP_PREFIX = 'ResizeObserver loop';

/** How many times the capture-phase listener has swallowed a genuine ResizeObserver-loop warning
 *  this session — but ONLY ever read via the `=== 1` check below, to decide whether to fire the
 *  one-shot ring notice. There is no accessor and nothing else reads it: the total itself is never
 *  surfaced anywhere, so a session that swallows the warning 50 times still shows exactly the ONE
 *  ring line from the first occurrence, with the other 49 uncounted-for in anything a human or
 *  agent can see. F4's actual guarantee is narrower than "counted" suggests — it is "never a
 *  SILENT drop with no trace AT ALL" (the one notice), not "the true count is available". */
let resizeObserverLoopSuppressedCount = 0;

let installed = false;

/** Register the `window` `error` (×2 — see the module doc comment) / `unhandledrejection`
 *  listeners. Idempotent — a second call is a no-op, so `installConsoleRing.ts`'s eager call and
 *  any test/tooling calling this directly can never double-register. */
export function installUncaughtCapture(): void {
  if (installed) return;
  installed = true;

  if (typeof window === 'undefined') return;

  // CAPTURE-PHASE listener, registered FIRST — see the module doc comment for why both the phase
  // and the registration order are load-bearing here. Handles exactly two things the plain listener
  // below cannot: a non-bubbling resource-load failure, and pre-empting the ResizeObserver-loop
  // noise before the plain listener records it as a real uncaught error.
  window.addEventListener('error', (event: Event) => {
    try {
      if (event instanceof ErrorEvent) {
        // "ResizeObserver loop completed with undelivered notifications" is a benign browser
        // warning fired when an observer callback dirties layout and the next batch spills into a
        // follow-up frame. Nothing actually breaks (there's no .error, no stack) and it's emitted by
        // our own resize-driven editor overlays — swallow it here so it never masquerades as a real
        // uncaught error, and `stopImmediatePropagation()` so the plain listener below (registered
        // SECOND, so it would otherwise still run in this same AT_TARGET pass) never sees it either.
        //
        // ⚠️ F4 (#626/#633 adversarial review): matched on `!event.error` (the genuine browser
        // warning throws no real Error, so this is always unset for it) AND the message STARTING
        // WITH the prefix — never `.includes`, which also matched a game's OWN thrown error merely
        // mentioning the same words (measured: "Uncaught Error: ResizeObserver loop guard tripped in
        // my game" produced ZERO ring entries under the old `.includes` check).
        if (!event.error && event.message.startsWith(RESIZE_OBSERVER_LOOP_PREFIX)) {
          resizeObserverLoopSuppressedCount++;
          // Surfaced ONCE per session, not per occurrence — a layout-heavy frame can trip this
          // repeatedly, and a notice per occurrence would be exactly the noise this swallow exists
          // to prevent. But never a SILENT drop: this is the trace that the suppression happened.
          if (resizeObserverLoopSuppressedCount === 1) {
            try {
              recordConsoleRingEntry('warn', [
                `${CONSOLE_CAPTURE_MARKER} suppressing benign "${RESIZE_OBSERVER_LOOP_PREFIX}" browser warning(s) — not a real error`,
              ]);
            } catch { /* ignore — a capture failure must never amplify the error it is reporting */ }
          }
          event.stopImmediatePropagation();
          return;
        }
        // Every OTHER real ErrorEvent is the plain listener's job — recording it here too would be
        // exactly the "two ring entries per fault" regression #596/#597 Stage 3a already fixed once.
        return;
      }
      // Resource load error (img/script/link). target has src/href. Doesn't bubble, so this
      // capture-phase listener is the ONLY thing that ever sees it.
      //
      // ⚠️ F5 (#626/#633 adversarial review): guarded on the event having a REAL ELEMENT TARGET,
      // never on `!(event instanceof ErrorEvent)` alone — `instanceof` is realm-scoped (a
      // cross-realm ErrorEvent fails it too), and a plain `Event('error')` dispatched AT window
      // (target === window, no element) used to fall through to here and record a fabricated
      // "Resource load error: <resource> " entry with an empty url — a SECOND ring entry for the
      // SAME event the plain listener below also records, the exact "two entries per fault"
      // regression this module exists to end.
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (!target || (target as unknown) === window || !('tagName' in target)) return;
      const url = target.src || target.href || '';
      const tag = target.tagName.toLowerCase() || 'resource';
      recordConsoleRingEntry('error', [`${CONSOLE_CAPTURE_MARKER} Resource load error: <${tag}> ${url}`.trim()]);
    } catch { /* ignore — a capture failure must never amplify the error it is reporting */ }
  }, true);

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
