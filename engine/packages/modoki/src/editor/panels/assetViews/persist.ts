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
import { invalidatePixiShaderProgram } from '../../../runtime/rendering/pixiShaderBuilder';
import { fireDirtyListeners } from '../../../runtime/core/ecs/entityUtils';
import { useEditorStore } from '../../store/editorStore';

export const clampNum = (v: number, min?: number, max?: number) => {
  let r = v;
  if (typeof min === 'number') r = Math.max(min, r);
  if (typeof max === 'number') r = Math.min(max, r);
  return r;
};

const _assetViewSetters = new Map<string, (data: any) => void>();

/** A write that did not land must SAY SO. The Inspector's asset edits were the last place in the
 *  editor where a rejected write was silent (the #308 sweep later found one more, AtlasAssetView,
 *  which now reports through this same function): the response was never inspected and a rejection was
 *  never caught, while the cache invalidation and the panel refresh ran regardless — so a failed
 *  write left the editor confidently showing a value the file does not have, and the only trace
 *  was an unhandled promise rejection nobody reads. Same class as the save toasts that were fixed
 *  for scenes and prefabs (C7): never report a save that did not happen.
 *
 *  It reports rather than REVERTS, deliberately. The edited value is still live and still correct
 *  as an intention; snapping the Inspector back to the old value would destroy the human's work to
 *  resolve a failure that is usually transient (permissions, a full disk, the backend restarting),
 *  and the next edit to the same asset rewrites the whole file — so editing again IS the retry.
 *  Same reasoning as `discardDirtyAssets`'s scope note: dropping the write is not dropping the edit. */
export function reportWriteFailed(path: string, detail: string): void {
  console.error(
    `[Inspector] FAILED to write ${path} — ${detail}. The editor is showing the edited value, but ` +
    'the file on disk still holds the previous one. Edit the asset again to retry the write.',
  );
  useEditorStore.getState().showToast(
    `Save FAILED for ${path.split('/').pop() ?? path} — the file on disk is unchanged (see console)`,
    'warn',
  );
}

/** Persist an asset-file edit + refresh the live panel for `path` if mounted.
 *  Pure of any React instance — safe to call from an undo/redo closure after the
 *  originating panel has unmounted. `invalidate` is a stable module-level fn
 *  (per asset type), so capturing it in the undo closure is unmount-safe too.
 *
 *  Returns the write's promise so a test can await it; every caller ignores it on purpose — an
 *  undo closure must not have to await a disk write, which is what keeps this callable from one. */
export function persistAssetEdit(
  path: string, updated: unknown, invalidate: (path: string, updated: any) => void,
): Promise<void> {
  const write = backendFetch('/api/write-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: JSON.stringify(updated, null, 2) }),
  })
    .then(async (res) => {
      if (res.ok) return;
      // Prefer the route's own message over a bare status — /api/write-file answers 403 for a path
      // outside the asset roots, which is a different fix from a 500.
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json() as { error?: unknown } | null;
        if (typeof body?.error === 'string' && body.error) detail = body.error;
      } catch { /* non-JSON body — the status is all there is */ }
      reportWriteFailed(path, detail);
    })
    .catch((e) => reportWriteFailed(path, e instanceof Error ? e.message : String(e)));
  // The cache + panel update OPTIMISTICALLY, before the write is known to have landed. That order
  // is what makes the live viewport reflect an Inspector edit immediately; the failure path above
  // is what stops it from being a LIE when the write does not land.
  invalidate(path, updated);
  _assetViewSetters.get(path)?.(updated); // refresh the mounted panel, if any
  // Wake the 3D viewport's idle dirty-gate. The Inspector saves via /api/write-file,
  // which is self-write-guarded (no file-watcher hot-reload), so an asset edit alone
  // leaves a STATIC scene idle — the invalidated material never gets re-resolved until
  // some OTHER event (Play, camera move, selection) re-arms the gate. Firing the shared
  // dirty signal (the same one gizmo/trait writes use) draws for the grace window, long
  // enough for the async material re-fetch to land and syncMaterial to re-apply it live.
  fireDirtyListeners();
  return write;
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
//
// This is the ONE call site where a shader's SOURCE has genuinely changed (a param default,
// range, etc. was edited and written to disk — see ShaderAssetView), so it's also the one call
// site allowed to evict `pixiShaderBuilder`'s module-level program cache (#716) — everywhere
// else (world swap, viewport teardown) that cache MUST survive `clearSpriteMaterialCache()`,
// which is the whole point of the fix. `persistAssetEdit` calls `invalidate(path, updated)`, so
// `path` is right here — evict just that path rather than the whole program cache.
export const invalidateShaderFile = (path: string) => { clearSpriteMaterialCache(); invalidatePixiShaderProgram(path); };
// Live-update the running scene: drop the stale entry, seed the new one so the
// next driveAnimator frame resolves the edited params (path === cache key).
export const invalidateAnimSetFile = (path: string, updated: unknown) => { invalidateAnimSet(path); setAnimSet(path, updated as { source?: string; clips?: AnimSetClipDef[] }); };
