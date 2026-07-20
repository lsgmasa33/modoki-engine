#!/usr/bin/env node
/** Per-game web build: typecheck + vite build.
 *
 *  The typecheck is SCOPED to the active MODOKI_PROJECT. The shared
 *  engine/tsconfig.app.json globs `../games` (every game) so `npm run typecheck`
 *  covers the whole repo — but a per-game BUILD shouldn't fail because a SIBLING
 *  game's native Capacitor plugins aren't built in this worktree (their JS/types
 *  live in a gitignored dist/). One project = one game (#29): a build typechecks
 *  the engine app + the ACTIVE in-repo game only, never its siblings.
 *
 *  Full cross-game coverage still lives in `npm run typecheck` (tsc -b engine). */

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const engineDir = path.join(repoRoot, 'engine');
const proj = process.env.MODOKI_PROJECT; // 'games/<id>' (in-repo) or an external abs path

// Include the engine app always; add the active game ONLY when it lives inside
// this repo's games/ (an external project's TS isn't in the repo tsconfig graph,
// and we never include sibling games). Paths are relative to engineDir, where the
// generated tsconfig sits, so its `extends` + relative includes resolve correctly.
const include = ['app'];
if (proj) {
  const abs = path.resolve(repoRoot, proj);
  const gamesDir = path.join(repoRoot, 'games');
  if (abs === path.join(gamesDir, path.basename(abs)) && abs.startsWith(gamesDir + path.sep)) {
    include.push(path.relative(engineDir, abs).split(path.sep).join('/'));
  }
}

const scopedPath = path.join(engineDir, 'tsconfig.app.scoped.json');
writeFileSync(scopedPath, JSON.stringify({ extends: './tsconfig.app.json', include }, null, 2) + '\n');

// Invoke tsc/vite via their resolved JS entrypoints with THIS node (process.execPath),
// not via a bare `tsc`/`vite` on PATH. Reasons: the packaged editor runs this as
// `node build-web.mjs` (electron-builder strips `scripts`, so `npm run build` isn't
// available) AND ships no node_modules/.bin symlinks — so a PATH lookup finds nothing.
// node_modules/.bin is still prepended to PATH for any grandchild that shells out.
const binDir = path.join(repoRoot, 'node_modules', '.bin');
const sep = process.platform === 'win32' ? ';' : ':';
const runEnv = { ...process.env, PATH: `${binDir}${sep}${process.env.PATH ?? ''}` };
const node = process.execPath;
const q = (s) => JSON.stringify(s);
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: repoRoot, env: runEnv });

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
try {
  // Typecheck gate — DEV only. typescript is a devDependency, so the packaged editor
  // doesn't ship it; there the typecheck is also redundant (the engine ships pre-built,
  // and an EXTERNAL project's game code isn't in the tsc scope anyway — see `include`
  // above). vite transpiles TS via esbuild, so the actual build needs no typescript.
  if (existsSync(tscBin)) {
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.app.scoped.json`); // app + active game (scoped)
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.node.json`);        // vite config / electron
  } else {
    console.log('[build-web] typescript not installed — skipping typecheck (packaged build).');
  }
  run(`${q(node)} ${q(viteBin)} build --config engine/vite.config.ts`);
} catch {
  // The failing child already printed its diagnostics via inherited stdio; exit
  // non-zero (without a node stack trace) so the build pipeline reports failure.
  process.exit(1);
}
