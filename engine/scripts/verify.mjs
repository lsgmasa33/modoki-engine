#!/usr/bin/env node
// `npm run verify` used to run its legs as one `&&` chain and took ~245s warm. The root test
// suite (vitest) leaves most of this machine's cores idle for much of its run, so the other
// legs can run concurrently INSIDE it for close to free: the TWO lanes below are independent
// of each other (no lane's result depends on another lane's output) and are launched in
// parallel via `child_process.spawn`. Only within lane 2 is there a real dependency — lint is
// cheap and only interesting when the types are sane — so lint runs after typecheck,
// sequentially, inside that one lane.
//
// MEASURED 2026-08-18 on this Mac, quiet box, warm caches (4 runs). ⚠️ Quote the RANGE — the
// spread between rounds is larger than most changes you would make here:
//
//                              standalone      inside the lane
//   typecheck                       12.4s          15.9-17.3s
//   lint                             1.3s            2.0-2.2s
//   engine tests (6 workers)        12.1s          33.8-36.2s
//   ---------------------------------------------------------
//   lane 2 total                  ~26s of work     51.8-55.7s
//   app tests (lane 1)                             82.1-86.0s
//   verify wall-clock                              82.1-86.0s
//
// ⚠️ **The app lane IS the wall clock — LANE 2 NEVER BINDS.** Wall exceeded appLane by 7-8ms in
// every run (82.077/82.070, 79.564/79.556, 86.019/86.012, 86.100/86.093), which is this script's
// own overhead and nothing else. It has ~30s of
// slack, so nothing removed from it changes the gate's wall-clock. Two consequences that have
// each already cost someone a session:
//
//   1. Lane 2 is ~26s of WORK stretched to ~54s by sharing the box with the app pool. The
//      engine suite is 12.1s standalone at 12 workers and 34s here. Do not read the in-lane
//      number as the suite's cost, and do not go hunting a pole inside it — there isn't one
//      (556 files, evenly spread, nothing slow enough for the reporter to print).
//   2. Typecheck is NOT the lane-2 pole; the engine suite is, at ~2x. Parallelising the five
//      independent typecheck commands inside `npm run typecheck` (six `tsc` programs, no project
//      references between them) would buy ~10s off a leg that
//      is not the constraint, and 0s off the gate. Measured and declined.
//
// ⚠️ **Running typecheck ‖ engine tests was MEASURED AND DECLINED (2026-08-18) — and it works.**
// The three-lane instability documented below does NOT reproduce now that the worker cap
// exists: A/B'd back to back, lane 2 goes 54s -> 35s with the app lane unchanged (82.1/86.0
// chained vs 79.6/86.1 concurrent — the two ROUNDS differ more than the two variants). It is
// declined because it buys 19s of slack nobody spends and 0s of wall-clock, while inflating
// typecheck 16s -> 24s (descheduled against the engine pool) — CPU spent for nothing, and the
// `win` clone pays that trade worst. Revisit ONLY if the app lane ever drops below ~54s.
//
// The only lever on `verify` is the app lane. It was the pole in all four runs.
//
// Output is BUFFERED per lane and flushed as a block when the lane finishes, so concurrent
// output never interleaves line-by-line. `verify:serial` (the old `&&` chain) is kept in
// package.json for debugging an interleaving problem, in case this script's buffering ever
// hides something real.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Run a single shell command, buffering stdout+stderr, and resolve with the result.
 * Never rejects — a failing command resolves with ok:false so the caller can keep going.
 */
/**
 * The engine suite runs while the app suite still holds the full performance-core pool, so it takes
 * a modest budget rather than sizing itself from the whole machine — two unrestricted vitest pools
 * fight, and that fight is what made the wall-clock unreproducible before the lanes were merged.
 * Deliberately not tiny: at 3 workers this suite went from ~25s to 64-80s and became the pole.
 */
const ENGINE_LANE_WORKERS = process.env.MODOKI_VERIFY_ENGINE_WORKERS ?? '6';

function runCommand(cmd, extraEnv = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const chunks = [];
    const child = spawn(cmd, {
      shell: true,
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });

    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));

    child.on('error', (err) => {
      chunks.push(Buffer.from(`\n[verify] failed to spawn "${cmd}": ${err.message}\n`));
      resolve({ ok: false, code: 1, output: Buffer.concat(chunks).toString('utf8'), seconds: (Date.now() - start) / 1000, child: null });
    });

    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        code,
        output: Buffer.concat(chunks).toString('utf8'),
        seconds: (Date.now() - start) / 1000,
      });
    });

    // Expose the child so SIGINT handling can kill it.
    runCommand._active = runCommand._active || new Set();
    runCommand._active.add(child);
    child.on('close', () => runCommand._active.delete(child));
  });
}

/**
 * Lane 2: typecheck -> lint -> engine tests, in sequence.
 *
 * ⚠️ THIS IS TWO LANES, NOT THREE, AND THAT WAS MEASURED. Running the engine suite as its own
 * third lane put TWO vitest pools in flight at once, each sizing itself from the whole machine;
 * they fought, and the wall-clock became unreproducible (85s / 115s / 147s on an identical tree)
 * with the engine suite's timing assumptions flaking. Budgeting workers across three lanes was
 * worse still, because BOTH suites then ran starved: at 9/3 the app lane went 106-147s, and at 12/3
 * the engine lane went from ~25s to 64-80s.
 *
 * Chaining instead of splitting fixes it without any budget arithmetic. `typecheck` is largely
 * single-threaded, so while it runs the app suite has the cores to itself; the engine suite then
 * starts late, is short, and is the only thing ever competing with the app pool. Lint runs only if
 * typecheck passed — it is cheap, and its result is only interesting when the types are sane.
 *
 * ⚠️ RE-MEASURED 2026-08-18 and the instability above no longer reproduces — the pinned
 * `ENGINE_LANE_WORKERS` is why. Chaining is kept for a DIFFERENT reason than it was adopted for:
 * splitting is now wall-clock-neutral rather than harmful, so it simply buys nothing. Note also
 * that chaining does not avoid the two pools overlapping — the engine suite runs t=~18s to t=~54s,
 * entirely inside the app lane — it only delays the overlap. See the header for the A/B.
 */
async function checksAndEngineLane() {
  const start = Date.now();
  const parts = [];
  const finish = (ok) => ({ ok, seconds: (Date.now() - start) / 1000, output: parts.join('') });

  const typecheck = await runCommand('npm run typecheck');
  parts.push(`--- typecheck ---\n${typecheck.output}`);
  if (!typecheck.ok) {
    parts.push('\n[verify] lint + engine tests skipped: typecheck failed\n');
    return finish(false);
  }

  const lint = await runCommand('npm run lint');
  parts.push(`--- lint ---\n${lint.output}`);

  // Runs even if lint failed — a lint error says nothing about whether the tests pass, and finding
  // out both in one go beats a second full run.
  const engine = await runCommand('npm --prefix engine/packages/modoki test',
    { MODOKI_TEST_MAX_WORKERS: ENGINE_LANE_WORKERS });
  parts.push(`--- engine tests ---\n${engine.output}`);

  return finish(lint.ok && engine.ok);
}

const lanes = [
  // The app suite keeps the machine's full performance-core pool (`engine/testWorkers.ts` sizes it)
  // — it is the critical path, and starving it just moves the wall-clock onto this lane.
  { name: 'app tests', run: () => runCommand('npm test') },
  { name: 'checks + engine tests', run: checksAndEngineLane },
];

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  console.error('\n[verify] SIGINT received — killing lanes...');
  for (const child of runCommand._active || []) {
    child.kill('SIGTERM');
  }
  process.exitCode = 1;
  // Give children a moment to die, then force exit.
  setTimeout(() => process.exit(1), 500).unref();
});

async function main() {
  const wallStart = Date.now();

  // Announce the lanes up front. Output is buffered per lane, so without this the terminal shows
  // NOTHING until the first lane finishes — on a gate people sit and watch, silence reads as a hang.
  console.log(`[verify] running ${lanes.length} lanes concurrently: ${lanes.map((l) => l.name).join(' · ')}`);

  const results = await Promise.all(
    lanes.map(async (lane) => {
      const result = await lane.run();
      const status = result.ok ? 'PASS' : 'FAIL';
      const header = `\n===== [${status}] ${lane.name} (${result.seconds.toFixed(1)}s) =====\n`;
      process.stdout.write(header);
      process.stdout.write(result.output);
      return { name: lane.name, ok: result.ok, seconds: result.seconds };
    })
  );

  if (interrupted) return;

  const wallSeconds = (Date.now() - wallStart) / 1000;

  console.log('\n===== verify summary =====');
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name} (${r.seconds.toFixed(1)}s)`);
  }
  console.log(`  total wall-clock: ${wallSeconds.toFixed(1)}s`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[verify] FAILED: ${failed.map((r) => r.name).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\n[verify] all lanes passed');
    process.exitCode = 0;
  }
}

// A throw in here must not report success — an unhandled rejection's exit code is a Node version
// detail, and this script's whole job is to be trusted as a gate.
main().catch((err) => {
  console.error(`\n[verify] crashed: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
