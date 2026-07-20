/** Atlas tree-shaker tests — a packed sprite member keeps the ATLAS (+ its generated
 *  pages) and drops the now-redundant source texture, while a whole-texture reference
 *  still keeps the source. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeKeptAssets } from '../../plugins/asset-tree-shaker';
import type { AssetRoot } from '../../plugins/vite-asset-scanner';
import { deriveGuid } from '../../packages/modoki/src/runtime/loaders/assetRefRules';

const TEX_GUID = '11111111-1111-4111-8111-111111111111';
const SLICE_GUID = '22222222-2222-4222-8222-222222222222';
const ATLAS_GUID = '33333333-3333-4333-8333-333333333333';

const TEX = '/games/test/assets/tex/slime.png';
const ATLAS = '/games/test/assets/sprites/pack.atlas.json';

function createRoots(projectRoot: string): AssetRoot[] {
  const gameAssetsAbs = path.join(projectRoot, 'games/test/runtime/assets');
  fs.mkdirSync(gameAssetsAbs, { recursive: true });
  return [{ urlPrefix: '/games/test/assets', absDir: gameAssetsAbs }];
}

let projectRoot: string;
let roots: AssetRoot[];
const abs = (virtual: string) => path.join(roots[0].absDir, virtual.substring('/games/test/assets'.length + 1));
function write(virtual: string, content: string) {
  const a = abs(virtual);
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.writeFileSync(a, content);
}

/** Write the texture PNG + its sidecar (id + one slice), shared by both tests. */
function writeTexture() {
  write(TEX, 'fake-png-bytes');
  write(`${TEX}.meta.json`, JSON.stringify({
    id: TEX_GUID, version: 2,
    sprites: [{ guid: SLICE_GUID, name: 'slime0', rect: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } }],
  }));
}

/** Write the atlas source + its built sidecar (frames map names SLICE_GUID a member). */
function writeBuiltAtlas() {
  write(ATLAS, JSON.stringify({ id: ATLAS_GUID, version: 1, members: [SLICE_GUID], pageSize: 64, padding: 2, extrude: 1 }));
  write(`${ATLAS}.meta.json`, JSON.stringify({
    atlasCache: {
      hash: 'ah', texture: { format: 'webp', maxSize: 1024, mipmaps: false, wrapS: 'clamp', wrapT: 'clamp', colorspace: 'srgb' },
      pages: [{ hash: 'p0', variants: ['webp'], w: 64, h: 64 }],
      frames: { [SLICE_GUID]: { page: 0, rect: { x: 1, y: 1, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } } },
    },
  }));
}

function scene2DSprite(ref: string) {
  write('/games/test/assets/scenes/main.json', JSON.stringify({
    version: 6, resources: [],
    entities: [{ traits: { Renderable2D: { sprite: ref } } }],
  }));
}

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-shaker-')); roots = createRoots(projectRoot); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('asset-tree-shaker — atlas', () => {
  it('a packed member keeps the atlas and drops the source texture', () => {
    writeTexture();
    writeBuiltAtlas();
    scene2DSprite(SLICE_GUID); // reference the packed slice

    const result = computeKeptAssets(projectRoot, roots);

    expect(result.kept).toContain(ATLAS);
    expect(result.kept).not.toContain(TEX); // fully-packed source dropped
  });

  it('a whole-texture reference keeps the source texture', () => {
    writeTexture();
    writeBuiltAtlas();
    scene2DSprite(TEX_GUID); // reference the whole texture, not the slice

    const result = computeKeptAssets(projectRoot, roots);

    expect(result.kept).toContain(TEX);
  });

  it('a reference to a 2D texture\'s auto whole-image sprite keeps the texture (no atlas)', () => {
    // A 2D texture with NO explicit slices exposes a derived whole-image sprite
    // (deriveGuid('sprite:'+texGuid)); a scene ref to THAT must keep the texture.
    write(TEX, 'fake-png-bytes');
    write(`${TEX}.meta.json`, JSON.stringify({ id: TEX_GUID, version: 2, type: '2d', texture: { format: 'webp' } }));
    scene2DSprite(deriveGuid('sprite:' + TEX_GUID));

    const result = computeKeptAssets(projectRoot, roots);

    expect(result.kept).toContain(TEX);
  });

  it('a member ref keeps an UNPACKED atlas on a clean build (authored members[], no atlasCache)', () => {
    // The atlas has never been packed (no sidecar frames). A ref to an authored
    // member must still keep the atlas file so the atlas-shaker CAN pack it.
    write(TEX, 'fake-png-bytes');
    write(`${TEX}.meta.json`, JSON.stringify({ id: TEX_GUID, version: 2, type: '2d', texture: { format: 'webp' } }));
    const member = deriveGuid('sprite:' + TEX_GUID);
    write(ATLAS, JSON.stringify({ id: ATLAS_GUID, version: 1, members: [member], pageSize: 64, padding: 2, extrude: 1 }));
    // NO atlas .meta.json — unpacked.
    scene2DSprite(member);

    const result = computeKeptAssets(projectRoot, roots);

    expect(result.kept).toContain(ATLAS);      // kept so it can be packed
    expect(result.kept).not.toContain(TEX);    // member redirects to the atlas
  });
});
