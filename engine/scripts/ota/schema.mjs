/** OTA publish-format schema (Phase 0 of docs/plans/mobile-ota-updates-plan.md).
 *
 *  Two JSON documents make up a release:
 *   - a per-bundle `manifest.json` (one per {name, version}) — the file list a
 *     bundle is made of, each entry content-hashed for delta + integrity.
 *   - a single signed `release.json` — which bundle version is CURRENT per
 *     name, plus the `mandatory` flag and the minimum engine API the bundles
 *     require.
 *
 *  Pure data + validation only (no Node/crypto/fs here) so this module is safe
 *  to share with a future browser-side OTA client (Phase 1) without dragging
 *  in Node built-ins. Signing lives in ./signing.mjs (Node-only); hashing a
 *  dist tree lives in ./buildManifest.mjs (Node-only, fs).
 *
 *  KEEP IN SYNC with engine/packages/modoki/src/runtime/ota/otaClient.ts's TS port of
 *  SCHEMA_VERSION/validateManifest/validateRelease/signingPayload. That's a port, not an
 *  import of this file, because @modoki/engine ships standalone and must not reach
 *  outside its own src/ into this Node-only dev-tooling directory (same class of
 *  exception CLAUDE.md documents for engine/scripts/projectRoots.mjs's two consumers). */

export const SCHEMA_VERSION = 1;

/** Validates a bundle manifest shape, returning a list of error strings (empty
 *  = valid). Never throws — callers decide whether to treat errors as fatal. */
export function validateManifest(manifest) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (manifest == null || typeof manifest !== 'object') {
    return ['manifest must be an object'];
  }
  if (manifest.schema !== SCHEMA_VERSION) fail(`manifest.schema must be ${SCHEMA_VERSION}, got ${manifest.schema}`);
  if (typeof manifest.name !== 'string' || !manifest.name) fail('manifest.name must be a non-empty string');
  if (typeof manifest.version !== 'string' || !manifest.version) fail('manifest.version must be a non-empty string');
  if (typeof manifest.engineApi !== 'number' || !Number.isInteger(manifest.engineApi) || manifest.engineApi < 1) {
    fail('manifest.engineApi must be a positive integer');
  }
  if (manifest.files == null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    fail('manifest.files must be an object keyed by relative file path');
  } else {
    for (const [filePath, entry] of Object.entries(manifest.files)) {
      if (!filePath || filePath.startsWith('/') || filePath.includes('..')) {
        fail(`manifest.files key "${filePath}" must be a relative path with no ".." segments`);
      }
      if (entry == null || typeof entry !== 'object') {
        fail(`manifest.files["${filePath}"] must be an object`);
        continue;
      }
      if (typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash)) {
        fail(`manifest.files["${filePath}"].hash must be a lowercase hex sha256 (64 chars)`);
      }
      if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) {
        fail(`manifest.files["${filePath}"].size must be a non-negative integer`);
      }
    }
  }
  // Optional (Phase 1 addition, additive — a Phase 0 manifest without it stays valid):
  // the whole-bundle zip the native OTA client downloads directly, so it never has to
  // fetch each content-addressed file individually over the JS bridge. Per-file hashes
  // above remain the delta key (Phase 2); this is a convenience artifact alongside them.
  if (manifest.bundleZip !== undefined) {
    const z = manifest.bundleZip;
    if (z == null || typeof z !== 'object') fail('manifest.bundleZip must be an object when present');
    else {
      if (typeof z.hash !== 'string' || !/^[0-9a-f]{64}$/.test(z.hash)) fail('manifest.bundleZip.hash must be a lowercase hex sha256 (64 chars)');
      if (typeof z.size !== 'number' || !Number.isInteger(z.size) || z.size < 0) fail('manifest.bundleZip.size must be a non-negative integer');
    }
  }
  return errors;
}

/** Validates a release document's shape (pre-signature-check structural
 *  validity only — see ./signing.mjs for verifying `sig`). */
export function validateRelease(release) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (release == null || typeof release !== 'object') {
    return ['release must be an object'];
  }
  if (release.schema !== SCHEMA_VERSION) fail(`release.schema must be ${SCHEMA_VERSION}, got ${release.schema}`);
  if (release.bundles == null || typeof release.bundles !== 'object' || Array.isArray(release.bundles)) {
    fail('release.bundles must be an object keyed by bundle name');
  } else {
    for (const [name, version] of Object.entries(release.bundles)) {
      if (typeof version !== 'string' || !version) fail(`release.bundles["${name}"] must be a non-empty version string`);
    }
  }
  if (typeof release.mandatory !== 'boolean') fail('release.mandatory must be a boolean');
  if (typeof release.minEngineApi !== 'number' || !Number.isInteger(release.minEngineApi) || release.minEngineApi < 1) {
    fail('release.minEngineApi must be a positive integer');
  }
  if (typeof release.sig !== 'string' || !release.sig) fail('release.sig must be a non-empty string (base64url Ed25519 signature)');
  return errors;
}

/** Builds a manifest object from a name/version/engineApi + a files map
 *  (relative path → {hash, size}), stamping the current schema version. Pure
 *  assembly — callers compute the hashes (see ./buildManifest.mjs). */
export function createManifest({ name, version, engineApi, files, bundleZip }) {
  const manifest = { schema: SCHEMA_VERSION, name, version, engineApi, files };
  if (bundleZip) manifest.bundleZip = bundleZip;
  return manifest;
}

/** Builds an UNSIGNED release object (no `sig` field yet — ./signing.mjs adds
 *  it over this object's canonical JSON, see signingPayload below). */
export function createRelease({ bundles, mandatory, minEngineApi }) {
  return { schema: SCHEMA_VERSION, bundles, mandatory, minEngineApi };
}

/** The exact byte sequence that gets signed / verified for a release: every
 *  field EXCEPT `sig`, with object keys sorted so the signature is stable
 *  regardless of insertion order. Both signing.mjs and a future verifying
 *  client MUST use this — any other serialization produces a different
 *  signature for logically-identical data. */
export function signingPayload(release) {
  const { sig: _sig, ...unsigned } = release;
  return JSON.stringify(sortKeysDeep(unsigned));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}
