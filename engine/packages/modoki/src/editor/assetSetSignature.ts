/** Signature of a set of asset paths, used to auto-refresh the Assets panel only
 *  when the files on disk actually change.
 *
 *  The dev-server watcher rebroadcasts `asset-manifest-updated` on EVERY manifest
 *  rebuild — crucially INCLUDING the panel's own /api/rescan-assets fetch. So a
 *  handler that refreshes the panel on every broadcast would loop forever
 *  (refresh → fetch → rebuild → broadcast → refresh …). Comparing this signature
 *  breaks the loop: the panel's self-induced rescan yields the SAME path set (the
 *  manifest has no monotonic/timestamp field), so it's ignored; a real
 *  add / remove / rename / move changes the set and triggers exactly one refresh.
 *
 *  Sorted so it's order-independent (readdir order isn't guaranteed). Intentionally
 *  keyed on PATHS only — same-path content edits (e.g. a texture re-import) don't
 *  change the panel's file listing and are already refreshed explicitly by the
 *  import flow, so folding content into the signature would only cause churn. */
export function assetSetSignature(assets: ReadonlyArray<{ path: string }> | undefined | null): string {
  if (!Array.isArray(assets)) return '';
  return assets.map((a) => a.path).sort().join('|');
}
