import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { earlyConsoleShimPlugin, type EarlyConsoleShimPluginOptions } from '../../plugins/earlyConsoleShim';
import { MAX_PER_BURST_WINDOW, STASH_KEY } from '../../packages/modoki/src/runtime/core/globalErrors';
import { clearAppServices } from '../../packages/modoki/src/runtime/core/appServices';
import { setManualEpoch, restoreRealEpoch } from '../../packages/modoki/src/runtime/core/clock';

// The engine lane's jsdom environment supplies `sessionStorage` but NOT `localStorage` (confirmed
// empirically — `typeof localStorage` is `'undefined'` here, on both `window` and `globalThis`).
// `hierarchyCollapse.test.ts` hit the same gap first; this follows its exact fix: back it with a
// REAL in-memory map, not a no-op stub, so the stash round-trip assertions below (#825) are not
// vacuous — a stub that only no-ops would make every "read back what was written" check pass
// whether or not `stashEarlyErrors()`/`drainStashedEarlyErrors()` actually do anything.
const localStorageBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (localStorageBacking.has(k) ? localStorageBacking.get(k)! : null),
  setItem: (k: string, v: string) => { localStorageBacking.set(k, String(v)); },
  removeItem: (k: string) => { localStorageBacking.delete(k); },
  clear: () => { localStorageBacking.clear(); },
});
afterAll(() => { vi.unstubAllGlobals(); });

/**
 * The fatal-load guard's early-error buffer (#636) — modeled on `earlyConsoleShim.test.ts`'s F6
 * block ("runs the ACTUAL page script, not a model of it"), which #633 wrote for the sibling
 * `__MODOKI_EARLY_CONSOLE__` shim. This is the equivalent for `window` `error`/`unhandledrejection`,
 * which that shim cannot see AT ALL — a module-eval throw fires an `ErrorEvent`, never a
 * `console.error` call, so only an early `window` listener can catch it.
 *
 * The guard (`engine/index.html:8-90`) is the earliest thing in the page that CAN catch it: it
 * registers both listeners at HTML-parse time, before rolldown's bundled entry chunk has run a
 * single static import (see `errorCaptureInstallOrder.test.ts`'s #636 caveat for the measured byte
 * offsets this covers on a boot that COMPLETES — #825 is the boot that never does).
 * `installGlobalErrorHandlers` (`runtime/core/globalErrors.ts`) drains it —
 * see `globalErrors.test.ts`'s "early error buffer drain (#636)" describe block for the seed-based
 * unit tests of THAT half; this file proves the actual `<script>` text does what those tests model.
 */

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX_HTML = path.join(engineDir, 'index.html');
const START_MARKER = '<!-- modoki:early-console:start -->';

// ⚠️ **File-wide test isolation, not scoped to one describe block.** Two DIFFERENT things in this
// file register real `window` `error`/`unhandledrejection` listeners that nothing ever removes —
// the guard's IIFE (`new Function(js)()`, re-run fresh per test) and `installGlobalErrorHandlers()`
// itself (called directly by several tests below) — because neither's PRODUCTION code ever needs
// to uninstall; a page installs once for its whole life. Within one test file, both accumulate on
// the SAME shared jsdom `window` across every `it()`.
//
// While `consider()` gated on `isLoadError`, a stale GUARD listener was harmless: every message
// this file dispatches either matched the pattern or didn't, consistently, so a stale closure
// re-invoked by a later test's dispatch took the same branch it always would have. #823 removed
// that gate, so a stale guard closure can now schedule its own fallback-screen timer in response to
// an unrelated test's dispatch.
//
// A stale `installGlobalErrorHandlers()` listener is worse, and this is not hypothetical — it is
// what MEASURABLY broke the #825 replay test while writing it: that listener calls
// `captureToCrashlytics` directly (not through a per-test buffer object, so there is no
// "orphaned, nobody reads it" escape hatch the guard's own buffering gets), and `captureToCrashlytics`
// spends the SAME shared, real-wall-clock burst-window budget (`MAX_PER_BURST_WINDOW`) every other
// call in the process does. A stale listener from an early test reacting to a LATER test's
// `window.dispatchEvent(...)` — including ones this file already made before #823/#825, like the
// EARLY_ERROR_CAP test's 40 dispatches — quietly spends that budget, and by the time a much later
// test needs to prove ITS OWN report got through, the window is already exhausted and `allow()`
// silently refuses it. `trackWindowListeners` wraps a callback that registers `window` listeners
// (the guard script, or `installGlobalErrorHandlers()`) and removes exactly the ones IT added once
// the test ends, so no test's dispatch can reach another test's stale closure. It ALSO snapshots
// `console.error`/`console.warn` before `fn()` runs and restores them in that SAME teardown —
// `installGlobalErrorHandlers()` wraps both on every install and never unwraps them
// (`__resetGlobalErrorsForTest({uninstall:true})` clears only the `installed` latch), so without
// this a later re-install in this file would capture THIS call's wrapper as "the original" and
// layer another one on top of it. Measured before this fix: 5 installs across 5 separate tests
// (each reset with `uninstall:true` after, never touching `console.*`), then ONE `console.warn` in
// a 6th test, produced THREE reports (capped there by `MAX_REPEATS_PER_MESSAGE`, not by the actual
// wrapper count of 5) instead of one — the same budget-exhaustion class this helper exists to stop,
// just for the console wrapper instead of the window listener. Harmless for callers that only wrap
// the guard script (`runGuardScript`), which never touches `console.*` at all.
//
// ⚠️ **What this helper does NOT undo, and cannot.** `installGlobalErrorHandlers()` also calls
// `onAppServicesRegistered(flushQueue)` (`appServices.ts`), and that list has no removal API —
// `appServices.ts:71`'s own doc comment calls it permanent ("Never removed — the listeners are
// process-level"). Every direct `installGlobalErrorHandlers()` call below therefore leaves one more
// `flushQueue` registration for the life of this file's test run; that residual is ACCEPTED, not
// fixed, and is unrelated to the window-listener and console-wrapper leaks this helper DOES close.
let trackedListenerCleanups: Array<() => void> = [];
function trackWindowListeners<T>(fn: () => T): T {
  const added: Array<[string, EventListenerOrEventListenerObject]> = [];
  const realAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    added.push([type, listener]);
    realAddEventListener(type, listener);
  }) as typeof window.addEventListener;
  const realConsoleError = console.error;
  const realConsoleWarn = console.warn;
  try {
    return fn();
  } finally {
    window.addEventListener = realAddEventListener;
    trackedListenerCleanups.push(() => {
      for (const [type, listener] of added) window.removeEventListener(type, listener);
      console.error = realConsoleError;
      console.warn = realConsoleWarn;
    });
  }
}
function runGuardScript(js: string): void {
  trackWindowListeners(() => { new Function(js)(); });
}
/** Run and clear every pending `trackWindowListeners` cleanup — what the file-level `afterEach`
 *  below calls after every test. Exposed as its own function so a regression test can simulate the
 *  boundary BETWEEN two `trackWindowListeners` calls from within one `it()` — reproducing what N
 *  SEPARATE tests' worth of install+teardown would leave behind, deterministically, rather than
 *  relying on real `it()` boundaries whose relative order `--sequence.shuffle.tests` can reorder.
 *
 *  ⚠️ **Runs cleanups in REVERSE (LIFO) order — this is load-bearing, not a style choice.** Several
 *  tests below call `trackWindowListeners` MORE THAN ONCE before any cleanup fires (e.g. the #825
 *  replay test installs, resets, then installs again). The window-listener half of each cleanup is
 *  order-independent (each removes exactly the specific listener references it captured), but the
 *  CONSOLE half is not: `console.warn`/`console.error` restoration is a WRAP-AROUND-CURRENT-VALUE
 *  stack, not a flat add/remove set. If install #2 runs before install #1's cleanup, it wraps
 *  AROUND #1's wrapper and its own snapshot IS that wrapper — restoring FIFO (#1 first, then #2)
 *  puts the real original back only for #2's cleanup to immediately overwrite it with #1's stale
 *  wrapper. Restoring LIFO (#2 first, then #1) unwinds the stack in the order it was built, same as
 *  any nested try/finally. Measured: FIFO order left a real, single-layer stale `console.warn`
 *  wrapper active after `afterEach`, caught only under `--sequence.shuffle.tests` when a LATER test
 *  observed it as its own "before" baseline. */
function flushTrackedListenerCleanups(): void {
  for (let i = trackedListenerCleanups.length - 1; i >= 0; i--) trackedListenerCleanups[i]();
  trackedListenerCleanups = [];
}
// ⚠️ The SECOND leak that measurably broke a PRE-EXISTING #636 test while writing these (found
// under `--sequence.shuffle.tests`, not by inspection): `appServices.ts`'s `registered` object is
// ALSO module-level and outlives every test that calls `registerAppServices({ crashlytics })`
// without a matching `clearAppServices()` after it — several tests below intentionally register
// their OWN crashlytics sink to observe a replay. Left in place, a LATER test's
// `drainEarlyErrors()`/`drainStashedEarlyErrors()` (both fire synchronously inside
// `installGlobalErrorHandlers()`, before that test gets a chance to register its own sink) deliver
// straight into the stale sink instead of queuing — so the later test's own, freshly-declared
// `errors` array never receives anything, and it looks exactly like a reporting bug that isn't one.
afterEach(() => {
  flushTrackedListenerCleanups();
  clearAppServices();
});

// Regression test for the console-wrapper half of the leak `trackWindowListeners` exists to close
// (see its header comment above for the mechanism and the measured symptom). `flushTrackedListenerCleanups()`
// simulates the boundary between N SEPARATE tests, each doing one install+reset, so this reproduces
// the actual CROSS-TEST leak rather than a within-one-test loop (which would never even exercise
// the teardown under test here, since nothing would flush until this test's own end).
describe('trackWindowListeners also restores console.error/console.warn between installs (not just window listeners)', () => {
  it('5 installs, each torn down at its own simulated test boundary, then ONE console.warn reports exactly ONCE', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();
    // `queued` (globalErrors.ts) is a SHARED module-level array, not per-install — a stray item
    // left there by an unrelated EARLIER test (one that captured something but never registered a
    // crashlytics sink to flush it) would otherwise ride into THIS test's `reports` the moment
    // `registerAppServices()` below calls every registered `flushQueue`. Reset before touching
    // anything, not just after — `uninstall:true` also guarantees `installed` starts false so the
    // very first loop iteration actually installs rather than silently no-op'ing.
    g.__resetGlobalErrorsForTest({ uninstall: true });
    try {
      // 5 simulated separate tests: install, reset (uninstall only — that never touches
      // `console.*`, see `installGlobalErrorHandlers`'s own doc comment), then the test-boundary
      // cleanup `trackWindowListeners` defers to `afterEach`, run explicitly here instead.
      for (let i = 0; i < 5; i++) {
        trackWindowListeners(() => g.installGlobalErrorHandlers());
        g.__resetGlobalErrorsForTest({ uninstall: true });
        flushTrackedListenerCleanups();
      }

      // A 6th "test" that actually wants error reporting — left for the real `afterEach` to clean
      // up, same as any other test in this file.
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      const reports: string[] = [];
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { reports.push(m); }, log: () => {} } });
      console.warn('one warning, after five prior installs');

      // Before the console-wrapper fix: 5 leaked wrappers + this test's own = 6 layered calls to
      // `captureToCrashlytics('warn', ...)` for one real `console.warn()`, capped at 3 by
      // `MAX_REPEATS_PER_MESSAGE` (not by the actual wrapper count) — never 1.
      expect(reports).toHaveLength(1);
    } finally {
      g.__resetGlobalErrorsForTest({ uninstall: true });
      a.clearAppServices();
    }
  });

  // The LIFO-vs-FIFO restore order (`flushTrackedListenerCleanups`'s header comment above explains
  // the mechanism) was previously observable ONLY under `--sequence.shuffle.tests`, which the gate
  // does not run — mutation-verified: reverting the loop to FIFO order is 18/18 green in this
  // file's default run order. This test does not depend on shuffle: it builds the same "several
  // installs with cleanups still PENDING at once" shape the #825 replay test happens to produce as
  // a side effect, deliberately, in one `it()`.
  it('nested installs restore console.error/console.warn in LIFO order — FIFO leaves a stale wrapper active', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();
    g.__resetGlobalErrorsForTest({ uninstall: true });

    const originalError = console.error;
    const originalWarn = console.warn;
    try {
      // Three installs, none flushed until after all three — each one's `trackWindowListeners`
      // snapshots console.error/warn BEFORE its own install, so install #2 captures install #1's
      // wrapper (not the real original), and #3 captures #2's. `__resetGlobalErrorsForTest`
      // between them only clears the `installed` latch — never console.* — so each subsequent
      // `installGlobalErrorHandlers()` call wraps AROUND whatever the previous one left in place.
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      g.__resetGlobalErrorsForTest({ uninstall: true });
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      g.__resetGlobalErrorsForTest({ uninstall: true });
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      g.__resetGlobalErrorsForTest({ uninstall: true });

      flushTrackedListenerCleanups();

      // LIFO unwinds the wrap-around stack in the order it was built (same as nested try/finally)
      // and lands back on the real original. FIFO restores the OLDEST snapshot (the real original)
      // FIRST, only for the next cleanup to immediately overwrite it with a still-wrapped console.*.
      expect(console.error).toBe(originalError);
      expect(console.warn).toBe(originalWarn);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      g.__resetGlobalErrorsForTest({ uninstall: true });
      a.clearAppServices();
    }
  });
});

// ⚠️ **Deliberately NOT routed through `readScannedSource` (#812 migration, considered and
// declined).** That reader has no HTML mode — `.html` is absent from its extension map — and
// forcing the JS-comment stripper over this file would not do what it does for a `.ts` guard:
// `//`/`/* */` stripping leaves the `<!-- modoki:early-console:start/end -->` HTML comments
// (this file's own `START_MARKER` and the second describe block below) completely untouched,
// since JS and HTML use different comment syntax — so it would not close the hole the migration
// is for, while dressing the read up as migrated. Worse, several assertions here are genuinely
// ABOUT that raw text on purpose, not merely tolerant of it: the second describe block checks the
// LITERAL output of `earlyConsoleShimPlugin`'s `transformIndexHtml` (a build-plugin transform,
// not hand-written source a human could hide a call in) for the presence/absence of the HTML
// comment markers themselves. Stripping first would make that check meaningless. The first
// describe block extracts the inline `<script>` text and executes it with `new Function(js)()` —
// comments have no effect on execution either way — so the residual risk (an `extractEarlyErrorCap`
// regex match landing on a decoy in a `//` comment) is real but narrow, and forcing an
// HTML-unaware fix for it risks being wrong in a way nobody would notice, which is worse than
// leaving it raw with this note.

/** Extract the FIRST inline `<script>...</script>` block in `engine/index.html` — the fatal-load
 *  guard, which sits BEFORE the `modoki:early-console:start` marker and carries the #636 buffer.
 *  Not the #633 console shim's block (that one lives between the markers). */
function extractFatalLoadGuardScript(html: string): string {
  const firstOpen = html.indexOf('<script>');
  if (firstOpen === -1) throw new Error('no bare <script> tag found (the fatal-load guard)');
  const firstClose = html.indexOf('</script>', firstOpen);
  if (firstClose === -1) throw new Error("the fatal-load guard's <script> has no closing tag");
  const markerIdx = html.indexOf(START_MARKER);
  if (markerIdx !== -1 && firstClose >= markerIdx) {
    throw new Error('the first <script> block must close before the early-console shim starts — did a block get reordered?');
  }
  return html.slice(firstOpen + '<script>'.length, firstClose);
}

/** Read the guard's own `EARLY_ERROR_CAP` literal out of the script text, rather than a hardcoded
 *  restatement — the whole point of the test below that uses this (#682 close-out round 3,
 *  MEDIUM 3) is to fail when this literal drifts, which a copy of the literal could not do. */
function extractEarlyErrorCap(js: string): number {
  const m = js.match(/var EARLY_ERROR_CAP = (\d+);/);
  if (!m) throw new Error('could not find `var EARLY_ERROR_CAP = <n>;` in the fatal-load guard script');
  return Number(m[1]);
}

describe('fatal-load guard early-error buffer (#636) — runs the ACTUAL page script, not a model of it', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  // Each test below executes the real IIFE fresh (via `runGuardScript`, module-scoped above),
  // which re-registers its OWN `window` listeners and reassigns `globalThis.__MODOKI_EARLY_ERRORS__`
  // to a brand-new object. `runGuardScript`'s own `afterEach` removes the listeners it just added,
  // so a stale closure from an earlier test cannot react to a later test's dispatch — see its
  // comment for why that stopped being merely "inert" once #823 removed `consider()`'s message gate.
  afterEach(() => {
    delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;
  });

  it('assigns globalThis.__MODOKI_EARLY_ERRORS__ and buffers a real ErrorEvent, drained into exactly one recordError', async () => {
    const js = extractFatalLoadGuardScript(html);
    runGuardScript(js);

    const seeded = (globalThis as { __MODOKI_EARLY_ERRORS__?: { entries: unknown[] } }).__MODOKI_EARLY_ERRORS__;
    expect(seeded).toBeTruthy();
    expect(seeded!.entries).toEqual([]);

    const err = new Error('module-eval-boom');
    err.stack = 'Error: module-eval-boom\n  at graph (App.tsx:1:1)';
    // No `#root` exists in this test's DOM, so `consider()` bails at its `!root` check before it
    // can schedule the fallback-screen timer — this test is about the BUFFER, not the fallback
    // screen (that path is `earlyErrorBuffer.test.ts`'s #823/#825 describe block, further below).
    window.dispatchEvent(
      new ErrorEvent('error', { error: err, message: 'module-eval-boom', filename: 'App.tsx', lineno: 12, colno: 3 }),
    );

    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    const errors: string[] = [];
    try {
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('[uncaught-early]');
      expect(errors[0]).toContain('module-eval-boom');
      expect(errors[0]).toContain('(App.tsx:12:3)');
    } finally {
      g.__resetGlobalErrorsForTest({ uninstall: true });
    }
  });

  it('caps the buffer at EARLY_ERROR_CAP entries (#682 MEDIUM 3 — below MAX_PER_BURST_WINDOW) and counts the rest as dropped, without touching the report pipeline', () => {
    const js = extractFatalLoadGuardScript(html);
    const cap = extractEarlyErrorCap(js);
    runGuardScript(js);

    const overflow = 12; // arbitrary margin past the cap — not itself load-bearing, unlike `cap`
    for (let i = 0; i < cap + overflow; i++) {
      // No `#root` exists, so `consider()` bails immediately on every dispatch and this test
      // exercises ONLY the buffer's own cap/drop-newest logic — the same isolation
      // `earlyConsoleShim.test.ts`'s "300 calls -> 256 kept + 44 dropped" cap-path test uses.
      window.dispatchEvent(new ErrorEvent('error', { error: new Error(`e${i}`), message: `e${i}` }));
    }

    const state = (globalThis as { __MODOKI_EARLY_ERRORS__?: { entries: unknown[]; dropped: number } }).__MODOKI_EARLY_ERRORS__!;
    expect(state.entries).toHaveLength(cap);
    expect(state.dropped).toBe(overflow);
  });

  // #682 close-out round 3, MEDIUM 3: nothing previously connected `EARLY_ERROR_CAP` to
  // `MAX_PER_BURST_WINDOW` — the two were only related by a HAND-KEPT comment on each side, and
  // that is exactly how the cap drifted to 32 (2 OVER the -2 headroom it needs) before being
  // caught by inspection rather than by a test. `globalErrors.ts`'s own comment above
  // `MAX_PER_BURST_WINDOW` derives the `-2`: 1 slot for a `[reload]` breadcrumb that can already
  // have fired, 1 for the drain's own "N dropped" breadcrumb — both go through the SAME shared
  // limiter as this cap's own entries, in one synchronous burst.
  it('EARLY_ERROR_CAP never exceeds MAX_PER_BURST_WINDOW - 2, the shared limiter headroom it must leave', () => {
    const js = extractFatalLoadGuardScript(html);
    const cap = extractEarlyErrorCap(js);
    expect(cap).toBeLessThanOrEqual(MAX_PER_BURST_WINDOW - 2);
  });

  it('buffers an unhandledrejection by reference, not a clone or a string', () => {
    const js = extractFatalLoadGuardScript(html);
    runGuardScript(js);

    const reason = new Error('rejected during module eval');
    const e = new Event('unhandledrejection') as Event & { reason?: unknown };
    e.reason = reason;
    window.dispatchEvent(e);

    const state = (globalThis as { __MODOKI_EARLY_ERRORS__?: { entries: Array<{ kind: string; reason?: unknown }> } })
      .__MODOKI_EARLY_ERRORS__!;
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].kind).toBe('unhandledrejection');
    expect(state.entries[0].reason).toBe(reason); // same object, not a copy
  });
});

/** Read the guard's own `STASH_MAX_ENTRIES` literal out of the script text — same reasoning as
 *  `extractEarlyErrorCap` above: the test using this must fail when the literal drifts, which a
 *  hardcoded restatement of `8` could not do. */
function extractStashMaxEntries(js: string): number {
  const m = js.match(/var STASH_MAX_ENTRIES = (\d+);/);
  if (!m) throw new Error('could not find `var STASH_MAX_ENTRIES = <n>;` in the fatal-load guard script');
  return Number(m[1]);
}

describe('fatal-load guard — #823 (widened screen gate) and #825 (cross-boot stash)', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  afterEach(() => {
    delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;
    document.body.innerHTML = '';
    localStorage.clear();
  });

  // A message shaped nothing like the old `isLoadError` pattern list (no "does not provide an
  // export", no "Cannot find module", no "SyntaxError", …) — the #823 class: a plain runtime
  // TypeError from a module that threw during evaluation, which the narrow gate always missed.
  const NON_LOAD_SHAPED_MESSAGE = "Cannot read properties of undefined (reading 'foo')";

  it('#823: a non-load-shaped error still shows the fallback screen once #root stays empty (the widened gate)', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error(NON_LOAD_SHAPED_MESSAGE), message: NON_LOAD_SHAPED_MESSAGE }),
      );
      vi.advanceTimersByTime(1400);

      const root = document.getElementById('root')!;
      // Typographic apostrophe (U+2019), matching the literal in engine/index.html's template.
      expect(root.innerHTML).toContain('Couldn’t open this project');
      expect(root.innerHTML).toContain(NON_LOAD_SHAPED_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('#823 accept side: an app that already rendered (#root has a child) is never shown the fallback screen', () => {
    document.body.innerHTML = '<div id="root"><div class="app">already rendered</div></div>';
    const before = document.getElementById('root')!.innerHTML;
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error(NON_LOAD_SHAPED_MESSAGE), message: NON_LOAD_SHAPED_MESSAGE }),
      );
      vi.advanceTimersByTime(1400);

      // The mounted-app guard (`!root || root.childElementCount > 0`) must still hold — widening
      // the message gate must not widen THIS check.
      expect(document.getElementById('root')!.innerHTML).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  // The test above dispatches a PLAIN runtime error, which never matches `isReloadRecoverable` —
  // so it cannot distinguish "the outer mounted-app guard (`index.html:198`) holds" from "only the
  // INNER duplicate check inside the 1400ms timer holds": mutation-verified, dropping the outer
  // guard's `childElementCount` check still leaves that test green, because `tryAutoReloadOnce`
  // never gets involved for a non-reload-shaped message and the inner duplicate catches it 1400ms
  // later regardless. The damaging branch a broken outer guard actually opens is THIS one: a
  // message shaped like the documented mid-session Vite re-optimize (`isReloadRecoverable`) reaches
  // `tryAutoReloadOnce()` — which calls `location.reload()` on a WORKING, already-rendered editor,
  // discarding unsaved scene edits — and does so BEFORE the 1400ms timer (and its inner duplicate
  // check) is ever scheduled. Only the outer guard stands between a populated #root and this path.
  it('#823 accept side: a reload-recoverable message on an already-rendered app never reaches tryAutoReloadOnce (must not schedule a reload)', () => {
    document.body.innerHTML = '<div id="root"><div class="app">already rendered</div></div>';
    const RELOAD_TS_KEY = 'modoki-optimize-reload-ts';
    sessionStorage.removeItem(RELOAD_TS_KEY);
    const realLocation = window.location;
    const reloadSpy = vi.fn();
    // jsdom's window.location.reload is not implemented AND not directly spy-able (its properties
    // are non-configurable) — replace the whole `location` object, same pattern as
    // `editorBootBoundary.test.tsx`/`hmrStaleness.test.ts`. Restored in the `finally` below.
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload: reloadSpy } });
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('does not provide an export'), message: 'does not provide an export' }),
      );
      vi.advanceTimersByTime(1400);

      // The more robust signal (per the brief): `tryAutoReloadOnce()` writes this key
      // SYNCHRONOUSLY, before its own 300ms reload timer even fires — its absence proves the
      // reload path was never entered at all, not merely that the reload hasn't fired yet.
      expect(sessionStorage.getItem(RELOAD_TS_KEY)).toBeNull();
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  // #823 close-out review — detail selection (`consider()`'s post-buffer `msg` derivation, the
  // block just above `stashEarlyErrors()` in the guard script) had ZERO coverage before these:
  // mutation-verified by replacing the whole selection block with `detail = msg` and confirming
  // every test below goes red (mutation-check results reported in the close-out summary).

  it('#823 review: a stackless benign error (e.g. ResizeObserver) never wins over a later stacked error', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      // Real browsers set `e.error === null` for this one — stackless by construction, and the
      // original motivating case for the widened #823 gate.
      window.dispatchEvent(new ErrorEvent('error', { error: null, message: 'ResizeObserver loop limit exceeded' }));
      const boom = new TypeError('registerTrait undefined');
      boom.stack = 'TypeError: registerTrait undefined\n  at graph (App.tsx:1:1)';
      window.dispatchEvent(new ErrorEvent('error', { error: boom, message: boom.message }));
      vi.advanceTimersByTime(1400);

      const root = document.getElementById('root')!;
      expect(root.innerHTML).toContain('registerTrait undefined');
      expect(root.innerHTML).not.toContain('ResizeObserver loop limit exceeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('#823 review: prefers the FIRST stacked error over a later stacked cascade symptom (LAST-with-a-stack picked the wrong one)', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      const rootCause = new Error('ROOTCAUSE registerTrait undefined');
      rootCause.stack = 'Error: ROOTCAUSE registerTrait undefined\n  at graph (App.tsx:1:1)';
      window.dispatchEvent(new ErrorEvent('error', { error: rootCause, message: rootCause.message }));
      // A cascade symptom of the root cause above — e.g. a dynamic import of a module the first
      // throw prevented from ever registering. Also happens to match `isReloadRecoverable`, which
      // is irrelevant here: that check only ever looks at the FIRST error's `msg`.
      const cascade = new Error('CASCADE Failed to fetch dynamically imported module');
      cascade.stack = 'Error: CASCADE Failed to fetch dynamically imported module\n  at loader (chunk.js:1:1)';
      window.dispatchEvent(new ErrorEvent('error', { error: cascade, message: cascade.message }));
      vi.advanceTimersByTime(1400);

      const root = document.getElementById('root')!;
      expect(root.innerHTML).toContain('ROOTCAUSE registerTrait undefined');
      expect(root.innerHTML).not.toContain('CASCADE Failed to fetch dynamically imported module');
    } finally {
      vi.useRealTimers();
    }
  });

  it('#823 review: a stacked error with an empty carried message falls back to msg, not an empty detail box', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      // `err.message` is '' (present, a string) — `deriveEntryMessage` returns it AS-IS without
      // falling back to the ErrorEvent's own, perfectly good, `message`. Before the fix this
      // discarded a correct `msg` for an empty detail box.
      const err = new Error('');
      err.stack = 'at worker (w.js:1:1)';
      window.dispatchEvent(new ErrorEvent('error', { error: err, message: 'a worker script threw' }));
      vi.advanceTimersByTime(1400);

      const root = document.getElementById('root')!;
      expect(root.innerHTML).toContain('a worker script threw');
      expect(root.innerHTML).not.toContain('[object Object]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('#823 review: a stacked rejection reason with an empty message falls back to msg, not "[object Object]"', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      // `reason.message` is '' (present, a string) — same short-circuit as the error case above,
      // but on the rejection branch (`deriveEntryMessage`'s `safeStashString(carried)` fallback).
      const reason = {
        stack: 'at worker (w.js:1:1)',
        message: '',
        toString() { return 'rejected during module eval'; },
      };
      const e = new Event('unhandledrejection') as Event & { reason?: unknown };
      e.reason = reason;
      window.dispatchEvent(e);
      vi.advanceTimersByTime(1400);

      const root = document.getElementById('root')!;
      expect(root.innerHTML).toContain('rejected during module eval');
      expect(root.innerHTML).not.toContain('[object Object]');
    } finally {
      vi.useRealTimers();
    }
  });

  // The `if (earlyErrors.done) return;` guard at the TOP of `stashEarlyErrors()` (untested before
  // this — deleting it leaves everything else in this file green). Drives the real sequence: fill
  // past the cap so `dropped > 0`, drain for real via `installGlobalErrorHandlers()` (which sets
  // `done = true` and empties `entries`), THEN dispatch one more error and let the already-pending
  // fallback-screen timer fire.
  it('stashEarlyErrors bails once installGlobalErrorHandlers has drained the buffer — no stale-dropped stash', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      const cap = extractEarlyErrorCap(js);
      runGuardScript(js);

      // Past the cap, so `earlyErrors.dropped > 0` — the stale count that would otherwise leak
      // into a post-drain stash if the `done` guard were missing.
      const overflow = 5;
      for (let i = 0; i < cap + overflow; i++) {
        window.dispatchEvent(new ErrorEvent('error', { error: new Error(`fill${i}`), message: `fill${i}` }));
      }

      const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
      const a = await import('../../packages/modoki/src/runtime/core/appServices');
      a.clearAppServices();
      try {
        trackWindowListeners(() => g.installGlobalErrorHandlers());
        a.registerAppServices({ crashlytics: { recordError: () => {}, log: () => {} } });

        // One more error AFTER the drain. `bufferEarlyError`'s OWN `done` check already refuses to
        // buffer it, but the pending fallback-screen timer (scheduled on the very first fill error
        // above) is still armed and about to call `stashEarlyErrors()`.
        window.dispatchEvent(new ErrorEvent('error', { error: new Error('after-drain'), message: 'after-drain' }));
        vi.advanceTimersByTime(1400);

        expect(localStorage.getItem(STASH_KEY)).toBeNull();
      } finally {
        g.__resetGlobalErrorsForTest({ uninstall: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('#825: a boot-killing error is stashed to localStorage before the fallback screen renders, and installGlobalErrorHandlers is never involved', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('module-eval-boom'), message: 'module-eval-boom', filename: 'App.tsx', lineno: 4, colno: 2 }),
      );
      // This is the production shape and the whole point of #825: `installGlobalErrorHandlers`
      // is NEVER called in this test. A boot fatal enough to reach the fallback screen is exactly
      // the boot where that installer never runs — the stash has to work with nothing else alive.
      vi.advanceTimersByTime(1400);
    } finally {
      vi.useRealTimers();
    }

    const raw = localStorage.getItem(STASH_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { v: number; entries: Array<Record<string, unknown>> };
    expect(parsed.v).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ kind: 'error', message: 'module-eval-boom', filename: 'App.tsx', lineno: 4, colno: 2 });
  });

  it('#825: a stash from one boot is replayed exactly once by installGlobalErrorHandlers() on the next, then never again', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      runGuardScript(js);
      window.dispatchEvent(
        new ErrorEvent('error', { error: new Error('boot-killer'), message: 'boot-killer', filename: 'App.tsx', lineno: 3, colno: 7 }),
      );
      vi.advanceTimersByTime(1400);
    } finally {
      vi.useRealTimers();
    }
    // The fixture is the REAL serializer's output (written by the guard script above), not a
    // hand-written guess at the shape.
    expect(localStorage.getItem(STASH_KEY)).toBeTruthy();

    // Simulate the NEXT boot: this boot's own (already-stashed) live buffer is gone, the way a
    // fresh page load's buffer would be empty rather than holding a prior boot's entries.
    delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;

    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    // `appServices.ts`'s `registered` is module-level and this file never `vi.resetModules()`s —
    // an EARLIER test's `registerAppServices({ crashlytics })` call leaks forward otherwise, and
    // the replay below would silently report into that stale sink instead of being queued for
    // THIS test's own registration a moment later.
    a.clearAppServices();
    try {
      const errors: string[] = [];
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('[uncaught-prev-boot]');
      expect(errors[0]).toContain('boot-killer');
      expect(localStorage.getItem(STASH_KEY), 'clear-on-read: the stash must be gone after one replay').toBeNull();

      // Replay-once: reset (so the `installed` latch alone cannot be credited for the silence)
      // and install again — nothing must be left to replay.
      g.__resetGlobalErrorsForTest({ uninstall: true });
      errors.length = 0;
      trackWindowListeners(() => g.installGlobalErrorHandlers());
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });
      expect(errors, 'nothing must be replayed a second time').toHaveLength(0);
    } finally {
      g.__resetGlobalErrorsForTest({ uninstall: true });
    }
  });

  it('#825 bounds: stashes at most STASH_MAX_ENTRIES entries and counts the rest as dropped', () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.useFakeTimers();
    try {
      const js = extractFatalLoadGuardScript(html);
      const maxEntries = extractStashMaxEntries(js);
      runGuardScript(js);
      const total = 20;
      for (let i = 0; i < total; i++) {
        window.dispatchEvent(new ErrorEvent('error', { error: new Error(`e${i}`), message: `e${i}` }));
      }
      vi.advanceTimersByTime(1400);

      const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { entries: unknown[]; dropped: number };
      expect(parsed.entries).toHaveLength(maxEntries);
      expect(parsed.dropped).toBe(total - maxEntries);
    } finally {
      vi.useRealTimers();
    }
  });

  // Same class of gap `EARLY_ERROR_CAP`'s own pin above closes, applied to `STASH_MAX_ENTRIES`:
  // nothing previously connected it to `MAX_PER_BURST_WINDOW`, so raising the literal (e.g. to 28)
  // currently passes every other test in this file silently — the same way `EARLY_ERROR_CAP` itself
  // once drifted 2 OVER its own headroom before a test caught it.
  //
  // The bound is deliberately NOT `STASH_MAX_ENTRIES <= MAX_PER_BURST_WINDOW - EARLY_ERROR_CAP`
  // (that would be `<= 2`, and the CURRENT, intentionally-chosen value of 8 already fails it) —
  // that bound assumes the REPLAYING boot's own early buffer is simultaneously at its own
  // `EARLY_ERROR_CAP` worst case, sharing the same burst window with the stash replay. It structurally
  // cannot be: a stash only replays on a boot that FOLLOWS a boot fatal enough to die before
  // `installGlobalErrorHandlers` ever ran, so the replaying boot's own live buffer is near-empty by
  // construction. The honest bound only needs to leave room for the drain's own two breadcrumbs —
  // a possible `[reload]` breadcrumb, and the stash's own "N dropped" breadcrumb — alongside
  // `STASH_MAX_ENTRIES` worth of replayed entries, all through the SAME shared burst window.
  it('STASH_MAX_ENTRIES leaves room for the replaying boot\'s [reload] + dropped-count breadcrumbs in the shared burst window', () => {
    const js = extractFatalLoadGuardScript(html);
    const maxEntries = extractStashMaxEntries(js);
    // The tail this does NOT cover — both this boot's own early-buffer drain AND the stash replay
    // hitting MAX_PER_BURST_WINDOW's true worst case in the SAME window — is remote (the replaying
    // boot's own buffer being simultaneously full requires a SECOND fatal, near-boot-killing burst
    // on the very next launch) and, if it ever happens, completely silent: clear-on-read has already
    // removed the stash key by the time anything could re-derive that this bound was exceeded, and
    // the dropped-count breadcrumb itself would simply be refused by the same window it is trying to
    // report on.
    // A cross-boot replay is a GUEST in this boot's budget, so the bound is a FRACTION, not the
    // leftover. `maxEntries + 2 <= MAX_PER_BURST_WINDOW` (the arithmetic worst case) is useless as a
    // guard: it permits 28, which would let a previous boot's faults consume the entire window and
    // leave the live boot unable to report its own — the exact drift this pin exists to catch, and
    // the value the #823/#825 close-out review named ("raise the literal to 28 and nothing goes
    // red"). A third of the window, breadcrumbs included, keeps the other two thirds for the boot
    // that is actually running. It is TIGHT at the current 8 on purpose: raising the stash cap is
    // supposed to cost a re-derivation of the shared budget, not slip through on slack.
    expect(maxEntries + 2).toBeLessThanOrEqual(Math.floor(MAX_PER_BURST_WINDOW / 3));
  });

  it('#825 bounds: a malformed stash is discarded silently on replay — no recordError, no throw', async () => {
    localStorage.setItem(STASH_KEY, 'not json');
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices(); // see the #825 replay test above — a stale registration from an earlier
                           // test would otherwise swallow evidence of a wrongly-reported entry.
    const errors: string[] = [];
    try {
      expect(() => trackWindowListeners(() => g.installGlobalErrorHandlers())).not.toThrow();
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });
      expect(errors).toHaveLength(0);
      expect(localStorage.getItem(STASH_KEY), 'clear-on-read applies even to an unparseable stash').toBeNull();
    } finally {
      g.__resetGlobalErrorsForTest({ uninstall: true });
    }
  });

  it('#825 bounds: a wrong-version stash is discarded silently on replay — no recordError, no throw', async () => {
    localStorage.setItem(STASH_KEY, JSON.stringify({
      v: 99, ts: Date.now(), dropped: 0, entries: [{ kind: 'error', message: 'from a future format' }],
    }));
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();
    const errors: string[] = [];
    try {
      expect(() => trackWindowListeners(() => g.installGlobalErrorHandlers())).not.toThrow();
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });
      expect(errors).toHaveLength(0);
    } finally {
      g.__resetGlobalErrorsForTest({ uninstall: true });
    }
  });

  it('#825 bounds: a stash older than 7 days is discarded silently on replay — no recordError, no throw', async () => {
    // Deterministic, not real wall-clock: pin `rawEpochNow()` (what `drainStashedEarlyErrors` reads
    // to compute `stashAgeMs`) at a fixed epoch, and write the stash's `ts` 8 days before it.
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const fixedEpoch = 1_800_000_000_000;
    let g: typeof import('../../packages/modoki/src/runtime/core/globalErrors') | undefined;
    // `setManualEpoch` moved INSIDE the try (was before it): two `await import`s and a
    // `clearAppServices()` used to sit between the pin and the `finally` that restores it, so any
    // of them throwing left `_manualEpoch` pinned for the rest of this file — under
    // `--sequence.shuffle.tests`, that would make the #825 replay test discard its own stash as
    // ~55 years old.
    try {
      setManualEpoch(fixedEpoch);
      localStorage.setItem(STASH_KEY, JSON.stringify({
        v: 1, ts: fixedEpoch - eightDaysMs, dropped: 0, entries: [{ kind: 'error', message: 'a very old fault' }],
      }));
      g = await import('../../packages/modoki/src/runtime/core/globalErrors');
      const a = await import('../../packages/modoki/src/runtime/core/appServices');
      a.clearAppServices();
      const errors: string[] = [];
      expect(() => trackWindowListeners(() => g!.installGlobalErrorHandlers())).not.toThrow();
      a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });
      expect(errors).toHaveLength(0);
    } finally {
      g?.__resetGlobalErrorsForTest({ uninstall: true });
      // Only the manual EPOCH was pinned above (`setManualEpoch`) — `restoreRealClock()` no longer
      // clears it (clock.ts's epoch/monotonic split), so the matching teardown is this one.
      restoreRealEpoch();
    }
  });

  // Same reasoning as the EARLY_ERROR_CAP/MAX_PER_BURST_WINDOW pin above: the HTML guard cannot
  // import `globalErrors.ts`'s `STASH_KEY`, so the two literals are kept in sync BY HAND and only
  // a test comparing them can catch a drift.
  it('the STASH_KEY literal in engine/index.html matches the STASH_KEY globalErrors.ts reads (#825 hand-kept sync)', () => {
    const js = extractFatalLoadGuardScript(html);
    const m = js.match(/var STASH_KEY = '([^']+)';/);
    if (!m) throw new Error("could not find `var STASH_KEY = '<key>';` in the fatal-load guard script");
    expect(m[1]).toBe(STASH_KEY);
  });
});

describe('earlyConsoleShimPlugin does not strip the fatal-load guard (#636)', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const ALL_FALSE: EarlyConsoleShimPluginOptions = {
    isPlayable: false, isDev: false, hasDebugBridge: false, isEditor: false, isDebugBuild: false,
  };

  /** Mirrors `earlyConsoleShim.test.ts`'s own helper of the same name. */
  function callTransformIndexHtml(plugin: ReturnType<typeof earlyConsoleShimPlugin>, htmlIn: string): string {
    const hook = plugin.transformIndexHtml as
      | ((h: string, ctx: unknown) => string)
      | { handler: (h: string, ctx: unknown) => string }
      | undefined;
    const fn = typeof hook === 'function' ? hook : hook?.handler;
    if (typeof fn !== 'function') throw new Error('earlyConsoleShimPlugin has no transformIndexHtml hook');
    const result = fn(htmlIn, {} as unknown);
    if (typeof result !== 'string') throw new Error(`transformIndexHtml did not return a string synchronously (got ${typeof result})`);
    return result;
  }

  it('strips __MODOKI_EARLY_CONSOLE__ (#633) in a build with the gate false, but leaves __MODOKI_EARLY_ERRORS__ (#636) in place', () => {
    // ALL_FALSE is the shipped-release shape — !isPlayable && (... all false) fails the gate, so the
    // #633 shim is stripped. The fatal-load guard, and the #636 buffer inside it, is UNGATED and
    // carries no strip markers of its own (checked below) — this is what proves it survives.
    const result = callTransformIndexHtml(earlyConsoleShimPlugin(ALL_FALSE), html);

    // The ASSIGNMENT, not the bare identifier — the fatal-load guard's own #636 header comment
    // names `__MODOKI_EARLY_CONSOLE__` in prose (to explain the two buffers don't interact), so a
    // plain substring check on that identifier would pass even if the stripped block leaked back in.
    expect(result).not.toContain('globalThis.__MODOKI_EARLY_CONSOLE__ =');
    expect(result).toContain('globalThis.__MODOKI_EARLY_ERRORS__ =');
    expect(result).toContain('bufferEarlyError');
  });

  it('the fatal-load guard carries no strip markers of its own', () => {
    const guardStart = html.indexOf('<script>');
    const guardEnd = html.indexOf('</script>', guardStart);
    const guardBlock = html.slice(guardStart, guardEnd);
    expect(guardBlock).not.toContain('modoki:early-console:start');
    expect(guardBlock).not.toContain('modoki:early-console:end');
    expect(guardBlock).toContain('__MODOKI_EARLY_ERRORS__');
  });
});
