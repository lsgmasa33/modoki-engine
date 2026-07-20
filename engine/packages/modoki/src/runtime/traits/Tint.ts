import { trait } from 'koota';

/** Tint — per-entity color wash applied on top of NPR.
 *  The render sync swaps the entity's mesh to a tinted clone of its material
 *  (`color` drives the clone's `.color`, `amount` its `nprColorPreserve`), so
 *  the grayscale NPR fill blends part-way toward the team color while shading
 *  and outlines are kept. Reusable for team colors, highlights, etc. */
export const Tint = trait({
  color: 0xffffff as number,
  amount: 0.5 as number,
});
