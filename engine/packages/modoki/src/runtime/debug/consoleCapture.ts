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

function bump(): void {
  version++;
  for (const l of listeners) l();
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
  buffer.length = 0;
  seq = 0;
}
