/**
 * ui-system F3 — locks two load-bearing invariants from CLAUDE.md:
 *  1. resolveImageUrl (the PixiJS/GPU 2D seam) routes through resolveTextureVariantUrl(ref,'2d');
 *  2. a DOM image ref (UIElement.imageSrc) MUST resolve through resolveDomImageUrl — a
 *     BROWSER-decodable URL — NOT the KTX2 GPU variant (DOM/CSS can't decode KTX2) and NOT
 *     raw resolveRef + assetUrl (the source PNG is dropped from prod → green CI, broken ship).
 *     Source-scan guard on UINode catches a future edit that swaps in either wrong path.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/runtime/loaders/textureResolver', () => ({
  resolveTextureVariantUrl: vi.fn((ref: string, usage: string) => (usage === '2d' ? `/variant/${ref}.webp` : `/wrong/${ref}`)),
}));

const { resolveImageUrl } = await import('../../src/runtime/rendering/renderUtils');
const { resolveTextureVariantUrl } = await import('../../src/runtime/loaders/textureResolver');

describe('resolveImageUrl', () => {
  it('routes a ref through the 2D (WebP) texture variant', () => {
    expect(resolveImageUrl('guid-x')).toBe('/variant/guid-x.webp');
    expect(resolveTextureVariantUrl).toHaveBeenCalledWith('guid-x', '2d');
  });

  it('returns undefined for an empty ref', () => {
    expect(resolveImageUrl('')).toBeUndefined();
  });
});

describe('UINode imageSrc call-site guard (F3)', () => {
  const src = readFileSync(new URL('../../src/runtime/ui/UINode.tsx', import.meta.url), 'utf-8');

  it('resolves imageSrc through resolveDomImageUrl, not the KTX2/GPU or raw path', () => {
    // Positive lock: the browser-decodable DOM resolver is used for imageSrc.
    expect(src).toMatch(/resolveDomImageUrl\(node\.imageSrc/);
    // Negative lock: imageSrc must NOT resolve via the PixiJS/GPU resolveImageUrl (returns
    // a KTX2 URL the DOM can't decode) nor the raw path (source stripped from prod builds).
    expect(src).not.toMatch(/resolveImageUrl\(node\.imageSrc/);
    expect(src).not.toMatch(/assetUrl\([^)]*imageSrc/);
    expect(src).not.toMatch(/resolveRef\([^)]*imageSrc/);
  });
});
