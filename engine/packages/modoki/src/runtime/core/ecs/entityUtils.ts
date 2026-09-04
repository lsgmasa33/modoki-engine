/** Entity utilities — read/write traits, query entities, delete.
 *  Pure runtime functions with no undo or Three.js dependency. */

import type { Trait, TraitRecord, ExtractSchema, TraitValue } from 'koota';
import { getCurrentWorld, findEntityById, destroyEntity, setStructureCallback } from './world';
import { getAllTraits, getTraitByName, transformName, type TraitMeta } from './traitRegistry';
import { EntityAttributes } from '../traits/EntityAttributes';
import { Transient } from '../traits/Transient';
import { isSimRunning } from '../playState';
import { inSystemTick } from '../systemTick';
import { noteAuthoredWriteWhileStopped } from './authoredWrites';
import { compareSiblings } from './entityOrder';
// Re-exported for backward compatibility — every existing caller imports these from here.
// The implementation lives in `renderDirty.ts` (a side-effect-free L0 module) so a module
// that only needs the dirty signal (e.g. `loaders/assetManifest.ts`) doesn't have to import
// this file's `setStructureCallback` wiring below just to reach it.
import { addDirtyListener, fireDirtyListeners } from '../renderDirty';
export { addDirtyListener, fireDirtyListeners };

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

/** Warn about the O(n) fallback at most WARN_CAP times per process, then once more to say
 *  the rest are hidden. Exported only so a test can reset it. */
const FALLBACK_WARN_CAP = 3;
let _fallbackWarnings = 0;
export function resetFallbackWarnings() { _fallbackWarnings = 0; }
function warnFallbackCapped(entityId: number) {
  _fallbackWarnings++;
  if (_fallbackWarnings <= FALLBACK_WARN_CAP) {
    // The message alone never said WHO called, which is the only thing that identifies the
    // spawn site that skipped registerEntity — and with the message capped there is now room
    // to print it. Drop this function + findEntity from the top so the first frame is the caller.
    const stack = (new Error().stack ?? '').split('\n').slice(3).join('\n');
    console.warn(`[entityUtils] findEntity(${entityId}) hit O(n) fallback — entity was not registered via registerEntity()\n${stack}`);
  } else if (_fallbackWarnings === FALLBACK_WARN_CAP + 1) {
    console.warn('[entityUtils] further O(n)-fallback warnings suppressed for this process — the first '
      + `${FALLBACK_WARN_CAP} are enough to act on, and one unregistered entity repeats per lookup`);
  }
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
      // fallback never fires. In dev, warn so missing registrations get fixed —
      // but CAPPED and with a STACK, because the interesting information is "this
      // happens at all, from here", and it otherwise repeats per lookup per entity:
      // uncapped it put 21,906 lines into a single CI run (2026-08-04), which is the
      // log you then have to read to find a real failure.
      //
      // It fires from TEST worlds, which spawn directly and skip registerEntity by
      // design. It looked platform-specific — thousands of lines on the ubuntu and
      // windows CI legs, none on macOS — but that is only vitest's reporter: console
      // output from a PASSING test is hidden locally and printed in CI. The warnings
      // were always there. Hence a cap rather than a test-env mute: the behaviour is
      // unchanged, only the volume is, and the stack makes the one surviving line
      // actionable instead of merely alarming.
      if (import.meta.env?.DEV) warnFallbackCapped(entityId);
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

/** #124 warn-only probe: a SYSTEM writing an AUTHORED entity while the sim is stopped is a
 *  write that a save will bake into the scene file. `Transient` covers system-SPAWNED entities
 *  (the serializer skips them); this covers the mutation of an entity the human authored, which
 *  transience cannot reach. Records only — the write itself always proceeds.
 *
 *  All three conditions matter. `inSystemTick()` excludes the human's own inspector/gizmo edits
 *  and load-time writes; `!isSimRunning()` excludes Play (whose mutations are reverted at Stop);
 *  the `Transient` check excludes generated content that is never serialized anyway. */
function noteIfAuthoredWriteWhileStopped(
  entity: ReturnType<typeof findEntity>,
  entityId: number,
  traitName: string,
  field: string,
) {
  if (!entity || !inSystemTick() || isSimRunning() || entity.has(Transient)) return;
  const attrs = entity.has(EntityAttributes)
    ? (entity.get(EntityAttributes) as { name?: string } | undefined)
    : undefined;
  noteAuthoredWriteWhileStopped(entityId, attrs?.name ?? `#${entityId}`, traitName, field);
}

/** Write a field value to a trait on an entity */
export function writeTraitField(entityId: number, meta: TraitMeta, field: string, value: unknown) {
  if (meta.category === 'tag') {
    const entity = findEntity(entityId);
    if (!entity) return;
    if (value) entity.add(meta.trait);
    else entity.remove(meta.trait);
    noteIfAuthoredWriteWhileStopped(entity, entityId, meta.name, field);
    fireDirtyListeners();
    return;
  }
  const entity = findEntity(entityId);
  if (!entity || !entity.has(meta.trait)) return;
  const current = entity.get(meta.trait) as Record<string, unknown>;
  entity.set(meta.trait, { ...current, [field]: value });
  noteIfAuthoredWriteWhileStopped(entity, entityId, meta.name, field);
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
 *  unambiguous primary renderer and legitimately store `''` or `'3d'`). F8.
 *
 *  Full rule (stored vs exposed type, why the caller owns the narrowing):
 *  docs/architecture.md § "The `layer` system". */
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
 *  it actually has, falling back to `storedLayer` when none of the primary renderable
 *  traits is present. `storedLayer` is the ALREADY-NARROWED `EntityAttributes.layer`:
 *  the caller maps `''` (and anything unrecognised) to `undefined` first, so this takes
 *  and returns the same three-layer type. Which traits count as primary, and the layer each
 *  maps to, is the `PRIMARY_RENDERABLE_LAYER` table directly above — module-private, so this
 *  comment points at it rather than restating it (a copy here would silently drift). Full
 *  rule: docs/architecture.md § "The `layer` system". */
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
  // Strip undefined-valued keys: koota's setter tests `'key' in value`, not whether it's
  // defined, so an explicit `{ isVisible: undefined }` would overwrite the real value with
  // undefined instead of leaving it untouched.
  const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
  entity.set(trait, { ...current, ...defined } as TraitValue<ExtractSchema<T>>);
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
  /** Base-scene persistence provenance (EntityAttributes.sourceScene) — the guid
   *  of the scene (in the active chain) this entity was loaded from. '' / undefined
   *  = the primary scene (Phase 3's load-bearing default). Stamped on every entity
   *  a base scene spawns, not just its roots, so a descendant reads its OWN value
   *  rather than inheriting from an ancestor. Drives the Hierarchy's scene-group
   *  ghosting (base-scene plan Phase 9). */
  sourceScene?: string;
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
    let sourceScene = '';
    if (attrMeta && entityHas(attrMeta.trait)) {
      const attr = entity.get(attrMeta.trait) as Record<string, unknown>;
      parentId = (attr.parentId as number) || 0;
      sortOrder = (attr.sortOrder as number) || 0;
      if (attr.name) { name = String(attr.name); nameFound = true; }
      // Accept ONLY the three real layers; everything else stays undefined. This is not
      // just an '' → undefined narrowing — `attr` is unknown-typed data out of
      // hot-reloadable scene JSON, so it also rejects junk (a hand-edited "layer": "3D"),
      // which is why deriveLayer takes the narrow type instead of doing this itself. #36.
      const l = attr.layer as string;
      if (l === '3d' || l === '2d' || l === 'ui') layer = l;
      if (typeof attr.editorFolder === 'string') editorFolder = attr.editorFolder;
      if (typeof attr.guid === 'string') guid = attr.guid;
      if (typeof attr.sourceScene === 'string') sourceScene = attr.sourceScene;
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

    entities.push({ id, name: transformName(name), traits: traitNames, parentId, sortOrder, layer, guid, isResource, editorFolder, sourceScene });
  }
  return dropParkedEntries(entities);
}

/**
 * Remove PARKED scroll-view entries — and their whole subtrees — from the agent-facing entity
 * list.
 *
 * Owner's ruling (2026-08-21): *an entry sitting in the recycle bin must be treated by Percept
 * and Enact exactly as if it had been destroyed.* It still exists in ECS — that is the point of
 * pooling — but it must not be listable, addressable or aimable while parked.
 *
 * ⚠️ This is deliberately NOT the same as `isVisible:false`. A hidden entity stays perfectly
 * addressable today and must keep doing so: hiding something is not a claim that it does not
 * exist. Only a pooled entry that the data no longer covers reads as destroyed.
 *
 * Done HERE rather than in each consumer because `getAllEntities` is the single choke point the
 * whole agent surface runs through — `get_scene_state`, entity aiming (`entityResolve`),
 * `diagnose`, layout bounds and live mutate all call it. One rule, one implementation, and no
 * way for the surfaces to drift apart on what "parked" means. The editor's own Hierarchy does
 * not read this function, so a pooled entry stays visible to a human debugging the scene.
 *
 * The trait is resolved through the REGISTRY, never imported: this is L0 core and `UIEntry` is
 * an L1 trait, which the layer zone forbids.
 */
function dropParkedEntries(entities: EntityInfo[]): EntityInfo[] {
  const entryMeta = getTraitByName('UIEntry');
  if (!entryMeta) return entities;

  const parked = new Set<number>();
  for (const e of entities) {
    if (!e.traits.includes('UIEntry')) continue;
    // `readTraitDataFull`, NOT `readTraitData`: the latter returns only keys declared in the
    // registry's curated `fields` list, so whether this rule works at all would depend on
    // registration bookkeeping — and `UIEntry`'s fields are all registered `hidden`, which is
    // exactly the kind of entry a later tidy-up removes. `live` is engine state, so read the
    // live trait.
    const data = readTraitDataFull(e.id, entryMeta);
    if (data && data.live === false) parked.add(e.id);
  }
  if (parked.size === 0) return entities;

  // A parked entry's whole SUBTREE goes with it — the members are what an aim would actually
  // land on, so dropping only the root would leave the interesting half addressable.
  const byId = new Map(entities.map((e) => [e.id, e]));
  const hidden = (id: number): boolean => {
    let cur = id;
    for (let guard = 0; cur && guard < 64; guard++) {
      if (parked.has(cur)) return true;
      cur = byId.get(cur)?.parentId ?? 0;
    }
    return false;
  };
  return entities.filter((e) => !hidden(e.id));
}

/** Build a tree from flat entity list. Siblings are ordered by `compareSiblings` —
 *  `sortOrder`, then guid, then name — the SAME rule the serializer writes the scene
 *  file with, so the panel's order and the file's order agree (that agreement is the
 *  stated point of QA-HIER-0002, and it was not actually true while this sorted by ecs
 *  id: equal sortOrder is ordinary, not an edge case).
 *
 *  The tiebreak used to be `a.id - b.id`, which made the displayed order depend on load
 *  history — ids are reassigned by a delete+undo or a duplicate+delete, so the panel
 *  reshuffled entities the human never touched. The guid does not move. */
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
    list.sort(compareSiblings<EntityInfo>((e) => e.guid ?? ''));
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
      destroyEntity(entity);
    }
  }
  fireDirtyListeners();
  markStructureDirty();
}

/** Delete an entity and all its children. Delegates to deleteEntities. */
export function deleteEntity(entityId: number) {
  deleteEntities([entityId]);
}
