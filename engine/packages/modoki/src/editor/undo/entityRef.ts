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
 *  EntityAttributes trait — an un-guidable bare entity), and only in the World the
 *  ref was taken in: ids are handed out again after a world swap, so a raw id held
 *  across one names whatever entity took it (the held-entity rule, #1221).
 *
 *  **`require` owns a miss (#1819, #1827, #1793; I19 and I20 in docs/prefabs.md).**
 *  `resolve` answers null and leaves the caller to decide, and the callers decided
 *  differently: a silent no-op reported as done, the scene root, or a raw id that named
 *  an unrelated entity after a swap. An undo or redo step asks `require` for every ref
 *  it NEEDS before it changes anything; a miss, or a target that has changed KIND
 *  (an instance a swap turned into a Missing Prefab placeholder), throws
 *  `UndoRefusedError`, so `runStep` drops the entry (#310) and toasts why. A ref whose
 *  miss the step has shown to be harmless keeps `resolve` (#1272's prior links), and so
 *  do readers that may drop a miss (selection). */

import { type World } from 'koota';
import { getCurrentWorld, getGuidIndex, findEntityByGuid, indexEntityGuid, rebuildGuidIndexSync } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData, writeTraitField, findEntity } from '../../runtime/core/ecs/entityUtils';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { UndoRefusedError } from './undoFailure';
import { isMissingPrefabPlaceholder, entityNameOf, placeholderRefusalWords } from './placeholderGate';

/** What KIND of thing a ref's entity is, as far as an undo step cares (I20): a live entity, or a Missing Prefab
 *  placeholder standing in for a reference the load could not expand. A world swap can turn one into the other under
 *  the same guid. */
export type EntityKind = 'entity' | 'placeholder';

/** What a step expects of its target when it runs: the kind (default: the kind the ref was taken as, which is the kind
 *  every editor step's forward half leaves, since no step turns an entity into a placeholder or back), and optionally a
 *  finer check of the step's own, which returns the refusal's words or null. */
export interface RefExpect {
  kind?: EntityKind;
  check?: (id: number) => string | null;
}

export interface EntityRef {
  /** Captured stable guid, or '' when the entity is un-guidable. */
  readonly guid: string;
  /** Capture-time id — fallback for un-guidable entities + diagnostics. */
  readonly rawId: number;
  /** The entity's name when the ref was taken: what a refusal calls it once it is gone. */
  readonly name: string;
  /** The kind the entity was when the ref was taken. */
  readonly kind: EntityKind;
  /** Current live ECS id, or null if the entity is gone. */
  resolve(): number | null;
  /** The live id, or a throw of `UndoRefusedError` when the entity is gone or is not what `expect` says (I19, I20).
   *  For a step that must not act on anything else: ask it for every ref the step needs, BEFORE the first write. */
  require(expect?: RefExpect): number;
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
  // A runtime guid (#1210) dies with its world, so an undo entry holding one would miss after a
  // Stop-revert or reload. Mint a durable guid over it, exactly as over an empty one.
  const existing = durableGuid(data.guid as string);
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
  // Durable only (#1210): a runtime guid is re-minted by the next save, so a ref holding one would
  // stop resolving mid-world. Such an entity takes the raw-id fallback, as a guid-less one did.
  return data ? durableGuid(data.guid as string) : '';
}

/** How an editor-journal payload names an entity (#1223 P2): its guid, or `id:<n>` when it has none.
 *
 *  ⚠️ Never `String(id)`. A bare number in a guid field looks like an address, and every guid-addressed
 *  op refuses it. `id:<n>` is the form a contact partner with no guid already takes (docs/mcp-tool-conventions.md §3),
 *  and it cannot be mistaken for a guid. Takes the guid the caller already captured and never reads the
 *  world: a delete's payload is built after the entity is gone, when its id may name a newcomer. */
export function journalRefOf(guid: string | null | undefined, id: number): string {
  return guid || `id:${id}`;
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
  const world = getCurrentWorld();
  const ref: EntityRef = {
    guid,
    rawId,
    name: entityNameOf(entityId),
    kind: isMissingPrefabPlaceholder(entityId) ? 'placeholder' : 'entity',
    resolve(): number | null {
      if (guid) { const id = idForGuid(guid); return id || null; }
      // un-guidable: raw-id fallback, valid only within the world it was taken in.
      return rawIdIn(rawId, world);
    },
    require(expect?: RefExpect): number {
      return requireResolved(ref, ref.resolve(), expect);
    },
  };
  _refWorlds.set(ref, world);
  return ref;
}

/** The World each ref was taken in, for `resolveWith`/`resolveRefs`, which resolve a ref against an index. */
const _refWorlds = new WeakMap<EntityRef, World>();

/** `rawId` while `world` is still the live one and holds it, else null. */
function rawIdIn(rawId: number, world: World | undefined): number | null {
  if (world !== undefined && world !== getCurrentWorld()) return null;
  return findEntity(rawId) ? rawId : null;
}

/** The refusal for `ref` resolved to `id`, or `id` itself: `require`'s one body, shared by `requireWith`. */
function requireResolved(ref: EntityRef, id: number | null, expect?: RefExpect): number {
  const label = `"${ref.name || ref.guid || `id:${ref.rawId}`}"`;
  if (id == null) {
    throw new UndoRefusedError(
      `${label} (${journalRefOf(ref.guid, ref.rawId)}) is no longer in the scene, so the step would act on nothing, or on whatever holds its place now.`,
      `${label} is no longer in the scene`,
    );
  }
  const want = expect?.kind ?? ref.kind;
  const now: EntityKind = isMissingPrefabPlaceholder(id) ? 'placeholder' : 'entity';
  if (now !== want) {
    const words = now === 'placeholder'
      ? placeholderRefusalWords(entityNameOf(id) || ref.name)
      : `${label} is not a Missing Prefab any more (its prefab was restored and the scene reloaded), and this step was recorded against the placeholder`;
    throw new UndoRefusedError(`${words}.`, words);
  }
  const why = expect?.check?.(id);
  if (why) throw new UndoRefusedError(`${label} ${why}.`, `${label} ${why}`);
  return id;
}

/** A `RefExpect.check` for a step whose forward half left its target an instance ROOT (Create Prefab's undo): the
 *  refusal's words when entity `id` is not one now, else null. Revert's undo asks the finer "an instance of THIS
 *  source" itself. */
export function isInstanceRootCheck(id: number): string | null {
  const meta = getTraitByName('PrefabInstance');
  const pi = meta ? readTraitData(id, meta) as { rootInstanceId?: number } | null : null;
  return pi && pi.rootInstanceId === id ? null : 'is no longer a prefab instance root';
}

/** `require` against a prebuilt guid→id index (`buildGuidIndex`): for a closure that requires many refs.
 *
 *  `renamed` (old guid → new guid) is for an undo that runs while a guid rename its own forward step made is still in
 *  force, and reverses it only later in the step: a Detach-on-move promotion renames members (#1447), and the undo takes
 *  the rename back AFTER it has asked for its refs, which were taken before the rename. Followed transitively (a → b → c,
 *  two promotions in turn). */
export function requireWith(ref: EntityRef, index: Map<string, number>, expect?: RefExpect, renamed?: ReadonlyMap<string, string>): number {
  if (!ref.guid || !renamed?.size) return requireResolved(ref, resolveWith(ref, index), expect);
  let g = ref.guid;
  for (let hops = 0; renamed.has(g) && hops < renamed.size; hops++) g = renamed.get(g)!;
  return requireResolved(ref, index.get(g) ?? null, expect);
}

/** Each detached member an undo relinks (`relinkDetachedMembers`), required live and not a Missing Prefab placeholder
 *  before anything is written (I19, I20). The relink itself skips a member it cannot find, and would put
 *  `PrefabInstance` back onto a placeholder: an orphan the frame-ending promoted and a world swap later made one. Found
 *  through `renamed`, like every ref taken before the rename. */
export function requireDetachedMembers(
  members: readonly { guid: string }[], index: Map<string, number>, renamed?: ReadonlyMap<string, string>,
  /** Guids the step itself brings back before it relinks (a delete's own targets): absent now, and not a miss. */
  respawned?: ReadonlySet<string>,
): void {
  for (const m of members) {
    if (!m.guid || respawned?.has(m.guid)) continue;
    let g = m.guid;
    for (let hops = 0; renamed?.has(g) && hops < renamed.size; hops++) g = renamed.get(g)!;
    const id = index.get(g);
    if (id == null) {
      throw new UndoRefusedError(`A member this step relinks (${m.guid}) is no longer in the scene, so it cannot be linked back.`, 'a member it links back is no longer in the scene');
    }
    if (isMissingPrefabPlaceholder(id)) {
      const words = placeholderRefusalWords(entityNameOf(id));
      throw new UndoRefusedError(`${words}.`, words);
    }
  }
}

/** The old → new guid renames a set of `DetachedMember`s carries (`renamed` pairs, in the order they were applied), for
 *  `requireWith`. */
export function renamesOf(members: readonly { renamed?: readonly (readonly [string, string])[] }[], into: Map<string, string> = new Map()): Map<string, string> {
  for (const m of members) for (const [a, b] of m.renamed ?? []) into.set(a, b);
  return into;
}

/** Every ref in `refs` required against one index, in order: the ids, or the first refusal. Asked BEFORE the step
 *  writes, so a refusal leaves nothing half-applied. */
export function requireAll(refs: readonly EntityRef[], expect?: RefExpect, index: Map<string, number> = buildGuidIndex()): number[] {
  return refs.map((r) => requireWith(r, index, expect));
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
  return rawIdIn(ref.rawId, _refWorlds.get(ref));
}

/** Resolve a batch of refs to live ids, dropping any that no longer resolve.
 *  Pass a prebuilt index to share one world scan across several resolveRefs calls. */
export function resolveRefs(refs: EntityRef[], index?: Map<string, number>): number[] {
  const idx = index ?? buildGuidIndex();
  const ids: number[] = [];
  for (const r of refs) {
    const id = r.guid ? (idx.get(r.guid) ?? 0) : (rawIdIn(r.rawId, _refWorlds.get(r)) ?? 0);
    if (id) ids.push(id);
  }
  return ids;
}
