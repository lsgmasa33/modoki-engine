/**
 * `perfCoreWorkers()` decides how many workers BOTH vitest suites run with, from inside the vite
 * configs — so it is load-bearing and, being config, is the kind of code nothing normally executes
 * in a test. The measurement behind it is in `engine/testWorkers.ts`; this pins the CONTRACT.
 *
 * The invariant worth guarding is the FALLBACK, not the happy path: a well-meaning "just always cap
 * it" would silently change parallelism on every machine in the fleet, and nothing else in the repo
 * would notice.
 *
 * ⚠️ This file used to assert that `win32` returns `{}`, on the reasoning that a homogeneous CPU
 * wants vitest's default. That was wrong and was corrected 2026-08-20: Windows boxes here are SMT,
 * so `availableParallelism()` counts hyperthreads, and the uncapped gate on the `win` clone does not
 * merely run slow — it goes RED on `testTimeout`, while being 44% SLOWER on the engine lane. The
 * measurement is in `engine/testWorkers.ts`. Linux keeps the default (the CI runners are not the
 * clone, and nothing has measured them).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { perfCoreWorkers } from '../../testWorkers';

const realPlatform = process.platform;
const realOverride = process.env.MODOKI_TEST_MAX_WORKERS;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Pretend the box has `n` logical CPUs.
 *
 *  Asserting against the REAL `availableParallelism()` only ever exercises the one branch this
 *  machine happens to land in — on a 12-thread dev box the "never cap up" guard never runs at all,
 *  so it could be deleted with the suite still green. The arithmetic is the whole contract here;
 *  it should not be tested at whatever width the CI runner and the dev box coincidentally share. */
function withCpus(n: number): void {
  vi.spyOn(os, 'availableParallelism').mockReturnValue(n);
}

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(realPlatform);
  if (realOverride === undefined) delete process.env.MODOKI_TEST_MAX_WORKERS;
  else process.env.MODOKI_TEST_MAX_WORKERS = realOverride;
});

describe('perfCoreWorkers', () => {
  it('honours MODOKI_TEST_MAX_WORKERS, on any platform', () => {
    process.env.MODOKI_TEST_MAX_WORKERS = '7';
    setPlatform('linux');
    expect(perfCoreWorkers()).toEqual({ maxWorkers: 7 });
    // The override is what `engine/scripts/verify.mjs` uses to keep its concurrent lanes from
    // oversubscribing each other, so it must win even where the sysctl path never runs.
    setPlatform('darwin');
    expect(perfCoreWorkers()).toEqual({ maxWorkers: 7 });
  });

  it('ignores a junk override rather than passing NaN to vitest', () => {
    // `maxWorkers: NaN` is not a documented vitest input and there is no reason to find out what it
    // does — a malformed env var should degrade to the default, not to undefined behaviour.
    setPlatform('linux');
    for (const junk of ['banana', '', '0', '-4']) {
      process.env.MODOKI_TEST_MAX_WORKERS = junk;
      expect(perfCoreWorkers(), `override "${junk}" should have been rejected`).toEqual({});
    }
  });

  it('returns {} on linux, leaving vitest its own default', () => {
    delete process.env.MODOKI_TEST_MAX_WORKERS;
    setPlatform('linux');
    expect(perfCoreWorkers()).toEqual({});
  });

  it('halves on win32 — an SMT sibling is not a core, and the uncapped gate goes RED', () => {
    delete process.env.MODOKI_TEST_MAX_WORKERS;
    setPlatform('win32');
    // 12 is the `win` clone the measurement came from (i5-11400, 6 physical / 12 logical): the cap
    // must land on 6, which is where the gate goes from red to green.
    withCpus(12);
    expect(perfCoreWorkers()).toEqual({ maxWorkers: 6 });
    // 4 is a GitHub `windows-latest` runner — the cap applies there too, and 2 < vitest's 3.
    withCpus(4);
    expect(perfCoreWorkers()).toEqual({ maxWorkers: 2 });
    // An ODD count is the only input that distinguishes ceil from floor, and every count above is
    // even — without this the rounding could be flipped with the suite still green. Round UP, so an
    // odd box is never left under-provisioned.
    withCpus(9);
    expect(perfCoreWorkers()).toEqual({ maxWorkers: 5 });
  });

  it('never caps UP, however few CPUs there are', () => {
    // The guard that makes this true (`half < availableParallelism()`) never executes on a normal
    // dev box, so without these it is unreachable code that the suite would happily let rot.
    delete process.env.MODOKI_TEST_MAX_WORKERS;
    setPlatform('win32');
    withCpus(1);
    expect(perfCoreWorkers(), 'a 1-CPU box must keep vitest its default').toEqual({});
    // At 2 and 3 the halving agrees with vitest's own `n - 1`, so capping is a no-op either way —
    // it must still never exceed the CPU count.
    for (const n of [2, 3]) {
      withCpus(n);
      const { maxWorkers } = perfCoreWorkers();
      expect(maxWorkers, `${n} CPUs`).toBeLessThan(n);
    }
  });

  it('caps below availableParallelism when it caps at all', () => {
    delete process.env.MODOKI_TEST_MAX_WORKERS;
    setPlatform(realPlatform);
    const result = perfCoreWorkers();
    // On a homogeneous CPU (Intel Mac, Linux, Windows) this is `{}`; on Apple Silicon it names the
    // performance-core count. Either is correct — what must never happen is a cap at or above the
    // total core count, which would be vitest's default wearing a disguise and would mean the
    // efficiency-core detection had silently stopped working.
    if (result.maxWorkers !== undefined) {
      expect(result.maxWorkers).toBeGreaterThan(0);
      expect(result.maxWorkers).toBeLessThan(os.availableParallelism());
    }
  });
});
