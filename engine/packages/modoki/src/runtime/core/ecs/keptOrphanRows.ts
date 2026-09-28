/** R2's kept-orphan store: the member rows a load could not match to any node the template still declares, kept per
 *  instance-root guid so the next SAVE can write them back rather than dropping them.
 *
 *  ⚠️ **Retained, not repaired.** A row orphans when its template node is GONE — a member deleted
 *  from the prefab, or a rigged re-import that could not re-associate a renamed bone. Keeping it
 *  means an undone template edit, or a re-import that matches again, restores the scene's identity
 *  for that member instead of silently minting a new one. That is the containment the #1468 design record promises: a
 *  rename costs one orphaned row and a log line, never a re-pointed subtree.
 *
 *  ⚠️ A member the INSTANCE removed is NOT an orphan — its node is still in the template, so its row
 *  is retained silently and un-removing it gets its identity back. R2 says this explicitly, and the
 *  distinction is why the loader asks the DOCUMENT rather than the live world: every removed member is
 *  absent from the world and would otherwise be reported as a loss on every load.
 *
 *  ⚠️ **The key is the root's IDENTITY, so it follows a rename** ({@link rekeyKeptOrphanRows}, called by
 *  `applyGuidRemap`, #1778). Create Prefab's stamp renames a swallowed reference node to its derived guid (#1758); with
 *  the rows left under the old guid, the next save looked under the new one, found nothing, and dropped them for good.
 *  Lives in L0 for that reason: the rename is core (`memberHome.ts`), and core may not import the loaders that fill it.
 *
 *  ⚠️ Rows accumulate: nothing expires an orphan, so a template that churns members grows the map
 *  by ~150 bytes each time. Accepted for now — the alternative is dropping identity on a timer — but
 *  it is the reason a later phase may want a deliberate prune, and not something to discover then.
 *
 *  Typed loosely here (L0 knows no scene row shape); `loadSceneFile.ts` owns the typed API over it. */
import { remapGuidValues } from '../assetRefRules';

const keptRows = new Map<string, Record<string, object>>();

export function keptOrphanRowsOf(rootGuid: string): Record<string, object> | undefined {
  return keptRows.get(rootGuid);
}

/** Replace the rows kept for `rootGuid`; an empty set drops the entry. */
export function setKeptOrphanRows(rootGuid: string, rows: Record<string, object>): void {
  if (!rootGuid) return;
  if (Object.keys(rows).length) keptRows.set(rootGuid, rows);
  else keptRows.delete(rootGuid);
}

export function dropKeptOrphanRows(rootGuid: string): void {
  keptRows.delete(rootGuid);
}

export function clearKeptOrphanRows(): void {
  keptRows.clear();
}

/** Move every renamed root's kept rows to its new guid, and rename the guids the rows themselves name (a row's `parent`,
 *  a node's guid, a ref inside a restated trait) — `remapWorldGuidRefs` reaches live trait values only, and a kept row
 *  restored later would otherwise name an entity by a guid it no longer has. Every entry is taken out before any goes
 *  back, so a remap that swaps two guids (a → b, b → a) swaps their rows rather than losing one set. A key that already
 *  holds rows keeps its own on a clash. */
export function rekeyKeptOrphanRows(remap: ReadonlyMap<string, string>): void {
  if (!remap.size) return;
  for (const [guid, rows] of keptRows) {
    const next = remapGuidValues(rows, remap) as Record<string, object>;
    if (next !== rows) keptRows.set(guid, next);
  }
  const moving: Array<[string, Record<string, object>]> = [];
  for (const [from, to] of remap) {
    const rows = keptRows.get(from);
    if (!rows || from === to) continue;
    keptRows.delete(from);
    moving.push([to, rows]);
  }
  for (const [to, rows] of moving) keptRows.set(to, { ...rows, ...keptRows.get(to) });
}
