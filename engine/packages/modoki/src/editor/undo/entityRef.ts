/** EntityRef — a stable handle to an entity that survives an ECS world rebuild.
 *
 *  The undo system used to capture a raw koota entity id (a number) in its
 *  undo/redo closures. Those ids are world-scoped: a Play→Stop revert (and any
 *  scene rebuild) creates a fresh world with new ids, so the captured numbers go
 *  stale and the action silently no-ops (or worse, hits a reused id). That's why
 *  Stop used to `clearHistory()`.
 *
 *  An EntityRef instead captures the entity's stable `EntityAttributes.guid` at
 *  action-creation time and resolves it to the *current* live id at apply-time.
 *  Because a freshly-created/never-saved entity has an empty guid, `ensureGuid`
 *  MINTS one and writes it to the LIVE world — see the note on that function for
 *  why writing it live (not just into the closure) is load-bearing.
 *
 *  Falls back to the raw id ONLY when the entity genuinely has no guid (no
 *  EntityAttributes trait — an un-guidable bare entity); that fallback is valid
 *  within the same world only, matching the pre-existing selectionRestore
 *  behavior for guid-less entities. */

import { type World } from 'koota';
import { getCurrentWorld, getGuidIndex, findEntityByGuid, indexEntityGuid, rebuildGuidIndexSync } from '../../runtime/ecs/world';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { readTraitData, writeTraitField, findEntity } from '../../runtime/ecs/entityUtils';
import { newGuid } from '../../runtime/loaders/assetManifest';

export interface EntityRef {
  /** Captured stable guid, or '' when the entity is un-guidable. */
  readonly guid: string;
  /** Capture-time id — fallback for un-guidable entities + diagnostics. */
  readonly rawId: number;
  /** Current live ECS id, or null if the entity is gone. */
  resolve(): number | null;
}

/** Read the entity's `EntityAttributes.guid`; if empty, mint one and WRITE it to
 *  the live world. Idempotent (returns the existing guid unchanged). Returns ''
 *  when the entity has no EntityAttributes trait (un-guidable).
 *
 *  Why write to the live world rather than only into the undo closure: the Play
 *  snapshot (`serializeScene()`) serializes the LIVE world's guid into the
 *  snapshot JSON. If the guid lived only in the closure, the reloaded entity on
 *  Stop would get a *fresh, different* guid baked into the JSON and `resolve()`
 *  would miss. Writing it live makes the snapshot carry this exact guid so Stop
 *  restores an entity whose guid the closure already holds.
 *
 *  This runs at action-creation time — a user edit in edit/Stopped mode, NOT
 *  during Play — so it does not violate the "Play must not mutate authored data"
 *  invariant (serialize.ts F3). The guid write is part of authoring the edit,
 *  just like writing the field value, and persists on the next save (same as
 *  serialize's own guid pre-pass). */
export function ensureGuid(entityId: number): string {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return '';
  const data = readTraitData(entityId, eaMeta);
  if (!data) return ''; // no EntityAttributes → un-guidable
  const existing = (data.guid as string) || '';
  if (existing) return existing;
  const g = newGuid();
  writeTraitField(entityId, eaMeta, 'guid', g);
  // Keep the guid→entity index warm for this fresh mint (a '' → guid transition).
  const ent = findEntity(entityId);
  if (ent) indexEntityGuid(ent);
  return g;
}

/** Resolve a single guid to a live ECS id in the current world (0 if none).
 *  O(1) via the maintained guid→entity index (self-heals on miss). */
function idForGuid(guid: string): number {
  if (!guid) return 0;
  const ent = findEntityByGuid(guid);
  return ent ? ent.id() : 0;
}

/** Read an entity's guid WITHOUT minting one ('' if none). */
function readGuid(entityId: number): string {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return '';
  const data = readTraitData(entityId, eaMeta);
  return data ? ((data.guid as string) || '') : '';
}

/** Create an EntityRef for a live entity.
 *  `mint` (default true): mint+persist a guid if the entity has none — required
 *  for undo of a *mutation* to survive a world rebuild. Pass `mint:false` for
 *  high-frequency, low-stakes captures (selection) so merely selecting an entity
 *  doesn't write a guid / dirty the scene; such a ref survives a rebuild only if
 *  the entity already had a guid (the common case after any edit), else it falls
 *  back to the raw id (drops on rebuild — acceptable for selection). */
export function entityRef(entityId: number, mint = true): EntityRef {
  const guid = mint ? ensureGuid(entityId) : readGuid(entityId);
  const rawId = entityId;
  return {
    guid,
    rawId,
    resolve(): number | null {
      if (guid) { const id = idForGuid(guid); return id || null; }
      // un-guidable: raw-id fallback, valid only within the same world.
      return findEntity(rawId) ? rawId : null;
    },
  };
}

/** One-pass guid→id index for a world. Build ONCE per undo/redo invocation that
 *  resolves many refs, then resolve each ref against it — avoids the O(n²) of
 *  scanning the world per ref. Mirrors selectionRestore.collectIdsByGuid (first
 *  wins on the illegal chance two entities share a guid). */
export function buildGuidIndex(world: World = getCurrentWorld()): Map<string, number> {
  // Snapshot the maintained guid→entity index as guid→id. Rebuild it first so a
  // missed mint site can't yield a stale batch (matches the old full-scan semantics;
  // batch resolves were O(n) before too).
  rebuildGuidIndexSync(world);
  const out = new Map<string, number>();
  for (const [g, e] of getGuidIndex(world)) {
    if (!out.has(g)) out.set(g, (e as { id(): number }).id());
  }
  return out;
}

/** Resolve a single ref against a prebuilt guid→id index (or null if gone).
 *  Use inside a multi-entity undo/redo closure that must keep positional
 *  alignment with a parallel old/new value array — `resolveRefs` drops missing
 *  entries and would break the alignment. */
export function resolveWith(ref: EntityRef, index: Map<string, number>): number | null {
  if (ref.guid) { const id = index.get(ref.guid); return id ?? null; }
  return findEntity(ref.rawId) ? ref.rawId : null;
}

/** Resolve a batch of refs to live ids, dropping any that no longer resolve.
 *  Pass a prebuilt index to share one world scan across several resolveRefs calls. */
export function resolveRefs(refs: EntityRef[], index?: Map<string, number>): number[] {
  const idx = index ?? buildGuidIndex();
  const ids: number[] = [];
  for (const r of refs) {
    const id = r.guid ? (idx.get(r.guid) ?? 0) : (findEntity(r.rawId) ? r.rawId : 0);
    if (id) ids.push(id);
  }
  return ids;
}
