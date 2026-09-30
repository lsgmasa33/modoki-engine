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
import { fileURLToPath } from 'node:url';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { readScannedSource } from '@modoki/engine/testing';
import {
  perfCores, budgetFor, isLiveRun, readRuns, registerVerifyRun, unregisterVerifyRun, benchLine,
  parseVitestAggregates, registryPath, MIN_WORKERS, VERIFY_TTL_MS,
  groupOf, countGroups, isTestRun, registerTestRun, VERIFY_GROUP_ENV, VERIFY_REGISTERED_ENV,
  verifyRegistryDir, engineLaneWorkers, LEGACY_ENGINE_LANE_WORKERS, verifyPoolSize, appLaneWorkers,
  groupNeeds, testRunNeed, VITEST_VALUE_FLAGS, VITEST_BOOLEAN_FLAGS,
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
    // ⚠️ `env: {}` per call, because three CLONES are three PROCESSES with three environments.
    // Sharing this process's env would hand all three the same `MODOKI_VERIFY_GROUP` — which the
    // vitest run executing this test has itself set — and they would collapse into one peer. That
    // is correct production behaviour (a lane of a gate JOINS that gate) and wrong for this case.
    registerVerifyRun({ pid: 111, clone: '/a', dir, alive, total: 12, env: {} });
    const second = registerVerifyRun({ pid: 222, clone: '/b', dir, alive, total: 12, env: {} });
    const third = registerVerifyRun({ pid: 333, clone: '/c', dir, alive, total: 12, env: {} });
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

describe('group identity — N processes of ONE gate must count ONCE', () => {
  it('falls back to the pid when an entry carries no group (a pre-#1285 clone)', () => {
    // A mixed fleet mid-upgrade writes entries with no `group`. Those must stay DISTINCT from each
    // other rather than collapsing into one shared "undefined" group, which would under-count the
    // box and hand every clone a pool it does not have.
    expect(groupOf({ pid: 42, clone: '/a', startedAt: 0 })).toBe('42');
    expect(groupOf({ pid: 7, clone: '/a', startedAt: 0, group: 'g1' })).toBe('g1');
    expect(countGroups([
      { pid: 1, clone: '/a', startedAt: 0 },
      { pid: 2, clone: '/b', startedAt: 0 },
    ])).toBe(2);
  });

  it('counts a gate and BOTH its lanes as one peer, not three', () => {
    // The regression this whole mechanism can cause: `verify.mjs` spawns two vitest lanes, both now
    // register themselves, and a SOLO gate would read peers=3 and budget itself to a third of a box
    // it owns entirely. That is worse than the blindness being fixed.
    registerVerifyRun({ pid: 100, clone: '/hub', dir, alive, total: 12, env: {}, group: 'gate-100' });
    registerVerifyRun({ pid: 101, clone: '/hub', dir, alive, total: 12, env: {}, group: 'gate-100' });
    const engineLane = registerVerifyRun({
      pid: 102, clone: '/hub', dir, alive, total: 12, env: {}, group: 'gate-100',
    });
    expect(engineLane.peers).toBe(1);
    expect(engineLane.appWorkers).toBe(12);
    expect(readRuns({ dir, alive })).toHaveLength(3); // three entries, one group
  });

  it('still counts a SEPARATE run as its own peer while a gate is registered', () => {
    // The point of the change: a scoped run or a mutation check on another clone is a real consumer
    // and must show up. If this passes only because everything is one group, the fix does nothing.
    registerVerifyRun({ pid: 100, clone: '/hub', dir, alive, total: 12, env: {}, group: 'gate-100' });
    registerVerifyRun({ pid: 101, clone: '/hub', dir, alive, total: 12, env: {}, group: 'gate-100' });
    const mutationCheck = registerVerifyRun({ pid: 200, clone: '/qa', dir, alive, total: 12, env: {} });
    expect(mutationCheck.peers).toBe(2);
    expect(mutationCheck.appWorkers).toBe(6);
  });

  it('inherits the group from the environment, which is how a lane joins its gate', () => {
    const laneEnv = { [VERIFY_GROUP_ENV]: 'gate-999' };
    const lane = registerVerifyRun({ pid: 300, clone: '/hub', dir, alive, total: 12, env: laneEnv });
    expect(lane.group).toBe('gate-999');
  });

  it('does NOT write the group back into the env it was given', () => {
    // An earlier draft published here, and the second logically-distinct run in one process then
    // picked up the first one's group and the two collapsed into one peer. Publication belongs to
    // the caller that spawns children.
    const env: NodeJS.ProcessEnv = {};
    registerVerifyRun({ pid: 400, clone: '/a', dir, alive, total: 12, env });
    expect(env[VERIFY_GROUP_ENV]).toBeUndefined();
    expect(env[VERIFY_REGISTERED_ENV]).toBeUndefined();
  });
});

describe('registerTestRun — the vitest-pool entry point', () => {
  it('refuses to register when vitest is not running — the DEV SERVER case', () => {
    // ⚠️ `engine/vite.config.ts` is the dev server's config too, and its `test:` block is evaluated
    // on every `npm run dev`. Registering there would hold a slot for the whole 45-minute TTL and
    // shrink every clone's gate because somebody opened the editor. A wrong count is worse than a
    // low one, so this fails CLOSED.
    expect(registerTestRun({ dir, alive, total: 12, env: {} })).toBeNull();
    expect(readRuns({ dir, alive })).toHaveLength(0);
  });

  it('registers when vitest IS running, and publishes the group to its own env', () => {
    const env: NodeJS.ProcessEnv = { VITEST: 'true' };
    const budget = registerTestRun({ pid: 500, clone: '/qa', dir, alive, total: 12, env });
    expect(budget?.peers).toBe(1);
    expect(env[VERIFY_GROUP_ENV]).toBe('500');
    expect(env[VERIFY_REGISTERED_ENV]).toBe('1');
    expect(readRuns({ dir, alive }).map((r) => r.pid)).toEqual([500]);
  });

  it('returns null — and registers nothing — when an ancestor already registered', () => {
    // `verify.mjs` marks the env for both lanes. Returning null is how the caller knows it owns no
    // registration and must not unregister one on exit; a lane tearing down the GATE's slot would
    // leave every other clone over-budgeting for the rest of the run.
    const env: NodeJS.ProcessEnv = { VITEST: 'true', [VERIFY_REGISTERED_ENV]: '1' };
    expect(registerTestRun({ pid: 600, clone: '/hub', dir, alive, total: 12, env })).toBeNull();
    expect(readRuns({ dir, alive })).toHaveLength(0);
  });

  it('isTestRun keys off VITEST only', () => {
    expect(isTestRun({ VITEST: 'true' })).toBe(true);
    expect(isTestRun({})).toBe(false);
    // NODE_ENV=test alone is not enough — plenty of tooling sets it outside vitest.
    expect(isTestRun({ NODE_ENV: 'test' })).toBe(false);
  });
});

describe('verifyRegistryDir — the registry must be visible to OTHER processes', () => {
  it('resolves OUTSIDE the vitest sandbox, with nothing injected', () => {
    // ⚠️ THE REGRESSION TEST FOR AN INERT SHIP. Every other test in this file injects `dir`, so not
    // one of them exercised the real resolution — and the real resolution went through
    // `claimsDir()`, which redirects to `modoki-claims-vitest-<pid>/` whenever VITEST is set. Each
    // pool therefore registered into a private temp dir nothing else reads: the budget returned a
    // plausible number, the gate stayed green, 34 tests passed, and a live run polled every 0.5s
    // never appeared in the shared registry.
    //
    // This test takes the DEFAULT path deliberately. It runs under vitest, so if the claims
    // redirection ever comes back this goes red here rather than being discovered by polling.
    expect(process.env.VITEST).toBeTruthy(); // the condition that used to trigger the redirect
    expect(registryPath()).not.toContain('modoki-claims-vitest-');
    expect(registryPath()).not.toContain(os.tmpdir());
    expect(registryPath()).toBe(path.join(os.homedir(), '.modoki', 'verify-runs.json'));
  });

  it('still honours MODOKI_HOME, so a deliberate sandbox can redirect', () => {
    // Refusing the automatic redirect must not refuse the explicit one — MODOKI_HOME is how a
    // sandbox, and any test that wants isolation without injecting `dir`, opts out.
    expect(verifyRegistryDir({ env: { MODOKI_HOME: '/tmp/sandbox' } })).toBe('/tmp/sandbox');
    expect(verifyRegistryDir({ env: {}, home: '/home/x' })).toBe(path.join('/home/x', '.modoki'));
  });
});

describe('engineLaneWorkers — the count the engine lane RUNS with (#1443)', () => {
  const solo = (total: number) => registerVerifyRun({ pid: 1, dir, alive, total, env: {} });

  it('sizes a SOLO run from the box, so a 6-core Windows box gets 3, not the Mac-sized 6', () => {
    // ⚠️ THE REGRESSION TEST FOR #1443. The lane was pinned to '6' and the budget applied only when
    // peers > 1, so a solo run on the `win` box (12 logical -> 6 perf) overlapped 6 + 6 = 12 workers
    // on 6 cores while the context line printed engine=3.
    const win = solo(6); // perfCores() on the win box: 12 logical, halved
    expect(win.peers).toBe(1);
    expect(engineLaneWorkers(win, {})).toBe(3);
  });

  it('leaves the Mac solo gate exactly where it was — 12 perf cores still gives 6', () => {
    expect(engineLaneWorkers(solo(12), {})).toBe(LEGACY_ENGINE_LANE_WORKERS);
  });

  it('follows the budget down when the box is shared', () => {
    registerVerifyRun({ pid: 2, dir, alive, total: 12, env: {} });
    const shared = registerVerifyRun({ pid: 3, dir, alive, total: 12, env: {} });
    expect(shared.peers).toBe(2);
    expect(engineLaneWorkers(shared, {})).toBe(3);
  });

  it('lets a deliberate human setting win, the lane knob first', () => {
    const b = solo(12);
    expect(engineLaneWorkers(b, { MODOKI_VERIFY_ENGINE_WORKERS: '10' })).toBe(10);
    expect(engineLaneWorkers(b, { MODOKI_TEST_MAX_WORKERS: '4' })).toBe(4);
    expect(engineLaneWorkers(b, { MODOKI_VERIFY_ENGINE_WORKERS: '10', MODOKI_TEST_MAX_WORKERS: '4' })).toBe(10);
    // Junk degrades to the budget rather than handing vitest NaN.
    expect(engineLaneWorkers(solo(6), { MODOKI_VERIFY_ENGINE_WORKERS: 'banana' })).toBe(3);
  });

  it('the opt-out takes the SOLO share, not the Mac pin — on the win box the pin IS #1443', () => {
    // Close-out review: the first version returned the legacy 6 here, so `MODOKI_VERIFY_NO_BUDGET=1`
    // on a 6-core box re-created 6 + 6 on 6 cores. Shared, it must ignore the peers too.
    expect(engineLaneWorkers(solo(6), { MODOKI_VERIFY_NO_BUDGET: '1' })).toBe(3);
    registerVerifyRun({ pid: 2, dir, alive, total: 12, env: {} });
    const shared = registerVerifyRun({ pid: 3, dir, alive, total: 12, env: {} });
    expect(shared.peers).toBeGreaterThan(1);
    expect(engineLaneWorkers(shared, {})).toBeLessThan(6); // divided across the peers
    expect(engineLaneWorkers(shared, { MODOKI_VERIFY_NO_BUDGET: '1' })).toBe(6); // 12 cores, solo share
  });

  it('falls back to the pre-budget pin only when there is no budget at all', () => {
    expect(engineLaneWorkers(null, {})).toBe(LEGACY_ENGINE_LANE_WORKERS);
  });

  it('is what verify.mjs passes to BOTH the engine lane and the context line', () => {
    // The unit tests above prove the function; this proves the gate calls it on both sides. The bug
    // was exactly the two drifting apart: the line read the budget, the lane read a constant.
    const { code } = readScannedSource(fileURLToPath(new URL('../../scripts/verify.mjs', import.meta.url)));
    expect(code).toMatch(/MODOKI_TEST_MAX_WORKERS:\s*String\(engineLaneWorkers\(budget\)\)/);
    expect(code).toMatch(/benchLine\(\{\s*\.\.\.budget,[^}]*engineWorkers:\s*engineLaneWorkers\(budget\)\s*\}\)/);
    expect(code).not.toMatch(/ENGINE_LANE_WORKERS/);
  });
});

describe('the Windows gate runs two thirds of the pool, for memory (#1846)', () => {
  const solo = (total: number) => registerVerifyRun({ pid: 1, dir, alive, total, env: {} });
  const shared = (total: number) => {
    registerVerifyRun({ pid: 2, dir, alive, total, env: {} });
    return registerVerifyRun({ pid: 3, dir, alive, total, env: {} });
  };

  it('cuts the pool to two thirds on Windows only, rounding up, floored at MIN_WORKERS, never above the cores', () => {
    // 6 is the `win` box (12 logical, already halved for SMT by perfCores); the gate's pool is 4.
    expect(verifyPoolSize({ platform: 'win32', cores: 6 })).toBe(4);
    // A count where ceil and floor differ above the floor tells them apart (7 * 2/3 = 4.67: 5 vs 4).
    expect(verifyPoolSize({ platform: 'win32', cores: 7 })).toBe(5);
    expect(verifyPoolSize({ platform: 'win32', cores: 2 })).toBe(MIN_WORKERS);
    // Review: MIN_WORKERS alone capped a 1-core box UP to 2, which testWorkers.ts refuses to do.
    expect(verifyPoolSize({ platform: 'win32', cores: 1 })).toBe(1);
    for (const platform of ['darwin', 'linux']) expect(verifyPoolSize({ platform, cores: 12 }), platform).toBe(12);
    // The default reads perfCores for the SAME platform, so the SMT half and the memory cut compose.
    const c = perfCores({ platform: 'win32' });
    expect(verifyPoolSize({ platform: 'win32' })).toBe(Math.min(c, Math.max(MIN_WORKERS, Math.ceil((c * 2) / 3))));
  });

  it('gives the win box app=4 engine=2 on a SOLO run — the app lane is capped, not left to testWorkers.ts', () => {
    // Left to testWorkers.ts (the rule everywhere else when solo), the app lane would run at its own 6.
    const win = solo(verifyPoolSize({ platform: 'win32', cores: 6 }));
    expect(win.peers).toBe(1);
    expect(appLaneWorkers(win, { env: {}, platform: 'win32' })).toBe(4);
    expect(engineLaneWorkers(win, {})).toBe(2);
    // Shared, both lanes follow the budget down, still capped.
    expect(appLaneWorkers(shared(4), { env: {}, platform: 'win32' })).toBe(MIN_WORKERS);
  });

  it('a JUNK MODOKI_TEST_MAX_WORKERS does not switch the Windows cap off (review)', () => {
    // testWorkers.ts ignores `0`/`banana` and falls through to its own 6, so treating any string as an
    // override put the app lane back at 6 while the engine lane (which validates) stayed at 2.
    const win = solo(4);
    for (const junk of ['0', '-3', 'banana']) {
      expect(appLaneWorkers(win, { env: { MODOKI_TEST_MAX_WORKERS: junk }, platform: 'win32' }), junk).toBe(4);
    }
  });

  it('leaves every other platform exactly where it was: solo falls through, shared takes its share', () => {
    // Solo first: once `shared` registers its peers, no later run in this registry is solo.
    const one = solo(12);
    expect(one.peers).toBe(1);
    const b = shared(12);
    expect(b.appWorkers).toBeLessThan(12); // divided across the peers
    for (const platform of ['darwin', 'linux']) {
      expect(appLaneWorkers(one, { env: {}, platform }), platform).toBeUndefined();
      expect(appLaneWorkers(one, { env: { MODOKI_VERIFY_NO_BUDGET: '1' }, platform }), platform).toBeUndefined();
      expect(appLaneWorkers(b, { env: {}, platform }), platform).toBe(b.appWorkers);
      // Review: the opt-out's only other assertion was on the SOLO budget, where `peers <= 1` returns
      // undefined anyway, so deleting the opt-out stayed green. SHARED is where it decides.
      expect(appLaneWorkers(b, { env: { MODOKI_VERIFY_NO_BUDGET: '1' }, platform }), platform).toBeUndefined();
    }
  });

  it('under the opt-out, Windows keeps the cut pool and drops only the division across clones', () => {
    // MODOKI_VERIFY_NO_BUDGET stops the CROSS-CLONE division; the memory cut is not that, so a shared
    // win run opting out takes the whole cut pool (4), not the SMT-halved 6 testWorkers.ts would pick.
    const b = shared(4);
    expect(b.peers).toBeGreaterThan(1);
    expect(appLaneWorkers(b, { env: { MODOKI_VERIFY_NO_BUDGET: '1' }, platform: 'win32' })).toBe(4);
  });

  it('lets MODOKI_TEST_MAX_WORKERS win on every platform, and does nothing without a budget', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(appLaneWorkers(shared(6), { env: { MODOKI_TEST_MAX_WORKERS: '4' }, platform }), platform).toBeUndefined();
      expect(appLaneWorkers(null, { env: {}, platform }), platform).toBeUndefined();
    }
  });

  it('is what verify.mjs registers, caps the APP lane with, and prints — the box, not the pool', () => {
    const { code } = readScannedSource(fileURLToPath(new URL('../../scripts/verify.mjs', import.meta.url)));
    expect(code).toMatch(/registerVerifyRun\(\{\s*total:\s*verifyPoolSize\(\)\s*\}\)/);
    expect(code).toMatch(/appLaneWorkers\(budget\)/);
    // On the app lane's entry specifically (review: a bare spread match stayed green moved to the engine lane).
    expect(code).toMatch(/name:\s*'app tests',[^\n]*\.\.\.laneWorkerEnv\(\)/);
    // The context line names the BOX's cores and the counts the lanes RUN with (review: it printed the
    // cut pool as "3 perf core(s)", and `budget.appWorkers` rather than the app lane's cap).
    expect(code).toMatch(/benchLine\(\{[^}]*total:\s*perfCores\(\),\s*appWorkers:\s*appLaneShown\(\)/);
  });
});

describe('a run over named files holds only what it can use (#1871)', () => {
  // The owner saw the box at ~60% with two gates and two one-file runs live: each run counted as a
  // whole peer, so every gate took floor(12/4) = 3 app workers while each one-file run used about one.

  it('water-fills: the small needs are granted first and the rest is split among the full-share runs', () => {
    expect(budgetFor(12, 4, [1, 1])).toBe(5);
    expect(budgetFor(12, 2, [1])).toBe(11);
    expect(budgetFor(12, 3, [2, 1])).toBe(9);
  });

  it('never hands out more than the pool: what the runs hold still sums to it (the #1285 protection)', () => {
    // Two gates at 5 plus two runs at 1 is 12 on 12 cores — the same total as the equal split.
    const gate = budgetFor(12, 4, [1, 1]);
    expect(2 * gate + 1 + 1).toBeLessThanOrEqual(12);
    for (const reserved of [[1], [1, 1], [1, 2, 3], [3, 3], [2, 2, 2, 2]]) {
      const runners = reserved.length + 2;
      const share = budgetFor(12, runners, reserved);
      const held = reserved.map((r) => Math.min(r, share)).reduce((a, b) => a + b, 0);
      expect(held + 2 * share, JSON.stringify(reserved)).toBeLessThanOrEqual(12);
    }
  });

  it('treats a need at or above the equal share as a full share, not a reservation', () => {
    // 12 over 3 runs is 4 each; a run that can use 5 gets its 4 like everyone else.
    expect(budgetFor(12, 3, [5])).toBe(4);
    expect(budgetFor(12, 3, [4])).toBe(4);
    // A solo run and no reservations: exactly the old answer.
    expect(budgetFor(12, 1)).toBe(12);
    expect(budgetFor(12, 1, [])).toBe(12);
  });

  it('two gates and two one-file runs: each gate gets app=5 engine=2, not app=3', () => {
    registerVerifyRun({ pid: 1, clone: '/ai3', dir, alive, total: 12, env: {}, need: 1 });
    registerVerifyRun({ pid: 2, clone: '/ai', dir, alive, total: 12, env: {}, need: 1 });
    registerVerifyRun({ pid: 3, clone: '/ai2', dir, alive, total: 12, env: {} });
    const gate = registerVerifyRun({ pid: 4, clone: '/qa', dir, alive, total: 12, env: {} });
    expect(gate.peers).toBe(4);
    expect(gate.appWorkers).toBe(5);
    expect(gate.engineWorkers).toBe(2);
    expect(gate.sized).toEqual({ runs: 2, workers: 2 });
    // It is what the lane is capped to, since the box is shared.
    expect(appLaneWorkers(gate, { env: {}, platform: 'darwin' })).toBe(5);
  });

  it('a run with no need — a gate, a whole suite, an older clone — still takes a full share', () => {
    registerVerifyRun({ pid: 1, clone: '/old', dir, alive, total: 12, env: {} });
    const gate = registerVerifyRun({ pid: 2, clone: '/qa', dir, alive, total: 12, env: {} });
    expect(gate.appWorkers).toBe(6);
    expect(gate.sized).toEqual({ runs: 0, workers: 0 });
  });

  it("a group takes a full share if ANY of its entries has no need, and the largest need otherwise", () => {
    const needs = groupNeeds([
      { pid: 1, clone: '/a', startedAt: 0, group: 'g', need: 1 },
      { pid: 2, clone: '/a', startedAt: 0, group: 'g' },
      { pid: 3, clone: '/b', startedAt: 0, group: 'h', need: 1 },
      { pid: 4, clone: '/b', startedAt: 0, group: 'h', need: 3 },
    ]);
    expect(needs.get('g')).toBe(Infinity);
    expect(needs.get('h')).toBe(3);
  });

  it('records the need in the registry, and a gate beside that run takes everything else', () => {
    const env: NodeJS.ProcessEnv = { VITEST: 'true' };
    registerTestRun({ pid: 700, clone: '/ai', dir, alive, total: 12, env, need: 1 });
    expect(readRuns({ dir, alive }).find((r) => r.pid === 700)?.need).toBe(1);
    const gate = registerVerifyRun({ pid: 701, clone: '/qa', dir, alive, total: 12, env: {} });
    expect(gate.appWorkers).toBe(11);
  });

  it('prints what the sized runs hold on the context line, and nothing extra when there are none', () => {
    const base = { peers: 4, total: 12, appWorkers: 5, engineWorkers: 2, load: [9, 9, 9], platform: 'darwin' };
    expect(benchLine({ ...base, sized: { runs: 2, workers: 2 } }))
      .toContain('4 verify run(s) on 12 perf core(s) (2 sized, holding 2) · workers app=5 engine=2');
    expect(benchLine({ ...base, sized: { runs: 0, workers: 0 } })).not.toContain('sized');
    expect(benchLine(base)).toContain('on 12 perf core(s) · workers');
  });
});

describe('testRunNeed — a run\'s need, read off the vitest command line (#1871)', () => {
  const v = (...args: string[]) => testRunNeed(['node', '/x/node_modules/vitest/vitest.mjs', ...args], { platform: 'darwin', tty: false });

  it('counts the named test files: one worker per file', () => {
    expect(v('run', 'tests/editor/prefabFuzz.test.ts')).toBe(1);
    expect(v('run', 'tests/a.test.ts', 'tests/b.spec.tsx')).toBe(2);
    expect(v('tests/a.test.ts')).toBe(1); // no subcommand, no terminal: vitest runs once
  });

  it('skips the value of a flag that takes one — `-t repl…` is not a filter', () => {
    expect(v('run', '--config', 'engine/vite.config.ts', 'tests/editor/prefabFuzz.test.ts', '-t', 'replay')).toBe(1);
    expect(v('run', '--config=engine/vite.config.ts', 'tests/a.test.ts', '--reporter', 'dot')).toBe(1);
    expect(v('run', '--config', 'vite.config.ts', '--reporter=dot', '--no-isolate', 'tests/a.test.ts')).toBe(1);
  });

  it('is a FULL share for anything that is not a bounded set of files', () => {
    expect(v('run')).toBeUndefined(); // a whole suite
    expect(v()).toBeUndefined();
    expect(v('run', 'tests/editor')).toBeUndefined(); // a directory
    expect(v('run', 'prefabFuzz')).toBeUndefined(); // a bare substring
    expect(v('run', 'tests/a.test.ts', 'tests/editor')).toBeUndefined(); // one filter is not a file
    expect(v('run', 'tests/a.test.ts', '--unknownFlag', 'value')).toBeUndefined(); // errs toward a full share
    expect(v('watch', 'tests/a.test.ts')).toBeUndefined();
    expect(v('related', 'src/a.ts')).toBeUndefined();
  });

  it('is a FULL share when a flag can SWALLOW the file, or after `--` — vitest then runs the whole suite (close-out review)', () => {
    // Per vitest's own parser each of these runs with NO filter (`-u` takes the file as its optional
    // value, everything after `--` is ignored) or is rejected (`--silent <file>`). Read as booleans they registered
    // `need: 1` while the run took all 12 workers, and a gate beside one took 11 more.
    for (const flag of ['-u', '--update', '--browser', '--coverage.all', '--silent', '--changed', '--bail', '--']) {
      expect(v('run', flag, 'tests/a.test.ts'), flag).toBeUndefined();
    }
    expect(v('run', '--coverage=false', 'tests/a.test.ts')).toBeUndefined(); // a boolean with a value: not read
  });

  it('is a FULL share for a watch run: pressing `a` reruns everything', () => {
    expect(v('run', '--watch', 'tests/a.test.ts')).toBeUndefined();
    expect(v('-w', 'tests/a.test.ts')).toBeUndefined();
    // A bare `vitest <file>` in a terminal watches; without one (a Claude session, a script) it runs once.
    const argv = ['node', 'vitest.mjs', 'tests/a.test.ts'];
    expect(testRunNeed(argv, { platform: 'darwin', tty: true })).toBeUndefined();
    expect(testRunNeed(argv, { platform: 'darwin', tty: false })).toBe(1);
    expect(testRunNeed(['node', 'vitest.mjs', 'run', 'tests/a.test.ts'], { platform: 'darwin', tty: true })).toBe(1);
  });

  it("never claims fewer files than vitest's OWN parser filters on — checked shape by shape against parseCLI", async () => {
    // The dangerous direction is a small need for a run vitest executes wide. A hand parser can only
    // drift toward that, so every shape that yields a number is checked against vitest's `parseCLI`:
    // the same filters, all of them test files, and not a watch, update, related or changed run.
    const { parseCLI } = await import('vitest/node');
    const files = ['tests/a.test.ts', 'tests/b.spec.tsx'];
    // Every entry of both allowlists, not a sample: a listed flag that swallows the file (a wrong entry,
    // or a vitest minor that gives it an optional value) must go red here (re-review: a hand-picked
    // corpus let `--merge-reports` join the boolean list with the file green).
    const flags = [
      ...[...VITEST_BOOLEAN_FLAGS].map((f) => [f]),
      ...[...VITEST_VALUE_FLAGS].map((f) => [f, 'X']),
      [], ['-t', 'replay'], ['--config', 'vite.config.ts'], ['--config=vite.config.ts'], ['--reporter', 'dot'],
      ['-u'], ['--update'], ['--browser'], ['--coverage.all'], ['--coverage'], ['--no-isolate'], ['--bail', '1'],
      ['--changed'], ['--'], ['--watch'], ['-w'], ['--run'], ['--project', 'app'], ['--shard', '1/2'],
      ['--inspect'], ['--api'], ['--passWithNoTests'], ['--unknownFlag', 'value'],
    ];
    let checked = 0;
    for (const sub of [['run'], [], ['watch'], ['related']]) {
      for (const f of flags) {
        for (const shape of [[...f, files[0]], [files[0], ...f], [...f, ...files], [files[0], ...f, files[1]]]) {
          const args = [...sub, ...shape];
          const need = testRunNeed(['node', 'vitest.mjs', ...args], { platform: 'darwin', tty: false });
          if (need === undefined) continue;
          let parsed: ReturnType<typeof parseCLI>;
          try { parsed = parseCLI(['vitest', ...args]); } catch { throw new Error(`need ${need} for a shape vitest REJECTS: ${args.join(' ')}`); }
          const o = parsed.options as Record<string, unknown>;
          expect(parsed.filter, args.join(' ')).toHaveLength(need);
          expect(parsed.filter.every((x) => /\.(test|spec)\./.test(String(x))), args.join(' ')).toBe(true);
          // Falsy, not absent: `--no-watch` sets `watch: false`, which is a run that ends.
          expect([o.watch, o.update, o.related, o.changed].map(Boolean), args.join(' ')).toEqual([false, false, false, false]);
          checked++;
        }
      }
    }
    // Each listed flag must have reached the parser on the accept side at least once.
    expect(checked, 'the corpus must reach the accept side too').toBeGreaterThan(VITEST_BOOLEAN_FLAGS.size + VITEST_VALUE_FLAGS.size);
  });

  it('is undefined on Windows, so the win box keeps the equal split (#1871 scope)', () => {
    expect(testRunNeed(['node', 'vitest.mjs', 'run', 'tests/a.test.ts'], { platform: 'win32' })).toBeUndefined();
  });
});
