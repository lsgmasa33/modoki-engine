/** revalidateSubtreeAfterRendererRebuild unit tests (#678).
 *
 *  Pure unit tests against plain objects shaped like Pixi display objects — no real Pixi
 *  renderer. What matters here is the WALK, the delete-vs-keep decision for `_gpuData`, and the
 *  `onViewUpdate` call — not anything Pixi itself does; see `gpuResourceInvalidation.ts`'s file
 *  header for the mechanism this guards (the isolation-test table establishing that `onViewUpdate`
 *  is what actually restores a blank frame, not the `_gpuData` purge alone).
 *
 *  The purge target is a caller-supplied `deadRendererUids` set (renderers that have already been
 *  destroyed — see `deadRendererUids` in `canvas2DPool.ts`), not a
 *  "live renderer uids" set — see the file header for why a live-set exclusion is wrong once more
 *  than one renderer/pool exists. */

import { describe, it, expect, vi } from 'vitest';

import { revalidateSubtreeAfterRendererRebuild } from '../../src/runtime/rendering/gpuResourceInvalidation';

/** A minimal "Pixi-shaped" node: a `_gpuData` cache keyed by (stringified) renderer uid, plus
 *  whichever of context/geometry/texture/children/onViewUpdate this test needs. */
function node(overrides: Record<string, unknown> = {}) {
  return { _gpuData: {}, children: [], ...overrides } as any;
}

describe('revalidateSubtreeAfterRendererRebuild', () => {
  it('deletes only the dead renderer\'s entry, keeping every other uid', () => {
    const root = node({ _gpuData: { 1: 'dead-gpu-object', 2: 'live-gpu-object' } });

    const { gpuDataPurged } = revalidateSubtreeAfterRendererRebuild(root, [1]);

    expect(gpuDataPurged).toBe(1);
    expect(root._gpuData).toEqual({ 2: 'live-gpu-object' });
  });

  it('purges nothing when deadRendererUid is undefined, but still runs the onViewUpdate pass', () => {
    const view = node({ onViewUpdate: vi.fn() });
    const root = node({ _gpuData: { 1: 'untouched' }, children: [view] });

    const { gpuDataPurged, viewsMarked } = revalidateSubtreeAfterRendererRebuild(root, undefined);

    expect(gpuDataPurged).toBe(0);
    expect(root._gpuData).toEqual({ 1: 'untouched' });
    expect(viewsMarked).toBe(1);
    expect(view.onViewUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns zeroed counts and touches nothing when root is null/undefined', () => {
    expect(revalidateSubtreeAfterRendererRebuild(null, [1])).toEqual({ gpuDataPurged: 0, viewsMarked: 0 });
    expect(revalidateSubtreeAfterRendererRebuild(undefined, [1])).toEqual({ gpuDataPurged: 0, viewsMarked: 0 });
  });

  it('reaches all five holder positions: node itself, context, geometry, texture.source, geometry.buffers[]', () => {
    const buffer1 = node({ _gpuData: { 1: 'buf1-dead' } });
    const buffer2 = node({ _gpuData: { 1: 'buf2-dead' } });
    const root = node({
      _gpuData: { 1: 'self-dead' },
      context: node({ _gpuData: { 1: 'context-dead' } }),
      geometry: node({ _gpuData: { 1: 'geometry-dead' }, buffers: [buffer1, buffer2] }),
      texture: { source: node({ _gpuData: { 1: 'texture-source-dead' } }) },
    });

    const { gpuDataPurged } = revalidateSubtreeAfterRendererRebuild(root, [1]);

    // 5 holder POSITIONS, but `geometry.buffers[]` contributes two, so 6 entries total
    // (self, context, geometry, texture.source, buffer1, buffer2)
    expect(gpuDataPurged).toBe(6);
    expect(root._gpuData).toEqual({});
    expect(root.context._gpuData).toEqual({});
    expect(root.geometry._gpuData).toEqual({});
    expect(root.texture.source._gpuData).toEqual({});
    expect(buffer1._gpuData).toEqual({});
    expect(buffer2._gpuData).toEqual({});
  });

  it('returns the correct total deleted count across a subtree', () => {
    const child = node({ _gpuData: { 1: 'a', 3: 'c' } });
    const root = node({ _gpuData: { 1: 'x' }, children: [child] });

    const { gpuDataPurged } = revalidateSubtreeAfterRendererRebuild(root, [1]);

    expect(gpuDataPurged).toBe(2); // root's "1" + child's "1"; child's "3" survives
    expect(root._gpuData).toEqual({});
    expect(child._gpuData).toEqual({ 3: 'c' });
  });

  it('terminates on a cyclic graph instead of looping forever', () => {
    const a: any = node({ _gpuData: { 1: 'a-dead' } });
    const b: any = node({ _gpuData: { 1: 'b-dead' } });
    a.children = [b];
    b.children = [a]; // b's child is an ancestor — cycle

    const { gpuDataPurged } = revalidateSubtreeAfterRendererRebuild(a, [1]);

    expect(gpuDataPurged).toBe(2);
    expect(a._gpuData).toEqual({});
    expect(b._gpuData).toEqual({});
  });

  it('a holder whose _gpuData access throws does not abort the walk — later siblings still purged', () => {
    const child1: any = { children: [] };
    Object.defineProperty(child1, '_gpuData', {
      get(): Record<string, unknown> { throw new Error('boom'); },
    });
    const child2 = node({ _gpuData: { 1: 'still-dead' } });
    const root = node({ _gpuData: {}, children: [child1, child2] });

    let result: { gpuDataPurged: number; viewsMarked: number } = { gpuDataPurged: 0, viewsMarked: 0 };
    expect(() => { result = revalidateSubtreeAfterRendererRebuild(root, [1]); }).not.toThrow();

    expect(result.gpuDataPurged).toBe(1);
    expect(child2._gpuData).toEqual({});
  });

  // `purgeHolder` no longer enumerates `_gpuData`'s keys at all — it does one `in` check plus one
  // exact `delete` per dead uid — so a non-numeric key surviving is true BY CONSTRUCTION today.
  // Kept anyway: it still fires (and would still catch a regression) if a key-enumerating sweep is
  // ever reintroduced, so it pins the "no sweep" property rather than testing live behaviour.
  it('an exact-key delete cannot touch non-numeric keys — pins the no-sweep property', () => {
    const root = node({ _gpuData: { foo: 'not-a-uid', 1: 'dead' } });

    const { gpuDataPurged } = revalidateSubtreeAfterRendererRebuild(root, [1]);

    expect(gpuDataPurged).toBe(1);
    expect(root._gpuData).toEqual({ foo: 'not-a-uid' });
  });

  // ── onViewUpdate (#678 — the actual cure for the blank frame, per the file header) ──────────

  it('calls onViewUpdate on every node that has one', () => {
    const child1 = node({ onViewUpdate: vi.fn() });
    const child2 = node({ onViewUpdate: vi.fn() });
    const root = node({ children: [child1, child2] });

    revalidateSubtreeAfterRendererRebuild(root, [1]);

    expect(child1.onViewUpdate).toHaveBeenCalledTimes(1);
    expect(child2.onViewUpdate).toHaveBeenCalledTimes(1);
  });

  it('skips a node without onViewUpdate without throwing', () => {
    const plain = node(); // a plain Container — no onViewUpdate
    const root = node({ children: [plain] });

    let result: { gpuDataPurged: number; viewsMarked: number } = { gpuDataPurged: 0, viewsMarked: 0 };
    expect(() => { result = revalidateSubtreeAfterRendererRebuild(root, [1]); }).not.toThrow();

    expect(result.viewsMarked).toBe(0);
  });

  it('a node whose onViewUpdate THROWS does not abort the walk', () => {
    const thrower = node({ onViewUpdate: () => { throw new Error('boom'); } });
    const sibling = node({ onViewUpdate: vi.fn() });
    const root = node({ children: [thrower, sibling] });

    let result: { gpuDataPurged: number; viewsMarked: number } = { gpuDataPurged: 0, viewsMarked: 0 };
    expect(() => { result = revalidateSubtreeAfterRendererRebuild(root, [1]); }).not.toThrow();

    expect(sibling.onViewUpdate).toHaveBeenCalledTimes(1);
    expect(result.viewsMarked).toBe(1); // thrower does not count; sibling does
  });

  it('viewsMarked counts correctly across a mixed subtree', () => {
    const withUpdate1 = node({ onViewUpdate: vi.fn() });
    const withUpdate2 = node({ onViewUpdate: vi.fn() });
    const withoutUpdate = node();
    const root = node({ onViewUpdate: vi.fn(), children: [withUpdate1, withUpdate2, withoutUpdate] });

    const { viewsMarked } = revalidateSubtreeAfterRendererRebuild(root, [1]);

    expect(viewsMarked).toBe(3); // root + withUpdate1 + withUpdate2; withoutUpdate does not count
  });
});
