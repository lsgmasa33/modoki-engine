/**
 * Shared routing for particle emitters: does an emitter render in 2D (PixiJS) or 3D (Three.js)?
 *
 * The rule is the SAME one Scene2D uses for `Renderable2D` — an emitter renders in 2D iff it has a
 * `Canvas2D` ancestor (walk the `EntityAttributes.parentId` chain); otherwise it renders in 3D. Both
 * particle sync passes (`particleSync` for 3D, `particleSync2D` for 2D) resolve routing through THIS
 * one pure helper, so they can never disagree — an emitter is rendered by exactly one path per frame
 * (the load-bearing mutual-exclusivity invariant). `particleSync2D` running inside Scene2D reuses
 * Scene2D's own already-built maps; the 3D `particleSync` builds its own via {@link buildCanvas2DRoute}.
 */

import type { World } from 'koota';
import { Canvas2D } from '../traits/Canvas2D';
import { EntityAttributes } from '../traits/EntityAttributes';
import { findCanvasAncestor } from './canvas2DRouting';

/** Per-frame snapshot of the hierarchy needed to route emitters: every entity's parent, and the
 *  set of Canvas2D entities. Reusable (pass the same object back in via `out`) to avoid per-frame
 *  allocation on the hot render path. */
export interface Canvas2DRoute {
  parentOf: Map<number, number>;
  canvasIds: Set<number>;
}

/** (Re)build the routing snapshot from the live world. Clears and repopulates `out` when given. */
export function buildCanvas2DRoute(world: World, out?: Canvas2DRoute): Canvas2DRoute {
  const parentOf = out?.parentOf ?? new Map<number, number>();
  const canvasIds = out?.canvasIds ?? new Set<number>();
  parentOf.clear();
  canvasIds.clear();
  world.query(EntityAttributes).updateEach(([attr]: [{ parentId: number }], entity) => {
    parentOf.set(entity.id(), attr.parentId || 0);
  });
  world.query(Canvas2D).updateEach((_c: unknown[], entity) => {
    canvasIds.add(entity.id());
  });
  return { parentOf, canvasIds };
}

/** The Canvas2D entity id an emitter renders into (→ 2D / PixiJS), or `null` when it has no
 *  Canvas2D ancestor (→ 3D / Three.js). The single source of truth both sync passes agree on. */
export function emitterCanvasId(route: Canvas2DRoute, entityId: number): number | null {
  return findCanvasAncestor(entityId, route.parentOf, route.canvasIds);
}
