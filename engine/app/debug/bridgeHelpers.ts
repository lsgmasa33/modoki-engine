/** Pure, dependency-free helpers for the debug bridge (app/debug/bridge.ts) — no Capacitor/DOM
 *  imports, so they're directly unit-testable. bridge.ts imports these instead of the tests
 *  re-implementing them (which let copies silently drift from the shipping code — code-review T7). */

/** Native (iOS drawHierarchy) capture dims, kept by the bridge after a native screenshot. */
export interface LastScreenInfo { imageWidth: number; imageHeight: number; screenWidth: number; screenHeight: number }
/** Per-request adb capture dims, passed by the MCP with a tap/drag (Android). */
export interface ScreenInfoParam { imgW: number; imgH: number; nativeW: number; nativeH: number }

export const MAX_CONSOLE_LOGS = 200;

export interface ConsoleLine {
  type: 'console';
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

export function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
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

/** Run `code` as a function body (so `return x` yields a value — the device_eval contract) and
 *  serialize the result, or return an `Error: …` string. (The old `eval` fallback was dead — a
 *  function body is a superset of a script — and double-executed side effects on a runtime error.) */
export function handleEval(code: string): unknown {
  try {
    const fn = new Function(code);
    return safeStringify(fn());
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/** A bounded console-capture ring: `push` records an entry (args serialized), `query` returns the
 *  last N (optionally filtered by level). */
export function createConsoleRing(maxLogs: number) {
  const entries: ConsoleLine[] = [];
  return {
    entries,
    push(level: ConsoleLine['level'], args: unknown[]): void {
      entries.push({ type: 'console', level, args: args.map(safeStringify), timestamp: Date.now() });
      if (entries.length > maxLogs) entries.shift();
    },
    query(limit: number, level?: string): ConsoleLine[] {
      const filtered = level ? entries.filter((l) => l.level === level) : entries;
      return filtered.slice(-limit);
    },
  };
}
