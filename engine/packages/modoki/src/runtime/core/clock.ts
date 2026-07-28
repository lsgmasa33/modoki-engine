/** Injectable wall-clock source for `timeSystem` (Phase 1 — verification harness).
 *
 *  Production reads `performance.now()` via `rawNow()`. Tests/headless playtests
 *  install a MANUAL clock so a run is reproducible: `setManualNow()` pins the
 *  timestamp and `advanceManual(dtMs)` steps it by an exact amount, so
 *  `timeSystem` produces a deterministic delta with no real wall-clock involved.
 *
 *  `timeSystem` keeps its own `lastTime`/delta math — this module only swaps the
 *  *source* of "now", so behavior is byte-identical in production (the default
 *  path is literally `performance.now()`). */

let _manualNow: number | null = null;

/** Current timestamp in milliseconds — real `performance.now()` unless a manual
 *  clock is installed. */
export function rawNow(): number {
  return _manualNow ?? performance.now();
}

/** Install a manual clock pinned at `ms`. All subsequent `rawNow()` calls return
 *  this value until `advanceManual()` moves it or `restoreRealClock()` clears it. */
export function setManualNow(ms: number): void {
  _manualNow = ms;
}

/** Advance the manual clock by `dtMs` milliseconds (installs it at 0 first if
 *  not already manual). The deterministic-step primitive builds on this. */
export function advanceManual(dtMs: number): void {
  _manualNow = (_manualNow ?? 0) + dtMs;
}

/** True while a manual clock is installed. */
export function isManualClock(): boolean {
  return _manualNow !== null;
}

/** Revert to the real `performance.now()` clock. */
export function restoreRealClock(): void {
  _manualNow = null;
}
