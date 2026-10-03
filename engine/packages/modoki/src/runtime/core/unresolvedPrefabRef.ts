/** The record a load could not expand, carried ON the placeholder that stands in for it (#1699).
 *
 *  A prefab reference whose document does not resolve leaves a placeholder entity, and this marker keeps what the file
 *  held for it (a scene entry, or an added reference node) so the next save writes it back verbatim. The rule, the
 *  writers and the placeholder spawner are in `runtime/loaders/unresolvedPrefabRefs.ts`; this module is only the
 *  marker, in core so `carriedMarkers.ts` can carry it.
 *
 *  ⚠️ An UNREGISTERED trait on purpose, like `TemplateAddedKey`: no serializer, snapshot or Inspector walks it, so it
 *  can never be written as a component of its own. What carries it is explicit:
 *   - delete → undo and the base-scene carry respawn the SAME entity, so `carriedMarkers.ts` lists it;
 *   - a duplicate or a paste is a new identity, and still keeps the record (Unity keeps a missing-prefab instance's
 *     data on a copy), re-guided by `copyUnresolvedRef` (`editor/undo/unresolvedRefCopy.ts`) so the copy shares no
 *     identity with the original;
 *   - an EXPANSION never carries it. A reload or a rebuild that finds the prefab spawns new entities, so "this entity
 *     still has the marker" is exactly "this reference has not been re-expanded yet". Writers key on the marker and not
 *     on whether the prefab resolves now, because a prefab restored mid-session resolves while the live entity is still
 *     the empty placeholder, and capturing that would lose the record one save later. */

import { trait } from 'koota';
import { CAPTURE_FORM_SCENE_VERSION } from './version';

/** `record` is JSON, so the marker's data is a value: a copy of it cannot alias the original's. `version` is the scene
 *  format the record was READ in (#2001 S6): a record is kept verbatim, so whoever parses it again (a re-seed, the
 *  prefab's return) must read it by the rules of the file it came from — a v20 entry's name and root order are read
 *  differently from an older one's. 0: not stated, the old capture's form. */
export const UnresolvedPrefabRef = trait({ source: '', kind: '' as '' | 'entry' | 'node' | 'row', record: '', version: 0 });

export type UnresolvedKind = 'entry' | 'node';

type Handle = { has(t: unknown): boolean; get(t: unknown): unknown; set(t: unknown, d: unknown): void; add(...t: unknown[]): void };

/** Put the marker on `entity`: `record` is what the file held for the reference to `source`. */
export function markUnresolved(entity: Handle | undefined | null, source: string, kind: UnresolvedKind, record: unknown, version = 0): void {
  if (!entity || !source) return;
  const data = { source, kind, record: JSON.stringify(record), version };
  if (entity.has(UnresolvedPrefabRef)) entity.set(UnresolvedPrefabRef, data);
  else entity.add(UnresolvedPrefabRef(data));
}

/** The record on `entity`, as a fresh object, or undefined when it carries none. */
export function unresolvedRefOf(entity: Handle | undefined | null): { source: string; kind: UnresolvedKind; record: Record<string, unknown>; version: number } | undefined {
  if (!entity || !entity.has(UnresolvedPrefabRef)) return undefined;
  const d = entity.get(UnresolvedPrefabRef) as { source: string; kind: string; record: string; version?: number };
  if (!d.source || (d.kind !== 'entry' && d.kind !== 'node')) return undefined;
  try {
    return { source: d.source, kind: d.kind, record: JSON.parse(d.record) as Record<string, unknown>, version: d.version || CAPTURE_FORM_SCENE_VERSION };
  } catch {
    return undefined;
  }
}

/** What a ROW placeholder stands for (#2001 S5, rule 9, ruling D): a nested reference row of a loaded document whose own
 *  prefab is missing or damaged. Unlike an entry's or a node's, it carries NO record to write back: the row is the
 *  document's, and every record about the frame it opens stays in the instance's list. It is the frame's stand-in only,
 *  so `unresolvedRefOf` never answers for it (no writer may treat it as a stored reference); the marker is shared so
 *  everything that shows a Missing Prefab placeholder shows this one too. */
export interface RowPlaceholder {
  source: string;
  /** The row's localId and minted identity in the document of the frame it hangs in. */
  localId: number;
  nodeGuid: string;
  reason: 'missing' | 'damaged';
}

/** Mark `entity` as the placeholder of a nested row. */
export function markRowPlaceholder(entity: Handle | undefined | null, row: RowPlaceholder): void {
  if (!entity || !row.source) return;
  const data = { source: row.source, kind: 'row' as const, record: JSON.stringify({ localId: row.localId, nodeGuid: row.nodeGuid, reason: row.reason }), version: 0 };
  if (entity.has(UnresolvedPrefabRef)) entity.set(UnresolvedPrefabRef, data);
  else entity.add(UnresolvedPrefabRef(data));
}

/** The row `entity` stands in for, when it is a row placeholder. */
export function rowPlaceholderOf(entity: Handle | undefined | null): RowPlaceholder | undefined {
  if (!entity || !entity.has(UnresolvedPrefabRef)) return undefined;
  const d = entity.get(UnresolvedPrefabRef) as { source: string; kind: string; record: string };
  if (d.kind !== 'row' || !d.source) return undefined;
  try {
    const r = JSON.parse(d.record) as { localId?: unknown; nodeGuid?: unknown; reason?: unknown };
    if (typeof r.localId !== 'number') return undefined;
    return { source: d.source, localId: r.localId, nodeGuid: typeof r.nodeGuid === 'string' ? r.nodeGuid : '', reason: r.reason === 'damaged' ? 'damaged' : 'missing' };
  } catch {
    return undefined;
  }
}
