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
 *  ⚠️ **The key is the root's IDENTITY, so it follows a rename** ({@link rekeyKeptOrphanRows}, registered with
 *  `applyGuidRemap`'s registry, `guidRemap.ts` — #1778, #1785). Create Prefab's stamp renames a swallowed reference node to its derived guid (#1758); with
 *  the rows left under the old guid, the next save looked under the new one, found nothing, and dropped them for good.
 *  It lives in L0 because the rename once called it directly, and core may not import the loaders that fill it.
 *
 *  ⚠️ Rows accumulate: nothing expires an orphan, so a template that churns members grows the map
 *  by ~150 bytes each time. Accepted for now — the alternative is dropping identity on a timer — but
 *  it is the reason a later phase may want a deliberate prune, and not something to discover then.
 *
 *  ⚠️ **The LEGACY half (#1780, #1738).** A scene or template older than member rows states a nested frame's edits in
 *  path-keyed channels (`nestedOverrides`, `nestedStructure`, keyed by row localIds). One addressing a frame the document
 *  does not expand (the template does not have the row yet, or its prefab cannot be read) reaches no live frame, so no
 *  capture regenerates it, and the next save dropped it. The load keeps those channels here under the same root guid,
 *  the writers put them back (a live capture wins each key), and a rebuild that makes the frame live hands them to its
 *  expansion. A legacy file's first save after that migrates what it applied onto member rows.
 *
 *  Typed loosely here (L0 knows no scene row shape); `loadSceneFile.ts` owns the typed API over it. */
import { remapGuidValues } from '../assetRefRules';
import { onGuidRemap } from './guidRemap';

const keptRows = new Map<string, Record<string, object>>();

/** A root's kept legacy channels: each is path key → what the channel states at that path. */
export type KeptLegacy = { nestedOverrides?: Record<string, object>; nestedStructure?: Record<string, object> };
const keptLegacy = new Map<string, KeptLegacy>();

export function keptLegacyOf(rootGuid: string): KeptLegacy | undefined {
  return keptLegacy.get(rootGuid);
}

/** Replace the legacy channels kept for `rootGuid`; nothing left drops the entry. */
export function setKeptLegacy(rootGuid: string, channels: KeptLegacy): void {
  if (!rootGuid) return;
  const out: KeptLegacy = {};
  if (channels.nestedOverrides && Object.keys(channels.nestedOverrides).length) out.nestedOverrides = channels.nestedOverrides;
  if (channels.nestedStructure && Object.keys(channels.nestedStructure).length) out.nestedStructure = channels.nestedStructure;
  if (out.nestedOverrides || out.nestedStructure) keptLegacy.set(rootGuid, out);
  else keptLegacy.delete(rootGuid);
}

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

/** Everything R2 keeps for one root: its orphan rows and its legacy channels. */
export type KeptState = { rows?: Record<string, object>; legacy?: KeptLegacy };

/** A deep copy of what is kept for `rootGuid`, for an entity snapshot to carry (#1788): the store sits beside the tree,
 *  keyed by the root's guid, so a respawn (undo) or a copy (duplicate, paste) got none of it — the copy's save wrote no
 *  orphan row and no legacy channel, and only the original took the scene's edit when the template brought them back.
 *  A copy, not the live value: the store is rewritten in place by a later load, settle or rename. */
export function keptStateOf(rootGuid: string): KeptState | undefined {
  const rows = rootGuid ? keptRows.get(rootGuid) : undefined;
  const legacy = rootGuid ? keptLegacy.get(rootGuid) : undefined;
  if (!rows && !legacy) return undefined;
  return structuredClone({ ...(rows ? { rows } : {}), ...(legacy ? { legacy } : {}) });
}

/** Put a snapshot's kept state back under `rootGuid` — the respawn half of {@link keptStateOf}. */
export function restoreKeptState(rootGuid: string, state: KeptState): void {
  if (!rootGuid) return;
  setKeptOrphanRows(rootGuid, structuredClone(state.rows ?? {}));
  setKeptLegacy(rootGuid, structuredClone(state.legacy ?? {}));
}

export function clearKeptOrphanRows(): void {
  keptRows.clear();
  keptLegacy.clear();
}

/** Move every renamed root's kept rows to its new guid, and rename the guids the rows themselves name (a row's `parent`,
 *  a node's guid, a ref inside a restated trait) — `remapWorldGuidRefs` reaches live trait values only, and a kept row
 *  restored later would otherwise name an entity by a guid it no longer has. Every entry is taken out before any goes
 *  back, so a remap that swaps two guids (a → b, b → a) swaps their rows rather than losing one set. A key that already
 *  holds rows keeps its own on a clash. */
export function rekeyKeptOrphanRows(remap: ReadonlyMap<string, string>): void {
  if (!remap.size) return;
  rekey(keptRows, remap, (a, b) => ({ ...a, ...b }));
  // The legacy half follows the same rename (#1780): its channels name guids too, in a restated trait's refs.
  rekey(keptLegacy, remap, (a, b) => ({
    nestedOverrides: { ...a.nestedOverrides, ...b.nestedOverrides },
    nestedStructure: { ...a.nestedStructure, ...b.nestedStructure },
  }));
}

onGuidRemap('keptOrphanRows', (remap) => rekeyKeptOrphanRows(remap));

function rekey<V extends object>(store: Map<string, V>, remap: ReadonlyMap<string, string>, merge: (moved: V, own: V) => V): void {
  for (const [guid, value] of store) {
    const next = remapGuidValues(value, remap) as V;
    if (next !== value) store.set(guid, next);
  }
  const moving: Array<[string, V]> = [];
  for (const [from, to] of remap) {
    const value = store.get(from);
    if (!value || from === to) continue;
    store.delete(from);
    moving.push([to, value]);
  }
  for (const [to, value] of moving) {
    const own = store.get(to);
    store.set(to, own ? merge(value, own) : value);
  }
}
