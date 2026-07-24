#!/usr/bin/env node
/** Publishes an OTA bundle update (Phase 0/1 of docs/plans/mobile-ota-updates-plan.md).
 *
 *  Takes an already-built `dist/` directory (from `node engine/scripts/build-web.mjs`),
 *  hashes it into a bundle manifest, uploads the content-addressed files + manifest
 *  ADDITIVELY (no `--delete-unmatched-destination-objects` — this bucket namespace is
 *  shared by every version ever published; deleting would strand clients still on an
 *  older version), then merges/signs/uploads `release.json`.
 *
 *  This is a standalone CLI, not wired into project.config.json / the editor build UI
 *  yet (that's Phase 5) — it takes its target bucket as an explicit argument so it can
 *  be exercised and tested independently of that integration.
 *
 *  Usage:
 *    node engine/scripts/ota-publish.mjs \
 *      --dist games/<id>/dist --bucket gs://modoki-ota/<id> \
 *      --name shell --version v13 --engine-api 1 --key default [--mandatory]
 *
 *  Layout written under the bucket:
 *    release.json                          (signed, no-cache)
 *    bundles/<name>/<version>/manifest.json (no-cache)
 *    bundles/<name>/<version>/files/<hash>  (immutable — content-addressed)
 *
 *  NOTE: files are re-uploaded per version even when a hash is unchanged from the
 *  previous version (a file is stored under `.../<version>/files/<hash>`, not deduped
 *  across versions). Storage cost only — the OTA CLIENT still only downloads a hash it
 *  doesn't already have locally, so player bandwidth is unaffected. A shared
 *  content-addressed store across versions is a possible later optimization; it would
 *  change publish-time storage only, not the manifest/release contract.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifestFiles } from './ota/buildManifest.mjs';
import { createManifest, createRelease, validateManifest, validateRelease } from './ota/schema.mjs';
import { signRelease } from './ota/signing.mjs';
import { buildZipFromDir } from './ota/zip.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const q = (s) => JSON.stringify(s);

function parseArgs(argv) {
  const args = { mandatory: false, key: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mandatory') { args.mandatory = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error(`[ota-publish] ${msg}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = args.dist ? path.resolve(repoRoot, args.dist) : null;
  const bucket = args.bucket?.replace(/\/+$/, '');
  const name = args.name;
  const version = args.version;
  const engineApi = Number(args.engineApi);

  if (!distDir || !existsSync(distDir)) fail(`--dist is required and must exist (got ${args.dist})`);
  if (!bucket || !bucket.startsWith('gs://')) fail(`--bucket must be a gs:// URL (got ${args.bucket})`);
  if (!name) fail('--name is required (the bundle name, e.g. "shell" or a sub-game id)');
  if (!version) fail('--version is required (e.g. "v13")');
  if (!Number.isInteger(engineApi) || engineApi < 1) fail('--engine-api must be a positive integer');

  const keyPath = path.join(repoRoot, 'build', 'ota-keys', `${args.key}.json`);
  if (!existsSync(keyPath)) fail(`Signing key not found: ${path.relative(repoRoot, keyPath)}. Run: node engine/scripts/ota-keygen.mjs ${args.key}`);
  const keypair = JSON.parse(readFileSync(keyPath, 'utf8'));

  console.log(`[ota-publish] Hashing ${path.relative(repoRoot, distDir)}...`);
  const files = await buildManifestFiles(distDir);
  const fileCount = Object.keys(files).length;
  console.log(`[ota-publish] ${fileCount} files hashed.`);

  // Phase 1's native OTA client downloads ONE zip directly (native HTTP, bypassing the
  // JS bridge entirely for the payload bytes) rather than fetching each content-addressed
  // file individually — thousands of small bridge round-trips would be prohibitively slow
  // (see the plan doc). buildZip() output has already been cross-verified against both
  // the system `unzip`/`zipinfo` CLI and a from-scratch Swift reader (OtaZip.swift).
  console.log('[ota-publish] Building bundle zip...');
  const zip = await buildZipFromDir(distDir, Object.keys(files));
  const zipHash = createHash('sha256').update(zip).digest('hex');
  console.log(`[ota-publish] Bundle zip: ${zip.length} bytes, sha256 ${zipHash}.`);

  const manifest = createManifest({ name, version, engineApi, files, bundleZip: { hash: zipHash, size: zip.length } });
  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length) fail(`Built an invalid manifest:\n  ${manifestErrors.join('\n  ')}`);

  // Stage a flat, content-addressed copy: <hash> filename, no relative path —
  // this is what makes `bundles/<name>/<version>/files/` safe to upload with
  // ordinary rsync (two DIFFERENT source files that happen to hash the same
  // collapse onto one object, which is correct: they're byte-identical).
  const stageDir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-'));
  try {
    for (const [relPath, entry] of Object.entries(files)) {
      copyFileSync(path.join(distDir, relPath), path.join(stageDir, entry.hash));
    }

    const bundlePrefix = `${bucket}/bundles/${name}/${version}`;
    console.log(`[ota-publish] Uploading ${fileCount} content-addressed files to ${bundlePrefix}/files/ ...`);
    // Deliberately NO --delete-unmatched-destination-objects: this bucket path
    // accumulates every version ever published; deleting would strand clients
    // still fetching an older manifest's hashes.
    execSync(`gcloud storage rsync --recursive ${q(stageDir)} ${q(`${bundlePrefix}/files`)}`, { stdio: 'inherit' });

    const manifestStageDir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-manifest-'));
    try {
      const manifestPath = path.join(manifestStageDir, 'manifest.json');
      const zipPath = path.join(manifestStageDir, 'bundle.zip');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      writeFileSync(zipPath, zip);
      execSync(`gcloud storage cp ${q(manifestPath)} ${q(`${bundlePrefix}/manifest.json`)}`, { stdio: 'inherit' });
      execSync(`gcloud storage cp ${q(zipPath)} ${q(`${bundlePrefix}/bundle.zip`)}`, { stdio: 'inherit' });
    } finally {
      rmSync(manifestStageDir, { recursive: true, force: true });
    }
    execSync(`gcloud storage objects update ${q(`${bundlePrefix}/manifest.json`)} --cache-control="no-cache, max-age=0"`, { stdio: 'inherit' });
    execSync(`gcloud storage objects update ${q(`${bundlePrefix}/bundle.zip`)} --cache-control="public, max-age=31536000, immutable"`, { stdio: 'inherit' });
    execSync(`gcloud storage objects update ${q(`${bundlePrefix}/files/**`)} --cache-control="public, max-age=31536000, immutable"`, { stdio: 'inherit' });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  // Merge into release.json: fetch current (if any), bump this bundle's
  // version, re-sign, re-upload. Never touches other bundles' entries, so
  // publishing "sling" can't accidentally roll back "shell" or vice versa.
  const releasePath = `${bucket}/release.json`;
  let existingRelease = null;
  try {
    const raw = execSync(`gcloud storage cat ${q(releasePath)}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    existingRelease = JSON.parse(raw);
  } catch {
    console.log('[ota-publish] No existing release.json — creating the first one.');
  }

  const bundles = { ...(existingRelease?.bundles ?? {}), [name]: version };
  // minEngineApi is a compatibility floor, independent of `mandatory` (which is
  // only about apply-timing) — it can only ratchet up, never down, across publishes.
  const minEngineApi = Math.max(existingRelease?.minEngineApi ?? engineApi, engineApi);
  const unsignedRelease = createRelease({ bundles, mandatory: !!args.mandatory, minEngineApi });
  const release = signRelease(unsignedRelease, keypair);
  const releaseErrors = validateRelease(release);
  if (releaseErrors.length) fail(`Built an invalid release:\n  ${releaseErrors.join('\n  ')}`);

  const releaseStageDir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-release-'));
  const tmpReleasePath = path.join(releaseStageDir, 'release.json');
  writeFileSync(tmpReleasePath, JSON.stringify(release, null, 2));
  execSync(`gcloud storage cp ${q(tmpReleasePath)} ${q(releasePath)}`, { stdio: 'inherit' });
  execSync(`gcloud storage objects update ${q(releasePath)} --cache-control="no-cache, max-age=0"`, { stdio: 'inherit' });
  rmSync(releaseStageDir, { recursive: true, force: true });

  console.log(`[ota-publish] Published ${name}@${version} — release.json now points ${name} → ${version}.`);
}

main().catch((err) => fail(err.stack || String(err)));
