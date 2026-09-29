/** Shared batch re-import loop — used by the Assets panel's "Re-import all" and
 *  by the multi-select batch Inspector views. Iterates file-by-file on the client
 *  so the progress modal can name the file currently being converted, and evicts
 *  the browser-side caches for every freshly-baked asset kind that holds one, so the
 *  LIVE viewport rebinds the new variant without a manual scene reload. */

import { reportGestureRefusal, reportBackgroundRefusal, refusedItemsText } from '../../backend/refusalChannel';
import { reimportAsset } from './reimportAsset';
import { REIMPORT_INVALIDATORS, type ReimportableAssetKind } from '../../../runtime/loaders/reimportInvalidation';
import { flushPendingMetaFor } from '../../scene/pendingMeta';

export type ReimportItem = { path: string; type: string };
export type SetImportStatus = (active: boolean, message?: string, step?: number, totalSteps?: number) => void;
export interface ReimportSummary { converted: number; errors: string[] }

/** Re-import each item via /api/reimport, driving `setImportStatus` for a
 *  determinate progress bar, then evict GPU caches for the ones that succeeded.
 *  Returns the aggregate summary. Callers clear the status + refresh assets. */
export async function reimportPaths(
  items: ReimportItem[],
  setImportStatus: SetImportStatus,
  label: string,
  /** Who asked (#1824, ruling FA): `'gesture'` — a Re-import the human clicked — toasts the failures; `'background'`
   *  — the Assets panel's import-on-add, which runs for whatever appears on disk (an agent's import, a git pull, a
   *  model's extracted textures) — states them in the console only. */
  channel: 'gesture' | 'background' = 'gesture',
): Promise<ReimportSummary> {
  const summary: ReimportSummary = { converted: 0, errors: [] };
  if (items.length === 0) {
    setImportStatus(true, 'Nothing to re-import', 0, 0);
    setTimeout(() => setImportStatus(false), 600);
    return summary;
  }

  const total = items.length;
  const reimported: ReimportItem[] = []; // items whose handler ran without error
  setImportStatus(true, label, 0, total);
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    setImportStatus(true, a.path, i, total);
    try {
      // #845: `/api/reimport` reads the CURRENT `.meta.json` off disk to know what to convert
      // with. A still-parked settings edit for this path has not reached disk yet, so without
      // this the reimport would bake the OLD settings while the panel already shows the new
      // ones — and the stale park would go on to overwrite the reimport's own fresh write at the
      // next Cmd+S. Flushing first makes both a single-asset Apply and this shared batch loop see
      // the same disk truth the panel does. A no-op when nothing is parked for `a.path`.
      await flushPendingMetaFor(a.path);
      const r = await reimportAsset(a.path, { recursive: false });
      // A refusal is NOT a re-import (#1824): it names its reason, and its caches are not evicted.
      // The route's own text often already names the path (a failed bake answers `errors:['<path>: <why>']`), so it is
      // prefixed only when it does not — a toast reading "a.png: a.png: boom" was the close-out review's finding.
      if (!r.ok) summary.errors.push(r.error.startsWith(a.path) ? r.error : `${a.path}: ${r.error}`);
      else if (r.errors.length > 0) summary.errors.push(...r.errors);
      else { summary.converted += r.converted; reimported.push(a); }
    } catch (e) {
      summary.errors.push(`${a.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    setImportStatus(true, a.path, i + 1, total);
  }
  // Evict every kind that HOLDS a cache, not just the two that used to be here
  // (#304 close-out). A batch re-import of a .wav left the decoded buffer playing the
  // old audio, and one of an .hdr left the viewport lit by the old environment, until
  // an editor restart.
  //
  // The mapping itself is SHARED with the agent/MCP path (#1366) — this loop used to spell it
  // out inline, the agent bridge kept a second copy, and the two drifted: neither evicted the
  // rigged prototype, so a re-imported SKINNED GLB kept its old skeleton and clips. See
  // `runtime/loaders/reimportInvalidation.ts` for the measurement and for why `model` is two
  // calls rather than one.
  for (const a of reimported) {
    // `Object.hasOwn` before the index: `a.type` is a SERVER-supplied string, and a plain object
    // literal carries `Object.prototype`, so a type of `__defineGetter__` would resolve to an
    // inherited function and `?.()` would call it — throwing a TypeError out of `reimportPaths` and
    // abandoning the rest of the batch. Unreachable with the backend's current kind set, so this is
    // hygiene rather than a live bug (close-out review).
    if (!Object.hasOwn(REIMPORT_INVALIDATORS, a.type)) continue;
    REIMPORT_INVALIDATORS[a.type as ReimportableAssetKind](a.path);
  }
  // A human's Re-import states the failures on screen with their reasons, background work in the console (#1824,
  // ruling FA); the batch views used to discard the summary entirely.
  if (summary.errors.length) {
    const text = `Re-import did not fully apply — ${refusedItemsText(summary.errors)}`;
    if (channel === 'gesture') reportGestureRefusal(text, summary.errors.join('\n'));
    else reportBackgroundRefusal(`[Assets] ${text}\n${summary.errors.join('\n')}`);
  }
  return summary;
}
