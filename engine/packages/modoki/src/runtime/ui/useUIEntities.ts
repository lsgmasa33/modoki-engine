/** useUIEntities — React hook that returns the current UI entity tree.
 *
 *  Backed by Zustand (uiTreeStore). The tree is rebuilt by uiTreeProjection()
 *  which runs in the ECS pipeline at PROJECTION priority — only when the dirty
 *  flag has been set by an ECS write. No polling, no per-frame comparison. */

import { useUITreeStore } from './uiTreeStore';

export type { UINodeData } from './uiTreeStore';

export function useUIEntities() {
  return useUITreeStore(s => s.tree);
}
