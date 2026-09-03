/** The ONE shared console ring — Stage 1 of #596/#597.
 *
 *  Today the app has FOUR independent `console.*` wrappers (this repo's own
 *  `runtime/debug/consoleCapture.ts`, the device bridge's `deviceConsoleCapture.ts`, and two more
 *  in the app layer), each installed lazily behind whatever chunk owns it — measured live, three
 *  of them install ~1.16s into boot and structurally cannot see app bootstrap or React mount
 *  (probes at nav+276ms and nav+305ms were missed; the first captured line was at nav+1462ms).
 *  This module replaces all four with ONE ring, installed as early as the app can call it, that
 *  every consumer will later PROJECT from (its own view, its own clear-via-watermark) rather than
 *  own its own patch of `console.*`. This file is Stage 1: the ring only. No consumer is touched
 *  yet — that is a later stage of #596/#597.
 *
 *  This is L0 (`runtime/core/`) — it may import nothing from the engine above it. The only import
 *  it needs is `rawNow` from `./clock`, which is also L0 (an intra-L0 edge, not a reach upward).
 *
 *  **Time**: `rawNow()` returns MONOTONIC milliseconds (`performance.now()`), not wall-clock
 *  epoch — that is correct and intended here, and is why this file needs no
 *  `ALLOW_WALLCLOCK` entry in the determinism guard (`tests/runtime/determinismGuard.test.ts`):
 *  it never touches `Date.now()`/`performance.now()` directly. A consumer that wants an epoch
 *  timestamp computes `performance.timeOrigin + entry.mono` itself, in the app layer — that
 *  arithmetic does not belong in L0.
 */

import { rawNow } from './clock';
import { createTeardownToken } from './liveness';

export type ConsoleRingLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleRingEntry {
  /** 1-based, strictly increasing, never reused — even across an eviction. */
  seq: number;
  /** `rawNow()` at record time — monotonic ms, NOT epoch. */
  mono: number;
  level: ConsoleRingLevel;
  /** Each arg stringified EAGERLY at record time — never a live object reference (it would leak
   *  and could mutate after the fact). Not joined: a consumer decides how to render multiple
   *  args. */
  args: string[];
  /** Call-site stack, lazily formatted on first read — see `ConsoleRingOptions.retainCallSite`.
   *  Only present on a `warn`/`error` entry recorded while `retainCallSite` is on (editor only),
   *  and never on a REPLAYED entry (the #633 shim drain) — see `record()`'s own doc comment.
   *  Absent everywhere else, including every `log`/`info` entry. */
  stack?: string;
}

export interface ConsoleRingOptions {
  /** Total entries kept: the pinned prefix plus the rolling tail. Default 512. */
  capacity?: number;
  /** How many of the EARLIEST entries are pinned and never evicted. Default 128. */
  bootPrefix?: number;
  /** Opt-in per-entry call-site capture for `warn`/`error` entries (#626). Default **false**.
   *  Retaining a live `Error` object per warn/error entry is a real cost — the editor's Console
   *  panel needs it (a `console.warn` row should have a stack even when no `Error` was passed), a
   *  device build must never pay for it. `engine/app/installConsoleRing.ts` is the ONE place this
   *  is turned on, gated `__MODOKI_EDITOR__`. */
  retainCallSite?: boolean;
}

const DEFAULT_CAPACITY = 512;
const DEFAULT_BOOT_PREFIX = 128;

/** The load-bearing capture. At MODULE SCOPE, before `installConsoleRing` (or anything else) has
 *  patched anything, this binds the PRISTINE, pre-patch `console.log`.
 *
 *  `engine/app/debug/bridge.ts` (`const _log = unpatchedLog`, ~25 call sites) logs its device-input
 *  chatter through this so those calls do NOT push into the ring — #591 regressed exactly this:
 *  its eager install inverted binding order, `bridge.ts` ended up binding the WRAPPER instead of
 *  the original, and ~200 input ops evicted the entire boot capture out of the ring. Binding this
 *  at module-evaluation time, before `installConsoleRing()` can ever run, makes that ordering
 *  mistake structurally impossible to repeat. */
export const unpatchedLog: (...args: unknown[]) => void = console.log.bind(console);

// ⚠️ THERE IS NO "unpatchedError" BINDING HERE, and that is deliberate — an earlier draft had one,
// captured the same way as `unpatchedLog` above, with a comment calling it "the pristine, pre-patch
// console.error". It was not pristine: `engine/app/main.tsx` imports `./installErrorCapture` (which
// calls `installGlobalErrorHandlers()`, synchronously, at module eval) ABOVE `./installConsoleRing`
// (which is what first imports and evaluates THIS module) — so by the time a module-scope
// `console.error.bind(console)` here would run, `globalErrors.ts:490` has ALREADY replaced
// `console.error` with its Crashlytics-reporting wrapper. Binding "console.error" at that point
// captures that wrapper, not the real thing — there is no way to reach past it from this module,
// and reordering the imports is not the fix (`main.tsx:12-15` documents why `installErrorCapture`
// must stay the inner wrap).
//
// That would have been SAFE for re-entrancy — globalErrors' wrapper sits INNER to this ring's own
// `console.error` patch (installed later, by `installConsoleRing()`), so calling it directly from
// `notify()`'s catch below could never loop back into `record()` above. But it is not safe for
// BUDGET: every call through it reaches `captureConsoleError` and spends the session's Crashlytics
// allowance — for a subscriber throwing during flush, which is this module's OWN bookkeeping
// failure, not anything the game or a player did. So `notify()`'s catch reports through
// `unpatchedLog` instead: it is the one binding in this file that genuinely IS pristine (nothing
// wraps `console.log`, on device or in the editor), which keeps the same re-entrancy guarantee at
// zero Crashlytics cost — at the price of the line showing as a plain log instead of a red error in
// devtools/logcat, which is the right trade for a failure nobody outside this file caused.

let capacity = DEFAULT_CAPACITY;
let bootPrefix = DEFAULT_BOOT_PREFIX;
let retainCallSite = false;
/** The ring's IDENTITY generation — bumps when the ring is invalidated (today: only the test
 *  reset). A projection holding a clear WATERMARK compares generations to know its watermark
 *  belongs to a ring that no longer exists.
 *
 *  ⚠️ `createTeardownToken`, NOT a hand-rolled counter, and that is a repo decision rather than a
 *  preference: #573 found five ad-hoc "am I still live?" conventions that disagreed, and settled on
 *  ONE pattern with a shared helper for the two shapes that are the same machinery. This is exactly
 *  the second of those — "a counter that bumps on INVALIDATION, not on start" (see
 *  `runtime/core/liveness.ts`). `livenessTokenIsShared.test.ts` does not catch a sixth counter in
 *  this shape (it compares against a value in ANOTHER module, which that guard correctly allows),
 *  so this is the convention holding on its own rather than the guard enforcing it.
 *
 *  `.generation` is read directly rather than via `capture()` because the consumers are synchronous
 *  cache checks with their own control flow, which the helper's doc calls a first-class use of the
 *  raw counter, not an escape hatch. Layer-clean: `liveness.ts` is L0 with no imports of its own. */
const ringLiveness = createTeardownToken();

/** `[pinned boot entries] ++ [rolling tail]`, in seq order. Once the tail is full, appending
 *  shifts out its own oldest entry — the pinned prefix is never touched. */
let pinned: ConsoleRingEntry[] = [];
let tail: ConsoleRingEntry[] = [];

let seq = 0;
let version = 0;
let dropped = 0;
let installed = false;
let recording = false; // re-entrancy guard: a logged getter/toString must not re-enter record()

const listeners = new Set<() => void>();
let notifyScheduled = false;

/** The four ORIGINAL console methods, as raw references (not bound — see the comment in
 *  `installConsoleRing` on why). `installConsoleRing` fills these in; `__resetConsoleRingForTest`
 *  restores `console[level]` from them. */
let originals: Record<ConsoleRingLevel, (...args: unknown[]) => void> | null = null;

/** Duplicates `engine/app/debug/bridgeHelpers.ts`'s `safeStringify` semantics on purpose — that
 *  helper lives in the app layer (L-above L0) and this file cannot import it. Strings pass
 *  through; an `Error` becomes `"Name: message"`; anything else goes through `JSON.stringify`,
 *  falling back to `String(v)` on failure (a circular reference, a BigInt, a symbol, …); a plain
 *  `undefined` argument stringifies to the literal `'undefined'`, matching `String(undefined)`. */
/** Kept BYTE-IDENTICAL to `engine/app/debug/bridgeHelpers.ts`'s `PENDING_PROMISE_MARKER`. Duplicated
 *  rather than imported because that helper is in the app layer and this file is L0. */
const PENDING_PROMISE_MARKER = '[unresolved Promise — did you forget `await`?]';

function isThenable(v: unknown): boolean {
  return !!v && (typeof v === 'object' || typeof v === 'function')
    && typeof (v as { then?: unknown }).then === 'function';
}

/** Depth cap for `formatCauseChain` below — copied from the editor's now-deleted `formatError`
 *  (F3, #626/#633 adversarial review). Guards against a pathological (or cyclic) `cause` chain
 *  growing an entry without bound; four links is already far more than any real error chain in
 *  this codebase has ever carried. */
const CAUSE_CHAIN_DEPTH_CAP = 4;

/** `\n  caused by: Name: message`, repeated for each `Error` in `err.cause`'s chain, depth-capped.
 *  Returns `''` when there is no `cause` (or it isn't an `Error`) — the overwhelmingly common case,
 *  so a caller can always just append the result.
 *
 *  Each link is rendered as `Name: message`, not its own `.stack` — the HEAD (whatever the caller
 *  prefixes this with) already carries a full stack saying WHERE the outer error was thrown; a
 *  cause is there to say WHAT led to it, one line each. */
function formatCauseChain(err: Error, depth = 0): string {
  const cause = (err as { cause?: unknown }).cause;
  if (depth >= CAUSE_CHAIN_DEPTH_CAP || !(cause instanceof Error)) return '';
  const head = `${cause.name || 'Error'}: ${cause.message}`;
  return `\n  caused by: ${head}${formatCauseChain(cause, depth + 1)}`;
}

function stringifyArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  // Top-level thenable handled BEFORE the JSON path, exactly as `safeStringify` does. Leaving it to
  // the replacer would work but return the marker JSON-QUOTED, so the two helpers would disagree on
  // a string this repo greps for.
  if (isThenable(v)) return PENDING_PROMISE_MARKER;
  // ⚠️ THE STACK IS THE POINT, and dropping it is a regression this repo has already paid for
  // twice. An Error has NO own enumerable properties, so `JSON.stringify(new Error('boom'))` is
  // `{}` — `console.error(err)` is how half the codebase reports a failure, and a real device boot
  // error once reached `diagnose` as a literal `{}` (measured on a Samsung, #157). An earlier draft
  // of THIS file returned `${v.name}: ${v.message}`, which is the same defect wearing a nicer
  // label: visible but useless, because the stack is what says WHERE. All three captures this file
  // replaced returned `stack || message`; so does this.
  //
  // F3 (#626/#633 adversarial review): PLUS the `cause` chain, which `.stack` alone never carries.
  // `formatError` used to do this in the editor's own projection — reachable by nothing once #626
  // moved the panel onto this ring, so a chained `new Error(msg, { cause })` (exactly the shape
  // `createEditor.tsx`'s `sceneReady.catch((e) => console.error('[Editor] scene load failed:', e))`
  // logs) reached every consumer with its cause silently erased. Fixed HERE, at the ring, so every
  // projection (editor, in-game debug menu, agent bridge, device bridge) gains it at once.
  if (v instanceof Error) return (v.stack || v.message) + formatCauseChain(v);
  try {
    // Handled at BOTH depths, matching `safeStringify`: the branch above catches a top-level Error,
    // the replacer below catches one NESTED in an object or array. `{cause: err}` and `[err]` are
    // exactly how a rejection value arrives, and serializing those to `{"cause":{}}` / `[{}]` is
    // the same defect one level down — a distinction `bridgeHelpers.ts` records learning the hard
    // way, in its own close-out review.
    //
    // The `cause` chain is appended here too (F3/F8, #626/#633 adversarial review) — the module doc
    // comment above already claimed a nested Error is "handled at BOTH depths", but until now that
    // meant `stack || message` only, dropping `cause` for exactly the shapes this branch exists for
    // (`console.error('ctx', { err })`, `console.error([err])`). A non-Error `cause` still stays
    // dropped here, same as the top-level branch above — that is pre-existing and fine, only an
    // `Error` cause carries anything worth chaining.
    const json = JSON.stringify(v, (_k, val) => (
      isThenable(val) ? PENDING_PROMISE_MARKER
        : val instanceof Error ? (val.stack || val.message) + formatCauseChain(val)
          : val));
    // `JSON.stringify` returns `undefined` — not a string — for a function, a symbol, or any value
    // whose `toJSON` yields undefined. Returning that would put a non-string into
    // `ConsoleRingEntry.args` despite its `string[]` type, and the first consumer to call
    // `.slice()`/`.includes()` on it would throw inside a console wrapper.
    return json === undefined ? String(v) : json;
  } catch {
    return String(v);
  }
}

function notify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const fn of listeners) {
      // Per-listener, and never allowed to escape or block the rest — see the module doc comment
      // above `unpatchedLog` (where `unpatchedError` used to be) for why the report below goes
      // through `unpatchedLog` and not the live `console.error`.
      try {
        fn();
      } catch (err) {
        // `unpatchedLog`, not a `console.error` path: this is an internal bookkeeping failure, and
        // routing it through anything that reaches `globalErrors.ts` would spend a real
        // Crashlytics issue on it.
        unpatchedLog('[consoleRing] a subscriber threw during flush', err);
      }
    }
  });
}

/** `replay` is passed ONLY by `drainEarlyConsole` (#633). Its presence — not the presence of a
 *  timestamp inside it — is what marks an entry as replayed, because the drain legitimately
 *  omits `mono` for an untrusted shim payload, and inferring "replayed" from a missing
 *  timestamp would then hand that entry a call-site stack pointing at the drain loop. */
function record(level: ConsoleRingLevel, args: unknown[], replay?: { mono?: number }): void {
  if (recording) return; // a logging getter/toString must not re-enter us
  recording = true;
  try {
    // Stringify BEFORE incrementing `seq` — `stringifyArg` has throwing paths no inner guard fully
    // covers (a hostile `toString`, a `.then`/`.stack` getter that itself throws), and every caller
    // already wraps its own call into `record()` in a try/catch. If `seq` incremented FIRST, a
    // swallowed throw here would still have CONSUMED a seq with nothing ever pushed to
    // `pinned`/`tail` — breaking the contiguity invariant `getConsoleRingBootPrefixCount()`'s own
    // doc comment asserts ("an entry's `seq` is in the pinned prefix iff `seq <=
    // getConsoleRingBootPrefixCount()`"), which BOTH gap markers
    // (`consoleVirtualization.ts`'s `findGapMarkerIndex`, `ConsoleTab.tsx`'s twin) rely on to find
    // the seam — a lost seq shifts it one row early. Building the array first means a throw here
    // never touches `seq` at all.
    const stringifiedArgs = args.map(stringifyArg);
    const entry: ConsoleRingEntry = {
      seq: ++seq,
      // `replay.mono` is ONLY for the #633 shim drain, which replays lines captured before this
      // module existed and carries each one's ORIGINAL `performance.now()`. Stamping them at drain
      // time instead would collapse the whole boot window onto one timestamp.
      mono: replay?.mono ?? rawNow(),
      level,
      args: stringifiedArgs,
    };
    // Opt-in call-site capture (#626), OFF by default — see `ConsoleRingOptions.retainCallSite`.
    // Only the editor's Console panel needs a stack on a `warn`/`error` row that logged no `Error`
    // (so it can still say WHERE the call came from); a device build must never pay for retaining a
    // live `Error` object per entry, hence the flag. `log`/`info` never get one, matching the
    // panel's existing cost decision.
    //
    // A REPLAYED entry (the #633 shim drain, `drainEarlyConsole` below) is skipped: the call site
    // captured HERE would point at the drain loop, not wherever the original console call actually
    // happened on the page. Keyed on `replay` being PASSED AT ALL, never on whether it carried a
    // timestamp — the drain omits `mono` for an untrusted payload, and keying on that would give
    // exactly those entries a misleading stack.
    if (retainCallSite && (level === 'warn' || level === 'error') && replay === undefined) {
      // Allocated HERE (inside record()) so the frame depth `slice(3)` assumes is stable: [0] the
      // "Error" header line, [1] this function (`record`), [2] the console wrapper arrow (or
      // `recordConsoleRingEntry`, its own equally-thin wrapper around this function), [3] the real
      // caller. (V8/Chromium-only by design — the editor ships in Electron; on a non-V8 engine the
      // header line is absent and one real frame would be dropped, acceptable since retainCallSite
      // is never turned on there.)
      let err: Error | undefined = new Error();
      let computedStack: string | undefined;
      Object.defineProperty(entry, 'stack', {
        enumerable: true,
        configurable: true,
        get() {
          if (computedStack === undefined) {
            computedStack = (err?.stack || '').split('\n').slice(3).join('\n').trim();
            // F10: release the retained Error the instant its stack IS READ. A strict improvement,
            // but only for an entry whose stack someone actually looks at — an entry whose getter
            // is NEVER called (most warn/error rows: nobody selected them in the Console panel)
            // keeps its `Error` (and whatever it pins via V8's stack-trace machinery) alive in the
            // CLOSURE for as long as the entry itself survives in the ring regardless of this fix,
            // same as before it. This does NOT cap the worst case at some bounded number of live
            // Errors — it only shortens the lifetime of the ones that get read. No practical unit
            // test exists for this (asserting "an Error got garbage-collected" isn't observable
            // from here); this comment is the only thing guarding the claim.
            err = undefined;
          }
          return computedStack;
        },
      });
    }
    if (pinned.length < bootPrefix) {
      pinned.push(entry);
    } else {
      tail.push(entry);
      const tailCapacity = Math.max(capacity - bootPrefix, 0);
      while (tail.length > tailCapacity) {
        tail.shift();
        dropped++;
      }
    }
    version++;
    notify();
  } finally {
    recording = false;
  }
}

/** Shape published by the inline early-capture shim in engine/index.html (#633). */
interface EarlyConsoleState {
  /** `[level, args, mono]` — `mono` is the shim's own `performance.now()` at CALL time. */
  entries: [string, unknown[], number?][];
  done: boolean;
  dropped: number;
}

/** The only four levels the shim (and this ring) knows how to record. */
const EARLY_CONSOLE_LEVELS: ReadonlySet<string> = new Set(['log', 'info', 'warn', 'error']);

/** Drain the inline shim's pre-install buffer into the ring (#633).
 *
 *  ⚠️ DISARM, NEVER UNWRAP. `installGlobalErrorHandlers` wraps console.error/warn AROUND this shim
 *  (measured: globalErrors patches before the ring does), so restoring the original console.*
 *  here would drop that wrapper and silently stop Crashlytics console reporting. Setting
 *  `done = true` leaves the chain intact and makes the shim a pass-through for the rest of the
 *  session.
 *
 *  Entries are recorded through `recordConsoleRingEntry`, which bypasses `console.*` — so this
 *  cannot re-enter the patches installed a few lines above, and the drained lines take the LOWEST
 *  seq numbers, landing inside the pinned boot prefix where they belong. */
function drainEarlyConsole(): void {
  const early = (globalThis as { __MODOKI_EARLY_CONSOLE__?: EarlyConsoleState }).__MODOKI_EARLY_CONSOLE__;
  if (!early || early.done) return;
  early.done = true;
  const pending = early.entries;
  early.entries = [];
  for (const [level, args, mono] of pending) {
    // ⚠️ PER-ENTRY try/catch, and it is load-bearing, not defensive dressing. `args` are LIVE object
    // references the shim captured from arbitrary pre-install code, and `stringifyArg` has throwing
    // paths that no inner guard covers (`isThenable` reads `v.then`; the fallback `String(v)` throws
    // for a null-prototype or throwing-`toString` value). Every OTHER route into `record()` is
    // already wrapped — the console wrappers below do `try { record(...) } catch {}` — but this one
    // runs inside `installConsoleRing()`, which `main.tsx` reaches through a STATIC side-effect
    // import. So an unguarded throw here does not lose a log line: it aborts the entry module, and
    // React never mounts. One hostile boot-time argument would cost the whole app.
    //
    // Swallowing per ENTRY (not around the loop) so one bad line cannot discard the rest of boot.
    try {
      // The shim is plain JS living in HTML, so its payload is untrusted — fold an unrecognised
      // level to 'log' rather than trusting it, and only honour a FINITE timestamp.
      const safeLevel: ConsoleRingLevel = EARLY_CONSOLE_LEVELS.has(level) ? (level as ConsoleRingLevel) : 'log';
      record(safeLevel, args, { mono: typeof mono === 'number' && Number.isFinite(mono) ? mono : undefined });
    } catch {
      /* never let one unstringifiable buffered arg break boot */
    }
  }
  if (early.dropped > 0) {
    try {
      recordConsoleRingEntry('warn', [`[console-ring] ${early.dropped} pre-install console line(s) dropped (early buffer cap)`]);
    } catch { /* same reasoning as the loop above */ }
  }
}

/** Wrap `console.log/info/warn/error`. Idempotent — a second call is a no-op. Each wrapper
 *  records (never letting capture break logging) and ALWAYS forwards to the original method. */
export function installConsoleRing(opts?: ConsoleRingOptions): void {
  if (installed) return;
  installed = true;

  capacity = opts?.capacity ?? DEFAULT_CAPACITY;
  // ⚠️ CLAMPED, because `pinned` fills to `bootPrefix` before the tail's capacity is consulted at
  // all: an unclamped `bootPrefix > capacity` pins every entry and the ring grows WITHOUT BOUND,
  // turning a memory cap into a leak on the low-end hardware #154 budgets. No production caller
  // reaches it today (1000/128 and 512/128) — this guards the next one.
  bootPrefix = Math.min(opts?.bootPrefix ?? DEFAULT_BOOT_PREFIX, capacity);
  retainCallSite = opts?.retainCallSite ?? false;

  // Store the RAW references (not `.bind()`ed) — a bound copy is a distinct function object, so
  // `__resetConsoleRingForTest` restoring a bound copy instead of the original reference would
  // leave `console.log` pointing at a fresh wrapper forever, one layer deeper on every
  // install/reset cycle. Invoke via `.apply(console, …)` below instead, which needs no bind.
  const levels: ConsoleRingLevel[] = ['log', 'info', 'warn', 'error'];
  const raw = {} as Record<ConsoleRingLevel, (...args: unknown[]) => void>;
  for (const level of levels) raw[level] = console[level];
  originals = raw;

  for (const level of levels) {
    const original = raw[level];
    console[level] = (...args: unknown[]) => {
      try {
        record(level, args);
      } catch {
        /* never let capture break logging */
      }
      original.apply(console, args);
    };
  }

  // #633: console.* is now patched — drain whatever the inline early-capture shim in index.html
  // buffered before this point, so a boot-time log fired ahead of this module still lands in the
  // ring instead of being lost to the (bundled-build) reordering that motivated the shim.
  drainEarlyConsole();
}

/** Record a SYNTHETIC entry directly, without routing it through `console.*`.
 *
 *  For lines that describe something which never was a `console.*` call — an uncaught `window`
 *  error, an unhandled rejection — so they still land in the ring alongside real log output.
 *
 *  ⚠️ DO NOT "SIMPLIFY" THIS INTO A `console[level](...)` CALL. That looks tidier (one recording
 *  path instead of two) and it silently reintroduces a defect this repo already measured and fixed:
 *  `runtime/core/globalErrors.ts:490` wraps `console.error` and reports to Crashlytics, and its
 *  de-duplication (`:385-389`) only recognises a call whose SOLE argument is an `Error` OBJECT,
 *  keyed in a WeakSet. A synthetic STRING cannot match it, so routing an already-reported uncaught
 *  error back through `console.error` files a SECOND Crashlytics issue for the same fault — the
 *  "two issues per fault" symptom documented at `globalErrors.ts:366-377` (measured on a Galaxy
 *  S22, 2026-08-20). Writing straight into the ring keeps the diagnostic line and reports nothing. */
export function recordConsoleRingEntry(level: ConsoleRingLevel, args: unknown[]): void {
  record(level, args);
}

/** Bumped by `__resetConsoleRingForTest()`. A consumer holding a clear WATERMARK (a `seq` value)
 *  compares epochs to know its watermark belongs to a ring that no longer exists.
 *
 *  It is the ring's IDENTITY, deliberately, not its position. Both position-based tests fail: `seq`
 *  and `version` both restart at 0, so `reset -> log once` lands them right back on values the
 *  consumer already observed — a "did it go backwards" check never fires, and a "is my watermark
 *  above the highest seq" check sees 1 > 1 and says no. Only an identity that never repeats can
 *  answer this, and both wrong versions of it were written here before this comment was. */
export function getConsoleRingEpoch(): number {
  return ringLiveness.generation;
}

/** Entries with `seq > sinceSeq` (all of them when omitted), pinned prefix then rolling tail, in
 *  seq order. Backs a per-consumer clear-via-watermark design: a consumer "clears" by advancing
 *  its own remembered `sinceSeq`, never by truncating this shared buffer. */
export function getConsoleRingEntries(sinceSeq?: number): ConsoleRingEntry[] {
  // ⚠️ ALWAYS a fresh array, never `pinned`/`tail` themselves. Four consumers now read this one
  // buffer, so handing any of them a live internal reference would let a stray `.reverse()`,
  // `.sort()` or `.push()` in one of them silently corrupt what every other consumer — and
  // `/api/console-logs` — sees. The `sinceSeq` branch already copied via `.filter()`; the
  // no-argument branch used to return the internal array directly, which was the inconsistent half.
  const all = [...pinned, ...tail];
  if (sinceSeq === undefined) return all;
  return all.filter((e) => e.seq > sinceSeq);
}

/** Monotonic — bumps synchronously on every record. Use as a `useSyncExternalStore` snapshot. */
export function getConsoleRingVersion(): number {
  return version;
}

/** How many rolling-tail entries have been evicted so far — lets a reader render a gap marker
 *  between the pinned boot prefix and the surviving tail.
 *
 *  ⚠️ THIS IS THE DISCLOSURE THAT MATTERS, and until #596/#597 close-out review nothing in
 *  production called it. Once the ring wraps, `[pinned] ++ [tail]` is DISCONTIGUOUS — an editor at
 *  `capacity:1000, bootPrefix:128` that logs 5000 lines holds entries 1-128 then 4129-5000, and
 *  every reader that just concatenates the two halves presents that as one continuous log. An agent
 *  reading it would conclude the app logged nothing between boot and whatever produced the flood.
 *  `console-logs`'s agent op (`agentBridge.ts`), `handleConsoleLogs` (device path, `bridge.ts`) and
 *  `ConsoleTab.tsx` all now surface this value so a non-zero read is visible, not silently implied
 *  contiguous. */
export function getConsoleRingDropped(): number {
  return dropped;
}

/** How many of the pinned boot-prefix entries exist right now — climbs from 0 up to `bootPrefix` as
 *  boot proceeds, then holds there for the rest of the session (pinned entries are never evicted).
 *  Since `pinned` is always the ring's very first N records, contiguous by construction, an entry's
 *  `seq` is in the pinned prefix iff `seq <= getConsoleRingBootPrefixCount()`. This is the minimal
 *  accessor a reader needs to draw the boundary `getConsoleRingDropped()` warns about — e.g.
 *  `ConsoleTab.tsx` renders a separator exactly where an entry's `seq` crosses it. */
export function getConsoleRingBootPrefixCount(): number {
  return pinned.length;
}

/** `fn` runs on a `queueMicrotask`, never synchronously from inside a `console.*` call — a
 *  synchronous notify from a warn/error raised during render would be a setState-during-render
 *  from the caller's perspective (see `runtime/debug/consoleCapture.ts`'s `bump()` doc comment for
 *  the measured incident this mirrors), and is pinned by
 *  `engine/tests/ui/debugErrorToaster.test.tsx:84`'s sibling ring. `version` still bumps
 *  immediately, so a snapshot taken right after a log call is already correct even before the
 *  microtask runs. */
export function subscribeConsoleRing(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function isConsoleRingInstalled(): boolean {
  return installed;
}

/** Test-only: restore the real console methods, clear the buffer, and reset every counter. */
export function __resetConsoleRingForTest(): void {
  if (originals) {
    for (const level of Object.keys(originals) as ConsoleRingLevel[]) {
      console[level] = originals[level];
    }
  }
  originals = null;
  installed = false;
  recording = false;
  notifyScheduled = false;
  pinned = [];
  tail = [];
  seq = 0;
  version = 0;
  dropped = 0;
  capacity = DEFAULT_CAPACITY;
  bootPrefix = DEFAULT_BOOT_PREFIX;
  ringLiveness.invalidateAll();
  retainCallSite = false;
  listeners.clear();
  // #633: clear the early shim's published state so a test that seeds it (or a real one that ran
  // earlier in the same process) does not leak a "done" or partially-drained buffer into the next.
  delete (globalThis as { __MODOKI_EARLY_CONSOLE__?: EarlyConsoleState }).__MODOKI_EARLY_CONSOLE__;
}
