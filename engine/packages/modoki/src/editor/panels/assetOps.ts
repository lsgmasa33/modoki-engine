/** Framework-free asset operations — the backend-IO helpers and the
 *  prefab-creation flow that the Assets and Hierarchy panels both need.
 *
 *  Before this module these helpers were copy-pasted between
 *  `Assets.tsx` and `Hierarchy.tsx` (editor-panels F6/F7): the thin
 *  `/api/*` wrappers (`writeAssetFile`/`writeFile`, `trashAssetFile`/
 *  `deleteAsset`, …), the "first writable asset root" lookup, and the
 *  "serialize entity subtree → write .prefab.json → tag the live tree as an
 *  instance → push undo" flow (`Hierarchy.handleCreatePrefab` vs the entity
 *  branch of `Assets.handleDrop`, near-identical line-for-line). Two copies
 *  drifted independently (one wrote to `${root}/prefabs/…`, the other to
 *  `${targetFolder}/…`). They now live here so a fix lands in ONE place, and
 *  the logic is unit-testable without rendering a React panel. */

import { whyWorldNotAuthored, notAuthoredExit } from '../scene/authoredWorld';
import { backendFetch, writeAssetFile, writeAssetFileGuarded, jsonFileBody, callBackend, postBackend, type BackendAnswer } from '../backend/editorBackend';
import { warnInertPrefabSizes, type PrefabFile } from '../scene/prefab';
import {
  preloadNestedPrefabsForSubtree, getCachedPrefabSync, primeEditorPrefabCache, classifyExistingDocumentId,
  parkedPrefabRead,
} from '../scene/prefabCache';
import { missingPrefabPlaceholders, unexpandedNestedRefusal, staleFramesInTreeRefusal } from '../scene/prefabFrames';
import { rebaseStaleInstancesSoon } from '../scene/prefabRebuild';
import { serializePrefab, parsedPrefabRows } from '../scene/prefabSerialize';
import {
  tagEntityTreeAsInstance, untagEntityTreeAsInstance, unstampMemberGuids, detachPrefabInstance, reattachPrefabInstance,
  tagCreatedPrefab, type DetachSnapshot,
} from '../scene/prefabLink';
import { partOfInstanceRefusal } from '../scene/restructureRefusal';
import { commitPrefabWrite, parsePrefabBytes, prefabTextIsDocument } from '../scene/prefabCommit';
import { assetWrittenToDisk } from '../scene/dirtyAssets';
import { entityRef, isInstanceRootCheck, type EntityRef } from '../undo/entityRef';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { resolveRef } from '../../runtime/loaders/assetManifest';
import { isGuid } from '../../runtime/core/assetRefRules';
import { reportUndoFailure, fileChangedRefusal, UndoRefusedError } from '../undo/undoFailure';
import { restorePrefabsInMemory } from '../scene/prefabMemoryRestore';
import type { UndoAction } from '../undo/undoManager';
import { dirtyAssetEditorHolds } from '../store/editorStore';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { captureAdoptionGate } from '../scene/adoptionGate';
import { captureEntityIdentity, findEntity } from '../../runtime/core/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { isHtmlFallthrough } from '../../runtime/loaders/assetFetch';
import { firstAssetRoot } from './assetRoots';
import { pastePathIn, splitAssetPath, type AssetEntry } from '../utils/assetPaths';
import { flushPendingMetaFor } from '../scene/pendingMeta';
import { existingAssetPath } from '../scene/createAssetDocument';

// ── Re-import / import planning (pure — unit-testable without IO) ─────

/** Asset types the dev server has a re-import handler for. Seeded with the
 *  built-in texture/model handlers as a fallback, then refreshed from the server
 *  registry via `refreshHandlerTypes()` so a newly-registered server handler
 *  (e.g. audio) surfaces in the menu + recursive re-import without a client edit.
 *  (editor-panels F9 — the client/server-drift seam.) */
export const HANDLER_TYPES = new Set(['texture', 'model']);

/** Fetch the server's registered re-import handler types and overwrite
 *  `HANDLER_TYPES` so client gating matches what the server can actually handle.
 *  Called once on panel mount; falls back to the seeded set on any failure (the
 *  build/no-dev-server case has no endpoint). Returns whether the set changed. */
export async function refreshHandlerTypes(): Promise<void> {
  try {
    const res = await backendFetch('/api/reimport-types');
    if (!res.ok) return;
    const data = (await res.json()) as { types?: unknown };
    if (!Array.isArray(data.types)) return;
    const types = data.types.filter((t): t is string => typeof t === 'string');
    if (types.length === 0) return; // keep the fallback rather than blanking it
    HANDLER_TYPES.clear();
    for (const t of types) HANDLER_TYPES.add(t);
  } catch { /* keep fallback */ }
}

/** Imported files with these extensions get run through the asset pipeline
 *  (texture conversion / model handling) right after they land on disk. */
export const CONVERTIBLE_RE = /\.(png|jpe?g|webp|glb|gltf)$/i;

/** The assets a re-import targets. A single (`recursive=false`) re-import hits
 *  exactly the asset at `target`; a recursive one hits everything under it
 *  (`'/'` = all). Non-handler types (no server handler) are always filtered out
 *  — the "Nothing to re-import" case is an empty result. PURE so the matching
 *  rule (the F9 client/server-drift seam) is testable without rendering. */
export function reimportTargets(
  assets: ReadonlyArray<AssetEntry>,
  target: string,
  recursive: boolean,
): AssetEntry[] {
  const matches = (a: AssetEntry): boolean => {
    if (!recursive) return a.path === target;
    if (target === '/') return true;
    const prefix = target.replace(/\/+$/, '') + '/';
    return a.path.startsWith(prefix);
  };
  return assets.filter((a) => matches(a) && HANDLER_TYPES.has(a.type));
}

/** Plan an OS-file import into `targetFolder`: assign each file a collision-free
 *  destination path (" copy" suffix, never overwrite) and flag whether it should
 *  be run through the conversion pipeline. PURE — the disk write + /api/reimport
 *  dispatch happen in the panel; this is just the naming/dispatch policy so it's
 *  unit-testable. `taken` is the set of already-used paths (mutated as planned
 *  so two same-named files in one batch don't collide). */
export function planImports(
  fileNames: ReadonlyArray<string>,
  targetFolder: string,
  taken: Set<string>,
): { name: string; dest: string; convert: boolean }[] {
  return fileNames.map((name) => {
    const dest = pastePathIn(targetFolder, `/${name}`, taken);
    taken.add(dest);
    return { name, dest, convert: CONVERTIBLE_RE.test(dest) };
  });
}

/** Write one dropped file's bytes to the `dest` {@link planImports} chose — only into an EMPTY path (#1784). `dest` was planned against the panel's in-memory listing, not the
 *  disk, so a file that landed there since (another import, an agent, a `git pull`) was otherwise overwritten with no
 *  word. `'taken'` is that case: the file there is left as it is. A `'failed'` carries the route's reason (#1811). */
export async function writeDroppedImport(dest: string, base64: string): Promise<{ result: 'ok' | 'taken' } | { result: 'failed'; error: string }> {
  const w = await writeAssetFileGuarded(dest, base64, { encoding: 'base64', createOnly: true });
  return w.result === 'conflict' ? { result: 'taken' } : w;
}

// ── Delete / rename policy (pure — the IO lives in the panel) ─────────

// Extensions we know are UTF-8 text, which carry their GUID inline and so have no `.meta.json` sidecar. Everything
// else is a binary with a sidecar pair (`sidecarsFor`).
const TEXT_ASSET_EXTS = ['.json', '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.svg', '.glsl', '.wgsl'];

export function isTextAsset(p: string): boolean {
  const lower = p.toLowerCase();
  return TEXT_ASSET_EXTS.some((ext) => lower.endsWith(ext));
}

/** How many paths the delete confirm names before it says "and N more" — the dialog is a question, not a listing. */
const DELETE_CONFIRM_LISTED = 8;

/** The question every Assets-panel delete asks FIRST, because a delete is not undoable (#1868, owner ruling D2).
 *  Unity asks the same before `ProjectWindowUtil.DeleteAssets`, and its last line is Unity's own wording. The files
 *  still go to the OS Trash, which is where a human gets one back — the dialog says so, since that is the only way.
 *  `paths` are what the gesture names (the selection, or the folder). What it drags along is said too, since none of
 *  it comes back from the editor either: a folder's contents (`folder`), a model's generated meshes, materials and
 *  textures (`generated`, a count), and the unsaved edits parked for anything that goes (`unsaved`), which are
 *  discarded. */
export function deleteConfirmText(
  paths: readonly string[],
  opts: { folder?: boolean; generated?: number; unsaved?: readonly string[] } = {},
): { title: string; message: string; okLabel: string } {
  const many = paths.length !== 1;
  const listed = paths.slice(0, DELETE_CONFIRM_LISTED);
  const more = paths.length - listed.length;
  const list = listed.join('\n') + (more > 0 ? `\n…and ${more} more` : '');
  const goes = opts.folder ? 'The folder and everything inside it go to the Trash.' : `${many ? 'They go' : 'It goes'} to the Trash.`;
  const generated = opts.generated
    ? ` So ${opts.generated === 1 ? 'does 1 file' : `do ${opts.generated} files`} generated on import (meshes, materials, textures).`
    : '';
  const unsaved = opts.unsaved?.length
    ? `\n\nUnsaved edits to ${opts.unsaved.length === 1 ? opts.unsaved[0] : `${opts.unsaved.length} assets (${opts.unsaved.slice(0, 3).join(', ')}${opts.unsaved.length > 3 ? ', …' : ''})`} are discarded.`
    : '';
  return {
    title: opts.folder ? 'Delete selected folder?' : many ? `Delete ${paths.length} selected assets?` : 'Delete selected asset?',
    message: `${list}\n\n${goes}${generated}${unsaved}\n\nYou cannot undo the delete assets action.`,
    okLabel: 'Move to Trash',
  };
}

/** What a delete of `targets` drags along that the confirm must name (#1868): the files it trashes beyond the targets
 *  and their sidecars — a model's generated products — and the unsaved edits parked under anything it trashes. */
export function deletionFootprint(
  targets: readonly string[], trashed: readonly string[], parked: readonly string[], folder?: string,
): { generated: number; unsaved: string[] } {
  const own = new Set(targets);
  const generated = trashed.filter((p) => !own.has(p) && !/\.meta(\.local)?\.json$/.test(p)).length;
  const gone = new Set(trashed);
  const under = (p: string) => gone.has(p) || own.has(p) || (!!folder && (p === folder || p.startsWith(`${folder}/`)));
  return { generated, unsaved: [...new Set(parked)].filter(under) };
}

/** Every path a delete of `assetPath` must remove.
 *
 *  This is the sidecar rule, and it has already been wrong once: the `.meta.json`
 *  of a binary asset used to be snapshotted but never trashed, leaving an
 *  orphaned sidecar on disk after every binary/model delete. Extracted from
 *  `Assets.tsx`'s `collectDeletion` (#105 Phase 3) so the rule is checkable without
 *  standing up fetch + the backend.
 *
 *  - The asset itself always goes first.
 *  - A BINARY asset also drops BOTH sidecar halves: the committed `.meta.json`
 *    (GUID + import settings) and the
 *    gitignored `.meta.local.json` (this machine's byte-stats; see
 *    `engine/plugins/meta-sidecar.ts`). Missing the local half left a file on disk
 *    after every delete, forever — invisible to `git status` because it is
 *    gitignored, and unbounded over time (QA-CTX-0005). Text assets carry their id
 *    inline and have no sidecar.
 *  - A MODEL additionally drops everything it generated (meshes / materials /
 *    textures) and each generated BINARY file's own sidecar.
 *
 *  The backend skips paths that no longer exist, so listing a maybe-absent sidecar
 *  is harmless — which is why this can be a pure list rather than an existence
 *  check per path. */
/** Both halves of a binary asset's sidecar pair: the committed `.meta.json` and
 *  the gitignored machine-local `.meta.local.json`. They are written as a pair by
 *  `writeMetaSidecar`, so anything that moves or removes one must handle both. */
function sidecarsFor(assetPath: string): string[] {
  return [assetPath + '.meta.json', assetPath + '.meta.local.json'];
}

export function deletionPathsFor(
  assetPath: string,
  assetType: string,
  generated?: { meshes?: string[]; materials?: string[]; textures?: string[] } | null,
): string[] {
  const paths: string[] = [assetPath];
  if (!isTextAsset(assetPath)) paths.push(...sidecarsFor(assetPath));
  if (assetType === 'model' && generated) {
    for (const f of [...(generated.meshes ?? []), ...(generated.materials ?? []), ...(generated.textures ?? [])]) {
      paths.push(f);
      if (!isTextAsset(f)) paths.push(...sidecarsFor(f));
    }
  }
  return paths;
}

/** Decide what a rename means, without performing it.
 *
 *  Returns the destination path, or a REASON it is refused — the panel logs and
 *  bails on each. Slashes are replaced rather than rejected so a pasted path
 *  cannot silently relocate the asset out of its folder. */
export type RenamePlan =
  | { ok: true; toPath: string; base: string }
  | { ok: false; reason: 'empty' | 'unchanged' | 'exists'; toPath?: string };

export function planRename(
  assetPath: string,
  newBase: string,
  existingPaths: ReadonlyArray<string>,
): RenamePlan {
  const { dir, base, ext } = splitAssetPath(assetPath);
  const safe = newBase.trim().replace(/[/\\]/g, '_');
  if (!safe) return { ok: false, reason: 'empty' };
  if (safe === base) return { ok: false, reason: 'unchanged' };
  const toPath = `${dir}/${safe}${ext}`;
  if (existingPaths.includes(toPath)) return { ok: false, reason: 'exists', toPath };
  return { ok: true, toPath, base: safe };
}

// ── Backend-IO wrappers (shared by Assets + Hierarchy) ───────────────

/** Write a text or base64-encoded file via /api/write-file. Re-exported from `editorBackend` —
 *  the ONE client write wrapper (#835) — so the many existing `from './assetOps'` importers
 *  (createRegisteredAsset.ts, scene/skinPrefab.ts, Assets.tsx) need no change. */
export { writeAssetFile };

/** Split a completed delete into what ACTUALLY went and what is still on disk (#884) — the
 *  DECISION, in `.ts` so it is testable without mounting the panel (CLAUDE.md § Panels).
 *
 *  Everything the panel does after a delete has to be keyed on `went`, not on what it asked for:
 *  a file the OS refused is still there, so its row must stay listed, its editor must stay bound,
 *  and undo must not offer to restore it. `/api/delete-asset` draws exactly this line for its own
 *  half of the repair; before this the panel undid that care by passing the full requested list to
 *  every step.
 *
 *  ⚠️ `removed` drops an asset whose OWN file went even if a SIDECAR of it was refused. The asset
 *  is gone; keeping its row listed because a `.meta.local.json` survived would be the mirror
 *  defect — a row pointing at nothing. The stray sidecar is named in the report the caller builds
 *  from `failed`, and the next scan reconciles it.
 *
 *  ⚠️ Returns only what a caller USES. An earlier draft also returned `stillOnDisk` (the refused
 *  paths), which nothing read — `Assets.tsx` reports straight off `del.failed` — and the docblock
 *  claimed it was "reported", which was a claim about a field with no consumer. */
export function planDeleteOutcome(
  requested: string[], assetPaths: string[], failed: string[],
): { went: string[]; removed: string[] } {
  const refused = new Set(failed);
  return {
    went: requested.filter((p) => !refused.has(p)),
    removed: assetPaths.filter((p) => !refused.has(p)),
  };
}

/** What to tell the human about a delete the OS refused (#884) — the DECISION, kept out of
 *  `Assets.tsx` so it can be unit-tested (CLAUDE.md: a panel's decisions live in a plain `.ts`
 *  module beside it). Returns `null` when there is nothing to report.
 *
 *  Two levels, matching the policy `undo/undoFailure.ts` already wrote down for #308: a failure
 *  the human CAUSED and can FIX is worth interrupting them for. A locked file, a denied ACL or a
 *  file open in another tool is exactly that — they can close the handle and delete again — so
 *  this earns a toast, not just a console line nobody is looking at.
 *
 *  `toast` is short and names basenames (a full asset url does not fit a toast and the basename is
 *  what the human sees in the panel); `detail` carries the full paths for the console, which is the
 *  only hand-recovery record they get. */
export function describeRefusedDeletes(
  failed: string[],
  opts: { trashed: number },
): { toast: string; detail: string } | null {
  if (failed.length === 0) return null;
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const NAMED = 3;
  const names = failed.slice(0, NAMED).map(base).join(', ')
    + (failed.length > NAMED ? `, +${failed.length - NAMED} more` : '');
  const n = `${failed.length} file${failed.length === 1 ? '' : 's'}`;
  // ⚠️ The denominator is what was really THERE (`trashed` + refused), not what was requested.
  // `deletionPathsFor` deliberately asks for maybe-absent sidecars — `.meta.local.json` is
  // gitignored and usually not on disk — so a requested-count denominator reports "Moved 1 of 3"
  // for one texture whose primary was locked, when only two files ever existed.
  const total = opts.trashed + failed.length;
  // "Moved 3 of 5" only makes sense when something moved; a total refusal says so plainly rather
  // than reporting "moved 0 of 5", which reads as a count that might tick up on a retry.
  //
  // ⚠️ "still on disk", never "still listed". A refused SIDECAR is not listed at all — the asset
  // scanner classifies `.meta.json`/`.meta.local.json` as null (`vite-asset-scanner.ts`), so they
  // have no row to stay in — and its asset's row is gone either way, since `planDeleteOutcome`
  // removes a row whose own file went. On-disk is the claim that is true for both.
  const toast = opts.trashed > 0
    ? `Moved ${opts.trashed} of ${total} to the Trash — ${names} could not be moved and ${failed.length === 1 ? 'is' : 'are'} still on disk`
    : `Could not move ${n} to the Trash — ${names} ${failed.length === 1 ? 'is' : 'are'} still on disk`;
  return { toast, detail: failed.join(', ') };
}

/** What a single-path asset op answers (#1824): it happened, or the route refused it — with the route's reason
 *  (`error`, never empty), its §5 `code` when it named one, and the HTTP `status` (0 when the request never got an
 *  answer). `status` stays because a caller may branch on it: `/api/move-file`'s 409 is a collision the human caused
 *  and can fix, which an undo reports differently (#308).
 *
 *  ⚠️ This replaced BOOLEAN wrappers, and an object is always truthy — so each one was RENAMED (`deleteAssetFile` →
 *  `trashAssetFile`, `createFolderApi` → `createAssetFolder`, `moveFileTo`/`moveFileToStatus` → `moveAsset`), which
 *  makes every old call site stop compiling instead of silently reading every refusal as a success. */
export type AssetOpResult = { ok: true } | { ok: false; error: string; status: number; code?: string };

/** An answer as an `AssetOpResult`. */
function assetOpResult(a: BackendAnswer): AssetOpResult {
  return a.ok ? { ok: true } : { ok: false, error: a.error, status: a.status, ...(a.code ? { code: a.code } : {}) };
}

/** Trash ONE asset via /api/delete-asset.
 *
 *  ⚠️ **The verdict is the OUTCOME, not the HTTP status** (#884): a path the OS refused answers **HTTP 200**
 *  `{ok:false}`. `readBackendAnswer` reads that as the refusal it is, and an unparseable 2xx as a success (the trash
 *  already happened). With ONE path there is no partial outcome to describe — it went or it did not, and why. */
export async function trashAssetFile(assetPath: string): Promise<AssetOpResult> {
  return assetOpResult(await postBackend('/api/delete-asset', { path: assetPath, rendererWrite: true }));
}

/** What a batch trash actually did. `missing` are the paths that were not on
 *  disk, so nothing was trashed for them — the caller MUST NOT treat those as
 *  recoverable files. `deletionPathsFor` deliberately lists maybe-absent
 *  sidecars (`.meta.local.json` is gitignored and usually not there), so
 *  "asked to trash" and "trashed" routinely differ and only the backend knows
 *  by how much. Discarding that distinction is what let an undo failure name
 *  files that never existed (#291). */
export type DeleteFilesResult = {
  ok: boolean;
  trashed: number;
  missing: string[];
  /** Paths the OS REFUSED to trash — a locked file, a denied ACL, a >260-char path — reported in
   *  the same strings the caller passed in, so they can be compared directly against the request
   *  (#884). These files are STILL ON DISK: a caller must not drop their rows, must not unbind an
   *  editor from them, and must not offer to "restore" them.
   *
   *  ⚠️ Non-empty with `ok:true` means a PARTIAL delete — the rest of the batch did go. `ok:false`
   *  with a non-empty `failed` means NONE of it went. Both are worth reporting to the human, so
   *  read `failed` before branching on `ok`, not after.
   *
   *  ⚠️ **NOT win32-only since #1006, and populated on darwin since #1212 A-8.** Finder names no
   *  path when it refuses, so the backend reports whatever is still on disk (Finder's delete is
   *  all-or-nothing, so that is the whole batch). On Linux a failing `trash-put` is not reported:
   *  the backend falls back to a PERMANENT `rmSync`, so `failed` empty with `ok:true` can mean
   *  "deleted, not trashed" — check `ok` for whether the paths are gone. That fallback (also used
   *  when `trash-put` is absent — CI, headless) reports per path, naming any whose subtree is not
   *  self-contained (#883); those files are still on disk, so the rule above applies in full. */
  failed: string[];
  /** Paths whose precondition (`opts.ifMatch`) failed — present only on that refusal, which trashes
   *  NOTHING: `ok:false`, every path still where it was (#1679). */
  conflicts?: string[];
  /** The route's reason, on `ok:false` (#1824) — what an undo's report names, instead of only "not trashed". */
  error?: string;
  /** The route's §5 code, on `ok:false`, when it named one. */
  code?: string;
};

/** Trash MANY paths in a single request → ONE OS-trash invocation → one trash
 *  sound (vs. one chime per file when each path was its own POST). The backend
 *  skips any path that no longer exists, so a list carrying maybe-absent
 *  sidecars is safe — and it REPORTS those in `missing`, which is the only way
 *  a caller can tell an absent sidecar from a file it failed to save. */
export async function deleteAssetFiles(
  paths: string[],
  /** The precondition the ROUTE checks atomically with the trash (#1679): `ifMatch` maps a path to the sha256 of the
   *  bytes it must still hold — a prefab commit's rollback trashing a file it created. One failure trashes NOTHING and
   *  comes back as `conflicts`. Keys must be members of `paths`. */
  opts?: { ifMatch?: Record<string, string> },
): Promise<DeleteFilesResult> {
  if (paths.length === 0) return { ok: true, trashed: 0, missing: [], failed: [] };
  // `rendererWrite` (here and in `trashAssetFile`): every caller is the editor's own flow — the
  // Assets panel, undo/redo, the model-import prune — i.e. the human deleting on purpose. The
  // route's unsaved-work gate is for the AGENT path, which cannot see the human's edit (#1215).
  const a = await postBackend('/api/delete-asset', {
    paths, rendererWrite: true,
    ...(opts?.ifMatch && Object.keys(opts.ifMatch).length ? { ifMatch: opts.ifMatch } : {}),
  });
  const body = (a.body ?? {}) as { trashed?: unknown; missing?: unknown; failed?: unknown; conflicts?: unknown };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  if (!a.ok) {
    const refused = { ok: false as const, trashed: typeof body.trashed === 'number' ? body.trashed : 0, missing: strings(body.missing),
      failed: strings(body.failed), error: a.error, ...(a.code ? { code: a.code } : {}) };
    if (a.status === 409 && a.reason === 'if-match') {
      const conflicts = strings(body.conflicts);
      // Never an empty list on a refusal — a caller branches on `conflicts?.length`, and an unparseable list must
      // still read as "refused", or a trash that did not happen would look like one that did.
      return { ...refused, trashed: 0, conflicts: conflicts.length ? conflicts : [...paths] };
    }
    return refused;
  }
  // A body we cannot parse is not a failed delete — the trash already happened. Fall back to "everything we asked
  // for was trashed", which is what the old boolean return assumed for every call.
  //
  // ⚠️ That optimism is deliberate and must NOT be flipped to pessimistic now that `failed` exists: an unparseable
  // body says nothing about which paths went, and guessing "all of them failed" would make a working delete report
  // phantom survivors on every unreadable reply. The body's own `ok:false` is read by the reader (#884, #1824).
  return {
    ok: true,
    trashed: typeof body.trashed === 'number' ? body.trashed : paths.length,
    missing: strings(body.missing),
    failed: strings(body.failed),
  };
}

/** What a document path holds before a step replaces it, for that step's undo to put back (#1679, #1264's shape):
 *  the bytes of a JSON object document; `undefined` when nothing is there (a 404, or the dev server's SPA fallback
 *  answering 200 with HTML for a missing path); `null` when something is there that is not a readable document — a
 *  failed read, or a corrupt one, which is `parseAssetJson`'s rule too: a corrupt file is never an absent one. The
 *  caller's undo then reports and leaves the file rather than trashing it as though it had created it. Decided by the
 *  FILE, not the manifest — a manifest-known id can outlive its file, and an id-less file is there all the same.
 *
 *  The bytes KEEP a leading UTF-8 BOM (#1684's note on #1692): an undo writes them back verbatim, and `Response.text()`
 *  strips it, so a restore silently re-encoded the file. Parse them with `parsePrefabBytes` (prefabCommit.ts), which
 *  drops it the way every reader does; the route's `ifMatch` hash strips it too (`sha256OfBytes`). */
export async function readPriorDocument(path: string): Promise<string | null | undefined> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (res.status === 404) return undefined;
    if (!res.ok) return null;
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    if (isHtmlFallthrough(text.replace(/^\uFEFF/, ''))) return undefined;
    try {
      const d: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      return d && typeof d === 'object' && !Array.isArray(d) ? text : null;
    } catch { return null; }
  } catch { return null; }
}

/** Copy an asset to a new path; the backend regenerates the GUID so the
 *  duplicate doesn't collide with the original in the manifest.
 *
 *  ⚠️ **Flushes a parked import-settings edit for the SOURCE first** (#882). `duplicateAssetFile`
 *  in the backend seeds the copy's `.meta.json` from the source's file, so without this the
 *  duplicate is born with the PRE-EDIT settings while the panel shows the newer ones — and since
 *  the route now refuses on a park, without it the panel's Duplicate would simply fail, returning
 *  `false` with the reason discarded and nothing shown to the human.
 *
 *  Flushing rather than forcing, and rather than refusing, is the same call
 *  `assetViews/reimport.ts` already makes: the human clicked Duplicate on this asset, and that
 *  click is consent to persist their own edit — which an AGENT does not have, which is why the
 *  agent path keeps the refusal and `force`. */
export async function duplicateAssetFile(from: string, to: string): Promise<AssetOpResult> {
  const r = await duplicateAssetFileReport(from, to);
  return r.ok ? { ok: true } : r;
}

/** `duplicateAssetFile`, with the route's reason on a refusal (#1824) — it used to go to the console only, and the
 *  caller got a bare `{ok:false}`. (The copy's hash and sidecar the route once reported were for the duplicate's undo,
 *  which went in #1868.) */
export async function duplicateAssetFileReport(from: string, to: string): Promise<
  { ok: true } | { ok: false; error: string; status: number; code?: string }
> {
  try { await flushPendingMetaFor(from); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), status: 0 }; }
  const a = await postBackend('/api/duplicate-asset', { from, to });
  if (!a.ok) return { ok: false, error: a.error, status: a.status, ...(a.code ? { code: a.code } : {}) };
  return { ok: true };
}

/** Create a (possibly empty) folder on disk under the asset roots. */
export async function createAssetFolder(folderPath: string): Promise<AssetOpResult> {
  return assetOpResult(await postBackend('/api/create-folder', { path: folderPath }));
}

/** Move/rename a file or folder to an explicit destination path (the backend also moves the asset's `.meta.json`
 *  sidecar). The caller controls the full target path, not just the destination folder.
 *
 *  `/api/move-file` never clobbers: it answers **409 "Destination exists"** when something already occupies the
 *  destination, 423 when an editor holds unsaved edits on the file (#1362), and 403/404/5xx otherwise. `status`
 *  distinguishes the COLLISION an undo/redo reports as user-caused (#308); `error` is the route's reason for any of
 *  them (#1824 — this used to keep only `{ok, status}` and throw the reason away). */
export async function moveAsset(from: string, to: string): Promise<AssetOpResult> {
  return assetOpResult(await postBackend('/api/move-file', { from, to }));
}

/** The texture editor holding unsaved edits on any of `froms` (or on something under one, for a
 *  folder move), as a ready-to-show message — or `null` when nothing is held.
 *
 *  ⚠️ NOT the guard. `/api/move-file` refuses the move itself (#1362), and it has to: the agent
 *  route never comes through this panel. It was written when the move wrapper threw the route's reason
 *  away; `moveAsset` now carries it (#1824), and this stays as the panel's pre-flight — it names the
 *  editor holding the file before any request is made. Same fact, one source — `dirtyAssetEditorHolds()`. */
export function assetEditorHoldMessage(froms: readonly string[]): string | null {
  // ⚠️ EXACT comparison, deliberately — do NOT fold case here, and do not "align" it with the
  // backend's matcher, which does.
  //
  // The two differ because they compare different things. This one compares two values from ONE
  // source: every `from` the panel passes comes from `asset.path` / `node.path` /
  // `clipboard.paths`, the same manifest values the mount's `path` is set from, so they cannot
  // differ in spelling. `assetEditorBindings.ts`'s header states that premise for this whole
  // subsystem and its consequence in as many words: "there is no normalization to get wrong; if
  // that ever stops being true this needs a shared canonicalizer, NOT a looser match here."
  // `heldAssetEditorRefusal` folds case because it compares a FILESYSTEM-derived path
  // (`absToAssetUrl` of the real `from`) against a store path, where two spellings of one file are
  // both legitimate on a case-insensitive volume.
  //
  // ⚠️ Scar: a review flagged the divergence as "the two matchers can disagree" and I closed it by
  // adding `toLowerCase()` here (7294b1921, reverted). That was the looser match the header
  // forbids, and it BROKE the case it was meant to protect: on a case-SENSITIVE volume,
  // `/assets/A.png` held while `/assets/a.png` moves made this panel block a move the backend would
  // have allowed. The disagreement the review described needs a `from` cased differently from the
  // mount path, which the shared source makes unreachable. If that premise ever breaks, reach for
  // `samePath` (`engine/scripts/pathIdentity.mjs`), not for `toLowerCase`.
  const holds = dirtyAssetEditorHolds().filter(({ path }) =>
    froms.some((from) => path === from || path.startsWith(`${from}/`)));
  if (!holds.length) return null;
  const which = holds.map((h) => `the ${h.kind} editor (${h.path})`).join(' and ');
  return `Unsaved edits in ${which} — Save or Cancel it first, then move the asset.`;
}

/** Resolve the first real (writable) asset root by scanning the live manifest.
 *  New prefab files must land under a *real* writable asset root — virtual tree
 *  nodes like "/" aren't writable. */
export async function readWritableAssetRoot(): Promise<{ ok: true; root: string | null } | { ok: false; error: string }> {
  const a = await callBackend('/api/rescan-assets');
  if (!a.ok) return { ok: false, error: a.error };
  const assets = Array.isArray(a.body.assets) ? a.body.assets as { path: string }[] : [];
  return { ok: true, root: firstAssetRoot(assets.map((x) => x.path)) };
}

// ── Create-prefab-from-entity flow (shared by Assets + Hierarchy) ────

export interface CreatePrefabResult {
  /** The path the prefab was written to. */
  savePath: string;
  /** The serialized prefab (the in-memory PrefabFile). */
  prefab: PrefabFile;
  /** Coalesced undo entry — caller pushes it (and may add its own refresh()
   *  to undo/redo). */
  action: UndoAction;
  /** How many RUNTIME entities the selection contained that did not go into the prefab — pooled
   *  UIEntries rows, timeline scrub/control spawns (#1306). Surfaced by the caller: a prefab that
   *  silently came out with fewer members than the user selected is the surprise that gets filed
   *  as a bug weeks later (owner, 2026-09-17). 0 in the ordinary case. */
  runtimeExcluded: number;
}

/** Serialize an entity subtree to a `.prefab.json`, write it, register its
 *  GUID↔path, cache it, and convert the live tree into a linked instance —
 *  then return the undo descriptor. Shared by Hierarchy "Create Prefab" and the
 *  Assets entity-drop branch (they differ only in how `savePath` is chosen).
 *
 *  Cache by GUID, not path — PrefabInstance.source is GUID-only, so the sync
 *  nested-instance lookup (getCachedPrefabSync, used when saving an OUTER prefab
 *  that now nests this one) keys on the GUID. Caching by path left it invisible,
 *  so a freshly-created nested prefab flattened on the next save.
 *
 *  Returns null if the entity can't be serialized or the file write fails;
 *  callers log the appropriate panel-specific error. Returns 'declined' when the
 *  path already held a file and the human chose not to replace it (#1264). */

/** Say so when undo could not put a prior prefab link back (#1272).
 *
 *  Scoping the untag by source means undo no longer DEPENDS on the GUID-keyed snapshot resolving
 *  — a held nested instance keeps its own link rather than being stripped and restored. But a ref
 *  can still miss (an entity deleted since the create, a guid re-minted across a reload), and a
 *  silent skip is indistinguishable from a working undo. The entities are left as they are; this
 *  only reports, because there is nothing left to roll back by the time it is known. */
function reportUnrestoredLinks(unresolved: number, label: string): void {
  if (unresolved <= 0) return;
  reportUndoFailure({
    direction: 'Undo', label,
    detail: `${unresolved} prefab link${unresolved === 1 ? '' : 's'} the tree had before could not be put back — ${unresolved === 1 ? 'that entity is' : 'those entities are'} no longer addressable (deleted, or its guid was re-derived by a scene reload). Everything else was undone.`,
  });
}

/** The `id` a prefab document's bytes carry (a leading BOM allowed), or undefined. */
function idOf(text: string): string | undefined {
  try { const id = (JSON.parse(text.replace(/^\uFEFF/, '')) as { id?: unknown }).id; return typeof id === 'string' && id ? id : undefined; } catch { return undefined; }
}

/** A clause as a sentence: its first letter capitalised. */
const sentence = (clause: string): string => clause.charAt(0).toUpperCase() + clause.slice(1);

export async function createPrefabFromEntity(
  entityId: number,
  /** Where to write. Over an existing file of another casing the prefab lands on THAT file's on-disk
   *  spelling (#1273), which is what the result's `savePath` reports. */
  requestedPath: string,
  label: string,
  /** Asked when `requestedPath` already holds a file (#1264). Both callers DERIVE the path from the
   *  entity's name, so a second entity called "Enemy" used to replace the first Enemy prefab under a
   *  fresh guid — every placed instance of it unlinked — and this function's own undo then TRASHED
   *  the path, taking the original prefab with it. A yes replaces the content and KEEPS the prefab's
   *  guid (owner 2026-09-15), so placed instances stay linked; undo restores the replaced bytes. */
  confirmReplace: (path: string) => Promise<boolean>,
): Promise<CreatePrefabResult | 'declined' | { refused: string }> {
  // The live subtree is what gets written, so it must be authored (#1548) — a posed or played
  // entity saved as a prefab carries the pose into every future instance.
  const notAuthored = whyWorldNotAuthored();
  if (notAuthored) return { refused: `Create Prefab refused — ${notAuthored}. ${sentence(notAuthoredExit(notAuthored) ?? 'exit the preview / stop Play first')}.` };
  // Part of a prefab instance is not saved as a prefab of its own (#1869, Unity's rule): asked before anything awaits.
  const part = partOfInstanceRefusal(entityId);
  if (part) return { refused: `Create Prefab refused — ${part}` };
  // A reference to a missing prefab holds its edits as a scene record, which a template cannot take (#1699, I8).
  const missing = missingPrefabPlaceholders(entityId)[0];
  if (missing) return { refused: `Create Prefab refused — "${missing.name}" is a reference to a missing prefab, so its edits cannot be written into a template until that prefab resolves. Restore it first, or leave it out of the selection.` };
  // Where it goes, and what is there now (#1264, #1273): a file at the path is replaced only when the human says so,
  // keeps its guid (owner 2026-09-15), and lands on the file's own on-disk spelling. Decided BEFORE the tree is
  // serialized, so what is written is the tree as it stands once the question is answered.
  // The world the tree lives in. The question below is a modal, and a world rebuilt while it is up (a watcher reload, an
  // agent's scene load) can hand `entityId` to another entity — which would then be written over the prefab the human
  // said yes to (close-out review). Captured as the ADOPTED world (#1750 R2): a same-world check also passes a world a
  // route installed and has not adopted, and misses an adopt that kept the world.
  // Non-null: a landing switch made `whyWorldNotAuthored` refuse above, and nothing has awaited since. The tree's root
  // itself too: a frame rebuilt in place (a leave repair, an Apply's fan-out) re-mints ids in the same world.
  const adopted = captureAdoptionGate()!;
  const sameRoot = captureEntityIdentity(entityId);
  const gone = (when: string) => (!adopted()
    ? { refused: `Create Prefab refused — the scene was reloaded ${when}, so the entity it was asked for is gone. Select it and try again.` }
    : !sameRoot()
      ? { refused: `Create Prefab refused — the entity it was asked for was rebuilt ${when} (a prefab instance refreshed in place). Select it and try again.` }
      : null);
  const at = await existingAssetPath(requestedPath);
  let savePath = requestedPath;
  let keptId: string | undefined;
  /** The replaced file's bytes — what the write is conditional on (I10), and what undo puts back. */
  let previousContent: string | null = null;
  let replaced = false;
  if (at != null) {
    if (!(await confirmReplace(at))) return 'declined';
    // ⚠️ REFUSE rather than mint over a document that is THERE and unreadable (#1468, #896's class): the human
    // confirmed replacing the file's content, not re-identifying it, and every instance of it would unlink.
    const existing = await classifyExistingDocumentId(at);
    if (existing.kind === 'refuse') return { refused: `Create Prefab refused — ${at} was not replaced: ${existing.reason}.` };
    // A parked prefab is replaced as the PARK (#1868 D-i): it is the document the editor shows and Save would write, so
    // the Replace is conditional on it (the commit checks the file's own baseline instead, and retires the park), and
    // its undo restores it — not the bytes an older Save left in the file.
    const parked = parkedPrefabRead(at);
    const prior = parked ? jsonFileBody(parked) : await readPriorDocument(at);
    if (prior === null) return { refused: `Create Prefab refused — ${at} could not be read, so it was not overwritten blind.` };
    savePath = at;
    if (prior !== undefined) {
      replaced = true;
      previousContent = prior;
      // The kept id from the SAME read as the rows matched and the bytes the write is conditional on (close-out review):
      // the classify above read the file separately, and a file swapped in between would land under the old one's id.
      keptId = idOf(prior) ?? (existing.kind === 'known' ? existing.id : undefined);
    }
  }
  // The question above is a modal: the world can have gone into Play or a preview while it was up.
  const stillNotAuthored = whyWorldNotAuthored();
  if (stillNotAuthored) return { refused: `Create Prefab refused — ${stillNotAuthored}. ${sentence(notAuthoredExit(stillNotAuthored) ?? 'exit the preview / stop Play first')}.` };
  const goneAtQuestion = gone('while the question was open');
  if (goneAtQuestion) return goneAtQuestion;
  // serializePrefab reads nested children from the editor prefab cache SYNCHRONOUSLY, and
  // nothing else on this path warms it — after an ordinary scene load it is empty, so a held
  // nested instance was flattened into copies with only a console.warn (#1284).
  await preloadNestedPrefabsForSubtree(entityId);
  // …and that warm is a real fetch when cold, with no world hold taken yet (the commit's is later): a hot reload landing
  // in it renumbers the world, and `entityId` then names another entity — H1's class (#1750). The last await before the
  // serialize, so the last check.
  const goneAtWarm = gone('while the prefab was being prepared');
  if (goneAtWarm) return goneAtWarm;
  // A nested frame that could not be expanded (#1790, owner ruling D) — asked only now, after the warm: a merely cold key
  // is not a missing prefab.
  const unexpanded = unexpandedNestedRefusal(entityId);
  if (unexpanded) return { refused: `Create Prefab refused — ${unexpanded}. Restore it, or leave the instance out of the selection.` };
  // A frame built from other rows than the cache holds (#1815, I3) — after the warm too: a cold key cannot be judged.
  const stale = staleFramesInTreeRefusal(entityId);
  if (stale) return { refused: `Create Prefab refused — ${stale}. Reload the scene and try again.` };
  let runtimeExcluded = 0;
  // ⚠️ A Replace that keeps the replaced prefab's id serializes AGAINST the document it replaces (#1686): with no id, every
  // row's `nodeGuid` was minted fresh, and every other instance's edits and pinned member guids are keyed by the old ones.
  // The live `nodeGuid` carries where the tree is an instance of it, then a unique name matches (Unity's Replace,
  // `nodeGuidsFor`). The id is known before the serialize here (the path is decided first), so once is enough. The rows
  // are the replaced BYTES, BOM dropped (`readPriorDocument` keeps one for the verbatim undo).
  const draft = serializePrefab(entityId, keptId, {
    bakeKeptState: true,
    onRuntimeExcluded: (n) => { runtimeExcluded = n; },
    ...(keptId && previousContent ? { replacing: parsedPrefabRows(previousContent.replace(/^\uFEFF/, '')) } : {}),
  });
  // A refusal said, like every other (#1776 close-out review): the tree is empty, or holds an instance of the prefab it
  // would replace — a prefab that would contain itself. It was a bare null both panels only logged.
  if (!draft) return { refused: `Create Prefab refused — the selection could not be written as a prefab: it is empty, or it holds an instance of ${at ?? savePath}, which cannot contain itself.` };
  // An authoring write, so it reports an inert size (#42, #1251) — named by the file it lands on.
  warnInertPrefabSizes(draft, savePath);
  // A Replace serializes WITH the kept id, so `serializePrefab`'s own cycle guard refuses (null, above) a tree holding an
  // instance of the very prefab it replaces — a prefab that would contain itself.
  const guid = keptId ?? draft.id ?? newGuid();
  const prefab: PrefabFile = { ...draft, id: guid };
  const content = jsonFileBody(prefab);
  // Resolved FIRST: `entityRef` mints the root a guid if it has none, and that guid is the ANCHOR every member's
  // derived guid is computed from (#1461). Minted after the tag, the stamp would have nothing to derive from and would
  // silently leave the window open. Its other job is unchanged — resolving the tagged subtree after a world rebuild
  // (Play→Stop).
  const ref = entityRef(entityId);
  let priorLinks: ReturnType<typeof detachPrefabInstance> | null = null;
  let guidRemap: ReturnType<typeof tagEntityTreeAsInstance> = new Map();
  // The undo of the tag's kept-state settle (#1790), run before the rename is reversed.
  let undoKept = () => {};
  // The template keys the tag wrote (#1830), which every redo puts back before it re-tags.
  let keys: ReadonlyMap<string, string> = new Map();
  // ONE step (#1692): the write only over what the path held when it was read — nothing, or `previousContent` — then
  // both caches (by GUID too: PrefabInstance.source is GUID-only, and the sync nested lookup keys on it), the tag of
  // THIS tree, and a rebuild of every OTHER live instance of a replaced prefab (#1685: they stayed expanded from the
  // old document, and the next save recorded the template's new members as removed from them, for good).
  const committed = await commitPrefabWrite(savePath, prefab, {
    expected: replaced ? previousContent : null,
    rebuild: (landed) => {
      // ⚠️ The tag reports the links it OVERWROTE, so undo can put them back (#1264 close-out) — and only those (#1830):
      // it snapshots the tree itself, without stripping (#1278), and keeps what it wrote. A snapshot of the whole tree put
      // create-time records back over nested frames a later save had rebased.
      // Inside the commit and BEFORE its rebase: the tag records this tree as expanded from the new document, so the
      // rebase rebuilds only the other instances — never this one from what it was before.
      // Not the raw id: the write and the warm awaited, and a freed id can be handed straight to another entity.
      const id = ref.resolve();
      if (id == null) return;
      // The rename the tag stamped onto the members (old guid → new), for undo to reverse.
      ({ guidRemap, undoKept, priorLinks, keys } = tagCreatedPrefab(id, landed.path, prefab));
    },
  });
  // Said to the human, as the agent's create says it (#1776): a failed write was a bare null, which both panels only
  // logged, so a Create Prefab that wrote nothing looked like one that did nothing.
  if (!committed.ok) {
    return { refused: committed.conflict
      ? `Create Prefab refused — ${savePath} changed on disk while it was being written, so it was left as it is.`
      : `Create Prefab failed — ${savePath} was not written: ${committed.error ?? 'the write failed'}.` };
  }
  // The path the prefab really landed on — the existing file's on-disk spelling after a Replace
  // (#1273). The instance tags and both undo directions key on it.
  savePath = committed.path;
  assetWrittenToDisk(savePath);
  // Whether the tree currently carries THIS prefab's tags. A failed undo returns without untagging, and
  // the undo manager still moves it to the redo stack — so redo must not re-snapshot a tree that is
  // still tagged, or `priorLinks` becomes this prefab's own links and the next undo re-links the tree
  // to the prefab it was just unlinked from (#1264 close-out review). False when the world was replaced during the
  // write and there was no tree left to tag.
  let tagged = priorLinks !== null;
  /** The undo rebased the re-linked tree onto its template's CURRENT document (#1820): a template change since the
   *  create (a saved prefab edit, an outside edit) — so the tree is no longer the one the create's rows describe, in
   *  shape or in value, and the redo refuses rather than re-link it to them. */
  let rebasedByUndo = false;
  /** Asked by the redo: whether a frame its undo relinked was rebuilt since (#1830 close-out review). */
  let relinkedChanged: () => string | null = () => null;
  // Not this step's OWN document: a Replace's undo restores its old bytes itself, and a rebase onto that is the step
  // undoing, not a template change it cannot redo over.
  const priorSources = () => new Set((priorLinks?.links ?? []).map((l) => l.data.source as string).filter((src) => !!src && src !== guid));
  /** The document a replace restores — `previousContent` as every reader parses it. */
  const restored = (): PrefabFile => parsePrefabBytes(previousContent!);

  /** Put the members' ORIGINAL guids back, and every ref with them (#1461). Runs ahead of the links:
   *  the `priorLinks` snapshot was taken one line before the tag and addresses each member by the guid it
   *  held then. The order is asserted in `tests/editor/createPrefabUndo.test.ts` (the `calls` sequence),
   *  so moving this line is a test failure, not a silent change. Only on a path that actually undoes —
   *  a refused file write leaves the tree
   *  tagged, and must leave the stamp with it. */
  const unstamp = () => { undoKept(); undoKept = () => {}; unstampMemberGuids(guidRemap); };
  const treeChangedRefusal = (why: string) => new UndoRefusedError(
    `"${prefab.name ?? savePath}" no longer describes the tree it was made from: ${why}. Nothing was written or linked.`,
    `The tree changed since it was saved as ${savePath.split('/').pop()} — nothing was redone`,
  );
  const action: UndoAction = {
    label,
    // Both directions are ALL-OR-NOTHING: a file write is gated, and the
    // cache + the live tree's instance tagging only follow if it landed (#308). A CREATE's undo writes no file at all
    // (#1795: it unlinks and leaves the prefab), and its redo writes one only where the file was deleted since.
    //
    // It is ONE coupled operation: the .prefab.json and the
    // entities linked to it. Half-applying that leaves the user in a state that is
    // neither before nor after — entities un-linked from a prefab still on disk, or
    // linked to one that is not. Refusing cleanly and saying so is the honest answer.
    // ⚠️ And both directions carry a PRECONDITION (#1679): the prefab is global and this entry outlives edits made
    // elsewhere — double-click the new prefab, edit it, Cmd+S, Back, and this scene's Cmd+Z used to trash or overwrite
    // that save. A Replace's halves restore IN MEMORY (#1868) and refuse when the editor holds another document than the
    // other half left (`restorePrefabsInMemory`); a create's redo re-links only while the file still holds `prefab`, and
    // writes the file only where it was deleted since. Each restore's rebuild puts this tree's links back (or on), and
    // its rebase brings every OTHER instance of a replaced prefab onto the restored document.
    undo: async () => {
      rebasedByUndo = false;
      // The tree this step tagged, asked BEFORE anything changes (#1795's second route, I19/I20): after a world swap it
      // can be gone, or a Missing Prefab placeholder (this prefab trashed, the scene reloaded) whose scene entry still
      // names the file. Asked only while the tree is tagged: an untagged tree has no link to undo.
      const tagCheck = { check: (id: number) => isInstanceRootCheck(id) ?? (instanceSourceIs(id, guid, savePath) ? null : `is no longer an instance of ${savePath}`) };
      // …and, for a create (it writes no file to be conditional on), still the tree the create tagged (#1795 review).
      const createCheck = { check: (id: number) => tagCheck.check(id) ?? createdFrameRebuiltRefusal(id, prefab, savePath) };
      // ⚠️ A CREATE's undo unlinks the tree and LEAVES THE FILE (#1795, hub ruling (i) 2026-09-29, Unity's rule: undo
      // reverts the scene object's connection, never the asset's creation — as the agent's `prefab create` undo does). It
      // trashed the file, and a scene saved in between (a Cmd+S, an Apply's undo) still named it: the next reload from
      // disk turned the tree into a Missing Prefab nobody deleted, with no redo left. Writing nothing also means there is
      // no file precondition to fail — #1821's refusal after a #1774 mark raise has nothing left to compare. A file left
      // behind is an ordinary unused asset. A Replace below still restores what it overwrote (#1264).
      if (!replaced) {
        if (!tagged) return;
        const id = ref.require(createCheck);
        unstamp();
        untagEntityTreeAsInstance(id, savePath, prefab); // by the document's own guid (#1807)
        if (priorLinks) {
          reportUnrestoredLinks(reattachPrefabInstance(priorLinks, { rootEcsId: id }), label);
          // The links name the template the tree was built from, which can have changed since (#1820): onto the current one.
          rebasedByUndo = rebaseStaleInstancesSoon({ sources: priorSources() });
          relinkedChanged = relinkedFramesCheck(priorLinks);
        }
        tagged = false;
        return;
      }
      if (tagged) ref.require(tagCheck);
      // ⚠️ A replace is RESTORED, never trashed: the path held a prefab before this action, and deleting it is exactly how
      // the original was lost (#1264). IN MEMORY (#1868, D1 = Park): both caches hold the replaced document, every other
      // instance is rebased onto it, and Save writes it. By the prefab's guid, so a Rename since finds it where it is
      // (#1868 hub call e). Refused, before anything changes, when the editor holds another document than this Replace
      // left (a prefab-edit save since, an outside change) — the #1679 precondition, asked of memory.
      await restorePrefabsInMemory([{ source: guid, doc: restored(), from: prefab }], {
        rebuild: () => {
          unstamp();
          // By the document's own guid (#1807): the manifest can still map it to a renamed path an undo just moved back.
          const id = ref.resolve();
          // `require` above refused a tree that was gone or a placeholder. A miss HERE is a world swap that landed during
          // the nested preload, so it is a shortfall of a step that applied in part (#1823).
          if (id != null) untagEntityTreeAsInstance(id, savePath, prefab);
          else reportUndoFailure({ direction: 'Undo', label, detail: `the entity linked to ${savePath} no longer exists, so nothing was unlinked` });
          if (priorLinks) {
            reportUnrestoredLinks(reattachPrefabInstance(priorLinks, { rootEcsId: id ?? undefined }), label);
            rebasedByUndo = rebaseStaleInstancesSoon({ sources: priorSources() }); // as the create's undo above (#1820)
            relinkedChanged = relinkedFramesCheck(priorLinks); // as the create's undo above (#1830 close-out review)
          }
          tagged = false;
        },
      });
    },
    redo: async () => {
      // Why gating matters MORE than logging on this side: caching the prefab (and
      // tagging the live tree as an instance of it) after a failed write leaves the
      // editor believing in a .prefab.json that is not on disk. It reads correctly
      // from cache for the rest of the session and comes back missing on the next
      // scene load or a fresh editor launch, which read the FILE. That delay is what
      // makes the desync expensive — the failure surfaces far from its cause.
      // A create's redo writes only over nothing — a prefab created there since (by hand, or another Create Prefab) is
      // somebody else's; a Replace's redo writes nothing (#1868).
      // The tree it tags, asked BEFORE the file is written (I19): a tree that is gone, or a placeholder now, refuses the
      // redo rather than writing a prefab nothing links.
      ref.require();
      // …and a tree the rows it wrote still describe (#1820). The undo rebased the re-linked tree onto its template's
      // current document when that template had changed since the create, so the tree differs from those rows — in shape
      // (the tag then refused inside while the step reported success) or only in value (re-linked, the reload reverted
      // it). Refused before anything is written, the undone state stands, and it is current.
      if (rebasedByUndo) throw treeChangedRefusal('the prefab the tree held changed since, and the undo brought the tree onto that change');
      // …and a frame the undo RELINKED rebuilt since (#1830 close-out review) — a Replace's too: its in-memory precondition
      // asks only after the document it replaced, not after the template the tree was put back on.
      const changed = relinkedChanged();
      if (changed) throw treeChangedRefusal(changed);
      if (!replaced) {
        // A create's undo left the file (#1795, ruling (i)), so the redo RE-LINKS to it and writes nothing when it still
        // holds this document (its bytes, or the same document under a raised #1774 mark). A file somebody changed since
        // (a prefab-edit save, an outside edit) refuses before any change (I10): the tag re-plans the tree against THESE
        // rows, and would tag it against a document the file no longer holds. Only a file deleted since (the unused
        // asset cleaned up) is written again, by the commit below, over nothing.
        // Read where the document IS now, by its own guid (#1807's rule for a document): a Rename since moved it, and the
        // path this step wrote can hold another prefab by then — a later Create Prefab of the same name reuses the path
        // the rename freed, and the redo read THAT file and refused (hunt seed 6029).
        const at = resolveRef(guid) ?? savePath;
        // The document the EDITOR holds first (#1868): a later Replace's or Apply's undo restores this one in memory only,
        // and the file keeps the bytes it overwrote until a Save — read from disk, it refused over the stack's own step.
        const parked = parkedPrefabRead(at);
        const onDisk = parked ? jsonFileBody(parked) : await readPriorDocument(at);
        // Unreadable (a failed fetch, a 5xx): said and left as it is, not refused as "changed" — a refusal drops the entry
        // for good over what may be a moment's failure (#1795 review).
        if (onDisk === null) return reportUndoFailure({ direction: 'Redo', label, detail: `${at} could not be read, so nothing was linked` });
        // Absent where the manifest says the document lives now, somewhere OTHER than the path this step wrote: it was
        // moved or deleted outside the stack, and writing it back at the old path would put a second file under its guid
        // (#1795 review). Only a document gone from the path this step wrote is written back, below.
        if (onDisk === undefined && at !== savePath) throw fileChangedRefusal([at]);
        if (onDisk !== undefined) {
          if (!prefabTextIsDocument(onDisk, prefab)) throw fileChangedRefusal([at]);
          const id = ref.require(); // asked again: the read above can span a world swap
          // The editor cache must hold the document every sync reader and the tag read (I9) — the file does, but an
          // eviction since the undo (a delete and its restore) can have left the key cold.
          if (!getCachedPrefabSync(guid)) primeEditorPrefabCache(guid, prefab);
          // The same cold-cache flatten as the commit's rebuild below (#1284), and the same re-resolve after it.
          await preloadNestedPrefabsForSubtree(id);
          // The keys the file holds go back on first (#1830), and a tree that no longer plans to its rows refuses.
          const t = tagCreatedPrefab(ref.require(), at, prefab, { keys }); // undo reverses THIS run's rename
          if (t.refused) throw treeChangedRefusal(t.refused);
          ({ guidRemap, undoKept } = t);
          if (!tagged) priorLinks = t.priorLinks;
          tagged = true;
          return;
        }
      }
      // A Replace's redo: IN MEMORY, as its undo (#1868). A create's redo reaches here only for a file deleted since, and
      // writes it back — a new asset, over nothing.
      const rebuild = async () => {
        const id = ref.resolve();
        // The prefab is back; the entity it links is gone, so nothing was linked — said into the step (#1823).
        if (id == null) return reportUndoFailure({ direction: 'Redo', label, detail: `${savePath} was restored, but the entity it links no longer exists, so nothing was linked` });
        // tagEntityTreeAsInstance re-runs planPrefabRows, whose nested-instance lookup is the
        // same sync cache read as the original create (#1284). Cold, the plan drops the nested
        // row, planMatchesFile then disagrees with the file that was written WARM, and the redo
        // tags nothing at all — leaving the subtree unlinked from the prefab it just restored.
        await preloadNestedPrefabsForSubtree(id);
        // Re-resolve: a cold source makes that warm do real I/O, and entityRef exists in this
        // file precisely because a raw id goes stale across a world rebuild (Play->Stop, a
        // watcher reload). Tagging the pre-await id could hit a different entity, or none.
        const tagId = ref.resolve();
        if (tagId == null) return reportUndoFailure({ direction: 'Redo', label, detail: `${savePath} was restored, but the entity it links no longer exists, so nothing was linked` });
        const t = tagCreatedPrefab(tagId, savePath, prefab, { keys }); // re-stamped, so undo reverses THIS run's rename
        if (t.refused) return reportUndoFailure({ direction: 'Redo', label, detail: `${savePath} was restored, but the tree no longer matches it (${t.refused}), so nothing was linked` });
        ({ guidRemap, undoKept } = t);
        if (!tagged) priorLinks = t.priorLinks;
        tagged = true;
      };
      if (replaced) {
        await restorePrefabsInMemory([{ source: guid, doc: prefab, from: restored() }], { rebuild });
        return;
      }
      const committed = await commitPrefabWrite(savePath, prefab, { expected: null, bytes: content, rebuild });
      if (committed.conflict) throw fileChangedRefusal([savePath]);
      if (!committed.ok) {
        reportUndoFailure({
          direction: 'Redo', label,
          detail: `the prefab file was not written: ${savePath} (${committed.error ?? 'the write failed'}). The entities were left un-linked rather than pointed at a file that is not there.`,
        });
      }
    },
  };
  return { savePath, prefab, action, runtimeExcluded };
}

/** Why instance root `id` cannot be un-created as the prefab document `doc`, or null: its own frame was expanded from
 *  ANOTHER document since the create tagged it (#1795 review). A prefab-edit save or an outside edit of the new prefab
 *  rebases the instance onto what the file now holds (a child added, a value changed); unlinking it then leaves those
 *  in the scene as plain entities, which is neither the tree before the create nor after it. The create's undo used to
 *  refuse through its file precondition; it writes no file now, so it asks the tree. The tag records `doc` itself as
 *  the frame's document, so the same object, or the same content (a reload re-expanding it), is the create's. */
export function createdFrameRebuiltRefusal(id: number, doc: PrefabFile, path: string): string | null {
  const handle = findEntity(id);
  const rec = handle ? frameRootDoc(getCurrentWorld(), handle) : undefined;
  if (!rec || rec.doc === (doc as unknown) || prefabTextIsDocument(jsonFileBody(rec.doc as unknown as PrefabFile), doc)) return null;
  return `was rebuilt from a changed ${path} since, so unlinking it would keep that change in the scene`;
}

/** Taken when Create Prefab's undo (a create's or a Replace's) has put the tree's old links back: the record of each frame it RELINKED (#1830 close-out
 *  review). The check it returns, asked by the redo before anything changes, answers why the tree no longer matches the
 *  rows the redo would link it to, or null: a relinked frame rebuilt from another document since the undo (a saved
 *  prefab edit, an outside edit). Linked anyway, its new values sat on rows written with the old ones and a Save + reload
 *  reverted them — the value half of the redo's refusal, which `rebasedByUndo` caught only when the undo's own rebase did
 *  it. A reload re-expanding the same document is not a change. */
export function relinkedFramesCheck(priorLinks: DetachSnapshot | null): () => string | null {
  const recordOf = (ref: EntityRef) => {
    const id = ref.resolve();
    const handle = id == null ? undefined : findEntity(id);
    return handle ? frameRootDoc(getCurrentWorld(), handle)?.doc as unknown as PrefabFile | undefined : undefined;
  };
  const held = (priorLinks?.links ?? []).filter((l) => l.frame).map((l) => ({ ref: l.ref, doc: recordOf(l.ref) }));
  return () => {
    for (const h of held) {
      if (!h.doc) continue;
      const now = recordOf(h.ref);
      if (now === h.doc || (now && prefabTextIsDocument(jsonFileBody(now), h.doc))) continue;
      return 'a prefab the tree held changed since the undo, and the tree was rebuilt onto that change';
    }
    return null;
  };
}

/** Whether instance root `id` is an instance of the prefab with document guid `guid` (or, where the manifest could not
 *  resolve it, the raw `path` it was tagged with). */
function instanceSourceIs(id: number, guid: string, path: string): boolean {
  const meta = getTraitByName('PrefabInstance');
  const source = meta ? (readTraitData(id, meta)?.source as string | undefined) : undefined;
  // `resolveRef` only for a guid: handed an internal path it logs a loud refusal (GUID-only refs) and answers nothing.
  return !!source && (source === guid || source === path || (isGuid(source) && resolveRef(source) === path));
}

/** The unsaved-work staleness a `/api/unused-assets` answer disclosed, or `null` when it disclosed
 *  none. (#889)
 *
 *  ⚠️ **This exists as a plain function so the Clean Up dialog's DECISION is testable without
 *  mounting the dialog** (`docs/editor.md` § Panels — a jsdom mount asserts the mock). The close-out
 *  review found the wire fields being computed by the route and consumed by nothing: the disclosure
 *  reached agents through the MCP surface while the HUMAN path — the one that actually deletes —
 *  dropped it. A field nobody reads is the same as a field nobody sends.
 *
 *  Why the dialog reads the RESPONSE rather than polling `unsavedChangeCauses()` itself: the
 *  server's answer is derived from the same probe that computed the orphan list, so it cannot
 *  disagree with it, and that probe carries the type-level exhaustiveness check a client-side
 *  hand-list cannot. `FindReferencesDialog` was the counter-example — a hand-list of two of the
 *  five causes — and #972 moved it onto the same `staleInputsNote`. Rule and rationale:
 *  `docs/mcp-persistence.md` § "The cause table is the SCHEMA"; guarded by
 *  `tests/architecture/staleDisclosureIsServerDerived.test.ts`. */
export interface UnusedStaleness {
  /** What the scan could not see. Non-empty when known; absent when the renderer could not be asked. */
  readonly inputs: ReadonlyArray<{ path: string; registry: string; detail?: string }>;
  /** True when the renderer never answered — "could not look", which is not "nothing is there". */
  readonly unknown: boolean;
  /** The sentence to show. Always present when this object is. */
  readonly note: string;
}

/** Read the disclosure off an `/api/unused-assets` body.
 *
 *  ⚠️ Returns `null` — not an empty object — when the editor was clean, because the dialog must
 *  render NOTHING in that case. The route omits the fields entirely rather than sending
 *  `staleInputs: []`, and a reader that turned absence into a falsy-but-present value would put an
 *  always-on caveat back on every clean scan, which is the banner people learn to ignore. */
export function readUnusedStaleness(body: {
  staleInputs?: Array<{ path: string; registry: string; detail?: string }>;
  staleInputsUnknown?: { reason: string };
  staleInputsNote?: string;
} | null | undefined): UnusedStaleness | null {
  if (!body) return null;
  const note = typeof body.staleInputsNote === 'string' ? body.staleInputsNote : '';
  const inputs = Array.isArray(body.staleInputs) ? body.staleInputs : [];
  const unknown = !!body.staleInputsUnknown;
  // The note is what the human reads, so no note means nothing to show — even if a field arrived.
  // That also makes a half-populated body (a field without its note) fail closed rather than
  // rendering an empty warning box.
  if (!note || (!inputs.length && !unknown)) return null;
  return { inputs, unknown, note };
}
