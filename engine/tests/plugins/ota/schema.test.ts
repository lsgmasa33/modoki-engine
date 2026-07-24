/** OTA publish-format schema (docs/plans/mobile-ota-updates-plan.md, Phase 0).
 *  Pure validation/assembly logic — no fs/crypto involved. */
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  createManifest,
  createRelease,
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
