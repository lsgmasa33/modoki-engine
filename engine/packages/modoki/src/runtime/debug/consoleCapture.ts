/** Console capture — a ring buffer over `console.*` for the debug menu's Console tab.
 *
 *  On device (and in a webview) there's no devtools console, so the debug menu needs
 *  its own log view. `installConsoleCapture()` wraps console.log/info/warn/error to
 *  record entries, then ALWAYS forwards to the original (so devtools + the editor's
 *  own console panel keep working). Installed once when the (enabled) debug menu
 *  chunk loads. No wall-clock (determinism guard) — entries carry a monotonic seq,
 *  not a timestamp. */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleEntry {
  seq: number;
  level: ConsoleLevel;
  text: string;
}

const MAX_ENTRIES = 300;
const buffer: ConsoleEntry[] = [];
const listeners = new Set<() => void>();
let seq = 0;
let version = 0;
let installed = false;
let recording = false; // re-entrancy guard (a logged object whose getter logs, etc.)
/** The ORIGINAL console.error, captured before patching. A flush-time failure must report through
 *  this and never through the patched method, which would record itself and re-enter the bump it
 *  is already inside. Null until `installConsoleCapture` runs. */
let originalError: ((...args: unknown[]) => void) | null = null;

// Notify OUT of the current task, coalesced to one call per burst.
//
// ⚠️ Synchronous notification is a REAL bug, not a style question. A `console.warn` raised from
// inside a React render body reaches a `useSyncExternalStore` subscriber synchronously — which is
// a setState during another component's render, and React logs a genuine console.error for it:
// "Cannot update a component (`ErrorToaster`) while rendering a different component
// (`UINodeInner`)". Measured on `games/anim-bug` (bug `mfAJ8yTNTqOQbU3sqY46`): `UINode` warns
// during render when an `imageSrc` points at a 3d-typed KTX2, and that one intentional,
// well-worded warning became a warning PLUS a scary React error in the same millisecond. Nothing
// about it is specific to that warn — ANY runtime warn or error emitted from a render path trips
// it. It also manufactures a spurious not-ok from `modoki_diagnose`, which gates on recent
// console errors.
//
// `version` still increments IMMEDIATELY, so a snapshot read straight after the log is already
// correct and `useSyncExternalStore` stays consistent; only the listener call is deferred.
// `queueMicrotask` rather than a timer or rAF: it is the smallest deferral that escapes the
// render, and unlike rAF it exists headless and unlike a timer it is not swallowed by fake
// timers in tests.
let notifyScheduled = false;
/** Bumped by the test reset, so a flush queued before it cannot fire against the new state. */
let notifyGeneration = 0;
function bump(): void {
  version++;
  if (notifyScheduled) return;
  notifyScheduled = true;
  const generation = notifyGeneration;
  queueMicrotask(() => {
    if (generation !== notifyGeneration) return; // reset between schedule and drain
    notifyScheduled = false;
    for (const l of listeners) {
      // Per-listener, and NOT optional. The loop used to run inside `record()`, which
      // `installConsoleCapture` wraps in "never let capture break logging" — deferring it to a
      // microtask moved it OUT of that try, so a throwing listener went from a silent no-op to an
      // uncaught exception. Swallowed here rather than left to escape, and reported through the
      // ORIGINAL console.error so it cannot recurse back into the capture that is mid-flush.
      try { l(); } catch (err) { originalError?.('[consoleCapture] a listener threw during flush', err); }
    }
  });
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function record(level: ConsoleLevel, args: unknown[]): void {
  if (recording) return; // guard against a logging getter / listener re-entering us
  recording = true;
  try {
    buffer.push({ seq: ++seq, level, text: args.map(stringifyArg).join(' ') });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
    bump();
  } finally {
    recording = false;
  }
}

/** Wrap console.* once. Idempotent. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  const levels: ConsoleLevel[] = ['log', 'info', 'warn', 'error'];
  originalError = console.error.bind(console);
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        record(level, args);
      } catch {
        /* never let capture break logging */
      }
      original(...args);
    };
  }
}

export function getConsoleEntries(): ConsoleEntry[] {
  return buffer;
}

/** Monotonic version — changes on every record/clear. Use as the useSyncExternalStore
 *  snapshot (the entries array is mutated in place, so its reference is stable and
 *  can't be the snapshot). */
export function getConsoleVersion(): number {
  return version;
}

export function clearConsoleEntries(): void {
  buffer.length = 0;
  bump();
}

export function subscribeConsole(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the capture (unwrap can't be undone, but clear state). */
export function __resetConsoleCaptureForTest(): void {
  notifyGeneration++;
  notifyScheduled = false;
  buffer.length = 0;
  seq = 0;
}
