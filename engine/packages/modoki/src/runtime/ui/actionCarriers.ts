/** Is a UI control that carries this action on screen? (#1406)
 *
 *  A scene `UIAction` `call` row reaches its handler the same way for a tap and for an agent's
 *  dispatch (`modoki_dispatch_action`, `device_dispatch_action`). For a tap, the renderer ties the
 *  handler to its control: a hidden button is unmounted, so nothing can press it. A dispatch skips
 *  the renderer, so a handler written to be reached only through its button ran with that button
 *  hidden, e.g. a panel's Confirm with the panel closed. The `dispatch-action` agent op asks this
 *  before it dispatches. `applyBindings` does not need to: a real press has a mounted control by
 *  construction.
 *
 *  A CARRIER is a UI entity (`UIElement`) whose `UIAction` has a `call` row naming the action, on
 *  any event. It is on screen when it is not `pointerThrough` (a pass-through element takes no
 *  press) and it is shown by either of two readings:
 *  - **now** — it and every ancestor have `isVisible !== false`, and it is not in a deactivated
 *    subtree. This lets an agent open a panel and press in it in one turn, before a frame runs.
 *  - **at the last UI sync** — the projected tree the renderer drew (`useUITreeStore`). A button
 *    whose own `set` rows hide its panel BEFORE its `call` row runs (a Confirm that closes its
 *    dialog) has already vanished from the ECS when the handler runs, but the player pressed it.
 *
 *  ⚠️ Not seen by either reading: a `UIBinding.visibleBinding` hide. It is evaluated at render
 *  time from the store, in `UINode`, so a control hidden only that way still counts. That fails
 *  open — the dispatch runs, as it did before this check.
 */

import type { World } from 'koota';
import { UIAction, type UIActionBinding } from '../traits/UIAction';
import { UIElement } from '../traits/UIElement';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { deactivatedEntities } from '../core/ecs/transformPropagationSystem';
import { useUITreeStore, type UINodeData } from './uiTreeStore';

export interface ActionControlReport {
  /** Some carrier is on screen now or was at the last UI sync. */
  onScreen: boolean;
  /** Every carrier found in the world, by entity name (the guid when unnamed), on screen or not,
   *  each name once: a pooled list names every row alike. Empty means no control carries the action. */
  carriers: string[];
}

function carries(bindings: readonly UIActionBinding[] | undefined, action: string): boolean {
  return !!bindings?.some((b) => b.kind === 'call' && b.action === action);
}

/** The last-sync reading: walk the projected tree, pruning at a hidden node the way `UINode` does
 *  (a hidden parent unmounts its whole subtree). `buildTree` already leaves deactivated entities out. */
function carriedInTree(nodes: readonly UINodeData[], action: string): boolean {
  for (const node of nodes) {
    if (!node.isVisible) continue;
    if (!node.pointerThrough && carries(node.action?.bindings, action)) return true;
    if (carriedInTree(node.children, action)) return true;
  }
  return false;
}

export function actionControlOnScreen(world: World, action: string): ActionControlReport {
  const carriers = new Set<string>();
  const candidates: number[] = [];
  world.query(UIAction, UIElement).updateEach(([ua, ui]: any[], entity: any) => {
    if (!carries(ua.bindings as UIActionBinding[], action)) return;
    const attr = entity.get(EntityAttributes) as { name?: string; guid?: string } | undefined;
    carriers.add(attr?.name || attr?.guid || `#${entity.id()}`);
    if (ui.pointerThrough !== true) candidates.push(entity.id());
  });
  if (candidates.length === 0) return { onScreen: false, carriers: [...carriers] };

  // id → { parent, own visibility } for every entity with a place in the hierarchy.
  const meta = new Map<number, { parent: number; visible: boolean }>();
  world.query(EntityAttributes).updateEach(([attr]: any[], entity: any) => {
    const ui = entity.has(UIElement) ? (entity.get(UIElement) as { isVisible?: boolean }) : undefined;
    meta.set(entity.id(), { parent: (attr.parentId as number) || 0, visible: ui?.isVisible !== false });
  });
  const shownNow = (id: number): boolean => {
    if (deactivatedEntities.has(id)) return false;
    let cur = id;
    let guard = meta.size + 1; // cycle guard
    while (cur && guard-- > 0) {
      const m = meta.get(cur);
      if (!m) break; // not in the hierarchy: nothing above it can hide it
      if (!m.visible) return false;
      cur = m.parent;
    }
    return true;
  };
  const onScreen = candidates.some(shownNow) || carriedInTree(useUITreeStore.getState().tree, action);
  return { onScreen, carriers: [...carriers] };
}
