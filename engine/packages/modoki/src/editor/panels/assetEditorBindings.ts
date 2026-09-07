/** Keep an asset editor's binding in step when its file MOVES or disappears (#186).
 *
 *  Five panels hold a live binding to the asset they are editing — Particle, SpriteAnim,
 *  Skin, Animation, Timeline — and the binding is a PATH. Each also PARKS its document under
 *  that path (`scene/dirtyAssets.ts`), to be written by the next Cmd+S, so any operation that
 *  changes where the file lives, without telling the panel, makes the next save write to the OLD
 *  location:
 *
 *  - **Delete** → the file you just moved to the trash comes BACK on the next edit.
 *  - **Rename / move** → worse: the asset FORKS. Measured on `games/timeline-demo` — after
 *    renaming a bound timeline, the next edit re-created the old file carrying the new
 *    content (duration 7) while the renamed file kept the old (duration 2). Your edits go
 *    to a zombie and the asset you renamed silently stops receiving them.
 *
 *  Neither fails; a file simply appears, so nothing reports it. The Assets panel already
 *  fixes its own SELECTION at every one of these sites — this is the same repair one layer
 *  down, and the reason it is a shared module rather than five inline blocks is that the
 *  first version of this fix covered `executeDeletion` alone and missed the other four.
 *
 *  ⚠️ **The BINDING is only half of it now (#259).** While the panels autosaved, closing the
 *  panel ended the story: nothing else held the path. Now the panel parks its document in the
 *  dirty-asset registry, which outlives the binding — so unbinding a deleted asset leaves a parked
 *  write that the next Cmd+S turns straight back into the file you deleted, and repointing a moved
 *  one leaves the old path parked, which forks the asset exactly as #186 measured. Worse, the
 *  registry keeps an entry for an asset whose panel was CLOSED, where there is no binding to
 *  repair at all. So the moves are applied to the registry independently of the bindings — see
 *  `applyMovesToParkedAssets`.
 *
 *  Paths are compared exactly (or by path-segment prefix for a folder). Both sides
 *  originate from the same `AssetEntry.path` — the Assets panel moves by it, and
 *  `openAssetInEditor` binds by it — so there is no normalization to get wrong; if that
 *  ever stops being true this needs a shared canonicalizer, not a looser match here. */

import { useEditorStore } from '../store/editorStore';
import {
  getDirtyAssetPaths, peekDirtyAsset, markAssetDirty, discardDirtyAssets, remapFlushedAssetRecords,
} from '../scene/dirtyAssets';
import {
  getPendingMetaPaths, peekPendingMeta, parkMetaEdit, discardPendingMeta, peekMetaBaseline,
} from '../scene/pendingMeta';
import { applyMove, type PathMove } from '../utils/assetPaths';
import { remapCurrentFolder } from './assetFolderState';

/** One editor's binding: the store field naming its asset, and the action that clears it. */
export interface AssetEditorBinding {
  /** Human-readable, for the console line — none of this should happen silently. */
  readonly label: string;
  readonly assetField: 'editingParticleAsset' | 'editingSpriteAnimAsset' | 'editingSkinAsset'
    | 'editingAnimationAsset' | 'editingTimelineAsset';
  readonly close: 'closeParticleEditor' | 'closeSpriteAnimEditor' | 'closeSkinEditor'
    | 'closeAnimationEditor' | 'closeTimelineEditor';
}

/** Every asset editor that binds to a file. Adding a sixth means adding it HERE — a new
 *  editor that forgets this line resurrects deleted assets exactly like the first five did. */
export const ASSET_EDITOR_BINDINGS: readonly AssetEditorBinding[] = [
  { label: 'particle', assetField: 'editingParticleAsset', close: 'closeParticleEditor' },
  { label: 'sprite animation', assetField: 'editingSpriteAnimAsset', close: 'closeSpriteAnimEditor' },
  { label: 'skin', assetField: 'editingSkinAsset', close: 'closeSkinEditor' },
  { label: 'animation', assetField: 'editingAnimationAsset', close: 'closeAnimationEditor' },
  { label: 'timeline', assetField: 'editingTimelineAsset', close: 'closeTimelineEditor' },
];

export interface BindingChange<T> { readonly binding: T; readonly to: string | null; readonly name?: string }

/** PURE core: how each bound editor is affected by `moves`. Exported for tests — the
 *  impure wrapper below is a thin store read + dispatch. First matching move wins. */
export function resolveBindingMoves<T extends { readonly label: string }>(
  bound: ReadonlyArray<T & { readonly path: string | null | undefined }>,
  moves: Iterable<PathMove>,
): BindingChange<T>[] {
  const list = [...moves];
  const out: BindingChange<T>[] = [];
  for (const b of bound) {
    // An UNBOUND editor (path null) is skipped before `applyMove` ever sees it. Not
    // defensive tidiness: the prefix branch calls `path.startsWith`, so ANY folder
    // rename/delete would THROW here whenever one of the five editors is closed — which is
    // almost always. (A mutation test caught this being under-specified: dropping the guard
    // leaves the exact-path cases passing and kills only the folder ones.)
    if (b.path == null) continue;
    for (const m of list) {
      const to = applyMove(b.path, m);
      if (to === undefined) continue;      // this move doesn't touch this binding
      if (to === b.path) break;            // moved onto itself — nothing to do
      out.push({ binding: b, to, name: m.name });
      break;
    }
  }
  return out;
}

/** Apply `moves` to the PARKED WRITES in the dirty-asset registry, which are keyed by path and
 *  outlive both the panel binding and the panel itself.
 *
 *  A moved asset keeps its parked doc — it is the same asset at a new location, and silently
 *  dropping a human's unsaved edits because they renamed the file would be its own bug. A DELETED
 *  asset loses it: the file is gone, and a parked write for it is a resurrection waiting for the
 *  next save. That discard is reported (never silent) for the same reason `discardDirtyAssets`
 *  and `dropParkedWriteFor` are — it destroys pending work.
 *
 *  Exported for tests; `applyAssetPathMoves` is the only production caller. */
export function applyMovesToParkedAssets(moves: Iterable<PathMove>): string[] {
  const list = [...moves];
  // PLAN, then apply — the same two-phase shape as `resolveBindingMoves` above, and for a reason
  // that is not stylistic: applying in-loop writes the moved doc back into the registry, so a
  // LATER iteration can pick it up as though it were that path's own. Concretely, with docs parked
  // for /a and /b and moves [a→b, b→c]: /a moves onto /b, then /b (still in the snapshot) moves
  // what is now A's doc on to /c — A lands at /c and B's edit is gone. No caller passes a chained
  // move today, so this is a trap rather than a live bug; resolving first makes it unreachable.
  const planned: { from: string; to: string | null; doc: ReturnType<typeof peekDirtyAsset> }[] = [];
  for (const path of getDirtyAssetPaths()) {
    for (const m of list) {
      const to = applyMove(path, m);
      if (to === undefined) continue;   // this move does not touch this path — try the next
      if (to !== path) planned.push({ from: path, to, doc: peekDirtyAsset(path) });
      break;                            // first matching move wins, as it does for bindings
    }
  }
  const notes: string[] = [];
  // Remap the flushed-record maps BEFORE discarding, using the same list of moves and the same
  // "first matching move wins" rule as the loop above. `discardDirtyAssets` below calls
  // `forgetFlushedHash(from)` — correct when an edit is being DISCARDED, wrong when the file is
  // merely MOVING. Remapping first means the record has already left `from`, so that call
  // becomes a harmless no-op and the record survives at `to`.
  remapFlushedAssetRecords((path) => {
    for (const m of list) {
      const to = applyMove(path, m);
      if (to === undefined) continue;
      return to;
    }
    return undefined;
  });
  // Drop every source path FIRST, so a rename onto a path that is itself parked cannot be
  // undone by its own discard landing after the new entry.
  for (const { from } of planned) discardDirtyAssets([from]);
  for (const { from, to, doc } of planned) {
    if (to === null) {
      notes.push(`dropped the unsaved edit parked for ${from} (its asset was deleted)`);
    } else if (doc) {
      // Carry the CAS baseline (ifMatch) across too — this is the only cross-path re-park in the
      // tree, so "omitted ifMatch preserves what's parked at the destination" (markAssetDirty's
      // rule for same-path re-parks) is the wrong default here. A rename doesn't change bytes
      // (renameSync), so the sha256 captured at `from` still describes the file at `to`.
      markAssetDirty(to, doc.type, doc.data, doc.origin, doc.ifMatch);
      notes.push(`moved the unsaved edit parked for ${from} → ${to}`);
    }
  }
  notes.push(...applyMovesToParkedMeta(list));
  return notes;
}

/** The same rule for PARKED IMPORT SETTINGS (`.meta.json`, #845) — a move carries the edit, a
 *  delete drops it.
 *
 *  ⚠️ This is not a nicety, it is a regression this range would otherwise ship. Before parking,
 *  every `.meta.json` edit wrote immediately, so no pending edit could outlive its path. Now one
 *  can, and `pendingMeta` is keyed by ASSET PATH with nothing migrating those keys:
 *
 *   - **Delete** `foo.png` with a parked Max Size change → the next Cmd+S POSTs `/api/write-meta`
 *     for a path with no asset. `resolveAssetPath` is a roots/traversal guard with no existence
 *     check and `assertSidecarWritable` only checks the format version, so the write SUCCEEDS and
 *     recreates a committed `foo.png.meta.json` beside a file that no longer exists — a
 *     resurrection, exactly as the sibling's docblock above describes for asset docs.
 *   - **Rename** `foo.png`→`bar.png` → the park stays keyed to `foo.png`: an orphan sidecar is
 *     written AND `bar.png` never receives the edit.
 *
 *  Folded into `applyMovesToParkedAssets` rather than given its own call site, because the two
 *  registries must move together — a caller that remembered one and forgot the other is precisely
 *  how this gap appeared.
 *
 *  ⚠️ **The CAS baseline is CARRIED, not dropped** — and an earlier version of this comment argued
 *  the opposite ("the first write at the new path is unconditional-but-informed"). `#854` settled
 *  it for the sibling registry on the same day and the reasoning transfers exactly: at a new key,
 *  *"preserve what is here"* and *"carry what came from there"* are different answers, and dropping
 *  the baseline turns the compare-and-swap OFF for the rest of the session — precisely the
 *  git-checkout hazard it exists for, on a path the human just renamed and is therefore actively
 *  working on. A rename moves the sidecar's BYTES unchanged, so the old baseline is still a true
 *  statement about the file at its new name; there is nothing to re-derive and no reason to
 *  distrust it. See `remapFlushedAssetRecords` in `dirtyAssets.ts` for the sibling's version.
 *
 *  Exported for tests. */
export function applyMovesToParkedMeta(moves: Iterable<PathMove>): string[] {
  const list = [...moves];
  // PLAN then apply, for the same chained-move reason spelled out in the sibling above.
  const planned: { from: string; to: string | null; doc: unknown }[] = [];
  for (const path of getPendingMetaPaths()) {
    for (const m of list) {
      const to = applyMove(path, m);
      if (to === undefined) continue;
      if (to !== path) planned.push({ from: path, to, doc: peekPendingMeta(path) });
      break;
    }
  }
  // Read the baselines BEFORE any discard — `discardPendingMeta` clears them with the park, which
  // is right when an edit is genuinely abandoned and wrong here, where the entry is moving.
  const carried = new Map<string, string | undefined>();
  for (const { from } of planned) carried.set(from, peekMetaBaseline(from));
  const notes: string[] = [];
  for (const { from } of planned) discardPendingMeta([from]);
  for (const { from, to, doc } of planned) {
    if (to === null) {
      notes.push(`dropped the unsaved import-settings edit parked for ${from} (its asset was deleted)`);
    } else if (doc !== undefined) {
      parkMetaEdit(to, doc, carried.get(from));
      notes.push(`moved the unsaved import-settings edit parked for ${from} → ${to}`);
    }
  }
  return notes;
}

/** Apply `moves` to every asset editor binding: unbind the ones whose asset is gone, repoint
 *  the ones whose asset moved — AND repair the parked writes, which the binding does not cover
 *  (see `applyMovesToParkedAssets`). Returns a short description per change (empty in the
 *  overwhelmingly common case where nothing bound or parked was touched). */
export function applyAssetPathMoves(moves: Iterable<PathMove>): string[] {
  const state = useEditorStore.getState();
  const bound = ASSET_EDITOR_BINDINGS.map((b) => ({ ...b, path: state[b.assetField]?.path }));
  const changes = resolveBindingMoves(bound, moves);
  const notes: string[] = [];
  for (const c of changes) {
    const store = useEditorStore.getState();
    if (c.to === null) {
      store[c.binding.close]();
      notes.push(`closed the ${c.binding.label} editor (its asset was deleted)`);
    } else {
      store.remapEditingAssetPath(c.binding.assetField, c.to, c.name);
      notes.push(`repointed the ${c.binding.label} editor to ${c.to}`);
    }
  }
  // Independently of the bindings: a parked write can belong to an asset whose panel is CLOSED.
  notes.push(...applyMovesToParkedAssets(moves));
  // Independently of BOTH of the above: the Assets panel's own "current folder" is also
  // path-keyed state that must follow a move, and wiring it per call site is exactly the
  // mistake this module's header already names — "the first version of this fix covered
  // `executeDeletion` alone and missed the other four" — a third time, this time for
  // `currentFolder` instead of a binding. `remapCurrentFolder` is a no-op unless `currentFolder`
  // IS `from` or sits under it, so this is harmless for the overwhelming majority of moves
  // (single-asset renames/cuts/deletes) where `currentFolder` names an unrelated folder.
  for (const m of moves) remapCurrentFolder(m.from, m.to);
  return notes;
}

/** Convenience for the delete sites: every path in `deletedPaths` is gone. */
export function unbindDeletedAssetEditors(deletedPaths: Iterable<string>): string[] {
  return applyAssetPathMoves([...deletedPaths].map((from) => ({ from, to: null })));
}
