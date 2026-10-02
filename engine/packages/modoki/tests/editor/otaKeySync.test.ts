/** OTA Keys → "Sync to Project Settings" asks before it REPLACES a shipped `ota.publicKey` (#1993). */
import { describe, it, expect } from 'vitest';
import { otaKeySyncConfirmation } from '../../src/editor/panels/otaKeySync';

describe('otaKeySyncConfirmation', () => {
  it('filling an empty ota.publicKey is first-time setup: no question', () => {
    expect(otaKeySyncConfirmation('', 'pub-new', 'default')).toBeNull();
    expect(otaKeySyncConfirmation(null, 'pub-new', 'default')).toBeNull();
    expect(otaKeySyncConfirmation(undefined, 'pub-new', 'default')).toBeNull();
  });

  it('the key already in Project Settings is no change: no question', () => {
    expect(otaKeySyncConfirmation('pub-same', 'pub-same', 'default')).toBeNull();
  });

  it('replacing a non-empty ota.publicKey is a rotation: asked, naming both keys and what it strands', () => {
    const ask = otaKeySyncConfirmation('pub-shipped', 'pub-new', 'release');
    expect(ask).not.toBeNull();
    expect(ask!.message).toContain('pub-shipped');
    expect(ask!.message).toContain('"release" (pub-new)');
    expect(ask!.message).toMatch(/none of those installs can verify an update again/);
    expect(ask!.okLabel).toBe('Replace key');
  });
});
