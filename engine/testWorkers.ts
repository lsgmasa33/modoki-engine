import os from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * `{ maxWorkers }` capped to the machine's PERFORMANCE cores, or `{}` where that is unknowable.
 * Spread into a vitest `test` block. Shared by `engine/vite.config.ts` (the app suite) and
 * `engine/packages/modoki/vitest.config.ts` (the engine suite) so the two cannot drift.
 *
 * ── WHY (measured 2026-08-06, not guessed) ──
 *
 * Vitest defaults to `availableParallelism() - 1`, which on Apple Silicon counts EFFICIENCY cores
 * as if they were performance cores. They are not: a CPU-bound test file scheduled onto an E core
 * runs roughly 4x slower, and vitest's wall-clock is set by its SLOWEST FILE — so a single unlucky
 * placement becomes the entire run's critical path, and oversubscribing guarantees such placements.
 *
 * On this 12P+4E box the app suite measured **179s at the default 15 workers and 84s at 12**. 8
 * workers measured 101s, so this is a genuine optimum rather than "fewer is better": below the
 * performance-core count you simply leave P cores idle.
 *
 * The effect was invisible until Court's hint sweeps were sharded across 19 files. With only four
 * heavy files they nearly always landed on P cores; more parallelism EXPOSED the problem rather
 * than causing it, which is why sharding alone bought almost nothing (198s -> 179s).
 *
 * `hw.perflevel0.logicalcpu` exists only on Apple Silicon. On Intel Macs, Linux and Windows the
 * sysctl fails and this returns `{}` so vitest keeps its own default — correct for a homogeneous
 * CPU, and better than guessing at a split we cannot observe. ⚠️ That means the Windows clone does
 * NOT get this speedup; do not quote a Mac timing as if it were `win`'s.
 *
 * `MODOKI_TEST_MAX_WORKERS` overrides everything — for an unusual box, for bisecting a contention
 * problem, and for `engine/scripts/verify.mjs`, which budgets workers ACROSS its concurrent lanes
 * so two vitest pools do not oversubscribe each other.
 */
export function perfCoreWorkers(): { maxWorkers?: number } {
  const override = process.env.MODOKI_TEST_MAX_WORKERS
  if (override) {
    const n = Number(override)
    if (Number.isFinite(n) && n > 0) return { maxWorkers: n }
  }
  if (process.platform !== 'darwin') return {}
  try {
    const n = Number(execFileSync('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], { encoding: 'utf8' }).trim())
    // A single-perflevel machine reports its whole core count here, which is vitest's default
    // anyway — only cap when there really are efficiency cores to keep work off.
    return Number.isFinite(n) && n > 0 && n < os.availableParallelism() ? { maxWorkers: n } : {}
  } catch {
    return {} // not Apple Silicon (or sysctl unavailable) — vitest's default is right.
  }
}
