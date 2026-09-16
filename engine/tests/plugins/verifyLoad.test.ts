/** `engine/scripts/verifyLoad.mjs` — the cross-clone worker budget behind `npm run verify` (#1285).
 *
 *  Why this file exists: the budget decides how many vitest workers every clone's gate gets, and it
 *  fails SILENTLY in the direction that matters. A budget that hands out too many slots does not
 *  throw — it reproduces the contention it was written to remove, and the symptom surfaces as a
 *  timeout in some unrelated test on some other clone hours later (#751, #1046, #505, #1059, #1099
 *  are five instances of exactly that, each fixed as if it were a local flake).
 *
 *  Everything here is driven through the injectable `dir` / `alive` / `now` / `platform` seams, so
 *  no test touches the real `~/.modoki`. */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import {
  perfCores, budgetFor, isLiveRun, readRuns, registerVerifyRun, unregisterVerifyRun, benchLine,
  parseVitestAggregates, registryPath, MIN_WORKERS, VERIFY_TTL_MS,
} from '../../scripts/verifyLoad.mjs';

let dir: string;
const alive = () => true;
const dead = () => false;

// `makeScratchDir`, not a raw `mkdtemp` — it removes the dir after the file whether the test passes
// or throws. #1117: raw mkdtemp in tests leaked 6,788 dirs into os.tmpdir() before anyone noticed.
beforeEach(() => {
  dir = makeScratchDir('modoki-verifyload-');
});

describe('budgetFor — dividing the performance-core pool', () => {
  it('gives a solo run the whole pool, and splits it as clones pile on', () => {
    // The solo case is load-bearing: `verify.mjs` only applies the budget when peers > 1, so this
    // number IS today's behaviour and a change here changes every clone's gate.
    expect(budgetFor(12, 1)).toBe(12);
    expect([2, 3, 4, 6].map((n) => budgetFor(12, n))).toEqual([6, 4, 3, 2]);
  });

  it('never starves a run below MIN_WORKERS, however many clones are running', () => {
    // `testWorkers.ts` measured the engine suite going 25s -> 64-80s at 3 workers. A gate that
    // cannot finish is worse than a contended one, so the floor is not negotiable.
    expect(budgetFor(12, 99)).toBe(MIN_WORKERS);
    expect(budgetFor(1, 50)).toBe(MIN_WORKERS);
  });

  it('treats a nonsense runner count as one runner rather than dividing by zero', () => {
    expect(budgetFor(12, 0)).toBe(12);
    expect(budgetFor(12, -3)).toBe(12);
  });
});

describe('perfCores — the pool being divided', () => {
  it('halves on Windows, because SMT siblings are not cores', () => {
    // ⚠️ THE REGRESSION TEST FOR 60a1b111a. This branch sat AFTER the Apple Silicon sysctl probe,
    // which succeeds on the Mac this was written on and returned first — so `win32` answered 12
    // instead of 8, and the branch could not be exercised anywhere it could be observed. Keep the
    // platform check ahead of the probe or this goes red.
    const logical = os.availableParallelism?.() ?? os.cpus().length;
    expect(perfCores({ platform: 'win32' })).toBe(Math.ceil(logical / 2));
  });

  it('gives a homogeneous CPU the logical count, WITHOUT consulting the darwin sysctl', () => {
    // ⚠️ The second half of the same seam bug. The first fix moved `win32` above the probe and left
    // every other platform below it, so on this Mac `linux` answered 12 — darwin's PERFORMANCE-core
    // count — where the right answer is the full logical count. Found by review, not by the fix.
    const logical = os.availableParallelism?.() ?? os.cpus().length;
    expect(perfCores({ platform: 'linux' })).toBe(logical);
    expect(perfCores({ platform: 'freebsd' })).toBe(logical);
  });

  it('returns a usable positive count on this machine', () => {
    const n = perfCores();
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe('benchLine — the context that makes a timing a measurement', () => {
  const budget = { peers: 2, total: 12, appWorkers: 6, engineWorkers: 3 };

  it('prints the load average on a platform that reports one', () => {
    const line = benchLine({ ...budget, load: [29.7, 34.3, 20.1], platform: 'darwin' });
    expect(line).toContain('load 29.7/34.3');
    expect(line).toContain('2 verify run(s) on 12 perf core(s)');
    expect(line).toContain('workers app=6 engine=3');
  });

  it('says n/a on Windows rather than printing a fake idle box', () => {
    // `os.loadavg()` is ALWAYS [0,0,0] on Windows. Printed raw it reads as a quiet machine — on the
    // one platform documented to go RED under oversubscription, which is what this line is for.
    const line = benchLine({ ...budget, load: [0, 0, 0], platform: 'win32' });
    expect(line).not.toContain('load 0.0/0.0');
    expect(line).toContain('n/a');
    // The parts that ARE meaningful on Windows must survive.
    expect(line).toContain('2 verify run(s)');
    expect(line).toContain('workers app=6 engine=3');
  });
});

describe('isLiveRun — expiry is BOTH the pid check and the TTL (#225)', () => {
  const run = (over: Partial<{ pid: number; startedAt: number }> = {}) =>
    ({ pid: 4242, clone: '/x', startedAt: Date.now(), ...over });

  it('is live only when the process is alive AND it is inside the TTL', () => {
    expect(isLiveRun(run(), { alive })).toBe(true);
  });

  it('expires a dead pid IMMEDIATELY rather than waiting out the TTL', () => {
    // The #225 scar in the device store: expiry applied on read alone makes a dead entry merely
    // LOOK live. Here it would shrink every other clone's budget for 45 minutes.
    expect(isLiveRun(run(), { alive: dead })).toBe(false);
  });

  it('expires past the TTL even when a recycled pid still answers', () => {
    const now = Date.now();
    expect(isLiveRun(run({ startedAt: now - VERIFY_TTL_MS - 1 }), { now, alive })).toBe(false);
    expect(isLiveRun(run({ startedAt: now - VERIFY_TTL_MS + 1000 }), { now, alive })).toBe(true);
  });

  it('rejects a malformed entry instead of trusting it', () => {
    expect(isLiveRun(null as never, { alive })).toBe(false);
    expect(isLiveRun({ pid: 'x', startedAt: Date.now() } as never, { alive })).toBe(false);
    expect(isLiveRun({ pid: 1 } as never, { alive })).toBe(false);
  });
});

describe('readRuns — a broken registry must not break the gate', () => {
  it('returns nothing when the file does not exist', () => {
    expect(readRuns({ dir, alive })).toEqual([]);
  });

  it('returns nothing for a truncated or hand-mangled file, rather than throwing', () => {
    // A throw here would fail `verify` for the state of somebody's home directory, which is exactly
    // the class of red this whole change exists to remove.
    fs.writeFileSync(registryPath(dir), '{"runs": [{"pid": 1,');
    expect(() => readRuns({ dir, alive })).not.toThrow();
    expect(readRuns({ dir, alive })).toEqual([]);
  });

  it('returns nothing when `runs` is present but not an array', () => {
    fs.writeFileSync(registryPath(dir), JSON.stringify({ runs: { pid: 1 } }));
    expect(readRuns({ dir, alive })).toEqual([]);
  });

  it('prunes entries whose process is gone, keeping the live ones', () => {
    registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12 });
    registerVerifyRun({ pid: 222, clone: '/b', dir, alive, total: 12 });
    expect(readRuns({ dir, alive: (p: number) => p === 222 }).map((r) => r.pid)).toEqual([222]);
  });
});

describe('registerVerifyRun / unregisterVerifyRun', () => {
  it('counts THIS run in `peers`, so a solo gate reports 1 and keeps the whole pool', () => {
    const r = registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12 });
    expect(r.peers).toBe(1);
    expect(r.appWorkers).toBe(12);
    expect(r.engineWorkers).toBe(6);
  });

  it('shrinks each run\'s share as clones join', () => {
    registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12 });
    const second = registerVerifyRun({ pid: 222, clone: '/b', dir, alive, total: 12 });
    const third = registerVerifyRun({ pid: 333, clone: '/c', dir, alive, total: 12 });
    expect([second.peers, third.peers]).toEqual([2, 3]);
    expect([second.appWorkers, third.appWorkers]).toEqual([6, 4]);
    // The engine lane has always taken about half the app lane's pool and runs inside it.
    expect([second.engineWorkers, third.engineWorkers]).toEqual([3, 2]);
  });

  it('does not double-count a run that registers twice', () => {
    registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12 });
    expect(registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12 }).peers).toBe(1);
  });

  it('removes only its own entry, and is safe to call twice', () => {
    registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12 });
    registerVerifyRun({ pid: 222, clone: '/b', dir, alive, total: 12 });
    unregisterVerifyRun({ pid: 222, dir, alive });
    expect(readRuns({ dir, alive }).map((r) => r.pid)).toEqual([111]);
    // `verify.mjs` releases from BOTH the SIGINT handler and a `process.on('exit')`, so the double
    // call is the normal Ctrl-C path, not a hypothetical.
    expect(() => unregisterVerifyRun({ pid: 222, dir, alive })).not.toThrow();
    expect(readRuns({ dir, alive }).map((r) => r.pid)).toEqual([111]);
  });

  it('still returns a usable budget when the registry cannot be written', () => {
    // An unwritable ~/.modoki must degrade to "behave as before this module existed", never fail
    // the gate. Simulated with a path whose parent is a FILE, so mkdir/rename cannot succeed.
    const blocked = path.join(dir, 'a-file', 'nested');
    fs.writeFileSync(path.join(dir, 'a-file'), 'not a directory');
    let r: ReturnType<typeof registerVerifyRun>;
    expect(() => { r = registerVerifyRun({ pid: 111, clone: '/a', dir: blocked, alive, total: 12 }); })
      .not.toThrow();
    expect(r!.peers).toBe(1);
    expect(r!.appWorkers).toBe(12);
    expect(() => unregisterVerifyRun({ pid: 111, dir: blocked, alive })).not.toThrow();
  });
});

describe('parseVitestAggregates — the figures that survive a contended box', () => {
  it('pulls the cross-worker breakdown out of a real reporter line', () => {
    const got = parseVitestAggregates(
      '   Duration  328.99s (transform 83.94s, setup 144.63s, import 1211.56s, tests 1088.77s, environment 1165.75s)',
    );
    expect(got?.duration).toBe(328.99);
    expect(got?.parts).toEqual({
      transform: 83.94, setup: 144.63, import: 1211.56, tests: 1088.77, environment: 1165.75,
    });
  });

  it('converts a millisecond value to seconds, so the units in one row match', () => {
    // Real output after the jsdom flip: `environment 17ms`. Reported raw it would read as 17
    // SECONDS beside five figures in seconds — a 1000x error in the one number the change is about.
    const got = parseVitestAggregates('   Duration  42.51s (transform 13.45s, environment 17ms)');
    expect(got?.parts.environment).toBe(0.017);
    expect(got?.parts.transform).toBe(13.45);
  });

  it('still parses when vitest colours its output (FORCE_COLOR)', () => {
    // Vitest dims the `(…)` group. With colour on, `\s+\(` cannot cross the escape, the match fails
    // and the caller drops the line SILENTLY — removing exactly the figures a contended box is
    // compared by, for someone who set FORCE_COLOR to read the gate more easily.
    const coloured = '   Duration  42.51s \x1b[2m (transform 13.45s, environment 17ms)\x1b[22m';
    const got = parseVitestAggregates(coloured);
    expect(got?.duration).toBe(42.51);
    expect(got?.parts.environment).toBe(0.017);
  });

  it('returns null rather than a half-parsed object when there is no Duration line', () => {
    expect(parseVitestAggregates('Test Files  865 passed')).toBeNull();
    expect(parseVitestAggregates('')).toBeNull();
    expect(parseVitestAggregates(undefined as never)).toBeNull();
  });
});
