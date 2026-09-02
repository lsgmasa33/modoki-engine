/** OTA update client (docs/ota-updates.md) — the trusted,
 *  ALREADY-RUNNING shell JS's half of the update flow: fetch `release.json` + a bundle's
 *  `manifest.json` over plain `fetch()`, verify the release's Ed25519 signature, and hand
 *  off to the native plugin (`ModokiOta`) for the actual byte-moving (download the zip
 *  directly, verify its SHA-256, unzip, stage) — see docs/ota-updates.md for why that part must
 *  be native (bridging thousands of small files as base64 is prohibitively slow).
 *
 *  Verification happens HERE, in JS, not in native code — deliberately: this JS is
 *  already running and was already vetted (either shipped in the signed app binary, or
 *  itself a previously-verified OTA update), so it is the trusted context. This also
 *  sidesteps a real platform gap: Android's minSdk 24 predates native EdDSA support
 *  (added API 33), so doing verification natively would need either a minSdk bump or a
 *  hand-rolled curve implementation on that platform — both worse than verifying once, in
 *  JS, with a single audited library (`@noble/curves`) shared by both platforms.
 *
 *  `@noble/curves` (not a hand-rolled Ed25519) is a deliberate choice — curve arithmetic
 *  is exactly the kind of code where "cheap to write, expensive to get subtly wrong"
 *  applies; the Node-side signer (engine/scripts/ota/signing.mjs) uses Node's own
 *  built-in `crypto` for the same reason, on the platform where that built-in exists. */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface OtaFileEntry {
  hash: string;
  size: number;
}

export interface OtaManifest {
  schema: number;
  name: string;
  version: string;
  engineApi: number;
  files: Record<string, OtaFileEntry>;
  bundleZip?: OtaFileEntry;
}

export interface OtaRelease {
  schema: number;
  bundles: Record<string, string>;
  mandatory: boolean;
  minEngineApi: number;
  /** sha256 of each bundle's CURRENT-version manifest, canonically serialized (#570,
   *  additive — a release without it is still valid). See
   *  {@link manifestHashPayload} and `checkForUpdate`'s `manifest-untrusted` outcome. */
  manifests?: Record<string, string>;
  /** Monotonic publish counter (#571, additive — a release without it is treated as `0`),
   *  bumped by `ota-publish.mjs` on every publish. `checkForUpdate` refuses a release whose
   *  `seq` is lower than the highest this device has already recorded — closing the
   *  anti-rollback gap #570 explicitly left open (a validly-signed but OLDER release.json,
   *  replayed by an attacker with bucket write, is otherwise indistinguishable from a
   *  legitimate one). See docs/ota-updates.md "The trust chain". */
  seq?: number;
  sig: string;
}

// KEEP IN SYNC with engine/scripts/ota/schema.mjs (SCHEMA_VERSION, validateManifest,
// validateRelease, signingPayload). A TS port, not a cross-package import, deliberately —
// this package (@modoki/engine) ships standalone (see docs/engine-oss-publishing.md) and
// must not reach outside its own src/ into engine/scripts/, a Node-only dev-tooling dir
// that isn't part of the published package. Same class of exception CLAUDE.md already
// documents for engine/scripts/projectRoots.mjs's two "keep-in-sync" TS consumers.
export const SCHEMA_VERSION = 1;

export function validateManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(msg);
  if (manifest == null || typeof manifest !== 'object') return ['manifest must be an object'];
  const m = manifest as Record<string, unknown>;
  if (m.schema !== SCHEMA_VERSION) fail(`manifest.schema must be ${SCHEMA_VERSION}, got ${m.schema}`);
  if (typeof m.name !== 'string' || !m.name) fail('manifest.name must be a non-empty string');
  if (typeof m.version !== 'string' || !m.version) fail('manifest.version must be a non-empty string');
  if (typeof m.engineApi !== 'number' || !Number.isInteger(m.engineApi) || m.engineApi < 1) {
    fail('manifest.engineApi must be a positive integer');
  }
  if (m.files == null || typeof m.files !== 'object' || Array.isArray(m.files)) {
    fail('manifest.files must be an object keyed by relative file path');
  } else {
    for (const [filePath, entry] of Object.entries(m.files as Record<string, unknown>)) {
      if (!filePath || filePath.startsWith('/') || filePath.includes('..')) {
        fail(`manifest.files["${filePath}"] must be a relative path with no ".." segments`);
      }
      const e = entry as Record<string, unknown> | null;
      if (e == null || typeof e !== 'object') {
        fail(`manifest.files["${filePath}"] must be an object`);
        continue;
      }
      if (typeof e.hash !== 'string' || !/^[0-9a-f]{64}$/.test(e.hash)) {
        fail(`manifest.files["${filePath}"].hash must be a lowercase hex sha256 (64 chars)`);
      }
      if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) {
        fail(`manifest.files["${filePath}"].size must be a non-negative integer`);
      }
    }
  }
  if (m.bundleZip !== undefined) {
    const z = m.bundleZip as Record<string, unknown> | null;
    if (z == null || typeof z !== 'object') fail('manifest.bundleZip must be an object when present');
    else {
      if (typeof z.hash !== 'string' || !/^[0-9a-f]{64}$/.test(z.hash)) fail('manifest.bundleZip.hash must be a lowercase hex sha256 (64 chars)');
      if (typeof z.size !== 'number' || !Number.isInteger(z.size) || z.size < 0) fail('manifest.bundleZip.size must be a non-negative integer');
    }
  }
  return errors;
}

export function validateRelease(release: unknown): string[] {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(msg);
  if (release == null || typeof release !== 'object') return ['release must be an object'];
  const r = release as Record<string, unknown>;
  if (r.schema !== SCHEMA_VERSION) fail(`release.schema must be ${SCHEMA_VERSION}, got ${r.schema}`);
  if (r.bundles == null || typeof r.bundles !== 'object' || Array.isArray(r.bundles)) {
    fail('release.bundles must be an object keyed by bundle name');
  } else {
    for (const [name, version] of Object.entries(r.bundles as Record<string, unknown>)) {
      if (typeof version !== 'string' || !version) fail(`release.bundles["${name}"] must be a non-empty version string`);
    }
  }
  if (typeof r.mandatory !== 'boolean') fail('release.mandatory must be a boolean');
  if (typeof r.minEngineApi !== 'number' || !Number.isInteger(r.minEngineApi) || r.minEngineApi < 1) {
    fail('release.minEngineApi must be a positive integer');
  }
  if (typeof r.sig !== 'string' || !r.sig) fail('release.sig must be a non-empty string (base64url Ed25519 signature)');
  if (r.manifests !== undefined) {
    if (r.manifests == null || typeof r.manifests !== 'object' || Array.isArray(r.manifests)) {
      fail('release.manifests must be an object keyed by bundle name');
    } else {
      for (const [name, hash] of Object.entries(r.manifests as Record<string, unknown>)) {
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
          fail(`release.manifests["${name}"] must be a lowercase hex sha256 (64 chars)`);
        }
      }
    }
  }
  if (r.seq !== undefined) {
    if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 0) {
      fail('release.seq must be a non-negative integer');
    }
  }
  return errors;
}

/** MUST match engine/scripts/ota/schema.mjs's `signingPayload` byte-for-byte — both sides
 *  sign/verify the same canonical (sorted-key, `sig`-excluded) JSON serialization. */
export function signingPayload(release: OtaRelease | Omit<OtaRelease, 'sig'>): string {
  const { sig: _sig, ...unsigned } = release as OtaRelease;
  return JSON.stringify(sortKeysDeep(unsigned));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    // Object.create(null), NOT `{}` — MUST match engine/scripts/ota/schema.mjs's
    // sortKeysDeep byte-for-byte, comment ported verbatim: a plain object literal's
    // `__proto__` is an ACCESSOR inherited from Object.prototype, so `sorted['__proto__']
    // = ...` would silently write through the setter (mutating `sorted`'s own prototype)
    // instead of storing an own property, and that key would vanish from the
    // JSON.stringify output entirely. That let two materially different documents (one
    // with a top-level `__proto__` key, one without) canonicalize to byte-identical
    // strings — a signature meant for one would vouch for the other. A null-prototype
    // object has no inherited `__proto__` setter to intercept the assignment, so it
    // becomes an ordinary own property like any other key. Output is unaffected for
    // every document that doesn't use `__proto__` as a key: JSON.stringify only ever
    // looks at own enumerable properties, never the prototype.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** MUST match engine/scripts/ota/schema.mjs's `manifestHashPayload` byte-for-byte — the
 *  canonical (sorted-key) JSON of a manifest, same treatment {@link signingPayload} gives
 *  a release. Canonical rather than raw file bytes so this hash survives `res.json()`
 *  round-tripping the manifest — the client never needs `res.text()`. */
export function manifestHashPayload(manifest: OtaManifest): string {
  return JSON.stringify(sortKeysDeep(manifest));
}

/** Lowercase-hex sha256 of a UTF-8 string, via `@noble/hashes` — a `dependencies` entry
 *  alongside `@noble/curves` (see engine/packages/modoki/package.json), so this adds no
 *  new library. Deliberately NOT `crypto.subtle.digest`: that is async (it would turn this
 *  synchronous canonical-hash step into a promise for no benefit) and is gated on a secure
 *  context, which is a property of however the host WebView is configured rather than
 *  something this module can rely on. Exported (not module-private) so the canonicalization
 *  parity test can assert this hashing path agrees with Node's `createHash('sha256')` on
 *  the publisher side, instead of duplicating this exact logic in the test. */
export function sha256Hex(s: string): string {
  const bytes = sha256(new TextEncoder().encode(s));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A single file to fetch individually by content hash (Phase 2 delta transfer) — as
 *  opposed to the whole-bundle `bundleZip` Phase 1 always downloads. */
export interface OtaDeltaDownload {
  path: string;
  url: string;
  hash: string;
  size: number;
}

/** The native plugin surface this client depends on — a structural (not nominal) type so
 *  tests can pass a plain mock without importing `@capacitor/core`. */
/** A single target-manifest file, as handed to native for whole-tree post-stage
 *  verification (#556) — see `OtaNativePlugin.stageUpdate`/`stageUpdateDelta`. */
export interface OtaFileRef {
  path: string;
  hash: string;
}

export interface OtaNativePlugin {
  /** `files` (#556): the target manifest's full path→hash map. Native verifies the staged
   *  tree against it (strict set equality) after writing, before the atomic rename — see
   *  the plugin's own doc comment (definitions.ts) for why the whole-zip hash alone isn't
   *  enough. */
  stageUpdate(opts: { name: string; version: string; zipUrl: string; expectedZipHash: string; expectedZipSize: number; files: OtaFileRef[] }): Promise<{ ok: boolean }>;
  /** Phase 2 delta staging: copy `copy` (unchanged relative paths) from the
   *  already-on-disk `baseVersion` folder, download only `download` (new/changed files,
   *  each independently hash-verified) into the new `version` folder. Native must refuse
   *  to activate a folder built this way if any copy source is missing (self-heal to
   *  `stageUpdate`'s whole-zip path is the CALLER's job, not native's — see
   *  `checkForUpdate`'s fallback). `files` (#556): same whole-tree verification as
   *  `stageUpdate` — `copy` entries are never individually hashed, so this is what catches
   *  a locally-corrupt base file. */
  stageUpdateDelta(opts: { name: string; version: string; baseVersion: string; copy: string[]; download: OtaDeltaDownload[]; files: OtaFileRef[] }): Promise<{ ok: boolean }>;
  activate(opts: { name: string; version: string }): Promise<{ ok: boolean }>;
  getState(): Promise<{ stateJSON: string }>;
  /** #571 anti-rollback: persists `seq` as the device's new high-water mark, monotonically
   *  — native takes `max(existing, seq)`, so this is safe to call with a `seq` that turns
   *  out not to be an increase (a repeat check against the same release.json). Called by
   *  `checkForUpdate` right after signature verification, BEFORE any up-to-date/staging
   *  decision — an up-to-date check is the common case, and skipping it there would leave
   *  the high-water mark stuck at its last-staged value while a device stays current for a
   *  long stretch, reopening exactly the replay window this exists to close. */
  recordSeq(opts: { seq: number }): Promise<{ ok: boolean }>;
}

/** Pure diff: which of `target`'s files are byte-identical (by content hash) to a file at
 *  the SAME relative path in `current`, vs which are new/changed and must be downloaded.
 *  A path present in `target` but absent from `current` is always a download (never a
 *  rename-detected copy — Phase 2 is a straightforward path+hash diff, not a content
 *  dedup across renamed files; Vite's content-hashed filenames make that unnecessary in
 *  practice, since an unchanged chunk keeps its exact name). */
export function diffManifests(current: OtaManifest, target: OtaManifest): { copy: string[]; download: Omit<OtaDeltaDownload, 'url'>[] } {
  const copy: string[] = [];
  const download: Omit<OtaDeltaDownload, 'url'>[] = [];
  for (const [path, entry] of Object.entries(target.files)) {
    const currentEntry = current.files[path];
    if (currentEntry && currentEntry.hash === entry.hash) {
      copy.push(path);
    } else {
      download.push({ path, hash: entry.hash, size: entry.size });
    }
  }
  return { copy, download };
}

export type OtaCheckResult =
  | { outcome: 'up-to-date' }
  | { outcome: 'no-release-for-bundle' }
  | { outcome: 'signature-invalid' }
  | { outcome: 'engine-api-too-old'; required: number; running: number }
  | { outcome: 'manifest-invalid'; errors: string[] }
  /** The fetched manifest is well-formed (passed `validateManifest`) but its canonical
   *  hash does NOT match the signed release's `manifests[bundleName]` entry — the bundle's
   *  CONTENTS don't match what the release.json commits to. Distinct from
   *  `manifest-invalid` (malformed shape): this manifest parses fine, it just isn't the
   *  one the signature vouches for, which means the bucket served tampered or stale
   *  bytes. Nothing is staged when this fires. */
  | { outcome: 'manifest-untrusted'; version: string; expected: string; actual: string }
  /** #571 anti-rollback: the release's `seq` is LOWER than the highest this device has
   *  already recorded — a validly-signed but stale release.json, most plausibly an
   *  attacker with bucket write replaying an old capture (see docs/ota-updates.md "The
   *  trust chain"). Checked before any bundle-version comparison, so a replay is refused
   *  outright rather than merely reported as `up-to-date`. Nothing is staged when this
   *  fires; the device stays on whatever it's already running. */
  | { outcome: 'seq-rollback'; version: string; seq: number; highestSeenSeq: number }
  | { outcome: 'no-bundle-zip-in-manifest' }
  /** The release's target version is one this device already PROVED bad — it exhausted
   *  its boot attempts and the watchdog reverted it (Phase 3a quarantine). Staging it
   *  again would re-enter the crash-loop → revert → re-stage cycle forever, so we refuse.
   *  Recovery is fix-forward only: publish a NEW version. A blocking/mandatory gate MUST
   *  treat this as "no update available" and let the player keep playing the working
   *  bundle — blocking here is what turns a stale app into a permanent brick. */
  | { outcome: 'version-rejected'; version: string }
  | { outcome: 'staged'; version: string; delta?: boolean; mandatory: boolean }
  /** The target version is already STAGED natively (`pending`) and is waiting for a restart to be
   *  served — the device is NOT running it yet. Distinct from `up-to-date` (which means `active`
   *  already IS the target) precisely so a mandatory gate can hold. */
  | { outcome: 'pending-restart'; version: string; mandatory: boolean };

/** Browser-safe base64url decode — this module runs in the WebView shell, where
 *  `Buffer` does not exist (unlike Node, where the test suite happens to run it). Uses
 *  `atob` (universally available in a WKWebView/Android WebView), not a Node API. */
function base64urlToBytes(s: string): Uint8Array {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url-decodes the release's Ed25519 signature and verifies it against
 *  {@link signingPayload}'s canonical serialization. Never throws — a malformed
 *  signature/key is simply "not verified", matching engine/scripts/ota/signing.mjs's
 *  Node-side `verifyRelease` contract exactly (both must treat garbage input the same
 *  way, since they check the same signatures). */
export function verifyReleaseSignature(release: OtaRelease, publicKeyBase64url: string): boolean {
  if (typeof release?.sig !== 'string' || !release.sig) return false;
  try {
    const sig = base64urlToBytes(release.sig);
    const pub = base64urlToBytes(publicKeyBase64url);
    const payload = new TextEncoder().encode(signingPayload(release));
    return ed25519.verify(sig, payload, pub);
  } catch {
    return false;
  }
}

/** Sentinel `baseVersion` meaning "diff against the bundle shipped inside the app binary
 *  itself", not an OTA-staged folder. Native resolves this specially: its source
 *  directory is the app's own embedded webDir (iOS's `public/` inside the app bundle,
 *  Android's `file:///android_asset/public/`), not `ionic_built_snapshots/<name>-<v>/`. */
export const EMBEDDED_BASE_VERSION = 'embedded';

export interface CheckForUpdateOptions {
  /** Base URL the bucket is served from, e.g. "https://cdn.example.com/games/mygame". */
  baseUrl: string;
  /** Ed25519 public key (base64url, 32 raw bytes) baked into the app. */
  publicKey: string;
  /** The bundle this running app instance drives — Phase 1 is single-game, so this is
   *  always the "shell" bundle name; Phase 4 sub-games would pass their own name. */
  bundleName: string;
  /** The running engine's own API version — a manifest requiring a HIGHER version is
   *  refused rather than staged (the compatibility gate a future sub-game module needs
   *  in full; already cheap and correct to enforce even for the single "shell" bundle). */
  runningEngineApi: number;
  /** Where the bundle's OWN manifest.json ships alongside its embedded assets — a
   *  RELATIVE path fetched from the app's own served origin (NOT prefixed with
   *  `baseUrl`; this must resolve locally, with zero network round-trip, since the whole
   *  point is delta-ing the very first update without needing a whole bundle download).
   *  Written into `dist/` by the build (see `engine/scripts/ota/buildManifest.mjs`'s
   *  `--embed` flag). Defaults to `'ota-embedded-manifest.json'`. Absent/unreadable
   *  (an older build that predates this feature) silently falls back to whole-zip — this
   *  is an optimization, not a requirement. */
  embeddedManifestUrl?: string;
  fetchImpl?: typeof fetch;
  native: OtaNativePlugin;
  /** Fires exactly once, right after the release is verified and this update is
   *  determined to be genuinely actionable (not up-to-date, not quarantined, not
   *  blocked by the release-level engine-API gate) — BEFORE the manifest fetch or any
   *  staging begins. Lets a caller (Phase 3b's blocking gate) know a `mandatory`
   *  update is about to download BEFORE the first `otaProgress` tick arrives, so it
   *  can show a blocking screen for the WHOLE download rather than only after it
   *  completes. Not called for up-to-date/quarantined/gated-out outcomes. A later
   *  failure (bad manifest, download error) still leaves the promise resolving to a
   *  non-`staged` outcome — the caller is expected to un-arm its gate whenever the
   *  final outcome isn't `staged`, not rely on this ever being "undone". */
  onWillStage?: (info: { version: string; mandatory: boolean }) => void;
  /** Called when a delta stage failed and the client fell back to a whole-bundle download
   *  (#556). Optional, but worth wiring: this path silently turns a small delta into a full
   *  download, and an unexplained bandwidth spike is precisely the thing nobody can diagnose
   *  after the fact. */
  onDeltaFallback?: (info: { version: string; reason: string }) => void;
}

export interface FetchReleaseOptions {
  /** Base URL the bucket is served from, e.g. "https://cdn.example.com/games/mygame". */
  baseUrl: string;
  /** Ed25519 public key (base64url, 32 raw bytes) baked into the app. */
  publicKey: string;
  fetchImpl?: typeof fetch;
}

export type FetchReleaseResult =
  | { ok: true; release: OtaRelease }
  | { ok: false; outcome: 'no-release-for-bundle' | 'signature-invalid' };

/** Fetches `release.json` and verifies its signature — the half of {@link checkForUpdate}
 *  that OTA Phase 4's sub-game discovery needs standalone (it reads `release.bundles` to
 *  find sub-game names before running `checkForUpdate` once per bundle; the shell's own
 *  `checkForUpdate` call inlines this same logic rather than calling out to it, so as not
 *  to double the network round-trip on the common single-bundle path). Never throws — a
 *  network/parse/signature failure is a discriminated result, same contract as
 *  `checkForUpdate`. */
export async function fetchRelease(opts: FetchReleaseOptions): Promise<FetchReleaseResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let release: OtaRelease;
  try {
    const res = await doFetch(`${opts.baseUrl}/release.json`);
    if (!res.ok) return { ok: false, outcome: 'no-release-for-bundle' };
    release = await res.json();
  } catch {
    return { ok: false, outcome: 'no-release-for-bundle' };
  }
  if (validateRelease(release).length > 0) return { ok: false, outcome: 'signature-invalid' };
  if (!verifyReleaseSignature(release, opts.publicKey)) return { ok: false, outcome: 'signature-invalid' };
  return { ok: true, release };
}

/** Fetches release.json, verifies its signature, and — if `bundleName` has a newer
 *  version than what's currently active — fetches that bundle's manifest and stages the
 *  update via the native plugin. Does NOT call `activate()` if staging fails, and never
 *  throws on network/parse/verification failure — every failure mode is a discriminated
 *  `OtaCheckResult` the caller can log/ignore (an OTA check failing must never crash the
 *  game that's already running fine). */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<OtaCheckResult> {
  const doFetch = opts.fetchImpl ?? fetch;

  let release: OtaRelease;
  try {
    const res = await doFetch(`${opts.baseUrl}/release.json`);
    if (!res.ok) return { outcome: 'no-release-for-bundle' };
    release = await res.json();
  } catch {
    return { outcome: 'no-release-for-bundle' };
  }

  if (validateRelease(release).length > 0) return { outcome: 'signature-invalid' };
  if (!verifyReleaseSignature(release, opts.publicKey)) return { outcome: 'signature-invalid' };

  const targetVersion = release.bundles[opts.bundleName];
  if (!targetVersion) return { outcome: 'no-release-for-bundle' };

  const { stateJSON } = await opts.native.getState();
  const state = parseNativeState(stateJSON);

  // Anti-rollback (#571). Checked before any bundle-version comparison below — a replayed
  // release is refused wholesale, not merely folded into an `up-to-date` outcome that
  // would (correctly, but silently) skip recording it. `highestSeenSeq` is read HERE, from
  // the state fetched above, before `recordSeq` (if called) can advance it — so the
  // comparison is always against what this device knew BEFORE this release was seen.
  const releaseSeq = release.seq ?? 0;
  const highestSeenSeq = state?.highestSeenSeq ?? 0;
  if (releaseSeq < highestSeenSeq) {
    return { outcome: 'seq-rollback', version: targetVersion, seq: releaseSeq, highestSeenSeq };
  }
  if (releaseSeq > highestSeenSeq) {
    // Recorded unconditionally on every signature-valid, non-rollback release — including
    // an up-to-date one. Skipping this on the up-to-date fast path (the common case) would
    // leave the high-water mark stuck at whatever it was when a bundle last actually
    // staged, so a device that stays current for a long stretch would still accept a
    // replay of any release published in between — exactly the gap this exists to close.
    // Swallowed on failure (disk full, IPC error): this function's contract is to never
    // throw on an OTA check (an OTA check failing must never crash a game that's already
    // running fine) — same reasoning as every other `catch` in this function. Losing one
    // recordSeq write only delays the high-water mark's advance to the NEXT check; it does
    // not weaken the rollback check itself, which still compares against whatever the
    // native side actually has persisted.
    try {
      await opts.native.recordSeq({ seq: releaseSeq });
    } catch {
      // best-effort — see comment above
    }
  }

  const currentActive = state?.active?.[opts.bundleName];
  const currentPending = state?.pending?.[opts.bundleName];
  if (currentActive === targetVersion) return { outcome: 'up-to-date' };
  if (currentPending === targetVersion) {
    // ⚠️ `pending` alone does NOT mean "waiting for a restart" — it survives the restart, because
    // promotion to `active` needs TWO confirmBoots across TWO launches (OtaCore.requiredConfirms).
    // `bootAttempts` is the discriminator: `activate()` clears it when staging, and the native boot
    // hook increments it when it SERVES the pending bundle, before the WebView loads. So 0 means
    // this device has never run the staged version and a restart is genuinely owed; >= 1 means we
    // are running it right now, and holding a mandatory gate here would block the game forever on
    // the very update it has already applied.
    const alreadyServed = (state?.bootAttempts?.[opts.bundleName] ?? 0) > 0;
    if (alreadyServed) return { outcome: 'up-to-date' };
    return { outcome: 'pending-restart', version: targetVersion, mandatory: release.mandatory };
  }

  // Quarantine gate (Phase 3a). Checked AFTER the up-to-date/pending-restart short-circuits
  // above, so a version that somehow reached `active` (or is already `pending`) despite being
  // listed still reports up-to-date/pending-restart — `rejected` vetoes STAGING, never a bundle
  // that is already booting fine or already staged (mirrors OtaCore's boot-side rule; see
  // ota-gate-vectors-phase3.json).
  if (state?.rejected?.[opts.bundleName]?.includes(targetVersion)) {
    return { outcome: 'version-rejected', version: targetVersion };
  }

  // Release-level engine-API gate (previously dead code — validated by `validateRelease`
  // but never read). Checked alongside the per-bundle `manifest.engineApi` gate below;
  // both refuse the update rather than staging it, so a stale-engine device just stays on
  // its current working bundle until it's upgraded past `minEngineApi`.
  if (release.minEngineApi > opts.runningEngineApi) {
    return { outcome: 'engine-api-too-old', required: release.minEngineApi, running: opts.runningEngineApi };
  }

  opts.onWillStage?.({ version: targetVersion, mandatory: release.mandatory });

  let manifest: OtaManifest;
  try {
    const res = await doFetch(`${opts.baseUrl}/bundles/${opts.bundleName}/${targetVersion}/manifest.json`);
    if (!res.ok) return { outcome: 'no-release-for-bundle' };
    manifest = await res.json();
  } catch {
    return { outcome: 'no-release-for-bundle' };
  }

  const manifestErrors = validateManifest(manifest);
  if (manifestErrors.length > 0) return { outcome: 'manifest-invalid', errors: manifestErrors };

  // Chain the manifest into the SIGNED release (#570): release.json is Ed25519-signed
  // and `manifests[bundleName]` is a field on it like any other, so an attacker with
  // bucket write cannot alter/replace manifest.json without invalidating that signature.
  // Checked here — after shape validation, before the engineApi gate below — so a
  // tampered-but-well-formed manifest never reaches staging. Optional: an older
  // release.json with no `manifests` field (or one missing this bundle) skips the check
  // entirely, same non-breaking contract `validateRelease` gives the field.
  const expectedManifestHash = release.manifests?.[opts.bundleName];
  if (typeof expectedManifestHash === 'string') {
    const actualManifestHash = sha256Hex(manifestHashPayload(manifest));
    if (actualManifestHash !== expectedManifestHash) {
      return { outcome: 'manifest-untrusted', version: targetVersion, expected: expectedManifestHash, actual: actualManifestHash };
    }
  }

  if (manifest.engineApi > opts.runningEngineApi) {
    return { outcome: 'engine-api-too-old', required: manifest.engineApi, running: opts.runningEngineApi };
  }

  // The target manifest's full path→hash map, handed to native so it can verify the
  // staged tree against it (strict set equality) before the atomic rename — #556. Built
  // once here and passed to whichever staging path actually runs.
  const files: OtaFileRef[] = Object.entries(manifest.files).map(([path, e]) => ({ path, hash: e.hash }));

  // Delta path: diff against whatever's ALREADY on disk — an active OTA version if one
  // exists, otherwise the bundle embedded in the app binary itself (so even the very
  // FIRST update, on a fresh install, never needs a whole-bundle download). Either base
  // manifest failing to fetch/validate falls back to whole-zip rather than failing the
  // update outright — delta is an optimization, not a requirement for the update to
  // succeed (an older build with no embedded manifest, or a CDN blip, must still work).
  const baseVersion = currentActive ?? EMBEDDED_BASE_VERSION;
  const baseManifest = currentActive
    ? await tryFetchManifest(doFetch, opts.baseUrl, opts.bundleName, currentActive)
    : await tryFetchEmbeddedManifest(doFetch, opts.embeddedManifestUrl ?? 'ota-embedded-manifest.json');
  if (baseManifest) {
    const { copy, download } = diffManifests(baseManifest, manifest);
    const downloadWithUrls: OtaDeltaDownload[] = download.map((d) => ({
      ...d,
      url: `${opts.baseUrl}/bundles/${opts.bundleName}/${targetVersion}/files/${d.hash}`,
    }));
    // Delta is an optimization, not a requirement — #556 closes the hole in the #550
    // quarantine ruling: a delta-staged bundle's `copy` entries are taken byte-for-byte
    // off disk and hashed by nobody, so "re-staging would fetch identical broken bytes"
    // (true for a whole-zip download) does NOT hold here — a locally corrupt base file
    // can make native's own whole-tree verification (definitions.ts) throw even though
    // the PUBLISHED bytes are perfectly good. Falling through to a whole-zip stage rather
    // than failing the update outright means a bad local copy on this one device never
    // blocks a good published version — same "optimization, not requirement" contract the
    // base-manifest fetch above already has.
    let deltaStaged = false;
    try {
      await opts.native.stageUpdateDelta({
        name: opts.bundleName,
        version: targetVersion,
        baseVersion,
        copy,
        download: downloadWithUrls,
        files,
      });
      deltaStaged = true;
    } catch (err) {
      // Reported, not swallowed — see `onDeltaFallback`.
      opts.onDeltaFallback?.({ version: targetVersion, reason: err instanceof Error ? err.message : String(err) });
      // fall through to whole-zip below
    }
    if (deltaStaged) {
      // Deliberately OUTSIDE the try above: an `activate` failure is not a STAGING failure.
      // Inside it, a failed activate would fall through and re-download the whole bundle for
      // a version that had already staged correctly — and the retry would hit the same
      // activate again anyway.
      await opts.native.activate({ name: opts.bundleName, version: targetVersion });
      return { outcome: 'staged', version: targetVersion, delta: true, mandatory: release.mandatory };
    }
  }

  if (!manifest.bundleZip) return { outcome: 'no-bundle-zip-in-manifest' };

  // No fallback here, deliberately: a whole-zip staging failure must reject and leave
  // `activate()` uncalled — nothing staged, nothing activated, device stays on its
  // working bundle. This is the caller's LAST resort; there is nowhere further to fall.
  await opts.native.stageUpdate({
    name: opts.bundleName,
    version: targetVersion,
    zipUrl: `${opts.baseUrl}/bundles/${opts.bundleName}/${targetVersion}/bundle.zip`,
    expectedZipHash: manifest.bundleZip.hash,
    expectedZipSize: manifest.bundleZip.size,
    files,
  });
  await opts.native.activate({ name: opts.bundleName, version: targetVersion });

  return { outcome: 'staged', version: targetVersion, mandatory: release.mandatory };
}

/** Fetches + validates a bundle's manifest.json, returning null (never throwing) on any
 *  failure — used for the delta path's BASE manifest, where failure means "fall back to
 *  whole-zip", not "fail the update".
 *
 *  Deliberately UNVERIFIED against `release.manifests` (unlike the TARGET manifest in
 *  `checkForUpdate` above): the signed release only commits to the CURRENT version's
 *  manifest, and this function (and {@link tryFetchEmbeddedManifest}) supply the delta
 *  BASE — either an older already-active version, or the manifest shipped inside the app
 *  binary itself. A lying/tampered base manifest cannot forge the update's contents:
 *  native verifies the whole staged tree against `files`, which is built from the
 *  now-authenticated TARGET manifest. A bad base can only make that whole-tree
 *  verification fail and fall back to the whole-zip path (see #556) — not an integrity
 *  hole, just a wasted delta.
 *
 *  ⚠️ That "cannot forge contents" guarantee holds ONLY on a device whose native plugin is
 *  #556-or-later. `OtaPlugin.swift`'s `stageUpdate` and `OtaPlugin.java`'s counterpart both
 *  SKIP the staged-tree-vs-`files` verification entirely when `files` is absent from the
 *  call (logging a loud warning and proceeding exactly as pre-#556 code did) — that's a
 *  deliberate compatibility fallback for a caller built before #556, not a bug. But native
 *  plugin code cannot itself be OTA-updated: an app installed with an older plugin binary
 *  keeps running that older plugin FOREVER, regardless of how many JS-side OTA updates it
 *  applies. So on such an already-installed app, a tampered/lying base manifest CAN still
 *  force a stale local file to be copied into the new staged tree completely unverified —
 *  the "native verifies the whole tree" backstop above simply isn't there to catch it. */
async function tryFetchManifest(
  doFetch: typeof fetch,
  baseUrl: string,
  bundleName: string,
  version: string,
): Promise<OtaManifest | null> {
  try {
    const res = await doFetch(`${baseUrl}/bundles/${bundleName}/${version}/manifest.json`);
    if (!res.ok) return null;
    const manifest = await res.json();
    if (validateManifest(manifest).length > 0) return null;
    return manifest as OtaManifest;
  } catch {
    return null;
  }
}

/** Same contract as {@link tryFetchManifest}, but for the EMBEDDED bundle's manifest — a
 *  bare relative URL fetched against the app's own served origin, never `baseUrl` (the
 *  CDN). Missing/invalid is expected and silent for any build that predates this
 *  feature — not an error. */
async function tryFetchEmbeddedManifest(doFetch: typeof fetch, embeddedManifestUrl: string): Promise<OtaManifest | null> {
  try {
    const res = await doFetch(embeddedManifestUrl);
    if (!res.ok) return null;
    const manifest = await res.json();
    if (validateManifest(manifest).length > 0) return null;
    return manifest as OtaManifest;
  } catch {
    return null;
  }
}

interface NativeState {
  active?: Record<string, string>;
  pending?: Record<string, string>;
  /** Phase 3a quarantine — versions this device proved bad. Absent on a state.json
   *  written by a Phase 1/2 binary, hence optional. */
  rejected?: Record<string, string[]>;
  /** Per-bundle launch count since a pending version was last SERVED. `activate()` clears
   *  this when it writes `pending` (staging), and the native boot hook increments it when
   *  it actually serves the pending bundle, before the WebView loads — so 0/absent means
   *  "staged, never run" and >= 1 means "we are running the pending version right now".
   *  The discriminator that distinguishes those two `pending === target` cases below. */
  bootAttempts?: Record<string, number>;
  /** #571 anti-rollback — the highest release `seq` this device has ever recorded, a
   *  single device-wide counter (not per-bundle: it is a property of `release.json` as a
   *  whole, one publish counter shared by every bundle it lists). Absent on a state.json
   *  written by a pre-#571 binary, hence optional; treated as `0`. */
  highestSeenSeq?: number;
}

function parseNativeState(json: string): NativeState | null {
  if (!json || json === 'null') return null;
  try {
    return JSON.parse(json) as NativeState;
  } catch {
    return null;
  }
}
