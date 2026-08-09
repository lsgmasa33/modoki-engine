/** Keep an asset editor's binding in step when its file MOVES or disappears (#186).
 *
 *  Five panels hold a live binding to the asset they are editing — Particle, SpriteAnim,
 *  Skin, Animation, Timeline — and the binding is a PATH. Each also autosaves that path on
 *  a 400ms debounce (`useDebouncedSave`), so any operation that changes where the file
 *  lives, without telling the panel, makes the next edit write to the OLD location:
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
 *  Paths are compared exactly (or by path-segment prefix for a folder). Both sides
 *  originate from the same `AssetEntry.path` — the Assets panel moves by it, and
 *  `openAssetInEditor` binds by it — so there is no normalization to get wrong; if that
 *  ever stops being true this needs a shared canonicalizer, not a looser match here. */

import { useEditorStore } from '../store/editorStore';

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

/** What happened to a path. `to: null` means the asset is GONE (delete) → unbind; a string
 *  means it MOVED → remap, because the asset survives (its GUID and `.meta.json` sidecar
 *  move with it) and only its location changed. `prefix` makes it a FOLDER operation,
 *  matching the folder itself and everything beneath it. */
export interface PathMove {
  readonly from: string;
  readonly to: string | null;
  readonly prefix?: boolean;
  /** Replacement display name, when the caller knows it (an asset rename). */
  readonly name?: string;
}

/** Where `path` ends up under `move`, or `undefined` if the move does not touch it.
 *  `null` = gone. Exported for the test that pins folder-prefix matching. */
export function applyMove(path: string, move: PathMove): string | null | undefined {
  if (move.prefix) {
    // Segment-boundary match ONLY: renaming `/assets/anim` must not capture
    // `/assets/animations/x.json`, which a bare startsWith would.
    if (path !== move.from && !path.startsWith(move.from + '/')) return undefined;
    if (move.to === null) return null;
    return move.to + path.slice(move.from.length);
  }
  if (path !== move.from) return undefined;
  return move.to;
}

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

/** Apply `moves` to every asset editor binding: unbind the ones whose asset is gone, repoint
 *  the ones whose asset moved. Returns a short description per change (empty in the
 *  overwhelmingly common case where nothing bound was touched). */
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
  return notes;
}

/** Convenience for the delete sites: every path in `deletedPaths` is gone. */
export function unbindDeletedAssetEditors(deletedPaths: Iterable<string>): string[] {
  return applyAssetPathMoves([...deletedPaths].map((from) => ({ from, to: null })));
}
