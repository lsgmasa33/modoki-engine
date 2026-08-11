/** loadPixiTexture — the Scene2D/font texture-load shim. A playable single-file
 *  build serves assets as EXTENSION-LESS blob: URLs; PixiJS v8 picks its texture
 *  parser by extension (path.extname strips ?query AND #hash), so a bare blob:
 *  fails to load unless the parser is forced. This asserts the blob → forced-parser
 *  branch (and that normal URLs pass through untouched, so KTX2 auto-detect is kept). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const load = vi.fn((arg: unknown) => Promise.resolve({ id: arg } as unknown));
const setPreferences = vi.fn();
// Real `Assets` carries a cache the shim now consults: `Assets.unload` destroys a texture's
// source EAGERLY but removes the entry asynchronously, so a present-but-sourceless entry is a
// real state the shim has to evict before loading (see `evictSourcelessEntry`).
const cacheMap = new Map<string, unknown>();
const cache = {
  has: (url: string) => cacheMap.has(url),
  get: (url: string) => cacheMap.get(url),
  remove: (url: string) => cacheMap.delete(url),
};
vi.mock('pixi.js', () => ({ Assets: { load, setPreferences, cache } }));

// Import AFTER the mock is registered.
const { loadPixiTexture } = await import('../../src/runtime/rendering/pixiTextureLoad');

describe('loadPixiTexture', () => {
  beforeEach(() => { load.mockClear(); cacheMap.clear(); });

  it('forces the image parser AND disables the texture worker for a blob: URL', async () => {
    // The worker fix: a playable opened from file:// mints blob:null URLs a Pixi
    // WORKER can't fetch — so a blob load must force main-thread decode. This is the
    // first blob load in the file, so the one-shot setPreferences fires here.
    await loadPixiTexture('blob:http://localhost/abc-123');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ src: 'blob:http://localhost/abc-123', parser: 'texture' });
    expect(setPreferences).toHaveBeenCalledWith({ preferWorkers: false });
  });

  it('passes a normal URL straight through (keeps extension auto-detect, incl. KTX2)', async () => {
    await loadPixiTexture('/assets/sprites/foo.png~uastc.ktx2?v=abcd');
    expect(load).toHaveBeenCalledWith('/assets/sprites/foo.png~uastc.ktx2?v=abcd');
  });

  it('a plain http(s)/relative image is NOT wrapped', async () => {
    await loadPixiTexture('/assets/x.webp');
    expect(load).toHaveBeenCalledWith('/assets/x.webp');
    expect(load).not.toHaveBeenCalledWith(expect.objectContaining({ parser: 'texture' }));
  });

  it('does NOT touch worker prefs for a non-blob load', async () => {
    setPreferences.mockClear();
    await loadPixiTexture('/assets/y.png');
    expect(setPreferences).not.toHaveBeenCalled();
  });

  // ── The sourceless-entry eviction. `Assets.unload` destroys the source eagerly and removes
  //    the cache entry asynchronously; in that window `Assets.load` hands the corpse straight
  //    back. Consumers then read it as live: a Sprite draws NOTHING permanently (measured on a
  //    live renderer, 2026-08-10 — Court's memo pen marks), a Mesh binds it, and the font path
  //    does `tex.source.scaleMode = 'linear'` and throws. The shim is the one choke point every
  //    texture load already goes through, so the eviction belongs here rather than per caller. ──
  describe('cached-but-sourceless entries', () => {
    it('evicts an entry whose source is gone, so the load actually refetches', async () => {
      cacheMap.set('/assets/dead.webp', { width: 128, height: 128, source: null });
      await loadPixiTexture('/assets/dead.webp');
      expect(cacheMap.has('/assets/dead.webp')).toBe(false); // evicted before loading
      expect(load).toHaveBeenCalledWith('/assets/dead.webp');
    });

    it('leaves a HEALTHY cached entry alone (no needless refetch)', async () => {
      const live = { width: 128, height: 128, source: { style: {} } };
      cacheMap.set('/assets/live.webp', live);
      await loadPixiTexture('/assets/live.webp');
      expect(cacheMap.get('/assets/live.webp')).toBe(live); // untouched
    });

    it('is a no-op for a url that is not cached at all', async () => {
      await loadPixiTexture('/assets/absent.webp');
      expect(load).toHaveBeenCalledWith('/assets/absent.webp');
      expect(cacheMap.size).toBe(0);
    });

    it('evicts on the blob: path too — a playable hits the same window', async () => {
      cacheMap.set('blob:http://x/dead', { source: undefined });
      await loadPixiTexture('blob:http://x/dead');
      expect(cacheMap.has('blob:http://x/dead')).toBe(false);
    });
  });
});
