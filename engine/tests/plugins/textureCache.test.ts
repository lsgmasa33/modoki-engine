/** Texture content-cache tests — hash key determinism + cache path scheme. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashKey, cachePathFor, cacheHit } from '../../plugins/texture-cache';
import { DEFAULT_TEXTURE_SETTINGS } from '../../packages/modoki/src/runtime/loaders/textureSettings';

describe('texture-cache hashKey', () => {
  it('is deterministic for the same bytes + settings', () => {
    const a = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    const b = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when source bytes change', () => {
    expect(hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS))
      .not.toBe(hashKey(Buffer.from('abd'), DEFAULT_TEXTURE_SETTINGS));
  });

  it('changes when settings change', () => {
    expect(hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS))
      .not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, maxSize: 512 }));
  });

  it('changes when flipY / flipGreen are set (so a flip re-converts the variant)', () => {
    const base = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    expect(base).not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, flipY: true }));
    expect(base).not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, flipGreen: true }));
    expect(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, flipY: true }))
      .not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, flipY: true, flipGreen: true }));
  });

  it('is backward-compatible: absent/false flip flags hash exactly as before', () => {
    // Existing textures (no flip flags) must NOT re-convert when this field landed.
    const base = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    expect(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, flipY: false, flipGreen: false })).toBe(base);
  });

  it('changes when webpQuality changes (so a quality edit re-encodes the WebP variant)', () => {
    // The encoder reads settings.webpQuality; the cache key MUST include it or an
    // Apply after editing quality hits the cache and never re-encodes.
    const q80 = hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, webpQuality: 80 });
    const q40 = hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, webpQuality: 40 });
    expect(q80).not.toBe(q40);
    // Out-of-range values are clamped in the key the same way the encoder clamps them.
    expect(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, webpQuality: 150 }))
      .toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, webpQuality: 100 }));
  });

  it('is backward-compatible: absent webpQuality hashes exactly as before', () => {
    // Existing WebP textures with no explicit quality must NOT re-convert.
    const base = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    expect(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, webpQuality: undefined })).toBe(base);
  });

  it('changes when uastcLevel / uastcRdoLambda change (re-encodes the UASTC variant)', () => {
    const base = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    expect(base).not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, uastcLevel: 4 }));
    expect(base).not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, uastcRdoLambda: 3 }));
  });

  it('is backward-compatible: absent UASTC knobs hash exactly as before', () => {
    const base = hashKey(Buffer.from('abc'), DEFAULT_TEXTURE_SETTINGS);
    expect(hashKey(Buffer.from('abc'), { ...DEFAULT_TEXTURE_SETTINGS, uastcLevel: undefined, uastcRdoLambda: undefined })).toBe(base);
  });
});

describe('texture-cache cachePathFor', () => {
  it('mirrors the url path under a per-hash dir', () => {
    // Normalize separators — filesystem path (path.join), backslash-delimited on Windows.
    expect(cachePathFor('/cache', '/games/g/assets/t/rock.png', 'deadbeef', 'uastc').replace(/\\/g, '/'))
      .toBe('/cache/games/g/assets/t/rock.png/deadbeef/uastc.ktx2');
  });

  it('uses the right extension per variant', () => {
    // `[\\/]` accepts either separator (backslash on Windows).
    expect(cachePathFor('/c', '/x.png', 'h', 'webp')).toMatch(/[\\/]webp\.webp$/);
    expect(cachePathFor('/c', '/x.png', 'h', 'png')).toMatch(/[\\/]png\.png$/);
    expect(cachePathFor('/c', '/x.png', 'h', 'astc')).toMatch(/[\\/]astc\.ktx2$/);
  });
});

describe('texture-cache cacheHit', () => {
  const src = '/assets/t/rock.png';
  const hash = 'cafebabe';
  const write = (dir: string, bytes: number) => {
    const p = cachePathFor(dir, src, hash, 'uastc');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
    return p;
  };

  it('is a hit when the variant exists and is non-empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texcache-'));
    try {
      write(dir, 128);
      expect(cacheHit(dir, src, hash, 'ktx2-uastc', '3d')).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a MISS when the variant is a 0-byte poison (interrupted encode)', () => {
    // Regression guard: an interrupted toktx write leaves a 0-byte file at the final
    // cache path. Counting it as a hit skips re-encoding on reimport forever and ships
    // an empty KTX2 that fails to load at runtime ("Texture load failed: <guid> {}").
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texcache-'));
    try {
      write(dir, 0);
      expect(cacheHit(dir, src, hash, 'ktx2-uastc', '3d')).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a miss when the variant is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texcache-'));
    try {
      expect(cacheHit(dir, src, hash, 'ktx2-uastc', '3d')).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
