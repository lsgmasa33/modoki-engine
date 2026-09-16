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
  /** The id shared by every process of ONE gate — `peers` counts distinct groups, not entries.
   *  Optional: an entry written by a pre-#1285 clone has none and falls back to its own pid. */
  group?: string;
}

/** This run's share of the box. `peers` COUNTS THIS RUN, so a solo gate reports 1. */
export interface VerifyBudget {
  peers: number;
  /** This run's group id. The caller publishes it to children it spawns, so they JOIN this run
   *  instead of counting against it. ⚠️ This sidecar is hand-written and drifts silently: the
   *  field was added to the implementation's return and omitted here, and only the root typecheck
   *  caught it — the tests using it had already passed. */
  group: string;
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
export const VERIFY_GROUP_ENV: string;
export const VERIFY_REGISTERED_ENV: string;

export function groupOf(run: Partial<VerifyRun> | null | undefined): string;
export function countGroups(runs: Array<Partial<VerifyRun>>): number;

/** True only when vitest is actually running — `engine/vite.config.ts` is the dev server's config
 *  too, so registering on config evaluation alone would register the editor. Fails closed. */
export function isTestRun(env?: NodeJS.ProcessEnv): boolean;

/** Registers any vitest pool. `null` when this process tree already registered — the caller then
 *  owns no registration and must not unregister. Never throws. */
export function registerTestRun(
  opts?: RunsOpts & {
    pid?: number;
    clone?: string;
    total?: number;
    group?: string;
    env?: NodeJS.ProcessEnv;
  },
): VerifyBudget | null;

/** The SHARED registry directory. ⚠️ Deliberately not `claimsDir()`, which redirects to a per-pid
 *  temp dir under vitest — a registry only this process can read is useless. Honours `MODOKI_HOME`
 *  and nothing else. */
export function verifyRegistryDir(opts?: { env?: NodeJS.ProcessEnv; home?: string }): string;

export function registryPath(dir?: string): string;
export function perfCores(opts?: { platform?: NodeJS.Platform | string }): number;
export function isLiveRun(run: VerifyRun | null | undefined, opts?: RunsOpts): boolean;
export function readRuns(opts?: RunsOpts): VerifyRun[];
export function budgetFor(total: number, runners: number): number;
export function registerVerifyRun(
  opts?: RunsOpts & {
    pid?: number;
    clone?: string;
    total?: number;
    group?: string;
    env?: NodeJS.ProcessEnv;
  },
): VerifyBudget;
export function unregisterVerifyRun(opts?: RunsOpts & { pid?: number }): void;
/** ⚠️ Takes only the fields it PRINTS, not a whole `VerifyBudget`. Widening it to the full budget
 *  made adding `group` a breaking change for every caller that builds the argument by hand — the
 *  line reports context and has no business requiring a group id it never renders. */
export function benchLine(
  b: Pick<VerifyBudget, 'peers' | 'total' | 'appWorkers' | 'engineWorkers'>
    & { load?: number[]; platform?: NodeJS.Platform | string },
): string;

/** vitest's cross-worker aggregate breakdown, in SECONDS (a `17ms` value becomes `0.017`).
 *  `null` when the output carries no `Duration` line. */
export function parseVitestAggregates(
  output: string | undefined,
): { duration: number; parts: Record<string, number> } | null;
