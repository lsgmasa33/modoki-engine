/** Append this clone's MCP tool-surface changes to its own ledger CSV (#894).
 *
 *      npm --prefix engine/tools/modoki-mcp run gen:ledger
 *
 *  Run by `/close-out` § 6, before the push. A run that changed nothing writes nothing, so it is
 *  cheap enough to be unconditional.
 *
 *  ⚠️ It is fine that § 6 places this ABOVE its `npm run verify` block: the row records the surface
 *  as it stands when the step runs, and if a red gate then forces a change to a description, the
 *  next run books the difference. What must not happen is skipping it — see the mis-attribution
 *  note in the skill. That
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
  parseLedger, lastKnownSizes, ledgerDelta, renderLedger, assertCsvSafe, LEDGER_HEADER,
} from './surfaceLedger.js';

const here = dirname(fileURLToPath(import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: here, encoding: 'utf8' }).trim();

const clone = process.env.MODOKI_LEDGER_CLONE || git('branch', '--show-current');
if (!clone) throw new Error('cannot determine the clone: no current branch and no MODOKI_LEDGER_CLONE');
// ⚠️ The HUB does not keep a ledger, and this guard is what stops the unconditional `/close-out`
// step from creating one. `main` is where every worker branch is merged, so its per-tool deltas are
// the UNION the five worker CSVs exist to disaggregate — a `main.csv` would restate the sum the
// `DEFINITION_BYTES` pin already reports, attributed to nobody, and it would grow a row on every
// integration. Escape hatch kept deliberate: `MODOKI_LEDGER_CLONE` still forces a name, so this is
// a default, not a prohibition.
//
// ⚠️ This is also why the file is keyed by BRANCH rather than by clone directory: the two coincide
// only because each clone stays on its own long-lived branch (CLAUDE.md § Clones). A `release_*`
// checkout in a worker would seed a second CSV; that is left un-guarded because a release branch is
// short-lived and the rows would still be honestly attributed to the work done on it.
if (!process.env.MODOKI_LEDGER_CLONE && clone === 'main') {
  console.log('ledger skipped: `main` is the integration branch — its deltas are the union of the '
    + 'worker branches, which the per-clone CSVs exist to separate. Set MODOKI_LEDGER_CLONE to override.');
  process.exit(0);
}
const sha = git('rev-parse', '--short', 'HEAD');
const date = new Date().toISOString().slice(0, 10);

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
if (existing.length === 0) writeFileSync(file, renderLedger(added, { withHeader: true }));
else appendFileSync(file, renderLedger(added, { withHeader: false }));

const net = added.reduce((sum, r) => sum + r.deltaBytes, 0);
const seeded = rows.length === 0;
console.log(
  seeded
    ? `ledger seeded: ${added.length} tools baselined for ${clone} at ${added[0].surfaceBytesAfter} B → ${file}`
    : `ledger: ${added.length} tool(s) changed, net ${net >= 0 ? '+' : ''}${net} B, `
      + `surface now ${added[0].surfaceBytesAfter} B → ${file}`,
);
console.log(`(header: ${LEDGER_HEADER})`);
