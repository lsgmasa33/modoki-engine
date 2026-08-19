/** Dirty-asset registry (mcp-persistence.md) — the pending, unsaved asset docs that a save
 *  writes to disk. THE only path from an asset edit to disk, for agents and humans alike.
 *
 *  Both writers apply their edit to the LIVE editor cache immediately (so the panel/viewport
 *  reflects it) and park the pending doc here; `saveAll` (serialize.ts) flushes it, and
 *  `hasUnsavedChanges()`/`get_editor_state` surface it so a pending asset is never silently lost
 *  the way the pre-Phase-3 prefab-instantiate bug lost live entities (see agentEditorOps.ts's
 *  `!edit`/`!create` undo-entry comments for that history):
 *
 *   - AGENT — `particle-set` / `anim-set-clip` / `anim-add-key` / `timeline-set` /
 *     `timeline-add-clip`, which answer `saved:false` and say so.
 *   - PANEL — the five asset editors (Particle / Animation / Timeline / Skin / SpriteAnim), as
 *     of #259. They used to write straight to disk on a 400ms debounce, which was a SECOND
 *     persistence contract for the same file: it collided with this registry (see
 *     `assetWrittenToDisk`), left no undo entry, and wrote committed files behind the human's
 *     back (CLAUDE.md #18). Now they park like everything else and Cmd+S is the write.
 *
 *  ORIGIN is recorded per entry because the flush is not identical for the two (see
 *  `AssetWriteOrigin`), and it follows the LAST writer — a park superseded by a panel edit is a
 *  panel write, which is the correct answer for both flags the flush sets. */

import { backendFetch } from '../backend/editorBackend';
import type { AssetSchemaType } from '../../runtime/assets/assetSchemas';

/** WHO parked a write. The flush treats the two differently in exactly two ways, both about
 *  what the writer is:
 *
 *   - **A panel is a FULL-DOCUMENT editor**, so removing a field is a legitimate user action and
 *     `JSON.stringify` simply omits it. `/api/asset-write` refuses a write that drops top-level
 *     keys unless the caller says `replace:true` — correct for the agent's read-modify-write
 *     flow, which always carries every key back, and wrong for a panel. Concretely, not
 *     hypothetically: `ensurePartsArray` (panels/skinParts.ts) converts a v1 rig to v2 by moving
 *     `sprite`/`mesh`/`skinIndices`/`skinWeights` into `parts[]`, so the first "+ Add Part" on a
 *     v1 rig drops four top-level keys. Panel-origin writes therefore pass `replace:true`;
 *     agent-origin writes keep the guard exactly as it was.
 *   - Everything in here was ALREADY applied to the live cache when it was parked, so the flush
 *     has nothing to tell the renderer and marks itself as the editor's own write. Without that,
 *     the flush's own (unsuppressed) `/api/asset-write` fires a watcher event ~150ms later,
 *     `dropParkedWriteFor` (agentBridge) discards whatever was parked by then — and an edit made
 *     in the second after Cmd+S is gone, loudly in the console and silently in the UI. A
 *     file-direct `modoki_write_asset` on the same route must NOT be suppressed: there the cache
 *     really is stale, which is the C7 bug the invalidation exists for. */
export type AssetWriteOrigin = 'panel' | 'agent';

interface DirtyAsset { type: AssetSchemaType; data: unknown; origin: AssetWriteOrigin }

const dirty = new Map<string, DirtyAsset>();

// ── Change notification ──
// The registry is read by UI (a panel's dirty indicator) as well as by save/agent code, and a
// bare Map cannot tell React that a flush emptied it: after Cmd+S nothing re-renders the panel,
// so an indicator derived from a plain read stays on "Unsaved" over a saved file until the next
// keystroke — a lie in the one direction that matters. Version + subscribe, read through
// useSyncExternalStore (same shape as EditorApp's extra-menus store).
let _version = 0;
const listeners = new Set<() => void>();
function bump(): void { _version += 1; for (const fn of listeners) fn(); }
/** Subscribe to registry changes (park / flush / discard). Returns an unsubscribe. */
export function subscribeDirtyAssets(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Monotonic change counter — the `getSnapshot` for a subscriber that wants "did anything move". */
export function getDirtyAssetsVersion(): number { return _version; }
/** Is a write parked for exactly this path? The per-panel dirty indicator's snapshot. */
export function isAssetDirty(path: string | undefined): boolean {
  return !!path && dirty.has(path);
}

/** Record (or replace) a pending asset write. Last-write-wins per path — a second edit to the
 *  same particle/clip/timeline/rig before a save simply supersedes the first.
 *
 *  `origin` defaults to `'agent'` so the agent ops read unchanged; the panels pass `'panel'`. */
export function markAssetDirty(
  path: string, type: AssetSchemaType, data: unknown, origin: AssetWriteOrigin = 'agent',
): void {
  dirty.set(path, { type, data, origin });
  bump();
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
export function peekDirtyAsset(
  path: string,
): { type: AssetSchemaType; data: unknown; origin: AssetWriteOrigin } | null {
  const d = dirty.get(path);
  return d ? { type: d.type, data: d.data, origin: d.origin } : null;
}

/** The EDITOR just wrote this asset's file itself, so any write still parked for that path is
 *  stale — drop it, or the next `saveAll` flushes the older doc straight over what was just
 *  written. Returns whether anything was dropped.
 *
 *  MEASURED, not theoretical (2026-08-18, games/3d-test): `particle_set` parked v1; a panel-shaped
 *  `/api/write-file` POST put v2 on disk; `dirtyAssetPaths` still listed the path; `save_all` then
 *  rewrote the file back to v1 with no warning. The human's panel edits were gone.
 *
 *  SCOPE AFTER #259, which is narrower than the collision that created it: the panels' EDITING
 *  path no longer writes behind the registry's back — it parks like everything else. What is left
 *  is the panels' one-shot CREATE/REGENERATE writes, which must still write immediately (a new
 *  file has to exist on disk for `registerAsset` and the manifest to see it). Of those,
 *  `SkinEditor`'s `autoRigSelected` is the one that can land on a path that ALREADY has a parked
 *  write — it derives `<sprite>.rig2d.json`, so re-rigging the same sprite regenerates over the
 *  rig you were editing.
 *
 *  `dropParkedWriteFor` (agentBridge) already states this rule for an EXTERNAL change — the file
 *  watcher sees the write and discards the park. It cannot see these: `/api/write-file`
 *  fingerprints its own bytes through `markEditorWrite` precisely so the editor does not react to
 *  itself, so those writes fire no watcher event at all. Closed by the writer saying so directly.
 *
 *  Loud, never silent, for the same reason as `dropParkedWriteFor`: this discards pending work. */
export function assetWrittenToDisk(path: string): boolean {
  if (!dirty.delete(path)) return false;
  bump();
  console.warn(
    `[dirtyAssets] ${path} was just written to disk by its editor panel — DISCARDED the older ` +
    'parked write for it. The file is now authoritative; the parked doc would have overwritten it ' +
    'at the next save_all.',
  );
  return true;
}

/** Test-only: drop every pending entry without writing it. */
export function clearDirtyAssets(): void { dirty.clear(); bump(); }

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
    if (discarded.length) bump();
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
  if (discarded.length) bump();
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
 *  ops already use, then drop the ones that succeeded. Called by `saveAll`, UNCONDITIONALLY and
 *  before the scene write — the scene's own refusals (run-mode, prefab-edit, needs-path, a
 *  cancelled Save-As, a failed write) are about the live WORLD and must not decide the fate of an
 *  asset document the panel owns. It used to live inside `saveScene`, behind a successful scene
 *  write, so all five of those silently swallowed it (#259).
 *
 *  Independent failures: one bad asset does not block the others or the scene save.
 *
 *  `replace`/`selfWrite` are per-entry and per-origin — see `AssetWriteOrigin` for both. */
export async function flushDirtyAssets(): Promise<FlushResult> {
  const saved: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const [path, { type, data, origin }] of dirty) {
    try {
      const res = await backendFetch('/api/asset-write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path, type, data,
          ...(origin === 'panel' ? { replace: true } : {}),
          selfWrite: true,
        }),
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
  if (saved.length) bump();
  return { saved, failed };
}
