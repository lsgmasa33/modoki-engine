/** Pure, dependency-free helpers for the debug bridge (app/debug/bridge.ts) — no Capacitor/DOM
 *  imports, so they're directly unit-testable. bridge.ts imports these instead of the tests
 *  re-implementing them (which let copies silently drift from the shipping code — code-review T7). */

import { withTimeout } from '@modoki/engine/runtime/core/abandonment';
import {
  PENDING_PROMISE_MARKER, isThenable, jsonSafeReplacer, renderError,
} from '@modoki/engine/runtime/core/jsonSafe';
import { EVAL_ASYNC_TIMEOUT_MS } from '../../tools/shared/evalTiming';

/** Native (iOS drawHierarchy) capture dims, kept by the bridge after a native screenshot. */
export interface LastScreenInfo { imageWidth: number; imageHeight: number; screenWidth: number; screenHeight: number }
/** Per-request adb capture dims, passed by the MCP with a tap/drag (Android). */
export interface ScreenInfoParam { imgW: number; imgH: number; nativeW: number; nativeH: number }

/** 'layout-bounds' -> 'layoutBounds'. Shared by both eval-scripting surfaces (editor's evalApi.ts
 *  and device's deviceEvalApi.ts) so the mapping can't drift between them — moved here (#83) from
 *  evalApi.ts, which re-exports it for anything still importing it from there. */
export function kebabToCamel(op: string): string {
  return op.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export interface ConsoleLine {
  type: 'console';
  /** The shared ring's seq (#1559). */
  seq: number;
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

/** What an un-awaited Promise serializes to (#145). Re-exported: the one definition is in
 *  `runtime/core/jsonSafe.ts` (#1068), shared with the console ring and the editor transports. */
export { PENDING_PROMISE_MARKER };

/** A short, content-free description of a value's shape — for a refusal that must never echo what
 *  the value actually held (a log line can carry secrets).
 *
 *  ⚠️ Deliberately a COPY of `describeShape` in `engine/tools/shared/mcpResult.ts` rather than an
 *  import of it (#648). `engine/app` imports `tools/shared` BY VALUE only for small, dependency-free
 *  modules where a hand-kept copy would be the very defect being fixed — `simStepTiming.ts` (#822) and
 *  `inputVocabulary.ts` (#1076) were the first, and more have followed (`git grep "from '../../tools/shared"`
 *  lists the current set; a list here went stale twice). A
 *  value import here would pull MCP result-formatting code into the bundle that ships to devices for
 *  no comparable reason. Eight lines on this side of that boundary is the cheaper trade. If this
 *  ever needs to change, change both — they are the same refusal vocabulary. */
export function describeShape(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') {
    const keys = Object.keys(v as object).slice(0, 8);
    return keys.length ? `an object with keys: ${keys.join(', ')}` : 'an empty object';
  }
  return `a ${typeof v}`;
}

export function safeStringify(value: unknown): string {
  if (isThenable(value)) return PENDING_PROMISE_MARKER;
  // An Error has NO own enumerable properties, so `JSON.stringify(new Error('boom'))` is `{}` —
  // the same empty-looking-RESULT-rather-than-a-mistake trap as the pending promise above, and it
  // bit the same way: `console.error(err)` is how half the codebase reports a failure, so a real
  // device boot error reached `diagnose` as a literal `{}` (measured on a Samsung, #157). Visible
  // but useless is not fixed. `agentBridge`'s capture already special-cased this; the ring reached
  // it through here and did not, which is exactly the kind of divergence one shared helper exists
  // to prevent.
  //
  // Handled at BOTH depths, like the thenable case beside it: the top-level branch returns the
  // stack as text (so a captured console arg reads as text, matching `agentBridge`'s capture), and the
  // replacer below catches Errors NESTED in an object or array. The first cut of this fix did only
  // the top level — `{cause: err}` and `[err]` still serialized to `{"cause":{}}` / `[{}]`, which is
  // the same defect one level down, and a rejection value is exactly the kind of thing that arrives
  // wrapped. Caught in close-out review by asking why the thenable directly above was nested-aware
  // and this was not.
  //
  // Both depths render through `runtime/core/jsonSafe.ts` (#1068): `errorText`, never
  // `stack || message` (on iOS the stack has no message line, so the device bridge showed frames
  // with no message, #1055), plus the `cause` chain. The two EDITOR transports render through the
  // same module (`opReplyFor`), so all three agree on what an Error in a reply reads as.
  if (value instanceof Error) return renderError(value);
  try {
    return typeof value === 'string'
      ? value
      : JSON.stringify(value, jsonSafeReplacer);
  } catch {
    return String(value);
  }
}

/** Convert screenshot pixel coords → CSS page coords.
 *  L5: prefer the explicitly-passed `screenInfo` param (Android adb, scoped to THIS capture) over the
 *  stale global `lastScreenInfo` — the param is the caller's authoritative dims, so a native capture's
 *  leftover `lastScreenInfo` can't send a later adb-based tap through the wrong (iOS) scale math. */
export function screenshotToCSS(
  sx: number,
  sy: number,
  opts: { screenInfo?: ScreenInfoParam; lastScreenInfo?: LastScreenInfo | null; dpr?: number },
): { x: number; y: number } {
  const dpr = opts.dpr && opts.dpr > 0 ? opts.dpr : 1;
  if (opts.screenInfo) {
    return {
      x: (sx * opts.screenInfo.nativeW) / opts.screenInfo.imgW / dpr,
      y: (sy * opts.screenInfo.nativeH) / opts.screenInfo.imgH / dpr,
    };
  }
  if (opts.lastScreenInfo) {
    const scaleToNative = opts.lastScreenInfo.screenWidth / opts.lastScreenInfo.imageWidth;
    return { x: (sx * scaleToNative) / dpr, y: (sy * scaleToNative) / dpr };
  }
  return { x: sx, y: sy };
}

/** The eval budget constants and `clampEvalTimeout` live in `tools/shared/evalTiming.ts` (#1962), so the
 *  backend relay and the MCP client size their deadlines from the op's own clamp instead of restating it. */
export {
  EVAL_ASYNC_TIMEOUT_MS, EDITOR_EVAL_MAX_TIMEOUT_MS, DEVICE_EVAL_MAX_TIMEOUT_MS, DEVICE_EVAL_TIMEOUT_MS, clampEvalTimeout,
} from '../../tools/shared/evalTiming';

/** The `AsyncFunction` constructor — not a global binding, only reachable off an async function's
 *  prototype. Used by `handleEval` so eval bodies may `await` (#145). */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;

/** Run `code` as a function body (so `return x` yields a value — the device_eval contract) and
 *  serialize the result, or return an `Error: …` string. (The old `eval` fallback was dead — a
 *  function body is a superset of a script — and double-executed side effects on a runtime error.)
 *  A returned Promise (e.g. `return someAsyncCall()`) is awaited, bounded by
 *  `EVAL_ASYNC_TIMEOUT_MS` — otherwise a thenable's own properties serialize to a misleading `{}`
 *  instead of its actual resolved value (this bit a real debugging session: an eval reading OTA
 *  state silently reported `{}` instead of the real, non-empty state). `arg`, if given, is passed
 *  as the function's sole parameter named `modoki` — the caller builds whatever scripting object
 *  it wants visible to `code` (this file stays dependency-free, so it never builds that object
 *  itself); omitted, `code` sees `modoki === undefined` and behaves exactly as before.
 *
 *  The body is compiled with the ASYNC function constructor (#145), so `await` PARSES. It used to
 *  be the sync `Function`, which made the obvious `const r = await modoki.sceneState({})` a SYNTAX
 *  error — reported as "Unexpected identifier 'modoki'", naming neither `await` nor async, so the
 *  workaround was undiscoverable. The asymmetry was the bug: this surface already awaited an async
 *  RESULT (below), only the constructor was sync. Sync code is unaffected — an async function's
 *  plain `return` is a resolved promise, which the existing race/await path already handled. */
export async function handleEval(
  code: string,
  arg?: unknown,
  timeoutMs: number = EVAL_ASYNC_TIMEOUT_MS,
): Promise<unknown> {
  try {
    const fn = new AsyncFunction('modoki', code);
    const result = fn(arg);
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      // This site was already CORRECT — it cleared its timer, and `Promise.race` consumed the
      // late rejection so nothing surfaced unhandled. It migrates to the shared helper anyway,
      // because a guard that exempts the correct sites is not a guard (#801). The helper also
      // keeps the timer-release this used to do by hand: without it a fast eval pinned a pending
      // timer for the FULL budget, and the budget is caller-supplied, so a 25s ceiling would keep
      // one alive long past the reply.
      return safeStringify(await withTimeout(
        result as Promise<unknown>,
        timeoutMs,
        'eval',
        // The purest `discard` in the tree: the abandoned thing is arbitrary agent-supplied code.
        // It cannot be cancelled and it owns nothing WE can reclaim — whatever side effects it
        // has already started will land whenever they land, and no disposition here changes that.
        { discard: 'agent-supplied eval code cannot be cancelled and owns no reclaimable resource; a late result is dropped' },
        'the code did not finish — an unresolved Promise, or a budget too small for what it awaits',
      ));
    }
    return safeStringify(result);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
