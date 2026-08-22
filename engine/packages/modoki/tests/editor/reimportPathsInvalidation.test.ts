/** reimportPaths — the batch re-import loop behind the Assets panel's "Re-import all"
 *  and the multi-select batch Inspector views (#304 close-out).
 *
 *  The bug this pins: it evicted the browser-side caches for models and textures ONLY,
 *  while the server has re-import handlers for seven asset types. A batch re-import of
 *  a `.wav` therefore re-encoded the file and left the decoded AudioBuffer playing the
 *  OLD audio until an editor restart; an `.hdr` left the viewport lit by the old
 *  environment. Both are silent — the conversion reports success.
 *
 *  Driven through the REAL invalidate* functions (only the HTTP transport is stubbed),
 *  and observed on the shared invalidation event, so a kind that stops being dispatched
 *  fails here rather than in a viewport nobody is looking at. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const backendFetchMock = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...args: unknown[]) => backendFetchMock(...args),
}));

const { reimportPaths } = await import('../../src/editor/panels/assetViews/reimport');
const { onAssetInvalidated, clearAssetInvalidationListeners } =
  await import('../../src/runtime/core/assetInvalidation');

const ok = () => Promise.resolve({ json: () => Promise.resolve({ converted: 1, errors: [] }) });
const noop = () => {};

beforeEach(() => {
  clearAssetInvalidationListeners();
  backendFetchMock.mockReset();
  backendFetchMock.mockImplementation(ok);
});

const ITEMS = [
  { path: '/assets/models/a.glb', type: 'model' },
  { path: '/assets/textures/t.png', type: 'texture' },
  { path: '/assets/audio/hit.wav', type: 'audio' },
  { path: '/assets/env/studio.hdr', type: 'environment' },
];

describe('reimportPaths cache eviction', () => {
  it('announces every cache-holding kind it re-imported, not just models + textures', async () => {
    const fired: Array<[string, string]> = [];
    onAssetInvalidated((kind, path) => { fired.push([kind, path]); });

    await reimportPaths(ITEMS, noop, 'Re-importing…');

    expect(fired).toEqual([
      ['model', '/assets/models/a.glb'],
      ['texture', '/assets/textures/t.png'],
      ['audio', '/assets/audio/hit.wav'],
      ['environment', '/assets/env/studio.hdr'],
    ]);
  });

  it('does not evict for an item whose conversion reported errors', async () => {
    backendFetchMock.mockImplementation(() =>
      Promise.resolve({ json: () => Promise.resolve({ errors: ['boom'] }) }));
    const fired: string[] = [];
    onAssetInvalidated((kind) => { fired.push(kind); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await reimportPaths(ITEMS, noop, 'Re-importing…');

    // Dropping a live GPU texture for a bake that FAILED would replace a good asset
    // with a re-fetch of the same stale bytes, for nothing.
    expect(fired).toEqual([]);
    expect(summary.errors).toHaveLength(4);
    err.mockRestore();
  });

  it('skips a kind with no browser-side cache instead of guessing', async () => {
    const fired: string[] = [];
    onAssetInvalidated((kind) => { fired.push(kind); });
    // `font` refreshes through the manifest-hash channel (onFontInvalidated), and
    // atlas/video hold no engine-side cache — see assetInvalidation.ts.
    await reimportPaths(
      [{ path: '/assets/fonts/x.ttf', type: 'font' }, { path: '/assets/video/v.mp4', type: 'video' }],
      noop, 'Re-importing…',
    );
    expect(fired).toEqual([]);
  });
});
