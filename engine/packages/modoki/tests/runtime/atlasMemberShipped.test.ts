/** A built atlas's member as a SHIPPED build sees it: the build folds each member into its atlas, so the manifest
 *  has an entry for the atlas and none for the member — only the atlas's frame index knows the guid. The texture
 *  seam must still call it an image and resolve it, or every 2D sprite path draws nothing (#1926: Ice Reef's
 *  debris, fine in the editor, where each member keeps its own entry, and gone on the phone). */
import { beforeEach, describe, expect, it } from 'vitest';

import '../../src/runtime/loaders/registerProviders';
import { clearManifest, getAssetType, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { isImagePath, isUnknownAssetGuid, resolveImageUrl } from '../../src/runtime/core/textureRefs';
import { DEFAULT_TEXTURE_SETTINGS } from '../../src/runtime/loaders/textureSettings';

const ATLAS = '55555555-3333-4333-8333-333333333333';
const MEMBER = '66666666-3333-4333-8333-333333333333';

beforeEach(() => {
  clearManifest();
  registerAsset(ATLAS, '/games/g/assets/sprites/d.atlas.json', 'atlas', undefined, {
    atlas: {
      hash: 'h', pages: [{ hash: 'p0', variants: ['webp'], w: 64, h: 64 }], texture: { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' },
      frames: { [MEMBER]: { page: 0, rect: { x: 2, y: 2, w: 10, h: 6 }, pivot: { x: 0.5, y: 0.5 }, orig: { w: 32, h: 32 }, trim: { x: 5, y: 20, w: 10, h: 6 } } },
    },
  });
});

describe('a packed member with no manifest entry of its own (a shipped build)', () => {
  it('is an image, resolves to its atlas page, and is not an unknown guid', () => {
    expect(getAssetType(MEMBER), 'the manifest itself has no entry: the build shape').toBeUndefined();
    expect(isImagePath(MEMBER)).toBe(true);
    expect(resolveImageUrl(MEMBER)).toContain('d.atlas.json~page0~webp.webp');
    expect(isUnknownAssetGuid(MEMBER)).toBe(false);
  });

  it('a guid in no atlas and no manifest is still unknown, and not an image', () => {
    const stray = '77777777-3333-4333-8333-333333333333';
    expect(isImagePath(stray)).toBe(false);
    expect(isUnknownAssetGuid(stray)).toBe(true);
  });
});
