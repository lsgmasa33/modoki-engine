/** Atlas reimport — end-to-end over the real packer + sharp compositor.
 *
 *  Builds two solid-colour source textures + a `.atlas.json` referencing one slice of
 *  each, runs `atlasReimportHandler`, and asserts: the sidecar `atlasCache` is written
 *  with a frame per member; each page's PNG variant lands in the texture cache; the
 *  composited pixels match the source at each frame rect AND in the extrude gutter
 *  (edge-replication bleed); and the content hash changes when a member rect changes.
 *
 *  Uses PNG page format (lossless, sharp-only) so pixel asserts are exact and no `toktx`
 *  is needed. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atlasReimportHandler } from '../../plugins/reimport-atlas';
import { getCacheDir, cachePathFor } from '../../plugins/texture-cache';
import { atlasPageUrlPath } from '../../plugins/atlas-cache';
import { readMetaSidecar } from '../../plugins/meta-sidecar';
import type { ReimportAsset, ReimportContext } from '../../plugins/reimport-registry';
import type { AtlasCacheBlock } from '../../packages/modoki/src/runtime/loaders/spriteAtlas';

const TEX_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TEX_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const SP_A = 'cccccccc-1111-4111-8111-111111111111';
const SP_B = 'dddddddd-1111-4111-8111-111111111111';
const ATLAS = 'eeeeeeee-1111-4111-8111-111111111111';

const ATLAS_URL = '/assets/sprites/test.atlas.json';
const TEX_A_URL = '/assets/tex/a.png';
const TEX_B_URL = '/assets/tex/b.png';

let projectRoot: string;
let assetsDir: string;
let atlasAbs: string;
let texAabs: string;
let texBabs: string;

async function solidPng(abs: string, w: number, h: number, rgb: [number, number, number]) {
  const sharp = (await import('sharp')).default;
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = rgb[0]; buf[i * 4 + 1] = rgb[1]; buf[i * 4 + 2] = rgb[2]; buf[i * 4 + 3] = 255; }
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(abs);
}

function writeAtlas(members: string[], opts: { pageSize: number; padding: number; extrude: number }) {
  fs.writeFileSync(atlasAbs, JSON.stringify({
    id: ATLAS, version: 1, members,
    pageSize: opts.pageSize, padding: opts.padding, extrude: opts.extrude,
    texture: { format: 'png', maxSize: 1024, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
  }, null, 2));
}

/** A member's slice rect (the whole 32×32 source). */
const RECT_A = { x: 0, y: 0, w: 32, h: 32 };
const RECT_B = { x: 0, y: 0, w: 32, h: 32 };

function listAssets(rectA = RECT_A): ReimportAsset[] {
  return [
    { guid: TEX_A, type: 'texture', path: TEX_A_URL, absPath: texAabs },
    { guid: TEX_B, type: 'texture', path: TEX_B_URL, absPath: texBabs },
    { guid: SP_A, type: 'sprite', path: `${TEX_A_URL}#${SP_A}`, sprite: { texture: TEX_A, rect: rectA, pivot: { x: 0.5, y: 0.5 } } },
    { guid: SP_B, type: 'sprite', path: `${TEX_B_URL}#${SP_B}`, sprite: { texture: TEX_B, rect: RECT_B, pivot: { x: 0.5, y: 0.5 } } },
  ];
}

function ctxFor(assets: ReimportAsset[]): ReimportContext {
  return { projectRoot, resolveAssetPath: () => null, listAssets: () => assets };
}

beforeAll(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-atlasproj-'));
  assetsDir = path.join(projectRoot, 'assets');
  fs.mkdirSync(path.join(assetsDir, 'tex'), { recursive: true });
  fs.mkdirSync(path.join(assetsDir, 'sprites'), { recursive: true });
  atlasAbs = path.join(assetsDir, 'sprites', 'test.atlas.json');
  texAabs = path.join(assetsDir, 'tex', 'a.png');
  texBabs = path.join(assetsDir, 'tex', 'b.png');
  await solidPng(texAabs, 32, 32, [220, 20, 20]);   // red
  await solidPng(texBabs, 32, 32, [20, 200, 20]);   // green
});

afterAll(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

/** Decode a cached page PNG to raw RGBA. */
async function decodePage(block: AtlasCacheBlock, page: number) {
  const sharp = (await import('sharp')).default;
  const file = cachePathFor(getCacheDir(projectRoot), atlasPageUrlPath(ATLAS_URL, page), block.pages[page].hash, 'png');
  expect(fs.existsSync(file)).toBe(true);
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}
const px = (img: { data: Buffer; w: number; ch: number }, x: number, y: number) => {
  const o = (y * img.w + x) * img.ch;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.ch > 3 ? img.data[o + 3] : 255];
};

describe('atlasReimportHandler', () => {
  it('packs members, writes the sidecar cache + page files, and composites pixels + bleed', async () => {
    writeAtlas([SP_A, SP_B], { pageSize: 128, padding: 4, extrude: 2 });
    await atlasReimportHandler(ATLAS_URL, atlasAbs, ctxFor(listAssets()));

    const block = readMetaSidecar(atlasAbs).atlasCache as AtlasCacheBlock;
    expect(block).toBeTruthy();
    expect(Object.keys(block.frames).sort()).toEqual([SP_A, SP_B].sort());
    expect(block.pages.length).toBeGreaterThanOrEqual(1);
    expect(block.pages[0].variants).toContain('png');

    // Each member's frame rect on the page renders its source colour, and the extrude
    // gutter just outside the rect carries the SAME colour (edge-replication bleed).
    const colorOf: Record<string, [number, number, number]> = { [SP_A]: [220, 20, 20], [SP_B]: [20, 200, 20] };
    for (const guid of [SP_A, SP_B]) {
      const f = block.frames[guid];
      const img = await decodePage(block, f.page);
      const [r, g, b] = px(img, f.rect.x + 1, f.rect.y + 1); // inside the frame
      const [er, eg, eb] = px(img, f.rect.x - 1, f.rect.y + 1); // one px into the gutter (bleed)
      const [tr, tg, tb] = colorOf[guid];
      expect(Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb)).toBeLessThan(20);
      expect(Math.abs(er - tr) + Math.abs(eg - tg) + Math.abs(eb - tb)).toBeLessThan(20);
    }
  });

  it('skips re-encoding when nothing changed (stable hash)', async () => {
    writeAtlas([SP_A, SP_B], { pageSize: 128, padding: 4, extrude: 2 });
    await atlasReimportHandler(ATLAS_URL, atlasAbs, ctxFor(listAssets()));
    const h1 = (readMetaSidecar(atlasAbs).atlasCache as AtlasCacheBlock).hash;
    await atlasReimportHandler(ATLAS_URL, atlasAbs, ctxFor(listAssets()));
    const h2 = (readMetaSidecar(atlasAbs).atlasCache as AtlasCacheBlock).hash;
    expect(h2).toBe(h1);
  });

  it('changes the content hash when a member slice rect changes', async () => {
    writeAtlas([SP_A, SP_B], { pageSize: 128, padding: 4, extrude: 2 });
    await atlasReimportHandler(ATLAS_URL, atlasAbs, ctxFor(listAssets()));
    const before = (readMetaSidecar(atlasAbs).atlasCache as AtlasCacheBlock).hash;
    // Shrink slice A's rect → different layout + hash.
    await atlasReimportHandler(ATLAS_URL, atlasAbs, ctxFor(listAssets({ x: 0, y: 0, w: 16, h: 16 })));
    const after = (readMetaSidecar(atlasAbs).atlasCache as AtlasCacheBlock).hash;
    expect(after).not.toBe(before);
  });
});
