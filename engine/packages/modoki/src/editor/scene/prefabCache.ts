/** The editor's prefab cache and prefab file reads: fetch, parked reads, refresh, nested preload, the editor-cache
 *  seat/prime/rekey/evict bookkeeping, cycle checks, and what id an existing file on disk carries.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { isPrefabDocument } from '../../runtime/loaders/prefabRoot';
import { admitPrefabDocument } from '../../runtime/loaders/documentIdentity';
import { prefabNests } from '../../runtime/loaders/prefabNesting';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents, setFrameDocFallback, frameDocReader } from '../../runtime/core/ecs/identityParents';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { registerAsset, getGuidForPath, isGuid, resolveRef, getAllAssets, lastKnownPathOf } from '../../runtime/loaders/assetManifest';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import { templateKeysOf, recoverTemplateKey as recoverKeyFrom, type KeyRecoveryNode } from '../../runtime/loaders/templateKeyRecovery';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { assetIsAbsent, parseAssetJson, ASSET_FETCH_INIT } from '../../runtime/loaders/assetFetch';
import { invalidatePrefab, replaceCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { parkedPrefab } from './dirtyAssets';
import { capturePrefabRead, notePrefabFileChanged } from './prefabRead';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { collectTree, type PrefabFile } from './prefab';
import { setTemplateCopyTest } from '../../runtime/loaders/overrideMarks';

/** Resolve the stable id a (re)written prefab at `prefabPath` must keep, so a
 *  model re-import never mints a fresh guid that orphans scenes whose
 *  PrefabInstance.source points at the old one (the tropical-island bug).
 *  `classifyExistingDocumentId` for a prefab: the file is always READ (the too-new
 *  refusal, #1678), and the manifest's guid wins over the file's own `id` when both
 *  exist. `mintable` only when nothing is there to orphan (a genuinely new prefab); the
 *  caller then mints a fresh guid via serializePrefab's `existingId ?? newGuid()`. */
export async function classifyExistingPrefabId(prefabPath: string): Promise<ExistingDocumentId> {
  return classifyExistingDocumentId(prefabPath);
}

/** What a caller about to overwrite `docPath` may conclude about the id it already carries.
 *
 *  ⚠️ Three outcomes, not two, and the third is the point (#1468, #896's class). `undefined` used to
 *  mean all of "genuinely missing", "the dev server answered 500", "the bytes are corrupt" and
 *  "written by a newer build" at once — and every caller reads it as *first-time import* and mints a
 *  FRESH guid over a document whose bytes are still on disk. Every scene referencing the old id then
 *  dangles, which is #1468's own subject arriving through a different door. */
export type ExistingDocumentId =
  /** The manifest or the file itself says what it is. Keep it. */
  | { kind: 'known'; id: string }
  /** Nothing to orphan — the path is free, or the document carries no id. Minting is correct. */
  | { kind: 'mintable'; reason: 'absent' | 'no-id' }
  /** Something is there and this build could not read it, or must not rewrite it. Do NOT mint, and
   *  do NOT write: `reason` is written for a human and is what the caller should surface. */
  | { kind: 'refuse'; reason: string };

/** The id an existing JSON asset document at `docPath` already carries, by a two-step lookup:
 *
 *    1. the asset manifest's registered guid for this path — survives even a full file rewrite,
 *       and for every document but a prefab is the fast/offline answer (a prefab is read anyway: ⚠️ below),
 *    2. the on-disk file's `id` — covers a freshly-scanned document the manifest hasn't indexed yet.
 *
 *  Nothing about the lookup is prefab-specific; the New-asset "Replace" path uses it for materials
 *  too, so replacing one keeps the refs that point at it (#1215).
 *
 *  ⚠️ Absence is decided by `assetIsAbsent`, NEVER by `isMissingAsset` — #896's scar is that the
 *  wide predicate makes a 5xx read as absent, which is exactly the substitution this function must
 *  not authorise. `parseAssetJson` is what classifies the response, so the dev server's SPA
 *  fallback (a 200 serving index.html) counts as absent and a mid-body network drop does not.
 *
 *  ⚠️ The too-new check is PREFAB-ONLY, deliberately. Each document kind has its own version ladder
 *  and its own disposition — a scene REFUSES at load, `/api/asset-write` gates on
 *  `ASSET_WRITE_FORMAT_VERSION`, and a `.meta.json` sidecar has `assertSidecarWritable`. Comparing a
 *  material's `version` against `PREFAB_FORMAT_VERSION` would be a confident wrong answer, so this
 *  asks the question only where it knows which constant means anything.
 *
 *  ⚠️ So a PREFAB is read even when the manifest knows its path (#1678). The manifest answered first,
 *  and an existing prefab is always indexed, so the too-new refusal ran only for a path nothing had
 *  scanned yet — never for the file it exists to protect. The rigged re-import then baked and rewrote
 *  every sidecar before the server's gate refused the prefab write. The manifest still supplies the id;
 *  the read only decides whether this build may write over the file. A file the manifest names but the
 *  disk no longer has keeps the manifest id: minting there would orphan every ref to it. */
export async function classifyExistingDocumentId(docPath: string): Promise<ExistingDocumentId> {
  const known = getGuidForPath(docPath);
  const isPrefab = docPath.endsWith('.prefab.json');
  if (known && !isPrefab) return { kind: 'known', id: known };
  let data: unknown;
  try {
    data = await parseAssetJson(await fetch(assetUrl(docPath), ASSET_FETCH_INIT), docPath);
  } catch (e) {
    if (assetIsAbsent(e)) return known ? { kind: 'known', id: known } : { kind: 'mintable', reason: 'absent' };
    // ⚠️ The wording does NOT assert the file is there (#1468 close-out review F6). One caller —
    // Scene create — classifies a path that may legitimately be EMPTY, and a backend restart or a
    // mid-body drop lands here rather than on `absent`. "X exists but could not be read" was then a
    // confident false statement about a path with nothing on it.
    return { kind: 'refuse', reason: `could not read ${docPath} to check what is there (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'refuse', reason: `${docPath} is not a JSON object` };
  }
  const doc = data as { id?: unknown; version?: unknown };
  if (isPrefab && typeof doc.version === 'number' && doc.version > PREFAB_FORMAT_VERSION) {
    return {
      kind: 'refuse',
      reason: `${docPath} was written by a newer build (prefab format ${doc.version}; this build writes `
        + `${PREFAB_FORMAT_VERSION}). Overwriting it would discard whatever the newer format added.`,
    };
  }
  if (known) return { kind: 'known', id: known };
  return typeof doc.id === 'string' && doc.id ? { kind: 'known', id: doc.id } : { kind: 'mintable', reason: 'no-id' };
}

/** Tag every member of the instance rooted at `rootEcsId` with its prefab: `PrefabInstance.source` = the DOCUMENT's own
 *  guid (I22, #1828). Every caller holds the document it just expanded, so identity is never re-derived from a path: a
 *  lookup through the renderer's manifest misses whenever the manifest lags a move, cannot read a file (#1799's BOM) or
 *  is asked in another spelling (#1753 F4), and the old `getGuidForPath(path) ?? path` then wrote the raw path, which
 *  the loader and the scene validator reject. A document with no guid is refused loudly and nothing is written — the
 *  instance keeps whatever source it had — rather than storing something no reader accepts. False when refused.
 *  `reachedBy` is the GUID a nested expansion reached the document by (a row's or a reference node's `prefab`, a guid in
 *  every file the loader accepts), for a document that states no `id` of its own. */
export function setPrefabSource(rootEcsId: number, doc: { id?: string; name?: string }, reachedBy?: string): boolean {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return false;
  const ref = doc.id ?? (reachedBy && isGuid(reachedBy) ? reachedBy : undefined);
  if (!ref || !isGuid(ref)) {
    console.error(`[Prefab] not tagging instance ${rootEcsId} of "${doc.name ?? '?'}": its document has no guid (id ${JSON.stringify(ref ?? null)}), and PrefabInstance.source is a guid only (I22)`);
    return false;
  }
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], _entity) => {
    if ((pi as Record<string, unknown>).rootInstanceId === rootEcsId) {
      (pi as Record<string, unknown>).source = ref;
    }
  });
  return true;
}

// ── Override Detection ──────────────────────────────────

/** Cache of loaded prefab files by source path */
export const prefabCache = new Map<string, PrefabFile>();

// Identity walks read a frame's template parents from the document it was expanded from — the loader records
// that per world; this is what they read for a frame the editor made itself (its own `instantiatePrefab`, a
// Create Prefab tag, an undo respawn into a world that never expanded the source). `identityParents.ts`.
setFrameDocFallback((source) => prefabCache.get(source) ?? null);

/** Load a prefab file (cached). `source` is a prefab GUID (resolved via the
 *  manifest) or a legacy path like "/models/.../island.prefab.json". Cached by
 *  the original ref so guid + path callers don't fetch twice. */
export async function getPrefabSource(source: string): Promise<PrefabFile | null> {
  // ⚠️ A cold read is not allowed to put older bytes back (#1669, the editor twin of #863). A write can land while the
  // fetch is in flight — Create Prefab → Replace, a rig update, an agent `create`, from the Apply dialog opening or a
  // nested preload racing it — and the fetch then resolves with the bytes from before it, over the document the write
  // just seated. So the read carries the runtime cache's revision token, which every prefab write and eviction bumps
  // (`replaceCachedPrefab`/`invalidatePrefab`), and is discarded when the token moved or a writer filled the key
  // meanwhile. One re-read, then the last fetch is returned uncached rather than looping on a file that keeps changing.
  // The token is `capturePrefabRead` (prefabRead.ts), the one every read-side seed asks (#1752).
  let prefab: PrefabFile | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (prefabCache.has(source)) return prefabCache.get(source)!;
    const unchanged = capturePrefabRead(source);
    prefab = await fetchPrefabSource(source);
    if (prefabCache.has(source)) return prefabCache.get(source)!;
    if (!unchanged()) continue;
    if (prefab) { seatEditorEntry(source, prefab); registerRead(source, prefab); }
    return prefab;
  }
  return prefab;
}

/** Name the file a read that was ACCEPTED came from, in the manifest (#1752 close-out review). Not done by the fetch
 *  itself: a stale read — one a write or a trash overtook — re-registered its guid at the path the trash had just emptied,
 *  so a trashed prefab resolved again until the next manifest broadcast. */
function registerRead(source: string, prefab: PrefabFile): void {
  const url = isGuid(source) ? resolveRef(source) : assetUrl(source);
  if (prefab.id && url) registerAsset(prefab.id, url, 'prefab');
}

const refusedReads = new Map<string, string>();

/** Why the last read of `source` REFUSED its document (#1937 C-A: an identifier declared twice; #1948 F3: a malformed nested owner), or null when it was not
 *  refused — so a door that answers in words says the file is damaged, not that it is missing (#1948 F7). */
export function prefabReadRefusal(source: string): string | null {
  return refusedReads.get(source) ?? null;
}

/** Read a prefab file from disk, uncached — the editor's ONE prefab read (#1671 row 6): `getPrefabSource`'s fetch half,
 *  `refreshPrefabSourceForPath`'s, and the prefab-edit open's. It registers nothing: its callers do, for a read they
 *  keep (`registerRead`). Null for anything that is not a readable prefab document. */
export async function fetchPrefabSource(source: string, init: RequestInit = ASSET_FETCH_INIT): Promise<PrefabFile | null> {
  refusedReads.delete(source);
  // Normally a GUID (resolve via manifest). A freshly-instantiated instance can
  // still carry a path before its owning scene is saved + normalized; resolveRef
  // rejects internal asset paths loudly, so fetch a path ref directly instead.
  const url = isGuid(source) ? resolveRef(source) : assetUrl(source);
  if (!url) return null;
  const parked = parkedPrefabRead(isGuid(source) ? url : source);
  if (parked) return parked;
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const prefab: unknown = await res.json();
    // Not a prefab document (#1813) is a prefab that did not load — the loader's rule (`isPrefabDocument`).
    if (!isPrefabDocument(prefab)) return null;
    // An identifier declared twice is refused as the runtime cache refuses it (#1937 C-A); a keyless template node gets
    // the same deterministic key there and here, so both caches name it alike.
    const admitted = admitPrefabDocument(prefab);
    if ('refusal' in admitted) {
      console.error(`[prefabCache] ${source} refused: ${admitted.refusal}`);
      refusedReads.set(source, admitted.refusal);
      return null;
    }
    // Prefabs carry no migration chain at all — PREFAB_FORMAT_VERSION is a writer-only stamp
    // nothing on the loading path inspects (#365/#379). Applying the zIndex migration
    // unconditionally here (cheap, idempotent) is the smallest thing that closes the same
    // data-loss window a versioned migration closes for scenes — see uiAnchorZIndexMigration.ts.
    // Structured walk — reaches overrides[localId][UIAnchor], added[] subtrees and
    // nestedOverrides paths too (including this prefab FILE's own nested rows), not just
    // entry.traits.
    for (const entry of admitted.doc.entities) migrateUIAnchorZIndexStructured(entry);
    return admitted.doc as PrefabFile;
  } catch { return null; }
}

/** A clone of the prefab parked for `path` (#1868), or null — taken by every editor read of a prefab file in place of
 *  the file. A clone, as a fetch returns a fresh document: a reader that edits what it read must not edit the park. */
export function parkedPrefabRead(path: string): PrefabFile | null {
  const doc = parkedPrefab(path) as PrefabFile | undefined;
  return doc ? JSON.parse(JSON.stringify(doc)) as PrefabFile : null;
}

/** Take the prefab at `path` from its FILE into both caches — the leave-prefab-edit repair (#1666) and the watcher's
 *  refresher for a runtime with no re-importer — through the prefab step's `'adopt'` landing (#1880 W4), which holds
 *  every rule this function used to carry itself:
 *  - REFRESH, never delete (#1169's close-out review): this cache has SYNC readers that treat a miss as "not a prefab"
 *    (`serializePrefab` flattens a nested instance it cannot find), so an unreadable file keeps the old entry and a key
 *    nobody has read is left cold rather than warmed; the runtime copy is REPLACED (#1308);
 *  - an editor write that landed during the read (an Apply) is kept, not overwritten by the older bytes.
 *  - the prefab open in prefab edit keeps its editor copy until the session ends (#1666): an in-editor writer that read it
 *    is refused as a conflict meanwhile, the safe direction.
 *  Nothing is rebased here: the leave repair rebases next itself. */
export async function refreshPrefabSourceForPath(path: string): Promise<void> {
  // The prefab step's `'adopt'` landing (#1880 W4), caches only: the leave repair's rebase rebuilds, and the watcher's
  // caller notes the change itself (`refreshPrefabSourceAfterDiskChange`). Imported when called: the step imports this
  // module, so a static import would close a load-time cycle.
  const { commitPrefabChanges } = await import('./prefabCommit');
  await commitPrefabChanges([{ source: path, doc: null, expected: null, land: 'adopt' }], { rebase: false, fileChanged: false });
}

/** The watcher's refresh (`agentBridge.ts`, via `setPrefabSourceRefresher`): the file at `path` CHANGED on disk, so every
 *  read of it in flight is older than the file (`notePrefabFileChanged`, #1752) — noted BEFORE the refresh's own fetch,
 *  since a placement resuming during that fetch would otherwise pass its check and prime the old bytes, and the refresh
 *  would then skip the key as replaced. Only here: the leave-edit repair refreshes a prefab whose file did not change,
 *  and noting it there refused a placement in flight for a write nobody made (close-out review). */
export async function refreshPrefabSourceAfterDiskChange(path: string): Promise<void> {
  notePrefabFileChanged(path);
  await refreshPrefabSourceForPath(path);
}

/** Synchronous cache lookup — returns the prefab if already loaded, else null.
 *  `instantiatePrefab` is sync, so a nested child must be preloaded (see
 *  `preloadNestedPrefabs`) before instantiation. */
export function getCachedPrefabSync(source: string): PrefabFile | null {
  return prefabCache.get(source) ?? null;
}

/** Transitively fetch every nested prefab referenced by `prefab` (and their
 *  nested children) into the cache, so a later sync `instantiatePrefab` can read
 *  them. Cycle-safe via `seen`. Call this from async entry points before
 *  instantiating a prefab that may contain nested instances. */
export async function preloadNestedPrefabs(prefab: PrefabFile, seen = new Set<string>()): Promise<void> {
  const children = prefab.entities.map((e) => e.prefab).filter((s): s is string => !!s);
  for (const childRef of children) {
    if (seen.has(childRef)) continue;
    seen.add(childRef);
    const child = await getPrefabSource(childRef);
    if (child) await preloadNestedPrefabs(child, seen);
  }
}

/** Warm every prefab referenced by the LIVE entity subtree under `selectedEntityId`,
 *  so the sync cache readers that run over that subtree can see them (#1284).
 *
 *  ⚠️ This is the counterpart to `preloadNestedPrefabs`, and the difference between the
 *  two IS the defect it fixes. `preloadNestedPrefabs` walks a prefab FILE's reference
 *  rows; the sync readers walk the LIVE TREE. Anything live-but-not-in-the-file is
 *  therefore never warmed by it, and every such reader treats "not in the cache" as
 *  "not a prefab" and silently takes its degraded branch:
 *    - `planPrefabRows` flattens a held nested instance into copies (Create Prefab had
 *      no warm at all, so after an ordinary scene load EVERY live instance was cold —
 *      the scene loader fills the RUNTIME cache, not this one);
 *    - `captureNestedRef` drops a user-added nested subtree from `added[]` entirely;
 *    - the old per-frame rebuild's nested capture/reapply lost a nested instance's
 *      per-copy overrides across a rebuild, with no warning at all (that route is gone, #1880 F7d;
 *      a rebuild now warms its whole entry, `preloadRebuildEntry`).
 *
 *  ⚠️ **Calling this does not make those readers safe everywhere — only on the paths that
 *  call it.** Every async entry point that reaches one of them now does, INCLUDING the undo and
 *  redo closures: `UndoAction.undo/redo` are typed `(): void | Promise<void>` and `undoManager`
 *  awaits them under its own in-flight mutex, so a closure that needs to warm can. An earlier
 *  version of this comment called those closures "synchronous … can never await", which was
 *  false and was the stated reason for deferring them.
 *
 *  ⚠️ **These calls are now belt-and-braces, not the mechanism.** Since #1295 the cache is
 *  populated by construction — `instantiatePrefabInstance` caches under the ref the instance
 *  carries, and `installEditorPrefabCacheWarm` fills it on every scene swap from what the loader
 *  already parsed. These are kept because each costs a `Map.has` once warm and the failure they
 *  guard against is silent; the source census that used to police them was deleted, because it
 *  needed a new anchor per reader and every sweep that anchored on ONE of them missed a path.
 *
 *  Call this from the async entry point BEFORE any of them, exactly as the scene save
 *  already does for its own capture loop (`serialize.ts`, "Preload every referenced
 *  prefab so captureInstanceOverrides can read from the cache without async I/O").
 *
 *  The warmed set is deliberately a SUPERSET of the set `planPrefabRows` turns into
 *  reference rows: it includes the selection root, which that function never collapses.
 *  Over-warming costs one cached fetch; under-warming is the bug — so the asymmetry is
 *  the point, and a later change to the membership rule cannot silently re-open this.
 *
 *  ⚠️ No recursion into each fetched FILE's own rows, deliberately. `collectTree` is a
 *  full descendant walk and `instantiatePrefab` gives every nested root its own
 *  `PrefabInstance`, so an instance nested N levels deep is its OWN entry in this loop —
 *  and every sync reader this feeds walks the live tree too, so a file row with no live
 *  instance is never read. A `preloadNestedPrefabs(child, seen)` call here was written
 *  first and removed: it made the depth case pass for the WRONG reason, and the pair was
 *  mutually redundant, so neither line could be shown to fail on its own. The depth-2
 *  case is covered in coldPrefabCacheWarming.test.ts and dies if this walk is truncated. */
export async function preloadNestedPrefabsForSubtree(selectedEntityId: number): Promise<void> {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return;
  // Collect first, then fetch in parallel — the scene save's equivalent preload does the same
  // (`serialize.ts`). The Set is what dedupes; it is NOT a side effect of fetching serially,
  // so parallelising cannot reintroduce a double fetch for two instances of one source.
  const seen = new Set<string>();
  for (const e of collectTree(selectedEntityId, getAllEntities())) {
    // A placeholder for a missing prefab (#1699) names its source on its marker, and a rebuild that finds that prefab
    // restored re-expands it only if this fetched it.
    const marked = e.missingPrefab ? unresolvedRefOf(findEntity(e.id))?.source : undefined;
    if (marked) { seen.add(marked); continue; }
    if (!e.traits.includes('PrefabInstance')) continue;
    const source = readTraitData(e.id, piMeta)?.source as string | undefined;
    if (source) seen.add(source);
  }
  const docs = await Promise.all([...seen].map((source) => getPrefabSource(source)));
  // …and every prefab those documents nest, live or not (#1790 close-out review F5): a row the scene REMOVED is live
  // nowhere, and Create Prefab's refusal (`unexpandedNestedRows`) asked over it cold named a readable prefab as missing.
  const nested = new Set(seen);
  await Promise.all(docs.map((doc) => (doc ? preloadNestedPrefabs(doc, nested) : undefined)));
}

/** Seed the editor prefab cache from a READ — the scene-load warm and the instantiate helper.
 *
 *  ⚠️ Deliberately NOT `setPrefabCache`, and the difference is the whole reason this exists:
 *  that one also rewrites the runtime cache (`replaceCachedPrefab`), because all of ITS callers
 *  follow a prefab FILE WRITE. A read-side seed doing that would bump the prefab's revision and
 *  re-spawn every pooled row built from it (#1308) — on every drag-drop, and once per prefab on
 *  every scene swap. */
export function primeEditorPrefabCache(source: string, prefab: PrefabFile): void {
  seatEditorEntry(source, prefab);
}

/** The ONE place the editor cache takes an entry (#1813): only a prefab DOCUMENT (`isPrefabDocument`), and anything else
 *  leaves the key absent — a prefab that did not load, which I18 handles — rather than a shape every sync reader of this
 *  cache assumes and throws on. Every writer below goes through it, and a new one must too. */
function seatEditorEntry(source: string, prefab: PrefabFile | null): void {
  // Admitted as every seat admits (#1937 C-A): a document declaring an identifier twice leaves the key absent; one with a
  // keyless template node is seated with its minted keys (the same object when there is nothing to mint).
  const admitted = prefab && isPrefabDocument(prefab) ? admitPrefabDocument(prefab) : null;
  if (admitted && 'doc' in admitted) { prefabCache.set(source, admitted.doc); deletedEditorKeys.delete(source); }
  else prefabCache.delete(source);
}

/** The GUIDS of what an asset delete evicted or deleted (#1805 close-out review): a scene swap's warm
 *  (`warmEditorPrefabCacheFor`, which seeds only guid sources from the loader) seeds a cold key from the LOADER's entry,
 *  which a delete left in place until #1834, so a reload put the deleted prefab straight back and the eviction lasted one
 *  swap. The loader evicts too now (`evictDeletedPrefabs`), and the tombstone stays as the second line: an entry a load
 *  seeded between the eviction and the warm is still not read. Such a guid is read from disk instead, through the manifest: a 404 for a file still gone, the document for one an
 *  undo restored — or, where the manifest still maps the guid to that path and a new file took it, that file's document,
 *  which the warm got through the loader before this too. Cleared by any document seated under the guid. */
const deletedEditorKeys = new Set<string>();

/** Did an asset delete evict `source` from the editor cache, with nothing seated under it since? */
export function editorPrefabDeleted(source: string): boolean {
  return deletedEditorKeys.has(source);
}

/** The editor cache's half of a prefab write, for `commitPrefabWrite` (prefabCommit.ts) alone: set `source` to the
 *  document just written, or evict it after a trash. The runtime cache is the commit's to update. */
export function seatEditorPrefabCache(source: string, prefab: PrefabFile | null): void {
  seatEditorEntry(source, prefab);
}

/** A prefab file moved from `from` to `to` (every file under it when `prefix`): its PATH key follows it (#1751 F6), so a
 *  reader by the new path finds it and nothing reads a stale copy at a path a new file may later take. The guid key is
 *  untouched — the file's identity did not change. As in the runtime cache's re-key (`rekeyCachedPrefab`), the old key
 *  goes and the moved document wins at the new one: the file there IS the moved file, and an entry left there by a file
 *  deleted earlier (#1738) must not answer for it. */
export function rekeyEditorPrefabCache(from: string, to: string, prefix = false): void {
  if (!from || !to || from === to) return;
  const dir = from.endsWith('/') ? from : `${from}/`;
  for (const [key, doc] of [...prefabCache]) {
    if (key !== from && !(prefix && key.startsWith(dir))) continue;
    const next = key === from ? to : `${to.endsWith('/') ? to : `${to}/`}${key.slice(dir.length)}`;
    prefabCache.delete(key);
    prefabCache.set(next, doc);
  }
}

/** A prefab file was DELETED (#1805, I9) — every file under `from` when `prefix`: every entry of the EDITOR cache that
 *  answers for it goes. Without it the editor cache kept answering after the trash while a world swap's re-fetch 404'd in
 *  the loader's, and a sync reader expanded a prefab that no longer exists (an instantiate from the stale entry, which the
 *  reload then showed empty).
 *
 *  The LOADER's entry goes in the same pass (`evictDeletedPrefabs`, #1834), keeping the scene's ownership. It was held
 *  back until #1819 landed: evicted, a reload after the delete gives Missing Prefab placeholders, and an undo run against a
 *  placeholder was #1819's open class; it now REFUSES by ruling R (`require`). What this evicts is also TOMBSTONED
 *  (`editorPrefabDeleted`), so a swap's warm reads it from disk rather than seeding it back from the loader. A delete is
 *  not undoable (#1868, owner ruling D2); a file put back from the OS Trash is an outside write, which the watcher raises.
 *  Every save captures the live instance from its frame record (I18).
 *
 *  An entry answers for the deleted file when its key is the path, when its key is a guid the manifest still maps into the
 *  deleted range, or when it is the id of a DOCUMENT held under one of those — which finds the guid key after a pruning
 *  manifest update (the dev server's full rescan, `createEditor.tsx`) has already forgotten the guid. ⚠️ One window
 *  stays: that rescan landing BEFORE this repair, with the prefab held under its guid ALONE, leaves nothing to trace the
 *  guid to the path, and the entry is not found. The Electron IPC update is additive and never prunes, so there the guid
 *  still maps when the route's repair runs.
 *  Live instances of it stay expanded: that is #1738's evicted state, and every writer captures them from their frame
 *  records (I18), so a save writes what the reload's Missing Prefab placeholder reads back. Returns how many it evicted. */
export function evictDeletedEditorPrefabs(from: string, prefix = false): number {
  if (!from) return 0;
  const dir = from.endsWith('/') ? from : `${from}/`;
  const inRange = (p: string | undefined) => !!p && (p === from || (prefix && p.startsWith(dir)));
  // A guid key by where it LIVED (#1834): the delete's pruned manifest push lands before this repair in the dev editor, and
  // resolving by the live manifest then found no path for a prefab held under its guid alone, so the trashed document
  // stayed readable (the "one window", docs/prefabs.md I9; it let Apply's I16 check see a trashed prefab only by luck, #1866).
  const pathOf = (key: string) => (isGuid(key) ? lastKnownPathOf(key) : key);
  const ids = new Set<string>();
  for (const [key, doc] of prefabCache) if (inRange(pathOf(key)) && doc.id) ids.add(doc.id);
  // Tombstoned too: every guid the manifest still maps into the range, whether or not the editor held it — the next swap's
  // warm would otherwise seed it from the loader's stale entry (`editorPrefabDeleted`).
  for (const a of getAllAssets()) if (a.type === 'prefab' && inRange(a.path)) ids.add(a.guid);
  let n = 0;
  for (const key of [...prefabCache.keys()]) {
    if (!inRange(pathOf(key)) && !ids.has(key)) continue;
    prefabCache.delete(key);
    if (isGuid(key)) deletedEditorKeys.add(key);
    n++;
  }
  for (const id of ids) deletedEditorKeys.add(id);
  return n;
}

/** Is this source already in the editor cache? (`getCachedPrefabSync` answers the same
 *  question, but returning the file invites a caller to use a copy it should not hold.) */
export function isEditorPrefabCached(source: string): boolean {
  return prefabCache.has(source);
}

/** True if nesting `childGuid` inside `parentGuid` would create a reference cycle
 *  — i.e. the child transitively nests the parent (or IS the parent). Best-effort
 *  sync walk over the editor cache (`prefabNests`); the instantiate-time `_stack` guard backstops
 *  any cycle this can't see (e.g. a child not yet cached). */
export function wouldCreateCycle(parentGuid: string, childGuid: string): boolean {
  return prefabNests(parentGuid, childGuid, prefabNestingReader());
}

/** The documents I16's cycle walk reads (#1866): the editor cache, then the document the live world last EXPANDED the prefab
 *  from (its frame records, `frameDocReader`). A prefab trashed mid-session is gone from both caches (#1805, #1834), but its
 *  live frames still hold what it nests, and it comes back with those bytes when the trash is undone. Read through the
 *  cache alone, the walk counted it as nesting nothing: an Apply promoted a live instance of the trashed P into Q, which P
 *  nests, and Q → P → Q was written, to show up as "P nests itself" the moment P was restored (hunt seed 6031). */
export function prefabNestingReader(): (guid: string) => PrefabFile | null {
  const recorded = frameDocReader(getCurrentWorld(), () => undefined);
  return (guid) => getCachedPrefabSync(guid) ?? ((recorded(guid) as PrefabFile | null | undefined) ?? null);
}

/** The template key a live added node had when it was spawned, recovered from its guid — for when
 *  the marker is gone (Play→Stop, delete→undo, a saved scene; #1387, #1426). The algorithm is the
 *  runtime's (`runtime/loaders/templateKeyRecovery.ts`), shared with the loader's heal; the editor's
 *  candidates are the keys its own prefab cache declares, which include a prefab being edited that no
 *  world ever expanded. `''` when nothing matches. */
export function recoverTemplateKey(ecsId: number, memo = new Map<number, string>()): string {
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta) return '';
  const keys = new Set<string>();
  for (const doc of new Set(prefabCache.values())) for (const k of templateKeysOf(doc)) keys.add(k);
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  const nodeOf = (id: number): KeyRecoveryNode | undefined => {
    const ea = readTraitData(id, eaMeta);
    if (!ea) return undefined;
    const pi = piMeta ? readTraitData(id, piMeta) as { localId?: number; parentLocalId?: number } | null : null;
    const key = templateKeyOf(findEntity(id));
    // By where the derive pass continues from (#1437, #1809): a member moved inside its instance from its template
    // parent, a keyed node from its frame root (`identityParents.ts`).
    const at = pi || key ? (identity ??= worldIdentityParents(getCurrentWorld())).derivesFrom(id) : { parentId: (ea.parentId as number) || 0, extra: [] };
    return { guid: durableGuid(ea.guid as string), parentId: at.parentId, key, pi, extra: at.extra };
  };
  return recoverKeyFrom(ecsId, nodeOf, keys, memo, undefined, (id) => (identity ??= worldIdentityParents(getCurrentWorld())).derivesFromAsKeyed(id));
}

// F7's root order (`overrideMarks.ts`): a reference node that lost its key marker is a template's copy, not the scene's.
setTemplateCopyTest((e) => !!recoverTemplateKey(e.id()));

/** Seed (or evict) both prefab caches with a document READ from disk — `openPrefabForEditing`'s read (`fetchPrefabSource`).
 *  ⚠️ NOT for a write: a prefab write is `commitPrefabWrite` (prefabCommit.ts, #1692), which seats both caches under
 *  every key only once the write has landed, and then rebuilds the live frames. Every writer used to call this after
 *  its own write, and each one that stopped there left other instances expanded from the old document (#1685). */
export function setPrefabCache(source: string, prefab: PrefabFile | null): void {
  seatEditorEntry(source, prefab);
  // Keep the runtime refcounted prefab cache in sync. REPLACE rather than evict: an eviction strands every synchronous
  // runtime reader until the next scene load (#1308). A delete still evicts.
  if (prefab) replaceCachedPrefab(source, prefab);
  else invalidatePrefab(source);
}
