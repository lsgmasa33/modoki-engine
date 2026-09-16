// Cross-clone worker budgeting and load context for `npm run verify` (#1283).
//
// ── WHY THIS EXISTS ──
//
// `verify.mjs` budgets vitest workers across ITS OWN two lanes, and `testWorkers.ts` caps each pool
// to the machine's PERFORMANCE cores. Both are correct and both assume the same thing: that this
// `verify` is the only one on the box. On this repo that assumption is false — six clones run
// concurrent sessions (CLAUDE.md § Clones), and a session runs the gate whenever it is finishing
// work. MEASURED 2026-09-16 on the hub while `modoki-qa` ran its own gate:
//
//     load average: 149.47 / 177.23 / 147.48   on a 12P+4E box
//     38 live node processes under ~/Projects/modoki-qa, 3 under ~/Projects/modoki
//
// That is ~9x oversubscription of the twelve performance cores. Two clones each taking "the whole
// machine's P cores" is 24 workers on 12 cores; six is worse.
//
// ⚠️ **The damage is not only slowness — it turns the gate RED.** `testWorkers.ts` already records
// this failure shape on Windows: oversubscription's first casualties are the tests nearest
// `testTimeout`, and they fail as TIMEOUTS, which reads exactly like a regression in the diff under
// test. It cost a session on 2026-09-16, when wordweave's backgroundRotation.test.ts overshot a 20s
// ceiling by 302ms under a contended box and `npm test` alone stayed green.
//
// ⚠️ **It also invalidates every wall-clock number.** `verify.mjs`'s header table is labelled
// "quiet box" and that precondition quietly stopped holding; the 82-86s baseline there is not
// reproducible today for reasons that have nothing to do with the tree. Hence `benchLine()` below:
// a measurement that does not record the contention it ran under cannot be compared to another one.
//
// ── THE BUDGET ──
//
// Advisory, not enforced. Each run registers itself, divides the performance-core pool by the
// number of live runs, and sizes its pools from that share. A SOLO run therefore gets exactly what
// it gets today (peers=1 -> the full pool), so nothing changes for the common case — this only
// bites when the box is genuinely shared, which is the case it exists for.
//
// Deliberately NOT a mutex. Serializing would make a clone wait minutes on another clone's gate,
// and the point is to stop the thrash, not to stop the work.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimsDir, isPidAlive } from './deviceClaimsStore.mjs';

/** Registry of in-flight `verify` runs, machine-wide. Sits beside the device claims (~/.modoki) and
 *  is picked up by the same `MODOKI_HOME` / vitest redirection, so a test never touches the real
 *  one. */
export const VERIFY_REGISTRY_FILE = 'verify-runs.json';

/** Wall-clock backstop for an entry whose pid check cannot help — a recycled pid, or a run killed
 *  so hard its release never ran. Short, because a gate that takes longer than this is already
 *  pathological and its slot should not keep shrinking everyone else's budget.
 *
 *  ⚠️ Expiry is BOTH tests, as in `deviceClaimsStore` (#225): a dead pid expires immediately and
 *  does not wait out the TTL, and the TTL catches what liveness cannot see. */
export const VERIFY_TTL_MS = 45 * 60 * 1000;

/** Never starve a run below this many workers however busy the box is: under ~2 the pool stops
 *  being a pool, and `testWorkers.ts` measured the engine suite going 25s -> 64-80s at 3. A badly
 *  contended gate is still better than one that cannot finish. */
export const MIN_WORKERS = 2;

export function registryPath(dir = claimsDir()) {
  return path.join(dir, VERIFY_REGISTRY_FILE);
}

/** Performance cores, or logical cores where that is unknowable.
 *
 *  `hw.perflevel0.logicalcpu` exists only on Apple Silicon — the same probe `testWorkers.ts` uses,
 *  and for the same reason: an E core runs a CPU-bound test file ~4x slower, so counting one as a
 *  worker slot is what creates the unlucky placement that sets the whole run's critical path. */
export function perfCores({ platform = process.platform } = {}) {
  const logical = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);

  // Windows FIRST, before the sysctl probe. Not merely an optimisation for a box that has no
  // `sysctl`: putting it after meant the branch could never be exercised anywhere it could be
  // observed, because on the Mac this was written on the probe SUCCEEDS and returns first — so the
  // seam existed, read as tested, and answered 12 for `win32`. Found by exercising it.
  //
  // Halve, for the reason `testWorkers.ts` measured: `availableParallelism()` counts SMT siblings
  // as cores, so budgeting against the logical count hands out twice the slots the box can run.
  // Keeping the two in step matters more than the exact figure — a budget that disagreed with the
  // cap would describe a pool that never existed.
  if (platform === 'win32') return Math.ceil(logical / 2);

  try {
    const n = Number(execFileSync('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // Not Apple Silicon (or no sysctl) — fall through to the homogeneous-CPU answer.
  }
  return logical;
}

/** An entry is live when its process is alive AND it is inside the TTL. */
export function isLiveRun(run, { now = Date.now(), alive = isPidAlive } = {}) {
  if (!run || typeof run.pid !== 'number') return false;
  if (!Number.isFinite(run.startedAt)) return false;
  if (now - run.startedAt > VERIFY_TTL_MS) return false;
  return alive(run.pid);
}

export function readRuns({ dir = claimsDir(), now = Date.now(), alive = isPidAlive } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(registryPath(dir), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or hand-mangled registry is not a reason to refuse to run the gate. Treat it as
    // empty; the next write replaces it wholesale.
    return [];
  }
  if (!Array.isArray(parsed?.runs)) return [];
  return parsed.runs.filter((r) => isLiveRun(r, { now, alive }));
}

function writeRuns(runs, dir = claimsDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = registryPath(dir);
  // Write-then-rename so a concurrent reader never sees a half-written file. Two runs registering
  // in the same millisecond can still lose one entry — this is an ADVISORY budget, and the cost of
  // that race is one run sizing itself one slot too generously, not a corrupt gate.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ runs }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Workers this run may use, given `runners` live runs sharing `total` performance cores. */
export function budgetFor(total, runners) {
  const n = Math.max(1, runners);
  return Math.max(MIN_WORKERS, Math.floor(total / n));
}

/**
 * Register this run and return its share of the box.
 *
 * `{ peers, total, appWorkers, engineWorkers }`. `peers` COUNTS THIS RUN, so a solo gate reports 1
 * and gets the whole pool — today's behaviour exactly, which is the point.
 */
export function registerVerifyRun({
  pid = process.pid,
  clone = process.cwd(),
  dir = claimsDir(),
  now = Date.now(),
  alive = isPidAlive,
  total = perfCores(),
} = {}) {
  const others = readRuns({ dir, now, alive }).filter((r) => r.pid !== pid);
  const runs = [...others, { pid, clone, startedAt: now }];
  try {
    writeRuns(runs, dir);
  } catch {
    // An unwritable ~/.modoki must not fail the gate — budgeting is an optimisation, and a run that
    // cannot register simply behaves as it did before this module existed.
  }
  const peers = runs.length;
  const appWorkers = budgetFor(total, peers);
  return {
    peers,
    total,
    appWorkers,
    // The engine lane has always taken about half the app lane's pool (12 vs a pinned 6) and runs
    // entirely INSIDE it, so it keeps that ratio rather than getting an equal share.
    engineWorkers: Math.max(MIN_WORKERS, Math.floor(appWorkers / 2)),
  };
}

export function unregisterVerifyRun({ pid = process.pid, dir = claimsDir(), now = Date.now(), alive = isPidAlive } = {}) {
  try {
    writeRuns(readRuns({ dir, now, alive }).filter((r) => r.pid !== pid), dir);
  } catch {
    // Same reasoning as register: the TTL and the pid check both expire this entry anyway.
  }
}

/** One line of context for any number this gate prints.
 *
 *  ⚠️ This is Phase 0 of the #1283 work and it is load-bearing, not decoration: a `verify` timing
 *  with no record of the contention it ran under cannot be compared against another one, and four
 *  months of the header's table were quoted as current long after the box stopped being quiet. */
export function benchLine({ peers, total, appWorkers, engineWorkers, load = os.loadavg() }) {
  const [l1, l5] = load;
  return `  context: load ${l1.toFixed(1)}/${l5.toFixed(1)} · ${peers} verify run(s) on ${total} perf core(s)`
    + ` · workers app=${appWorkers} engine=${engineWorkers}`;
}

/** Pull vitest's own aggregate breakdown out of a lane's captured output.
 *
 *  These sums (transform/setup/import/tests/environment) are summed ACROSS workers, so they are not
 *  wall clock and do not shrink when the box is busy the way wall clock inflates — which makes them
 *  the comparable number between two runs on a contended machine. `environment` in particular is
 *  what exposed the app suite paying jsdom for files that never touch a DOM. */
export function parseVitestAggregates(output) {
  const m = /Duration\s+([\d.]+)s\s+\(([^)]+)\)/.exec(output ?? '');
  if (!m) return null;
  const parts = {};
  for (const seg of m[2].split(',')) {
    const kv = /\s*(\w+)\s+([\d.]+)(m?s)/.exec(seg);
    if (kv) parts[kv[1]] = kv[3] === 'ms' ? Number(kv[2]) / 1000 : Number(kv[2]);
  }
  return { duration: Number(m[1]), parts };
}
