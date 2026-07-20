/** Playable asset profile — unit tests for the pure setting overrides. The end-to-end
 *  effect (a real sling playable build → 0 KTX2, 13 WebP, 130 KB HDR, no transcoders) is
 *  validated by hand; these lock the pure transforms so a refactor can't silently change
 *  what the profile forces. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isPlayableBuild,
  playableTextureSettings,
  playableEnvSettings,
  PLAYABLE_TEXTURE_MAX,
  PLAYABLE_ENV_MAX,
  PLAYABLE_WEBP_QUALITY,
} from '../../plugins/playable-profile';
import type { TextureImportSettings } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import type { EnvImportSettings } from '../../packages/modoki/src/runtime/loaders/environmentSettings';

const tex = (over: Partial<TextureImportSettings> = {}): TextureImportSettings => ({
  format: 'ktx2-uastc',
  maxSize: 2048,
  mipmaps: true,
  wrapS: 'repeat',
  wrapT: 'repeat',
  colorspace: 'srgb',
  ...over,
});

const env = (over: Partial<EnvImportSettings> = {}): EnvImportSettings => ({
  format: 'hdr',
  maxSize: 1024,
  ...over,
});

describe('isPlayableBuild', () => {
  const prev = process.env.MODOKI_PLAYABLE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MODOKI_PLAYABLE;
    else process.env.MODOKI_PLAYABLE = prev;
  });

  it('true only when MODOKI_PLAYABLE=1', () => {
    process.env.MODOKI_PLAYABLE = '1';
    expect(isPlayableBuild()).toBe(true);
    process.env.MODOKI_PLAYABLE = '0';
    expect(isPlayableBuild()).toBe(false);
    delete process.env.MODOKI_PLAYABLE;
    expect(isPlayableBuild()).toBe(false);
  });
});

describe('playableTextureSettings', () => {
  it('forces WebP (no KTX2 → no transcoder) and the playable webp quality', () => {
    const out = playableTextureSettings(tex({ format: 'ktx2-uastc' }));
    expect(out.format).toBe('webp');
    expect(out.webpQuality).toBe(PLAYABLE_WEBP_QUALITY);
  });

  it('caps the longest edge at 512 but never UPSCALES a smaller texture', () => {
    expect(playableTextureSettings(tex({ maxSize: 2048 })).maxSize).toBe(PLAYABLE_TEXTURE_MAX); // 512
    expect(playableTextureSettings(tex({ maxSize: 256 })).maxSize).toBe(256); // already smaller — kept
  });

  it('preserves unrelated fields (wrap/colorspace/mipmaps)', () => {
    const out = playableTextureSettings(tex({ wrapS: 'clamp', colorspace: 'linear', mipmaps: false }));
    expect(out.wrapS).toBe('clamp');
    expect(out.colorspace).toBe('linear');
    expect(out.mipmaps).toBe(false);
  });
});

describe('playableEnvSettings', () => {
  it('forces plain HDR (NOT ultrahdr — no committed variant for a playable source)', () => {
    expect(playableEnvSettings(env({ format: 'ultrahdr' })).format).toBe('hdr');
  });

  it('caps the env at 256 but never UPSCALES', () => {
    expect(playableEnvSettings(env({ maxSize: 2048 })).maxSize).toBe(PLAYABLE_ENV_MAX); // 256
    expect(playableEnvSettings(env({ maxSize: 256 })).maxSize).toBe(256);
  });
});
