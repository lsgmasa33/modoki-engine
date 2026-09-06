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

export const RENDERER_CENSUS_SRC_ROOTS = [
  path.resolve(__dirname, '../../packages/modoki/src'),
  path.resolve(__dirname, '../../app'),
];

/** Every .ts/.tsx under the census roots. */
export function rendererCensusSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const root of RENDERER_CENSUS_SRC_ROOTS) if (fs.existsSync(root)) walk(root);
  return out;
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
