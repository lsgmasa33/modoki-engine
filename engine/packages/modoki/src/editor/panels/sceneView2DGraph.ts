/** SceneView's 2D scene-graph memos — the entity → parent / sortOrder / orderInLayer maps, the Canvas2D
 *  set, and the paint order derived from them. Read by the 2D pick path, the 2D gizmo bounds and the
 *  chrome overlay draw.
 *
 *  The maps are keyed by bare entity id, so a memo that outlives an entity serves its row to the next
 *  entity koota spawns on that index (#1220). What makes them safe is the KEY they are memoized on,
 *  and it needs both parts:
 *  - `getStructureVersion()` — bumped by every `registerEntity`, so the newcomer on a recycled index
 *    invalidates before anything can ask for it (the 2D dirty version, which this memo was keyed on
 *    alone before #1220, is bumped by neither a spawn nor a destroy). `unregisterEntity` bumps it too,
 *    so a destroy with no respawn drops the dead row. It is also bumped by a write to an
 *    EntityAttributes structure field (`parentId`, `sortOrder`) made through entityUtils.
 *  - `get2DDirtyVersion()` — every other ECS write through entityUtils (`Renderable2D.orderInLayer`,
 *    an added Canvas2D) fires the dirty listeners, which bump it; so does a world swap. The swap is why
 *    there is no separate world key (unlike `animation/entityIndex.ts`): a scene load that registers
 *    into a staging world bumps the structure version while the OLD world is still current, and the
 *    swap that follows bumps this one. Both bumps come from `ensureCanvas2DListeners`, which SceneView
 *    wires on mount — before any of the readers below can run.
 *  ⚠️ A write made with koota's own `entity.set` bumps none of these. Such writes DO exist
 *  (`demos/forest-camp/runtime/systems.ts` re-parents a 3D arrow, the timeline sets `isActive`, games set
 *  Renderable2D visuals), and a UI binding or an Entries row can target any field. None changed a 2D
 *  routing field (`parentId`/`sortOrder` of a 2D entity, `orderInLayer`, Canvas2D presence) when #1220
 *  was checked. One that does leaves these memos stale until the next bump, so it must go through
 *  entityUtils or call `mark2DDirty`. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { getAllTraits } from '../../runtime/core/ecs/traitRegistry';
import { getStructureVersion } from '../../runtime/core/ecs/entityUtils';
import { computePaintOrder } from '../../runtime/rendering/paintOrder';
import { collectOrderInLayer } from '../../runtime/rendering/orderInLayer';
import { get2DDirtyVersion } from '../store/canvas2DDirty';

export interface Canvas2DRoutingMaps {
  parentOf: Map<number, number>;
  sortOrderOf: Map<number, number>;
  orderInLayerOf: Map<number, number>;
  canvasIds: Set<number>;
}

/** Build the entity → parent map, sort orders, order-in-layer overrides and the Canvas2D id set for
 *  the current world. Used to route each Renderable2D to its owning Canvas2D. */
function buildCanvas2DRouting(): Canvas2DRoutingMaps {
  const allTraits = getAllTraits();
  const eaMeta = allTraits.find(t => t.name === 'EntityAttributes');
  const c2dMeta = allTraits.find(t => t.name === 'Canvas2D');
  const parentOf = new Map<number, number>();
  const sortOrderOf = new Map<number, number>();
  const canvasIds = new Set<number>();
  if (eaMeta) {
    getCurrentWorld().query(eaMeta.trait).updateEach(([ea]: any[], entity: any) => {
      parentOf.set(entity.id(), ea.parentId || 0);
      sortOrderOf.set(entity.id(), ea.sortOrder || 0);
    });
  }
  // ⚠️ The order-in-layer map comes from the SHARED runtime helper, not from a local
  // `Renderable2D`-only pass (#1228). The local pass was the defect: the runtime collected it from
  // `Renderable2D` AND `Text2D` while this one read `Renderable2D` alone, so a `Text2D.orderInLayer`
  // — which this very editor's Inspector exposes — moved the label in the game and not in SceneView,
  // and the pick below then handed the click to the sprite underneath.
  //
  // This resolves the traits by direct import rather than through `getAllTraits()` like the two
  // metadata lookups above. That is safe because it is the SAME trait object either way:
  // `engine/app/ecs/traits/index.ts` re-exports from `@modoki/engine/runtime`, which is what the
  // helper imports, and `registerTraits.ts` registers those very objects. It is also what makes the
  // helper the single source — a name-keyed lookup here would be a second list to keep in step.
  const orderInLayerOf = collectOrderInLayer(getCurrentWorld());
  if (c2dMeta) {
    getCurrentWorld().query(c2dMeta.trait).updateEach((_: any, entity: any) => {
      canvasIds.add(entity.id());
    });
  }
  return { parentOf, sortOrderOf, orderInLayerOf, canvasIds };
}

/** The memo key — see the module docblock for why each part is needed. */
interface GraphStamp { structure: number; dirty2D: number }

function currentStamp(): GraphStamp {
  return { structure: getStructureVersion(), dirty2D: get2DDirtyVersion() };
}

function sameStamp(a: GraphStamp, b: GraphStamp): boolean {
  return a.structure === b.structure && a.dirty2D === b.dirty2D;
}

// Memoized so the per-frame draw and — crucially — the per-`pointermove` HOVER hit-test reuse one
// build instead of allocating fresh maps every event over a static scene (gizmos F3).
let _routingCache: { stamp: GraphStamp; routing: Canvas2DRoutingMaps } | null = null;

export function getCanvas2DRouting(): Canvas2DRoutingMaps {
  const stamp = currentStamp();
  if (_routingCache && sameStamp(_routingCache.stamp, stamp)) return _routingCache.routing;
  const routing = buildCanvas2DRouting();
  _routingCache = { stamp, routing };
  return routing;
}

// Paint order is a pure function of the routing (sortOrder DFS over the hierarchy), so it is invariant
// across sim-running redraws of a static scene — memoize it on the same stamp instead of re-running the
// O(n) DFS every frame per Canvas2D layer (P4).
let _paintOrderCache: { stamp: GraphStamp; order: Map<number, number> } | null = null;

export function getPaintOrder(): Map<number, number> {
  const stamp = currentStamp();
  if (_paintOrderCache && sameStamp(_paintOrderCache.stamp, stamp)) return _paintOrderCache.order;
  const { sortOrderOf, parentOf, orderInLayerOf } = getCanvas2DRouting();
  const order = computePaintOrder(sortOrderOf, parentOf, orderInLayerOf.size ? orderInLayerOf : undefined);
  _paintOrderCache = { stamp, order };
  return order;
}

/** Drop both memos. For tests. @internal */
export function _resetSceneView2DGraph(): void {
  _routingCache = null;
  _paintOrderCache = null;
}
