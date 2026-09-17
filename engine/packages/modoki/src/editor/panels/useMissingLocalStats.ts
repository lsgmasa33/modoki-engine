/** Does this asset's Inspector have a stats row it cannot fill? (#1305)
 *
 *  ⚠️ **SUBSCRIBED, not read plainly** — the same rule `useMetaDirty` carries, and for the same
 *  reason. The answer changes when the human re-imports the asset, and a re-import does not pass
 *  through the panel's own state: without the subscription the hint would still be on screen over
 *  an asset whose numbers are now sitting right beside it. Stale in the one direction that
 *  misleads, which is this repo's most common defect shape.
 *
 *  Version-counter form (`useSyncExternalStore(subscribe, getVersion, getVersion)` plus a separate
 *  read), matching `useMetaDirty`, `SceneAssetView` and `AtlasAssetView`. */
import { useSyncExternalStore } from 'react';
import { subscribeMissingLocalStats, getMissingLocalStatsVersion, missingLocalStatsFor } from '../scene/missingLocalStats';

/** `true` when `block`'s peeled values are missing for `path` — i.e. the panel should offer
 *  "re-import to compute stats" instead of rendering a row it has no number for.
 *
 *  The subscription is established BEFORE the early exit, deliberately: hooks cannot be
 *  conditional, and a panel whose path arrives asynchronously must already be subscribed when it
 *  does. */
export function useMissingLocalStats(path: string | undefined, block: string): boolean {
  useSyncExternalStore(subscribeMissingLocalStats, getMissingLocalStatsVersion, getMissingLocalStatsVersion);
  if (!path) return false;
  return missingLocalStatsFor(path).includes(block);
}
