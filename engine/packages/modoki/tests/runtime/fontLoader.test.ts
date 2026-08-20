/** fontLoader unit tests — parseFontFilename (pure), registry lookups on fresh state. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function getLoader() {
  return import('../../src/runtime/loaders/fontLoader');
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

    describe('same-family (weight, style) collisions', () => {
      /** `loadAllFonts` loads every `font` asset in the manifest — the ENGINE's bundled families and
       *  the GAME's own. A game carrying its own copy of a bundled font (Court ships a byte-identical
       *  Arimo) therefore collides by construction, and warning about it trained people to ignore a
       *  warning that CAN matter: two DIFFERENT files normalizing to one family is a real ambiguity,
       *  because which typeface you get depends on load order. Basename discriminates the two. */
      async function loadBoth(a: string, b: string) {
        installFontFaceMock();
        const { loadFont } = await getLoader();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const pa = loadFont(a); flush(`url("${a}")`); await pa;
        const pb = loadFont(b); flush(`url("${b}")`); await pb;
        const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('already has'));
        const logs = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('already has'));
        warn.mockRestore(); log.mockRestore();
        return { warnings, logs };
      }

      it('does NOT warn when the SAME font file is shipped under two paths', async () => {
        const { warnings, logs } = await loadBoth(
          '/modoki/assets/fonts/Arimo/Arimo-VariableFont_wght.ttf',
          '/assets/fonts/Arimo-VariableFont_wght.ttf',
        );
        expect(warnings, 'a duplicate copy is expected, not a problem').toEqual([]);
        expect(logs.length, 'but it is still reported, at log level').toBe(1);
        expect(logs[0]).toContain('SAME font file');
      });

      it('warns for a different file at the same family/weight/style', async () => {
        const { warnings, logs } = await loadBoth('/vendor/Roboto-Bold.ttf', '/game/Roboto-Bold.otf');
        // Different basenames (extension differs) at identical CSS coordinates → real ambiguity.
        expect(logs).toEqual([]);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('DIFFERENT file');
      });
    });

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

    it('a failure warning names the failing path + reason, not just a count', async () => {
      installFontFaceMock();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadAllFonts } = await getLoader();
      const p = loadAllFonts([{ path: '/fonts/Open-Bold.woff2', type: 'font' }]);
      const sources = Object.keys(loadCalls);
      (rejecters[sources[0]] ?? []).forEach(r => r(new Error('boom')));
      await p;
      const msg = warn.mock.calls.map(c => String(c[0])).find(m => /fonts failed/.test(m));
      expect(msg).toContain('/fonts/Open-Bold.woff2');
      expect(msg).toContain('boom');
      warn.mockRestore();
    });

    it('skips a font entry whose manifest block has sourceShipped:false — the build dropped it on purpose', async () => {
      installFontFaceMock();
      const { loadAllFonts, getLoadedFontFamilies } = await getLoader();
      const p = loadAllFonts([
        { path: '/fonts/Roboto-Regular.woff2', type: 'font', font: { sourceShipped: false } },
        { path: '/fonts/Open-Bold.woff2', type: 'font', font: { sourceShipped: true } },
        { path: '/fonts/Geologica-Bold.woff2', type: 'font' }, // no font block at all — dev/legacy, still loads
      ]);
      const sources = Object.keys(loadCalls);
      // Only the two NOT flagged sourceShipped:false attempted a load.
      expect(sources.length).toBe(2);
      expect(sources.some(s => s.includes('Roboto'))).toBe(false);
      sources.forEach(s => (resolvers[s] ?? []).forEach(r => r()));
      await p;
      expect(getLoadedFontFamilies()).not.toContain('Roboto');
      expect(getLoadedFontFamilies()).toContain('Open');
      expect(getLoadedFontFamilies()).toContain('Geologica');
    });

    it('does not warn about a sourceShipped:false font — it is not a failure', async () => {
      installFontFaceMock();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadAllFonts } = await getLoader();
      await loadAllFonts([
        { path: '/fonts/Roboto-Regular.woff2', type: 'font', font: { sourceShipped: false } },
      ]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  /** #253 — a scene's `{type:'font', path:'<CSS family name>'}` resource (from
   *  `UIElement.fontFamily`) used to be a NO-OP in SceneManager's acquire, on the assumption
   *  that `loadAllFonts` had already registered everything. Its only editor-side caller is the
   *  Assets PANEL, so with that tab unmounted no face was registered and every DOM string in
   *  the Game panel rendered in the browser's default serif — silently. `loadFontFamily` is
   *  what the scene-load path calls instead. */
  describe('loadFontFamily (#253 — a scene resource that names a CSS family)', () => {
    let loadCalls: Record<string, number>;
    let resolvers: Record<string, (() => void)[]>;
    let rejecters: Record<string, ((e: Error) => void)[]>;

    function installFontFaceMock() {
      loadCalls = {};
      resolvers = {};
      rejecters = {};
      class FakeFontFace {
        constructor(public family: string, public source: string, public descriptors: { weight: string; style: string }) {}
        load() {
          loadCalls[this.source] = (loadCalls[this.source] ?? 0) + 1;
          return new Promise<this>((resolve, reject) => {
            (resolvers[this.source] ??= []).push(() => resolve(this));
            (rejecters[this.source] ??= []).push((e: Error) => reject(e));
          });
        }
      }
      (globalThis as any).FontFace = FakeFontFace;
      (globalThis as any).document = { fonts: { add: vi.fn() } };
    }

    /** Register a manifest the way the real scan does, on the post-resetModules graph. */
    async function seedManifest(entries: { path: string; type?: string; sourceShipped?: boolean }[]) {
      const manifest = await import('../../src/runtime/loaders/assetManifest');
      manifest.clearManifest();
      entries.forEach((e, i) => {
        manifest.registerAsset(
          `30000000-0000-4000-8000-00000000000${i}`,
          e.path,
          (e.type ?? 'font') as any,
          undefined, // texture settings
          e.sourceShipped === undefined ? undefined : { font: { sourceShipped: e.sourceShipped } },
        );
      });
      return manifest;
    }

    /** Settle every FontFace.load() the call kicked off, then await it. */
    async function settle<T>(p: Promise<T>): Promise<T> {
      await Promise.resolve();
      Object.keys(loadCalls).forEach(s => (resolvers[s] ?? []).forEach(r => r()));
      return p;
    }

    it('registers EVERY variant of the family, and nothing outside it', async () => {
      installFontFaceMock();
      await seedManifest([
        { path: '/assets/fonts/VarelaRound-Regular.ttf' },
        { path: '/assets/fonts/VarelaRound-Bold.ttf' },
        { path: '/assets/fonts/Roboto-Regular.ttf' },       // a different family
        { path: '/assets/textures/sky.png', type: 'texture' }, // not a font at all
      ]);
      const { loadFontFamily, getLoadedFonts } = await getLoader();

      const n = await settle(loadFontFamily('Varela Round'));

      expect(n, 'both Varela Round variants').toBe(2);
      expect(Object.keys(loadCalls).length).toBe(2);
      expect(Object.keys(loadCalls).every(s => s.includes('VarelaRound'))).toBe(true);
      // Bold registered too — a UI authoring fontWeight:700 needs the real file, else the
      // browser synthesizes a fake bold from the regular.
      const variants = getLoadedFonts().get('Varela Round') ?? [];
      expect(variants.map(v => v.weight).sort()).toEqual(['400', '700']);
    });

    it('warns ONCE for a family that matches no font asset, and names the filename rule', async () => {
      installFontFaceMock();
      await seedManifest([{ path: '/assets/fonts/Roboto-Regular.ttf' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadFontFamily } = await getLoader();

      expect(await loadFontFamily('Varela Round')).toBe(0);
      expect(await loadFontFamily('Varela Round')).toBe(0);

      const msgs = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('Varela Round'));
      expect(msgs.length, 'warn-once, not once per UI string').toBe(1);
      expect(msgs[0]).toContain('matches no font asset');
      expect(msgs[0]).toContain('VarelaRound-Regular.ttf');
      // The build's font scan uses the same exact-case rule, so a case slip drops the font from
      // the shipped game too — the message has to say so or it reads as editor-only.
      expect(msgs[0]).toMatch(/CASE|exact/);
      expect(Object.keys(loadCalls).length).toBe(0);
      warn.mockRestore();
    });

    it('reports a sourceShipped:false family as DROPPED BY THE BUILD, not as missing', async () => {
      installFontFaceMock();
      await seedManifest([{ path: '/assets/fonts/VarelaRound-Regular.ttf', sourceShipped: false }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadFontFamily } = await getLoader();

      expect(await loadFontFamily('Varela Round')).toBe(0);

      const msg = warn.mock.calls.map(c => String(c[0])).find(m => m.includes('Varela Round'));
      // The two need different fixes — ship the source vs. name a real font — so they must
      // not share a message.
      expect(msg).toContain('did not ship');
      expect(msg).not.toContain('matches no font asset');
      expect(Object.keys(loadCalls).length, 'the path would 404').toBe(0);
      warn.mockRestore();
    });

    it('treats a generic CSS keyword as nothing to load — silently', async () => {
      installFontFaceMock();
      await seedManifest([{ path: '/assets/fonts/Roboto-Regular.ttf' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadFontFamily } = await getLoader();

      for (const generic of ['sans-serif', 'serif', 'system-ui', 'MONOSPACE', 'inherit']) {
        expect(await loadFontFamily(generic), generic).toBe(0);
      }
      expect(warn, 'a generic keyword names no asset BY DESIGN').not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('resolves each segment of a hand-typed CSS stack separately', async () => {
      installFontFaceMock();
      await seedManifest([{ path: '/assets/fonts/VarelaRound-Regular.ttf' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadFontFamily } = await getLoader();

      // The whole string as ONE family would match nothing and warn about a family
      // nobody authored.
      const n = await settle(loadFontFamily('"Varela Round", sans-serif'));

      expect(n).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('is a silent no-op with no DOM — a headless scene load must not warn or throw', async () => {
      delete (globalThis as any).FontFace;
      delete (globalThis as any).document;
      await seedManifest([{ path: '/assets/fonts/VarelaRound-Regular.ttf' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadFontFamily } = await getLoader();

      await expect(loadFontFamily('Varela Round')).resolves.toBe(0);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('a FontFace failure is warned, not thrown — a font must not fail a scene load', async () => {
      installFontFaceMock();
      await seedManifest([{ path: '/assets/fonts/VarelaRound-Regular.ttf' }]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { loadFontFamily } = await getLoader();

      const p = loadFontFamily('Varela Round');
      await Promise.resolve();
      Object.keys(loadCalls).forEach(s => (rejecters[s] ?? []).forEach(r => r(new Error('boom'))));

      await expect(p).resolves.toBe(0);
      expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes('boom'))).toBe(true);
      warn.mockRestore();
    });
  });
});
