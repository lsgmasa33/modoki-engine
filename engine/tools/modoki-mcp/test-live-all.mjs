// `npm run test:mcp:live` — the T3 sweep (test-live-tools.ts) THEN the smoke half (test-smoke.mjs).
//
// Both halves always run. They used to be chained with `&&`, so a single sweep DEFECT skipped the
// whole smoke half and the run said nothing about the mutating tools. The exit still fails when
// EITHER half fails, so a real DEFECT stays red.
//
// A Node runner rather than `a ; b` in package.json: npm runs scripts under cmd.exe on Windows,
// where `;` is not a separator.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSpawn } from '../../scripts/winSpawn.mjs';

const cwd = dirname(fileURLToPath(import.meta.url));
// `toSpawn` finds npm.cmd on Windows without a shell (noShellSpawn.test.ts). A child killed by a
// signal has a null status, which counts as a failure.
const run = (script) => {
  const s = toSpawn('npm', ['run', script]);
  return spawnSync(s.command, s.args, { ...s.options, cwd, stdio: 'inherit' }).status ?? 1;
};

const sweep = run('test:live');
const smoke = run('smoke');
console.log(`\n[test:mcp:live] sweep ${sweep === 0 ? 'OK' : `FAILED (exit ${sweep})`} · smoke ${smoke === 0 ? 'OK' : `FAILED (exit ${smoke})`}`);
process.exit(sweep === 0 && smoke === 0 ? 0 : 1);
