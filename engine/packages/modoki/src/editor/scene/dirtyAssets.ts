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

/** The pending doc for one path, or null if nothing is parked for it — i.e. what `saveAll`
 *  would actually WRITE. `getDirtyAssetPaths()` answers only "is something pending"; a caller
 *  that needs to know *which* def is queued (a test asserting undo moved the parked write, or a
 *  read that must not report the live cache as though it were the pending one) needs this. */
export function peekDirtyAsset(path: string): { type: AssetSchemaType; data: unknown } | null {
  const d = dirty.get(path);
  return d ? { type: d.type, data: d.data } : null;
}

/** Test-only: drop every pending entry without writing it. */
export function clearDirtyAssets(): void { dirty.clear(); }

/** Drop pending asset writes WITHOUT writing them — the missing counterpart to `flushDirtyAssets`.
 *
 *  WHY THIS EXISTS. Manual persistence gave the registry exactly one exit: `saveAll`. So an
 *  exploratory particle/anim/timeline edit could not be backed out at all. The obvious workaround —
 *  re-apply the old def — is NOT equivalent, and the difference is not academic: it re-parks a
 *  write, so the doc stays dirty and the NEXT save commits it. It is also not byte-faithful, because
 *  the def a caller can read back is the MIGRATED one (a legacy scalar `gravity: 6` reads as
 *  `[0,-6,0]`), so "restoring" it rewrites the file in a new form. Both were measured on
 *  `confetti.particle.json` while reviewing the tool-quality audit: the live smoke suite claimed to
 *  restore the asset and in fact left a parked write that turned a committed asset dirty on the next
 *  save — and, via `hasUnsavedChanges()`, blocked the file-direct routes for everything after it.
 *
 *  SCOPE, and it is narrow on purpose: this drops the PENDING WRITE, not the edit. The editor's live
 *  cache keeps whatever def was applied until the asset is reloaded, because the panel and viewport
 *  are already showing it and silently snapping them back would be a second surprise. To genuinely
 *  revert: apply the previous def, THEN discard the write that re-parked.
 *
 *  `paths` omitted = drop everything. That is deliberately NOT the shape the agent surface exposes
 *  bare — see the `discard-asset-edits` op, which refuses a bare call and makes the caller say
 *  `all:true`. Same lesson as `set_selection`, where a bare call clearing everything is what made a
 *  misspelled argument key destructive. */
export function discardDirtyAssets(paths?: readonly string[]): { discarded: string[]; notPending: string[] } {
  if (!paths) {
    const discarded = [...dirty.keys()];
    dirty.clear();
    return { discarded, notPending: [] };
  }
  const discarded: string[] = [];
  const notPending: string[] = [];
  for (const p of paths) {
    // Report a path that was NOT pending rather than counting it as discarded: "I dropped your
    // edit" and "there was nothing to drop" are different answers, and a typo'd path must not read
    // as the first one.
    (dirty.delete(p) ? discarded : notPending).push(p);
  }
  return { discarded, notPending };
}

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
