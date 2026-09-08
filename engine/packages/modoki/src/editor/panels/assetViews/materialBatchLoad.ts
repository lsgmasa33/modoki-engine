/** `MaterialBatchView`'s load-outcome decision, extracted so it is unit-testable without mounting
 *  the component (CLAUDE.md § Panels), the same way `particleLoadPersist.ts` and `atlasPersist.ts`
 *  do for their panels.
 *
 *  #886: the panel used to fall back to `{}` on BOTH a non-ok response and a caught rejection —
 *
 *  ```ts
 *  try { const r = await fetch(p); return [p, r.ok ? await r.json() : {}] as const; }
 *  catch { return [p, {}] as const; }
 *  ```
 *
 *  — and `{}` is TRUTHY, so `writeAll`'s `if (!cur) continue` did not skip it. One field edit then
 *  parked `{ color: … }` for that path, and the flush POSTs panel-origin writes with
 *  `replace: true`: a FULL REPLACE that deliberately skips `/api/asset-write`'s dropped-field
 *  guard. The material's shader, params, textures and scalars were erased and the write answered
 *  `ok`. (Its `id` usually survived — the route preserves an existing file's id when the incoming
 *  document omits one — so this destroyed CONTENT rather than identity, except where the file was
 *  absent and there was no id to preserve.)
 *
 *  ⚠️ **One case the server catches, and it is worth knowing which:** a `.mat.json` that is on disk
 *  but UNPARSABLE is refused by `/api/asset-write` itself — `material` has a real format constant,
 *  so `classifyJsonFormatVersion` returns `unreadable` and the route 400s. So the erasure above is
 *  reachable through a fetch rejection or a non-ok response over a VALID file, not through a
 *  conflict-markered one. The four asset editors sharing this classifier have no such backstop:
 *  `.anim.json`, `.timeline.json`, `.spriteanim.json` and `.rig2d.json` carry no format constant
 *  (docs/format-versioning.md § 3), so the client-side refusal is the only line they have.
 *
 *  **The repair is a data shape, not a new branch: a member that could not be read is ABSENT from
 *  the map.** `writeAll`'s existing `if (!cur) continue` is then correct exactly as written, and
 *  the other members of the same batch selection still park — which is the behaviour #886 asks for.
 *
 *  ⚠️ **There is deliberately no "missing ⇒ load defaults" branch here**, unlike the five asset
 *  EDITORS that share this classifier. Those panels CREATE their document (a brand-new
 *  `.particle.json`/`.anim.json` is authored in the panel and written on first save), so defaults
 *  are the correct content for an absent file. This panel only ever edits materials that the Assets
 *  tree already listed; a `.mat.json` that is not there is one that was deleted or renamed out from
 *  under the selection, and fabricating one would write a new file at a path the human did not ask
 *  for. `MaterialAssetView` already answers a failed single-material read the same way (`data =
 *  null`, every write path early-returns). So both verdicts exclude the member — the classifier is
 *  consulted for the REASON, which is what the banner tells the human. */

import { classifyAssetDocFetchFailure } from '../assetDocLoad';

/** path → the `.mat.json` document the panel will edit. A member whose read failed is ABSENT. */
export type MatMap = Record<string, Record<string, unknown>>;

/** A member of the selection that could not be read, and why — one banner line each. */
export type UnreadableMaterial = { path: string; message: string };

export type MaterialBatchLoad = { mats: MatMap; unreadable: UnreadableMaterial[] };

export type MaterialBatchLoadDeps = {
  /** The dirty-asset registry's parked document for this path, or null. Consulted FIRST: a parked
   *  edit is not on disk, so reading the file would re-seed the panel with the PRE-edit document
   *  (#831/#843 — see the panel's own comment). */
  parked: (path: string) => unknown | null;
  /** Fetch and PARSE the document at `path`. Must reject with `MissingAssetError` for an absent
   *  file — i.e. go through `parseAssetJson`, not a raw `r.json()`, or Vite's SPA-fallback
   *  `index.html` body arrives as a bare `SyntaxError` and "absent" cannot be told from "corrupt". */
  fetchDoc: (path: string) => Promise<unknown>;
};

/** Load every member of a batch selection, excluding the ones that could not be read.
 *
 *  ⚠️ A document that parses to a NON-OBJECT (a JSON `null`, a number, an array — a truncated or
 *  hand-mangled file can produce any of them) is unreadable too, not a member. Without this the
 *  `{}`-shaped hole simply moves: `mats[p] = null` is falsy and would be skipped by `writeAll`, but
 *  `mats[p] = []` or `mats[p] = 3` is truthy and would be spread into a park just as `{}` was. */
export async function loadMaterialBatch(
  paths: string[],
  deps: MaterialBatchLoadDeps,
): Promise<MaterialBatchLoad> {
  const mats: MatMap = {};
  const unreadable: UnreadableMaterial[] = [];
  await Promise.all(paths.map(async (path) => {
    const parked = deps.parked(path);
    if (parked && typeof parked === 'object' && !Array.isArray(parked)) {
      mats[path] = parked as Record<string, unknown>;
      return;
    }
    try {
      const doc = await deps.fetchDoc(path);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        unreadable.push({ path, message: `the file did not contain a JSON object (got ${doc === null ? 'null' : Array.isArray(doc) ? 'an array' : typeof doc})` });
        return;
      }
      mats[path] = doc as Record<string, unknown>;
    } catch (e) {
      const failure = classifyAssetDocFetchFailure(e);
      unreadable.push({
        path,
        message: failure.kind === 'missing'
          ? 'it is no longer on disk (deleted, renamed, or moved since it was selected)'
          : failure.message,
      });
    }
  }));
  return { mats, unreadable };
}

/** Plan a batch edit: which members an edit actually reaches, and their before/after documents.
 *
 *  Extracted alongside the loader because the two halves are ONE decision — the loader's promise
 *  ("a member that could not be read is absent") means nothing unless the writer honours absence,
 *  and `#886`'s defect was precisely that it did not: `{}` is truthy, so the `if (!cur) continue`
 *  below did not skip the member whose read had failed.
 *
 *  ⚠️ Keyed off `paths`, not `Object.keys(mats)`, so the ORDER is the selection's and a member that
 *  vanished from the map is skipped rather than silently reordered into the write. */
export function planBatchWrite(
  paths: string[],
  mats: MatMap,
  mutate: (data: Record<string, unknown>) => Record<string, unknown>,
): { prev: MatMap; next: MatMap } {
  const prev: MatMap = {};
  const next: MatMap = {};
  for (const path of paths) {
    const cur = mats[path];
    if (!cur) continue;
    prev[path] = cur;
    next[path] = mutate(cur);
  }
  return { prev, next };
}
