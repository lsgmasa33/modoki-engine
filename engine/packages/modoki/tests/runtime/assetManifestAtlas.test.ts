import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearManifest, registerAsset, registerAtlasFrames, getAtlasFrame, clearAtlasFrames,
  unregisterAsset, getSpriteEpoch, type AtlasCacheBlock,
} from '../../src/runtime/loaders/assetManifest';
import { DEFAULT_TEXTURE_SETTINGS } from '../../src/runtime/loaders/textureSettings';

const ATLAS = '11111111-1111-4111-8111-111111111111';
const ATLAS_PATH = '/games/g/assets/sprites/pack.atlas.json';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-1111-4111-8111-111111111111';

function block(frames: Record<string, { page: number; x: number; y: number }>, hash = 'h1'): AtlasCacheBlock {
  const pageCount = Math.max(1, ...Object.values(frames).map((f) => f.page + 1));
  return {
    hash,
    pages: Array.from({ length: pageCount }, (_, i) => ({ hash: `${hash}p${i}`, variants: ['webp'], w: 256, h: 256 })),
    texture: { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' },
    frames: Object.fromEntries(Object.entries(frames).map(([g, f]) => [g,
      { page: f.page, rect: { x: f.x, y: f.y, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 } }])),
  };
}

beforeEach(() => clearManifest());

describe('atlas frame index', () => {
  it('registerAtlasFrames indexes members; getAtlasFrame returns placement + page dims', () => {
    registerAtlasFrames(ATLAS, block({ [A]: { page: 0, x: 1, y: 2 }, [B]: { page: 1, x: 3, y: 4 } }));
    // page dims (256²) ride along so a consumer can normalize the page-px rect to 0..1 UVs.
    expect(getAtlasFrame(A)).toMatchObject({ atlasGuid: ATLAS, page: 0, rect: { x: 1, y: 2 }, pageW: 256, pageH: 256 });
    expect(getAtlasFrame(B)).toMatchObject({ page: 1, rect: { x: 3, y: 4 }, pageW: 256, pageH: 256 });
    expect(getAtlasFrame('nope')).toBeUndefined();
  });

  it('registering an atlas AssetEntry populates the index', () => {
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, { atlas: block({ [A]: { page: 0, x: 5, y: 6 } }) });
    expect(getAtlasFrame(A)?.rect).toMatchObject({ x: 5, y: 6 });
  });

  it('re-registering an atlas replaces its frames (removed members stop resolving)', () => {
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, { atlas: block({ [A]: { page: 0, x: 0, y: 0 }, [B]: { page: 0, x: 20, y: 0 } }) });
    expect(getAtlasFrame(B)).toBeDefined();
    // Re-pack drops B.
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, { atlas: block({ [A]: { page: 0, x: 8, y: 8 } }, 'h2') });
    expect(getAtlasFrame(A)).toMatchObject({ rect: { x: 8, y: 8 }, hash: 'h2p0' });
    expect(getAtlasFrame(B)).toBeUndefined();
  });

  it('unregistering the atlas drops its frames', () => {
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, { atlas: block({ [A]: { page: 0, x: 0, y: 0 } }) });
    unregisterAsset(ATLAS);
    expect(getAtlasFrame(A)).toBeUndefined();
  });

  it('getSpriteEpoch changes for a member when the atlas re-packs', () => {
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, { atlas: block({ [A]: { page: 0, x: 0, y: 0 } }) });
    const e1 = getSpriteEpoch(A);
    // Re-pack (same members, new hash) → the member's epoch must move so the 2D slot
    // cache rebuilds the framed page.
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, { atlas: block({ [A]: { page: 0, x: 4, y: 4 } }, 'h2') });
    expect(getSpriteEpoch(A)).not.toBe(e1);
  });

  it('clearManifest and clearAtlasFrames both clear the index', () => {
    registerAtlasFrames(ATLAS, block({ [A]: { page: 0, x: 0, y: 0 } }));
    clearAtlasFrames();
    expect(getAtlasFrame(A)).toBeUndefined();
    registerAtlasFrames(ATLAS, block({ [A]: { page: 0, x: 0, y: 0 } }));
    clearManifest();
    expect(getAtlasFrame(A)).toBeUndefined();
  });
});
