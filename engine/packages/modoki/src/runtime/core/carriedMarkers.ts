/** The unregistered marker traits a respawn of the SAME entity must carry (#1427).
 *
 *  A few traits are deliberately kept out of the name-based trait registry, so no serializer,
 *  snapshot or Inspector sees them. That is right for a COPY — a duplicate or a scene file is a new
 *  identity — but wrong for the two respawns that recreate the same entity in a new world or at a
 *  new id: the base-scene carry (`SceneManager`) and delete→undo (`respawnFromSnapshot`). Both build
 *  their snapshot from the registry, so without this they silently dropped:
 *   - `Transient` — the only thing that keeps a runtime subtree out of a save. A pool under a
 *     `Persistent` root or a kept base's prefab member was written into the scene file after a carry.
 *   - `TemplateAddedKey` — how a template-added node is named. Without it the Inspector showed a
 *     false override on a member reference into the node.
 *
 *  A copy does not carry them. That is right for `Transient` (a pasted copy of a runtime node should
 *  be savable) and for a copied KEYED node itself (two siblings sharing one key name neither), but
 *  wrong for a keyed node INSIDE a copied instance, which lands in a different frame and loses its
 *  name for good — #1430. A new unregistered marker goes on this list
 *  (the architecture guard `unregisteredTraitsCarried.test.ts` fails until it does). */

import { Transient } from './traits/Transient';
import { TemplateAddedKey } from './templateIdentity';

type Handle = { has(t: unknown): boolean; get(t: unknown): unknown; add(...t: unknown[]): void };

/** Every carried marker, by a stable name — the name is what a snapshot stores. */
export const CARRIED_MARKER_TRAITS = { Transient, TemplateAddedKey } as const;
type MarkerName = keyof typeof CARRIED_MARKER_TRAITS;

/** What one entity carried: marker name → its data (`true` for a tag). Absent markers are omitted. */
export type CarriedMarkers = Partial<Record<MarkerName, true | Record<string, unknown>>>;

/** The markers `entity` carries, or `undefined` when it carries none. */
export function captureMarkers(entity: Handle | undefined | null): CarriedMarkers | undefined {
  if (!entity) return undefined;
  let out: CarriedMarkers | undefined;
  for (const [name, t] of Object.entries(CARRIED_MARKER_TRAITS) as [MarkerName, typeof Transient][]) {
    if (!entity.has(t)) continue;
    const data = entity.get(t) as Record<string, unknown> | undefined;
    (out ??= {})[name] = data && Object.keys(data).length ? { ...data } : true;
  }
  return out;
}

/** Put captured markers back on the respawned entity. */
export function restoreMarkers(entity: Handle, markers: CarriedMarkers | undefined): void {
  if (!markers) return;
  for (const [name, data] of Object.entries(markers) as [MarkerName, true | Record<string, unknown>][]) {
    const t = CARRIED_MARKER_TRAITS[name] as unknown as (d?: Record<string, unknown>) => unknown;
    if (!t || entity.has(t)) continue;
    entity.add(data === true ? t : t(data));
  }
}
