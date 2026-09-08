/** Canonicalization PARITY between the two `manifestHashPayload`/`signingPayload`/
 *  `sortKeysDeep` implementations (docs/ota-updates.md).
 *
 *  There are two of these functions — one in `engine/scripts/ota/schema.mjs` (Node-only,
 *  used by `ota-publish.mjs` to hash manifests and sign releases) and one ported to TS in
 *  `engine/packages/modoki/src/runtime/ota/otaClient.ts` (ships in `@modoki/engine`, runs on
 *  device to verify what the first one produced). They are a deliberate MANUAL PORT, not a
 *  shared import — `otaClient.ts` must not reach outside its own `src/` into
 *  `engine/scripts/`, a Node-only dev-tooling directory that isn't part of the published
 *  package (see the "KEEP IN SYNC" comment at the top of each file). Nothing enforces that
 *  the port stays byte-for-byte faithful except a human re-reading both files on every
 *  future edit.
 *
 *  A silent divergence between them is FAIL-CLOSED, not a crash: the client hashes a
 *  manifest with ITS OWN canonicalization and compares against `release.manifests[name]`,
 *  which was produced by the SERVER's canonicalization. If the two ever disagree on any
 *  input actually seen in production — a key order, an escaped character, a nesting shape —
 *  every device downloading that manifest gets `manifest-untrusted` forever (see
 *  `checkForUpdate`'s outcome of that name), and it looks like server-side corruption, not a
 *  client bug. `otaClient.test.ts` and `schema.test.ts` each test their OWN implementation
 *  against itself; neither one can catch the two drifting apart. This file is the only test
 *  in the suite that imports both implementations side by side and asserts they still agree
 *  — it exists specifically to catch a one-sided edit that would otherwise pass
 *  `npm run verify` while bricking OTA updates in the field. */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  manifestHashPayload as manifestHashPayloadJs,
  signingPayload as signingPayloadJs,
  SCHEMA_VERSION as SCHEMA_VERSION_JS,
  validateManifest as validateManifestJs,
  validateRelease as validateReleaseJs,
} from '../../../scripts/ota/schema.mjs';
import {
  manifestHashPayload as manifestHashPayloadTs,
  signingPayload as signingPayloadTs,
  sha256Hex,
  SCHEMA_VERSION as SCHEMA_VERSION_TS,
  validateManifest as validateManifestTs,
  validateRelease as validateReleaseTs,
  type OtaManifest,
  type OtaRelease,
} from '../../../packages/modoki/src/runtime/ota/otaClient';

describe('OTA canonicalization parity: manifestHashPayload', () => {
  it('agrees byte-for-byte on a realistic full manifest with a nested files map + bundleZip', () => {
    const manifest: OtaManifest = {
      schema: 1,
      name: 'shell',
      version: 'v13',
      engineApi: 2,
      files: {
        'index.html': { hash: 'a'.repeat(64), size: 512 },
        'assets/app.js': { hash: 'b'.repeat(64), size: 204800 },
        'assets/app.css': { hash: 'c'.repeat(64), size: 4096 },
        'assets/logo.png': { hash: 'd'.repeat(64), size: 32768 },
      },
      bundleZip: { hash: 'e'.repeat(64), size: 241664 },
    };
    expect(manifestHashPayloadJs(manifest)).toBe(manifestHashPayloadTs(manifest));
  });

  it('agrees byte-for-byte regardless of top-level and nested key insertion order', () => {
    const a: OtaManifest = {
      schema: 1,
      name: 'shell',
      version: 'v13',
      engineApi: 2,
      files: {
        'index.html': { hash: 'a'.repeat(64), size: 512 },
        'assets/app.js': { hash: 'b'.repeat(64), size: 204800 },
      },
      bundleZip: { hash: 'e'.repeat(64), size: 241664 },
    };
    // Same data, shuffled at every level: manifest keys, files keys, and each file
    // entry's own keys.
    const b = {
      bundleZip: { size: 241664, hash: 'e'.repeat(64) },
      files: {
        'assets/app.js': { size: 204800, hash: 'b'.repeat(64) },
        'index.html': { size: 512, hash: 'a'.repeat(64) },
      },
      version: 'v13',
      engineApi: 2,
      name: 'shell',
      schema: 1,
    } as unknown as OtaManifest;
    expect(manifestHashPayloadJs(a)).toBe(manifestHashPayloadJs(b));
    expect(manifestHashPayloadTs(a)).toBe(manifestHashPayloadTs(b));
    expect(manifestHashPayloadJs(a)).toBe(manifestHashPayloadTs(a));
    expect(manifestHashPayloadJs(b)).toBe(manifestHashPayloadTs(b));
  });

  it('agrees byte-for-byte on non-ASCII and escape-sensitive file paths', () => {
    const manifest: OtaManifest = {
      schema: 1,
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: {
        'assets/日本語.png': { hash: 'a'.repeat(64), size: 1 },
        'assets/a"b.png': { hash: 'b'.repeat(64), size: 2 },
        'assets/emoji-🎮.png': { hash: 'c'.repeat(64), size: 3 },
      },
    };
    expect(manifestHashPayloadJs(manifest)).toBe(manifestHashPayloadTs(manifest));
  });

  it('agrees byte-for-byte on a key set that discriminates codepoint sort from locale sort', () => {
    // Mutation testing on the original fixtures caught a reversed sort, no sort at all, no
    // array recursion, a dropped `null`, and the __proto__ regression below — but NOT
    // `.sort()` mutated to `.sort((a, b) => a.localeCompare(b))`, because every fixture key
    // above happens to sort identically under both comparators. Real dist/ manifests don't:
    // codepoint order (what `.sort()` with no comparator does, and what BOTH ports must
    // use) puts underscore/uppercase before lowercase before nothing-special
    // (`_headers` < `assets/App.js` < `assets/Logo.png` < `assets/app.js` < `index.html`
    //  < `README.md`), while `localeCompare` reorders case-insensitively and treats
    // "README.md" as sorting near the top. A one-sided "tidy up the sort" edit on just one
    // port would still pass every OTHER case here and ship green — this fixture is the one
    // that would catch it. Do not "simplify" this key set; the mix of case and a
    // digit-leading path is the point.
    const manifest: OtaManifest = {
      schema: 1,
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: {
        'README.md': { hash: 'a'.repeat(64), size: 1 },
        '_headers': { hash: 'b'.repeat(64), size: 2 },
        'assets/App.js': { hash: 'c'.repeat(64), size: 3 },
        'assets/app.js': { hash: 'd'.repeat(64), size: 4 },
        'assets/Logo.png': { hash: 'e'.repeat(64), size: 5 },
        'index.html': { hash: 'f'.repeat(64), size: 6 },
        'assets/2x/icon.png': { hash: '0'.repeat(64), size: 7 },
      },
    };
    expect(manifestHashPayloadJs(manifest)).toBe(manifestHashPayloadTs(manifest));
  });

  it('agrees byte-for-byte on deeply nested objects and array-containing values', () => {
    // manifest.files entries don't naturally nest this deep or hold arrays, but
    // sortKeysDeep is generic recursion — exercise it directly through a manifest shape
    // that carries extra, non-schema fields (both implementations canonicalize whatever
    // object they're handed, not just the fields validateManifest checks).
    const manifest = {
      schema: 1,
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: { 'a.js': { hash: 'a'.repeat(64), size: 1 } },
      extra: {
        nested: {
          deeper: {
            list: [3, 1, { z: 1, a: 2 }, [9, 8, 7]],
            tags: ['b', 'a', 'c'],
          },
          value: null,
        },
      },
    } as unknown as OtaManifest;
    expect(manifestHashPayloadJs(manifest)).toBe(manifestHashPayloadTs(manifest));
  });
});

describe('OTA canonicalization parity: signingPayload', () => {
  it('agrees byte-for-byte on a release with manifests present', () => {
    const release: OtaRelease = {
      schema: 1,
      bundles: { shell: 'v13', sling: 'v4' },
      mandatory: true,
      minEngineApi: 2,
      manifests: { shell: 'a'.repeat(64), sling: 'b'.repeat(64) },
      sig: 'not-checked-here',
    };
    expect(signingPayloadJs(release)).toBe(signingPayloadTs(release));
  });

  it('agrees byte-for-byte on a release WITHOUT manifests', () => {
    const release: OtaRelease = {
      schema: 1,
      bundles: { shell: 'v13' },
      mandatory: false,
      minEngineApi: 1,
      sig: 'not-checked-here',
    };
    expect(signingPayloadJs(release)).toBe(signingPayloadTs(release));
  });

  it('agrees byte-for-byte when manifests keys are ordered differently', () => {
    const a: OtaRelease = {
      schema: 1,
      bundles: { shell: 'v13', sling: 'v4' },
      mandatory: false,
      minEngineApi: 1,
      manifests: { shell: 'a'.repeat(64), sling: 'b'.repeat(64) },
      sig: 'not-checked-here',
    };
    const b = {
      sig: 'not-checked-here',
      manifests: { sling: 'b'.repeat(64), shell: 'a'.repeat(64) },
      minEngineApi: 1,
      mandatory: false,
      bundles: { sling: 'v4', shell: 'v13' },
      schema: 1,
    } as unknown as OtaRelease;
    expect(signingPayloadJs(a)).toBe(signingPayloadJs(b));
    expect(signingPayloadTs(a)).toBe(signingPayloadTs(b));
    expect(signingPayloadJs(a)).toBe(signingPayloadTs(a));
    expect(signingPayloadJs(b)).toBe(signingPayloadTs(b));
  });
});

describe('OTA canonicalization parity: __proto__ handling (regression)', () => {
  // sortKeysDeep in BOTH ports used to build its sorted copy as a plain object literal
  // (`{}`), whose `__proto__` is an ACCESSOR inherited from Object.prototype — assigning
  // through it silently mutated the copy's own prototype instead of storing an own
  // property, so a top-level `__proto__` key vanished from the canonical output entirely.
  // That let a document WITH a `__proto__` key and the otherwise-identical document
  // WITHOUT one canonicalize to the SAME string. Both ports now use a null-prototype
  // object for the sorted copy, so the two must (a) still agree with each other on both
  // variants and (b) actually produce DIFFERENT output for the two variants.
  const withProtoKey = JSON.parse(
    '{"schema":1,"name":"shell","version":"v1","engineApi":1,"files":{},"__proto__":{"evil":1}}',
  ) as OtaManifest;
  const withoutProtoKey: OtaManifest = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: {} };

  it('both ports agree with each other on the variant WITH a __proto__ key', () => {
    expect(manifestHashPayloadJs(withProtoKey)).toBe(manifestHashPayloadTs(withProtoKey));
  });

  it('both ports agree with each other on the variant WITHOUT a __proto__ key', () => {
    expect(manifestHashPayloadJs(withoutProtoKey)).toBe(manifestHashPayloadTs(withoutProtoKey));
  });

  it('both ports produce DIFFERENT output for the two variants (the __proto__ key is no longer swallowed)', () => {
    expect(manifestHashPayloadJs(withProtoKey)).not.toBe(manifestHashPayloadJs(withoutProtoKey));
    expect(manifestHashPayloadTs(withProtoKey)).not.toBe(manifestHashPayloadTs(withoutProtoKey));
  });
});

describe('OTA canonicalization parity: the hash-chain joint (Node createHash vs client sha256Hex)', () => {
  // Everything above proves the two `manifestHashPayload`/`signingPayload` STRING
  // implementations agree. But `ota-publish.mjs` hashes that string with Node's
  // `createHash('sha256').update(payload, 'utf8')`, while `otaClient.ts`'s `checkForUpdate`
  // hashes it with `sha256(new TextEncoder().encode(payload))` (@noble/hashes) — a
  // DIFFERENT hashing implementation on each side of the SAME joint the rest of this file
  // covers only up to the payload string. If these two ever disagreed (a UTF-8 encoding
  // edge case, a library bug), every device would get `manifest-untrusted` even with a
  // byte-identical payload string on both sides. `sha256Hex` is exported from otaClient.ts
  // specifically so this test can exercise the REAL client code path rather than
  // duplicating its hashing logic here.
  function nodeSha256Hex(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
  }

  it('agrees on a plain ASCII payload', () => {
    const payload = manifestHashPayloadJs({
      schema: 1,
      name: 'shell',
      version: 'v13',
      engineApi: 2,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 512 } },
    });
    expect(sha256Hex(payload)).toBe(nodeSha256Hex(payload));
  });

  it('agrees on non-ASCII, an astral-plane emoji, and an embedded escaped quote', () => {
    const manifest = {
      schema: 1,
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: {
        'assets/日本語.png': { hash: 'a'.repeat(64), size: 1 },
        'assets/emoji-🎮.png': { hash: 'b'.repeat(64), size: 2 },
        'assets/a"b.png': { hash: 'c'.repeat(64), size: 3 },
      },
    } as unknown as OtaManifest;
    const payload = manifestHashPayloadJs(manifest);
    expect(sha256Hex(payload)).toBe(nodeSha256Hex(payload));
  });
});

/** #629 — `SCHEMA_VERSION` lives as two separately-bumped constants (one per
 *  implementation, same "keep in sync" reasoning as the canonicalization functions above:
 *  `otaClient.ts` ships in `@modoki/engine` and must not reach outside its own `src/` into
 *  `engine/scripts/`, a Node-only dev-tooling dir). Prose ("KEEP IN SYNC with...") kept
 *  these in agreement until now — nothing re-checked it on an edit. This converts that
 *  banner into a mechanism: a value bump on one side with none on the other fails HERE,
 *  not in the field as every device's manifest/release getting refused as `schema` mismatch. */
describe('OTA schema-version + validator gate parity (#629)', () => {
  it('SCHEMA_VERSION agrees between the two implementations', () => {
    expect(SCHEMA_VERSION_JS).toBe(SCHEMA_VERSION_TS);
  });

  it.each([SCHEMA_VERSION_TS - 1, SCHEMA_VERSION_TS, SCHEMA_VERSION_TS + 1])(
    'validateManifest and validateRelease AGREE on acceptance at schema %d',
    (schema) => {
      const manifest = {
        schema,
        name: 'shell',
        version: 'v1',
        engineApi: 1,
        files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      };
      const release = {
        schema,
        bundles: { shell: 'v1' },
        mandatory: false,
        minEngineApi: 1,
        sig: 'x'.repeat(16),
      };

      const manifestAcceptedJs = validateManifestJs(manifest).length === 0;
      const manifestAcceptedTs = validateManifestTs(manifest).length === 0;
      expect(manifestAcceptedTs).toBe(manifestAcceptedJs);

      const releaseAcceptedJs = validateReleaseJs(release).length === 0;
      const releaseAcceptedTs = validateReleaseTs(release).length === 0;
      expect(releaseAcceptedTs).toBe(releaseAcceptedJs);
    },
  );
});
