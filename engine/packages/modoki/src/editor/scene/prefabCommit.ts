/** A change to a prefab document is ONE step (#1692, #1880 W; docs/prefabs.md § "Model and invariants", I9–I11, and
 *  § "One step for every change to a prefab document"). `commitPrefabChanges` is the step: a write (`'file'`), an undo's
 *  park (`'park'`) or an outside change taken in (`'adopt'`), each through one invariant stage — see its comment.
 *  `tests/architecture/prefabStepCensus.test.ts` pins that nothing else writes, parks or seats a prefab.
 *
 *  What follows is the write's history. `commitPrefabWrite` became the only function that changes a `.prefab.json`. Before it, `writePrefabFileReport` put the
 *  bytes on disk and seated the runtime cache under the one key it was handed, and every writer assembled the rest
 *  itself — the editor cache, the rebuild of the live frames, the check that the world was still the one it began in.
 *  Each writer that skipped a step was a bug: Create Prefab → Replace, the skin rig and the model regenerate rebuilt
 *  nothing, so another live instance was saved against the old rows and lost the template's new members for good
 *  (#1685); the agent `create` set no editor cache at all; the forward Apply ran its refresh and pushed its undo entry
 *  into whatever world was live after its write (#1667); Apply's undo saved the scene file with no precondition
 *  (#1695). One step, so no writer can leave one out:
 *
 *  1. **The write is conditional** on what the caller read — `expected` (I10). A failed or refused write changes
 *     nothing: no cache, no frame.
 *  2. **Both caches** then hold the written document under every key they are read by (I9).
 *  3. **Every live frame** of the source is rebuilt, or refused: the caller's own `rebuild` first (Apply's refresh,
 *     Create Prefab's tag), then {@link rebaseStaleInstances} for every frame of this source still expanded from
 *     another document.
 *  4. **Serialized against world switches** (I11): the step holds them off from its first line to its last
 *     (`beginWorldBoundOperation`), starts only once no editor route is between its world call and its adopt (#1698's
 *     `adoptionsSettled`), and rebuilds nothing when the world it began in is gone or a route is mid-adoption after the
 *     write (`pendingAdoptions`). */

import { admitPrefabDocument } from '../../runtime/loaders/documentIdentity';
import { frameRepeatRefusal } from '../../runtime/loaders/frameRepeat';
import { type PrefabFile } from './prefab';
import { preloadNestedPrefabs, seatEditorPrefabCache, prefabNestingReader, getCachedPrefabSync, evictDeletedEditorPrefabs, rekeyEditorPrefabCache } from './prefabCache';
import { notePrefabFileChanged } from './prefabRead';
import { rebaseStaleInstances } from './prefabRebuild';
import { expandedPrefabRefs, prefabNests } from '../../runtime/loaders/prefabNesting';
import { postWriteFile, jsonFileBody, readBackendAnswer } from '../backend/editorBackend';
import { deleteAssetFiles } from '../panels/assetOps';
import { sha256OfWritten, sha256OfBytes } from '../utils/contentHash';
import { newGuid, registerAsset, getGuidForPath, isGuid, resolveRef, guidMovedFrom, resolveGuidToPath } from '../../runtime/loaders/assetManifest';
import { replaceCachedPrefab, invalidatePrefab, evictDeletedPrefabs, acquirePrefab, getCachedPrefab, rekeyCachedPrefab } from '../../runtime/loaders/meshTemplateCache';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { isHtmlFallthrough } from '../../runtime/loaders/assetFetch';
import { isPrefabDocument } from '../../runtime/loaders/prefabRoot';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { beginWorldBoundOperation } from '../undo/undoManager';
import { adoptionsSettledGate, pendingAdoptionCount, captureAdoptionGate } from './adoptionGate';
import { parkedPrefab, parkedPrefabEntry, beginAssetWrites, parkPrefab, discardDirtyAssets, assetWritesSettled, prefabWriteStarting, prefabWriteLanded } from './dirtyAssets';
import { UndoRefusedError } from '../undo/undoFailure';
import { useEditorStore } from '../store/editorStore';
import { localIdCounter, storedLocalIdCounter, advanceLocalIdCounter, markUnstated, sameDocumentContent, canonicalJson, LOCAL_ID_MARK_VERSION, type CountedDoc } from '../../runtime/core/localIdCounter';
import { markStale } from '../../runtime/prefab/instanceStore';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** What the file must hold for the write to go ahead:
 *  - a `PrefabFile`: the document the caller READ. Matched against the editor's own serialization of it first, and —
 *    only when that is refused — against the file's bytes re-read and parsed the way every reader parses them, so a
 *    file written by another tool (other whitespace, CRLF, a BOM, a key the zIndex migration fills in) still counts
 *    as the document read. The retry is conditional on the bytes it read, so nothing can land in between.
 *  - a string: the exact bytes the caller wrote or read (an undo's other half).
 *  - `null`: nothing may be at the path (a create). */
export type PrefabExpectation = PrefabFile | string | null;

export interface PrefabCommitResult {
  ok: boolean;
  /** The file the ref names. */
  path: string;
  /** The precondition refused: the file is not what the caller read (or something is there on a create). Nothing
   *  changed — not the file, not a cache, not a frame. */
  conflict?: boolean;
  /** Why it did not land, when the route or the hash said so. */
  error?: string;
  /** What to do instead, when the route's refusal said (#1776) — handed to an agent refusal as its `options`. */
  options?: string[];
  /** The world the step began in was replaced while it wrote: the caches hold the new document, which is what the
   *  new world's load reads, and nothing was rebuilt. */
  worldLeft?: boolean;
  /** Frames the rebase rebuilt. */
  rebased?: number;
}

export interface PrefabCommitOptions {
  expected: PrefabExpectation;
  /** The exact bytes to write, for an undo that puts a replaced file back VERBATIM (#1679): `doc` must be what they
   *  parse to, and it is what the caches hold. Default: the editor's own serialization of `doc`. */
  bytes?: string;
  /** Write with NO precondition. Only for a deliberate gesture that has been shown the conflict and chose to replace
   *  what is on disk — the prefab-edit save's Overwrite (#1692). Nothing else passes it. */
  overwrite?: boolean;
  /** The caller's own rebuild, run once the caches hold the document and before the rebase: Apply's refresh (with its
   *  guid remap and applied-field subtraction), Create Prefab's tag of the tree it wrote. Not run when the world left. */
  rebuild?: (landed: { path: string }) => void | Promise<void>;
  /** The `rebuild` keeps the records it touches as they must stand (#2046): the commit marks no record stale for it. */
  maintainsRecords?: boolean;
  /** `false`: skip the rebase. For a caller whose `rebuild` replaces the world and rebases it itself (Apply's undo
   *  reloads a scene snapshot). */
  rebase?: boolean;
}

/** Why a commit over `path` met a conflict, worded for the caller to say (#1872 close-out review). Two causes, and they
 *  need opposite advice:
 *  - `parked`: the prefab is PARKED over an outside change of its file (#1868: the watcher kept the park). The writer read
 *    the park (`readPriorDocument`), whose baseline the file no longer holds, so a retry meets the same conflict until
 *    the park is saved (Save asks whether to overwrite the outside change) or discarded.
 *  - otherwise the file changed between the writer's read and its write, and a retry reads the new content. */
export function prefabConflictReason(path: string): { parked: boolean; reason: string } {
  return parkedPrefabEntry(path)?.fileChanged
    ? { parked: true, reason: `${path} has unsaved changes in the editor and its file was changed outside the editor since, so it was left as it is — save it first (Save asks whether to overwrite the outside change) or discard the editor's changes, then try again` }
    : { parked: false, reason: `${path} changed on disk while it was being written, so it was left as it is` };
}

/** The file a prefab ref names: a GUID through the manifest; a path (a not-yet-normalized instance, a new file) as is. */
export function prefabPathOf(source: string): string {
  return isGuid(source) ? (resolveRef(source) || source) : source;
}

/** One file of a {@link commitPrefabWrites}: `doc` for `source` (or `null` to trash it), over `expected`. */
export interface PrefabWrite {
  source: string;
  doc: PrefabFile | null;
  expected: PrefabExpectation;
  /** See {@link PrefabCommitOptions.bytes}. */
  bytes?: string;
}

export interface PrefabCommitsResult {
  ok: boolean;
  /** Each file's path, in the order written (the route's spelling where it named one). */
  paths: string[];
  /** A precondition refused: some file is not what its caller read. With `stranded` empty, nothing changed. */
  conflict?: boolean;
  error?: string;
  /** What to do instead, when the route's refusal said (#1776). */
  options?: string[];
  /** The file whose precondition or write refused or failed (`conflict`/`error`) — the one a refusal names (#1732): with
   *  several files it is not necessarily the first. */
  failed?: string;
  /** Files a mid-way failure left written and could NOT put back (a multi-file commit's rollback lost a race too). */
  stranded?: string[];
  worldLeft?: boolean;
  rebased?: number;
}

/** How a change to a prefab document LANDS (#1880 W, `commitPrefabChanges`):
 *  - `'file'`: its bytes are written — every forward write (Apply, Create/Replace, a prefab-edit save, a model or rig
 *    import) and Save's flush of a park;
 *  - `'park'`: it is held in memory for Save to write (#1868, D1 = Park) — every undo and redo of a prefab write;
 *  - `'adopt'`: the file already changed and the editor takes it (#1873 R1's re-import, a discard, the watcher, the
 *    prefab-edit open's seed). */
export type Landing = 'file' | 'park' | 'adopt';

/** One change of a {@link commitPrefabChanges}. */
export interface PrefabChange {
  source: string;
  /** `'file'`: the document to write, `null` to trash the file. `'park'`: the document to restore. `'adopt'`: the
   *  document the caller READ from the file (the prefab-edit open), or `null` for the step to read it. */
  doc: PrefabFile | null;
  /** `'file'`: what the FILE must hold ({@link PrefabExpectation}). `'park'`: the document the EDITOR must hold — the side
   *  the step being undone or redone left. */
  expected: PrefabExpectation;
  land: Landing;
  /** `'file'` only: see {@link PrefabCommitOptions.bytes}. */
  bytes?: string;
}

export interface PrefabChangesResult extends PrefabCommitsResult {
  /** A `'park'` step refused before anything changed — the reason, worded for the undo or redo that asked. */
  refusal?: UndoRefusedError;
  /** An `'adopt'` step: what became of each file. */
  adopted?: AdoptReport;
}

/** What an `'adopt'` step did with each file (#1873 R1's report, #1880 W4). An adopt never refuses as a whole: each file is
 *  taken, or said. */
export interface AdoptReport {
  /** Each path whose file document both caches now hold. */
  reimported: string[];
  /** A path whose file could not be read, is still parked, contains itself, or met an editor write: the editor keeps the
   *  document it held. */
  failed: { path: string; reason: string }[];
  /** A path whose file is GONE (#1873 R1 r2): both caches evicted as the in-editor delete evicts them; the caller then
   *  shows its live instances as Missing Prefab placeholders (#2056, `showDeletedPrefabsMissing`). */
  deleted: string[];
  /** A path whose file is gone while its GUID lives at another path (#2067): a MOVE, which identity, not the path, decides
   *  (docs/mcp-persistence.md rule 2). Both caches' path keys follow it, as the in-editor move's repair does; nothing is
   *  evicted or tombstoned, and the instances stay live. */
  moved: { from: string; to: string }[];
  /** A path nothing in the open scene uses (#1702's case): only the caches were brought up to date. */
  unused: string[];
  /** Every key the step seated a live-used prefab under — what the rebase rebuilt from, and what the caller's
   *  placeholder pass looks for. */
  sources: string[];
}

/** A `'park'` change as the undo and redo of a prefab write record it: `doc` goes back, over `from`. */
export interface PrefabRestore {
  /** The prefab's guid — resolved to wherever the file is NOW, so a Rename since the step does not strand it (#1868 hub
   *  call e) — or a path, for a document with no guid. */
  source: string;
  /** The document to restore. */
  doc: PrefabFile;
  /** The document the step LEFT: what the editor must hold now (else the restore refuses), and what the file holds when
   *  nothing is parked for it. */
  from: PrefabFile;
}

/** Write `doc` to the prefab `source` names — or trash it, for `null` — as ONE step. See the module comment. */
export async function commitPrefabWrite(source: string, doc: PrefabFile | null, opts: PrefabCommitOptions): Promise<PrefabCommitResult> {
  const res = await commitPrefabWrites([{ source, doc, expected: opts.expected, bytes: opts.bytes }], {
    overwrite: opts.overwrite, rebase: opts.rebase, ...(opts.maintainsRecords ? { maintainsRecords: true } : {}),
    rebuild: opts.rebuild ? (landed) => opts.rebuild!({ path: landed.paths[0]! }) : undefined,
  });
  const { paths, stranded: _stranded, failed: _failed, ...rest } = res;
  return { ...rest, path: paths[0] ?? prefabPathOf(source) };
}

/** Several prefab files written as ONE step — {@link commitPrefabChanges} with every change landing `'file'`. */
export async function commitPrefabWrites(
  writes: readonly PrefabWrite[],
  opts: { overwrite?: boolean; rebuild?: (landed: { paths: string[] }) => void | Promise<void>; rebase?: boolean; maintainsRecords?: boolean } = {},
): Promise<PrefabCommitsResult> {
  const { refusal: _refusal, ...res } = await commitPrefabChanges(writes.map((w) => ({ ...w, land: 'file' as const })), opts);
  return res;
}

/** The undo and the redo of a prefab write (#1868, D1 = Park): each of `restores` goes back IN MEMORY as ONE step —
 *  {@link commitPrefabChanges} with every change landing `'park'` — and a refusal is thrown, before anything changed.
 *  `rebuild`: the caller's own live state (Apply's scene snapshot, Replace's tag), run once the caches hold every
 *  document and before the rebase. */
export async function parkPrefabChanges(
  restores: readonly PrefabRestore[],
  opts: { rebuild?: () => void | Promise<void>; rebase?: boolean; maintainsRecords?: boolean } = {},
): Promise<void> {
  const res = await commitPrefabChanges(restores.map((r) => ({ source: r.source, doc: r.doc, expected: r.from, land: 'park' as const })), {
    rebase: opts.rebase, ...(opts.rebuild ? { rebuild: () => opts.rebuild!() } : {}), ...(opts.maintainsRecords ? { maintainsRecords: true } : {}),
  });
  if (res.refusal) throw res.refusal;
}

/** What the editor holds for the prefab `source` names, NOW (#1880 W1): its park when one is there, else its cached
 *  document — what every editor read takes. `undefined` when neither holds one (a trash evicts both; a cold cache). */
export interface EditorNow {
  path: string;
  editor: PrefabFile | undefined;
  park: ReturnType<typeof parkedPrefabEntry>;
}

/** What the file holds: `'absent'`, `'unreadable'`, or its document — read now (`text`/`bytes` then set), or the record
 *  the editor keeps of it when nothing needed reading. */
export type FileNow = 'absent' | 'unreadable' | { doc: PrefabFile | null; text?: string; bytes?: Uint8Array };

/** See {@link EditorNow}. Synchronous: what the editor holds cannot need a read. */
export function editorNow(source: string): EditorNow {
  const path = prefabPathOf(source);
  const park = parkedPrefabEntry(path);
  return { path, park, editor: ((park?.doc as PrefabFile | undefined) ?? getCachedPrefabSync(source)) as PrefabFile | undefined };
}

/** The ONE answer to "what does the editor hold, and what does the file hold" for `source` (#1880 W1). The three
 *  computations it replaced — the park's `onDisk`, the undo step's own `from`, the commit's re-read — disagreed exactly
 *  where round 3 found its bugs (#1877 S1: the restore took a mark from `from`, lower than the file's since a Save).
 *
 *  The file is READ when `read` asks (a write, which is conditional on what it read), when a park's baseline is no longer
 *  the file's (`fileChanged`: the watcher kept the park over an outside change), and when the editor holds nothing — a
 *  trashed prefab, or a cold cache. Otherwise the editor's own record says what the file holds: a clean park's baseline
 *  (the file has not been written since it was parked), else the cached document (every write and every outside change
 *  seats the cache with what the file holds). */
export async function documentNow(source: string, opts: { read?: boolean } = {}): Promise<EditorNow & { file: FileNow }> {
  const now = editorNow(source);
  return { ...now, file: fileRecord(now, opts.read) ?? toFileNow(await readState(now.path)) };
}

/** The file half of {@link documentNow} when the editor's record answers it without a read; undefined when a read must. */
function fileRecord(now: EditorNow, read?: boolean): FileNow | undefined {
  if (read) return undefined;
  if (now.park) return now.park.fileChanged ? undefined : { doc: now.park.onDisk as PrefabFile };
  return now.editor ? { doc: now.editor } : undefined;
}

function toFileNow(state: Awaited<ReturnType<typeof readState>>): FileNow {
  return typeof state === 'string' ? state : { ...state, doc: parsedOrNull(state.text) };
}

const fileDocOf = (f: FileNow | undefined): PrefabFile | null => (f && typeof f === 'object' ? f.doc : null);

/** Is the prefab `source` names GONE — trashed since, its file absent — as {@link documentNow} answers it? False while
 *  the editor holds its document (a trash evicts both caches) and when the read fails: a failed read is not a delete. */
export async function prefabFileGone(source: string): Promise<boolean> {
  return (await documentNow(source)).file === 'absent';
}

/** The highest localId mark this session has seen for each prefab — by its guid, else its path — over every landing
 *  (#1880 W, hub ruling). The mark says "no number below me will be handed out again" (I4, #1774), and the file alone
 *  cannot carry that promise: an outside change can put back an older document (a `git checkout`) while the open scene
 *  still holds rows keyed to the newer members' numbers, and the next minting writer would then hand one of those
 *  numbers to an unrelated member. Memory only: never written by itself — it rides the next real write's mark. */
const markRecord = new Map<string, number>();

/** Paths an adopt refused as a cycle → every prefab its document reached through nesting when it was refused (any of
 *  them may be the link whose change breaks the cycle — A nests B nests X is broken by B alone): taken again once a step
 *  lands, or an adopt deletes, one of THOSE (see {@link retryClosedCycles}). Dropped whenever the path is examined again,
 *  and put back only if it is still a cycle. */
const cyclicAdopts = new Map<string, Set<string>>();

/** Every prefab `doc` reaches through nesting, read through `read` — the guids, and the paths they resolve to. */
function nestingClosure(doc: PrefabFile, read: (guid: string) => { entities?: unknown } | null | undefined): Set<string> {
  const out = new Set<string>();
  const queue = [...expandedPrefabRefs(doc.entities)];
  while (queue.length) {
    const ref = queue.shift()!;
    if (out.has(ref)) continue;
    out.add(ref);
    if (isGuid(ref)) { const at = resolveRef(ref); if (at) out.add(at); }
    const next = read(ref) as PrefabFile | null | undefined;
    if (next?.entities) queue.push(...expandedPrefabRefs(next.entities));
  }
  return out;
}

/** Take again every path refused as a cycle that one of `landed` (keys a step just seated, or an adopt found deleted)
 *  may have closed — once, as a retry, which never retries itself. Null when there is none. `rebase`: the caller's. */
async function retryClosedCycles(landed: ReadonlySet<string>, exclude: readonly string[], opts: { rebase?: boolean; fileChanged?: boolean }): Promise<AdoptReport | null> {
  const retry = [...cyclicAdopts].filter(([p, reach]) => !exclude.includes(p) && [...reach].some((k) => landed.has(k))).map(([p]) => p);
  if (!retry.length) return null;
  return (await landAdopts(retry.map((p) => ({ source: p, doc: null, expected: null, land: 'adopt' as const })), { ...opts, retry: true })).adopted!;
}

/** Test seam: forget {@link markRecord} and the adopt's cycle retries, as a fresh editor session starts without them. */
export function resetPrefabMarkRecord(): void { markRecord.clear(); cyclicAdopts.clear(); }

function recordedMark(key: string | undefined): number { return key ? markRecord.get(key) ?? 0 : 0; }
function recordMark(key: string | undefined, mark: number): void {
  if (key && mark > recordedMark(key)) markRecord.set(key, mark);
}

const counterOf = (d: unknown): number => (d && typeof d === 'object' ? localIdCounter(d as CountedDoc) : 0);
const expectedDocOf = (e: PrefabExpectation | undefined): PrefabFile | null => (e == null ? null : typeof e === 'string' ? parsedOrNull(e) : e);

/** ONE step for every change to a prefab document (#1880 W; docs/prefabs.md § "Model and invariants", I9–I11, I16). The
 *  write door (`commitPrefabWrites`) stated the invariants and the in-memory restore every undo used (#1868) stated most
 *  of them again, or did not (#1877 C1: the mark written back down, a self-containing restore, an undo resurrecting a
 *  trashed prefab). Each change carries how it lands ({@link Landing}); every landing passes the same stage, in this
 *  order, BEFORE anything changes, and a refusal changes nothing:
 *
 *  1. **The world gate** (I11): held against world switches from the first line to the last (`beginWorldBoundOperation`),
 *     started only in an ADOPTED world once no route is between its world call and its adopt (#1698, #1750 R2).
 *  2. **{@link documentNow}**: what the editor and the file hold, once.
 *  3. **The precondition**: `'file'` — the file holds `expected` (I10); `'park'` — the editor holds `expected`, the side
 *     the step left (the #1664/#1679 precondition, asked of memory).
 *  4. **The file exists** (`'file'` over a document, `'park'`): a prefab trashed since is not written or parked back —
 *     Unity brings no deleted asset back through an undo either.
 *  5. **I16**: no document lands that contains itself, read through this step's own documents first (a cycle across two
 *     files of one Apply). Only a true no-op is exempt: `bytes` the file holds already (W3).
 *  6. **The mark** (I4, #1774): the highest of the document's, the editor's (its park included), the file's, what
 *     `expected` names and {@link markRecord} — taken once, here.
 *  7. **Land**: a conditional write (N files: every precondition first, a mid-way miss rolled back), or a park, or the
 *     park dropped when the document is what the file holds.
 *  8. **The tail**: both caches seated (`seatCaches`: REPLACE, never evict, #1308), nested prefabs preloaded, the
 *     caller's `rebuild`, then {@link rebaseStaleInstances} over every source.
 *
 *  One landing per step: no caller mixes them, and a mix would need a rollback across a written file and a park. */
async function commitPrefabChangesUnmarked(
  changes: readonly PrefabChange[],
  opts: {
    overwrite?: boolean; rebuild?: (landed: { paths: string[] }) => void | Promise<void>; rebase?: boolean;
    /** The caller's `rebuild` maintains the instance records itself (it marks stale what it rebuilds from the capture,
     *  #2046 S7.3): the step does not mark the whole store stale for running it. */
    maintainsRecords?: boolean;
    /** `'adopt'`: the file CHANGED (the watcher, a discard), so every read of it in flight is older than it (#1752). False
     *  for an adopt of a file that did not change (the prefab-edit open, the leave repair). Default true. */
    fileChanged?: boolean;
  } = {},
): Promise<PrefabChangesResult> {
  const asked = changes.map((c) => prefabPathOf(c.source));
  const land = changes[0]?.land ?? 'file';
  if (changes.some((c) => c.land !== land)) {
    return { ok: false, paths: asked, error: 'a prefab step lands every change the same way (a write, a park or an adopt), so nothing was changed' };
  }
  if (land === 'adopt') {
    // 1. The world gate, as the re-import held it: an adopt writes nothing, so it waits for no route — it RUNS inside
    // routes (the prefab-edit open's seed, the leave repair) and inside the watcher, which asks the adoption owner
    // itself. It holds world switches off while it runs, and rebuilds only in the world it began in.
    const release = beginWorldBoundOperation();
    try { return await landAdopts(changes, opts); } finally { release(); }
  }
  /** A refusal of this step: said, and for a park thrown by the undo that asked (`refusal`). */
  const refuse = (error: string, short: string, extra: Partial<PrefabChangesResult> = {}): PrefabChangesResult => ({
    ok: false, paths: asked, error, ...extra, ...(land === 'park' ? { refusal: new UndoRefusedError(error, short) } : {}),
  });
  // 1. The world gate, for a PARK: the undo or redo step that runs it — the world switches that take `beginWorldSwitch`
  // wait for a running step (#1579); the watcher's hot reload does not, and the old in-memory restore was not gated
  // against it either. The adoption gate below is not for a park (close-out review): its refusals are TRANSIENT ("a
  // scene is still loading", "the scene was replaced"), and an undo that refuses is dropped from the history for good —
  // a rig-prefab undo, which survives world swaps, was lost behind a pending hot reload with a toast saying "try again".
  if (land === 'park') return landParks(changes, opts, refuse);
  // 0. Identity (#1937 C-A step 6, owner ruling F-D): a document declaring a localId, nodeGuid or template key twice is
  // never WRITTEN — every seat would refuse it, and every instance of it would become a Damaged Prefab placeholder. Asked
  // of every editor write (Apply, Create Prefab, the prefab-edit save, the agent's ops) here, in the one write path; a
  // park restores what a file held, and an undo is not refused for the file's own past.
  // …and one a key two files give one frame (#1933 L5), read through this step's own documents first, then the editor's
  // cache (a nested prefab it does not hold is not checked, as the validator says).
  const stepDocs = new Map<string, PrefabFile>();
  for (const c of changes) if (c.doc?.id) stepDocs.set(c.doc.id, c.doc);
  const readNested = (g: string): unknown => stepDocs.get(g) ?? getCachedPrefabSync(g) ?? null;
  for (const c of changes) {
    if (!c.doc) continue;
    const admitted = admitPrefabDocument(c.doc);
    const refusal = 'refusal' in admitted ? admitted.refusal : frameRepeatRefusal(admitted.doc, readNested);
    if (refusal) return refuse(`${prefabLabel(prefabPathOf(c.source), c.doc).long} was not written: ${refusal}`, `the prefab would be damaged (${'malformed' in admitted && admitted.malformed ? 'a value in a shape no reader takes' : 'an identifier declared twice'}) — nothing was written`);
  }
  const release = beginWorldBoundOperation();
  let releaseWrites = () => {};
  try {
    // 1. The world gate. A route between its world call and its adopt (a hot reload, a scene load past its wait): the
    // world on screen is about to become another scene's, and its history and path with it. Waited for, not raced — the
    // owner registers a route only around its own world call, never across a prefab step, so this cannot wait for itself
    // (#1698). Asked through `adoptionGate.ts`, not by importing the owner: that import closes a load-time cycle through
    // `./prefab` and drags the owner's whole graph into every write (see that file).
    // ⚠️ The world is taken BEFORE the wait (close-out review): the wait only blocks when a route is about to REPLACE the
    // world, and taken after it the step adopted that new world as its own — its caller's rebuild (Apply's refresh,
    // Create Prefab's and the agent's tag) then ran there, with ids and captures from the world it began in. A world
    // replaced while waiting refuses the whole step instead: what the caller computed describes a world that is gone.
    // …and taken only in an ADOPTED world (#1750 R2): called in a route's State 4 (another prefab's edit-open tail), the
    // world is already the incoming one and stays "the same" all the way to its adopt, so the commit wrote that world as
    // the open prefab (#1747). Refused, not waited for (owner, 2026-09-28: a world that is not savable refuses).
    const live = captureAdoptionGate();
    if (!live) {
      return refuse('a scene is still loading, so nothing was changed — try again once it is open', 'a scene is still loading — nothing was changed', { worldLeft: true });
    }
    const world = getCurrentWorld();
    const settling = adoptionsSettledGate();
    if (settling) await settling;
    if (!live()) {
      return refuse('the scene was replaced before the change could start, so nothing was changed', 'the scene was replaced — nothing was changed', { worldLeft: true });
    }
    const worldLeft = () => !live() || pendingAdoptionCount() > 0;
    return await landFiles(changes, opts, worldLeft, world, (b) => { releaseWrites = b; });
  } finally {
    releaseWrites();
    release();
  }
}

type Refuse = (error: string, short: string, extra?: Partial<PrefabChangesResult>) => PrefabChangesResult;

/** The name a refusal gives the prefab at `path`: its file name, or — for a guid no manifest maps any more (a trash
 *  unregisters the asset) — the document's name with the guid. */
function prefabLabel(path: string, doc: PrefabFile | null | undefined): { long: string; short: string } {
  if (isGuid(path)) return { long: `"${doc?.name ?? path}" (${path})`, short: doc?.name ?? path };
  return { long: path, short: path.split('/').pop() ?? path };
}

/** I16 over this step's documents, read through the step's own documents first, then the editor's (a prefab no cache
 *  holds — trashed mid-session — is read from what its live frames were expanded from, #1866). The first document that
 *  would contain itself, with the ref that closes the cycle; null when none. `skip`: a change I16 does not ask. */
function selfContaining<T extends { doc: PrefabFile | null; guid?: string }>(plan: readonly T[], skip: (w: T) => boolean): { w: T; ref: string } | null {
  const batch = new Map(plan.filter((w) => w.doc && w.guid).map((w) => [w.guid!, w.doc!]));
  const nesting = prefabNestingReader();
  const read = (g: string) => batch.get(g) ?? nesting(g);
  for (const w of plan) {
    if (!w.doc || !w.guid || skip(w)) continue;
    const ref = expandedPrefabRefs(w.doc.entities).find((r) => prefabNests(w.guid!, r, read));
    if (ref) return { w, ref };
  }
  return null;
}

/** The `'adopt'` landing of {@link commitPrefabChanges} (#1880 W4): the FILE already changed — an outside write, a
 *  delete or a put-back (#1873 R1, the watcher), a discarded park (#1873 S2), or a file the prefab-edit open just read —
 *  and the editor takes it. Unity's import after an AssetDatabase write. It never refuses as a whole: each file is taken,
 *  or said in {@link AdoptReport}, and the editor keeps what it held for one it could not take.
 *
 *  - The precondition: an editor write that landed while the file was read seated a newer document than those bytes, and
 *    rebased the instances onto it — it is not overwritten (the refresh's rule).
 *  - Exists does NOT refuse here: a file gone is itself adopted. A gone file whose GUID lives at another path is a MOVE
 *    (#2067): its path keys follow it. Otherwise both caches are evicted as the in-editor delete evicts them, and the
 *    caller shows the live instances as Missing Prefab placeholders (#2056), as Unity does; a put-back re-expands them.
 *  - I16: a file that would contain itself is not seated (hub ruling, 2026-09-30): an outside write cannot be refused, but
 *    seating it would expand a cycle. Said with the prefab that closes it.
 *  - The mark (hub ruling (A)): the file's document is seated with its mark raised to {@link markRecord} and to what both
 *    caches held (the loader's copy included: after a scene load it is often the only one) — in the CACHES only. Nothing is parked or written, and `sameDocument` ignores the mark, so no
 *    precondition and no dirty flag moves; the next real write carries the raised mark to the file. Without it, an
 *    outside `git checkout` of an older document let the next minting writer (every one reads the cached mark) number a
 *    new row at one the open scene still keys a newer member by.
 *  - Seated with REPLACE, never evict (#1308): a prefab something uses live takes `seatCaches` under every key; one
 *    nothing uses has only the keys somebody read brought up to date, and its runtime copy follows the scenes that own
 *    it. Then the rebase, when asked, over every live-used source. */
async function landAdopts(changes: readonly PrefabChange[], opts: { rebase?: boolean; fileChanged?: boolean; retry?: boolean }): Promise<PrefabChangesResult> {
  const report: AdoptReport = { reimported: [], failed: [], deleted: [], moved: [], unused: [], sources: [] };
  // What uses a prefab asks the scene manager, whose module this one must not load for every write (a hand-listed runtime
  // mock of a unit test, a load-time cycle): imported by an adopt that READS its file. One the caller read (the
  // prefab-edit open) asks none of it, and seats before its first await — its caller takes a read token over the seat.
  const sceneUse = (() => { let m: Promise<typeof import('./prefabUse')> | undefined; return () => (m ??= import('./prefabUse')); })();
  // The prefab OPEN in prefab edit keeps its editor copy against an outside change until the session ends, and the leave
  // repair takes the file then (#1666): an in-editor writer that read that copy is refused as a conflict meanwhile — the
  // safe direction (`refreshPrefabSourceForPath`'s rule, kept).
  const editing = useEditorStore.getState().editingPrefab?.guid;
  const world = getCurrentWorld();
  const paths = changes.map((c) => prefabPathOf(c.source));
  const taken: Array<{ path: string; source: string; keysBefore: string[]; held: Array<PrefabFile | null>; doc: PrefabFile; guid?: string; read: boolean }> = [];
  /** The paths found gone, judged once every file of the batch is read: a move's new path may come later in it (#2067). */
  const gone: Array<{ path: string; keysBefore: string[]; held: Array<PrefabFile | null> }> = [];
  /** Every key this step seated a document under — what a cycle refused earlier may have been waiting for. */
  const landed = new Set<string>();
  for (const [i, c] of changes.entries()) {
    const path = paths[i]!;
    // Examined again: whatever happens below replaces what a retry was waiting for (close-out re-review — only the
    // live-used seat cleared it, and every other outcome left the path re-read by every later adopt for the session).
    cyclicAdopts.delete(path);
    // A park still there is what every editor read takes in place of the file (#1868): adopting the file would re-seat
    // the park, not the file. The caller discards first.
    if (parkedPrefab(path) !== undefined) { report.failed.push({ path, reason: 'it is still parked, so its file was not read' }); continue; }
    // Any read of it in flight read the document before the change (#1752): it must not prime the caches after this does.
    if (opts.fileChanged !== false) notePrefabFileChanged(path);
    const pathGuid = getGuidForPath(path);
    const keysBefore = [...new Set([path, ...(pathGuid ? [pathGuid] : []), ...(isGuid(c.source) ? [c.source] : [])])];
    const held = keysBefore.map((k) => getCachedPrefabSync(k));
    let doc = c.doc;
    if (!doc) {
      // 2. What the file holds, read now.
      const file = toFileNow(await readState(path));
      // 3. The precondition: an editor write (an Apply, a Replace) landed during the read.
      if (keysBefore.some((k, j) => getCachedPrefabSync(k) !== held[j])) {
        report.failed.push({ path, reason: 'an editor write landed while its file was read, and the editor keeps that write' });
        continue;
      }
      if (file === 'absent') { gone.push({ path, keysBefore, held }); continue; }
      doc = file === 'unreadable' ? null : file.doc;
      // A half-typed hand edit keeps the document the editor held — and so does JSON that is not a prefab (no `entities`,
      // #1813's `isPrefabDocument`): seated, every synchronous reader of the caches throws on it (close-out review).
      if (!doc || !isPrefabDocument(doc)) { report.failed.push({ path, reason: 'its file could not be read as a prefab, so the editor keeps the document it held' }); continue; }
    }
    taken.push({ path, source: c.source, keysBefore, held, doc, guid: pathGuid ?? doc.id, read: !c.doc });
  }
  for (const { path, keysBefore, held } of gone) {
    // 4a. Moved (#2067; rule 2, identity not path): the GUID that lived here — by the manifest's own record of the move,
    // by the document a cache held under the path, or by the path's own guid key — lives at another path now: in this
    // batch, or in the manifest, which a watcher rebuilds before it reports. Unity's import of a moved asset keeps its
    // instances linked. The caches' path keys follow it; the file at the new path is adopted on its own.
    const identities = [guidMovedFrom(path), ...held.map((d) => d?.id), ...keysBefore].filter((g): g is string => !!g && isGuid(g));
    const to = identities.map((g) => taken.find((t) => t.guid === g && t.path !== path)?.path ?? resolveGuidToPath(g)).find((p) => !!p && p !== path);
    if (to) {
      rekeyEditorPrefabCache(path, to);
      rekeyCachedPrefab(path, to);
      // The rekey is this step's own seat: the new path's adoption below re-checks its keys against what they held when
      // its file was read, and took the moved document under the new path for an editor write — it kept the old bytes
      // and said "not re-imported" (live, 2026-10-03). Its baseline is taken again, after the rekey.
      const dest = taken.find((t) => t.path === to);
      if (dest) dest.held = dest.keysBefore.map((k) => getCachedPrefabSync(k));
      report.moved.push({ from: path, to });
      continue;
    }
    // 4b. Gone — adopted as gone (#1873 R1 r2). Asked BEFORE any "is it used" rule (#1873 R1 review F2): the dev editor
    // loads the delete's PRUNED manifest before this event, so the path resolves to no guid by now — the eviction
    // finds the guid keys itself (`lastKnownPathOf`), and "used" asks by the guids that LIVED at this path too.
    const { usedLive, liveSourcesOnceAt, scenesReferencing } = await sceneUse();
    const keys = new Set([...keysBefore, ...liveSourcesOnceAt(path)]);
    const usedBefore = usedLive(keys) || scenesReferencing(keys).length > 0;
    evictDeletedEditorPrefabs(path);
    evictDeletedPrefabs(path);
    for (const k of keys) landed.add(k);
    (usedBefore ? report.deleted : report.unused).push(path);
  }
  // 5. I16, read through this step's documents first.
  const cyclic = new Set<(typeof taken)[number]>();
  for (const t of taken) {
    const hit = selfContaining(taken, (w) => w !== t);
    if (!hit) continue;
    cyclic.add(t);
    const batch = new Map(taken.filter((w) => w.guid).map((w) => [w.guid!, w.doc]));
    const nesting = prefabNestingReader();
    cyclicAdopts.set(t.path, nestingClosure(t.doc, (g) => batch.get(g) ?? nesting(g)));
    const through = isGuid(hit.ref) ? (resolveRef(hit.ref) || hit.ref) : hit.ref;
    report.failed.push({ path: t.path, reason: `it would contain itself (it nests ${through}, which nests it back), so it was not re-imported — the editor keeps the document it held` });
  }
  for (const t of taken) {
    if (cyclic.has(t)) continue;
    const { path, keysBefore, held, guid } = t;
    // 6. The mark, raised in the caches only (see above).
    const key = guid ?? path;
    // The loader is asked by guid only: it resolves a ref through the manifest, which refuses a path loudly.
    const loaderKeys = [...new Set([...keysBefore, ...(guid ? [guid] : [])])].filter(isGuid);
    const need = Math.max(recordedMark(key), ...held.map(counterOf), ...loaderKeys.map((k) => counterOf(getCachedPrefab(k))));
    let doc = t.doc;
    if (need > localIdCounter(doc as CountedDoc)) { doc = clone(doc); stateRaisedMark(doc, need); }
    recordMark(key, localIdCounter(doc as CountedDoc));
    const keys = new Set([...keysBefore, ...(guid ? [guid] : []), ...(doc.id ? [doc.id] : [])]);
    const heldKeys = keysBefore.filter((k, j) => held[j] && !(t.read && k === editing));
    if (t.read && opts.fileChanged === false) {
      // 7. Land — the file did not change (the leave repair): the editor keys somebody read take it, and the manifest
      // names it; nothing else moves. The runtime copy is the file's already, and its revision bump would refuse every
      // read in flight for a write nobody made (#1752 close-out re-review).
      for (const k of heldKeys) seatEditorPrefabCache(k, doc);
      if (doc.id) registerAsset(doc.id, path, 'prefab');
      landed.add(path); if (guid) landed.add(guid);
      report.reimported.push(path);
      continue;
    }
    // 7. Land. The LOADER's copy (#1873 R1 review F1): every loaded scene that references the prefab keeps owning it, with
    // the file's document — a timeline spawn, an empty pool or a game trait's ref reads it synchronously. Acquired by its
    // GUID (the loader resolves only a guid ref), which the manifest maps to the path the file has NOW.
    const owners = t.read ? (await sceneUse()).scenesReferencing(keys) : [];
    if (guid) for (const sid of owners) await acquirePrefab(sid, guid);
    // …and asked again after it (R1 review): an acquire of a path the loader does not hold is a real fetch.
    if (t.read && keysBefore.some((k, j) => getCachedPrefabSync(k) !== held[j])) {
      report.failed.push({ path, reason: 'an editor write landed while its file was read, and the editor keeps that write' });
      continue;
    }
    // A document the caller opened is in use by the caller.
    if (t.read && !(await sceneUse()).usedLive(keys)) {
      // Nothing live to rebase: the editor keys somebody read are brought up to date, and the rest stay cold
      // (`refreshPrefabSourceForPath`'s rule); the loader's copy is the file's, or gone when no scene owns it.
      for (const k of heldKeys) seatEditorPrefabCache(k, doc);
      if (doc.id) registerAsset(doc.id, path, 'prefab');
      if (owners.length) replaceCachedPrefab(path, doc); else invalidatePrefab(path);
      landed.add(path); if (guid) landed.add(guid);
      (owners.length ? report.reimported : report.unused).push(path);
      continue;
    }
    seatCaches(path, guid ?? t.source, guid, doc, t.read ? editing : undefined);
    landed.add(path); if (guid) landed.add(guid);
    await preloadNestedPrefabs(doc);
    for (const k of [path, ...(guid ? [guid] : []), ...(doc.id ? [doc.id] : [])]) if (!report.sources.includes(k)) report.sources.push(k);
    report.reimported.push(path);
  }
  // A file refused as a cycle is taken again once a prefab on its cycle lands or is deleted (close-out review): an outside
  // checkout that FLIPS a nesting direction (H nested X; now X nests H and H nests nothing) arrives one file per event,
  // and X, adopted first, read the old H and looked like a cycle — refused, and never retried, so the scene sat on a
  // document neither the file nor the editor held. Only when such a prefab lands, so a genuine cycle is not re-read by
  // every unrelated change; once, and never from a retry. A WRITE that breaks the cycle takes it again too (`landFiles`).
  if (!opts.retry && landed.size) {
    const again = await retryClosedCycles(landed, paths, { ...opts, rebase: false });
    if (again) {
      report.reimported.push(...again.reimported);
      report.failed.push(...again.failed);
      report.deleted.push(...again.deleted);
      report.moved.push(...again.moved);
      report.unused.push(...again.unused);
      for (const k of again.sources) if (!report.sources.includes(k)) report.sources.push(k);
    }
  }
  // 8. The rebase — not when the caller rebuilds its own world (the prefab-edit open, the leave repair), and not in a
  // world replaced during the reads: that load built its frames from these files itself.
  if (opts.rebase === false || !report.sources.length || getCurrentWorld() !== world) return { ok: true, paths, adopted: report };
  const rebased = await rebaseStaleInstances({ sources: new Set(report.sources) });
  return { ok: true, paths, rebased, adopted: report };
}

/** The `'park'` landing of {@link commitPrefabChanges} — the undo and redo of every prefab write (#1868, D1 = Park).
 *  Nothing is written and no scene is saved: both caches hold the document (as a write's would), the caller rebuilds its
 *  own live state, every other live frame is rebased onto it, and the document is PARKED in the dirty-asset registry — or
 *  its park is dropped, when it is what the file already holds (a redo back to what the forward write put there). */
async function landParks(changes: readonly PrefabChange[], opts: { rebuild?: (landed: { paths: string[] }) => void | Promise<void>; rebase?: boolean }, refuse: Refuse): Promise<PrefabChangesResult> {
  const paths = changes.map((c) => prefabPathOf(c.source));
  // 2. What the file holds, read FIRST where the editor's record cannot say (#1877 close-out review): awaited after the
  // settle below, a Save that began during its round trip was not waited for, which reopened the window the settle closes.
  const reads = await Promise.all(changes.map(async (c) => (fileRecord(editorNow(c.source)) ? undefined : toFileNow(await readState(prefabPathOf(c.source))))));
  // A Save writing one of these prefabs is waited for (close-out review F1), as an asset-document step waits: until its
  // write lands, the park's baseline says what the file held BEFORE it, and a redo back to that document read as "back to
  // the file" and dropped the park — leaving the file on the saved document and the editor on the redone one, clean.
  await assetWritesSettled(paths);
  const plan = changes.map((c, i) => {
    const now = editorNow(c.source);
    const file = fileRecord(now) ?? reads[i] ?? 'unreadable';
    const doc = clone(c.doc!);
    // A document read from a file that carried no id keeps the one the manifest gave it: Save would otherwise mint a new
    // one and unlink every instance (#1264's rule, as the forward write's).
    if (!doc.id && isGuid(c.source)) doc.id = c.source;
    return { ...c, doc, from: expectedDocOf(c.expected), now, file, guid: doc.id ?? (isGuid(c.source) ? c.source : undefined) };
  });
  for (const p of plan) {
    const name = prefabLabel(p.now.path, p.from);
    // 3. The precondition, asked of MEMORY: the editor holds another document than the step left — a prefab-edit save,
    // a later write that is not on this stack, or an outside change the watcher brought in. The step restores what IT
    // changed; putting its side back over somebody else's would lose that change at the next Save.
    // With nothing held (a cold cache: an unused prefab's keys stay cold), the file as read stands in (close-out review):
    // parked over a file somebody changed since, Save's precondition would meet the file it was parked over and write
    // without asking.
    const holder = p.now.editor ?? fileDocOf(p.file) ?? undefined;
    if (holder && p.from && !prefabTextIsDocument(jsonFileBody(holder), p.from)) {
      return refuse(`${name.long} changed since this step (a prefab-edit save, another write, or an outside change), so it was left as it is.`, `${name.short} changed since, and was left as it is`);
    }
    // 4. The file is gone — an Assets trash since the step, which cannot be undone. Restored, the park brought the
    // trashed prefab back at the next Save, behind a "changed on disk" prompt that was false (#1877 L2). A read that
    // failed is not a delete: an unreachable backend refuses nothing here.
    if (p.file === 'absent') {
      return refuse(`${name.long} was deleted since this step, so it was left deleted.`, `${name.short} was deleted since, and was left deleted`);
    }
  }
  // 5. I16 (#1877 L1): B's prefab edit placed an A after an Apply took B out of A, and the undo put B back. The write
  // door asks this of every write; a park passes no door until Save, which then refused for good.
  const cyclic = selfContaining(plan, () => false);
  if (cyclic) {
    const name = prefabLabel(cyclic.w.now.path, cyclic.w.doc);
    return refuse(`${name.long} would contain itself once restored (a prefab it nests now contains it), so it was left as it is.`, `${name.short} would contain itself, and was left as it is`);
  }
  const sources = new Set<string>();
  for (const p of plan) {
    const { path } = p.now;
    const fileDoc = fileDocOf(p.file);
    // What the file holds, for the park's baseline: the park's own record when one is there (a re-park keeps it), else
    // the file as `documentNow` knows it, else the side the step left.
    const onDisk = p.now.park?.onDisk ?? fileDoc ?? (p.now.editor ? clone(p.now.editor) : p.from);
    // 6. The mark never goes down (I4, #1774): the restored document is OLDER than the one the step left, and a row the
    // step added took a number at or above the old mark. Every reader of the park mints from it (Create Prefab's
    // Replace, the model re-import, the rigged regenerate, the agent's create, prefab edit), and with the old mark a new
    // row reused the undone row's number (#1872 close-out review; #1877 S1 when a Save since wrote a higher one). Stated
    // only when it is higher than the document's own counter: a step that added no row leaves the document as it was.
    const mark = Math.max(counterOf(p.now.editor), counterOf(fileDoc), counterOf(p.from), counterOf(onDisk), recordedMark(p.guid ?? path));
    if (mark > localIdCounter(p.doc as CountedDoc)) stateRaisedMark(p.doc, mark);
    recordMark(p.guid ?? path, localIdCounter(p.doc as CountedDoc));
    // 7. Land.
    seatCaches(path, p.source, p.doc.id, p.doc);
    // Not dropped when the file changed under the park (the watcher kept it): `onDisk` no longer says what the file holds,
    // so the park stays for Save, whose precondition meets the change and asks (close-out review F2).
    if (prefabTextIsDocument(jsonFileBody(onDisk), p.doc) && !p.now.park?.fileChanged) discardDirtyAssets([path]);
    else parkPrefab(path, p.doc, onDisk);
    sources.add(p.source); sources.add(path);
    if (p.doc.id) sources.add(p.doc.id);
  }
  // 8. The tail.
  for (const p of plan) await preloadNestedPrefabs(p.doc);
  await opts.rebuild?.({ paths });
  if (opts.rebase !== false) await rebaseStaleInstances({ sources });
  return { ok: true, paths };
}

/** The `'file'` landing of {@link commitPrefabChanges}. All-or-nothing, as far as a filesystem allows: every file is read
 *  and compared with its `expected` (absent, the same bytes, or the same document) before any is written — one mismatch
 *  refuses the whole step, writing nothing; each is then written with `ifMatch` on exactly the bytes that read saw (or
 *  `createOnly`), so the route still refuses one that changed in between; and a later file refused anyway puts back the
 *  ones already written, each conditional on what this step wrote there, naming any it cannot in `stranded`. */
async function landFiles(
  changes: readonly PrefabChange[],
  opts: { overwrite?: boolean; rebuild?: (landed: { paths: string[] }) => void | Promise<void>; rebase?: boolean },
  worldLeft: () => boolean,
  world: ReturnType<typeof getCurrentWorld>,
  holdWrites: (release: () => void) => void,
): Promise<PrefabChangesResult> {
  // `overwrite` skips every precondition, so a multi-file rollback would have nothing true to put back (the caller's
  // `expected` is exactly what an overwrite ignores): one file only — the prefab-edit save's Overwrite.
  if (opts.overwrite && changes.length > 1) {
    return { ok: false, paths: changes.map((w) => prefabPathOf(w.source)), error: 'an overwrite writes one file at a time' };
  }
  const plan = changes.map((w) => {
    const now = editorNow(w.source);
    if (w.doc && !w.doc.id) w.doc.id = newGuid();
    const guid = w.doc?.id ?? (isGuid(w.source) ? w.source : getGuidForPath(now.path) ?? idIn(w.expected));
    // A parked prefab (#1868): every read takes the park, so a writer that read it names a document the file does not
    // hold. Checked against what the file holds instead, and the park retires once this lands. An `expected` that is
    // NOT the park is checked against the file as it is — a writer that read something else conflicts, as it should.
    const readPark = !!now.park && expectsDocument(w.expected, now.park.doc as PrefabFile);
    return { ...w, asked: now.path, guid, now, ...(readPark ? { expected: now.park!.onDisk as PrefabExpectation } : {}) };
  });
  const paths0 = plan.map((x) => x.asked);
  // Every path is a write in flight until this step ends, so a park of one of these prefabs waits for it rather than
  // parking against a file this write is about to change (#1868 close-out re-review).
  holdWrites(beginAssetWrites(paths0));
  // Counted from here, before the read: an outside change held once this step has started does not count as written over.
  const startedAt = paths0.map(prefabWriteStarting);
  // 2–4. What each file holds, read now, and every precondition before any write.
  const exact: Array<{ ifMatch?: string; createOnly?: boolean; prior: string | null; fileDoc: PrefabFile | null; read?: boolean }> = [];
  for (const w of plan) {
    const pre = await precheck(w.asked, w.expected, { overwrite: opts.overwrite, single: plan.length === 1, writesDocument: !!w.doc });
    if ('refused' in pre) return { ok: false, paths: paths0, failed: w.asked, ...(pre.refused === 'conflict' ? { conflict: true } : { error: pre.refused }) };
    exact.push(pre);
  }
  // 5. I16 at the ONE door every editor prefab write passes (#1817): no document is written that contains itself, whoever
  // built it — a prefab-edit save, Create Prefab's Replace, Apply's plan (which checks only the nodes it promotes), the
  // agent's create. Exempt only a TRUE no-op (#1880 W3): `bytes` the file holds already, as just read — a verbatim
  // restore of what is there writes no new shape. Recorded bytes were exempt whatever the file held, so Create Prefab's
  // redo wrote a document back into a nesting that had become a cycle since (a prefab it nests had placed it meanwhile).
  const cyclic = selfContaining(plan, (w) => {
    const pre = exact[plan.indexOf(w)]!;
    return w.bytes !== undefined && !!pre.read && pre.prior !== null && pre.prior.replace(/^\uFEFF/, '') === w.bytes.replace(/^\uFEFF/, '');
  });
  if (cyclic) {
    console.error(`[Prefab] refusing to save — nesting "${cyclic.ref}" inside "${cyclic.w.guid}" creates a cycle`);
    return { ok: false, paths: paths0, failed: cyclic.w.asked, error: `"${cyclic.w.doc!.name ?? cyclic.w.asked}" would contain itself (a prefab cannot contain itself), so nothing was written` };
  }
  // 7. The writes, undone in reverse on a mid-way miss.
  const done: Array<{ path: string; wrote: string | null; prior: string | null }> = [];
  for (const [i, w] of plan.entries()) {
    const pre = exact[i]!;
    // 6. The mark: never below the document's, the editor's (its park included — #1880: the commit read only the file),
    // the file's, what the caller read, or this session's record of it.
    const need = Math.max(counterOf(w.now.editor), counterOf(w.now.park?.doc), counterOf(pre.fileDoc), counterOf(expectedDocOf(w.expected)), recordedMark(w.guid ?? w.asked));
    const content = w.doc ? contentFor(w.doc, w.bytes, need) : null;
    const landed: Landed = w.doc
      ? await post(w.asked, content!, pre.createOnly ? { createOnly: true } : pre.ifMatch !== undefined ? { ifMatch: pre.ifMatch } : {}, w.doc.name)
        .then((r): Landed => (r.ok ? { ...r, content: content! } : r))
      : await trashDoc(w.asked, w.expected, pre);
    if (!landed.ok) {
      const stranded = await rollBack(done);
      return { ok: false, paths: paths0, failed: w.asked, ...('conflict' in landed && landed.conflict ? { conflict: true } : {}),
        ...('error' in landed && landed.error ? { error: landed.error } : {}),
        ...('options' in landed && landed.options?.length ? { options: landed.options } : {}), ...(stranded.length ? { stranded } : {}) };
    }
    const path = landed.path ?? w.asked;
    done.push({ path, wrote: 'content' in landed ? landed.content ?? null : null, prior: pre.prior });
    if (w.doc) recordMark(w.guid ?? path, localIdCounter(w.doc as CountedDoc));
  }
  const paths = done.map((d) => d.path);
  // Every file now holds this step's write, so an outside change held before it started is gone from disk: its release
  // applies nothing (#1889). Only once the whole step has landed — a refusal above rolls the files already written back,
  // which may put that very change back.
  for (const [i, w] of plan.entries()) prefabWriteLanded(w.asked, startedAt[i]!);
  // Whatever it was checked against, a landed write replaces a park at its path (close-out review F3).
  for (const w of plan) w.now.park?.landed();
  // 8. Both caches for every file, one rebuild, one rebase.
  for (const [i, w] of plan.entries()) seatCaches(paths[i]!, w.source, w.guid, w.doc);
  for (const w of plan) if (w.doc) await preloadNestedPrefabs(w.doc);
  if (worldLeft()) return { ok: true, paths, worldLeft: true };
  await opts.rebuild?.({ paths });
  if (!plan.some((w) => w.doc) || opts.rebase === false || getCurrentWorld() !== world) return { ok: true, paths };
  const sources = new Set<string>();
  for (const [i, w] of plan.entries()) if (w.doc) { sources.add(w.source); sources.add(paths[i]!); if (w.guid) sources.add(w.guid); }
  const rebased = await rebaseStaleInstances({ sources });
  // A write can break a cycle an outside change was refused for (a prefab-edit save or an Apply that takes X out of H):
  // that file is taken again now, rebased in the world this write rebased (close-out re-review).
  // Not the files this write landed (close-out re-review): re-read, they would be noted as changed — refusing a read of
  // them in flight for this step's own write — and seated twice. Guarded: the write has landed whatever the retry does.
  if (cyclicAdopts.size && getCurrentWorld() === world) {
    try {
      await retryClosedCycles(sources, paths, {});
    } catch (e) {
      console.error('[Prefab] a prefab refused as a cycle could not be taken again after this write:', e);
    }
  }
  return { ok: true, paths, rebased };
}

/** Is `path` what `expected` says, read now? The exact precondition for its write when so, the bytes it read, and the
 *  document they hold. An `overwrite` asks nothing of what is there, but still reads it: its mark is kept.
 *
 *  A read that FAILED (not a 404: the route or the network) is not a delete. With several files it refuses — every
 *  precondition must hold before any write. With one, the write is conditional on what the caller read instead, as it
 *  was before every write read its file (#1880 W): the route's own `ifMatch`/`createOnly` is then the whole check, and
 *  the file's mark is the one term the step goes without. */
async function precheck(path: string, expected: PrefabExpectation, opts: { overwrite?: boolean; single: boolean; writesDocument: boolean }): Promise<{ ifMatch?: string; createOnly?: boolean; prior: string | null; fileDoc: PrefabFile | null; read?: boolean } | { refused: string }> {
  const { overwrite } = opts;
  const state = await readState(path);
  if (state === 'unreadable') {
    if (!opts.single) return { refused: `${path} could not be read to check it before writing` };
    if (overwrite) return { prior: null, fileDoc: null };
    if (expected === null) return { createOnly: true, prior: null, fileDoc: null };
    const prior = typeof expected === 'string' ? expected : jsonFileBody(expected);
    const ifMatch = await hashOf(prior);
    return typeof ifMatch === 'string' ? { ifMatch, prior, fileDoc: null } : { refused: ifMatch.ok ? 'hash' : (ifMatch.error ?? 'hash') };
  }
  const fileDoc = state === 'absent' ? null : parsedOrNull(state.text);
  // 4. An Overwrite answers "the file changed", never "the file is gone" (#1880 W6): written back, a prefab trashed since
  // came back from a park or an open edit — the undo's L2 by another door. Unity brings no deleted asset back either.
  if (overwrite && state === 'absent' && opts.writesDocument) return { refused: `${path} was deleted since, so it was not written back — an Overwrite replaces a changed file, not a deleted one` };
  if (overwrite) return { prior: state === 'absent' ? null : state.text, fileDoc, read: true };
  if (expected === null) return state === 'absent' ? { createOnly: true, prior: null, fileDoc, read: true } : { refused: 'conflict' };
  if (state === 'absent') return { refused: 'conflict' };
  const expectedDoc = typeof expected === 'string' ? parsedOrNull(expected) : expected;
  const same = (typeof expected === 'string'
    ? state.text.replace(/^\uFEFF/, '') === expected.replace(/^\uFEFF/, '')
    : state.text.replace(/^\uFEFF/, '') === jsonFileBody(expected)) || (!!expectedDoc && sameDocument(state.text, expectedDoc));
  if (!same) return { refused: 'conflict' };
  const ifMatch = await hashBytes(state.bytes);
  return typeof ifMatch === 'string' ? { ifMatch, prior: state.text, fileDoc, read: true } : { refused: ifMatch.ok ? 'hash' : (ifMatch.error ?? 'hash') };
}

/** Put back, newest first, what a failed multi-file commit already wrote — each only over what the commit wrote there.
 *  Returns the paths it could not. */
async function rollBack(done: Array<{ path: string; wrote: string | null; prior: string | null }>): Promise<string[]> {
  const stranded: string[] = [];
  for (const d of [...done].reverse()) {
    const expected = d.wrote;
    // The prior bytes, with the mark this commit wrote kept (#1774): the route refuses a write that lowers it.
    const priorDoc = d.prior === null ? null : parsedOrNull(d.prior);
    const prior = d.prior === null || !priorDoc ? d.prior : contentFor(priorDoc, d.prior, counterOf(parsedOrNull(d.wrote)));
    const back = prior === null
      ? await trashDoc(d.path, expected, undefined)
      : await post(d.path, prior, expected === null ? { createOnly: true } : { ifMatch: await hashOrEmpty(expected) }, 'rollback');
    if (!back.ok) stranded.push(d.path);
  }
  if (stranded.length) console.error(`[Prefab] a multi-file write failed part-way; these files keep the new content and could not be put back: ${stranded.join(', ')}`);
  return stranded;
}
async function hashOrEmpty(text: string): Promise<string> {
  const h = await hashOf(text);
  return typeof h === 'string' ? h : '';
}

/** Both caches, under every key they are read by: the editor cache by the guid, the path and the ref the caller
 *  used (a live instance carries whichever it was spawned with); the runtime cache by the resolved path, which is
 *  how it keys every ref. A trash evicts them all.
 *
 *  ⚠️ EVERY key, the prefab open in prefab edit included (close-out review, #1692). A first version skipped that one
 *  entry so the edit's save kept diffing against what it opened — and the rebase that follows, which rebuilds every
 *  frame against the cache, then put the live instances an Apply had just refreshed back onto the OLD document. The
 *  edit session keeps its own baseline instead (`prefabEdit.ts` `editBaselineFor`).
 *
 *  ⚠️ **The step's own seat — every landing's (#1880 W) — and deliberately THIS function for a park, not the watcher's
 *  eviction.** An undo that restores a prefab writes no file, so no watcher event runs, and it seats the caches from the
 *  document it restores. Exported for a test that queues a commit's seat; no production file outside the step calls it
 *  (`prefabStepCensus.test.ts`). The watcher's runtime half is `invalidatePrefab`, an EVICTION, which is #1308's blank: a
 *  synchronous reader (a pooled scroll view) of a prefab the open scene owns reads `undefined` until the next scene load.
 *  Do not "align" that caller with the watcher by switching it to `invalidatePrefab`. */
export function seatCaches(path: string, source: string, guid: string | undefined, doc: PrefabFile | null, except?: string): void {
  if (doc?.id) registerAsset(doc.id, path, 'prefab');
  // `except`: the editor key an adopt leaves alone — the prefab open in prefab edit (see `landAdopts`). Never a write's.
  for (const key of new Set([source, path, ...(guid ? [guid] : [])])) if (key !== except) seatEditorPrefabCache(key, doc);
  // REPLACE, not evict (#1308): an eviction strands every synchronous runtime reader (a pooled scroll view, a timeline
  // spawn) until the next scene load. A trash evicts. Its own try: the bytes are on disk, and a cache fault must not
  // read as a failed write.
  try {
    if (doc) replaceCachedPrefab(path, doc);
    else { invalidatePrefab(path); if (guid) invalidatePrefab(guid); }
  } catch (e) {
    console.error(`[Prefab] wrote ${path}, but the runtime cache update failed:`, e);
  }
}

/** `path`: the route's own spelling of the file it wrote, when it names one — a create inside a folder typed in another
 *  case lands in the folder that exists (#1273), and the caches and the manifest must key on THAT. `content`: the bytes a
 *  document write put down, which the high-water mark can make differ from the caller's (`contentFor`). */
type Landed = { ok: true; path?: string; content?: string } | { ok: false; conflict?: boolean; error?: string; options?: string[] };

/** The bytes a write of `doc` puts down, with its localId high-water mark (#1774, `localIdCounter.ts`) at least `need` —
 *  the step's mark (`commitPrefabChanges` stage 6: the editor's, the file's, what the caller read, the session's record).
 *  So no write LOWERS the mark, whichever writer made it: a writer may state the mark
 *  itself, and this is the line under it. Mutates `doc`, so the caches and the caller's own record hold the mark written.
 *
 *  It is also the ONE owner of "a document that claims v8 states its mark" (#1797, `markUnstated`): a writer that stamps
 *  the version on a clone of a file that had no mark (Apply's enclosing document did) gets it stated here, from its
 *  rows, so no writer can do half of it. A document that does not claim v8 is left without one, as below.
 *
 *  A write that lowers nothing, and states its mark if it claims v8, is left exactly as built. `bytes` (an undo putting a file back verbatim, #1679) are kept
 *  verbatim unless they would lower the mark — undoing a
 *  write that minted a number must not free that number for the next write, or it derives the guid the undone node had
 *  (Apply adds C at 4, Cmd+Z, the next Apply adds D at 4). Then the bytes are written with the mark raised and a format
 *  version that claims it, spliced in so every other byte stays (`withTopLevelNumbers`); re-serialized only when the
 *  splice cannot be shown exact. */
function contentFor(doc: PrefabFile, bytes: string | undefined, need: number): string {
  // Nothing to raise and nothing unstated: the document goes down exactly as the caller built it, and a restore of a
  // file from before v8 stays without a mark (it derives the same one from its rows).
  // Judged on what is WRITTEN: with `bytes`, the bytes — not `doc`, which an earlier call may already have raised (a redo
  // hands the same document and the same recorded bytes every time; judged on the raised document, the lower bytes went
  // out and were refused for good, close-out re-review).
  const written = bytes === undefined ? doc : parsedOrNull(bytes) ?? doc;
  // …nor a STALE one (#1880, seed 1099): a mark stated at or below the document's own highest row — an outside edit added
  // a row without raising it. The counter still derives past the row, but the file broke v8's contract ("the mark is
  // above every row"), and the validator's promise that the next write corrects it was false.
  const stated = (written as { nextLocalId?: unknown }).nextLocalId;
  // What the WRITTEN document holds, not the counter: a number a loaded record reserves (#1933 S5) is in no file yet, and
  // read through the counter a write would look as if it already stated it, and go down without it.
  const holds = storedLocalIdCounter(written);
  // …and the reservation itself is a source of the mark: a create that restores a trashed file (its undo) has no file,
  // editor copy or park to name it, so only the document's own counter does.
  need = Math.max(need, localIdCounter(written as CountedDoc));
  const stale = typeof stated === 'number' && stated < holds;
  if (need <= holds && !markUnstated(written) && !stale) return bytes ?? jsonFileBody(doc);
  const claims = !(written.version >= LOCAL_ID_MARK_VERSION);
  stateRaisedMark(doc, need);
  if (bytes === undefined) return jsonFileBody(doc);
  return withTopLevelNumbers(bytes, { nextLocalId: doc.nextLocalId!, ...(claims ? { version: doc.version } : {}) }) ?? jsonFileBody(doc);
}

/** Raise `doc`'s localId mark to at least `need` and state it as a write does (#1774): the field, placed after the root
 *  when it was absent, and the version the field arrived in. A raised mark is v8 data, so the document claims v8 (an
 *  older build then refuses to save over it and drop the mark) — v8, not today's format: a later bump must not be
 *  claimed by a document that carries nothing of it (close-out review of #1797). The commit's writes and an in-memory
 *  restore's park both state it here (#1872 close-out review), so Save writes a park as the commit would have. */
export function stateRaisedMark(doc: PrefabFile, need: number): void {
  const had = doc.nextLocalId !== undefined;
  advanceLocalIdCounter(doc, need);
  if (!(doc.version >= LOCAL_ID_MARK_VERSION)) doc.version = LOCAL_ID_MARK_VERSION;
  if (!had) placeMarkAfterRoot(doc);
}

/** `bytes` with each of `fields` set as a top-level number and every other byte kept — formatting, key order, a BOM —
 *  so a restore that has to raise the mark changes only the lines that say so. Null when that cannot be shown: bytes
 *  that do not parse, a key spelled more than once in the text, or a result that does not parse to exactly the
 *  document with those fields set (the caller then re-serializes). */
function withTopLevelNumbers(bytes: string, fields: Record<string, number>): string | null {
  const bom = bytes.charCodeAt(0) === 0xfeff ? bytes.slice(0, 1) : '';
  let text = bytes.slice(bom.length);
  let before: unknown;
  try { before = JSON.parse(text); } catch { return null; }
  if (!before || typeof before !== 'object' || Array.isArray(before)) return null;
  const inserts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!(key in (before as object))) { inserts.push(key); continue; }
    if (text.split(`"${key}"`).length !== 2) return null;
    const at = new RegExp(`("${key}"\\s*:\\s*)-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`);
    if (!at.test(text)) return null;
    text = text.replace(at, `$1${value}`);
  }
  if (inserts.length) {
    const open = text.indexOf('{');
    const ws = /^\s*/.exec(text.slice(open + 1))![0];
    const multiline = ws.includes('\n');
    const entries = inserts.map((k) => `"${k}"${multiline ? ': ' : ':'}${fields[k]},${multiline ? ws : ''}`).join('');
    text = `${text.slice(0, open + 1)}${ws}${entries}${text.slice(open + 1 + ws.length)}`;
  }
  try {
    if (canonicalJson(JSON.parse(text)) !== canonicalJson({ ...(before as object), ...fields })) return null;
  } catch { return null; }
  return bom + text;
}

/** Move `nextLocalId` to where the serializer writes it, right after `rootLocalId`, so the bytes of a document it was
 *  newly added to read as the next ordinary save will write them. Key order only; nothing else changes. */
function placeMarkAfterRoot(doc: PrefabFile): void {
  const rec = doc as unknown as Record<string, unknown>;
  const keys = Object.keys(rec);
  const at = keys.indexOf('rootLocalId');
  if (at < 0) return;
  const after = keys.slice(at + 1).filter((k) => k !== 'nextLocalId').map((k) => [k, rec[k]] as const);
  const mark = rec.nextLocalId;
  for (const [k] of after) delete rec[k];
  delete rec.nextLocalId;
  rec.nextLocalId = mark;
  for (const [k, v] of after) rec[k] = v;
}

/** A prior document from its bytes, parsed as every reader parses them; null when there are none or they do not parse. */
function parsedOrNull(text: string | null | undefined): PrefabFile | null {
  if (!text) return null;
  try { return parsePrefabBytes(text); } catch { return null; }
}

async function trashDoc(path: string, expected: PrefabExpectation, pre: { ifMatch?: string; createOnly?: boolean } | undefined): Promise<Landed> {
  if (expected === null) return { ok: true };
  const hash = pre?.ifMatch ?? await hashOf(typeof expected === 'string' ? expected : jsonFileBody(expected));
  if (typeof hash !== 'string') return hash;
  const res = await deleteAssetFiles([path], { ifMatch: { [path]: hash } });
  if (res.conflicts?.length) return { ok: false, conflict: true };
  if (res.ok && res.failed.length === 0) return { ok: true };
  // The route's reason when it gave one (#1824): an agent's refusal names it, not only "could not be trashed".
  return { ok: false, error: `${path} could not be trashed${!res.ok && res.error ? `: ${res.error}` : ''}` };
}

/** `crypto.subtle` exists only in a secure context; nothing has been written when it is missing. */
async function hashOf(text: string): Promise<string | Landed> {
  try { return await sha256OfWritten(text); } catch (e) {
    return { ok: false, error: `its expected contents could not be hashed (${e instanceof Error ? e.message : String(e)})` };
  }
}
async function hashBytes(bytes: Uint8Array): Promise<string | Landed> {
  try { return await sha256OfBytes(bytes); } catch (e) {
    return { ok: false, error: `its contents could not be hashed (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function post(path: string, content: string, pre: { createOnly?: boolean; ifMatch?: string }, name: string | undefined): Promise<Landed> {
  try {
    const r = await readBackendAnswer(await postWriteFile(path, content, undefined, pre));
    if (r.ok) {
      const written = typeof r.body.path === 'string' && r.body.path ? r.body.path : path;
      console.log(`[Prefab] Wrote "${name}" → ${written}`);
      return { ok: true, path: written };
    }
    // READ THE BODY (#1468 close-out review F5): the format gate answers 409 with its reason in `error`, and it is the
    // one thing only the human can act on. `readBackendAnswer` is the one reader (#1811, #1824): it says which 409s are a
    // conflict (if-match, if-none-match, and `prefab-mark-lowered`, #1774 — the fallback re-reads the file and raises
    // from it), and never answers without a reason (#1776: the route's empty 403 reached the agent as a bare ok:false).
    // Not logged here: every caller reports its own failure, once, in its own words (an undo's #308 report, Apply's
    // refusal, the prefab-edit save's warnings) — a second line here doubled each one.
    return { ok: false, ...(r.conflict ? { conflict: true } : { error: r.error, ...(r.options ? { options: r.options } : {}) }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A prefab file's bytes as every reader parses them: a leading BOM dropped, and the zIndex migration
 *  `getPrefabSource` applies (a doc seeded un-migrated poisons override detection). For an undo that restores bytes it
 *  read (`readPriorDocument` keeps the BOM so the restore is verbatim). Throws on bytes that are not JSON. */
export function parsePrefabBytes(text: string): PrefabFile {
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as PrefabFile;
  // Read as every seat reads it (#1937 C-A): admitted FIRST — a keyless template node's key is seeded from the node as the
  // file states it, before the migration rewrites it — then migrated. A document read here (an undo's restore, a park, a
  // precheck's file) is then the same document a cache holds, and compares equal to it. A refused one is read as it is.
  const admitted = admitPrefabDocument(raw);
  const doc = 'doc' in admitted ? admitted.doc : raw;
  for (const entry of doc.entities ?? []) migrateUIAnchorZIndexStructured(entry);
  return doc;
}

/** The `id` of the document `expected` names, for a trash whose path the manifest no longer maps. */
function idIn(expected: PrefabExpectation): string | undefined {
  if (expected === null) return undefined;
  if (typeof expected !== 'string') return expected.id;
  try { const id = (JSON.parse(expected.replace(/^\uFEFF/, '')) as { id?: unknown }).id; return typeof id === 'string' ? id : undefined; } catch { return undefined; }
}

/** What is at `path` now: absent (a 404, or the SPA fallback's HTML), its bytes, or unreadable (any other miss). */
async function readState(path: string): Promise<'absent' | 'unreadable' | { bytes: Uint8Array; text: string }> {
  try {
    const res = await fetch(assetUrl(path), { cache: 'no-store' });
    if (res.status === 404) return 'absent';
    if (!res.ok) return 'unreadable';
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    return isHtmlFallthrough(text.replace(/^\uFEFF/, '')) ? 'absent' : { bytes, text };
  } catch { return 'unreadable'; }
}

/** Does `text` parse to `expected`, the way every prefab reader parses it (`fetchPrefabSource`: the zIndex migration
 *  on every entity)? An id-less file compares with the id the editor minted for it (#1664: Apply mints both sides').
 *  The localId high-water mark and the format version are not compared (#1774, `sameDocumentContent`): this commit owns both where it raises the
 *  mark (`contentFor` stamps a restore with the version that claims it), and only ever raises them, so a file that
 *  differs from what the caller read in those alone holds nobody's change to protect. An undo's redo is the case: it is
 *  conditional on the bytes the undo recorded, which predate the mark the undo's own write had to keep. */
/** Does `text` (a prefab file's bytes) hold `doc` — byte for byte as the editor writes it, or as the same document parsed
 *  the way every reader parses it ({@link sameDocument})? What a record of "the document this file held" is compared by. */
export function prefabTextIsDocument(text: string, doc: PrefabFile): boolean {
  return text.replace(/^\uFEFF/, '') === jsonFileBody(doc) || sameDocument(text, doc);
}

function sameDocument(text: string, expected: PrefabFile): boolean {
  try {
    // Both sides as every seat reads a document (#1937 C-A): the file through `parsePrefabBytes` (admitted, then migrated),
    // and `expected` admitted too — a no-op for one a cache holds, the minted keys for one read raw elsewhere. So a keyless
    // template node's minted key is on both, and an edit opened from the admitted document is not read as a file changed
    // under it (the prefab-edit save refused every keyless prefab before this).
    const parsed = parsePrefabBytes(text) as PrefabFile;
    if (!parsed || !Array.isArray(parsed.entities)) return false;
    const exp = admitPrefabDocument(expected);
    const want = 'doc' in exp ? exp.doc : expected;
    // An id-less file takes the expected one AFTER its admission: the id seeds a mint, and the seat minted without it.
    if (!parsed.id && want.id) parsed.id = want.id;
    return sameDocumentContent(parsed, want); // the one rule (#1892): the mark and the version aside
  } catch { return false; }
}

/** Does `expected` name `doc` — the same object, its bytes, or the same document? */
function expectsDocument(expected: PrefabExpectation, doc: PrefabFile): boolean {
  if (expected === null) return false;
  if (expected === doc) return true;
  return prefabTextIsDocument(typeof expected === 'string' ? expected : jsonFileBody(expected), doc);
}

/** {@link commitPrefabChangesUnmarked}, marking the instance store stale when the step does not maintain the list: it
 *  ran a caller's `rebuild` that does not say it maintains the records (an op S7 has not moved onto records yet, which
 *  rebuilds from the capture), or it threw
 *  part-way (#2001 S4, `instanceStore.ts`). The landing itself changes no record, and its rebase reprojects a tree with a
 *  fresh record from the store and marks only what it rebuilt from the capture (`rebuildStaleFrames`, #2046 S7.3). */
export const commitPrefabChanges: typeof commitPrefabChangesUnmarked = async (changes, opts = {}) => {
  let out: Awaited<ReturnType<typeof commitPrefabChangesUnmarked>>;
  try { out = await commitPrefabChangesUnmarked(changes, opts); } catch (err) { markStale(getCurrentWorld(), 'prefabWrite'); throw err; }
  if (opts.rebuild && !opts.maintainsRecords) markStale(getCurrentWorld(), 'prefabWrite');
  return out;
};
