#!/usr/bin/env node
/** OTA Phase 4 — build a project's game.ts as a sub-game bundle: one externalized
 *  IIFE (games/<id>/subgame-dist/subgame.js + subgame.json + its own asset manifest)
 *  that a shell dynamically loads at runtime, instead of the normal shell app build.
 *  See docs/ota-subgame-modules.md.
 *
 *  Typecheck scoping mirrors build-web.mjs exactly (see its header comment) — a
 *  sub-game build shouldn't fail because a sibling game's native plugin types aren't
 *  built in this worktree. */

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chooseViteConfig } from './viteConfigChoice.mjs';
import { isProjectDir } from './projectRoots.mjs';

const repoRoot = process.cwd();
const engineDir = path.join(repoRoot, 'engine');
const proj = process.env.MODOKI_PROJECT;

if (!proj) {
  console.error('[build-subgame] MODOKI_PROJECT is required (e.g. MODOKI_PROJECT=games/<id>).');
  process.exit(1);
}

const include = ['app'];
const abs = path.resolve(repoRoot, proj);
if (isProjectDir(repoRoot, abs)) {
  include.push(path.relative(engineDir, abs).split(path.sep).join('/'));
}

// Write deferred to just before tsc actually runs — see build-web.mjs's matching
// comment (its `existsSync(tscBin)` branch) for why an unconditional write here EPERMs
// a packaged install's read-only `engine/` (e.g. an admin-elevated Program Files).
const scopedPath = path.join(engineDir, 'tsconfig.app.scoped.json');

const binDir = path.join(repoRoot, 'node_modules', '.bin');
const sep = process.platform === 'win32' ? ';' : ':';
const runEnv = { ...process.env, MODOKI_SUBGAME: '1', PATH: `${binDir}${sep}${process.env.PATH ?? ''}` };
const node = process.execPath;
const q = (s) => JSON.stringify(s);
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: repoRoot, env: runEnv });

const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
try {
  if (existsSync(tscBin)) {
    writeFileSync(scopedPath, JSON.stringify({ extends: './tsconfig.app.json', include }, null, 2) + '\n');
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.app.scoped.json`);
    run(`${q(node)} ${q(tscBin)} -p engine/tsconfig.node.json`);
  } else {
    console.log('[build-subgame] typescript not installed — skipping typecheck (packaged build).');
  }
  // ⚠️ Do NOT add --configLoader runner — see build-web.mjs's matching comment (bug
  // vSlzfZLr7pIX5Yw0RSSe): it breaks any build-hook dynamic import (rigged-model
  // conversion, the SSR-postprocessor loader), which is worse than the EPERM it fixes.
  // #326: same as build-web.mjs — a packaged editor must be handed the CJS config, whose Vite
  // loader branch compiles in memory instead of writing `.vite-temp` inside the signed bundle.
  // This site was missed when that landed; nothing calls it from the editor UI TODAY (a sub-game
  // build is still run by hand, see docs/ota-subgame-modules.md), so the bug was latent — which
  // is exactly how it would have shipped the moment that gets wired to a button.
  run(`${q(node)} ${q(viteBin)} build --config ${chooseViteConfig(engineDir)}`);
} catch {
  process.exit(1);
}
