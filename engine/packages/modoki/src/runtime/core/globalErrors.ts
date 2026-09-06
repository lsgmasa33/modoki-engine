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
import { peekResumeReload } from './resumeReload';

/** `console.error` AND `console.warn` → a non-fatal Crashlytics ISSUE (grouped, alerted on).
 *
 * ⚠️ **`warn` used to be a breadcrumb, and the OWNER reversed that (2026-08-20).** The original
 * argument was that a game warns on ordinary paths (a missing sprite, a skipped hint) and that
 * turning those into alerting issues would bury a real crash. The owner's call is that a warning
 * IS something to look at — if it fires on an ordinary path, the fix is to stop warning there,
 * not to route it somewhere nobody reads.
 *
 * Breadcrumbs are not unused by that change; they carry GAME EVENTS instead. Court feeds them
 * from the `track()` analytics seam, so a crash report shows the run that led to it
 * (`level_start` → `hint_opened` → `level_failed` → crash) rather than console chatter. That is
 * the shape a breadcrumb trail is for, and it is one seam rather than a second hand-maintained
 * list — see `games/court/packages/app-services/src/track.ts`.
 *
 * The caps below matter MORE under this decision, not less: they are what stops a warn inside a
 * per-frame system from becoming 60 issues a second. */
export type CaptureKind = 'error' | 'warn' | 'breadcrumb';

/** Caps. A warn inside a per-frame system is 60 calls/second; unbounded, that is a flooded
 *  console, a throttled SDK and a real bridge cost on the player's phone for no information. */
const MAX_REPEATS_PER_MESSAGE = 3;
const MAX_ERRORS_PER_SESSION = 100;
/**
 * ⚠️ **A SEPARATE session budget for warn-derived issues, and the separation is the point.**
 *
 * When `console.warn` started reporting as an ISSUE it also started spending the ERROR budget, and
 * that quietly inverted what this rate limiter is for. The dedupe above keys on exact message text,
 * so it does nothing against the ~97 runtime warn sites that interpolate a value
 * (`[MeshCache] Texture load failed: ${ref}`, one per distinct ref) — 100 such warns exhaust
 * `MAX_ERRORS_PER_SESSION`, and from then on EVERY genuine crash in that session is dropped
 * silently by the cap. Measured in a close-out review: 200 distinct warns followed by a real
 * `console.error` delivered 100 warns and not the crash.
 *
 * Warns are still delivered as issues — the owner's decision is unchanged — they simply cannot
 * consume the budget that exists to guarantee a crash gets through. The burst window below stays
 * SHARED on purpose: that one is about instantaneous load on the SDK and the device, which does not
 * care where a message came from.
 */
const MAX_WARNS_PER_SESSION = 100;
const MAX_BREADCRUMBS_PER_SESSION = 500;
/** Burst ceiling, for the flood that DEFEATS dedupe by varying its text (an entity id in the
 *  message). Sliding window, deliberately coarse.
 *
 *  ⚠️ `engine/index.html`'s fatal-load guard has its OWN `EARLY_ERROR_CAP`, bounding how many
 *  pre-install errors `drainEarlyErrors` (below) can feed through THIS SAME limiter in one
 *  synchronous burst — it must stay AT MOST this value `-2` (currently exactly `-2`, i.e. NO
 *  slack: `EARLY_ERROR_CAP` is 28, this is 30), where the 2 reserved slots are a `[reload]`
 *  breadcrumb that can spend one first, plus the drain's own "dropped" breadcrumb, which needs
 *  the other or the cap that is supposed to make drops honest gets silently refused itself. That
 *  file is a plain inline `<script>` and cannot import this constant, so raising this one without
 *  lowering it there — or without re-deriving the margin — reopens #636's silent-drop bug.
 *  `earlyErrorBuffer.test.ts` asserts the `-2` relationship against this exported value directly
 *  (#682 close-out round 3, MEDIUM 3) — a HAND-KEPT margin with nothing checking it is exactly how
 *  `EARLY_ERROR_CAP` drifted to 32 (2 OVER the headroom, not under it) in the first place. */
const BURST_WINDOW_MS = 5000;
export const MAX_PER_BURST_WINDOW = 30;
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

const SESSION_COUNTERS_KEY = 'modoki.globalErrors.sessionCounters';

/**
 * How long away from the foreground makes the NATIVE Crashlytics session likely to have rolled
 * over, so a budget carried across the reload would be charged against a session that never spent
 * it. Firebase's session timeout is 30 minutes; this matches it.
 *
 * ⚠️ **Bias this DOWN, never up.** The two ways to be wrong are not symmetric. Clearing too eagerly
 * restores exactly the pre-persistence behaviour — a fresh budget per realm, which shipped for
 * months and loses nothing. Keeping too eagerly means a brand-new native session starts with a
 * spent budget and reports NOTHING for its whole life, silently, which is strictly worse than the
 * bug the persistence was added to fix. When in doubt, clear.
 */
const CRASHLYTICS_SESSION_WINDOW_MS = 30 * 60_000;

interface PersistedCounters { errorsSent: number; warnsSent: number; breadcrumbsSent: number }

/**
 * Read the three session budgets left behind by a PREVIOUS boot of this same realm (see the
 * comment on `errorsSent` below for what "durable" means and does not mean here).
 *
 * ⚠️ Same shape and same caution as `resumeReload.ts`'s `markResumeReload`/`consumeResumeReload`:
 * every access is try/catch'd, because a context that throws on `sessionStorage` (private mode,
 * disabled site data) must fall back SILENTLY to today's in-memory-only behaviour. This module IS
 * the thing that reports failures — it must never become a source of one itself. Any failure to
 * read, or a value that does not parse as a finite number, is treated as "nothing persisted" (0),
 * never as an error.
 *
 * ⚠️ MUST be declared (and `SESSION_COUNTERS_KEY` with it) above the module-level `errorsSent`
 * init below, which calls this at module-evaluation time — a `const` referenced before its own
 * declaration line throws (TDZ), and that throw was previously swallowed by this function's own
 * try/catch, silently returning zero on every load. Caught by the reload test in
 * `globalErrors.test.ts`; keep this above the `errorsSent`/`warnsSent`/`breadcrumbsSent` `let`s.
 */
function loadPersistedCounters(): PersistedCounters {
  const zero: PersistedCounters = { errorsSent: 0, warnsSent: 0, breadcrumbsSent: 0 };
  try {
    // ⚠️ A budget only belongs to the next realm if the NATIVE session is still the same one.
    // `peekResumeReload()` (never `consume` — that one-shot belongs to the resume-reload path)
    // says how long the app was away. Past the window the native session has almost certainly
    // rolled, and carrying a spent budget into a fresh session would silence it completely: Court
    // routes every analytics event through `captureToCrashlytics('breadcrumb', …)`, so a long
    // play session reaches `MAX_BREADCRUMBS_PER_SESSION` readily, and #574 then reloads on the
    // next resume. Found in close-out review; the persistence shipped without it and this is the
    // one direction in which persisting is WORSE than not persisting.
    const away = peekResumeReload();
    if (away && away.awayMs > CRASHLYTICS_SESSION_WINDOW_MS) {
      // ⚠️ Clear the STORED value too, not just the in-memory one. `savePersistedCounters()` runs
      // only when a capture is allowed, so a realm that drops the budget here and then charges
      // NOTHING before its own next reload would leave the dead session's spent value in storage
      // and hand it to the realm after that — which then files nothing for its whole life. That is
      // the boot window, and "silences a whole session" is the direction this file's bias rule
      // calls unacceptable. Found in close-out review.
      clearPersistedCounters();
      return zero;
    }

    const raw = sessionStorage.getItem(SESSION_COUNTERS_KEY);
    if (raw == null) return zero;
    const parsed = JSON.parse(raw) as Partial<PersistedCounters>;
    // Clamped, not merely finite-checked: a hand-edited or corrupt key holding a huge value would
    // disable reporting for this context, and a NEGATIVE one would disable the cap and let the
    // budget run unbounded. Both are silent. `readCount` collapses either into a sane range.
    const readCount = (v: unknown, cap: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(0, Math.trunc(v)), cap) : 0;
    return {
      errorsSent: readCount(parsed.errorsSent, MAX_ERRORS_PER_SESSION),
      warnsSent: readCount(parsed.warnsSent, MAX_WARNS_PER_SESSION),
      breadcrumbsSent: readCount(parsed.breadcrumbsSent, MAX_BREADCRUMBS_PER_SESSION),
    };
  } catch {
    return zero;
  }
}

/** Write the three session budgets back, so the NEXT boot of this realm (a reload) sees them.
 *  Called every time one is charged in `allow()`. Failure is silent — see `loadPersistedCounters`. */
function savePersistedCounters(): void {
  try {
    sessionStorage.setItem(SESSION_COUNTERS_KEY, JSON.stringify({ errorsSent, warnsSent, breadcrumbsSent }));
  } catch {
    /* private mode, disabled site data, or a context that throws on access — see above */
  }
}

/** Test seam + `__resetGlobalErrorsForTest`: drop whatever was persisted, so a leftover budget
 *  from one test/realm cannot leak into the next. Failure is silent — see `loadPersistedCounters`.
 *
 *  ⚠️ **`sessionStorage` survives `vi.resetModules()` within a vitest file**, so this is not
 *  optional hygiene: a test file that charges past a cap across its cases and does NOT call
 *  `__resetGlobalErrorsForTest` will see later cases silently drop reports, and the failure looks
 *  like the code under test rather than like test bleed. Every current caller resets; a new one
 *  must too. */
function clearPersistedCounters(): void {
  try {
    sessionStorage.removeItem(SESSION_COUNTERS_KEY);
  } catch {
    /* nothing left to try */
  }
}

const repeats = new Map<string, number>();
/**
 * ⚠️ **`errorsSent`/`warnsSent`/`breadcrumbsSent` are seeded from `sessionStorage` and DURABLE
 * across a same-origin reload; `windowStart`/`windowCount` and `repeats` are deliberately NOT.**
 *
 * A webview reload re-runs this module from scratch, re-zeroing every `let` here — but native
 * Crashlytics still counts it as ONE session (#588). Without persistence a cap whose name says
 * "per session" is really per REALM, and #574's `useResumeReload.ts` made unattended reloads
 * routine, which is what turns that from pedantry into a real volume multiplier. See
 * `loadPersistedCounters`/`savePersistedCounters` above for the mechanism and its honest limits.
 *
 * `windowStart`/`windowCount` stay per-realm on purpose: it is a short WALL-CLOCK burst limiter
 * (`BURST_WINDOW_MS` = 5s) and a reload takes far longer than that window is worth reasoning
 * about — there is no meaningful "burst in progress" to resume. `repeats` also stays per-realm: it
 * is a write per capture for a dedupe generation, and resetting it on reload merely makes the
 * FIRST few repeats after a reload slightly more permissive, which is not worth a persistence path.
 *
 * ⚠️ **This is a strict improvement, not a guarantee — it does NOT make the budget "per session".**
 * `resumeReload.ts:118-123` already notes that iOS can recycle the WKWebView content process while
 * the app process lives, clearing `sessionStorage` while native state survives. When that happens
 * here, the counters reset to 0 while native Crashlytics still counts one session — i.e. this
 * degrades to exactly today's (unpersisted) behaviour, no worse. What it fixes is the common case:
 * a same-origin JS reload (#574's resume-reload, a crash-loop) that leaves the webview's storage
 * intact.
 */
const persistedCounters = loadPersistedCounters();
let errorsSent = persistedCounters.errorsSent;
let warnsSent = persistedCounters.warnsSent;
let breadcrumbsSent = persistedCounters.breadcrumbsSent;
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

  // 2. Session cap — read, not yet charged. THREE budgets, not two: see MAX_WARNS_PER_SESSION for
  //    why a warn flood must not be able to spend the crash budget.
  const spent = kind === 'error' ? errorsSent : kind === 'warn' ? warnsSent : breadcrumbsSent;
  const cap = kind === 'error' ? MAX_ERRORS_PER_SESSION
            : kind === 'warn' ? MAX_WARNS_PER_SESSION
            : MAX_BREADCRUMBS_PER_SESSION;
  if (spent >= cap) return false;

  // 3. Burst window, charged only for a send.
  const t = now();
  if (t - windowStart > BURST_WINDOW_MS) {
    windowStart = t;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_BURST_WINDOW) return false;
  windowCount++;

  if (kind === 'error') errorsSent++;
  else if (kind === 'warn') warnsSent++;
  else breadcrumbsSent++;
  savePersistedCounters();
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
    // 'warn' delivers as an ISSUE exactly like 'error' — it is a separate BUDGET, not a separate
    // destination. Only 'breadcrumb' takes the log path.
    if (kind === 'breadcrumb') svc.log(text);
    else svc.recordError(text);
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

/** Shape published by the fatal-load guard's early-error buffer in engine/index.html (#636). */
interface EarlyErrorEntry {
  kind: 'error' | 'unhandledrejection';
  error?: unknown;
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  reason?: unknown;
  ts?: number;
}
interface EarlyErrorState {
  entries: EarlyErrorEntry[];
  done: boolean;
  dropped: number;
}

/**
 * Drain the fatal-load guard's pre-install error buffer (#636) — the mirror of #633's
 * `drainEarlyConsole` (`consoleRing.ts`), for the OTHER inline script in `engine/index.html`: the
 * fatal-load guard, which registers `window` `error`/`unhandledrejection` listeners at HTML-parse
 * time, before rolldown's bundled entry chunk has run a single static import (see that guard's own
 * header comment for the measured byte offsets this covers) — but only for a boot that reaches
 * THIS function at all; a boot that never does leaves the buffer undrained, which is #825.
 *
 * ⚠️ Claim the carried error/reason object BEFORE reporting — the same protocol the live listener
 * below uses (`alreadyReported.add` before `captureToCrashlytics`), and for the same reason: it is
 * what stops one fault from becoming a second Crashlytics issue when Capacitor's bridge or React's
 * boundary later re-logs the same object through `console.error`.
 *
 * Reports go straight through `captureToCrashlytics`, never `captureConsoleError` — that path only
 * dedupes a LONE `Error` argument (`args.length === 1 && args[0] instanceof Error`), and a replayed
 * uncaught error was never a console call.
 *
 * Single-drain and a SEPARATE buffer from the console ring's `__MODOKI_EARLY_CONSOLE__` — the two
 * do not interact, and this must not touch `drainEarlyConsole`.
 */
function drainEarlyErrors(): void {
  const early = (globalThis as { __MODOKI_EARLY_ERRORS__?: EarlyErrorState }).__MODOKI_EARLY_ERRORS__;
  if (!early || early.done) return;
  early.done = true;
  const pending = early.entries;
  early.entries = [];
  for (const it of pending) {
    // Per-entry try/catch, same reasoning as drainEarlyConsole's loop: `describe()` already guards
    // against a hostile value, but this runs unconditionally at install time and one bad buffered
    // entry must not take the rest of the drain — or boot — down with it.
    try {
      // `it.ts` is the guard's own `performance.now()` at the moment THIS entry was captured —
      // often long before the drain itself runs (install can happen well after boot; see this
      // function's header). `captureToCrashlytics` carries no separate timestamp field to feed, so
      // (unlike `consoleRing.ts`'s `drainEarlyConsole`, which threads its buffered `mono` through
      // the RING's own `mono` field) the only place to put it is the message text itself — without
      // it every early fault reads as having happened "now", at drain time, which is exactly the
      // moment it did NOT happen.
      const when = typeof it.ts === 'number' && Number.isFinite(it.ts) ? ` (t=${Math.round(it.ts)}ms)` : '';
      if (it.kind === 'unhandledrejection') {
        if (it.reason !== null && typeof it.reason === 'object') alreadyReported.add(it.reason as object);
        captureToCrashlytics('error', `[unhandledrejection-early] ${describe(it.reason)}${when}`);
      } else {
        const where = it.filename ? ` (${it.filename}:${it.lineno}:${it.colno})` : '';
        if (it.error !== null && typeof it.error === 'object') alreadyReported.add(it.error as object);
        const msg = it.error !== undefined && it.error !== null ? describe(it.error) : describe(it.message);
        captureToCrashlytics('error', `[uncaught-early] ${msg}${where}${when}`);
      }
    } catch {
      /* never let one unreportable buffered entry break the rest of the drain */
    }
  }
  if (early.dropped > 0) {
    try {
      captureToCrashlytics('breadcrumb', `[modoki] ${early.dropped} pre-install error event(s) dropped (early buffer cap)`);
    } catch { /* same reasoning as the loop above */ }
  }
}

/**
 * True when THIS boot is a same-origin reload rather than a fresh navigation.
 *
 * `performance.getEntriesByType('navigation')` is not a clock read — it is a one-shot descriptor
 * of how the current document was loaded, resolved once at navigation and never advancing — so it
 * does not touch the determinism guard's `performance.now()`/`Date.now()` rule. Guarded anyway:
 * the entry can be absent on an older/embedded webview, and the array can be empty.
 *
 * ⚠️ Deliberately NOT `consumeResumeReload()` (`resumeReload.ts`) — that breadcrumb is a ONE-SHOT
 * owned by the resume-reload consumer, and reading it here would consume it out from under that
 * path. This asks the browser directly instead, which costs nothing and steps on nothing.
 */
function isReloadBoot(): boolean {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as { type?: string } | undefined;
    return nav?.type === 'reload';
  } catch {
    return false;
  }
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

    // A post-reload crash report otherwise shows a discontinuity in the breadcrumb trail with
    // nothing explaining it. Routed through captureToCrashlytics like everything else, so it is
    // subject to the same budgets — this is not a special unlimited channel.
    if (isReloadBoot()) {
      captureToCrashlytics('breadcrumb', '[reload] this boot followed a page reload, not a fresh navigation');
    }

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

    // Drain the fatal-load guard's pre-install buffer AFTER the listeners above are registered, so
    // anything thrown while draining is itself covered by them.
    drainEarlyErrors();

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
          // 'warn': delivered as an ISSUE (owner's call, see the CaptureKind doc above) but on its
          // OWN session budget, so a warn flood cannot silence a later crash.
          captureToCrashlytics('warn', `[console.warn] ${describeArgs(args)}`);
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
  warnsSent = 0;
  breadcrumbsSent = 0;
  windowStart = 0;
  windowCount = 0;
  queued = [];
  queueOverflowed = false;
  reporting = false;
  now = opts?.clock ?? rawNow;
  clearPersistedCounters(); // else a leftover session budget leaks from one test/realm into the next
  if (opts?.uninstall) installed = false;
}
