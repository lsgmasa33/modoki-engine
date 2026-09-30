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

/** What a parked entry is: an `ASSET_SCHEMA_TYPES` document, written through `/api/asset-write`, or a prefab (#1868),
 *  written through `commitPrefabWrite` — the one door a `.prefab.json` goes through, which `/api/asset-write` refuses. */
export type DirtyDocType = AssetSchemaType | 'prefab';

interface DirtyAsset {
  type: DirtyDocType;
  data: unknown;
  origin: AssetWriteOrigin;
  /** OPTIONAL compare-and-swap baseline: the sha256 of the file's bytes as the parker last read
   *  them. When set, the flush sends it as `/api/asset-write`'s `ifMatch` precondition and the
   *  write is REFUSED (409) if the file changed underneath in the meantime.
   *
   *  Two setters. An accepted asset-document undo/redo over the FILE sets it to the bytes it checked
   *  (#1710, `assetDocUndo.ts`), so an outside write between the step and Cmd+S is refused, not
   *  overwritten. And `AtlasAssetView` sets it for its own reason (#439): that panel serializes the WHOLE
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
  /** A prefab only: the document the FILE holds (#1868) — the flush's `commitPrefabWrite` precondition, and what a
   *  forward write that read the park is checked against instead ({@link parkedPrefabEntry}). */
  onDisk?: unknown;
  /** A prefab only: the human chose Overwrite over a conflict, so the next flush writes with no precondition. Cleared
   *  when that flush ends, whatever it did: an answer is for the conflict it was asked about, not the next one. */
  overwrite?: boolean;
  /** A prefab only: its file changed on disk while it was parked, and the watcher kept the park (hub call a). `onDisk`
   *  no longer says what the file holds, so a restore never drops this park as "back to the file" — it stays for Save,
   *  whose precondition meets the change and asks (close-out review F2). */
  fileChanged?: boolean;
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

/** The sha256 the route reported for the bytes it wrote with `lastFlushed`'s doc — a pair with it, kept, moved and
 *  cleared with it. **Not `lastFlushedHash`**, which a discard or a panel's own write forgets because a CAS panel must
 *  not re-seed its baseline from it. This one is only ever compared against the file's CURRENT bytes (#1710's asset-doc
 *  undo, `assetDocUndo.ts`), so a record that has gone stale can only fail that comparison — a refusal, never a write
 *  over something newer — and forgetting it on a discard would refuse the ordinary "save, edit, undo, undo" instead. */
const lastFlushedSha = new Map<string, string>();

/** How many flush WRITES of each path have STARTED this session. A baseline read that resolves after this moved
 *  cannot say which side of the write it read, so `captureAssetDocBaseline` drops it (#1710 close-out review): a save
 *  racing the read would otherwise hash the SAVED bytes under the claim "the file holds `before`". Bumped before the
 *  request goes out, so a read the write overtakes is always caught — at worst a read that finished first is dropped
 *  too, which costs a refusal, never a false "holds". */
const writeEpoch = new Map<string, number>();
export function getAssetWriteEpoch(path: string): number { return writeEpoch.get(path) ?? 0; }
/** The `writeEpoch` at which the last flush write of each path that LANDED started. Not `writeEpoch` itself, which a
 *  refused write bumps too: a Save the human cancelled (its 409) is no editor write over an outside change (#1879 close-out
 *  review 3). The START epoch, so a write already in flight when an outside change was held does not count as after it. */
const landedWriteEpoch = new Map<string, number>();

/** The flushes writing each path right now, settled when that FLUSH ends (its bookkeeping included — the park is
 *  dropped and `lastFlushed` recorded only after the whole loop). An asset-doc undo waits on these before reading the
 *  file (#1710 close-out review): a step that read the pre-save bytes while the save was in flight discarded its park
 *  as "the file holds the target", and the save then landed the other doc — editor showing one, disk holding another,
 *  reported clean. */
const writesInFlight = new Map<string, Set<Promise<void>>>();
/** Every flush writing any of `paths` has ended — including one that STARTED while an earlier one was being awaited.
 *  A SET per path, not one promise: two flushes can overlap (an agent `save_all` does not take the Cmd+S latch), and a
 *  single slot let the first flush's settle clear it while the second's write was still in flight (#1710 review 3). */
export async function assetWritesSettled(paths: readonly string[]): Promise<void> {
  for (;;) {
    const pending = paths.flatMap((p) => [...(writesInFlight.get(p) ?? [])]);
    if (!pending.length) return;
    await Promise.all(pending);
  }
}
/** Enter a prefab commit's writes into the in-flight set (#1868 close-out review): a restore waits on
 *  {@link assetWritesSettled} for ANY write of its prefab, not only Save's, or a restore landing mid-write parks against a
 *  file the write is about to change. Returns the release, which the caller runs once its write step has ended. */
export function beginAssetWrites(paths: readonly string[]): () => void {
  let end!: () => void;
  const done = new Promise<void>((r) => { end = r; });
  const sets = paths.map((p) => {
    const set = writesInFlight.get(p) ?? new Set<Promise<void>>();
    set.add(done);
    writesInFlight.set(p, set);
    return { p, set };
  });
  return () => {
    for (const { p, set } of sets) {
      set.delete(done);
      if (!set.size && writesInFlight.get(p) === set) writesInFlight.delete(p);
    }
    end();
  };
}
/** Is a flush writing `path` right now? */
export function assetWriteInFlight(path: string): boolean { return (writesInFlight.get(path)?.size ?? 0) > 0; }

/** Paths whose live cache holds a doc the file does not, with nothing parked: an agent discard drops the pending write
 *  and deliberately KEEPS the applied def live (`discardDirtyAssets`' `cacheKeepsEdit`). While a path is here, the file
 *  is not the doc the panel shows, so an asset-doc baseline taken now would name the file's bytes as the wrong doc
 *  (#1710 close-out review) — `captureAssetDocBaseline` takes none. Cleared when a flush writes the path. */
const cacheDiverged = new Set<string>();
export function assetCacheDiverged(path: string): boolean { return cacheDiverged.has(path); }
/** The live cache for `path` now agrees with the file again — it was reloaded from disk (the watcher), or the file was
 *  written from it. Ends a divergence `discardDirtyAssets`' `cacheKeepsEdit` began. */
export function assetCacheMatchesFile(path: string): void { cacheDiverged.delete(path); }

/** What the last flush of `path` wrote — the doc and the route's hash of its bytes — or null if this session has never
 *  written it or the route did not report a hash. Whether the file STILL holds it is the caller's to check. */
export function getLastFlushedWrite(path: string): { data: unknown; sha256: string } | null {
  const sha256 = lastFlushedSha.get(path);
  return sha256 !== undefined && lastFlushed.has(path) ? { data: lastFlushed.get(path), sha256 } : null;
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
  remapOneFlushedMap(lastFlushedSha, remap);
  // The divergence flag names a FILE too: left on the old path it would miss the moved asset (a baseline taken there
  // names the file's bytes as the cache's doc) and wrongly bind whatever is created at the old path next.
  const moved = new Map([...cacheDiverged].map((p) => [p, true] as const));
  remapOneFlushedMap(moved, remap);
  cacheDiverged.clear();
  for (const p of moved.keys()) cacheDiverged.add(p);
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
  // A park of a file whose outside change is held and still on disk starts conflicted (#1879 close-out review 2).
  const baseline = ifMatch ?? dirty.get(path)?.ifMatch ?? (outsideChangeStands(path) ? CHANGED_OUTSIDE_BASELINE : undefined);
  dirty.set(path, { type, data, origin, ifMatch: baseline });
  flushErrors.delete(path); // a fresh edit supersedes the previous flush's failure
  bump();
}

/** Park a PREFAB document (#1868): an undone Apply, Replace or rig-prefab update restores it in memory, and Cmd+S writes
 *  it. `onDisk` is the document the file holds now; a re-park of a path already parked KEEPS the baseline it carries,
 *  since the file has not changed in between (the same rule `markAssetDirty` applies to `ifMatch`). The caller has
 *  already seated the document in both caches — this only records that the file does not hold it. */
export function parkPrefab(path: string, doc: unknown, onDisk: unknown): void {
  const prior = dirty.get(path);
  const kept = prior?.type === 'prefab';
  dirty.set(path, {
    type: 'prefab', data: doc, origin: 'panel', onDisk: kept ? prior.onDisk : onDisk,
    ...(kept && prior.fileChanged ? { fileChanged: true } : {}),
  });
  flushErrors.delete(path);
  bump();
}

/** The parked prefab document for `path`, or undefined — what every prefab READ takes over the file (#1868, hub call c):
 *  a scene load, the editor cache's cold read, the prefab-edit open and a placement. Otherwise Apply and Revert would
 *  compute against the file while Save writes the park. */
export function parkedPrefab(path: string | undefined): unknown {
  const d = path ? dirty.get(path) : undefined;
  return d?.type === 'prefab' ? d.data : undefined;
}

/** The parked prefab at `path` with the document its file holds, or null (#1868). For a write over it
 *  (`commitPrefabWrites`): a writer that read the PARK names a document the file does not hold, so it is checked against
 *  `onDisk` instead. `landed()` is called once ANY write of the path lands, whatever it was checked against: the file and
 *  both caches now hold the written document, so this park is retired. A writer that read the file (a model re-import,
 *  the agent's `create`) used to leave the park behind, and every later read took it over the document just written
 *  (close-out review F3). The park is retired while it still holds the document captured here — the same entry, or the
 *  same document re-flagged since (Overwrite, the watcher's keeper). A DIFFERENT document parked meanwhile is left as it
 *  is, baseline and all, so Save conflicts and asks: re-baselining it onto the write made that Save a silent overwrite
 *  (close-out re-review). A restore cannot park meanwhile — it waits on the write (`beginAssetWrites`). `fileChanged`
 *  says the watcher kept the park over an outside change (see `DirtyAsset.fileChanged`). */
export function parkedPrefabEntry(path: string): { doc: unknown; onDisk: unknown; fileChanged: boolean; landed: () => void } | null {
  const d = dirty.get(path);
  if (d?.type !== 'prefab') return null;
  return {
    doc: d.data,
    onDisk: d.onDisk,
    fileChanged: !!d.fileChanged,
    landed: () => {
      const now = dirty.get(path);
      if (now?.type !== 'prefab' || now.data !== d.data) return;
      dirty.delete(path);
      flushErrors.delete(path);
      bump();
    },
  };
}

/** The watcher saw `path` change on disk and KEPT its park (hub call a): mark the park's baseline as no longer the file's
 *  (see `DirtyAsset.fileChanged`). True when a prefab is parked there — the watcher then leaves the file alone. */
export function keepParkedPrefabOverFileChange(path: string): boolean {
  const d = dirty.get(path);
  if (d?.type !== 'prefab') return false;
  if (!d.fileChanged) { dirty.set(path, { ...d, fileChanged: true }); bump(); }
  return true;
}

/** Re-park `entry` (from {@link peekDirtyAsset}) under `path` whole — every field, the prefab baseline included. The
 *  Assets move repair's re-park: a rename does not change the bytes, so what the entry says about the file still holds. */
export function reparkDirtyAsset(path: string, entry: NonNullable<ReturnType<typeof peekDirtyAsset>>): void {
  dirty.set(path, { ...entry });
  flushErrors.delete(path);
  bump();
}

/** The human read a conflict and chose Overwrite: the next flush of `path` writes whatever the file holds now. An asset
 *  document drops its `ifMatch` ({@link clearAssetIfMatch}); a prefab writes with `commitPrefabWrite`'s `overwrite`.
 *  False when nothing is parked there. The same warning as `clearAssetIfMatch`: the human's decision, never the code's. */
export function overwriteParkedAsset(path: string): boolean {
  const d = dirty.get(path);
  if (!d) return false;
  if (d.type !== 'prefab') { clearAssetIfMatch(path); return true; }
  dirty.set(path, { ...d, overwrite: true });
  flushErrors.delete(path);
  bump();
  return true;
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

/** A baseline no file's sha256 can equal: the file under this park changed OUTSIDE the editor. */
export const CHANGED_OUTSIDE_BASELINE = 'changed-outside-the-editor';

/** Outside changes to asset files the watcher HOLDS until a focus gain or `modoki_refresh` (#1879), each with the
 *  editor's write count (`writeEpoch`) for that path when it was held. The park and the held change must not meet
 *  silently in either direction (#1879 close-out reviews):
 *  - a Save before the release must not write a park over the outside change — so a park of a held path, made before
 *    the hold or after it, gets a baseline no file matches, and Cmd+S asks Overwrite or Cancel;
 *  - once the editor HAS written the file since (the human chose Overwrite), the outside change is gone from disk, and the
 *    release must apply nothing — dropping the park then threw away edits made after that save. */
const heldOutside = new Map<string, number>();

/** The watcher holds an outside change of `path` (a newer one restarts its count). Marks a park already there. */
export function noteOutsideChangeHeld(path: string): boolean {
  heldOutside.set(path, getAssetWriteEpoch(path));
  const d = dirty.get(path);
  if (!d || d.type === 'prefab') return false;
  dirty.set(path, { ...d, ifMatch: CHANGED_OUTSIDE_BASELINE });
  bump();
  return true;
}

/** Has a write of the editor LANDED on `path` since its outside change was held (a refused Save does not count)? Then
 *  that change is no longer on disk. */
export function outsideChangeSuperseded(path: string): boolean {
  const at = heldOutside.get(path);
  return at !== undefined && (landedWriteEpoch.get(path) ?? 0) > at;
}

/** The release applied (or skipped) `path`'s held change: parks made from now on are ordinary. */
export function endOutsideChangeHold(path: string): void { heldOutside.delete(path); }

/** Is an outside change of `path` held and still on disk? A park made now must not be written over it unasked. */
function outsideChangeStands(path: string): boolean {
  return heldOutside.has(path) && !outsideChangeSuperseded(path);
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
): { type: DirtyDocType; data: unknown; origin: AssetWriteOrigin; ifMatch?: string; onDisk?: unknown; overwrite?: boolean; fileChanged?: boolean } | null {
  const d = dirty.get(path);
  return d ? { ...d } : null;
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
  cacheDiverged.delete(path); // the file was just written from the editor's own doc
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
export function clearDirtyAssets(): void { heldOutside.clear(); landedWriteEpoch.clear(); dirty.clear(); cacheDiverged.clear(); lastFlushed.clear(); lastFlushedSha.clear(); lastFlushedHash.clear(); flushErrors.clear(); bump(); }

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
export function discardDirtyAssets(
  paths?: readonly string[],
  /** The caller leaves the live cache on the discarded edit (the agent `discard-asset-edits` op, by design) rather
   *  than moving it back to the file — see `assetCacheDiverged`. A panel's own discard, an undo back to the file's
   *  doc and a Discard & reload all leave cache and file agreeing, and do not pass it. */
  opts?: { cacheKeepsEdit?: boolean },
): { discarded: string[]; notPending: string[] } {
  // Without the flag the caller says cache and file AGREE after this (an undo back to the file's doc, a Discard & reload,
  // the watcher's reload, a panel back at its saved doc) — which ends any divergence an earlier agent discard began.
  const diverge = (ps: readonly string[]) => { for (const p of ps) { if (opts?.cacheKeepsEdit) cacheDiverged.add(p); else cacheDiverged.delete(p); } };
  if (!paths) {
    const discarded = [...dirty.keys()];
    diverge(discarded);
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
  diverge(opts?.cacheKeepsEdit ? discarded : paths);
  if (discarded.length) bump();
  return { discarded, notPending };
}

export interface FlushResult {
  /** Paths written successfully (and removed from the registry). */
  saved: string[];
  /** Paths that failed to write (LEFT in the registry — still pending, still reported by
   *  `hasUnsavedChanges()`/`get_editor_state`, so a failed flush is never silently dropped). */
  failed: Array<{ path: string; error: string; conflict?: boolean }>;
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
  const failed: FlushResult['failed'] = [];
  /** path → the exact entry object we wrote, so the cleanup below can tell it apart from one that
   *  superseded it mid-flush. */
  const written = new Map<string, DirtyAsset>();
  /** path → the route's hash of what it wrote, paired with `lastFlushed` below (`lastFlushedSha`). */
  const writtenSha = new Map<string, string>();
  // ONE promise for this flush, entered in the in-flight set of every path it writes and settled when it ends.
  let flushEnded!: () => void;
  const thisFlush = new Promise<void>((r) => { flushEnded = r; });
  const writing: Array<{ path: string; set: Set<Promise<void>> }> = [];
  try {
    /** Recorded per path as the loop runs, then swapped in wholesale below — writing straight into
     *  `flushErrors` here would clear an error for a path this flush never reached. */
    const errorsByPath = new Map<string, { error: string; conflict: boolean }>();
    for (const [path, entry] of dirty) {
      const { type, data, origin, ifMatch } = entry;
      writeEpoch.set(path, getAssetWriteEpoch(path) + 1);
      const startedAt = getAssetWriteEpoch(path);
      const set = writesInFlight.get(path) ?? new Set<Promise<void>>();
      set.add(thisFlush);
      writesInFlight.set(path, set);
      writing.push({ path, set });
      if (entry.type === 'prefab') {
        const landed = await flushPrefab(path, entry);
        // An Overwrite answers the conflict it was asked about, not the next one (close-out review F6).
        // Only when this flush wrote WITH it (close-out re-review): an answer given while another flush was writing is
        // that other flush's to use.
        const now = dirty.get(path);
        if (entry.overwrite && now?.type === 'prefab' && now.overwrite) dirty.set(path, { ...now, overwrite: undefined });
        if (landed.ok) { saved.push(path); written.set(path, entry); landedWriteEpoch.set(path, startedAt); continue; }
        failed.push({ path, error: landed.error, ...(landed.conflict ? { conflict: true } : {}) });
        errorsByPath.set(path, { error: landed.error, conflict: landed.conflict });
        continue;
      }
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
          failed.push({ path, error, ...(body?.conflict === true ? { conflict: true } : {}) });
          errorsByPath.set(path, { error, conflict: body?.conflict === true });
          continue;
        }
        saved.push(path);
        written.set(path, entry);
        landedWriteEpoch.set(path, startedAt);
        // The server's own hash of what it wrote — see `getLastFlushedAssetHash`. Absent from an
        // older backend's reply, in which case a CAS panel keeps its previous baseline and its next
        // save conflicts LOUDLY rather than writing against a baseline nobody vouched for.
        if (typeof body?.sha256 === 'string') { lastFlushedHash.set(path, body.sha256); writtenSha.set(path, body.sha256); }
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
      const sha = writtenSha.get(path);
      if (sha !== undefined) lastFlushedSha.set(path, sha); else lastFlushedSha.delete(path);
      cacheDiverged.delete(path); // the file now holds a doc the editor wrote from its own state
    }
    for (const path of saved) flushErrors.delete(path);
    for (const [path, err] of errorsByPath) flushErrors.set(path, err);
    // Bump on a FAILURE too, not just a success: the panel that needs to show "changed on disk"
    // learns about it through this subscription, and a flush where every entry failed used to move
    // nothing at all.
    if (written.size || errorsByPath.size) bump();
    return { saved, failed };
  } finally {
    for (const { path, set } of writing) {
      set.delete(thisFlush);
      if (!set.size && writesInFlight.get(path) === set) writesInFlight.delete(path);
    }
    flushEnded();
  }
}

/** One parked prefab, written through `commitPrefabWrite` over the document the file held when it was parked — or over
 *  anything, after the human chose Overwrite. The document itself goes down: the caches and the live frames already hold
 *  it, so the commit's re-seat and rebase find nothing to change. Imported dynamically: `prefabCommit` reaches the whole
 *  prefab graph, which this module must not load. */
async function flushPrefab(path: string, entry: DirtyAsset): Promise<{ ok: true } | { ok: false; error: string; conflict: boolean }> {
  try {
    const { commitPrefabWrite } = await import('./prefabCommit');
    const res = await commitPrefabWrite(path, entry.data as Parameters<typeof commitPrefabWrite>[1], {
      expected: entry.onDisk as Parameters<typeof commitPrefabWrite>[2]['expected'],
      ...(entry.overwrite ? { overwrite: true } : {}),
    });
    // Written, even when the world was replaced meanwhile (`worldLeft` with `ok`): the caches hold it, and the file does.
    if (res.ok) return { ok: true };
    if (res.conflict) return { ok: false, conflict: true, error: `${path} changed on disk since its unsaved edit was made, so it was not overwritten` };
    return { ok: false, conflict: false, error: res.error ?? `${path} could not be written` };
  } catch (e) {
    return { ok: false, conflict: false, error: e instanceof Error ? e.message : String(e) };
  }
}
