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

import { useEffect, useRef } from 'react';
import { markAssetDirty } from '../../scene/dirtyAssets';
import type { AssetSchemaType } from '../../../runtime/assets/assetSchemas';
import { invalidateMaterial } from '../../../runtime/loaders/meshTemplateCache';
import { invalidateAnimSet, setAnimSet, type AnimSetClipDef } from '../../../runtime/loaders/animSetCache';
import { invalidateShader } from '../../../runtime/loaders/spriteMaterialCache';
import { fireDirtyListeners } from '../../../runtime/core/ecs/entityUtils';

export const clampNum = (v: number, min?: number, max?: number) => {
  let r = v;
  if (typeof min === 'number') r = Math.max(min, r);
  if (typeof max === 'number') r = Math.min(max, r);
  return r;
};

const _assetViewSetters = new Map<string, (data: any) => void>();

/** ⚠️ `reportWriteFailed` used to live here and is GONE (#831). It was the console+toast for a
 *  rejected Inspector write, and after #831 no Inspector code writes: everything parks, and the
 *  only writer is `flushDirtyAssets`. Its report is not lost — it moved to where the failure now
 *  happens, twice over: `toastForSave` (scene/saveCommand.ts) names every path whose write failed
 *  and is still unsaved, in a WARN toast; and `getAssetFlushError` (scene/dirtyAssets.ts) carries
 *  the reason per path so the panel showing that asset can say so itself.
 *
 *  Its old reasoning still holds and is why the flush LEAVES a failed entry parked: report, do not
 *  REVERT. The edited value is still correct as an intention, and snapping the Inspector back would
 *  destroy the human's work to resolve a failure that is usually transient. */

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
 *  point, so nothing is reported here; a failed FLUSH is `flushDirtyAssets`' to report.
 *
 *  `ifMatch` is an OPTIONAL compare-and-swap baseline — the sha256 of the file's bytes as this
 *  panel last read them — which the flush turns into a write precondition. Only `AtlasAssetView`
 *  passes one; see `DirtyAsset.ifMatch` for why that view needs it and the others do not. */
export function persistAssetEdit(
  path: string, type: AssetSchemaType, updated: unknown, invalidate: (path: string, updated: any) => void,
  ifMatch?: string,
): void {
  markAssetDirty(path, type, updated, 'panel', ifMatch);
  invalidate(path, updated);
  _assetViewSetters.get(path)?.(updated); // refresh the mounted panel, if any
  // Wake every subscribed viewport's idle dirty-gate (2D and 3D). An asset edit alone leaves a STATIC scene idle — the
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

/** Register a live refresher for EACH of several paths at once (#843's batch views).
 *
 *  A batch view can't just call `useAssetViewRefresher` in a loop over `paths` — that calls a hook
 *  a variable number of times, which is an illegal hook call (React tracks hooks by call ORDER, not
 *  identity). So the whole map has to be one effect, registering one `_assetViewSetters` entry per
 *  path, with each entry's cleanup identity-guarded exactly like `useAssetViewRefresher`'s single
 *  one — `if (_assetViewSetters.get(p) === fn) delete` — so a stale registration is never dropped
 *  out from under a newer one.
 *
 *  Two things that would otherwise re-register on every render and defeat the identity guard above:
 *   - `paths` (Inspector.tsx builds it as `assets.map((a) => a.path)` on every render, so a NEW
 *     array is a certainty even when its contents haven't changed) — key the effect on the joined
 *     path string instead of the array itself.
 *   - `setDataFor`, when the caller doesn't memoize it — read it through a ref so a changing
 *     callback identity doesn't retrigger the effect either. */
export function useAssetViewRefreshers(paths: string[], setDataFor: (path: string, data: any) => void) {
  const setDataForRef = useRef(setDataFor);
  setDataForRef.current = setDataFor;
  const key = paths.join(' ');
  useEffect(() => {
    const fns = paths.map((p) => {
      const fn = (data: any) => setDataForRef.current(p, data);
      _assetViewSetters.set(p, fn);
      return [p, fn] as const;
    });
    return () => { for (const [p, fn] of fns) { if (_assetViewSetters.get(p) === fn) _assetViewSetters.delete(p); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `key`, the joined path string, deliberately: `paths` is a fresh array every render (Inspector.tsx rebuilds it via .map), so depending on the array itself would re-register every render and defeat the identity-guarded cleanup above.
  }, [key]);
}

export const invalidateMaterialFile = (path: string) => invalidateMaterial(path);
// An `.atlas.json` edit invalidates NOTHING live, and that is a measured fact rather than a gap:
// this document is the AUTHORED half (which sprites, how they pack), while everything the
// renderer reads — pages, frame map, hash — is DERIVED, lives in the `.meta.json` sidecar, and
// only changes when a re-pack runs (`/api/reimport`, the panel's Pack button). Changing `padding`
// does not move a pixel until then. A no-op is the honest wiring; inventing an invalidation here
// would drop a cache entry nothing had rebuilt and make the panel look like it had done something.
export const invalidateAtlasFile = (_path: string) => { /* nothing live derives from this doc */ };
// A `.shader.json` edit (param default/range/label): drop THIS shader's compiled 2D-material
// program so the next material-pass frame recompiles + re-reads the new defaults. The cache is
// keyed by GUID and every entity using the edited shader shares that guid, so evicting the one
// key already re-resolves all of them while leaving every OTHER shader's program alone (#852 —
// this used to clear the whole map, flashing unrelated entities for a frame). An already-mounted
// material Mesh caches its bound uniforms, so a default change fully reflects on the next scene
// load / material rebuild.
//
// Delegates to `spriteMaterialCache.invalidateShader` (#842) rather than spelling the two calls
// out here — this panel and the live-reload watcher (agentBridge.ts's ASSET_CACHE_INVALIDATORS)
// must drive the SAME definition of "a `.shader.json` changed", not two copies that can drift.
export const invalidateShaderFile = (path: string) => invalidateShader(path);
// Live-update the running scene: drop the stale entry, seed the new one so the
// next driveAnimator frame resolves the edited params (path === cache key).
export const invalidateAnimSetFile = (path: string, updated: unknown) => { invalidateAnimSet(path); setAnimSet(path, updated as { source?: string; clips?: AnimSetClipDef[] }); };
