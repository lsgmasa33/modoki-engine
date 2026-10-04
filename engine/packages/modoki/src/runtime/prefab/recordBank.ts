/**
 * #2046 S7.6: the exact records of a world the editor reloads from its own serialized text.
 *
 * Stop's restore, a timeline preview's exit and a prefab edit's leave each bring back a world the editor held, by
 * reloading the text that world serialized to (the envelope's snapshot, or the file the prefab edit's open saved). The
 * load then holds that text's PARSE, which can state a record in another form than the list the editor kept (rule 8:
 * a list changes only by a gesture). So the leaver BANKS the world's store with the entries it serialized, under the
 * key the reload loads, and the load seats a banked record in place of the parse where both of these hold:
 *  - its top-level entry's text is the banked one (nothing rewrote that entry while the world was away: an outside
 *    edit, a discarded edit the file never got), and
 *  - its fold is the parse's (the live tree the load projected from the parse is then the banked record's projection
 *    too, so no tree is rebuilt).
 * Every other record the reloaded entries state keeps the load's parse, fresh (#2001 S8b): an entry rewritten while away,
 * a root the bank does not hold, a fold that differs (a template change while away, a prefab edit), and a banked record
 * that was stale. The parse is the record of the text the load spawned the tree from, so it is that tree's record exactly,
 * as any load's is; before S8b it was marked stale by the leaver's op, and re-seeded from the capture of that same tree.
 * One bank per key; the load of that key takes it, whichever route loads it.
 */
import type { World } from 'koota';
import type { SceneEntityEntry } from '../loaders/loadSceneFile';
import type { InstanceRecord, PrefabReader } from './instanceRecord';
import { foldInstance } from './foldInstance';
import { setInstanceRecord, storedInstance, storedInstances, type StoredInstance } from './instanceStore';

export interface RecordBank {
  /** The world's stored instances, cloned when banked. */
  stored: Map<string, StoredInstance>;
  /** Each top-level entry the banked text holds, by its guid, as JSON. */
  entries: Map<string, string>;
}

const banks = new Map<string, RecordBank>();

/** An entry as comparable text. The load numbers each entity node it spawns (`id`, on the entry object it was handed), so
 *  a node's numeric `id` is not compared, on either side: an entity node is any object holding `traits`. */
const entryText = (e: SceneEntityEntry): string =>
  JSON.stringify(e, function (this: Record<string, unknown>, k, v: unknown) { return k === 'id' && typeof v === 'number' && 'traits' in this ? undefined : v; });

const entryGuid = (e: SceneEntityEntry): string | undefined =>
  e.guid || ((e.traits?.EntityAttributes as { guid?: string } | undefined)?.guid);

/** `world`'s stored instances, cloned: what {@link bankInstanceRecords} banks. */
export function cloneInstanceStore(world: World): Map<string, StoredInstance> {
  const stored = new Map<string, StoredInstance>();
  for (const [g, s] of storedInstances(world)) stored.set(g, structuredClone(s));
  return stored;
}

/** A stored instance as comparable text, its Maps and Sets as their entries: equal text, the same record and stale mark. */
export const storedText = (s: StoredInstance | undefined): string =>
  JSON.stringify(s, (_k, v: unknown) => v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v) ?? '';

/** `world`'s stored instances now ({@link cloneInstanceStore}), less every one that differs from `before` (a clone taken
 *  when the caller began serializing). The serialize awaits, and an edit can land meanwhile: a record taken after it
 *  would state an edit the banked text may not, which neither comparison catches when the fold is unchanged (#2046 S7
 *  close-out review). A record left out is not seated: the load keeps its parse, stale. */
export function steadyRecords(before: ReadonlyMap<string, StoredInstance>, world: World): Map<string, StoredInstance> {
  const out = new Map<string, StoredInstance>();
  for (const [g, s] of cloneInstanceStore(world)) if (storedText(s) === storedText(before.get(g))) out.set(g, s);
  return out;
}

/** Bank `stored` ({@link cloneInstanceStore}) for the next load of `key`, with the entries the world serialized to.
 *  Returns the bank, for {@link dropRecordBank}. */
export function bankInstanceRecords(key: string, stored: Map<string, StoredInstance>, entries: readonly SceneEntityEntry[] | undefined): RecordBank {
  const byGuid = new Map<string, string>();
  for (const e of entries ?? []) { const g = entryGuid(e); if (g) byGuid.set(g, entryText(e)); }
  const bank = { stored, entries: byGuid };
  banks.set(key, bank);
  return bank;
}

/** Drop `bank` from `key` if it is still the one banked there: a route that banked and then did not leave (a refused or
 *  superseded prefab-edit open, a Stop whose reload threw). Left behind, it was taken by the next load of that key,
 *  whichever route made it (#2046 S7 close-out review). A newer route's bank under the same key is kept. */
export function dropRecordBank(key: string, bank: RecordBank): void {
  if (banks.get(key) === bank) banks.delete(key);
}

/** The file a bank was made for MOVED (#2096, B3 rule 12): the bank follows it, so the load of `to` takes it. Left at
 *  `from`, the reload of the moved scene parsed every record afresh, and the next load of a file made at `from` took a
 *  bank of another world. */
export function rekeyRecordBank(from: string, to: string): void {
  const b = banks.get(from);
  if (!b || from === to) return;
  banks.delete(from);
  banks.set(to, b);
}

/** The bank for `key`, taken: the load of `key` calls this once, before its entry loop, so a bank serves one load. */
export function takeRecordBank(key: string): RecordBank | undefined {
  const b = banks.get(key);
  banks.delete(key);
  return b;
}

/** The fold as comparable text: every Map and Set spread, in insertion order (the fold's own, deterministic) — except the
 *  links under each anchor, by guid. The save writes a row's `own` nodes in sibling order, not in the order the links were
 *  made (`serializeInstanceRecord.ts` `ownNodes`), so the parse of the banked text lists them in another order than a
 *  record whose links a gesture made after a reorder (hunt seed 9306): the same nodes under the same anchors, which the
 *  projection places by their own sibling order either way. */
function foldText(read: PrefabReader, rec: InstanceRecord): string | null {
  try {
    const fold = foldInstance(read, rec);
    const anchors = new Map([...fold.anchors].map(([k, refs]) => [k, [...refs].sort((a, b) => a.guid.localeCompare(b.guid))]));
    return JSON.stringify({ ...fold, anchors }, (_k, v: unknown) => v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v);
  } catch { return null; }
}

/** `banked` with every identity pin the file states that it does not hold (#2001 S6). A pin is identity, not an override:
 *  the save writes one for each PRESENT member from the live tree (design § 2.7), so a record need not hold it — until the
 *  member is no longer live. A world reloaded with a prefab gone (a trash's own reload, #2056) shows a placeholder there,
 *  and from then on the record is the pins' only home: seated without them, the next save wrote the entry with no pin and
 *  no row under the missing frame. The list is otherwise the banked one, exactly. */
function withStatedPins(banked: InstanceRecord, parsed: InstanceRecord): InstanceRecord {
  for (const [key, row] of parsed.list.rows) {
    if (row.guid === undefined) continue;
    const have = banked.list.rows.get(key);
    if (!have) banked.list.rows.set(key, { guid: row.guid, ...(row.name !== undefined ? { name: row.name } : {}) });
    else if (have.guid === undefined) { have.guid = row.guid; if (have.name === undefined && row.name !== undefined) have.name = row.name; }
  }
  return banked;
}

/** After the load parsed `entry`'s records into `world` (`rootGuids`): seat each banked record the rules above allow. */
export function adoptBankedRecords(world: World, bank: RecordBank, entry: SceneEntityEntry, rootGuids: readonly string[], read: PrefabReader): void {
  const g = entryGuid(entry);
  const same = !!g && bank.entries.get(g) === entryText(entry);
  for (const rootGuid of rootGuids) {
    const banked = same ? bank.stored.get(rootGuid) : undefined;
    const parsed = storedInstance(world, rootGuid);
    const want = banked && parsed ? foldText(read, banked.record) : null;
    if (want !== null && want === foldText(read, parsed!.record)) setInstanceRecord(world, withStatedPins(structuredClone(banked!.record), parsed!.record));
  }
}
