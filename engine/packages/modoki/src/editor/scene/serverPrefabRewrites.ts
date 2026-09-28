/** The client half of a SERVER-computed prefab/scene rewrite (#1751; docs/prefabs.md § "Model and invariants", I9).
 *
 *  `/api/prefab-member-paths` rewrites the stored member refs of every other scene and prefab that uses a prefab whose
 *  member paths moved (#1437). It marks those writes as the editor's own, so the watcher does not hot-reload the open
 *  scene under its live edits. But the watcher's event is ALSO what brings the client up to date, and these bytes are
 *  the server's, not ones the client sent. Before this module nothing took the watcher's place:
 *  - both prefab caches kept the old tokens, so the next write of such a prefab (whose `expected` is the cached copy)
 *    was refused as a conflict against its own repair, and a reopen re-expanded it from the stale copy;
 *  - the open scene's `lastWrittenSceneBytes` still named the pre-repair bytes, so an Apply undo's scene half was
 *    refused as an outside change;
 *  - the prefab open in prefab edit was rewritten under the edit, and its save was refused as "changed on disk";
 *  - a parked scene's undo stack, recorded over the old refs, was never marked stale.
 *
 *  Separate from `prefabCommit.ts` only because it reads the prefab-edit session and the scene record, and
 *  `prefabEdit.ts` already imports the commit: kept here, the graph stays acyclic. */

import { repairPrefabMemberPaths, type MemberPathRepair, type MemberPathRewrite } from '../backend/editorBackend';
import { seatCaches, parsePrefabBytes } from './prefabCommit';
import { adoptRewrittenEditBaseline } from './prefabEdit';
import { adoptRewrittenSceneBytes, getCurrentScenePath } from './serialize';
import { recordSceneFileChanged } from './sceneAdoption';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { normScenePath } from '../../runtime/scene/scenePathKey';
import type { PrefabFile } from './prefab';

export interface AdoptOptions {
  /** The LIVE world already holds the repair: the rewrite ran inside the Apply (or its undo) step, in the world it
   *  changed (#1750's rule — called only there, never across a world switch). Then the live world's own files (the open
   *  scene, a loaded base, the prefab open in prefab edit) agree with it, and the editor's record of each moves with the
   *  file. False for a repair run after the world was replaced (Apply undo's `worldLeft` tail): nothing live is known to
   *  hold it, so no record moves and every rewritten scene's undo stack is marked stale, as the watcher would. */
  liveWorldRepaired: boolean;
}

/** {@link AdoptOptions}, with `liveWorldRepaired` as a question asked once the route has RETURNED: the route awaits the
 *  backend, and a caller whose world can be replaced across that await (Apply's undo, before its "still THAT world?"
 *  check) must not have its answer taken before it (close-out review). */
export interface RepairOptions { liveWorldRepaired: boolean | (() => boolean) }

/** Bring the client up to date with files a server route rewrote on the editor's behalf — what the watcher would have
 *  done had the write not been marked as the editor's own, except that the runtime cache is REPLACED, not evicted (see
 *  `seatCaches`: the watcher's eviction is #1308's blank). */
export function adoptServerPrefabRewrites(written: readonly MemberPathRewrite[], opts: AdoptOptions): void {
  const live = liveSceneFiles();
  for (const w of written) {
    if (w.type === 'prefab') {
      let doc: PrefabFile;
      try { doc = parsePrefabBytes(w.text); } catch (e) {
        console.error(`[Prefab] ${w.path} was rewritten, but its new bytes did not parse, so the editor still holds the old copy:`, e);
        continue;
      }
      seatCaches(w.path, w.path, w.guid ?? doc.id, doc);
      if (opts.liveWorldRepaired && (w.guid ?? doc.id)) adoptRewrittenEditBaseline((w.guid ?? doc.id)!, w.prior, doc);
      continue;
    }
    const key = normScenePath(w.path);
    if (opts.liveWorldRepaired && live.has(key)) {
      // Its live world holds the repair, and its next save writes that: the undo stack stays, and the record follows.
      adoptRewrittenSceneBytes(w.path, w.prior, w.text);
      continue;
    }
    // A scene no live world holds (or none known to hold the repair): its undo stack was recorded over the old refs.
    recordSceneFileChanged(w.path);
    // A loaded BASE whose file changed leaves the primary's file alone, but the primary's stack was recorded over the
    // base's old bytes too — the watcher raises the primary's for the same reason (`agentBridge.ts` `handleSceneChanged`).
    const primary = getCurrentScenePath();
    if (live.has(key) && primary && normScenePath(primary) !== key) recordSceneFileChanged(primary);
  }
}

/** The files the live world is built from: the open scene and every loaded base, normalised. */
function liveSceneFiles(): Set<string> {
  const out = new Set<string>();
  const primary = getCurrentScenePath();
  if (primary) out.add(normScenePath(primary));
  for (const entry of sceneManager.getLoadedScenes().values()) if (entry.path) out.add(normScenePath(entry.path));
  return out;
}

/** THE way to run the member-path repair (#1437) from the editor: the route, then its rewrites adopted. Resolves to what
 *  the route did, or null when it could not (already logged). */
export async function repairMemberPathsEverywhere(prefab: string, before: unknown, opts: RepairOptions): Promise<MemberPathRepair | null> {
  const repair = await repairPrefabMemberPaths(prefab, before);
  if (repair) {
    const live = opts.liveWorldRepaired;
    adoptServerPrefabRewrites(repair.written, { liveWorldRepaired: typeof live === 'function' ? live() : live });
  }
  return repair;
}
