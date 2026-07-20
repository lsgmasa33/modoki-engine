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
});
