/** #1880 W5 (#1881): a link change that puts prefab links back asks `requireLinks` BEFORE it changes anything, and
 *  refuses when a link would be LOST — its entity no longer resolves AND the prefab it names is gone (trashed since).
 *  Create Prefab's undo used to change the tree and count the miss afterwards (seed 1012; the fuzz regression drives the
 *  real undo). Here, the rule itself, with both sides:
 *  - refused: an unresolved link to a prefab whose file is gone, named by the path it lived at;
 *  - accepted: an unresolved link to a prefab that still exists — #1272's case, a held nested frame whose guid a reload
 *    re-derived, which keeps its own link;
 *  - accepted without a read: every link resolves. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerAsset } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { requireLinks, type DetachSnapshot } from '../../packages/modoki/src/editor/scene/prefabLink';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';

registerAllTraits();

const Q = 'cccccccc-0000-4000-8000-000000001881';
const QP = '/assets/prefabs/Q1881.prefab.json';
const disk = new Set<string>();
const reads: string[] = [];

/** A link as a snapshot records it: `live` says whether its entity (and root) still resolve. */
const link = (live: boolean) => ({
  id: 7, data: { source: Q, localId: 1, parentLocalId: 4 }, marks: {} as never,
  ref: { rawId: 7, resolve: () => (live ? 7 : null) }, rootRef: { rawId: 7, resolve: () => (live ? 7 : null) },
}) as unknown as DetachSnapshot['links'][number];
const snapshot = (...links: DetachSnapshot['links']): DetachSnapshot => ({ links, orphans: [] });
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  disk.clear();
  reads.length = 0;
  registerAsset(Q, QP, 'prefab');
  setPrefabCache(Q, null); // a trash evicts both caches: nothing holds Q, so the file is asked
  vi.stubGlobal('fetch', async (url: string) => {
    reads.push(String(url));
    return String(url).endsWith(QP) && disk.has(QP) ? new Response(JSON.stringify({ id: Q, name: 'Q', entities: [] }), { status: 200 }) : new Response('', { status: 404 });
  });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('requireLinks (#1880 W5)', () => {
  // Mutation: drop the check (return at once) — nothing refuses, and the caller half-applies.
  it('an unresolved link to a prefab deleted since refuses, naming the prefab, before anything changes', async () => {
    const e = await refusal(requireLinks(snapshot(link(false), link(false)), '"Save prefab "R""'));
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect(String((e as Error).message)).toBe(`"Save prefab "R"" was not undone: 2 of the prefab links it puts back name ${QP}, which was deleted since, so nothing was changed.`);
  });

  // Accept side (#1272). Mutation: refuse every unresolved link (drop the `prefabFileGone` test) — this goes red.
  it('an unresolved link to a prefab that still exists is not refused', async () => {
    disk.add(QP);
    await expect(requireLinks(snapshot(link(false)), 'the step')).resolves.toBeUndefined();
  });

  // Mutation: ask the file for every link — a read is made.
  it('links that all resolve read nothing and refuse nothing', async () => {
    await expect(requireLinks(snapshot(link(true), link(true)), 'the step')).resolves.toBeUndefined();
    expect(reads).toEqual([]);
  });
});
