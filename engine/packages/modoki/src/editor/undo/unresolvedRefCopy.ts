/** A copy of a missing prefab's placeholder keeps its record, re-guided (#1699). The marker and the rule are in
 *  `runtime/core/unresolvedPrefabRef.ts`; this is the editor's half, beside its one caller (`copySnapshot`),
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

/** The guids a COPY of a placeholder mints for its record, where the placeholder's guid was `oldGuid` and is now
 *  `newGuid`: every identity the record states gets a fresh one from `mint`, and the root's becomes `newGuid` (a scene
 *  entry names its own root in `PrefabInstance.rootInstanceId`), so the copy and the original never answer to one guid
 *  once the prefab resolves. `copySnapshot` merges these into the copy's own remap BEFORE it rewrites anything, so a
 *  copied entity's ref into a record member follows the copy's member too (#1763). */
export function recordGuidMints(data: { record: string }, oldGuid: string, newGuid: string, mint: () => string): Map<string, string> {
  const remap = new Map<string, string>();
  let parsed: unknown;
  try { parsed = JSON.parse(data.record); } catch { return remap; }
  for (const g of statedGuids(parsed, new Set())) remap.set(g, g === oldGuid ? newGuid : mint());
  if (oldGuid && newGuid) remap.set(oldGuid, newGuid);
  return remap;
}

/** The guids a COPY mints for the R2 state kept for one of its stored roots (#1788): every identity the kept rows and
 *  legacy channels state — an orphan member's pinned guid, a scene node's — gets a fresh one, so the original and the copy
 *  never pin one member guid between them once the template brings that member back (#1293). Merged into the copy's
 *  remap with the record mints above, before anything is rewritten, so a copied entity's ref to the orphan follows too. */
export function keptGuidMints(kept: unknown, mint: () => string): Map<string, string> {
  const remap = new Map<string, string>();
  for (const g of statedGuids(kept, new Set())) remap.set(g, mint());
  return remap;
}

/** The marker data for a COPY of a placeholder: its record with every guid in `remap` rewritten, as a value and as a
 *  key. `remap` is the WHOLE copy's (`recordGuidMints` for every record in it, plus `planCopyGuids`' for every entity
 *  copied), so a ref inside the record to an entity copied alongside the placeholder names the copy of it, not the
 *  original (#1338's rule; #1763). A reference to anything outside the copy is left alone, as a copy leaves it. */
export function copyUnresolvedRef(data: { source: string; kind: string; record: string }, remap: ReadonlyMap<string, string>): { source: string; kind: string; record: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(data.record); } catch { return { ...data }; }
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') return remap.get(v) ?? v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [remap.get(k) ?? k, swap(x)]));
    return v;
  };
  return { ...data, record: JSON.stringify(swap(parsed)) };
}
