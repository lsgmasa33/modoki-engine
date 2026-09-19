// Cross-clone worker budgeting and load context for `npm run verify` (#1285).
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
//
// ⚠️ **THE BUDGET NEVER RENEGOTIATES, so this HALVES the problem rather than solving it.** A run
// sizes its pools once, at registration, and keeps them for its whole gate. The FIRST clone to
// start therefore always sees `peers = 1` and takes the entire pool; only later arrivals divide. Two
// clones land at 12+6 and 6+3 = 27 workers on 12 perf cores, not the 2x6 that "divides the pool by
// the number of live runs" reads like. Still well short of the 36 they took before, and renegotiating
// mid-run would mean restarting a live vitest pool — but do not quote the mechanism as if the
// division were even.
//
// ⚠️ **The read-modify-write can drop a LIVE peer, and that is worse than the register-side race.**
// If A's exit handler reads the registry, B then renames its own registration in, and A writes its
// filtered set, B's entry is gone for the rest of B's run: B's own release no-ops, and every run
// starting afterwards sees `peers` one lower and over-budgets. The window is a few milliseconds and
// the consequence lasts a whole gate. Not observed, not defended against — an advisory budget that
// is occasionally one slot generous is still the point, and a lock here would cost more than it
// saves.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPidAlive } from './deviceClaimsStore.mjs';

/** Registry of in-flight test runs, machine-wide. Sits beside the device claims in `~/.modoki`.
 *
 *  ⚠️ It does NOT follow the device claims' vitest redirection — see `verifyRegistryDir()`. It
 *  honours `MODOKI_HOME` and nothing else, because a registry only other processes can read is the
 *  whole point, and the claims' per-pid sandbox makes that impossible. */
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

/**
 * Where the SHARED registry lives — deliberately NOT `claimsDir()`.
 *
 * ⚠️ **`claimsDir()` redirects to a per-pid temp dir whenever `VITEST` is set** (`deviceClaimsStore`
 * — `modoki-claims-vitest-<pid>/`), so that a test can never corrupt the real device claims. That is
 * right for claims and FATAL here: this registry's entire purpose is to be visible to OTHER
 * processes, and a vitest pool writing into a directory named after its own pid is visible to
 * nobody.
 *
 * ⚠️ **This was shipped and measured inert.** Registration from `testWorkers.ts` returned a
 * plausible budget, the gate stayed green, and 34 tests passed — every one of them injecting `dir`,
 * so not one exercised the real resolution. A live run polled every 0.5s never appeared in
 * `~/.modoki/verify-runs.json`. The test that now prevents it is `resolves outside the vitest
 * sandbox`: it asserts the DEFAULT path, with nothing injected.
 *
 * `MODOKI_HOME` is still honoured, so a deliberate sandbox (and any test that wants one) can still
 * redirect; only the automatic VITEST redirection is refused.
 */
export function verifyRegistryDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.MODOKI_HOME) return env.MODOKI_HOME;
  return path.join(home, '.modoki');
}

export function registryPath(dir = verifyRegistryDir()) {
  return path.join(dir, VERIFY_REGISTRY_FILE);
}

/** Env var carrying the GROUP id every process of one gate shares. See `groupOf()`. */
export const VERIFY_GROUP_ENV = 'MODOKI_VERIFY_GROUP';

/** Env var marking "this process tree already registered", so workers do not re-register. */
export const VERIFY_REGISTERED_ENV = 'MODOKI_VERIFY_REGISTERED';

/**
 * The id that makes N processes count as ONE run.
 *
 * ⚠️ **Without this, moving registration into `testWorkers.ts` COUNTS ONE GATE AS SEVERAL AND
 * BUDGETS IT AGAINST ITSELF** — the exact inversion of what #1285 is for. Two ways it happens:
 *
 *   1. `verify.mjs` spawns TWO vitest processes (app lane ‖ engine lane). Registering per process
 *      makes a solo gate read `peers = 3` (both lanes plus `verify.mjs`) and take a third of the
 *      box it has entirely to itself.
 *   2. Vitest's pool workers may evaluate the config too, depending on pool and version. Per-pid
 *      registration would then scale `peers` with the WORKER COUNT — the quantity being budgeted.
 *
 * So `verify.mjs` stamps its own pid into the env, every process it spawns inherits it, and
 * `peers` counts DISTINCT GROUPS rather than entries. A standalone `npx vitest run` inherits
 * nothing and is its own group, which is the whole point: it is a real, separate consumer of the
 * box and used to be invisible.
 *
 * Entries written by an older clone carry no `group`; they fall back to their own pid, so a mixed
 * fleet mid-upgrade degrades to the previous behaviour rather than mis-grouping.
 */
export function groupOf(run) {
  if (run?.group) return String(run.group);
  return String(run?.pid ?? '');
}

/** Distinct live groups — this is `peers`. */
export function countGroups(runs) {
  return new Set(runs.map(groupOf)).size;
}

/**
 * Is this process actually running TESTS?
 *
 * ⚠️ **`engine/vite.config.ts` is the DEV SERVER's config as well as the test suite's**, and its
 * `test:` block — including the `perfCoreWorkers()` call registration hangs off — is evaluated
 * whenever Vite loads the config. Without this gate, `npm run dev` would register the editor as a
 * live test run and hold the slot for the full 45-minute TTL, so every clone's gate would budget
 * itself down because somebody opened the editor. That is worse than the blindness being fixed: it
 * is a WRONG count rather than a low one.
 *
 * VERIFIED by probe rather than assumed, 2026-09-16: at config-evaluation time vitest has already
 * set `VITEST="true"` and `NODE_ENV="test"`, with `VITEST_WORKER_ID` still undefined — the config
 * is evaluated once, in the MAIN process, and pool workers do not re-evaluate it.
 *
 * Fails CLOSED: an environment that does not set `VITEST` simply does not register, which is the
 * behaviour that existed before this module. A missed registration costs one slot of accuracy; a
 * phantom one costs every clone on the box.
 */
export function isTestRun(env = process.env) {
  return Boolean(env.VITEST);
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

  // ⚠️ **EVERY platform is decided BEFORE the probe, not just win32.** The first fix moved `win32`
  // up and left this gate out, so on a Mac the sysctl still answered first for `linux`, `freebsd`
  // and everything else — `perfCores({platform:'linux'})` returned 12 (this box's PERFORMANCE
  // cores) where the homogeneous-CPU answer is 16. The injectable seam was still unreachable for
  // every branch but the one that had been fixed, which is the same defect one branch short of
  // swept. `testWorkers.ts` has the correct shape and gates on `!== 'darwin'` before probing.
  if (platform !== 'darwin') return logical;

  try {
    const n = Number(execFileSync('sysctl', ['-n', 'hw.perflevel0.logicalcpu'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // An Intel Mac (no `hw.perflevel0`) or no sysctl — the homogeneous-CPU answer is correct there.
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

export function readRuns({ dir = verifyRegistryDir(), now = Date.now(), alive = isPidAlive } = {}) {
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

function writeRuns(runs, dir = verifyRegistryDir()) {
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
  dir = verifyRegistryDir(),
  now = Date.now(),
  alive = isPidAlive,
  total = perfCores(),
  env = process.env,
  group = env[VERIFY_GROUP_ENV] || String(pid),
} = {}) {
  // ⚠️ **Deliberately does NOT write the group back into `process.env`.** An earlier draft did, so
  // that children would inherit it — and that made the function silently non-idempotent: the SECOND
  // logically-distinct run registering in the same process picked up the FIRST one's group from the
  // ambient env and the two collapsed into one peer. Caught by `verifyLoad.test.ts`'s three-clone
  // case reporting `peers` of 1. Publication is now explicit and belongs to the caller that spawns
  // children (`verify.mjs` via `laneGroupEnv()`, `registerTestRun` for its own process).
  const others = readRuns({ dir, now, alive }).filter((r) => r.pid !== pid);
  const runs = [...others, { pid, clone, startedAt: now, group: String(group) }];
  try {
    writeRuns(runs, dir);
  } catch {
    // An unwritable ~/.modoki must not fail the gate — budgeting is an optimisation, and a run that
    // cannot register simply behaves as it did before this module existed.
  }
  const peers = countGroups(runs);
  const appWorkers = budgetFor(total, peers);
  return {
    peers,
    total,
    /** This run's group id — the caller publishes it to children it spawns. */
    group: String(group),
    appWorkers,
    // The engine lane has always taken about half the app lane's pool (12 vs a pinned 6) and runs
    // entirely INSIDE it, so it keeps that ratio rather than getting an equal share.
    engineWorkers: Math.max(MIN_WORKERS, Math.floor(appWorkers / 2)),
  };
}

/**
 * Register ANY vitest pool — the half of #1285 that `verify.mjs` alone could never see.
 *
 * ⚠️ **The peer count used to describe a different population from the load it sat beside.** Only
 * `verify.mjs` registered, so a scoped `npx vitest run`, a `npm test`, a typecheck and — worst of
 * all — a MUTATION CHECK were invisible. Mutation checks are structurally the bad case: CLAUDE.md
 * requires one per new test and they re-run the same suite back to back by design. MEASURED on the
 * hub: **load 154.86 with 106 node processes across four clones, and every clone reading
 * `peers == 1`** and claiming the whole pool.
 *
 * Returns `null` when this process tree has already registered, so the caller knows not to unwind
 * a registration it does not own. Never throws: a pool that cannot register must still run.
 */
export function registerTestRun(opts = {}) {
  const env = opts.env ?? process.env;
  if (!isTestRun(env)) return null;
  if (env[VERIFY_REGISTERED_ENV]) return null;
  try {
    const budget = registerVerifyRun({ ...opts, env });
    // Publish to OUR OWN env only, so anything this pool spawns joins this group instead of
    // counting against it. Cheap insurance: probed 2026-09-16, vitest evaluates the config once in
    // the main process and pool workers do not re-evaluate it — but a future pool that did would
    // otherwise scale `peers` with the worker count, which is the quantity being budgeted.
    env[VERIFY_GROUP_ENV] = budget.group;
    env[VERIFY_REGISTERED_ENV] = '1';
    return budget;
  } catch {
    // Budgeting is advisory. A registry that cannot be read or written leaves the pool sized
    // exactly as it was before this existed, which is the correct failure direction.
    return null;
  }
}

export function unregisterVerifyRun({ pid = process.pid, dir = verifyRegistryDir(), now = Date.now(), alive = isPidAlive } = {}) {
  try {
    writeRuns(readRuns({ dir, now, alive }).filter((r) => r.pid !== pid), dir);
  } catch {
    // Same reasoning as register: the TTL and the pid check both expire this entry anyway.
  }
}

/** The engine lane's pinned count from before the budget existed — what `MODOKI_VERIFY_NO_BUDGET`
 *  and a run with no budget fall back to. Sized on the Mac as half its 12 performance cores. */
export const LEGACY_ENGINE_LANE_WORKERS = 6;

/** How many workers `verify.mjs`'s engine lane RUNS with — the one number both the lane's env and
 *  the `context:` line read, so the line cannot describe a pool nobody used (#1443).
 *
 *  ⚠️ **It applies on a SOLO run too, unlike the app lane's budget.** The app lane can fall through
 *  to `testWorkers.ts` because that module sizes it per platform; the engine lane never could — it
 *  was pinned to a Mac-sized 6, which on a 6-core Windows box is the whole cap, so the two lanes
 *  overlapped at 12 workers on 6 cores while this line printed `engine=3`. `budget.engineWorkers`
 *  is half of `perfCores()`, which already halves on Windows, and on the Mac solo it is still 6.
 *  (Half, not less: on the Mac, 3 workers took this suite from ~25s to 64-80s and made it the pole.)
 *
 *  Precedence, most deliberate first: the lane's own knob, then `MODOKI_TEST_MAX_WORKERS` (which
 *  `testWorkers.ts` documents as beating everything — the old pin silently outvoted it for this
 *  lane), then the budget. `MODOKI_VERIFY_NO_BUDGET` stops the division ACROSS clones and takes the
 *  solo share; only a run with no budget at all falls back to the legacy pin. */
export function engineLaneWorkers(budget, env = process.env) {
  for (const knob of ['MODOKI_VERIFY_ENGINE_WORKERS', 'MODOKI_TEST_MAX_WORKERS']) {
    const n = Number(env[knob]);
    if (env[knob] && Number.isFinite(n) && n > 0) return n;
  }
  if (!budget) return LEGACY_ENGINE_LANE_WORKERS;
  // The opt-out stops the division ACROSS clones — it takes the solo share, never the Mac pin,
  // which on the 6-core win box is exactly the 12-on-6 this function exists to prevent.
  if (env.MODOKI_VERIFY_NO_BUDGET) return Math.max(MIN_WORKERS, Math.floor(budgetFor(budget.total, 1) / 2));
  return budget.engineWorkers;
}

/** One line of context for any number this gate prints.
 *
 *  ⚠️ This is Phase 0 of the #1285 work and it is load-bearing, not decoration: a `verify` timing
 *  with no record of the contention it ran under cannot be compared against another one, and four
 *  months of the header's table were quoted as current long after the box stopped being quiet. */
export function benchLine({
  peers, total, appWorkers, engineWorkers, load = os.loadavg(), platform = process.platform,
}) {
  // ⚠️ **`os.loadavg()` returns `[0,0,0]` on Windows — always, by Node's contract.** Printed raw
  // that reads as a perfectly idle box, which is strictly worse than printing nothing: the line
  // LOOKS like a measurement was taken. And it lands on the one platform that `testWorkers.ts`
  // measures going RED rather than merely slow under oversubscription — the platform this line
  // exists to explain. `peers` and the worker split are still real there, so the line stays.
  const l = platform === 'win32' ? 'n/a (os.loadavg is 0 on Windows)' : `${load[0].toFixed(1)}/${load[1].toFixed(1)}`;
  return `  context: load ${l} · ${peers} verify run(s) on ${total} perf core(s)`
    + ` · workers app=${appWorkers} engine=${engineWorkers}`;
}

/** Pull vitest's own aggregate breakdown out of a lane's captured output.
 *
 *  These sums (transform/setup/import/tests/environment) are summed ACROSS workers, so they are not
 *  wall clock and do not shrink when the box is busy the way wall clock inflates — which makes them
 *  the comparable number between two runs on a contended machine. `environment` in particular is
 *  what exposed the app suite paying jsdom for files that never touch a DOM. */
export function parseVitestAggregates(output) {
  // Strip ANSI first. Vitest dims the `(…)` group, so with colour enabled the line reads
  // `Duration  12.3s \x1b[2m (transform …)\x1b[22m` and `\s+\(` cannot cross the escape — the match
  // fails and the caller's `if (!agg) continue` drops the line in silence. Under `verify`'s pipe
  // picocolors disables colour, which is the only reason this worked; anyone setting `FORCE_COLOR`
  // to read the gate more easily would lose exactly the figures a contended box is compared by.
  // Matching an ANSI SGR escape REQUIRES the ESC control character — that is what the strip is for,
  // not an accident of the pattern. (The disable must sit on the line immediately above the regex:
  // put a continuation comment between them and it lands on the comment instead, silently.)
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;]*m/g;
  const m = /Duration\s+([\d.]+)s\s+\(([^)]+)\)/.exec((output ?? '').replace(ansi, ''));
  if (!m) return null;
  const parts = {};
  for (const seg of m[2].split(',')) {
    const kv = /\s*(\w+)\s+([\d.]+)(m?s)/.exec(seg);
    if (kv) parts[kv[1]] = kv[3] === 'ms' ? Number(kv[2]) / 1000 : Number(kv[2]);
  }
  return { duration: Number(m[1]), parts };
}
