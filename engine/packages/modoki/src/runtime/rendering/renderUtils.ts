/** Shared rendering utilities used by both runtime (Scene2D/Scene3D) and editor (SceneView). */

import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { isGuid, getAssetType } from '../loaders/assetManifest';
import { resolveTextureVariantUrl, resolveSprite, resolveBrowserImageUrl } from '../loaders/textureResolver';
// Re-exported so the 2D render path resolves sprites through ONE module seam
// (renderUtils) — keeps Scene2D's resolution mockable in one place.
export { resolveSprite } from '../loaders/textureResolver';
export type { ResolvedSprite } from '../loaders/textureResolver';
// The 3D world-transform API now lives in the light `ecs/worldTransform` module (so the
// simulation half can consume it without the renderer's texture deps). Re-exported here for
// existing render-path callers.
export {
  getWorldTransform3D, getWorldMatrix3D, getParentWorldMatrix3D, worldToLocal3D, hasParent,
} from '../ecs/worldTransform';
export type { WorldTransform3D } from '../ecs/worldTransform';

export interface WorldTransform2D { x: number; y: number; rz: number; sx: number; sy: number }

// Reusable output object to avoid per-call allocation in hot render paths
const _wt2d: WorldTransform2D = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };

/** Resolve an entity's world-space 2D transform INTO a caller-provided object.
 *  Falls back to the local transform if propagation hasn't run yet. Allocation-free
 *  and alias-free: use this whenever you need to hold TWO results at once (e.g. compare
 *  a parent's transform against a child's) — pass a distinct `out` for each. */
export function getWorldTransform2DInto(
  out: WorldTransform2D,
  entityId: number,
  localTf: { x: number; y: number; rz: number; sx: number; sy: number },
): WorldTransform2D {
  const wt = worldTransforms.get(entityId);
  const src = wt || localTf;
  out.x = src.x; out.y = src.y; out.rz = src.rz; out.sx = src.sx; out.sy = src.sy;
  return out;
}

/** Resolve an entity's world-space 2D transform (position, rotation, scale).
 *  Falls back to local transform if propagation hasn't run yet.
 *
 *  ⚠️ Returns a SHARED module-level singleton, reused on every call. Read/destructure
 *  its fields IMMEDIATELY; do NOT retain the reference. Two live results alias the same
 *  object — `const a = getWorldTransform2D(p); const b = getWorldTransform2D(c);` makes
 *  `a === b`. If you need two at once, use {@link getWorldTransform2DInto} with separate
 *  out-objects. The singleton exists only to keep the per-frame render path allocation-free. */
export function getWorldTransform2D(entityId: number, localTf: { x: number; y: number; rz: number; sx: number; sy: number }): WorldTransform2D {
  return getWorldTransform2DInto(_wt2d, entityId, localTf);
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
    const t = getAssetType(ref);
    return t === 'texture' || t === 'sprite';
  }
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(ref) || ref.startsWith('http') || ref.startsWith('data:') || ref.startsWith('blob:');
}

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
  if (isGuid(ref) && getAssetType(ref) === 'sprite') return resolveSprite(ref)?.url;
  return resolveTextureVariantUrl(ref, '2d');
}

/** Resolve any image-or-texture ref to a **browser-decodable** URL for DOM/Canvas2D
 *  consumers (UI `<img>`/CSS `background-image`, editor SceneView Canvas2D `drawImage`) —
 *  these paths can't decode the KTX2 GPU variant that {@link resolveImageUrl} returns.
 *  Prefers the WebP/PNG variant (a 2d/ui texture always has one). See
 *  `resolveBrowserImageUrl` for the full contract.
 *
 *  `warnKtx` (opt-in): the production-DOM path (UI `<img>`) sets it so a 3d-typed texture
 *  with no browser variant warns; the editor SceneView preview leaves it off. */
export function resolveDomImageUrl(ref: string, warnKtx = false): string | undefined {
  if (!ref) return undefined;
  return resolveBrowserImageUrl(ref, warnKtx);
}


/** Resolve 2D primitive shape type from sprite keyword. Used by both Scene2D (PixiJS)
 *  and the editor SceneView's inline Canvas2DLayer to keep shape logic consistent. */
export type PrimitiveShape = 'square' | 'triangle' | 'circle';
export function resolvePrimitiveShape(sprite: string): PrimitiveShape {
  if (sprite === 'square') return 'square';
  if (sprite === 'triangle') return 'triangle';
  return 'circle';
}
