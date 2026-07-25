#!/usr/bin/env node
/** Writes the EMBEDDED bundle's own manifest.json into a built `dist/` directory (Phase 2
 *  of docs/ota-updates.md — "delta update without any whole update").
 *
 *  Without this, the very FIRST OTA check on a fresh install has nothing local to diff
 *  against, so it always falls back to downloading the whole bundle zip even if only one
 *  file changed since the app was built. Shipping the app's OWN manifest alongside its
 *  embedded assets lets `checkForUpdate` (engine/packages/modoki/src/runtime/ota/otaClient.ts)
 *  fetch it via a bare relative URL — zero network round-trip beyond what's already in the
 *  WebView's local content — and diff the very first update too.
 *
 *  Run AFTER the normal web build, BEFORE `cap sync` (so the manifest ships inside the
 *  native app's bundled assets, not just the dev dist/ directory):
 *    MODOKI_PROJECT=games/<id> npm run build
 *    node engine/scripts/ota-embed-manifest.mjs --dist games/<id>/dist --name shell --engine-api 1
 *
 *  Deliberately NOT wired into the build automatically yet — same "standalone CLI, Phase
 *  5 wires it into project.config.json / the editor" posture as ota-publish.mjs, so it can
 *  be exercised/tested independently first. `--name` should match the `bundleName` the
 *  game's `checkForUpdate` call passes at runtime; the `version` field is always the fixed
 *  sentinel `EMBEDDED_BASE_VERSION` from otaClient.ts ("embedded") since it isn't a real
 *  published version and `diffManifests` never compares version strings, only per-file
 *  path+hash. */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildManifestFiles } from './ota/buildManifest.mjs';
import { createManifest, validateManifest } from './ota/schema.mjs';

const EMBEDDED_BASE_VERSION = 'embedded'; // keep in sync with otaClient.ts's exported constant

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error(`[ota-embed-manifest] ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dist) fail('--dist <path> is required (a built dist/ directory)');
  if (!args.name) fail('--name <bundleName> is required (must match the runtime checkForUpdate call)');
  const engineApi = Number(args.engineApi);
  if (!Number.isInteger(engineApi) || engineApi < 1) fail('--engine-api <n> must be a positive integer');

  const distDir = path.resolve(args.dist);
  if (!existsSync(distDir)) fail(`dist dir not found: ${distDir}`);

  const outPath = args.out ? path.resolve(args.out) : path.join(distDir, 'ota-embedded-manifest.json');

  // Hash the dist tree BEFORE writing the manifest into it — otherwise the manifest would
  // (harmlessly, but confusingly) include a hash for itself from a stale previous run.
  const files = await buildManifestFiles(distDir);
  const manifest = createManifest({ name: args.name, version: EMBEDDED_BASE_VERSION, engineApi, files });
  const errors = validateManifest(manifest);
  if (errors.length > 0) fail(`built an invalid manifest (this is a bug): ${errors.join('; ')}`);

  writeFileSync(outPath, JSON.stringify(manifest));
  console.log(`[ota-embed-manifest] wrote ${outPath} (${Object.keys(files).length} files)`);
}

main().catch((err) => fail(err?.stack || String(err)));
