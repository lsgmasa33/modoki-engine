/** KTX2-caps guard (docs/textures.md, "Runtime resolution").
 *
 *  `KTX2Loader.loadAsync`/`.setKTX2Loader(...)` throws "Missing initialization with
 *  `.detectSupport( renderer )`" if it runs before GPU caps are known. That invariant used to
 *  be guaranteed by the editor's up-front "wait for ANY 3D viewport before loading the scene"
 *  gate; now that the scene load no longer waits on a viewport (`ensureKtx2Caps()` is the one
 *  narrow, terminating gate instead), every file that touches the shared KTX2 loader must gate
 *  itself explicitly — `loadBillboardPage` (scene3DSync.ts) was exactly this kind of hole,
 *  invisible only because the old up-front gate happened to guarantee ordering.
 *
 *  This test fails the build if a NEW file reaches `getKTX2Loader()` and then either
 *  `.loadAsync(...)` or `.setKTX2Loader(...)` without also calling `ensureKtx2Caps` somewhere in
 *  the same file. File-level, not function-level (matches determinismGuard.test.ts's
 *  precision) — coarser than ideal, but a file that both touches the loader AND calls
 *  `ensureKtx2Caps` for an unrelated reason is exactly the kind of near-miss worth a human
 *  glance, not a free pass. The allowlist is EXPLICIT and reviewed — every entry is a
 *  deliberate exception with a documented reason, not a silent pass. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '../helpers/sourceScanner';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';

const RUNTIME = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/runtime');

/** Files permitted to touch the shared KTX2 loader without an in-file `ensureKtx2Caps` call. */
const ALLOW_UNGATED_KTX2: Set<string> = new Set([
  // `textureResolver.ts` DEFINES `getKTX2Loader`/`ensureKtx2Caps` — it always contains the
  // token, but list it explicitly so this allowlist documents every exception rather than
  // relying on an implicit "well it always matches" accident.
  'loaders/textureResolver.ts',
]);

function tsFiles(dir: string): string[] {
  return repoFiles({
    under: dir,
    match: (rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel),
    floor: 400,
  }).map(({ abs }) => abs);
}

// Comment stripping is the shared scanner (#419) — see sourceScanner.ts.

const FILES = tsFiles(RUNTIME).map((f) => {
  const raw = readFileSync(f, 'utf8');
  return { rel: relative(RUNTIME, f).replace(/\\/g, '/'), raw, code: stripComments(raw) };
});

describe('KTX2-caps guard', () => {
  // Length/line parity is true by construction for the scanner (sourceScanner.ts) — this pins
  // against a regression to a regex stripper. The forward oracle lives in sourceScanner.test.ts.
  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    for (const f of FILES) assertScanIsSane(f.raw, f.code, f.rel);
  });

  it('every file that touches the shared KTX2 loader also gates on ensureKtx2Caps', () => {
    const offenders = FILES
      .filter((f) => /\bgetKTX2Loader\s*\(/.test(f.code))
      .filter((f) => /\.loadAsync\s*\(/.test(f.code) || /\bsetKTX2Loader\s*\(/.test(f.code))
      .filter((f) => !/\bensureKtx2Caps\b/.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => !ALLOW_UNGATED_KTX2.has(rel));
    expect(
      offenders,
      `gate this KTX2 load site on ensureKtx2Caps(), or add a reviewed allowlist entry:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the allowlist itself stays small (review pressure)', () => {
    expect(ALLOW_UNGATED_KTX2.size).toBeLessThanOrEqual(2);
  });
});
