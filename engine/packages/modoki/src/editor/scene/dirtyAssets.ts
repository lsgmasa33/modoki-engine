/** Dirty-asset registry (mcp-persistence.md Phase 3) — pending, unsaved
 *  particle/animation/timeline edits made in 'manual' persistence mode.
 *
 *  `particle-set` / `anim-set-clip` / `anim-add-key` / `timeline-set` / `timeline-add-clip`
 *  apply their edit to the LIVE editor cache immediately either way (so the panel/viewport
 *  reflects it), but in 'auto' mode they ALSO persist straight to disk via `/api/asset-write`
 *  (unchanged from before this plan). In 'manual' mode there is nowhere for that pending write
 *  to live until a save — `saveAll` (serialize.ts) only ever serializes the SCENE, not
 *  arbitrary asset files — so this module is that somewhere: a `path -> pending doc` map,
 *  flushed by `saveAll` and visible to `hasUnsavedChanges()`/`get_editor_state` so a pending
 *  asset is never silently lost the way the pre-Phase-3 prefab-instantiate bug lost live
 *  entities (see agentEditorOps.ts's `!edit`/`!create` undo-entry comments for that history). */

import { backendFetch } from '../backend/editorBackend';
import type { AssetSchemaType } from '../../runtime/assets/assetSchemas';

interface DirtyAsset { type: AssetSchemaType; data: unknown }

const dirty = new Map<string, DirtyAsset>();

/** Record (or replace) a pending asset write. Last-write-wins per path — a second manual-mode
 *  edit to the same particle/clip/timeline before a save simply supersedes the first. */
export function markAssetDirty(path: string, type: AssetSchemaType, data: unknown): void {
  dirty.set(path, { type, data });
}

/** True if any asset edit is pending a save. Folded into `hasUnsavedChanges()`. */
export function hasDirtyAssets(): boolean { return dirty.size > 0; }

/** The pending paths, for `get_editor_state` — an agent must be able to SEE what would be
 *  lost by a `load_scene`/`new_scene`/discard, the same way `unsavedChanges` already does for
 *  live-world scene edits. */
export function getDirtyAssetPaths(): string[] { return [...dirty.keys()]; }

/** Test-only: drop every pending entry without writing it. */
export function clearDirtyAssets(): void { dirty.clear(); }

export interface FlushResult {
  /** Paths written successfully (and removed from the registry). */
  saved: string[];
  /** Paths that failed to write (LEFT in the registry — still pending, still reported by
   *  `hasUnsavedChanges()`/`get_editor_state`, so a failed flush is never silently dropped). */
  failed: Array<{ path: string; error: string }>;
}

/** Write every pending asset via the same validated `/api/asset-write` route the file-direct
 *  ops already use, then drop the ones that succeeded. Called by `saveAll` alongside the scene
 *  write. Independent failures: one bad asset does not block the others or the scene save. */
export async function flushDirtyAssets(): Promise<FlushResult> {
  const saved: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const [path, { type, data }] of dirty) {
    try {
      const res = await backendFetch('/api/asset-write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, type, data }),
      });
      let body: { ok?: unknown; error?: unknown; errors?: unknown } | null = null;
      try { body = await res.json(); } catch { /* non-JSON body */ }
      const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]).join('; ') : '';
      if (!res.ok || body?.ok === false || errors) {
        failed.push({ path, error: errors || (typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`) });
        continue;
      }
      saved.push(path);
    } catch (e) {
      failed.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const path of saved) dirty.delete(path);
  return { saved, failed };
}
