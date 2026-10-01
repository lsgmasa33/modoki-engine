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
 *  ⚠️ **The UNUSED half (#1914 R4, owner ruling F5, docs/prefabs.md § I18).** A writer's record whose target does not
 *  take it — a field the schema no longer declares, a trait nothing registers, a removal of a component the base no longer
 *  has, a legacy localId the template dropped — is Unity's unused override: ignored at load, written back by every save
 *  until an explicit Remove, and applied again once its target returns. Kept here under the same root guid, as the part
 *  of a LIVE member's row (`unused`, by row key) or of the legacy localId channels (`KeptLegacy`) that the load could not
 *  apply; the writers merge it under what the live capture states (`withKeptUnused`, `withKeptLegacy`).
 *
 *  Typed loosely here (L0 knows no scene row shape); `loadSceneFile.ts` owns the typed API over it. */
import { remapGuidValues } from '../assetRefRules';
import { onGuidRemap } from './guidRemap';

const keptRows = new Map<string, Record<string, object>>();
/** Per root: by row key, the part of a LIVE member's row its target does not take (#1914 R4). */
const keptUnused = new Map<string, Record<string, object>>();

/** A root's kept legacy channels: the path-keyed ones by path key (R2: a frame no expansion reaches), and the localId-keyed
 *  ones by localId (#1914 R4: the records whose target is gone or unknown) — each what the file stated there. */
export type KeptLegacy = {
  nestedOverrides?: Record<string, object>; nestedStructure?: Record<string, object>;
  overrides?: Record<string, object>; removedTraits?: Record<string, string[]>; removed?: number[]; moved?: Record<string, string>;
  /** The owner's values in a shape no reader takes, each at its place (#1938 C-B step 2, `malformedChannels.ts`): kept
   *  verbatim and written back where the save states nothing there. */
  malformed?: Array<{ path: string[]; value: unknown }>;
};
const LEGACY_CHANNELS = ['nestedOverrides', 'nestedStructure', 'overrides', 'removedTraits', 'removed', 'moved', 'malformed'] as const;
const keptLegacy = new Map<string, KeptLegacy>();

export function keptLegacyOf(rootGuid: string): KeptLegacy | undefined {
  return keptLegacy.get(rootGuid);
}

/** Replace the legacy channels kept for `rootGuid`; nothing left drops the entry. */
export function setKeptLegacy(rootGuid: string, channels: KeptLegacy): void {
  if (!rootGuid) return;
  const out: Record<string, unknown> = {};
  for (const c of LEGACY_CHANNELS) {
    const v = channels[c];
    if (v && Object.keys(v).length) out[c] = v;
  }
  if (Object.keys(out).length) keptLegacy.set(rootGuid, out as KeptLegacy);
  else keptLegacy.delete(rootGuid);
}

export function keptUnusedRowsOf(rootGuid: string): Record<string, object> | undefined {
  return keptUnused.get(rootGuid);
}

/** Replace the unused row parts kept for `rootGuid`; an empty set drops the entry. */
export function setKeptUnusedRows(rootGuid: string, rows: Record<string, object>): void {
  if (!rootGuid) return;
  if (Object.keys(rows).length) keptUnused.set(rootGuid, rows);
  else keptUnused.delete(rootGuid);
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

/** Everything R2 keeps for one root: its orphan rows, its legacy channels, and its live members' unused row parts. */
export type KeptState = { rows?: Record<string, object>; legacy?: KeptLegacy; unused?: Record<string, object> };

/** A deep copy of what is kept for `rootGuid`, for an entity snapshot to carry (#1788): the store sits beside the tree,
 *  keyed by the root's guid, so a respawn (undo) or a copy (duplicate, paste) got none of it — the copy's save wrote no
 *  orphan row and no legacy channel, and only the original took the scene's edit when the template brought them back.
 *  A copy, not the live value: the store is rewritten in place by a later load, settle or rename. */
export function keptStateOf(rootGuid: string): KeptState | undefined {
  const rows = rootGuid ? keptRows.get(rootGuid) : undefined;
  const legacy = rootGuid ? keptLegacy.get(rootGuid) : undefined;
  const unused = rootGuid ? keptUnused.get(rootGuid) : undefined;
  if (!rows && !legacy && !unused) return undefined;
  return structuredClone({ ...(rows ? { rows } : {}), ...(legacy ? { legacy } : {}), ...(unused ? { unused } : {}) });
}

/** Put a snapshot's kept state back under `rootGuid` — the respawn half of {@link keptStateOf}. */
export function restoreKeptState(rootGuid: string, state: KeptState): void {
  if (!rootGuid) return;
  setKeptOrphanRows(rootGuid, structuredClone(state.rows ?? {}));
  setKeptLegacy(rootGuid, structuredClone(state.legacy ?? {}));
  setKeptUnusedRows(rootGuid, structuredClone(state.unused ?? {}));
}

export function clearKeptOrphanRows(): void {
  keptRows.clear();
  keptLegacy.clear();
  keptUnused.clear();
}

/** Move every renamed root's kept rows to its new guid, and rename the guids the rows themselves name (a row's `parent`,
 *  a node's guid, a ref inside a restated trait) — `remapWorldGuidRefs` reaches live trait values only, and a kept row
 *  restored later would otherwise name an entity by a guid it no longer has. Every entry is taken out before any goes
 *  back, so a remap that swaps two guids (a → b, b → a) swaps their rows rather than losing one set. A key that already
 *  holds rows keeps its own on a clash. */
export function rekeyKeptOrphanRows(remap: ReadonlyMap<string, string>): void {
  if (!remap.size) return;
  rekey(keptRows, remap, (a, b) => ({ ...a, ...b }));
  rekey(keptUnused, remap, (a, b) => ({ ...a, ...b }));
  // The legacy half follows the same rename (#1780): its channels name guids too, in a restated trait's refs.
  rekey(keptLegacy, remap, (a, b) => {
    const out: Record<string, unknown> = {};
    for (const c of LEGACY_CHANNELS) {
      const x = a[c], y = b[c];
      if (x || y) out[c] = Array.isArray(x) || Array.isArray(y) ? [...new Set([...(x as number[] ?? []), ...(y as number[] ?? [])])] : { ...x, ...y };
    }
    return out as KeptLegacy;
  });
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
