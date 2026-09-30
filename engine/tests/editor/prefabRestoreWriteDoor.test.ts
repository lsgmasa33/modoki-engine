/** #1877 C1, #1880 W2: the undo's landing (`'park'`, #1868) seats and parks a document that Save later writes, so it
 *  refuses what the write landing refuses — one invariant stage (`commitPrefabChanges`), before anything changes — not only "this document moved on since the step":
 *  - L2: the file is GONE (an Assets trash since the step evicts both caches). Restored, the park wrote the trashed prefab
 *    back at the next Save, behind a false "changed on disk" prompt. Unity brings no deleted asset back through an undo.
 *  - L1: the restored document would contain itself (I16) through a prefab changed outside the stack. Restored, Save
 *    refused for good until the park was discarded.
 *  Each with its accept side: a cold-cache document whose file is there, and a restore that nests without a cycle. The
 *  mark half (S1) is driven through the real Apply/undo/Save in `localIdCounter.test.ts`. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerAsset } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { clearDirtyAssets, peekDirtyAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { parkPrefabChanges } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';

registerAllTraits();

const A = 'cccccccc-0000-4000-8000-000001877a01';
const B = 'cccccccc-0000-4000-8000-000001877a02';
const AP = '/assets/prefabs/A1877.prefab.json';
const BP = '/assets/prefabs/B1877.prefab.json';
/** Files on disk: a GET answers from here, as the route does. */
const disk = new Set<string>();

const row = (localId: number, name: string, parentId: number, prefab?: string) => ({
  localId, name, nodeGuid: `eeeeeeee-0000-4000-8000-0018770${localId}${name.length}${name.charCodeAt(0) % 10}0`, ...(prefab ? { prefab } : {}),
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const docA = (nestsB: boolean): PrefabFile => ({
  id: A, version: 9, name: 'A', rootLocalId: 1, nextLocalId: 3, entities: [row(1, 'AR', 0), ...(nestsB ? [row(2, 'HoldsB', 1, B)] : [])],
} as unknown as PrefabFile);
const docB = (nestsA: boolean): PrefabFile => ({
  id: B, version: 9, name: 'B', rootLocalId: 1, nextLocalId: 3, entities: [row(1, 'BR', 0), ...(nestsA ? [row(2, 'HoldsA', 1, A)] : [])],
} as unknown as PrefabFile);
const seat = (guid: string, path: string, doc: PrefabFile | null) => { setPrefabCache(guid, doc as never); setPrefabCache(path, doc as never); };
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  clearDirtyAssets();
  disk.clear();
  registerAsset(A, AP, 'prefab');
  registerAsset(B, BP, 'prefab');
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('/api/exists')) {
      const asked = decodeURIComponent(String(url).split('path=')[1] ?? '');
      return new Response(JSON.stringify(disk.has(asked) ? { exists: true, path: asked } : { exists: false }), { status: 200 });
    }
    // A prefab GET (`documentNow` reads a file no cache or park holds): what the file holds, or a 404 once it is gone.
    const file = [AP, BP].find((p) => String(url).endsWith(p));
    if (file) return disk.has(file) ? new Response(JSON.stringify(file === AP ? docA(true) : docB(false)), { status: 200 }) : new Response('', { status: 404 });
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  });
  for (const k of ['log', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});
afterAll(() => { seat(A, AP, null); seat(B, BP, null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('#1877 L2: the undo of a write to a prefab trashed since then refuses, and brings nothing back', () => {
  // Mutation: drop the park landing's exists check (`p.file === 'absent'`) — the restore seats and parks A.
  it('the file is gone and no cache holds it: refused, nothing seated, nothing parked', async () => {
    seat(A, AP, null); // the trash evicted both caches; `disk` has no A
    const e = await refusal(parkPrefabChanges([{ source: A, doc: docA(false), from: docA(true) }], { rebase: false }));
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect(String((e as Error).message)).toMatch(/was deleted since this step/);
    expect(getCachedPrefabSync(A)).toBeFalsy();
    expect(peekDirtyAsset(AP)).toBeNull();
  });

  // Accept side. Mutation: refuse every document no cache holds (`p.file !== 'absent'` read as gone) — this goes red.
  it('a document no cache holds whose file IS there restores, parked for Save', async () => {
    seat(A, AP, null);
    disk.add(AP);
    await parkPrefabChanges([{ source: A, doc: docA(false), from: docA(true) }], { rebase: false });
    expect(getCachedPrefabSync(A)?.entities.map((r) => r.name)).toEqual(['AR']);
    expect(peekDirtyAsset(AP)).not.toBeNull();
  });
});

describe('#1880 close-out review: with nothing held, the file stands in for the precondition', () => {
  // A rig-prefab undo (it survives world swaps) whose prefab nothing in the scene uses: its keys are cold. The file was
  // trashed and put back with other content since. Parked over it, Save's precondition met the file it was parked over
  // and overwrote it unasked. Mutation: ask the precondition of `p.now.editor` only — this restores and parks.
  it('a cold prefab whose file holds another document than the step left refuses, and parks nothing', async () => {
    seat(A, AP, null);
    disk.add(AP); // the file holds docA(true)
    const e = await refusal(parkPrefabChanges([{ source: A, doc: docA(false), from: { ...docA(true), name: 'A as the step left it' } as PrefabFile }], { rebase: false }));
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect(String((e as Error).message)).toMatch(/changed since this step/);
    expect(peekDirtyAsset(AP)).toBeNull();
  });
});

describe('#1877 L1: a restore that would make a prefab contain itself refuses before anything changes (I16)', () => {
  // An Apply took B out of A; B's own prefab edit then placed an A and saved; undoing the Apply puts B back in A.
  // Mutation: `landParks` skips `selfContaining` — A is seated nesting B while B nests A.
  it('A restored to nest B, while B (changed outside the stack) nests A: refused, A left as it was', async () => {
    seat(A, AP, docA(false));
    seat(B, BP, docB(true));
    disk.add(AP).add(BP);
    const e = await refusal(parkPrefabChanges([{ source: A, doc: docA(true), from: docA(false) }], { rebase: false }));
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect(String((e as Error).message)).toMatch(/would contain itself/);
    expect(getCachedPrefabSync(A)?.entities.map((r) => r.name)).toEqual(['AR']);
    expect(peekDirtyAsset(AP)).toBeNull();
  });

  // Across the restored set: restoring A (nests B) and B (nests A) in ONE step is a cycle even though neither cache
  // shows it yet. Mutation: `read` consults only the caches, not the restored batch.
  it('a two-document step whose documents nest each other: refused, read through the restored set', async () => {
    seat(A, AP, docA(false));
    seat(B, BP, docB(false));
    disk.add(AP).add(BP);
    const e = await refusal(parkPrefabChanges([
      { source: A, doc: docA(true), from: docA(false) },
      { source: B, doc: docB(true), from: docB(false) },
    ], { rebase: false }));
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect(getCachedPrefabSync(B)?.entities.map((r) => r.name)).toEqual(['BR']);
  });

  // Accept side: nesting with no cycle restores. Mutation: the I16 loop refuses any document that nests a prefab.
  it('A restored to nest B, while B nests nothing: restored', async () => {
    seat(A, AP, docA(false));
    seat(B, BP, docB(false));
    disk.add(AP).add(BP);
    await parkPrefabChanges([{ source: A, doc: docA(true), from: docA(false) }], { rebase: false });
    expect(getCachedPrefabSync(A)?.entities.map((r) => r.name)).toEqual(['AR', 'HoldsB']);
  });
});
