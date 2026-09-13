#!/usr/bin/env node
/** Prunes one OTA bundle's old versions from its bucket, by hand (#836).
 *
 *  `ota-publish.mjs` already does this after every successful publish; this runs the SAME
 *  `pruneBundleVersions` (ota/pruneBundle.mjs) without publishing anything — to see what a publish
 *  would delete (`--dry-run`), or to catch up a bucket that grew before pruning existed. What is kept,
 *  and why deleting an old version cannot strand a device, is that module's header.
 *
 *  Usage:
 *    node engine/scripts/ota-prune.mjs --bucket gs://modoki-ota/<id> --name shell --project games/<id> [--dry-run]
 *
 *  `--project` is the SHELL project whose bucket this is: its `ota.retainVersions` is how many to keep,
 *  and `--name` must be its own `ota.bundleName` or a sub-game it lists — the same names a publish into
 *  that bucket may use. */
import path from 'node:path';
import { OTA_SAFE_BUCKET, OTA_SAFE_TOKEN } from './ota/otaSafeTokens.mjs';
import { OTA_DEFAULT_BUNDLE_NAME, otaRetainVersions } from './ota/publishGuards.mjs';
import { otaPublishTarget, readRawOtaBlock } from './ota/publishPreflight.mjs';
import { pruneBundleVersions } from './ota/pruneBundle.mjs';

function fail(msg) {
  console.error(`[ota-prune] ${msg}`);
  process.exit(1);
}

const args = { dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') { args.dryRun = true; continue; }
  if (!a.startsWith('--')) fail(`unexpected argument ${JSON.stringify(a)}`);
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) fail(`${a} needs a value`);
  args[a.slice(2)] = value;
  i++;
}

const bucket = args.bucket?.replace(/\/+$/, '');
const { name } = args;
if (typeof bucket !== 'string' || !OTA_SAFE_BUCKET.test(bucket)) fail(`--bucket must be a gs:// URL matching ${OTA_SAFE_BUCKET} (got ${args.bucket})`);
if (typeof name !== 'string' || !OTA_SAFE_TOKEN.test(name)) fail(`--name must match ${OTA_SAFE_TOKEN} (got ${JSON.stringify(name)})`);
if (!args.project) fail('--project is required (the shell project whose bucket this is — its ota.retainVersions decides how many versions stay).');

const projectDir = path.resolve(args.project);
const raw = readRawOtaBlock(projectDir);
if (!raw.ok) fail(`${raw.file} ${raw.reason === 'missing' ? 'not found' : `could not be parsed: ${raw.error}`}`);
const ota = raw.ota;
if (ota === null || typeof ota !== 'object' || Array.isArray(ota)) fail(`${raw.file} has no object-typed "ota" field.`);
const keep = otaRetainVersions(ota);
if (keep === null) fail(`${raw.file}'s ota.retainVersions is not a positive integer (got ${JSON.stringify(ota.retainVersions)}).`);
const bundleName = ota.bundleName === undefined ? OTA_DEFAULT_BUNDLE_NAME : ota.bundleName;
const subgames = Array.isArray(ota.subgames) ? ota.subgames : [];
if (!otaPublishTarget(name, { bundleName, subgames })) {
  fail(`--name "${name}" is neither ${raw.file}'s ota.bundleName ("${bundleName}") nor a sub-game it lists (${JSON.stringify(subgames)}), so it is not a bundle this project publishes.`);
}

console.log(`[ota-prune] ${args.dryRun ? 'Planning' : 'Pruning'} ${bucket}/bundles/${name}: keeping the newest ${keep} plus the live version.`);
const result = pruneBundleVersions({ bucket, name, keep, dryRun: args.dryRun });
if (result.plan) {
  const { plan } = result;
  console.log(`[ota-prune] keep   (${plan.keep.length}): ${plan.keep.join(', ') || '—'}`);
  console.log(`[ota-prune] delete (${plan.remove.length}): ${plan.remove.join(', ') || '—'}`);
  if (plan.incomplete.length) console.log(`[ota-prune] left alone, no manifest.json (still uploading, or a dead upload): ${plan.incomplete.join(', ')}`);
  if (plan.unknownAge.length) console.log(`[ota-prune] left alone, manifest age unreadable: ${plan.unknownAge.join(', ')}`);
}
if (!result.ok) fail(`${result.error}${result.removed.length ? ` (deleted before the failure: ${result.removed.join(', ')})` : ''}`);
console.log(args.dryRun
  ? '[ota-prune] Dry run — nothing deleted.'
  : `[ota-prune] Deleted ${result.removed.length} version(s).`);
