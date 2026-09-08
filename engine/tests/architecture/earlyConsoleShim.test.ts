import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { earlyConsoleShimPlugin, type EarlyConsoleShimPluginOptions } from '../../plugins/earlyConsoleShim';

/**
 * The inline early-console-capture shim (#633) — source-parsing guard, modeled on
 * `deviceConsoleCaptureInstallOrder.test.ts` and `errorCaptureInstallOrder.test.ts`.
 *
 * `engine/index.html` is the ONE thing that runs before every static import in a bundled build
 * (rolldown inlines `main.tsx`'s side-effect imports into the entry chunk's BODY, which by ES
 * semantics runs after every static import has evaluated — measured on a `--target web` build of
 * `games/sling`). This guard checks the markers are in place, in order, exactly once, and that the
 * shim never grows a "restore the original console.*" branch — that would clobber whatever
 * `installGlobalErrorHandlers` has already wrapped around it by drain time (see
 * `runtime/core/consoleRing.ts`'s `drainEarlyConsole` doc comment).
 *
 * It also pins `engine/plugins/earlyConsoleShim.ts`'s gate expression text against
 * `engine/app/installConsoleRing.ts`'s runtime gate — the two cannot share code (one runs in Node
 * at build time, the other in the browser off `import.meta.env`), so a drift between them is
 * silent otherwise: the plugin would strip (or keep) the shim in builds where the ring itself
 * install differently, either shipping a dead buffering patch or dropping the one thing early boot
 * logs depend on.
 */

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX_HTML = path.join(engineDir, 'index.html');
const PLUGIN = path.join(engineDir, 'plugins/earlyConsoleShim.ts');

const START_MARKER = '<!-- modoki:early-console:start -->';
const END_MARKER = '<!-- modoki:early-console:end -->';

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Calls a Vite `transformIndexHtml` hook, which the `Plugin` type allows as either a plain
 * function or an `{ order, handler }` object (`plugins/bootSplash.ts` uses the latter form) —
 * `earlyConsoleShimPlugin` currently uses the plain-function form, but this helper works with
 * either so it keeps working if that ever changes.
 */
function callTransformIndexHtml(plugin: ReturnType<typeof earlyConsoleShimPlugin>, html: string): string {
  const hook = plugin.transformIndexHtml as
    | ((html: string, ctx: unknown) => string)
    | { handler: (html: string, ctx: unknown) => string }
    | undefined;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('earlyConsoleShimPlugin has no transformIndexHtml hook');
  }
  const result = fn(html, {} as unknown);
  if (typeof result !== 'string') {
    throw new Error(`transformIndexHtml did not return a string synchronously (got ${typeof result})`);
  }
  return result;
}

describe('early console shim (#633)', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  it('contains both markers, exactly once each', () => {
    expect(countOccurrences(html, START_MARKER), `expected exactly one ${START_MARKER}`).toBe(1);
    expect(countOccurrences(html, END_MARKER), `expected exactly one ${END_MARKER}`).toBe(1);
  });

  it('appears BEFORE the module entry script', () => {
    const startIdx = html.indexOf(START_MARKER);
    const moduleScriptIdx = html.indexOf('<script type="module"');
    expect(startIdx, `${START_MARKER} not found`).toBeGreaterThanOrEqual(0);
    expect(moduleScriptIdx, '<script type="module" not found').toBeGreaterThanOrEqual(0);
    expect(
      startIdx,
      'the early-console shim must sit before the module entry script — anything after it runs ' +
        'too late to catch a module-eval-time console call in the entry chunk',
    ).toBeLessThan(moduleScriptIdx);
  });

  it("appears AFTER the fatal-load guard's <script> open tag", () => {
    const firstScriptIdx = html.indexOf('<script>');
    const startIdx = html.indexOf(START_MARKER);
    expect(firstScriptIdx, 'no bare <script> tag found (the fatal-load guard)').toBeGreaterThanOrEqual(0);
    expect(
      startIdx,
      'the early-console shim must come after the fatal-load guard\'s <script> open tag, per the ' +
        'brief — it is the SECOND inline script in <head>',
    ).toBeGreaterThan(firstScriptIdx);
  });

  it('assigns globalThis.__MODOKI_EARLY_CONSOLE__', () => {
    const start = html.indexOf(START_MARKER);
    const end = html.indexOf(END_MARKER);
    const block = html.slice(start, end);
    expect(block.includes('globalThis.__MODOKI_EARLY_CONSOLE__')).toBe(true);
  });

  it('does NOT contain a bare restore like `console[lvl] = real` outside the wrapper assignment', () => {
    const start = html.indexOf(START_MARKER);
    const end = html.indexOf(END_MARKER);
    const block = html.slice(start, end);
    // The ONLY assignment to console[lvl] in the shim must be the wrapper function — a future
    // "cleanup" that restores console[lvl] = real (or console[lvl] = state.originals[lvl], or any
    // other spelling of "put the pristine function back") would clobber whatever
    // installGlobalErrorHandlers has already wrapped around this shim by drain time.
    expect(
      block.includes('= real;'),
      'the shim must never restore console.* directly — disarm (state.done = true, handled by ' +
        'drainEarlyConsole) is the only safe teardown; see the shim\'s own header comment',
    ).toBe(false);
  });

  it('the fatal-load guard script and the shim are BOTH inside <head>', () => {
    const headCloseIdx = html.indexOf('</head>');
    const endIdx = html.indexOf(END_MARKER);
    expect(headCloseIdx, '</head> not found').toBeGreaterThanOrEqual(0);
    expect(endIdx, END_MARKER + ' not found').toBeGreaterThanOrEqual(0);
    expect(endIdx, 'the shim must close before </head>').toBeLessThan(headCloseIdx);
  });

  describe("plugin gate mirrors installConsoleRing.ts's runtime gate", () => {
    const pluginSrc = fs.readFileSync(PLUGIN, 'utf8');
    const stripped = stripComments(pluginSrc);
    assertScanIsSane(pluginSrc, stripped, 'plugins/earlyConsoleShim.ts');

    it('pins the exact boolean expression', () => {
      const lines = stripped.split('\n');
      const returnIdx = lines.findIndex((l) => /return\s+!isPlayable/.test(l));
      expect(
        returnIdx,
        'could not find the `return !isPlayable && (...)` line in shouldKeepEarlyConsoleShim — ' +
          'did the gate move or get renamed?',
      ).toBeGreaterThanOrEqual(0);
      const m = lines[returnIdx].match(/return\s+(.*?);?\s*$/);
      expect(m, `line ${returnIdx} ("${lines[returnIdx]}") does not match "return <expr>;"`).not.toBeNull();
      const expr = m![1].replace(/\s+/g, ' ').trim();
      expect(
        expr,
        `plugins/earlyConsoleShim.ts's gate must mirror installConsoleRing.ts's runtime gate ` +
          `(pinned by deviceConsoleCaptureInstallOrder.test.ts as ` +
          `"!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE || ` +
          `__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)"), spelled in terms of this file's own ` +
          `{isPlayable, isDev, hasDebugBridge, isEditor, isDebugBuild} args. Got: "${expr}"`,
      ).toBe('!isPlayable && (isDev || hasDebugBridge || isEditor || isDebugBuild)');
    });
  });

  // F7 (#626/#633 adversarial review): the GATE EXPRESSION above is pinned on both sides
  // (`shouldKeepEarlyConsoleShim`'s own boolean logic, and — via `deviceConsoleCaptureInstallOrder
  // .test.ts` — `installConsoleRing.ts`'s runtime gate), but the WIRING at the plugin's ONE call
  // site in `vite.config.ts` was not: a transposition (e.g. `isEditor: isPlayable`) leaves every
  // existing gate assertion green while shipping a packaged editor with no shim at all — #633 back,
  // invisibly. This parses the actual `earlyConsoleShimPlugin({...})` call and pins each of its
  // five properties to the exact expression `vite.config.ts` computes it from.
  describe("vite.config.ts wires earlyConsoleShimPlugin's five arguments correctly", () => {
    const VITE_CONFIG = path.join(engineDir, 'vite.config.ts');
    const viteConfigSrc = fs.readFileSync(VITE_CONFIG, 'utf8');
    const stripped = stripComments(viteConfigSrc);
    assertScanIsSane(viteConfigSrc, stripped, 'vite.config.ts');

    /** The `earlyConsoleShimPlugin({ ... })` call's argument object, as `{propName: exprText}` —
     *  a shorthand property (`isPlayable,`) is recorded as `{isPlayable: 'isPlayable'}`, matching
     *  what it means. */
    function extractPluginCallArgs(text: string): Record<string, string> {
      const callMarker = 'earlyConsoleShimPlugin(';
      const callIdx = text.indexOf(callMarker);
      expect(callIdx, 'could not find an earlyConsoleShimPlugin( call in vite.config.ts').toBeGreaterThanOrEqual(0);
      let i = callIdx + callMarker.length;
      let depth = 1; // already inside the call's own '('
      const start = i;
      while (depth > 0 && i < text.length) {
        if (text[i] === '(' || text[i] === '{') depth++;
        else if (text[i] === ')' || text[i] === '}') depth--;
        i++;
      }
      const argsText = text.slice(start, i - 1).trim().replace(/^\{/, '').replace(/\}$/, '');
      const props: Record<string, string> = {};
      for (const rawEntry of argsText.split(',')) {
        const entry = rawEntry.trim();
        if (!entry) continue;
        const m = entry.match(/^([A-Za-z0-9_]+)\s*:\s*([\s\S]+)$/);
        if (m) props[m[1]] = m[2].replace(/\s+/g, ' ').trim();
        else props[entry] = entry; // shorthand: `isPlayable` means `isPlayable: isPlayable`
      }
      return props;
    }

    it('wires each argument to the expression the guard expects, by name', () => {
      const props = extractPluginCallArgs(stripped);
      const context = () => `earlyConsoleShimPlugin(...) call in vite.config.ts, parsed as: ${JSON.stringify(props)}`;
      expect(props.isPlayable, context()).toBe('isPlayable');
      expect(props.isDev, context()).toBe("command === 'serve'");
      expect(props.hasDebugBridge, context()).toBe('!!process.env.VITE_DEBUG_BRIDGE');
      expect(props.isEditor, context()).toBe('isEditorBuild');
      expect(props.isDebugBuild, context()).toBe('debugBuildFlag');
    });
  });
});

/**
 * The suite above pins the GATE EXPRESSION's source text — it proves the plugin's gate and
 * `installConsoleRing.ts`'s runtime gate read the same, not that `earlyConsoleShimPlugin`
 * actually DOES anything with the result. A `transformIndexHtml` that silently `return html`s
 * unchanged in every branch would pass every assertion above. This block calls the plugin for
 * real, against a realistic HTML fixture, and checks what it actually returns.
 */
describe('earlyConsoleShimPlugin (#633) — functional behaviour', () => {
  const FIXTURE_HTML = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <title>Fixture</title>',
    '  <script>/* fatal-load guard */</script>',
    START_MARKER,
    '  <script>',
    '    globalThis.__MODOKI_EARLY_CONSOLE__ = { buffer: [] };',
    '  </script>',
    END_MARKER,
    '</head>',
    '<body>',
    '  <div id="root"></div>',
    '  <script type="module" src="/src/main.tsx"></script>',
    '</body>',
    '</html>',
  ].join('\n');

  const NO_MARKERS_HTML =
    '<head><title>No markers here</title></head><body>' +
    '<script type="module" src="/src/main.tsx"></script></body>';

  const ALL_FALSE: EarlyConsoleShimPluginOptions = {
    isPlayable: false,
    isDev: false,
    hasDebugBridge: false,
    isEditor: false,
    isDebugBuild: false,
  };

  it('keeps the block when the gate is true', () => {
    const result = callTransformIndexHtml(earlyConsoleShimPlugin({ ...ALL_FALSE, isDev: true }), FIXTURE_HTML);
    expect(result).toContain(START_MARKER);
    expect(result).toContain(END_MARKER);
    expect(result).toContain('__MODOKI_EARLY_CONSOLE__');
  });

  it('strips the block when the gate is false, without eating the surrounding html', () => {
    const result = callTransformIndexHtml(earlyConsoleShimPlugin(ALL_FALSE), FIXTURE_HTML);
    expect(result).not.toContain(START_MARKER);
    expect(result).not.toContain(END_MARKER);
    expect(result).not.toContain('__MODOKI_EARLY_CONSOLE__');
    // The strip must be scoped to exactly the marker pair — this is the assertion that catches
    // a strip eating too much (or too little) of the surrounding document.
    expect(result).toContain('<title>Fixture</title>');
    expect(result).toContain('fatal-load guard');
    expect(result).toContain('<div id="root"></div>');
    expect(result).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it('strips even when every other flag is true — isPlayable overrides all of them', () => {
    // Mirrors the leading `!__MODOKI_PLAYABLE__` in installConsoleRing.ts's gate. A careless
    // refactor from `&&` to `||` at the top level would keep the block here; this is the case
    // that catches it.
    const result = callTransformIndexHtml(
      earlyConsoleShimPlugin({
        isPlayable: true,
        isDev: true,
        hasDebugBridge: true,
        isEditor: true,
        isDebugBuild: true,
      }),
      FIXTURE_HTML,
    );
    expect(result).not.toContain(START_MARKER);
    expect(result).not.toContain(END_MARKER);
    expect(result).not.toContain('__MODOKI_EARLY_CONSOLE__');
  });

  const KEEPS_ALONE: Array<[string, EarlyConsoleShimPluginOptions]> = [
    ['isDev', { ...ALL_FALSE, isDev: true }],
    ['hasDebugBridge', { ...ALL_FALSE, hasDebugBridge: true }],
    ['isEditor', { ...ALL_FALSE, isEditor: true }],
    ['isDebugBuild', { ...ALL_FALSE, isDebugBuild: true }],
  ];

  it.each(KEEPS_ALONE)('keeps the block when only %s is true', (_flag, opts) => {
    const result = callTransformIndexHtml(earlyConsoleShimPlugin(opts), FIXTURE_HTML);
    expect(result).toContain(START_MARKER);
    expect(result).toContain(END_MARKER);
    expect(result).toContain('__MODOKI_EARLY_CONSOLE__');
  });

  it('returns the html unchanged when the markers are absent, rather than throwing or mangling it', () => {
    const result = callTransformIndexHtml(earlyConsoleShimPlugin(ALL_FALSE), NO_MARKERS_HTML);
    expect(result).toBe(NO_MARKERS_HTML);
  });
});

/**
 * F6 (#626/#633 adversarial review): everything above tests the shim's SHAPE from the outside —
 * `EarlyConsoleState` is declared once in `consoleRing.ts` and modeled a SECOND time in
 * `consoleRing.test.ts` (its `seedEarlyConsole` helper) — but nothing runs the actual `<script>`
 * body from `engine/index.html`. A change to what it PUSHES (an object instead of a `[level, args,
 * mono]` tuple, `arguments` instead of a sliced array, a dropped third slot) would stay green
 * everywhere else. This extracts the REAL script text and executes it for real, in this file
 * because it already reads `engine/index.html` and this suite's jsdom environment (the root vitest
 * config sets `environment: 'jsdom'`) can run it.
 */
describe('early console shim (#633) — runs the ACTUAL page script, not a model of it (F6)', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  it('drains real console.* calls with CALL-time timestamps, and the cap/dropped path (300 calls -> 256 kept + 44 dropped + one drop-notice)', async () => {
    const start = html.indexOf(START_MARKER);
    const end = html.indexOf(END_MARKER);
    expect(start, START_MARKER + ' not found').toBeGreaterThanOrEqual(0);
    expect(end, END_MARKER + ' not found').toBeGreaterThan(start);
    const block = html.slice(start + START_MARKER.length, end);
    const scriptMatch = block.match(/<script>([\s\S]*)<\/script>/);
    expect(scriptMatch, 'expected exactly one <script>...</script> between the markers').not.toBeNull();
    const js = scriptMatch![1];

    const originalConsole = {
      log: console.log, info: console.info, warn: console.warn, error: console.error,
    };
    // A deterministic, strictly-increasing fake clock — makes "each buffered call got its OWN
    // mono, in call order" trivially distinguishable from the regression this guards against
    // ("every replayed entry gets the SAME mono, stamped once at drain time").
    let fakeNow = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow++);
    delete (globalThis as { __MODOKI_EARLY_CONSOLE__?: unknown }).__MODOKI_EARLY_CONSOLE__;

    let ringMod: typeof import('../../packages/modoki/src/runtime/core/consoleRing') | undefined;
    try {
      // Executing the REAL page shim source, verbatim — not a hand-written model of it.
      new Function(js)();

      // Two real, distinguishable calls, then a flood that overruns the shim's own CAP (256) —
      // 300 total calls, so exactly 44 never get buffered by the shim at all (300 - 256).
      console.info('early-info');
      console.warn('early-warn');
      for (let i = 0; i < 298; i++) console.log(`line-${i}`);

      // Bump the fake clock AFTER every buffered call and BEFORE the drain — the correct shim
      // baked each call's `mono` into its own buffered tuple back when `fakeNow` was still
      // 1000/1001, so the drain reading it back must still see 1000/1001 no matter what the clock
      // reads NOW. A regression that re-reads the clock fresh during the drain loop instead would
      // stamp every replayed entry with THIS new value (9000, incrementing) rather than its
      // original call-time one — which a `toBeLessThan`-style check, or even `toBe(1000)` with
      // `fakeNow` left at 1000 throughout, cannot distinguish from the correct behaviour.
      fakeNow = 9000;
      ringMod = await import('../../packages/modoki/src/runtime/core/consoleRing');
      ringMod.installConsoleRing();

      const entries = ringMod.getConsoleRingEntries();
      const infoEntry = entries.find((e) => e.args[0] === 'early-info');
      const warnEntry = entries.find((e) => e.args[0] === 'early-warn');
      const dropNotice = entries.find((e) => e.level === 'warn' && String(e.args[0]).includes('[console-ring]'));

      expect(infoEntry?.level).toBe('info');
      expect(warnEntry?.level).toBe('warn');
      // Call-time, not drain-time (the whole point of this test). The shim's own `now()` reads the
      // clock exactly once per buffered call, in order, so under the real fixed clock the FIRST
      // two calls get EXACTLY 1000 and 1001 — pinned as exact values, not just relative order,
      // because a regression that re-reads the clock fresh during the drain loop (dropping
      // `replay.mono`) would ALSO produce two increasing-but-later values (e.g. 1256, 1257) that a
      // bare `toBeLessThan` comparison would not catch.
      expect(infoEntry!.mono).toBe(1000);
      expect(warnEntry!.mono).toBe(1001);

      // The cap/dropped path: 300 calls into a CAP=256 shim buffer -> 256 survive (the FIRST 256
      // calls made — info, warn, then 254 of the 298 log lines), 44 dropped, plus the ONE
      // drop-notice entry `drainEarlyConsole` adds when `early.dropped > 0`.
      expect(entries, `entries: ${entries.map((e) => e.args[0]).join(', ')}`).toHaveLength(257);
      expect(dropNotice).toBeTruthy();
      expect(dropNotice!.args[0]).toContain('44');
    } finally {
      ringMod?.__resetConsoleRingForTest();
      nowSpy.mockRestore();
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      delete (globalThis as { __MODOKI_EARLY_CONSOLE__?: unknown }).__MODOKI_EARLY_CONSOLE__;
    }
  });
});
