/** Shared census helper for `glContextRelease.test.ts` and `rendererLossHandling.test.ts` (#795).
 *
 *  Both guards walk the SAME editor+runtime source tree looking for renderer CONSTRUCTION sites,
 *  each pairing them with a different required companion call — `forceContextLoss` for release,
 *  an `attachRendererLossHandling`/`attachContextLossListeners`/`attachDeviceLostListener` call
 *  for loss DETECTION. Those are two different properties over the same corpus, kept as two
 *  separate test files on purpose (a red in one must not be ambiguous with the other) — but the
 *  walk-and-strip pass underneath them is identical, so it is factored out here rather than
 *  duplicated a second time. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

export const RENDERER_CENSUS_SRC_ROOTS = [
  path.resolve(__dirname, '../../packages/modoki/src'),
  path.resolve(__dirname, '../../app'),
];

/** Every .ts/.tsx under the census roots, via the ONE shared corpus producer.
 *
 *  Merge note: `main` introduced this helper (to share one census across the renderer guards) in
 *  the same window the `win` branch migrated every corpus producer onto `repoCorpus.mjs`
 *  (#799/#771/#805). Both changes are right and they are not in tension — main's contribution is
 *  the shared CENSUS, this branch's is the shared ENUMERATION — so the merge keeps main's
 *  abstraction and puts the shared producer underneath it, rather than picking a side. Left as a
 *  hand-rolled `readdirSync` walk it would have been the first thing to trip
 *  `corpusProducerIsShared.test.ts` after the merge.
 *
 *  `floor` is well under the ~855 measured, so only a broken enumeration trips it, never churn.
 *  `under` takes the absolute roots directly — no `path.relative` round-trip, which is the hazard
 *  the producer exists to delete (docs/windows.md § Paths). */
export function rendererCensusSourceFiles(): string[] {
  return repoFiles({ under: RENDERER_CENSUS_SRC_ROOTS, match: /\.tsx?$/, floor: 600 })
    .map(({ abs }) => abs);
}

export interface CensusedFile {
  file: string;
  raw: string;
  /** Comment-stripped source — a required call mentioned only in a comment (a stale TODO) must
   *  not satisfy either guard's pairing. */
  stripped: string;
}

/** Read + comment-strip + sanity-check every census source file once. Both guards iterate this
 *  same list, so a red in one is never explained by the walk finding a different file set than
 *  the other. */
export function censusRendererSources(): CensusedFile[] {
  return rendererCensusSourceFiles().map((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const stripped = stripComments(raw);
    assertScanIsSane(raw, stripped, path.relative(process.cwd(), file));
    return { file, raw, stripped };
  });
}
