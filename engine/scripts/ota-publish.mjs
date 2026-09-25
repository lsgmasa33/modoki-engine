#!/usr/bin/env node
/** Publishes an OTA bundle update (docs/ota-updates.md).
 *
 *  Takes an already-built `dist/` directory (from `node engine/scripts/build-web.mjs`),
 *  hashes it into a bundle manifest, uploads the content-addressed files + manifest
 *  ADDITIVELY (no `--delete-unmatched-destination-objects` — a sync would wipe every other
 *  version and bundle in the namespace), then merges/signs/uploads `release.json`, and only
 *  then prunes this bundle's old versions down to `ota.retainVersions` plus the live one (#836,
 *  ota/pruneBundle.mjs — a deliberate, bounded delete, never a sync).
 *
 *  It takes its bucket/dist/version as explicit arguments so it can be exercised and tested
 *  independently of the editor build UI. It DOES read the target project's `project.config.json`
 *  (via `--project`), but only for its publish guards — the signing key, the dist kind, and
 *  (#837) a sub-game's engine API against the shell's `ota.engineApi`, below — never for the
 *  bucket or version themselves. A shell dist's engine API is still an explicit argument; a
 *  sub-game dist's comes from its own `subgame.json`.
 *
 *  #582: these two guards used to exist ONLY in the editor's `/api/ota/publish` route, but
 *  that route's own refusal message sends a human here BY HAND for a sub-game publish
 *  (build-subgame.mjs + a manual `ota-publish.mjs` invocation) — so the by-hand path had
 *  NEITHER guard. A decision this load-bearing must not be enforced by only one of two entry
 *  points to the same operation.
 *
 *  Usage:
 *    node engine/scripts/ota-publish.mjs \
 *      --dist games/<id>/dist --bucket gs://modoki-ota/<id> \
 *      --name shell --version v13 --engine-api 1 --key default --project games/<id> \
 *      [--mandatory | --no-mandatory] [--allow-unclean-build]
 *
 *  The dist must carry the `modoki-build.json` its build wrote (#906, ota/buildStamp.mjs) naming a
 *  clean commit; that stamp goes into the signed manifest as `build`. A dirty, unknown or unstamped
 *  build is refused. `--allow-unclean-build` publishes it anyway with `build.forced: true` — a CLI-only
 *  override: the editor route and `modoki_ota_publish` deliberately cannot pass it (owner, 2026-09-13).
 *
 *  `--engine-api` is required for a SHELL dist. A SUB-GAME dist (one carrying `subgame.json`) takes
 *  its engine API from that file instead, so omit the flag there; a flag that disagrees with it, or
 *  a stamped value that differs from the shell project's `ota.engineApi`, is refused (#837).
 *
 *  `mandatory` is STICKY across publishes: `--mandatory` sets it true, `--no-mandatory`
 *  clears it, and passing NEITHER flag inherits the existing release's `mandatory` value
 *  (false if there is no existing release) rather than silently clearing a live mandatory
 *  release on the next routine publish.
 *
 *  Layout written under the bucket:
 *    release.json                          (signed, no-cache)
 *    bundles/<name>/<version>/manifest.json (no-cache)
 *    bundles/<name>/<version>/files/<hash>  (immutable — content-addressed)
 *    bundles/<name>/<version>/bundle.zip    (immutable)
 *
 *  NOTE: files are re-uploaded per version even when a hash is unchanged from the
 *  previous version (a file is stored under `.../<version>/files/<hash>`, not deduped
 *  across versions). Storage cost only — the OTA CLIENT still only downloads a hash it
 *  doesn't already have locally, so player bandwidth is unaffected. A shared
 *  content-addressed store across versions is a possible later optimization; it would
 *  change publish-time storage only, not the manifest/release contract.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifestFiles } from './ota/buildManifest.mjs';
import { isGcloudObjectNotFoundError, gcloudSync } from './ota/gcloud.mjs';
import { createManifest, createRelease, manifestHashPayload, validateManifest, validateRelease } from './ota/schema.mjs';
import { OTA_DEFAULT_BUNDLE_NAME, OTA_DEFAULT_ENGINE_API, otaBundleDistKindRefusal, otaSubgameEngineApi } from './ota/publishGuards.mjs';
import { otaPublishPreflight, readRawOtaBlock } from './ota/publishPreflight.mjs';
import { OTA_SAFE_TOKEN, OTA_SAFE_BUCKET } from './ota/otaSafeTokens.mjs';
import { signRelease } from './ota/signing.mjs';
import { buildZipFromDir } from './ota/zip.mjs';
import { BUILD_STAMP_FILENAME, otaBuildProvenance } from './ota/buildStamp.mjs';
import { pruneBundleVersions } from './ota/pruneBundle.mjs';
import { acquireBuildClaim } from './buildClaimsStore.mjs';
import { samePath } from './pathIdentity.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  // `mandatory` starts `undefined` (not `false`) so the release-merge loop can tell
  // "neither flag passed" (inherit the existing release's value) apart from an explicit
  // `--no-mandatory` (clear it).
  const args = { mandatory: undefined, key: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mandatory') { args.mandatory = true; continue; }
    if (a === '--no-mandatory') { args.mandatory = false; continue; }
    // A bare switch like the two above: the generic `--key value` parse below would swallow the
    // NEXT argument as its value.
    if (a === '--allow-unclean-build') { args.allowUncleanBuild = true; continue; }
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
  // `--repo-root` lets a caller that already computed its own repo root (the
  // /api/ota/publish route uses `editorRoot || projectRoot` for its OWN key-existence
  // precheck) pass that SAME value through, instead of this script independently
  // re-deriving one from `import.meta.url`. A review (2026-07-26) flagged the two
  // resolutions as duplicated with nothing enforcing they agree — for a self-contained
  // game opened standalone (no `engine/` alongside it), or any future path change on
  // either side, they could silently desync and produce a misleading "key not found" (or
  // a false "found") error. Defaults to the old behavior when omitted, e.g. for a human
  // running this CLI directly from the repo root.
  const repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : defaultRepoRoot;
  const distDir = args.dist ? path.resolve(repoRoot, args.dist) : null;
  const bucket = args.bucket?.replace(/\/+$/, '');
  const name = args.name;
  const version = args.version;
  // `undefined` when omitted: a sub-game dist takes its engine API from its own subgame.json (#837).
  const engineApiFlag = args.engineApi === undefined ? undefined : Number(args.engineApi);
  const projectDir = args.project ? path.resolve(repoRoot, args.project) : null;

  if (!distDir || !existsSync(distDir)) fail(`--dist is required and must exist (got ${args.dist})`);
  if (engineApiFlag !== undefined && (!Number.isInteger(engineApiFlag) || engineApiFlag < 1)) fail('--engine-api must be a positive integer');
  if (!projectDir) {
    fail('--project is required (the project dir whose project.config.json this release is published for, e.g. games/ota-test) — its ota.publicKey is the key the SHIPPED APP verifies against, and its ota.bundleName decides whether this dist may be published under --name.');
  }

  // Read the project's config directly (not via `loadProjectConfig`, which is TS and defaults
  // missing fields — this script must NOT degrade an unreadable/malformed config to
  // "unguarded"; it must abort loudly instead, the same fail-closed shape the version-collision
  // guard below already uses for "could not check" vs "definitely fine").
  const rawConfig = readRawOtaBlock(projectDir);
  const projectConfigPath = rawConfig.file;
  if (!rawConfig.ok && rawConfig.reason === 'missing') fail(`--project's project.config.json not found: ${projectConfigPath}`);
  if (!rawConfig.ok) fail(`--project's project.config.json (${projectConfigPath}) could not be parsed as JSON: ${rawConfig.error}`);
  const ota = rawConfig.ota;

  // THE publish-request check — the same `otaPublishPreflight` the editor's `/api/ota/publish` runs
  // before it builds (#827): enabled, the four tainted inputs, the project's bundle identity, the
  // publish target (the shell's own name or a LISTED sub-game — #837, which this script lacked until
  // #827), and the signing key. BEFORE any hashing/zipping/upload, so a refusal provably reaches
  // nothing in the bucket. Only the wording is this script's; every refusal is keyed below, and
  // `otaPublishPreflight.test.ts` holds this map to the full list.
  const preflight = otaPublishPreflight({ ota, name, version, keyName: args.key, bucket, repoRoot });
  if (!preflight.ok) {
    const r = preflight;
    fail({
      'no-ota-block': `${projectConfigPath} has no object-typed "ota" field — cannot verify this publish's signing key or bundle identity against it.`,
      'not-enabled': `${projectConfigPath}'s ota.enabled is not true — this project has not opted into OTA updates. Enable OTA in Project Settings first, then publish.`,
      'bad-version': `--version must match ${OTA_SAFE_TOKEN} (got ${JSON.stringify(version)})`,
      'bad-name': `--name must match ${OTA_SAFE_TOKEN} (got ${JSON.stringify(name)}) — in particular, a "/" is rejected: it would silently write bucket objects under a NESTED path while release.json still records --name as a flat string, so the version-collision guard below (which reads back that same flat path) would never see what actually landed. Use a plain bundle-name token, not a path.`,
      'bad-key-name': `--key must match ${OTA_SAFE_TOKEN} (got ${JSON.stringify(args.key)}) — it names a keypair in build/ota-keys/, not a path.`,
      'bad-bucket': `--bucket must be a gs:// URL matching ${OTA_SAFE_BUCKET} (got ${args.bucket})`,
      'bad-project-bundle-name': `${projectConfigPath}'s ota.bundleName is present but not a non-empty string (got ${JSON.stringify(ota?.bundleName)}) — it decides whether this dist may be published under --name "${name}", so this publish cannot be checked. Set it in project.config.json, or remove the key to use the default ("${OTA_DEFAULT_BUNDLE_NAME}").`,
      'bad-project-subgames': `${projectConfigPath}'s ota.subgames is present but not a list of project ids (got ${JSON.stringify(ota?.subgames)}) — it decides which sub-game names may be published into this shell, so this publish cannot be checked.`,
      'bad-project-retain-versions': `${projectConfigPath}'s ota.retainVersions is present but not a positive integer (got ${JSON.stringify(ota?.retainVersions)}) — it decides how many versions of "${name}" this publish keeps in the bucket, so it cannot prune. Set it in project.config.json, or remove the key to keep the default.`,
      'ambiguous-bundle': `--name "${name}" is BOTH ${projectConfigPath}'s own ota.bundleName and a sub-game listed in its ota.subgames — it cannot say whether it publishes the shell or that sub-game. Rename one.`,
      'unknown-bundle': `--name "${name}" is neither ${projectConfigPath}'s own ota.bundleName ("${r.bundleName}") nor a sub-game listed in its ota.subgames (${JSON.stringify(r.subgames)}). A sub-game is published into this shell only once the shell lists it (Project Settings → OTA → Sub-games) — the same rule the editor's Publish OTA Update… enforces (#837, #827). Pass --name ${JSON.stringify(String(r.bundleName))} to publish this project as itself.`,
      'key-missing': `Signing key not found: ${path.relative(repoRoot, String(r.keyPath))}. Run: node engine/scripts/ota-keygen.mjs ${args.key}`,
      'key-unparseable': `Signing key "${args.key}" (${r.keyPath}) could not be parsed as JSON — regenerate it: node engine/scripts/ota-keygen.mjs ${args.key}`,
      'no-key-public-half': `Signing key "${args.key}" (${r.keyPath}) has no publicKey field — regenerate it: node engine/scripts/ota-keygen.mjs ${args.key}`,
      'project-public-key-empty': `${projectConfigPath}'s ota.publicKey is EMPTY, so no installed app can verify a release. Set it to the signing key's public half ("${r.keyPublicKey}") in project.config.json, rebuild + ship the native app so the new key is baked in, and publish then.`,
      mismatch: `Signing key "${args.key}" does NOT match ${projectConfigPath}'s ota.publicKey — every installed app would reject the release as signature-invalid, while this publish would report success. Key "${args.key}" public half: "${r.keyPublicKey}". project.config.json ota.publicKey: "${ota?.publicKey}". Publish with the key that matches (--key <name>), or — only if you intend to ROTATE the key — set ota.publicKey to the new value and ship a native build carrying it BEFORE publishing, or installed apps will be stranded.`,
    }[r.refusal] ?? `refused: ${r.refusal}`);
  }
  const { target, keypair, bundleName: projectBundleName } = preflight;

  // The dist's KIND must match the target — only this script receives a pre-built dist, so this half
  // is not in the shared preflight (the route builds the kind its target names).
  const distIsSubgameModule = existsSync(path.join(distDir, 'subgame.json'));
  const kindRefusal = otaBundleDistKindRefusal({ targetKind: target.kind, distIsSubgameModule });
  if (kindRefusal === 'subgame-name-with-shell-dist') {
    fail(`--name "${name}" is a sub-game listed in ${projectConfigPath}'s ota.subgames, but ${path.relative(repoRoot, distDir)} is a plain shell dist/ (no subgame.json) — publishing it would ship this project's own shell content under "${name}"'s identity. Build a real sub-game module dist (build-subgame.mjs) if you meant to publish "${name}" as a sub-game, or pass --name ${JSON.stringify(projectBundleName)} to publish this project as itself.`);
  }
  if (kindRefusal === 'shell-name-with-subgame-dist') {
    fail(`--name "${name}" matches ${projectConfigPath}'s own ota.bundleName, but ${path.relative(repoRoot, distDir)} is a sub-game module dist (subgame.json present) — publishing it under "${name}" would replace this project's shell bundle with a module the OTA client cannot boot standalone. Publish it under its own sub-game --name instead.`);
  }
  // Engine API (#837). A SHELL dist states it with --engine-api, which stays required. A SUB-GAME
  // dist already carries the value its build stamped into subgame.json, and that is exactly what a
  // device compares against its own ENGINE_API_VERSION, for EXACT equality (subgameLoader.ts). So
  // it is read from the dist, a flag may only agree with it, and it must equal the shell project's
  // own ota.engineApi. Before this, a disagreeing --engine-api published a manifest saying one
  // number over a module saying another: every device refused it while this script reported
  // success. Like the identity guards above, it runs before the claim and before any upload.
  let engineApi;
  if (!distIsSubgameModule) {
    if (engineApiFlag === undefined) fail('--engine-api is required for a shell dist (a sub-game dist takes its engine API from its own subgame.json).');
    engineApi = engineApiFlag;
  } else {
    const subgameJsonPath = path.join(distDir, 'subgame.json');
    let subgameMeta;
    try {
      subgameMeta = JSON.parse(readFileSync(subgameJsonPath, 'utf8'));
    } catch (e) {
      fail(`${subgameJsonPath} could not be parsed as JSON (${e.message}) — cannot tell which engine API this sub-game was built against.`);
    }
    const shellEngineApi = ota.engineApi === undefined ? OTA_DEFAULT_ENGINE_API : ota.engineApi;
    const stamped = subgameMeta?.engineApi;
    const resolved = otaSubgameEngineApi({ stamped, requested: engineApiFlag, shellEngineApi });
    if (resolved.refusal) {
      fail({
        'stamped-invalid': `${subgameJsonPath} has no positive-integer engineApi (got ${JSON.stringify(stamped)}) — rebuild the sub-game with build-subgame.mjs.`,
        'flag-mismatch': `--engine-api ${engineApiFlag} disagrees with ${subgameJsonPath}, which was built against engine API ${stamped}. The manifest would contradict its own module and every device would refuse it. Omit --engine-api for a sub-game dist.`,
        'shell-mismatch': `Sub-game "${name}" was built against engine API ${stamped} (${subgameJsonPath}), but ${projectConfigPath}'s ota.engineApi is ${JSON.stringify(shellEngineApi)}. A device loads a sub-game only when its engine API EXACTLY equals the running shell's, so every device would refuse this bundle. Rebuild the sub-game against this shell's engine API, or publish it into a shell that runs ${stamped}.`,
      }[resolved.refusal]);
    }
    engineApi = resolved.engineApi;
    console.log(`[ota-publish] Sub-game engine API ${engineApi}, read from ${path.relative(repoRoot, subgameJsonPath)}; matches the shell's ota.engineApi.`);
  }

  // Cross-process build claim (#650) — closed here, right where the file's own comment above
  // already draws the line for the publish-identity guards: BEFORE any hashing/zipping/upload
  // work, so a refusal provably reaches nothing in the bucket. Everything above this point is
  // pure argument/config validation (no mutation, no read of `distDir`); this is the first place
  // the script actually touches the contested resource — reading `distDir` to hash it — so it's
  // also the earliest point a claim is worth taking. `buildLock.ts`'s in-process slot cannot see
  // this script (a separate process), so without this a hand-run publish can read `distDir` mid-
  // write by a concurrent CLI build and upload a torn bundle to every installed device.
  // REFUSES AND EXITS rather than waiting: a scripted publish must not hang on an interactive
  // editor, matching what the editor's own `/api/ota/publish` route already does.
  const buildClaim = acquireBuildClaim(projectDir, `OTA publish (CLI): ${name}@${version}`, { kind: 'cli' });
  if (!buildClaim.ok) fail(buildClaim.message);
  // #837 close-out: a SUB-GAME dist belongs to a DIFFERENT project than --project (the shell), and
  // build-subgame.mjs claims THAT project while it writes the dist. Claiming only the shell left the
  // dist unguarded for the whole hash-and-upload below, so a build of the same sub-game started
  // meanwhile would empty the folder mid-read and upload a torn module. Claim the dist's own project
  // too. A build already running there makes this publish refuse, loudly, instead. Skipped when the
  // dist sits inside --project itself: a second claim on one root from one process is refused.
  let distClaim = null;
  const distProjectDir = path.dirname(distDir);
  if (distIsSubgameModule && !samePath(distProjectDir, projectDir)) {
    const claimed = acquireBuildClaim(distProjectDir, `OTA publish (CLI): ${name}@${version} (sub-game dist)`, { kind: 'cli' });
    if (!claimed.ok) {
      buildClaim.release();
      fail(claimed.message);
    }
    distClaim = claimed;
  }

  try {
    // Build provenance (#906): which tree built this dist, read from the stamp the BUILD wrote into it
    // (ota/buildStamp.mjs) — never from this script's own checkout, which may not be the tree that
    // built it at all. Read under the claim, like the hashing below, so a concurrent rebuild cannot
    // swap the stamp out from under the bytes it describes. Before any upload, so a refusal reaches
    // nothing in the bucket.
    const stampPath = path.join(distDir, BUILD_STAMP_FILENAME);
    let stampText = null;
    try {
      stampText = readFileSync(stampPath, 'utf8');
    } catch (e) {
      // Only ABSENT is "no stamp"; an unreadable file is not a missing one (#1120's lesson).
      if (e?.code !== 'ENOENT') fail(`Could not read ${stampPath}: ${e.message}`);
    }
    const provenance = otaBuildProvenance({ stampText, allowUnclean: args.allowUncleanBuild === true });
    if (provenance.refusal) {
      const rel = path.relative(repoRoot, distDir);
      // Functions, not strings: the `dirty` wording parses the stamp, which only that refusal guarantees.
      const why = {
        'no-stamp': () => `${rel} has no ${BUILD_STAMP_FILENAME}, so nothing records which source tree built it. Rebuild it (build-web.mjs --target native, or build-subgame.mjs) — a build stamps its own dist.`,
        'bad-stamp': () => `${stampPath} is not a valid build stamp ({ commit, dirty }). Rebuild the dist.`,
        'unknown-tree': () => `${rel} was built where git could not report the tree (not a repository, or git unavailable), so this publish cannot say which source it ships.`,
        dirty: () => `${rel} was built from a tree with uncommitted changes (at commit ${JSON.parse(stampText).commit}), so no commit reproduces what this publish would ship. Commit, rebuild, and publish that.`,
      }[provenance.refusal];
      fail(`${why ? why() : `refused: ${provenance.refusal}.`} To publish it anyway, run this script by hand with --allow-unclean-build: the manifest then records forced: true.`);
    }
    const { build } = provenance;
    if (build.forced) {
      console.warn(`[ota-publish] WARNING: publishing an unclean build (--allow-unclean-build): commit ${build.commit ?? 'unknown'}, dirty ${build.dirty ?? 'unknown'}. The manifest records forced: true.`);
    } else {
      console.log(`[ota-publish] Built from commit ${build.commit} (clean).`);
    }

    console.log(`[ota-publish] Hashing ${path.relative(repoRoot, distDir)}...`);
    const files = await buildManifestFiles(distDir);
    const fileCount = Object.keys(files).length;
    console.log(`[ota-publish] ${fileCount} files hashed.`);

    // Phase 1's native OTA client downloads ONE zip directly (native HTTP, bypassing the
    // JS bridge entirely for the payload bytes) rather than fetching each content-addressed
    // file individually — thousands of small bridge round-trips would be prohibitively slow
    // (see docs/ota-updates.md). buildZip() output has already been cross-verified against both
    // the system `unzip`/`zipinfo` CLI and a from-scratch Swift reader (OtaZip.swift).
    console.log('[ota-publish] Building bundle zip...');
    const zip = await buildZipFromDir(distDir, Object.keys(files));
    const zipHash = createHash('sha256').update(zip).digest('hex');
    console.log(`[ota-publish] Bundle zip: ${zip.length} bytes, sha256 ${zipHash}.`);

    const manifest = createManifest({ name, version, engineApi, files, bundleZip: { hash: zipHash, size: zip.length }, build });
    const manifestErrors = validateManifest(manifest);
    if (manifestErrors.length) fail(`Built an invalid manifest:\n  ${manifestErrors.join('\n  ')}`);

    // Hash of the manifest's canonical serialization, chained into release.json's signed
    // `manifests[name]` entry below so the signed release commits to this bundle's CONTENTS,
    // not just its version pointer.
    const manifestHash = createHash('sha256').update(manifestHashPayload(manifest), 'utf8').digest('hex');
    console.log(`[ota-publish] Bundle manifest: sha256 ${manifestHash}.`);

    // Refuse a version-string collision that would change what an already-published version
    // MEANS. This script is the SINGLE SOURCE OF TRUTH for that decision, reached by every
    // publishing surface (the editor's `/api/ota/publish` route, the MCP `modoki_ota_publish`
    // tool, direct CLI use) — the editor route deliberately carries no collision guard of its
    // own any more (#577: a duplicate existence-based guard there ran first and refused the
    // exact identical-contents retry this guard exists to allow). release.json only tracks the
    // CURRENT live version, not history, so the versioned manifest object itself is the thing
    // to check.
    //
    // Checked HERE, after `manifestHash` is computed (not before, as an earlier version of
    // this guard did) — that ordering is load-bearing. A version's manifest.json is now
    // uploaded LAST of everything for that version (see the upload block below), so "the
    // versioned manifest.json exists" means "this version's contents were fully committed",
    // and comparing hashes tells apart the two cases that "does a manifest exist" alone
    // cannot:
    //   - IDENTICAL contents → this is a RETRY of a publish that got this far before
    //     (auth expiry, an exhausted precondition retry budget, a killed process, ... in the
    //     release.json loop below, which runs AFTER this point). The original guard treated
    //     any existing manifest as fatal and refused to retry the exact failure it was
    //     written to protect against — repro confirmed a retry succeeded before this guard
    //     existed and failed with "Version collision" after. ALLOW an identical retry.
    //   - DIFFERENT contents → a genuine collision: republishing would change what this
    //     version string means to every client that already fetched it. Refuse, as before.
    console.log('[ota-publish] Checking for a version collision...');
    const versionedManifestPath = `${bucket}/bundles/${name}/${version}/manifest.json`;
    let existingManifestRaw = null;
    try {
      existingManifestRaw = gcloudSync(['storage', 'cat', versionedManifestPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    } catch (e) {
      // A missing object is the ONLY stderr shape that means "safe to proceed" — anything
      // else (auth expired, network blip, wrong bucket permissions) must NOT be silently
      // treated as "no collision": that would let a publish proceed past the one guard that
      // stops a version from being silently republished with different bytes. This is the
      // null-conflates-absent-with-unknown trap: "could not check" and "definitely doesn't
      // exist" must fail differently, or the guard fails open on exactly the errors (auth,
      // network, permissions) it most needs to catch.
      const stderr = e?.stderr?.toString() ?? '';
      if (!isGcloudObjectNotFoundError(stderr)) {
        fail(`Could not check for a version collision: ${stderr || e.message}`);
      }
      // else: genuinely doesn't exist yet — no collision, proceed to publish normally.
    }
    if (existingManifestRaw !== null) {
      let existingManifestHash;
      try {
        const existingManifest = JSON.parse(existingManifestRaw);
        existingManifestHash = createHash('sha256').update(manifestHashPayload(existingManifest), 'utf8').digest('hex');
      } catch (e) {
        // An existing object that can't even be parsed is "unknown", not "no collision" —
        // same fail-closed reasoning as the fetch failure above.
        fail(`Could not check for a version collision: existing manifest.json at ${versionedManifestPath} could not be parsed: ${e.message}`);
      }
      if (existingManifestHash === manifestHash) {
        console.log(`[ota-publish] "${name}@${version}" already published with identical contents — resuming.`);
      } else {
        const m = version.match(/^v(\d+)$/);
        const hint = m ? ` Try v${Number(m[1]) + 1}.` : '';
        fail(`Version collision: "${name}@${version}" is already published under ${bucket} with DIFFERENT contents than this publish would produce. Publishing again would change what this version string means to every client that already fetched it.${hint}`);
      }
    }

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
      // Deliberately NO --delete-unmatched-destination-objects: this is the new version's own
      // prefix, and old versions are removed only by the bounded prune after release.json (#836).
      gcloudSync(['storage', 'rsync', '--recursive', stageDir, `${bundlePrefix}/files`], { stdio: 'inherit' });
      gcloudSync(['storage', 'objects', 'update', `${bundlePrefix}/files/**`, '--cache-control=public, max-age=31536000, immutable'], { stdio: 'inherit' });

      const manifestStageDir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-manifest-'));
      try {
        const manifestPath = path.join(manifestStageDir, 'manifest.json');
        const zipPath = path.join(manifestStageDir, 'bundle.zip');
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        writeFileSync(zipPath, zip);
        // Upload order is LOAD-BEARING for the version-collision guard above: that guard
        // treats "manifest.json exists at this version's path" as "this version's contents
        // were fully committed" — true only if manifest.json is the LAST object written for
        // this version. `bundle.zip` before `manifest.json` (files/ above already went
        // first); `release.json` stays last of ALL, further below — that ordering is
        // separately load-bearing and untouched by this reordering.
        gcloudSync(['storage', 'cp', zipPath, `${bundlePrefix}/bundle.zip`], { stdio: 'inherit' });
        gcloudSync(['storage', 'objects', 'update', `${bundlePrefix}/bundle.zip`, '--cache-control=public, max-age=31536000, immutable'], { stdio: 'inherit' });
        gcloudSync(['storage', 'cp', manifestPath, `${bundlePrefix}/manifest.json`], { stdio: 'inherit' });
        gcloudSync(['storage', 'objects', 'update', `${bundlePrefix}/manifest.json`, '--cache-control=no-cache, max-age=0'], { stdio: 'inherit' });
      } finally {
        rmSync(manifestStageDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }

    // Merge into release.json: fetch current (if any), bump this bundle's version, re-sign,
    // re-upload. Never touches other bundles' entries, so publishing "sling" can't
    // accidentally roll back "shell" or vice versa.
    //
    // Optimistic concurrency (a fresh-eyes review, 2026-07-26, caught the original
    // read-merge-write here had no guard at all): two publishes racing for DIFFERENT bundle
    // names could both read the same pre-publish release.json, and whichever writes second
    // would silently overwrite the first's just-published bundle entry — even though that
    // bundle's files genuinely landed in the bucket. `--if-generation-match` makes the final
    // write fail (not silently succeed) if the object changed since we read it; on that
    // failure we re-fetch + re-merge + retry, so a losing writer's changes are never
    // dropped, only delayed. `=0` is GCS's documented idiom for "the object must not exist
    // yet" (the create-for-the-first-time case).
    const releasePath = `${bucket}/release.json`;
    const MAX_RELEASE_RETRIES = 5;
    let published = false;
    for (let attempt = 1; attempt <= MAX_RELEASE_RETRIES && !published; attempt++) {
      let existingRelease = null;
      let generation = '0';
      let describeSucceeded = false;
      try {
        const rawGeneration = gcloudSync(['storage', 'objects', 'describe', releasePath, '--format=value(generation)'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
        if (!/^\d+$/.test(rawGeneration)) fail(`Unexpected generation value from gcloud: ${JSON.stringify(rawGeneration)}`);
        generation = rawGeneration;
        describeSucceeded = true;
        const raw = gcloudSync(['storage', 'cat', releasePath], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
        existingRelease = JSON.parse(raw);
        // Shape-check what JSON.parse handed back (F4): `null`, an array, or an object
        // missing an object-typed `bundles` field all parse "successfully" — JSON.parse alone
        // can't tell a malformed release from a well-formed one — and without this check the
        // merge below (`{ ...(existingRelease?.bundles ?? {}), [name]: version }`) would
        // silently treat any of those as "no bundles yet" and publish a release containing
        // ONLY the bundle staged by THIS run, wiping every other bundle's entry that was
        // actually live. Deliberately a `fail()` here, not a retry: a corrupt/malformed
        // existing release is not the concurrent-write race the loop above already handles
        // via --if-generation-match, so it must ABORT this publish attempt rather than being
        // retried into an overwrite.
        const releaseIsObject = typeof existingRelease === 'object' && existingRelease !== null && !Array.isArray(existingRelease);
        const bundlesIsObject = releaseIsObject && typeof existingRelease.bundles === 'object' && existingRelease.bundles !== null && !Array.isArray(existingRelease.bundles);
        if (!releaseIsObject || !bundlesIsObject) {
          fail(`release.json exists (generation ${generation}) but its body is malformed (expected an object with an object "bundles" field, got ${JSON.stringify(existingRelease)}). Publishing now would drop every other bundle's entry. Aborting without writing.`);
        }
      } catch {
        // `describe` failing means release.json genuinely doesn't exist yet — this is
        // the legitimate first-publish path, so fall back to generation '0' / no
        // existing release. But if `describe` SUCCEEDED (the object exists) and only
        // the subsequent `cat`/`JSON.parse` threw, that is NOT "no existing release" —
        // `generation` would still hold the real value while `existingRelease` stays
        // null, so the merge below would build a release containing ONLY this bundle
        // and `--if-generation-match` would happily overwrite the real release.json
        // with it. Treat that case as a hard error instead of silently reset.
        if (describeSucceeded) {
          fail(`release.json exists (generation ${generation}) but could not be read/parsed. Publishing now would drop every other bundle's entry. Aborting without writing.`);
        }
        generation = '0';
        if (attempt === 1) console.log('[ota-publish] No existing release.json — creating the first one.');
      }

      const bundles = { ...(existingRelease?.bundles ?? {}), [name]: version };
      // minEngineApi is a compatibility floor, independent of `mandatory` (which is
      // only about apply-timing) — it can only ratchet up, never down, across publishes.
      const minEngineApi = Math.max(existingRelease?.minEngineApi ?? engineApi, engineApi);
      // `mandatory` is STICKY: an explicit --mandatory/--no-mandatory wins, and passing
      // neither flag INHERITS the just-refetched existingRelease's value (false when there
      // is none yet). Computed here, inside the retry loop, next to `bundles`/`minEngineApi`
      // — `existingRelease` is refetched on every attempt, so inheriting from a stale read
      // (e.g. computed once before the loop) would reintroduce the bug under the exact
      // concurrent-publish race this loop exists to handle.
      const mandatory = args.mandatory !== undefined ? args.mandatory : (existingRelease?.mandatory ?? false);
      // `manifests` merges the SAME way `bundles` does, for the same reason: this is the
      // subtle bug to avoid here. If publishing bundle B naively wrote `{ [name]: manifestHash }`
      // without spreading in `existingRelease?.manifests`, bundle A's already-shipped clients
      // would silently stop having their manifest enforced — the field would just vanish from
      // under them on someone else's publish. Then PRUNE any entry whose key is no longer in the
      // merged `bundles` map, so a bundle removed from the release doesn't leave a stale hash
      // behind that nothing will ever refresh.
      const mergedManifests = { ...(existingRelease?.manifests ?? {}), [name]: manifestHash };
      // Object.hasOwn, not `bundleName in bundles` — `in` also matches INHERITED properties
      // (`toString`, `constructor`, ...), so a manifests entry literally named "toString"
      // would survive the prune even though `bundles` has no such own key.
      const manifests = Object.fromEntries(Object.entries(mergedManifests).filter(([bundleName]) => Object.hasOwn(bundles, bundleName)));
      // Anti-rollback (#571): a bare increment off the just-refetched `existingRelease`, same
      // per-attempt recompute `bundles`/`minEngineApi`/`mandatory`/`manifests` already use —
      // recomputing inside the retry loop is what keeps this correct under the concurrent-
      // publish race `--if-generation-match` guards against (a losing attempt refetches the
      // winner's `seq` and increments off THAT, so two racing publishes still produce two
      // distinct, strictly increasing values rather than a duplicate).
      const seq = (existingRelease?.seq ?? 0) + 1;
      const unsignedRelease = createRelease({ bundles, mandatory, minEngineApi, manifests, seq });
      const release = signRelease(unsignedRelease, keypair);
      const releaseErrors = validateRelease(release);
      if (releaseErrors.length) fail(`Built an invalid release:\n  ${releaseErrors.join('\n  ')}`);

      const releaseStageDir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-release-'));
      const tmpReleasePath = path.join(releaseStageDir, 'release.json');
      writeFileSync(tmpReleasePath, JSON.stringify(release, null, 2));
      try {
        gcloudSync(['storage', 'cp', tmpReleasePath, releasePath, `--if-generation-match=${generation}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        gcloudSync(['storage', 'objects', 'update', releasePath, '--cache-control=no-cache, max-age=0'], { stdio: 'inherit' });
        published = true;
      } catch (e) {
        const stderr = e?.stderr?.toString() ?? '';
        const isPreconditionFailure = /PreconditionFailed|GcsPreconditionFailedError/i.test(stderr);
        if (isPreconditionFailure && attempt < MAX_RELEASE_RETRIES) {
          console.log(`[ota-publish] release.json changed concurrently (attempt ${attempt}/${MAX_RELEASE_RETRIES}) — refetching and retrying...`);
        } else if (isPreconditionFailure) {
          fail(`release.json kept changing concurrently after ${MAX_RELEASE_RETRIES} attempts — another publish is racing this one. Try again once it finishes.`);
        } else {
          fail(`Failed to upload release.json: ${stderr || e.message}`);
        }
      } finally {
        rmSync(releaseStageDir, { recursive: true, force: true });
      }

      if (published) {
        console.log(`[ota-publish] Published ${name}@${version} — release.json now points ${name} → ${version}, mandatory=${mandatory}, seq=${seq}.`);
        // Partial manifest coverage is otherwise invisible: this publish only ever writes
        // `manifests[name]` for the bundle it's publishing, so on a bucket with several
        // bundles, every OTHER bundle's `manifests` entry stays missing/unenforced
        // indefinitely with nothing anywhere else to notice or warn about it.
        const uncoveredBundles = Object.keys(bundles).filter((bundleName) => !Object.hasOwn(manifests, bundleName));
        if (uncoveredBundles.length > 0) {
          console.warn(`[ota-publish] WARNING: manifest verification is NOT enabled for: ${uncoveredBundles.join(', ')}.`);
          console.warn('[ota-publish]          Republish each of those bundles to add its manifests[] entry to release.json.');
        }
      }
    }

    // Retention (#836): only AFTER release.json points at the new version, so the version being
    // published is both the newest and the live one when the plan is taken. A failure here is a loud
    // warning, not a failed publish: the release is already live, and the next publish prunes again.
    // What is kept and why that strands no device: ota/pruneBundle.mjs.
    // The version this publish just made live must still be fetchable. A concurrent prune (another
    // publish's, or ota-prune.mjs by hand) can delete a RETRIED old version's objects in the gap before its
    // manifest is refreshed — the one race pruneBundle.mjs's grace window does not close (see
    // PRUNE_GRACE_MS). Rare, and fleet-wide when it happens, so not left to a device to discover. The
    // manifest and the zip are what a device cannot do without; `files/` is not probed, because a missing
    // delta file already falls back to the whole zip on the device (#556).
    for (const object of ['manifest.json', 'bundle.zip']) {
      const objectPath = `${bucket}/bundles/${name}/${version}/${object}`;
      try {
        gcloudSync(['storage', 'objects', 'describe', objectPath, '--format=value(generation)'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const stderr = e?.stderr?.toString() ?? '';
        if (isGcloudObjectNotFoundError(stderr)) { // real text, measured: `…manifest.json not found: 404.`
          fail(`release.json now points ${name} at ${version}, but ${objectPath} is GONE — a concurrent prune deleted it mid-publish. Every device will fail to fetch this version. Publish ${name} again now (a new version string).`);
        }
        console.warn(`[ota-publish] WARNING: could not confirm ${objectPath} survived the publish: ${stderr || e.message}`);
      }
    }

    const prune = pruneBundleVersions({ bucket, name, keep: preflight.retainVersions });
    if (prune.ok) {
      const { plan } = prune;
      console.log(`[ota-publish] Retention: kept ${plan.keep.length} version(s) of ${name} (newest ${preflight.retainVersions} + live), deleted ${prune.removed.length}${prune.removed.length ? `: ${prune.removed.join(', ')}` : ''}.`);
      if (plan.incomplete.length) console.log(`[ota-publish] Retention: left alone, no manifest.json: ${plan.incomplete.join(', ')}`);
    } else {
      console.warn(`[ota-publish] WARNING: the release is live, but pruning old versions failed: ${prune.error}${prune.removed.length ? ` (deleted before the failure: ${prune.removed.join(', ')})` : ''}. The next publish prunes again, or run engine/scripts/ota-prune.mjs.`);
    }
  } finally {
    buildClaim.release();
    distClaim?.release();
  }
}

main().catch((err) => fail(err.stack || String(err)));
