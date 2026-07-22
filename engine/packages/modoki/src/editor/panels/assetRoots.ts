/** Writable asset-root resolution, shared by the Hierarchy (Create Prefab) and
 *  Assets (Import) panels.
 *
 *  The dev server serves a project's assets under one of three URL prefixes,
 *  depending on the project shape (see vite-asset-scanner.ts `collectAssetRoots`):
 *   - flat one-game project (#29):   /assets/...            → root "/assets"
 *   - engine built-ins:              /modoki/assets/...     → root "/modoki/assets"
 *   - multi-game repo:               /games/<id>/assets/... → root "/games/<id>/assets"
 *
 *  The bare flat-project `/assets` prefix arrived with the #29 one-game teardown;
 *  the older regex only knew `/modoki/assets` and `/games/<id>/assets`, so when a
 *  game is opened standalone (the normal flat case) NOTHING matched — and Create
 *  Prefab / Import failed with "No writable asset root". This is the single source
 *  of truth that fixes that (guarded by assetRoots.test.ts). */
export const ASSET_ROOT_RE = /^(\/(?:assets|modoki\/assets|(?:games|demos)\/[^/]+\/assets))(?:\/|$)/;

/** First (sorted) writable asset root among a set of asset URL paths, or null if
 *  none match. Sorting puts the project root ("/assets", "/games/<id>/assets", or
 *  "/demos/<id>/assets") ahead of the engine "/modoki/assets" built-ins
 *  ("/a"/"/d"/"/g" all < "/m"), so new prefabs and imports land in the project,
 *  never in the read-only engine assets. */
export function firstAssetRoot(paths: Iterable<string>): string | null {
  const roots = new Set<string>();
  for (const p of paths) {
    const m = p.match(ASSET_ROOT_RE);
    if (m) roots.add(m[1]);
  }
  return [...roots].sort()[0] ?? null;
}
