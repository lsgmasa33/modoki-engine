/** assetSetSignature — the dedupe key that lets the editor auto-refresh the Assets
 *  panel on disk changes WITHOUT looping on the watcher's self-echo. */

import { describe, it, expect } from 'vitest';
import { assetSetSignature } from '../../src/editor/assetSetSignature';

describe('assetSetSignature', () => {
  it('is identical for the same file set (the panel\'s own rescan echo → no refresh)', () => {
    const a = [{ path: '/assets/a.png' }, { path: '/assets/b.glb' }];
    const echo = [{ path: '/assets/a.png' }, { path: '/assets/b.glb' }];
    expect(assetSetSignature(a)).toBe(assetSetSignature(echo));
  });

  it('is order-independent (readdir order is not guaranteed)', () => {
    const a = [{ path: '/assets/a.png' }, { path: '/assets/b.glb' }];
    const reordered = [{ path: '/assets/b.glb' }, { path: '/assets/a.png' }];
    expect(assetSetSignature(a)).toBe(assetSetSignature(reordered));
  });

  it('changes on add / remove / rename (a real disk change → exactly one refresh)', () => {
    const base = [{ path: '/assets/a.png' }];
    expect(assetSetSignature([...base, { path: '/assets/new.prefab.json' }])).not.toBe(assetSetSignature(base)); // add
    expect(assetSetSignature([])).not.toBe(assetSetSignature(base));                                            // remove
    expect(assetSetSignature([{ path: '/assets/renamed.png' }])).not.toBe(assetSetSignature(base));            // rename
  });

  it('treats missing / non-array input as the empty signature', () => {
    expect(assetSetSignature(undefined)).toBe('');
    expect(assetSetSignature(null)).toBe('');
    expect(assetSetSignature([])).toBe('');
  });
});
