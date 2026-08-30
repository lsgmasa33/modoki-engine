/** AtlasAssetView's write+report, extracted (#308 close-out, part D-2) so it is
 *  unit-testable without mounting the component. `AtlasAssetView.tsx`'s `update` callback used
 *  to inline `void writeAssetFile(...).then((ok) => { if (!ok) reportWriteFailed(...) })` —
 *  which is plain logic, but it lived INSIDE the component, so covering it meant mounting the
 *  panel (forbidden — see CLAUDE.md § Panels: editor `.tsx` carries no tests, `.ts` does).
 *  Minimal extraction: same write, same order, same failure message; the component now just
 *  calls this instead of inlining the write+report itself. */

import { writeAssetFile } from '../assetOps';
import { reportWriteFailed } from './persist';
import { defaultAtlasSource } from '../../../runtime/loaders/spriteAtlas';

/** Write an atlas document's serialized content to `path` and report (console + toast) if the
 *  write did not land. Fire-and-forget by design — the caller does not await this, matching the
 *  optimistic-update-then-report shape every sibling asset view uses (see `persist.ts`'s
 *  `reportWriteFailed` header). Returns the write's own boolean so a test can await it. */
export async function persistAtlasDoc(path: string, content: string): Promise<boolean> {
  const ok = await writeAssetFile(path, content);
  if (!ok) reportWriteFailed(path, 'the atlas write was rejected');
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Load-state decision logic (#430).
//
// AtlasAssetView's load effect used to keep DEFAULT_DOC silently on any failed/aborted fetch,
// with `rawDoc.current = {}` — so the FIRST edit after a failed load called `persistAtlasDoc`
// with a default document, overwriting the real `.atlas.json` (losing `members`, `texture`, the
// `id` GUID). This half — classifying a fetch outcome into a load state + normalized doc, and
// gating whether a write may proceed — is pure decision logic, extracted here for the same
// reason `persistAtlasDoc` above was (#308): editor `.tsx` carries no tests (CLAUDE.md § Panels).

export interface AtlasSourceDoc {
  id?: string;
  version?: number;
  members: string[];
  pageSize: number;
  padding: number;
  extrude: number;
  maxPages?: number;
}

export const DEFAULT_ATLAS_DOC: AtlasSourceDoc = defaultAtlasSource();

export type AtlasLoadState = 'loading' | 'ok' | 'failed';

/** What the load effect actually observed, reduced to the four cases that matter. An abort is
 *  the effect's own cleanup firing (path changed again, or unmount) — never a load failure. */
export type AtlasLoadOutcome =
  | { kind: 'aborted' }
  | { kind: 'httpError' }
  | { kind: 'networkError' }
  | { kind: 'ok'; body: unknown };

/** Normalize a fetched `.atlas.json` body the same tolerant way the load effect always did:
 *  a missing/malformed field falls back to `DEFAULT_ATLAS_DOC`'s value rather than failing the
 *  load — a response that parses but is missing fields is a valid (if sparse) atlas, not a
 *  load failure. */
function normalizeAtlasBody(body: Record<string, unknown>): AtlasSourceDoc {
  const d = body as Partial<AtlasSourceDoc>;
  return {
    id: d.id, version: d.version,
    members: Array.isArray(d.members) ? d.members.filter((m): m is string => typeof m === 'string') : [],
    pageSize: typeof d.pageSize === 'number' ? d.pageSize : DEFAULT_ATLAS_DOC.pageSize,
    padding: typeof d.padding === 'number' ? d.padding : DEFAULT_ATLAS_DOC.padding,
    extrude: typeof d.extrude === 'number' ? d.extrude : DEFAULT_ATLAS_DOC.extrude,
    ...(typeof d.maxPages === 'number' ? { maxPages: d.maxPages } : {}),
  };
}

/** The load effect's next state given a fetch outcome. `null` means "aborted" — the caller does
 *  nothing at all (no state change, no banner): the effect's own cleanup already fired because a
 *  newer load (a path change, or a retry) superseded this one. A non-ok HTTP status or a network
 *  throw is `'failed'` — everything else (including a body missing every field) is `'ok'`, EXCEPT
 *  a parsed body that isn't a plain object (`null`, an array, a string, a number): `{...raw}` in
 *  `serializeAtlasDoc` and the `Partial<AtlasSourceDoc>` cast in `normalizeAtlasBody` both assume
 *  an object, so a body of that shape must not be classified 'ok' — it has no `id` to lose and no
 *  real fields to normalize, and treating it as an editable document is the same data loss #430
 *  fixed, just reached through a different response shape (review finding 4). */
export function classifyAtlasLoad(outcome: AtlasLoadOutcome):
  | { loadState: 'ok'; doc: AtlasSourceDoc; raw: Record<string, unknown> }
  | { loadState: 'failed' }
  | null {
  switch (outcome.kind) {
    case 'aborted': return null;
    case 'httpError': return { loadState: 'failed' };
    case 'networkError': return { loadState: 'failed' };
    case 'ok': {
      const body = outcome.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return { loadState: 'failed' };
      const raw = body as Record<string, unknown>;
      return { loadState: 'ok', doc: normalizeAtlasBody(raw), raw };
    }
  }
}

/** Whether `update()` may write right now. Kept as a standalone predicate (rather than folded
 *  into `persistAtlasDoc`) because the guard also gates `setDoc` — the component must skip the
 *  OPTIMISTIC state update too, not just the write, so the caller needs to ask the question
 *  before it does anything at all.
 *
 *  Compares IDENTITY, not just state (review findings 1 + 3): `loadState === 'ok'` alone is true
 *  in the window between a `path` prop change (A → B) and the load effect for B actually landing
 *  — React can defer a passive effect past paint, and a selection change re-renders the whole
 *  Inspector, so that window is real. `loadedPath` is set only alongside a successful load's
 *  `rawDoc`/`doc`, so `loadedPath !== path` catches exactly that window: the panel is still
 *  painted with A's loaded document but is now asking about B's path. */
export function canPersistAtlasDoc(loadState: AtlasLoadState, loadedPath: string | null, path: string): boolean {
  return loadState === 'ok' && loadedPath === path;
}
