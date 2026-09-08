/**
 * Strips the inline early-console-capture shim out of `engine/index.html` (#633) when the shared
 * console ring will NOT be installed in this build — so a build with no consumer of it does not
 * ship a permanently-buffering `console.*` patch that nothing ever drains.
 *
 * ⚠️ `shouldKeepEarlyConsoleShim` is a MIRROR of `engine/app/installConsoleRing.ts`'s runtime gate
 * (`!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE ||
 * __MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)`, pinned by
 * `engine/tests/architecture/deviceConsoleCaptureInstallOrder.test.ts`) — NOT a shared helper,
 * because this file runs in Vite config (Node, build time) while that gate runs in the browser
 * off `import.meta.env`/build-time defines. The two must be kept in sync BY HAND if either ever
 * changes; `engine/tests/architecture/earlyConsoleShim.test.ts` pins this file's expression text
 * so a drift is caught.
 *
 * Takes its five inputs as explicit args rather than sniffing `process.env`/`command` itself, so
 * `engine/vite.config.ts` stays the one place that decides what a build IS.
 */

import type { Plugin } from 'vite';
import {
  STASH_KEY, STASH_VERSION, REPLAY_ENTRY_CAP, CONSOLE_TAIL_LINES,
  STASH_MAX_MESSAGE, STASH_MAX_STACK, STASH_MAX_CONSOLE_CHARS,
} from '../packages/modoki/src/runtime/core/bootStash';

/** Bracket the block removed from `engine/index.html` — kept in sync with the literal markers
 *  there by `earlyConsoleShim.test.ts`. */
const START_MARKER = '<!-- modoki:early-console:start -->';
const END_MARKER = '<!-- modoki:early-console:end -->';

export interface EarlyConsoleShimPluginOptions {
  isPlayable: boolean;
  isDev: boolean;
  hasDebugBridge: boolean;
  isEditor: boolean;
  isDebugBuild: boolean;
}

/** Mirrors `installConsoleRing.ts`'s gate — see the module header for why this can't just import
 *  it. Kept as its own named function (rather than inlined into the plugin) so the pinning test
 *  can locate and assert its exact expression text. */
function shouldKeepEarlyConsoleShim(opts: EarlyConsoleShimPluginOptions): boolean {
  const { isPlayable, isDev, hasDebugBridge, isEditor, isDebugBuild } = opts;
  return !isPlayable && (isDev || hasDebugBridge || isEditor || isDebugBuild);
}

/**
 * The cross-boot stash constants the inline guard needs, injected from their ONE definition in
 * `runtime/core/bootStash.ts` (#861).
 *
 * ⚠️ WHY THIS EXISTS. `engine/index.html`'s guard is a bare inline `<script>` with no bundler, so
 * it cannot import a constant — and the previous arrangement said so and left the copies to be
 * "kept in sync BY HAND". That is not a hypothetical cost: `EARLY_ERROR_CAP` drifted to 32, two
 * OVER the headroom it was supposed to leave, and nothing noticed until a review derived the
 * margin by hand. Rather than adding four more hand-synced literals for the unified envelope, the
 * HTML carries each one tagged with a `modoki:stash-const <NAME>` comment and this rewrites the
 * value at build time from the TS source of truth.
 *
 * The literals in the HTML are still real, working values — the raw file has to run correctly in
 * `earlyErrorBuffer.test.ts`, which executes the actual page script — so they are DEFAULTS that a
 * build overwrites, and a test pins them equal to the TS constants so dev and prod agree.
 */
/** ⚠️ LINE-SCOPED (`[^;\n]`, and horizontal whitespace only before the tag). An earlier `[^;]+`
 *  here spanned newlines, so the match ran from a `=` many lines above straight through the
 *  intervening comment prose into the first tagged literal below it — rewriting a whole block of
 *  the guard rather than one value. A tagged constant is always a single `var NAME = VALUE;` line,
 *  so the pattern says so. */
const STASH_CONST_RE = /(=[ \t]*)([^;\n]+)(;[ \t]*\/\* modoki:stash-const (\w+) \*\/)/g;

export function injectStashConstants(html: string, values: Readonly<Record<string, string | number>>): string {
  return html.replace(STASH_CONST_RE, (whole, eq: string, _old: string, tail: string, name: string) => {
    // An UNKNOWN tag is left exactly as it was rather than blanked — a rename on the TS side must
    // fail loudly in the pinning test, not silently erase the value the page depends on.
    if (!(name in values)) return whole;
    const v = values[name];
    return `${eq}${typeof v === 'string' ? JSON.stringify(v) : String(v)}${tail}`;
  });
}

export function earlyConsoleShimPlugin(opts: EarlyConsoleShimPluginOptions): Plugin {
  return {
    name: 'modoki:early-console-shim',
    transformIndexHtml(html) {
      // Constants FIRST, and unconditionally: the fatal-load guard is a separate script from the
      // shim and is never stripped, so its stash constants must be injected even in a build where
      // the shim below is removed entirely.
      let out = injectStashConstants(html, {
        STASH_KEY,
        STASH_VERSION,
        REPLAY_ENTRY_CAP,
        STASH_MAX_MESSAGE,
        STASH_MAX_STACK,
        STASH_MAX_CONSOLE_CHARS,
        CONSOLE_TAIL_LINES,
      });
      if (shouldKeepEarlyConsoleShim(opts)) return out;
      const start = out.indexOf(START_MARKER);
      const end = out.indexOf(END_MARKER);
      if (start === -1 || end === -1) return out; // markers absent — nothing to strip
      out = out.slice(0, start) + out.slice(end + END_MARKER.length);
      return out;
    },
  };
}
