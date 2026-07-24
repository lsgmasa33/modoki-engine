/** Ed25519 signing for OTA releases (docs/plans/mobile-ota-updates-plan.md, Phase 0). */
import { describe, it, expect } from 'vitest';
import { generateKeypair, signRelease, verifyRelease } from '../../../scripts/ota/signing.mjs';
import { createRelease } from '../../../scripts/ota/schema.mjs';

describe('OTA signing', () => {
  it('a signature from the correct key verifies', () => {
    const keypair = generateKeypair();
    const unsigned = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 });
    const release = signRelease(unsigned, keypair);
    expect(verifyRelease(release, keypair.publicKey)).toBe(true);
  });

  it('rejects a signature verified against the WRONG public key', () => {
    const keypair = generateKeypair();
    const attacker = generateKeypair();
    const unsigned = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 });
    const release = signRelease(unsigned, keypair);
    expect(verifyRelease(release, attacker.publicKey)).toBe(false);
  });

  it('rejects a release whose signed field was tampered with after signing', () => {
    const keypair = generateKeypair();
    const unsigned = createRelease({ bundles: { shell: 'v1' }, mandatory: false, minEngineApi: 1 });
    const release = signRelease(unsigned, keypair);
    const tampered = { ...release, bundles: { shell: 'v2' } }; // attacker points the shell at their own bundle
    expect(verifyRelease(tampered, keypair.publicKey)).toBe(false);
  });

  it('rejects a release with a missing or empty sig instead of throwing', () => {
    const keypair = generateKeypair();
    expect(verifyRelease({ schema: 1, bundles: {}, mandatory: false, minEngineApi: 1 }, keypair.publicKey)).toBe(false);
    expect(verifyRelease({ sig: '' }, keypair.publicKey)).toBe(false);
    expect(verifyRelease(null, keypair.publicKey)).toBe(false);
  });

  it('rejects garbage base64url in sig instead of throwing', () => {
    const keypair = generateKeypair();
    expect(verifyRelease({ schema: 1, bundles: {}, mandatory: false, minEngineApi: 1, sig: '!!!not-base64!!!' }, keypair.publicKey)).toBe(false);
  });

  it('rejects verification against a malformed public key instead of throwing', () => {
    const unsigned = createRelease({ bundles: {}, mandatory: false, minEngineApi: 1 });
    const release = signRelease(unsigned, generateKeypair());
    expect(verifyRelease(release, 'not-a-real-public-key')).toBe(false);
  });

  it('two keypairs never collide', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});
