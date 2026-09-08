/** `TextureBatchView`'s and `ModelBatchView`'s load-outcome decision, extracted so it is
 *  unit-testable without mounting either component (`docs/editor.md` § Panels), the same way
 *  `materialBatchLoad.ts` does for the material batch and `particleLoadPersist.ts` for the
 *  particle panel.
 *
 *  ## #903: the control showed an edit that would never be written
 *
 *  Both views used to install a document for EVERY selected path — `metaReadFallback()` on a
 *  thrown read, the helper's own tagged fallback on a non-ok one — and then, on every field
 *  change, do this:
 *
 *  ```ts
 *  for (const p of paths) {
 *    next[p] = updated;        // ← unconditional
 *    parkMetaEdit(p, updated); // ← may REFUSE, and returned void, so the loop could not tell
 *  }
 *  ```
 *
 *  A fallback document is exactly what `parkMetaEdit` refuses (it is tagged `FROM_FAILED_READ`,
 *  and carries no read stamp for the path). So for any member whose `loadAll` fetch failed, the
 *  row showed the new value, the park was refused, and Cmd+S wrote the others: **N of M silently
 *  dropped**, with a `console.error` as the only trace. Select 8 textures, hiccup on 3, change Max
 *  Size once — 8 rows move, 5 files change, and nothing on screen says which 3 did not.
 *
 *  ## The repair is a data shape, not a new branch — same as #886's
 *
 *  **A member that cannot be parked is ABSENT from `metas`.** The apply loops' `if (!metas[p])
 *  continue` is then correct by construction, exactly as `planBatchWrite`'s `if (!cur) continue`
 *  became correct once `{}` stopped being a member. The alternative — keep the fallback in the map
 *  and check the park verdict at apply time — leaves the map holding a document the view must
 *  remember not to trust, which is the state the `{}` fallback was.
 *
 *  ⚠️ **The exclusion predicate is ASKED, not re-derived.** `classifyMetaPark` is the same
 *  function `parkMetaEdit` runs, so "would this park be refused?" has one implementation. A local
 *  `metaCameFromFailedRead(m) || …` here would be a second mechanism for one property — the shape
 *  `docs/falsifiable-tests.md` calls out, where breaking either alone leaves the behaviour green
 *  and the two only diverge in production.
 *
 *  ⚠️ **There is deliberately no "missing ⇒ defaults" branch**, unlike the five asset EDITORS that
 *  author their document. A `.meta.json` is a sidecar for a file the Assets tree already listed;
 *  an absent one is read by `/api/read-meta` as `{}` with `ok: true`, which is a legitimately
 *  empty sidecar and IS parkable (it gets stamped). Only a read that FAILED is excluded here, and
 *  the two are different responses — see `readMetaPreferringPark`'s `ok` docblock, which warns
 *  against re-deriving "safe to spread" from that flag alone. */

import { classifyMetaPark, parkMetaEdit, refusalMessageFor, type MetaParkVerdict } from '../../scene/pendingMeta';

/** path → the full sidecar the view will edit and merge into. A member that cannot be parked is
 *  ABSENT — that absence is the guarantee the apply loops rest on. */
export type MetaMap = Record<string, Record<string, unknown>>;

/** A member of the selection excluded from the batch, and why — one banner line each. */
export type UnreadableMeta = { path: string; message: string };

export type MetaBatchLoad = { metas: MetaMap; unreadable: UnreadableMeta[] };

export type MetaBatchLoadDeps = {
  /** Read one path's sidecar, preferring a parked edit over disk (#845). Must be
   *  `readMetaPreferringPark` in production: it stamps an ok response for the path and substitutes
   *  the TAGGED fallback for a non-ok one, which is what makes the classifier below able to tell
   *  the two apart at all. A raw `fetch(...).json()` would hand back an unstamped document that
   *  this loader would correctly — but uselessly — exclude every time. */
  readMeta: (path: string) => Promise<{ meta: Record<string, unknown> }>;
};

/** Human wording for a member excluded because the registry would refuse its park. Shares
 *  `refusalMessageFor`'s vocabulary but not its sentence: the console line is addressed to whoever
 *  is reading logs and repeats the recovery per path, while the banner already carries one Retry
 *  for the whole selection. */
function exclusionMessage(verdict: MetaParkVerdict): string {
  if (verdict.parked) return 'it can be parked'; // unreachable — callers check `.parked` first
  return verdict.reason === 'failed-read'
    ? 'its import settings could not be read, so the editor has no GUID for it'
    : verdict.readFor === undefined
      ? 'no import settings have been read for it yet'
      : `the settings held for it were read for ${verdict.readFor}`;
}

/** Load every member of a batch selection, excluding the ones an edit could not reach.
 *
 *  ⚠️ A read that THROWS is excluded here rather than turned into `metaReadFallback()` by the
 *  caller. Both end in the same place — the fallback is tagged and the classifier refuses it — but
 *  going through the exclusion keeps the REASON, and "the network read threw" is a different
 *  sentence to the human than "the editor has no GUID for it". */
export async function loadMetaBatch(
  paths: readonly string[],
  deps: MetaBatchLoadDeps,
): Promise<MetaBatchLoad> {
  const metas: MetaMap = {};
  const unreadable: UnreadableMeta[] = [];
  await Promise.all(paths.map(async (path) => {
    let meta: Record<string, unknown>;
    try {
      ({ meta } = await deps.readMeta(path));
    } catch (e) {
      unreadable.push({ path, message: `reading its import settings failed — ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const verdict = classifyMetaPark(path, meta);
    // ⚠️ `.parked`, never the verdict itself — a verdict object is always truthy.
    if (!verdict.parked) {
      unreadable.push({ path, message: exclusionMessage(verdict) });
      return;
    }
    metas[path] = meta;
  }));
  return { metas, unreadable };
}

/** Plan a batch edit: which members it actually reaches, and their next documents.
 *
 *  Extracted alongside the loader because the two halves are ONE decision (the same argument
 *  `planBatchWrite`'s docblock makes): the loader's promise — *a member that cannot be parked is
 *  absent* — means nothing unless the writer honours absence, and #903's defect was precisely that
 *  it did not.
 *
 *  ⚠️ Keyed off `paths`, not `Object.keys(metas)`, so the ORDER is the selection's and an excluded
 *  member is skipped rather than silently reordered into the write. */
export function planMetaBatchWrite(
  paths: readonly string[],
  metas: MetaMap,
  mutate: (meta: Record<string, unknown>, path: string) => Record<string, unknown>,
): MetaMap {
  const next: MetaMap = {};
  for (const path of paths) {
    const cur = metas[path];
    if (!cur) continue;
    next[path] = mutate(cur, path);
  }
  return next;
}

/** Park every planned edit, and ASSERT that each was accepted.
 *
 *  ⚠️ **This is a tripwire, not the guard.** The guard is the exclusion: `planMetaBatchWrite` only
 *  ever hands back members the loader admitted to `metas`, and the loader admitted only what
 *  `classifyMetaPark` accepted — so a refusal HERE means the two disagreed, which is the exact
 *  drift the single classifier exists to prevent. It cannot be a silent `return`: #903 was a
 *  refused park with nowhere to report, and re-introducing one inside the fix would be the same
 *  defect wearing the repair's clothes.
 *
 *  Shared by both batch views rather than written twice, because "how does a batch park its plan"
 *  is one answer and two copies would drift on the first change — the same reason
 *  `planMetaBatchWrite` is not two loops. */
export function parkPlannedMetaEdits(next: MetaMap, view: string): void {
  for (const path of Object.keys(next)) {
    const verdict = parkMetaEdit(path, next[path]);
    // ⚠️ `.parked`, never the verdict itself — always truthy.
    if (!verdict.parked) {
      console.error(
        `[${view}] INVARIANT: a planned batch edit for ${path} was REFUSED by the registry, but `
        + 'the loader had admitted it as editable. The exclusion predicate and the park predicate '
        + `have diverged. ${refusalMessageFor(path, verdict)}`,
      );
    }
  }
}
