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

import { backendFetch } from '../backend/editorBackend';
import { serializePrefab, tagEntityTreeAsInstance, untagEntityTreeAsInstance, setPrefabCache, warnInertPrefabSizes, type PrefabFile } from '../scene/prefab';
import { entityRef } from '../undo/entityRef';
import type { UndoAction } from '../undo/undoManager';
import { registerAsset } from '../../runtime/loaders/assetManifest';
import { firstAssetRoot } from './assetRoots';
import { pastePathIn, splitAssetPath, type AssetEntry } from '../utils/assetPaths';
import { isTextAsset } from './assetUndo';

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

/** Write a text or base64-encoded file via /api/write-file. */
export async function writeAssetFile(filePath: string, content: string, encoding?: 'base64'): Promise<boolean> {
  try {
    const res = await backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content, encoding }),
    });
    return res.ok;
  } catch { return false; }
}

/** Trash ONE asset via /api/delete-asset. */
export async function deleteAssetFile(assetPath: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/delete-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: assetPath }),
    });
    return res.ok;
  } catch { return false; }
}

/** What a batch trash actually did. `missing` are the paths that were not on
 *  disk, so nothing was trashed for them — the caller MUST NOT treat those as
 *  recoverable files. `deletionPathsFor` deliberately lists maybe-absent
 *  sidecars (`.meta.local.json` is gitignored and usually not there), so
 *  "asked to trash" and "trashed" routinely differ and only the backend knows
 *  by how much. Discarding that distinction is what let an undo failure name
 *  files that never existed (#291). */
export type DeleteFilesResult = { ok: boolean; trashed: number; missing: string[] };

/** Trash MANY paths in a single request → ONE OS-trash invocation → one trash
 *  sound (vs. one chime per file when each path was its own POST). The backend
 *  skips any path that no longer exists, so a list carrying maybe-absent
 *  sidecars is safe — and it REPORTS those in `missing`, which is the only way
 *  a caller can tell an absent sidecar from a file it failed to save. */
export async function deleteAssetFiles(paths: string[]): Promise<DeleteFilesResult> {
  if (paths.length === 0) return { ok: true, trashed: 0, missing: [] };
  try {
    const res = await backendFetch('/api/delete-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) return { ok: false, trashed: 0, missing: [] };
    // A body we cannot parse is not a failed delete — the trash already happened.
    // Fall back to "everything we asked for was trashed", which is what the old
    // boolean return assumed for every call.
    try {
      const body = await res.json() as Partial<DeleteFilesResult>;
      return {
        ok: true,
        trashed: typeof body?.trashed === 'number' ? body.trashed : paths.length,
        missing: Array.isArray(body?.missing) ? body.missing : [],
      };
    } catch { return { ok: true, trashed: paths.length, missing: [] }; }
  } catch { return { ok: false, trashed: 0, missing: [] }; }
}

/** Copy an asset to a new path; the backend regenerates the GUID so the
 *  duplicate doesn't collide with the original in the manifest. */
export async function duplicateAssetFile(from: string, to: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/duplicate-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
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
  try {
    const res = await backendFetch('/api/move-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    return res.ok;
  } catch { return false; }
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
  const content = JSON.stringify(prefab, null, 2);
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
    undo: async () => {
      await deleteAssetFile(savePath);
      setPrefabCache(cacheKey, null);
      const id = ref.resolve(); if (id != null) untagEntityTreeAsInstance(id);
    },
    redo: async () => {
      await writeAssetFile(savePath, content);
      if (prefab.id) registerAsset(prefab.id, savePath, 'prefab');
      setPrefabCache(cacheKey, prefab);
      const id = ref.resolve(); if (id != null) tagEntityTreeAsInstance(id, savePath);
    },
  };
  return { savePath, prefab, action };
}
