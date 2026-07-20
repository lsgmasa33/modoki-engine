/** Editor-only entity actions with undo support.
 *  Wraps runtime entityUtils with undo/redo tracking. */

import * as THREE from 'three';
import { getCurrentWorld, registerEntity } from '../../runtime/ecs/world';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/ecs/traitRegistry';
import {
  findEntity, readTraitData, readTraitDataFull, writeTraitField,
  getAllEntities, deleteEntity, markStructureDirty, cloneTraitValues,
} from '../../runtime/ecs/entityUtils';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { markOverride } from '../../runtime/loaders/overrideMarks';
import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { pushAction, type EditDetail } from './undoManager';
import { entityRef, ensureGuid, buildGuidIndex, resolveWith, type EntityRef } from './entityRef';
import { notifyFieldEdited } from '../animation/recording';

/** Record a deliberate per-instance override when the user edits a field on a
 *  prefab-instance member, so the change survives serialize even if the prefab
 *  base is later edited to coincide with it — AND so override capture can tell a
 *  real edit from a field that merely diverged from the base when the prefab was
 *  re-imported under an un-edited instance (the rigged-reimport root-bone bug).
 *  No-op for non-instance entities and for the PrefabInstance trait itself.
 *  See overrideMarks.ts + getOverrideValues/captureInstanceOverrides. */
export function markOverrideIfInstance(entityId: number, traitName: string, field: string): void {
  if (traitName === 'PrefabInstance') return;
  const piMeta = getTraitByName('PrefabInstance');
  const entity = findEntity(entityId);
  if (!piMeta || !entity || !entity.has(piMeta.trait)) return;
  markOverride(entityId, traitName, field);
}

function markFieldOverrideIfInstance(entityId: number, meta: TraitMeta, field: string): void {
  markOverrideIfInstance(entityId, meta.name, field);
}

/** Write a field with undo tracking */
export function writeTraitFieldWithUndo(entityId: number, meta: TraitMeta, field: string, value: unknown) {
  let oldValue: unknown;
  if (meta.category === 'tag') {
    const entity = findEntity(entityId);
    oldValue = entity ? entity.has(meta.trait) : false;
  } else {
    // readTraitDataFull (not the curated readTraitData) so off-meta fields — e.g. the
    // Animator `clips` bank, AudioSource clips, AoS object fields — capture their REAL
    // prior value; readTraitData drops them, so undo would restore `undefined` (wipe).
    const data = readTraitDataFull(entityId, meta);
    oldValue = data ? data[field] : undefined;
  }
  writeTraitField(entityId, meta, field, value);
  markFieldOverrideIfInstance(entityId, meta, field);
  // Capture a guid-based ref so undo/redo survive a world rebuild (Play→Stop).
  const ref = entityRef(entityId);
  _pushAction({
    label: `Edit ${meta.name}.${field || 'toggle'}`,
    undo: () => { const id = ref.resolve(); if (id == null) return; writeTraitField(id, meta, field, oldValue); },
    redo: () => { const id = ref.resolve(); if (id == null) return; writeTraitField(id, meta, field, value); markFieldOverrideIfInstance(id, meta, field); },
    coalesceKey: fieldCoalesceKey(meta, field, [entityId]),
    detail: editDetail([ref], meta, field, [oldValue], [value]),
  });
  // Animation record mode: key this field at the playhead (no-op unless recording).
  notifyFieldEdited(entityId, meta.name, field, value);
}

/** Write one field to the same trait across many entities, captured as a single
 *  undo entry. Each entity's prior value (or tag membership) is snapshotted
 *  individually so undo restores them even when they differed (mixed values).
 *  Only the named field is touched — other (possibly mixed) fields are left
 *  per-entity as they were. */
export function writeTraitFieldMultiWithUndo(entityIds: number[], meta: TraitMeta, field: string, value: unknown) {
  if (entityIds.length === 0) return;
  const oldValues = entityIds.map((id) => {
    if (meta.category === 'tag') {
      const entity = findEntity(id);
      return entity ? entity.has(meta.trait) : false;
    }
    const data = readTraitDataFull(id, meta); // off-meta fields (see writeTraitFieldWithUndo)
    return data ? data[field] : undefined;
  });
  entityIds.forEach((id) => { writeTraitField(id, meta, field, value); markFieldOverrideIfInstance(id, meta, field); });
  // Guid refs (positionally aligned with oldValues) so undo/redo survive a rebuild.
  const refs = entityIds.map((id) => entityRef(id));
  const suffix = entityIds.length > 1 ? ` (${entityIds.length})` : '';
  _pushAction({
    label: `Edit ${meta.name}.${field || 'toggle'}${suffix}`,
    undo: () => { const idx = buildGuidIndex(); refs.forEach((r, i) => { const id = resolveWith(r, idx); if (id != null) writeTraitField(id, meta, field, oldValues[i]); }); },
    redo: () => { const idx = buildGuidIndex(); refs.forEach((r) => { const id = resolveWith(r, idx); if (id != null) { writeTraitField(id, meta, field, value); markFieldOverrideIfInstance(id, meta, field); } }); },
    coalesceKey: fieldCoalesceKey(meta, field, entityIds),
    detail: editDetail(refs, meta, field, oldValues, refs.map(() => value)),
  });
  // Animation record mode: key each edited entity's field at the playhead.
  entityIds.forEach((id) => notifyFieldEdited(id, meta.name, field, value));
}

/** Write the same trait field across many entities where the NEW value is derived
 *  per-entity from that entity's CURRENT value, captured as one undo entry. Unlike
 *  writeTraitFieldMultiWithUndo (one value broadcast to all), this preserves each
 *  entity's other state — essential for fields holding composite values (e.g.
 *  UIAction.bindings, an array of objects) where the user edits ONE sub-field and
 *  every other sub-field must stay per-entity. `compute(oldValue, id)` returns the
 *  entity's new field value; return the old value unchanged to skip an entity. */
export function writeTraitFieldPerEntityWithUndo(
  entityIds: number[], meta: TraitMeta, field: string,
  compute: (oldValue: unknown, id: number) => unknown, label: string,
) {
  if (entityIds.length === 0) return;
  const entries = entityIds.map((id) => {
    // readTraitDataFull: `compute` derives the new value from the old, so an off-meta
    // field (Animator `clips` bank, etc.) MUST read its real value here — with the curated
    // readTraitData it came back undefined and `compute` wrote an empty bank (clip-name
    // rename wiped the whole clips list).
    const data = readTraitDataFull(id, meta);
    const oldValue = data ? data[field] : undefined;
    return { id, ref: entityRef(id), oldValue, newValue: compute(oldValue, id) };
  }).filter((e) => !Object.is(e.oldValue, e.newValue));
  if (entries.length === 0) return;
  // Resolve by guid each invocation (incl. the immediate apply) so redo survives a rebuild.
  const applyAll = () => {
    const idx = buildGuidIndex();
    entries.forEach(({ ref, newValue }) => { const id = resolveWith(ref, idx); if (id != null) { writeTraitField(id, meta, field, newValue); markFieldOverrideIfInstance(id, meta, field); } });
  };
  applyAll();
  const suffix = entries.length > 1 ? ` (${entries.length})` : '';
  _pushAction({
    label: `${label}${suffix}`,
    undo: () => { const idx = buildGuidIndex(); entries.forEach(({ ref, oldValue }) => { const id = resolveWith(ref, idx); if (id != null) writeTraitField(id, meta, field, oldValue); }); },
    redo: applyAll,
    coalesceKey: fieldCoalesceKey(meta, field, entityIds),
    detail: editDetail(entries.map((e) => e.ref), meta, field, entries.map((e) => e.oldValue), entries.map((e) => e.newValue)),
  });
  entries.forEach(({ id, newValue }) => notifyFieldEdited(id, meta.name, field, newValue));
}

/** Write SEVERAL fields of one trait per-entity as a SINGLE undo entry. `compute`
 *  receives the entity's FULL live trait data (including AoS object/array fields not in
 *  meta.fields, via readTraitDataFull) and returns a partial patch {field: newValue}.
 *  Use for compound edits that must undo in one step — e.g. a SpriteAnimator track
 *  rename/add/delete that touches both `clips` and the active `clip`. Resolves entities
 *  by guid at apply-time so undo/redo survive Play→Stop world rebuilds.
 *  NOTE (Percept V1): this compound multi-field helper does NOT attach a structured
 *  `EditDetail` — that shape describes a single {field, old, new}, which can't represent
 *  a multi-field patch. Its `!edit` journal event is label-only. Reachable via
 *  SpriteAnimator clip/track ops; the single-field helpers above carry full detail. */
export function writeTraitFieldsPerEntityWithUndo(
  entityIds: number[], meta: TraitMeta,
  compute: (oldFull: Record<string, unknown> | null, id: number) => Record<string, unknown>,
  label: string,
) {
  if (entityIds.length === 0) return;
  const entries = entityIds.map((id) => {
    const full = readTraitDataFull(id, meta);
    const patch = compute(full, id);
    const oldValues: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) oldValues[k] = full ? full[k] : undefined;
    return { id, ref: entityRef(id), oldValues, patch };
  }).filter((e) => Object.keys(e.patch).length > 0);
  if (entries.length === 0) return;
  const writeMany = (id: number, values: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(values)) { writeTraitField(id, meta, field, value); markFieldOverrideIfInstance(id, meta, field); }
  };
  const applyAll = () => {
    const idx = buildGuidIndex();
    entries.forEach(({ ref, patch }) => { const id = resolveWith(ref, idx); if (id != null) writeMany(id, patch); });
  };
  applyAll();
  const suffix = entries.length > 1 ? ` (${entries.length})` : '';
  _pushAction({
    label: `${label}${suffix}`,
    undo: () => { const idx = buildGuidIndex(); entries.forEach(({ ref, oldValues }) => { const id = resolveWith(ref, idx); if (id != null) writeMany(id, oldValues); }); },
    redo: applyAll,
  });
  entries.forEach(({ id, patch }) => { for (const [field, value] of Object.entries(patch)) notifyFieldEdited(id, meta.name, field, value); });
}

/** Keys of `values` the trait actually declares. A clipboard entry captured before a
 *  registry change can carry fields the trait has since dropped. AoS traits expose
 *  `schema` as a function — nothing to filter against, so the values pass through and
 *  the trait factory takes what it knows. */
export function filterToTraitSchema(meta: TraitMeta, values: Record<string, unknown>): Record<string, unknown> {
  const schema = (meta.trait as { schema?: unknown }).schema;
  if (!schema || typeof schema !== 'object') return values;
  return Object.fromEntries(Object.entries(values).filter(([k]) => k in (schema as object)));
}

/** Add a component trait to every selected entity that doesn't already have it,
 *  as a single undo entry. Entities that already carry the trait are skipped so
 *  their existing data isn't clobbered. No-op (no undo entry) if all already have it.
 *
 *  `values` (optional) prefills the new trait — this is what "Paste Component As New"
 *  is: an add-component that isn't left at defaults. It lives here rather than in a
 *  separate paste action because add-and-populate must be ONE undo entry (composing
 *  add + write would push two, and a single Cmd+Z would leave a half-pasted component
 *  behind), and because a parallel copy of this body would silently miss future fixes
 *  to the add path. Values are cloned per entity so two pasted entities never share an
 *  array. `label` overrides the action label ("Paste X As New" vs "Add X"). */
export function addTraitToEntitiesWithUndo(
  entityIds: number[], meta: TraitMeta,
  values?: Record<string, unknown>,
  label = `Add ${meta.name}`,
) {
  const targets = entityIds.filter((id) => {
    const e = findEntity(id);
    return !!e && !e.has(meta.trait);
  });
  if (targets.length === 0) return;
  const initial = values ? filterToTraitSchema(meta, values) : undefined;
  const refs = targets.map((id) => entityRef(id));
  const apply = () => {
    const idx = buildGuidIndex();
    refs.forEach((r) => {
      const id = resolveWith(r, idx);
      // Clone per entity AND per apply: without it, redo would re-seat the same
      // object on every target and they'd share one array.
      if (id != null) findEntity(id)?.add(initial ? meta.trait(cloneTraitValues(initial)) : meta.trait());
    });
    markUIDirty(); markStructureDirty();
  };
  const revert = () => {
    const idx = buildGuidIndex();
    refs.forEach((r) => { const id = resolveWith(r, idx); if (id != null) findEntity(id)?.remove(meta.trait); });
    markUIDirty(); markStructureDirty();
  };
  apply();
  _pushAction({
    label: `${label}${targets.length > 1 ? ` (${targets.length})` : ''}`,
    undo: revert,
    redo: apply,
  });
  // Prefilled fields are real field edits: tell the animation recorder, exactly as the
  // trait-field writers do. Without this an armed Auto-Key misses a pasted component's
  // values while catching a Paste-Values onto an existing one.
  if (initial) {
    targets.forEach((id) => {
      for (const [field, value] of Object.entries(initial)) notifyFieldEdited(id, meta.name, field, value);
    });
  }
}

/** Remove a component trait from every selected entity that has it, as a single
 *  undo entry. Each entity's trait data is snapshotted so undo restores the
 *  original values. No-op if none carry the trait. */
export function removeTraitFromEntitiesWithUndo(entityIds: number[], meta: TraitMeta) {
  const targets: { ref: EntityRef; data: Record<string, unknown> | null }[] = [];
  for (const id of entityIds) {
    const e = findEntity(id);
    if (e && e.has(meta.trait)) targets.push({ ref: entityRef(id), data: readTraitData(id, meta) });
  }
  if (targets.length === 0) return;
  const apply = () => {
    const idx = buildGuidIndex();
    targets.forEach((t) => { const id = resolveWith(t.ref, idx); if (id != null) findEntity(id)?.remove(meta.trait); });
    markUIDirty(); markStructureDirty();
  };
  const revert = () => {
    const idx = buildGuidIndex();
    targets.forEach((t) => { const id = resolveWith(t.ref, idx); if (id != null) findEntity(id)?.add(meta.trait((t.data ?? {}) as Record<string, unknown>)); });
    markUIDirty(); markStructureDirty();
  };
  apply();
  _pushAction({
    label: `Remove ${meta.name}${targets.length > 1 ? ` (${targets.length})` : ''}`,
    undo: revert,
    redo: apply,
  });
}

/** Paste copied trait values onto every selected entity that ALREADY carries the
 *  trait, as a single undo entry. Fields are matched against each target's own
 *  live keys, so a clipboard entry captured before a trait gained/lost a field
 *  pastes the overlap rather than writing a stale key. Values are cloned per
 *  entity (see `cloneTraitValues`) so pasting onto several entities never leaves
 *  them sharing one array. Prefab-instance overrides are marked by the underlying
 *  writer. No-op if no target carries the trait or nothing overlaps.
 *  Caller must ensure `values` came from this same trait — see `isTraitCopyable`
 *  + the exact-name match the Inspector's Paste Values enforces. */
export function pasteTraitValuesWithUndo(entityIds: number[], meta: TraitMeta, values: Record<string, unknown>) {
  const targets = entityIds.filter((id) => {
    const e = findEntity(id);
    return !!e && e.has(meta.trait);
  });
  if (targets.length === 0) return;
  writeTraitFieldsPerEntityWithUndo(targets, meta, (oldFull) => {
    if (!oldFull) return {};
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(oldFull)) if (key in values) patch[key] = values[key];
    return cloneTraitValues(patch);
  }, `Paste ${meta.name} Values`);
}

/** Paste copied trait values as a NEW component on every selected entity that lacks the
 *  trait, as a single undo entry (undo removes the trait outright). Thin alias for the
 *  prefilled `addTraitToEntitiesWithUndo` — see there for why add-and-populate is one
 *  action. Entities that already carry the trait keep their values. */
export function pasteTraitAsNewWithUndo(entityIds: number[], meta: TraitMeta, values: Record<string, unknown>) {
  addTraitToEntitiesWithUndo(entityIds, meta, values, `Paste ${meta.name} As New`);
}

// ── Action callback (for backward compat during migration) ──

type ActionCallback = (action: { label: string; undo: () => void; redo: () => void; coalesceKey?: string; detail?: EditDetail; kind?: string; journalPayload?: Record<string, unknown> }) => void;

/** GUID for a parent id in a structural journal payload: 'root' for 0, else the
 *  entity's stable guid (stringified raw id only for an un-guidable entity). */
function parentGuid(parentId: number): string {
  return parentId ? (entityRef(parentId).guid || String(parentId)) : 'root';
}

/** Build the structured `!edit` diff (Percept V1) from positionally-aligned refs +
 *  old/new value arrays. Uses each ref's stable guid (raw-id string only for an
 *  un-guidable entity). `refs`, `olds`, `news` must be index-aligned. */
function editDetail(refs: EntityRef[], meta: TraitMeta, field: string, olds: unknown[], news: unknown[]): EditDetail {
  return {
    trait: meta.name,
    field: field || '',
    entities: refs.map((r) => r.guid || String(r.rawId)),
    old: olds,
    new: news,
  };
}

/** Coalesce key for a field edit: per-keystroke writes to the SAME field on the
 *  SAME entity set merge into one undo entry (editor-inspector.md F6 / undoManager
 *  COALESCE_MS window). Value edits only — tag toggles are discrete clicks, not
 *  keystrokes, so they each stay their own undo step (coalesceKey undefined). */
function fieldCoalesceKey(meta: TraitMeta, field: string, ids: number[]): string | undefined {
  if (meta.category === 'tag') return undefined;
  return `field:${[...ids].sort((a, b) => a - b).join(',')}:${meta.name}.${field}`;
}
let _pushAction: ActionCallback = pushAction;

export function setActionCallback(cb: ActionCallback) { _pushAction = cb; }

// ── Delete with undo ──

export interface EntitySnapshot {
  id: number;
  traits: { meta: TraitMeta; data: Record<string, unknown> | true }[];
  children: EntitySnapshot[];
}

export function snapshotEntity(entityId: number): EntitySnapshot | null {
  const entity = findEntity(entityId);
  if (!entity) return null;
  const traits: EntitySnapshot['traits'] = [];
  for (const meta of getAllTraits()) {
    if (!entity.has(meta.trait)) continue;
    if (meta.category === 'tag') { traits.push({ meta, data: true }); }
    else { const data = readTraitData(entityId, meta); if (data) traits.push({ meta, data: { ...data } }); }
  }
  const childEntities = getAllEntities().filter(e => e.parentId === entityId);
  const children = childEntities.map(c => snapshotEntity(c.id)).filter((s): s is EntitySnapshot => s !== null);
  return { id: entityId, traits, children };
}

/** Deep-clone a snapshot, assigning a FRESH EntityAttributes.guid to every entity
 *  in the subtree. Used by duplicate: respawnFromSnapshot copies traits verbatim
 *  (including guid), so without this a duplicated entity shares the source's guid.
 *  Colliding guids break anything keyed on guid — selection restore, prefab
 *  structural-override keys (the duplicate-key React crash), asset refs. The clone
 *  is computed ONCE in duplicateEntity so undo→redo re-spawns the same identity. */
export function regenerateSnapshotGuids(snapshot: EntitySnapshot): EntitySnapshot {
  const traits = snapshot.traits.map((t) => {
    if (t.data === true || t.meta.name !== 'EntityAttributes') return t;
    return { meta: t.meta, data: { ...t.data, guid: newGuid() } };
  });
  return { id: snapshot.id, traits, children: snapshot.children.map(regenerateSnapshotGuids) };
}

/** How a duplicate/paste of a prefab-instance entity should be handled (prefab F1):
 *  - 'root'   — the entity is an instance ROOT (`PrefabInstance.rootInstanceId === itself`).
 *               The copy becomes a NEW linked instance: keep PrefabInstance, but re-root it
 *               (rewrite `rootInstanceId` across the copied subtree) so its members point at
 *               their own root, not the source's — see `reRootPrefabInstanceSubtree`.
 *  - 'member' — the entity is a non-root instance MEMBER (a child inside an instance). The
 *               copy becomes an ADDED child of the same instance — i.e. plain entities with
 *               NO PrefabInstance, exactly as if the user added a new child (captureInstance-
 *               Structure picks up non-member descendants of a member as `added`). Strip it.
 *  - 'none'   — not a prefab instance; ordinary duplicate.
 *  Classified from the captured SNAPSHOT (not the live entity) so paste works even
 *  after the source is gone: the snapshot root's `.id` is the original source ECS id,
 *  and an instance ROOT is the one whose `PrefabInstance.rootInstanceId` points at it. */
export function classifyPrefabDuplicate(snapshot: EntitySnapshot): 'none' | 'root' | 'member' {
  const pi = snapshot.traits.find((t) => t.data !== true && t.meta.name === 'PrefabInstance');
  if (!pi || pi.data === true) return 'none';
  const rootInstanceId = (pi.data as Record<string, unknown>).rootInstanceId as number;
  return rootInstanceId === snapshot.id ? 'root' : 'member';
}

/** Deep-clone a snapshot with `PrefabInstance` stripped from every entity in the
 *  subtree. Used by duplicate/paste of a non-root instance MEMBER so the copy
 *  becomes a plain ADDED child of the instance (prefab F1, 'member' case). Must
 *  NOT touch the delete-undo restore path, which keeps instance linkage. */
export function stripPrefabInstanceFromSnapshot(snapshot: EntitySnapshot): EntitySnapshot {
  return {
    id: snapshot.id,
    traits: snapshot.traits.filter((t) => t.meta.name !== 'PrefabInstance'),
    children: snapshot.children.map(stripPrefabInstanceFromSnapshot),
  };
}

/** Re-root a freshly-respawned prefab-instance copy: rewrite `PrefabInstance.rootInstanceId`
 *  to `newRootId` on every PrefabInstance-bearing entity in the new subtree, so the copy is
 *  its OWN linked instance (disjoint rootInstanceId group from the source). `source`/`localId`
 *  are unchanged — it stays an instance of the same prefab. Run post-respawn on BOTH the
 *  initial spawn and redo (fresh ECS ids each time). prefab F1, 'root' case. */
export function reRootPrefabInstanceSubtree(newRootId: number): void {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return;
  const childrenOf = new Map<number, number[]>();
  for (const e of getAllEntities()) {
    if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
    childrenOf.get(e.parentId)!.push(e.id);
  }
  const stack = [newRootId];
  while (stack.length) {
    const id = stack.pop()!;
    const en = findEntity(id);
    if (en?.has(piMeta.trait)) writeTraitField(id, piMeta, 'rootInstanceId', newRootId);
    for (const c of childrenOf.get(id) || []) stack.push(c);
  }
}

export function respawnFromSnapshot(snapshot: EntitySnapshot, newParentId: number = 0): number {
  const traitArgs: any[] = [];
  for (const { meta, data } of snapshot.traits) {
    if (data === true) { traitArgs.push(meta.trait()); }
    else {
      const patched = meta.name === 'EntityAttributes' ? { ...data, parentId: newParentId } : data;
      traitArgs.push(meta.trait(patched as Record<string, unknown>));
    }
  }
  const entity = getCurrentWorld().spawn(...traitArgs);
  registerEntity(entity);
  const newId = entity.id();
  for (const child of snapshot.children) { respawnFromSnapshot(child, newId); }
  return newId;
}

/** The EntityAttributes.guid carried in a snapshot's root traits ('' if none).
 *  respawnFromSnapshot restores this verbatim, so it's the stable handle to the
 *  respawned entity across a world rebuild. */
function rootGuidOf(snap: EntitySnapshot): string {
  const ea = snap.traits.find((t) => t.data !== true && t.meta.name === 'EntityAttributes');
  return ea && ea.data !== true ? ((ea.data as Record<string, unknown>).guid as string) || '' : '';
}

/** Resolve a snapshot's root guid to the current live id, or null. */
function findByRootGuid(guid: string): number | null {
  if (!guid) return null;
  return buildGuidIndex().get(guid) ?? null;
}

// ── Create with undo ──

export interface TraitSpec { name: string; data?: Record<string, unknown> }

/** Spawn an entity from trait specs, select it, and push a create/delete undo action.
 *  `selectEntity` is injected so this stays free of the editor store and unit-testable.
 *  Returns the new entity id, or null if a referenced trait isn't registered. */
export function createEntityWithUndo(
  label: string,
  parentId: number,
  traitSpecs: TraitSpec[],
  selectEntity: (id: number | null) => void,
): number | null {
  const allTraitsList = getAllTraits();
  // Auto-assign sortOrder to (max sibling sortOrder + 1) so new entities go to the end
  // and have unique values — required for drag-to-reorder to compute distinct positions.
  const siblings = getAllEntities().filter(e => e.parentId === parentId);
  const nextSort = siblings.length > 0 ? Math.max(...siblings.map(s => s.sortOrder)) + 1 : 0;
  const traitInits: any[] = [];
  for (const spec of traitSpecs) {
    const meta = allTraitsList.find(t => t.name === spec.name);
    if (!meta) { console.error(`[createEntity] Cannot create entity: ${spec.name} trait not registered`); return null; }
    const data = spec.name === 'EntityAttributes' && spec.data && spec.data.sortOrder === undefined
      ? { ...spec.data, sortOrder: nextSort }
      : spec.data;
    traitInits.push(data !== undefined ? meta.trait(data) : meta.trait());
  }
  const entity = getCurrentWorld().spawn(...traitInits);
  registerEntity(entity);
  let currentId = entity.id();
  // Mint+persist a guid BEFORE snapshotting so the snapshot carries it: respawn
  // restores the same guid and the Play snapshot serializes it, so undo/redo can
  // re-find the entity after a world rebuild.
  ensureGuid(currentId);
  const snap = snapshotEntity(currentId);
  const guid = rootGuidOf(snap!);
  const parentRef = parentId ? entityRef(parentId) : null;
  selectEntity(currentId);
  _pushAction({
    label,
    undo: () => { const id = findByRootGuid(guid) ?? (findEntity(currentId) ? currentId : null); if (id != null) deleteEntity(id); selectEntity(null); },
    redo: () => { if (snap) { currentId = respawnFromSnapshot(snap, parentRef?.resolve() ?? 0); selectEntity(currentId); } },
    kind: '!create',
    journalPayload: { entity: guid || String(currentId), parent: parentGuid(parentId) },
  });
  return currentId;
}

/** A nested entity subtree spec: traits for this node + recursive children. */
export interface SubtreeSpec { traits: TraitSpec[]; children?: SubtreeSpec[] }

/** Create a nested entity SUBTREE (an entity + recursive children) as ONE undo action —
 *  undo removes the whole subtree, redo respawns it. Mirrors createEntityWithUndo but
 *  for a hierarchy (e.g. a SkinnedSprite2D + its Bone2D chain). Each node's
 *  EntityAttributes.parentId is forced to its actual spawned parent, so the caller's
 *  specs don't need to know the ids. */
/** Spawn a nested entity subtree WITHOUT undo — returns the root id (or null). Each
 *  node's EntityAttributes.parentId is forced to its actual spawned parent. Used by
 *  createEntitySubtreeWithUndo and by prefab generation (spawn → serialize → delete). */
export function spawnEntitySubtree(parentId: number, root: SubtreeSpec): number | null {
  const allTraitsList = getAllTraits();
  const spawnNode = (node: SubtreeSpec, parent: number): number | null => {
    const siblings = getAllEntities().filter((e) => e.parentId === parent);
    const nextSort = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sortOrder)) + 1 : 0;
    const inits: any[] = [];
    for (const spec of node.traits) {
      const meta = allTraitsList.find((t) => t.name === spec.name);
      if (!meta) { console.error(`[spawnEntitySubtree] Cannot create: ${spec.name} trait not registered`); return null; }
      let data = spec.data;
      if (spec.name === 'EntityAttributes') {
        data = { ...(spec.data ?? {}), parentId: parent };
        if ((data as Record<string, unknown>).sortOrder === undefined) (data as Record<string, unknown>).sortOrder = nextSort;
      }
      inits.push(data !== undefined ? meta.trait(data) : meta.trait());
    }
    const ent = getCurrentWorld().spawn(...inits);
    registerEntity(ent);
    const id = ent.id();
    ensureGuid(id);
    for (const child of node.children ?? []) spawnNode(child, id);
    return id;
  };
  const rootId = spawnNode(root, parentId);
  if (rootId != null) markStructureDirty();
  return rootId;
}

export function createEntitySubtreeWithUndo(
  label: string,
  parentId: number,
  root: SubtreeSpec,
  selectEntity: (id: number | null) => void,
): number | null {
  const rootId = spawnEntitySubtree(parentId, root);
  if (rootId == null) return null;
  let currentId = rootId;
  const snap = snapshotEntity(currentId);
  const guid = rootGuidOf(snap!);
  const parentRef = parentId ? entityRef(parentId) : null;
  selectEntity(currentId);
  _pushAction({
    label,
    undo: () => { const id = findByRootGuid(guid) ?? (findEntity(currentId) ? currentId : null); if (id != null) deleteEntity(id); selectEntity(null); },
    redo: () => { if (snap) { currentId = respawnFromSnapshot(snap, parentRef?.resolve() ?? 0); selectEntity(currentId); } },
    kind: '!create',
    journalPayload: { entity: guid || String(currentId), parent: parentGuid(parentId) },
  });
  return currentId;
}

// ── Duplicate with undo ──

/** Deep-duplicate an entity (and all its children) into the SAME parent as the
 *  original, select the copy, and push a duplicate/delete undo action.
 *  Mirrors the create/delete pattern: snapshotEntity deep-captures the subtree
 *  (traits + children, recursively), respawnFromSnapshot rebuilds it.
 *  `selectEntity` is injected so this stays free of the editor store and unit-testable.
 *  Returns the new entity id, or null if the source entity doesn't exist. */
export function duplicateEntity(
  entityId: number,
  selectEntity: (id: number | null) => void,
): number | null {
  const captured = snapshotEntity(entityId);
  if (!captured) return null;
  // Prefab-instance handling (prefab F1): duplicating an instance ROOT makes a new
  // linked instance (re-root post-spawn); duplicating a non-root MEMBER makes a
  // plain ADDED child (strip PrefabInstance). Ordinary entities: 'none'.
  const prefabKind = classifyPrefabDuplicate(captured);
  // Mint fresh guids for the whole copied subtree ONCE (stable across undo/redo).
  // Without this the copy inherits the source's guid → collisions that break
  // guid-keyed logic (prefab "+added.<guid>" override keys, selection restore).
  let snapshot = regenerateSnapshotGuids(captured);
  if (prefabKind === 'member') snapshot = stripPrefabInstanceFromSnapshot(snapshot);
  // Duplicate into the same parent as the original.
  const attrMeta = getAllTraits().find(m => m.name === 'EntityAttributes');
  const attrData = attrMeta ? readTraitData(entityId, attrMeta) : null;
  const parentId = (attrData?.parentId as number) || 0;

  // respawnFromSnapshot copies the source's EntityAttributes — including its
  // sortOrder — verbatim, so the fresh copy would collide with the source's
  // sortOrder among the same parent's children, breaking drag-to-reorder's
  // distinct-position math. Reassign (max sibling sortOrder + 1) post-spawn,
  // mirroring createEntityWithUndo's auto-assignment. Excludes the duplicate
  // itself from the max so the copied value can't inflate the result.
  const assignFreshSortOrder = (newId: number, resolvedParentId: number) => {
    if (!attrMeta) return;
    const siblings = getAllEntities().filter(e => e.parentId === resolvedParentId && e.id !== newId);
    const nextSort = siblings.length > 0 ? Math.max(...siblings.map(s => s.sortOrder)) + 1 : 0;
    writeTraitField(newId, attrMeta, 'sortOrder', nextSort);
  };

  // regenerateSnapshotGuids already minted a fresh root guid; use it as the
  // stable handle so undo/redo survive a world rebuild. Parent resolved by ref.
  const guid = rootGuidOf(snapshot);
  const parentRef = parentId ? entityRef(parentId) : null;
  // Spawn + post-spawn fixups (sortOrder, and re-root for an instance-root copy).
  // Shared by the initial spawn and redo so identity stays consistent.
  const spawnCopy = (p: number): number => {
    const id = respawnFromSnapshot(snapshot, p);
    assignFreshSortOrder(id, p);
    if (prefabKind === 'root') reRootPrefabInstanceSubtree(id);
    return id;
  };
  let currentId = spawnCopy(parentId);
  selectEntity(currentId);
  _pushAction({
    label: 'Duplicate Entity',
    undo: () => { const id = findByRootGuid(guid) ?? (findEntity(currentId) ? currentId : null); if (id != null) deleteEntity(id); selectEntity(null); },
    redo: () => {
      currentId = spawnCopy(parentRef?.resolve() ?? 0);
      selectEntity(currentId);
    },
    kind: '!duplicate',
    // Source guid from the attrData already read above — do NOT entityRef(entityId) here:
    // that mints+writes a guid to the SOURCE, dirtying authored data purely to log it.
    journalPayload: { entity: guid || String(currentId), source: ((attrData?.guid as string) || String(entityId)), parent: parentGuid(parentId) },
  });
  return currentId;
}

/** Delete many entities as a SINGLE coalesced undo entry.
 *  - Drops ids whose ancestor is also selected: the ancestor's snapshot already
 *    captures the whole subtree, so deleting both would double-handle it and
 *    corrupt the partial-undo state.
 *  - `setSelection` (optional) is a RAW selection setter that must NOT push its
 *    own undo entry (e.g. a direct store `setState`). Folding the selection
 *    change into this action's closures keeps one undo entry total: undo
 *    restores the entities AND reselects them; redo clears the selection.
 *  No-op (no undo entry) if nothing resolves to a live root. */
export function deleteEntitiesWithUndo(
  entityIds: number[],
  setSelection?: (ids: number[]) => void,
): void {
  if (entityIds.length === 0) return;

  // Keep only roots — an id whose parent chain hits another selected id is a
  // descendant and is captured by that ancestor's snapshot.
  const idSet = new Set(entityIds);
  const byId = new Map(getAllEntities().map(e => [e.id, e]));
  const isDescendantOfSelected = (id: number): boolean => {
    let cur = byId.get(id);
    while (cur && cur.parentId !== 0) {
      if (idSet.has(cur.parentId)) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  };

  const snaps: { snapshot: EntitySnapshot; guid: string; parentRef: EntityRef | null }[] = [];
  for (const id of entityIds) {
    if (isDescendantOfSelected(id)) continue;
    // Mint+persist a guid BEFORE snapshotting (a delete target may be guid-less)
    // so the snapshot carries it and redo can re-find the entity after a rebuild.
    ensureGuid(id);
    const snapshot = snapshotEntity(id);
    if (!snapshot) continue;
    let parentId = 0;
    for (const { meta, data } of snapshot.traits) {
      if (meta.name === 'EntityAttributes' && data !== true) {
        parentId = ((data as Record<string, unknown>).parentId as number) || 0;
        break;
      }
    }
    snaps.push({ snapshot, guid: rootGuidOf(snapshot), parentRef: parentId ? entityRef(parentId) : null });
  }
  if (snaps.length === 0) return;

  snaps.forEach(s => deleteEntity(s.snapshot.id));
  setSelection?.([]);

  _pushAction({
    label: snaps.length > 1 ? `Delete ${snaps.length} Entities` : 'Delete Entity',
    undo: () => {
      const liveIds = snaps.map(s => respawnFromSnapshot(s.snapshot, s.parentRef?.resolve() ?? 0));
      setSelection?.(liveIds);
    },
    redo: () => {
      // Resolve each entity by its (restored) root guid — robust across rebuild + id reuse.
      const idx = buildGuidIndex();
      snaps.forEach(s => { const id = idx.get(s.guid); if (id) deleteEntity(id); });
      setSelection?.([]);
    },
    kind: '!delete',
    journalPayload: { entities: snaps.map(s => s.guid || String(s.snapshot.id)) },
  });
}

export function deleteEntityWithUndo(entityId: number): void {
  // Mint+persist a guid BEFORE snapshotting so the snapshot carries it (the
  // entity may be guid-less) — undo respawns it, redo re-finds it by guid.
  ensureGuid(entityId);
  const snapshot = snapshotEntity(entityId);
  if (!snapshot) return;
  const originalParentId = (() => {
    for (const { meta, data } of snapshot.traits) {
      if (meta.name === 'EntityAttributes' && data !== true) return (data as Record<string, unknown>).parentId as number || 0;
    }
    return 0;
  })();
  const guid = rootGuidOf(snapshot);
  const parentRef = originalParentId ? entityRef(originalParentId) : null;
  deleteEntity(entityId);
  _pushAction({
    label: 'Delete Entity',
    // undo respawns from the snapshot (carries the guid); redo re-resolves the
    // live entity by that guid — robust to ID reuse and a world rebuild.
    undo: () => { respawnFromSnapshot(snapshot, parentRef?.resolve() ?? 0); },
    redo: () => { const id = findByRootGuid(guid); if (id != null) deleteEntity(id); },
    kind: '!delete',
    journalPayload: { entities: [guid || String(entityId)] },
  });
}

// ── Reparent with undo ──

function isAncestorOf(ancestorId: number, entityId: number): boolean {
  const entities = getAllEntities();
  const byId = new Map(entities.map(e => [e.id, e]));
  let current = byId.get(entityId);
  while (current && current.parentId !== 0) {
    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

function matrixFromTransform(tf: { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }): THREE.Matrix4 {
  const pos = new THREE.Vector3(tf.x, tf.y, tf.z);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(tf.rx, tf.ry, tf.rz));
  const scale = new THREE.Vector3(tf.sx, tf.sy, tf.sz);
  return new THREE.Matrix4().compose(pos, quat, scale);
}

function decomposeMatrix(mat: THREE.Matrix4): { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number } {
  const pos = new THREE.Vector3(); const quat = new THREE.Quaternion(); const scale = new THREE.Vector3();
  mat.decompose(pos, quat, scale);
  const euler = new THREE.Euler().setFromQuaternion(quat);
  return { x: pos.x, y: pos.y, z: pos.z, rx: euler.x, ry: euler.y, rz: euler.z, sx: scale.x, sy: scale.y, sz: scale.z };
}

/** True if `nodeId` is `rootId` or any descendant of it (i.e. inside that instance's
 *  subtree). Used by reparent's prefab-boundary check (panels F2). */
function isWithinInstanceSubtree(nodeId: number, rootId: number): boolean {
  const byId = new Map(getAllEntities().map((e) => [e.id, e]));
  let cur = byId.get(nodeId);
  while (cur) {
    if (cur.id === rootId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

export function reparentEntity(entityId: number, newParentId: number, newSortOrder?: number): boolean {
  if (entityId === newParentId) return false;
  if (newParentId !== 0 && isAncestorOf(entityId, newParentId)) return false;

  const allTraits = getAllTraits();
  const transformMeta = allTraits.find(m => m.name === 'Transform');
  const attrMeta = allTraits.find(m => m.name === 'EntityAttributes');
  if (!attrMeta) return false;

  const oldAttr = readTraitData(entityId, attrMeta);
  if (!oldAttr) return false;
  const oldParentId = (oldAttr.parentId as number) || 0;
  const oldSortOrder = (oldAttr.sortOrder as number) || 0;
  const oldFolder = (oldAttr.editorFolder as string) || '';

  const parentChanged = oldParentId !== newParentId;
  const orderChanged = newSortOrder !== undefined && newSortOrder !== oldSortOrder;
  if (!parentChanged && !orderChanged) return false;

  // Maintenance rule: editorFolder (the Hierarchy grouping tag) is only valid on
  // ROOTS. When an entity gains a parent it stops being a root, so drop its folder
  // tag — folded into this action's undo/redo so Cmd+Z restores the tag too.
  const clearFolder = parentChanged && newParentId !== 0 && oldFolder !== '';

  // Compensate local transform to preserve world position (only if entity has Transform)
  const fields = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const;
  let oldLocal: Record<string, any> | null = null;
  let newLocal: Record<string, number> | null = null;

  if (parentChanged && transformMeta) {
    oldLocal = readTraitData(entityId, transformMeta);
    if (oldLocal) {
      const entityWorld = worldTransforms.get(entityId);
      const entityWorldMatrix = entityWorld
        ? matrixFromTransform(entityWorld)
        : matrixFromTransform(oldLocal as any);
      let newParentWorldMatrix = new THREE.Matrix4();
      if (newParentId !== 0) {
        const parentWorld = worldTransforms.get(newParentId);
        if (parentWorld) newParentWorldMatrix = matrixFromTransform(parentWorld);
      }
      const invParent = newParentWorldMatrix.clone().invert();
      newLocal = decomposeMatrix(new THREE.Matrix4().multiplyMatrices(invParent, entityWorldMatrix));
      for (const f of fields) writeTraitField(entityId, transformMeta, f, newLocal[f]);
    }
  }

  if (parentChanged) writeTraitField(entityId, attrMeta, 'parentId', newParentId);
  if (newSortOrder !== undefined) writeTraitField(entityId, attrMeta, 'sortOrder', newSortOrder);
  if (clearFolder) writeTraitField(entityId, attrMeta, 'editorFolder', '');

  // Prefab-boundary auto-detach (panels F2): if the moved entity is a prefab MEMBER
  // and its new parent is OUTSIDE its instance subtree, strip PrefabInstance from the
  // moved member subtree so it becomes plain entities ("unpack on move", user-chosen).
  // A plain entity (no PrefabInstance) is untouched — dropping it INTO an instance just
  // makes it an added child, which the override system already captures. Detach is part
  // of this action's undo/redo so Cmd+Z restores the instance linkage too.
  const piMeta = getTraitByName('PrefabInstance');
  const detachTargets: { ref: EntityRef; data: Record<string, unknown> }[] = [];
  if (piMeta && parentChanged) {
    const moved = findEntity(entityId);
    if (moved?.has(piMeta.trait)) {
      const rootId = (moved.get(piMeta.trait) as Record<string, unknown>).rootInstanceId as number;
      if (!isWithinInstanceSubtree(newParentId, rootId)) {
        const byParent = new Map<number, number[]>();
        for (const e of getAllEntities()) {
          if (!byParent.has(e.parentId)) byParent.set(e.parentId, []);
          byParent.get(e.parentId)!.push(e.id);
        }
        const stack = [entityId];
        while (stack.length) {
          const id = stack.pop()!;
          const en = findEntity(id);
          if (en?.has(piMeta.trait)) {
            const pd = en.get(piMeta.trait) as Record<string, unknown>;
            if ((pd.rootInstanceId as number) === rootId) detachTargets.push({ ref: entityRef(id), data: { ...pd } });
          }
          for (const c of byParent.get(id) || []) stack.push(c);
        }
      }
    }
  }
  const applyDetach = () => {
    if (!piMeta) return;
    const idx = buildGuidIndex();
    for (const t of detachTargets) { const id = resolveWith(t.ref, idx); if (id != null) findEntity(id)?.remove(piMeta.trait); }
  };
  const undoDetach = () => {
    if (!piMeta) return;
    const idx = buildGuidIndex();
    for (const t of detachTargets) { const id = resolveWith(t.ref, idx); if (id != null) findEntity(id)?.add(piMeta.trait(t.data)); }
  };
  if (detachTargets.length) applyDetach();
  markStructureDirty();

  const savedOldLocal = oldLocal ? { ...oldLocal } : null;
  const savedNewParentId = newParentId;
  const savedNewSortOrder = newSortOrder ?? oldSortOrder;
  const savedNewLocal = newLocal;

  const entityName = getAllEntities().find(e => e.id === entityId)?.name || `Entity ${entityId}`;
  const parentName = newParentId === 0 ? 'root' : (getAllEntities().find(e => e.id === newParentId)?.name || `Entity ${newParentId}`);
  const label = parentChanged ? `Reparent "${entityName}" → ${parentName}` : `Reorder "${entityName}"`;

  // Guid refs so undo/redo survive a world rebuild. Root (0) stays literal 0.
  const ref = entityRef(entityId);
  const oldParentRef = oldParentId ? entityRef(oldParentId) : null;
  const newParentRef = savedNewParentId ? entityRef(savedNewParentId) : null;

  _pushAction({
    label,
    undo: () => {
      const id = ref.resolve(); if (id == null) return;
      if (detachTargets.length) undoDetach(); // re-tag the detached members first
      writeTraitField(id, attrMeta!, 'parentId', oldParentRef?.resolve() ?? 0);
      writeTraitField(id, attrMeta!, 'sortOrder', oldSortOrder);
      if (clearFolder) writeTraitField(id, attrMeta!, 'editorFolder', oldFolder);
      if (savedOldLocal && transformMeta) { for (const f of fields) writeTraitField(id, transformMeta, f, savedOldLocal[f]); }
      markStructureDirty();
    },
    redo: () => {
      const id = ref.resolve(); if (id == null) return;
      writeTraitField(id, attrMeta!, 'parentId', newParentRef?.resolve() ?? 0);
      writeTraitField(id, attrMeta!, 'sortOrder', savedNewSortOrder);
      if (clearFolder) writeTraitField(id, attrMeta!, 'editorFolder', '');
      if (savedNewLocal && transformMeta) { for (const f of fields) writeTraitField(id, transformMeta, f, savedNewLocal[f]); }
      if (detachTargets.length) applyDetach(); // re-strip after the move
      markStructureDirty();
    },
    kind: '!reparent',
    // `from`/`to` are parent guids ('root' for scene root); equal when this is a pure
    // reorder (sortOrder change under the same parent).
    journalPayload: { entity: ref.guid || String(entityId), from: parentGuid(oldParentId), to: parentGuid(savedNewParentId), reorder: !parentChanged },
  });

  return true;
}
