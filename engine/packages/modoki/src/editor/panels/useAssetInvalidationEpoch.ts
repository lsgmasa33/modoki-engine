/** useAssetInvalidationEpoch — a counter that bumps whenever an editor re-import
 *  invalidates an asset's cached derivations (`invalidateModel` /
 *  `invalidateTexture` / `invalidateAudio`).
 *
 *  WHY (#294): the asset previews are keyed on the asset PATH, and a re-import is
 *  exactly the gesture that rewrites the bytes behind a path without changing it.
 *  React therefore never re-runs the load, and the panel keeps showing the
 *  pre-reimport geometry with nothing saying so. Folding this epoch into a
 *  `resetKey`/effect dep gives those previews the "the file changed underneath me"
 *  signal the path cannot carry.
 *
 *  #303/#304 extended it past previews to the SIDECAR-DERIVED STATS: an Inspector
 *  re-reads `.meta.json` on mount and after its own Import button, so a re-import
 *  fired from the Assets panel or a batch view left its byte counts, LOD list and
 *  `converted` flag showing pre-reimport values indefinitely.
 *
 *  `matches` narrows to the assets a caller cares about — it receives the
 *  `(path, targets)` pair the event delivers, where `targets` also names a model's
 *  baked LOD siblings. Omit it to bump on ANY invalidation of that kind (correct,
 *  and the only option for a consumer that cannot cheaply map itself back to a
 *  source asset — see MeshPreview). */

import { useEffect, useRef, useState } from 'react';
import { onAssetInvalidated, type InvalidatedAssetKind } from '../../runtime/core/assetInvalidation';

export type ModelInvalidationFilter = (modelPath: string, targets: ReadonlySet<string>) => boolean;

/** Trailing-edge coalescing window. ONE Import click fires `invalidateModel` for the
 *  same model THREE times — measured on games/sling's ramp_wedge, 2 ms apart then
 *  32 ms later: the import invalidates before re-deriving templates, again around the
 *  prefab regeneration, and once more at the end. Each bump costs a subscriber a full
 *  reload (ModelPreview refetches + re-parses the baked GLB), so without this the fix
 *  buys correct pixels at 3x the work on exactly the large models where it hurts. The
 *  window is long enough to swallow a burst and far shorter than any GLB load, so the
 *  refresh still reads as immediate. */
const COALESCE_MS = 250;

/** Append the epoch as a cache-bust query so the browser cannot replay its cached copy
 *  of a URL whose bytes were rewritten in place. A no-op at epoch 0 (nothing has been
 *  re-imported yet), so a normal session's URLs stay untouched.
 *
 *  `blob:`/`data:` are passed through: they are already unique, and a query suffix
 *  BREAKS a blob-URL lookup (it is matched by UUID, not by query) — the same carve-out
 *  `withCacheBust` in `runtime/loaders/assetUrl.ts` makes, for the same reason. Reachable
 *  via `assetUrl`, which resolves a path to a blob: URL under the playable build's
 *  `__PLAYABLE_ASSETS__`. */
export function cacheBustReimport(url: string, epoch: number): string {
  if (epoch <= 0) return url;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'reimport=' + epoch;
}

/** Bump on re-imports of ONE asset kind. `matches` narrows further, within that kind.
 *
 *  The kind is a dep, not a ref: a panel does not switch which kind it watches, and
 *  reading it through a ref would make a hypothetical switch silently not take. */
export function useAssetInvalidationEpoch(
  kind: InvalidatedAssetKind,
  matches?: ModelInvalidationFilter,
): number {
  const [epoch, setEpoch] = useState(0);
  // Read the predicate through a ref so an inline arrow (the usual call shape)
  // doesn't resubscribe on every render.
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onAssetInvalidated((firedKind, path, targets) => {
      if (firedKind !== kind) return;
      const f = matchesRef.current;
      if (f && !f(path, targets)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; setEpoch((n) => n + 1); }, COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer); // no bump into an unmounted panel
    };
  }, [kind]);

  return epoch;
}

/** The model-only spelling — what every pre-#304 caller means, kept so the
 *  previews wired up by #294 read the same as they did. */
export function useModelInvalidationEpoch(matches?: ModelInvalidationFilter): number {
  return useAssetInvalidationEpoch('model', matches);
}
