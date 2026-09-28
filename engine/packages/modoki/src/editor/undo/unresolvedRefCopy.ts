/** A copy of a missing prefab's placeholder keeps its record, re-guided (#1699). The marker and the rule are in
 *  `runtime/core/unresolvedPrefabRef.ts`; this is the editor's half, beside its one caller (`regenerateSnapshotGuids`),
 *  because a copy is an authoring act and mints guids, which a runtime path must not (`determinismGuard`). */

/** Every value of a `guid` key anywhere in `value`: the identities a record states (its root, its member rows' pins,
 *  the nodes it adds). */
function statedGuids(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) statedGuids(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'guid' && typeof v === 'string' && v) out.add(v);
      else statedGuids(v, out);
    }
  }
  return out;
}

/** The marker data for a COPY of a placeholder whose guid was `oldGuid` and is now `newGuid`. Every identity the record
 *  states is re-minted with `mint`, and the root's becomes `newGuid`, everywhere it appears in the record (a scene
 *  entry names its own root in `PrefabInstance.rootInstanceId`), so the copy and the original never answer to one guid
 *  once the prefab resolves. A reference to anything OUTSIDE the record is left alone, as a copy leaves it. */
export function copyUnresolvedRef(data: { source: string; kind: string; record: string }, oldGuid: string, newGuid: string, mint: () => string): { source: string; kind: string; record: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(data.record); } catch { return { ...data }; }
  const remap = new Map<string, string>();
  for (const g of statedGuids(parsed, new Set())) remap.set(g, g === oldGuid ? newGuid : mint());
  if (oldGuid && newGuid) remap.set(oldGuid, newGuid);
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') return remap.get(v) ?? v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [remap.get(k) ?? k, swap(x)]));
    return v;
  };
  return { ...data, record: JSON.stringify(swap(parsed)) };
}
