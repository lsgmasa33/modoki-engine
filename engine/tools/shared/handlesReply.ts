/** How an `enact-handles` answer is shaped for an agent — ONE implementation for `modoki_handles` (the
 *  editor's `/api/enact-handles` route) and `device_handles` (#1216 C-14).
 *
 *  The op returns every handle; the shaping lives above it because `inputRoutes.ts` calls the op
 *  directly to aim `tap_handle`/`drag_handle`, and a summary there would break trusted input. It lived
 *  only in the editor route, while `device_handles` goes straight to the op over the device relay — so
 *  the device tool's description promised a counts-only bare call and a filter miss that names what is
 *  live, and delivered neither: a bare call dumped every handle, and a typo'd filter answered an empty
 *  list that reads exactly like "nothing is there".
 *
 *  Dependency-free: the Node backend and the `game-debug-mcp` package both import it as a value. The
 *  general form of its empty-filter disclosure (#1214) is `filterDisclosure.ts`. */

import { histogram } from './filterDisclosure.js';

export interface HandlesFilter { editor?: string; kind?: string; ids?: string[]; prefix?: string; label?: string }
export interface HandlesResponse { handles?: Array<{ id?: string; editor?: string; kind?: string; label?: string }>; [k: string]: unknown }

/** The filter a reply shows was NOT applied, or null. An app build older than the op's `prefix`/`label`
 *  filters (a6554dfff) ignores both and answers every handle — which is not bare and not empty, so the
 *  shaping below would pass that dump off as the matches. A label the op capped for the report (`…`)
 *  cannot be compared, so it is given the benefit of the doubt. */
export function ignoredHandleFilter(res: HandlesResponse, filter: HandlesFilter): 'prefix' | 'label' | null {
  if (!Array.isArray(res.handles)) return null;
  const { prefix, label } = filter;
  if (prefix && res.handles.some((h) => typeof h.id === 'string' && !h.id.startsWith(prefix))) return 'prefix';
  if (label) {
    // `normalizeHandleLabel` (runtime/rendering/interactionHandles.ts) — restated, because this module
    // imports nothing; a drift here can only make this check more lenient or stricter, never filter.
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
    if (res.handles.some((h) => typeof h.label !== 'string' || (!h.label.endsWith('…') && norm(h.label) !== norm(label)))) return 'label';
  }
  return null;
}

/** The next move when nothing exposes handles — it differs by surface, so each caller supplies it:
 *  `noHandles` is a bare call's whole hint, `nothingLive` finishes "no handle matches <filter>, and …". */
export interface HandlesRemedies { noHandles: string; nothingLive: string }

/** `ids` as either surface takes it: a list, or a comma-separated string (the editor's query form). */
export function parseHandleIds(ids: string | readonly string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  const list = (typeof ids === 'string' ? ids.split(',') : [...ids]).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function isBareHandlesFilter(f: HandlesFilter): boolean {
  return !f.editor && !f.kind && !(f.ids?.length) && !f.prefix && !f.label;
}

function countsOf(handles: NonNullable<HandlesResponse['handles']>) {
  return { byEditor: histogram(handles, (h) => h.editor ?? '?'), byKind: histogram(handles, (h) => h.kind ?? '?') };
}

/** Shape a successful `enact-handles` answer. `fetchAll` re-asks with no filter; it runs only when a
 *  filtered call matched nothing, so the hot path costs one request. */
export async function shapeHandlesReply(
  res: HandlesResponse, filter: HandlesFilter, fetchAll: () => Promise<HandlesResponse | null>, remedies: HandlesRemedies,
): Promise<Record<string, unknown>> {
  if (!Array.isArray(res.handles)) return res;
  // A bare call with a Dopesheet open enumerates every key of every track (no windowing in
  // DopesheetView) — ~374 bytes/handle, so 2,000 keys ≈ 187k tokens. Untargeted reports per-editor/
  // per-kind counts; the geometry needs an editor/kind/ids filter.
  if (isBareHandlesFilter(filter)) {
    // Keep every diagnostic counter. `occludedCount:0` only means "all clickable" when
    // `occlusionUnchecked` is 0 too — dropping either would make the pair a lie.
    //
    // ⚠️ `returnedCount` is DROPPED here, and that is the whole point of naming it (#1266). This
    // branch returns NO rows — it strips `handles` and answers counts — so a field defined as "the
    // rows in this reply" would state a falsehood: a bare call with a Dopesheet open would say
    // `returnedCount: 2000` beside no `handles` key at all, and a caller that believed it would
    // conclude its own parse had failed. Under the old vague name `count` this was merely
    // ambiguous; the precise name makes it wrong, so the summary must not carry it. `totalCount`
    // stays: how many handles exist IS the answer a bare call is giving.
    const { handles, returnedCount: _returnedCount, ...meta } = res;
    return {
      ...meta,
      ...countsOf(handles),
      hint: handles.length
        ? 'Counts only. Pass editor=<name>, kind=<name>, or ids=[…] for handle geometry (x/y/rect).'
        : remedies.noHandles,
    };
  }
  if (res.handles.length > 0) return res;
  // A FILTERED call that matched NOTHING used to return `{count:0, editors:[], handles:[]}` —
  // byte-indistinguishable from "no editor is open", so a typo'd editor=/kind= read as a correct
  // negative answer (S3.10). `editors` is derived from the already-filtered list, so it was empty too.
  const { editor, kind, ids, prefix, label } = filter;
  const asked = [editor ? `editor=${editor}` : null, kind ? `kind=${kind}` : null,
    ids?.length ? `ids=[${ids.join(',')}]` : null,
    prefix ? `prefix=${prefix}` : null, label ? `label=${JSON.stringify(label)}` : null].filter(Boolean).join(', ');
  let all: HandlesResponse | null = null;
  try { all = await fetchAll(); } catch { /* keep the primary answer */ }
  const liveHandles = Array.isArray(all?.handles) ? all.handles : [];
  const { byEditor, byKind } = countsOf(liveHandles);
  // #1152: the id prefixes that ARE live, so an empty `prefix=dialog.saveAs.` answers "that dialog is
  // not open" — and a typo'd one is visibly a typo. First segment only: that is the panel/dialog, and a
  // full id list is the unbounded dump the bare-call summary exists to avoid.
  const idPrefixes = new Set<string>();
  if (prefix || label) {
    for (const h of liveHandles) if (h.editor === 'chrome' && typeof h.id === 'string') idPrefixes.add(`${h.id.split('.')[0]}.`);
  }
  const live = Object.keys(byEditor);
  const prefixNote = idPrefixes.size
    ? ` Chrome id prefixes live now: {${[...idPrefixes].sort().join(', ')}} — a prefix absent from this set is a panel or dialog that is not open.`
    : '';
  const labelNote = label ? ' A label matches the WHOLE label (whitespace-collapsed, case-insensitive), never a substring.' : '';
  return {
    ...res,
    byEditor,
    byKind,
    hint: live.length
      ? `no handle matches ${asked}. Live now: editor ∈ {${live.join(', ')}}, kind ∈ {${Object.keys(byKind).join(', ')}} — check the spelling, or drop the filter for counts.${prefixNote}${labelNote}`
      : `no handle matches ${asked}, and ${remedies.nothingLive}`,
  };
}
