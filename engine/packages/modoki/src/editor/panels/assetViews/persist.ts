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
import { markAssetDirty } from '../../scene/dirtyAssets';
import type { AssetSchemaType } from '../../../runtime/assets/assetSchemas';
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

/** Park an asset-file edit and refresh the live panel for `path` if mounted.
 *
 *  ⚠️ **This PARKS; it does not write (#831).** It used to POST `/api/write-file` on every
 *  keystroke, so one numeric field in the Material view hit the disk immediately while
 *  `get_editor_state` reported `persistenceMode: 'manual'` and `unsavedChanges: false` — a
 *  committed file rewritten behind the human's back, which is the hazard CLAUDE.md's "stage paths
 *  EXPLICITLY" rule exists for (#18). #259 made the five asset EDITORS manual on the premise that
 *  manual save was "every other surface"; that premise was false, and these four asset VIEWS are
 *  the population it missed. Now they park like everything else and Cmd+S is the write.
 *
 *  Pure of any React instance — safe to call from an undo/redo closure after the originating panel
 *  has unmounted, which is the whole reason this is a module function and not a hook. That matters
 *  more now, not less: `markAssetDirty` is likewise a plain module function, so the undo path parks
 *  exactly as the edit path does. (`useParkedAssetDoc`, the five editors' idiom, is a hook and
 *  cannot be reached from an undo closure — hence the different shape for the same contract.)
 *
 *  `type` is REQUIRED and has no default. The registry is keyed by path alone, so the type is what
 *  lets `pendingAssetDoc` refuse to hand a shader doc to the animset view; making it a parameter
 *  also means the type checker enumerates every call site rather than a hand-list doing it.
 *
 *  ⚠️ The cache + panel still update OPTIMISTICALLY and SYNCHRONOUSLY here, before anything is
 *  written — unchanged, and still what makes the viewport reflect an Inspector edit immediately.
 *  What changed is only WHEN the bytes land. There is no longer a write that can fail at this
 *  point, so nothing is reported here; a failed FLUSH is `flushDirtyAssets`' to report. */
export function persistAssetEdit(
  path: string, type: AssetSchemaType, updated: unknown, invalidate: (path: string, updated: any) => void,
): void {
  markAssetDirty(path, type, updated, 'panel');
  invalidate(path, updated);
  _assetViewSetters.get(path)?.(updated); // refresh the mounted panel, if any
  // Wake the 3D viewport's idle dirty-gate. An asset edit alone leaves a STATIC scene idle — the
  // invalidated material never gets re-resolved until some OTHER event (Play, camera move,
  // selection) re-arms the gate. Firing the shared dirty signal (the same one gizmo/trait writes
  // use) draws for the grace window, long enough for the async material re-fetch to land and
  // syncMaterial to re-apply it live.
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
