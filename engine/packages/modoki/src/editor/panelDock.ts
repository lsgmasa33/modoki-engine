/** Panel docking helpers — extracted from EditorApp so they're unit-testable
 *  without importing the editor's heavy view tree (SceneView/Three, GameView/Pixi).
 *  Pure operations over a FlexLayout Model: no DOM, no React. */

import { Actions, DockLocation, Model, TabNode } from 'flexlayout-react';

/** Map a game panel's `dockLocation` hint to a FlexLayout DockLocation (default CENTER). */
export function toDockLocation(loc?: 'center' | 'bottom' | 'left' | 'right'): DockLocation {
  switch (loc) {
    case 'bottom': return DockLocation.BOTTOM;
    case 'left':   return DockLocation.LEFT;
    case 'right':  return DockLocation.RIGHT;
    default:       return DockLocation.CENTER;
  }
}

/** Focus a panel's tab if it's already open, else dock a fresh tab next to the
 *  Scene tabset (or the first tabset). Shared by the Window menu (showPanel) and
 *  the openByDefault auto-dock on first load. A non-CENTER `location` splits off a
 *  new tabset in that direction. Returns 'focused' | 'added' | 'no-target' for tests. */
export function dockPanel(
  model: Model,
  id: string,
  name: string,
  location: DockLocation = DockLocation.CENTER,
): 'focused' | 'added' | 'no-target' {
  let tabId: string | null = null;
  let sceneTabsetId: string | null = null;
  let firstTabsetId: string | null = null;
  model.visitNodes((node) => {
    const type = node.getType();
    if (type === 'tab' && (node as TabNode).getComponent() === id) tabId = node.getId();
    if (type === 'tabset') {
      if (!firstTabsetId) firstTabsetId = node.getId();
      const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
      if (kids.some((c) => c.getComponent?.() === 'scene')) sceneTabsetId = node.getId();
    }
  });
  if (tabId) { model.doAction(Actions.selectTab(tabId)); return 'focused'; }
  const target = sceneTabsetId ?? firstTabsetId;
  if (!target) return 'no-target';
  model.doAction(Actions.addNode({ type: 'tab', name, component: id }, target, location, -1, true));
  return 'added';
}
