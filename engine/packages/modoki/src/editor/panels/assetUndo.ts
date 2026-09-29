/** Undo builders for the Assets panel — framework-free factories that return a
 *  `UndoAction` the panel pushes. Extracted from Assets.tsx (editor-panels F6,
 *  then #308) so the near-identical `pushAction({undo, redo})` shapes
 *  (delete/duplicate/rename/move/paste/folder-create/folder-rename) live in
 *  one place and the snapshot/GUID-sidecar/failure-reporting logic is
 *  unit-testable without rendering the component.
 *
 *  Each builder takes a `refresh` callback (the panel's asset re-scan) so undo/
 *  redo re-list after mutating disk, exactly as the inline builders did.
 *
 *  #308: every builder below that moves/creates/deletes a file now checks the
 *  boolean/status the helper returns and calls `reportUndoFailure` on a miss —
 *  see that module's header for the reporting bar (console-only vs. a toast).
 *  React state setters (`setPendingFolders`, `setExpanded`) are threaded in as
 *  narrow function params rather than imported from the store, so this file
 *  stays framework-free. */

import type { UndoAction } from '../undo/undoManager';
import { commitPrefabWrite, parsePrefabBytes } from '../scene/prefabCommit';
import {
  writeAssetFile, deleteAssetFiles, duplicateAssetFileReport,
  createAssetFolder, moveAsset,
} from './assetOps';
import { writeAssetFileGuarded, backendFetch, importedFileBytes } from '../backend/editorBackend';
import { sha256OfBytes } from '../utils/contentHash';
import type { AssetEntry } from '../utils/assetPaths';
import { unbindDeletedAssetEditors, applyAssetPathMoves } from './assetEditorBindings';
import { reannounceRestoredFiles } from './assetRestore';
import type { PathMove } from '../utils/assetPaths';
import { reportUndoFailure, COLLISION_STATUS, UndoRefusedError, fileChangedRefusal, expectedHash } from '../undo/undoFailure';

/** A failed helper's reason as a report's parenthetical (#1824, U3 of docs/refusal-reporting.md): a step's report names
 *  WHY, not only what, now that the asset helpers carry the route's reason instead of a bare boolean. */
function because(r: { ok: boolean; error?: string }): string {
  return r.ok || !r.error ? '' : ` (${r.error})`;
}

// Extensions we know are UTF-8 text — everything else is treated as binary so
// the delete-undo snapshot round-trips bytes through base64 instead of
// fetch().text() (which silently UTF-8 corrupts binary files like .glb).
const TEXT_ASSET_EXTS = new Set(['.json', '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.svg', '.glsl', '.wgsl']);

export function isTextAsset(p: string): boolean {
  const lower = p.toLowerCase();
  return Array.from(TEXT_ASSET_EXTS).some((ext) => lower.endsWith(ext));
}

/** One restorable file captured before a delete. */
export type Snapshot = { path: string; content: string; encoding?: 'base64' };

/** The snapshot `collectDeletion` (Assets.tsx) takes of a file's bytes before a delete. A text asset stays text only
 *  while its bytes ARE UTF-8: `res.text()` replaced anything else with U+FFFD, so a Latin-1 `.txt`/`.md`/`.svg` came
 *  back from undo corrupted, and the redo's precondition could never match it (#1679 close-out re-review). Everything
 *  else goes byte-exact through base64 — which is also why binaries never went through `.text()`. */
export function snapshotFromBytes(path: string, bytes: Uint8Array): Snapshot {
  if (isTextAsset(path)) {
    try { return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch { /* not UTF-8 */ }
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { path, content: btoa(bin), encoding: 'base64' };
}

/** The disk effect of deleting ONE asset: undo snapshots + the flat list of
 *  paths to trash (asset + sidecar + generated files + their sidecars).
 *  `deletePaths` is what we ASKED to trash, which is deliberately a superset of
 *  what existed — see DeleteFilesResult. */
export type DeleteResult = { asset: AssetEntry; snapshots: Snapshot[]; deletePaths: string[] };

/** `sha256`: the copy's bytes as `/api/duplicate-asset` wrote them (#1679) — the undo trashes the copy only while it
 *  still holds them. Absent (a route that did not report one) → the undo REFUSES rather than trash unguarded. */
export type DupResult = { asset: AssetEntry; toPath: string; sha256?: string; sidecar?: Record<string, unknown> };

/** Build a single coalesced undo/redo for one or more completed deletes. Undo
 *  restores the FULL snapshot set (not just the GLB) so generated mesh/mat/
 *  texture refs don't dangle; redo re-trashes the whole set in ONE call. */
/** @param notTrashed Paths that did NOT go to the trash, so undo must not touch them and the
 *    shortfall report must not name them. Restoring one would be a write the user never asked
 *    for, and reporting one as "still in the trash, recover by hand" sends them hunting for a
 *    file that was never there.
 *
 *    ⚠️ **The two halves are passed SEPARATELY because they age differently, and merging them is
 *    a bug that has now been written twice.** `missing` is decided once, at the delete: a file
 *    that was never on disk (`deletionPathsFor` deliberately lists maybe-absent sidecars, #291)
 *    will not appear later. `failed` is the OS refusing a file that IS there (#884) — and the
 *    toast tells the human to close the handle and retry, so the very next redo can succeed on
 *    it. Hence `failed` is recomputed per redo and `missing` is not.
 *
 *    ⚠️ And `missing` must NOT be re-read from a redo's reply, which is the subtler half: a redo
 *    reports a path as `missing` when it is not on disk, and a path whose RESTORE just failed is
 *    exactly that. Refreshing `missing` from the redo therefore swallows the file the previous
 *    undo already reported as lost — permanently un-restorable and silent, the very defect this
 *    parameter's split exists to prevent. */
export function makeDeleteUndo(
  results: DeleteResult[], refresh: () => void,
  notTrashed: { missing?: string[]; failed?: string[] } = {},
): UndoAction {
  const label = results.length > 1 ? `Delete ${results.length} items` : `Delete ${results[0].asset.name}`;
  // Fixed at construction — see the docblock. Never re-read from a redo.
  const neverExisted = new Set(notTrashed.missing ?? []);
  // Ages: a redo can succeed on a path that was refused. `let`, rewritten by redo only.
  let refused = new Set(notTrashed.failed ?? []);
  const snapshotOf = new Map(results.flatMap((r) => r.snapshots).map((s) => [s.path, s] as const));
  // ⚠️ WHERE EACH PATH IS NOW, per path, because each step acts only on what the step before it actually did (#1679).
  // `inTrash`: this entry put it in the trash and nobody has put a file back at the path. `onDisk`: this entry's last
  // undo restored it there. A path in neither is not this entry's any more — a group whose restore found another file
  // at its path is dropped from both, so a redo cannot trash that file, and a later undo does not keep asking.
  const inTrash = new Set(Array.from(new Set(results.flatMap((r) => r.deletePaths))).filter((p) => !neverExisted.has(p) && !refused.has(p)));
  const onDisk = new Set<string>();
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      // Only what actually went. A file the OS refused is still on disk with the user's own
      // bytes in it; writing the snapshot back over it would clobber any edit made since.
      //
      // ⚠️ And only into an EMPTY path (`createOnly`, #1679): the file went to the trash, so anything at its path now
      // was put there since — the user recreated it, or another import landed on the name — and restoring over it is
      // exactly the overwrite this precondition stops. ONE ASSET AT A TIME, all-or-nothing: an asset is its file, its
      // sidecars and (for a model) every generated file, and half of that on disk is a GUID-less asset or an orphan
      // sidecar. Sidecars go FIRST, so the scanner never sees the file bare and mints it a sidecar of its own (which
      // the restore would then collide with); a collision part-way puts back what this asset had written.
      //
      // ⚠️ The WRITE's own result decides whether it was restored — #308's thesis, which this
      // builder never applied to itself. `writeAssetFile` catches and resolves `false`, so a
      // restore that 500'd used to be counted as restored: `lost` came out empty and the undo
      // reported "restored N of N" about a file still sitting in the trash. Exactly the false
      // success the shortfall report below exists to prevent, one level in from where it looked.
      //
      // ⚠️ One exception to `createOnly`: a SIDECAR whose file never left disk (the OS refused the file but took its
      // sidecar — #884's partial refusal) is OVERWRITTEN. The delete's own inline manifest rebuild heals the bare file
      // with a freshly minted sidecar, so something is always at that path — and it is that same file's, not somebody
      // else's. Writing the snapshot back is what restores the file's original GUID; a `createOnly` there dropped the
      // whole asset and left every ref to it dangling (close-out review). And a write that FAILS stops the asset too,
      // exactly like a collision, except that it stays in the trash to retry: carrying on would put the file on disk
      // without its sidecar, the heal would mint one, and the next undo would collide with it for good.
      const restoredPaths: string[] = [];
      const occupied: string[] = [];
      const unrolled: string[] = [];
      /** Each refused write, with the route's reason (#1811): the shortfall below names why, not only which. */
      const refusals: string[] = [];
      const isOwnSidecar = (p: string) => isSidecarPath(p) && refused.has(primaryOfSidecar(p));
      // Write order inside an asset: its sidecars, then its files, then — LAST — an own sidecar (below). An own sidecar
      // is an OVERWRITE of the healed one, which a put-back cannot undo by trashing: trashed, the refused file would be
      // left bare and the heal would mint it yet another GUID (close-out re-review). Its file is on disk already, so
      // the sidecar-first ordering buys nothing for it, and going last means it is written only once the rest landed.
      const rank = (p: string) => (isOwnSidecar(p) ? 2 : isSidecarPath(p) ? 0 : 1);
      // Hashed BEFORE the first write of the whole undo — every candidate, once: the put-back below needs them, and a
      // hash that throws after a write would refuse a step that had already written (`expectedHash` throws a refusal:
      // "nothing was applied").
      const hashes = await ifMatchOf([...new Map(results.flatMap((r) => r.snapshots).filter((s) => inTrash.has(s.path)).map((s) => [s.path, s] as const)).values()]);
      for (const r of results) {
        // ⚠️ Filtered HERE, per asset, not once up front (close-out re-review): results can SHARE paths — a folder
        // delete lists a model with its generated files, and each generated file as an asset of its own — and a path an
        // earlier asset just restored must drop out of the later one's list, or the later one collides with it, reads
        // it as somebody else's file, and drops itself whole.
        const todo = r.snapshots.filter((s) => inTrash.has(s.path)).sort((a, b) => rank(a.path) - rank(b.path));
        if (todo.length === 0) continue;
        const wrote: Snapshot[] = [];
        let stopped: { path: string; collided: boolean } | null = null;
        for (const s of todo) {
          const ownSidecar = isOwnSidecar(s.path);
          const w = ownSidecar
            ? await writeAssetFile(s.path, s.content, s.encoding).then((o) => (o.ok ? { result: 'ok' as const } : { result: 'failed' as const, error: o.error }))
            : await writeAssetFileGuarded(s.path, s.content, { encoding: s.encoding, createOnly: true });
          if (w.result === 'ok') wrote.push(s);
          else {
            if (w.result === 'failed') refusals.push(`${s.path} (${w.error})`);
            stopped = { path: s.path, collided: w.result === 'conflict' };
            break;
          }
        }
        if (stopped === null) {
          for (const s of wrote) { inTrash.delete(s.path); onDisk.add(s.path); restoredPaths.push(s.path); }
          continue;
        }
        if (stopped.collided) {
          // The asset is not this entry's any more, all of it: dropped from `refused` too, or the next redo would retry
          // trashing its refused file and the undo after that would restore the file without its sidecar.
          occupied.push(stopped.path);
          for (const p of r.deletePaths) { inTrash.delete(p); refused.delete(p); }
        }
        if (wrote.length > 0) {
          const back = await deleteAssetFiles(wrote.map((s) => s.path), { ifMatch: Object.fromEntries(wrote.map((s) => [s.path, hashes[s.path]])) });
          if (!back.ok || back.failed.length > 0) {
            // Could not take them back: they are on disk with this entry's bytes, so they are its to trash on redo.
            for (const s of wrote) {
              if (!back.ok || back.failed.includes(s.path)) { inTrash.delete(s.path); onDisk.add(s.path); restoredPaths.push(s.path); unrolled.push(s.path); }
            }
          }
        }
      }
      // An undo that restores only SOME of what it trashed is a false success: the panel
      // refreshes, files reappear, and the ones whose snapshot read failed stay in the OS
      // trash with nothing naming them (#291). So report the SHORTFALL, which covers the
      // total case (nothing restorable) and the partial case in one check — the total case
      // used to be a console.warn and the partial case was not reported at all.
      //
      // Measured against what the backend ACTUALLY trashed, not against deletePaths:
      // deletionPathsFor deliberately lists maybe-absent sidecars (`.meta.local.json` is
      // gitignored and usually not on disk), so a deletePaths-based diff would name files
      // that never existed and send the user hunting in the trash for them.
      // Through `reportUndoFailure` (#1823), so the step's result carries it: it was a bare console line, and the agent's
      // undo answered `did:true` over files still in the trash.
      const lost = Array.from(inTrash);
      if (lost.length > 0) {
        reportUndoFailure({
          direction: 'Undo', label,
          detail: `restored ${restoredPaths.length} of ${restoredPaths.length + lost.length} file(s). ` +
            `Still in the trash, recover by hand: ${lost.join(', ')}` + (refusals.length ? `. Refused: ${refusals.join('; ')}` : ''),
        });
      }
      if (unrolled.length > 0 && occupied.length === 0) {
        // A write failed part-way and the put-back failed too: half an asset is on disk. Say which files, because the
        // console shortfall above counts them as restored.
        reportUndoFailure({ direction: 'Undo', label, detail: `an asset was only partly restored (a write failed${refusals.length ? `: ${refusals.join('; ')}` : ''}), and these could not be taken back: ${unrolled.join(', ')}` });
      }
      if (occupied.length > 0) {
        // Not restored, and left alone from here on: the file at that path is somebody else's (#1679).
        reportUndoFailure({
          direction: 'Undo', label, userFixable: true,
          detail: `not restored, because another file is now at ${occupied.join(', ')} — that asset is still in the trash, and the file at its path was left as it is` +
            // The partial branch above is skipped when something collided, so the write failure's reason is said here.
            (unrolled.length ? `. These were restored (a write failed${refusals.length ? `: ${refusals.join('; ')}` : ''}) and could not be taken back: ${unrolled.join(', ')}` : ''),
        });
      }
      // The files that came back are told to the renderer in this step (#1844, #1834): its manifest pruned their guids at
      // the delete, and the restore went through `/api/write-file`, which rebuilds nothing — an undo walked straight on
      // (an agent's back-to-back undos, two quick Cmd+Z) met a guid that resolved to nothing. Own sidecars too: they put
      // the snapshot's GUID back over the heal's.
      const told = await reannounceRestoredFiles(restoredPaths);
      if (!told.ok) reportUndoFailure({ direction: 'Undo', label, detail: `restored, but the editor's asset index was not refreshed (${told.error}); it catches up at the next file-watcher update` });
      // Refresh even on a partial restore — the files that DID come back must appear.
      refresh();
    },
    redo: async () => {
      // Re-delete in ONE trash call (same as the original delete): what the last undo restored, plus any path the OS
      // refused last time, which is the whole point of retrying. Never a path the undo did not put back (#1679).
      //
      // ⚠️ Each FILE only while it holds the snapshot's bytes — an edit made to a restored file since is the user's,
      // and one mismatch trashes nothing at all (`fileChangedRefusal`). A retried refusal has a snapshot too: taken
      // at the delete, so an edit made after the OS refused it is protected the same way. SIDECARS ride with their
      // file and carry no BYTE hash: the scanner and the bakes rewrite both halves on their own, so a hash would refuse
      // redo for nothing. The committed half carries a SETTINGS precondition instead (#1696, below).
      const retried = Array.from(refused).filter((p) => snapshotOf.has(p) && !onDisk.has(p));
      // A retried file takes its sidecars along: the one on disk is the heal's (this entry's snapshot of it went to the
      // trash with the delete), and left behind it would be an orphan the next undo's restore collides with — dropping
      // the whole asset (close-out re-review). They ride unhashed, like every sidecar; a missing one is skipped.
      const riders = retried.filter((p) => !isSidecarPath(p)).flatMap((p) => [`${p}.meta.json`, `${p}.meta.local.json`]);
      const allPaths = [...new Set([...onDisk, ...retried, ...riders])];
      if (allPaths.length === 0) { refresh(); return; }
      const guarded = allPaths.map((p) => snapshotOf.get(p)).filter((s): s is Snapshot => s !== undefined && !isSidecarPath(s.path));
      // A committed sidecar the last undo restored carries its SETTINGS as a precondition (#1696): for a binary it is
      // where the import settings live, so one edited since is the user's. Only one this entry wrote back (`onDisk`) —
      // a retry's rider is the heal's, not ours, and rides unguarded.
      const ifSettings = settingsExpectations([...onDisk].map((p) => [p, snapshotDoc(snapshotOf.get(p))] as const));
      const res = await deleteAssetFiles(allPaths, { ifMatch: await ifMatchOf(guarded), ifSettings });
      if (res.conflicts?.length) throw fileChangedRefusal(res.conflicts);
      // Same false-success shape on the other half: a failed re-delete left the files on
      // disk, refresh() re-listed them, and redo read as a no-op (#291).
      // Reported into the step (#1823), not only to the console.
      if (!res.ok) {
        reportUndoFailure({ direction: 'Redo', label, detail: `nothing was trashed${because(res)} — the files are still on disk: ${allPaths.join(', ')}` });
      } else if (res.failed.length > 0) {
        // ⚠️ A PARTIAL refusal is `ok:true`, so the check above cannot see it — the very defect
        // #884 fixed in `executeDeletion`, left standing on this half until the close-out review
        // found it. Silent here means the redo re-lists the refused file and reads as a no-op.
        reportUndoFailure({ direction: 'Redo', label, detail: `the OS refused to trash: ${res.failed.join(', ')}` });
      }
      // ⚠️ Only on a SUCCESSFUL redo, and only the `failed` half. On `!res.ok` the redo deleted
      // nothing — `deleteAssetFiles` answers `{ok:false, missing:[], failed:[]}` for a non-2xx and
      // for a transport throw alike — so taking its empty lists would wipe the filter that a redo
      // which never ran has no business changing: the next undo would then name a never-existed
      // sidecar as "still in the trash" (#291's exact complaint) and, on win32, write a snapshot
      // back over a refused file the user may have edited since.
      if (res.ok) {
        const failed = new Set(res.failed);
        const gone = new Set(res.missing);
        for (const p of allPaths) {
          if (failed.has(p)) continue;
          onDisk.delete(p);
          // A path that was not there (a sidecar the user removed) was not trashed by this redo, so no later undo
          // may "restore" it — and neither is one this entry has no snapshot of (a rider's local stats file).
          if (!gone.has(p) && snapshotOf.has(p)) inTrash.add(p);
        }
        refused = failed;
      }
      refresh();
    },
  };
}

/** A `.meta.json` / `.meta.local.json` sidecar — it travels with its asset and carries no byte hash of its own (the
 *  committed half may carry a settings precondition, #1696 — `settingsExpectations`). */
function isSidecarPath(p: string): boolean {
  return p.endsWith('.meta.json') || p.endsWith('.meta.local.json');
}

/** The file a sidecar belongs to. */
function primaryOfSidecar(p: string): string {
  return p.replace(/\.meta(\.local)?\.json$/, '');
}

/** `/api/delete-asset`'s `ifSettings` (#1696) for committed sidecars this step expects to find: each `.meta.json`
 *  paired with the document it should still hold. A pair with no document (none was reported or snapshotted) is
 *  left out, and that sidecar rides unguarded as before. */
function settingsExpectations(pairs: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [p, doc] of pairs) if (doc && p.endsWith('.meta.json')) out[p] = doc;
  return out;
}

/** The sidecar document a text snapshot holds, or undefined when it is not a JSON object. */
function snapshotDoc(s: Snapshot | undefined): Record<string, unknown> | undefined {
  if (!s || s.encoding === 'base64') return undefined;
  try {
    const v: unknown = JSON.parse(s.content.replace(/^\uFEFF/, ''));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** `{path: sha256 of the bytes written}` for a set of snapshots this step wrote (#1679). */
async function ifMatchOf(written: ReadonlyArray<{ path: string; content: string; encoding?: 'base64' }>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const w of written) out[w.path] = await expectedHash(w.path, w.content, w.encoding);
  return out;
}

/** Build a single coalesced undo/redo for one or more completed duplicates.
 *  Undo trashes each copy (and its sidecar for binary assets); redo re-copies. */
/** ⚠️ The batch builders below track an `undone` set instead of replaying their immutable
 *  item list. The reasoning — and the two invariants that make closure-held state safe here
 *  (redo is unreachable before undo; undo actions are never serialized or cloned) — is in
 *  docs/editor.md § "An undo/redo that discards a failed filesystem op". Read it before
 *  simplifying this away: replaying the list reports a file as lost when it is sitting
 *  exactly where the user wanted it. */
export function makeDuplicateUndo(results: DupResult[], refresh: () => void): UndoAction {
  const label = results.length > 1 ? `Duplicate ${results.length} items` : `Duplicate ${results[0].asset.name}`;
  // Copies currently NOT on disk (undo trashed them). Empty to start: the forward
  // duplicate just created every one of them.
  const undone = new Set<string>();
  // The bytes each copy holds as this entry last wrote it — re-read from every redo, since a JSON copy is re-minted.
  const shaOf = new Map(results.map((r) => [r.toPath, r.sha256] as const));
  // And the committed sidecar each binary copy got (#1696), for `trashCopies`' settings precondition.
  const sidecarOf = new Map(results.map((r) => [r.toPath, r.sidecar] as const));
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      const copies = results.filter(({ toPath }) => !undone.has(toPath)).map(({ toPath }) => toPath);
      const trashed = await trashCopies(copies, shaOf, sidecarOf);
      const deleted = trashed.trashed; // primary files actually trashed — safe to unbind
      const failed = copies.filter((p) => !deleted.includes(p));
      for (const p of deleted) undone.add(p);
      // The copy can be OPEN by now (duplicate → double-click the copy → ⌘Z), and a bound
      // editor would autosave it straight back (#186). makeDeleteUndo's `redo` needs no
      // such call: the forward delete already unbound, and `undo` restores the file
      // without restoring the binding, so nothing is bound when it re-trashes. Only the
      // copies that actually got trashed are unbound — one still on disk is still a live file.
      unbindDeletedAssetEditors(deleted);
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Undo', label, detail: `still on disk, not trashed${trashed.error ? ` (${trashed.error})` : ''}: ${failed.join(', ')}` });
      }
      refresh();
    },
    redo: async () => {
      const failed: string[] = [];
      for (const { asset, toPath } of results) {
        if (!undone.has(toPath)) continue; // the copy is still on disk — nothing to redo
        // The route refuses a destination that is already occupied (409 "Destination exists"), so a redo never
        // lands on a file made at that path since — that half needed no new precondition.
        const r = await duplicateAssetFileReport(asset.path, toPath);
        if (r.ok) { undone.delete(toPath); shaOf.set(toPath, r.sha256); sidecarOf.set(toPath, r.sidecar); } else failed.push(`${toPath}${because(r)}`);
      }
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Redo', label, detail: `not re-copied: ${failed.join(', ')}` });
      }
      refresh();
    },
  };
}

/** Trash the copies a Duplicate or a copy-Paste made, in ONE request, each only while it holds the bytes the route
 *  reported writing (#1679) — a copy edited since (duplicate → open the copy → edit → save → Cmd+Z) is the user's
 *  work now. One mismatch trashes nothing and REFUSES the step (`fileChangedRefusal`, the #1664 shape), so there is
 *  no half-undone batch to describe. Resolves to the copies actually trashed, and the route's reason when it refused
 *  the request (#1824).
 *
 *  Drops BOTH halves of each copy's sidecar pair: the committed `.meta.json` (import settings + the GUID the copy
 *  created) and the gitignored machine-local `.meta.local.json` (byte stats) — dropping only the committed half left
 *  the local one on disk after every undone duplicate (QA-CTX-0005). They ride in the same request, so a refusal
 *  keeps them too: never an orphan sidecar, never a GUID-less copy. They carry no byte hash (the scanner rewrites both
 *  on its own), and the route skips one that is not there, so a missing sidecar is never reported as a failure.
 *
 *  The committed `.meta.json` carries a SETTINGS precondition instead (#1696): it is where a binary's import settings
 *  live, so an import-settings edit to the copy, saved since, refuses the step like an edit to the file does. The
 *  expectation is the sidecar the route reported writing (`sidecarOf`); a copy with none reported rides as before. */
async function trashCopies(
  copies: string[], shaOf: ReadonlyMap<string, string | undefined>,
  sidecarOf: ReadonlyMap<string, Record<string, unknown> | undefined>,
): Promise<{ trashed: string[]; error?: string }> {
  if (copies.length === 0) return { trashed: [] };
  const unknown = copies.filter((p) => shaOf.get(p) === undefined);
  if (unknown.length > 0) {
    throw new UndoRefusedError(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'was' : 'were'} not trashed: the copy's contents were never reported, so it cannot be told apart from an edit made since.`,
      `${unknown.length === 1 ? unknown[0].split('/').pop() : `${unknown.length} copies`} could not be checked, and ${unknown.length === 1 ? 'was' : 'were'} left as ${unknown.length === 1 ? 'it is' : 'they are'}`,
    );
  }
  const paths = copies.flatMap((p) => (isTextAsset(p) ? [p] : [p, p + '.meta.json', p + '.meta.local.json']));
  const ifMatch = Object.fromEntries(copies.map((p) => [p, shaOf.get(p) as string]));
  const ifSettings = settingsExpectations(copies.filter((p) => !isTextAsset(p)).map((p) => [`${p}.meta.json`, sidecarOf.get(p)]));
  const res = await deleteAssetFiles(paths, { ifMatch, ifSettings });
  if (res.conflicts?.length) throw fileChangedRefusal(res.conflicts);
  if (!res.ok) return { trashed: [], ...(res.error ? { error: res.error } : {}) };
  const failed = new Set(res.failed);
  return { trashed: copies.filter((p) => !failed.has(p)) };
}

/** A single rename's move found its destination TAKEN (409): refused, naming the path, before anything moved (#1795, hub
 *  review). Create Prefab's undo keeps its file (ruling (i), Unity), so a prefab made at the name a rename freed now
 *  holds that path when the rename is undone; any file made there since does the same. It was a report that kept the
 *  entry, so the next redo tried the OTHER file's path; a refusal drops the entry (#310), never overwrites, and says
 *  which file is in the way. A multi-file move (a paste, a drop) keeps its per-file report: partial progress there is
 *  useful (`makeDeleteUndo`'s reasoning). */
function destinationTakenRefusal(what: string, to: string): UndoRefusedError {
  // The cause named only where it can be it: a prefab path (close-out review — "a prefab Create Prefab made" read as the
  // reason for a PNG). The toast says the step is gone, since a refusal drops it: "try again" pointed Cmd+Z at the step
  // BELOW it.
  const why = to.endsWith('.prefab.json') ? ' — a prefab Create Prefab made at that name is kept by its undo' : '';
  return new UndoRefusedError(
    `${what} was not moved: another file now holds "${to}" (made there since${why}). Nothing was moved.`,
    `"${to.split('/').pop()}" is taken by another file now, so nothing was moved and this step was dropped — rename it by hand if you still want it`,
  );
}

/** Build the undo/redo for a single-asset rename (Assets.tsx `handleRename`, #308). The
 *  forward rename already happened by the time this is pushed; `undo`/`redo` each move the
 *  file back/forward and only remap the asset-editor binding when the move actually landed —
 *  repointing a binding at a path the file is NOT at is the forking bug #186 exists to avoid.
 *  A failed move (of either direction) is reported via `reportUndoFailure`, toasting only on
 *  the 409 collision case (something now occupies the path we're moving back/forward to). */
export function makeRenameUndo(params: {
  originalPath: string;
  originalName: string;
  toPath: string;
  newName: string;
  refresh: () => void;
}): UndoAction {
  const { originalPath, originalName, toPath, newName, refresh } = params;
  const label = `Rename ${originalName}`;
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      const moved = await moveAsset(toPath, originalPath);
      if (!moved.ok && moved.status === COLLISION_STATUS) { refresh(); throw destinationTakenRefusal(`"${toPath}"`, originalPath); }
      if (moved.ok) {
        applyAssetPathMoves([{ from: toPath, to: originalPath, name: originalName }]);
      } else {
        reportUndoFailure({
          direction: 'Undo', label,
          detail: `"${toPath}" did not move back to "${originalPath}"${because(moved)}`,
        });
      }
      refresh();
    },
    redo: async () => {
      const moved = await moveAsset(originalPath, toPath);
      if (!moved.ok && moved.status === COLLISION_STATUS) { refresh(); throw destinationTakenRefusal(`"${originalPath}"`, toPath); }
      if (moved.ok) {
        applyAssetPathMoves([{ from: originalPath, to: toPath, name: newName }]);
      } else {
        reportUndoFailure({
          direction: 'Redo', label,
          detail: `"${originalPath}" did not move to "${toPath}"${because(moved)}`,
        });
      }
      refresh();
    },
  };
}

/** Undo/redo for deleting an EMPTY folder (Assets.tsx `handleDeleteFolder`'s `else` branch,
 *  #308) — the folder held no assets, so there is nothing to snapshot; undo just recreates
 *  the (empty) folder shell and redo re-trashes it. Neither `createAssetFolder` nor
 *  `trashEmptyFolder` distinguishes a collision from any other failure, so this is never
 *  `userFixable`; the report names the route's reason (#1824). */
export function makeEmptyFolderDeleteUndo(params: {
  folderPath: string;
  folderName: string;
  refresh: () => void;
}): UndoAction {
  const { folderPath, folderName, refresh } = params;
  const label = `Delete folder ${folderName}`;
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      const made = await createAssetFolder(folderPath);
      if (!made.ok) reportUndoFailure({ direction: 'Undo', label, detail: `folder "${folderPath}" was not recreated${because(made)}` });
      refresh();
    },
    redo: async () => {
      // Only while it is still EMPTY (#1679): the undo recreated a shell, and whatever was put in it since is not
      // this entry's to trash. A refusal leaves the folder and everything in it (`fileChangedRefusal`).
      const trashed = await trashEmptyFolder(folderPath);
      if (!trashed.ok) reportUndoFailure({ direction: 'Redo', label, detail: `folder "${folderPath}" was not removed${because(trashed)}` });
      refresh();
    },
  };
}

/** Trash a folder this entry created, only while it holds nothing but OS litter (`ifEmpty`, #1679). A folder with
 *  anything in it REFUSES the step (`fileChangedRefusal`) and stays, contents and all. A plain failure answers
 *  `ok:false` with the route's reason, for the caller's #308 report (#1824). */
async function trashEmptyFolder(folderPath: string): Promise<{ ok: boolean; error?: string }> {
  const res = await deleteAssetFiles([folderPath], { ifEmpty: [folderPath] });
  if (res.conflicts?.length) throw fileChangedRefusal(res.conflicts);
  if (!res.ok) return { ok: false, error: res.error };
  return res.failed.length === 0 ? { ok: true } : { ok: false, error: 'the OS refused to trash it' };
}

/** Undo/redo for the "New Folder" action (Assets.tsx `createFolder`, #308 — found in
 *  re-verification, not in the original issue text). `setPendingFolders` only runs on
 *  success: an unconditional update here would desync the client's folder tree from disk
 *  exactly like `commitFolderRename`'s bug (below) — the folder would appear/vanish in the
 *  panel while the filesystem disagreed.
 *
 *  #309: undo prunes `expanded` as well, because UNDOING A CREATE IS A FOLDER DELETE and
 *  `handleDeleteFolder` prunes both sets — this was the one folder-removal path that did not.
 *  Redo deliberately does NOT re-add the key: the forward `createFolder` never put it there.
 *  Full reasoning: docs/editor.md § "Undoable panel state cannot live in useState". */
export function makeNewFolderUndo(params: {
  path: string;
  refresh: () => void;
  setPendingFolders: (updater: (prev: Set<string>) => Set<string>) => void;
  setExpanded: (updater: (prev: Set<string>) => Set<string>) => void;
}): UndoAction {
  const { path, refresh, setPendingFolders, setExpanded } = params;
  const label = 'New Folder';
  // Drop the folder's own key AND anything beneath it — same shape as handleDeleteFolder's
  // `prune`. A freshly-created folder is empty, so the subtree case is defensive rather than
  // reachable today; it costs nothing and stops this diverging from the delete path again.
  const prune = (set: Set<string>) => {
    const n = new Set<string>();
    for (const x of set) if (x !== path && !x.startsWith(path + '/')) n.add(x);
    return n;
  };
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      // Only while it is still EMPTY (#1679): New Folder → drop files into it (Finder, or a copy that is not its own
      // undo entry) → Cmd+Z here used to trash the folder with them inside.
      const trashed = await trashEmptyFolder(path);
      if (trashed.ok) { setPendingFolders(prune); setExpanded(prune); }
      else reportUndoFailure({ direction: 'Undo', label, detail: `folder "${path}" still exists on disk${because(trashed)}` });
      refresh();
    },
    redo: async () => {
      const made = await createAssetFolder(path);
      if (made.ok) setPendingFolders((p) => new Set(p).add(path));
      else reportUndoFailure({ direction: 'Redo', label, detail: `folder "${path}" was not recreated${because(made)}` });
      refresh();
    },
  };
}

/** Undo/redo for a folder rename (Assets.tsx `commitFolderRename`, #308 — the worst site:
 *  `setPendingFolders` used to run UNCONDITIONALLY, so a failed undo/redo remapped the
 *  client's folder tree while the folder stayed physically at the other path — an active
 *  desync, not a no-op. Both `setPendingFolders` and `setExpanded` now gate on the move
 *  actually landing. `setExpanded` was previously never remapped by undo/redo at all (only
 *  the forward rename remapped it) — fixed here to match, closing that asymmetry too. */
export function makeFolderRenameUndo(params: {
  oldPath: string;
  newPath: string;
  folderName: string;
  refresh: () => void;
}): UndoAction {
  const { oldPath, newPath, folderName, refresh } = params;
  const label = `Rename folder ${folderName}`;
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      const moved = await moveAsset(newPath, oldPath);
      if (!moved.ok && moved.status === COLLISION_STATUS) { refresh(); throw destinationTakenRefusal(`folder "${newPath}"`, oldPath); }
      if (moved.ok) {
        // (`expanded`/`pendingFolders` are remapped by applyAssetPathMoves itself now — #867.)
        applyAssetPathMoves([{ from: newPath, to: oldPath, prefix: true }]);
      } else {
        reportUndoFailure({
          direction: 'Undo', label,
          detail: `folder "${newPath}" did not move back to "${oldPath}"${because(moved)}`,
        });
      }
      refresh();
    },
    redo: async () => {
      const moved = await moveAsset(oldPath, newPath);
      if (!moved.ok && moved.status === COLLISION_STATUS) { refresh(); throw destinationTakenRefusal(`folder "${oldPath}"`, newPath); }
      if (moved.ok) {
        applyAssetPathMoves([{ from: oldPath, to: newPath, prefix: true }]);
      } else {
        reportUndoFailure({
          direction: 'Redo', label,
          detail: `folder "${oldPath}" did not move to "${newPath}"${because(moved)}`,
        });
      }
      refresh();
    },
  };
}

/** One item a cut/copy paste moved or copied — the panel's own destination-collision
 *  planning already happened, so `from`/`to` are the exact paths that landed. */
/** `sha256`: for a copy-paste, the copy's bytes as the route wrote them (`DupResult.sha256`, #1679). */
export type PasteMove = { from: string; to: string; sha256?: string; sidecar?: Record<string, unknown> };

/** Undo/redo for `pasteClipboard` (Assets.tsx, #308). The forward loop already skips any
 *  item whose move/copy failed (`done` only holds what actually landed) — this only needs to
 *  handle the REVERSE direction failing, which the old closures silently dropped one item at
 *  a time. Failures are collected and reported as ONE message naming every skipped path,
 *  not one console line per item. Only the cut branch can collide (`moveAsset`); the
 *  copy branch refuses a copy edited since instead (`trashCopies`, #1679). */
export function makePasteUndo(params: {
  op: 'cut' | 'copy';
  done: PasteMove[];
  refresh: () => void;
}): UndoAction {
  const { op, done, refresh } = params;
  const label = `${op === 'cut' ? 'Move' : 'Paste'} ${done.length} item(s)`;
  // Items currently in the UNDONE state — moved back to `from` (cut), or trashed (copy).
  // See the note above makeDuplicateUndo for why replaying the whole list is wrong.
  const undone = new Set<string>();
  // A copy-paste's copies, as makeDuplicateUndo's `shaOf` (#1679). Unused by a cut: a move destroys no bytes.
  const shaOf = new Map(done.map((m) => [m.to, m.sha256] as const));
  const sidecarOf = new Map(done.map((m) => [m.to, m.sidecar] as const));
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      const back: PathMove[] = [];
      // Named for what it is, NOT `undone` — that name belongs to the builder-scope Set
      // above, and a local of the same name here SHADOWS it: the state tracking silently
      // reads and writes an array instead, which is a TypeError at runtime and a compile
      // error only because `string[]` has no `.has`. Keep these two distinct.
      const deletedCopies: string[] = []; // primary copies actually trashed — safe to unbind
      const failed: string[] = [];
      const copies: string[] = [];
      let collision = false;
      for (const { from, to } of done) {
        if (undone.has(to)) continue; // already undone by an earlier partial pass
        if (op === 'cut') {
          const moved = await moveAsset(to, from);
          if (moved.ok) { back.push({ from: to, to: from }); undone.add(to); }
          else { failed.push(`${to} → ${from}${because(moved)}`); if (moved.status === COLLISION_STATUS) collision = true; }
        } else {
          copies.push(to);
        }
      }
      // The copies go in ONE guarded request, sidecars included — `trashCopies`, shared with makeDuplicateUndo (#1679).
      if (copies.length > 0) {
        const trashed = await trashCopies(copies, shaOf, sidecarOf);
        for (const to of copies) {
          if (trashed.trashed.includes(to)) { undone.add(to); deletedCopies.push(to); } else failed.push(`${to}${trashed.error ? ` (${trashed.error})` : ''}`);
        }
      }
      if (op === 'cut') applyAssetPathMoves(back);
      else unbindDeletedAssetEditors(deletedCopies);
      if (failed.length > 0) {
        reportUndoFailure({
          direction: 'Undo', label, userFixable: collision,
          detail: `not ${op === 'cut' ? 'moved back' : 'removed'}: ${failed.join(', ')}`,
        });
      }
      refresh();
    },
    redo: async () => {
      const fwd: PathMove[] = [];
      const failed: string[] = [];
      let collision = false;
      for (const { from, to } of done) {
        if (!undone.has(to)) continue; // already in the redone state — nothing to move/copy
        if (op === 'cut') {
          const moved = await moveAsset(from, to);
          if (moved.ok) { fwd.push({ from, to }); undone.delete(to); }
          else { failed.push(`${from} → ${to}${because(moved)}`); if (moved.status === COLLISION_STATUS) collision = true; }
        } else {
          const r = await duplicateAssetFileReport(from, to);
          if (r.ok) { undone.delete(to); shaOf.set(to, r.sha256); sidecarOf.set(to, r.sidecar); } else failed.push(`${from} → ${to}${because(r)}`);
        }
      }
      if (op === 'cut') applyAssetPathMoves(fwd);
      if (failed.length > 0) {
        reportUndoFailure({
          direction: 'Redo', label, userFixable: collision,
          detail: `not ${op === 'cut' ? 'moved' : 'copied'}: ${failed.join(', ')}`,
        });
      }
      refresh();
    },
  };
}

/** One item a drag-drop move landed on (Assets.tsx `handleFilesDrop`). `to`/`from` are
 *  explicit full paths (already resolved by the panel's folder-relative `moveFile`), so
 *  undo/redo can call `moveAsset` directly without recomputing a destination folder.
 *
 *  ⚠️ `prefix` travels with the move in BOTH directions (#867). It marks the moved thing as a
 *  FOLDER, so the repair reaches everything under it; a folder drag whose undo dropped the flag
 *  would leave the descendants unrepaired on the way back, which is the same bug pointing the
 *  other way. Reversing a prefix move is still a prefix move — only `from`/`to` swap. */
export type DropMove = { from: string; to: string; prefix?: boolean };

/** Undo/redo for `handleFilesDrop` (Assets.tsx, #308) — same skip-every-item shape as
 *  `makePasteUndo`'s cut branch, and the same fix: collect every move that failed in either
 *  direction and report it as one message, toasting only when the backend actually reported
 *  a 409 collision. */
export function makeFilesDropUndo(params: {
  moves: DropMove[];
  refresh: () => void;
}): UndoAction {
  const { moves, refresh } = params;
  const label = moves.length > 1 ? `Move ${moves.length} items` : `Move "${moves[0].from.split('/').pop()}"`;
  // Items currently moved back to `from`. See the note above makeDuplicateUndo.
  const undone = new Set<string>();
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    undo: async () => {
      const back: PathMove[] = [];
      const failed: string[] = [];
      let collision = false;
      for (const m of moves) {
        if (undone.has(m.to)) continue; // already moved back by an earlier partial pass
        const moved = await moveAsset(m.to, m.from);
        if (moved.ok) { back.push({ from: m.to, to: m.from, prefix: m.prefix }); undone.add(m.to); }
        else { failed.push(`${m.to} → ${m.from}${because(moved)}`); if (moved.status === COLLISION_STATUS) collision = true; }
      }
      applyAssetPathMoves(back);
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Undo', label, userFixable: collision, detail: `not moved back: ${failed.join(', ')}` });
      }
      refresh();
    },
    redo: async () => {
      const fwd: PathMove[] = [];
      const failed: string[] = [];
      let collision = false;
      for (const m of moves) {
        if (!undone.has(m.to)) continue; // already at its destination — nothing to move
        const moved = await moveAsset(m.from, m.to);
        if (moved.ok) { fwd.push({ from: m.from, to: m.to, prefix: m.prefix }); undone.delete(m.to); }
        else { failed.push(`${m.from} → ${m.to}${because(moved)}`); if (moved.status === COLLISION_STATUS) collision = true; }
      }
      applyAssetPathMoves(fwd);
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Redo', label, userFixable: collision, detail: `not moved: ${failed.join(', ')}` });
      }
      refresh();
    },
  };
}

/** Undo/redo for `importModelWithMeta` (Assets.tsx, module-scope, #308 follow-up A —
 *  found in re-verification after the original sweep, not in the issue text). The
 *  forward path already writes the prefab before this is built, so undo trashes it and
 *  redo re-writes it; both directions used to discard the boolean. A plain failure is
 *  console-only (never `userFixable`); a changed file refuses the step (#1679, below). */
export function makeModelImportUndo(params: {
  assetName: string;
  prefabPath: string;
  content: string;
  /** What the prefab path held BEFORE the import: absent for a fresh create; the bytes for a RE-import over an
   *  existing prefab (it keeps that prefab's id, #1468). A re-import's undo RESTORES those bytes rather than trashing
   *  the file — trashing it is how #1264 lost a replaced prefab, and the same shape was left standing here (#1679
   *  close-out sweep). An unreadable prior refuses the import itself now (#1692), so there is no third case. */
  previousContent?: string;
  onDone?: () => void;
}): UndoAction {
  const { assetName, prefabPath, content, previousContent, onDone } = params;
  const label = `Import Model "${assetName}"`;
  const replaced = previousContent !== undefined;
  // Whether `content` is on disk as this entry left it — false once an undo landed. An undo that reported a failure
  // left it there, so the redo after it must expect `content`, not what the undo would have put back.
  let onDisk = true;
  return {
    label,
    // A FILE's edit (#1857) that also rebuilds the live frames placed from it: one `commitPrefabWrite` per half.
    _isFileDirect: true, _rebasesLiveFrames: true,
    // ⚠️ Both halves carry a PRECONDITION (#1679): undo changes the prefab only while it holds the imported bytes
    // (import → open the prefab → edit → Cmd+S → Cmd+Z used to trash that save), redo only while it holds what the undo
    // left. Either miss REFUSES before anything moved (`fileChangedRefusal`). Same call as Create Prefab's.
    // Each half is ONE `commitPrefabWrite` (#1692): both caches follow the file, and the instances placed from the
    // prefab are rebuilt from whatever it holds now.
    undo: async () => {
      const w = await commitPrefabWrite(prefabPath, replaced ? parsePrefabBytes(previousContent!) : null, {
        expected: content, ...(replaced ? { bytes: previousContent! } : {}),
      });
      if (w.conflict) throw fileChangedRefusal([prefabPath]);
      if (w.ok) onDisk = false;
      else reportUndoFailure({ direction: 'Undo', label, detail: `prefab "${prefabPath}" was not ${replaced ? 'restored' : 'trashed'}: ${w.error ?? 'the write failed'}` });
      onDone?.();
    },
    redo: async () => {
      const w = await commitPrefabWrite(prefabPath, parsePrefabBytes(content), {
        expected: onDisk ? content : replaced ? previousContent! : null, bytes: content,
      });
      if (w.conflict) throw fileChangedRefusal([prefabPath]);
      if (w.ok) onDisk = true;
      else reportUndoFailure({ direction: 'Redo', label, detail: `prefab "${prefabPath}" was not recreated: ${w.error ?? 'the write failed'}` });
      onDone?.();
    },
  };
}

/** One file `importFiles` (Assets.tsx) wrote to disk — content is base64 so redo can
 *  re-write it byte-for-byte. `sha256`, when set, is the hash of what the file holds once the import SETTLED
 *  (`settledHashes`), which is what the undo's precondition expects instead of the written bytes (#1679). */
export type ImportedFile = { path: string; content: string; sha256?: string };

/** The hash of each TEXT file among `paths` as it stands once the scanner has had its say (#1679). The scanner
 *  rewrites an imported JSON asset on its own when it has no `id`, or one another asset already holds (the GUID heal),
 *  so the bytes an import wrote are not the bytes on disk a moment later — and an undo expecting the written bytes
 *  would refuse, calling the scanner's stamp an edit. `/api/rescan-assets` runs that heal INLINE, so the read after it
 *  is the settled file. A binary is never rewritten in place (every importer writes to the cache or a sibling), so
 *  it is not read back: its written bytes are the baseline. A read that fails leaves the path out, and the caller
 *  falls back to the written bytes — a refusal later, never an unguarded trash. */
export async function settledHashes(paths: readonly string[], opts: { rescanned?: boolean } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = paths.filter(isTextAsset);
  if (text.length === 0) return out;
  // `rescanned`: the caller's own rescan just ran the heal (`reannounceRestoredFiles`), so a second full scan buys nothing.
  if (!opts.rescanned) { try { await backendFetch('/api/rescan-assets', { method: 'POST' }); } catch { return out; } }
  for (const p of text) {
    try {
      // The BYTES, not `res.text()`: decoding replaces invalid UTF-8 with U+FFFD, so a Latin-1 or UTF-16 text file got
      // a baseline no route hash could match, and its undo always refused (close-out review).
      const res = await fetch(p, { cache: 'no-store' });
      if (res.ok) out.set(p, await sha256OfBytes(new Uint8Array(await res.arrayBuffer())));
    } catch { /* fall back to the written bytes */ }
  }
  return out;
}

/** Undo/redo for `importFiles`'s OS-file-drop import (Assets.tsx, #308 follow-up B).
 *  Same skip-every-item shape as `makePasteUndo`/`makeFilesDropUndo`: every result in
 *  both loops used to be discarded, and undo unbound ALL N imported files regardless of
 *  which deletes actually landed — a file whose delete failed is still on disk, so its
 *  editor binding (if any) is still valid and must not be dropped. Only the files that
 *  were really trashed are unbound; every failure in either direction is batch-reported
 *  as one message.
 *
 *  #1679: undo trashes the files in ONE request, each only while it holds what the import left there — one edited
 *  since REFUSES the step and nothing is trashed. Redo re-writes each only into an EMPTY path, and one it finds taken is
 *  skipped and reported (a toast: the user can clear the path), the rest landing; `onDisk` then holds exactly the
 *  files this entry wrote, so the next undo never trashes the one it skipped. Sidecars are not touched in either
 *  direction, as before: the one the forward import's conversion wrote stays through an undo, so a redo re-links to
 *  the same GUID instead of minting a new one. */
export function makeFileImportUndo(params: {
  imported: ImportedFile[];
  refresh: () => void;
}): UndoAction {
  const { imported, refresh } = params;
  const label = imported.length > 1 ? `Import ${imported.length} files` : `Import "${imported[0].path.split('/').pop()}"`;
  // path → the hash its current bytes are expected to have; present = on disk as this entry left it.
  const onDisk = new Map<string, string | undefined>(imported.map((f) => [f.path, f.sha256]));
  // path → the bytes (base64) this entry last wrote there: a redo re-decides a JSON asset's id (#1713), so they can move.
  const bytesOf = new Map<string, string>(imported.map((f) => [f.path, f.content]));
  return {
    label,
    _isFileDirect: true, // a FILE's edit, no live entity (#1857): it outlives a preview, Stop and a world switch
    // Undoing an import DELETES the files, and you can have opened one in the meantime
    // (import a .particle.json → double-click it → ⌘Z), so it unbinds like any delete.
    undo: async () => {
      const files = imported.filter((f) => onDisk.has(f.path));
      if (files.length === 0) { refresh(); return; }
      const ifMatch: Record<string, string> = {};
      for (const f of files) ifMatch[f.path] = onDisk.get(f.path) ?? await expectedHash(f.path, bytesOf.get(f.path)!, 'base64');
      const res = await deleteAssetFiles(files.map((f) => f.path), { ifMatch });
      if (res.conflicts?.length) throw fileChangedRefusal(res.conflicts);
      const failed = res.ok ? new Set(res.failed) : new Set(files.map((f) => f.path));
      const deleted = files.map((f) => f.path).filter((p) => !failed.has(p));
      for (const p of deleted) onDisk.delete(p);
      unbindDeletedAssetEditors(deleted);
      if (failed.size > 0) {
        reportUndoFailure({ direction: 'Undo', label, detail: `still on disk, not trashed${because(res)}: ${[...failed].join(', ')}` });
      }
      refresh();
    },
    redo: async () => {
      const failed: string[] = [];
      const taken: string[] = [];
      const wrote: string[] = [];
      // The id is decided AGAIN, as the forward import decided it (#1713 close-out re-review): the one this entry kept
      // can have been taken since the undo freed it (an agent import elsewhere pushes no undo, so redo stays offered),
      // and re-writing it as it was would leave two files on one id to the scanner's heal. Unchanged when still free.
      const claimed = new Set<string>();
      for (const f of imported) {
        if (onDisk.has(f.path)) continue; // still on disk from before — nothing to redo
        const bytes = await importedFileBytes(f.path, bytesOf.get(f.path)!, claimed);
        if ('error' in bytes) { failed.push(`${f.path} (${bytes.error})`); continue; }
        const content = bytes.content;
        bytesOf.set(f.path, content);
        const w = await writeAssetFileGuarded(f.path, content, { encoding: 'base64', createOnly: true });
        if (w.result === 'ok') wrote.push(f.path);
        else if (w.result === 'conflict') taken.push(f.path);
        else failed.push(`${f.path} (${w.error})`);
      }
      // The files are back where an undo trashed them, through `/api/write-file`: the renderer is told in this step (the
      // manifest from one rescan, and a refetch of an owned prefab), not left to the watcher's debounced push (#1844).
      const told = await reannounceRestoredFiles(wrote);
      if (!told.ok) reportUndoFailure({ direction: 'Redo', label, detail: `re-imported, but the editor's asset index was not refreshed (${told.error}); it catches up at the next file-watcher update` });
      // Re-take the settled baseline, for a re-written JSON the scanner may still re-stamp (one with no GUID-shaped id).
      // That rescan already ran the heal, so the read is of the settled file.
      const settled = await settledHashes(wrote, { rescanned: told.ok });
      for (const p of wrote) onDisk.set(p, settled.get(p));
      if (taken.length > 0) {
        reportUndoFailure({ direction: 'Redo', label, userFixable: true, detail: `not re-imported, because another file is now at ${taken.join(', ')} — it was left as it is` });
      }
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Redo', label, detail: `not re-imported: ${failed.join(', ')}` });
      }
      refresh();
    },
  };
}
