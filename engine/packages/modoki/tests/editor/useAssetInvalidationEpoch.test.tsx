// @vitest-environment jsdom
/** useModelInvalidationEpoch + the MeshPreview reset key it feeds (#294).
 *
 *  The bug: a re-import rewrites the geometry behind an asset path WITHOUT changing
 *  the path, and every asset preview keyed on the path alone therefore never rebuilds
 *  — you keep looking at the pre-reimport mesh with nothing saying so.
 *
 *  These drive the REAL `invalidateModel` → `onModelInvalidated` chain (no listener
 *  stub), so they fail if the subscription, the filter, or the unsubscribe breaks.
 *  The MeshPreview case asserts the observable contract Preview3DShell acts on —
 *  `resetKey` CHANGES — which is exactly what was false before the fix. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';

const { useModelInvalidationEpoch, useAssetInvalidationEpoch, cacheBustReimport } =
  await import('../../src/editor/panels/useAssetInvalidationEpoch');
const { invalidateModel } = await import('../../src/runtime/loaders/meshTemplateCache');
const { invalidateTexture } = await import('../../src/runtime/loaders/textureResolver');

const MODEL = '/games/fixture/assets/models/thing.glb';
const OTHER = '/games/fixture/assets/models/other.glb';
const TEX = '/games/fixture/assets/textures/brick.png';

// The hook coalesces on a trailing timer (one Import click fires invalidateModel
// three times), so every assertion below has to flush it.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const settle = () => act(() => { vi.advanceTimersByTime(500); });
const invalidate = (path: string) => { act(() => { invalidateModel(path); }); settle(); };

describe('useModelInvalidationEpoch', () => {
  it('starts at 0 and bumps on every invalidation when unfiltered', () => {
    const { result } = renderHook(() => useModelInvalidationEpoch());
    expect(result.current).toBe(0);
    invalidate(MODEL);
    expect(result.current).toBe(1);
    invalidate(OTHER);
    expect(result.current).toBe(2);
  });

  it('bumps only for models the filter accepts', () => {
    const { result } = renderHook(() =>
      useModelInvalidationEpoch((_path, targets) => targets.has(MODEL)));
    invalidate(OTHER);
    expect(result.current).toBe(0); // unrelated re-import must not refetch a multi-MB GLB
    invalidate(MODEL);
    expect(result.current).toBe(1);
  });

  it('passes the invalidated path AND its LOD-sibling target set to the filter', () => {
    const matches = vi.fn(() => false);
    renderHook(() => useModelInvalidationEpoch(matches));
    invalidate(MODEL);
    expect(matches).toHaveBeenCalledTimes(1);
    const [modelPath, targets] = matches.mock.calls[0] as unknown as [string, ReadonlySet<string>];
    expect(modelPath).toBe(MODEL);
    expect(targets.has(MODEL)).toBe(true); // the model itself is always a target
  });

  it('does not resubscribe when the caller passes a fresh inline predicate each render', () => {
    const { result, rerender } = renderHook(() =>
      useModelInvalidationEpoch((_p, t) => t.has(MODEL)));
    rerender();
    rerender();
    invalidate(MODEL);
    expect(result.current).toBe(1); // 2 would mean a duplicate listener survived
  });

  it('unsubscribes on unmount', () => {
    const matches = vi.fn(() => true);
    const { unmount } = renderHook(() => useModelInvalidationEpoch(matches));
    unmount();
    invalidate(MODEL);
    expect(matches).not.toHaveBeenCalled();
  });

  it('coalesces one import\'s burst of invalidations into a SINGLE bump', () => {
    // Measured on games/sling: one Import click fired invalidateModel for the same
    // model 3x (2 ms apart, then 32 ms later). Uncoalesced, each one costs the
    // subscriber a full GLB refetch + re-parse.
    const { result } = renderHook(() => useModelInvalidationEpoch());
    act(() => {
      invalidateModel(MODEL);
      vi.advanceTimersByTime(2);
      invalidateModel(MODEL);
      vi.advanceTimersByTime(32);
      invalidateModel(MODEL);
    });
    settle();
    expect(result.current).toBe(1);
  });

  it('still bumps again for a LATER import, past the coalescing window', () => {
    const { result } = renderHook(() => useModelInvalidationEpoch());
    invalidate(MODEL);
    invalidate(MODEL);
    expect(result.current).toBe(2);
  });

  // #304 — the hook now watches ONE kind, over a registry all three caches emit
  // through. The kind is the only thing separating a Model Inspector from a
  // Texture Inspector, so a leak either way refreshes the wrong panel and leaves
  // the right one showing pre-reimport numbers.
  it('ignores a re-import of a different asset kind', () => {
    const { result } = renderHook(() => useModelInvalidationEpoch());
    act(() => { invalidateTexture(TEX); });
    settle();
    expect(result.current).toBe(0);
  });
});

describe('useAssetInvalidationEpoch(kind)', () => {
  it('bumps on a texture re-import and not on a model one', () => {
    const { result } = renderHook(() => useAssetInvalidationEpoch('texture'));
    invalidate(MODEL);
    expect(result.current).toBe(0);
    act(() => { invalidateTexture(TEX); });
    settle();
    expect(result.current).toBe(1);
  });

  it('narrows within the kind via the filter — the shape a Texture Inspector uses', () => {
    const { result } = renderHook(() => useAssetInvalidationEpoch('texture', (p) => p === TEX));
    act(() => { invalidateTexture('/games/fixture/assets/textures/other.png'); });
    settle();
    expect(result.current).toBe(0);
    act(() => { invalidateTexture(TEX); });
    settle();
    expect(result.current).toBe(1);
  });
});

describe('cacheBustReimport', () => {
  it('is a no-op before anything has been re-imported', () => {
    expect(cacheBustReimport('/assets/models/a.glb', 0)).toBe('/assets/models/a.glb');
  });

  it('appends the epoch so the browser cannot replay a rewritten URL', () => {
    expect(cacheBustReimport('/assets/models/a.glb', 2)).toBe('/assets/models/a.glb?reimport=2');
  });

  it('joins with & when the URL already carries a query', () => {
    expect(cacheBustReimport('/a.glb?v=abc', 1)).toBe('/a.glb?v=abc&reimport=1');
  });

  it('leaves blob:/data: URLs alone — a query suffix breaks blob-URL lookup', () => {
    // assetUrl resolves a path to a blob: URL under the playable build's
    // __PLAYABLE_ASSETS__; matching is by UUID, so `?reimport=` would 404 the model.
    expect(cacheBustReimport('blob:http://x/9d1f-uuid', 3)).toBe('blob:http://x/9d1f-uuid');
    expect(cacheBustReimport('data:model/gltf-binary;base64,AAA', 3)).toBe('data:model/gltf-binary;base64,AAA');
  });
});

describe('MeshPreview reset key', () => {
  it('changes on a re-import even though the path does not', async () => {
    const keys: string[] = [];
    vi.doMock('../../src/editor/panels/Preview3DShell', () => ({
      Preview3DShell: ({ resetKey }: { resetKey: string }) => { keys.push(resetKey); return null; },
    }));
    const { MeshPreview } = await import('../../src/editor/panels/MeshPreview');

    const path = '/games/fixture/assets/models/thing.mesh.json';
    render(<MeshPreview path={path} />);
    const before = keys.at(-1)!;
    invalidate(MODEL);
    const after = keys.at(-1)!;

    expect(before).toContain(path); // still addresses the right asset
    expect(after).toContain(path);
    expect(after).not.toBe(before);  // …and Preview3DShell will re-run `populate`
    vi.doUnmock('../../src/editor/panels/Preview3DShell');
  });
});
