/** Undo builders for the Assets panel — framework-free factories that return a
 *  `UndoAction` the panel pushes. Extracted from Assets.tsx (editor-panels F6)
 *  so the near-identical `pushAction({undo, redo})` shapes (delete/duplicate)
 *  live in one place and the snapshot/GUID-sidecar logic is unit-testable
 *  without rendering the component.
 *
 *  Each builder takes a `refresh` callback (the panel's asset re-scan) so undo/
 *  redo re-list after mutating disk, exactly as the inline builders did. */

import type { UndoAction } from '../undo/undoManager';
import { writeAssetFile, deleteAssetFile, deleteAssetFiles, duplicateAssetFile } from './assetOps';
import type { AssetEntry } from '../utils/assetPaths';

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
 *  paths to trash (asset + sidecar + generated files + their sidecars). */
export type DeleteResult = { asset: AssetEntry; snapshots: Snapshot[]; deletePaths: string[] };

export type DupResult = { asset: AssetEntry; toPath: string };

/** Build a single coalesced undo/redo for one or more completed deletes. Undo
 *  restores the FULL snapshot set (not just the GLB) so generated mesh/mat/
 *  texture refs don't dangle; redo re-trashes the whole set in ONE call. */
export function makeDeleteUndo(results: DeleteResult[], refresh: () => void): UndoAction {
  const label = results.length > 1 ? `Delete ${results.length} items` : `Delete ${results[0].asset.name}`;
  return {
    label,
    undo: async () => {
      const all = results.flatMap((r) => r.snapshots);
      if (all.length === 0) { console.warn('[Assets] Cannot undo: nothing was restorable'); return; }
      for (const s of all) await writeAssetFile(s.path, s.content, s.encoding);
      refresh();
    },
    redo: async () => {
      // Re-delete the whole set in ONE trash call (same as the original delete).
      const allPaths = Array.from(new Set(results.flatMap((r) => r.deletePaths)));
      await deleteAssetFiles(allPaths);
      refresh();
    },
  };
}

/** Build a single coalesced undo/redo for one or more completed duplicates.
 *  Undo trashes each copy (and its sidecar for binary assets); redo re-copies. */
export function makeDuplicateUndo(results: DupResult[], refresh: () => void): UndoAction {
  const label = results.length > 1 ? `Duplicate ${results.length} items` : `Duplicate ${results[0].asset.name}`;
  return {
    label,
    undo: async () => {
      for (const { toPath } of results) {
        await deleteAssetFile(toPath);
        // Drop the duplicate's sidecar too (binary assets carry import settings
        // + GUID in a .meta.json the copy created).
        if (!isTextAsset(toPath)) await deleteAssetFile(toPath + '.meta.json');
      }
      refresh();
    },
    redo: async () => {
      for (const { asset, toPath } of results) await duplicateAssetFile(asset.path, toPath);
      refresh();
    },
  };
}
