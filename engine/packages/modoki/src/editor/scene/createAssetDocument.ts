/** Write a NEW asset document without ever silently replacing one (#1264).
 *
 *  Every human "New X" / "Create Prefab" / "Auto-Rig" path used to pick or derive a destination,
 *  mint a guid, and write with a plain `/api/write-file` — which replaces. Nothing between the
 *  destination and the write asked whether a file was already there, and the replacement got a
 *  FRESH guid, so every scene/prefab ref to the old asset dangled. The save dialog is not a guard:
 *  the Windows/Linux fallback never checks, the macOS panel checks the COLLAPSED name (`Walk.json`
 *  while the write goes to `Walk.anim.json`), and several paths derive their destination with no
 *  dialog at all. So the check lives HERE, at the write, where the real destination is known.
 *
 *  The shape, one for every caller:
 *    1. write create-only (`ifNoneMatch:'*'`) — the route refuses inside the same synchronous
 *       window as the write, so there is no check-then-write gap;
 *    2. on a 409, ask `confirmReplace` (absent → report `exists`, which is what an agent op wants);
 *    3. on a yes, write again as a replace, **keeping the replaced asset's guid** (owner
 *       2026-09-15, #1215 + #1264): "Replace" is about the file's content, not about breaking
 *       what uses it.
 *
 *  Registration (`registerAsset`) stays with the caller — the asset type and any cache seeding are
 *  its own. `assetWrittenToDisk` does not: every create must drop a parked edit for the path, or
 *  the next Cmd+S flushes the old edited document back over the replacement. */

import { newGuid, getAssetEntry } from '../../runtime/loaders/assetManifest';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { backendFetch, postWriteFile } from '../backend/editorBackend';
import { resolveExistingDocumentId } from './prefab';
import { assetWrittenToDisk } from './dirtyAssets';

export type NewAssetDocumentResult =
  | { outcome: 'created'; path: string; guid: string }
  /** `previousContent` is the replaced file's text, read only when `keepPrevious` was asked for
   *  (an undo that must RESTORE the old asset rather than delete the file); null otherwise. */
  | { outcome: 'replaced'; path: string; guid: string; previousContent: string | null }
  /** The destination exists and no `confirmReplace` was given. Nothing was written. */
  | { outcome: 'exists'; path: string }
  /** The destination exists and the human said no. Nothing was written. */
  | { outcome: 'declined'; path: string }
  /** The destination is a DIFFERENT kind of asset than `opts.kind`. Nothing was asked or written. */
  | { outcome: 'wrongKind'; path: string; existingType: string }
  /** The write failed, or `build` refused (returned null). */
  | { outcome: 'failed'; path: string; status?: number };

export async function writeNewAssetDocument(
  path: string,
  /** The document's bytes for `guid`. `kept` is true when `guid` is the REPLACED asset's id — a
   *  builder that would otherwise prefer an id of its own must use this one, or every ref to the
   *  replaced asset dangles. Null aborts (e.g. a prefab that would nest itself). */
  build: (guid: string, kept: boolean) => string | null,
  opts: {
    confirmReplace?: (path: string) => Promise<boolean>;
    /** The guid a fresh create uses. Default: a new one. */
    guid?: string;
    /** The asset type being created. When given, a destination the manifest types as something ELSE
     *  is refused, never replaced — see {@link otherAssetKindAt}. */
    kind?: string;
    keepPrevious?: boolean;
  } = {},
): Promise<NewAssetDocumentResult> {
  const fresh = opts.guid ?? newGuid();
  const firstBody = build(fresh, false);
  if (firstBody == null) return { outcome: 'failed', path };
  const first = await post(path, firstBody, true);
  if (first?.ok) {
    assetWrittenToDisk(path);
    return { outcome: 'created', path, guid: fresh };
  }
  if (first?.status !== 409) return { outcome: 'failed', path, status: first?.status };
  const existingType = opts.kind ? otherAssetKindAt(path, opts.kind) : undefined;
  if (existingType) return { outcome: 'wrongKind', path, existingType };
  if (!opts.confirmReplace) return { outcome: 'exists', path };
  if (!(await opts.confirmReplace(path))) return { outcome: 'declined', path };

  // Both read BEFORE the replacing write, which is what destroys them.
  const keptId = await resolveExistingDocumentId(path);
  const previousContent = opts.keepPrevious ? await readText(path) : null;
  const guid = keptId ?? fresh;
  const body = build(guid, keptId != null);
  if (body == null) return { outcome: 'failed', path };
  const second = await post(path, body, false);
  if (!second?.ok) return { outcome: 'failed', path, status: second?.status };
  assetWrittenToDisk(path);
  return { outcome: 'replaced', path, guid, previousContent };
}

/** For a create that must decide BEFORE it can write — Scene's override discards the live world
 *  first and writes last, so a create-only 409 would arrive after the damage. True when nothing is at
 *  `path`, or the human confirmed replacing it. A check-then-act, unlike `writeNewAssetDocument`:
 *  the price of an override that is arbitrary editor code rather than a document written here. */
export async function mayCreateOver(
  path: string,
  confirmReplace: (path: string) => Promise<boolean>,
  kind: string,
): Promise<'create' | 'declined' | { existingType: string }> {
  if (!(await assetFileExists(path))) return 'create';
  const existingType = otherAssetKindAt(path, kind);
  if (existingType) return { existingType };
  return (await confirmReplace(path)) ? 'create' : 'declined';
}

/** The manifest's type for the asset at `path` when it is not `kind`, else undefined (#1264 close-out).
 *
 *  A Replace keeps the replaced document's guid, which is only right when the new document is the SAME
 *  kind. The scene flows write plain `.json`, so their destination can be `Enemy.prefab.json`: kept,
 *  that prefab's guid would be re-registered as a scene and every `PrefabInstance.source` pointing at it
 *  would resolve to a scene document. Every other create enforces a compound extension that cannot
 *  land on another kind. A file the manifest has not indexed yet reads as no conflict. */
export function otherAssetKindAt(path: string, kind: string): string | undefined {
  const type = getAssetEntry(path)?.type;
  return type && type !== kind ? type : undefined;
}

/** Whether a file is at `path`, for a create that must ask BEFORE it can write (Scene's override
 *  discards the live world first). `/api/exists`, not `fetch(path).ok` — Vite's SPA fallback answers
 *  200 for a file that is not there. A failed probe reads as absent: the backend is then unreachable
 *  and the write that follows fails on its own. */
export async function assetFileExists(path: string): Promise<boolean> {
  try {
    const res = await backendFetch(`/api/exists?path=${encodeURIComponent(path)}`);
    return res.ok && ((await res.json()) as { exists?: boolean }).exists === true;
  } catch { return false; }
}

async function post(path: string, content: string, createOnly: boolean): Promise<Response | undefined> {
  try { return await postWriteFile(path, content, undefined, { createOnly }); } catch { return undefined; }
}

async function readText(path: string): Promise<string | null> {
  try {
    const res = await fetch(assetUrl(path), { cache: 'no-store' });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}
