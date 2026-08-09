#!/usr/bin/env node
// `npm run verify` runs its legs SEQUENTIALLY: typecheck (25s) + lint (2s) +
// root `npm test` (198s) + `npm --prefix engine/packages/modoki test` (20s) — ~245s total,
// measured warm. The root test suite (vitest) leaves most of this machine's cores idle for
// nearly all of that 198s, so the other legs can run concurrently INSIDE it for free: the
// three lanes below are independent of each other (no lane's result depends on another
// lane's output) and are launched in parallel via `child_process.spawn`. Only within lane 2
// is there a real dependency — lint is cheap and only interesting when the types are sane —
// so lint runs after typecheck, sequentially, inside that one lane.
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
