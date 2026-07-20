/** Phase 7 — atlas / sliced-sprite skinning. A rig whose `sprite` is a SLICE of a sheet
 *  must render the deformed mesh from that sub-rect: the buffer carries a normalized
 *  `uvRect` and the renderer remaps the 0..1 sprite-local UVs into it. Whole-image rigs
 *  are unchanged (no uvRect). Headless — asserts the buffer, no renderer. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../../src/runtime/traits';
import { skin2DSystem } from '../../src/runtime/systems/skin2DSystem';
import { getSkin2DBuffer, clearSkin2DBuffers, frameSkin2DUVs } from '../../src/runtime/systems/skin2DBuffers';
import { setRig2D, clearRig2DCache } from '../../src/runtime/loaders/rig2dCache';
import { clearManifest, registerAsset, registerSprite } from '../../src/runtime/loaders/assetManifest';
import { DEFAULT_TEXTURE_SETTINGS } from '../../src/runtime/loaders/textureSettings';

const SHEET = 'aaaaaaaa-0000-4000-8000-000000000001';
const SLICE = 'bbbbbbbb-0000-4000-8000-000000000002';
const SHEET_PATH = '/games/x/assets/textures/darkassassin.png';

function makeRig(sprite: string) {
  return {
    id: '', sprite,
    bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
    mesh: {
      verts: [[0, 0], [16, 0], [16, 16], [0, 16]],
      uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
      tris: [0, 1, 2, 0, 2, 3],
    },
    skinIndices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    skinWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  };
}

let world: ReturnType<typeof createWorld> | undefined;
afterEach(() => { world?.destroy(); world = undefined; clearSkin2DBuffers(); clearRig2DCache(); clearManifest(); });

function run(rigKey: string) {
  world = createWorld();
  const root = world.spawn(Transform(), SkinnedSprite2D({ rig: rigKey }));
  world.spawn(Transform(), Bone2D({ name: 'root' }), EntityAttributes({ guid: 'rb', parentId: root.id() }));
  skin2DSystem(world);
  return getSkin2DBuffer(root.id())!;
}

describe('frameSkin2DUVs', () => {
  it('remaps sprite-local 0..1 UVs into a sheet sub-rect', () => {
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0.5, 0.5]);
    const out = frameSkin2DUVs(uvs, { u0: 0.25, v0: 0.0, uw: 0.25, vh: 0.125 });
    expect(Array.from(out)).toEqual([0.25, 0, 0.5, 0, 0.5, 0.125, 0.375, 0.0625]);
  });
  it('returns a copy (not the same ref) when no rect is given', () => {
    const uvs = new Float32Array([0.25, 0.5]); // f32-exact so equality is clean
    const out = frameSkin2DUVs(uvs, undefined);
    expect(Array.from(out)).toEqual([0.25, 0.5]);
    expect(out).not.toBe(uvs);
  });
});

describe('skin2DSystem — sliced-sprite rig', () => {
  it('carries a normalized uvRect for a sprite carved from a sheet', () => {
    registerAsset(SHEET, SHEET_PATH, 'texture');
    registerSprite(SLICE, SHEET, SHEET_PATH, {
      texture: SHEET, rect: { x: 64, y: 32, w: 128, h: 64 }, pivot: { x: 0.5, y: 0.5 }, sheetW: 256, sheetH: 512,
    });
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D('slice.rig2d.json', makeRig(SLICE));
    const buf = run('slice.rig2d.json').parts[0];
    expect(buf.url).toBeTruthy();
    // Normalized frame: x/sheetW, y/sheetH, w/sheetW, h/sheetH — resolution independent.
    expect(buf.uvRect).toEqual({ u0: 64 / 256, v0: 32 / 512, uw: 128 / 256, vh: 64 / 512 });
    // The mesh's corner UVs, remapped, land on the slice's corners in the sheet.
    const framed = frameSkin2DUVs(buf.uvs, buf.uvRect);
    expect(framed[0]).toBeCloseTo(0.25, 6);      // u 0 → 64/256
    expect(framed[2]).toBeCloseTo(0.75, 6);      // u 1 → (64+128)/256
  });

  it('leaves uvRect undefined for a whole-image rig', () => {
    registerAsset(SHEET, SHEET_PATH, 'texture');
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D('whole.rig2d.json', makeRig(SHEET));
    const buf = run('whole.rig2d.json').parts[0];
    expect(buf.url).toBeTruthy();
    expect(buf.uvRect).toBeUndefined();
  });

  it('rebuilds a rig whose sprite resolves LATE — cold scene-load race (regression: DarkAssassin blank on launch)', () => {
    // The skin system can run before the scene's textures/atlas register in the manifest
    // (cold editor open). The first build then resolves nothing → textureless mesh. It
    // must retry and pick up the URL once the asset arrives — NOT stay blank behind the
    // idle fast-path until a manual reload.
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D('cold.rig2d.json', makeRig(SLICE));
    world = createWorld();
    const root = world.spawn(Transform(), SkinnedSprite2D({ rig: 'cold.rig2d.json' }));
    world.spawn(Transform(), Bone2D({ name: 'root' }), EntityAttributes({ guid: 'rb', parentId: root.id() }));

    // Pass 1 — asset not registered yet → unresolved, textureless buffer.
    skin2DSystem(world);
    expect(getSkin2DBuffer(root.id())!.parts[0].url).toBe('');

    // The scene's resources finish acquiring (texture + slice now in the manifest).
    registerAsset(SHEET, SHEET_PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' });
    registerSprite(SLICE, SHEET, SHEET_PATH, {
      texture: SHEET, rect: { x: 64, y: 32, w: 128, h: 64 }, pivot: { x: 0.5, y: 0.5 }, sheetW: 256, sheetH: 512,
    });

    // Pass 2 — the retry rebuilds and resolves the URL + uvRect (no reload needed).
    skin2DSystem(world);
    const part = getSkin2DBuffer(root.id())!.parts[0];
    expect(part.url).toContain(SHEET_PATH + '~webp.webp');
    expect(part.uvRect).toEqual({ u0: 64 / 256, v0: 32 / 512, uw: 128 / 256, vh: 64 / 512 });
  });

  it('carries a uvRect for a member drawn from a BUILT ATLAS page (regression: DarkAssassin)', () => {
    // A rig whose sprite is a packed atlas member resolves to the atlas PAGE (not the
    // source sheet). resolveSprite returns the page rect + page dims as sheetW/H, so the
    // skin builder normalizes rect/page → uvRect. Before the fix sheetW/H were null →
    // uvRect undefined → every part sampled the whole page (garbled sprites).
    const ATLAS = 'cccccccc-0000-4000-8000-000000000003';
    const ATLAS_PATH = '/games/x/assets/rigs/dark-assassin.atlas.json';
    registerAsset(SHEET, SHEET_PATH, 'texture', undefined);
    registerSprite(SLICE, SHEET, SHEET_PATH, {
      texture: SHEET, rect: { x: 64, y: 32, w: 128, h: 64 }, pivot: { x: 0.5, y: 0.5 }, sheetW: 256, sheetH: 512,
    });
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, {
      atlas: {
        hash: 'a', pages: [{ hash: 'p0', variants: ['webp'], w: 128, h: 64 }],
        texture: { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' },
        frames: { [SLICE]: { page: 0, rect: { x: 1, y: 1, w: 64, h: 32 }, pivot: { x: 0.5, y: 0.5 } } },
      },
    });
    clearRig2DCache(); clearSkin2DBuffers();
    setRig2D('atlas.rig2d.json', makeRig(SLICE));
    const buf = run('atlas.rig2d.json').parts[0];
    expect(buf.url).toContain(ATLAS_PATH + '~page0~webp.webp');   // draws from the page
    // Normalized against the PAGE dims (128×64), NOT the source sheet (256×512).
    expect(buf.uvRect).toEqual({ u0: 1 / 128, v0: 1 / 64, uw: 64 / 128, vh: 32 / 64 });
  });
});
