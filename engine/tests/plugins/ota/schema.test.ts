/** OTA publish-format schema (docs/ota-updates.md).
 *  Pure validation/assembly logic — no fs/crypto involved. */
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  createManifest,
  createRelease,
  manifestHashPayload,
  signingPayload,
  validateManifest,
  validateRelease,
} from '../../../scripts/ota/schema.mjs';

describe('OTA schema: manifest', () => {
  it('accepts a well-formed manifest', () => {
    const manifest = createManifest({
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 123 } },
    });
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('rejects a wrong schema version', () => {
    const manifest = createManifest({ name: 'shell', version: 'v1', engineApi: 1, files: {} });
    manifest.schema = SCHEMA_VERSION + 1;
    expect(validateManifest(manifest).some((e) => e.includes('schema'))).toBe(true);
  });

  it('rejects a non-hex or wrong-length hash', () => {
    const manifest = createManifest({
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: { 'a.js': { hash: 'not-a-hash', size: 10 } },
    });
    expect(validateManifest(manifest).some((e) => e.includes('hash'))).toBe(true);
  });

  it('rejects a path escaping the bundle root', () => {
    const manifest = createManifest({
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: { '../../etc/passwd': { hash: 'a'.repeat(64), size: 1 } },
    });
    expect(validateManifest(manifest).some((e) => e.includes('..'))).toBe(true);
  });

  it('rejects a negative or non-integer size', () => {
    const manifest = createManifest({
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: { 'a.js': { hash: 'a'.repeat(64), size: -1 } },
    });
    expect(validateManifest(manifest).some((e) => e.includes('size'))).toBe(true);
  });

  it('rejects a missing/empty name or version', () => {
    expect(validateManifest(createManifest({ name: '', version: 'v1', engineApi: 1, files: {} })).length).toBeGreaterThan(0);
    expect(validateManifest(createManifest({ name: 'shell', version: '', engineApi: 1, files: {} })).length).toBeGreaterThan(0);
  });

  it('rejects a non-object manifest', () => {
    expect(validateManifest(null)).toEqual(['manifest must be an object']);
    expect(validateManifest('nope')).toEqual(['manifest must be an object']);
  });
});

describe('OTA schema: release', () => {
  const signed = () => ({ ...createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }), sig: 'x'.repeat(10) });

  it('accepts a well-formed signed release', () => {
    expect(validateRelease(signed())).toEqual([]);
  });

  it('rejects a missing sig', () => {
    const release = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 });
    expect(validateRelease(release).some((e) => e.includes('sig'))).toBe(true);
  });

  it('rejects a non-boolean mandatory flag', () => {
    const release = signed();
    (release as any).mandatory = 'yes';
    expect(validateRelease(release).some((e) => e.includes('mandatory'))).toBe(true);
  });

  it('rejects a non-string bundle version', () => {
    const release = signed();
    (release as any).bundles.shell = 42;
    expect(validateRelease(release).some((e) => e.includes('bundles'))).toBe(true);
  });

  it('accepts a release with no manifests field (back-compat)', () => {
    const release = signed();
    expect((release as any).manifests).toBeUndefined();
    expect(validateRelease(release)).toEqual([]);
  });

  it('accepts a well-formed manifests map', () => {
    const release = { ...signed(), manifests: { shell: 'a'.repeat(64) } };
    expect(validateRelease(release)).toEqual([]);
  });

  it('rejects a manifests entry that is not a lowercase hex sha256', () => {
    const release = { ...signed(), manifests: { shell: 'not-a-hash' } };
    expect(validateRelease(release).some((e) => e.includes('manifests'))).toBe(true);
  });

  it('rejects a non-object manifests field', () => {
    const release = { ...signed(), manifests: ['a'.repeat(64)] };
    expect(validateRelease(release).some((e) => e.includes('manifests'))).toBe(true);
  });
});

describe('OTA schema: signingPayload', () => {
  it('is stable regardless of key insertion order', () => {
    const a = { schema: 1, bundles: { shell: 'v1', sling: 'v2' }, mandatory: false, minEngineApi: 1 };
    const b = { mandatory: false, bundles: { sling: 'v2', shell: 'v1' }, minEngineApi: 1, schema: 1 };
    expect(signingPayload(a)).toBe(signingPayload(b));
  });

  it('excludes the sig field from the payload', () => {
    const withSig = { schema: 1, bundles: {}, mandatory: false, minEngineApi: 1, sig: 'abc' };
    const withoutSig = { schema: 1, bundles: {}, mandatory: false, minEngineApi: 1 };
    expect(signingPayload(withSig)).toBe(signingPayload(withoutSig));
  });

  it('produces a different payload when data actually differs', () => {
    const a = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 };
    const b = { schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 };
    expect(signingPayload(a)).not.toBe(signingPayload(b));
  });
});

describe('OTA schema: createRelease manifests', () => {
  it('omits manifests when not provided', () => {
    const release = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 });
    expect('manifests' in release).toBe(false);
  });

  it('omits manifests when provided but empty', () => {
    const release = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, manifests: {} });
    expect('manifests' in release).toBe(false);
  });

  it('includes manifests when non-empty', () => {
    const release = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, manifests: { shell: 'a'.repeat(64) } });
    expect(release.manifests).toEqual({ shell: 'a'.repeat(64) });
  });
});

describe('OTA schema: manifestHashPayload', () => {
  it('is stable regardless of key insertion order', () => {
    const a = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: { 'a.js': { hash: 'a'.repeat(64), size: 1 } } };
    const b = { version: 'v1', files: { 'a.js': { size: 1, hash: 'a'.repeat(64) } }, name: 'shell', engineApi: 1, schema: 1 };
    expect(manifestHashPayload(a)).toBe(manifestHashPayload(b));
  });

  it('produces a different payload when the manifest actually differs', () => {
    const a = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: {} };
    const b = { schema: 1, name: 'shell', version: 'v2', engineApi: 1, files: {} };
    expect(manifestHashPayload(a)).not.toBe(manifestHashPayload(b));
  });

  it('does NOT drop a __proto__ key from the payload (regression)', () => {
    // sortKeysDeep used to build its sorted copy as a plain object literal (`{}`), whose
    // `__proto__` is an ACCESSOR inherited from Object.prototype — assigning through it
    // (`sorted['__proto__'] = ...`) silently mutated `sorted`'s own prototype instead of
    // storing an own property, so the key vanished from JSON.stringify's output. That
    // meant this document and the otherwise-identical one below (parsed via JSON.parse,
    // so `__proto__` really is an own enumerable property on each, per the JSON spec)
    // canonicalized to the SAME string — a signature meant to vouch for one would also
    // vouch for the other. They must differ now that sortKeysDeep uses a null-prototype
    // object for its sorted copy.
    const withProtoKey = JSON.parse('{"schema":1,"name":"shell","version":"v1","engineApi":1,"files":{},"__proto__":{"evil":1}}');
    const withoutProtoKey = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: {} };
    expect(manifestHashPayload(withProtoKey)).not.toBe(manifestHashPayload(withoutProtoKey));
  });
});
