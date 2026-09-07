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
 *  Neither fails; a file simply appears, so nothing reports it. The reason this is a shared
 *  module rather than five inline blocks is that the first version of this fix covered
 *  `executeDeletion` alone and missed the other four.
 *
 *  ⚠️ **This header used to claim "the Assets panel already fixes its own SELECTION at every one
 *  of these sites".** It did not — exactly ONE of thirteen move sites repaired the selection
 *  (`handleRename`), and `assetUndo.ts` had zero selection references at all. That claim was the
 *  reason selection stayed out of this module for so long, so it is corrected rather than
 *  deleted: the repair is now `applyMovesToSelection`, below, inside the seam (#867).
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

import { useEditorStore, type SelectedAsset } from '../store/editorStore';
import {
  getDirtyAssetPaths, peekDirtyAsset, markAssetDirty, discardDirtyAssets, remapFlushedAssetRecords,
} from '../scene/dirtyAssets';
import {
  getPendingMetaPaths, peekPendingMeta, parkMetaEdit, discardPendingMeta, peekMetaBaseline,
} from '../scene/pendingMeta';
import { applyMove, splitAssetPath, type PathMove } from '../utils/assetPaths';
import { remapCurrentFolder, remapFolderSets } from './assetFolderState';

/** The display name a repaired item should carry after `move`.
 *
 *  ⚠️ **A repair must not invent a name.** Three formats are already in play for this field: the
 *  manifest's display name (`AssetEntry.name`, e.g. `Cutscene.Timeline`) when you click an asset,
 *  and the bare STEM (`planRename`'s `base` — `toPath = dir/base + ext`, so `run`, not
 *  `run.spriteanim.json`) when you rename one. A first cut of #867's selection repair derived the
 *  basename-with-extension, which is a THIRD format and matches neither.
 *
 *  The rule that is right in every case: **a move only changes the name when it renamed this exact
 *  path.** A relocation — a drag into a folder, a cut/paste, a folder move — leaves every basename
 *  untouched, so the existing name is already correct and must be kept.
 *
 *  `m.name` is preferred when the move supplies one, but ONLY on an exact match: for a `prefix`
 *  move `m.name` is the FOLDER's new name, and applying it to a child would rename every file in a
 *  moved folder to the folder's name. When no name is supplied and the basename genuinely changed
 *  — which is what an agent rename through `/api/move-file` looks like, since the route has no
 *  display-name convention to send — the stem is derived from the DESTINATION.
 *
 *  ⚠️ That derivation is *not* identical to `planRename`'s `base`, and an earlier draft of this
 *  comment claimed it was. `planRename` splits the extension off the SOURCE and reuses it
 *  (`toPath = dir + base + ext`); this splits the DESTINATION. They diverge when a rename crosses a
 *  compound-extension boundary: renaming `index.json` to `level.court` gives
 *  `planRename.base = 'level.court'` and `toPath = …/level.court.json`, while `splitAssetPath` sees
 *  the compound `.court.json` and returns `'level'`. Cosmetic — one rename can show `level.court`
 *  in the Inspector and `level` in a panel header — and only reachable on the panel path, where
 *  `m.name` wins anyway. Recorded rather than fixed: matching `planRename` needs the SOURCE
 *  extension, which a repair applied to an arbitrary path does not have.
 *
 *  Returns `undefined` for "keep the name you already have" — which is what
 *  `remapEditingAssetPath`'s own `name ?? cur.name` already means, so the binding path needs no
 *  current-name argument it does not have. */
export function repairedName(from: string, to: string, move: PathMove): string | undefined {
  // Only an EXACT match may take the move's own name; on a `prefix` move it belongs to the folder.
  if (from === move.from && move.name != null) return move.name;
  const fromBase = from.slice(from.lastIndexOf('/') + 1);
  const toBase = to.slice(to.lastIndexOf('/') + 1);
  if (fromBase === toBase) return undefined;  // relocated, not renamed — the name still fits
  return splitAssetPath(to).base;
}

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
      // NOT `m.name`: the route's repair (#867) carries no name, and `remapEditingAssetPath`'s
      // `name ?? cur.name` then kept the OLD one — so renaming a bound asset through the panel
      // left the editor's header showing the previous filename, because the route's repair ran
      // first and the panel's own name-carrying call then found the binding already moved.
      out.push({ binding: b, to, name: to === null ? undefined : repairedName(b.path, to, m) });
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
 *  ⚠️ **This repair is reached ONLY through `applyAssetPathMoves`, whose every caller is a
 *  client-side panel or undo site — so it does NOT cover an agent move or a dragged folder (#867).**
 *  `modoki_move_asset` POSTs `/api/move-file` out-of-process and nothing else, and a folder drag
 *  drops `isFolder` so no prefix move is built; either way a parked import-settings edit is
 *  stranded under the old path and the next Cmd+S recreates an orphan sidecar beside a file that no
 *  longer exists (`resolveAssetPath` is a roots/traversal guard with NO existence check). The same
 *  gap the atlas CAS has, which is why #867 is a CLASS issue about wiring the repair to the MOVE
 *  rather than to its call sites. Deliberately not fixed here: that is a seam change, #867 is
 *  claimed by another clone, and it has been told this registry is a second member. Being folded
 *  into `applyMovesToParkedAssets` is what keeps the two fixable in one place when it lands.
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

/** Apply `moves` to the ASSET SELECTION — the Inspector's lead asset and the multi-select set.
 *
 *  Both are path-keyed, and until #867 exactly ONE of the move sites repaired them: `handleRename`
 *  (`Assets.tsx`). `pasteClipboard`'s cut branch, `handleFilesDrop` and every one of `assetUndo.ts`'s
 *  eight seam calls left the Inspector aimed at a path the file had left — and nothing self-heals,
 *  because the panel's sync effect reacts to the STORE clearing the selection, never to the selected
 *  path vanishing from a refreshed listing.
 *
 *  Concretely, with an atlas selected: drag it to another folder, click "+ Add member", and the edit
 *  parks at the dead path with a stale CAS baseline; the next Cmd+S 409s, and the only forward exit
 *  — Overwrite — recreates the file where it used to be. That is #186's fork, reached through the
 *  selection instead of through a binding.
 *
 *  Repairing the STORE is enough for the panel too: `Assets.tsx`'s store→local effect already
 *  repoints its own `selected` whenever `selectedAsset.path` differs from it.
 *
 *  Exported for tests; `applyAssetPathMoves` is the only production caller. */
export function applyMovesToSelection(moves: Iterable<PathMove>): string[] {
  const list = [...moves];
  const state = useEditorStore.getState();
  const { selectedAsset, selectedAssets } = state;
  if (!selectedAsset && selectedAssets.length === 0) return [];

  /** `undefined` = untouched, `null` = its file is gone, otherwise the repointed asset. */
  const move = (a: SelectedAsset): SelectedAsset | null | undefined => {
    for (const m of list) {
      const to = applyMove(a.path, m);
      if (to === undefined) continue;   // this move does not touch this asset
      if (to === a.path) return undefined; // moved onto itself
      if (to === null) return null;
      return { ...a, path: to, name: repairedName(a.path, to, m) ?? a.name };
    }
    return undefined;
  };

  const notes: string[] = [];
  const nextLead = selectedAsset ? move(selectedAsset) : undefined;
  const nextList: SelectedAsset[] = [];
  let listChanged = false;
  for (const a of selectedAssets) {
    const r = move(a);
    if (r === undefined) { nextList.push(a); continue; }
    listChanged = true;
    if (r !== null) nextList.push(r);
  }
  if (nextLead === undefined && !listChanged) return notes;

  const lead = nextLead === undefined ? selectedAsset : nextLead;
  if (nextLead === null) notes.push(`cleared the Inspector selection (${selectedAsset!.path} was deleted)`);
  else if (nextLead) notes.push(`repointed the Inspector selection to ${nextLead.path}`);
  useEditorStore.getState().remapSelectedAssets({ selectedAsset: lead, selectedAssets: nextList });
  return notes;
}

/** Apply `moves` to every asset editor binding: unbind the ones whose asset is gone, repoint
 *  the ones whose asset moved — AND repair the parked writes, which the binding does not cover
 *  (see `applyMovesToParkedAssets`). Returns a short description per change (empty in the
 *  overwhelmingly common case where nothing bound or parked was touched). */
export function applyAssetPathMoves(moves: Iterable<PathMove>): string[] {
  // `moves` is an Iterable and is consumed THREE times below (bindings, parked registries,
  // the current-folder remap). A generator would be empty by the second read, silently
  // skipping two of the three repairs. Every caller passes an array today, so this is a trap
  // rather than a live bug — materialise once and it cannot become one.
  const list = [...moves];
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
  notes.push(...applyMovesToParkedAssets(list));
  // Independently of BOTH of the above: the Assets panel's own "current folder" is also
  // path-keyed state that must follow a move, and wiring it per call site is exactly the
  // mistake this module's header already names — "the first version of this fix covered
  // `executeDeletion` alone and missed the other four" — a third time, this time for
  // `currentFolder` instead of a binding. `remapCurrentFolder` is a no-op unless `currentFolder`
  // IS `from` or sits under it, so this is harmless for the overwhelming majority of moves
  // (single-asset renames/cuts/deletes) where `currentFolder` names an unrelated folder.
  for (const m of list) remapCurrentFolder(m.from, m.to);
  // And independently of all three: the Inspector's own selection (#867 member 3). Same argument
  // as `currentFolder` above — one site repaired it, twelve did not.
  notes.push(...applyMovesToSelection(list));
  // …and the folder-tree sets. Same argument again: three of thirteen sites remapped them by hand.
  remapFolderSets(list);
  return notes;
}

/** Convenience for the delete sites: every path in `deletedPaths` is gone. */
export function unbindDeletedAssetEditors(deletedPaths: Iterable<string>): string[] {
  return applyAssetPathMoves([...deletedPaths].map((from) => ({ from, to: null })));
}
