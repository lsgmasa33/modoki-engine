/** How many UNUSED overrides an instance keeps (#1914 R5, owner ruling F6): the records the load could not apply and every
 *  save writes back (docs/prefabs.md § I18), which the Apply/Revert dialog states as a read-only count. Unity lists them
 *  in the Overrides drop-down with a Remove; Modoki's Remove is later work, so nothing here acts on them.
 *
 *  One record is one statement a writer made: a field, a component added with no fields, a component removal (or
 *  restore), a member removal, an added node, a re-parent, a legacy move. A row's `guid` and `name` are identity, not
 *  overrides (Unity's file has no such entry), so a row holding only them counts nothing.
 *
 *  What is counted is what the next save writes from the kept stores:
 *   - each LIVE member's unused part, through the save's own predicate (`liveKeptUnused`): a removal of a component the
 *     member carries again is not written, and a member the instance deleted since takes its records with it;
 *   - each R2 orphan row (a member the template no longer declares, or one a lower layer removed: no live member holds
 *     its key, which is what makes it an orphan);
 *   - the legacy channels kept for the root (`keptLegacyChannels`): a localId record whose target is gone, and a path-keyed
 *     frame no expansion reaches. */

import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { keptLegacyChannels, keptMemberOrphans, type SceneMemberRow, type KeptLegacyChannels } from '../../runtime/loaders/loadSceneFile';
import { liveKeptUnused, withUnusedPart } from './prefabBase';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Records in a `{trait: {field: value}}` bag: each field, and a component stated with none (it adds the component). */
function traitBagRecords(bag: unknown): number {
  if (!isRecord(bag)) return 0;
  let n = 0;
  for (const fields of Object.values(bag)) n += isRecord(fields) ? Math.max(1, Object.keys(fields).length) : 1;
  return n;
}

/** Records one member row states, identity left out. */
export function rowRecords(row: unknown): number {
  if (!isRecord(row)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (k === 'guid' || k === 'name') continue;
    if (k === 'traits') n += traitBagRecords(v);
    else if (k === 'traitRemovals') n += isRecord(v) ? Object.keys(v).length : 0;
    else if (Array.isArray(v)) n += v.length; // `removedTraits` names; `added` / `own` nodes
    else if (v !== undefined && v !== false) n += 1; // `removed: true`, `parent`
  }
  return n;
}

/** Records the kept legacy channels state. */
export function legacyRecords(legacy: KeptLegacyChannels | undefined): number {
  if (!legacy) return 0;
  let n = 0;
  for (const bag of Object.values(legacy.overrides ?? {})) n += traitBagRecords(bag);
  for (const names of Object.values(legacy.removedTraits ?? {})) n += Array.isArray(names) ? names.length : 0;
  n += legacy.removed?.length ?? 0;
  n += Object.keys(legacy.moved ?? {}).length;
  for (const frame of Object.values(legacy.nestedOverrides ?? {})) {
    if (isRecord(frame)) for (const bag of Object.values(frame)) n += traitBagRecords(bag);
  }
  for (const st of Object.values(legacy.nestedStructure ?? {})) {
    if (!isRecord(st)) continue;
    n += Array.isArray(st.added) ? st.added.length : 0;
    n += Array.isArray(st.removed) ? st.removed.length : 0;
    if (isRecord(st.removedTraits)) for (const names of Object.values(st.removedTraits)) n += Array.isArray(names) ? names.length : 0;
    n += isRecord(st.moved) ? Object.keys(st.moved).length : 0;
  }
  return n;
}

/** The unused overrides instance root `rootId` keeps (the module doc says what one is). 0 for an entity with no durable
 *  guid: the kept stores are keyed by it, so such a root keeps nothing. */
export function instanceUnusedOverrides(rootId: number): number {
  const ea = getTraitByName('EntityAttributes');
  const rootGuid = ea ? durableGuid((readTraitData(rootId, ea) as { guid?: string } | null)?.guid) : '';
  if (!rootGuid) return 0;
  let n = 0;
  for (const { part, carried } of liveKeptUnused(rootGuid, rootId)) n += rowRecords(withUnusedPart(undefined, part as SceneMemberRow, carried));
  for (const row of Object.values(keptMemberOrphans(rootGuid) ?? {})) n += rowRecords(row);
  return n + legacyRecords(keptLegacyChannels(rootGuid));
}
