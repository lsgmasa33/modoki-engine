import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEXTURE_SETTINGS, resolveTextureSettings, variantsForFormat, variantsToEmit, browserVariant,
  variantExtension, variantSuffix, selectVariant,
  deriveSettingsForType, resolveTextureType,
  DEFAULT_WEBP_QUALITY, resolveWebpQuality,
} from '../../src/runtime/loaders/textureSettings';

describe('deriveSettingsForType', () => {
  it('3d → mipmapped KTX2 UASTC, repeat wrap', () => {
    expect(deriveSettingsForType('3d')).toMatchObject({ format: 'ktx2-uastc', mipmaps: true, wrapS: 'repeat' });
  });
  it('2d → KTX2 UASTC, no mips, clamp', () => {
    expect(deriveSettingsForType('2d')).toMatchObject({ format: 'ktx2-uastc', mipmaps: false, wrapS: 'clamp' });
  });
  it('ui → WebP, no mips, clamp', () => {
    expect(deriveSettingsForType('ui')).toMatchObject({ format: 'webp', mipmaps: false, wrapS: 'clamp' });
  });
  it('explicit overrides win (2D WebP override for crisp art)', () => {
    expect(deriveSettingsForType('2d', { format: 'webp' }).format).toBe('webp');
  });
});

describe('resolveTextureType', () => {
  it('returns the explicit type when present', () => {
    expect(resolveTextureType({ type: 'ui', texture: { format: 'ktx2-uastc' } })).toBe('ui');
  });
  it('infers 2d from webp/png, 3d from ktx2, for legacy (no type)', () => {
    expect(resolveTextureType({ texture: { format: 'webp' } })).toBe('2d');
    expect(resolveTextureType({ texture: { format: 'png' } })).toBe('2d');
    expect(resolveTextureType({ texture: { format: 'ktx2-uastc' } })).toBe('3d');
    expect(resolveTextureType(undefined)).toBe('3d');
  });
});

describe('resolveTextureSettings', () => {
  it('fills defaults for missing/empty meta', () => {
    expect(resolveTextureSettings(undefined)).toEqual(DEFAULT_TEXTURE_SETTINGS);
    expect(resolveTextureSettings({})).toEqual(DEFAULT_TEXTURE_SETTINGS);
  });

  it('merges a partial settings block over the defaults', () => {
    const s = resolveTextureSettings({ texture: { format: 'webp', maxSize: 512 } });
    expect(s.format).toBe('webp');
    expect(s.maxSize).toBe(512);
    expect(s.wrapS).toBe(DEFAULT_TEXTURE_SETTINGS.wrapS);
  });
});

describe('variantsForFormat', () => {
  it('KTX2 formats are 3D-only (no WebP); ASTC adds a UASTC fallback sibling', () => {
    expect(variantsForFormat('ktx2-uastc')).toEqual(['uastc']);
    expect(variantsForFormat('ktx2-etc1s')).toEqual(['etc1s']);
    expect(variantsForFormat('ktx2-astc')).toEqual(['astc', 'uastc']);
    expect(variantsForFormat('webp')).toEqual(['webp']);
    expect(variantsForFormat('png')).toEqual(['png']);
  });
});

describe('variantsToEmit (type-aware: 2d/ui ktx2 gains a WebP sibling)', () => {
  it('a 2d/ui ktx2 texture emits its GPU variant PLUS a WebP browser sibling', () => {
    expect(variantsToEmit('ktx2-uastc', '2d')).toEqual(['uastc', 'webp']);
    expect(variantsToEmit('ktx2-etc1s', 'ui')).toEqual(['etc1s', 'webp']);
    expect(variantsToEmit('ktx2-astc', '2d')).toEqual(['astc', 'uastc', 'webp']);
  });
  it('a 3d ktx2 texture emits GPU-only (Three decodes KTX2 in the editor too)', () => {
    expect(variantsToEmit('ktx2-uastc', '3d')).toEqual(['uastc']);
    expect(variantsToEmit('ktx2-astc', '3d')).toEqual(['astc', 'uastc']);
  });
  it('webp/png formats already have a browser variant — no duplicate sibling', () => {
    expect(variantsToEmit('webp', '2d')).toEqual(['webp']);
    expect(variantsToEmit('png', 'ui')).toEqual(['png']);
    expect(variantsToEmit('webp', '3d')).toEqual(['webp']);
  });
});

describe('browserVariant (mirrors variantsToEmit)', () => {
  it('returns WebP for a 2d/ui ktx2 texture, its own for webp/png', () => {
    expect(browserVariant('ktx2-uastc', '2d')).toBe('webp');
    expect(browserVariant('ktx2-astc', 'ui')).toBe('webp');
    expect(browserVariant('webp', '2d')).toBe('webp');
    expect(browserVariant('png', '2d')).toBe('png');
  });
  it('returns null for a 3d ktx2 texture (no browser variant emitted)', () => {
    expect(browserVariant('ktx2-uastc', '3d')).toBeNull();
    expect(browserVariant('ktx2-astc', '3d')).toBeNull();
  });
  it('infers type from format when omitted (legacy: ktx2 ⇒ 3d ⇒ null)', () => {
    expect(browserVariant('ktx2-uastc')).toBeNull();
    expect(browserVariant('webp')).toBe('webp');
  });
});

describe('variantExtension / variantSuffix', () => {
  it('maps variants to file extensions and served suffixes', () => {
    expect(variantExtension('uastc')).toBe('ktx2');
    expect(variantExtension('webp')).toBe('webp');
    expect(variantSuffix('uastc')).toBe('~uastc.ktx2');
    expect(variantSuffix('webp')).toBe('~webp.webp');
  });
});

describe('selectVariant', () => {
  const base = DEFAULT_TEXTURE_SETTINGS;

  it('2d picks WebP/PNG directly, and the universal transcodable variant for KTX2', () => {
    expect(selectVariant({ ...base, format: 'webp' }, '2d', { astc: true })).toBe('webp');
    expect(selectVariant({ ...base, format: 'png' }, '2d', { astc: false })).toBe('png');
    // KTX2 now decodes in the PixiJS 2D path (libktx transcoder) — hand it the
    // UNIVERSAL variant (uastc/etc1s), never native astc (Pixi drives the transcode).
    expect(selectVariant({ ...base, format: 'ktx2-uastc' }, '2d', { astc: true })).toBe('uastc');
    expect(selectVariant({ ...base, format: 'ktx2-etc1s' }, '2d', { astc: true })).toBe('etc1s');
    expect(selectVariant({ ...base, format: 'ktx2-astc' }, '2d', { astc: true })).toBe('uastc');
  });

  it('3d ASTC format → native ASTC when supported, else UASTC', () => {
    expect(selectVariant({ ...base, format: 'ktx2-astc' }, '3d', { astc: true })).toBe('astc');
    expect(selectVariant({ ...base, format: 'ktx2-astc' }, '3d', { astc: false })).toBe('uastc');
  });

  it('3d UASTC/ETC1S formats map directly', () => {
    expect(selectVariant({ ...base, format: 'ktx2-uastc' }, '3d', { astc: true })).toBe('uastc');
    expect(selectVariant({ ...base, format: 'ktx2-etc1s' }, '3d', { astc: true })).toBe('etc1s');
  });
});

describe('resolveWebpQuality', () => {
  it('falls back to the default when unset or NaN', () => {
    expect(resolveWebpQuality(undefined)).toBe(DEFAULT_WEBP_QUALITY);
    expect(resolveWebpQuality(Number.NaN)).toBe(DEFAULT_WEBP_QUALITY);
  });
  it('clamps to 1–100 and rounds', () => {
    expect(resolveWebpQuality(0)).toBe(1);
    expect(resolveWebpQuality(-20)).toBe(1);
    expect(resolveWebpQuality(150)).toBe(100);
    expect(resolveWebpQuality(82.6)).toBe(83);
  });
  it('passes valid values through', () => {
    expect(resolveWebpQuality(80)).toBe(80);
    expect(resolveWebpQuality(1)).toBe(1);
    expect(resolveWebpQuality(100)).toBe(100);
  });
});
