// @vitest-environment jsdom
/** loadSpriteAlphaMask — the editor's sprite-alpha sampler for "drop vertex by alpha"
 *  tessellation. jsdom has no real canvas, so we stub Image + a 2D context that returns
 *  a synthetic RGBA buffer. Pins: UV→mask index mapping, the alpha threshold, atlas-rect
 *  source cropping (drawImage source args), out-of-range UVs, and the tainted-canvas /
 *  load-failure null paths. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSpriteAlphaMask } from '../../src/editor/panels/spriteAlphaMask';

// The synthetic source image is a `SRC × SRC` RGBA grid; alpha = pixel value from `alphaAt`.
const SRC = 8;
let alphaAt: (x: number, y: number) => number;
let lastDraw: { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number } | null;
let imageShouldFail = false;
let throwOnGetImageData = false;

class FakeImage {
  crossOrigin = '';
  naturalWidth = SRC;
  naturalHeight = SRC;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => (imageShouldFail ? this.onerror?.() : this.onload?.()));
  }
}

function makeCtx() {
  // The canvas the helper creates; its width/height are set by the helper (mask dims).
  let mw = 0, mh = 0;
  return {
    set _w(v: number) { mw = v; },
    drawImage(_img: unknown, sx: number, sy: number, sw: number, sh: number, _dx: number, _dy: number, dw: number, dh: number) {
      lastDraw = { sx, sy, sw, sh, dw, dh };
      mw = dw; mh = dh;
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      if (throwOnGetImageData) throw new Error('tainted');
      // Map each mask pixel back to a source pixel (no downscale in these tests → 1:1
      // within the drawn rect) and read alpha from alphaAt at the source coordinate.
      const data = new Uint8ClampedArray(w * h * 4);
      const rect = lastDraw!;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const srcX = rect.sx + Math.floor((x + 0.5) / w * rect.sw);
        const srcY = rect.sy + Math.floor((y + 0.5) / h * rect.sh);
        data[(y * w + x) * 4 + 3] = alphaAt(srcX, srcY);
      }
      return { data, width: w, height: h };
    },
  };
}

beforeEach(() => {
  lastDraw = null;
  imageShouldFail = false;
  throwOnGetImageData = false;
  alphaAt = () => 255;
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => makeCtx() } as unknown as HTMLElement;
    return {} as HTMLElement;
  }) as typeof document.createElement);
});
afterEach(() => vi.restoreAllMocks());

describe('loadSpriteAlphaMask', () => {
  it('maps a left-opaque / right-transparent image into a UV predicate', async () => {
    alphaAt = (x) => (x < SRC / 2 ? 255 : 0);
    const mask = await loadSpriteAlphaMask('x.png');
    expect(mask).not.toBeNull();
    expect(mask!.isInside(0.1, 0.5)).toBe(true);  // left half — opaque
    expect(mask!.isInside(0.9, 0.5)).toBe(false); // right half — transparent
  });

  it('respects the alpha threshold', async () => {
    alphaAt = () => 20; // uniformly semi-transparent
    const soft = await loadSpriteAlphaMask('x.png', { threshold: 8 });
    expect(soft!.isInside(0.5, 0.5)).toBe(true);  // 20 > 8 → opaque
    const strict = await loadSpriteAlphaMask('x.png', { threshold: 64 });
    expect(strict!.isInside(0.5, 0.5)).toBe(false); // 20 < 64 → transparent
  });

  it('samples only the atlas sub-rect (drawImage source crop)', async () => {
    // Opaque only in the bottom-right quadrant of the full sheet.
    alphaAt = (x, y) => (x >= SRC / 2 && y >= SRC / 2 ? 255 : 0);
    const rect = { x: SRC / 2, y: SRC / 2, w: SRC / 2, h: SRC / 2 };
    const mask = await loadSpriteAlphaMask('sheet.png', { rect });
    expect(lastDraw).toMatchObject({ sx: 4, sy: 4, sw: 4, sh: 4 }); // cropped to the rect
    // Within the rect the region is fully opaque → any in-range UV is inside.
    expect(mask!.isInside(0.25, 0.25)).toBe(true);
    expect(mask!.isInside(0.75, 0.75)).toBe(true);
  });

  it('returns false for out-of-range UVs', async () => {
    const mask = await loadSpriteAlphaMask('x.png');
    expect(mask!.isInside(-0.1, 0.5)).toBe(false);
    expect(mask!.isInside(0.5, 1.5)).toBe(false);
  });

  it('returns null when the image fails to load', async () => {
    imageShouldFail = true;
    expect(await loadSpriteAlphaMask('missing.png')).toBeNull();
  });

  it('returns null on a tainted canvas (getImageData throws)', async () => {
    throwOnGetImageData = true;
    expect(await loadSpriteAlphaMask('cross-origin.png')).toBeNull();
  });
});
