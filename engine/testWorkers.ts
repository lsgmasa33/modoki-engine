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
 * `hw.perflevel0.logicalcpu` exists only on Apple Silicon. On Intel Macs and Linux the sysctl
 * fails and this returns `{}` so vitest keeps its own default — correct for a homogeneous CPU,
 * and better than guessing at a split we cannot observe. ⚠️ Do not quote a Mac timing as if it
 * were `win`'s; the machines are not comparable.
 *
 * ── WINDOWS: halve, because hyperthreads are not cores (measured 2026-08-20) ──
 *
 * Same failure as Apple Silicon's E cores, different cause: vitest's `availableParallelism() - 1`
 * counts SMT siblings as if they were cores. On the `win` clone (i5-11400, 6 physical / 12 logical)
 * that is 11 workers on 6 cores, and the gate does not merely slow down — it goes RED, because the
 * first casualties are the tests nearest `testTimeout` and they fail as *timeouts*, which reads
 * exactly like a regression.
 *
 * Measured on ONE commit (566d2af19), both lanes, capped vs default:
 *
 *   capped 6 → app 489.2s PASS · engine 308.6s PASS
 *   default  → app 493.0s FAIL · engine 443.7s FAIL  (qaCaseReferences + barrelImportOrder time
 *              out at 20s; rampProbeRunner's 5ms budget measures 74.5ms)
 *
 * So the extra workers buy NOTHING — the app lane is a wash and the engine lane is 44% slower —
 * and cost the gate. There is no tradeoff here to tune.
 *
 * `ceil(availableParallelism() / 2)` deliberately, NOT a physical-core probe. On an SMT box it IS
 * the physical count; on a non-SMT box it over-halves, and the measurement above shows halving
 * costs ~0 wall-clock, so that downside is empirically nil. The correct probe
 * (`Get-CimInstance Win32_Processor`) costs ~1.9s per vitest launch — noise inside `verify`, but it
 * doubles a single-file run, and `os.cpus().length` cannot answer since it reports LOGICAL cores.
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
  if (process.platform === 'win32') {
    const half = Math.ceil(os.availableParallelism() / 2)
    // Never cap UP: on a 1-2 thread box vitest's default is already at or below this.
    return half > 0 && half < os.availableParallelism() ? { maxWorkers: half } : {}
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
