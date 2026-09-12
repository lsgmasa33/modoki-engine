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
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { perToolBytes } from './surfaceBytes.js';
import {
  parseLedger, corpusBaseline, ledgerDelta, renderLedger, appendChunk, assertCsvSafe,
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
// ONE spelling of this clone's file name: it is both what we append to and what the corpus scan
// must skip (it is already parsed strictly, as `rows`). Two copies of the sanitisation would let a
// change to one silently double-count this clone's own rows.
const ownFile = `${clone.replace(/\//g, '-')}.csv`;
const file = join(dir, ownFile);
const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
const rows = parseLedger(existing);

// ── The baseline is the CORPUS, not this clone's file (#1103) ──────────────────────────────────
// Writing stays per-clone and unchanged; only READING widens. Each clone's CSV travels with its
// commits, so the merge that brings in another clone's tool change also brings in the row that
// booked it — which is what lets this run recognise the bytes as already-spent instead of booking
// them again under the clone that merely merged.
//
// ⚠️ **Our own file and everyone else's are parsed under DIFFERENT failure rules, deliberately.**
// `rows` above is the strict parse of the file this run is about to APPEND to: `parseLedger` throws
// on a malformed line, and that must stay fatal, because appending to a file we could not read
// compounds the corruption and the next run then fails on a file nobody can repair by hand. Another
// clone's file is not ours to append to — losing it costs only a wider re-booking window (the
// pre-#1103 behaviour), so it warns and is skipped rather than taking this run down with it.
const corpusRows = [
  ...rows,
  ...(existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith('.csv') && f !== ownFile)
    .flatMap((f) => {
      try { return parseLedger(readFileSync(join(dir, f), 'utf8')); } catch (e) {
        console.warn(`ledger: ignoring unreadable ${f} — ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
];

/** Rank every corpus sha by where it sits in THIS tree's history — 0 = HEAD, larger = older, absent
 *  = not an ancestor. One `git rev-list` rather than a `merge-base --is-ancestor` per sha.
 *
 *  ⚠️ CSV shas are ABBREVIATED and the abbreviation length is not fixed (git widens it as a repo
 *  grows), so this indexes the full shas by a 7-char prefix and then prefix-matches. Keying the map
 *  on a guessed length would silently rank nothing on the day git moved to 10 characters — and a
 *  baseline of nothing is indistinguishable from a clean tree, so the run would book the entire
 *  surface against this clone rather than fail. */
function rankShas(shas: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  if (shas.length === 0) return ranks;
  let history: string[];
  try { history = git('rev-list', 'HEAD').split('\n').filter(Boolean); } catch { return ranks; }
  const byPrefix = new Map<string, { full: string; rank: number }[]>();
  history.forEach((full, rank) => {
    const key = full.slice(0, 7);
    const bucket = byPrefix.get(key);
    if (bucket) bucket.push({ full, rank }); else byPrefix.set(key, [{ full, rank }]);
  });
  for (const short of new Set(shas)) {
    if (short.length < 7) continue;   // too short to disambiguate — treat as unknown, not as HEAD
    const hit = (byPrefix.get(short.slice(0, 7)) ?? []).find((c) => c.full.startsWith(short));
    if (hit) ranks.set(short, hit.rank);
  }
  return ranks;
}

const order = rankShas(corpusRows.map((r) => r.sha));
if (order.size === 0 && corpusRows.length > 0) {
  // Not fatal, but it silently reverts this run to the pre-#1103 behaviour, so it must be visible.
  console.warn('ledger: could not rank any recorded sha against HEAD — falling back to this '
    + "clone's own file, which re-books anything that arrived by merge.");
}
const lastKnown = corpusBaseline({ rows: corpusRows, order, fallbackClone: clone });

// Seeding is now a property of the CORPUS, not of this clone's file: a new clone joining an
// established repo inherits real baselines instead of booking the whole 150 KB surface as its own
// first-run delta. Only a genuinely empty corpus seeds.
const seeding = lastKnown.size === 0;

const added = ledgerDelta({
  perTool: perToolBytes(), lastKnown, date, clone, sha, seeding,
});
for (const row of added) assertCsvSafe(row);

if (added.length === 0) {
  console.log('ledger unchanged: no tool has changed size since any clone last recorded one at a\n'
    + "  commit in this tree's history (#1103 — the baseline is the whole ledger/ corpus, so work\n"
    + '  that arrived by merge is already accounted for and is not re-booked here).');
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
// ⚠️ `seeding`, NOT `rows.length === 0`. Since #1103 a clone whose own file is empty but whose
// corpus is not inherits real baselines and books real deltas — calling that "seeded" would
// describe a fresh clone's first genuine measurements as a zero-delta baseline.
console.log(
  seeding
    ? `ledger seeded: ${added.length} tools baselined for ${clone} at ${added[0].surfaceBytesAfter} B → ${file}`
    : `ledger: ${added.length} tool(s) changed, net ${net >= 0 ? '+' : ''}${net} B, `
      + `surface now ${added[0].surfaceBytesAfter} B → ${file}`,
);
console.log(`(header: ${LEDGER_HEADER})`);
