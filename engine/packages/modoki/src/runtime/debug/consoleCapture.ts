/** Console capture — the debug menu's view onto the SHARED console ring (#596/#597 Stage 3b).
 *
 *  This used to be its own independent `console.*` wrapper. It no longer patches anything: the
 *  shared ring (`runtime/core/consoleRing.ts`, L0) is the ONE thing wrapping `console.*` now, and
 *  this module is a PROJECTION of it — its own view (`getConsoleEntries`), its own clear-via-
 *  watermark (`clearConsoleEntries`), nothing more. `installConsoleCapture()` no longer decides
 *  WHEN capture starts; the app's eager installer (`engine/app/installConsoleRing.ts`, a
 *  side-effect import above `App.tsx` in `main.tsx`) already did that, and wins on sizing
 *  (capacity/bootPrefix) because it always runs first. This call is only a safety net for a
 *  consumer of `@modoki/engine` standalone, without that app shell around it.
 *
 *  On device (and in a webview) there's no devtools console, so the debug menu needs its own log
 *  view — that part is unchanged. No wall-clock (determinism guard): entries carry the shared
 *  ring's monotonic `seq`, not a timestamp. */

import {
  installConsoleRing,
  getConsoleRingEntries,
  getConsoleRingVersion,
  getConsoleRingEpoch,
  getConsoleRingDropped,
  getConsoleRingBootPrefixCount,
  subscribeConsoleRing,
  unpatchedLog,
  __resetConsoleRingForTest,
  type ConsoleRingLevel,
} from '../core/consoleRing';
import { createTeardownToken } from '../core/liveness';

export type ConsoleLevel = ConsoleRingLevel;

export interface ConsoleEntry {
  seq: number;
  level: ConsoleLevel;
  text: string;
}

/** This projection's own subscribers. Each is ALSO passed straight through to
 *  `subscribeConsoleRing` (see `subscribeConsole`), so a new console.* entry notifies it via the
 *  ring's own already-pinned microtask/per-listener-catch machinery. Kept here too so
 *  `clearConsoleEntries()` — a change the shared ring itself cannot see — can notify the SAME
 *  listeners through an equivalent local mechanism below. */
const listeners = new Set<() => void>();

/** Per-consumer watermark: `getConsoleEntries()` only returns entries with `seq >` this.
 *  `clearConsoleEntries()` advances it to the ring's current highest seq — it NEVER truncates the
 *  shared ring itself.
 *
 *  ⚠️ This is the whole reason for the watermark, not an implementation detail. `ConsoleTab.tsx`'s
 *  Clear button (`tabs/ConsoleTab.tsx:26`) is the only production caller, and if it truncated the
 *  shared buffer, a human tidying the on-screen tab would silently destroy the buffer behind
 *  `modoki_get_console_logs` / `device_console_logs` / `diagnose` — on device, the one usable log
 *  surface. Clearing must be a view operation, never a mutation of the shared ring. */
let clearedBeforeSeq = 0;

/** Bumped by `clearConsoleEntries()`, on top of the shared ring's own version. The ring's version
 *  does not move on a clear (nothing was recorded), but what `getConsoleEntries()` returns DOES
 *  change — so the composed snapshot below must move too, or `useSyncExternalStore` would read an
 *  unchanged snapshot and never re-render. */
let localVersion = 0;

// Notify OUT of the current task, coalesced to one call per burst — mirrors consoleRing.ts's own
// `notify()` (see its doc comment for the measured incident: a synchronous notify from inside a
// `console.warn`/`console.error` raised during render reaches a `useSyncExternalStore` subscriber
// synchronously, which is a setState during another component's render). `localVersion` (and so
// `getConsoleVersion()`) still bumps immediately in `clearConsoleEntries()`, so a snapshot read
// right after is already correct; only the listener call is deferred.
let notifyScheduled = false;
/** Invalidated by the test reset, so a flush queued before it cannot fire against the new state. */
const notifyLiveness = createTeardownToken();
function notifyLocal(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  const stillLive = notifyLiveness.capture();
  queueMicrotask(() => {
    if (!stillLive()) return; // reset between schedule and drain
    notifyScheduled = false;
    for (const fn of listeners) {
      // Per-listener, and NOT optional — a throwing listener must not escape or block the others.
      try {
        fn();
      } catch (err) {
        // ⚠️ `unpatchedLog`, NOT `console.error`. Same reasoning as the shared ring's own flush
        // catch: `globalErrors.ts:490` wraps `console.error` and reports to Crashlytics, and its
        // dedup only recognises a call whose sole argument is an `Error` object — so reporting an
        // INTERNAL bookkeeping failure here with two args files a real Crashlytics issue and spends
        // the session's error budget. Reaching this at all means a `subscribeConsole` listener threw
        // during a Clear-triggered flush; that deserves a log line, not a crash report.
        unpatchedLog('[consoleCapture] a subscriber threw during flush', err);
      }
    }
  });
}

/** Install the shared ring, as a safety net for a standalone `@modoki/engine` consumer. Idempotent
 *  (delegates to `installConsoleRing`, itself idempotent). No longer patches `console.*` itself —
 *  capture already started, eagerly, in `main.tsx` (a side-effect import above `App.tsx`), and by
 *  the time this module even loads (behind the debug-menu chunk) that install has long since won.
 *  This call decides nothing about WHEN capture starts any more. */
export function installConsoleCapture(): void {
  installConsoleRing();
}

/** The ring's identity, as of the last time ANY entry point that reads or writes `clearedBeforeSeq`
 *  checked it — not just `getConsoleEntries()`'s own cache below. Detects the ring being reset OUT
 *  FROM UNDER this projection (only possible via `__resetConsoleRingForTest()`): see
 *  `syncClearWatermarkToRing`'s doc comment for why that matters and why this is tracked separately
 *  from the cache rather than folded into `cachedRingVersion` alone. */
let lastKnownRingEpoch = -1;

/** Belt-and-braces alongside `lastKnownRingEpoch` (close-out review of #626/#633) — see
 *  `syncClearWatermarkToRing`'s doc comment for why a version going backwards is checked TOO,
 *  not just the epoch. */
let lastKnownRingVersion = -1;

/** Cache for `getConsoleEntries()` — see its own doc comment for why. Keyed on the RAW ring
 *  version, not the composed `getConsoleVersion()`: a combined `ring + local` number would hide a
 *  ring-version decrease behind whatever `localVersion` happens to be. */
let cachedRingVersion = -1;
let cachedClearedBeforeSeq = -1;
let cachedEntries: ConsoleEntry[] = [];

/** Self-heal `clearedBeforeSeq`/`localVersion` when the shared ring has been reset OUT FROM UNDER
 *  this projection — a test calling `__resetConsoleRingForTest()` directly, bypassing
 *  `__resetConsoleCaptureForTest()` below (this file's `uncaughtCapture.test.ts` sibling used to do
 *  exactly that). The ring's `seq`/`version` counters restart at 0/1, but `clearedBeforeSeq` does
 *  not — left alone, every future `getConsoleRingEntries(clearedBeforeSeq)` call would filter out
 *  EVERY entry until `seq` climbs back past the now-impossible stale watermark, reading as
 *  "captures nothing" with nothing failing anywhere.
 *
 *  Called from EVERY entry point that reads OR writes `clearedBeforeSeq` (`getConsoleEntries`,
 *  `getConsoleErrorsSince`, `clearConsoleEntries`) — not just the one with the memo cache — so the
 *  watermark this detects staleness against is current even when a caller never calls
 *  `getConsoleEntries()` at all between a Clear and a bare ring reset. Returns the current ring
 *  version so callers that already need it don't read it twice. */
function syncClearWatermarkToRing(): number {
  // ⚠️ Keyed on the ring's EPOCH — its identity — not on its version going BACKWARDS, which is what
  // this did until #626's close-out and which MISSES the common case. `seq` and `version` both
  // restart at 0 on a reset, so `reset -> log once` puts them back on values already observed:
  // `1 < 1` is false, no heal fires, and `clearedBeforeSeq` then filters out every entry — reading
  // as "captures nothing" with nothing failing anywhere. The identical bug was written twice (here
  // and in the editor projection this file is the model for) before an epoch replaced both.
  //
  // PLUS `ringVersion < lastKnownRingVersion` — belt-and-braces, close-out review of #626/#633.
  // Neither this module nor its editor twin supports HMR today, so nobody has built a real path
  // where this second leg fires on its own: it is cheap insurance against a hypothetical, not a
  // fix for anything demonstrated. The hypothetical: a genuinely FRESH ring module instance always
  // starts at `epoch === 0`, which could collide with an already-remembered `0` left behind by an
  // EARLIER ring instance this projection tracked before it was replaced — the epoch check alone
  // would then miss the reset. A version that has gone backwards is an independent signal for
  // exactly that case.
  const ringEpoch = getConsoleRingEpoch();
  const ringVersion = getConsoleRingVersion();
  if (ringEpoch !== lastKnownRingEpoch || ringVersion < lastKnownRingVersion) {
    clearedBeforeSeq = 0;
    localVersion = 0;
    cachedRingVersion = -1;
    cachedClearedBeforeSeq = -1;
    lastKnownRingEpoch = ringEpoch;
  }
  lastKnownRingVersion = ringVersion;
  return ringVersion;
}

/** The shared ring, projected into this consumer's `ConsoleEntry` shape and filtered to entries
 *  past the local clear watermark. All four levels, including `'info'` — `ConsoleTab.tsx` renders
 *  it with its own colour; folding levels down to three is a concern for a three-level reader, not
 *  this one.
 *
 *  MEMOIZED on `(ring version, clearedBeforeSeq)` — a second read at the same version reuses the
 *  same array rather than rebuilding it. `ErrorToaster` is mounted unconditionally in every debug
 *  build and previously called this on every coalesced console burst; when the Console tab is ALSO
 *  open, `ConsoleTab.tsx` reads the same version again on its own render, and without this cache
 *  that meant two full `[...pinned, ...tail]` rebuilds — each allocating an entry object AND a
 *  `.join(' ')`'d string PER RING ENTRY — for one burst. See `getConsoleErrorsSince` below for the
 *  OTHER half of the fix: `ErrorToaster` no longer calls this at all on its hot path. */
export function getConsoleEntries(): ConsoleEntry[] {
  const ringVersion = syncClearWatermarkToRing();
  if (ringVersion === cachedRingVersion && clearedBeforeSeq === cachedClearedBeforeSeq) {
    return cachedEntries;
  }
  cachedEntries = getConsoleRingEntries(clearedBeforeSeq).map((e) => ({
    seq: e.seq,
    level: e.level,
    text: e.args.join(' '),
  }));
  cachedRingVersion = ringVersion;
  cachedClearedBeforeSeq = clearedBeforeSeq;
  return cachedEntries;
}

/** Cheap accessor for `ErrorToaster`: entries with `seq > sinceSeq` at level `'error'` only, never
 *  touching entries the caller cannot possibly want.
 *
 *  `ErrorToaster` (`runtime/debug/ErrorToaster.tsx`) is mounted unconditionally in every debug
 *  build (`DebugMenu.tsx`) and its effect re-runs on every coalesced console burst. It used to call
 *  `getConsoleEntries()` there — rebuilding AND `.join(' ')`-ing every arg of every entry in the
 *  WHOLE ring — to look at, at most, the handful of entries newer than its own watermark. A debug
 *  device build at the ring's 512-entry cap, logging once per frame at 60fps, paid that cost every
 *  single frame for a toaster that in the common frame uses none of it (#154's low-end budget).
 *  Also respects the clear watermark, same as `getConsoleEntries()` — a manually-cleared error must
 *  not resurface as "new" just because a caller's own `sinceSeq` predates the clear. */
export function getConsoleErrorsSince(sinceSeq: number): ConsoleEntry[] {
  syncClearWatermarkToRing();
  return getConsoleRingEntries(Math.max(sinceSeq, clearedBeforeSeq))
    .filter((e) => e.level === 'error')
    .map((e) => ({ seq: e.seq, level: e.level, text: e.args.join(' ') }));
}

/** How many rolling-tail entries have been evicted so far — see `consoleRing.ts`'s own doc comment.
 *  `ConsoleTab.tsx` reads this to decide whether to draw a gap marker at all. */
export function getConsoleDropped(): number {
  return getConsoleRingDropped();
}

/** The boundary `seq` between the pinned boot prefix and the rolling tail — see
 *  `getConsoleRingBootPrefixCount`'s own doc comment. `ConsoleTab.tsx` reads this to find WHERE to
 *  draw the gap marker. */
export function getConsoleBootPrefixCount(): number {
  return getConsoleRingBootPrefixCount();
}

/** Composed from the shared ring's version PLUS this module's own counter, so a clear — which the
 *  shared ring cannot see — still moves the `useSyncExternalStore` snapshot. Monotonic: both
 *  addends only ever increase. */
export function getConsoleVersion(): number {
  return getConsoleRingVersion() + localVersion;
}

/** Advance the local watermark to the ring's current highest seq. A VIEW operation, never a
 *  truncation of the shared ring — see `clearedBeforeSeq`'s doc comment above. */
export function clearConsoleEntries(): void {
  syncClearWatermarkToRing();
  const all = getConsoleRingEntries();
  clearedBeforeSeq = all.length ? all[all.length - 1].seq : clearedBeforeSeq;
  localVersion++;
  notifyLocal();
}

export function subscribeConsole(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeRing = subscribeConsoleRing(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeRing();
  };
}

/** Test-only: reset this projection's local watermark/counter AND the shared ring, so existing
 *  `beforeEach` hooks keep working exactly as before. */
export function __resetConsoleCaptureForTest(): void {
  notifyLiveness.invalidateAll();
  notifyScheduled = false;
  clearedBeforeSeq = 0;
  localVersion = 0;
  lastKnownRingEpoch = -1;
  cachedRingVersion = -1;
  cachedClearedBeforeSeq = -1;
  cachedEntries = [];
  __resetConsoleRingForTest();
}
