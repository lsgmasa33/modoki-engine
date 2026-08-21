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
import {
  writeAssetFile, deleteAssetFile, deleteAssetFiles, duplicateAssetFile,
  createFolderApi, moveFileToStatus,
} from './assetOps';
import type { AssetEntry } from '../utils/assetPaths';
import { remapPrefix } from '../utils/assetPaths';
import { unbindDeletedAssetEditors, applyAssetPathMoves, type PathMove } from './assetEditorBindings';
import { reportUndoFailure, COLLISION_STATUS } from '../undo/undoFailure';

// Extensions we know are UTF-8 text — everything else is treated as binary so
// the delete-undo snapshot round-trips bytes through base64 instead of
// fetch().text() (which silently UTF-8 corrupts binary files like .glb).
const TEXT_ASSET_EXTS = new Set(['.json', '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.svg', '.glsl']);

export function isTextAsset(p: string): boolean {
  const lower = p.toLowerCase();
  return Array.from(TEXT_ASSET_EXTS).some((ext) => lower.endsWith(ext));
}

/** One restorable file captured before a delete. */
export type Snapshot = { path: string; content: string; encoding?: 'base64' };

/** The disk effect of deleting ONE asset: undo snapshots + the flat list of
 *  paths to trash (asset + sidecar + generated files + their sidecars).
 *  `deletePaths` is what we ASKED to trash, which is deliberately a superset of
 *  what existed — see DeleteFilesResult. */
export type DeleteResult = { asset: AssetEntry; snapshots: Snapshot[]; deletePaths: string[] };

export type DupResult = { asset: AssetEntry; toPath: string };

/** Build a single coalesced undo/redo for one or more completed deletes. Undo
 *  restores the FULL snapshot set (not just the GLB) so generated mesh/mat/
 *  texture refs don't dangle; redo re-trashes the whole set in ONE call. */
export function makeDeleteUndo(results: DeleteResult[], refresh: () => void, trashedMissing: string[] = []): UndoAction {
  const label = results.length > 1 ? `Delete ${results.length} items` : `Delete ${results[0].asset.name}`;
  return {
    label,
    undo: async () => {
      const all = results.flatMap((r) => r.snapshots);
      for (const s of all) await writeAssetFile(s.path, s.content, s.encoding);
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
      const restored = new Set(all.map((s) => s.path));
      const neverExisted = new Set(trashedMissing);
      const lost = Array.from(new Set(results.flatMap((r) => r.deletePaths)))
        .filter((p) => !restored.has(p) && !neverExisted.has(p));
      if (lost.length > 0) {
        console.error(
          `[Assets] Undo of "${label}" restored ${restored.size} of ${restored.size + lost.length} file(s). ` +
          `Still in the trash, recover by hand: ${lost.join(', ')}`,
        );
      }
      // Refresh even on a partial restore — the files that DID come back must appear.
      refresh();
    },
    redo: async () => {
      // Re-delete the whole set in ONE trash call (same as the original delete).
      const allPaths = Array.from(new Set(results.flatMap((r) => r.deletePaths)));
      // Same false-success shape on the other half: a failed re-delete left the files on
      // disk, refresh() re-listed them, and redo read as a no-op (#291).
      const res = await deleteAssetFiles(allPaths);
      if (!res.ok) console.error(`[Assets] Redo of "${label}" failed — the files are still on disk: ${allPaths.join(', ')}`);
      refresh();
    },
  };
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
  return {
    label,
    undo: async () => {
      const deleted: string[] = []; // primary files actually trashed — safe to unbind
      const failed: string[] = [];
      for (const { toPath } of results) {
        if (undone.has(toPath)) continue; // already trashed by an earlier partial undo
        const ok = await deleteAssetFile(toPath);
        if (ok) { deleted.push(toPath); undone.add(toPath); } else failed.push(toPath);
        // Drop BOTH halves of the duplicate's sidecar pair: the committed `.meta.json`
        // (import settings + GUID the copy created) and the gitignored machine-local
        // `.meta.local.json` (byte stats). Dropping only the committed half left the local
        // one on disk after every undone duplicate — the QA-CTX-0005 leak, in the flow that
        // sweep did not reach. deleteAssetFile no-ops on a path that is not there, and the
        // backend can't distinguish that from a real failure — so only the PRIMARY file's
        // result is checked; a missing sidecar is never reported as a failure (matches the
        // existing best-effort comment above, now made explicit for #308).
        if (!isTextAsset(toPath)) {
          await deleteAssetFile(toPath + '.meta.json');
          await deleteAssetFile(toPath + '.meta.local.json');
        }
      }
      // The copy can be OPEN by now (duplicate → double-click the copy → ⌘Z), and a bound
      // editor would autosave it straight back (#186). makeDeleteUndo's `redo` needs no
      // such call: the forward delete already unbound, and `undo` restores the file
      // without restoring the binding, so nothing is bound when it re-trashes. Only the
      // copies that actually got trashed are unbound — one still on disk is still a live file.
      unbindDeletedAssetEditors(deleted);
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Undo', label, detail: `still on disk, not trashed: ${failed.join(', ')}` });
      }
      refresh();
    },
    redo: async () => {
      const failed: string[] = [];
      for (const { asset, toPath } of results) {
        if (!undone.has(toPath)) continue; // the copy is still on disk — nothing to redo
        const ok = await duplicateAssetFile(asset.path, toPath);
        if (ok) undone.delete(toPath); else failed.push(toPath);
      }
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Redo', label, detail: `not re-copied: ${failed.join(', ')}` });
      }
      refresh();
    },
  };
}

/** Report what an asset move/delete did to the open asset editors (#186). Silent when it
 *  touched none, which is almost always — but a binding that silently repoints or closes is
 *  how the original bug stayed invisible, so the one case that matters says so. Shared with
 *  Assets.tsx's own forward-path call sites (rescan/drop/paste) so there is one definition. */
export function logBindingChanges(notes: string[]): void {
  for (const n of notes) console.log(`[Assets] ${n}`);
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
    undo: async () => {
      const { ok, status } = await moveFileToStatus(toPath, originalPath);
      if (ok) {
        logBindingChanges(applyAssetPathMoves([{ from: toPath, to: originalPath, name: originalName }]));
      } else {
        reportUndoFailure({
          direction: 'Undo', label, userFixable: status === COLLISION_STATUS,
          detail: `"${toPath}" did not move back to "${originalPath}"`,
        });
      }
      refresh();
    },
    redo: async () => {
      const { ok, status } = await moveFileToStatus(originalPath, toPath);
      if (ok) {
        logBindingChanges(applyAssetPathMoves([{ from: originalPath, to: toPath, name: newName }]));
      } else {
        reportUndoFailure({
          direction: 'Redo', label, userFixable: status === COLLISION_STATUS,
          detail: `"${originalPath}" did not move to "${toPath}"`,
        });
      }
      refresh();
    },
  };
}

/** Undo/redo for deleting an EMPTY folder (Assets.tsx `handleDeleteFolder`'s `else` branch,
 *  #308) — the folder held no assets, so there is nothing to snapshot; undo just recreates
 *  the (empty) folder shell and redo re-trashes it. Neither `createFolderApi` nor
 *  `deleteAssetFile` distinguishes a collision from any other failure, so this is always
 *  console-only (never `userFixable`). */
export function makeEmptyFolderDeleteUndo(params: {
  folderPath: string;
  folderName: string;
  refresh: () => void;
}): UndoAction {
  const { folderPath, folderName, refresh } = params;
  const label = `Delete folder ${folderName}`;
  return {
    label,
    undo: async () => {
      const ok = await createFolderApi(folderPath);
      if (!ok) reportUndoFailure({ direction: 'Undo', label, detail: `folder "${folderPath}" was not recreated` });
      refresh();
    },
    redo: async () => {
      const ok = await deleteAssetFile(folderPath);
      if (!ok) reportUndoFailure({ direction: 'Redo', label, detail: `folder "${folderPath}" was not removed` });
      refresh();
    },
  };
}

/** Undo/redo for the "New Folder" action (Assets.tsx `createFolder`, #308 — found in
 *  re-verification, not in the original issue text). `setPendingFolders` only runs on
 *  success: an unconditional update here would desync the client's folder tree from disk
 *  exactly like `commitFolderRename`'s bug (below) — the folder would appear/vanish in the
 *  panel while the filesystem disagreed. */
export function makeNewFolderUndo(params: {
  path: string;
  refresh: () => void;
  setPendingFolders: (updater: (prev: Set<string>) => Set<string>) => void;
}): UndoAction {
  const { path, refresh, setPendingFolders } = params;
  const label = 'New Folder';
  return {
    label,
    undo: async () => {
      const ok = await deleteAssetFile(path);
      if (ok) setPendingFolders((p) => { const n = new Set(p); n.delete(path); return n; });
      else reportUndoFailure({ direction: 'Undo', label, detail: `folder "${path}" still exists on disk` });
      refresh();
    },
    redo: async () => {
      const ok = await createFolderApi(path);
      if (ok) setPendingFolders((p) => new Set(p).add(path));
      else reportUndoFailure({ direction: 'Redo', label, detail: `folder "${path}" was not recreated` });
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
  setPendingFolders: (updater: (prev: Set<string>) => Set<string>) => void;
  setExpanded: (updater: (prev: Set<string>) => Set<string>) => void;
}): UndoAction {
  const { oldPath, newPath, folderName, refresh, setPendingFolders, setExpanded } = params;
  const label = `Rename folder ${folderName}`;
  return {
    label,
    undo: async () => {
      const { ok, status } = await moveFileToStatus(newPath, oldPath);
      if (ok) {
        setPendingFolders((p) => remapPrefix(p, newPath, oldPath));
        setExpanded((p) => remapPrefix(p, newPath, oldPath));
        logBindingChanges(applyAssetPathMoves([{ from: newPath, to: oldPath, prefix: true }]));
      } else {
        reportUndoFailure({
          direction: 'Undo', label, userFixable: status === COLLISION_STATUS,
          detail: `folder "${newPath}" did not move back to "${oldPath}"`,
        });
      }
      refresh();
    },
    redo: async () => {
      const { ok, status } = await moveFileToStatus(oldPath, newPath);
      if (ok) {
        setPendingFolders((p) => remapPrefix(p, oldPath, newPath));
        setExpanded((p) => remapPrefix(p, oldPath, newPath));
        logBindingChanges(applyAssetPathMoves([{ from: oldPath, to: newPath, prefix: true }]));
      } else {
        reportUndoFailure({
          direction: 'Redo', label, userFixable: status === COLLISION_STATUS,
          detail: `folder "${oldPath}" did not move to "${newPath}"`,
        });
      }
      refresh();
    },
  };
}

/** One item a cut/copy paste moved or copied — the panel's own destination-collision
 *  planning already happened, so `from`/`to` are the exact paths that landed. */
export type PasteMove = { from: string; to: string };

/** Undo/redo for `pasteClipboard` (Assets.tsx, #308). The forward loop already skips any
 *  item whose move/copy failed (`done` only holds what actually landed) — this only needs to
 *  handle the REVERSE direction failing, which the old closures silently dropped one item at
 *  a time. Failures are collected and reported as ONE message naming every skipped path,
 *  not one console line per item. Only the cut branch can collide (`moveFileToStatus`); the
 *  copy branch's `deleteAssetFile`/`duplicateAssetFile` never distinguish a collision. */
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
  return {
    label,
    undo: async () => {
      const back: PathMove[] = [];
      // Named for what it is, NOT `undone` — that name belongs to the builder-scope Set
      // above, and a local of the same name here SHADOWS it: the state tracking silently
      // reads and writes an array instead, which is a TypeError at runtime and a compile
      // error only because `string[]` has no `.has`. Keep these two distinct.
      const deletedCopies: string[] = []; // primary copies actually trashed — safe to unbind
      const failed: string[] = [];
      let collision = false;
      for (const { from, to } of done) {
        if (undone.has(to)) continue; // already undone by an earlier partial pass
        if (op === 'cut') {
          const { ok, status } = await moveFileToStatus(to, from);
          if (ok) { back.push({ from: to, to: from }); undone.add(to); }
          else { failed.push(`${to} → ${from}`); if (status === COLLISION_STATUS) collision = true; }
        } else {
          const ok = await deleteAssetFile(to);
          if (ok) {
            undone.add(to);
            deletedCopies.push(to);
            // Both sidecar halves — the committed `.meta.json` AND the gitignored
            // `.meta.local.json` — or undoing a paste leaves the local one behind
            // forever (QA-CTX-0005). Best-effort like makeDuplicateUndo: deleteAssetFile
            // no-ops on a path that isn't there, and a missing sidecar is not itself a
            // reportable failure — only the primary file's delete is checked above.
            if (!isTextAsset(to)) { await deleteAssetFile(to + '.meta.json'); await deleteAssetFile(to + '.meta.local.json'); }
          } else {
            failed.push(to);
          }
        }
      }
      if (op === 'cut') logBindingChanges(applyAssetPathMoves(back));
      else logBindingChanges(unbindDeletedAssetEditors(deletedCopies));
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
          const { ok, status } = await moveFileToStatus(from, to);
          if (ok) { fwd.push({ from, to }); undone.delete(to); }
          else { failed.push(`${from} → ${to}`); if (status === COLLISION_STATUS) collision = true; }
        } else {
          const ok = await duplicateAssetFile(from, to);
          if (ok) undone.delete(to); else failed.push(`${from} → ${to}`);
        }
      }
      if (op === 'cut') logBindingChanges(applyAssetPathMoves(fwd));
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
 *  undo/redo can call `moveFileToStatus` directly without recomputing a destination folder. */
export type DropMove = { from: string; to: string };

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
    undo: async () => {
      const back: PathMove[] = [];
      const failed: string[] = [];
      let collision = false;
      for (const m of moves) {
        if (undone.has(m.to)) continue; // already moved back by an earlier partial pass
        const { ok, status } = await moveFileToStatus(m.to, m.from);
        if (ok) { back.push({ from: m.to, to: m.from }); undone.add(m.to); }
        else { failed.push(`${m.to} → ${m.from}`); if (status === COLLISION_STATUS) collision = true; }
      }
      logBindingChanges(applyAssetPathMoves(back));
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
        const { ok, status } = await moveFileToStatus(m.from, m.to);
        if (ok) { fwd.push({ from: m.from, to: m.to }); undone.delete(m.to); }
        else { failed.push(`${m.from} → ${m.to}`); if (status === COLLISION_STATUS) collision = true; }
      }
      logBindingChanges(applyAssetPathMoves(fwd));
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
 *  redo re-writes it; both directions used to discard the boolean. Neither
 *  `deleteAssetFile` nor `writeAssetFile` distinguishes a collision, so this is always
 *  console-only (never `userFixable`), matching `makeEmptyFolderDeleteUndo`. */
export function makeModelImportUndo(params: {
  assetName: string;
  prefabPath: string;
  content: string;
  onDone?: () => void;
}): UndoAction {
  const { assetName, prefabPath, content, onDone } = params;
  const label = `Import Model "${assetName}"`;
  return {
    label,
    undo: async () => {
      const ok = await deleteAssetFile(prefabPath);
      if (!ok) reportUndoFailure({ direction: 'Undo', label, detail: `prefab "${prefabPath}" was not trashed` });
      onDone?.();
    },
    redo: async () => {
      const ok = await writeAssetFile(prefabPath, content);
      if (!ok) reportUndoFailure({ direction: 'Redo', label, detail: `prefab "${prefabPath}" was not recreated` });
      onDone?.();
    },
  };
}

/** One file `importFiles` (Assets.tsx) wrote to disk — content is base64 so redo can
 *  re-write it byte-for-byte. */
export type ImportedFile = { path: string; content: string };

/** Undo/redo for `importFiles`'s OS-file-drop import (Assets.tsx, #308 follow-up B).
 *  Same skip-every-item shape as `makePasteUndo`/`makeFilesDropUndo`: every result in
 *  both loops used to be discarded, and undo unbound ALL N imported files regardless of
 *  which deletes actually landed — a file whose delete failed is still on disk, so its
 *  editor binding (if any) is still valid and must not be dropped. Only the files that
 *  were really trashed are unbound; every failure in either direction is batch-reported
 *  as one message. Neither `deleteAssetFile` nor `writeAssetFile` distinguishes a
 *  collision, so this is always console-only. */
export function makeFileImportUndo(params: {
  imported: ImportedFile[];
  refresh: () => void;
}): UndoAction {
  const { imported, refresh } = params;
  const label = imported.length > 1 ? `Import ${imported.length} files` : `Import "${imported[0].path.split('/').pop()}"`;
  return {
    label,
    // Undoing an import DELETES the files, and you can have opened one in the meantime
    // (import a .particle.json → double-click it → ⌘Z), so it unbinds like any delete.
    undo: async () => {
      const deleted: string[] = [];
      const failed: string[] = [];
      for (const f of imported) {
        const ok = await deleteAssetFile(f.path);
        if (ok) deleted.push(f.path); else failed.push(f.path);
      }
      logBindingChanges(unbindDeletedAssetEditors(deleted));
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Undo', label, detail: `still on disk, not trashed: ${failed.join(', ')}` });
      }
      refresh();
    },
    redo: async () => {
      const failed: string[] = [];
      for (const f of imported) {
        const ok = await writeAssetFile(f.path, f.content, 'base64');
        if (!ok) failed.push(f.path);
      }
      if (failed.length > 0) {
        reportUndoFailure({ direction: 'Redo', label, detail: `not re-imported: ${failed.join(', ')}` });
      }
      refresh();
    },
  };
}
