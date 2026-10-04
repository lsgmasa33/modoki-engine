/**
 * What a stored instance states beyond what its live tree shows, read from its RECORD (#2001 S8b step 2): Unity's
 * "unused overrides". The rows whose node is gone, the part of a live member's row its member does not take, and the
 * legacy channels no frame takes. A BAKE (Create Prefab over a scene instance, Apply's promotion of a scene-added
 * reference node: #1790, #1802, owner ruling D) carries them into the template it writes. Until S8b it read them from
 * stores the load filled beside the record; those are deleted, and the record is the one place this state lives.
 *
 * Every part is in SCENE form, as the scene writer writes the record (`writtenEntryOf`): the bake puts it in template
 * form (`templateRowOf`, `toTemplateStructure`), as it does its capture.
 */
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { instanceRowKeysIn } from '../../runtime/core/ecs/memberRows';
import { storedRecord } from '../../runtime/prefab/instanceStore';
import { foldInstance } from '../../runtime/prefab/foldInstance';
import { LEGACY_ROW_CHANNELS } from '../../runtime/prefab/templateFormDocument';
import type { KeptLegacyChannels, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { guidOfEntity } from './instanceKeys';
import { editorPrefabReader } from './instanceSync';
import { writtenEntryOf } from './instanceReproject';
import { liveOwnContent } from './instanceOwnContent';

type Rows = Record<string, SceneMemberRow>;

/** What a stored root states beyond its live tree, in the shape an entity snapshot carries (`EntitySnapshot.kept`): its
 *  orphan rows, its legacy channels, and its live members' unused row parts. */
export type KeptState = { rows?: Record<string, object>; legacy?: KeptLegacyChannels; unused?: Record<string, object> };

export interface KeptFromRecord {
  /** Each row no live node answers to that holds a record the fold could not apply: whole. */
  orphans: Rows;
  /** For each LIVE member, the part of its row its member does not take (#1914 R4): statements only, no identity. */
  unused: Rows;
  /** The legacy channels the record holds verbatim (`held.pendingLegacy`), as the written entry states them. */
  legacy: KeptLegacyChannels;
}

/** {@link KeptFromRecord} for the stored instance rooted at `rootId`; undefined when its tree holds no record. */
export function keptFromRecord(rootId: number): KeptFromRecord | undefined {
  const world = getCurrentWorld();
  const guid = guidOfEntity(rootId);
  const rec = guid ? storedRecord(world, guid) : undefined;
  if (!rec) return undefined;
  const entry = writtenEntryOf(rec, rootId, liveOwnContent(new Set())) as unknown as Record<string, unknown> & { members?: Rows };
  const rows = entry.members ?? {};
  const live = new Set(instanceRowKeysIn(rootId, world, true).values());
  const orphans: Rows = {};
  const unused: Rows = {};
  for (const { key, part } of foldInstance(editorPrefabReader, rec).unused) {
    const row = rows[key];
    if (!row) continue;
    if (!live.has(key)) { orphans[key] = row; continue; }
    const into = (unused[key] ??= {});
    const traits = row.traits as Record<string, unknown> | undefined;
    if (part.kind === 'trait' && traits?.[part.trait] !== undefined) {
      into.traits = { ...into.traits, [part.trait]: traits[part.trait] } as SceneMemberRow['traits'];
    } else if (part.kind === 'field') {
      const data = traits?.[part.trait] as Record<string, unknown> | undefined;
      if (data && part.field in data) {
        const at = (into.traits as Record<string, Record<string, unknown>> | undefined)?.[part.trait];
        into.traits = { ...into.traits, [part.trait]: { ...at, [part.field]: data[part.field] } } as SceneMemberRow['traits'];
      }
    } else if (part.kind === 'traitRemoval') {
      // In the form the row states it in: a `removedTraits` list entry, or a `traitRemovals` statement.
      if (row.removedTraits?.includes(part.trait)) into.removedTraits = [...(into.removedTraits ?? []), part.trait];
      else if (row.traitRemovals && part.trait in row.traitRemovals) into.traitRemovals = { ...into.traitRemovals, [part.trait]: row.traitRemovals[part.trait]! };
    }
    if (!Object.keys(into).length) delete unused[key];
  }
  const legacy: Record<string, unknown> = {};
  for (const k of LEGACY_ROW_CHANNELS) if (entry[k] !== undefined) legacy[k] = entry[k];
  return { orphans, unused, legacy: legacy as KeptLegacyChannels };
}

/** {@link keptFromRecord} in the shape an entity snapshot carries (`EntitySnapshot.kept`, #1788): a copy mints new
 *  identities for the guids its rows pin, and a respawn carries them. */
export function keptStateFromRecord(rootId: number): KeptState | undefined {
  const k = keptFromRecord(rootId);
  if (!k) return undefined;
  const rows = Object.keys(k.orphans).length ? k.orphans : undefined;
  const unused = Object.keys(k.unused).length ? k.unused : undefined;
  const legacy = Object.keys(k.legacy).length ? k.legacy as KeptState['legacy'] : undefined;
  return rows || unused || legacy ? structuredClone({ ...(rows ? { rows } : {}), ...(unused ? { unused } : {}), ...(legacy ? { legacy } : {}) }) : undefined;
}
