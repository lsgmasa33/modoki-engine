#!/usr/bin/env node
/**
 * `tsc` under the gate's heap (#1885): `node engine/scripts/tsc.mjs <tsc args>` runs the repo's
 * own TypeScript with `TSC_NODE_ARGS` (see tscHeap.mjs for why). For npm scripts, which cannot set
 * a node flag portably; a script that already spawns tsc imports `TSC_NODE_ARGS` instead.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TSC_NODE_ARGS } from './tscHeap.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const r = spawnSync(process.execPath, [...TSC_NODE_ARGS, tscBin, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) { console.error(`[tsc] could not run ${tscBin}: ${r.error.message}`); process.exit(1); }
// A signal death has no status: fail with 128 + the signal, as a shell reports it — 134 for V8's OOM abort (SIGABRT),
// 137 for the kernel's OOM killer (SIGKILL), so the two memory failures stay told apart.
process.exit(r.status ?? 128 + (constants.signals[r.signal] ?? 6));
