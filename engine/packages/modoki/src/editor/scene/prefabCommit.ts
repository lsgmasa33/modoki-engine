/** A prefab write is ONE step (#1692; docs/prefabs.md § "Model and invariants", I9–I11).
 *
 *  `commitPrefabWrite` is the only function that changes a `.prefab.json`. Before it, `writePrefabFileReport` put the
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

import {
  preloadNestedPrefabs, rebaseStaleInstances, seatEditorPrefabCache, type PrefabFile,
} from './prefab';
import { postWriteFile, jsonFileBody } from '../backend/editorBackend';
import { deleteAssetFiles } from '../panels/assetOps';
import { sha256OfWritten, sha256OfBytes } from '../utils/contentHash';
import { newGuid, registerAsset, getGuidForPath, isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { replaceCachedPrefab, invalidatePrefab } from '../../runtime/loaders/meshTemplateCache';
import { migrateUIAnchorZIndexStructured } from '../../runtime/loaders/uiAnchorZIndexMigration';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { isHtmlFallthrough } from '../../runtime/loaders/assetFetch';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { beginWorldBoundOperation } from '../undo/undoManager';
import { adoptionsSettledGate, pendingAdoptionCount, captureAdoptionGate } from './adoptionGate';
import { localIdCounter, advanceLocalIdCounter } from '../../runtime/core/localIdCounter';
import { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';

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
  /** `false`: skip the rebase. For a caller whose `rebuild` replaces the world and rebases it itself (Apply's undo
   *  reloads a scene snapshot). */
  rebase?: boolean;
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
  /** The file whose precondition or write refused or failed (`conflict`/`error`) — the one a refusal names (#1732): with
   *  several files it is not necessarily the first. */
  failed?: string;
  /** Files a mid-way failure left written and could NOT put back (a multi-file commit's rollback lost a race too). */
  stranded?: string[];
  worldLeft?: boolean;
  rebased?: number;
}

/** Write `doc` to the prefab `source` names — or trash it, for `null` — as ONE step. See the module comment. */
export async function commitPrefabWrite(source: string, doc: PrefabFile | null, opts: PrefabCommitOptions): Promise<PrefabCommitResult> {
  const res = await commitPrefabWrites([{ source, doc, expected: opts.expected, bytes: opts.bytes }], {
    overwrite: opts.overwrite, rebase: opts.rebase,
    rebuild: opts.rebuild ? (landed) => opts.rebuild!({ path: landed.paths[0]! }) : undefined,
  });
  const { paths, stranded: _stranded, failed: _failed, ...rest } = res;
  return { ...rest, path: paths[0] ?? prefabPathOf(source) };
}

/** Several prefab files as ONE step (#1692; the unit #1693's Apply needs, which writes an inner prefab AND the enclosing
 *  one whose override it drops — Unity's U13). All-or-nothing, as far as a filesystem allows:
 *  1. **Every precondition is checked before any file is written** — each file is read and compared with its
 *     `expected` (absent, the same bytes, or the same document). One mismatch refuses the whole commit, writing nothing.
 *     A single file skips the read: its conditional write IS the atomic check.
 *  2. Each file is then written with `ifMatch` on exactly the bytes that check read (or `createOnly`), so the route still
 *     refuses one that changed in between. If a later file is refused or fails anyway, the files already written are
 *     put back — each conditional on what this commit wrote there — and any that cannot be are named in `stranded`.
 *  3. Both caches for every file, then the caller's `rebuild` ONCE, then one rebase over every source. */
export async function commitPrefabWrites(
  writes: readonly PrefabWrite[],
  opts: { overwrite?: boolean; rebuild?: (landed: { paths: string[] }) => void | Promise<void>; rebase?: boolean } = {},
): Promise<PrefabCommitsResult> {
  const release = beginWorldBoundOperation();
  try {
    // A route between its world call and its adopt (a hot reload, a scene load past its wait): the world on screen is
    // about to become another scene's, and its history and path with it. Waited for, not raced — the owner registers a
    // route only around its own world call, never across a prefab write, so this cannot wait for itself (#1698).
    // Asked through `adoptionGate.ts`, not by importing the owner: that import closes a load-time cycle through `./prefab`
    // and drags the owner's whole graph into every write (see that file).
    // ⚠️ The world is taken BEFORE the wait (close-out review): the wait only blocks when a route is about to REPLACE the
    // world, and taken after it the commit adopted that new world as its own — its caller's rebuild (Apply's refresh,
    // Create Prefab's and the agent's tag) then ran there, with ids and captures from the world it began in. A world
    // replaced while waiting refuses the whole write instead: what the caller computed describes a world that is gone.
    // …and taken only in an ADOPTED world (#1750 R2): called in a route's State 4 (another prefab's edit-open tail), the
    // world is already the incoming one and stays "the same" all the way to its adopt, so the commit wrote that world as
    // the open prefab (#1747). Refused, not waited for (owner, 2026-09-28: a world that is not savable refuses).
    const live = captureAdoptionGate();
    if (!live) {
      return { ok: false, paths: writes.map((w) => prefabPathOf(w.source)), worldLeft: true, error: 'a scene is still loading, so nothing was written — try again once it is open' };
    }
    const world = getCurrentWorld();
    const settling = adoptionsSettledGate();
    if (settling) await settling;
    if (!live()) {
      return { ok: false, paths: writes.map((w) => prefabPathOf(w.source)), worldLeft: true, error: 'the scene was replaced before the write could start, so nothing was written' };
    }
    const worldLeft = () => !live() || pendingAdoptionCount() > 0;

    // `overwrite` skips every precondition, so a multi-file rollback would have nothing true to put back (the caller's
    // `expected` is exactly what an overwrite ignores): one file only — the prefab-edit save's Overwrite.
    if (opts.overwrite && writes.length > 1) {
      return { ok: false, paths: writes.map((w) => prefabPathOf(w.source)), error: 'an overwrite writes one file at a time' };
    }
    const plan = writes.map((w) => {
      const asked = prefabPathOf(w.source);
      if (w.doc && !w.doc.id) w.doc.id = newGuid();
      const guid = w.doc?.id ?? (isGuid(w.source) ? w.source : getGuidForPath(asked) ?? idIn(w.expected));
      return { ...w, asked, guid };
    });
    // 1. Every precondition before any write (N > 1).
    const exact = new Map<number, { ifMatch?: string; createOnly?: boolean; prior: string | null }>();
    if (plan.length > 1 && !opts.overwrite) {
      for (const [i, w] of plan.entries()) {
        const pre = await precheck(w.asked, w.expected);
        if ('refused' in pre) return { ok: false, paths: plan.map((x) => x.asked), failed: w.asked, ...(pre.refused === 'conflict' ? { conflict: true } : { error: pre.refused }) };
        exact.set(i, pre);
      }
    }
    // 2. The writes, undone in reverse on a mid-way miss.
    const done: Array<{ path: string; wrote: string | null; prior: string | null }> = [];
    for (const [i, w] of plan.entries()) {
      const pre = exact.get(i);
      const landed = w.doc
        ? await writeDoc(w.asked, w.doc, { expected: w.expected, bytes: w.bytes, overwrite: opts.overwrite }, pre)
        : await trashDoc(w.asked, w.expected, pre);
      if (!landed.ok) {
        const stranded = await rollBack(done);
        return { ok: false, paths: plan.map((x) => x.asked), failed: w.asked, ...('conflict' in landed && landed.conflict ? { conflict: true } : {}),
          ...('error' in landed && landed.error ? { error: landed.error } : {}), ...(stranded.length ? { stranded } : {}) };
      }
      const path = landed.path ?? w.asked;
      done.push({ path, wrote: 'content' in landed ? landed.content ?? null : null, prior: pre ? pre.prior : priorOf(w.expected) });
    }
    const paths = done.map((d) => d.path);
    // 3. Both caches for every file, one rebuild, one rebase.
    for (const [i, w] of plan.entries()) seatCaches(paths[i]!, w.source, w.guid, w.doc);
    for (const w of plan) if (w.doc) await preloadNestedPrefabs(w.doc);
    if (worldLeft()) return { ok: true, paths, worldLeft: true };
    await opts.rebuild?.({ paths });
    if (!plan.some((w) => w.doc) || opts.rebase === false || getCurrentWorld() !== world) return { ok: true, paths };
    const sources = new Set<string>();
    for (const [i, w] of plan.entries()) if (w.doc) { sources.add(w.source); sources.add(paths[i]!); if (w.guid) sources.add(w.guid); }
    const rebased = await rebaseStaleInstances({ sources });
    return { ok: true, paths, rebased };
  } finally {
    release();
  }
}

/** Is `path` what `expected` says, read now? The exact precondition for its write when so (#1692, multi-file). */
async function precheck(path: string, expected: PrefabExpectation): Promise<{ ifMatch?: string; createOnly?: boolean; prior: string | null } | { refused: string }> {
  const state = await readState(path);
  if (state === 'unreadable') return { refused: `${path} could not be read to check it before writing` };
  if (expected === null) return state === 'absent' ? { createOnly: true, prior: null } : { refused: 'conflict' };
  if (state === 'absent') return { refused: 'conflict' };
  const expectedDoc = typeof expected === 'string' ? parsedOrNull(expected) : expected;
  const same = (typeof expected === 'string'
    ? state.text.replace(/^\uFEFF/, '') === expected.replace(/^\uFEFF/, '')
    : state.text.replace(/^\uFEFF/, '') === jsonFileBody(expected)) || (!!expectedDoc && sameDocument(state.text, expectedDoc));
  if (!same) return { refused: 'conflict' };
  const ifMatch = await hashBytes(state.bytes);
  return typeof ifMatch === 'string' ? { ifMatch, prior: state.text } : { refused: ifMatch.ok ? 'hash' : (ifMatch.error ?? 'hash') };
}

/** The bytes a file held before a commit wrote it, when the caller's `expected` says them. */
function priorOf(expected: PrefabExpectation): string | null {
  return expected === null ? null : typeof expected === 'string' ? expected : jsonFileBody(expected);
}

/** Put back, newest first, what a failed multi-file commit already wrote — each only over what the commit wrote there.
 *  Returns the paths it could not. */
async function rollBack(done: Array<{ path: string; wrote: string | null; prior: string | null }>): Promise<string[]> {
  const stranded: string[] = [];
  for (const d of [...done].reverse()) {
    const expected = d.wrote;
    // The prior bytes, with the mark this commit wrote kept (#1774): the route refuses a write that lowers it.
    const priorDoc = d.prior === null ? null : parsedOrNull(d.prior);
    const prior = d.prior === null || !priorDoc ? d.prior : contentFor(priorDoc, d.prior, parsedOrNull(d.wrote));
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
 *  edit session keeps its own baseline instead (`prefabEdit.ts` `editBaselineFor`). */
function seatCaches(path: string, source: string, guid: string | undefined, doc: PrefabFile | null): void {
  if (doc?.id) registerAsset(doc.id, path, 'prefab');
  for (const key of new Set([source, path, ...(guid ? [guid] : [])])) seatEditorPrefabCache(key, doc);
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
type Landed = { ok: true; path?: string; content?: string } | { ok: false; conflict?: boolean; error?: string };

/** The bytes a write of `doc` puts down, with its localId high-water mark (#1774, `localIdCounter.ts`) at least every
 *  prior's — `priors` being the documents it lands over: the one the caller read, or the file re-read when that is what
 *  the precondition matched. So no write LOWERS the mark, whichever writer made it: each writer states the mark itself,
 *  and this is the line under it. Mutates `doc`, so the caches and the caller's own record hold the mark written.
 *
 *  A write that lowers nothing is left exactly as built. `bytes` (an undo putting a file back verbatim, #1679) are kept
 *  verbatim unless they would lower the mark — undoing a
 *  write that minted a number must not free that number for the next write, or it derives the guid the undone node had
 *  (Apply adds C at 4, Cmd+Z, the next Apply adds D at 4). Then the bytes are written with the mark raised and a format
 *  version that claims it, spliced in so every other byte stays (`withTopLevelNumbers`); re-serialized only when the
 *  splice cannot be shown exact. */
function contentFor(doc: PrefabFile, bytes: string | undefined, ...priors: Array<PrefabFile | null | undefined>): string {
  const need = Math.max(0, ...priors.map((p) => (p ? localIdCounter(p) : 0)));
  // Nothing to raise: the document goes down exactly as the caller built it — a writer states its own mark, and a
  // restore of a file from before v8 stays without one (it derives the same mark from its rows).
  // Judged on what is WRITTEN: with `bytes`, the bytes — not `doc`, which an earlier call may already have raised (a redo
  // hands the same document and the same recorded bytes every time; judged on the raised document, the lower bytes went
  // out and were refused for good, close-out re-review).
  const written = bytes === undefined ? doc : parsedOrNull(bytes) ?? doc;
  if (need <= localIdCounter(written)) return bytes ?? jsonFileBody(doc);
  const had = doc.nextLocalId !== undefined;
  advanceLocalIdCounter(doc, need);
  // A raised mark is v8 data, so what is written claims v8 (an older build then refuses to save over it and drop the mark).
  const claims = !(written.version >= PREFAB_FORMAT_VERSION);
  if (!(doc.version >= PREFAB_FORMAT_VERSION)) doc.version = PREFAB_FORMAT_VERSION;
  if (bytes === undefined) {
    if (!had) placeMarkAfterRoot(doc);
    return jsonFileBody(doc);
  }
  return withTopLevelNumbers(bytes, { nextLocalId: doc.nextLocalId!, ...(claims ? { version: doc.version } : {}) }) ?? jsonFileBody(doc);
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
    if (canonical(JSON.parse(text)) !== canonical({ ...(before as object), ...fields })) return null;
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

async function writeDoc(
  path: string, doc: PrefabFile, w: { expected: PrefabExpectation; bytes?: string; overwrite?: boolean },
  /** The precondition a multi-file pre-check already established, exactly, and the bytes it read there. */
  pre?: { ifMatch?: string; createOnly?: boolean; prior?: string | null },
): Promise<Landed> {
  const put = async (content: string, cond: { createOnly?: boolean; ifMatch?: string }): Promise<Landed> => {
    const res = await post(path, content, cond, doc.name);
    return res.ok ? { ...res, content } : res;
  };
  const expectedDoc = w.expected === null ? null : typeof w.expected === 'string' ? parsedOrNull(w.expected) : w.expected;
  // An overwrite ignores what is there, but never the mark it holds.
  if (w.overwrite) return put(contentFor(doc, w.bytes, expectedDoc, parsedOrNull((await readBytes(path))?.text)), {});
  if (pre) return put(contentFor(doc, w.bytes, parsedOrNull(pre.prior)), pre.createOnly ? { createOnly: true } : { ifMatch: pre.ifMatch });
  const { expected } = w;
  if (expected === null) return put(contentFor(doc, w.bytes), { createOnly: true });
  const first = await hashOf(typeof expected === 'string' ? expected : jsonFileBody(expected));
  if (typeof first !== 'string') return first;
  const res = await put(contentFor(doc, w.bytes, expectedDoc), { ifMatch: first });
  if (res.ok || !res.conflict || !expectedDoc) return res;
  // Refused against the exact bytes. The file may still hold the document read: in other bytes, or with only its mark
  // raised since (`sameDocument` — a write stamped the mark after the caller recorded the bytes it holds, #1774). The
  // mark then comes from the file that is there.
  const onDisk = await readBytes(path);
  if (!onDisk || !sameDocument(onDisk.text, expectedDoc)) return res;
  const again = await hashBytes(onDisk.bytes);
  if (typeof again !== 'string') return again;
  return put(contentFor(doc, w.bytes, expectedDoc, parsedOrNull(onDisk.text)), { ifMatch: again });
}

async function trashDoc(path: string, expected: PrefabExpectation, pre: { ifMatch?: string; createOnly?: boolean } | undefined): Promise<Landed> {
  if (expected === null) return { ok: true };
  const hash = pre?.ifMatch ?? await hashOf(typeof expected === 'string' ? expected : jsonFileBody(expected));
  if (typeof hash !== 'string') return hash;
  const res = await deleteAssetFiles([path], { ifMatch: { [path]: hash } });
  if (res.conflicts?.length) return { ok: false, conflict: true };
  return res.ok && res.failed.length === 0 ? { ok: true } : { ok: false, error: `${path} could not be trashed` };
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
    const res = await postWriteFile(path, content, undefined, pre);
    if (res.ok) {
      const body = await res.json().catch(() => null) as { path?: unknown } | null;
      const written = typeof body?.path === 'string' && body.path ? body.path : path;
      console.log(`[Prefab] Wrote "${name}" → ${written}`);
      return { ok: true, path: written };
    }
    // READ THE BODY (#1468 close-out review F5): the format gate answers 409 with its reason in `error`, and it is the
    // one thing only the human can act on. Only an if-match / if-none-match 409 is a conflict; the gate's is not.
    const body = await res.json().catch(() => null) as { error?: unknown; reason?: unknown } | null;
    const why = typeof body?.error === 'string' ? body.error : typeof body?.reason === 'string' ? body.reason : '';
    // `prefab-mark-lowered` (#1774) is a conflict too: the file's localId high-water mark rose past what this write was
    // raised to, so it is not the file the caller read — and the fallback below re-reads it and raises from it.
    const conflict = res.status === 409 && (body?.reason === 'if-match' || body?.reason === 'if-none-match' || body?.reason === 'prefab-mark-lowered');
    // Not logged here: every caller reports its own failure, once, in its own words (an undo's #308 report, Apply's
    // refusal, the prefab-edit save's warnings) — a second line here doubled each one.
    return { ok: false, ...(conflict ? { conflict } : {}), ...(why && !conflict ? { error: why } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A prefab file's bytes as every reader parses them: a leading BOM dropped, and the zIndex migration
 *  `getPrefabSource` applies (a doc seeded un-migrated poisons override detection). For an undo that restores bytes it
 *  read (`readPriorDocument` keeps the BOM so the restore is verbatim). Throws on bytes that are not JSON. */
export function parsePrefabBytes(text: string): PrefabFile {
  const doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as PrefabFile;
  for (const entry of doc.entities ?? []) migrateUIAnchorZIndexStructured(entry);
  return doc;
}

/** The `id` of the document `expected` names, for a trash whose path the manifest no longer maps. */
function idIn(expected: PrefabExpectation): string | undefined {
  if (expected === null) return undefined;
  if (typeof expected !== 'string') return expected.id;
  try { const id = (JSON.parse(expected.replace(/^\uFEFF/, '')) as { id?: unknown }).id; return typeof id === 'string' ? id : undefined; } catch { return undefined; }
}

/** The file's bytes, uncached, or null when it is absent or unreadable. */
async function readBytes(path: string): Promise<{ bytes: Uint8Array; text: string } | null> {
  try {
    const res = await fetch(assetUrl(path), { cache: 'no-store' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    return isHtmlFallthrough(text) ? null : { bytes, text };
  } catch { return null; }
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
 *  The localId high-water mark and the format version are not compared (#1774): this commit owns both where it raises the
 *  mark (`contentFor` stamps a restore with the version that claims it), and only ever raises them, so a file that
 *  differs from what the caller read in those alone holds nobody's change to protect. An undo's redo is the case: it is
 *  conditional on the bytes the undo recorded, which predate the mark the undo's own write had to keep. */
function sameDocument(text: string, expected: PrefabFile): boolean {
  try {
    const parsed = parsePrefabBytes(text) as PrefabFile & { nextLocalId?: unknown };
    if (!parsed || !Array.isArray(parsed.entities)) return false;
    if (!parsed.id && expected.id) parsed.id = expected.id;
    const want = JSON.parse(JSON.stringify(expected)) as PrefabFile & { nextLocalId?: unknown };
    for (const d of [parsed, want] as unknown as Array<Record<string, unknown>>) { delete d.nextLocalId; delete d.version; }
    return canonical(parsed) === canonical(want);
  } catch { return false; }
}

/** JSON with every object's keys sorted: two parses of one document compare equal whatever order a writer put them in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
