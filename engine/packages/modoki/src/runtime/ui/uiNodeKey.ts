/** React key for a UI node. koota's `entityId` is a RECYCLED index (#868): keyed by it alone, a UI
 *  entity destroyed and replaced on the same index between two tree rebuilds kept the dead entity's
 *  fiber and DOM (scroll position, focus, an input's typed value, AutoFitText's measurements). The
 *  generation makes the newcomer mount fresh; a live entity's key is unchanged across edits.
 *
 *  Its own module so `UINode.tsx` stays component-only (fast refresh) and suites that mock
 *  `uiTreeStore` with an explicit export list are not broken by a new import. */

import type { UINodeData } from './uiTreeStore';

export function uiNodeKey(node: Pick<UINodeData, 'entityId' | 'generation'>): string {
  return `${node.entityId}:${node.generation}`;
}
