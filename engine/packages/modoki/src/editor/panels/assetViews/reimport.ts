/** Shared batch re-import loop — used by the Assets panel's "Re-import all" and
 *  by the multi-select batch Inspector views. Iterates file-by-file on the client
 *  so the progress modal can name the file currently being converted, and evicts
 *  the browser-side caches for every freshly-baked asset kind that holds one, so the
 *  LIVE viewport rebinds the new variant without a manual scene reload. */

import { backendFetch } from '../../backend/editorBackend';
import { invalidateModel, invalidateEnvironment } from '../../../runtime/loaders/meshTemplateCache';
import { invalidateTexture } from '../../../runtime/loaders/textureResolver';
import { invalidateAudio } from '../../../runtime/loaders/audioBufferCache';

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
      const res = await backendFetch('/api/reimport', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: a.path, recursive: false }),
      });
      const r = await res.json().catch(() => ({}));
      if (Array.isArray(r.errors) && r.errors.length > 0) summary.errors.push(...r.errors);
      else { if (typeof r.converted === 'number') summary.converted += r.converted; reimported.push(a); }
    } catch (e) {
      summary.errors.push(`${a.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    setImportStatus(true, a.path, i + 1, total);
  }
  // Evict every kind that HOLDS a cache, not just the two that used to be here
  // (#304 close-out). A batch re-import of a .wav left the decoded buffer playing the
  // old audio, and one of an .hdr left the viewport lit by the old environment, until
  // an editor restart. `font` is deliberately absent: it refreshes through the
  // manifest-hash channel (`onFontInvalidated`) instead. See assetInvalidation.ts.
  for (const a of reimported) {
    if (a.type === 'model') invalidateModel(a.path);
    else if (a.type === 'texture') invalidateTexture(a.path);
    else if (a.type === 'audio') invalidateAudio(a.path);
    else if (a.type === 'environment') invalidateEnvironment(a.path);
  }
  if (summary.errors.length) console.error('[reimport] errors:', summary.errors);
  return summary;
}
