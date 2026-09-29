/** Every localId allocator seeds from the prefab's persisted high-water mark (#1774, `localIdCounter.ts`).
 *
 *  A derived member guid is a hash of the localId path, so an allocator that numbers above the rows it can SEE hands a
 *  number an earlier write freed at the top to a new node, which then takes over every ref to the deleted member. The
 *  behaviour is pinned per writer in `tests/editor/localIdCounter.test.ts`; this is the cheap backstop over the census:
 *  - each known allocator calls the mark (`localIdCounter(` / `advanceLocalIdCounter(`, the paren required — a name in
 *    a comment or an import is not a call);
 *  - no OTHER editor or app code takes a `Math.max` over row localIds, the shape every pre-#1774 allocator had.
 *
 *  If you are here because the second test failed: seed your allocator from `localIdCounter(doc)`, state the result with
 *  `advanceLocalIdCounter`, add it to ALLOCATORS below, and give it a case in `localIdCounter.test.ts`.
 *  ⚠️ Honest scope: a new allocator spelled some other way (a `reduce` over a different field, a counter kept elsewhere)
 *  passes this scan; the per-writer table is what catches a writer, this only catches the familiar shape. */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const SCENE = 'engine/packages/modoki/src/editor/scene/';
/** file → the functions in it that hand out a NEW localId. */
const ALLOCATORS: Record<string, string[]> = {
  [`${SCENE}prefab.ts`]: ['serializePrefabBody', 'replaceNumbering', 'mergeRiggedPrefab', 'planApply'],
  [`${SCENE}prefabEdit.ts`]: ['usedUpTo'],
};
const READS_MARK = /\b(?:advanceLocalIdCounter|localIdCounter)\(/;

/** The code of the function (or `const` arrow) named `name`: from its declaration to the next top-level one. */
function bodyOf(code: string, name: string): string | null {
  const start = code.search(new RegExp(`^(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\b)`, 'm'));
  if (start < 0) return null;
  const rest = code.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?(?:function |const |let |class |interface |type )/m);
  return code.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('localId allocators read the high-water mark (#1774)', () => {
  it('each known allocator calls localIdCounter / advanceLocalIdCounter', () => {
    const missing: string[] = [];
    for (const [rel, fns] of Object.entries(ALLOCATORS)) {
      const { code } = readScannedSource(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)));
      for (const fn of fns) {
        const body = bodyOf(code, fn);
        if (body === null) missing.push(`${rel}: ${fn} not found — renamed? update ALLOCATORS`);
        else if (!READS_MARK.test(body)) missing.push(`${rel}: ${fn} numbers rows without reading the mark`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('no other editor or app code takes a Math.max over row localIds', () => {
    const files = repoFiles({ under: 'engine', match: /\.tsx?$/, floor: 500 })
      .filter(({ rel }: { rel: string }) => /(packages[\\/]modoki[\\/]src[\\/]editor|app)[\\/]/.test(rel))
      .filter(({ rel }: { rel: string }) => !/[\\/]tests?[\\/]|\.test\.tsx?$/.test(rel));
    expect(files.length, 'the corpus the scan covers').toBeGreaterThan(100);
    const hits: string[] = [];
    for (const { rel, abs } of files) {
      const { code } = readScannedSource(abs);
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (!/Math\.max\(/.test(line) || !/\.localId\b/.test(line)) return;
        // The one sanctioned shape: mergeRiggedPrefab lifting its mark-seeded counter above the fresh rows.
        if (/nextId = Math\.max\(nextId, pe\.localId \+ 1\)/.test(line)) return;
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, 'allocate from localIdCounter(doc) instead — see this file\'s docblock').toEqual([]);
  });
});
