/** Type sidecar for recordTakeBoot.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Boot attempts before a reloading page is reported as a failure. */
export declare const MAX_BOOT_ATTEMPTS: number;

/** Did the page reload — `navigations` main-frame navigations so far (the `goto` is 1), or an error
 *  whose text says the execution context was destroyed. */
export declare function pageReloaded(navigations: number, error?: unknown): boolean;

/** A failed boot attempt is a reload (retry) unless the render is being cancelled. */
export declare function failedAttemptReloaded(opts: { navigations: number; error: unknown; cancelling: boolean }): boolean;

/** One boot attempt's result: did the page reload during it, and what it produced or threw. */
export type BootOutcome<T> = { reloaded: boolean; value: T } | { reloaded: boolean; error: unknown };

/** Run `attempt(n)` until one boots without a reload; see the implementation's docblock. */
export declare function bootWithReloadRetry<T>(
  attempt: (n: number) => Promise<BootOutcome<T>>,
  opts?: { maxAttempts?: number; discard?: (outcome: BootOutcome<T>) => Promise<void>; onReload?: (n: number) => void },
): Promise<{ value: T; reloads: number }>;
