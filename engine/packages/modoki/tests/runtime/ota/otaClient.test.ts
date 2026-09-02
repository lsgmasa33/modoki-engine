/** OTA update client (docs/ota-updates.md). */
import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  checkForUpdate,
  fetchRelease,
  diffManifests,
  manifestHashPayload,
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
  // depend on the module's internal (non-exported) sortKeysDeep helper. Key order below is
  // alphabetical (bundles, mandatory, manifests, minEngineApi, schema) to match sortKeysDeep.
  const sorted: Record<string, unknown> = { bundles: unsigned.bundles, mandatory: unsigned.mandatory };
  if (unsigned.manifests !== undefined) sorted.manifests = unsigned.manifests;
  sorted.minEngineApi = unsigned.minEngineApi;
  sorted.schema = unsigned.schema;
  if (unsigned.seq !== undefined) sorted.seq = unsigned.seq;
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

  it('accepts a release with no manifests field (back-compat)', () => {
    const release = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, sig: 'x'.repeat(10) };
    expect(validateRelease(release)).toEqual([]);
  });

  it('accepts a well-formed manifests map', () => {
    const release = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, manifests: { shell: 'a'.repeat(64) }, sig: 'x'.repeat(10) };
    expect(validateRelease(release)).toEqual([]);
  });

  it('rejects a manifests entry that is not a lowercase hex sha256', () => {
    const release = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, manifests: { shell: 'not-a-hash' }, sig: 'x'.repeat(10) };
    expect(validateRelease(release).some((e) => e.includes('manifests'))).toBe(true);
  });

  it('accepts a release with no seq field (back-compat)', () => {
    const release = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, sig: 'x'.repeat(10) };
    expect(validateRelease(release)).toEqual([]);
  });

  it('accepts a non-negative integer seq', () => {
    const release = { schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, seq: 42, sig: 'x'.repeat(10) };
    expect(validateRelease(release)).toEqual([]);
  });

  it('rejects a negative or non-integer seq', () => {
    expect(validateRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, seq: -1, sig: 'x'.repeat(10) }).some((e) => e.includes('seq'))).toBe(true);
    expect(validateRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, seq: 1.5, sig: 'x'.repeat(10) }).some((e) => e.includes('seq'))).toBe(true);
  });
});

describe('manifestHashPayload (TS port parity)', () => {
  it('is stable regardless of key insertion order', () => {
    const a: OtaManifest = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: { 'a.js': { hash: 'a'.repeat(64), size: 1 } } };
    const b: OtaManifest = { version: 'v1', files: { 'a.js': { size: 1, hash: 'a'.repeat(64) } }, name: 'shell', engineApi: 1, schema: 1 };
    expect(manifestHashPayload(a)).toBe(manifestHashPayload(b));
  });

  it('produces a different payload when the manifest actually differs', () => {
    const a: OtaManifest = { schema: 1, name: 'shell', version: 'v1', engineApi: 1, files: {} };
    const b: OtaManifest = { schema: 1, name: 'shell', version: 'v2', engineApi: 1, files: {} };
    expect(manifestHashPayload(a)).not.toBe(manifestHashPayload(b));
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

describe('diffManifests (Phase 2 delta)', () => {
  function manifest(files: Record<string, { hash: string; size: number }>): OtaManifest {
    return { schema: 1, name: 'shell', version: 'vX', engineApi: 1, files };
  }

  it('copies a file unchanged when its path AND hash both match', () => {
    const current = manifest({ 'assets/a.js': { hash: 'a'.repeat(64), size: 10 } });
    const target = manifest({ 'assets/a.js': { hash: 'a'.repeat(64), size: 10 } });
    expect(diffManifests(current, target)).toEqual({ copy: ['assets/a.js'], download: [] });
  });

  it('downloads a file whose hash changed at the same path', () => {
    const current = manifest({ 'assets/a.js': { hash: 'a'.repeat(64), size: 10 } });
    const target = manifest({ 'assets/a.js': { hash: 'b'.repeat(64), size: 12 } });
    expect(diffManifests(current, target)).toEqual({
      copy: [],
      download: [{ path: 'assets/a.js', hash: 'b'.repeat(64), size: 12 }],
    });
  });

  it('downloads a file present only in target (new file)', () => {
    const current = manifest({});
    const target = manifest({ 'assets/new.js': { hash: 'c'.repeat(64), size: 5 } });
    expect(diffManifests(current, target)).toEqual({
      copy: [],
      download: [{ path: 'assets/new.js', hash: 'c'.repeat(64), size: 5 }],
    });
  });

  it('does not copy a file that only exists in current (removed in target)', () => {
    const current = manifest({ 'assets/gone.js': { hash: 'd'.repeat(64), size: 1 } });
    const target = manifest({});
    expect(diffManifests(current, target)).toEqual({ copy: [], download: [] });
  });

  it('handles a mixed diff (unchanged + changed + new, all in one manifest)', () => {
    const current = manifest({
      'index.html': { hash: '1'.repeat(64), size: 1 },
      'assets/old.js': { hash: '2'.repeat(64), size: 2 },
    });
    const target = manifest({
      'index.html': { hash: '1'.repeat(64), size: 1 }, // unchanged
      'assets/old.js': { hash: '3'.repeat(64), size: 3 }, // changed
      'assets/new.js': { hash: '4'.repeat(64), size: 4 }, // new
    });
    expect(diffManifests(current, target)).toEqual({
      copy: ['index.html'],
      download: [
        { path: 'assets/old.js', hash: '3'.repeat(64), size: 3 },
        { path: 'assets/new.js', hash: '4'.repeat(64), size: 4 },
      ],
    });
  });
});

function mockNative(overrides: Partial<OtaNativePlugin> = {}): OtaNativePlugin {
  return {
    stageUpdate: vi.fn().mockResolvedValue({ ok: true }),
    stageUpdateDelta: vi.fn().mockResolvedValue({ ok: true }),
    activate: vi.fn().mockResolvedValue({ ok: true }),
    getState: vi.fn().mockResolvedValue({ stateJSON: 'null' }),
    recordSeq: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('fetchRelease', () => {
  it('returns the verified release on a valid signature', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1', 'subgame-a': 'v3' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));

    const result = await fetchRelease({ baseUrl: 'https://cdn.example.com/game', publicKey, fetchImpl });

    expect(result).toEqual({ ok: true, release });
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/game/release.json');
  });

  it('reports signature-invalid on a tampered release', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const tampered = { ...release, bundles: { shell: 'v99' } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(tampered));

    const result = await fetchRelease({ baseUrl: 'https://cdn.example.com/game', publicKey, fetchImpl });

    expect(result).toEqual({ ok: false, outcome: 'signature-invalid' });
  });

  it('reports no-release-for-bundle on a network failure', async () => {
    const { publicKey } = makeKeypair();
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, false));

    const result = await fetchRelease({ baseUrl: 'https://cdn.example.com/game', publicKey, fetchImpl });

    expect(result).toEqual({ ok: false, outcome: 'no-release-for-bundle' });
  });
});

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

    expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: false });
    expect(native.stageUpdate).toHaveBeenCalledWith({
      name: 'shell', version: 'v2',
      zipUrl: 'https://cdn.example.com/game/bundles/shell/v2/bundle.zip',
      expectedZipHash: 'b'.repeat(64), expectedZipSize: 100,
      files: [{ path: 'index.html', hash: 'a'.repeat(64) }],
    });
    expect(native.activate).toHaveBeenCalledWith({ name: 'shell', version: 'v2' });
    expect(native.stageUpdateDelta).not.toHaveBeenCalled();
  });

  it('stages an update whose manifest hash matches release.manifests', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const manifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 100 },
    };
    // `manifests[shell]` must be the ACTUAL sha256 hex of the manifest's canonical JSON —
    // computed the same way otaClient.ts's (non-exported) sha256Hex does.
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const expectedHash = Array.from(sha256(new TextEncoder().encode(manifestHashPayload(manifest))), (b) => b.toString(16).padStart(2, '0')).join('');
    const release = signRelease(
      { schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1, manifests: { shell: expectedHash } },
      privateKey,
    );
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(manifest));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) });

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: false });
    expect(native.stageUpdate).toHaveBeenCalled();
  });

  it('reports manifest-untrusted and stages nothing when the manifest hash does not match release.manifests', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const manifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 100 },
    };
    const wrongHash = 'f'.repeat(64);
    const release = signRelease(
      { schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1, manifests: { shell: wrongHash } },
      privateKey,
    );
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(manifest));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) });

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'manifest-untrusted', version: 'v2', expected: wrongHash, actual: expect.any(String) });
    expect(native.stageUpdate).not.toHaveBeenCalled();
    expect(native.stageUpdateDelta).not.toHaveBeenCalled();
    expect(native.activate).not.toHaveBeenCalled();
  });

  it('stages normally when the release has no manifests field at all (back-compat)', async () => {
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

    expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: false });
    expect(native.stageUpdate).toHaveBeenCalled();
  });

  it('takes the delta path (not whole-zip) when the active version\'s manifest is fetchable', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const baseManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: {
        'index.html': { hash: 'a'.repeat(64), size: 1 }, // unchanged
        'assets/old.js': { hash: 'b'.repeat(64), size: 2 }, // removed in v2
      },
    };
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: {
        'index.html': { hash: 'a'.repeat(64), size: 1 }, // unchanged
        'assets/new.js': { hash: 'c'.repeat(64), size: 3 }, // new
      },
      bundleZip: { hash: 'd'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse(baseManifest));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) });

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'staged', version: 'v2', delta: true, mandatory: false });
    expect(native.stageUpdate).not.toHaveBeenCalled();
    expect(native.stageUpdateDelta).toHaveBeenCalledWith({
      name: 'shell', version: 'v2', baseVersion: 'v1',
      copy: ['index.html'],
      download: [{ path: 'assets/new.js', hash: 'c'.repeat(64), size: 3, url: 'https://cdn.example.com/game/bundles/shell/v2/files/' + 'c'.repeat(64) }],
      files: [{ path: 'index.html', hash: 'a'.repeat(64) }, { path: 'assets/new.js', hash: 'c'.repeat(64) }],
    });
    expect(native.activate).toHaveBeenCalledWith({ name: 'shell', version: 'v2' });
  });

  it('reports the delta fallback through onDeltaFallback instead of swallowing it (#556)', async () => {
    // The fallback silently turns a small delta into a full bundle download. If the reason is
    // swallowed, an unexplained bandwidth spike is undiagnosable after the fact.
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const baseManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
    };
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'd'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse(baseManifest));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }),
      stageUpdateDelta: vi.fn().mockRejectedValue(new Error('stage verification failed: hash mismatch')),
    });
    const onDeltaFallback = vi.fn();

    await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
      onDeltaFallback,
    });

    expect(onDeltaFallback).toHaveBeenCalledWith({
      version: 'v2', reason: 'stage verification failed: hash mismatch',
    });
  });

  it('does NOT re-download the whole bundle when the delta staged fine but activate threw (#556)', async () => {
    // `activate` sits outside the delta try deliberately. Inside it, a failed activate would
    // fall through and re-download a whole bundle for a version that had already staged
    // correctly — and the retry would hit the same failing activate anyway.
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const baseManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
    };
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'd'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse(baseManifest));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }),
      activate: vi.fn().mockRejectedValue(new Error('activate failed')),
    });

    await expect(checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    })).rejects.toThrow('activate failed');

    expect(native.stageUpdateDelta).toHaveBeenCalledTimes(1);
    expect(native.stageUpdate).not.toHaveBeenCalled();
  });

  it('takes the delta path against the EMBEDDED manifest on a fresh install (no active version yet)', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const embeddedManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'embedded', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
    };
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: {
        'index.html': { hash: 'a'.repeat(64), size: 1 }, // unchanged from embedded
        'assets/new.js': { hash: 'e'.repeat(64), size: 5 },
      },
      bundleZip: { hash: 'f'.repeat(64), size: 200 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse(embeddedManifest));
    const native = mockNative(); // no active/pending — genuinely fresh install

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'staged', version: 'v1', delta: true, mandatory: false });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'ota-embedded-manifest.json');
    expect(native.stageUpdate).not.toHaveBeenCalled();
    expect(native.stageUpdateDelta).toHaveBeenCalledWith({
      name: 'shell', version: 'v1', baseVersion: 'embedded',
      copy: ['index.html'],
      download: [{ path: 'assets/new.js', hash: 'e'.repeat(64), size: 5, url: 'https://cdn.example.com/game/bundles/shell/v1/files/' + 'e'.repeat(64) }],
      files: [{ path: 'index.html', hash: 'a'.repeat(64) }, { path: 'assets/new.js', hash: 'e'.repeat(64) }],
    });
  });

  it('falls back to whole-zip when no base manifest (active OR embedded) is fetchable', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'f'.repeat(64), size: 200 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse({}, false)); // embedded manifest 404s
    const native = mockNative();

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'staged', version: 'v1', mandatory: false });
    expect(native.stageUpdateDelta).not.toHaveBeenCalled();
    expect(native.stageUpdate).toHaveBeenCalledWith({
      name: 'shell', version: 'v1',
      zipUrl: 'https://cdn.example.com/game/bundles/shell/v1/bundle.zip',
      expectedZipHash: 'f'.repeat(64), expectedZipSize: 200,
      files: [{ path: 'index.html', hash: 'a'.repeat(64) }],
    });
  });

  it('falls back to whole-zip and still resolves staged when stageUpdateDelta throws (#556)', async () => {
    // The #550 quarantine ruling ("re-staging would fetch identical broken bytes") does NOT
    // hold for delta staging: `copy` entries are taken byte-for-byte off disk and hashed by
    // nobody, so a LOCALLY corrupt base file can make native's own whole-tree verification
    // throw even though the published bytes are fine. Delta is an optimization, so this must
    // fall through to a whole-zip stage rather than failing the update outright.
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const baseManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
    };
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'd'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse(baseManifest));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }),
      stageUpdateDelta: vi.fn().mockRejectedValue(new Error('stage verification failed: hash mismatch')),
    });

    const result = await checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    });

    expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: false });
    expect(native.stageUpdateDelta).toHaveBeenCalledTimes(1);
    expect(native.stageUpdate).toHaveBeenCalledWith({
      name: 'shell', version: 'v2',
      zipUrl: 'https://cdn.example.com/game/bundles/shell/v2/bundle.zip',
      expectedZipHash: 'd'.repeat(64), expectedZipSize: 100,
      files: [{ path: 'index.html', hash: 'a'.repeat(64) }],
    });
    expect(native.activate).toHaveBeenCalledWith({ name: 'shell', version: 'v2' });
  });

  it('propagates and never calls activate when stageUpdate (whole-zip) throws — no fallback', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v1', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'f'.repeat(64), size: 200 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse({}, false)); // embedded manifest 404s -> whole-zip path
    const native = mockNative({
      stageUpdate: vi.fn().mockRejectedValue(new Error('hash mismatch')),
    });

    await expect(checkForUpdate({
      baseUrl: 'https://cdn.example.com/game', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native,
    })).rejects.toThrow('hash mismatch');

    expect(native.activate).not.toHaveBeenCalled();
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

  // #509: `pending` means STAGED-AND-WAITING-FOR-RESTART, not running — reporting it as
  // `up-to-date` let a concurrent caller tear down a mandatory gate the FIRST caller had
  // legitimately armed, because the pending version wasn't running yet either.
  it('reports pending-restart (not up-to-date) when the target is already staged but not active', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: true, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({
        stateJSON: JSON.stringify({ active: { shell: 'v1' }, pending: { shell: 'v2' } }),
      }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'pending-restart', version: 'v2', mandatory: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never fetched a manifest, same short-circuit as up-to-date
    expect(native.stageUpdate).not.toHaveBeenCalled();
    expect(native.stageUpdateDelta).not.toHaveBeenCalled();
  });

  // Brick regression: `pending` also stays set for TWO launches AFTER a restart actually
  // serves it (promotion to `active` needs two confirmBoots — OtaCore.requiredConfirms). If
  // this case were also reported as `pending-restart`, a mandatory gate would hold FOREVER
  // on the very update the device is already running — the app never boots and a restart
  // just repeats the same launch. `bootAttempts >= 1` is what the native boot hook sets
  // BEFORE the WebView loads when it serves the pending bundle, so it's the discriminator.
  it('reports up-to-date (not pending-restart) when the pending version is already being served (bootAttempts >= 1)', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: true, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({
        stateJSON: JSON.stringify({ active: { shell: 'v1' }, pending: { shell: 'v2' }, bootAttempts: { shell: 1 } }),
      }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'up-to-date' });
  });

  it('reports up-to-date (not pending-restart) when active already matches, even if pending also holds a stale value', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: true, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({
        stateJSON: JSON.stringify({ active: { shell: 'v2' }, pending: { shell: 'v1' } }),
      }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'up-to-date' });
  });

  it('refuses to re-stage a version this device already quarantined (Phase 3a)', async () => {
    // The regression this locks: before the `rejected` list existed, revert() erased all
    // memory of the failure, so this exact call re-staged the known-bad bundle — forever.
    // Observed on-device during Phase 1's iOS revert test; see docs/ota-updates.md's Quarantine section.
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v13' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({
        stateJSON: JSON.stringify({ active: { shell: 'v12' }, rejected: { shell: ['v13'] } }),
      }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'version-rejected', version: 'v13' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never even fetched the manifest
    expect(native.stageUpdate).not.toHaveBeenCalled();
    expect(native.stageUpdateDelta).not.toHaveBeenCalled();
  });

  it('quarantine is per-bundle — another bundle\'s rejection never blocks this one', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v13' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v13', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'f'.repeat(64), size: 200 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse({}, false)); // no base manifest -> whole-zip
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ rejected: { sling: ['v13'] } }) }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'staged', version: 'v13', mandatory: false });
  });

  it('a quarantined version that is nonetheless active reports up-to-date, not rejected', async () => {
    // `rejected` vetoes STAGING, never a bundle already booting fine — otherwise a device
    // could be left with nothing to run. Mirrors OtaCore's boot-side rule.
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v13' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({
        stateJSON: JSON.stringify({ active: { shell: 'v13' }, rejected: { shell: ['v13'] } }),
      }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'up-to-date' });
  });

  it('a Phase 1/2 state.json with no `rejected` key still stages normally', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const targetManifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'f'.repeat(64), size: 200 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(targetManifest))
      .mockResolvedValueOnce(jsonResponse({}, false));
    const native = mockNative({
      getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }),
    });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: false });
  });

  it('reports pending-restart (not up-to-date) when the target version is already pending (avoids re-downloading mid-attempt, #509)', async () => {
    // #509: `pending` means staged-and-waiting-for-a-restart, NOT running — this case still
    // avoids a redundant re-download (no manifest fetch below), but must NOT be conflated with
    // `up-to-date`, whose caller-side meaning is "nothing to wait for". See the dedicated
    // pending-restart tests above for the outcome's full contract.
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, pending: { shell: 'v2' } }) }) });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });
    expect(result).toEqual({ outcome: 'pending-restart', version: 'v2', mandatory: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never fetched a manifest — same short-circuit as before
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

  it('refuses a release whose minEngineApi is newer than what is running (release-level gate)', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 5 }, privateKey);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
    const native = mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) });

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 2, fetchImpl, native });

    expect(result).toEqual({ outcome: 'engine-api-too-old', required: 5, running: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never even fetched the manifest
    expect(native.stageUpdate).not.toHaveBeenCalled();
  });

  it('surfaces mandatory:true on the staged result when the release is marked mandatory', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: true, minEngineApi: 1 }, privateKey);
    const manifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse({}, false)); // no base manifest -> whole-zip
    const native = mockNative();

    const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

    expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: true });
  });

  it('fires onWillStage exactly once, before the manifest fetch, with the right mandatory flag', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: true, minEngineApi: 1 }, privateKey);
    const manifest: OtaManifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 100 },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(release))
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse({}, false));
    const native = mockNative();
    const onWillStage = vi.fn();

    await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native, onWillStage });

    expect(onWillStage).toHaveBeenCalledTimes(1);
    expect(onWillStage).toHaveBeenCalledWith({ version: 'v2', mandatory: true });
    // Called BEFORE the manifest fetch (only release.json had been fetched at that point) —
    // verified by checking the callback ran while fetchImpl had made exactly 1 call.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2); // sanity: manifest WAS eventually fetched
  });

  it('does NOT fire onWillStage for up-to-date, quarantined, or engine-gated outcomes', async () => {
    const { privateKey, publicKey } = makeKeypair();
    const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: true, minEngineApi: 1 }, privateKey);
    const onWillStage = vi.fn();

    // up-to-date
    await checkForUpdate({
      baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, onWillStage,
      fetchImpl: vi.fn().mockResolvedValueOnce(jsonResponse(release)),
      native: mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' } }) }) }),
    });
    expect(onWillStage).not.toHaveBeenCalled();

    // quarantined
    await checkForUpdate({
      baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, onWillStage,
      fetchImpl: vi.fn().mockResolvedValueOnce(jsonResponse(release)),
      native: mockNative({ getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ rejected: { shell: ['v1'] } }) }) }),
    });
    expect(onWillStage).not.toHaveBeenCalled();

    // release-level engine gate
    const gatedRelease = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: true, minEngineApi: 5 }, privateKey);
    await checkForUpdate({
      baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, onWillStage,
      fetchImpl: vi.fn().mockResolvedValueOnce(jsonResponse(gatedRelease)),
      native: mockNative(),
    });
    expect(onWillStage).not.toHaveBeenCalled();
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

  // #571 anti-rollback.
  describe('seq (anti-rollback, #571)', () => {
    it('refuses a release whose seq is lower than the highest already recorded, staging nothing', async () => {
      const { privateKey, publicKey } = makeKeypair();
      const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1, seq: 3 }, privateKey);
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
      const native = mockNative({
        getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, highestSeenSeq: 10 }) }),
      });

      const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

      expect(result).toEqual({ outcome: 'seq-rollback', version: 'v2', seq: 3, highestSeenSeq: 10 });
      expect(fetchImpl).toHaveBeenCalledTimes(1); // never even fetched the manifest
      expect(native.stageUpdate).not.toHaveBeenCalled();
      expect(native.stageUpdateDelta).not.toHaveBeenCalled();
      expect(native.recordSeq).not.toHaveBeenCalled();
    });

    it('treats an absent seq as 0, so it is refused once this device has recorded anything higher', async () => {
      const { privateKey, publicKey } = makeKeypair();
      // A pre-#571 release, with no `seq` field at all — replaying it must not disarm rollback
      // protection just because it predates the field, matching #570's own manifests precedent.
      const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1 }, privateKey);
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
      const native = mockNative({
        getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, highestSeenSeq: 1 }) }),
      });

      const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

      expect(result).toEqual({ outcome: 'seq-rollback', version: 'v2', seq: 0, highestSeenSeq: 1 });
    });

    it('records the new high-water mark and proceeds when seq is higher than what was recorded', async () => {
      const { privateKey, publicKey } = makeKeypair();
      const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, seq: 7 }, privateKey);
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
      const native = mockNative({
        getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, highestSeenSeq: 2 }) }),
      });

      const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

      expect(result).toEqual({ outcome: 'up-to-date' });
      expect(native.recordSeq).toHaveBeenCalledWith({ seq: 7 });
    });

    it('advances the high-water mark even on an up-to-date check, closing the replay window for a later rollback', async () => {
      // The gap this locks: recording only on the STAGING path would leave the high-water
      // mark stuck at its last-staged value while a device stays current for a long stretch,
      // during which an attacker could replay any release published in between.
      const { privateKey, publicKey } = makeKeypair();
      const release = signRelease({ schema: 1, bundles: { shell: 'v5' }, mandatory: false, minEngineApi: 1, seq: 9 }, privateKey);
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
      const native = mockNative({
        getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v5' } }) }), // no highestSeenSeq yet
      });

      const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

      expect(result).toEqual({ outcome: 'up-to-date' });
      expect(native.recordSeq).toHaveBeenCalledWith({ seq: 9 });
    });

    it('does not call recordSeq when seq exactly matches what is already recorded (nothing to advance)', async () => {
      const { privateKey, publicKey } = makeKeypair();
      const release = signRelease({ schema: 1, bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1, seq: 4 }, privateKey);
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(release));
      const native = mockNative({
        getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, highestSeenSeq: 4 }) }),
      });

      const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

      expect(result).toEqual({ outcome: 'up-to-date' });
      expect(native.recordSeq).not.toHaveBeenCalled();
    });

    it('stages a genuinely newer release normally once its higher seq is recorded', async () => {
      const { privateKey, publicKey } = makeKeypair();
      const release = signRelease({ schema: 1, bundles: { shell: 'v2' }, mandatory: false, minEngineApi: 1, seq: 5 }, privateKey);
      const manifest: OtaManifest = {
        schema: 1, name: 'shell', version: 'v2', engineApi: 1,
        files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
        bundleZip: { hash: 'b'.repeat(64), size: 100 },
      };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse(release))
        .mockResolvedValueOnce(jsonResponse(manifest))
        .mockResolvedValueOnce(jsonResponse({}, false)); // no base manifest -> whole-zip
      const native = mockNative({
        getState: vi.fn().mockResolvedValue({ stateJSON: JSON.stringify({ active: { shell: 'v1' }, highestSeenSeq: 4 }) }),
      });

      const result = await checkForUpdate({ baseUrl: 'https://x', publicKey, bundleName: 'shell', runningEngineApi: 1, fetchImpl, native });

      expect(result).toEqual({ outcome: 'staged', version: 'v2', mandatory: false });
      expect(native.recordSeq).toHaveBeenCalledWith({ seq: 5 });
      expect(native.stageUpdate).toHaveBeenCalled();
    });
  });
});
