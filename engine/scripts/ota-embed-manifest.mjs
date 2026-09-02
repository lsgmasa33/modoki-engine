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
 *    node engine/scripts/ota-embed-manifest.mjs \
 *      --dist games/<id>/dist --name shell --engine-api 1 --project games/<id>
 *
 *  It IS wired into the editor's native build pipeline (`vite-asset-scanner.ts`, gated on
 *  `cfg.ota.enabled`) — "Deliberately NOT wired" below is about `ota-publish.mjs`'s own
 *  posture, not this script's.
 *
 *  #582's sibling guard: `--project <dir>` is REQUIRED (mirroring `ota-publish.mjs`'s own
 *  `--project`) and read for exactly two checks, never for `--dist`/`--name`/`--engine-api`
 *  themselves, which stay explicit CLI arguments:
 *   - `--name` must equal the project's resolved `ota.bundleName` (an absent field resolves
 *     to `OTA_DEFAULT_BUNDLE_NAME`, imported from `./ota/publishGuards.mjs` — the SAME
 *     defaulting `ota-publish.mjs` uses, not reimplemented here). The route always builds
 *     `--dist <projectRoot>/dist` and `--name cfg.ota.bundleName` from ONE project, so mixing
 *     project A's `--dist` with project B's `--name` here writes an embedded manifest
 *     describing another app's files — the delta path then fails on-device and silently
 *     falls back to a whole-zip download forever.
 *   - the resolved `--dist` must be INSIDE the resolved `--project` directory. Unlike
 *     `ota-publish.mjs` (which deliberately has NO such containment check — a sub-game
 *     publish legitimately pairs `--dist games/A/subgame-dist` with `--project games/<shell>`),
 *     this check IS valid here: an embedded manifest always describes the shipping app's OWN
 *     dist, and the route always passes `<projectRoot>/dist`.
 *
 *  Deliberately NOT wired into `ota-publish.mjs` itself or the standalone sub-game publish
 *  path — same "standalone CLI, exercised/tested independently" posture that motivated
 *  keeping this a plain CLI rather than folding it into `ota-publish.mjs`. `--name` should
 *  match the `bundleName` the game's `checkForUpdate` call passes at runtime; the `version`
 *  field is always the fixed sentinel `EMBEDDED_BASE_VERSION` from otaClient.ts ("embedded")
 *  since it isn't a real published version and `diffManifests` never compares version
 *  strings, only per-file path+hash. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildManifestFiles } from './ota/buildManifest.mjs';
import { OTA_DEFAULT_BUNDLE_NAME } from './ota/publishGuards.mjs';
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
  if (!args.project) fail('--project is required (the project dir whose project.config.json this manifest is embedded for) — its ota.bundleName decides whether --dist/--name may be embedded together.');

  const distDir = path.resolve(args.dist);
  if (!existsSync(distDir)) fail(`dist dir not found: ${distDir}`);
  const projectDir = path.resolve(args.project);

  // Same fail-closed reasoning as ota-publish.mjs's own `--project` read: an unreadable or
  // malformed config must abort loudly, never degrade to "unguarded".
  const projectConfigPath = path.join(projectDir, 'project.config.json');
  if (!existsSync(projectConfigPath)) fail(`--project's project.config.json not found: ${projectConfigPath}`);
  let projectConfig;
  try {
    projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
  } catch (e) {
    fail(`--project's project.config.json (${projectConfigPath}) could not be parsed as JSON: ${e.message}`);
  }
  const ota = projectConfig?.ota;
  if (typeof ota !== 'object' || ota === null || Array.isArray(ota)) {
    fail(`${projectConfigPath} has no object-typed "ota" field — cannot verify this manifest's bundle identity against it.`);
  }
  // Absent `bundleName` resolves to the default — see OTA_DEFAULT_BUNDLE_NAME's own doc
  // comment in publishGuards.mjs for why (pruneProjectConfig omits a field equal to its
  // default when the on-disk file never had the key). Deliberately reuses that constant
  // rather than re-deriving the default here — the two scripts must agree.
  const projectBundleName = ota.bundleName === undefined ? OTA_DEFAULT_BUNDLE_NAME : ota.bundleName;
  if (typeof projectBundleName !== 'string' || !projectBundleName) {
    fail(`${projectConfigPath}'s ota.bundleName is present but not a non-empty string (got ${JSON.stringify(ota.bundleName)}).`);
  }
  if (args.name !== projectBundleName) {
    fail(`--name "${args.name}" does not match ${projectConfigPath}'s ota.bundleName ("${projectBundleName}") — the route always builds --dist and --name from ONE project, so a mismatch here would embed a manifest describing another app's files. Pass --name "${projectBundleName}" to embed this project's own manifest.`);
  }
  // Containment check — valid HERE unlike ota-publish.mjs's deliberate lack of one: an
  // embedded manifest always describes the shipping app's OWN dist (the route always passes
  // `<projectRoot>/dist`), whereas a sub-game PUBLISH legitimately pairs a sub-game's own
  // dist with the shell project it's staged from. Those are different operations with
  // different invariants, not an inconsistency between the two scripts.
  const distRelToProject = path.relative(projectDir, distDir);
  if (distRelToProject.startsWith('..') || path.isAbsolute(distRelToProject)) {
    fail(`--dist (${distDir}) is not inside --project (${projectDir}) — an embedded manifest must describe the shipping app's OWN dist.`);
  }

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
