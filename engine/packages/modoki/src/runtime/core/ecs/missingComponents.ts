import { findEntityById } from './world';
import { getTraitByName } from './traitRegistry';

/** The data of a component whose trait this build does not register, kept for its entity (#1933 N1b, #1938 F-CB3's data
 *  half; Unity keeps a "Missing (Mono Script)" component's data until it is removed on purpose).
 *
 *  The spawner cannot make such a component, so the entity is spawned without it, and every writer that builds an
 *  entity's traits from the live world used to drop it on the next save: a renamed or deleted trait, or game code that
 *  failed to load, silently erased that data from the scene or prefab. The load records each such component here under
 *  the entity's guid, verbatim, and those writers put it back (`withMissingComponents`), beside the traits the entity
 *  carries. A trait registered later is still written from here (the entity was spawned without it).
 *
 *  Keyed by the guid the live entity carries, as R2's kept stores are keyed by root guid — so a delete and its undo, which
 *  respawns the entity under a new id and the same guid, keep it. Every load sets or clears the record of each entity it
 *  spawns, so a component removed from the file outside the editor does not come back. A record whose entity is gone is
 *  never written (the writers walk live entities). The Inspector shows each as a read-only "Missing component" row with a
 *  Remove (#1944, `editor/panels/missingComponentRows.ts`), the one act that drops the data on purpose; a duplicate or
 *  paste carries it under the copy's guid (`EntitySnapshot.missing`).
 *
 *  ⚠️ A guid is unique within a file by rule, not by load (scene-loading.md § "Guid uniqueness"; refusing such a file is
 *  #1937 C-A step 5, parked). So the record also names the entity that OWNS it (close-out review #4: two entities on one
 *  guid lost the owner's component when its twin spawned second, or wrote it onto both when the twin spawned first): a
 *  record set in this load is not cleared by a twin spawned later in it, and a writer puts it back only on its owner — or,
 *  once the owner no longer carries that guid (deleted, or respawned by an undo), on the entity that does. */

type MissingRecord = { bag: Record<string, unknown>; owner: number; load: number };
const byGuid = new Map<string, MissingRecord>();
let currentLoad = 0;
/** A load begins: records set from here on are this load's, and a twin's clear does not take them. */
export function beginMissingComponentsLoad(): void {
  currentLoad++;
}

/** Record `bag` (trait name → the file's data, verbatim) as the missing components of entity `owner`, which carries
 *  `guid` — or clear the guid's record, unless this load already set it for a twin. */
export function setMissingComponents(guid: string, bag: Record<string, unknown> | undefined, owner: number): void {
  if (!guid) return;
  if (bag && Object.keys(bag).length) byGuid.set(guid, { bag, owner, load: currentLoad });
  else if (byGuid.get(guid)?.load !== currentLoad) byGuid.delete(guid);
}

/** Entity `guid`'s missing components, or undefined. */
export function missingComponentsOf(guid: string): Readonly<Record<string, unknown>> | undefined {
  return guid ? byGuid.get(guid)?.bag : undefined;
}

/** The guid live entity `id` carries, or '' (gone, or no EntityAttributes). */
function liveGuidOf(id: number): string {
  const ea = getTraitByName('EntityAttributes');
  const e = findEntityById(id);
  return ea && e?.has(ea.trait) ? String((e.get(ea.trait) as { guid?: unknown }).guid ?? '') : '';
}

/** `traits` with the missing components of entity `id` (which carries `guid`) put back: each one under its name, unless
 *  `traits` states that name already (the live entity carries it, a trait registered since). Not when another live
 *  entity owns the guid's record. Returns `traits` itself when there is nothing to add. */
export function withMissingComponents<T extends Record<string, unknown>>(traits: T, guid: string, id: number): T {
  const missing = missingComponentsFor(guid, id);
  if (!missing) return traits;
  const out: Record<string, unknown> = { ...traits };
  for (const [name, data] of Object.entries(missing)) if (!(name in out)) out[name] = structuredClone(data);
  return out as T;
}

/** The missing components the writers would put back on live entity `id` (which carries `guid`): its record, unless
 *  another live entity owns it. What the Inspector shows, so it shows exactly what the next save writes. */
export function missingComponentsFor(guid: string, id: number): Readonly<Record<string, unknown>> | undefined {
  const rec = guid ? byGuid.get(guid) : undefined;
  if (!rec || (rec.owner !== id && liveGuidOf(rec.owner) === guid)) return undefined;
  return rec.bag;
}

/** Take component `name` out of `guid`'s record (#1944's Remove) — so no writer puts it back — and return its data and
 *  the record's owner, for the undo. A record left empty goes. Undefined when there was nothing to take. The bag is
 *  replaced, not edited: the load's own object is not this module's to change. */
export function removeMissingComponent(guid: string, name: string): { data: unknown; owner: number } | undefined {
  const rec = guid ? byGuid.get(guid) : undefined;
  if (!rec || !Object.hasOwn(rec.bag, name)) return undefined;
  const { [name]: data, ...rest } = rec.bag;
  if (Object.keys(rest).length) byGuid.set(guid, { ...rec, bag: rest });
  else byGuid.delete(guid);
  return { data, owner: rec.owner };
}

/** Put component `name` back into `guid`'s record, owned by live entity `owner` — the undo of
 *  {@link removeMissingComponent}. */
export function restoreMissingComponent(guid: string, name: string, data: unknown, owner: number): void {
  if (!guid) return;
  const rec = byGuid.get(guid);
  // `load: -1`: no load set it, so no load's twin-clear rule reads it as this load's.
  byGuid.set(guid, rec ? { ...rec, bag: { ...rec.bag, [name]: data } } : { bag: { [name]: data }, owner, load: -1 });
}

/** Drop every record. For tests and the fuzz harness — production keeps them for the process, refreshed by each load. */
export function clearMissingComponents(): void {
  byGuid.clear();
}
