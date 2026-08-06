import { trait } from 'koota';

/** Renderable3DPrimitive — built-in primitive meshes with color.
 *  Use for simple geometry (cube, sphere, etc.) that doesn't need a GLB asset.
 *  Optionally accepts a .mat.json material path — when set, the resolved
 *  material replaces the default MeshStandardMaterial created by createPrimitiveMesh. */
export const Renderable3DPrimitive = trait({
  mesh: 'cube' as string,
  color: 0xffffff as number,
  size: 1 as number,
  material: '' as string,
  /** Per-renderer visibility — hides just THIS renderable. Independent of the entity's
   *  on/off (`EntityAttributes.isActive`, which also cascades to children); both must be
   *  true to draw. */
  isVisible: true as boolean,
  /** Rendering-layer mask (#136) — see `Renderable3D.renderingLayerMask`. Honoured only when
   *  `material` names a `.mat.json`: a primitive with the DEFAULT material owns a per-entity
   *  material that `color` is written into live, and a light-mask variant is shared by
   *  (material, mask), so the two would fight over the same object. Explicit-material
   *  primitives have no live colour path, so there is nothing to fight. */
  renderingLayerMask: 1 as number,
});
