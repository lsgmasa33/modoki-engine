/** Template identity for an ADDED node written into a prefab template (#1387).
 *
 *  A prefab is a template, so it carries no per-instance identity: a flat member's guid is cleared
 *  and re-derived per instance from its localId path (`deriveInstanceMemberGuids`). An `added` node
 *  inside a nested ROW (the row's own `added`, `nestedStructure[*].added`, or a reference node's)
 *  has no localId, so it used to keep its durable guid verbatim — and every instance of the prefab
 *  then spawned an entity with that ONE guid.
 *
 *  Such a node now carries `AddedEntity.key` (template-local, guid-shaped, stable across saves) and
 *  `guid: ''`. The loader spawns it with this marker; `deriveInstanceMemberGuids` derives its guid
 *  per instance by stepping `'+' + key` along the member path; a template write reads the key back
 *  off the marker, so re-saving a prefab does not re-key it. A SCENE-authored node keeps its `guid`
 *  and never carries a key — which kind a node is follows from the field it carries.
 *
 *  Deliberately UNREGISTERED (the `Transient` precedent): no name-based serializer, snapshot or
 *  Inspector sees it, so a scene save, a duplicate or a paste never writes or copies it. Any
 *  scene-form round trip (Play→Stop, delete→undo) therefore drops it, and a template write then
 *  RECOVERS the key from the node's derived guid (`recoverTemplateKey` in editor/scene/prefab.ts);
 *  re-minting instead re-keyed the node and pinned untouched interiors. See docs/scene-loading.md
 *  § "Guid uniqueness is a PER-FILE rule". */

import { trait } from 'koota';

/** The slice of a koota entity handle these helpers touch — structural, so the loader's and the
 *  editor's own handle types both fit. */
type Handle = { has(t: unknown): boolean; get(t: unknown): unknown; set(t: unknown, d: unknown): void; add(...t: unknown[]): void };

export const TemplateAddedKey = trait({ key: '' });

export { addedKeyStep } from './assetRefRules';

/** The template key a live entity carries, or `''`. */
export function templateKeyOf(entity: Handle | undefined | null): string {
  if (!entity || !entity.has(TemplateAddedKey)) return '';
  return (entity.get(TemplateAddedKey) as { key: string }).key || '';
}

/** Mark a live entity with its template key (replacing any it had). */
export function setTemplateKey(entity: Handle | undefined | null, key: string): void {
  if (!entity || !key) return;
  if (entity.has(TemplateAddedKey)) entity.set(TemplateAddedKey, { key });
  else entity.add(TemplateAddedKey({ key }));
}
