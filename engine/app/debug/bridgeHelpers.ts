/** Pure, dependency-free helpers for the debug bridge (app/debug/bridge.ts) — no Capacitor/DOM
 *  imports, so they're directly unit-testable. bridge.ts imports these instead of the tests
 *  re-implementing them (which let copies silently drift from the shipping code — code-review T7). */

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
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

/** What an un-awaited Promise serializes to. A pending thenable has no own enumerable properties,
 *  so `JSON.stringify` renders it `{}` — an empty-looking RESULT rather than a mistake, which is
 *  how it silently cost real debugging calls (#145). Naming it makes the omission self-diagnosing. */
export const PENDING_PROMISE_MARKER = '[unresolved Promise — did you forget `await`?]';

function isThenable(v: unknown): boolean {
  return !!v && (typeof v === 'object' || typeof v === 'function')
    && typeof (v as { then?: unknown }).then === 'function';
}

/** A short, content-free description of a value's shape — for a refusal that must never echo what
 *  the value actually held (a log line can carry secrets).
 *
 *  ⚠️ Deliberately a COPY of `describeShape` in `engine/tools/shared/mcpResult.ts` rather than an
 *  import of it (#648). Every existing `engine/app` → `tools/shared` reference is `import type`,
 *  which costs the bundle nothing; a VALUE import would pull MCP result-formatting code into the
 *  bundle that ships to devices. Eight lines on this side of that boundary is the cheaper trade.
 *  If this ever needs to change, change both — they are the same refusal vocabulary. */
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
  // Handled at BOTH depths, like the thenable case beside it: the top-level branch returns the raw
  // stack (so a captured console arg reads as text, matching `agentBridge`'s capture), and the
  // replacer below catches Errors NESTED in an object or array. The first cut of this fix did only
  // the top level — `{cause: err}` and `[err]` still serialized to `{"cause":{}}` / `[{}]`, which is
  // the same defect one level down, and a rejection value is exactly the kind of thing that arrives
  // wrapped. Caught in close-out review by asking why the thenable directly above was nested-aware
  // and this was not.
  if (value instanceof Error) return value.stack || value.message;
  try {
    return typeof value === 'string'
      ? value
      : JSON.stringify(value, (_k, v) => (
        isThenable(v) ? PENDING_PROMISE_MARKER
          : v instanceof Error ? (v.stack || v.message)
            : v));
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

/** Default bound on how long an eval body is awaited before the bridge gives up and reports a
 *  timeout — without this, a hung/never-resolving promise would wedge the eval indefinitely
 *  instead of surfacing an error. Overridable per call (see `clampEvalTimeout`).
 *
 *  ⚠️ **This number was UNREACHABLE on both surfaces until it became overridable**, because each
 *  transport carries its own, shorter deadline and wins the race — so the caller got a generic
 *  transport error where this one would have said "code returned a Promise that never resolved":
 *  - **editor**: the backend→renderer HMR relay defaults to **3000ms** (`requestBrowser` in
 *    `vite-asset-scanner.ts`) — strictly less than this, so 3s was the real editor budget.
 *  - **device**: `TcpLeaseTransport`'s `REQUEST_TIMEOUT_MS` is **5000ms** (`deviceConnection.ts`)
 *    and its clock starts EARLIER (host-side, before the request reaches the device), so an equal
 *    5000 here always lost.
 *  Both callers now size their transport deadline from the requested eval budget — see
 *  `EDITOR_EVAL_MAX_TIMEOUT_MS` / `DEVICE_EVAL_MAX_TIMEOUT_MS` for the ceilings and why they differ. */
export const EVAL_ASYNC_TIMEOUT_MS = 5000;

/** Editor ceiling. The relay and the MCP client both take an explicit timeout, so the only real
 *  constraint is that each outer layer stays strictly larger: op ≤ 25s → relay op+10s → client
 *  op+15s, all under nothing in particular. Generous on purpose: an editor eval legitimately
 *  parks (`modoki.waitForEdit()`), and the old effective 3s made that impossible. */
export const EDITOR_EVAL_MAX_TIMEOUT_MS = 25_000;

/** Device ceiling. This used to be **4500, imposed from outside this file**: `TcpLeaseTransport`
 *  fixed its request deadline at 5000ms PER CONNECTION (`request()` took no timeout), so anything
 *  at or above that was fiction — the host gave up first and reported `device request timed out
 *  after 5000ms` instead of the eval's own, far more useful message, and 4500 was a workaround
 *  leaving ~500ms for the reply to travel back.
 *
 *  #153 plumbed a PER-REQUEST deadline through that transport, and `/api/device/request` now sizes
 *  it from this op's own budget + 5s of headroom, so the innermost timeout is the one that fires.
 *  Kept strictly BELOW `EDITOR_EVAL_MAX_TIMEOUT_MS` rather than raised to meet it: the device pays
 *  a real network hop the editor does not, so its op budget should always leave more room under
 *  the outer deadlines than the editor's does. That ordering is asserted in `bridge.test.ts`. */
export const DEVICE_EVAL_MAX_TIMEOUT_MS = 20_000;
/** Device default. Left at 4000 — below the transport's 5000 CONNECTION default, so an eval that
 *  does not ask for a budget still gets its own timeout message rather than a transport one. Only
 *  a caller that names `timeoutMs` lifts the transport deadline with it (#153). */
export const DEVICE_EVAL_TIMEOUT_MS = 4000;

/** Clamp a caller-supplied eval budget into `[50, max]`, falling back to `def` for anything
 *  absent or non-finite. CLAMPS rather than refuses — an over-cap request is a reasonable ask
 *  against a limit the caller cannot see, and the timeout message names the budget actually
 *  used, so the clamp is never silent when it matters. */
export function clampEvalTimeout(requested: unknown, def: number, max: number): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.max(50, Math.min(max, Math.floor(n)));
}

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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`eval timed out after ${timeoutMs}ms (the code did not finish — an unresolved Promise, or a budget too small for what it awaits)`)), timeoutMs);
      });
      try {
        return safeStringify(await Promise.race([result, timeout]));
      } finally {
        // Release the timer as soon as the race settles. Without this a fast eval still pinned a
        // pending timer for the FULL budget — harmless at 5s, but the budget is caller-supplied
        // now, so a 25s ceiling would keep one alive long past the reply.
        clearTimeout(timer);
      }
    }
    return safeStringify(result);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
