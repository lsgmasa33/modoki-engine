/** consoleCapture — the editor Console panel's PROJECTION of the shared console ring (#626).
 *
 *  This USED TO BE its own independent `console.*`/`window` wrapper, installed as early as the
 *  editor itself could call it (`createEditor()`) so no early-init log or error was missed —
 *  measured live, it still missed a ~1.16s window of boot that the shared ring
 *  (`runtime/core/consoleRing.ts`) caught, because "as early as the editor could call it" is later
 *  than the ring's own eager install (`engine/app/installConsoleRing.ts`, a side-effect import above
 *  `App.tsx` in `main.tsx`). This module no longer patches `console.*` or listens on `window` at
 *  all: it is a PROJECTION of the shared ring, exactly like `runtime/debug/consoleCapture.ts` (the
 *  in-game debug menu's own projection of the same ring) — its own view (`getEditorLogs`), its own
 *  clear-via-watermark (`clearEditorLogs`), nothing more. Resource-load errors and the
 *  ResizeObserver-loop-noise swallow moved to `engine/app/debug/uncaughtCapture.ts` (a second,
 *  capture-phase `window` listener) — see its own doc comment.
 *
 *  THE ONE GENUINE DIFFERENCE this panel still needs, which the shared ring does not model by
 *  default: a `warn`/`error` row needs a stack even when the call passed no `Error` object — so it
 *  can still say WHERE `console.warn(...)` was called from — and formatting `.stack` is the
 *  expensive part in V8, so it must stay LAZY. That is `ConsoleRingOptions.retainCallSite`:
 *  `installConsoleRing.ts` turns it on for the editor only (a device build must never pay for
 *  retaining a live `Error` object per warn/error entry), and the ring itself allocates the `Error`
 *  at the console call site and exposes `entry.stack` as a lazily-memoized getter. This module just
 *  reads it.
 *
 *  ⚠️ `formatError` USED TO live here (a `String(err)` + `cause`-chain formatter) but had ZERO
 *  production callers by the time #626/#633 were adversarially reviewed: `getEditorLogs()` below
 *  projects the ring's own `stringifyArg` output, which is `err.stack || err.message` — no
 *  `formatError` in that path at all — so an Error's `cause` chain (F3) reached this panel erased,
 *  while two test suites kept asserting a function nothing calls. Deleted; the fix moved to the
 *  RING'S `stringifyArg` (`runtime/core/consoleRing.ts`) so every projection gains it, not just
 *  this one. */

import {
  getConsoleRingEntries, getConsoleRingVersion, getConsoleRingEpoch, subscribeConsoleRing,
  getConsoleRingDropped, getConsoleRingBootPrefixCount,
} from '../runtime/core/consoleRing';

export interface LogEntry {
  id: number;
  time: string;
  level: 'log' | 'warn' | 'error';
  message: string;
  stack: string;
}

function formatTime(now: Date): string {
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
}

/** Per-consumer watermark: `getEditorLogs()` only returns entries with `seq >` this.
 *  `clearEditorLogs()` advances it to the ring's current highest seq — it NEVER truncates the shared
 *  ring itself.
 *
 *  ⚠️ This is a VIEW operation, not a truncation, and that distinction matters more here than it
 *  used to: the old `logBuffer.length = 0` wiped the ONE buffer this panel owned, but the ring is
 *  now shared with three other consumers (`agentBridge`, the device bridge, the in-game debug menu's
 *  `ConsoleTab`) and `/api/console-logs` — truncating it from a Clear click in the editor Console
 *  panel would silently erase THEIR history too. Mirrors `runtime/debug/consoleCapture.ts`'s
 *  identical `clearedBeforeSeq`. */
let clearWatermark = 0;

/** Bumped by `clearEditorLogs()`, on top of the shared ring's own version — mirrors
 *  `runtime/debug/consoleCapture.ts`'s identical `localVersion`/`getConsoleVersion()` pair (see its
 *  own doc comment for the full rationale). The ring's version does not move on a clear (nothing was
 *  recorded), but what `getEditorLogs()` returns DOES change — so the version Console.tsx's
 *  `useMemo` keys on must move too, or a Clear would silently no-op whenever the ring's version
 *  already matched what the panel last rendered (the common case: autoscroll/scrollTop/selection all
 *  still at their defaults). */
let clearVersion = 0;

/** Self-heal `clearWatermark`/`clearVersion` when the shared ring has been reset OUT FROM UNDER
 *  this projection. The ring's counters restart at 0 but a watermark set before the reset does not
 *  — left alone, every later `getConsoleRingEntries(clearWatermark)` would filter out EVERY entry
 *  until `seq` climbed back past a now-impossible value, so the panel would read as "captures
 *  nothing" with nothing failing anywhere. That is the same silent-empty failure this whole issue
 *  exists to remove, one level up.
 *
 *  Mirrors `runtime/debug/consoleCapture.ts`'s `syncClearWatermarkToRing` — that twin hit this
 *  exact case first and documented it; this projection was written from the same pattern and
 *  initially copied everything EXCEPT the guard. Called from every entry point that reads or writes
 *  the watermark, not just one, so staleness is detected even if a caller only ever asks for the
 *  version. */
let lastRingEpoch = -1;

/** Belt-and-braces alongside `lastRingEpoch` (close-out review of #626/#633) — see
 *  `syncClearWatermarkToRing`'s doc comment for why a version going backwards is checked TOO, not
 *  just the epoch. */
let lastRingVersion = -1;

function syncClearWatermarkToRing(): number {
  // Keyed on the ring's EPOCH — its identity — not on any counter's value. `seq` and `version` both
  // restart at 0 on a reset, so `reset -> log once` puts them back on values already observed:
  // "version went backwards" never fires, and "watermark above highest seq" compares 1 > 1 and says
  // no. Both were written here and both were wrong; the test below pins that exact sequence.
  //
  // PLUS `ringVersion < lastRingVersion` — belt-and-braces, close-out review of #626/#633. Neither
  // this module nor its runtime twin supports HMR today, so nobody has built a real path where this
  // second leg fires on its own: it is cheap insurance against a hypothetical, not a fix for
  // anything demonstrated. The hypothetical: a genuinely FRESH ring module instance always starts
  // at `epoch === 0`, which could collide with an already-remembered `0` left behind by an EARLIER
  // ring instance this projection tracked before it was replaced — the epoch check alone would then
  // miss the reset. A version that has gone backwards is an independent signal for exactly that
  // case.
  const ringEpoch = getConsoleRingEpoch();
  const ringVersion = getConsoleRingVersion();
  if (ringEpoch !== lastRingEpoch || ringVersion < lastRingVersion) {
    clearWatermark = 0;
    clearVersion = 0;
    lastRingEpoch = ringEpoch;
    cachedRingVersion = -1; // the cache below describes a ring that no longer exists
  }
  lastRingVersion = ringVersion;
  return ringVersion;
}

/** Memo for `getEditorLogs()`, keyed on the ring's RAW version plus this module's watermark — the
 *  only two inputs that can change what it returns. Console.tsx calls it on every render (scroll,
 *  resize, selection), and without this each of those would re-map the whole ring — up to 1000
 *  entries, each allocating a `Date` — where the pre-#626 panel just read a stable array reference.
 *  Mirrors `runtime/debug/consoleCapture.ts`'s identical cache, which exists for the same reason.
 *
 *  ⚠️ F9 (#626/#633 adversarial review): `getEditorLogs()` never hands out THIS array itself — same
 *  reasoning as `getConsoleRingEntries()`'s own ⚠️ (`runtime/core/consoleRing.ts`). Console.tsx is
 *  not the only reader of a Console-panel projection convention, and a stray `.reverse()`/`.sort()`/
 *  `.push()` on a returned array would otherwise corrupt what every LATER call sees, since they'd
 *  all be looking at this same cached array. The cache still pays for the expensive part (the
 *  per-entry mapping, including a `Date` allocation each); only the O(n) array copy repeats. */
let cachedRingVersion = -1;
let cachedWatermark = -1;
let cachedLogs: LogEntry[] = [];

/** The shared ring, projected into this panel's `LogEntry` shape and filtered to entries past the
 *  local clear watermark. `'info'` folds to `'log'` — the panel's own level union has no `'info'`
 *  row (it never has; the toolbar only offers Log/Warn/Err). `time` is recovered from the ring's
 *  MONOTONIC `mono` at DISPLAY time (`performance.timeOrigin + entry.mono`), matching
 *  `runtime/core/consoleRing.ts`'s own doc comment on why that arithmetic does not belong in the
 *  ring itself. */
export function getEditorLogs(): LogEntry[] {
  const ringVersion = syncClearWatermarkToRing();
  if (ringVersion === cachedRingVersion && clearWatermark === cachedWatermark) return cachedLogs.slice();
  cachedRingVersion = ringVersion;
  cachedWatermark = clearWatermark;
  cachedLogs = getConsoleRingEntries(clearWatermark).map((e) => {
    const row = {
      id: e.seq,
      level: e.level === 'info' ? 'log' : e.level,
      message: e.args.join(' '),
      time: formatTime(new Date(performance.timeOrigin + e.mono)),
    } as LogEntry;
    // ⚠️ `stack` is re-exposed as a GETTER, never read here. The ring's own `stack` is itself a lazy
    // getter (`retainCallSite`), and formatting `Error.stack` is the expensive part in V8 — the whole
    // reason the capture is deferred. A plain `stack: e.stack ?? ''` in this map would READ it for
    // every entry on every projection, formatting up to 1000 stacks each time the ring's version
    // moves (i.e. on every new log line), which is worse than the pre-#626 panel and quietly undoes
    // the capability this issue set out to keep. Console.tsx reads `.stack` for the SELECTED row only.
    Object.defineProperty(row, 'stack', {
      enumerable: true,
      configurable: true,
      get() { return e.stack ?? ''; },
    });
    return row;
  });
  return cachedLogs.slice();
}

/** How many rolling-tail entries have been evicted from the shared ring so far — see
 *  `consoleRing.ts`'s own doc comment (`getConsoleRingDropped`, "THE DISCLOSURE THAT MATTERS").
 *
 *  F2 (#626/#633 adversarial review): Console.tsx reads this to decide whether to draw a gap
 *  marker at all — mirrors `runtime/debug/tabs/ConsoleTab.tsx`'s identical use of
 *  `runtime/debug/consoleCapture.ts`'s `getConsoleDropped()`. Before this, the editor Console panel
 *  was the ONE projection of the four the ring's own doc comment names that never surfaced it: its
 *  `[pinned] ++ [tail]` concatenation reads as one continuous log, and the toolbar's `n/total`
 *  counter can read as healthy (e.g. `1000/1000`) while the ring is silently discontiguous. */
export function getEditorLogsDropped(): number {
  return getConsoleRingDropped();
}

/** The boundary `seq` between the pinned boot prefix and the rolling tail — see
 *  `getConsoleRingBootPrefixCount`'s own doc comment. Console.tsx reads this to find WHERE to draw
 *  the gap marker (F2). */
export function getEditorLogsBootPrefixCount(): number {
  return getConsoleRingBootPrefixCount();
}

/** Advance the local watermark to the ring's current highest seq, and bump `clearVersion` so a
 *  reader keyed on `getEditorLogsVersion()` sees the change even when the ring's own version didn't
 *  move. A VIEW operation, never a truncation of the shared ring — see `clearWatermark`'s own doc
 *  comment above. */
export function clearEditorLogs(): void {
  syncClearWatermarkToRing();
  const all = getConsoleRingEntries();
  clearWatermark = all.length ? all[all.length - 1].seq : clearWatermark;
  clearVersion++;
}

/** Composed version for Console.tsx's `useMemo` invalidation key: the shared ring's own version
 *  (bumps on every new log) plus this module's own counter (bumps on every Clear) — see
 *  `clearVersion`'s doc comment above for why the plain ring version alone is not enough. Monotonic:
 *  both addends only ever increase. */
export function getEditorLogsVersion(): number {
  return syncClearWatermarkToRing() + clearVersion;
}

/** Set by the Console panel to be notified when a new log lands. Backed directly by the shared
 *  ring's own subscription — already coalesced to one microtask-scheduled flush per burst (see
 *  `consoleRing.ts`'s `notify()`), so this module no longer needs its own rAF-based coalescing. Only
 *  ONE callback is tracked at a time, matching the original API (the Console panel is a singleton
 *  tab). */
let unsubscribeOnNewLog: (() => void) | null = null;
export function setOnNewLog(cb: (() => void) | null): void {
  unsubscribeOnNewLog?.();
  unsubscribeOnNewLog = cb ? subscribeConsoleRing(cb) : null;
}
