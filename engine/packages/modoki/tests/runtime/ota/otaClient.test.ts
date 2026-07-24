/** OTA update client (docs/plans/mobile-ota-updates-plan.md, Phase 1). */
import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  checkForUpdate,
  validateManifest,
  validateRelease,
  verifyReleaseSignature,
  type OtaManifest,
  type OtaNativePlugin,
  type OtaRelease,
} from '../../../src/runtime/ota/otaClient';

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function makeKeypair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey: toBase64url(publicKey) };
}

function signRelease(unsigned: Omit<OtaRelease, 'sig'>, privateKey: Uint8Array): OtaRelease {
  // Mirrors signingPayload's sorted-key canonical JSON, done inline so the test doesn't
  // depend on the module's internal (non-exported) sortKeysDeep helper.
  const sorted = { bundles: unsigned.bundles, mandatory: unsigned.mandatory, minEngineApi: unsigned.minEngineApi, schema: unsigned.schema };
  const payload = new TextEncoder().encode(JSON.stringify(sorted));
  const sig = ed25519.sign(payload, privateKey);
  return { ...unsigned, sig: toBase64url(sig) };
}

describe('validateManifest (TS port parity)', () => {
  it('accepts a well-formed manifest with an optional bundleZip', () => {
    const manifest: OtaManifest = {
      schema: 1,
      name: 'shell',
      version: 'v1',
      engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 2 },
    };
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('rejects a malformed bundleZip', () => {
    const manifest = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: {}, bundleZip: { hash: 'not-hex', size: 1 } };
    expect(validateManifest(manifest).some((e) => e.includes('bundleZip'))).toBe(true);
  });

  it('rejects a path escaping the bundle root', () => {
    const manifest = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: { '../etc/passwd': { hash: 'a'.repeat(64), size: 1 } } };
    expect(validateManifest(manifest).some((e) => e.includes('..'))).toBe(true);
  });
});

describe('validateRelease (TS port parity)', () => {
  it('rejects a missing sig', () => {
    const release = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 };
    expect(validateRelease(release).some((e) => e.includes('sig'))).toBe(true);
  });
});

describe('verifyReleaseSignature', () => {
  it('verifies a signature from the matching key', () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    expect(verifyReleaseSignature(release, publicKey)).toBe(true);
  });

  it('rejects a signature against the wrong key', () => {
    const { privateKey } = makeKeypair();
    const attacker = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    expect(verifyReleaseSignature(release, attacker.publicKey)).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const tampered = { ...release, bundles: { shell: 'v2' } };
    expect(verifyReleaseSignature(tampered, publicKey)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyReleaseSignature({ sig: '' } as OtaRelease, 'x')).toBe(false);
    expect(verifyReleaseSignature({ sig: '!!!not-base64!!!' } as OtaRelease, 'also-not-base64')).toBe(false);
    expect(verifyReleaseSignature(null as unknown as OtaRelease, 'x')).toBe(false);
  });
});

function mockNative(overrides: Partial<OtaNativePlugin> = {}): OtaNativePlugin {
  return {
    stageUpdate: vi.fn().mockResolvedValue({ ok: true }),
    activate: vi.fn().mockResolvedValue({ ok: true }),
    getState: vi.fn().mockResolvedValue({ stateJSON: 'null' }),
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('checkForUpdate', () => {
  it('stages an update when the release names a newer version than active', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const manifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(manifest));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) });

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'staged', version: 'v2' });
    expect(native.stageUpdate).toHaveBeenCalledWith({
      name: 'shell', version: 'v2',
      zipUrl: 'https://cdn.example.com/game/bundles/shell/v2/bundle.zip',
      expectedZipHash: 'b'.repeat(64), expectedZipSize: 100,
    });
    expect(native.activate).toHaveBeenCalledWith({ name: 'shell', version: 'v2' });
  });

  it('reports up-to-date without fetching a manifest when active already matches', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'up-to-date' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never fetched a manifest
    expect(native.stageUpdate).not.toHaveBeenCalled();
  });

  it('reports up-to-date when the target version is already pending (avoids re-downloading mid-attempt)', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, pending: { shell: 'v2' } }) }) });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'up-to-date' });
  });

  it('rejects a release with an invalid signature and never stages anything', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const attackerKeypair = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, attackerKeypair.privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative();
    void privateKey;

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'signature-invalid' });
    expect(native.stageUpdate).not.toHaveBeenCalled();
  });

  it('refuses a manifest that requires a newer engine API than is running', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const manifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 5,
      files: {}, bundleZip: { hash: 'a'.repeat(64), size: 1 },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release)).mockResolvedValueOnce(jsonResponse(manifest));
    const native = mockNative();

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 2, fetchImpl, native });

    expect(result).toEqual({ outcome: 'engine-api-too-old', required: 5, running: 2 });
    expect(native.stageUpdate).not.toHaveBeenCalled();
  });

  it('reports no-release-for-bundle when the release has no entry for this bundle', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { sling: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative();

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'no-release-for-bundle' });
  });

  it('never throws when release.json fails to fetch (network down)', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('network down'));
    const native = mockNative();
    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey: 'x', bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'no-release-for-bundle' });
  });

  it('refuses a manifest missing bundleZip rather than staging with no download target', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const manifest = { schema: 1, name: 'shell', version: 'v2', engineApi: 1, files: {} }; // no bundleZip
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release)).mockResolvedValueOnce(jsonResponse(manifest));
    const native = mockNative();

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'no-bundle-zip-in-manifest' });
    expect(native.stageUpdate).not.toHaveBeenCalled();
  });
});
