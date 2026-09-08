/** Regression for docs/async-lifetime.md: `generateChunk` awaits `generateMsdf(await this.bytes(),
 *  …)` and then writes `glyphMap`/`kern`/`ctxs`/`allocator`/`atlasVersion` with no liveness check,
 *  even though the class already carries a `disposed` boolean (set by `dispose()`).
 *
 *  PRODUCTION DRIVER: a scene swap. `releaseFontsForScene`/`invalidateFont`/`disposeAllFonts`
 *  (fontAtlasLoader.ts) call `provider.dispose()` — wired into `meshTemplateCache`'s
 *  `releaseAllForScene`, which `SceneManager` calls synchronously on every scene swap/unload — and
 *  a glyph generation this font kicked off via `ensureGlyphs` (any text whose layout hash just
 *  changed — a score, a typewriter reveal, a freshly-spawned label) is very plausibly still
 *  in-flight through the shared MSDF worker (`msdfGenerate`'s `genQueue`) when the swap lands.
 *  `dispose()` clears `glyphMap`/`kern`/`pages`/`ctxs`; without the guard, the still-running
 *  `generateChunk` resumes and writes fresh glyphs and a fresh canvas access straight back into a
 *  provider nothing owns any more — for a font that may itself already be garbage. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gen = vi.hoisted(() => ({
  resolve: null as null | ((v: unknown) => void),
  calls: 0,
}));

vi.mock('../../src/runtime/rendering/text/msdfGenerate', () => ({
  generateMsdf: vi.fn((_font: Uint8Array, charset: string) => {
    gen.calls += 1;
    return new Promise((resolve) => {
      gen.resolve = () => resolve({
        texture: { data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 },
        glyphs: [...charset].map((ch) => ({
          unicode: ch.codePointAt(0)!,
          atlasPosition: [0, 0] as [number, number],
          atlasSize: [40, 40] as [number, number],
          bounds: { left: 0, bottom: 0, right: 32, top: 32 },
          advance: 40,
        })),
        metrics: { emSize: 1, ascender: 25.6, descender: -6.4, lineHeight: 38.4 },
        kerning: [],
      });
    });
  }),
  disposeMsdfGenerator: vi.fn(async () => {}),
}));

import { DynamicFontProvider } from '../../src/runtime/rendering/text/dynamicFontProvider';
import type { GlyphAtlas } from '../../src/runtime/rendering/text/glyphAtlas';

const fakeCtx = () => ({
  createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: () => {},
  clearRect: () => {},
});
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx() });
beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
  gen.resolve = null;
  gen.calls = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

const EMPTY_BAKED: GlyphAtlas = {
  atlas: { type: 'mtsdf', distanceRange: 4, width: 4, height: 4, size: 32, yOrigin: 'top' },
  metrics: { emSize: 1, ascender: -0.8, descender: 0.2, lineHeight: 1.2 },
  glyphs: new Map(),
  kerning: new Map(),
};

describe('DynamicFontProvider — dispose() mid-generateChunk must not resurrect disposed state', () => {
  it('drops the in-flight batch instead of writing into glyphMap/kern/ctxs after dispose()', async () => {
    const p = DynamicFontProvider.fromBaked('t', EMPTY_BAKED, 'atlas.png', async () => new Uint8Array([1]));
    const anyP = p as unknown as {
      generating: boolean; pending: Set<number>;
      glyphMap: Map<number, unknown>; kern: Map<number, unknown>; ctxs: unknown[];
    };
    const A = 0x3042; // あ — outside EMPTY_BAKED's charset, so this is a genuine miss.

    p.ensureGlyphs([A]); // fire-and-forget: kicks off flush -> generateBatch -> generateChunk
    await vi.waitFor(() => { if (gen.calls < 1) throw new Error('generateMsdf not called yet'); });

    p.dispose(); // the scene swap lands WHILE generateMsdf is still in flight
    expect(anyP.glyphMap.size).toBe(0);
    expect(anyP.ctxs.length).toBe(0); // dispose() already dropped the canvases

    gen.resolve!(undefined); // let generateChunk's await resume — must not throw, must not write
    await vi.waitFor(() => { if (anyP.generating) throw new Error('still generating'); });

    // The disposed provider must not have resurrected any of the state dispose() cleared.
    expect(anyP.glyphMap.size).toBe(0);
    expect(anyP.kern.size).toBe(0);
    expect(anyP.ctxs.length).toBe(0);
    expect(p.getGlyph(A)).toBeUndefined();
  });
});
