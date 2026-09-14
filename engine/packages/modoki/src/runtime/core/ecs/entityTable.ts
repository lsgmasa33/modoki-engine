/** Per-entity state that survives across frames, made safe against koota's recycled indices (#868).
 *
 *  ## The hazard, stated once
 *
 *  `entity.id()` is the masked INDEX, not the identity, and koota's free list is LIFO — a despawn
 *  followed by a spawn reclaims the freed index, and in bulk the reuse is total (destroy 8, spawn 8,
 *  get `8..1` back). So any map that holds state across frames and is looked up by `entity.id()`
 *  hands a new entity the dead one's state. `docs/engine-concepts.md` § Entity has the full rule and
 *  the five fixed incidents (#336, #738, #759, #848, #873) that each invented their own shape.
 *
 *  ## The two shapes, and which one to use
 *
 *  - **`PackedEntity`** — a map private to its module, keyed by `packedOf(entity)` (koota's packed
 *    `worldId/generation/index` number). The brand makes `map.set(entity.id(), …)` a type error.
 *    Use it for membership sets and small keyed state nobody else addresses by id.
 *  - **`EntityTable<T>`** — id-keyed, with the generation stored IN the entry beside the payload.
 *    Use it when the id is also an addressing contract other modules call in with (a renderer's
 *    `get(id)`, a sweep driven by an id set), or when entries own something that must be released.
 *
 *  ## What the table guarantees
 *
 *  - **Every READ is generation-checked.** `get`/`has` return nothing for an entry stamped by a
 *    different generation of the same index, and have no side effects.
 *  - **Every WRITE stamps.** `getOrCreate`, `set`, `replace` and `touch` take an `Entity` — never a
 *    bare id — so no payload can be written without stamping it for the entity that owns it. That
 *    is what makes #848's first-cut defect (a generation-checked read with a stamp written only on
 *    BUILD, so a reuse fast-path locked the newcomer out forever) unrepresentable: a reuse path here
 *    IS a `getOrCreate` hit.
 *  - **A write from a LIVE entity evicts a dead one's entry at its index; a write from a DEAD handle
 *    changes nothing it does not own.** An `Entity` captured earlier and used after its despawn (an
 *    async load's `.then`, an `ended` listener, a finished crossfade) would otherwise dispose the
 *    newcomer's live entry and stamp the slot for a corpse. With a dead handle `set`/`replace` store
 *    nothing, `getOrCreate` creates nothing (it may still READ the entry stamped for that handle),
 *    `touch` neither keeps nor evicts, and `delete` removes only an entry stamped for that handle.
 *  - **The stamp lives in the same record as the payload**, so the guard can never outlive, or be
 *    outlived by, the state it describes (#873: "key the reset off the thing being reset").
 *  - **Every exit runs `dispose`** — stale eviction, `delete`, `set` over a different value, the
 *    `endPass` sweep, `retain`, `clear` and the world-swap clear. The one exception is `replace`,
 *    which hands the previous value BACK instead (a crossfade that keeps the old voice fading).
 *
 *  Mismatch policy is REBUILD (dispose, then create for the newcomer). Reset-in-place is the other
 *  way to discharge the obligation (#873) and is deliberately not offered here: it costs an
 *  enumeration of everything a build seeds, and no site that uses this table needs it yet.
 *
 *  ## Where the generation stops discriminating — documented HERE, not at each site
 *
 *  koota 0.6 packs 4 bits of world id, 8 bits of generation and 20 bits of index. So:
 *  - **The generation wraps at 256.** A dead entry is removed only by a WRITE at its index, a sweep
 *    (`endPass`/`retain`) or a clear — never by a read. So an entry can alias a newcomer if its index
 *    is recycled a multiple of 256 times with none of those in between; a hot index (a bullet a
 *    frame) gets there in seconds. A table swept every pass bounds that to one pass; a table that is
 *    only read, or whose owner skips passes (an idle renderer), carries the risk and must say so
 *    where it is declared.
 *  - **A world swap can reuse both the index and the world id** (koota releases and reuses world
 *    ids), so an entry from the outgoing world can match a live entity in the incoming one.
 *    `worldSwap: 'clear'` clears the table on `onWorldSwap`; `'owner-clears'` is for a table whose
 *    OWNER is already per-world or is torn down on the swap (a `WeakMap<World, …>` state, a
 *    per-surface render state) — and it is a claim, so name the teardown in the comment beside it.
 *  - **Two LIVE worlds sharing one table** would alias by index, and eviction could then drop the
 *    other world's live entry. Id-keyed state already had that defect; this type does not fix it.
 *    Give each world its own table. */

import type { Entity } from 'koota';
import { onWorldSwap } from './worldRegistry';

/** koota's packed entity number — generation included. Key private maps by this, never by `id()`. */
export type PackedEntity = number & { readonly __packedEntity: unique symbol };

/** The packed (generation-carrying) identity of `entity`. */
export function packedOf(entity: Entity): PackedEntity {
  return entity.valueOf() as PackedEntity;
}

/** Whether the entity a stored packed value names is still alive — generation AND world checked.
 *  For a reader that holds only a bare id and a stamp recorded earlier (an addressing contract
 *  like `videoElementFor(id)`), so it can refuse a dead owner's entry before the next reconcile
 *  gets to it. koota's own `isAlive()` throws once that world is destroyed; this reads that as dead. */
export function isPackedAlive(packed: number): boolean {
  try {
    return (packed as unknown as Entity).isAlive();
  } catch {
    return false;
  }
}

export interface EntityTableOptions<T> {
  /** Names the table in an error message. */
  label: string;
  /** Release whatever an entry owns. Runs on every exit except `replace` (see the module doc). */
  dispose?: (value: T, id: number) => void;
  /** `'clear'` subscribes to `onWorldSwap` and clears (disposing) on every swap — call `detach()`
   *  if the table itself is ever dropped. `'owner-clears'` subscribes to nothing, because the
   *  object holding the table is already per-world or torn down on the swap. */
  worldSwap: 'clear' | 'owner-clears';
}

interface Entry<T> {
  packed: number;
  value: T;
  /** The `beginPass` number this entry was last touched in. */
  pass: number;
}

export class EntityTable<T> implements Iterable<[number, T]> {
  private readonly entries = new Map<number, Entry<T>>();
  private readonly opts: EntityTableOptions<T>;
  private pass = 0;
  private inPass = false;
  private unsubscribe: (() => void) | undefined;

  constructor(opts: EntityTableOptions<T>) {
    this.opts = opts;
    if (opts.worldSwap === 'clear') this.unsubscribe = onWorldSwap(() => this.clear());
  }

  get size(): number { return this.entries.size; }

  /** The entry `entity` owns, or `undefined` — including when the index holds a dead entity's. */
  get(entity: Entity): T | undefined {
    const e = this.entries.get(entity.id());
    return e && e.packed === entity.valueOf() ? e.value : undefined;
  }

  has(entity: Entity): boolean {
    const e = this.entries.get(entity.id());
    return !!e && e.packed === entity.valueOf();
  }

  /** The entry for `entity`, creating it when absent or when the index held a dead entity's (which
   *  is disposed first). When `create` returns `undefined` — or `entity` is itself dead — nothing is
   *  stored. Touches the entry. */
  getOrCreate(entity: Entity, create: (entity: Entity) => T | undefined): T | undefined {
    const id = entity.id();
    const packed = entity.valueOf();
    const e = this.entries.get(id);
    const alive = entity.isAlive();
    if (e && e.packed === packed) {
      if (alive) e.pass = this.pass; // a dead handle reads its own leftover entry but cannot keep it alive
      return e.value;
    }
    if (!alive) return undefined;
    if (e) this.evict(id, e);
    const value = create(entity);
    if (value !== undefined) this.entries.set(id, { packed, value, pass: this.pass });
    return value;
  }

  /** Store `value` for `entity`, disposing whatever it replaces — this entity's previous value (when
   *  it is a different object) or a dead entity's entry at the index. Touches the entry. A dead
   *  `entity` stores nothing. */
  set(entity: Entity, value: T): void {
    const prev = this.write(entity, value);
    if (prev !== undefined && prev !== value) this.opts.dispose?.(prev, entity.id());
  }

  /** Store `value` for `entity` and hand back this entity's previous value WITHOUT disposing it —
   *  for a caller that keeps the old one alive a while (a crossfade tail). A dead entity's entry at
   *  the index is still disposed, since nobody can hold it. A dead `entity` stores nothing and
   *  returns `undefined`. */
  replace(entity: Entity, value: T): T | undefined {
    return this.write(entity, value);
  }

  /** Remove and dispose `entity`'s entry. A LIVE entity also clears a dead entity's entry at its
   *  index (it can belong to no one live); a dead handle removes only an entry stamped for itself. */
  delete(entity: Entity): boolean {
    const id = entity.id();
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.packed !== entity.valueOf() && !entity.isAlive()) return false;
    this.evict(id, e);
    return true;
  }

  /** Remove and dispose whatever occupies index `id`. For a sweep that already knows the index is
   *  gone (an id-set diff, a teardown); addressing an entity goes through `delete(entity)`. */
  deleteId(id: number): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.evict(id, e);
    return true;
  }

  /** The value at index `id`, WITHOUT a generation check — the last entity reconciled there.
   *  For a consumer that only has an id (a picker, a probe, a sibling renderer sharing the key
   *  space) and treats the result as "what was last drawn at this index", never as proof of whose
   *  state it is. Anything that decides on the payload goes through `get(entity)`. */
  peekId(id: number): T | undefined {
    return this.entries.get(id)?.value;
  }

  hasId(id: number): boolean {
    return this.entries.has(id);
  }

  /** Start a sweep: every entry not `touch`ed (or written) before `endPass` is disposed. Calling it
   *  while a pass is open restarts the pass rather than throwing — a pass abandoned by a throw must
   *  not wedge every later frame (the frame driver retries a throwing callback, then unregisters it
   *  after ten in a row). */
  beginPass(): void {
    this.inPass = true;
    this.pass++;
  }

  /** Mark `entity`'s entry live for this pass. A LIVE entity evicts a dead entity's entry at its
   *  index; a dead handle leaves the slot alone. */
  touch(entity: Entity): void {
    const id = entity.id();
    const e = this.entries.get(id);
    if (!e) return;
    if (!entity.isAlive()) return; // a dead handle keeps nothing alive and evicts nothing
    if (e.packed === entity.valueOf()) e.pass = this.pass;
    else this.evict(id, e);
  }

  /** Dispose every entry not touched since `beginPass`. */
  endPass(): void {
    if (!this.inPass) throw new Error(`[EntityTable:${this.opts.label}] endPass called without beginPass`);
    this.inPass = false;
    const stale = [...this.entries].filter(([, e]) => e.pass !== this.pass);
    this.disposeAll(stale);
  }

  /** Dispose every entry for which `keep` returns false. */
  retain(keep: (value: T, id: number) => boolean): void {
    this.disposeAll([...this.entries].filter(([id, e]) => !keep(e.value, id)));
  }

  /** Dispose every entry, and abandon any open pass. */
  clear(): void {
    this.inPass = false;
    this.disposeAll([...this.entries]);
  }

  /** Stop listening for world swaps (a `worldSwap: 'clear'` table that is itself being dropped). */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  ids(): IterableIterator<number> { return this.entries.keys(); }

  *values(): IterableIterator<T> {
    for (const e of this.entries.values()) yield e.value;
  }

  *[Symbol.iterator](): IterableIterator<[number, T]> {
    for (const [id, e] of this.entries) yield [id, e.value];
  }

  /** Stamp `value` for a live `entity`; returns the previous value of THIS entity, or `undefined`.
   *  A dead entity's entry at the index is evicted (disposed). */
  private write(entity: Entity, value: T): T | undefined {
    const id = entity.id();
    const packed = entity.valueOf();
    if (!entity.isAlive()) return undefined;
    const e = this.entries.get(id);
    if (e && e.packed === packed) {
      const prev = e.value;
      e.value = value;
      e.pass = this.pass;
      return prev;
    }
    if (e) this.evict(id, e);
    this.entries.set(id, { packed, value, pass: this.pass });
    return undefined;
  }

  private evict(id: number, e: Entry<T>): void {
    this.entries.delete(id);
    this.opts.dispose?.(e.value, id);
  }

  /** Remove every listed entry, then dispose each — one throwing `dispose` does not strand the rest
   *  in memory; the first error is rethrown once all have run. */
  private disposeAll(list: ReadonlyArray<[number, Entry<T>]>): void {
    for (const [id] of list) this.entries.delete(id);
    const dispose = this.opts.dispose;
    if (!dispose) return;
    let first: unknown;
    let threw = false;
    for (const [id, e] of list) {
      try {
        dispose(e.value, id);
      } catch (err) {
        if (!threw) { first = err; threw = true; }
      }
    }
    if (threw) throw first;
  }
}
