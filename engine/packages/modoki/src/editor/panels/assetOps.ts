/** Framework-free asset operations — the backend-IO helpers and the
 *  prefab-creation flow that the Assets and Hierarchy panels both need.
 *
 *  Before this module these helpers were copy-pasted between
 *  `Assets.tsx` and `Hierarchy.tsx` (editor-panels F6/F7): the thin
 *  `/api/*` wrappers (`writeAssetFile`/`writeFile`, `deleteAssetFile`/
 *  `deleteAsset`, …), the "first writable asset root" lookup, and the
 *  "serialize entity subtree → write .prefab.json → tag the live tree as an
 *  instance → push undo" flow (`Hierarchy.handleCreatePrefab` vs the entity
 *  branch of `Assets.handleDrop`, near-identical line-for-line). Two copies
 *  drifted independently (one wrote to `${root}/prefabs/…`, the other to
 *  `${targetFolder}/…`). They now live here so a fix lands in ONE place, and
 *  the logic is unit-testable without rendering a React panel. */

import { backendFetch, writeAssetFile, jsonFileBody } from '../backend/editorBackend';
import { serializePrefab, tagEntityTreeAsInstance, untagEntityTreeAsInstance, setPrefabCache, warnInertPrefabSizes, type PrefabFile } from '../scene/prefab';
import { entityRef } from '../undo/entityRef';
import { reportUndoFailure } from '../undo/undoFailure';
import type { UndoAction } from '../undo/undoManager';
import { registerAsset } from '../../runtime/loaders/assetManifest';
import { firstAssetRoot } from './assetRoots';
import { pastePathIn, splitAssetPath, type AssetEntry } from '../utils/assetPaths';
import { isTextAsset } from './assetUndo';
import { flushPendingMetaFor } from '../scene/pendingMeta';

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

// ── Delete / rename policy (pure — the IO lives in the panel) ─────────

/** Every path a delete of `assetPath` must remove, in restore order.
 *
 *  This is the sidecar rule, and it has already been wrong once: the `.meta.json`
 *  of a binary asset used to be snapshotted for undo but never trashed, leaving an
 *  orphaned sidecar on disk after every binary/model delete. Extracted from
 *  `Assets.tsx`'s `collectDeletion` (#105 Phase 3) so the rule is checkable without
 *  standing up fetch + the backend.
 *
 *  - The asset itself always goes first, so an undo restores in the original order.
 *  - A BINARY asset also drops BOTH sidecar halves: the committed `.meta.json`
 *    (GUID + import settings — both dangle if lost across a delete/undo) and the
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
 *  (assetUndo.ts, createRegisteredAsset.ts, scene/skinPrefab.ts, Assets.tsx) need no change. */
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

/** Trash ONE asset via /api/delete-asset.
 *
 *  ⚠️ **The boolean is the OUTCOME, not the HTTP status** (#884). It used to be plain `res.ok`,
 *  and a path the OS refused answers **HTTP 200** — so a delete that deleted nothing returned
 *  `true`, and every caller that carefully checks this boolean (the seven #308 undo/redo closures,
 *  the Assets folder delete) was checking the wrong thing. The route now says `ok:false` in the
 *  body for that case; this reads it.
 *
 *  A boolean is still the right model HERE, unlike `deleteAssetFiles` below: with ONE path there
 *  is no partial outcome to describe — it went or it did not. */
export async function deleteAssetFile(assetPath: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/delete-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: assetPath }),
    });
    if (!res.ok) return false;
    // An unparseable body is not a failed delete — the trash already happened, and the old
    // boolean assumed exactly that for every call. Only an explicit `ok:false` is a refusal.
    try {
      const body = await res.json() as { ok?: unknown };
      return body?.ok !== false;
    } catch { return true; }
  } catch { return false; }
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
   *  ⚠️ **win32 only today.** darwin's `osascript` and Linux's `trash-put` are single invocations
   *  that throw as a whole, so their refusal arrives as `ok:false` with `failed` EMPTY. An empty
   *  `failed` is therefore not evidence that every path went — check `ok` for that. */
  failed: string[];
};

/** Trash MANY paths in a single request → ONE OS-trash invocation → one trash
 *  sound (vs. one chime per file when each path was its own POST). The backend
 *  skips any path that no longer exists, so a list carrying maybe-absent
 *  sidecars is safe — and it REPORTS those in `missing`, which is the only way
 *  a caller can tell an absent sidecar from a file it failed to save. */
export async function deleteAssetFiles(paths: string[]): Promise<DeleteFilesResult> {
  if (paths.length === 0) return { ok: true, trashed: 0, missing: [], failed: [] };
  try {
    const res = await backendFetch('/api/delete-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) return { ok: false, trashed: 0, missing: [], failed: [] };
    // A body we cannot parse is not a failed delete — the trash already happened.
    // Fall back to "everything we asked for was trashed", which is what the old
    // boolean return assumed for every call.
    //
    // ⚠️ That optimism is deliberate and must NOT be flipped to pessimistic now that `failed`
    // exists: an unparseable body says nothing about which paths went, and guessing "all of them
    // failed" would make a working delete report phantom survivors on every unreadable reply.
    try {
      const body = await res.json() as Partial<DeleteFilesResult>;
      return {
        // ⚠️ Read the BODY's verdict, not just the HTTP status (#884). This used to be a
        // hardcoded `true`, so a 200 saying `ok:false` — the route's answer when the OS refused
        // every path — arrived here as a clean success.
        ok: body?.ok !== false,
        trashed: typeof body?.trashed === 'number' ? body.trashed : paths.length,
        missing: Array.isArray(body?.missing) ? body.missing : [],
        failed: Array.isArray(body?.failed) ? body.failed.filter((p): p is string => typeof p === 'string') : [],
      };
    } catch { return { ok: true, trashed: paths.length, missing: [], failed: [] }; }
  } catch { return { ok: false, trashed: 0, missing: [], failed: [] }; }
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
export async function duplicateAssetFile(from: string, to: string): Promise<boolean> {
  try {
    await flushPendingMetaFor(from);
    const res = await backendFetch('/api/duplicate-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (!res.ok) {
      // The refusal body carries WHY (§5), and this used to throw it away — a Duplicate that
      // failed with nothing said anywhere.
      const detail = await res.text().catch(() => '');
      console.error(`[Assets] duplicate ${from} → ${to} failed: ${res.status} ${detail.slice(0, 400)}`);
    }
    return res.ok;
  } catch { return false; }
}

/** Create a (possibly empty) folder on disk under the asset roots. */
export async function createFolderApi(folderPath: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/create-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    });
    return res.ok;
  } catch { return false; }
}

/** Move/rename a file to an explicit destination path (the backend also moves
 *  the asset's .meta.json sidecar). The caller controls the full target path,
 *  not just the destination folder. */
export async function moveFileTo(from: string, to: string): Promise<boolean> {
  return (await moveFileToStatus(from, to)).ok;
}

/** `moveFileTo` with the HTTP status preserved, so a caller can tell a COLLISION
 *  from a backend failure. `/api/move-file` never clobbers: it answers **409
 *  "Destination exists"** when something already occupies the destination, and
 *  403/404/5xx for everything else. That distinction is what an undo/redo needs
 *  in order to report honestly (#308) — a 409 is user-caused and user-fixable
 *  (they recreated something at the old path, so undoing a rename can't move it
 *  back), while a 5xx is neither. `status` is 0 when the request itself threw.
 *
 *  `moveFileTo` deliberately stays a bare boolean rather than being widened to
 *  this shape: every existing call site uses it directly in boolean context
 *  (`if (await moveFileTo(a, b))`), and an object return is ALWAYS truthy — so
 *  widening it in place would silently disarm each of those guards while
 *  typechecking cleanly. */
export async function moveFileToStatus(from: string, to: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await backendFetch('/api/move-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    return { ok: res.ok, status: res.status };
  } catch { return { ok: false, status: 0 }; }
}

/** Resolve the first real (writable) asset root by scanning the live manifest.
 *  New prefab files must land under a *real* writable asset root — virtual tree
 *  nodes like "/" aren't writable. */
export async function firstWritableAssetRoot(): Promise<string | null> {
  try {
    const res = await backendFetch('/api/rescan-assets');
    if (!res.ok) return null;
    const data = await res.json();
    return firstAssetRoot(((data.assets || []) as { path: string }[]).map((a) => a.path));
  } catch { return null; }
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
 *  callers log the appropriate panel-specific error. */

export async function createPrefabFromEntity(
  entityId: number,
  savePath: string,
  label: string,
): Promise<CreatePrefabResult | null> {
  const prefab = serializePrefab(entityId);
  if (!prefab) return null;
  warnInertPrefabSizes(prefab, savePath);
  const content = jsonFileBody(prefab);
  if (!(await writeAssetFile(savePath, content))) return null;

  // Register the prefab's GUID↔path first so tagEntityTreeAsInstance stores the
  // GUID (PrefabInstance.source is GUID-only).
  if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
  const cacheKey = prefab.id ?? savePath;
  setPrefabCache(cacheKey, prefab);
  tagEntityTreeAsInstance(entityId, savePath);

  // Resolve the tagged subtree root by guid so tag/untag hit the right entity
  // after a world rebuild (Play→Stop).
  const ref = entityRef(entityId);
  const action: UndoAction = {
    label,
    // Both directions are ALL-OR-NOTHING: the file write/delete is gated, and the
    // cache + the live tree's instance tagging only follow if it landed (#308).
    //
    // That differs from makeDeleteUndo, which deliberately restores what it can and
    // reports the shortfall — and the difference is the unit of work, not a
    // disagreement. There, undo covers N INDEPENDENT files and partial progress is
    // genuinely useful. Here it is ONE coupled operation: the .prefab.json and the
    // entities linked to it. Half-applying that leaves the user in a state that is
    // neither before nor after — entities un-linked from a prefab still on disk, or
    // linked to one that is not. Refusing cleanly and saying so is the honest answer.
    undo: async () => {
      if (!(await deleteAssetFile(savePath))) {
        reportUndoFailure({
          direction: 'Undo', label,
          detail: `the prefab file was not trashed and is still on disk: ${savePath}. The entities were left linked to it rather than half-undone.`,
        });
        return;
      }
      setPrefabCache(cacheKey, null);
      const id = ref.resolve(); if (id != null) untagEntityTreeAsInstance(id);
    },
    redo: async () => {
      // Why gating matters MORE than logging on this side: caching the prefab (and
      // tagging the live tree as an instance of it) after a failed write leaves the
      // editor believing in a .prefab.json that is not on disk. It reads correctly
      // from cache for the rest of the session and comes back missing on the next
      // scene load or a fresh editor launch, which read the FILE. That delay is what
      // makes the desync expensive — the failure surfaces far from its cause.
      if (!(await writeAssetFile(savePath, content))) {
        reportUndoFailure({
          direction: 'Redo', label,
          detail: `the prefab file was not written: ${savePath}. The entities were left un-linked rather than pointed at a file that is not there.`,
        });
        return;
      }
      if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
      setPrefabCache(cacheKey, prefab);
      const id = ref.resolve(); if (id != null) tagEntityTreeAsInstance(id, savePath);
    },
  };
  return { savePath, prefab, action };
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
 *  Why the dialog reads the RESPONSE rather than polling `unsavedChangeCauses()` itself, as
 *  `FindReferencesDialog` does: the server's answer is derived from the same probe that computed
 *  the orphan list, so it cannot disagree with it — and that dialog's own client-side check is a
 *  hand-list of two of the five causes (#972). */
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
