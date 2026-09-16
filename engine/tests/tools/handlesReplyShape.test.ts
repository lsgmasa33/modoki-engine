/** `shapeHandlesReply` — the summary both `modoki_handles` and `device_handles` answer through.
 *
 *  This seam had NO test. It was written for #1216 C-14 so the two surfaces could not diverge, and
 *  a review of #1266 found it silently turning a correct op reply into a false one: the bare-call
 *  branch strips the rows and spreads the rest of the reply through, so the moment `handlesDump`
 *  renamed its row count `count` -> `returnedCount`, a bare call answered `returnedCount: N` with
 *  no `handles` key at all. The unit tests either side of it (`handlesDump.test.ts` on the producer,
 *  the registry guards on the schema) both stayed green, because neither runs THIS function.
 *
 *  So the cases below are about the SHAPING, not the counting: which fields survive each branch. */

import { describe, it, expect } from 'vitest';
import { shapeHandlesReply, isBareHandlesFilter, type HandlesResponse } from '../../tools/shared/handlesReply';

const REMEDIES = { noHandles: 'nothing exposes handles.', nothingLive: 'nothing is live.' };

/** A producer reply shaped like `computeHandles` — rows plus the counters that describe them. */
const dump = (n: number): HandlesResponse => ({
  returnedCount: n,
  totalCount: n,
  editors: n ? ['chrome'] : [],
  offScreenCount: 0,
  occludedCount: 0,
  occlusionUnchecked: 0,
  disabledCount: 0,
  viewport: { w: 800, h: 600 },
  handles: Array.from({ length: n }, (_, i) => ({ id: `chrome.btn${i}`, editor: 'chrome', kind: 'button', label: `Btn ${i}` })),
});

const noFetch = async () => null;

describe('the bare-call summary returns NO rows, so it must not claim it returned any', () => {
  // The defect this file exists for. Mutation: drop `returnedCount: _returnedCount` from the
  // destructure in shapeHandlesReply and this goes red — the count rides through on `...meta`.
  it('drops returnedCount, because there is no `handles` key for it to describe', async () => {
    const r = await shapeHandlesReply(dump(2000), {}, noFetch, REMEDIES);
    expect(r.handles).toBeUndefined();
    expect(r).not.toHaveProperty('returnedCount');
  });

  // …but the question a bare call IS answering ("how many are there?") must survive.
  // Mutation: add `totalCount` to the destructure too and this goes red.
  it('keeps totalCount and the per-editor/per-kind histograms', async () => {
    const r = await shapeHandlesReply(dump(3), {}, noFetch, REMEDIES);
    expect(r.totalCount).toBe(3);
    expect(r.byEditor).toEqual({ chrome: 3 });
    expect(r.byKind).toEqual({ button: 3 });
    expect(r.hint).toContain('Counts only');
  });

  it('keeps the diagnostic counters, which are a PAIR — occludedCount alone is not an all-clear', async () => {
    const r = await shapeHandlesReply(dump(2), {}, noFetch, REMEDIES);
    expect(r.occludedCount).toBe(0);
    expect(r.occlusionUnchecked).toBe(0);
  });

  it('an EMPTY bare call hints at the surface remedy, not at a filter', async () => {
    const r = await shapeHandlesReply(dump(0), {}, noFetch, REMEDIES);
    expect(r.hint).toBe(REMEDIES.noHandles);
    expect(r).not.toHaveProperty('returnedCount');
  });
});

describe('a FILTERED call that matched rows is passed through untouched', () => {
  // The rows ARE the answer here, so `returnedCount` is true and must survive. This is the case
  // that stops the fix above from being "delete returnedCount everywhere".
  it('keeps returnedCount and the handles themselves', async () => {
    const r = await shapeHandlesReply(dump(2), { editor: 'chrome' }, noFetch, REMEDIES);
    expect(r.returnedCount).toBe(2);
    expect(r.handles).toHaveLength(2);
  });
});

describe('a FILTERED call that matched NOTHING says what IS live', () => {
  // Zero rows is a true `returnedCount: 0` — the reply still carries `handles: []`, so the count
  // describes something. Mutation: strip returnedCount unconditionally and this goes red.
  it('keeps returnedCount:0 beside the empty rows, and names the live editors/kinds', async () => {
    const r = await shapeHandlesReply(dump(0), { editor: 'nope' }, async () => dump(4), REMEDIES);
    expect(r.returnedCount).toBe(0);
    expect(r.byEditor).toEqual({ chrome: 4 });
    expect(String(r.hint)).toContain('editor=nope');
    expect(String(r.hint)).toContain('chrome');
  });

  it('falls back to the surface remedy when nothing at all is live', async () => {
    const r = await shapeHandlesReply(dump(0), { editor: 'nope' }, async () => dump(0), REMEDIES);
    expect(String(r.hint)).toContain(REMEDIES.nothingLive);
  });

  it('a failing re-fetch does not lose the primary answer', async () => {
    const r = await shapeHandlesReply(dump(0), { kind: 'nope' }, async () => { throw new Error('relay down'); }, REMEDIES);
    expect(r.returnedCount).toBe(0);
    expect(String(r.hint)).toContain('kind=nope');
  });
});

describe('isBareHandlesFilter decides which branch runs, so it must count every filter', () => {
  it('bare is bare', () => expect(isBareHandlesFilter({})).toBe(true));
  it.each([
    ['editor', { editor: 'chrome' }],
    ['kind', { kind: 'button' }],
    ['ids', { ids: ['a'] }],
    ['prefix', { prefix: 'dialog.' }],
    ['label', { label: 'Save' }],
  ])('%s is not bare', (_name, filter) => {
    expect(isBareHandlesFilter(filter)).toBe(false);
  });

  // An empty `ids` array is not a filter — it narrows nothing, so it must take the bare branch
  // rather than the "matched nothing" one, which would answer a misleading "no handle matches".
  it('an EMPTY ids array is bare, not a filter that matched nothing', () => {
    expect(isBareHandlesFilter({ ids: [] })).toBe(true);
  });
});

describe('a reply with no handles array is not shaped at all', () => {
  // A relay error or an older app build can answer something that is not a dump. Shaping it would
  // invent counts for rows nobody returned.
  it('passes a non-dump reply straight through', async () => {
    const err = { error: { code: 'NOT_AVAILABLE_HERE' } } as unknown as HandlesResponse;
    expect(await shapeHandlesReply(err, {}, noFetch, REMEDIES)).toBe(err);
  });
});
