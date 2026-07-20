/** consoleCapture — intercepts console.log/warn/error plus uncaught errors and
 *  unhandled promise rejections, buffering them for the Console panel.
 *
 *  This is split out of Console.tsx so the capture can be installed at the VERY
 *  beginning of editor launch (from createEditor, before any lazy panel bundle
 *  loads). Console.tsx imports the shared buffer + install fn from here so that
 *  nothing fired during early init is missed. */

export interface LogEntry {
  id: number;
  time: string;
  level: 'log' | 'warn' | 'error';
  message: string;
  stack: string;
}

let logIdCounter = 0;
export const logBuffer: LogEntry[] = [];
export const MAX_LOGS = 1000;
let captureInstalled = false;

/** Set by the Console panel to be notified when a new log lands. */
let _onNewLog: (() => void) | null = null;
export function setOnNewLog(cb: (() => void) | null) { _onNewLog = cb; }

// Coalesce notifications: a burst of N logs in one tick (a loop that logs, a
// hot-reload dumping warnings) would otherwise fire `_onNewLog` N times → N Console
// re-renders, each re-filtering the whole buffer. Batch to ONE notification per
// frame. rAF in the editor (Electron/browser); setTimeout(0) fallback for headless.
// (editor-core F2 / panels F4)
let _notifyScheduled = false;
const scheduleFlush: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => { requestAnimationFrame(cb); }
    : (cb) => { setTimeout(cb, 0); };

function notifyNewLog() {
  if (!_onNewLog || _notifyScheduled) return;
  _notifyScheduled = true;
  scheduleFlush(() => {
    _notifyScheduled = false;
    _onNewLog?.(); // re-check: the panel may have unmounted during the frame
  });
}

/** Current high-water mark of the id counter — Console uses this to bump a
 *  re-render version and to force a refresh after clearing the buffer. */
export function getLogIdCounter() { return logIdCounter; }
export function bumpLogIdCounter() { return ++logIdCounter; }

// Original console methods, captured before patching. The error/rejection
// handlers below MUST use these (not the patched methods) to avoid recursion.
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

function formatTime(now: Date): string {
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
}

// Stack source: either an already-resolved string (window error/rejection handlers
// already hold one) or an `Error` whose `.stack` is formatted LAZILY. Reading
// `Error.stack` triggers V8 to format the structured trace into a string — the
// expensive part — so for console-method captures we defer it until the Console
// panel actually displays the selected entry's stack (Console.tsx reads `.stack`
// only for the clicked row). `log`-level captures pass '' (no stack) entirely.
// (editor-core F2 part b)
type StackSource = string | Error;

function makeEntry(level: LogEntry['level'], message: string, src: StackSource): LogEntry {
  const base = { id: logIdCounter++, time: formatTime(new Date()), level, message };
  if (typeof src === 'string') return { ...base, stack: src };
  // Lazy: format `Error.stack` once, on first read, dropping the 3 internal frames
  // (Error header + addEntry + the patched console method — see addEntry note).
  const err = src;
  let computed: string | undefined;
  const entry = base as LogEntry;
  Object.defineProperty(entry, 'stack', {
    enumerable: true,
    configurable: true,
    get() {
      if (computed === undefined) {
        computed = (err.stack || '').split('\n').slice(3).join('\n').trim();
      }
      return computed;
    },
  });
  return entry;
}

function pushEntry(level: LogEntry['level'], message: string, src: StackSource) {
  logBuffer.push(makeEntry(level, message, src));
  if (logBuffer.length > MAX_LOGS) logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  notifyNewLog();
}

function stringifyArgs(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === 'string') parts.push(a);
    else if (a == null) parts.push(String(a));
    else {
      try { parts.push(JSON.stringify(a, null, 2)); }
      catch { parts.push('[Circular]'); }
    }
  }
  return parts.join(' ');
}

/** Install console + window error/rejection interception. Idempotent. */
export function installConsoleCapture() {
  if (captureInstalled) return;
  captureInstalled = true;

  function addEntry(level: LogEntry['level'], args: unknown[]) {
    const message = stringifyArgs(args);
    // Stack capture: `log`-level entries rarely need a trace and capturing one on
    // EVERY log is the hot cost, so skip it. warn/error keep a stack, but hand the
    // raw `Error` to `makeEntry` so the (expensive) `.stack` string is formatted
    // LAZILY, only if the user clicks the entry to expand it. The `Error` is
    // allocated HERE (not in makeEntry/pushEntry) so the frame depth the `slice(3)`
    // assumes is stable: line 0 is the "Error" header, then addEntry, then the
    // patched console method, then the real caller. (V8/Chromium-only by design —
    // the editor ships in Electron; on a non-V8 engine the header line is absent and
    // one real frame would be dropped, acceptable since it never runs there.)
    // (editor-core F2 part b / F10)
    pushEntry(level, message, level === 'log' ? '' : new Error());
  }

  console.log = (...args: unknown[]) => { origLog(...args); addEntry('log', args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); addEntry('warn', args); };
  console.error = (...args: unknown[]) => { origError(...args); addEntry('error', args); };

  if (typeof window !== 'undefined') {
    // Uncaught errors — including resource load errors (which arrive as a plain
    // Event, not an ErrorEvent, and carry no .error). Use the original console
    // methods inside the handler to avoid recursion through the patched ones.
    window.addEventListener('error', (event: Event) => {
      try {
        if (event instanceof ErrorEvent) {
          const err = event.error;
          const message = event.message || (err instanceof Error ? err.message : String(err));
          // "ResizeObserver loop completed with undelivered notifications" is a
          // benign browser warning fired when an observer callback dirties layout
          // and the next batch spills into a follow-up frame. Nothing actually
          // breaks (there's no .error, no stack) and it's emitted by our own
          // resize-driven editor overlays. Swallow it so it doesn't masquerade as
          // an uncaught error in the Console.
          if (message.includes('ResizeObserver loop')) {
            event.stopImmediatePropagation();
            return;
          }
          const stack = err instanceof Error ? (err.stack || '') : '';
          pushEntry('error', `Uncaught: ${message}`, stack);
        } else {
          // Resource load error (img/script/link). target has src/href.
          const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
          const url = target?.src || target?.href || '';
          const tag = target?.tagName?.toLowerCase() || 'resource';
          pushEntry('error', `Resource load error: <${tag}> ${url}`.trim(), '');
        }
      } catch (e) {
        origError('[consoleCapture] error handler failed', e);
      }
    }, true); // capture phase so resource errors (which don't bubble) are seen

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      try {
        const reason = event.reason;
        const message = reason instanceof Error ? reason.message : stringifyArgs([reason]);
        const stack = reason instanceof Error ? (reason.stack || '') : '';
        pushEntry('error', `Unhandled rejection: ${message}`, stack);
      } catch (e) {
        origError('[consoleCapture] rejection handler failed', e);
      }
    });
  }
}

// Install at module load so logs/errors that fire during early app init (before
// the Console panel mounts) are still captured into the buffer.
installConsoleCapture();
