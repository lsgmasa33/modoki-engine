/**
 * The unified cross-boot stash (#861), and one test per member of the family it closes.
 *
 * The family's one mechanism: **a buffer filled during boot whose only delivery path is code that
 * runs later in that same boot.** Three sites had it — the inline guard's error buffer (#825, fixed
 * ad-hoc), the inline console shim's ring (#859), and `deliver()`'s in-memory `queued[]` (#860).
 *
 * ⚠️ MEASURED 2026-09-07, and it is why there are two console-tail sources rather than one. On a
 * `--target web` build of `games/sling` served over HTTP, a top-level throw in a module in
 * `App.tsx`'s static import graph finds BOTH inline buffers ALREADY DRAINED (`done: true`) — the
 * installers are side-effect imports above `./App.tsx` in `main.tsx` and that source order survives
 * the bundle. Only modules evaluated before `main.tsx`'s `import './installErrorCapture'` are in
 * the inline guard's window. So the common case for a dying boot is #860's window, where the RING
 * holds the log lines, not the shim.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PER_BURST_WINDOW, MAX_QUEUED } from '../../packages/modoki/src/runtime/core/globalErrors';
import {
  STASH_KEY, STASH_VERSION, REPLAY_ENTRY_CAP, CONSOLE_CONTEXT_SLOT, RESERVED_BREADCRUMBS,
  STASH_MAX_MESSAGE, STASH_MAX_STACK, STASH_MAX_CONSOLE_CHARS, CONSOLE_TAIL_LINES,
} from '../../packages/modoki/src/runtime/core/bootStash';
import { injectStashConstants, earlyConsoleShimPlugin } from '../../plugins/earlyConsoleShim';

const INDEX_HTML = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html',
);
const START_MARKER = '<!-- modoki:early-console:start -->';

// ⚠️ The engine lane's jsdom supplies `sessionStorage` but NOT `localStorage` — confirmed
// empirically here (undefined on BOTH `window` and `globalThis`), same as
// `earlyErrorBuffer.test.ts` documents. Without this stub every stash write silently no-ops
// through `bootStash.ts`'s own try/catch and the tests below would pass by asserting nothing.
const localStorageBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (localStorageBacking.has(k) ? localStorageBacking.get(k)! : null),
  setItem: (k: string, v: string) => { localStorageBacking.set(k, String(v)); },
  removeItem: (k: string) => { localStorageBacking.delete(k); },
  clear: () => { localStorageBacking.clear(); },
});

/** The fatal-load guard's inline script — the first bare `<script>`, which closes before the
 *  early-console shim's markers begin. Same extraction as `earlyErrorBuffer.test.ts`. */
function extractFatalLoadGuardScript(html: string): string {
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  const marker = html.indexOf(START_MARKER);
  if (open === -1 || close === -1) throw new Error('no bare <script> (the fatal-load guard)');
  if (marker !== -1 && close >= marker) throw new Error('guard block must close before the shim starts');
  return html.slice(open + '<script>'.length, close);
}

/** The #633 early-console shim's inline script, between the markers. */
function extractEarlyConsoleShimScript(html: string): string {
  const start = html.indexOf(START_MARKER);
  const open = html.indexOf('<script>', start);
  const close = html.indexOf('</script>', open);
  if (start === -1 || open === -1 || close === -1) throw new Error('no early-console shim block');
  return html.slice(open + '<script>'.length, close);
}

const listenerCleanups: Array<() => void> = [];
function runInlineScript(js: string): void {
  const added: Array<[string, EventListenerOrEventListenerObject]> = [];
  const realAdd = window.addEventListener.bind(window);
  const realError = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  const realInfo = console.info;
  window.addEventListener = ((t: string, l: EventListenerOrEventListenerObject) => {
    added.push([t, l]); realAdd(t, l);
  }) as typeof window.addEventListener;
  try {
    new Function(js)();
  } finally {
    window.addEventListener = realAdd;
    // LIFO, for the same reason `earlyErrorBuffer.test.ts` documents at length: console patching is
    // a wrap-around-current-value stack, so restoring in insertion order reinstates a stale wrapper.
    listenerCleanups.unshift(() => {
      for (const [t, l] of added) window.removeEventListener(t, l);
      console.error = realError; console.warn = realWarn;
      console.log = realLog; console.info = realInfo;
    });
  }
}

afterEach(async () => {
  for (const c of listenerCleanups.splice(0)) c();
  const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
  const a = await import('../../packages/modoki/src/runtime/core/appServices');
  g.__resetGlobalErrorsForTest({ uninstall: true });
  a.clearAppServices();
  delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;
  delete (globalThis as { __MODOKI_EARLY_CONSOLE__?: unknown }).__MODOKI_EARLY_CONSOLE__;
  try { localStorage.clear(); } catch { /* jsdom always has it; belt and braces */ }
  document.body.innerHTML = '';
});

describe('#861 — the divided replay budget', () => {
  /**
   * ⚠️ THE GUARD THE WHOLE CLASS ISSUE ASKS FOR. Every replay drains through the SAME limiter in
   * one synchronous burst on the replaying boot, and #825 already had to hand-pick its cap because
   * of it. Three ad-hoc stashes would have meant three independently guessed caps against one
   * undivided budget — `globalErrors.ts`'s own comment names that as the way #636's silent-drop bug
   * gets reopened. This is the arithmetic that makes adding a FOURTH source impossible to do
   * silently: it goes red on the sum, not on any single cap.
   */
  it('the replay budget stays within a THIRD of the shared burst window', () => {
    const total = REPLAY_ENTRY_CAP + CONSOLE_CONTEXT_SLOT + RESERVED_BREADCRUMBS;
    expect(
      total,
      `the cross-boot replay spends ${total} of ${MAX_PER_BURST_WINDOW} burst slots. A replay is a ` +
      'GUEST in the live boot\'s budget: exceeding a third of the window lets a PREVIOUS boot\'s ' +
      'stash crowd out the crash THIS boot is trying to report, and a limiter refusal is completely ' +
      'silent. Adding a replay source means RE-DERIVING this total, not appending another cap.',
    ).toBeLessThanOrEqual(Math.floor(MAX_PER_BURST_WINDOW / 3));
  });

  it('the console tail costs exactly ONE slot, however many lines it carries', () => {
    // #859's ring holds up to 256 lines and the whole window is 30 events wide — a line-per-event
    // replay could not fit under ANY division of it. One joined breadcrumb is what makes the tail
    // affordable, so this constant is load-bearing rather than cosmetic.
    expect(CONSOLE_CONTEXT_SLOT).toBe(1);
  });
});

describe('#861 — the inline guard\'s constants are INJECTED, not hand-synced', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  /**
   * ⚠️ NOTHING IN THE GATE PARSED THIS FILE AS HTML, and a close-out review caught the consequence:
   * seven lines of JS comment were committed ABOVE `<!doctype html>`. Non-whitespace before the
   * DOCTYPE makes the parser DISCARD it and switch to quirks mode (`compatMode = BackCompat`) —
   * legacy box model, different `%` height resolution — and renders the text as body content. This
   * is `engine/vite.config.ts`'s `root` index, so it would have shipped in the editor, `npm run
   * dev`, and every `--target web`/`native`/`playable` build.
   *
   * The existing tests could not see it: they `indexOf('<script>')` and extract the guard body,
   * which is unaffected by anything before it. One line fixes that for good.
   */
  it('starts with the DOCTYPE — anything before it silently forces quirks mode', () => {
    expect(
      html.trimStart().startsWith('<!doctype html>'),
      'engine/index.html must open with <!doctype html>. Non-whitespace before it is discarded by ' +
      'the parser, drops the page into BackCompat, and renders as visible body text.',
    ).toBe(true);
    expect(html.indexOf('<!doctype html>'), 'and no leading blank lines either').toBe(0);
  });

  /**
   * ⚠️ The scar this replaces: `EARLY_ERROR_CAP` drifted to 32 — two OVER the headroom it was meant
   * to leave — because the HTML and the TS constant were "kept in sync BY HAND" and nothing checked
   * it. The unified envelope needed four more shared literals, so they are injected at build time
   * from `bootStash.ts` instead. The HTML still carries real working DEFAULTS (the raw file has to
   * run under `earlyErrorBuffer.test.ts`), and this pins those defaults equal to the TS values so
   * dev and prod cannot disagree.
   */
  it('every tagged literal in index.html already equals its bootStash.ts constant', () => {
    const guard = extractFatalLoadGuardScript(html);
    const expected: Record<string, string | number> = {
      STASH_KEY, STASH_VERSION, REPLAY_ENTRY_CAP, CONSOLE_TAIL_LINES,
      STASH_MAX_MESSAGE, STASH_MAX_STACK, STASH_MAX_CONSOLE_CHARS,
    };
    const found = new Map<string, string>();
    for (const m of guard.matchAll(/=[ \t]*([^;\n]+);[ \t]*\/\* modoki:stash-const (\w+) \*\//g)) {
      found.set(m[2], m[1].trim());
    }
    // Every constant is TAGGED — a new shared literal added without its tag would silently go back
    // to being hand-kept, which is the exact regression this test exists to prevent.
    expect([...found.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, raw] of found) {
      const want = expected[name];
      expect(JSON.parse(raw.replace(/'/g, '"')), `index.html's ${name} drifted from bootStash.ts`).toBe(want);
    }
  });

  it('injectStashConstants rewrites a drifted literal from the TS source of truth', () => {
    const drifted = "var STASH_MAX_ENTRIES = 999; /* modoki:stash-const REPLAY_ENTRY_CAP */";
    expect(injectStashConstants(drifted, { REPLAY_ENTRY_CAP })).toContain(`= ${REPLAY_ENTRY_CAP};`);
  });

  /**
   * ⚠️ COVERS THE WIRING, not the helper. Both tests above call `injectStashConstants` directly on
   * synthetic strings — so replacing the plugin's `injectStashConstants(html, {…})` call with a
   * bare `html` (i.e. no build ever injects anything) left the whole suite GREEN. The injection is
   * a no-op today precisely because the defaults already match, which is what makes its failure
   * invisible. This drives the real `transformIndexHtml` over HTML whose literal has drifted.
   */
  it('the PLUGIN actually applies the injection, not just the helper it calls', () => {
    const plugin = earlyConsoleShimPlugin({
      isPlayable: false, isDev: false, hasDebugBridge: false, isEditor: true, isDebugBuild: false,
    });
    const transform = plugin.transformIndexHtml as (html: string) => string;
    const drifted = '<script>var STASH_MAX_ENTRIES = 999; /* modoki:stash-const REPLAY_ENTRY_CAP */</script>';
    expect(transform(drifted)).toContain(`= ${REPLAY_ENTRY_CAP};`);
  });

  it('injects even in a build where the console shim is STRIPPED', () => {
    // The fatal-load guard is a SEPARATE script from the shim and ships in every build, so a
    // release/playable build that strips the shim must still get its stash constants.
    const plugin = earlyConsoleShimPlugin({
      isPlayable: true, isDev: false, hasDebugBridge: false, isEditor: false, isDebugBuild: false,
    });
    const transform = plugin.transformIndexHtml as (html: string) => string;
    const drifted = '<script>var STASH_MAX_ENTRIES = 999; /* modoki:stash-const REPLAY_ENTRY_CAP */</script>'
      + START_MARKER + '<script>/* shim */</script><!-- modoki:early-console:end -->';
    const out = transform(drifted);
    expect(out).toContain(`= ${REPLAY_ENTRY_CAP};`);
    expect(out, 'the shim itself must still be stripped').not.toContain('/* shim */');
  });

  it('leaves an UNKNOWN tag untouched rather than blanking it', () => {
    // A rename on the TS side must fail loudly in the pinning test above, never silently erase a
    // value the page depends on to boot.
    const unknown = "var X = 5; /* modoki:stash-const NOT_A_REAL_CONSTANT */";
    expect(injectStashConstants(unknown, { REPLAY_ENTRY_CAP })).toBe(unknown);
  });
});

describe('#860 — a fault queued with no crashlytics sink survives the boot that raised it', () => {
  it('persists the queued report, and replays it on the next boot', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    // Window 3: the installer HAS run, so the live listener captures — but no game has registered
    // `crashlytics` yet, which is the whole of App.tsx's async boot (measured; see the header).
    runInlineScript('');
    g.installGlobalErrorHandlers();
    g.captureToCrashlytics('error', '[uncaught] window3-boom');

    const raw = localStorage.getItem(STASH_KEY);
    expect(raw, 'a fault with nowhere to go must be persisted, not left in an in-memory queue').toBeTruthy();
    const parsed = JSON.parse(raw!) as { v: number; reports?: Array<{ kind: string; text: string }> };
    expect(parsed.v).toBe(STASH_VERSION);
    expect(parsed.reports?.[0]).toMatchObject({ kind: 'error' });
    expect(parsed.reports?.[0].text).toContain('window3-boom');

    // Simulate the NEXT boot: fresh module state, the stash still on disk.
    g.__resetGlobalErrorsForTest({ uninstall: true });
    a.clearAppServices();
    localStorage.setItem(STASH_KEY, raw!);

    const errors: string[] = [];
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });

    expect(errors.some((e) => e.includes('window3-boom')), 'the previous boot\'s fault must be replayed').toBe(true);
    expect(errors.some((e) => e.includes('[prev-boot]')), 'and labelled as a previous boot, not as live').toBe(true);
    expect(localStorage.getItem(STASH_KEY), 'clear-on-read: one replay only').toBeNull();
  });

  /** #1056 — the replay validates each stashed report's kind, and `caught` is one of them. A kind the
   *  replay did not list would be skipped silently: the failure recorded, and then never sent. */
  it('replays a previous boot\'s CAUGHT report (journalError) as an issue (#1056)', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();
    g.__resetGlobalErrorsForTest({ uninstall: true });
    localStorage.setItem(STASH_KEY, JSON.stringify({
      v: STASH_VERSION, ts: Date.now(), dropped: 0, entries: [],
      reports: [{ kind: 'caught', text: '[journalError] court.iap.durability-unconfirmed {"transactionId":"t-9"}' }],
    }));

    const errors: string[] = [];
    g.installGlobalErrorHandlers();
    a.registerAppServices({ crashlytics: { recordError: (m: string) => { errors.push(m); }, log: () => {} } });

    expect(errors, 'the previous boot\'s caught failure must reach recordError')
      .toContain('[prev-boot] [journalError] court.iap.durability-unconfirmed {"transactionId":"t-9"}');
  });

  /** ⚠️ The half that keeps the eager write honest. Without it, a boot that queued a warn early and
   *  then booted FINE would replay that warn on every subsequent launch. */
  it('clears the stash when the sink arrives, so a boot that RECOVERED never replays itself', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    runInlineScript('');
    g.installGlobalErrorHandlers();
    g.captureToCrashlytics('error', '[uncaught] transient-early-fault');
    expect(localStorage.getItem(STASH_KEY), 'precondition: it was stashed').toBeTruthy();

    a.registerAppServices({ crashlytics: { recordError: () => {}, log: () => {} } });
    expect(
      localStorage.getItem(STASH_KEY),
      'the sink arrived and the queue flushed LIVE — a persisted copy would double-report next launch',
    ).toBeNull();
  });

  /**
   * ⚠️ TESTED ON THE READ PATH, deliberately, and the first version of this test was WORTHLESS.
   * It drove the cap through `captureToCrashlytics`, which only ever fills `reports` — so `entries`
   * was always empty, `REPLAY_ENTRY_CAP - entries.length` and `REPLAY_ENTRY_CAP` were the same
   * number, and giving reports their own cap changed nothing the test could see. A mutation check
   * caught it: breaking the pool produced ZERO red tests.
   *
   * The pool is only meaningful where both arrays can actually coexist, which is a payload this
   * module did not write — a hand-edited, corrupted, or future-version stash. That is exactly the
   * input the read-side bound exists for, so that is where it gets tested.
   */
  it('an envelope carrying BOTH faults and reports is capped on the TOTAL, not on each array', async () => {
    const { readAndClearBootStash } = await import('../../packages/modoki/src/runtime/core/bootStash');

    localStorage.setItem(STASH_KEY, JSON.stringify({
      v: STASH_VERSION,
      ts: Date.now(),
      dropped: 0,
      // BOTH arrays deliberately OVER the cap on their own, so the test can tell three things
      // apart that a cap-sized fixture cannot: no cap, a per-array cap, and the shared pool.
      entries: Array.from({ length: REPLAY_ENTRY_CAP + 3 }, (_, i) => ({ kind: 'error', message: `fault-${i}` })),
      reports: Array.from({ length: REPLAY_ENTRY_CAP + 3 }, (_, i) => ({ kind: 'error', text: `report-${i}` })),
    }));

    const stash = readAndClearBootStash()!;
    expect(stash).not.toBeNull();
    expect(
      stash.dropped,
      'what the READ side truncated is added to the writer\'s count — passing `dropped` through ' +
      'unchanged loses entries with no breadcrumb saying so, which is the silent drop this budget exists to prevent',
    ).toBe((REPLAY_ENTRY_CAP + 3) * 2 - REPLAY_ENTRY_CAP);
    expect(
      stash.entries.length + (stash.reports?.length ?? 0),
      'entries and reports draw on ONE pool. A cap each would let a single stash spend twice the ' +
      'budget on the replaying boot, and the overflow is refused SILENTLY by the limiter.',
    ).toBeLessThanOrEqual(REPLAY_ENTRY_CAP);
  });

  /**
   * ⚠️ FOUND BY RUNNING THE REAL BUILD, not by reading the code. A `--target web` build of
   * games/sling registers NO crashlytics service at all, so a replayed report finds no sink, gets
   * queued, and — before this guard — was persisted AGAIN. The next boot then replayed it,
   * re-prefixed it and re-stashed it: `[prev-boot] [prev-boot] [prev-boot] …` growing by a prefix
   * every launch and never draining, for the whole 7-day staleness window.
   *
   * A replayed report has already had its one chance. Clear-on-read is what makes the replay
   * ONCE-ONLY, and re-stashing it silently undid exactly that.
   */
  it('never re-stashes a report it just replayed, so a sink-less app cannot immortalise one fault', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    localStorage.setItem(STASH_KEY, JSON.stringify({
      v: STASH_VERSION, ts: Date.now(), dropped: 0, entries: [],
      reports: [{ kind: 'error', text: '[uncaught] one-and-only-fault' }],
    }));

    // A boot with NO crashlytics registered — the replay has nowhere to land and is queued.
    runInlineScript('');
    g.installGlobalErrorHandlers();

    const after = localStorage.getItem(STASH_KEY);
    const reports = after ? (JSON.parse(after).reports ?? []) as Array<{ text: string }> : [];
    expect(
      reports.some((r) => r.text.includes('one-and-only-fault')),
      'the replayed fault must NOT be written back — re-stashing it makes the next boot replay it ' +
      'again, re-prefixed, forever',
    ).toBe(false);
  });

  /**
   * ⚠️ THE DEFECT THIS PINS SILENTLY UN-DID THE WHOLE FIX. `writeBootStash` took the FIRST
   * `REPLAY_ENTRY_CAP` queued reports. A boot emits ordinary log noise before it dies — asset
   * 404s, deprecation warnings, and `console.error`/`console.warn` are BOTH wrapped into
   * `deliver()` — so six benign lines ahead of the fatal throw meant the stash carried six warns
   * and dropped the crash. Every test stayed green: the cap test asserted only HOW MANY survived,
   * never WHICH, so it passed under the head slice and the correct one alike.
   *
   * Neither end is right on its own — a tail slice inverts it, dropping the root cause when a
   * fatal throw is followed by cascade errors. The pool fills by KIND first, so a fatal error is
   * never displaced by benign noise however much of it came first.
   */
  it('keeps the FATAL error over benign warns that queued ahead of it', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    runInlineScript('');
    g.installGlobalErrorHandlers();
    // Exactly the shape measured on a real boot: benign noise first, the killer last.
    for (let i = 0; i < REPLAY_ENTRY_CAP; i++) g.captureToCrashlytics('warn', `[console.warn] benign-${i}`);
    g.captureToCrashlytics('error', '[uncaught] THE-FATAL-CRASH');

    const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: Array<{ text: string }> };
    const texts = (parsed.reports ?? []).map((r) => r.text);
    expect(
      texts.some((t) => t.includes('THE-FATAL-CRASH')),
      'the fault that killed the boot is the ONE report that must survive the cap — dropping it for ' +
      'six benign warns is the exact failure this whole family exists to prevent',
    ).toBe(true);
    expect(texts.length).toBeLessThanOrEqual(REPLAY_ENTRY_CAP);
  });

  it('replays reports in the order the boot produced them, not in priority order', async () => {
    const { writeBootStash, readAndClearBootStash } = await import('../../packages/modoki/src/runtime/core/bootStash');
    writeBootStash({
      reports: [
        { kind: 'warn', text: 'first-warn' },
        { kind: 'error', text: 'the-error' },
        { kind: 'warn', text: 'second-warn' },
      ],
    });
    const texts = (readAndClearBootStash()!.reports ?? []).map((r) => r.text);
    // Kind decides WHO survives; chronology decides how it READS. A replay ordered by priority
    // would misrepresent the sequence that led to the crash.
    expect(texts).toEqual(['first-warn', 'the-error', 'second-warn']);
  });

  /** ⚠️ A stash means "this boot died with something unreported". A healthy boot that merely
   *  queued the `[reload]` breadcrumb wrote one anyway, so the NEXT boot filed *previous boot's
   *  console tail before it died* about a boot that booted perfectly — and on a sink-less app that
   *  self-sustained forever. */
  it('a healthy boot with nothing but a breadcrumb queued writes NO stash', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    runInlineScript('');
    g.installGlobalErrorHandlers();
    g.captureToCrashlytics('breadcrumb', '[reload] this boot followed a page reload');

    expect(
      localStorage.getItem(STASH_KEY),
      'a breadcrumb is not a crash — stashing one makes the next boot report a death that never happened',
    ).toBeNull();
  });

  /**
   * ⚠️ THE SECOND HALF OF THE SAME DEFECT, and the first fix did not reach it. Ranking inside
   * `selectReportsForStash` protects the fatal error only if it is IN the array being ranked —
   * and `MAX_QUEUED` refused it at the door. So 50 benign warns filled the queue, the crash
   * arrived, and it was dropped one layer above the fix that was supposed to save it: the exact
   * failure the previous commit claimed to close, moved from the cap to the queue.
   *
   * The regression test for that has to reach 50, not 6. The earlier version stopped at
   * `REPLAY_ENTRY_CAP` warns and passed under both the fixed and the broken behaviour.
   */
  it('a fatal error arriving after the queue is FULL evicts a warn instead of being refused', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    // The burst limiter refuses past 30 per 5s window before `deliver()` sees anything, so the
    // clock has to move for the queue to fill at all.
    let t = 0;
    g.__resetGlobalErrorsForTest({ clock: () => t });
    runInlineScript('');
    g.installGlobalErrorHandlers();

    for (let i = 0; i < MAX_QUEUED + 10; i++) {
      if (i % 20 === 0) t += 6000;
      g.captureToCrashlytics('warn', `[console.warn] benign-${i}`);
    }
    t += 6000;
    g.captureToCrashlytics('error', '[uncaught] LATE-FATAL-CRASH');

    const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: Array<{ text: string }> };
    expect(
      (parsed.reports ?? []).some((r) => r.text.includes('LATE-FATAL-CRASH')),
      'a full queue must not be able to lock the crash out — the newcomer outranks a queued warn, ' +
      'so the warn is evicted and the fault gets in',
    ).toBe(true);
  });

  /** ⚠️ Distinguishes "an error got in" from "the RIGHT item was evicted". A test that only checks
   *  the newcomer arrives passes even when eviction picks the most important item instead of the
   *  least — so it needs an error ALREADY in the queue that must survive. */
  it('evicts a WARN, never the error already queued, when a second error arrives', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    let t = 0;
    g.__resetGlobalErrorsForTest({ clock: () => t });
    runInlineScript('');
    g.installGlobalErrorHandlers();

    g.captureToCrashlytics('error', '[uncaught] FIRST-FATAL');
    for (let i = 0; i < MAX_QUEUED + 5; i++) {
      if (i % 20 === 0) t += 6000;
      g.captureToCrashlytics('warn', `[console.warn] filler-${i}`);
    }
    t += 6000;
    g.captureToCrashlytics('error', '[uncaught] SECOND-FATAL');

    const texts = ((JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: Array<{ text: string }> })
      .reports ?? []).map((r) => r.text);
    expect(texts.some((x) => x.includes('FIRST-FATAL')), 'the queued error must not be what gets evicted').toBe(true);
    expect(texts.some((x) => x.includes('SECOND-FATAL')), 'and the newcomer still gets in').toBe(true);
  });

  /** #1056 — a `caught` report (`journalError`) ranks BELOW an error and ABOVE a warn, in queue
   *  admission and stash selection alike, because both read the one `reportKindRank`. */
  it('a caught failure arriving at a FULL queue of warns evicts a warn (#1056)', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    let t = 0;
    g.__resetGlobalErrorsForTest({ clock: () => t });
    runInlineScript('');
    g.installGlobalErrorHandlers();

    for (let i = 0; i < MAX_QUEUED + 5; i++) {
      if (i % 20 === 0) t += 6000;
      g.captureToCrashlytics('warn', `[console.warn] filler-${i}`);
    }
    t += 6000;
    g.captureToCrashlytics('caught', '[journalError] LATE-CAUGHT');

    const texts = ((JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: Array<{ text: string }> })
      .reports ?? []).map((r) => r.text);
    expect(texts.some((x) => x.includes('LATE-CAUGHT')), 'a caught failure outranks a queued warn').toBe(true);
  });

  it('an error arriving at a FULL queue of caught failures evicts one, and a caught-only queue is stashed (#1056)', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    let t = 0;
    g.__resetGlobalErrorsForTest({ clock: () => t });
    runInlineScript('');
    g.installGlobalErrorHandlers();

    g.captureToCrashlytics('caught', '[journalError] FIRST-CAUGHT');
    expect(localStorage.getItem(STASH_KEY), 'a caught failure is a report, not a breadcrumb: it must be stashed')
      .not.toBeNull();

    for (let i = 1; i < MAX_QUEUED + 5; i++) {
      if (i % 20 === 0) t += 6000;
      g.captureToCrashlytics('caught', `[journalError] filler-${i}`);
    }
    t += 6000;
    g.captureToCrashlytics('error', '[uncaught] LATE-FATAL');

    const texts = ((JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: Array<{ text: string }> })
      .reports ?? []).map((r) => r.text);
    expect(texts.some((x) => x.includes('LATE-FATAL')), 'an error outranks a queued caught failure').toBe(true);
  });

  /** ⚠️ The new key is read and REMOVED before the legacy key is touched, so a throw on the legacy
   *  read used to discard a payload that no longer existed on disk — a real crash report read,
   *  cleared and lost in one call. */
  it('a throw reading the LEGACY key never costs the payload already taken off disk', async () => {
    const { readAndClearBootStash, LEGACY_STASH_KEY, STASH_VERSION: V } =
      await import('../../packages/modoki/src/runtime/core/bootStash');

    localStorage.setItem(STASH_KEY, JSON.stringify({
      v: V, ts: Date.now(), dropped: 0, entries: [],
      reports: [{ kind: 'error', text: 'the-only-copy-of-this-crash' }],
    }));

    const real = globalThis.localStorage;
    vi.stubGlobal('localStorage', {
      ...real,
      getItem: (k: string) => {
        if (k === LEGACY_STASH_KEY) throw new Error('SecurityError: storage partition');
        return real.getItem(k);
      },
      removeItem: (k: string) => real.removeItem(k),
      setItem: (k: string, v: string) => real.setItem(k, v),
    });
    try {
      const stash = readAndClearBootStash();
      expect(stash, 'the legacy key is best-effort; it must never take the real payload down with it').not.toBeNull();
      expect(stash!.reports?.[0].text).toContain('the-only-copy-of-this-crash');
    } finally {
      vi.stubGlobal('localStorage', real);
    }
  });

  it('every report ADMITTED to the queue is either kept or counted', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    let t = 0;
    g.__resetGlobalErrorsForTest({ clock: () => t });
    runInlineScript('');
    g.installGlobalErrorHandlers();

    // All the same kind, so nothing outranks anything: the queue fills to MAX_QUEUED and every
    // later event is refused without changing the queue's content.
    for (let i = 0; i < MAX_QUEUED + 30; i++) {
      if (i % 20 === 0) t += 6000;
      g.captureToCrashlytics('error', `[uncaught] flood-${i}`);
    }

    const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: unknown[]; dropped: number };
    const kept = parsed.reports?.length ?? 0;
    expect(kept).toBeLessThanOrEqual(REPLAY_ENTRY_CAP);
    // ⚠️ The invariant is over what was ADMITTED, not over every event. A refused event writes
    // nothing on purpose (writing per refusal was unbounded — 61 synchronous localStorage writes
    // for 61 events), so the persisted count reflects drops up to the last content-changing write.
    // That trade is documented at `stashQueuedReports`; this pins the half that must stay exact.
    expect(
      kept + parsed.dropped,
      'everything that made it into the queue is either in the stash or in its drop count',
    ).toBe(MAX_QUEUED);
  });

  it('reads #825\'s legacy key so an upgrade does not lose the fault it stashed', async () => {
    const { readAndClearBootStash, LEGACY_STASH_KEY } = await import('../../packages/modoki/src/runtime/core/bootStash');
    // Exactly what a pre-#861 build wrote: v1, errors-only, under the OLD key.
    localStorage.setItem(LEGACY_STASH_KEY, JSON.stringify({
      v: 1, ts: Date.now(), dropped: 0,
      entries: [{ kind: 'error', message: 'crash-from-the-old-build' }],
    }));

    const stash = readAndClearBootStash();
    expect(stash, 'the one launch that matters is the update AFTER a boot-killing crash').not.toBeNull();
    expect(stash!.entries[0]).toMatchObject({ message: 'crash-from-the-old-build' });
    expect(localStorage.getItem(LEGACY_STASH_KEY), 'and the old key must not be left behind forever').toBeNull();
  });

  it('counts what the cap could not hold, rather than dropping it silently', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    runInlineScript('');
    g.installGlobalErrorHandlers();
    // Distinct text per call, so the limiter's dedupe cannot be what bounds this — the cap under
    // test is the stash's own.
    for (let i = 0; i < REPLAY_ENTRY_CAP + 5; i++) g.captureToCrashlytics('error', `[uncaught] boom-${i}`);

    const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { reports?: unknown[]; dropped: number };
    expect(parsed.reports?.length ?? 0).toBeLessThanOrEqual(REPLAY_ENTRY_CAP);
    expect(parsed.dropped, 'a drop nobody can see is the failure this budget exists to make visible').toBeGreaterThan(0);
  });
});

describe('#859 — the console run-up to the crash crosses the boot', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  it('the inline guard stashes the buffered console tail as ONE joined string', () => {
    document.body.innerHTML = '<div id="root"></div>';
    // Guard first, then the shim — the real page order, and it matters: the shim wraps console
    // AROUND whatever the guard left in place.
    runInlineScript(extractFatalLoadGuardScript(html));
    runInlineScript(extractEarlyConsoleShimScript(html));

    vi.useFakeTimers();
    try {
      console.log('run-up line one');
      console.warn('run-up line two');
      window.dispatchEvent(new ErrorEvent('error', {
        error: new Error('module-eval-boom'), message: 'module-eval-boom',
      }));
      vi.advanceTimersByTime(1400);
    } finally {
      vi.useRealTimers();
    }

    const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { console?: string };
    expect(typeof parsed.console, 'the run-up to the crash is the highest-value context a report carries').toBe('string');
    expect(parsed.console).toContain('run-up line one');
    expect(parsed.console).toContain('run-up line two');
    expect(parsed.console!.length).toBeLessThanOrEqual(STASH_MAX_CONSOLE_CHARS);
  });

  it('replays the whole tail as exactly ONE breadcrumb, never one per line', async () => {
    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    a.clearAppServices();

    const lines = Array.from({ length: 30 }, (_, i) => `boot line ${i}`).join('\n');
    localStorage.setItem(STASH_KEY, JSON.stringify({
      v: STASH_VERSION, ts: Date.now(), dropped: 0, entries: [], console: lines,
    }));

    const logs: string[] = [];
    const errors: string[] = [];
    runInlineScript('');
    g.installGlobalErrorHandlers();
    a.registerAppServices({
      crashlytics: { recordError: (m: string) => { errors.push(m); }, log: (m: string) => { logs.push(m); } },
    });

    const tailCrumbs = logs.filter((l) => l.includes('boot line'));
    expect(
      tailCrumbs,
      '30 lines must cost ONE breadcrumb. One per line would spend the entire 30-slot burst window ' +
      'on a previous boot\'s logs and silently refuse the fault they are context FOR.',
    ).toHaveLength(CONSOLE_CONTEXT_SLOT);
    expect(tailCrumbs[0]).toContain('boot line 0');
    expect(tailCrumbs[0]).toContain('boot line 29');
    expect(errors, 'a console tail is context, never an ISSUE in its own right').toHaveLength(0);
  });

  it('keeps the lines CLOSEST to the crash when the tail is over budget', () => {
    document.body.innerHTML = '<div id="root"></div>';
    runInlineScript(extractFatalLoadGuardScript(html));
    runInlineScript(extractEarlyConsoleShimScript(html));

    vi.useFakeTimers();
    try {
      // Each line is deliberately fat, so the CHARACTER bound (not the line count) is what binds.
      for (let i = 0; i < 60; i++) console.log(`line-${i}-${'x'.repeat(200)}`);
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
      vi.advanceTimersByTime(1400);
    } finally {
      vi.useRealTimers();
    }

    const parsed = JSON.parse(localStorage.getItem(STASH_KEY)!) as { console?: string };
    expect(parsed.console!.length).toBeLessThanOrEqual(STASH_MAX_CONSOLE_CHARS);
    expect(
      parsed.console,
      'the run-up to the crash is the NEWEST lines — trimming the tail instead of the head would ' +
      'keep the least relevant output and drop the part that explains the fault',
    ).toContain('line-59-');
    expect(parsed.console).not.toContain('line-0-');
  });
});
