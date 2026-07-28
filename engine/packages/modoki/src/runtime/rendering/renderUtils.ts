/** Shared rendering utilities used by both runtime (Scene2D/Scene3D) and editor (SceneView). */

import { worldTransforms } from '../core/ecs/transformPropagationSystem';
// Re-exported so the 2D render path resolves sprites through ONE module seam
// (renderUtils) — keeps Scene2D's resolution mockable in one place. Implementation moved to
// core/textureRefs.ts (P7 C9) — pure ref-classification, never rendering-specific.
export {
  resolveSprite, isImagePath, resolveImageUrl, resolveDomImageUrl, resolvePrimitiveShape,
  type PrimitiveShape,
} from '../core/textureRefs';
export type { ResolvedSprite } from '../core/textureProvider';
// The 3D world-transform API now lives in the light `ecs/worldTransform` module (so the
// simulation half can consume it without the renderer's texture deps). Re-exported here for
// existing render-path callers.
export {
  getWorldTransform3D, getWorldMatrix3D, getParentWorldMatrix3D, worldToLocal3D, hasParent,
} from '../core/ecs/worldTransform';
export type { WorldTransform3D } from '../core/ecs/worldTransform';

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
