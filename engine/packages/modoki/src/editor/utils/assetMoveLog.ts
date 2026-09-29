/** Every Assets move and delete this session, in order — so a step recorded against an asset's PATH can find where the
 *  asset is now (#1868).
 *
 *  An Assets file operation is not undoable since #1868 (owner ruling D2), so it no longer pushes an entry that clears
 *  the redo stack or unwinds before the steps below it: an asset-document step recorded before a Rename runs after it.
 *  Unity's undo follows the asset (it records the object, not the path); this is the same answer for a history keyed by
 *  path. Fed by the one seam every move and delete reaches, `applyAssetPathMoves`. Module state: a relaunch starts a
 *  new history, and the undo stack does not survive one either. */

import { applyMove, type PathMove } from './assetPaths';

const log: PathMove[] = [];

/** Record `moves`, in the order they happened. */
export function recordAssetMoves(moves: readonly PathMove[]): void {
  for (const m of moves) log.push({ from: m.from, to: m.to, ...(m.prefix ? { prefix: true } : {}) });
}

/** How many moves the log holds — the MARK a step takes when it is recorded, so it later replays only the moves made
 *  after it. A move made BEFORE the record is not this asset's history: rename A→B, then create a new A and edit it,
 *  and that edit's step belongs to the new A, not to B. */
export function assetMoveMark(): number { return log.length; }

/** Where the asset recorded at `path` (at `mark`, {@link assetMoveMark}) is now: the path itself when nothing moved it
 *  since, the new path after a rename or a move (a folder's included), and `null` once it was deleted. */
export function currentAssetPath(path: string, mark: number): string | null {
  let p = path;
  for (const m of log.slice(mark)) {
    const to = applyMove(p, m);
    if (to === undefined) continue;
    if (to === null) return null;
    p = to;
  }
  return p;
}

/** Test-only: forget the session's moves. */
export function clearAssetMoveLog(): void { log.length = 0; }
