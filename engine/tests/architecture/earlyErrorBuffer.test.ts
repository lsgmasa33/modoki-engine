import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { earlyConsoleShimPlugin, type EarlyConsoleShimPluginOptions } from '../../plugins/earlyConsoleShim';
import { MAX_PER_BURST_WINDOW } from '../../packages/modoki/src/runtime/core/globalErrors';

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

  // Each test below executes the real IIFE fresh, which re-registers its OWN `window` listeners
  // and reassigns `globalThis.__MODOKI_EARLY_ERRORS__` to a brand-new object. A previous test's
  // listener closure still points at ITS OWN (now-orphaned) buffer object, not at whatever
  // `__MODOKI_EARLY_ERRORS__` currently names — so the accumulation across tests in this file is
  // inert, the same reasoning `globalErrors.test.ts`'s own beforeEach comment gives for its stale
  // per-test window listeners.
  afterEach(() => {
    delete (globalThis as { __MODOKI_EARLY_ERRORS__?: unknown }).__MODOKI_EARLY_ERRORS__;
  });

  it('assigns globalThis.__MODOKI_EARLY_ERRORS__ and buffers a real ErrorEvent, drained into exactly one recordError', async () => {
    const js = extractFatalLoadGuardScript(html);
    new Function(js)();

    const seeded = (globalThis as { __MODOKI_EARLY_ERRORS__?: { entries: unknown[] } }).__MODOKI_EARLY_ERRORS__;
    expect(seeded).toBeTruthy();
    expect(seeded!.entries).toEqual([]);

    const err = new Error('module-eval-boom');
    err.stack = 'Error: module-eval-boom\n  at graph (App.tsx:1:1)';
    // A message that does NOT match the guard's own `isLoadError` regex, so `consider()` bails out
    // immediately instead of scheduling the fallback-screen timer — this test is about the BUFFER,
    // not the fallback screen (a separate, explicitly out-of-scope gap noted in the guard's own
    // #636 comment).
    window.dispatchEvent(
      new ErrorEvent('error', { error: err, message: 'module-eval-boom', filename: 'App.tsx', lineno: 12, colno: 3 }),
    );

    const g = await import('../../packages/modoki/src/runtime/core/globalErrors');
    const a = await import('../../packages/modoki/src/runtime/core/appServices');
    const errors: string[] = [];
    try {
      g.installGlobalErrorHandlers();
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
    new Function(js)();

    const overflow = 12; // arbitrary margin past the cap — not itself load-bearing, unlike `cap`
    for (let i = 0; i < cap + overflow; i++) {
      // Messages deliberately don't match `isLoadError`, so `consider()` bails immediately and this
      // test exercises ONLY the buffer's own cap/drop-newest logic — the same isolation
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
    new Function(js)();

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
