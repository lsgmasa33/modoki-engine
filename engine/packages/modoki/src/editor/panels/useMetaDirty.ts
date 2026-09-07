/** Is a `.meta.json` import-settings edit parked for this panel's path(s)? (#870)
 *
 *  WHY THIS EXISTS. Since #845 an Inspector import-settings change PARKS instead of writing, so
 *  there is unsaved work — in the one place the human is looking — with no on-screen sign of it.
 *  `pendingMeta.ts` exported the whole observability surface for exactly this
 *  (`subscribePendingMeta`, `getPendingMetaVersion`, `isMetaDirty`, whose own docblock says *"A
 *  panel's dirty indicator"*) and **nothing consumed any of it**. A complete-looking API with zero
 *  callers is what made the gap quiet: reading `pendingMeta.ts` you would conclude the indicator
 *  exists.
 *
 *  ⚠️ **SUBSCRIBED, not read plainly.** A bare `isMetaDirty(path)` in a panel body is right at the
 *  moment of the edit and wrong for the rest of the panel's life: Cmd+S and an agent's
 *  `discard_asset_edits` both empty the registry **without touching any panel state**, so nothing
 *  re-renders and the marker stays on "Unsaved" over a file that is already on disk — stale in the
 *  one direction that misleads. *"A store subscription nothing re-renders on is this repo's most
 *  common defect shape"* (#870), so the test for this drives every case from OUTSIDE the hook — a
 *  flush and an agent discard, neither of which passes through the component.
 *
 *  (An earlier version of this note claimed the set direction "passes without any subscription at
 *  all". That is true of a real PANEL, whose own `setState` re-renders it regardless, and FALSE of
 *  the test it pointed at: under `renderHook` there is no other trigger, so that case fails too.
 *  Worth keeping straight — the reason to assert the clear direction is that it is the one a real
 *  panel gets wrong, not that the other assertion is worthless.)
 *
 *  WHICH CONVENTION. This is the **version-counter** form —
 *  `useSyncExternalStore(subscribe, getVersion, getVersion)` followed by a separate
 *  `isXDirty(path)` read — matching `SceneAssetView.tsx` (`pendingBaseScene`) and
 *  `AtlasAssetView.tsx` (`dirtyAssets`). `getPendingMetaVersion`'s own docblock already calls
 *  itself *"the `getSnapshot` for a `useSyncExternalStore` subscriber"*, so the registry was built
 *  for this shape. The other live convention — `useParkedAssetDoc.ts`'s boolean snapshot — belongs
 *  to panels that own a WHOLE DOCUMENT and have a persistent status line to put `Saved ✓` in; an
 *  Inspector asset view has neither, and shows its marker only when dirty.
 *
 *  A hook rather than nine copies of the same three lines: the batch views park N paths, and
 *  `isMetaDirty` is single-path, so every panel re-deriving "any of mine" is how the two batch
 *  views end up with a marker that only tracks the first selection. */
import { useSyncExternalStore } from 'react';
import { subscribePendingMeta, getPendingMetaVersion, isMetaDirty } from '../scene/pendingMeta';

/** `true` when a `.meta.json` edit is parked for `paths` — one path, or ANY of several.
 *
 *  Pass the batch views' whole selection: "any of mine is unsaved" is the honest claim for a panel
 *  editing N sidecars at once, and it is the question `isMetaDirty` alone cannot answer.
 *
 *  `undefined` / `[]` is `false` — a panel with nothing selected has nothing unsaved. The
 *  subscription is established BEFORE that early exit, deliberately: hooks cannot be conditional,
 *  and a panel whose path arrives asynchronously must already be subscribed when it does. */
export function useMetaDirty(paths: string | readonly string[] | undefined): boolean {
  // The whole point. `getPendingMetaVersion` bumps on park / flush / discard, so a save or an
  // agent discard — neither of which passes through this component — re-renders it.
  useSyncExternalStore(subscribePendingMeta, getPendingMetaVersion, getPendingMetaVersion);
  if (!paths) return false;
  return typeof paths === 'string' ? isMetaDirty(paths) : paths.some((p) => isMetaDirty(p));
}
