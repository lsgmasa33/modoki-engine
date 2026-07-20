/** fontLoader unit tests — parseFontFilename (pure), registry lookups on fresh state. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getLoader() {
  return import('../../../src/runtime/loaders/fontLoader');
}

describe('fontLoader', () => {
  describe('parseFontFilename', () => {
    it('parses Roboto-Bold.woff2', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Roboto-Bold.woff2');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('700');
      expect(info.style).toBe('normal');
    });

    it('parses Roboto-BoldItalic.woff2', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Roboto-BoldItalic.woff2');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('700');
      expect(info.style).toBe('italic');
    });

    it('parses Roboto-Regular.woff2', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Roboto-Regular.woff2');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('400');
      expect(info.style).toBe('normal');
    });

    it('parses OpenSans-Light.ttf with camelCase expansion', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('OpenSans-Light.ttf');
      expect(info.family).toBe('Open Sans');
      expect(info.weight).toBe('300');
      expect(info.style).toBe('normal');
    });

    it('parses MyFont.woff2 with no weight suffix', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('MyFont.woff2');
      // No hyphen → entire filename is the family, camelCase expanded
      expect(info.family).toBe('My Font');
      expect(info.weight).toBe('400');
      expect(info.style).toBe('normal');
    });

    it('strips directory from path', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('/fonts/Roboto-Bold.woff2');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('700');
    });

    it('parses SemiBold weight', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Inter-SemiBold.woff2');
      expect(info.family).toBe('Inter');
      expect(info.weight).toBe('600');
      expect(info.style).toBe('normal');
    });

    it('parses Black weight', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Montserrat-Black.woff2');
      expect(info.family).toBe('Montserrat');
      expect(info.weight).toBe('900');
      expect(info.style).toBe('normal');
    });

    it('parses Thin weight', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Raleway-Thin.woff2');
      expect(info.family).toBe('Raleway');
      expect(info.weight).toBe('100');
      expect(info.style).toBe('normal');
    });

    it('parses ExtraBold weight', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Nunito-ExtraBold.ttf');
      expect(info.family).toBe('Nunito');
      expect(info.weight).toBe('800');
      expect(info.style).toBe('normal');
    });

    it('parses SemiBoldItalic variant', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Lato-SemiBoldItalic.woff2');
      expect(info.family).toBe('Lato');
      expect(info.weight).toBe('600');
      expect(info.style).toBe('italic');
    });

    it('parses underscore-separated filename', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('Roboto_Bold.woff2');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('700');
    });

    it('preserves path in returned info', async () => {
      const { parseFontFilename } = await getLoader();
      const info = parseFontFilename('/assets/fonts/Roboto-Bold.woff2');
      expect(info.path).toBe('/assets/fonts/Roboto-Bold.woff2');
    });
  });

  describe('fontFamilyFromPath', () => {
    it('resolves path to family name via parseFontFilename', async () => {
      const { fontFamilyFromPath } = await getLoader();
      expect(fontFamilyFromPath('/fonts/Roboto-Bold.woff2')).toBe('Roboto');
    });

    it('handles filename without weight suffix', async () => {
      const { fontFamilyFromPath } = await getLoader();
      expect(fontFamilyFromPath('Arial.ttf')).toBe('Arial');
    });
  });

  describe('getLoadedFontFamilies', () => {
    it('returns empty array initially', async () => {
      const { getLoadedFontFamilies } = await getLoader();
      expect(getLoadedFontFamilies()).toEqual([]);
    });
  });

  describe('getLoadedFonts', () => {
    it('returns empty Map initially', async () => {
      const { getLoadedFonts } = await getLoader();
      const fonts = getLoadedFonts();
      expect(fonts.size).toBe(0);
    });
  });

  describe('fontPathFromFamily', () => {
    it('returns null for unknown family', async () => {
      const { fontPathFromFamily } = await getLoader();
      expect(fontPathFromFamily('UnknownFont')).toBeNull();
    });
  });

  describe('loadFont (F7 concurrency + F8 reverse lookup)', () => {
    // Track FontFace.load() invocations to assert the underlying load runs once per path.
    let loadCalls: Record<string, number>;
    let resolvers: Record<string, (() => void)[]>;
    let rejecters: Record<string, ((e: Error) => void)[]>;

    function installFontFaceMock(opts: { fail?: boolean } = {}) {
      loadCalls = {};
      resolvers = {};
      rejecters = {};
      class FakeFontFace {
        family: string;
        source: string;
        descriptors: { weight: string; style: string };
        constructor(family: string, source: string, descriptors: { weight: string; style: string }) {
          this.family = family;
          this.source = source;
          this.descriptors = descriptors;
        }
        load() {
          loadCalls[this.source] = (loadCalls[this.source] ?? 0) + 1;
          return new Promise<this>((resolve, reject) => {
            (resolvers[this.source] ??= []).push(() => resolve(this));
            (rejecters[this.source] ??= []).push((e: Error) => reject(e));
            if (opts.fail) {
              // Reject on next microtask
              Promise.resolve().then(() => reject(new Error('boom')));
            }
          });
        }
      }
      (globalThis as any).FontFace = FakeFontFace;
      (globalThis as any).document = { fonts: { add: vi.fn() } };
    }

    function flush(source: string) {
      (resolvers[source] ?? []).forEach(r => r());
    }

    it('shares one underlying load for two concurrent calls of the same path (F7)', async () => {
      installFontFaceMock();
      const { loadFont } = await getLoader();

      const p1 = loadFont('/fonts/Roboto-Bold.woff2');
      const p2 = loadFont('/fonts/Roboto-Bold.woff2');

      // Exactly one FontFace.load() was invoked across the two callers.
      const sources = Object.keys(loadCalls);
      expect(sources.length).toBe(1);
      expect(loadCalls[sources[0]]).toBe(1);

      flush(sources[0]);
      const [f1, f2] = await Promise.all([p1, p2]);
      expect(f1).toBe('Roboto');
      expect(f2).toBe('Roboto');
    });

    it('a rejected load does not poison future loads (F7)', async () => {
      installFontFaceMock({ fail: true });
      const { loadFont } = await getLoader();

      await expect(loadFont('/fonts/Roboto-Bold.woff2')).rejects.toThrow('boom');
      const firstCount = loadCalls[Object.keys(loadCalls)[0]];
      expect(firstCount).toBe(1);

      // Now succeed on retry — the failed path was evicted, so a new load runs.
      installFontFaceMock();
      const p = loadFont('/fonts/Roboto-Bold.woff2');
      const source = Object.keys(loadCalls)[0];
      expect(loadCalls[source]).toBe(1);
      flush(source);
      await expect(p).resolves.toBe('Roboto');
    });

    it('fontPathFromFamily is deterministic — prefers the regular variant (F8)', async () => {
      installFontFaceMock();
      const { loadFont, fontPathFromFamily } = await getLoader();

      // Load Bold first, then Regular — first-loaded is NOT the regular weight.
      const pBold = loadFont('/fonts/Roboto-Bold.woff2');
      flush(Object.keys(loadCalls).find(s => s.includes('Roboto-Bold'))!);
      await pBold;

      const pReg = loadFont('/fonts/Roboto-Regular.woff2');
      flush(Object.keys(loadCalls).find(s => s.includes('Roboto-Regular'))!);
      await pReg;

      // Despite Bold being registered first, the regular (400/normal) variant wins.
      expect(fontPathFromFamily('Roboto')).toBe('/fonts/Roboto-Regular.woff2');
    });

    it('a successful load populates the registry + adds the FontFace to document.fonts (#6)', async () => {
      installFontFaceMock();
      const { loadFont, getLoadedFontFamilies, getLoadedFonts } = await getLoader();
      const p = loadFont('/fonts/Roboto-Regular.woff2');
      flush(Object.keys(loadCalls)[0]);
      await p;
      expect(getLoadedFontFamilies()).toEqual(['Roboto']);
      expect(getLoadedFonts().get('Roboto')).toHaveLength(1);
      expect((globalThis as any).document.fonts.add).toHaveBeenCalledTimes(1);
    });

    it('loadAllFonts loads only type==="font" assets and summarizes failures (#6)', async () => {
      installFontFaceMock();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadAllFonts, getLoadedFontFamilies } = await getLoader();
      const p = loadAllFonts([
        { path: '/fonts/Roboto-Regular.woff2', type: 'font' },
        { path: '/fonts/Open-Bold.woff2', type: 'font' },
        { path: '/img/sky.png', type: 'texture' }, // ignored
      ]);
      const sources = Object.keys(loadCalls);
      expect(sources.length).toBe(2); // the texture was filtered out
      // Succeed one font, fail the other → 1/2 failure summary.
      (resolvers[sources.find(s => s.includes('Roboto'))!] ?? []).forEach(r => r());
      (rejecters[sources.find(s => s.includes('Open'))!] ?? []).forEach(r => r(new Error('x')));
      await p;
      expect(warn.mock.calls.some(c => /1\/2 fonts failed/.test(String(c[0])))).toBe(true);
      expect(getLoadedFontFamilies()).toContain('Roboto');
      warn.mockRestore();
    });
  });
});
