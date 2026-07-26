/** Pre-flight scan + confirm text for a Hierarchy scene-move (promote/demote) —
 *  scene-loading.md Phase 14. Kept out of `entityActions.ts`
 *  on purpose: this does `fetch` + `getAllAssets()` (async, disk-facing), and
 *  `entityActions.ts` is the widely-mocked foundational module that must stay
 *  light for every unit test that imports it.
 *
 *  The collision this scans for is a DISK-side, sibling-level hazard, not a
 *  live one: `moveEntityToScene` moves an entity between two scenes that are
 *  BOTH already loaded into the same world, and `filterDuplicateChainGuids`
 *  already deduped at chain-load time — so no two LIVE entities ever share a
 *  guid. A promoted guid can still collide with a SIBLING level file that
 *  isn't currently loaded (the A4-hazard-revival case the plan calls out):
 *  that sibling's own next load will have its copy shadowed by the base's
 *  (`filterDuplicateChainGuids`'s existing safety net), leaving a dead row in
 *  its file until it's next saved. Advisory only (owner decision) — this never
 *  offers or performs a rekey; it only reports so the user can judge. */

import { getAllEntities, subtreeIds, findEntity } from '../../runtime/ecs/entityUtils';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { ASSET_FETCH_INIT } from '../../runtime/loaders/assetFetch';
import { getAllAssets } from '../../runtime/loaders/assetManifest';
import { getCurrentScenePath } from './serialize';

export interface SceneMovePreflight {
  entityName: string;
  subtreeCount: number;
  /** Name of the parent left behind, or null if the entity is already a root
   *  (no re-rooting will happen regardless of how the drop is routed). */
  reRootFrom: string | null;
  /** Names of PrefabInstance ROOTS inside the moving subtree (Phase 5 limitation). */
  prefabInstanceRoots: string[];
  /** Sibling scene files on disk (declaring the SAME base as `targetScene`) that
   *  already contain one of the moving guids. Only populated for a PROMOTE
   *  (`targetScene !== ''`) — a demote has no "sibling of the base" to collide
   *  with in the same sense. */
  collisions: { path: string; name: string; guids: string[] }[];
  /** Count of sibling scenes actually scanned. */
  scanned: number;
  /** Sibling scene paths whose fetch/parse failed — so the UI never implies the
   *  scan was exhaustive when it wasn't. */
  scanFailed: string[];
}

/** Scan the live subtree rooted at `entityId` (as it stands BEFORE the move) and
 *  every OTHER scene file on disk that declares `targetScene` as its own
 *  `baseScene` (i.e. a sibling level of the base being promoted into), for any
 *  guid already present in that subtree. Never throws — a failed sibling fetch
 *  is recorded in `scanFailed`, not raised. Skips the currently-open scene path
 *  (already accounted for by the live move) and the target scene's own asset. */
export async function preflightSceneMove(entityId: number, targetScene: string): Promise<SceneMovePreflight> {
  const flat = getAllEntities();
  const byId = new Map(flat.map((e) => [e.id, e]));
  const rootInfo = byId.get(entityId);
  const ids = subtreeIds(flat, entityId);
  const entityName = rootInfo?.name ?? `Entity ${entityId}`;
  const subtreeGuids = ids.map((id) => byId.get(id)?.guid || '').filter(Boolean);

  const piMeta = getTraitByName('PrefabInstance');
  const prefabInstanceRoots: string[] = [];
  if (piMeta) {
    for (const id of ids) {
      const e = findEntity(id);
      const pd = e?.has(piMeta.trait) ? (e.get(piMeta.trait) as Record<string, unknown>) : null;
      if (pd && (pd.rootInstanceId as number) === id) prefabInstanceRoots.push(byId.get(id)?.name || `Entity ${id}`);
    }
  }

  const oldParentId = rootInfo?.parentId || 0;
  const reRootFrom = oldParentId ? (byId.get(oldParentId)?.name ?? `Entity ${oldParentId}`) : null;

  const result: SceneMovePreflight = {
    entityName, subtreeCount: ids.length, reRootFrom, prefabInstanceRoots,
    collisions: [], scanned: 0, scanFailed: [],
  };
  if (!targetScene || subtreeGuids.length === 0) return result; // demote: no sibling-of-base hazard

  const currentPath = getCurrentScenePath() || '';
  const guidSet = new Set(subtreeGuids);
  const sceneAssets = getAllAssets().filter((a) => a.type === 'scene' && a.path !== currentPath && a.guid !== targetScene);

  for (const asset of sceneAssets) {
    let data: { baseScene?: string; entities?: unknown[] } | null = null;
    try {
      const res = await fetch(assetUrl(asset.path), ASSET_FETCH_INIT);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch {
      result.scanFailed.push(asset.path);
      continue;
    }
    if (!data || data.baseScene !== targetScene) continue;
    result.scanned++;
    const hitGuids: string[] = [];
    for (const raw of data.entities ?? []) {
      const guid = (raw as { traits?: { EntityAttributes?: { guid?: string } } })?.traits?.EntityAttributes?.guid;
      if (guid && guidSet.has(guid)) hitGuids.push(guid);
    }
    if (hitGuids.length > 0) {
      result.collisions.push({ path: asset.path, name: asset.path.split('/').pop() || asset.path, guids: hitGuids });
    }
  }
  return result;
}

/** Pure string builder for the promote/demote confirm dialog — separated from
 *  `preflightSceneMove` so it's unit-testable without a fetch mock. */
export function formatSceneMoveConfirm(pre: SceneMovePreflight, targetScene: string): string {
  const verb = targetScene ? 'Promote' : 'Demote';
  const dest = targetScene ? 'into the base scene' : 'to the primary scene';
  const lines: string[] = [];
  lines.push(`${verb} "${pre.entityName}" (${pre.subtreeCount} ${pre.subtreeCount === 1 ? 'entity' : 'entities'}) ${dest}?`);
  lines.push('');
  if (pre.reRootFrom) {
    lines.push(`• It leaves its parent "${pre.reRootFrom}" behind — that parent stays where it is, so the authored parent/child relationship is gone (its world position/rotation is preserved by the move).`);
  }
  if (targetScene) lines.push('• Every level that uses this base will now show it.');
  if (pre.prefabInstanceRoots.length > 0) {
    lines.push(`• ${pre.prefabInstanceRoots.length} prefab instance${pre.prefabInstanceRoots.length === 1 ? '' : 's'} in the subtree: ${pre.prefabInstanceRoots.join(', ')} — its editor bookkeeping (Apply-to-Prefab, structural overrides) may not survive a later swap that keeps this base loaded (known Phase 5 limitation; the scene itself is still savable).`);
  }
  if (pre.collisions.length > 0) {
    const names = pre.collisions.map((c) => c.name).join(', ');
    lines.push(`• ${pre.collisions.length} other scene${pre.collisions.length === 1 ? '' : 's'} already contain${pre.collisions.length === 1 ? 's' : ''} one of these guids: ${names}. At its next load the base's copy wins and that scene's copy is dropped; its file keeps a dead row until it is next saved. Refs from scenes that aren't currently loaded cannot be updated by this move.`);
  }
  if (pre.scanFailed.length > 0) {
    lines.push(`• Could not scan ${pre.scanFailed.length} sibling scene${pre.scanFailed.length === 1 ? '' : 's'} for collisions: ${pre.scanFailed.join(', ')}.`);
  }
  lines.push('');
  lines.push('Nothing is written to disk now — Save All writes both files.');
  return lines.join('\n');
}
