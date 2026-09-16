/** orderInLayer — the single source for WHICH 2D traits carry an explicit "Order in Layer" and
 *  what each entity's value is. Consumed by the runtime PixiJS layer (`Scene2D`) and by the editor
 *  SceneView (`editor/panels/sceneView2DGraph`), which both feed the result to `computePaintOrder`.
 *
 *  ⚠️ **This exists because the two callers each had their own collection and they drifted (#1228).**
 *  The runtime read `Renderable2D` AND `Text2D`; the editor read `Renderable2D` only. So an
 *  `orderInLayer` authored on a `Text2D` — a field the editor's own Inspector exposes, tooltipped
 *  "Draw order within the 2D layer (higher = in front)" (`engine/app/ecs/registerTraits.ts`) —
 *  was honoured by the game and ignored by the viewport that authored it. The visible symptom was
 *  click-to-select: a label drawn on top of a sprite lost the click to the sprite underneath,
 *  because SceneView's pick ranks candidates by this very map. The editor's overlay draw order was
 *  wrong for the same reason.
 *
 *  ⚠️ **A 2D trait that gains an `orderInLayer` field is added HERE, not at a call site.** That is
 *  the entire point of the module: the previous shape made adding one silently correct in one
 *  surface and silently wrong in the other, with nothing failing and no test able to notice.
 *
 *  Deliberately NOT part of this: `UIElement.zIndex` and the UI tree's own ordering
 *  (`runtime/ui/uiTreeStore.ts`). That is a separate, sanctioned derivation over the DOM/UI layer
 *  with different stacking rules — `paintOrder.ts`'s doc-block names it as the thing it mirrors on
 *  purpose. Folding it in here would merge two orderings that are meant to differ. */

import type { World } from 'koota';
import { Renderable2D, Text2D } from '../traits';

/** Every 2D trait carrying an `orderInLayer` field, in PRECEDENCE ORDER: a later trait wins for an
 *  entity that carries more than one. `Text2D` last preserves the runtime's pre-#1228 behaviour,
 *  where the `Text2D` pass ran after the `Renderable2D` pass and overwrote it. */
const ORDERED_2D_TRAITS = [Renderable2D, Text2D];

/** Build `entityId → orderInLayer` for every entity in `world` that sets a non-zero one.
 *
 *  Entities with `orderInLayer === 0` are deliberately ABSENT rather than present-as-0:
 *  `computePaintOrder` defaults a missing id to 0, and an empty map lets both callers skip the
 *  re-rank entirely (they pass `undefined` when `size === 0`), which keeps the common no-override
 *  scene on the pure-hierarchy path. */
export function collectOrderInLayer(world: World): Map<number, number> {
  const orderInLayerOf = new Map<number, number>();
  for (const trait of ORDERED_2D_TRAITS) {
    // ⚠️ `readEach`, NOT `updateEach` — this only READS. koota's `updateEach` defaults to
    // `changeDetection: 'auto'`, which per entity snapshots each trait, re-checks `world.has`,
    // diffs every tracked trait against the snapshot and writes it back: all wasted when the
    // callback never mutates. `transformPropagationSystem.ts` carries the same note for the same
    // reason. Both pre-#1228 call sites used `updateEach`, so this is a change of behaviour only
    // in the work it avoids — `Scene2D` runs this every frame.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    world.query(trait).readEach(([t]: any[], entity: any) => {
      if (t.orderInLayer) orderInLayerOf.set(entity.id(), t.orderInLayer);
    });
  }
  return orderInLayerOf;
}
