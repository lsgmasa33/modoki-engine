/** Texture conversion pipeline — end-to-end over the REAL encoders.
 *
 *  Generates a source PNG (sharp), runs `convertTexture` for each format, and
 *  asserts the derived variants are actually produced + well-formed:
 *    • WebP / PNG via sharp (no external CLI),
 *    • KTX2 (UASTC / ETC1S / native-ASTC) via the real `toktx` binary,
 *    • dimensions downscaled to the max-size cap and snapped to a multiple of 4
 *      (block-compression requirement),
 *    • mip levels baked when requested,
 *    • a second convert is a cache hit.
 *
 *  KTX formats are gated on `toktx` being on PATH; if it is missing those cases
 *  skip (WebP/PNG still run) so CI without KTX-Software stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { convertTexture, __resetKtxCheck } from '../../plugins/texture-convert';
import { getCacheDir, cachePathFor } from '../../plugins/texture-cache';
import {
  DEFAULT_TEXTURE_SETTINGS, variantsForFormat, variantExtension,
  type TextureFormat, type TextureImportSettings, type TextureType, type TextureVariant,
} from '../../packages/modoki/src/runtime/loaders/textureSettings';

function toktxPresent(): boolean {
  try { execFileSync('toktx', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_TOKTX = toktxPresent();

const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function isKtx2(file: string): boolean {
  const head = fs.readFileSync(file).subarray(0, 12);
  return head.equals(KTX2_MAGIC);
}

let dir: string;
let projectRoot: string;
let srcPath: string;
// Deliberately non-square AND not a multiple of 4 (130×70) so the snap-to-4 +
// downscale logic has something to do.
const SRC_W = 130;
const SRC_H = 70;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-texsrc-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-texproj-'));
  srcPath = path.join(dir, 'source.png');
  const sharp = (await import('sharp')).default;
  const channels = 4;
  const buf = Buffer.alloc(SRC_W * SRC_H * channels);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      const o = (y * SRC_W + x) * channels;
      buf[o] = on ? 200 : 30; buf[o + 1] = on ? 120 : 60; buf[o + 2] = on ? 40 : 180; buf[o + 3] = 255;
    }
  }
  await sharp(buf, { raw: { width: SRC_W, height: SRC_H, channels } }).png().toFile(srcPath);
}, 30_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function settings(format: TextureFormat, over: Partial<TextureImportSettings> = {}): TextureImportSettings {
  return { ...DEFAULT_TEXTURE_SETTINGS, format, maxSize: 64, mipmaps: true, ...over };
}

async function run(format: TextureFormat, over: Partial<TextureImportSettings> = {}, textureType?: TextureType) {
  __resetKtxCheck();
  const s = settings(format, over);
  // Distinct cache path per (format, type) so the 3d vs 2d ktx2 cases don't collide.
  const urlPath = `/games/test/assets/textures/${format}${textureType ? '-' + textureType : ''}/source.png`;
  const result = await convertTexture({
    projectRoot,
    sourceUrlPath: urlPath,
    absSource: srcPath,
    settings: s,
    textureType,
  });
  const cacheDir = getCacheDir(projectRoot);
  const files = result.variants.map((v) => cachePathFor(cacheDir, urlPath, result.hash, v));
  return { result, files, settings: s };
}

describe('texture conversion pipeline (real encoders)', () => {
  it('WebP: produces a webp variant, downscaled + snapped to multiple of 4', async () => {
    const { result, files } = await run('webp');
    expect(result.variants).toEqual(['webp']);
    expect(fs.existsSync(files[0])).toBe(true);
    expect(variantExtension('webp')).toBe('webp');
    // 130×70 capped at 64 → scale 64/130 → ~64×34 → snapped to 64×36.
    expect(result.width % 4).toBe(0);
    expect(result.height % 4).toBe(0);
    expect(result.width).toBeLessThanOrEqual(64);
    expect(result.height).toBeLessThanOrEqual(64);
    expect(result.variantBytes.webp).toBeGreaterThan(0);
    // sharp tags WebP files with a RIFF/WEBP container.
    const head = fs.readFileSync(files[0]);
    expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(head.subarray(8, 12).toString('ascii')).toBe('WEBP');
  }, 30_000);

  it('PNG: passes through resized bytes as a valid PNG', async () => {
    const { result, files } = await run('png');
    expect(result.variants).toEqual(['png']);
    const head = fs.readFileSync(files[0]).subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }, 30_000);

  it('second convert is a cache hit (no re-encode)', async () => {
    const first = await run('webp');
    const second = await run('webp');
    expect(second.result.cached).toBe(true);
    expect(second.result.hash).toBe(first.result.hash);
  }, 30_000);

  it('changing settings changes the content hash', async () => {
    const a = await run('webp', { maxSize: 64 });
    const b = await run('webp', { maxSize: 256 });
    expect(b.result.hash).not.toBe(a.result.hash);
  }, 30_000);

  (HAS_TOKTX ? describe : describe.skip)('KTX2 (real toktx)', () => {
    it('UASTC: emits a valid KTX2 with baked mip levels', async () => {
      const { result, files } = await run('ktx2-uastc', { mipmaps: true });
      expect(result.variants).toEqual(['uastc']);
      expect(isKtx2(files[0])).toBe(true);
      expect(variantExtension('uastc')).toBe('ktx2');
      expect(result.width % 4).toBe(0);
      expect(result.height % 4).toBe(0);
      // mipmaps on a 64×36 image → log2(64)+1 = 7 levels.
      expect(result.mipLevels).toBeGreaterThan(1);
      expect(result.variantBytes.uastc).toBeGreaterThan(0);
    }, 60_000);

    it('ETC1S: emits a valid KTX2', async () => {
      const { result, files } = await run('ktx2-etc1s');
      expect(result.variants).toEqual(['etc1s']);
      expect(isKtx2(files[0])).toBe(true);
    }, 60_000);

    it('2D/UI ktx2 texture ALSO emits a WebP browser sibling (3D does not)', async () => {
      // A 2d/ui texture stays KTX2 for the runtime (PixiJS) but gains a WebP sibling for
      // the editor Canvas2D preview + DOM. A 3d texture (default inference above) does not.
      const { result, files } = await run('ktx2-uastc', { mipmaps: false }, '2d');
      expect(result.variants).toEqual(['uastc', 'webp']);
      expect(isKtx2(files[0])).toBe(true);          // GPU variant is real KTX2
      expect(fs.existsSync(files[1])).toBe(true);    // browser sibling is a real file
      expect(result.variantBytes.webp).toBeGreaterThan(0);
    }, 60_000);

    it('native ASTC: emits both astc + uastc fallback variants', async () => {
      const { result, files } = await run('ktx2-astc');
      // variantsForFormat('ktx2-astc') = ['astc', 'uastc'] (native + universal fallback).
      expect(result.variants).toEqual(variantsForFormat('ktx2-astc'));
      for (const f of files) expect(isKtx2(f)).toBe(true);
      expect(result.variants).toContain('astc' as TextureVariant);
      expect(result.variants).toContain('uastc' as TextureVariant);
    }, 60_000);

    it('mipmaps off → single level', async () => {
      const { result } = await run('ktx2-uastc', { mipmaps: false });
      expect(result.mipLevels).toBe(1);
    }, 60_000);
  });

  if (!HAS_TOKTX) {
    it.skip('toktx not on PATH — KTX2 variant tests skipped', () => {});
  }
});
