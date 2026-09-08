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
//   (+ scoped per-project typecheck, #967 — not in the above; its cost is at the leg below)
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

import { spawn, spawnSync } from 'node:child_process';
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
 * Lane 2: typecheck -> scoped per-project typecheck -> lint -> engine tests, in sequence.
 *
 * ⚠️ The MEASURED table in the header predates the scoped leg (#967) and the whole lane has NOT
 * been re-measured. The leg costs 0 on a branch that touched no game; its measured in-lane cost
 * is stated ONCE, at the leg itself below. Do not quote the numbers below as current for lane 2.
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

  // #967: the SCOPED per-project typecheck. The wide program above (app + every game + every
  // demo at once) cannot see a project whose file typechecks only because a SIBLING leaked
  // ambient types into it — that mask surfaces later, in a per-game web build. This used to run
  // only in the private `ci.yml`, which is no longer run, so it ran nowhere at all.
  //
  // ⚠️ It is affordable HERE only because it defaults to the projects this branch TOUCHED; a full
  // sweep would make lane 2 the pole outright. The script escalates ITSELF to a full sweep
  // whenever it cannot tell what changed — including on a clean checkout of `main` — so a slow
  // run here is information, not a bug: read its `selection:` line before assuming it misbehaved.
  // Costs, the per-clone project-count caveat and the `main` case all live in ONE place, that
  // script's own header. Do not restate them here.
  //
  // ⚠️ WHEN THE ESCALATION FIRES, THIS GATE GOES FROM ~2 MINUTES TO ~11. Measured 2026-09-08 on a
  // branch that edited the machinery files: lane 2 = 643.1s against a 100.2s app lane, so lane 2
  // becomes the pole and verify's wall clock is 643.2s. The sweep itself is unchanged standalone
  // (171.4s, 29 projects) — the ~3x is in-lane inflation, because a sweep that long overlaps the
  // whole app lane rather than hiding under it. This is the DESIGNED price of editing the scoped
  // typecheck's own machinery (or of a clean checkout of `main`), not a regression; it is written
  // down because a gate that silently takes 5x longer reads as a hang.
  //
  // ⚠️ MEASURED IN-LANE, and quote THIS number rather than the standalone one: 23.1s for two
  // projects (13.1 + 10.0), against 13.5s for the same two run standalone. That ~1.7x is the
  // same in-lane inflation the header documents for every other leg — the first draft of this
  // comment quoted the standalone figure, which is precisely the mistake the header warns about.
  // In that run lane 2 was 116.0s against a 139.9s app lane, so it still did not bind; but the
  // header's "~30s of slack" is a PRE-#967 figure and the margin is now thinner than it reads.
  //
  // Ordered after typecheck (a wide type error makes every scoped run repeat the same noise) and
  // before lint purely because it is the more interesting signal of the two.
  const scoped = await runCommand('npm run typecheck:projects');
  parts.push(`--- typecheck (per-project, scoped) ---\n${scoped.output}`);

  const lint = await runCommand('npm run lint');
  parts.push(`--- lint ---\n${lint.output}`);

  // Runs even if lint failed — a lint error says nothing about whether the tests pass, and finding
  // out both in one go beats a second full run.
  const engine = await runCommand('npm --prefix engine/packages/modoki test',
    { MODOKI_TEST_MAX_WORKERS: ENGINE_LANE_WORKERS });
  parts.push(`--- engine tests ---\n${engine.output}`);

  return finish(scoped.ok && lint.ok && engine.ok);
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

/** Re-copy `engine/scripts/git-hooks/*` into the hooks dir git actually reads (#909).
 *
 *  The hooks are a SOURCE that is COPIED; editing one changes nothing until the installer re-runs.
 *  `prepare` covers a hook change that rides along with a dependency change, and nothing covered a
 *  hook edited on its own — so two clones spent a day committing through a hook from before the
 *  edit, with the suite green the whole time.
 *
 *  ⚠️ **A heal, not a guard, and that is the decision.** The alternative was a test comparing
 *  installed against source, which goes red for the state of somebody's machine rather than for
 *  anything in the diff under test, needs a skip for a clone that has no hooks, and re-opens the
 *  argument `CLAUDE.md` already settled when it declined a blocking hook ("the discipline IS the
 *  guard"). ⚠️ **And the two must not both exist** — healing here immediately before such a test
 *  ran would make it a guard that cannot fail, which is the exact class (#851/#909) this is fixing.
 *
 *  Never fails the gate: the installer already no-ops without a git dir, and a hook that could not
 *  be installed is not a reason to refuse to run the tests. */
function installGitHooks() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'install-git-hooks.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  // Quiet on the ONE line that would otherwise print every run — `no git hooks dir`, which a
  // tarball extract or any non-git checkout emits — and pass everything else through.
  //
  // ⚠️ **Deny-list, not allow-list, and the allow-list version was a bug** (close-out review). It
  // kept only `[hooks] installed …`, which also discarded the installer's STACK TRACE. Measured: an
  // unwritable hooks dir makes the installer exit 1 with EACCES, and the filter reduced that to the
  // empty string — so `verify` printed nothing, went green, and the developer kept committing
  // through the stale hook. That is the #909 state the heal exists to prevent, with the heal's own
  // reporting hiding it. Status is checked for the same reason: silence must mean "nothing to do",
  // never "it failed".
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('[hooks] no git hooks dir'))
    .join('\n');
  if (out) console.log(out);
  if (r.status !== 0) {
    console.warn(`[verify] git hooks were NOT installed (exit ${r.status}) — commits from this clone `
      + 'may be running a stale hook. This does not fail the gate; see docs/verify-and-ci.md.');
  }
}

async function main() {
  const wallStart = Date.now();

  installGitHooks();

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
