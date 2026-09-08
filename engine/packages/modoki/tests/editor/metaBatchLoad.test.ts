/** The meta batch views' load + write-plan decision, and the park verdict they rest on (#903).
 *
 *  The defect: both views set their local map for EVERY selected path and called `parkMetaEdit`,
 *  which returned `void`. A member whose sidecar read had failed was represented by the TAGGED
 *  fallback — which is exactly what the registry refuses — so its row showed the new value, the
 *  park was dropped, and Cmd+S wrote the others. N of M, silently.
 *
 *  ⚠️ **Both halves are asserted, and either alone is vacuous** (the same argument
 *  `materialBatchLoad.test.ts` makes): excluding the unreadable member is worthless if the write
 *  plan reaches it anyway, and a plan that honours absence is worthless if the loader never
 *  produces one. And both are asserted against their ACCEPT side too — proving the loader excludes
 *  a bad member says nothing about a good one still landing, which is the half a fix like this
 *  breaks. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  loadMetaBatch, planMetaBatchWrite, parkPlannedMetaEdits, type MetaMap,
} from '../../src/editor/panels/assetViews/metaBatchLoad';
import {
  classifyMetaPark, parkMetaEdit, peekPendingMeta, clearPendingMeta,
  metaReadFallback, stampMetaReadPath,
} from '../../src/editor/scene/pendingMeta';

const A = '/assets/textures/a.png';
const B = '/assets/textures/b.png';
const C = '/assets/textures/c.png';

/** What `readMetaPreferringPark` hands a panel for a GOOD read: the document, stamped for the path
 *  it was read for. Unstamped, the registry refuses it — so building the fixture any other way
 *  would make every "accepted" assertion below silently test the refusal instead. */
const good = (path: string, doc: Record<string, unknown> = {}) => stampMetaReadPath({ id: `guid${path}`, ...doc }, path);

afterEach(() => { clearPendingMeta(); });

describe('classifyMetaPark — one predicate, two consumers (#903)', () => {
  it('ACCEPTS a document stamped for its own path', () => {
    // The accept side, first and deliberately: a classifier that refused everything would satisfy
    // every rejection assertion below and break the editor completely.
    expect(classifyMetaPark(A, good(A))).toEqual({ parked: true });
  });

  it('refuses a document built on a FAILED read', () => {
    expect(classifyMetaPark(A, metaReadFallback())).toEqual({ parked: false, reason: 'failed-read' });
  });

  it('refuses an UNSTAMPED document, naming that nothing was read', () => {
    expect(classifyMetaPark(A, { id: 'guid-a' })).toEqual({ parked: false, reason: 'foreign-read', readFor: undefined });
  });

  it("refuses another path's document, and names the path it was read for", () => {
    expect(classifyMetaPark(A, good(B))).toEqual({ parked: false, reason: 'foreign-read', readFor: B });
  });

  it('is the SAME decision parkMetaEdit makes — the verdict is returned, not swallowed', () => {
    // ⚠️ This is the assertion that keeps the two from drifting. If `parkMetaEdit` ever grows its
    // own copy of the predicate again, one of these two comparisons stops holding.
    expect(parkMetaEdit(A, good(A))).toEqual(classifyMetaPark(A, good(A)));
    expect(parkMetaEdit(B, metaReadFallback())).toEqual(classifyMetaPark(B, metaReadFallback()));
    // …and the accepted one actually landed, while the refused one did not.
    expect(peekPendingMeta(A)).toBeDefined();
    expect(peekPendingMeta(B)).toBeUndefined();
  });

  it('returns a TRUTHY object even when it refuses — so `.parked` is the only correct test', () => {
    // The trap this union exists to make unwriteable: `if (!parkMetaEdit(...))` is dead code.
    const refused = parkMetaEdit(A, metaReadFallback());
    expect(refused.parked).toBe(false);
    expect(Boolean(refused)).toBe(true);
  });
});

describe('loadMetaBatch', () => {
  it('excludes a member whose read REJECTED, and keeps its siblings', async () => {
    const { metas, unreadable } = await loadMetaBatch([A, B], {
      readMeta: (p) => (p === A
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({ meta: good(B) })),
    });
    expect(Object.keys(metas)).toEqual([B]);
    expect(metas[A]).toBeUndefined();   // ⚠️ ABSENT, not a fallback document — the whole fix
    expect(unreadable).toEqual([{ path: A, message: 'reading its import settings failed — Failed to fetch' }]);
  });

  it('excludes a member handed the FAILED-READ fallback, which is how a non-ok GET arrives', async () => {
    // `readMetaPreferringPark` substitutes `metaReadFallback()` for a non-ok response rather than
    // throwing, so this — not the rejection above — is the path #903's own scenario takes.
    const { metas, unreadable } = await loadMetaBatch([A, B], {
      readMeta: (p) => Promise.resolve({ meta: p === A ? metaReadFallback() : good(B) }),
    });
    expect(Object.keys(metas)).toEqual([B]);
    expect(unreadable).toEqual([
      { path: A, message: 'its import settings could not be read, so the editor has no GUID for it' },
    ]);
  });

  it('admits EVERY member when every read is good — the accept side', async () => {
    const { metas, unreadable } = await loadMetaBatch([A, B, C], {
      readMeta: (p) => Promise.resolve({ meta: good(p) }),
    });
    expect(Object.keys(metas).sort()).toEqual([A, B, C].sort());
    expect(unreadable).toEqual([]);
  });

  it('treats an EMPTY sidecar as editable — an absent .meta.json is not a failed read', async () => {
    // `/api/read-meta` answers a file with no sidecar as `{}` with `ok: true`, and that document is
    // stamped and parkable. Excluding it would make a freshly-imported asset unauthorable in a
    // batch — the "no missing ⇒ defaults branch" note in the module's docblock.
    const { metas, unreadable } = await loadMetaBatch([A], {
      readMeta: (p) => Promise.resolve({ meta: stampMetaReadPath({}, p) }),
    });
    expect(metas[A]).toBeDefined();
    expect(unreadable).toEqual([]);
  });
});

describe('planMetaBatchWrite', () => {
  it('reaches only the members the loader admitted', () => {
    const metas: MetaMap = { [B]: good(B) };   // A was excluded
    const next = planMetaBatchWrite([A, B], metas, (m) => ({ ...m, maxSize: 512 }));
    expect(Object.keys(next)).toEqual([B]);
    expect(next[A]).toBeUndefined();
  });

  it('still reaches every ADMITTED member — the accepted subset must keep landing', () => {
    const metas: MetaMap = { [A]: good(A), [B]: good(B) };
    const next = planMetaBatchWrite([A, B], metas, (m) => ({ ...m, maxSize: 512 }));
    expect(Object.keys(next).sort()).toEqual([A, B].sort());
    expect(next[A].maxSize).toBe(512);
    expect(next[B].maxSize).toBe(512);
  });

  it('runs `mutate` PER MEMBER, so a derived nested object is not shared across paths', () => {
    // The `applyType` trap: hoisting the derived codec block gave every parked entry the same
    // `texture` reference, and `parkMetaEdit` copies only the top level.
    const metas: MetaMap = { [A]: good(A), [B]: good(B) };
    const next = planMetaBatchWrite([A, B], metas, (m) => ({ ...m, texture: { format: 'ktx2-uastc' } }));
    expect(next[A].texture).not.toBe(next[B].texture);
  });

  it('keeps the SELECTION order, not the map\'s', () => {
    const metas: MetaMap = { [B]: good(B), [A]: good(A) };
    expect(Object.keys(planMetaBatchWrite([A, B], metas, (m) => m))).toEqual([A, B]);
  });
});

describe('parkPlannedMetaEdits', () => {
  it('parks every planned member', () => {
    const plan = planMetaBatchWrite([A, B], { [A]: good(A), [B]: good(B) }, (m) => ({ ...m, maxSize: 512 }));
    parkPlannedMetaEdits(plan, 'TextureBatchView');
    expect(peekPendingMeta(A)).toMatchObject({ maxSize: 512 });
    expect(peekPendingMeta(B)).toMatchObject({ maxSize: 512 });
  });

  it('reports an INVARIANT violation rather than returning quietly when a park is refused', () => {
    // Unreachable through the views (the loader excluded whatever the registry would refuse), so
    // this asserts the tripwire, not a live path. It must not be a silent `return`: that is #903's
    // own defect, re-introduced inside its fix.
    const errors: string[] = [];
    const spy = console.error;
    console.error = (...a: unknown[]) => { errors.push(String(a[0])); };
    try {
      parkPlannedMetaEdits({ [A]: metaReadFallback() as Record<string, unknown> }, 'TextureBatchView');
    } finally {
      console.error = spy;
    }
    expect(errors.some((e) => e.includes('INVARIANT') && e.includes(A))).toBe(true);
    expect(peekPendingMeta(A)).toBeUndefined();
  });

  it('says NOTHING when every planned park is accepted', () => {
    // The accept side of the tripwire: a reporter that fires unconditionally would satisfy the
    // assertion above just as happily.
    const errors: unknown[] = [];
    const spy = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      parkPlannedMetaEdits({ [A]: good(A) }, 'TextureBatchView');
    } finally {
      console.error = spy;
    }
    expect(errors).toEqual([]);
  });
});
