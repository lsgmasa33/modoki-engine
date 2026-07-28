/** Pure image/texture-ref classification helpers — extracted out of `rendering/renderUtils.ts`
 *  (P7 C9). Never rendering-specific (they're `isGuid` + `getAssetType` + a variant pick), so
 *  they belong in `core/` and reach the texture-resolution seam via `core/textureProvider.ts`
 *  instead of importing `loaders/` directly. `rendering/renderUtils.ts` re-exports everything
 *  here for its existing callers. */

import { isGuid } from './assetRefRules';
import { textureProvider } from './textureProvider';
import type { ResolvedSprite } from './textureProvider';

/** Resolve any image-or-texture ref to a URL for the **PixiJS/GPU 2D** renderer (Scene2D).
 *  PixiJS registers a KTX2 parser, so this returns the GPU `'2d'` variant (KTX2 for
 *  `ktx2-*` formats, WebP/PNG otherwise). A sprite GUID resolves to its backing
 *  texture/atlas-page URL (use {@link resolveSprite} when you also need the frame rect).
 *  A whole-image ref MUST stay on the explicit `resolveTextureVariantUrl(ref,'2d')` path —
 *  ui-system F3 mocks exactly that seam.
 *
 *  ⚠ DOM/Canvas2D consumers (UI `<img>`/CSS background, editor SceneView Canvas2D) CANNOT
 *  decode KTX2 — they must use {@link resolveDomImageUrl}, not this. */
export function resolveImageUrl(ref: string): string | undefined {
  if (!ref) return undefined;
  const p = textureProvider.get();
  if (isGuid(ref) && p?.getAssetType(ref) === 'sprite') return p.resolveSprite(ref)?.url;
  return p?.resolveTextureVariantUrl(ref, '2d');
}

/** Resolve any image-or-texture ref to a **browser-decodable** URL for DOM/Canvas2D
 *  consumers (UI `<img>`/CSS `background-image`, editor SceneView Canvas2D `drawImage`) —
 *  these paths can't decode the KTX2 GPU variant that {@link resolveImageUrl} returns.
 *  Prefers the WebP/PNG variant (a 2d/ui texture always has one).
 *
 *  `warnKtx` (opt-in): the production-DOM path (UI `<img>`) sets it so a 3d-typed texture
 *  with no browser variant warns; the editor SceneView preview leaves it off. */
export function resolveDomImageUrl(ref: string, warnKtx = false): string | undefined {
  if (!ref) return undefined;
  return textureProvider.get()?.resolveBrowserImageUrl(ref, warnKtx);
}

/** True if ref refers to an image file (URL, image-extension path, or texture GUID). */
export function isImagePath(ref: string): boolean {
  if (!ref) return false;
  if (isGuid(ref)) {
    // Disambiguate via the manifest: TEXTURE and SPRITE guids are images. A material
    // guid (.mat.json) must fall through to resolveMaterial — treating it as an
    // image here routes it into the inline-texture path and the mesh never gets
    // its material. Unknown guids default to non-image (resolveMaterial handles
    // the miss gracefully).
    const t = textureProvider.get()?.getAssetType(ref);
    return t === 'texture' || t === 'sprite';
  }
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(ref) || ref.startsWith('http') || ref.startsWith('data:') || ref.startsWith('blob:');
}

/** Resolve a sprite ref through the texture-resolution seam. See {@link ResolvedSprite}. */
export function resolveSprite(ref: string): ResolvedSprite | undefined {
  return textureProvider.get()?.resolveSprite(ref);
}

/** Resolve 2D primitive shape type from sprite keyword. Used by both Scene2D (PixiJS)
 *  and the editor SceneView's inline Canvas2DLayer to keep shape logic consistent. */
export type PrimitiveShape = 'square' | 'triangle' | 'circle';
export function resolvePrimitiveShape(sprite: string): PrimitiveShape {
  if (sprite === 'square') return 'square';
  if (sprite === 'triangle') return 'triangle';
  return 'circle';
}
