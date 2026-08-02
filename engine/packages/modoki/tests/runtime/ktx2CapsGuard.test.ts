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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = join(fileURLToPath(new URL('.', import.meta.url)), '../../src/runtime');

/** Files permitted to touch the shared KTX2 loader without an in-file `ensureKtx2Caps` call. */
const ALLOW_UNGATED_KTX2: Set<string> = new Set([
  // `textureResolver.ts` DEFINES `getKTX2Loader`/`ensureKtx2Caps` — it always contains the
  // token, but list it explicitly so this allowlist documents every exception rather than
  // relying on an implicit "well it always matches" accident.
  'loaders/textureResolver.ts',
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip block + line comments so a mention in prose (e.g. this very file's own doc comment
 *  talking about `getKTX2Loader()`) can't trip the guard — only real call sites count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const FILES = tsFiles(RUNTIME).map((f) => ({ rel: relative(RUNTIME, f).replace(/\\/g, '/'), code: stripComments(readFileSync(f, 'utf8')) }));

describe('KTX2-caps guard', () => {
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
