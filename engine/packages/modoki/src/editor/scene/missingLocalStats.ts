/** Which assets are missing their machine-local (peeled) cache values, as last reported by the
 *  server (#1305).
 *
 *  ## Why a store rather than panel state
 *
 *  A peel migration strips a host-measured field out of the committed `.meta.json` and CANNOT seed
 *  the gitignored `.meta.local.json` — that file is gitignored, so no commit can carry one — and
 *  nothing re-derives it, because a peeled value is written only as a side-effect of a reimport
 *  handler and that runs only on a converted-artifact cache miss, which a warm `.cache/` makes
 *  impossible. So on most machines the Inspector row fed by such a field simply has no value.
 *
 *  The panel needs to SAY so ("re-import to compute stats") rather than show a blank — or, as
 *  texture and model did before #1305, a confidently defaulted `0 B`. Which fields are peeled is
 *  server knowledge (`plugins/meta-sidecar.ts` § LOCAL_KEYS), so the answer arrives on
 *  `/api/read-meta`'s `X-Meta-Local-Missing` header, and this is where it lands.
 *
 *  A store, not a field threaded through each view's `loadMeta`, for the reason `useMetaDirty`
 *  gives: every asset view with a peeled row would re-derive the same plumbing, and the batch views read N paths.
 *  This follows the same version-counter convention so a panel re-renders when the answer changes
 *  without the change passing through its own state.
 *
 *  ⚠️ **The version bumps only on a real change.** `/api/read-meta` is re-read on every reimport
 *  epoch and on every panel mount, so bumping unconditionally would re-render every subscribed
 *  panel on every read — a store subscription that fires constantly is as bad as one that never
 *  fires, and harder to notice. */

import { notifyListeners } from '../../runtime/core/notifyListeners';

/** path → the cache blocks whose peeled values this host does not hold. Absent ⇒ nothing missing. */
const missing = new Map<string, readonly string[]>();
let version = 0;
const listeners = new Set<() => void>();

/** Shared empty result, so a subscriber's `useMemo`/`===` comparisons do not see a new array each
 *  render for the overwhelmingly common "nothing missing" case. */
const NONE: readonly string[] = Object.freeze([]);

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Record what the server said about `path`. Called by `noteMetaReadResult` (`pendingMeta.ts`),
 *  which every raw `/api/read-meta` GET owes a call — the helper's and each declared exemption's
 *  alike (`metaReadPreferringPark.test.ts`'s `'seeds'` rule). Not from the helper alone: the video
 *  panel is such an exemption, and its hint was dead until this moved. */
export function noteMissingLocalStats(path: string, blocks: readonly string[]): void {
  const prev = missing.get(path) ?? NONE;
  if (same(prev, blocks)) return; // see the ⚠️ above — no change, no re-render
  if (blocks.length === 0) missing.delete(path);
  else missing.set(path, [...blocks]);
  version++;
  notifyListeners(listeners, 'missingLocalStats', []);
}

export function subscribeMissingLocalStats(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The `getSnapshot` for a `useSyncExternalStore` subscriber. */
export function getMissingLocalStatsVersion(): number { return version; }

/** The cache blocks `path` is missing peeled values for — `[]` when it is whole, or unknown. */
export function missingLocalStatsFor(path: string): readonly string[] {
  return missing.get(path) ?? NONE;
}

/** Test seam: drop everything recorded. Production never calls this — an entry is corrected by the
 *  next read of that path, which is the only event that can know better. */
export function resetMissingLocalStats(): void {
  missing.clear();
  version++;
  notifyListeners(listeners, 'missingLocalStats', []);
}
