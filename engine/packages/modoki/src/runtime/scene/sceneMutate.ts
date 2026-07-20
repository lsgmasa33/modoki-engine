/** Scene-file mutation — pure operations on the on-disk scene JSON shape.
 *
 *  The scene file is the source of truth (see docs/scene-loading.md). An agent
 *  mutates it through validated ops here instead of hand-editing raw JSON, then
 *  the dev-server watcher + hot-reload reflect the change in the browser. Pure
 *  and side-effect-free (GUID minting is injected), so it unit-tests without a
 *  live world and runs identically in Node (the dev server) and the browser.
 *
 *  Entity identity is by the scene file's numeric `id`, the top-level `name`,
 *  or the `EntityAttributes.guid`. New entities get the next free numeric id and
 *  a fresh guid. */

import { newGuid } from '../loaders/assetRefRules';

/** Minimal on-disk entity shape (matches editor SerializedEntity / runtime
 *  SceneEntityEntry — kept structural to avoid a cross-layer import). */
export interface MutableEntity {
  id: number;
  name?: string;
  traits: Record<string, Record<string, unknown> | boolean>;
  prefab?: string;
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  /** Prefab INSTANCE nodes store their identity guid at the node top level
   *  (not in EntityAttributes, which comes from the expanded prefab). */
  guid?: string;
}

export interface MutableScene {
  entities: MutableEntity[];
  [key: string]: unknown;
}

/** How an op refers to an existing entity. At least one field is required. */
export interface EntityRef {
  id?: number;
  name?: string;
  guid?: string;
}

export type MutateOp =
  | { op: 'setTrait'; entity: EntityRef; trait: string; fields?: Record<string, unknown> }
  | { op: 'removeTrait'; entity: EntityRef; trait: string }
  | { op: 'addEntity'; name?: string; parentId?: number | string; traits?: Record<string, Record<string, unknown> | boolean> }
  | { op: 'removeEntity'; entity: EntityRef };

/** Core traits every entity needs — refused by removeTrait (a human can't remove
 *  these in the Inspector either; dropping them corrupts the entity). */
const CORE_TRAITS = new Set(['Transform', 'EntityAttributes']);

export interface ApplyResult {
  scene: MutableScene;
  /** Number of ops that produced a change. */
  changed: number;
  /** Entity refs that matched NOTHING in this scene FILE. (C7)
   *
   *  This module is a pure function over the file — it cannot know whether such a ref
   *  exists in the LIVE world. That distinction is exactly what an agent needs ("does not
   *  exist" vs "exists live, not saved yet"), so report the refs and let a caller that CAN
   *  reach the renderer explain them. (The C7 save-state audit in docs/connect-claude-code.md
   *  assumed this resolver knew both; it does not, and cannot.) */
  unresolved: EntityRef[];
  /** Hard errors (entity not found, malformed op). Non-empty means some ops
   *  were skipped — the caller decides whether to still write. */
  errors: string[];
  /** Soft warnings — the op applied but produced a suspect result (a now-dangling
   *  entity ref after a remove, an addEntity under a non-existent parent). The agent
   *  reads these to self-correct; they do NOT block the write. */
  warnings: string[];
}

/** Apply a list of mutation ops to a scene object. Mutates `scene` in place and
 *  also returns it. `mint` is injectable so tests get deterministic ids. */
export function applyOps(scene: MutableScene, ops: MutateOp[], mint: () => string = newGuid): ApplyResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unresolved: EntityRef[] = [];
  let changed = 0;

  if (!scene || !Array.isArray(scene.entities)) {
    return { scene, changed: 0, errors: ['scene.entities is missing or not an array'], warnings, unresolved };
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const where = `op[${i}] (${op?.op ?? 'unknown'})`;
    try {
      if (op.op === 'setTrait') {
        const entity = resolveEntity(scene, op.entity, errors, where, unresolved);
        if (!entity) continue;
        if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
        const fields = op.fields ?? {};
        // Prefab-instance roots route trait writes into their overrides (see helper).
        const container = traitWriteContainer(entity);
        if (Object.keys(fields).length === 0) {
          // No fields → treat as a tag (presence). Don't clobber existing data.
          // Only count as changed when the tag was actually added — re-tagging an
          // existing trait is a genuine no-op and must not report changed (F6).
          if (container[op.trait] === undefined) {
            container[op.trait] = true;
            changed++;
          }
        } else {
          const existing = container[op.trait];
          const base = existing && typeof existing === 'object' ? existing : {};
          container[op.trait] = { ...base, ...fields };
          changed++;
        }
      } else if (op.op === 'removeTrait') {
        const entity = resolveEntity(scene, op.entity, errors, where, unresolved);
        if (!entity) continue;
        if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
        if (CORE_TRAITS.has(op.trait)) { errors.push(`${where}: cannot remove core trait '${op.trait}'`); continue; }
        // Removing a trait the entity doesn't have is a genuine no-op (not an
        // error) — mirrors removeTraitFromEntitiesWithUndo's skip-if-absent.
        // Prefab-instance roots remove the override (same container as setTrait).
        const container = traitWriteContainer(entity);
        if (container[op.trait] !== undefined) {
          delete container[op.trait];
          changed++;
        }
      } else if (op.op === 'addEntity') {
        // Warn if the requested parent doesn't exist yet (ops apply in order, so a
        // parent added by an earlier op IS present here). An orphan won't render
        // under the expected parent and the agent gets no other signal. (F5)
        const pid = op.parentId;
        if (pid != null && pid !== 0 && pid !== '') {
          const parentExists = scene.entities.some((e) =>
            typeof pid === 'number' ? e.id === pid : entityGuid(e) === pid);
          if (!parentExists) {
            warnings.push(`${where}: parentId '${pid}' matches no existing entity — '${op.name ?? 'new entity'}' will be orphaned`);
          }
        }
        const id = nextId(scene);
        const traits: Record<string, Record<string, unknown> | boolean> = { ...(op.traits ?? {}) };
        // Ensure EntityAttributes carries a stable guid + name + parentId so the
        // entity round-trips through load/save and selection-restore.
        const existingAttrs = (traits.EntityAttributes && typeof traits.EntityAttributes === 'object')
          ? (traits.EntityAttributes as Record<string, unknown>)
          : {};
        traits.EntityAttributes = {
          name: op.name ?? existingAttrs.name ?? `Entity ${id}`,
          guid: existingAttrs.guid ?? mint(),
          parentId: op.parentId ?? existingAttrs.parentId ?? 0,
          ...existingAttrs,
          // re-apply the canonical name/parentId in case existingAttrs lacked them
          ...(op.name ? { name: op.name } : {}),
          ...(op.parentId != null ? { parentId: op.parentId } : {}),
        };
        // EntityAttributes.name is canonical (the loader reads only that). The
        // top-level `name` is decorative (serialize parity / labels) — derive it
        // from the same value so the two can't diverge at creation.
        const entity: MutableEntity = { id, name: (traits.EntityAttributes as { name: string }).name, traits };
        scene.entities.push(entity);
        changed++;
      } else if (op.op === 'removeEntity') {
        const entity = resolveEntity(scene, op.entity, errors, where, unresolved);
        if (!entity) continue;
        const toRemove = collectSubtree(scene, entity.id);
        // Collect the removed guids BEFORE filtering so we can flag any surviving
        // entity that still references the deleted subtree (a now-dangling ref). (F5)
        const removedGuids = new Set<string>();
        for (const e of scene.entities) {
          if (!toRemove.has(e.id)) continue;
          const g = entityGuid(e);
          if (g) removedGuids.add(g);
        }
        scene.entities = scene.entities.filter((e) => !toRemove.has(e.id));
        if (removedGuids.size) flagDanglingRefs(scene, removedGuids, warnings, where);
        changed++;
      } else {
        errors.push(`${where}: unknown op '${(op as { op?: string }).op}'`);
      }
    } catch (e) {
      errors.push(`${where}: ${String(e)}`);
    }
  }

  return { scene, changed, errors, warnings, unresolved };
}

/** Scan surviving entities for entity-ref fields that still point at a removed guid.
 *  Today the only entity→entity refs in the on-disk format are `UIAction.bindings[].target`
 *  (the entity a button writes to / passes to its handler). Reported as warnings so an
 *  agent can re-wire the dangling button instead of silently shipping broken UI. (F5) */
function flagDanglingRefs(scene: MutableScene, removedGuids: Set<string>, warnings: string[], where: string): void {
  for (const e of scene.entities) {
    const ua = e.traits?.UIAction;
    if (!ua || typeof ua !== 'object') continue;
    const bindings = (ua as { bindings?: unknown }).bindings;
    if (!Array.isArray(bindings)) continue;
    for (const b of bindings) {
      const target = b && typeof b === 'object' ? (b as { target?: unknown }).target : undefined;
      if (typeof target === 'string' && removedGuids.has(target)) {
        warnings.push(`${where}: ${entityName(e) ?? `entity ${e.id}`} UIAction.target '${target}' references a removed entity (now dangling)`);
      }
    }
  }
}

/** Resolve an entity ref to an entity, pushing an error if not found/ambiguous. */
function resolveEntity(scene: MutableScene, ref: EntityRef, errors: string[], where: string, unresolved?: EntityRef[]): MutableEntity | null {
  if (!ref || (ref.id == null && !ref.name && !ref.guid)) {
    errors.push(`${where}: entity ref needs an id, name, or guid`);
    return null;
  }
  let matches: MutableEntity[];
  if (ref.id != null) {
    matches = scene.entities.filter((e) => e.id === ref.id);
  } else if (ref.guid) {
    matches = scene.entities.filter((e) => entityGuid(e) === ref.guid);
  } else {
    matches = scene.entities.filter((e) => entityName(e) === ref.name);
  }
  if (matches.length === 0) {
    errors.push(`${where}: no entity matching ${JSON.stringify(ref)} in this scene FILE`);
    unresolved?.push(ref);
    return null;
  }
  if (matches.length > 1) {
    errors.push(`${where}: ${matches.length} entities match ${JSON.stringify(ref)} — use 'id' or 'guid' to disambiguate`);
    return null;
  }
  return matches[0];
}

function entityName(e: MutableEntity): string | undefined {
  if (e.name) return e.name;
  const attrs = e.traits?.EntityAttributes;
  return attrs && typeof attrs === 'object' ? (attrs as { name?: string }).name : undefined;
}

function entityGuid(e: MutableEntity): string | undefined {
  const attrs = e.traits?.EntityAttributes;
  const attrGuid = attrs && typeof attrs === 'object' ? (attrs as { guid?: string }).guid : undefined;
  // Prefab instances carry their guid at the node top level, not in EntityAttributes.
  return attrGuid ?? e.guid;
}

/** The object a setTrait/removeTrait write should land in. For a normal entity
 *  that's `entity.traits`. For a PREFAB INSTANCE root, trait edits are authored
 *  as overrides keyed by the root's localId — writing a top-level trait instead
 *  is silently ignored by the loader (the instance's traits come from the prefab),
 *  which is the bug that made `setTrait Transform` on an instance apply scale but
 *  not position. Route into `overrides[rootLocalId]` (created on demand) so the
 *  edit is authoritative. */
function traitWriteContainer(entity: MutableEntity): Record<string, unknown> {
  const pi = entity.traits?.PrefabInstance;
  const localId = entity.prefab && pi && typeof pi === 'object'
    ? (pi as { localId?: number }).localId
    : undefined;
  if (localId != null) {
    entity.overrides ??= {};
    entity.overrides[localId] ??= {};
    return entity.overrides[localId] as Record<string, unknown>;
  }
  return entity.traits as Record<string, unknown>;
}

/** A serialized parentId reference: a GUID string (current files), a numeric file id
 *  (legacy), or 0/'' for root. */
function parentKeyOf(e: MutableEntity): string | number {
  const attrs = e.traits?.EntityAttributes;
  if (attrs && typeof attrs === 'object') {
    const p = (attrs as { parentId?: unknown }).parentId;
    if (typeof p === 'string') return p;   // guid (current)
    if (typeof p === 'number') return p;    // numeric file id (legacy)
  }
  return 0;
}

/** Collect an entity id plus all descendants (by EntityAttributes.parentId).
 *  Works whether parentId is a GUID (current) or a numeric file id (legacy), and
 *  even a mix — a child is matched against its parent's guid AND numeric id. */
function collectSubtree(scene: MutableScene, rootId: number): Set<number> {
  const childrenByKey = new Map<string | number, MutableEntity[]>();
  for (const e of scene.entities) {
    const p = parentKeyOf(e);
    if (p) {
      const arr = childrenByKey.get(p) ?? [];
      arr.push(e);
      childrenByKey.set(p, arr);
    }
  }
  const out = new Set<number>();
  const root = scene.entities.find((e) => e.id === rootId);
  if (!root) return out;
  const stack: MutableEntity[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    if (out.has(e.id)) continue;
    out.add(e.id);
    const g = entityGuid(e);
    for (const c of childrenByKey.get(e.id) ?? []) stack.push(c);       // legacy numeric ref
    if (g) for (const c of childrenByKey.get(g) ?? []) stack.push(c);    // guid ref (current)
  }
  return out;
}

/** Next free numeric entity id (max existing + 1, min 1). */
function nextId(scene: MutableScene): number {
  let max = 0;
  for (const e of scene.entities) if (typeof e.id === 'number' && e.id > max) max = e.id;
  return max + 1;
}
