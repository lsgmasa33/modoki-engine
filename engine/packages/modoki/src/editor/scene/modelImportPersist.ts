/** modelImport's read-before-write classification for `.mesh.json` / `.mat.json`, extracted so it
 *  is unit-testable without the full import pipeline (CLAUDE.md § Panels; mirrors
 *  `particleLoadPersist.ts`'s extraction for `ParticleEditor`).
 *
 *  Both formats are REFUSE-disposition documents (docs/format-versioning.md § 2b-bis) —
 *  machine-generated import artifacts, not player data. `modelImport.ts` reads the existing
 *  document back before EVERY overwrite (to preserve the stable id, and for materials to carry
 *  hand-authored fields forward) — that one read is also the write-time REFUSE gate (§ 5 step 4),
 *  so there is no separate "check before overwrite" step to add; item 3 and item 4 of #784 phase
 *  C2b share this single classification.
 *
 *  Before this fix, a read failure of ANY kind — a genuinely missing file, corrupt/conflict-
 *  markered bytes, or a document written by a newer build — collapsed to the same `undefined`/
 *  `null`, and `modelImport.ts` treated that as "first-time import": minting a fresh GUID over a
 *  document whose bytes were still on disk, dangling every scene/prefab that referenced it by
 *  that id. That is § 4's third trap restated for this document — preserving the bytes is not
 *  preserving the asset once nothing can find it by GUID any more. */

import { classifyFormatVersion } from '../../runtime/core/formatVersion';
import { isMissingAsset } from '../../runtime/loaders/assetFetch';

/** What to do when fetching/parsing an existing `.mesh.json`/`.mat.json` throws. `'absent'` is a
 *  genuinely missing file — a first-time import, or a fresh override target — and minting a new
 *  GUID for it is correct, same as before this fix. Anything else (a real JSON parse failure, a
 *  network error) is `'abort'`: the caller must not treat it as absent. */
export type ExistingAssetFetchOutcome =
  | { kind: 'absent' }
  | { kind: 'abort'; reason: string };

export function classifyExistingAssetFetchFailure(e: unknown): ExistingAssetFetchOutcome {
  if (isMissingAsset(e)) return { kind: 'absent' };
  return { kind: 'abort', reason: e instanceof Error ? e.message : String(e) };
}

/** What to do with a successfully-fetched-and-parsed existing document, against this build's
 *  format constant (`MESH_FORMAT_VERSION` or `MATERIAL_FORMAT_VERSION`). `'ok'` covers BOTH the
 *  `ok` and `absent` verdicts from `classifyFormatVersion` — both are readable
 *  (docs/format-versioning.md § 2a); `'abort'` covers `too-new` and `unreadable`. */
export type ExistingAssetJsonOutcome =
  | { kind: 'ok' }
  | { kind: 'abort'; reason: string };

export function classifyExistingAssetJson(json: unknown, current: number): ExistingAssetJsonOutcome {
  const verdict = classifyFormatVersion(json, current);
  if (verdict.kind === 'too-new') {
    return { kind: 'abort', reason: `format version ${verdict.version} is newer than this build's constant (${current})` };
  }
  if (verdict.kind === 'unreadable') {
    return { kind: 'abort', reason: `version field is unreadable (${verdict.reason})` };
  }
  return { kind: 'ok' };
}
