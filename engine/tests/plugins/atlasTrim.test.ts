/** Atlas trim (`AtlasSource.trim`): each member is cropped to its visible pixels before packing, and the crop is
 *  recorded so a sprite drawn from it keeps its full size and pivot. Over the real packer + sharp compositor.
 *
 *  The fixture is a shard cut out of a whole block, as Ice Reef's debris is: a 32 x 32 image whose only visible
 *  pixels are a 10 x 6 patch at (5, 20). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { atlasReimportHandler } from '../../plugins/reimport-atlas';
import { getCacheDir, cachePathFor } from '../../plugins/texture-cache';
import { atlasPageUrlPath } from '../../plugins/atlas-cache';
import { readMetaSidecar } from '../../plugins/meta-sidecar';
import type { ReimportAsset, ReimportContext } from '../../plugins/reimport-registry';
import { alphaBounds, type AtlasCacheBlock } from '../../packages/modoki/src/runtime/loaders/spriteAtlas';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const TEX = 'aaaaaaaa-2222-4222-8222-222222222222';
const SP = 'cccccccc-2222-4222-8222-222222222222';
const ATLAS = 'eeeeeeee-2222-4222-8222-222222222222';
const ATLAS_URL = '/assets/sprites/trim.atlas.json';
const PATCH = { x: 5, y: 20, w: 10, h: 6 };

let projectRoot: string;
let atlasAbs: string;
let texAbs: string;

beforeAll(async () => {
  projectRoot = makeScratchDir('modoki-atlastrim-');
  const assets = path.join(projectRoot, 'assets');
  fs.mkdirSync(path.join(assets, 'tex'), { recursive: true });
  fs.mkdirSync(path.join(assets, 'sprites'), { recursive: true });
  atlasAbs = path.join(assets, 'sprites', 'trim.atlas.json');
  texAbs = path.join(assets, 'tex', 'shard.png');
  const sharp = (await import('sharp')).default;
  const buf = Buffer.alloc(32 * 32 * 4);
  for (let y = PATCH.y; y < PATCH.y + PATCH.h; y++) {
    for (let x = PATCH.x; x < PATCH.x + PATCH.w; x++) buf.set([30, 200, 90, 255], (y * 32 + x) * 4);
  }
  await sharp(buf, { raw: { width: 32, height: 32, channels: 4 } }).png().toFile(texAbs);
});
afterAll(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

const assets = (): ReimportAsset[] => [
  { guid: TEX, type: 'texture', path: '/assets/tex/shard.png', absPath: texAbs },
  { guid: SP, type: 'sprite', path: `/assets/tex/shard.png#${SP}`, sprite: { texture: TEX, rect: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } } },
];
const ctx = (): ReimportContext => ({ projectRoot, resolveAssetPath: () => null, listAssets: assets });

async function pack(trim: boolean): Promise<AtlasCacheBlock> {
  fs.writeFileSync(atlasAbs, JSON.stringify({
    id: ATLAS, version: 1, members: [SP], pageSize: 64, padding: 2, extrude: 1, ...(trim ? { trim: true } : {}),
    texture: { format: 'png', maxSize: 1024, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
  }));
  await atlasReimportHandler(ATLAS_URL, atlasAbs, ctx());
  return readMetaSidecar(atlasAbs).atlasCache as AtlasCacheBlock;
}

describe('alphaBounds', () => {
  it('finds the visible pixels, and says when there are none', () => {
    const w = 4, h = 3, data = new Uint8Array(w * h * 4);
    data[(1 * w + 2) * 4 + 3] = 9;
    data[(2 * w + 1) * 4 + 3] = 255;
    expect(alphaBounds(data, w, h, 4)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(alphaBounds(new Uint8Array(w * h * 4), w, h, 4)).toBeNull();
  });
});

describe('a trimmed atlas', () => {
  it('packs only the visible patch, and records where it sat in the full frame', async () => {
    const block = await pack(true);
    const f = block.frames[SP];
    expect([f.rect.w, f.rect.h]).toEqual([PATCH.w, PATCH.h]);
    expect(f.trim).toEqual(PATCH);
    expect(f.orig).toEqual({ w: 32, h: 32 });
    // The page holds the patch's pixels at the frame rect, not the transparent border.
    const sharp = (await import('sharp')).default;
    const file = cachePathFor(getCacheDir(projectRoot), atlasPageUrlPath(ATLAS_URL, f.page), block.pages[f.page].hash, 'png');
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels + info.channels - 1];
    expect(at(f.rect.x, f.rect.y)).toBe(255);
    expect(at(f.rect.x + f.rect.w - 1, f.rect.y + f.rect.h - 1)).toBe(255);
    expect(info.width * info.height, 'the page is sized to the patch, not the frame').toBeLessThan(32 * 32);
  });

  it('is untouched without the option: the whole frame, no trim fields, and a different cache key', async () => {
    const trimmed = await pack(true);
    const whole = await pack(false);
    const f = whole.frames[SP];
    expect([f.rect.w, f.rect.h]).toEqual([32, 32]);
    expect(f.trim).toBeUndefined();
    expect(f.orig).toBeUndefined();
    expect(whole.hash).not.toBe(trimmed.hash);
  });
});
