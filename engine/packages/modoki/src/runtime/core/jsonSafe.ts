/** Rendering a value that LEAVES the process — a bridge reply, a console-ring entry, a Crashlytics
 *  text, a debug-menu row — so that what `JSON.stringify` would silently turn into `{}` arrives as
 *  text instead (#1068).
 *
 *  Two kinds of value have no own enumerable properties, so they serialize to `{}`, an empty-looking
 *  RESULT rather than a visible mistake:
 *   - an `Error`: `name`, `message` and `stack` are not enumerable. A real device boot error once
 *     reached `diagnose` as a literal `{}` (#157). Rendered by `renderError`, which is `errorText`
 *     (the message survives on iOS, #1055) plus the `cause` chain.
 *   - a pending thenable, i.e. an un-awaited Promise (#145). Rendered as `PENDING_PROMISE_MARKER`.
 *
 *  ⚠️ **ONE implementation, because it was hand-copied per exit and the copies drifted.** The device
 *  bridge (`safeStringify`), the console ring (`stringifyArg`) and `journalError`'s Crashlytics text
 *  each carried their own replacer: only the ring appended the cause chain, and `journalError`'s knew
 *  nothing of thenables. The two EDITOR transports carried none at all, so an Error anywhere in an
 *  editor op reply, a journal payload among them, reached the agent as `{}` while the device bridge
 *  showed the same event as text (#1068, observed headless). Guarded as the only copy by
 *  `engine/tests/architecture/jsonSafeIsShared.test.ts`.
 *
 *  L0 on purpose (it imports only `errorText`), so the console ring can take it, and a dedicated deep
 *  export (`@modoki/engine/runtime/core/jsonSafe`), so `engine/app/debug` can take it without pulling
 *  the runtime barrel in. */

import { errorText } from './errorText';

/** What an un-awaited Promise serializes to. Naming it makes the omission self-diagnosing (#145).
 *  ⚠️ Matched as a literal string by tests and by agents reading replies; do not reword it casually. */
export const PENDING_PROMISE_MARKER = '[unresolved Promise — did you forget `await`?]';

export function isThenable(v: unknown): boolean {
  return !!v && (typeof v === 'object' || typeof v === 'function')
    && typeof (v as { then?: unknown }).then === 'function';
}

/** Depth cap for the cause chain, from the editor's now-deleted `formatError` (F3, #626/#633
 *  adversarial review). Guards against a pathological (or cyclic) `cause` chain growing a line
 *  without bound; four links is already more than any real error chain here has carried. */
const CAUSE_CHAIN_DEPTH_CAP = 4;

/** `\n  caused by: Name: message`, once per `Error` in `err.cause`'s chain, depth-capped. `''` when
 *  there is no Error cause, the overwhelmingly common case.
 *
 *  Each link is `Name: message`, not its own stack: the head already carries a stack saying WHERE
 *  the outer error was thrown, and a cause is there to say WHAT led to it, one line each. */
function formatCauseChain(err: Error, depth = 0): string {
  const cause = (err as { cause?: unknown }).cause;
  if (depth >= CAUSE_CHAIN_DEPTH_CAP || !(cause instanceof Error)) return '';
  const head = `${cause.name || 'Error'}: ${cause.message}`;
  return `\n  caused by: ${head}${formatCauseChain(cause, depth + 1)}`;
}

/** An `Error` as text: `errorText`, then one `caused by:` line per Error in its `cause` chain. */
export function renderError(err: Error): string {
  return errorText(err) + formatCauseChain(err);
}

/** A `JSON.stringify` replacer that renders a nested `Error` or thenable as text.
 *
 *  A TOP-LEVEL one is rendered too, but JSON-quoted. A caller that wants the bare text (a console
 *  arg, a device reply) checks for it before stringifying, as `safeStringify` does. */
export function jsonSafeReplacer(_key: string, value: unknown): unknown {
  return isThenable(value) ? PENDING_PROMISE_MARKER
    : value instanceof Error ? renderError(value)
      : value;
}

/** `value` with every `Error` and thenable inside it rendered as text, for a transport that ends in a
 *  bare `JSON.stringify` it does not own (Vite's `hot.send`; the editor backend's response write,
 *  after Electron's IPC).
 *
 *  **Copy-on-write.** When nothing inside needs rendering, the SAME reference comes back, so a large
 *  reply with no Error in it (a scene-state dump) is walked but never copied. Only the containers on
 *  a path to a rendered value are rebuilt, as plain objects and arrays holding the same own enumerable
 *  keys `JSON.stringify` would have emitted. The input is never mutated.
 *
 *  It walks what `JSON.stringify` walks, in the same order. An object with a `toJSON` is replaced by
 *  what `toJSON(key)` returns, and THAT is walked, because `JSON.stringify` runs the replacer over the
 *  `toJSON` result too. When that result needs nothing rendered, the original object comes back, so
 *  a `Date` costs no copy. A typed-array view (a Node `Buffer` included) is left as it is BEFORE its
 *  `toJSON` is consulted: it can hold no Error, and projecting a large one is pure cost. A cycle is
 *  left as it is too, so the transport's own stringify fails on it exactly as it did before.
 *
 *  `key` is the property name the RESULT will sit under when the transport stringifies it, which is
 *  what a root `toJSON(key)` receives. `opReplyFor` passes `'result'` because it sends `{ result }`;
 *  a bare `JSON.stringify(toJsonSafe(v))` wants the default `''`.
 *
 *  ⚠️ Accepted costs of copy-on-write, and the parity limits that come with them:
 *   - A `toJSON` or an enumerable GETTER can run more than once: here, and again in the transport
 *     wherever this walk handed the original object back. The wire carries the transport's read. No
 *     op result has a side-effecting getter or `toJSON` today.
 *   - A copied container is built with `defineProperty`, never `out[key] =`, so an own `__proto__` key
 *     (from `JSON.parse`) stays an own key rather than silently becoming the copy's prototype.
 *   - A function-valued `toJSON` key is left out of a copy. `JSON.stringify` never calls a projected
 *     value's own `toJSON` and omits function values anyway, but on a copy the transport WOULD call it.
 *   - A primitive's `toJSON` (a user-defined `BigInt.prototype.toJSON`) and a function carrying a
 *     `toJSON` property are not projected.
 *
 *  Total: a hostile getter makes it return `value` unchanged rather than throw, because the caller is
 *  a reply path and the transport would have met the same getter anyway. */
export function toJsonSafe(value: unknown, key = ''): unknown {
  try {
    return walk(value, new WeakSet(), key);
  } catch {
    return value;
  }
}

/** One property position, as `JSON.stringify` visits it: `toJSON` first, then the value itself. */
function walk(v: unknown, onPath: WeakSet<object>, key: string): unknown {
  if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      const projected: unknown = (toJSON as (k: string) => unknown).call(v, key);
      const walked = walkValue(projected, onPath);
      return Object.is(walked, projected) ? v : walked;
    }
  }
  return walkValue(v, onPath);
}

/** Copy one own property onto a rebuilt container. `defineProperty`, so an own `__proto__` key stays
 *  an own key; a function-valued `toJSON` is dropped (see `toJsonSafe`'s parity notes). */
function copyOwn(target: object, key: string, value: unknown): void {
  if (key === 'toJSON' && typeof value === 'function') return;
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A value with any `toJSON` already applied: the replacer's cases, then the container walk. */
function walkValue(v: unknown, onPath: WeakSet<object>): unknown {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
  if (isThenable(v)) return PENDING_PROMISE_MARKER;
  if (v instanceof Error) return renderError(v);
  if (typeof v === 'function') return v;
  const obj = v as object;
  if (onPath.has(obj) || ArrayBuffer.isView(obj)) return v;
  onPath.add(obj);
  try {
    if (Array.isArray(obj)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < obj.length; i++) {
        const next = walk(obj[i], onPath, String(i));
        if (out === null && !Object.is(next, obj[i])) out = obj.slice(0, i);
        if (out !== null) out.push(next);
      }
      return out ?? obj;
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec);
    let out: object | null = null;
    for (let i = 0; i < keys.length; i++) {
      const cur = rec[keys[i]];
      const next = walk(cur, onPath, keys[i]);
      if (out === null && !Object.is(next, cur)) {
        out = {};
        for (let j = 0; j < i; j++) copyOwn(out, keys[j], rec[keys[j]]);
      }
      if (out !== null) copyOwn(out, keys[i], next);
    }
    return out ?? obj;
  } finally {
    onPath.delete(obj);
  }
}
