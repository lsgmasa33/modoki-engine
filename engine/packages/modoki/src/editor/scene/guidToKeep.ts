import { getGuidForPath, isGuid, newGuid } from '../../runtime/loaders/assetManifest';

/** The GUID a re-import keeps for the asset at `path`: the id its sidecar read gave, else the one the manifest holds
 *  for the path, else a fresh one. ⚠️ `/api/read-meta` answers `{}` for a sidecar that does not parse, so an importer
 *  that minted whenever its read came back id-less re-minted the asset over a merge conflict, and every reference to it
 *  dangled (B3 R11, #2071). The manifest still holds the id: the scan salvages it from the damaged file. Editor-only:
 *  it mints, and the shipped runtime may not (`determinismGuard.test.ts`). */
export function guidToKeep(readId: unknown, path: string): string {
  if (typeof readId === 'string' && isGuid(readId)) return readId;
  return getGuidForPath(path) ?? newGuid();
}
