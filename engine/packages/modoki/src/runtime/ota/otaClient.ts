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
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
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
export interface OtaNativePlugin {
  stageUpdate(opts: { name: string; version: string; zipUrl: string; expectedZipHash: string; expectedZipSize: number }): Promise<{ ok: boolean }>;
  /** Phase 2 delta staging: copy `copy` (unchanged relative paths) from the
   *  already-on-disk `baseVersion` folder, download only `download` (new/changed files,
   *  each independently hash-verified) into the new `version` folder. Native must refuse
   *  to activate a folder built this way if any copy source is missing (self-heal to
   *  `stageUpdate`'s whole-zip path is the CALLER's job, not native's — see
   *  `checkForUpdate`'s fallback). */
  stageUpdateDelta(opts: { name: string; version: string; baseVersion: string; copy: string[]; download: OtaDeltaDownload[] }): Promise<{ ok: boolean }>;
  activate(opts: { name: string; version: string }): Promise<{ ok: boolean }>;
  getState(): Promise<{ stateJSON: string }>;
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
  | { outcome: 'no-bundle-zip-in-manifest' }
  /** The release's target version is one this device already PROVED bad — it exhausted
   *  its boot attempts and the watchdog reverted it (Phase 3a quarantine). Staging it
   *  again would re-enter the crash-loop → revert → re-stage cycle forever, so we refuse.
   *  Recovery is fix-forward only: publish a NEW version. A blocking/mandatory gate MUST
   *  treat this as "no update available" and let the player keep playing the working
   *  bundle — blocking here is what turns a stale app into a permanent brick. */
  | { outcome: 'version-rejected'; version: string }
  | { outcome: 'staged'; version: string; delta?: boolean; mandatory: boolean };

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
  const currentActive = state?.active?.[opts.bundleName];
  const currentPending = state?.pending?.[opts.bundleName];
  if (currentActive === targetVersion || currentPending === targetVersion) {
    return { outcome: 'up-to-date' };
  }

  // Quarantine gate (Phase 3a). Checked AFTER the up-to-date short-circuit above, so a
  // version that somehow reached `active` despite being listed still reports up-to-date —
  // `rejected` vetoes STAGING, never a bundle that is already booting fine (mirrors
  // OtaCore's boot-side rule; see ota-gate-vectors-phase3.json).
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
  if (manifest.engineApi > opts.runningEngineApi) {
    return { outcome: 'engine-api-too-old', required: manifest.engineApi, running: opts.runningEngineApi };
  }

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
    await opts.native.stageUpdateDelta({
      name: opts.bundleName,
      version: targetVersion,
      baseVersion,
      copy,
      download: downloadWithUrls,
    });
    await opts.native.activate({ name: opts.bundleName, version: targetVersion });
    return { outcome: 'staged', version: targetVersion, delta: true, mandatory: release.mandatory };
  }

  if (!manifest.bundleZip) return { outcome: 'no-bundle-zip-in-manifest' };

  await opts.native.stageUpdate({
    name: opts.bundleName,
    version: targetVersion,
    zipUrl: `${opts.baseUrl}/bundles/${opts.bundleName}/${targetVersion}/bundle.zip`,
    expectedZipHash: manifest.bundleZip.hash,
    expectedZipSize: manifest.bundleZip.size,
  });
  await opts.native.activate({ name: opts.bundleName, version: targetVersion });

  return { outcome: 'staged', version: targetVersion, mandatory: release.mandatory };
}

/** Fetches + validates a bundle's manifest.json, returning null (never throwing) on any
 *  failure — used for the delta path's BASE manifest, where failure means "fall back to
 *  whole-zip", not "fail the update". */
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
}

function parseNativeState(json: string): NativeState | null {
  if (!json || json === 'null') return null;
  try {
    return JSON.parse(json) as NativeState;
  } catch {
    return null;
  }
}
