/** An instance's ENTRY: the save's own statement of a stored instance root, in the scene file's rows form (#1880 F6).
 *  One writer, so the save and the rebuild state an instance the same way: the save writes it into the scene entry,
 *  and the rebuild (F6) respawns from it through the loader, which makes a rebuild the load of what the save writes. */

import type { SceneEntityEntry } from '../../runtime/loaders/loadSceneFile';
import type { PrefabFile } from './prefab';
import { captureInstanceOverrides } from './prefabInstanceOverrides';
import { captureInstanceMembers } from './prefabMembers';
import { captureInstanceStructure, captureNestedChannels, moveChannelsOntoRows, withoutRowParents, type FrameEdit } from './prefabCapture';
import { withKeptLegacy, withKeptLocalRecords, withKeptUnused } from './prefabBase';

/** The instance half of a scene entry, as the loader reads it — `SceneEntityEntry`'s own fields, so the two cannot drift.
 *  Each field is absent when it states nothing, as the save writes it. */
export type InstanceEntry = Pick<SceneEntityEntry, 'overrides' | 'added' | 'removed' | 'removedTraits' | 'moved' | 'nestedOverrides' | 'nestedStructure' | 'members'>;

/** Stored root `rootId` (of `source`) as the save states it, measured against `prefab` — the document the instance was
 *  EXPANDED from (`savedFrameDoc`, #1685), every nested frame against its own record. `rootGuid` keys the legacy channels
 *  the load kept for it (R2's legacy half). Synchronous over caches the caller has warmed (`preloadNestedPrefabs`).
 *  `consumedEcsIds`: every live entity the entry states, so the caller does not write it again as an entity of its own. */
export function captureInstanceEntry(
  rootId: number, source: string, prefab: PrefabFile, rootGuid: string,
  /** A caller's edit of chosen frames' statements, made where the capture makes each one and before it goes onto rows —
   *  so a rebuild to a state the live tree does not show (an Apply's subtraction, a Revert's reduced set, #1880 F6) is
   *  still stated by the save's one writer. `frames`: by frame root ecs id, this root's own included; `dropParents`:
   *  members (by ecs id) whose move is taken back, at any depth — their row states no `parent`. `againstRecords`: a
   *  rebuild's capture — every reference node stated against its own record (`StructureCaptureOpts.againstRecords`). */
  edit: { frames?: ReadonlyMap<number, FrameEdit>; dropParents?: ReadonlySet<number>; againstRecords?: boolean } = {},
): { entry: InstanceEntry; consumedEcsIds: number[] } {
  const own = edit.frames?.get(rootId);
  // Scene FILE form (#1468 Phase 4): a reference node inside writes its edits on its own rows.
  const live = captureInstanceStructure(rootId, prefab, { rows: true, frameEdits: edit.frames, dropParents: edit.dropParents, againstRecords: edit.againstRecords });
  const s = own?.structure ? own.structure(live) : live;
  const channels = captureNestedChannels(rootId, source, live.ownedNested, { rows: true, frameEdits: edit.frames, againstRecords: edit.againstRecords });
  // The records the load kept as UNUSED go back first (#1914 R4): a localId the template has goes onto its row with the rest.
  const local = withKeptLocalRecords({
    overrides: own?.overrides ? own.overrides(captureInstanceOverrides(rootId, prefab)) : captureInstanceOverrides(rootId, prefab),
    removedTraits: s.removedTraits, removed: s.removed, moved: s.unrowed ?? {},
  }, rootGuid, rootId);
  const unrowed = local.moved ?? {};
  // A structure that states nothing is handed on as none at all, as the save always has: `[]` is not "nothing" to every
  // reader of a channel.
  const struct = s.added.length || local.removed?.length || Object.keys(local.removedTraits ?? {}).length || Object.keys(unrowed).length ? s : undefined;
  // v16 (#1468): each member's guid, STORED under its minted identity instead of re-derived from its position on the next
  // load — plus, since Phase 3, `parent` for a member that has been moved inside the instance. Absent when the template
  // predates prefab v5; see `memberRowKeysIn` for the full exclusion list.
  // ⚠️ The template is passed, and it is what makes `parent` writable at all: the move is a DIFF against where this
  // document puts the member, so a capture with no document can only carry the rows it is handed (`memberRowParents`).
  // Since Phase 4 the rows also carry every EDIT they can key (`moveChannelsOntoRows`): what is left in the localId
  // channels below is the root's own edits and what no row can address.
  const moved = moveChannelsOntoRows(rootId, prefab, source, {
    overrides: local.overrides,
    added: struct?.added, removed: struct ? local.removed : undefined, removedTraits: struct ? local.removedTraits : undefined,
    nestedOverrides: channels.nestedOverrides, nestedStructure: channels.nestedStructure,
  }, captureInstanceMembers(rootId, prefab), channels.frames, { againstRecords: edit.againstRecords, frameEdits: edit.frames });
  const members = withKeptUnused(withoutRowParents(rootId, moved.members, edit.dropParents), rootGuid, rootId);
  const ch = withKeptLegacy(moved.channels, rootGuid);
  const entry: InstanceEntry = {};
  if (ch.overrides && Object.keys(ch.overrides).length) entry.overrides = ch.overrides;
  if (ch.added?.length) entry.added = ch.added;
  if (ch.removed?.length) entry.removed = ch.removed;
  if (ch.removedTraits && Object.keys(ch.removedTraits).length) entry.removedTraits = ch.removedTraits;
  if (Object.keys(unrowed).length) entry.moved = unrowed;
  if (ch.nestedOverrides && Object.keys(ch.nestedOverrides).length) entry.nestedOverrides = ch.nestedOverrides;
  if (ch.nestedStructure && Object.keys(ch.nestedStructure).length) entry.nestedStructure = ch.nestedStructure;
  if (Object.keys(members).length) entry.members = members;
  return { entry, consumedEcsIds: [...live.consumedEcsIds, ...channels.consumedEcsIds] };
}
