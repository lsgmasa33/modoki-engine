/** Shared scene-scoped owner-set helpers (F12).
 *
 *  Both `meshTemplateCache` and `riggedModelCache` track resource ownership as
 *  `Map<path, Set<sceneId>>` (the documented Set<sceneId> refcount invariant —
 *  see CLAUDE.md / the Refcount API block). The add/remove bookkeeping is
 *  identical, so it lives here as a leaf util (no imports) both caches share.
 *
 *  Each returns a "transition" boolean the caller uses to decide whether to
 *  load (first owner) or dispose (last owner). */

export function addToOwnerSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): boolean {
  let owners = map.get(key);
  if (!owners) { owners = new Set(); map.set(key, owners); }
  const wasEmpty = owners.size === 0;
  owners.add(value);
  return wasEmpty; // true if this is the first owner (caller may want to load)
}

export function removeFromOwnerSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): boolean {
  const owners = map.get(key);
  if (!owners) return false;
  owners.delete(value);
  if (owners.size === 0) {
    map.delete(key);
    return true; // last owner released — caller should dispose
  }
  return false;
}
