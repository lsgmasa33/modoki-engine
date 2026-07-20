/** Entity utilities — read/write traits, query entities, delete.
 *  Pure runtime functions with no undo or Three.js dependency. */

import type { Trait, TraitRecord, ExtractSchema, TraitValue } from 'koota';
import { getCurrentWorld, findEntityById, unregisterEntity, setStructureCallback } from './world';
import { getAllTraits, transformName, type TraitMeta } from './traitRegistry';
import { EntityAttributes } from '../traits/EntityAttributes';

// Pluggable dirty listeners — multiple systems (uiTreeStore, the editor's
// Canvas2DLayer) register callbacks to be notified on any ECS trait write.
const _dirtyListeners: Set<() => void> = new Set();
/** Register a dirty listener. Returns an unsubscribe function. */
export function addDirtyListener(fn: () => void): () => void {
  _dirtyListeners.add(fn);
  return () => { _dirtyListeners.delete(fn); };
}
/** Fire ALL registered dirty listeners (NOT UI-specific — it just notifies every
 *  subscriber, one of which is uiTreeStore.markUIDirty). Renamed from the former
 *  `markUIDirty` to end the name collision with the UI-flag setter of the same name
 *  in uiTreeStore (F7). Use after a direct trait write that bypasses writeTraitField
 *  (e.g. a bulk `entity.set` from a gizmo drag), so the Inspector and other subscribers
 *  refresh. writeTraitField already calls this internally. */
export function fireDirtyListeners() { for (const fn of _dirtyListeners) fn(); }

// Structure-dirty subscriber set — notifies Hierarchy, Console, etc. when
// entities are created, deleted, or reparented. Multiple subscribers supported.
const _structureListeners = new Set<() => void>();
let _structureVersion = 0;
/** Subscribe to structural entity changes (create/delete/reparent).
 *  Returns an unsubscribe function. */
export function onStructureDirty(fn: () => void): () => void {
  _structureListeners.add(fn);
  return () => { _structureListeners.delete(fn); };
}
/** Like {@link onStructureDirty} but COALESCES bursts: a bulk operation (loading a
 *  scene with many prefab instances registers one entity — and fires
 *  markStructureDirty — per entity) invokes `fn` at most ONCE per animation frame
 *  instead of once per entity. Essential for React subscribers that `setState` in
 *  the callback: firing per-entity during a synchronous load storm blows React's
 *  update-depth limit ("Maximum update depth exceeded") and re-renders the panel
 *  dozens of times; deferring to a rAF collapses it to a single post-load render.
 *  Returns an unsubscribe function that also cancels any pending frame. */
export function onStructureDirtyCoalesced(fn: () => void): () => void {
  let raf = 0; // 0 = nothing scheduled
  const hasRAF = typeof requestAnimationFrame !== 'undefined';
  const flush = () => { raf = 0; fn(); };
  const unsub = onStructureDirty(() => {
    if (raf) return; // already scheduled for this frame
    raf = hasRAF ? requestAnimationFrame(flush) : (setTimeout(flush, 0) as unknown as number);
  });
  return () => {
    unsub();
    if (raf) { if (hasRAF) cancelAnimationFrame(raf); else clearTimeout(raf); raf = 0; }
  };
}
/** Monotonic counter incremented on every markStructureDirty. Subscribers can
 *  capture this in a ref and skip rebuilds when it hasn't changed — much cheaper
 *  than hashing the entity list. */
export function getStructureVersion(): number { return _structureVersion; }
/** Notify all structure-dirty subscribers. */
export function markStructureDirty() {
  _structureVersion++;
  for (const fn of _structureListeners) fn();
}
// Wire world.ts registerEntity → markStructureDirty (avoids circular import)
setStructureCallback(markStructureDirty);

/** Safe world.query — returns null if the trait hasn't been initialized in the world yet (koota quirk). */
function safeQuery(trait: any) {
  try { return getCurrentWorld().query(trait); } catch { return null; }
}

/** Find an entity by ID. O(1) via entity index, with fallback scan for
 *  entities not registered via registerEntity (e.g. in tests). */
export function findEntity(entityId: number) {
  const fromIndex = findEntityById(entityId);
  if (fromIndex) return fromIndex;

  // Fallback: walk the world's entity list directly (koota exposes .entities)
  const world = getCurrentWorld();
  for (const e of (world as any).entities ?? []) {
    if ((e as any).id?.() === entityId) {
      // Production code should always go through registerEntity so this O(n)
      // fallback never fires. In dev, warn so missing registrations get fixed.
      if (import.meta.env?.DEV) {
        console.warn(`[entityUtils] findEntity(${entityId}) hit O(n) fallback — entity was not registered via registerEntity()`);
      }
      return e;
    }
  }
  return null;
}

/** Get all registered traits present on an entity */
export function getEntityTraits(entityId: number): TraitMeta[] {
  const entity = findEntity(entityId);
  if (!entity) return [];
  const result: TraitMeta[] = [];
  const safeHas = (t: any) => { try { return entity.has(t); } catch { return false; } };
  for (const meta of getAllTraits()) {
    if (safeHas(meta.trait)) result.push(meta);
  }
  return result;
}

/** Read all field values for a trait on an entity */
export function readTraitData(entityId: number, meta: TraitMeta): Record<string, unknown> | null {
  const entity = findEntity(entityId);
  if (!entity || !entity.has(meta.trait)) return null;
  if (meta.category === 'tag') return {};
  const data = entity.get(meta.trait);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(meta.fields)) {
    result[key] = (data as Record<string, unknown>)[key];
  }
  return result;
}

/** Like {@link readTraitData} but returns EVERY persistent field the trait holds,
 *  not just the curated Inspector subset in `meta.fields`. SoA traits expose a
 *  plain-object `schema` (every field is a key); AoS traits (`trait(() => ({…}))`,
 *  e.g. AnimationLibrary's `animSets`/`boneMaps`, SkinnedMeshRenderer's `materials`,
 *  UIAction's `onClickSet`) expose `schema` as a function / undefined — for those we
 *  fall back to the LIVE object's own keys. Use this for serialization / prefab
 *  override capture: `readTraitData` would silently DROP an AoS object/array field
 *  that isn't declared in `meta.fields` (the bone-map-lost-on-save bug). Mirrors the
 *  key-enumeration `serializeScene` already does inline. */
export function readTraitDataFull(entityId: number, meta: TraitMeta): Record<string, unknown> | null {
  const entity = findEntity(entityId);
  if (!entity || !entity.has(meta.trait)) return null;
  if (meta.category === 'tag') return {};
  const data = entity.get(meta.trait) as Record<string, unknown>;
  const schema = (meta.trait as { schema?: unknown }).schema;
  const keys = schema && typeof schema === 'object' ? Object.keys(schema) : Object.keys(data);
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = data[key];
  return result;
}

/** Deep-clone a bag of trait values. {@link readTraitDataFull} hands back LIVE
 *  references into a trait's backing store, so anything that stashes or replays
 *  its result (the Inspector's component clipboard, a paste onto several
 *  entities) must clone — otherwise two entities end up sharing one array and
 *  editing one silently mutates the other. Falls back to a per-field clone when
 *  a field holds something `structuredClone` refuses (a class instance, a
 *  function); that field keeps its original reference rather than failing the
 *  whole clone. */
export function cloneTraitValues(values: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(values);
  } catch {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      try { out[k] = structuredClone(v); } catch { out[k] = v; }
    }
    return out;
  }
}

/** Write a field value to a trait on an entity */
export function writeTraitField(entityId: number, meta: TraitMeta, field: string, value: unknown) {
  if (meta.category === 'tag') {
    const entity = findEntity(entityId);
    if (!entity) return;
    if (value) entity.add(meta.trait);
    else entity.remove(meta.trait);
    fireDirtyListeners();
    return;
  }
  const entity = findEntity(entityId);
  if (!entity || !entity.has(meta.trait)) return;
  const current = entity.get(meta.trait) as Record<string, unknown>;
  entity.set(meta.trait, { ...current, [field]: value });
  fireDirtyListeners();
  // EntityAttributes fields that the Hierarchy displays/orders by (name, layer,
  // parentId, sortOrder) must also bump the structure version — otherwise the
  // Hierarchy's onStructureDirty subscription never fires and the change isn't
  // reflected until the editor reloads.
  if (meta.name === 'EntityAttributes' && STRUCTURE_FIELDS.has(field)) {
    markStructureDirty();
  }
}

/** EntityAttributes fields whose changes affect the Hierarchy tree (label/order/
 *  folder grouping). `editorFolder` is here so re-tagging a root into/out of a
 *  folder rebuilds the tree (it regroups roots, same as a parentId/sortOrder move). */
const STRUCTURE_FIELDS = new Set(['name', 'layer', 'parentId', 'sortOrder', 'editorFolder']);

/** Trait name → rendering layer for the three *primary* renderable traits that map
 *  1:1 to a render path (Scene3D / Scene2D / UIRenderer). `EntityAttributes.layer` is
 *  a stored field that the editor writes and serialization persists, but it can drift
 *  from the actual renderable trait set (e.g. a `Renderable2D` entity left at
 *  `layer:'3d'`, or a `Renderable3DPrimitive` left at `layer:''`). To make the two
 *  unable to disagree, `deriveLayer` reconciles the stored value against this map on
 *  read (`getAllEntities`): when a primary renderable trait is present its layer wins;
 *  otherwise the stored value stands (Light/HDR/ModelSource/group-node entities have no
 *  unambiguous primary renderer and legitimately store `''` or `'3d'`). F8. */
const PRIMARY_RENDERABLE_LAYER: Record<string, EntityInfo['layer']> = {
  Renderable3D: '3d',
  Renderable3DPrimitive: '3d',
  Text3D: '3d',
  Renderable2D: '2d',
  Text2D: '2d',
  UIElement: 'ui',
  RenderableUI: 'ui',
};

/** Derive the authoritative rendering layer for an entity from the renderable traits
 *  it actually has, falling back to the stored `EntityAttributes.layer` when none of the
 *  primary renderable traits is present. See {@link PRIMARY_RENDERABLE_LAYER}. */
export function deriveLayer(traitNames: readonly string[], storedLayer: EntityInfo['layer']): EntityInfo['layer'] {
  for (const t of traitNames) {
    const derived = PRIMARY_RENDERABLE_LAYER[t];
    if (derived) return derived;
  }
  return storedLayer;
}

/** Read a whole trait's data off an entity by the trait OBJECT (type-safe).
 *  `const t = getTrait(id, Transform)` → typed `{ x, y, z, ... } | null`. Returns
 *  null if the entity is missing or doesn't have the trait. Pure read, no side
 *  effects — pair with `setTrait` to write (a raw koota read is fine for reading). */
export function getTrait<T extends Trait>(entityId: number, trait: T): TraitRecord<ExtractSchema<T>> | null {
  const entity = findEntity(entityId);
  if (!entity || !entity.has(trait)) return null;
  return (entity.get(trait) ?? null) as TraitRecord<ExtractSchema<T>> | null;
}

/** Write one or more fields of a trait by the trait OBJECT (type-safe partial):
 *  `setTrait(id, UIElement, { isVisible: false, opacity: 0.5 })`. Merges over the
 *  current value. This is the direct alternative to `writeTraitField` — and unlike
 *  a raw koota `entity.set`, it fires the editor/UI dirty signals so the Inspector,
 *  Hierarchy, and DOM UI actually refresh (a bare set updates data but nothing
 *  re-renders). For per-frame mutation inside a system, prefer
 *  `world.query(...).updateEach` — calling findEntity 60×/s per entity is wasteful. */
export function setTrait<T extends Trait>(
  entityId: number, trait: T, partial: Partial<TraitValue<ExtractSchema<T>>>,
): void {
  const entity = findEntity(entityId);
  if (!entity || !entity.has(trait)) return;
  const current = entity.get(trait) as Record<string, unknown>;
  entity.set(trait, { ...current, ...(partial as Record<string, unknown>) } as TraitValue<ExtractSchema<T>>);
  fireDirtyListeners();
  // Hierarchy-affecting EntityAttributes fields must also bump the structure
  // version (mirrors writeTraitField), else the tree doesn't reorder/rename.
  if ((trait as unknown) === (EntityAttributes as unknown)) {
    for (const k of Object.keys(partial)) { if (STRUCTURE_FIELDS.has(k)) { markStructureDirty(); break; } }
  }
}

/** Entity info returned by getAllEntities */
export interface EntityInfo {
  id: number;
  name: string;
  traits: string[];
  parentId: number;
  sortOrder: number;
  layer?: '2d' | '3d' | 'ui';
  /** Stable EntityAttributes.guid ('' if never assigned). Lets the editor key
   *  per-entity view state (e.g. Hierarchy expand/collapse) to something that
   *  survives the runtime-id reassignment on every scene reload. */
  guid?: string;
  isResource?: boolean;
  /** Editor Hierarchy folder path (EntityAttributes.editorFolder). Only meaningful
   *  on roots (parentId 0); '' / undefined = ungrouped. */
  editorFolder?: string;
  children?: EntityInfo[];
}

export function getAllEntities(): EntityInfo[] {
  const entities: EntityInfo[] = [];
  const seen = new Set<number>();
  const allTraits = getAllTraits();

  // Pre-find special traits once (not per entity)
  const attrMeta = allTraits.find((m) => m.name === 'EntityAttributes');

  // Primary pass: query EntityAttributes (all visible entities have it).
  // This avoids iterating all 20+ traits just to discover entities.
  const entitiesToProcess: { id: number; entity: any }[] = [];
  if (attrMeta) {
    const q = safeQuery(attrMeta.trait);
    if (q) {
      q.updateEach((_: any, entity: any) => {
        const id = entity.id();
        seen.add(id);
        entitiesToProcess.push({ id, entity });
      });
    }
  }

  // Fallback pass: catch any entities that don't have EntityAttributes
  // (rare — mostly resources or test entities)
  for (const meta of allTraits) {
    if (meta === attrMeta) continue;
    const q = safeQuery(meta.trait);
    if (!q) continue;
    q.updateEach((_: any, entity: any) => {
      const id = entity.id();
      if (seen.has(id)) return;
      seen.add(id);
      entitiesToProcess.push({ id, entity });
    });
  }

  for (const { id, entity } of entitiesToProcess) {
    const entityHas = (t: any) => { try { return entity.has(t); } catch { return false; } };

    // Single pass: collect trait names, detect role/resource, find name — all at once
    const traitNames: string[] = [];
    let name = '';
    let nameFound = false;
    let isResource = false;
    let cameraFound = false;
    let firstStringFieldName = '';

    for (const m of allTraits) {
      if (!entityHas(m.trait)) continue;
      traitNames.push(m.name);

      if (m.role === 'camera') cameraFound = true;
      if (m.category === 'resource') isResource = true;

      // Look for a string field fallback name (only from components)
      if (!firstStringFieldName && m.category === 'component' && m.name !== 'Name') {
        const data = entity.get(m.trait) as Record<string, unknown>;
        for (const [key, hint] of Object.entries(m.fields)) {
          if (hint.type === 'string' && !hint.readOnly && data[key]) {
            firstStringFieldName = String(data[key]);
            break;
          }
        }
      }
    }

    // Read EntityAttributes (parentId, sortOrder, name, layer) — single get
    let parentId = 0;
    let sortOrder = 0;
    let layer: EntityInfo['layer'];
    let editorFolder = '';
    let guid = '';
    if (attrMeta && entityHas(attrMeta.trait)) {
      const attr = entity.get(attrMeta.trait) as Record<string, unknown>;
      parentId = (attr.parentId as number) || 0;
      sortOrder = (attr.sortOrder as number) || 0;
      if (attr.name) { name = String(attr.name); nameFound = true; }
      const l = attr.layer as string;
      if (l === '3d' || l === '2d' || l === 'ui') layer = l;
      if (typeof attr.editorFolder === 'string') editorFolder = attr.editorFolder;
      if (typeof attr.guid === 'string') guid = attr.guid;
    }
    // Reconcile against the present renderable trait so the stored `layer` can't drift
    // (a Renderable2D entity stuck at '3d', a Renderable3DPrimitive at ''). F8.
    layer = deriveLayer(traitNames, layer);

    // Name resolution priority: EntityAttributes.name > camera role > resource name > string field
    if (!nameFound) {
      if (cameraFound) { name = 'Game Camera'; }
      else if (isResource) {
        const resMeta = allTraits.find(m => m.category === 'resource' && entityHas(m.trait));
        name = resMeta ? `${resMeta.name} (resource)` : `Entity ${id}`;
      }
      else if (firstStringFieldName) { name = firstStringFieldName; }
      else { name = `Entity ${id}`; }
    }

    entities.push({ id, name: transformName(name), traits: traitNames, parentId, sortOrder, layer, guid, isResource, editorFolder });
  }
  return entities;
}

/** Build a tree from flat entity list. Sorted by sortOrder. */
export function buildEntityTree(entities: EntityInfo[]): EntityInfo[] {
  const byId = new Map<number, EntityInfo>();
  for (const e of entities) {
    byId.set(e.id, { ...e, children: [] });
  }
  const roots: EntityInfo[] = [];
  for (const e of byId.values()) {
    if (e.parentId === 0 || !byId.has(e.parentId)) {
      roots.push(e);
    } else {
      byId.get(e.parentId)!.children!.push(e);
    }
  }
  const sortChildren = (list: EntityInfo[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    for (const e of list) {
      if (e.children && e.children.length > 0) sortChildren(e.children);
    }
  };
  sortChildren(roots);
  return roots;
}

/** `rootId` followed by every descendant, depth-first. Pure over a flat entity list, so
 *  callers that already hold one (or a test fixture) don't touch the world. Returns just
 *  `[rootId]` when it has no children — and `[]` if `rootId` isn't in `flat`, since an id
 *  with no entity has no subtree to speak of. */
export function subtreeIds(flat: EntityInfo[], rootId: number): number[] {
  if (!flat.some((e) => e.id === rootId)) return [];
  const childrenByParent = new Map<number, number[]>();
  for (const e of flat) {
    if (e.parentId > 0) {
      let arr = childrenByParent.get(e.parentId);
      if (!arr) { arr = []; childrenByParent.set(e.parentId, arr); }
      arr.push(e.id);
    }
  }
  const out: number[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    const children = childrenByParent.get(id);
    if (children) stack.push(...children);
  }
  return out;
}

/** Delete multiple entities and all their children in one pass.
 *  Builds the child index once (O(n)), then collects subtrees for all IDs. */
export function deleteEntities(entityIds: number[]) {
  if (entityIds.length === 0) return;

  // Build child index from all entities once
  const allEnts = getAllEntities();
  const childrenByParent = new Map<number, number[]>();
  for (const e of allEnts) {
    if (e.parentId > 0) {
      let arr = childrenByParent.get(e.parentId);
      if (!arr) { arr = []; childrenByParent.set(e.parentId, arr); }
      arr.push(e.id);
    }
  }

  // Collect entire subtrees depth-first
  const toDelete: number[] = [];
  for (const entityId of entityIds) {
    const stack = [entityId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      toDelete.push(id);
      const children = childrenByParent.get(id);
      if (children) stack.push(...children);
    }
  }

  // Delete in reverse (children before parents), dedup in case of overlapping subtrees
  const seen = new Set<number>();
  for (let i = toDelete.length - 1; i >= 0; i--) {
    const id = toDelete[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const entity = findEntity(id);
    if (entity) {
      unregisterEntity(entity);
      entity.destroy();
    }
  }
  fireDirtyListeners();
  markStructureDirty();
}

/** Delete an entity and all its children. Delegates to deleteEntities. */
export function deleteEntity(entityId: number) {
  deleteEntities([entityId]);
}
