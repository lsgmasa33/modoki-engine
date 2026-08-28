#!/usr/bin/env node
/**
 * Stamp the engine plugin dists that `build:plugins` just built, marking them CURRENT for
 * their sources (#395).
 *
 * Runs in the root `postinstall`, immediately after `build:plugins`. Without it,
 * `build:plugins` leaves a correct dist with no build stamp, so the next caller of
 * ensurePluginBuilt (the editor on open, the vendorer, or a test) reads that dist as
 * STALE and rebuilds it — deleting and recreating `dist/` inside the repo. When that
 * happened under `npm run verify`, it raced the app lane's dynamic
 * `import('capacitor-game-debug')` and failed the suite with a module-resolution error
 * that vanished on re-run. See vendorPlugins.ts § stampPluginBuild.
 *
 * ⚠️ THE STAMPED SET IS DERIVED FROM `build:plugins`, NOT FROM listEnginePlugins.
 * This is the whole safety argument and it is easy to get wrong. `listEnginePlugins`
 * discovers every `engine/packages/*` declaring a `capacitor` field; `build:plugins` is a
 * hand-written `--workspace` list, and the two are ALLOWED to diverge —
 * `pluginBuildCoverage.test.ts` says so explicitly ("a plugin used solely by a game …
 * is deliberately not required here"). Stamping the discovered set would vouch for a
 * plugin this install never built: if such a plugin has a stale `dist/` lying around from
 * an earlier build, the stamp is computed from its CURRENT sources, ensurePluginBuilt then
 * short-circuits forever, and packInto ships a tarball whose name is current and whose
 * bytes are stale — the #90 failure this stamp machinery exists to prevent. Only the
 * workspaces the `&&` actually covers may be stamped.
 *
 * ORDERING IS THE OTHER HALF: chained after `build:plugins` with `&&`, so a failed build
 * never reaches this script. (npm does NOT abort at the first failing workspace — later
 * ones still run — but the overall exit is non-zero, so nothing here is stamped.)
 *
 * NEVER fails the install. A missing stamp costs one redundant rebuild; a postinstall
 * that exits non-zero costs the whole `npm install`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendorPlugins } from './loadVendorPlugins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** The workspace dirs named in the root `build:plugins` script — the ONLY dirs whose dist
 *  this install is entitled to vouch for. Returns [] if the script is missing or shaped
 *  unexpectedly, which stamps nothing (safe: one redundant rebuild, never a stale trust).
 *
 *  Verified to fail SAFE (under-stamp) for every realistic rewrite: `-w a -w b` -> [], `--workspaces`
 *  -> [], `--workspace-root` -> no capture, a quoted path with a space -> a truncated nonexistent
 *  dir. The derivation test catches the two dangerous ones outright (`-w` makes the --workspace
 *  count 0; `--workspaces` makes parsed.length disagree with it).
 *
 *  ⚠️ ONE shape would be unsafe and is NOT guarded, because it cannot arise from today's script:
 *  chaining a SECOND command with its own workspaces inside build:plugins, e.g.
 *  `npm run build --workspace a && npm run build:native --workspace b`. `b` would be stamped
 *  although `npm run build` never ran there. If build:plugins ever grows a second command, this
 *  parser must become command-aware rather than string-wide. */
export function buildPluginsWorkspaces(pkgJson) {
  const script = pkgJson?.scripts?.['build:plugins'];
  if (typeof script !== 'string') return [];
  const out = [];
  const re = /--workspace(?:=|\s+)(\S+)/g;
  let m;
  while ((m = re.exec(script)) !== null) out.push(m[1].replace(/^["']|["']$/g, ''));
  return out;
}

/** The dirs this install is entitled to stamp, as {rel, dir} — the F1 safety property in ONE
 *  testable place. It MUST derive from build:plugins and never from listEnginePlugins: the loop
 *  below is a trivial iteration precisely so that the decision lives here, where a test can pin it.
 *  A stamper that consulted discovery instead would return the wider set and vouch for a plugin
 *  this install never built. */
export function plannedStampDirs(repoRoot, pkgJson) {
  return buildPluginsWorkspaces(pkgJson).map((rel) => ({ rel, dir: path.resolve(repoRoot, rel) }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stamp-plugin-builds.mjs')) {
  const mod = await loadVendorPlugins(repoRoot);
  if (!mod) {
    console.warn('[stamp] cannot load engine/plugins/vendorPlugins.ts (missing sources, or esbuild is not installed) — skipping. Plugin dists will be rebuilt once on first use.');
    process.exit(0);
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const workspaces = buildPluginsWorkspaces(pkg);
    if (!workspaces.length) {
      console.warn('[stamp] could not read any --workspace from build:plugins — stamping nothing. Plugin dists will be rebuilt once on first use.');
      process.exit(0);
    }
    const stamped = [];
    const skipped = [];
    for (const { rel, dir } of plannedStampDirs(repoRoot, pkg)) {
      if (mod.stampPluginBuild(dir)) stamped.push(rel);
      else skipped.push(rel);
    }
    if (stamped.length) console.log(`[stamp] marked ${stamped.length} plugin dist(s) current: ${stamped.join(', ')}`);
    // Loud, because a silent skip here is the flake coming back.
    if (skipped.length) console.warn(`[stamp] NOT stamped (no dist/, no src/, or the stamp could not be written): ${skipped.join(', ')}`);
  } catch (e) {
    console.warn(`[stamp] skipped (${e.message}) — plugin dists will be rebuilt once on first use.`);
  }
}
