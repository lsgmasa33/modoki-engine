/** "Has a write landed on this prefab since I read it?" — the one question every read-side seed of the prefab caches
 *  asks before it seeds (#1669, #1752).
 *
 *  A seed that follows a READ (a cold `getPrefabSource`, a drop that fetched the file and then awaited its nested
 *  children, the prefab edit-open's raw fetch) holds bytes from before its await. A write can land inside that await —
 *  Create Prefab → Replace, an Apply, an agent `create`, a trash — and seat the newer document under every key
 *  (`commitPrefabWrite`). A seed that runs after it puts the older bytes back (I10), and every frame expanded from the
 *  newer document then reads as stale against the cache: the next rebase rebuilds them onto the old one (#1685's shape).
 *
 *  The answer is the runtime cache's per-key revision (`getPrefabRevision`), which every prefab write and eviction
 *  bumps. Capture BEFORE the read; ask after the read's last await, before seeding. A moved token means a write landed
 *  in between: the reader refuses (or re-reads, for `getPrefabSource`, which has no caller to refuse to). It is never
 *  a content comparison — a raw fetch and a migrated cache copy of the same file differ in bytes, and a drop of an
 *  unchanged prefab must not be refused over that.
 *
 *  Its own module, not `prefab.ts`, so a reader asks it without that module's graph. The refusal a placement throws is
 *  `StalePrefabRead` (`stalePrefabRead.ts`, re-exported here). */
import { isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { getPrefabRevision } from '../../runtime/loaders/meshTemplateCache';
import { createTeardownToken } from '../../runtime/core/liveness';

/** The key a read of `source` is judged by: the path the runtime cache keys revisions by. A guid resolves through the
 *  manifest ONCE, at capture; a path is taken as it is. */
function readKey(source: string): string {
  return isGuid(source) ? (resolveRef(source) ?? source) : source;
}

/** Per key: the watcher saw the file change on disk (`notePrefabFileChanged`). A second signal beside the revision,
 *  because the watcher's reload evicts the runtime cache — the revision's bump — as LATE as it can (a deferred reload must
 *  not strand Play's synchronous spawns), and seats the editor cache from the new bytes before that. A placement in
 *  flight between the two passed the revision check and primed the old bytes over the new (#1752 close-out review). */
const changedOnDisk = createTeardownToken<string>();

/** True while no write or eviction has landed on the prefab `source` names since this was called, and the watcher has
 *  not reported its file changed. `source` is a guid or an asset path in the manifest's spelling (a caller holding a
 *  typed one normalises it first — the agent ops ask `existingAssetPath`, #1273).
 *
 *  ⚠️ The key is RESOLVED ONCE, here (`readKey`). A PATH used to be mapped to its guid and the guid re-resolved at every
 *  check, so after a trash and the manifest's prune the guid resolved to nothing, its revision read as 0, and a capture
 *  taken at 0 — every prefab no write has touched this session — read as "unchanged" after exactly the write it exists to
 *  see (#1752 close-out review; `prefabReadSeeds.test.ts`, the trash-and-prune case). A GUID the same way: a cold
 *  `getPrefabSource(guid)` over a trash and its prune (the cold-guid case). A guid the manifest does not know at capture
 *  still resolves at each check
 *  (`getPrefabRevision` has no raw-guid form); it names no file, so its read fetches nothing and seeds nothing. */
export function capturePrefabRead(source: string): () => boolean {
  const key = readKey(source);
  const revision = getPrefabRevision(key);
  const sameFile = changedOnDisk.capture(key);
  return () => getPrefabRevision(key) === revision && sameFile();
}

/** The watcher saw the prefab file at `path` change on disk: every read of it in flight is older than the file now.
 *  Called by `refreshPrefabSourceAfterDiskChange` (the watcher's refresh) before its fetch, cached or not — the event is
 *  the file, not the cache. */
export function notePrefabFileChanged(path: string): void {
  changedOnDisk.invalidateKey(readKey(path));
}

export { StalePrefabRead } from './stalePrefabRead';
