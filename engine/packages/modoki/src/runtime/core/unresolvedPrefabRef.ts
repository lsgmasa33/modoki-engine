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

/** `record` is JSON, so the marker's data is a value: a copy of it cannot alias the original's. */
export const UnresolvedPrefabRef = trait({ source: '', kind: '' as '' | 'entry' | 'node', record: '' });

export type UnresolvedKind = 'entry' | 'node';

type Handle = { has(t: unknown): boolean; get(t: unknown): unknown; set(t: unknown, d: unknown): void; add(...t: unknown[]): void };

/** Put the marker on `entity`: `record` is what the file held for the reference to `source`. */
export function markUnresolved(entity: Handle | undefined | null, source: string, kind: UnresolvedKind, record: unknown): void {
  if (!entity || !source) return;
  const data = { source, kind, record: JSON.stringify(record) };
  if (entity.has(UnresolvedPrefabRef)) entity.set(UnresolvedPrefabRef, data);
  else entity.add(UnresolvedPrefabRef(data));
}

/** The record on `entity`, as a fresh object, or undefined when it carries none. */
export function unresolvedRefOf(entity: Handle | undefined | null): { source: string; kind: UnresolvedKind; record: Record<string, unknown> } | undefined {
  if (!entity || !entity.has(UnresolvedPrefabRef)) return undefined;
  const d = entity.get(UnresolvedPrefabRef) as { source: string; kind: string; record: string };
  if (!d.source || (d.kind !== 'entry' && d.kind !== 'node')) return undefined;
  try {
    return { source: d.source, kind: d.kind, record: JSON.parse(d.record) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}
