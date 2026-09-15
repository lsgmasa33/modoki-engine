/** ECS World — entity index helpers and world registry re-exports.
 *
 *  The singleton `world` export was removed; consumers must call getCurrentWorld()
 *  inside callbacks/functions (never capture at module load) so world swaps take
 *  effect immediately. */

import { $internal, type Entity, type World } from 'koota';
import { getCurrentWorld, getEntityIndex, getGuidIndex, peekCurrentWorld } from './worldRegistry';
import { EntityAttributes } from '../traits/EntityAttributes';
import { emit, entityRef, isJournalEnabled } from '../journal';
import { inSystemTick } from '../systemTick';
import { Transient } from '../traits/Transient';
import { formatRuntimeGuid, parseRuntimeGuid, isRuntimeGuid } from '../assetRefRules';
import { packedOf, type PackedEntity } from './entityTable';

export { getCurrentWorld, setCurrentWorld, onWorldSwap, getGuidIndex, peekCurrentWorld } from './worldRegistry';

/** Read an entity's stable guid ('' if absent/un-guidable). Sync + dependency-free
 *  so the guid index can be maintained inside registerEntity. */
function guidOf(entity: any): string {
  try {
    return entity.has(EntityAttributes) ? ((entity.get(EntityAttributes)?.guid as string) || '') : '';
  } catch { return ''; }
}

// Pluggable structure-dirty callback — set by entityUtils at init to avoid circular imports.
let _onStructure: (() => void) | null = null;
/** Register the structure-dirty callback. Called once by entityUtils. */
export function setStructureCallback(fn: (() => void) | null) { _onStructure = fn; }

/** Find an entity by numeric ID in the given world (defaults to current main). */
export function findEntityById(entityId: number, world: World = getCurrentWorld()): Entity | undefined {
  return getEntityIndex(world).get(entityId);
}

/** Find an entity by its stable guid in the given world (O(1) via the guid index).
 *  Returns undefined for ''/unknown. Self-healing: on a miss it does ONE full scan,
 *  repopulates the whole guid map, and retries — so correctness holds even if a guid
 *  mint site forgot to call indexEntityGuid (the explicit wiring is just for speed).
 *
 *  ⚠️ The rescan runs only when a guid could have APPEARED since the last one (see
 *  {@link GuidEpoch}). It used to run on every miss, so a guid held across frames and polled after
 *  its entity was gone paid a whole-world scan per call — measured 0.13 ms at 1k entities and
 *  1.6 ms at 10k, against ~150 ns for a hit (#1222). */
export function findEntityByGuid(guid: string, world: World = getCurrentWorld()): Entity | undefined {
  if (!guid) return undefined;
  // A runtime guid (#1210) resolves through its world's address table, never the rescan: it names
  // the entity it was MINTED for, even after a save re-minted that entity a durable guid, and a
  // stale one (another world's generation, a despawned entity) misses in O(1).
  const runtime = parseRuntimeGuid(guid);
  if (runtime) return resolveRuntimeGuid(runtime, world);
  const idx = getGuidIndex(world);
  let entity = idx.get(guid);
  if (entity && guidOf(entity) === guid) return entity;
  // Miss (or stale) → rescan and retry, unless nothing that can add a guid has happened since the
  // last rescan — which already put every guid in the world into the index.
  const epoch = guidEpochFor(world);
  if (epoch && epoch.scannedAt === epoch.value) return undefined;
  rebuildGuidIndexSync(world);
  entity = idx.get(guid);
  return entity && guidOf(entity) === guid ? entity : undefined;
}

/** {@link findEntityByGuid} for a caller running INSIDE a structure change — a live, registered
 *  entity carrying `guid`, or undefined. It never rescans: `unregisterEntity` fires its structure
 *  callback after the index drops the entity but before `destroy()`, so a rescan there would index
 *  the dying entity by its guid and a later lookup could hand back the corpse. A guid written onto an
 *  entity by a site that forgot `indexEntityGuid` is therefore invisible here until a rescan
 *  (`editor/store/heldEntity.ts` re-asks a frame later through `findEntityByGuid` for that reason). */
export function peekEntityByGuid(guid: string, world: World = getCurrentWorld()): Entity | undefined {
  if (!guid) return undefined;
  const runtime = parseRuntimeGuid(guid);
  const entity = runtime ? resolveRuntimeGuid(runtime, world) : getGuidIndex(world).get(guid);
  if (!entity || !isLive(entity) || (!runtime && guidOf(entity) !== guid)) return undefined; // a runtime guid survives a re-mint (#1210)
  return getEntityIndex(world).get(entity.id()) === entity ? entity : undefined;
}

/** Per-world counter of everything that can put a guid on a live entity, driven by koota itself:
 *  `onAdd(EntityAttributes)` (every spawn carrying it, and a later `entity.add`) and
 *  `onChange(EntityAttributes)` (every `entity.set`, which is the only way to write a SoA trait's
 *  field — `writeTraitField` and the runtime mint included). `scannedAt` is the value when the index
 *  was last rebuilt from the world: while the two match, a miss is a real miss and scanning again
 *  could not find it.
 *
 *  Why koota's events and not calls at our own mint sites: the rescan exists precisely for a site
 *  that forgot `indexEntityGuid`, so the gate must see a write nobody announced. An explicit bump in
 *  `registerEntity` was tried and removed — `onAdd` already covers every spawn, so no test could
 *  fail without it. The subscriptions are taken on the world's first miss; before that there is
 *  nothing to invalidate (`scannedAt` starts at -1).
 *
 *  ⚠️ A removal CAN strand a findable guid, when two live entities share one (a hand- or agent-edited
 *  scene file loads both; only chain scenes filter duplicates). The index holds ONE of them, so
 *  destroying the indexed one used to leave the other reachable only through the rescan this gate
 *  now skips. So a guid the RESCAN finds on two entities is recorded (`duplicateGuids`), and
 *  `unregisterEntity` bumps for exactly those. The rescan is the only place that needs to notice: a
 *  duplicate that arrives by a spawn or a write bumps the epoch itself, so the next miss rescans and
 *  records it before the gate can close on it. (Noting collisions in `registerEntity` too was tried
 *  and removed at the scoped review — no sequence could make it matter.) Bumping on every destroy would reopen the rescan every
 *  frame in a game that destroys every frame (#1222 close-out review).
 *
 *  Not covered, and not reachable today: a world's FIRST miss taken inside an `updateEach` over
 *  `EntityAttributes` whose callback then writes `ea.guid` back through the state object. koota fixes
 *  the loop's change tracking when it starts, so that write fires no `onChange`. No engine loop over
 *  `EntityAttributes` writes a field (26 sites, read at the review). */
interface GuidEpoch { value: number; scannedAt: number; rescans: number }
const guidEpochs = new WeakMap<World, GuidEpoch>();
/** Durable guids the index has seen on more than one live entity in a world — see {@link GuidEpoch}. */
const duplicateGuids = new WeakMap<World, Set<string>>();

function noteDuplicateGuid(world: World, guid: string): void {
  let d = duplicateGuids.get(world);
  if (!d) { d = new Set(); duplicateGuids.set(world, d); }
  d.add(guid);
}

function isLive(entity: Entity): boolean {
  try { return entity.isAlive(); } catch { return false; }
}

function guidEpochFor(world: World): GuidEpoch | undefined {
  let e = guidEpochs.get(world);
  if (!e) {
    const epoch: GuidEpoch = { value: 0, scannedAt: -1, rescans: 0 };
    // `world.reset()` drops every koota subscription without a word, and a gate whose bumps have
    // stopped arriving turns a findable guid into a permanent miss. koota's own React bindings
    // survive a reset through the reset-subscription set on `$internal` (koota/react `useQuery`),
    // and so does this: a reset forgets the epoch, so the next miss subscribes and rescans afresh.
    // Without that hook (a koota that moved it) there is no gate at all — every miss rescans, as
    // before #1222. Measured on koota 0.6.6; `engine/tests/editor/watch.test.ts` resets one world
    // per case and is what found this.
    const resets = (world as unknown as Record<symbol, { resetSubscriptions?: Set<(w: World) => void> }>)[$internal]?.resetSubscriptions;
    if (!resets) return undefined;
    e = epoch;
    guidEpochs.set(world, epoch);
    const bump = () => { epoch.value++; };
    try {
      world.onAdd(EntityAttributes, bump);
      world.onChange(EntityAttributes, bump);
      resets.add(function forget() { resets.delete(forget); guidEpochs.delete(world); });
    } catch { guidEpochs.delete(world); return undefined; } // a destroyed world: no gate
  }
  return e;
}

/** Whole-world guid rescans `world` has run, so a test can tell a gated miss from a rescanned one
 *  (both return undefined). @internal */
export function _guidIndexRescans(world: World): number { return guidEpochs.get(world)?.rescans ?? 0; }


// ── Runtime guids (#1210) ───────────────────────────────────────────────────────────────────
// An entity spawned with an empty `EntityAttributes.guid` gets a RUNTIME guid at spawn:
// `00000000-GGGG-GGGG-0000-NNNNNNNNNNNN` (`isRuntimeGuid`). N counts EntityAttributes spawns in its
// world, so the same spawn order yields the same guids (replays, journal comparisons). G is the
// world's GENERATION, and it is what makes a stale guid MISS instead of naming a different entity:
//
// ⚠️ G is a counter this module owns, incremented once per world — never koota's world id or entity
// generation. koota packs 4 bits of world id and 8 of generation and reuses both across a swap
// (see entityTable.ts), so either would let a guid from the outgoing world match an entity in the
// incoming one. A per-world counter alone would too: every world would start again at 1.
//
// It is an ADDRESS, not a lifetime key, and not a persistent identity: nothing may persist one
// (`durableGuid`, `assertNoRuntimeGuids`), and per-entity state keys by `packedOf`/EntityTable.

interface RuntimeAddresses {
  /** This world's generation — assigned on its first mint. */
  generation: number;
  /** The ordinal the next mint gets. */
  next: number;
  /** ordinal → entity, for lookup. Holds live entities only (`unregisterEntity` removes). */
  entityOf: Map<number, Entity>;
  /** packed entity → ordinal, so unregister finds the row even after the guid was re-minted. */
  ordinalOf: Map<PackedEntity, number>;
}

const runtimeAddresses = new WeakMap<World, RuntimeAddresses>();
let nextRuntimeGeneration = 1;

function runtimeAddressesFor(world: World): RuntimeAddresses {
  let t = runtimeAddresses.get(world);
  if (!t) {
    t = { generation: nextRuntimeGeneration++, next: 1, entityOf: new Map(), ordinalOf: new Map() };
    runtimeAddresses.set(world, t);
  }
  return t;
}

function resolveRuntimeGuid(g: { generation: number; ordinal: number }, world: World): Entity | undefined {
  const t = runtimeAddresses.get(world);
  if (!t || t.generation !== g.generation) return undefined;
  const entity = t.entityOf.get(g.ordinal);
  if (!entity) return undefined;
  try { return entity.isAlive() ? entity : undefined; } catch { return undefined; } // destroyed world throws
}

/** Give `entity` a runtime guid when it carries EntityAttributes with an empty guid — or with a
 *  runtime guid it was COPIED with (a Persistent/base-scene carry, an undo respawn, a snapshot). A
 *  fresh spawn never owns an existing address: that row belongs to the entity it was minted for (or
 *  to a dead world), so keeping it would leave this entity answering to nothing. Must run BEFORE
 *  `registerEntity`, so the guid index and the `@spawn` journal ref both see the guid. */
function mintRuntimeGuid(entity: any, world: World): void {
  let ea: Record<string, unknown> | undefined;
  try { ea = entity.has(EntityAttributes) ? (entity.get(EntityAttributes) as Record<string, unknown>) : undefined; } catch { ea = undefined; }
  if (!ea || (ea.guid && !isRuntimeGuid(ea.guid as string))) return;
  const t = runtimeAddressesFor(world);
  const ordinal = t.next++;
  t.entityOf.set(ordinal, entity);
  t.ordinalOf.set(packedOf(entity), ordinal);
  entity.set(EntityAttributes, { ...ea, guid: formatRuntimeGuid(t.generation, ordinal) });
}

/** The runtime-guid generation counter, for `createTestWorld` to save on create and restore on
 *  dispose — so two identical harness runs mint identical guids. Restored, never zeroed: a world
 *  created before the test world may still hold a generation, and zeroing would re-issue it.
 *  @internal */
export function _getRuntimeGuidGeneration(): number { return nextRuntimeGeneration; }
/** @internal — see {@link _getRuntimeGuidGeneration}. */
export function _setRuntimeGuidGeneration(n: number): void { nextRuntimeGeneration = n; }
/** Live rows in `world`'s runtime-address table. A per-shot spawner must not grow it: the row is
 *  dropped in `unregisterEntity`, and `isAlive()` on lookup only hides a stale row, it does not free
 *  it — so this is how a test tells "misses" from "misses AND was released". @internal */
export function _runtimeAddressRows(world: World): number { return runtimeAddresses.get(world)?.entityOf.size ?? 0; }

/** (Re)index an entity's current guid. Call after a '' → guid mint so the index
 *  reflects the new guid without waiting for the scan fallback. */
export function indexEntityGuid(entity: any, world: World = getCurrentWorld()) {
  const guid = guidOf(entity);
  if (guid && !isRuntimeGuid(guid)) getGuidIndex(world).set(guid, entity);
}

/** Percept (J3): journal a spawn/despawn — but ONLY in the currently-active world.
 *  Scene load spawns into a staging world and teardown drops an old world, both
 *  ≠ current, so this naturally skips the bulk load/teardown flood and records only
 *  runtime (gameplay/editor) spawns + deletes. Safe if no current world is set. */
function emitLifecycle(type: '@spawn' | '@despawn', entity: any, world: World) {
  // Cheapest guards first: skip entirely when journaling is off (prod) — no
  // entityRef/alloc. peek (not getCurrentWorld) — must NOT lazily allocate a world.
  if (!isJournalEnabled() || world !== peekCurrentWorld()) return;
  emit(type, { entity: entityRef(entity) }, world);
}

/** Register an entity in the given world's index. Called after world.spawn(). */
export function registerEntity(entity: any, world: World = getCurrentWorld()) {
  getEntityIndex(world).set(entity.id(), entity);
  const guid = guidOf(entity); // durable for loaded/serialized entities; a runtime guid for fresh ones
  // A runtime guid resolves through the address table, never this index — indexing it would only
  // leave a dead key behind once a save re-mints the entity's guid (#1210).
  if (guid && !isRuntimeGuid(guid)) getGuidIndex(world).set(guid, entity);
  _onStructure?.();
  emitLifecycle('@spawn', entity, world);
}

/** Spawn an entity AND put it in the world's index — the only sanctioned way to create one.
 *
 *  `world.spawn()` is koota's API, so nothing could make registration automatic; `registerEntity`
 *  has always been a second call you had to remember. Every production site DID remember (a sweep
 *  found no exception), but the harness and nine test files did not — and an unregistered entity
 *  is invisible to the O(1) index, so every lookup falls back to an O(n) scan. That is not merely
 *  slow: engine code under those tests took a DIFFERENT path than the same code takes in the
 *  running game, and it announced itself as 21,906 warning lines in one CI run before anyone
 *  noticed (2026-08-04).
 *
 *  There is no case for spawning without registering — hence this helper, and the ESLint rule that
 *  bans a bare `.spawn(` everywhere except right here.
 *
 *  Also the one place that tags a RUNTIME spawn `Transient` (#124). Every load-time spawn
 *  (scene load, GLB import, SceneManager, the headless harness) runs OUTSIDE a system tick, so
 *  it is unaffected; a spawn made from INSIDE a registered system's `fn(world)` — e.g. a
 *  PROJECTION-tier system like chess's board sync, which runs even while the editor is stopped
 *  (see pipeline.ts's `runPipeline`) — gets tagged so the serializer skips it and its subtree
 *  instead of baking generated/derived entities into the scene file on save.
 *
 *  `inSystemTick()` is a synchronous flag (set for the duration of the system loop only), so a
 *  spawn made from an ASYNC continuation a system merely STARTED — e.g. a GLB load resolving
 *  after the tick that kicked it off has already ended — lands outside the tick and is NOT
 *  tagged. That's a known, deliberate gap: it errs toward the spawned entity getting SAVED
 *  rather than silently dropped, which is the safe direction for what is fundamentally a
 *  data-loss-shaped bug — a false negative here just re-creates the old behavior for that one
 *  case, a false positive would destroy the caller's data. */
export function spawnEntity(world: World, ...traits: Parameters<World['spawn']>) {
  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned world.spawn in the engine
  const entity = world.spawn(...traits);
  if (inSystemTick()) entity.add(Transient);
  mintRuntimeGuid(entity, world); // before registerEntity: the index and `@spawn` see the guid (#1210)
  registerEntity(entity, world);
  return entity;
}

/** Destroy an entity AND drop it from the world's index — the symmetric partner of spawnEntity,
 *  and the only sanctioned way to remove one.
 *
 *  Forgetting this half is WORSE than forgetting to register. An unregistered entity merely costs
 *  an O(n) scan and is still correct; an unregistered DESTROY leaves a live index entry pointing at
 *  a dead entity, so `findEntityById` hands back a corpse and the caller reads traits off it. Two
 *  sites in the since-deleted `games/agy` scaffold did exactly that (2026-08-04), found by asking
 *  whether the spawn fix had a mirror image — it did. */
export function destroyEntity(entity: any, world: World = getCurrentWorld()) {
  unregisterEntity(entity, world);
  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned entity.destroy() in the engine
  entity.destroy();
}

/** Unregister an entity from the given world's index. Called before entity.destroy(). */
export function unregisterEntity(entity: any, world: World = getCurrentWorld()) {
  emitLifecycle('@despawn', entity, world); // before index removal — entity still live
  getEntityIndex(world).delete(entity.id());
  const guid = guidOf(entity);
  if (guid) {
    const idx = getGuidIndex(world);
    const held = idx.get(guid);
    if (held !== undefined && (held === entity || !isLive(held))) idx.delete(guid); // never evict another live holder
    // Another live entity may still carry this guid, unindexed: let the next miss rescan for it.
    if (duplicateGuids.get(world)?.has(guid)) { const e = guidEpochs.get(world); if (e) e.value++; }
  }
  const t = runtimeAddresses.get(world);
  if (t) {
    const packed = packedOf(entity);
    const ordinal = t.ordinalOf.get(packed);
    if (ordinal !== undefined) { t.ordinalOf.delete(packed); t.entityOf.delete(ordinal); }
  }
  // The mirror of registerEntity's bump (#1220). Without it a destroy moved no version at all, so a
  // memo keyed on the structure version kept a destroyed entity's row until the next spawn anywhere
  // bumped it. Structure listeners only set dirty flags (notifyListeners isolates a throwing one), so
  // firing before `entity.destroy()` lets nothing rebuild from the corpse.
  _onStructure?.();
}

/** Rebuild the guid→entity index by walking EntityAttributes-tagged entities.
 *  Sync (the trait is statically imported) so findEntityByGuid can self-heal. */
export function rebuildGuidIndexSync(world: World = getCurrentWorld()) {
  const idx = getGuidIndex(world);
  const epoch = guidEpochFor(world);
  if (epoch) { epoch.scannedAt = epoch.value; epoch.rescans++; } // before the walk: a write DURING it bumps past this
  idx.clear();
  try {
    world.query(EntityAttributes).updateEach(([ea]: any[], entity: any) => {
      const g = (ea?.guid as string) || '';
      // Runtime guids never enter the index: they resolve through the address table (#1210).
      if (!g || isRuntimeGuid(g)) return;
      if (idx.has(g)) noteDuplicateGuid(world, g); // first wins (guids must be unique) — but remember
      else idx.set(g, entity);
    });
  } catch { /* EntityAttributes not in this world */ }
}

// Expose live current-world getter for debug console: window.__ecsWorld
// Use a getter so it always reflects the current world, not a stale capture.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  Object.defineProperty(window, '__ecsWorld', {
    configurable: true,
    get: getCurrentWorld,
  });
}
