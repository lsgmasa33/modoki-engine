#!/usr/bin/env node
/** Re-serialize every tracked `<asset>.meta.json` through the REAL
 *  `readMetaSidecar` → `writeMetaSidecar` pair, so the on-disk result cannot
 *  drift from what the editor/build writes at runtime.
 *
 *  This is the migration arm of the committed-vs-machine-local sidecar split
 *  (meta-sidecar.ts): whenever a key moves from the committed `.meta.json` into
 *  the gitignored `.meta.local.json`, the sidecars committed BEFORE that move
 *  still carry it, so the first write on any machine strips it — every time,
 *  forever. Running this once lands the migration in one reviewable commit.
 *
 *  Idempotent by construction: a second run rewrites 0 files. Nothing is lost —
 *  peeled keys are written to this machine's `.meta.local.json`, so the local
 *  caches they key stay valid and nothing re-bakes.
 *
 *    node engine/scripts/migrate-meta-sidecars.mjs [--dry-run]
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { repoFiles } from './repoCorpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dryRun = process.argv.includes('--dry-run');

// Bundle the TS module rather than reimplementing the split — the whole point is
// that this script and the editor agree byte-for-byte.
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meta-sidecar-')), 'meta-sidecar.mjs');
// ⚠️ `shell: isWindows` is load-bearing, not defensive. `execFile`/`spawn` do NO PATHEXT
// resolution on Windows, so a bare `npx` — whose real file is `npx.cmd` — throws ENOENT and this
// script is simply unrunnable there (VERIFIED on the `win` clone: `execFileSync('npx',
// ['--version'])` throws ENOENT in isolation). Same remedy and same spelling as
// `bootstrap-mcp-deps.mjs:33` and `bootstrap-game-deps.mjs:53`; see docs/windows.md § PATHEXT.
// Adding a `.cmd` shim is NOT an alternative — Node throws EINVAL on spawning `.cmd` without a
// shell since the CVE-2024-27980 fix.
//
// ⚠️ Residual, shared with both bootstrap scripts: `shell: true` makes Node CONCATENATE argv
// without escaping (DEP0190), so `outFile` would break if `os.tmpdir()` contained a space — a
// real possibility on Windows (`C:\Users\Jane Doe\...`), though not on this clone. The
// prescribed fix in docs/windows.md is `whichSync()`/`spawnable()` from engine/toolchain, which
// a plain `.mjs` cannot import (the same `.ts`-barrier that forced pathPosix.mjs to exist). Left
// matching the established `.mjs` precedent rather than diverging here.
const isWindows = process.platform === 'win32';
execFileSync('npx', ['esbuild', 'engine/plugins/meta-sidecar.ts', '--bundle', '--format=esm',
  '--platform=node', `--outfile=${outFile}`], { cwd: repoRoot, stdio: 'inherit', shell: isWindows });
const { readMetaSidecar, writeMetaSidecar } = await import(pathToFileURL(outFile).href);

// repoFiles() is `-z`-safe internally (see repoCorpus.mjs) — a non-ASCII path (the
// island's Cyrillic-named textures) is never rendered as an escaped, double-quoted
// string that would fail to open. Floored well under the 391 measured today, so only
// a broken enumeration (not ordinary asset churn) can trip it.
const tracked = repoFiles({ match: /\.meta\.json$/, floor: 100 }).map(({ rel }) => rel);

let changed = 0;
for (const rel of tracked) {
  const abs = path.join(repoRoot, rel);
  const assetPath = abs.replace(/\.meta\.json$/, '');
  const before = fs.readFileSync(abs, 'utf-8');
  const meta = readMetaSidecar(assetPath);
  if (Object.keys(meta).length === 0) { console.warn(`  skip (unparsable): ${rel}`); continue; }
  if (dryRun) {
    // Predict the committed text without touching disk: same peel, same writer.
    const probe = path.join(path.dirname(outFile), 'probe');
    writeMetaSidecar(probe, meta);
    const after = fs.readFileSync(probe + '.meta.json', 'utf-8');
    fs.rmSync(probe + '.meta.json'); fs.rmSync(probe + '.meta.local.json', { force: true });
    if (after !== before) { changed++; console.log(`  would rewrite: ${rel}`); }
    continue;
  }
  writeMetaSidecar(assetPath, meta);
  if (fs.readFileSync(abs, 'utf-8') !== before) { changed++; console.log(`  rewrote: ${rel}`); }
}

console.log(`\n${dryRun ? 'Would rewrite' : 'Rewrote'} ${changed} of ${tracked.length} tracked sidecars.`);
