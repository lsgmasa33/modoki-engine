/** #1937 C-A step 7, T14: every committed prefab admits — no identifier declared twice — and no key one of them gives a
 *  frame is given again by a prefab it nests (#1933 L5). A committed prefab that failed would load as a Damaged Prefab
 *  placeholder in every scene that places it, and fail its game's build (`asset-tree-shaker.ts`). Measured when the gate
 *  landed: 108 prefabs, none refused, none keyless. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { admitPrefabDocument } from '../../packages/modoki/src/runtime/loaders/documentIdentity';
import { frameRepeatRefusal } from '../../packages/modoki/src/runtime/loaders/frameRepeat';
import { isPrefabDocument } from '../../packages/modoki/src/runtime/loaders/prefabDocumentShape';
import { parseJsonText } from '../../scripts/jsonFile.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasAnyProject, hasInternalGames } from '../helpers/repoLayout';

const REPO = path.resolve(__dirname, '../../..');

/** Every committed prefab: games, demos and the scaffolder template, not the native projects' copies of a web build.
 *  `floor: 0` deliberately: this runs at MODULE scope, and the public snapshot ships no `games/` (and only the demos its
 *  CI names), so a real floor there throws at collection on every OS leg (`prefabInertSize.test.ts` § the same trap).
 *  The census test below carries the floor, skipped where there is no project. */
const prefabFiles = (): string[] => repoFiles({ under: ['games', 'demos', 'engine/templates'], match: /\.prefab\.json$/, exclude: ['node_modules', 'dist', 'ios', 'android'], floor: 0 })
  .map(({ abs }: { abs: string }) => abs);

/** Each prefab's refusal, or none: admission, then the cross-file repeat over the corpus's admitted documents. */
function refusals(docs: ReadonlyMap<string, unknown>): string[] {
  const byGuid = new Map<string, unknown>();
  for (const d of docs.values()) {
    const id = (d as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const a = admitPrefabDocument(d);
    byGuid.set(id.toLowerCase(), 'doc' in a ? a.doc : d);
  }
  const out: string[] = [];
  for (const [file, doc] of docs) {
    if (!isPrefabDocument(doc)) continue;
    const a = admitPrefabDocument(doc);
    const reason = 'refusal' in a ? a.refusal : frameRepeatRefusal(a.doc, (g) => byGuid.get(g.toLowerCase()) ?? null);
    if (reason) out.push(`${path.relative(REPO, file)}: ${reason}`);
  }
  return out;
}

describe('every committed prefab admits (#1937 T14)', () => {
  const docs = new Map<string, unknown>(prefabFiles().map((f) => [f, parseJsonText(fs.readFileSync(f, 'utf8'))]));

  it.skipIf(!hasAnyProject())('the corpus is what the gate measured (a census, not an empty pass)', () => {
    expect(docs.size).toBeGreaterThanOrEqual(hasInternalGames() ? 100 : 1);
  });

  it('none is refused', () => {
    expect(refusals(docs)).toEqual([]);
  });

  // The guard's own accept-side test: it REPORTS a repeat injected into a copy of a corpus prefab. Mutation: `refusals`
  // never pushes — this goes green on nothing, and the case above could not fail.
  it('a repeated localId injected into a copy of one is reported', () => {
    // A corpus prefab with two rows, or — in a checkout that ships none — a minimal one, so the accept side never skips.
    const minimal = { id: 'cccccccc-0000-4000-8000-0000000019c1', version: 9, name: 'M', rootLocalId: 1, entities: [{ localId: 1, traits: {} }, { localId: 2, traits: {} }] };
    const [file, doc] = [...docs].find(([, d]) => isPrefabDocument(d) && (d as { entities: unknown[] }).entities.length >= 2) ?? ['minimal.prefab.json', minimal];
    const broken = structuredClone(doc) as { entities: Array<{ localId?: number }> };
    broken.entities[1]!.localId = broken.entities[0]!.localId;
    expect(refusals(new Map([...docs, [file, broken]]))).toEqual([expect.stringContaining('to two rows')]);
  });
});
