/** Append this clone's MCP tool-surface changes to its own ledger CSV (#894).
 *
 *      npm --prefix engine/tools/modoki-mcp run gen:ledger
 *
 *  Run by `/close-out` § 6, before the push. A run that changed nothing writes nothing, so it is
 *  cheap enough to be unconditional.
 *
 *  ⚠️ § 6 runs it AFTER the gate, and that ordering is deliberate: the row records a `sha`, and
 *  CLAUDE.md sanctions fixing a red gate with `--amend`. Booked before the gate, a row can end up
 *  pointing at a commit that no longer exists on the branch. That
 *  automation is the load-bearing part: a ledger that depends on someone remembering to type a row
 *  rots on the first busy close-out, and a rotted ledger is worse than none, because it is silently
 *  incomplete while still looking authoritative.
 *
 *  The measurement and the diff live in `surfaceBytes.ts` / `surfaceLedger.ts` so this file stays a
 *  thin shell over functions the tests drive directly (conventions §9). */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { perToolBytes } from './surfaceBytes.js';
import {
  parseLedger, lastKnownSizes, ledgerDelta, renderLedger, appendChunk, assertCsvSafe,
  ledgerSkipReason, LEDGER_HEADER,
} from './surfaceLedger.js';

const here = dirname(fileURLToPath(import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: here, encoding: 'utf8' }).trim();

const clone = process.env.MODOKI_LEDGER_CLONE || git('branch', '--show-current');
if (!clone) throw new Error('cannot determine the clone: no current branch and no MODOKI_LEDGER_CLONE');
// The decision lives in `surfaceLedger.ts` (`ledgerSkipReason`) because it is unreachable from any
// clone that could test it here — see its docblock for why that matters.
const skip = ledgerSkipReason(clone, process.env);
if (skip) {
  console.log(`ledger skipped: ${skip}. Set MODOKI_LEDGER_CLONE to override.`);
  process.exit(0);
}

const sha = git('rev-parse', '--short', 'HEAD');
const date = new Date().toISOString().slice(0, 10);

const dirtySurface = git('status', '--porcelain', '--', 'src', 'surfaceBytes.ts');
if (dirtySurface) {
  console.error('ledger REFUSED: the tool-surface source is uncommitted, so this measurement would '
    + 'not describe any committed tree. Commit or restore first, then re-run.\n'
    + dirtySurface.split('\n').map((l) => `  ${l}`).join('\n'));
  process.exit(1);
}

const dir = join(here, 'ledger');
const file = join(dir, `${clone.replace(/\//g, '-')}.csv`);
const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
const rows = parseLedger(existing);

const added = ledgerDelta({
  perTool: perToolBytes(), lastKnown: lastKnownSizes(rows), date, clone, sha,
});
for (const row of added) assertCsvSafe(row);

if (added.length === 0) {
  console.log(`ledger unchanged: no tool changed size since ${clone}'s last run`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
if (existing.length === 0) {
  writeFileSync(file, renderLedger(added, { withHeader: true }));
} else {
  // `appendChunk`, not a bare `renderLedger`: it heals a missing trailing newline on the existing
  // file, which would otherwise concatenate two rows into one unreadable line. Reason in full at
  // its definition.
  appendFileSync(file, appendChunk(existing, added));
}

const net = added.reduce((sum, r) => sum + r.deltaBytes, 0);
const seeded = rows.length === 0;
console.log(
  seeded
    ? `ledger seeded: ${added.length} tools baselined for ${clone} at ${added[0].surfaceBytesAfter} B → ${file}`
    : `ledger: ${added.length} tool(s) changed, net ${net >= 0 ? '+' : ''}${net} B, `
      + `surface now ${added[0].surfaceBytesAfter} B → ${file}`,
);
console.log(`(header: ${LEDGER_HEADER})`);
