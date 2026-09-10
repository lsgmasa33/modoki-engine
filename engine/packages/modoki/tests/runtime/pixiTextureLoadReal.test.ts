// @vitest-environment jsdom
/** loadMtsdfAtlasTexture against the REAL PixiJS — the contract test (#1045).
 *
 *  ⚠️ **Why this file exists separately from `pixiTextureLoad.test.ts`.** That suite mocks
 *  `pixi.js` wholesale (`FakeImageSource`/`FakeTexture`) and `fontTexturePixi.test.ts` mocks the
 *  whole `pixiTextureLoad` module, so between them NOTHING constructs a real `ImageSource`. The
 *  fix's correctness rests on three facts about Pixi that only real Pixi can answer:
 *
 *    1. `ImageSource` accepts an `ImageBitmap` as its `resource`.
 *    2. `'no-premultiply-alpha'` is still the literal `alphaMode` that makes `GlTextureSystem`
 *       leave `UNPACK_PREMULTIPLY_ALPHA_WEBGL` false — the ENTIRE point of the fix.
 *    3. `scaleMode` / `autoGenerateMipmaps` are real `TextureSourceOptions` and are not
 *       silently dropped.
 *
 *  A Pixi bump that renames any of them leaves the mocked suite green and blanks every glyph on
 *  EVERY platform, not just iOS 16 — and the commit's own finding is that the device repro is
 *  invisible to `verify` and to both CI legs, so a mocked suite is the only gate that exists.
 *  `vi.mock` is file-scoped, hence a separate file rather than another `describe`.
 *
 *  This does NOT touch a GPU: it asserts the source Pixi BUILT, not what a driver uploaded. The
 *  upload half is unfalsifiable off-device by construction — see docs/rendering.md
 *  § "2D SDF text (MTSDF)" for the on-device measurement that covers it. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageSource, Texture } from 'pixi.js';

const { loadMtsdfAtlasTexture } = await import('../../src/runtime/rendering/pixiTextureLoad');

const url = '/assets/fonts/Klee~atlas.png?v=abc';
/** Real `ImageSource` reads `width`/`height` off the resource; nothing here needs real pixels. */
const fakeBitmap = () => ({ width: 2048, height: 1024, close: vi.fn() }) as unknown as ImageBitmap;

describe('loadMtsdfAtlasTexture — the real Pixi contract (#1045)', () => {
  let bitmap: ImageBitmap;

  beforeEach(() => {
    bitmap = fakeBitmap();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200, blob: () => Promise.resolve({} as Blob),
    })));
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap)));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('produces a real Texture whose real ImageSource carries the decoded bitmap', async () => {
    const tex = await loadMtsdfAtlasTexture(url);
    expect(tex, 'a real Pixi Texture, not a stand-in').toBeInstanceOf(Texture);
    expect(tex.source, 'ImageSource must accept an ImageBitmap resource').toBeInstanceOf(ImageSource);
    expect(tex.source.resource, 'the decoded bitmap reaches the source').toBe(bitmap);
    // Pixi derives these from the resource; a rejected resource would leave them at the 0/1
    // defaults, so they double as proof the ImageBitmap was actually understood.
    expect(tex.source.width).toBe(2048);
    expect(tex.source.height).toBe(1024);
  });

  it('REAL Pixi keeps alphaMode no-premultiply-alpha — the literal the whole fix rests on', async () => {
    const tex = await loadMtsdfAtlasTexture(url);
    // If a Pixi bump renamed or dropped this value, `source.alphaMode` would come back as
    // something else here and every MTSDF glyph would go transparent on every platform.
    expect(tex.source.alphaMode).toBe('no-premultiply-alpha');
  });

  it('REAL Pixi keeps the distance-field sampling options (linear, no mipmaps)', async () => {
    const tex = await loadMtsdfAtlasTexture(url);
    // Mipmapping an MTSDF atlas averages distance samples across glyph cells; linear filtering is
    // what the shader's screenPxRange maths assumes.
    expect(tex.source.scaleMode).toBe('linear');
    expect(tex.source.autoGenerateMipmaps).toBe(false);
  });
});
