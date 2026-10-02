/** #2065 — the atlas pack gate keys what the page ENCODER receives, not the authored block.
 *
 *  The gate (`packAtlasAsset`: skip when `prev.hash === atlasHash` and every page is cached) used a
 *  key over three authored `src.texture` fields. So the playable profile's WebP override — applied
 *  in `pageSettings()`, never visible in the authored block — did not move it: a playable build
 *  after a normal pack found the normal KTX2 pack "up to date" (its WebP sibling satisfied the
 *  cache check) and shipped the KTX2 pages. Reproduced on skin-test before the fix.
 *
 *  `convertTexture` is faked here: it writes a placeholder file per variant at the real cache path
 *  under the real `hashKey`. The encoder is not the mechanism under test (the gate is), and a real
 *  `ktx2-*` encode would need the pinned toktx — which is exactly the format the bug needs, since
 *  only a `ktx2-*` 2d page emits the WebP sibling that made the stale pack look complete. */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { TextureImportSettings } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import type { AtlasSource } from '../../packages/modoki/src/runtime/loaders/spriteAtlas';
import type { ReimportAsset, ReimportContext } from '../../plugins/reimport-registry';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

vi.mock('../../plugins/texture-convert', async () => {
  const { getCacheDir, hashKey, cachePathFor } = await import('../../plugins/texture-cache');
  const { variantsToEmit } = await import('../../packages/modoki/src/runtime/loaders/textureSettings');
  return {
    convertTexture: async (o: { projectRoot: string; sourceUrlPath: string; absSource: string; settings: TextureImportSettings; textureType: '2d' }) => {
      const hash = hashKey(fs.readFileSync(o.absSource), o.settings);
      const variants = variantsToEmit(o.settings.format, o.textureType);
      for (const v of variants) {
        const p = cachePathFor(getCacheDir(o.projectRoot), o.sourceUrlPath, hash, v);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `fake ${v}`);
      }
      return { hash, variants };
    },
  };
});

const { packAtlasAsset } = await import('../../plugins/reimport-atlas');
const { atlasHashKey } = await import('../../plugins/atlas-cache');

const TEX = 'aaaaaaaa-2065-4111-8111-111111111111';
const SPRITE = 'cccccccc-2065-4111-8111-111111111111';
const ATLAS_URL = '/assets/sprites/k.atlas.json';

let projectRoot: string;
let atlasAbs: string;
let texAbs: string;

beforeAll(async () => {
  projectRoot = makeScratchDir('modoki-atlaskey-');
  fs.mkdirSync(path.join(projectRoot, 'assets', 'sprites'), { recursive: true });
  atlasAbs = path.join(projectRoot, 'assets', 'sprites', 'k.atlas.json');
  texAbs = path.join(projectRoot, 'assets', 'sprites', 't.png');
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toFile(texAbs);
  fs.writeFileSync(atlasAbs, JSON.stringify({
    id: 'eeeeeeee-2065-4111-8111-111111111111', version: 1, members: [SPRITE], pageSize: 64, padding: 2, extrude: 1,
    texture: { format: 'ktx2-uastc', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
  }));
});
afterAll(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

const PLAYABLE = process.env.MODOKI_PLAYABLE;
afterEach(() => {
  if (PLAYABLE === undefined) delete process.env.MODOKI_PLAYABLE; else process.env.MODOKI_PLAYABLE = PLAYABLE;
});

const ctx = (): ReimportContext => ({
  projectRoot,
  resolveAssetPath: () => null,
  listAssets: (): ReimportAsset[] => [
    { guid: TEX, type: 'texture', path: '/assets/sprites/t.png', absPath: texAbs },
    { guid: SPRITE, type: 'sprite', path: `/assets/sprites/t.png#${SPRITE}`, sprite: { texture: TEX, rect: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 } } },
  ],
});

describe('atlas pack gate vs the playable WebP override (#2065)', () => {
  it('a playable pack after a normal pack re-packs to WebP pages and leaves the committed sidecar alone', async () => {
    delete process.env.MODOKI_PLAYABLE;
    const normal = await packAtlasAsset(ATLAS_URL, atlasAbs, ctx());
    expect(normal.texture.format).toBe('ktx2-uastc');
    expect(normal.pages[0].variants).toEqual(['uastc', 'webp']); // the WebP sibling the stale gate accepted
    const sidecar = fs.readFileSync(`${atlasAbs}.meta.json`, 'utf8');

    process.env.MODOKI_PLAYABLE = '1';
    const playable = await packAtlasAsset(ATLAS_URL, atlasAbs, ctx());
    expect(playable.texture.format).toBe('webp');
    expect(playable.pages.map((p) => p.variants)).toEqual([['webp']]);
    expect(playable.hash).not.toBe(normal.hash);
    // The playable override is a build profile, not authored data — the committed sidecar keeps
    // the normal pack, so a playable build leaves the tree clean.
    expect(fs.readFileSync(`${atlasAbs}.meta.json`, 'utf8')).toBe(sidecar);

    // ...and the normal profile still finds its own pack up to date afterwards.
    delete process.env.MODOKI_PLAYABLE;
    expect(await packAtlasAsset(ATLAS_URL, atlasAbs, ctx())).toEqual(normal);
  });
});

describe('atlasHashKey keys every encoder setting and every pack option (#2065)', () => {
  const members = [{ guid: SPRITE, textureBytes: Buffer.from('px'), rect: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 } }];
  const src: AtlasSource = { id: 'a', version: 1, members: [SPRITE], pageSize: 64, padding: 2, extrude: 1, maxPages: 2 };
  // `sizes` is the one field exempt, by name: it is BUILD-BAKED output metadata (which tier caps got
  // a variant, written after the encode — vite-asset-scanner's `settings.sizes = capSizes`), and
  // each cap is encoded through its own settings with its own `maxSize`. Not an encoder input, so
  // neither this key nor the texture key hashes it. A NEW field still has to be decided here.
  type EncoderSettings = Omit<Required<TextureImportSettings>, 'sizes'>;
  const base: EncoderSettings = {
    format: 'ktx2-uastc', maxSize: 2048, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb',
    flipY: true, flipGreen: true, webpQuality: 80, uastcLevel: 2, uastcRdoLambda: 1,
  };
  // A mapped type over EVERY key of TextureImportSettings: a field added to the settings type
  // must be given a perturbation here, or this file stops typechecking. Optional fields are
  // perturbed by dropping them (set → unset), which the texture key distinguishes by contract.
  const PERTURB: { [K in keyof EncoderSettings]: TextureImportSettings[K] } = {
    format: 'webp', maxSize: 1024, mipmaps: true, wrapS: 'repeat', wrapT: 'repeat', colorspace: 'linear',
    flipY: undefined, flipGreen: undefined, webpQuality: undefined, uastcLevel: undefined, uastcRdoLambda: undefined,
  };
  const ref = atlasHashKey(members, src, base);

  it.each(Object.keys(PERTURB) as (keyof EncoderSettings)[])('page setting %s moves the key', (k) => {
    expect(atlasHashKey(members, src, { ...base, [k]: PERTURB[k] })).not.toBe(ref);
  });

  it.each([
    ['pageSize', 128], ['padding', 3], ['extrude', 2], ['maxPages', 3], ['trim', true],
  ] as const)('pack option %s moves the key', (k, v) => {
    expect(atlasHashKey(members, { ...src, [k]: v }, base)).not.toBe(ref);
  });

  it('identity fields and the authored texture block do not — they are keyed through other inputs', () => {
    expect(atlasHashKey(members, { ...src, id: 'b', version: 2, members: ['x'] }, base)).toBe(ref);
    // The authored block reaches the key only through the resolved settings argument.
    expect(atlasHashKey(members, { ...src, texture: { ...base, format: 'png' } }, base)).toBe(ref);
  });
});
