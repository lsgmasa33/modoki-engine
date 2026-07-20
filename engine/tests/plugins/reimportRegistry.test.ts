/** Reimport-registry tests — generic per-asset-type handler dispatch. */

import { describe, it, expect } from 'vitest';
import { registerReimportHandler, getReimportHandler, hasReimportHandler } from '../../plugins/reimport-registry';

describe('reimport-registry', () => {
  it('registers and retrieves a handler by type', () => {
    const handler = async () => {};
    registerReimportHandler('test-type', handler);
    expect(hasReimportHandler('test-type')).toBe(true);
    expect(getReimportHandler('test-type')).toBe(handler);
  });

  it('returns undefined for an unregistered type', () => {
    expect(getReimportHandler('no-such-type')).toBeUndefined();
    expect(hasReimportHandler('no-such-type')).toBe(false);
  });
});
