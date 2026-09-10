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
class FakeImageSource { constructor(public opts: Record<string, unknown>) {} }
class FakeTexture { constructor(public opts: { source: unknown }) {} }
vi.mock('pixi.js', () => ({
  Assets: { load, setPreferences, cache },
  ImageSource: FakeImageSource,
  Texture: FakeTexture,
}));

// Import AFTER the mock is registered.
const { loadPixiTexture, loadMtsdfAtlasTexture } = await import('../../src/runtime/rendering/pixiTextureLoad');

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

/** loadMtsdfAtlasTexture — #1045.
 *
 *  ⚠️ **The bug this pins, and why no other test in the repo could.** A baked MTSDF atlas carries
 *  the 3-channel distance field in RGB and the true SDF in alpha. `Assets.load` decodes through a
 *  bare `createImageBitmap(blob)`, whose `premultiplyAlpha` then falls to the UA default — and on
 *  iOS 16 that default IS `'premultiply'`. Premultiplying scales RGB by alpha, dragging
 *  `median(rgb)` below the shader's 0.5 edge threshold, so `fill` clamps to 0 and EVERY GLYPH IN
 *  THE GAME renders fully transparent. Measured on an iPhone 8 / iOS 16.7.16 over one glyph cell:
 *  texels with `median(rgb) > 0.5` were 1775 in the file and 0 on the GPU.
 *
 *  Setting `source.alphaMode = 'no-premultiply-alpha'` cannot repair it: per the WebGL spec
 *  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is IGNORED for ImageBitmap uploads (confirmed on the device —
 *  flipping it changed nothing either way). The `createImageBitmap` OPTION is the only lever, so
 *  that option is what these assert.
 *
 *  ⚠️ It is invisible to every other gate: iOS 26, Android and desktop do not premultiply by
 *  default, so the repro needs a real iOS 16 device — the same blind spot as the r185 ceiling. */
describe('loadMtsdfAtlasTexture — the atlas must decode UNPREMULTIPLIED (#1045)', () => {
  const url = '/assets/fonts/KleeOne-Regular.ttf~atlas.png?v=abc';
  let bitmapOpts: ImageBitmapOptions | undefined;
  let createCalls: number;

  beforeEach(() => {
    load.mockClear();
    bitmapOpts = undefined;
    createCalls = 0;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({} as Blob) })));
    vi.stubGlobal('createImageBitmap', vi.fn((_blob: Blob, opts?: ImageBitmapOptions) => {
      createCalls++;
      bitmapOpts = opts;
      return Promise.resolve({ width: 2048, height: 1024 } as ImageBitmap);
    }));
  });

  it('decodes with premultiplyAlpha:none — the one option that keeps the distance field intact', async () => {
    await loadMtsdfAtlasTexture(url);
    expect(createCalls, 'the atlas is decoded by us, not by Assets').toBe(1);
    // THE REGRESSION. Dropping this option (or the whole options object, which is what
    // `Assets.load` effectively does) hands the UA its default and blanks all text on iOS 16.
    expect(bitmapOpts?.premultiplyAlpha, 'a premultiplied atlas is an unreadable distance field').toBe('none');
    // A colour-profile transform is a no-op on a profile-less PNG and corruption on any other,
    // and this is DATA, not a picture.
    expect(bitmapOpts?.colorSpaceConversion).toBe('none');
  });

  it('never routes the atlas through Assets.load — that path cannot express the option', async () => {
    await loadMtsdfAtlasTexture(url);
    expect(load, 'Assets.load has no way to ask for an unpremultiplied bitmap').not.toHaveBeenCalled();
  });

  it('builds the source as unpremultiplied, linear, mip-free distance-field data', async () => {
    const tex = await loadMtsdfAtlasTexture(url) as unknown as { opts: { source: { opts: Record<string, unknown> } } };
    expect(tex.opts.source.opts).toMatchObject({
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
      autoGenerateMipmaps: false,
    });
  });

  /** ⚠️ **The WIRING, which every other test in this block leaves unmeasured.** The assertions
   *  above prove a bitmap was DECODED with the right option and that a source was BUILT with the
   *  right style flags — never that the two are the same object. Measured: deleting
   *  `resource: bitmap` from the loader left all 24 tests GREEN. So a refactor that keeps the
   *  decode but sources the texture from `response.blob()`, from a second bare
   *  `createImageBitmap`, or from nothing at all would ship through `verify` and both CI legs
   *  with this suite passing — and blank every glyph on iOS 16 again, the original bug restored
   *  with its own regression test still green. (docs/falsifiable-tests.md — a guard that cannot
   *  fail is not a guard.) */
  it('puts THAT bitmap — the unpremultiplied one — into the texture', async () => {
    const decoded: unknown[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn((_blob: Blob, opts?: ImageBitmapOptions) => {
      const bmp = { width: 2048, height: 1024, tag: 'the-decoded-one', opts } as unknown as ImageBitmap;
      decoded.push(bmp);
      return Promise.resolve(bmp);
    }));
    const tex = await loadMtsdfAtlasTexture(url) as unknown as { opts: { source: { opts: { resource: unknown } } } };
    expect(decoded, 'exactly one decode').toHaveLength(1);
    expect(tex.opts.source.opts.resource, 'the texture must carry the bitmap that was decoded unpremultiplied — not a second, differently-decoded one').toBe(decoded[0]);
  });

  it('rejects on a failed fetch rather than resolving a blank texture', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve({} as Blob) })));
    // A resolved-but-empty texture would draw nothing and look exactly like this bug; the caller's
    // .catch() logs the URL instead.
    await expect(loadMtsdfAtlasTexture(url)).rejects.toThrow('404');
  });

  it('falls back to Assets.load where createImageBitmap does not exist — SAFELY', async () => {
    // Not a quiet reintroduction of the bug: without createImageBitmap Pixi decodes into an
    // HTMLImageElement, and UNPACK_PREMULTIPLY_ALPHA_WEBGL *is* honoured for those.
    vi.stubGlobal('createImageBitmap', undefined);
    await loadMtsdfAtlasTexture(url);
    expect(load).toHaveBeenCalledWith(url);
  });
});
