/**
 * `perfCoreWorkers()` decides how many workers BOTH vitest suites run with, from inside the vite
 * configs — so it is load-bearing and, being config, is the kind of code nothing normally executes
 * in a test. The measurement behind it is in `engine/testWorkers.ts`; this pins the CONTRACT.
 *
 * The invariant worth guarding is the FALLBACK, not the happy path. Returning `{}` on anything that
 * is not Apple Silicon is what keeps Linux/Windows — the CI runners and the `win` clone — on
 * vitest's own default. A well-meaning "just always cap it" would silently change parallelism on
 * every machine in the fleet, and nothing else in the repo would notice.
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { perfCoreWorkers } from '../../testWorkers';

const realPlatform = process.platform;
const realOverride = process.env.MODOKI_TEST_MAX_WORKERS;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
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

  it('returns {} off darwin, leaving vitest its own default', () => {
    delete process.env.MODOKI_TEST_MAX_WORKERS;
    for (const platform of ['linux', 'win32']) {
      setPlatform(platform);
      expect(perfCoreWorkers(), `${platform} must keep vitest's default`).toEqual({});
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
