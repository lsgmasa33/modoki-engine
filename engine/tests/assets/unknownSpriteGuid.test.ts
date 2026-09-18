/** A 2D sprite whose texture GUID was deleted must still warn (#1408, QA-ASSET-0011).
 *
 *  `isImagePath` answers `false` for a GUID the manifest does not know (so a material guid is never
 *  treated as an image), which sent such a sprite down Scene2D's plain-graphics path where
 *  `resolveSprite` — the only place `[Sprite2D] Unknown asset guid` is emitted — was never reached.
 *  Scene2D now asks `isUnknownAssetGuid` and routes that ref through `resolveSprite` for the warning.
 *
 *  What this file can and cannot see: it pins the PREDICATE (true for a deleted guid, false for a
 *  known non-image guid and a primitive keyword — the false side is what keeps Scene2D from
 *  mislabelling a known asset as "not in the manifest") and the warning that call produces. The
 *  Scene2D call sites (new slot, ref change, the sprite → graphics flip of a texture deleted under
 *  a live sprite, the 2D-material path) are pinned in the package's Scene2D harness:
 *  `engine/packages/modoki/tests/runtime/Scene2D.test.ts` § "an unknown sprite guid reaches
 *  resolveSprite". */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { textureProvider } from '../../packages/modoki/src/runtime/core/textureProvider';
import { isImagePath, isUnknownAssetGuid, resolveSprite, resolveDomImageUrl } from '../../packages/modoki/src/runtime/core/textureRefs';
import {
  resolveSprite as resolverResolveSprite, resolveTextureVariantUrl, resolveBrowserImageUrl,
  loadTexture3D, releaseTexture3D, resetUnresolvedSpriteWarnings,
} from '../../packages/modoki/src/runtime/loaders/textureResolver';
import {
  registerAsset, unregisterAsset, getAssetType, getSpriteEpoch, clearManifest,
} from '../../packages/modoki/src/runtime/loaders/assetManifest';

const TEX = '11111111-2222-4333-8444-555555555501';
const MAT = '11111111-2222-4333-8444-555555555502';

function provide(): void {
  textureProvider.provide({
    resolveSprite: resolverResolveSprite, resolveTextureVariantUrl, resolveBrowserImageUrl,
    loadTexture3D, releaseTexture3D, getSpriteEpoch, getAssetType, ensurePixiKtxTranscoder: () => {},
  });
}

afterEach(() => {
  clearManifest();
  resetUnresolvedSpriteWarnings();
  textureProvider.reset();
  vi.restoreAllMocks();
});

describe('a deleted sprite texture guid (#1408)', () => {
  it('is an unknown guid once the texture is unregistered — and isImagePath alone never flags it', () => {
    provide();
    registerAsset(TEX, '/games/x/assets/textures/a.png', 'texture');
    expect(isUnknownAssetGuid(TEX)).toBe(false);
    unregisterAsset(TEX);
    expect(isImagePath(TEX)).toBe(false); // the reason the graphics path swallowed it
    expect(isUnknownAssetGuid(TEX)).toBe(true);
  });

  it('warns [Sprite2D] Unknown asset guid exactly once when resolved', () => {
    provide();
    registerAsset(TEX, '/games/x/assets/textures/a.png', 'texture');
    unregisterAsset(TEX);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSprite(TEX)).toBeUndefined();
    expect(resolveSprite(TEX)).toBeUndefined();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[Sprite2D] Unknown asset guid'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(TEX);
  });

  it('is NOT unknown for a known non-image guid or a primitive keyword', () => {
    provide();
    registerAsset(MAT, '/games/x/assets/materials/m.mat.json', 'material');
    expect(isUnknownAssetGuid(MAT)).toBe(false);
    expect(isUnknownAssetGuid('square')).toBe(false);
    expect(isUnknownAssetGuid('')).toBe(false);
  });

  it('is NOT unknown when no texture provider is wired (headless, nothing to ask)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isUnknownAssetGuid(TEX)).toBe(false);
  });
});

describe('a deleted UI image guid (#1408 sibling: the DOM path)', () => {
  const uiLines = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[UIImage] Unknown asset guid'));

  it('warns [UIImage] Unknown asset guid exactly once on the production-DOM path', () => {
    provide();
    registerAsset(TEX, '/games/x/assets/textures/a.png', 'texture');
    unregisterAsset(TEX);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDomImageUrl(TEX, true)).toBeUndefined();
    expect(resolveDomImageUrl(TEX, true)).toBeUndefined();
    expect(uiLines(warn)).toHaveLength(1);
    expect(uiLines(warn)[0]).toContain(TEX);
  });

  it('a sprite guid whose PARENT texture is gone names the texture, not the sprite, as missing', () => {
    provide();
    const SPRITE = '11111111-2222-4333-8444-555555555503';
    registerAsset(SPRITE, '/games/x/assets/textures/a.png#s', 'sprite', undefined, {
      sprite: { texture: TEX, rect: { x: 0, y: 0, w: 4, h: 4 }, pivot: { x: 0.5, y: 0.5 } } as never,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDomImageUrl(SPRITE, true)).toBeUndefined();
    expect(uiLines(warn)).toHaveLength(1);
    expect(uiLines(warn)[0]).toContain(`its parent texture ${TEX} is not in the manifest`);
  });

  it('stays quiet on the editor-preview path (no opt-in)', () => {
    provide();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDomImageUrl(TEX, false)).toBeUndefined();
    expect(uiLines(warn)).toHaveLength(0);
  });

  it('warns again after the guid resolved once in between (forget-on-resolve)', () => {
    provide();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDomImageUrl(TEX, true);
    registerAsset(TEX, '/games/x/assets/textures/a.png', 'texture');
    expect(resolveDomImageUrl(TEX, true)).toBeDefined();
    unregisterAsset(TEX);
    resolveDomImageUrl(TEX, true);
    expect(uiLines(warn)).toHaveLength(2);
  });
});
