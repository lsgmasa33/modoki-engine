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

// Only `fetch` is stubbed (#1824): each answer is read by the real `readBackendAnswer`.
const backendFetchMock = vi.fn();
vi.stubGlobal('fetch', backendFetchMock);

const { reimportPaths } = await import('../../src/editor/panels/assetViews/reimport');
const { onAssetInvalidated, clearAssetInvalidationListeners } =
  await import('../../src/runtime/core/assetInvalidation');

const ok = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, converted: 1, errors: [] }) });
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
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, converted: 0, errors: ['boom'] }) }));
    const fired: string[] = [];
    onAssetInvalidated((kind) => { fired.push(kind); });
    const err = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

/** #1824 — the false success. `/api/reimport` refuses with `error` alone (the 404 "no manifest asset matches", the
 *  unsaved-edit 409, the 422 "nothing to re-import") and no `errors`, and the loop read only `errors`: the refusal was
 *  counted as re-imported and its caches evicted. Mutation: read `errors` only again (treat `!r.ok` as success) —
 *  both expectations go red. */
describe('reimportPaths: a refusal is not a re-import (#1824)', () => {
  it('names the refusal and evicts nothing for it', async () => {
    backendFetchMock.mockImplementation(() => Promise.resolve({
      ok: false, status: 404, json: () => Promise.resolve({ ok: false, converted: 0, errors: [], error: 'no manifest asset matches "/assets/textures/t.png"' }),
    }));
    const fired: string[] = [];
    onAssetInvalidated((kind) => { fired.push(kind); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await reimportPaths([{ path: '/assets/textures/t.png', type: 'texture' }], noop, 'Re-importing…');
    expect(summary).toEqual({ converted: 0, errors: ['/assets/textures/t.png: no manifest asset matches "/assets/textures/t.png"'] });
    expect(fired).toEqual([]);
    warn.mockRestore();
  });
});

/** Close-out review: a failed single-path bake answers `errors:['<path>: <why>']` with no `error`, and the loop prefixed
 *  the path again ("a.png: a.png: boom"). Mutation: always prefix — red. */
describe('reimportPaths names each failure once (#1824 close-out)', () => {
  it('does not repeat a path the route already named', async () => {
    backendFetchMock.mockImplementation(() => Promise.resolve({
      ok: false, status: 500, json: () => Promise.resolve({ ok: false, converted: 0, errors: ['/assets/textures/t.png: toktx exited 1'] }),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await reimportPaths([{ path: '/assets/textures/t.png', type: 'texture' }], noop, 'Re-importing…');
    expect(summary.errors).toEqual(['/assets/textures/t.png: toktx exited 1']);
    warn.mockRestore();
  });

  // Ruling FA: the Assets panel's import-on-add is background work. Mutation: ignore `channel` (always toast) — red.
  it("a 'background' run states its failures in the console, never a toast", async () => {
    const { useEditorStore } = await import('../../src/editor/store/editorStore');
    useEditorStore.setState({ toast: null });
    backendFetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, error: 'no manifest asset matches' }) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reimportPaths([{ path: '/assets/textures/t.png', type: 'texture' }], noop, 'Re-importing…', 'background');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('no manifest asset matches');
    await reimportPaths([{ path: '/assets/textures/t.png', type: 'texture' }], noop, 'Re-importing…');
    expect(useEditorStore.getState().toast?.message).toContain('no manifest asset matches');
    warn.mockRestore();
  });
});
