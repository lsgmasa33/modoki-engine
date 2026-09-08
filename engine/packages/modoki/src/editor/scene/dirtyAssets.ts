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
 *     Since #831, the four Inspector asset VIEWS (Material, MaterialBatch, Shader, AnimSet) park
 *     through this same call with origin `'panel'` too (`assetViews/persist.ts`) — so PANEL now
 *     covers all 8 `ASSET_SCHEMA_TYPES`, not just the original five.
 *
 *  ORIGIN is recorded per entry because the flush is not identical for the two (see
 *  `AssetWriteOrigin`), and it follows the LAST writer — a park superseded by a panel edit is a
 *  panel write, which is the correct answer for both flags the flush sets. */

import { backendFetch } from '../backend/editorBackend';
import type { AssetSchemaType } from '../../runtime/assets/assetSchemas';
import { notifyListeners } from '../../runtime/core/notifyListeners';

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

interface DirtyAsset {
  type: AssetSchemaType;
  data: unknown;
  origin: AssetWriteOrigin;
  /** OPTIONAL compare-and-swap baseline: the sha256 of the file's bytes as the parker last read
   *  them. When set, the flush sends it as `/api/asset-write`'s `ifMatch` precondition and the
   *  write is REFUSED (409) if the file changed underneath in the meantime.
   *
   *  Only `AtlasAssetView` sets it today. It needs it (#439): that panel serializes the WHOLE
   *  document, and nothing notifies it of a same-path content change — `assetsVersion` is keyed on
   *  the asset PATH SET, and `atlas` is not a `SceneChangedKind`, so neither the manifest signal
   *  nor `dropParkedWriteFor` fires for it. A `git checkout` under a live editor (CLAUDE.md's
   *  documented hazard) would otherwise be silently reverted by the next Cmd+S.
   *
   *  ⚠️ **It is NOT the only view with that hazard, and an earlier draft of this note said it
   *  was.** `material` and `shader` are absent from `LiveReloadKind`/`SceneChangedKind` too
   *  (`vite-asset-scanner.ts`, `agentBridge.ts`), and `classifySceneChange` has no case for
   *  either — so `MaterialAssetView`, `ShaderAssetView` and `MaterialBatchView` park whole
   *  documents with no baseline AND no watcher drop, and the same `git checkout` reverts them
   *  silently. That is #842, claimed elsewhere; its fix is to derive the watcher classification
   *  from `ASSET_SCHEMA_TYPES`, not to give each view its own baseline. So the honest scoping is
   *  "atlas needs this INDEPENDENTLY of #842", not "atlas is the only one at risk".
   *
   *  ⚠️ Parking made that window LONGER, not shorter. Before #831 the panel wrote on every control
   *  interaction, so the read-to-write gap was one keystroke; now it is however long the human takes
   *  to press Cmd+S. The precondition matters MORE after the fix than before it. */
  ifMatch?: string;
}

const dirty = new Map<string, DirtyAsset>();

// ── Change notification ──
// The registry is read by UI (a panel's dirty indicator) as well as by save/agent code, and a
// bare Map cannot tell React that a flush emptied it: after Cmd+S nothing re-renders the panel,
// so an indicator derived from a plain read stays on "Unsaved" over a saved file until the next
// keystroke — a lie in the one direction that matters. Version + subscribe, read through
// useSyncExternalStore (same shape as EditorApp's extra-menus store).
let _version = 0;
const listeners = new Set<() => void>();

/** The doc most recently WRITTEN to each path by a flush — i.e. what the file holds, as far as the
 *  editor knows. Identity is the signal: it stays the same object until the next flush of that
 *  path, so a panel can use it as a `useSyncExternalStore` snapshot.
 *
 *  WHY IT EXISTS. A panel skips parking when its document is identity-equal to the one it knows is
 *  on disk, and that baseline was seeded ONLY at load — so after a save it still named the doc the
 *  panel had OPENED. Undo back to that value therefore looked "already saved", parked nothing, and
 *  the revert lived in memory that no save could reach while the editor reported clean. Measured on
 *  `games/3d-test` (owner, 2026-08-19): a keyframe moved from t=1.05 to t=1.0944 and saved, then
 *  undone — the panel showed 1.05, the file held 1.0944, `dirtyAssetPaths` was empty, and Cmd+S was
 *  a no-op. The debounced autosave this replaced advanced its own baseline on every successful
 *  write; parking moved the write here, so the advance has to come from here too. */
const lastFlushed = new Map<string, unknown>();

/** What the last flush wrote for `path`, or null if this session has never written it. A panel
 *  adopts it as its saved-baseline ONLY when it is the very doc that panel parked (see
 *  `useParkedAssetDoc`) — never merely because the path was written, which would let one panel's
 *  save re-baseline another's unsaved edit. */
export function getLastFlushedAsset(path: string | undefined): unknown | null {
  return path ? lastFlushed.get(path) ?? null : null;
}
/** Why the LAST flush of each path failed, if it did. Cleared when the path is parked again,
 *  discarded, or flushed successfully.
 *
 *  A failed flush already leaves the entry parked and reports it in `FlushResult.failed` — but
 *  that result goes to whoever called `saveAll`, and the person who needs to know is looking at
 *  the PANEL. A compare-and-swap conflict is the case that made this necessary (the atlas panel
 *  has a "changed on disk" banner and no way to learn that its save hit one), and the same
 *  blindness applies to every other panel's ordinary write failure. */
const flushErrors = new Map<string, { error: string; conflict: boolean }>();

/** Why the last flush of `path` failed, or null if the last one succeeded / never ran.
 *  `conflict` distinguishes "the file changed under you" from "the write was rejected" — a
 *  different story for the reader, and only the first one means re-reading will help. */
export function getAssetFlushError(path: string | undefined): { error: string; conflict: boolean } | null {
  return path ? flushErrors.get(path) ?? null : null;
}

/** The sha256 of the bytes the last flush WROTE for each path, as reported by the writer. */
const lastFlushedHash = new Map<string, string>();

/** Forget what the last flush wrote for `path`. Called wherever the record stops being a claim
 *  about the CURRENT file — a discard (the panel is about to re-read the truth from disk) or a
 *  write by the panel itself.
 *
 *  ⚠️ Without this the record outlives its subject and clobbers a freshly-read baseline. Measured
 *  path: save an atlas (disk = H1, recorded H1) → `git checkout` moves the file to H2 → edit and
 *  Cmd+S → 409, conflict banner → click "Discard & reload" → the load effect correctly re-seeds
 *  the panel's baseline to H2 → the very next render re-seeds it back to the stale H1 → the human
 *  redoes the edits and gets the identical 409. The escape hatch destroyed their work and did not
 *  resolve the conflict.
 *
 *  ⚠️ **EXPORTED because the discard paths are not the only ones that obsolete it.** A panel that
 *  RE-READS the file has just computed the truth from the bytes; the record is then a claim about
 *  a file that no longer matches it, and the panel's own re-seed would overwrite the fresh read
 *  with the stale record. That path fires with nothing parked and no discard involved — reach it
 *  by `git checkout`ing an atlas the editor has saved this session, then pressing Retry — so it
 *  needs its own call. `AtlasAssetView`'s load effect is the caller. */
export function forgetFlushedAssetHash(path: string): void { lastFlushedHash.delete(path); }
const forgetFlushedHash = forgetFlushedAssetHash;

/** Re-key `lastFlushed` and `lastFlushedHash` when their subject FILE moves — the same "a
 *  record keyed by a path must follow that path" rule `applyMovesToParkedAssets` applies to the
 *  dirty registry, extended to these two, which that function's own loop cannot reach: it walks
 *  `getDirtyAssetPaths()`, so a path with NO parked write (already flushed, panel closed) is
 *  never visited, and its flushed record is stranded under a filename that no longer exists.
 *
 *  `remap(path)` answers per key: `undefined` = untouched, `null` = the file is gone (delete the
 *  entry), a string = the new path (re-key to it). Each map is walked independently — a path can
 *  be a key in one and not the other.
 *
 *  PLAN then apply, same as `applyMovesToParkedAssets`: snapshot each map's ENTRIES (key AND
 *  value) before mutating either one, AND delete every source key before setting any destination
 *  — a chain resolves every move against the ORIGINAL records this way. Neither half alone is
 *  enough for a chained `[A→B, B→C]`: snapshotting keys but reading values live would re-key A→B
 *  first, then read B's slot with a LIVE `.get(path)`, which by then holds A's value, not B's.
 *  Snapshotting entries but deleting-then-setting INTERLEAVED per key is *also* wrong — writing
 *  `B ← A`'s value and only afterwards processing the snapshotted `(B, bValue)` entry deletes the
 *  very value just written, so `B` ends up empty instead of holding `A`'s record. Only "delete
 *  every source first, set every destination after" gets both hops right. Not observed live — no
 *  caller passes a chained move today — but it is the same trap the sibling function guards
 *  against, so it gets the same guarantee. */
export function remapFlushedAssetRecords(remap: (path: string) => string | null | undefined): void {
  remapOneFlushedMap(lastFlushed, remap);
  remapOneFlushedMap(lastFlushedHash, remap);
}

function remapOneFlushedMap<V>(map: Map<string, V>, remap: (path: string) => string | null | undefined): void {
  const planned: Array<{ from: string; to: string | null; value: V }> = [];
  for (const [path, value] of map) {
    const to = remap(path);
    if (to === undefined) continue;
    planned.push({ from: path, to, value });
  }
  for (const { from } of planned) map.delete(from);
  for (const { to, value } of planned) if (to !== null) map.set(to, value);
}

/** The sha256 of what the last flush actually put on disk for `path`, or null if this session has
 *  never written it.
 *
 *  A compare-and-swap panel needs this to survive its own save: its baseline was the text it
 *  LOADED, and after Cmd+S that is no longer what the file holds — so the next park would carry a
 *  baseline the server can never match and every subsequent save would 409 with no way out. The
 *  value comes from the writer's own response rather than being recomputed here, because the bytes
 *  are the server's (`normalizeAssetData`, id preservation, the trailing newline) and a second
 *  copy of that serialisation would drift. */
export function getLastFlushedAssetHash(path: string | undefined): string | null {
  return path ? lastFlushedHash.get(path) ?? null : null;
}

function bump(): void { _version += 1; notifyListeners(listeners, 'dirtyAssets', []); }
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
 *  `origin` defaults to `'agent'` so the agent ops read unchanged; the panels pass `'panel'`.
 *
 *  ⚠️ **An omitted `ifMatch` PRESERVES whatever the superseded entry carried — it does not clear
 *  it.** Omitting the argument means "I do not manage a baseline for this path", which is true of
 *  every caller but `AtlasAssetView`; clearing on their behalf would silently disarm the
 *  compare-and-swap. The concrete path that would do it is `adoptParkedDoc`, which re-parks a
 *  panel's normalized copy of an existing entry and has no baseline of its own to pass. Advancing
 *  a baseline is `flushDirtyAssets`' job (it records what the server actually wrote); this
 *  function only ever carries one forward. */
export function markAssetDirty(
  path: string, type: AssetSchemaType, data: unknown, origin: AssetWriteOrigin = 'agent',
  ifMatch?: string,
): void {
  dirty.set(path, { type, data, origin, ifMatch: ifMatch ?? dirty.get(path)?.ifMatch });
  flushErrors.delete(path); // a fresh edit supersedes the previous flush's failure
  bump();
}

/** Drop the compare-and-swap baseline on `path`'s parked write, so the next flush writes
 *  UNCONDITIONALLY — i.e. deliberately overwrites whatever the file now holds.
 *
 *  The escape hatch a precondition needs, and the reason it is a separate, loudly-named function
 *  rather than `markAssetDirty(..., undefined)`: omitting the argument PRESERVES the baseline (see
 *  `markAssetDirty`), which is right for every incidental re-park and wrong for the one case where
 *  a human has read the banner and chosen to overwrite. Without it a conflicted panel is a dead
 *  end — every save 409s, and the only way out is discarding the human's unsaved work.
 *
 *  ⚠️ Never call this to "fix" a conflict on the caller's own judgement. The CAS exists to stop a
 *  SILENT overwrite; an explicit one is a decision, and the decision is the human's. */
export function clearAssetIfMatch(path: string): boolean {
  const d = dirty.get(path);
  if (!d || d.ifMatch === undefined) return false;
  dirty.set(path, { ...d, ifMatch: undefined });
  flushErrors.delete(path);
  bump();
  return true;
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
): { type: AssetSchemaType; data: unknown; origin: AssetWriteOrigin; ifMatch?: string } | null {
  const d = dirty.get(path);
  return d ? { type: d.type, data: d.data, origin: d.origin, ifMatch: d.ifMatch } : null;
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
  // The panel wrote the file itself, so what THIS module last flushed is no longer what is on
  // disk — see `forgetFlushedHash`.
  forgetFlushedHash(path);
  bump();
  console.warn(
    `[dirtyAssets] ${path} was just written to disk by its editor panel — DISCARDED the older ` +
    'parked write for it. The file is now authoritative; the parked doc would have overwritten it ' +
    'at the next save_all.',
  );
  return true;
}

/** Test-only: drop every pending entry without writing it. */
export function clearDirtyAssets(): void { dirty.clear(); lastFlushed.clear(); lastFlushedHash.clear(); flushErrors.clear(); bump(); }

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
    for (const p of discarded) { flushErrors.delete(p); forgetFlushedHash(p); }
    if (discarded.length) bump();
    return { discarded, notPending: [] };
  }
  const discarded: string[] = [];
  const notPending: string[] = [];
  for (const p of paths) {
    // Report a path that was NOT pending rather than counting it as discarded: "I dropped your
    // edit" and "there was nothing to drop" are different answers, and a typo'd path must not read
    // as the first one.
    if (dirty.delete(p)) { discarded.push(p); flushErrors.delete(p); forgetFlushedHash(p); } else notPending.push(p);
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
  /** path → the exact entry object we wrote, so the cleanup below can tell it apart from one that
   *  superseded it mid-flush. */
  const written = new Map<string, DirtyAsset>();
  /** Recorded per path as the loop runs, then swapped in wholesale below — writing straight into
   *  `flushErrors` here would clear an error for a path this flush never reached. */
  const errorsByPath = new Map<string, { error: string; conflict: boolean }>();
  for (const [path, entry] of dirty) {
    const { type, data, origin, ifMatch } = entry;
    try {
      const res = await backendFetch('/api/asset-write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path, type, data,
          ...(origin === 'panel' ? { replace: true } : {}),
          ...(ifMatch !== undefined ? { ifMatch } : {}),
          selfWrite: true,
        }),
      });
      let body: { ok?: unknown; error?: unknown; errors?: unknown; conflict?: unknown; sha256?: unknown } | null = null;
      try { body = await res.json(); } catch { /* non-JSON body */ }
      const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]).join('; ') : '';
      if (!res.ok || body?.ok === false || errors) {
        const error = errors || (typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
        failed.push({ path, error });
        errorsByPath.set(path, { error, conflict: body?.conflict === true });
        continue;
      }
      saved.push(path);
      written.set(path, entry);
      // The server's own hash of what it wrote — see `getLastFlushedAssetHash`. Absent from an
      // older backend's reply, in which case a CAS panel keeps its previous baseline and its next
      // save conflicts LOUDLY rather than writing against a baseline nobody vouched for.
      if (typeof body?.sha256 === 'string') lastFlushedHash.set(path, body.sha256);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ path, error });
      errorsByPath.set(path, { error, conflict: false });
    }
  }
  for (const [path, entry] of written) {
    // ⚠️ Delete ONLY the entry we actually wrote. Each write above is an `await`, and an edit
    // landing in that window REPLACES the entry — a blind `dirty.delete(path)` then drops the
    // human's newer doc, which is on screen, is not on disk, and no longer counts as unsaved. The
    // window is short (one HTTP round trip) and it is exactly the "keep dragging after Cmd+S" case.
    const current = dirty.get(path);
    if (current === entry) dirty.delete(path);
    else if (current && current.ifMatch !== undefined) {
      // ⚠️ …and that superseding entry's BASELINE is now stale, which is the same case one level
      // down. It captured the hash of the file as it was BEFORE this flush; the flush then wrote
      // our own bytes over it, so the precondition it carries can no longer match and the next
      // save 409s under a banner claiming the file "changed on disk" — when nothing external
      // touched it. Advance it to what the writer says it actually wrote. Only for an entry that
      // HAS a baseline: an entry with none is deliberately unconditional and must stay so.
      const advanced = lastFlushedHash.get(path);
      if (advanced) dirty.set(path, { ...current, ifMatch: advanced });
    }
    // Record what the FILE now holds — `entry.data`, not whatever is parked now, for the same
    // reason. See `lastFlushed`.
    lastFlushed.set(path, entry.data);
  }
  for (const path of saved) flushErrors.delete(path);
  for (const [path, err] of errorsByPath) flushErrors.set(path, err);
  // Bump on a FAILURE too, not just a success: the panel that needs to show "changed on disk"
  // learns about it through this subscription, and a flush where every entry failed used to move
  // nothing at all.
  if (written.size || errorsByPath.size) bump();
  return { saved, failed };
}
