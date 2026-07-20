/** Font content-cache tests — hash stability, settings sensitivity, the invariant
 *  that `mode` does NOT affect the hash (baked/dynamic bake the same atlas), and
 *  the cache-path layout. Plus resolveFontSettings / expandCharset unit coverage. */

import { describe, it, expect } from 'vitest';
import { hashKey, atlasCachePath, metricsCachePath, getFontCacheDir } from '../../plugins/font-cache';
import { DEFAULT_FONT_SETTINGS, resolveFontSettings, expandCharset } from '../../packages/modoki/src/runtime/loaders/fontSettings';

const bytes = Buffer.from('fake-font-source-bytes');
const S = DEFAULT_FONT_SETTINGS;

describe('font hashKey', () => {
  it('is stable + 16 hex chars', () => {
    expect(hashKey(bytes, S)).toBe(hashKey(bytes, S));
    expect(hashKey(bytes, S)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a bake setting changes', () => {
    expect(hashKey(bytes, { ...S, size: 32 })).not.toBe(hashKey(bytes, S));
    expect(hashKey(bytes, { ...S, pxRange: 4 })).not.toBe(hashKey(bytes, S));
    expect(hashKey(bytes, { ...S, fieldType: 'msdf' })).not.toBe(hashKey(bytes, S));
    expect(hashKey(bytes, { ...S, charset: 'latin1' })).not.toBe(hashKey(bytes, S));
  });

  it('does NOT change when only mode changes (baked vs dynamic → same atlas)', () => {
    expect(hashKey(bytes, { ...S, mode: 'dynamic' })).toBe(hashKey(bytes, S));
  });

  it('changes when the source bytes change', () => {
    expect(hashKey(Buffer.from('other'), S)).not.toBe(hashKey(bytes, S));
  });

  it('a custom charset equal to a preset hashes the same (charset is expanded)', () => {
    const ascii = expandCharset({ charset: 'ascii' });
    const asPreset = hashKey(bytes, { ...S, charset: 'ascii' });
    const asCustom = hashKey(bytes, { ...S, charset: 'custom', customChars: ascii });
    expect(asCustom).toBe(asPreset);
  });
});

describe('font cache paths', () => {
  it('lay out <cacheDir>/<urlPath>/<hash>/{atlas.png,metrics.json}', () => {
    const dir = getFontCacheDir('/proj');
    const h = 'abcd1234abcd1234';
    // Normalize separators — filesystem paths (path.join), backslash-delimited on Windows.
    expect(atlasCachePath(dir, '/games/x/assets/fonts/Inter.ttf', h).replace(/\\/g, '/'))
      .toBe('/proj/.cache/modoki-fonts/games/x/assets/fonts/Inter.ttf/abcd1234abcd1234/atlas.png');
    expect(metricsCachePath(dir, '/games/x/assets/fonts/Inter.ttf', h).replace(/\\/g, '/'))
      .toBe('/proj/.cache/modoki-fonts/games/x/assets/fonts/Inter.ttf/abcd1234abcd1234/metrics.json');
  });
});

describe('resolveFontSettings', () => {
  it('returns defaults for empty/missing meta', () => {
    expect(resolveFontSettings(null)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(resolveFontSettings({})).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it('merges the persisted font block over defaults', () => {
    const r = resolveFontSettings({ font: { size: 64, mode: 'dynamic' } });
    expect(r.size).toBe(64);
    expect(r.mode).toBe('dynamic');
    expect(r.pxRange).toBe(DEFAULT_FONT_SETTINGS.pxRange); // untouched default
  });
});

describe('expandCharset', () => {
  it('ascii = 95 printable chars', () => {
    expect(expandCharset({ charset: 'ascii' }).length).toBe(95);
  });
  it('latin1 adds the 0xA0–0xFF supplement', () => {
    expect(expandCharset({ charset: 'latin1' }).length).toBe(95 + (0xff - 0xa0 + 1));
  });
  it('custom returns the authored chars verbatim', () => {
    expect(expandCharset({ charset: 'custom', customChars: 'xyz' })).toBe('xyz');
    expect(expandCharset({ charset: 'custom' })).toBe('');
  });
});
