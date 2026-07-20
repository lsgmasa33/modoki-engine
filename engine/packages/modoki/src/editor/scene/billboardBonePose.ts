/** Coordinate math for posing a 2.5D billboard's `Bone2D` with the 3D gizmo.
 *
 *  A billboarded rig renders in the Three.js scene as a mesh whose vertices are the
 *  rig's pixel-space deformed positions REFLECTED to `(px, -py)` (Y flips 2D-down →
 *  3D-up), living inside the billboard's `flip` group (see `buildBillboardGeometry`
 *  in scene3DSync). A `Bone2D` has no Three object, so the editor parks a proxy
 *  Object3D at the bone INSIDE that same `flip` group and attaches the gizmo to it.
 *
 *  These pure helpers convert between the bone's 2D transform (rig pixel space) and
 *  the proxy's LOCAL transform under `flip`. The reflection is `(x, y, rz) → (x, -y,
 *  -rz)`: negating Y also negates the sense of rotation, and it's an involution, so
 *  the same map inverts itself. Parent-relative conversion reuses the SAME
 *  `worldToLocal2D` the Canvas2D bone gizmo uses, so both gizmos agree. */

import { worldToLocal2D, type Transform2D } from '../panels/Gizmo2D';

/** The proxy's LOCAL transform under the billboard `flip` group. `z` is always 0
 *  (the rig is planar); rotation is Z-only (in-plane), matching a 2D bone. */
export interface BoneProxyLocal {
  x: number; y: number; z: number;
  /** Z-euler rotation of the proxy (radians). */
  rz: number;
  sx: number; sy: number;
}

/** Bone rig-2D transform (relative to the sprite) → proxy LOCAL transform under
 *  `flip`. Reflects Y and rotation to match the billboard mesh's `(px, -py)` layout. */
export function boneRelToProxyLocal(rel: Transform2D): BoneProxyLocal {
  return { x: rel.x, y: -rel.y, z: 0, rz: -rel.rz, sx: rel.sx, sy: rel.sy };
}

/** Proxy LOCAL transform under `flip` → the bone's rig-2D WORLD transform (still
 *  relative to the sprite). The inverse reflection of {@link boneRelToProxyLocal}. */
export function proxyLocalToBoneRel(proxy: { x: number; y: number; rz: number; sx: number; sy: number }): Transform2D {
  return { x: proxy.x, y: -proxy.y, rz: -proxy.rz, sx: proxy.sx, sy: proxy.sy };
}

/** Full round-trip for a gizmo drag: the dragged proxy's LOCAL transform + the
 *  bone's PARENT (as a rig-2D transform relative to the sprite, or null when the
 *  bone's parent IS the sprite/rig root) → the bone's LOCAL `Transform` fields. */
export function proxyLocalToBoneLocal(
  proxy: { x: number; y: number; rz: number; sx: number; sy: number },
  parentRel: Transform2D | null,
): Transform2D {
  return worldToLocal2D(proxyLocalToBoneRel(proxy), parentRel);
}
