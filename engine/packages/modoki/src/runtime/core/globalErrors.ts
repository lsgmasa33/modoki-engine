/**
 * Global JS error capture → the registered `crashlytics` app-service.
 *
 * ⚠️ THE GAP THIS EXISTS TO CLOSE (#275). A shipped Modoki build had NO global error handling at
 * all. `window.addEventListener('error'|'unhandledrejection')` existed in FOUR files, every one of
 * them a debug or editor surface a release build does not ship: `engine/app/debug/agentBridge.ts`
 * and `engine/app/debug/hmrStaleness.ts` (behind `if (__MODOKI_EDITOR__)`),
 * `engine/app/debug/bridge.ts` (behind the `build.debugBuild` gate), and
 * `src/editor/consoleCapture.ts` (dev-only by location). (#275 itself said "exactly two" — an
 * undercount that named the two an agent would grep for; the conclusion is unchanged and the
 * evidence for it is wider.) So an uncaught throw outside a React
 * subtree, an async failure inside a system, or a rejected asset load reached NOTHING in
 * production: no console anyone could read, no report, no signal. The only crash path that ever
 * reported was `ErrorBoundary.componentDidCatch`, which sees React render errors and nothing else.
 *
 * ⚠️ AND WHY IT LIVES HERE RATHER THAN IN THE DEBUG PLUMBING. `engine/app/main.tsx` gates the
 * journal, the debug menu, the debug handles and the debug bridge on
 * `__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__`, so ANY route through `journalWarn`/`journalError`
 * or through either bridge is dead in the build that actually ships. That is the exact trap that
 * made Court's retention milestones fire zero times for a day (#269) and that Phase 4 of
 * games/court/attribution.md documents for analytics. This module is engine-level and UNGATED —
 * it must be installed on every build, including a release one, or it reports nothing when it
 * matters.
 *
 * It is a no-op until a game registers a `crashlytics` service (`registerAppServices`), which
 * happens well after boot — so events raised before that are QUEUED and flushed on registration
 * rather than dropped. A crash during boot is the one we would most want and the one a
 * fire-and-forget handler would lose.
 */

import { appServices, onAppServicesRegistered } from './appServices';
import { rawNow } from './clock';

/** `console.error` → a non-fatal Crashlytics ISSUE (grouped, alerted on).
 *  `console.warn`  → a Crashlytics BREADCRUMB (context inside somebody else's report).
 *
 * That split is the decision this file encodes, and conflating the two is what makes a crash
 * console useless: a game warns on ordinary paths (a missing sprite, a skipped hint), and turning
 * those into alerting issues buries the one report that is a real crash. */
export type CaptureKind = 'error' | 'breadcrumb';

/** Caps. A warn inside a per-frame system is 60 calls/second; unbounded, that is a flooded
 *  console, a throttled SDK and a real bridge cost on the player's phone for no information. */
const MAX_REPEATS_PER_MESSAGE = 3;
const MAX_ERRORS_PER_SESSION = 100;
const MAX_BREADCRUMBS_PER_SESSION = 500;
/** Burst ceiling, for the flood that DEFEATS dedupe by varying its text (an entity id in the
 *  message). Sliding window, deliberately coarse. */
const BURST_WINDOW_MS = 5000;
const MAX_PER_BURST_WINDOW = 30;
/** How many DISTINCT message texts the dedupe table remembers before starting a new generation.
 *  It is a bound on memory, not on sending — see the note in `allow()`. */
const MAX_DISTINCT_TRACKED = 500;
/** A stack can be arbitrarily long; the SDK truncates anyway and the bridge pays per byte. */
const MAX_MESSAGE_CHARS = 4000;
/** Boot queue: deep enough to hold a boot failure's cascade, shallow enough to never be a leak. */
const MAX_QUEUED = 50;

let installed = false;
let installing = false;
/**
 * Re-entrancy latch: anything raised while we are already reporting is dropped on the floor.
 *
 * ⚠️ IT COVERS ONLY THE SYNCHRONOUS BOUNCE, and this comment used to claim more. A real
 * `CrashlyticsService` is `async` — Court's returns a promise and warns from a later `.catch` —
 * so by the time its `console.warn` re-enters here the latch has already been released in
 * `deliver`'s `finally`. Widening it to span the await was considered and REJECTED: it would drop
 * a genuine error that happened while a report was in flight, which is a worse trade than the
 * thing it prevents.
 *
 * What actually bounds the async bounce is the WRAPPER's own once-per-distinct-message latch,
 * plus the caps below. MEASURED, not assumed: one `console.warn` into a service that always
 * rejects delivers exactly TWO messages — the original, and one echo of the reporter's own
 * failure warning — and then stops. `globalErrors.test.ts` § "the async bounce" pins that number,
 * so a wrapper that forgets its latch shows up as a rising count rather than as a silent flood.
 */
let reporting = false;

const repeats = new Map<string, number>();
let errorsSent = 0;
let breadcrumbsSent = 0;
let windowStart = 0;
let windowCount = 0;

interface Queued { kind: CaptureKind; text: string }
let queued: Queued[] = [];
let queueOverflowed = false;

/** The burst window is genuine WALL CLOCK — it bounds how often we talk to a native SDK, which is
 *  not game state and must not scale with `timeScale` or stop when the sim pauses. `rawNow()` is
 *  the engine's sanctioned wrapper for exactly that (a bare `Date.now()` here fails the
 *  determinism guard, correctly: the guard cannot tell rate-limiting from simulation). Injectable
 *  so a test can drive the window without sleeping. */
let now: () => number = rawNow;

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : text;
}

/** Describe anything at all without trusting it. `e.error` is attacker-shaped in the general
 *  case — a Proxy, or a value whose `stack` getter throws — and this runs at the moment
 *  something is already going wrong, so a throw in here would become a second error event. */
function describe(value: unknown): string {
  try {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

function describeArgs(args: unknown[]): string {
  try {
    return args.map(describe).join(' ');
  } catch {
    return '<unprintable>';
  }
}

/**
 * True when this message may be sent; false when a cap swallowed it.
 *
 * ⚠️ THE ORDER OF THESE THREE CHECKS IS THE WHOLE CORRECTNESS OF THE LIMITER, and it shipped
 * wrong. The burst window used to be charged FIRST, before the per-message repeat cap was even
 * consulted — so an attempt that dedupe was already going to throw away still spent one of the 30
 * slots. The threat model this module names in its own comments then triggers the bug: a warning
 * inside a per-frame system fires 60x/second, dedupe correctly sends 3 of them, and the other 57
 * silently exhaust the window — after which **a brand-new, first-ever crash in that same 5 seconds
 * is dropped**, with its own repeat count at 0 and the session cap nowhere near. Measured, not
 * reasoned: 40 identical calls delivered 3 and drove `windowCount` to 40, and the next distinct
 * message never arrived. Losing an unrelated crash to somebody else's flood is the exact opposite
 * of what a rate limiter is for.
 *
 * So: dedupe first (it counts ATTEMPTS — that is what makes a repeat cap a repeat cap), then the
 * session cap, and the burst window LAST, charged only for a message that is actually about to be
 * sent. Every budget below the one that rejects is left untouched.
 */
function allow(kind: CaptureKind, text: string): boolean {
  // 1. Per-message dedupe. Counts attempts, and stops counting once the number can no longer
  //    change the answer, so a per-frame message cannot grow an unbounded integer.
  const seen = (repeats.get(text) ?? 0) + 1;
  if (repeats.size >= MAX_DISTINCT_TRACKED && !repeats.has(text)) {
    // ⚠️ Bounded, because nothing else bounds it. A flood that varies its text (an entity id in
    // the message) adds a key per distinct message, and the session caps do NOT stop the
    // bookkeeping — they stop the sending. Over a multi-hour mobile session that is a real leak.
    // Clearing rather than evicting one entry is deliberate: it costs a fresh dedupe generation
    // (a few repeats get through again) and cannot be gamed into O(n) work per call.
    repeats.clear();
  }
  repeats.set(text, Math.min(seen, MAX_REPEATS_PER_MESSAGE + 1));
  if (seen > MAX_REPEATS_PER_MESSAGE) return false;

  // 2. Session cap — read, not yet charged.
  if (kind === 'error' ? errorsSent >= MAX_ERRORS_PER_SESSION
                       : breadcrumbsSent >= MAX_BREADCRUMBS_PER_SESSION) return false;

  // 3. Burst window, charged only for a send.
  const t = now();
  if (t - windowStart > BURST_WINDOW_MS) {
    windowStart = t;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_BURST_WINDOW) return false;
  windowCount++;

  if (kind === 'error') errorsSent++;
  else breadcrumbsSent++;
  return true;
}

function deliver(kind: CaptureKind, text: string): void {
  const svc = appServices().crashlytics;
  if (!svc) {
    if (queued.length >= MAX_QUEUED) {
      queueOverflowed = true;
      return;
    }
    queued.push({ kind, text });
    return;
  }
  reporting = true;
  try {
    if (kind === 'error') svc.recordError(text);
    else svc.log(text);
  } catch {
    /* a reporting failure must never amplify the thing it is reporting */
  } finally {
    reporting = false;
  }
}

/** Report one captured event. Public so a game/system can route a handled-but-notable failure
 *  here deliberately, rather than having to throw to be seen. */
export function captureToCrashlytics(kind: CaptureKind, text: string): void {
  if (reporting) return;
  const msg = truncate(text);
  if (!allow(kind, msg)) return;
  deliver(kind, msg);
}

/**
 * ⚠️ CAPACITOR'S OWN BRIDGE CALLS `console.error(err)` FOR EVERY UNCAUGHT WINDOW ERROR, which
 * made one fault arrive as TWO Crashlytics issues. Measured on a Galaxy S22, 2026-08-20: a single
 * `setTimeout(() => { throw … })` produced `recordException` twice, once tagged `[console.error]`
 * and once `[uncaught]`, and the JS stack proved the first one's caller —
 * `cap.handleWindowError` -> `handleError` -> `console.error`. It happens INSIDE the error
 * dispatch, so it lands before our own `'error'` listener; a "have we already reported this"
 * check at console time would always answer no.
 *
 * So a lone `Error` argument is reported on a MICROTASK instead. The whole `'error'` dispatch is
 * one task, so our listener has run — and recorded the error object here — by the time the
 * microtask drains. The uncaught report wins, keeping the label that says which one it was; a
 * `console.error(err)` that is NOT an uncaught error is unaffected beyond a microtask's delay.
 *
 * ⚠️ REACT DOES THE SAME THING, and it was the same two-issues-per-fault symptom: an error caught
 * by an `ErrorBoundary` is ALSO logged by React to `console.error`. Measured on the same device,
 * same session. That is why {@link reportReactError} claims the error object here too — the
 * boundary's report is the good one (it carries the component stack), so the console copy stands
 * down.
 */
const alreadyReported = new WeakSet<object>();

function captureConsoleError(args: unknown[]): void {
  const sole = args.length === 1 ? args[0] : undefined;
  if (sole instanceof Error) {
    const err = sole;
    void Promise.resolve().then(() => {
      if (alreadyReported.has(err)) return;
      captureToCrashlytics('error', `[console.error] ${describe(err)}`);
    });
    return;
  }
  captureToCrashlytics('error', `[console.error] ${describeArgs(args)}`);
}

/**
 * Report a React subtree crash caught by an `ErrorBoundary`. Routed through this module rather
 * than straight at `appServices().crashlytics` for two reasons that are both defects otherwise:
 * it CLAIMS the error object, so React's own `console.error` copy does not become a second issue;
 * and it goes through the rate limiter, so a boundary caught in a re-render loop cannot flood.
 */
export function reportReactError(error: unknown, componentStack?: string | null): void {
  if (error !== null && typeof error === 'object') alreadyReported.add(error as object);
  const stack = componentStack ? `\n${componentStack}` : '';
  captureToCrashlytics('error', `[react] ${describe(error)}${stack}`);
}

function flushQueue(): void {
  if (!appServices().crashlytics) return;
  const pending = queued;
  queued = [];
  if (queueOverflowed) {
    queueOverflowed = false;
    pending.push({
      kind: 'breadcrumb',
      text: `[modoki] more than ${MAX_QUEUED} events were raised before crash reporting was registered; the excess was dropped.`,
    });
  }
  for (const q of pending) deliver(q.kind, q.text);
}

/**
 * Install the handlers. Idempotent — a second call is a no-op, so an HMR re-import or a second
 * game load cannot double-wrap `console` (which would double-report every line).
 *
 * ⚠️ CALL IT EARLY, before anything else touches `console.warn`. `warnSuppress.ts` swaps
 * `console.warn` for the duration of Rapier's init and restores the function it captured; if we
 * installed DURING that window we would capture its wrapper as "the original" and its restore
 * would then throw ours away. Installed first, the nesting is the harmless direction.
 */
export function installGlobalErrorHandlers(): void {
  if (installed || installing) return;
  installing = true;
  try {
    onAppServicesRegistered(flushQueue);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('error', (e: ErrorEvent) => {
        try {
          const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
          // Claim the error object BEFORE reporting, so the deferred console.error copy that
          // Capacitor's bridge already queued sees it and stands down (see the WeakSet above).
          if (e.error !== null && typeof e.error === 'object') alreadyReported.add(e.error as object);
          const msg = e.error !== undefined && e.error !== null ? describe(e.error) : describe(e.message);
          captureToCrashlytics('error', `[uncaught] ${msg}${where}`);
        } catch { /* ignore */ }
      });
      window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        try {
          captureToCrashlytics('error', `[unhandledrejection] ${describe(e.reason)}`);
        } catch { /* ignore */ }
      });
    }

    if (typeof console !== 'undefined') {
      const realError = console.error.bind(console);
      const realWarn = console.warn.bind(console);
      console.error = (...args: unknown[]) => {
        try {
          captureConsoleError(args);
        } catch { /* ignore */ }
        realError(...args);
      };
      console.warn = (...args: unknown[]) => {
        try {
          captureToCrashlytics('breadcrumb', `[console.warn] ${describeArgs(args)}`);
        } catch { /* ignore */ }
        realWarn(...args);
      };
    }
    installed = true;
  } finally {
    installing = false;
  }
}

/** Test seam: how many DISTINCT messages the dedupe table is currently holding. Exposed because
 *  the bound on it is invisible from the outside — the symptom of losing it is memory, not
 *  behaviour, so nothing else could fail. */
export function __dedupeTableSizeForTest(): number {
  return repeats.size;
}

/** Test seam: the caps, the dedupe table, the queue and the injectable clock. Does NOT uninstall
 *  the listeners — a test that needs a fresh install should reset the module registry instead. */
export function __resetGlobalErrorsForTest(opts?: { clock?: () => number; uninstall?: boolean }): void {
  repeats.clear();
  errorsSent = 0;
  breadcrumbsSent = 0;
  windowStart = 0;
  windowCount = 0;
  queued = [];
  queueOverflowed = false;
  reporting = false;
  now = opts?.clock ?? rawNow;
  if (opts?.uninstall) installed = false;
}
