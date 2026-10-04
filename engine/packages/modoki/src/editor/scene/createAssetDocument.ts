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
import { classifyJsonAssetPath } from '../../runtime/loaders/assetTypeClassifier';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { notePrefabWrite } from './prefabWriteLog';
import { backendFetch, postWriteFile, readBackendAnswer, thrownRefusal, type BackendAnswer } from '../backend/editorBackend';
import { classifyExistingDocumentId } from './prefabCache';
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
  /** The write failed, or `build` refused (returned null). `error` is why, in the route's words when it answered (#1811). */
  | { outcome: 'failed'; path: string; status?: number; error?: string; options?: string[] };

export async function writeNewAssetDocument(
  path: string,
  /** The document's bytes for `guid`. `kept` is true when `guid` is the REPLACED asset's id — a
   *  builder that would otherwise prefer an id of its own must use this one, or every ref to the
   *  replaced asset dangles. `previous` is the replaced document's bytes, read before the write (`keepPrevious`
   *  only; null otherwise): what a builder matching identity against the old content reads (#1686). Null
   *  aborts (e.g. a prefab that would nest itself). */
  build: (guid: string, kept: boolean, previous: string | null) => string | null,
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
  const firstBody = build(fresh, false, null);
  if (firstBody == null) return { outcome: 'failed', path };
  const first = await post(path, firstBody, true);
  if (first.ok) {
    // The route's spelling of what it wrote: a create inside a folder typed in another case lands in
    // the folder that exists, and the caller registers `path` (#1273 close-out review).
    const written = answeredPath(first.body, 'path') ?? path;
    assetWrittenToDisk(written);
    return { outcome: 'created', path: written, guid: fresh };
  }
  // Only the create-only precondition means "something is there" (#1824): a 409 that names ANOTHER reason — the
  // prefab format gate's — is a failed write with the route's reason, not an offer to replace a file. A 409 naming
  // no reason at all still reads as "exists", which is what a route too old to name one meant.
  if (first.status !== 409 || (first.reason !== undefined && first.reason !== 'if-none-match')) return { outcome: 'failed', path, ...(first.status ? { status: first.status } : {}), ...refusalFields(first) };
  // ⚠️ From here on, the path is the one the ROUTE says is there, not the one we asked for (#1273).
  // The create-only check is case-insensitive wherever the filesystem is, so `enemy.prefab.json`
  // conflicts with `Enemy.prefab.json` — and every step below keys on an exact path: the kind check
  // and the kept guid read the manifest, the Replace names the file to the human, and the replacing
  // write, the parked-edit drop and the caller's registration must all land on the asset that exists
  // rather than mint a second spelling of it. A route too old to answer keeps the requested spelling.
  const at = answeredPath(first.body, 'existingPath') ?? path;
  const existingType = opts.kind ? otherAssetKindAt(at, opts.kind) : undefined;
  if (existingType) return { outcome: 'wrongKind', path: at, existingType };
  if (!opts.confirmReplace) return { outcome: 'exists', path: at };
  if (!(await opts.confirmReplace(at))) return { outcome: 'declined', path: at };

  // Both read BEFORE the replacing write, which is what destroys them.
  const existing = await classifyExistingDocumentId(at);
  // ⚠️ REFUSE rather than mint over a document that is THERE and unreadable (#1468, #896's class).
  // A 500, corrupt bytes or a file a newer build wrote used to arrive here as `undefined`, which
  // this line read as "first-time import" and answered with a FRESH guid — orphaning everything
  // that referenced the old one, with the old bytes still on disk. The human already confirmed
  // replacing the file; they did not confirm re-identifying it.
  if (existing.kind === 'refuse') {
    console.error(`[Asset] not replacing ${at} — ${existing.reason}`);
    return { outcome: 'failed', path: at, error: existing.reason };
  }
  const keptId = existing.kind === 'known' ? existing.id : undefined;
  const previousContent = opts.keepPrevious ? await readText(at) : null;
  const guid = keptId ?? fresh;
  const body = build(guid, keptId != null, previousContent);
  if (body == null) return { outcome: 'failed', path: at };
  const second = await post(at, body, false);
  if (!second.ok) return { outcome: 'failed', path: at, ...(second.status ? { status: second.status } : {}), ...refusalFields(second) };
  assetWrittenToDisk(at);
  return { outcome: 'replaced', path: at, guid, previousContent };
}

/** What a panel's New-asset command tells the human when `writeNewAssetDocument` did not create or replace (#1811):
 *  the route's reason for a failed write, or the kind clash. Null when there is nothing to say — the human declined the
 *  Replace, or created/replaced it. The panels used to return silently on every one of these. */
export function newAssetRefusalText(r: NewAssetDocumentResult): string | null {
  const file = r.path.split('/').pop() || r.path;
  if (r.outcome === 'failed') return `${file} was not created: ${r.error ?? 'the document could not be built'}`;
  if (r.outcome === 'wrongKind') return `${file} was not replaced: it is a '${r.existingType}' asset, not this kind`;
  return null;
}

/** For a create that must decide BEFORE it can write — Scene's override discards the live world
 *  first and writes last, so a create-only 409 would arrive after the damage. `{ create }` when nothing
 *  is at `path`, or the human confirmed replacing it. A check-then-act, unlike `writeNewAssetDocument`:
 *  the price of an override that is arbitrary editor code rather than a document written here.
 *
 *  `create` is the path to write: `path` itself when nothing is there, else the EXISTING file's
 *  on-disk spelling — the same reason `writeNewAssetDocument` switches to it (#1273). */
export async function mayCreateOver(
  path: string,
  confirmReplace: (path: string) => Promise<boolean>,
  kind: string,
): Promise<{ create: string } | 'declined' | { existingType: string }> {
  const at = await existingAssetPath(path);
  if (at == null) return { create: path };
  const existingType = otherAssetKindAt(at, kind);
  if (existingType) return { existingType };
  return (await confirmReplace(at)) ? { create: at } : 'declined';
}

/** The manifest's type for the asset at `path` when it is not `kind`, else undefined (#1264 close-out).
 *
 *  A Replace keeps the replaced document's guid, which is only right when the new document is the SAME
 *  kind. The scene flows write plain `.json`, so their destination can be `Enemy.prefab.json`: kept,
 *  that prefab's guid would be re-registered as a scene and every `PrefabInstance.source` pointing at it
 *  would resolve to a scene document. Every other create enforces a compound extension that cannot
 *  land on another kind. A file the manifest has not indexed yet is classified by its url with
 *  `classifyJsonAssetPath`, the rule the scanner types by — the answer the manifest WILL give once it
 *  indexes the file (#1472; the backend's `wrongKindRefusal` asks the same two questions in the same
 *  order). A path no kind claims reads as no conflict. */
export function otherAssetKindAt(path: string, kind: string): string | undefined {
  const type = getAssetEntry(path)?.type ?? classifyJsonAssetPath(path);
  return type && type !== kind ? type : undefined;
}

/** The path of the file at `path`, or null when there is none — for a create that must ask BEFORE it
 *  can write (Scene's override discards the live world first). `/api/exists`, not `fetch(path).ok` —
 *  Vite's SPA fallback answers 200 for a file that is not there. A failed probe reads as absent: the
 *  backend is then unreachable and the write that follows fails on its own.
 *
 *  The answer is the route's on-disk spelling, which differs from `path` in case alone when the
 *  filesystem folded it (#1273); a route too old to answer with one keeps `path`. */
export async function existingAssetPath(path: string): Promise<string | null> {
  try {
    const res = await backendFetch(`/api/exists?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { exists?: boolean; path?: unknown };
    if (body.exists !== true) return null;
    return typeof body.path === 'string' && body.path ? body.path : path;
  } catch { return null; }
}

/** The on-disk path `/api/write-file` names in `field` — `path` on a write, `existingPath` on a
 *  create-only 409 — if it names one. */
function answeredPath(body: unknown, field: 'path' | 'existingPath'): string | undefined {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

/** A refused write's reason and options, as a failed outcome carries them (#1811). */
function refusalFields(r: { error: string; options?: string[] }): { error: string; options?: string[] } {
  return { error: r.error, ...(r.options ? { options: r.options } : {}) };
}

/** The route's answer, read by the one reader — a request that never reached it is a refusal with `status` 0. */
async function post(path: string, content: string, createOnly: boolean): Promise<BackendAnswer> {
  let r: BackendAnswer;
  try { r = await readBackendAnswer(await postWriteFile(path, content, undefined, { createOnly })); } catch (e) { return thrownRefusal(e); }
  if (r.ok) notePrefabWrite(path, false);
  return r;
}

async function readText(path: string): Promise<string | null> {
  try {
    const res = await fetch(assetUrl(path), { cache: 'no-store' });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}
