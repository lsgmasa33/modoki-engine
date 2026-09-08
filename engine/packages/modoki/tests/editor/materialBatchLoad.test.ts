/** `MaterialBatchView`'s load + write-plan decision (#886).
 *
 *  The defect: a member whose read failed was represented as `{}`, which is TRUTHY, so the write
 *  plan's `if (!cur) continue` did not skip it — and a panel-origin flush is `replace: true`, i.e.
 *  a full replace that skips `/api/asset-write`'s dropped-field guard. One colour edit erased the
 *  material's shader, params and textures.
 *
 *  Both halves are asserted, because either alone is vacuous: excluding the failed member is
 *  worthless if the write plan then reaches it anyway, and a write plan that honours absence is
 *  worthless if the loader never produces one. */

import { describe, it, expect } from 'vitest';
import { loadMaterialBatch, planBatchWrite, type MatMap } from '../../src/editor/panels/assetViews/materialBatchLoad';
import { MissingAssetError } from '../../src/runtime/loaders/assetFetch';

const A = '/assets/materials/a.mat.json';
const B = '/assets/materials/b.mat.json';
const C = '/assets/materials/c.mat.json';

const docA = { id: 'guid-a', shader: 'pbr', color: 1, roughness: 0.5 };
const docB = { id: 'guid-b', shader: 'pbr', color: 2, roughness: 0.9 };

/** No park anywhere — the common case. */
const noPark = () => null;

describe('loadMaterialBatch', () => {
  it('excludes a member whose read REJECTED, and keeps its siblings', async () => {
    const { mats, unreadable } = await loadMaterialBatch([A, B], {
      parked: noPark,
      fetchDoc: (p) => (p === A ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(docB)),
    });
    expect(Object.keys(mats)).toEqual([B]);
    expect(mats[A]).toBeUndefined();       // ⚠️ absent, NOT `{}` — the whole fix
    expect(mats[B]).toEqual(docB);
    expect(unreadable).toEqual([{ path: A, message: 'Failed to fetch' }]);
  });

  it('excludes an ABSENT member too, and says so in words the human can act on', async () => {
    // Unlike the five asset EDITORS, materials get no "missing ⇒ load defaults" branch: this panel
    // never CREATES a material, so an absent `.mat.json` was deleted or renamed out from under the
    // selection. Both verdicts exclude — the classifier is consulted for the REASON.
    const { mats, unreadable } = await loadMaterialBatch([A, B], {
      parked: noPark,
      fetchDoc: (p) => (p === A ? Promise.reject(new MissingAssetError('404', { status: 404, absent: true })) : Promise.resolve(docB)),
    });
    expect(mats[A]).toBeUndefined();
    expect(Object.keys(mats)).toEqual([B]);
    expect(unreadable[0].message).toContain('no longer on disk');
  });

  it('excludes a body that parsed to a NON-OBJECT — otherwise the hole just moves', async () => {
    // `null` is falsy and would be skipped by the write plan anyway; `[]` and `3` are TRUTHY and
    // would be spread into a park exactly as `{}` was. All three are "not a material document".
    for (const body of [null, [], 3, 'x'] as unknown[]) {
      const { mats, unreadable } = await loadMaterialBatch([A], { parked: noPark, fetchDoc: () => Promise.resolve(body) });
      expect(mats[A]).toBeUndefined();
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0].path).toBe(A);
    }
  });

  it('loads every member when every read succeeds — the ACCEPT side', async () => {
    const { mats, unreadable } = await loadMaterialBatch([A, B], {
      parked: noPark,
      fetchDoc: (p) => Promise.resolve(p === A ? docA : docB),
    });
    expect(mats).toEqual({ [A]: docA, [B]: docB });
    expect(unreadable).toEqual([]);
  });

  it('prefers a PARKED document over the file, and never fetches it (#831/#843)', async () => {
    const parkedDoc = { id: 'guid-a', shader: 'pbr', color: 999 };
    const fetched: string[] = [];
    const { mats } = await loadMaterialBatch([A, B], {
      parked: (p) => (p === A ? parkedDoc : null),
      fetchDoc: (p) => { fetched.push(p); return Promise.resolve(docB); },
    });
    expect(mats[A]).toBe(parkedDoc);
    expect(fetched).toEqual([B]);          // A's file was never read — the park is newer
  });

  it('does not accept a NON-OBJECT park either', async () => {
    // `pendingAssetDoc` is typed `unknown`, so the park side needs the same shape check the fetch
    // side has — an agent op or a corrupt restore could put anything in the registry.
    const { mats, unreadable } = await loadMaterialBatch([A], {
      parked: () => [] as unknown,
      fetchDoc: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect(mats[A]).toBeUndefined();
    expect(unreadable).toHaveLength(1);
  });
});

describe('planBatchWrite', () => {
  const paint = (d: Record<string, unknown>) => ({ ...d, color: 42 });

  it('reaches only the members present in the map — an excluded one is never written', () => {
    // #886's acceptance criterion, exactly: "a material whose read fails is NOT parked by a batch
    // edit, and the other members of the same batch selection still are."
    const mats: MatMap = { [B]: docB };            // A was excluded by the loader
    const { prev, next } = planBatchWrite([A, B], mats, paint);
    expect(Object.keys(next)).toEqual([B]);
    expect(Object.keys(prev)).toEqual([B]);
    expect(next[B]).toEqual({ ...docB, color: 42 });
    expect(prev[B]).toBe(docB);                    // undo target is the doc that was on screen
  });

  it('writes every member when none was excluded — the ACCEPT side', () => {
    const { next } = planBatchWrite([A, B], { [A]: docA, [B]: docB }, paint);
    expect(Object.keys(next)).toEqual([A, B]);
    expect(next[A]).toEqual({ ...docA, color: 42 });
    expect(next[B]).toEqual({ ...docB, color: 42 });
  });

  it('does not mutate the loaded documents in place — `prev` must survive as the undo target', () => {
    // Replaces a test that asserted `next[p].id` survived: `planBatchWrite` never touches fields,
    // so that only ever proved the TEST's own `paint` spreads, and no mutation of the source could
    // fail it. This one can: rewrite the body as `Object.assign(cur, mutate(cur))` — the obvious
    // "avoid an allocation" refactor — and `prev` becomes the mutated object, so undo restores the
    // edit it was meant to revert. Same shape as the `_isFileDirect` undo entry the panel pushes.
    const a = { id: 'guid-a', color: 1 };
    const mats: MatMap = { [A]: a };
    const { prev, next } = planBatchWrite([A], mats, paint);
    expect(a).toEqual({ id: 'guid-a', color: 1 });   // the source document is untouched
    expect(prev[A]).toBe(a);                          // undo restores the object that was on screen
    expect(next[A]).not.toBe(a);                      // …and the write is a different object
    expect(next[A]).toEqual({ id: 'guid-a', color: 42 });
  });

  it('skips a path that is in the selection but not in the map, in either order', () => {
    expect(Object.keys(planBatchWrite([A, B, C], { [B]: docB }, paint).next)).toEqual([B]);
    expect(Object.keys(planBatchWrite([C, B, A], { [B]: docB }, paint).next)).toEqual([B]);
  });
});

describe('loadMaterialBatch reports which members came from the PARK (#902)', () => {
  it('names a park-sourced member, and does not name a file-sourced one', () => {
    // The disclosure the batch view renders. Without it the diversion is invisible: the human is
    // told to repair the file and press Retry, the Retry adopts an agent's park, the banner clears,
    // and Cmd+S replaces the repair.
    const parkedA = { id: 'guid-a', shader: 'pbr', color: 99 };
    return loadMaterialBatch([A, B], {
      parked: (p) => (p === A ? parkedA : null),
      fetchDoc: () => Promise.resolve(docB),
    }).then(({ mats, adopted, unreadable }) => {
      expect(adopted).toEqual([A]);
      expect(mats[A]).toBe(parkedA);   // the PARK, not the file — the ordering is unchanged
      expect(mats[B]).toEqual(docB);
      expect(unreadable).toEqual([]);
    });
  });

  it('reports NOTHING when every member came from the file — the accept side', async () => {
    // A reporter that named every member would satisfy the assertion above just as happily, and
    // would put a permanent "you are editing unsaved work" banner on every clean batch.
    const { adopted } = await loadMaterialBatch([A, B], { parked: noPark, fetchDoc: () => Promise.resolve(docA) });
    expect(adopted).toEqual([]);
  });

  it('reports in SELECTION order, not in whichever order the reads settled', async () => {
    // `Promise.all` resolves concurrently, so an unsorted list reshuffles between loads and the
    // banner's rows jump around for no reason the human can see.
    const { adopted } = await loadMaterialBatch([A, B, C], {
      parked: (p) => (p === A || p === C ? { id: `guid${p}`, shader: 'pbr' } : null),
      fetchDoc: () => Promise.resolve(docB),
    });
    expect(adopted).toEqual([A, C]);
  });

  it('does not name a member whose park was a NON-OBJECT — it took the file path', async () => {
    // The `typeof parked === 'object'` guard: a truthy non-object park falls through to the fetch,
    // so claiming it was adopted would be a false statement about which document is open.
    const { adopted, mats } = await loadMaterialBatch([A], {
      parked: () => 3 as unknown as Record<string, unknown>,
      fetchDoc: () => Promise.resolve(docA),
    });
    expect(adopted).toEqual([]);
    expect(mats[A]).toEqual(docA);
  });
});
