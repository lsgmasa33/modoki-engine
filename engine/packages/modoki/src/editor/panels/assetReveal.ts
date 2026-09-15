/** How the Assets panel follows a selection made OUTSIDE it (the Inspector, the agent's
 *  `set-selection {asset}`, a rename): which of its reactions a store change earns.
 *
 *  Kept out of `Assets.tsx` so the decision — including the last-seen bookkeeping, whose ordering
 *  is part of it — is unit-testable with no renderer. */

import { ASSETS_SECTION } from './assetListing';
import type { SelectedAsset } from '../store/editorStore';

export interface StoreSelectionPlan {
  /** Adopt the store's asset as the panel's local single selection (collapsing a multi-select). */
  syncLocal: boolean;
  /** Add `revealKeysFor(asset)` to the persisted `expanded` set. */
  expand: boolean;
  /** Scroll the row into view once the tree commits. */
  scroll: boolean;
}

export interface StoreSelectionTracker {
  /** Record selection objects the PANEL ITSELF is about to publish, so they never count as fresh. */
  markOwn(assets: ReadonlyArray<SelectedAsset | null | undefined>): void;
  /** Plan the reaction to the store's CURRENT selection, then remember it as seen. */
  next(asset: SelectedAsset | null, localSelected: string | null, isRowRendered: (path: string) => boolean): StoreSelectionPlan;
}

/** Tracks the last store selection the panel reacted to.
 *
 *  ⚠️ **A fresh selection keys on a NEW OBJECT, not a new PATH (#1143).** Reacting only to a path
 *  change meant re-selecting the asset that was already selected revealed nothing: collapse its
 *  group, select it again through `modoki_set_selection`, and the row stayed hidden. `qa/knowledge.md`
 *  § 3 names that call as THE way to make a row exist, and a case inherits the previous case's
 *  selection, so it failed exactly when a QA run reached for it (measured on `demos/particle-demo`:
 *  same path again → 0 rows; clear, then select → 1 row). The store short-circuits a same-path
 *  `selectAsset` (`editorStore.ts`), so a new object means somebody asked again.
 *
 *  ⚠️ **But a new object also comes from the panel ITSELF**, and that must not count. Clicks
 *  (`activate`/`selectEngineAsset`) and the multi-select effect republishing its lead (Cmd+A) publish
 *  fresh objects. Treated as fresh, a click re-opened the other view's groups (persisted), and Cmd+A
 *  scrolled a scrolled-away panel back to the lead row. So `Assets.tsx` wraps its two store actions to
 *  `markOwn` every object it publishes through them, and an own object is not fresh THE FIRST TIME it
 *  is seen. The mark is then dropped: undo/redo restores that same object later (`applySelection`
 *  stores it as-is), and a restore IS a request to show it.
 *
 *  Not covered, on purpose: a path REMAP (rename, cut/paste, drag into a folder, an agent move) builds
 *  its new object in `applyMovesToSelection`, outside the wrapped actions, so it still expands and
 *  scrolls to the moved row. That is what the pre-#1143 path guard did too. Also out of reach: a
 *  same-path `store.selectAsset` from the Inspector returns before publishing anything
 *  (`editorStore.ts`), so only the agent op's fresh object can reveal an already-selected asset.
 *
 *  `expand` ALSO requires the row to be absent from the DOM, so an external selection of a row that is
 *  already rendered adds no keys to the persisted set. `scroll` does not require it: an external
 *  selection of a rendered but scrolled-off row still needs bringing into view.
 *
 *  `syncLocal` keeps the path guard: adopting on identity would collapse a multi-select every time
 *  `setSelectedAssets` republishes its lead. */
export function createStoreSelectionTracker(): StoreSelectionTracker {
  let lastSeen: SelectedAsset | null = null;
  const own = new WeakSet<SelectedAsset>();
  return {
    markOwn(assets) {
      for (const a of assets) if (a) own.add(a);
    },
    next(asset, localSelected, isRowRendered) {
      const wasOwn = !!asset && own.delete(asset);   // a mark is spent on first sight
      const fresh = asset !== lastSeen && !wasOwn;
      lastSeen = asset;
      if (!asset) return { syncLocal: false, expand: false, scroll: false };
      return {
        syncLocal: asset.path !== localSelected,
        expand: fresh && !isRowRendered(asset.path),
        scroll: fresh,
      };
    },
  };
}

/** The `expanded` keys that make `asset`'s row render in EITHER view: its type group (category
 *  view); the top "Assets" section, every ancestor folder and the root (folder view — nothing under
 *  the section renders while `ASSETS_SECTION` is collapsed, see `visibleOrder` in `assetListing.ts`);
 *  and, for a sliced sprite (`<texture>#<sliceGuid>`, `assetManifest.ts` — the LAST `#`, as
 *  `SpriteAssetView.tsx` splits it), the parent texture row its child rows render under, in the
 *  `texture` group — unless the list shows that sprite as a ROW of its own (`spriteRow`: the `sprite`
 *  chip, or a search that surfaced it — `filterAssets`, #1249), where it renders in the `sprite` group
 *  and no texture row holds it. An ENGINE asset (`/modoki/…`) gets none: those rows live in the Engine section,
 *  which `EngineRevealWatcher` reveals through its own keys, and adding project keys for them would
 *  only re-open the project's collapsed groups. */
export function revealKeysFor(asset: Pick<SelectedAsset, 'path' | 'type'>, opts: { spriteRow?: boolean } = {}): string[] {
  if (asset.path.startsWith('/modoki/')) return [];
  const hash = asset.type === 'sprite' ? asset.path.lastIndexOf('#') : -1;
  const rowPath = hash >= 0 ? asset.path.slice(0, hash) : asset.path;
  // A flat sprite row sits in the texture's FOLDER (its path is `<texture>#<slice>`) but in the `sprite` group.
  const keys = hash >= 0 ? (opts.spriteRow ? ['sprite'] : ['texture', rowPath]) : [asset.type];
  keys.push(ASSETS_SECTION);
  const lastSlash = rowPath.lastIndexOf('/');
  if (lastSlash > 0) {
    const parts = rowPath.substring(0, lastSlash).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) keys.push('/' + parts.slice(0, i).join('/'));
  }
  keys.push('/');
  return keys;
}
