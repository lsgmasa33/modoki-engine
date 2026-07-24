/** OTA update client (docs/plans/mobile-ota-updates-plan.md, Phase 1) — the trusted,
 *  ALREADY-RUNNING shell JS's half of the update flow: fetch `release.json` + a bundle's
 *  `manifest.json` over plain `fetch()`, verify the release's Ed25519 signature, and hand
 *  off to the native plugin (`ModokiOta`) for the actual byte-moving (download the zip
 *  directly, verify its SHA-256, unzip, stage) — see the plan doc for why that part must
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

/** The native plugin surface this client depends on — a structural (not nominal) type so
 *  tests can pass a plain mock without importing `@capacitor/core`. */
export interface OtaNativePlugin {
  stageUpdate(opts: { name: string; version: string; zipUrl: string; expectedZipHash: string; expectedZipSize: number }): Promise<{ ok: boolean }>;
  activate(opts: { name: string; version: string }): Promise<{ ok: boolean }>;
  getState(): Promise<{ stateJSON: string }>;
}

export type OtaCheckResult =
  | { outcome: 'up-to-date' }
  | { outcome: 'no-release-for-bundle' }
  | { outcome: 'signature-invalid' }
  | { outcome: 'engine-api-too-old'; required: number; running: number }
  | { outcome: 'manifest-invalid'; errors: string[] }
  | { outcome: 'no-bundle-zip-in-manifest' }
  | { outcome: 'staged'; version: string };

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
  fetchImpl?: typeof fetch;
  native: OtaNativePlugin;
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
  if (!manifest.bundleZip) return { outcome: 'no-bundle-zip-in-manifest' };

  await opts.native.stageUpdate({
    name: opts.bundleName,
    version: targetVersion,
    zipUrl: `${opts.baseUrl}/bundles/${opts.bundleName}/${targetVersion}/bundle.zip`,
    expectedZipHash: manifest.bundleZip.hash,
    expectedZipSize: manifest.bundleZip.size,
  });
  await opts.native.activate({ name: opts.bundleName, version: targetVersion });

  return { outcome: 'staged', version: targetVersion };
}

interface NativeState {
  active?: Record<string, string>;
  pending?: Record<string, string>;
}

function parseNativeState(json: string): NativeState | null {
  if (!json || json === 'null') return null;
  try {
    return JSON.parse(json) as NativeState;
  } catch {
    return null;
  }
}
