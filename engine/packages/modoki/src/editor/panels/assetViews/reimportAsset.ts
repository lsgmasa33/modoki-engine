/** One asset's `/api/reimport`, read by the one reader (#1824) — split from `reimport.ts` so a caller that re-imports
 *  one asset (the asset views' Apply, `makeTexture2D`, the model import) does not load the batch loop's cache
 *  invalidators, and the runtime loaders behind them, just to make one request. */

import { postBackend } from '../../backend/editorBackend';

/** One asset's re-import, read by the one reader (#1824). `ok:true`: the route ran the bake — `errors`, when it has
 *  any, are the assets that failed inside a run that converted others (the route's own `ok:true` partial success).
 *  `ok:false`: the route refused or nothing converted — the 404 "no manifest asset matches", the unsaved-edit 409, the
 *  422 "nothing to re-import", a 500 — with its reason. Before #1824 every caller read only `errors`, so a refusal
 *  carrying `error` alone was counted as a re-import that happened. */
export type ReimportOutcome =
  | { ok: true; converted: number; errors: string[] }
  | { ok: false; error: string; status: number; code?: string };

/** POST `/api/reimport` for one path. The caller flushes a parked settings edit FIRST (#845) where it has one. */
export async function reimportAsset(path: string, opts?: { recursive?: boolean }): Promise<ReimportOutcome> {
  const a = await postBackend('/api/reimport', { path, ...(opts?.recursive !== undefined ? { recursive: opts.recursive } : {}) });
  if (!a.ok) return { ok: false, error: a.error, status: a.status, ...(a.code ? { code: a.code } : {}) };
  const errors = Array.isArray(a.body.errors) ? a.body.errors.filter((e): e is string => typeof e === 'string') : [];
  return { ok: true, converted: typeof a.body.converted === 'number' ? a.body.converted : 0, errors };
}

/** What went wrong with one re-import, as a sentence — the refusal's reason, or a partial run's errors — or null when
 *  nothing did. For a single-asset Apply, which states it on screen (ruling FA). */
export function reimportProblem(r: ReimportOutcome): string | null {
  if (!r.ok) return r.error;
  return r.errors.length ? r.errors.join('; ') : null;
}
