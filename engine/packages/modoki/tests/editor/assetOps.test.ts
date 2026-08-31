/** `writeAssetFileIfMatch`'s outcome mapping (#490 review finding 5).
 *
 *  Every other conditional-write test either exercises the SERVER route directly
 *  (`writeFileIfMatch.test.ts`) or drives `persistAtlasDocIfUnchanged` with a fake writer that
 *  never touches the network (`atlasPersist.test.ts`) — so nothing had both ends mocked out and
 *  covered the one seam that actually maps an HTTP response to `'written' | 'conflict' |
 *  'failed'`: `writeAssetFileIfMatch` itself. It goes through `backendFetch` → global `fetch`,
 *  same convention as `assetUndo.test.ts`/`createPrefabUndo.test.ts` — stub `fetch`, assert the
 *  request AND the mapped outcome. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeAssetFileIfMatch } from '../../src/editor/panels/assetOps';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

describe('writeAssetFileIfMatch', () => {
  it('maps a 2xx response to "written"', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const outcome = await writeAssetFileIfMatch('/a.atlas.json', '{"members":[]}\n', 'deadbeef');

    expect(outcome).toBe('written');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/write-file');
    expect(JSON.parse(init.body)).toEqual({ path: '/a.atlas.json', content: '{"members":[]}\n', ifMatch: 'deadbeef' });
  });

  it('maps a 409 response to "conflict"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409 });

    const outcome = await writeAssetFileIfMatch('/a.atlas.json', '{"members":["x"]}\n', 'deadbeef');

    expect(outcome).toBe('conflict');
  });

  it('maps any OTHER non-ok status (e.g. 500) to "failed", not "conflict"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const outcome = await writeAssetFileIfMatch('/a.atlas.json', '{"members":["x"]}\n', 'deadbeef');

    expect(outcome).toBe('failed');
  });

  it('maps a 403 response to "failed"', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    const outcome = await writeAssetFileIfMatch('/a.atlas.json', '{"members":["x"]}\n', 'deadbeef');

    expect(outcome).toBe('failed');
  });

  it('maps a thrown network error to "failed"', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const outcome = await writeAssetFileIfMatch('/a.atlas.json', '{"members":["x"]}\n', 'deadbeef');

    expect(outcome).toBe('failed');
  });
});
