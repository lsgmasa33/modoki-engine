/** loadPixiTexture — the Scene2D/font texture-load shim. A playable single-file
 *  build serves assets as EXTENSION-LESS blob: URLs; PixiJS v8 picks its texture
 *  parser by extension (path.extname strips ?query AND #hash), so a bare blob:
 *  fails to load unless the parser is forced. This asserts the blob → forced-parser
 *  branch (and that normal URLs pass through untouched, so KTX2 auto-detect is kept). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const load = vi.fn((arg: unknown) => Promise.resolve({ id: arg } as unknown));
const setPreferences = vi.fn();
vi.mock('pixi.js', () => ({ Assets: { load, setPreferences } }));

// Import AFTER the mock is registered.
const { loadPixiTexture } = await import('../../src/runtime/rendering/pixiTextureLoad');

describe('loadPixiTexture', () => {
  beforeEach(() => load.mockClear());

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
});
