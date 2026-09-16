/** Type sidecar for `verifyLoad.mjs` — see that file for the design rationale (#1285).
 *  Hand-written because the module is plain JS (`engine/scripts/verify.mjs` is a plain-JS CLI and
 *  cannot import TypeScript), but `engine/tests/plugins/verifyLoad.test.ts` imports it and is
 *  typechecked normally. Same pattern as `deviceClaimsStore.mjs`/`.d.mts`. */

/** One in-flight `npm run verify`, machine-wide. */
export interface VerifyRun {
  /** The `verify.mjs` process's pid — one half of the expiry test. */
  pid: number;
  /** The clone this run belongs to, for reading the registry by eye. Never used for matching. */
  clone: string;
  /** Epoch ms. The other half of the expiry test, via `VERIFY_TTL_MS`. */
  startedAt: number;
}

/** This run's share of the box. `peers` COUNTS THIS RUN, so a solo gate reports 1. */
export interface VerifyBudget {
  peers: number;
  /** Performance cores being divided (`perfCores()` unless injected). */
  total: number;
  appWorkers: number;
  engineWorkers: number;
}

/** Seams for the tests; every one defaults to the real thing. */
export interface RunsOpts {
  dir?: string;
  now?: number;
  alive?: (pid: number) => boolean;
}

export const VERIFY_REGISTRY_FILE: string;
export const VERIFY_TTL_MS: number;
export const MIN_WORKERS: number;

export function registryPath(dir?: string): string;
export function perfCores(opts?: { platform?: NodeJS.Platform | string }): number;
export function isLiveRun(run: VerifyRun | null | undefined, opts?: RunsOpts): boolean;
export function readRuns(opts?: RunsOpts): VerifyRun[];
export function budgetFor(total: number, runners: number): number;
export function registerVerifyRun(
  opts?: RunsOpts & { pid?: number; clone?: string; total?: number },
): VerifyBudget;
export function unregisterVerifyRun(opts?: RunsOpts & { pid?: number }): void;
export function benchLine(
  b: VerifyBudget & { load?: number[]; platform?: NodeJS.Platform | string },
): string;

/** vitest's cross-worker aggregate breakdown, in SECONDS (a `17ms` value becomes `0.017`).
 *  `null` when the output carries no `Duration` line. */
export function parseVitestAggregates(
  output: string | undefined,
): { duration: number; parts: Record<string, number> } | null;
