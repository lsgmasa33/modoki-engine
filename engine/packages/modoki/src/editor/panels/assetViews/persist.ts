/** Asset-file edit persistence (editor-inspector.md F10), extracted from
 *  Inspector.tsx alongside the asset views (F2). Asset-file edits (material /
 *  animSet) must be undone/redone against the FILE + CACHE — the source of truth
 *  — NOT a panel instance's React state. The panel that pushed the edit may have
 *  unmounted (asset deselected) by the time undo runs, so a closure over its
 *  setData would setState-after-unmount and leave the file/cache out of step.
 *
 *  Each mounted asset view registers its setData under its `path`; persistAssetEdit
 *  writes the file, runs the type-specific cache invalidation, and refreshes
 *  whichever instance is currently showing that asset (or none — the file+cache
 *  still update and a later re-select re-reads from disk via the load effect). */

import { useEffect } from 'react';
import { backendFetch } from '../../backend/editorBackend';
import { invalidateMaterial } from '../../../runtime/loaders/meshTemplateCache';
import { invalidateAnimSet, setAnimSet, type AnimSetClipDef } from '../../../runtime/loaders/animSetCache';
import { clearSpriteMaterialCache } from '../../../runtime/loaders/spriteMaterialCache';
import { fireDirtyListeners } from '../../../runtime/ecs/entityUtils';

export const clampNum = (v: number, min?: number, max?: number) => {
  let r = v;
  if (typeof min === 'number') r = Math.max(min, r);
  if (typeof max === 'number') r = Math.min(max, r);
  return r;
};

const _assetViewSetters = new Map<string, (data: any) => void>();

/** Persist an asset-file edit + refresh the live panel for `path` if mounted.
 *  Pure of any React instance — safe to call from an undo/redo closure after the
 *  originating panel has unmounted. `invalidate` is a stable module-level fn
 *  (per asset type), so capturing it in the undo closure is unmount-safe too. */
export function persistAssetEdit(path: string, updated: unknown, invalidate: (path: string, updated: any) => void) {
  backendFetch('/api/write-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: JSON.stringify(updated, null, 2) }),
  });
  invalidate(path, updated);
  _assetViewSetters.get(path)?.(updated); // refresh the mounted panel, if any
  // Wake the 3D viewport's idle dirty-gate. The Inspector saves via /api/write-file,
  // which is self-write-guarded (no file-watcher hot-reload), so an asset edit alone
  // leaves a STATIC scene idle — the invalidated material never gets re-resolved until
  // some OTHER event (Play, camera move, selection) re-arms the gate. Firing the shared
  // dirty signal (the same one gizmo/trait writes use) draws for the grace window, long
  // enough for the async material re-fetch to land and syncMaterial to re-apply it live.
  fireDirtyListeners();
}

/** Register `setData` as the live refresher for `path` while the view is mounted. */
export function useAssetViewRefresher(path: string, setData: (data: any) => void) {
  useEffect(() => {
    _assetViewSetters.set(path, setData);
    return () => { if (_assetViewSetters.get(path) === setData) _assetViewSetters.delete(path); };
  }, [path, setData]);
}

export const invalidateMaterialFile = (path: string) => invalidateMaterial(path);
// A `.shader.json` edit (param default/range/label): drop the compiled 2D-material
// programs so the next material-pass frame recompiles + re-reads the new defaults. (The
// cache is keyed by GUID, so clearing all is the simplest correct invalidation; they
// recompile lazily.) An already-mounted material Mesh caches its bound uniforms, so a
// default change fully reflects on the next scene load / material rebuild.
export const invalidateShaderFile = () => clearSpriteMaterialCache();
// Live-update the running scene: drop the stale entry, seed the new one so the
// next driveAnimator frame resolves the edited params (path === cache key).
export const invalidateAnimSetFile = (path: string, updated: unknown) => { invalidateAnimSet(path); setAnimSet(path, updated as { source?: string; clips?: AnimSetClipDef[] }); };
