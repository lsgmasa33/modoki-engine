/** The dynamic font path honours its font's AUTHORED import settings.
 *
 *  It used to honour none of them: `fontAtlasLoader` called
 *  `DynamicFontProvider.create(guid, bytes)` with no config, so the provider fell back to
 *  its module constants and every sidecar field except `mode` was inert. A font could
 *  author `size: 128, pxRange: 8` in the Font Inspector, see it listed there, and get
 *  64/16 at runtime — an authoring surface that looked wired and was not.
 *
 *  `distanceRange` is the one with teeth: FontManifestBlock's own doc says it MUST match
 *  between the baked atlas and the dynamic pages or AA/outline thickness drifts between
 *  baked and generated glyphs, and the defaults (8-at-size-128 baked vs 16-at-64 dynamic)
 *  did not match.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface GenOpts { fontSize: number; fieldRange: number; padding: number; textureSize: [number, number] }
const genSpy = vi.fn(async (_font: Uint8Array, charset: string, _opts?: GenOpts) => ({
  texture: { data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 },
  glyphs: [...charset].map((ch) => ({
    unicode: ch.codePointAt(0)!,
    atlasPosition: [0, 0] as [number, number],
    atlasSize: [8, 8] as [number, number],
    bounds: { left: 0, bottom: 0, right: 8, top: 8 },
    advance: 10,
  })),
  metrics: { emSize: 1, ascender: 46, descender: -13, lineHeight: 60 },
  kerning: [],
}));
vi.mock('../../src/runtime/rendering/text/msdfGenerate', () => ({
  generateMsdf: (...args: unknown[]) => genSpy(...(args as Parameters<typeof genSpy>)),
  disposeMsdfGenerator: vi.fn(async () => {}),
}));

import { DynamicFontProvider, dynamicConfigFromSettings } from '../../src/runtime/rendering/text/dynamicFontProvider';
import type { FontManifestBlock } from '../../src/runtime/core/fontSettings';

const fakeCtx = () => ({
  createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData: () => {},
  clearRect: () => {},
});
beforeEach(() => {
  genSpy.mockClear();
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('dynamicConfigFromSettings', () => {
  it('maps the manifest block onto the generator knobs', () => {
    const font: FontManifestBlock = { mode: 'dynamic', size: 128, distanceRange: 8, atlasMax: 1024, charset: 'ascii' };
    const cfg = dynamicConfigFromSettings(font);
    expect(cfg.fontSize).toBe(128);
    expect(cfg.fieldRange).toBe(8);
    expect(cfg.atlasSize).toBe(1024);
    expect(cfg.seed).toContain('A');
    expect(cfg.seed).not.toContain('ÿ'); // ascii preset, not latin1
  });

  it('expands the latin1 preset and a custom charset for the seed', () => {
    expect(dynamicConfigFromSettings({ charset: 'latin1' }).seed).toContain('ÿ');
    expect(dynamicConfigFromSettings({ charset: 'custom', customChars: '日本語' }).seed).toBe('日本語');
  });

  it('omits what the block does not carry, so the provider keeps its defaults', () => {
    expect(dynamicConfigFromSettings(undefined)).toEqual({});
    expect(dynamicConfigFromSettings({ mode: 'dynamic' })).toEqual({});
  });
});

describe('DynamicFontProvider honours authored settings', () => {
  it('generates at the authored size/fieldRange, not the module constants', async () => {
    const p = await DynamicFontProvider.create('t', new Uint8Array([1]), {
      fontSize: 128, fieldRange: 8, atlasSize: 512, seed: 'AB',
    });
    expect(p).not.toBeNull();
    const opts = genSpy.mock.calls[0][2]!;
    expect(opts.fontSize).toBe(128);
    expect(opts.fieldRange).toBe(8);
    // NOT textureSize: `atlasSize` is OUR page dimension. It used to be handed to the
    // generator as its scratch size too, which is how `atlasMax: 512` at `size: 128`
    // silently lost 70 of 95 seed glyphs — see the scratch-atlas block below.
    expect(p!.atlas.width).toBe(512);
  });

  it('reports the authored calibration on `atlas`, so the shader matches what was generated', async () => {
    const p = (await DynamicFontProvider.create('t', new Uint8Array([1]), {
      fontSize: 128, fieldRange: 8, atlasSize: 512, seed: 'A',
    }))!;
    expect(p.atlas).toMatchObject({ size: 128, distanceRange: 8, width: 512, height: 512 });
  });

  // The defaults are still the defaults — this pins that "honours settings" did not turn
  // into "requires settings", since a font with no sidecar block passes {}.
  it('falls back to the module constants when nothing is authored', async () => {
    const p = (await DynamicFontProvider.create('t', new Uint8Array([1]), { seed: 'A' }))!;
    expect(p.atlas).toMatchObject({ size: 64, distanceRange: 16, width: 2048, height: 2048 });
  });

  // ── The generator's padding contract. See the `cellPadding` note in the provider: the
  // `padding` OPTION is only the packer's inter-cell gap; each glyph cell is padded by
  // `floor(fieldRange/2)`, which is what `glyphFromGen` must be told or the quad stops
  // matching the cell its UVs address. Measured on Geologica @ size 128 with the option
  // pinned at 8 — fieldRange 8/16/24 gave cell pad 4/8/12.
  //
  // The old code passed a constant 8 and was right only because floor(16/2) === 8. When
  // #187 phase 3 made fieldRange authored, a font authoring pxRange 8 got cell pad 4
  // against a quad built for 8 and every glyph rendered ~8% oversized and shifted —
  // worse the narrower the glyph, since the error is (bw+16)/(bw+8).
  //
  // ⚠️ These assert the PLANE (the quad), not the option: an assertion on `opts.padding`
  // is exactly the check that passed all through the bug.
  describe('glyph quads follow the generator’s real cell padding', () => {
    // The mock reports bounds 0..8 with atlasSize [8,8] — i.e. pad 0 — so a provider that
    // honours the contract derives pad from fieldRange and the plane is bounds ± pad.
    const planeOf = async (fieldRange: number) => {
      const p = (await DynamicFontProvider.create('t', new Uint8Array([1]), { fontSize: 128, fieldRange, seed: 'A' }))!;
      return p.getGlyph(65)!.plane!;
    };

    it('derives the pad from fieldRange, not a constant', async () => {
      const p8 = await planeOf(8);   // cell pad 4
      expect(p8.left).toBeCloseTo(-4 / 128, 6);
      expect(p8.right).toBeCloseTo((8 + 4) / 128, 6);

      genSpy.mockClear();
      const p24 = await planeOf(24); // cell pad 12
      expect(p24.left).toBeCloseTo(-12 / 128, 6);
      expect(p24.right).toBeCloseTo((8 + 12) / 128, 6);
    });

    it('does not spend the padding OPTION on the cell — that is the packer gap', async () => {
      await DynamicFontProvider.create('t', new Uint8Array([1]), { fontSize: 128, fieldRange: 8, seed: 'A' });
      const opts = genSpy.mock.calls[0][2]!;
      // Whatever gap we choose, it must not be read as the cell padding (see above).
      expect(opts.fieldRange).toBe(8);
      expect(opts.padding).not.toBe(8); // an 8 here is what made the old bug invisible
    });
  });

  // The generator shelf-packs into the texture it is handed and never bounds-checks the
  // bottom edge; a cell past it is written out of range, silently dropped by the typed
  // array, and the glyph blits fully transparent. Measured: 95 ASCII glyphs at size 128
  // into a 512 scratch lost 70 of them. So the scratch is a fixed 2048 (NOT the font's
  // atlasMax, which sizes our own pages) and each generation is chunked to fit it.
  describe('scratch atlas is sized independently of atlasMax', () => {
    it('never hands the generator the page size', async () => {
      await DynamicFontProvider.create('t', new Uint8Array([1]), { fontSize: 128, atlasSize: 512, seed: 'AB' });
      expect(genSpy.mock.calls[0][2]!.textureSize).toEqual([2048, 2048]);
    });

    it('chunks a big batch so one generation cannot overflow the scratch', async () => {
      // At size 128 the pessimistic cell is 192+2*8+2 = 210px ⇒ floor(2048/210)=9 per axis
      // ⇒ 81 per pass, so a 95-glyph ASCII seed takes two.
      let seed = ''; for (let cp = 0x20; cp <= 0x7e; cp++) seed += String.fromCodePoint(cp);
      await DynamicFontProvider.create('t', new Uint8Array([1]), { fontSize: 128, fieldRange: 16, seed });
      expect(genSpy.mock.calls.length).toBeGreaterThan(1);
      for (const call of genSpy.mock.calls) expect(call[1].length).toBeLessThanOrEqual(81);
    });

    it('keeps a small batch to a single pass', async () => {
      await DynamicFontProvider.create('t', new Uint8Array([1]), { fontSize: 64, seed: 'AB' });
      expect(genSpy.mock.calls.length).toBe(1);
    });
  });

  it('seeds from the authored charset rather than always ASCII', async () => {
    await DynamicFontProvider.create('t', new Uint8Array([1]), { seed: '日本' });
    expect(genSpy.mock.calls[0][1]).toBe('日本');
  });
});

/** The wrong-typeface tripwire must baseline on the BAKE, not on the first generation.
 *
 *  The shared MSDF worker holds one font, so a concurrent generation can return another
 *  font's outlines (see msdfGenerateSerial). The tripwire is the defence-in-depth for that.
 *  Baselined on `_metrics` — set BY the first generated batch — it was blind to exactly the
 *  batch most likely to be wrong: the one that races at scene load. Seeded from a bake there
 *  is a correct baseline available from the start, so every batch is checked. */
describe('a baked-seeded provider checks EVERY batch against the bake', () => {
  const bakedAtlas = () => ({
    atlas: { type: 'mtsdf', distanceRange: 8, width: 512, height: 512, size: 64, yOrigin: 'top' as const },
    // Geologica-ish: the generator mock below reports NotoSansJP-ish metrics instead.
    metrics: { emSize: 1, lineHeight: 1.25, ascender: -0.975, descender: 0.275 },
    glyphs: new Map([[65, { unicode: 65, advance: 0.7 }]]),
    kerning: new Map<number, number>(),
  });

  it('errors when the FIRST generated batch comes back from a different typeface', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The mock's metrics (ascender 46/64 = 0.72, lineHeight 60/64 = 0.94) disagree with the
      // bake's 0.975 / 1.25 — i.e. a different face.
      const p = DynamicFontProvider.fromBaked('t', bakedAtlas() as never, '/a.png',
        () => Promise.resolve(new Uint8Array([1])));
      p.ensureGlyphs([0x4e00]);                       // a miss → generation
      await vi.waitFor(() => expect(err).toHaveBeenCalled());
      expect(String(err.mock.calls[0][0])).toMatch(/DIFFERENT typeface/);
    } finally { err.mockRestore(); }
  });

  it('stays silent when the generated metrics match the bake', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const baked = bakedAtlas();
      // Match what metricsFromGen will produce from the mock: asc 46/64, lh 60/64.
      baked.metrics.ascender = -46 / 64;
      baked.metrics.lineHeight = 60 / 64;
      const p = DynamicFontProvider.fromBaked('t2', baked as never, '/a.png',
        () => Promise.resolve(new Uint8Array([1])));
      p.ensureGlyphs([0x4e00]);
      await vi.waitFor(() => expect(p.getGlyph(0x4e00)).toBeDefined());
      expect(err, 'a matching typeface must not warn').not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });
});
