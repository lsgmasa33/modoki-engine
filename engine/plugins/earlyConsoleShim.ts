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

export function earlyConsoleShimPlugin(opts: EarlyConsoleShimPluginOptions): Plugin {
  return {
    name: 'modoki:early-console-shim',
    transformIndexHtml(html) {
      if (shouldKeepEarlyConsoleShim(opts)) return html;
      const start = html.indexOf(START_MARKER);
      const end = html.indexOf(END_MARKER);
      if (start === -1 || end === -1) return html; // markers absent — nothing to strip
      return html.slice(0, start) + html.slice(end + END_MARKER.length);
    },
  };
}
