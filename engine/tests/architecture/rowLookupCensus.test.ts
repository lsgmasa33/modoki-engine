/** #1880 F3c: which row of a prefab document a localId names has ONE answer, `rowAt` (runtime/core/prefabRowAt.ts): the
 *  LAST row, as the spawner's `localToEcs` keeps it. About 48 sites asked it with a raw `.find((e) => e.localId === …)`,
 *  which took the FIRST — so on a document a hand edit or merge gave a repeated localId, a reader read one row while the
 *  world showed another. This census refuses a new raw lookup anywhere under engine/ (the app and tools included). */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** Every raw "the row at localId" lookup in `text`: a `.find` whose predicate compares its OWN parameter's `localId`.
 *  A live-entity lookup that reads a localId through a helper (`piOf(m.id)?.localId`), or any other field, is not one. */
export function rawLocalIdFinds(text: string): string[] {
  // `\1.localId` bare or defaulted (`(r.localId ?? 0) ===`, which the first version of this matcher missed).
  return [...text.matchAll(/\.find\(\(?([A-Za-z_$][\w$]*)\)?\s*=>\s*\(?\1\??\.localId(?:\s*\?\?\s*[\w.]+\))?\s*===/g)].map((m) => m[0]);
}

describe('the row-at-localId lookup is `rowAt`, everywhere (#1880 F3c)', () => {
  it('(self-test) the matcher finds a raw lookup, and not another field or a live-entity read', () => {
    expect(rawLocalIdFinds('const r = doc.entities.find((e) => e.localId === lid);')).toHaveLength(1);
    expect(rawLocalIdFinds('rows.find(r => r.localId === 3 && r.prefab)')).toHaveLength(1);
    expect(rawLocalIdFinds('doc.entities.find((r) => (r.localId ?? 0) === lid && r.prefab)')).toHaveLength(1);
    expect(rawLocalIdFinds('rows.find((r) => r.nodeGuid === g)')).toEqual([]);
    expect(rawLocalIdFinds('all.find((m) => piOf(m.id)?.localId === lid)')).toEqual([]);
  });

  it('no production file under engine/ looks a row up by localId with a raw .find', () => {
    const files = repoFiles({ under: 'engine', match: /\.tsx?$/, floor: 500 })
      .filter(({ rel }: { rel: string }) => !/[\\/]tests?[\\/]|\.test\.tsx?$/.test(rel) && !rel.includes('/node_modules/'));
    const hits: string[] = [];
    for (const { rel, abs } of files) for (const m of rawLocalIdFinds(readScannedSource(abs).code)) hits.push(`${rel}: ${m}`);
    expect(hits, 'use rowAt / referenceRowAt (runtime/core/prefabRowAt.ts)').toEqual([]);
  });
});
