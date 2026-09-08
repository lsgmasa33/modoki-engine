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
let _manualEpoch: number | null = null;

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

/** True while a manual epoch is installed (`setManualEpoch()`) — the
 *  `rawEpochNow()` counterpart to `isManualClock()` above. The two overrides
 *  are independent: either can be installed (and torn down) without the
 *  other. */
export function isManualEpoch(): boolean {
  return _manualEpoch !== null;
}

/** Wall-clock EPOCH milliseconds — real `Date.now()` unless a manual epoch is
 *  installed. Deliberately a SEPARATE reading from `rawNow()`, not an alternate
 *  unit on the same value: `rawNow()` is monotonic and resets to ~0 on every
 *  navigation, so it can only answer "how long since this page loaded"; it
 *  cannot answer a question that crosses a boot (persistence, staleness, a
 *  cross-session age), because there is no fixed origin to measure from.
 *  `rawEpochNow()` is the one for that.
 *
 *  ⚠️ Package-internal to `runtime/**` — deliberately NOT re-exported from the
 *  `@modoki/engine` barrel (`runtime/index.ts`), so `engine/app/**` and
 *  `games/**` cannot reach it. That is also exactly the scope the determinism
 *  guard (`tests/runtime/determinismGuard.test.ts`) scans for a raw
 *  `Date.now()`/`performance.now()`: code outside `runtime/**` is not covered
 *  by that guard and has no need of this wrapper — it can read `Date.now()`
 *  directly.
 *
 *  Reaching for this inside a sim tick is almost certainly wrong — game state
 *  reads `getSimDelta()`/`getVisualDelta()`, not a wall-clock reading. */
export function rawEpochNow(): number {
  return _manualEpoch ?? Date.now();
}

/** Install a manual epoch pinned at `ms`. All subsequent `rawEpochNow()` calls
 *  return this value until `restoreRealEpoch()` clears it. Deliberately its OWN
 *  override, not `_manualNow` reused: the two are different units with
 *  different origins (monotonic-since-load vs. wall-clock epoch), and reusing
 *  one for the other would make an epoch stamp read as decades old the moment
 *  a test pins `_manualNow` at 0. */
export function setManualEpoch(ms: number): void {
  _manualEpoch = ms;
}

/** Revert to the real monotonic clock — clears ONLY the manual `rawNow()`
 *  override (`_manualNow`). Does NOT clear a manual epoch installed via
 *  `setManualEpoch()` — that is `restoreRealEpoch()`'s job. The two overrides
 *  are separate clocks with separate teardown: this used to clear both, which
 *  meant `stepSimulation`'s unconditional call to this (and `createTestWorld`'s
 *  `dispose()`) silently wiped out a manually-pinned epoch nobody asked either
 *  of them to touch. */
export function restoreRealClock(): void {
  _manualNow = null;
}

/** Revert to the real wall-clock epoch — clears ONLY the manual `rawEpochNow()`
 *  override (`_manualEpoch`). Does NOT clear a manual monotonic clock installed
 *  via `setManualNow()`/`advanceManual()` — that is `restoreRealClock()`'s job. */
export function restoreRealEpoch(): void {
  _manualEpoch = null;
}
