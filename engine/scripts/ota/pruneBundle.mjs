/** CDN retention for OTA bundles (#836): delete a bundle's old published versions from the bucket.
 *
 *  Before this, nothing ever deleted a version — every publish added a full copy forever. The owner's
 *  ruling (2026-09-13): **the publish path prunes, keeping the newest N plus whatever `release.json`
 *  points at.** `ota-publish.mjs` calls {@link pruneBundleVersions} after a successful release write;
 *  `ota-prune.mjs` runs the same function by hand, with `--dry-run`.
 *
 *  **Why deleting an old version cannot strand a device** (read from `otaClient.ts`, not assumed): a
 *  device runs from its own staged copy on disk, and the bucket is only ever asked for the TARGET
 *  version's files and zip. The one request that reaches an older version is the delta BASE
 *  `manifest.json` — the device's current `active` version — and its failure falls back to the whole
 *  `bundle.zip` of the target. So a pruned base costs that device a full download, never an update.
 *
 *  What the plan keeps:
 *   - the newest `keep` versions, ordered by when their `manifest.json` was CREATED. The manifest is
 *     uploaded last, so that is when the version was committed; version strings are operator tokens
 *     and have no order.
 *   - the version `release.json` points this bundle at, however old.
 *   - ⚠️ **every version folder with no `manifest.json`.** That is a publish still uploading, or one
 *     that died mid-upload, and nothing here can tell those apart — so it is never deleted, only
 *     reported. Deleting it could remove the files of a publish that is about to commit.
 *   - any manifest whose creation time cannot be read: an age that is not known cannot be "old".
 *
 *   - any version whose manifest is younger than {@link PRUNE_GRACE_MS} — see it for why this, and not
 *     the generation checks, is what makes a concurrent publish safe.
 *
 *  Concurrency: the grace window above; `release.json`'s generation re-read before EACH version's
 *  deletes, re-planning if a publish landed; and a final read of the live pointer that reports a
 *  deleted live version loudly instead of succeeding.
 *
 *  Delete order within a version: `files/`, then `bundle.zip`, then the rest — `manifest.json` last. A
 *  prune that dies partway then leaves a version that still HAS its manifest, which the next prune
 *  sees and finishes; manifest-first would leave a manifest-less folder the rule above never deletes. */
import { isGcloudNoMatchError, isGcloudObjectNotFoundError, gcloudSync } from './gcloud.mjs';
import { OTA_SAFE_TOKEN } from './otaSafeTokens.mjs';

/** A folder name that can be a version at all: a publish token, and not `.`/`..`. Anything else is
 *  ignored rather than deleted — a name is interpolated into a delete GLOB, where `*` would widen it. */
const isVersionName = (s) => OTA_SAFE_TOKEN.test(s) && s !== '.' && s !== '..';

/** Runs `gcloud <args>` with no shell (`gcloudSync`; Windows resolves `gcloud.cmd`). Never throws. */
export function runGcloud(args) {
  try {
    const stdout = gcloudSync(args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e?.stdout?.toString() ?? '', stderr: e?.stderr?.toString() || String(e?.message ?? e) };
  }
}

/** The version names under `<bucket>/bundles/<name>/`, from `gcloud storage ls` of that prefix. Only
 *  direct child FOLDERS with a version-shaped name count; anything else is not a version. Pure. */
export function parseVersionPrefixes(stdout, bundlePrefix) {
  const versions = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(`${bundlePrefix}/`) || !line.endsWith('/')) continue;
    const rest = line.slice(bundlePrefix.length + 1, -1);
    if (isVersionName(rest)) versions.push(rest);
  }
  return versions;
}

/** version → the ms timestamp its `manifest.json` was created, from `gcloud storage ls --json` of
 *  `<bundlePrefix>/*\/manifest.json`. A timestamp that does not parse maps to `null`. Pure. */
export function parseManifestListing(jsonText, bundlePrefix) {
  const created = new Map();
  const entries = JSON.parse(jsonText);
  if (!Array.isArray(entries)) throw new Error('gcloud storage ls --json did not return a list');
  for (const entry of entries) {
    const url = String(entry?.url ?? '').replace(/#\d+$/, '');
    if (!url.startsWith(`${bundlePrefix}/`) || !url.endsWith('/manifest.json')) continue;
    const version = url.slice(bundlePrefix.length + 1, -'/manifest.json'.length);
    if (!isVersionName(version)) continue;
    const ms = Date.parse(entry?.metadata?.timeCreated ?? '');
    created.set(version, Number.isFinite(ms) ? ms : null);
  }
  return created;
}

/** How recent a version's `manifest.json` may be and still be pruned: never, inside this window.
 *
 *  ⚠️ This is what actually makes a concurrent publish safe, and the generation checks below are NOT
 *  enough on their own (close-out review of #836, reproduced against the real function): a publish
 *  uploads its manifest, then spends seconds to minutes in its release write — retrying when it loses
 *  the generation race — and a prune that planned and re-checked before that write LANDS goes on to
 *  delete the very version it points at. Two shapes: a second publish of the same bundle whose release
 *  write retried past this one's, and an identical-content RETRY of an old version (which re-points the
 *  release at it). Every publish path re-uploads its manifest before writing the release, the identical
 *  retry included, so "manifest younger than the window" covers every version some publish is about to
 *  point at ONCE that manifest is up. An hour dwarfs any release-write retry loop and absorbs clock skew
 *  between this machine and GCS's `timeCreated`. A structural safety margin, not a tuning knob — hence a
 *  constant.
 *
 *  ⚠️ **Not closed: a retry of an OLD version still mid-upload** (its `files/` and `bundle.zip` going up
 *  before its manifest is refreshed) can lose them to a prune that planned in that gap — and then point
 *  the release at them. Found by the second close-out review, not reproduced live. It is DETECTED rather
 *  than prevented: `ota-publish.mjs` confirms its own manifest and zip still exist after its release
 *  write and fails loudly if they do not. Preventing it would need a lock both sides honour. */
export const PRUNE_GRACE_MS = 60 * 60 * 1000;

/** Which versions to keep and which to delete. Pure.
 *
 *  - `versions`: every version folder name found.
 *  - `created`: version → manifest creation ms, or `null` when unreadable; a version ABSENT from it has
 *    no `manifest.json`.
 *  - `pointer`: the version `release.json` names for this bundle, or undefined.
 *  - `keep`: how many of the newest to keep (a positive integer).
 *  - `now` / `graceMs`: a manifest created after `now - graceMs` is never deleted ({@link PRUNE_GRACE_MS}).
 *
 *  Returns `{ keep, remove, incomplete, unknownAge, recent }` — `remove` oldest first, the rest sorted. */
export function planPrune({ versions, created, pointer, keep, now, graceMs = PRUNE_GRACE_MS }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`planPrune: keep must be a positive integer (got ${keep})`);
  if (!Number.isFinite(now)) throw new Error(`planPrune: now must be a timestamp (got ${now})`);
  const incomplete = [];
  const unknownAge = [];
  const dated = [];
  for (const version of versions) {
    if (!created.has(version)) incomplete.push(version);
    else if (created.get(version) === null) unknownAge.push(version);
    else dated.push({ version, ms: created.get(version) });
  }
  // Newest first; a tie (same creation instant) breaks on the name so the plan is deterministic.
  dated.sort((a, b) => b.ms - a.ms || (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
  const recent = dated.filter((d) => d.ms > now - graceMs).map((d) => d.version);
  const kept = new Set([...dated.slice(0, keep).map((d) => d.version), ...incomplete, ...unknownAge, ...recent]);
  if (pointer !== undefined) kept.add(pointer);
  const remove = dated.filter((d) => !kept.has(d.version)).reverse().map((d) => d.version);
  return { keep: [...kept].sort(), remove, incomplete: incomplete.sort(), unknownAge: unknownAge.sort(), recent: recent.sort() };
}

const missing = (stderr) => isGcloudNoMatchError(stderr) || isGcloudObjectNotFoundError(stderr);

/** Plans and (unless `dryRun`) performs the prune of one bundle's versions.
 *
 *  Returns `{ ok: true, plan, removed }` or `{ ok: false, error, plan?, removed }`. `removed` lists what
 *  was actually deleted before any failure. Every read failure means NOTHING more is deleted: a listing
 *  or a `release.json` that cannot be read is "could not tell", never "empty".
 *
 *  Three layers against a concurrent publish, and the first is the one that holds: the grace window in
 *  {@link planPrune}; `release.json`'s generation re-read before EACH version's deletes, re-planning when
 *  it moved; and a last read of the live pointer that turns "we deleted the live version" — which the
 *  first two should make impossible — into a loud failure instead of a silent one. */
export function pruneBundleVersions({ bucket, name, keep, dryRun = false, gcloud = runGcloud, maxAttempts = 5, now = Date.now(), graceMs = PRUNE_GRACE_MS }) {
  const bundlePrefix = `${bucket}/bundles/${name}`;
  const releasePath = `${bucket}/release.json`;
  const removed = [];

  const releaseGeneration = () => {
    const r = gcloud(['storage', 'objects', 'describe', releasePath, '--format=value(generation)']);
    const generation = r.stdout.trim();
    return r.ok && /^\d+$/.test(generation) ? generation : null;
  };
  /** The live pointer for this bundle, or `{ error }`. */
  const readPointer = () => {
    const cat = gcloud(['storage', 'cat', releasePath]);
    if (!cat.ok) return { error: `could not read ${releasePath}: ${cat.stderr.trim()}` };
    try {
      const bundles = JSON.parse(cat.stdout)?.bundles;
      if (bundles === null || typeof bundles !== 'object' || Array.isArray(bundles)) throw new Error('no object "bundles" field');
      const pointer = Object.hasOwn(bundles, name) ? bundles[name] : undefined;
      if (pointer !== undefined && typeof pointer !== 'string') throw new Error(`bundles["${name}"] is not a string`);
      return { pointer };
    } catch (e) {
      return { error: `${releasePath} is malformed (${e.message})` };
    }
  };
  const stop = (error, plan) => ({ ok: false, error: `${error} — ${removed.length ? `stopped after deleting ${removed.join(', ')}` : 'nothing pruned'}`, ...(plan ? { plan } : {}), removed });

  let lastPlan = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = releaseGeneration();
    if (before === null) return stop(`could not read ${releasePath}'s generation, so the live version is unknown`, lastPlan);
    const live = readPointer();
    if (live.error) return stop(live.error, lastPlan);

    const folders = gcloud(['storage', 'ls', `${bundlePrefix}/`]);
    if (!folders.ok && !isGcloudNoMatchError(folders.stderr)) return stop(`could not list ${bundlePrefix}/: ${folders.stderr.trim()}`, lastPlan);
    const versions = (folders.ok ? parseVersionPrefixes(folders.stdout, bundlePrefix) : []).filter((v) => !removed.includes(v));
    const manifests = gcloud(['storage', 'ls', '--json', `${bundlePrefix}/*/manifest.json`]);
    if (!manifests.ok && !isGcloudNoMatchError(manifests.stderr)) return stop(`could not list ${bundlePrefix}'s manifests: ${manifests.stderr.trim()}`, lastPlan);
    let created;
    try {
      created = manifests.ok ? parseManifestListing(manifests.stdout, bundlePrefix) : new Map();
    } catch (e) {
      return stop(`could not parse ${bundlePrefix}'s manifest listing (${e.message})`, lastPlan);
    }

    const plan = planPrune({ versions, created, pointer: live.pointer, keep, now, graceMs });
    lastPlan = plan;
    if (dryRun) {
      const after = releaseGeneration();
      if (after === before) return { ok: true, plan, removed };
      if (after === null) return stop(`could not re-read ${releasePath}'s generation`, plan);
      continue;
    }

    let moved = false;
    for (const version of plan.remove) {
      const now2 = releaseGeneration();
      if (now2 === null) return stop(`could not re-read ${releasePath}'s generation`, plan);
      if (now2 !== before) { moved = true; break; } // a publish landed: re-plan against it
      const prefix = `${bundlePrefix}/${version}`;
      for (const args of [
        // Explicit `/**` globs, never `rm --recursive <prefix>`: the bare prefix `.../v1` is one character
        // away from `.../v10`, and a delete is the one place that ambiguity must not be left to gcloud.
        ['storage', 'rm', `${prefix}/files/**`],
        ['storage', 'rm', `${prefix}/bundle.zip`],
        ['storage', 'rm', `${prefix}/**`],
      ]) {
        const r = gcloud(args);
        if (!r.ok && !missing(r.stderr)) return stop(`failed deleting ${name}@${version} (${args.join(' ')}): ${r.stderr.trim()}`, plan);
      }
      removed.push(version);
    }
    if (moved) continue;

    if (removed.length === 0) return { ok: true, plan, removed }; // nothing deleted: nothing to confirm
    const final = readPointer();
    if (final.error) return stop(`could not re-read ${releasePath} to confirm the live version survived: ${final.error}`, plan);
    if (final.pointer !== undefined && removed.includes(final.pointer)) {
      // Deleted by NAME is not deleted NOW: a concurrent identical publish may have re-created it since.
      // Ask the bucket, and only a missing manifest is the emergency.
      const still = gcloud(['storage', 'objects', 'describe', `${bundlePrefix}/${final.pointer}/manifest.json`, '--format=value(generation)']);
      if (!(still.ok && /^\d+$/.test(still.stdout.trim()))) {
        return stop(`${releasePath} now points ${name} at ${final.pointer}, whose files this prune DELETED — every device will fail to fetch it until a publish; republish ${name} now`, plan);
      }
    }
    return { ok: true, plan, removed };
  }
  return stop(`${releasePath} kept changing across ${maxAttempts} plans — another publish is running`, lastPlan);
}
