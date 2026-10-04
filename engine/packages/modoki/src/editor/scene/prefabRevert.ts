/** Revert: taking an instance's selected overrides back to its template.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5); onto the instance's override list by #2001 S7
 *  (#2046): a Revert takes records off the list and rebuilds the instance from it. */

import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { toLocalIdKeys, splitNestedKey } from './overrideKeyGrammar';
import { resolveAffectedScenes } from './sceneDirty';
import { type PrefabFile, resolveInstanceContext } from './prefab';
import { getCachedPrefabSync, getPrefabSource, preloadNestedPrefabs } from './prefabCache';
import { framesBuiltFromOtherRows, missingSourceRefusal, staleFramesRefusal, staleInstanceRefusal } from './prefabFrames';
import { preloadRebuildEntry, keptEnclosingSource } from './prefabRebuild';
import { ensureGuid } from '../undo/entityRef';
import { dropInstanceRecord, setInstanceRecord } from '../../runtime/prefab/instanceStore';
import * as instanceEdits from '../instance/instanceEdits';
import { guidOfEntity, storedRootsUnder } from '../instance/instanceKeys';
import { treeForWrite } from '../instance/instanceSync';
import { projectionRootOf, reprojectFromStore } from '../instance/instanceReproject';
import { rollbackOnThrow } from '../instance/instanceRollback';
import { recordsSide, type RecordsSide } from '../instance/instanceHistory';

/** Why a Revert of instance `rootInstanceId` would refuse, or null: {@link staleInstanceRefusal}, or its OWN prefab does
 *  not load (#1862). That is a live frame kept across a rebuild after its prefab was trashed, a nested one or #1738's
 *  top-level one: the base a Revert goes back to is gone, so there is nothing to revert TO. Unity's shape: it refuses the
 *  write it cannot represent and names the way out ("recover the missing … Prefab" or "unpack",
 *  `PrefabStage.PromptIfMissingVariantParentForVariant`, `PrefabUtility.SaveAsPrefabAssetArgumentCheck`). Asked through
 *  the async read, never the bare cache, so a merely cold key is not refused. The one question every Revert caller asks
 *  (the dialog, the agent op), because Revert's own `null` cannot carry a reason. */
export async function revertRefusal(rootInstanceId: number): Promise<string | null> {
  const stale = staleInstanceRefusal(rootInstanceId);
  if (stale) return stale;
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) return null;
  if (!await getPrefabSource(ctx.source)) return missingSourceRefusal(ctx.rootInstanceId, ctx.source, 'revert');
  await preloadRebuildEntry(rootInstanceId); // warmed, so a merely cold prefab is not read as a trashed one
  return keptFrameRefusal(rootInstanceId);
}

/** The refusal a Revert of `rootInstanceId` gives when it lies inside a frame its entry's rebuild keeps live
 *  ({@link keptEnclosingSource}: that frame's prefab trashed, with no one record to expand it from), or null. The rebuild
 *  would leave the instance as it is, so the Revert would change nothing while reporting that it did (#1880 F7d close-out
 *  review 1). */
function keptFrameRefusal(rootInstanceId: number): string | null {
  const source = keptEnclosingSource(rootInstanceId);
  return source ? `Revert refused: this instance lies inside an instance of "${source}", whose prefab cannot be read — restore that prefab, or reload the scene, and Revert again` : null;
}

/** Everything the Revert's undo entry needs: the records it changed, as they stood before and after (#2001 S7, #2046;
 *  rule 8), and the instance it rebuilt. */
export interface RevertResult {
  newRootId: number;
  source: string;
  prefab: PrefabFile;
  /** The guid of the frame root reverted, which the reprojection keeps (`newRootId` is found by it after an undo). */
  frameGuid: string;
  /** The guid of the outermost live root of the instance tree, which every side reprojects. */
  topGuid: string;
  /** The touched records before the Revert, with the scene-owned content they link (a reverted added node's), and after. */
  before: RecordsSide;
  after: RecordsSide;
  /** The keys that named no record of this instance's list: the enclosing prefab's own statements, or not this instance's. */
  unmatched: string[];
  /** The BASE scene(s) that own the instance — pass as the undo action's `affectedScenes`. A base's
   *  file is written by Save All only when it is dirty, and nothing else marks it: without this a
   *  revert on a base's instance reads saved and is lost on reload (#1431). [] for a primary one. */
  affectedScenes: string[];
}

/** Revert selected overrides on a SINGLE prefab instance back to the prefab base (the inverse of applyToPrefabSelective,
 *  scoped to this instance only; the prefab file is never touched). The selected records come OFF the instance's list
 *  (`instanceEdits.revert`), and the instance is rebuilt from the list (`reprojectFromStore`, #2001 S7): the value each
 *  reverted record leaves is the fold's without it, so every kind (field, added/removed component, added/removed node,
 *  move) reverts by one rule. Returns the new frame root + the state the undo entry needs, or null if the entity is not
 *  an instance, the prefab can't be loaded, or no key named a record. */
async function revertOverridesSelectiveUnmarked(
  rootInstanceId: number,
  selectedKeys: Set<string>,
): Promise<RevertResult | null> {
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) {
    console.warn('[Prefab] Selected entity is not a prefab instance');
    return null;
  }
  const { source } = ctx;
  if (selectedKeys.size === 0) {
    console.log('[Prefab] Nothing selected; aborting revert.');
    return null;
  }

  const prefab = await getPrefabSource(source);
  if (!prefab) {
    console.warn(`[Prefab] Cannot revert: source prefab not in cache: ${source}`);
    return null;
  }
  // The same refusal as Apply's (#1483): the keys below would name members by other members' rows.
  const staleFrames = framesBuiltFromOtherRows(rootInstanceId);
  if (staleFrames.length) {
    console.error(`[Prefab] cannot revert: ${staleFramesRefusal(staleFrames)}`);
    return null;
  }
  // Nested children must be cached for the synchronous rebuild. The file walk misses a USER-ADDED nested instance (not a
  // row of `prefab`) (#1284), and the rebuild loads the whole scene entry the instance sits in, every frame of it (#1880 F7a).
  await preloadNestedPrefabs(prefab);
  await preloadRebuildEntry(rootInstanceId);
  // The keys in their localId form against this document (#1468 Phase 4) — see the same step in
  // `applyToPrefabSelective`. A key naming a member the document no longer has reverts nothing.
  selectedKeys = toLocalIdKeys(selectedKeys, prefab, getCachedPrefabSync).keys;
  // A nested instance's own edit (U14's chain-qualified key) is reverted on the nested instance itself, not here.
  for (const k of [...selectedKeys]) {
    if (splitNestedKey(k)) { selectedKeys.delete(k); console.warn(`[Prefab] not reverting ${k}: revert it on the nested instance it belongs to`); }
  }
  if (selectedKeys.size === 0) return null;
  const kept = keptFrameRefusal(rootInstanceId);
  if (kept) { console.warn(`[Prefab] ${kept}`); return null; }

  const top = projectionRootOf(rootInstanceId) || rootInstanceId;
  // Every record of the tree stored, a nested one included: the before side below must state each one the Revert can
  // touch (review F2). Asked BEFORE anything is minted: a refused Revert changes nothing (#2001 S8b), and a root on a
  // runtime guid (#1210) holds no record, the store keying an instance by its root's durable guid.
  if (!treeForWrite(top)) {
    console.warn(`[Prefab] Revert of an instance of "${source}" not done: its override list could not be read — reload its scene`);
    return null;
  }
  // Both found again by their durable guids after each rebuild (`ensureGuid`, #1880 F7c): a tree that holds its records
  // has one at its top already; a frame under it keyed by derivation is given its own.
  const topGuid = ensureGuid(top);
  const frameGuid = ensureGuid(rootInstanceId);
  // Every record of the tree, before: the Revert can drop a nested instance's record with the node that held it.
  const guids = storedRootsUnder(top).map(guidOfEntity).filter(Boolean);
  let before = recordsSide(guids, top);
  const edit = instanceEdits.revert({ frameRoot: rootInstanceId, doc: prefab, source }, selectedKeys);
  if (!edit) {
    console.warn(`[Prefab] Revert of an instance of "${source}" not done: no override list holds it — reload its scene`);
    return null;
  }
  for (const k of edit.unmatched) console.warn(`[Prefab] not reverting ${k}: this instance's list states no such override (the prefab enclosing it authors it, it is not this instance's, or it already has the prefab's value)`);
  // The step holds the records the Revert CHANGED, and nothing else (rule 8): put back over a later state of the tree
  // (a reload, a trashed prefab around it), an untouched record must stay as that state has it.
  const touched = new Set(edit.touched);
  const narrowed = (side: RecordsSide): RecordsSide => ({ ...side, records: new Map([...side.records].filter(([g]) => touched.has(g))) });
  before = narrowed(before);
  const after = narrowed(recordsSide(guids));
  // Nothing taken off: the instance already shows what the Revert asks for (a default override at the prefab's value, a
  // key the enclosing prefab authors). Done, and nothing rebuilt, as the old rebuild of an unchanged entry changed nothing.
  if (edit.unmatched.length === selectedKeys.size) {
    return { newRootId: rootInstanceId, source, prefab, frameGuid, topGuid, before, after, unmatched: edit.unmatched, affectedScenes: resolveAffectedScenes([rootInstanceId]) };
  }
  const done = reprojectFromStore(top, before.content);
  if (!done) {
    // Put the records back as they were: nothing was rebuilt, so the list must still say what the user sees.
    restoreRecords(before);
    console.warn(`[Prefab] Revert of an instance of "${source}" not done: the instance could not be rebuilt from its list — reload its scene`);
    return null;
  }
  const newRootId = (frameGuid && findEntityByGuid(frameGuid)?.id()) || done.root;
  return {
    newRootId, source, prefab, frameGuid, topGuid, before, after, unmatched: edit.unmatched,
    affectedScenes: resolveAffectedScenes([newRootId]),
  };
}

/** Seat `side`'s records without rebuilding anything. */
function restoreRecords(side: RecordsSide): void {
  const world = getCurrentWorld();
  for (const [g, r] of side.records) {
    if (r) setInstanceRecord(world, structuredClone(r));
    else dropInstanceRecord(world, g);
  }
}

/** A Revert that throws part-way can leave the records saying "reverted" (`instanceEdits.revert` edits them in place)
 *  while the rebuild did not land (#2046 S7 close-out review F4): it rolls back (`instanceRollback.ts`, #2001 S8b). A
 *  Revert that returns maintains the records itself. */
export const revertOverridesSelective: (rootInstanceId: number, selectedKeys: Set<string>) => Promise<RevertResult | null> =
  rollbackOnThrow('Revert', revertOverridesSelectiveUnmarked);
