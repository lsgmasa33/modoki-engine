import { describe, it, expect, beforeEach, beforeAll, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { clearManifest, registerAsset, registerSprite } from '../../src/runtime/loaders/assetManifest';
import {
  resolveTextureVariantUrl, getTextureSettings, invalidateTexture, resolveSprite,
  loadTexture3D, releaseTexture3D, getSharedTextureStats, disposeAllSharedTextures, isSharedTexture,
  getKTX2Loader, setActiveRenderer, onRendererReady, getActiveRenderer,
} from '../../src/runtime/loaders/textureResolver';
import { DEFAULT_TEXTURE_SETTINGS } from '../../src/runtime/loaders/textureSettings';

const GUID = '11111111-1111-4111-8111-111111111111';
const PATH = '/games/g/assets/tex/rock.png';

beforeEach(() => clearManifest());

describe('resolveTextureVariantUrl', () => {
  it('falls back to the source URL when the texture is unconverted', () => {
    registerAsset(GUID, PATH, 'texture'); // no baked settings
    const url = resolveTextureVariantUrl(GUID, '3d');
    expect(url).toContain(PATH);
    expect(url).not.toContain('~');
  });

  it('picks the UASTC variant for 3d when converted as ktx2-uastc', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' });
    expect(resolveTextureVariantUrl(GUID, '3d')).toContain(PATH + '~uastc.ktx2');
  });

  it('picks the WebP variant for 2d when imported as a webp (2D) format', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' });
    expect(resolveTextureVariantUrl(GUID, '2d')).toContain(PATH + '~webp.webp');
  });

  it('picks the UASTC (universal) variant for 2d KTX2 — PixiJS transcodes via libktx', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' });
    expect(resolveTextureVariantUrl(GUID, '2d')).toContain(PATH + '~uastc.ktx2');
  });

  it('ASTC format falls back to UASTC when the GPU lacks ASTC (default caps)', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-astc' });
    expect(resolveTextureVariantUrl(GUID, '3d')).toContain(PATH + '~uastc.ktx2');
  });

  it('rejects a direct internal path ref (GUID-only) — returns undefined', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveTextureVariantUrl(PATH, '3d')).toBeUndefined();
    err.mockRestore();
  });

  it('does NOT append the cache-bust ?v in dev even when a hash is present', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' }, undefined, 'deadbeef');
    const url = resolveTextureVariantUrl(GUID, '3d');
    expect(url).toContain(PATH + '~uastc.ktx2');
    expect(url).not.toContain('?v=');
  });

  it('appends ?v=<hash> in production builds (immutable-cache bust)', () => {
    vi.stubEnv('PROD', 'true');
    try {
      registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' }, undefined, 'deadbeef');
      expect(resolveTextureVariantUrl(GUID, '3d')).toContain(PATH + '~uastc.ktx2?v=deadbeef');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveSprite', () => {
  const SPRITE = '22222222-2222-4222-8222-222222222222';

  it('resolves a whole-texture ref to the full image (frame null)', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' });
    const r = resolveSprite(GUID);
    expect(r?.url).toContain(PATH + '~webp.webp');
    expect(r?.frame).toBeNull();
    expect(r?.sheetW).toBeNull();
  });

  it('resolves a sliced sprite through its parent texture, carrying the frame + sheet', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' });
    registerSprite(SPRITE, GUID, PATH, {
      texture: GUID, rect: { x: 64, y: 0, w: 64, h: 32 }, pivot: { x: 0.5, y: 1 },
      sheetW: 256, sheetH: 256,
    });
    const r = resolveSprite(SPRITE);
    // URL flows through the PARENT texture's 2D variant — not the synthetic path.
    expect(r?.url).toContain(PATH + '~webp.webp');
    expect(r?.url).not.toContain('#');
    expect(r?.frame).toEqual({ x: 64, y: 0, w: 64, h: 32 });
    expect(r?.pivot).toEqual({ x: 0.5, y: 1 });
    expect(r?.sheetW).toBe(256);
  });

  it('resolves a sliced sprite of a KTX2 texture through the ~uastc.ktx2 variant', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' });
    registerSprite(SPRITE, GUID, PATH, {
      texture: GUID, rect: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 },
    });
    const r = resolveSprite(SPRITE);
    // KTX2 now serves the 2D path (PixiJS libktx transcode) — no source fallback.
    expect(r?.url).toContain(PATH + '~uastc.ktx2');
    expect(r?.frame).toEqual({ x: 0, y: 0, w: 16, h: 16 });
  });

  it('redirects a packed member to its atlas page + page rect, carrying page dims as sheetW/H', () => {
    const ATLAS = '33333333-3333-4333-8333-333333333333';
    const ATLAS_PATH = '/games/g/assets/sprites/pack.atlas.json';
    // The source texture + slice still exist, but the member is in a built atlas.
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' });
    registerSprite(SPRITE, GUID, PATH, {
      texture: GUID, rect: { x: 64, y: 0, w: 64, h: 32 }, pivot: { x: 0, y: 0 }, sheetW: 256, sheetH: 256,
    });
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, {
      atlas: {
        hash: 'abc123', pages: [{ hash: 'p0hash', variants: ['webp'], w: 128, h: 64 }],
        texture: { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' },
        frames: { [SPRITE]: { page: 0, rect: { x: 1, y: 1, w: 64, h: 32 }, pivot: { x: 0.25, y: 0.75 } } },
      },
    });
    const r = resolveSprite(SPRITE);
    expect(r?.url).toContain(ATLAS_PATH + '~page0~webp.webp');
    expect(r?.frame).toEqual({ x: 1, y: 1, w: 64, h: 32 });   // page rect, NOT source rect
    expect(r?.pivot).toEqual({ x: 0.25, y: 0.75 });
    // sheetW/H MUST be the PAGE dims (not null) so the 2D skin builder can normalize the
    // page-px rect to 0..1 UVs (rect/page). Returning null here left the skinned rig
    // sampling the whole page → garbled sprites. The page is 1:1, so `frameTexture`'s
    // downscale scaling (base.width/sheetW) stays a no-op.
    expect(r?.sheetW).toBe(128);
    expect(r?.sheetH).toBe(64);
  });

  it('redirects a member to a KTX2 atlas page (~page0~uastc.ktx2)', () => {
    const ATLAS = '44444444-4444-4444-8444-444444444444';
    const ATLAS_PATH = '/games/g/assets/sprites/k.atlas.json';
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'webp' });
    registerSprite(SPRITE, GUID, PATH, { texture: GUID, rect: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 } });
    registerAsset(ATLAS, ATLAS_PATH, 'atlas', undefined, {
      atlas: {
        hash: 'k', pages: [{ hash: 'kp0', variants: ['uastc'], w: 64, h: 64 }],
        texture: { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' }, // KTX2 pages now decode in 2D
        frames: { [SPRITE]: { page: 0, rect: { x: 2, y: 2, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 } } },
      },
    });
    const r = resolveSprite(SPRITE);
    expect(r?.url).toContain(ATLAS_PATH + '~page0~uastc.ktx2'); // the KTX2 page, not the source
    expect(r?.frame).toEqual({ x: 2, y: 2, w: 16, h: 16 });    // page rect
  });
});

describe('invalidateTexture', () => {
  // The editor's texture re-import + model import call this with the asset PATH
  // (not a GUID). resolveRef rejects internal paths loudly, so a path ref must be
  // accepted directly — regression guard for the "path reference no longer
  // supported" error on Re-import.
  it('accepts a PATH ref without the GUID-rejection error, clearing variant keys', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const removed: string[] = [];
    const remove = vi.spyOn(THREE.Cache, 'remove').mockImplementation((k: string) => { removed.push(k); });

    invalidateTexture(PATH);

    expect(err).not.toHaveBeenCalled();                         // no resolveRef rejection
    expect(removed).toContain(PATH);                            // source key cleared
    expect(removed.some((k) => k.startsWith(PATH + '~'))).toBe(true); // variant keys cleared
    remove.mockRestore();
    err.mockRestore();
  });

  it('resolves a GUID ref to its path and clears the same keys', () => {
    registerAsset(GUID, PATH, 'texture');
    const removed: string[] = [];
    const remove = vi.spyOn(THREE.Cache, 'remove').mockImplementation((k: string) => { removed.push(k); });

    invalidateTexture(GUID);

    expect(removed).toContain(PATH);
    remove.mockRestore();
  });
});

describe('shared texture cache (F3 — dedup + refcount)', () => {
  // Non-KTX path: an unconverted texture resolves to the source URL and loads via
  // THREE.TextureLoader, whose loadAsync is inherited from Loader.prototype. Each
  // call resolves a FRESH THREE.Texture so instance identity proves sharing.
  let loadAsyncSpy: ReturnType<typeof vi.spyOn>;
  // loadTexture3D now gates a KTX2 load on `rendererReady` (the runtime fix for the
  // Android "Missing initialization with `.detectSupport( renderer )`" race — a KTX2
  // load must not fire before `setActiveRenderer` wires the loader's GPU caps). Prime
  // that ready state once so the KTX-loading tests here (and in the later
  // applyTextureSettings block — `rendererReadyFired` is module-monotonic) don't hang
  // waiting for a renderer. Stub detectSupport so caps stay the pristine {astc:false}
  // the earlier variant-selection tests assert against.
  beforeAll(() => {
    const detect = vi.spyOn(getKTX2Loader(), 'detectSupport').mockImplementation(function (this: { workerConfig?: { astcSupported?: boolean } }) {
      this.workerConfig = { astcSupported: false }; return this as never;
    });
    setActiveRenderer({} as never);
    detect.mockRestore();
  });
  beforeEach(() => {
    loadAsyncSpy = vi.spyOn(THREE.Loader.prototype, 'loadAsync')
      .mockImplementation(async () => new THREE.Texture() as never);
  });
  afterEach(() => { disposeAllSharedTextures(); loadAsyncSpy.mockRestore(); });

  it('returns the SAME instance for repeated loads of one ref — loads/transcodes once', async () => {
    registerAsset(GUID, PATH, 'texture'); // unconverted → source URL, non-KTX
    const a = await loadTexture3D(GUID);
    const b = await loadTexture3D(GUID);
    expect(a).toBe(b);
    expect(loadAsyncSpy).toHaveBeenCalledTimes(1);
    expect(getSharedTextureStats()).toEqual({ count: 1, refs: 2 });
    expect(isSharedTexture(a)).toBe(true);
  });

  it('disposes the texture only when the LAST reference is released', async () => {
    registerAsset(GUID, PATH, 'texture');
    const a = await loadTexture3D(GUID);
    await loadTexture3D(GUID); // refs = 2 (same instance)
    const disp = vi.spyOn(a, 'dispose');
    releaseTexture3D(a);
    expect(disp).not.toHaveBeenCalled();           // one ref still out
    expect(getSharedTextureStats().count).toBe(1);
    releaseTexture3D(a);
    expect(disp).toHaveBeenCalledTimes(1);          // last ref → disposed + evicted
    expect(getSharedTextureStats()).toEqual({ count: 0, refs: 0 });
  });

  it('keys non-KTX textures by flipY so opposite orientations do not share', async () => {
    registerAsset(GUID, PATH, 'texture');
    const a = await loadTexture3D(GUID, { flipY: true });
    const b = await loadTexture3D(GUID, { flipY: false });
    expect(a).not.toBe(b);
    expect(getSharedTextureStats().count).toBe(2);
  });

  it('does not cache a failed load — a later load retries', async () => {
    registerAsset(GUID, PATH, 'texture');
    loadAsyncSpy.mockRejectedValueOnce(new Error('boom'));
    await expect(loadTexture3D(GUID)).rejects.toThrow('boom');
    expect(getSharedTextureStats().count).toBe(0);
    const t = await loadTexture3D(GUID); // default mock resolves
    expect(t).toBeInstanceOf(THREE.Texture);
    expect(getSharedTextureStats().count).toBe(1);
  });

  it('invalidateTexture force-disposes shared textures + evicts; a stale release is a no-op', async () => {
    registerAsset(GUID, PATH, 'texture');
    const a = await loadTexture3D(GUID);
    await loadTexture3D(GUID); // refs = 2 — invalidate ignores the count
    const disp = vi.spyOn(a, 'dispose');
    const remove = vi.spyOn(THREE.Cache, 'remove').mockImplementation(() => {});
    invalidateTexture(GUID);
    expect(disp).toHaveBeenCalledTimes(1);
    expect(getSharedTextureStats().count).toBe(0);
    releaseTexture3D(a); // entry already gone → must not double-dispose / throw
    expect(disp).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  it('releasing a texture that never came from the cache disposes it directly', () => {
    const t = new THREE.Texture();
    expect(isSharedTexture(t)).toBe(false);
    const disp = vi.spyOn(t, 'dispose');
    releaseTexture3D(t);
    expect(disp).toHaveBeenCalledTimes(1);
  });

  // KTX2 branch: a converted ktx2-uastc texture resolves to a `~uastc.ktx2` URL and
  // loads via the KTX2Loader singleton (whose real `load` needs a transcoder/WASM, so
  // spy the instance directly). KTX2 is always bottom-origin, so applyTextureSettings
  // forces flipY=false and the cache key ignores flipY — opposite-flipY loads collapse
  // to ONE entry.
  it('shares ONE entry for a KTX2 texture regardless of flipY (always bottom-origin)', async () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' });
    const ktxSpy = vi.spyOn(getKTX2Loader(), 'loadAsync')
      .mockImplementation(async () => new THREE.Texture() as never);
    const a = await loadTexture3D(GUID, { flipY: true });
    const b = await loadTexture3D(GUID, { flipY: false });
    expect(a).toBe(b);                              // flipY does not split KTX entries
    expect(ktxSpy).toHaveBeenCalledTimes(1);
    expect(getSharedTextureStats()).toEqual({ count: 1, refs: 2 });
    expect(a.flipY).toBe(false);                    // forced bottom-origin
    expect(a.generateMipmaps).toBe(false);          // baked mips
    ktxSpy.mockRestore();
  });

  it('loads a KTX2 variant from the ~uastc.ktx2 URL (not the source PNG)', async () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' });
    const ktxSpy = vi.spyOn(getKTX2Loader(), 'loadAsync')
      .mockImplementation(async () => new THREE.Texture() as never);
    await loadTexture3D(GUID);
    const url = ktxSpy.mock.calls[0][0] as string;
    expect(url).toContain(PATH + '~uastc.ktx2');
    ktxSpy.mockRestore();
  });
});

describe('getTextureSettings', () => {
  it('returns defaults for an unknown ref', () => {
    expect(getTextureSettings('/unknown.png')).toEqual(DEFAULT_TEXTURE_SETTINGS);
  });

  it('returns the baked settings for a converted texture', () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, maxSize: 1024, wrapS: 'clamp' });
    const s = getTextureSettings(GUID);
    expect(s.maxSize).toBe(1024);
    expect(s.wrapS).toBe('clamp');
  });
});

describe('2d unconverted-texture fallback', () => {
  // An unconverted texture (no baked settings) has no variant on disk, so 2D
  // resolution returns the raw source URL. (Converted KTX2/WebP/PNG all yield a
  // real 2D variant now — see resolveTextureVariantUrl tests above.)
  it('does not crash when the texture is unconverted (no settings) → source URL', () => {
    registerAsset(GUID, PATH, 'texture'); // no settings → source fallback path
    const url = resolveTextureVariantUrl(GUID, '2d');
    expect(url).toContain(PATH);
    expect(url).not.toContain('~');
  });
});

// ── Missing Test #2 — applyTextureSettings KTX-vs-PNG branches ──────────────
describe('applyTextureSettings branches (via loadTexture3D)', () => {
  let loadAsyncSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Non-KTX source path → THREE.TextureLoader.loadAsync (inherited from Loader).
    loadAsyncSpy = vi.spyOn(THREE.Loader.prototype, 'loadAsync')
      .mockImplementation(async () => new THREE.Texture() as never);
  });
  afterEach(() => { disposeAllSharedTextures(); loadAsyncSpy.mockRestore(); });

  it('non-KTX: honors flipY, generateMipmaps=settings.mipmaps, mipmap minFilter', async () => {
    // format 'png' produces no 3D variant → 3D load falls back to the source (non-KTX),
    // and getTextureSettings returns the baked block (mipmaps:true here).
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', mipmaps: true });
    const tex = await loadTexture3D(GUID, { flipY: true });
    expect(tex.flipY).toBe(true);                                  // flipY honored for non-KTX
    expect(tex.generateMipmaps).toBe(true);
    expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);    // mipmaps on
  });

  it('non-KTX: mipmaps off → no generateMipmaps + linear minFilter; flipY=false honored', async () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', mipmaps: false });
    const tex = await loadTexture3D(GUID, { flipY: false });
    expect(tex.flipY).toBe(false);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.minFilter).toBe(THREE.LinearFilter);               // mipmaps off
  });

  it('applies wrap + colorspace from the import settings', async () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', wrapS: 'clamp', wrapT: 'mirror', colorspace: 'linear' });
    const tex = await loadTexture3D(GUID);
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.wrapT).toBe(THREE.MirroredRepeatWrapping);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);              // linear → NoColorSpace
  });

  it('srgb colorspace maps to SRGBColorSpace', async () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'png', colorspace: 'srgb' });
    const tex = await loadTexture3D(GUID);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  // NOTE: KTX2Loader and TextureLoader both inherit loadAsync from THREE.Loader, so
  // a single prototype spy serves both — the loader taken can't be told apart by the
  // spy. The applyTextureSettings effects (flipY/generateMipmaps) ARE the observable
  // proof that loadTexture3D went down the isKtx branch.
  it('KTX: forces flipY=false + no generateMipmaps regardless of the flipY opt or mipmaps setting', async () => {
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc', mipmaps: true });
    // Spy the KTX2Loader instance directly: its real loadAsync needs GPU init
    // (detectSupport), and a prior describe's mockRestore can leave the singleton's
    // own loadAsync = real, shadowing the prototype spy.
    const ktxSpy = vi.spyOn(getKTX2Loader(), 'loadAsync').mockImplementation(async () => new THREE.Texture() as never);
    const tex = await loadTexture3D(GUID, { flipY: true }); // opt ignored on the KTX branch
    expect(tex.flipY).toBe(false);
    expect(tex.generateMipmaps).toBe(false); // baked mips, never regenerated
    ktxSpy.mockRestore();
  });

  it('routes a ?v=<hash> cache-busted .ktx2 URL down the KTX branch (regex handles the suffix)', async () => {
    vi.stubEnv('PROD', 'true'); // PROD appends ?v=<hash>
    const ktxSpy = vi.spyOn(getKTX2Loader(), 'loadAsync').mockImplementation(async () => new THREE.Texture() as never);
    try {
      registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' }, undefined, 'cafef00d');
      const tex = await loadTexture3D(GUID);
      const url = ktxSpy.mock.calls[0][0] as string;
      expect(url).toContain('~uastc.ktx2?v=cafef00d'); // cache-busted variant URL
      expect(tex.flipY).toBe(false);                    // KTX branch was taken despite ?v=
      expect(tex.generateMipmaps).toBe(false);
    } finally {
      ktxSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

// ── Missing Tests #3 + #4 — setActiveRenderer caps + getKTX2Loader singleton ──
// These mutate module-level singletons (detectedCaps, rendererReadyFired); they live
// at the END of the file so earlier "default caps" tests run against the pristine
// {astc:false} state. The last test restores caps to false for hygiene.
describe('getKTX2Loader (Missing Test #4)', () => {
  it('returns the same singleton instance', () => {
    expect(getKTX2Loader()).toBe(getKTX2Loader());
  });
});

describe('setActiveRenderer caps detection + rendererReady (Missing Test #3)', () => {
  // A minimal renderer stub; detectSupport is overridden via a spy on the loader.
  const fakeRenderer = {} as never;

  it('reflects astc support from the loader workerConfig into variant selection', () => {
    const loader = getKTX2Loader();
    const detect = vi.spyOn(loader, 'detectSupport').mockImplementation(function (this: { workerConfig?: { astcSupported?: boolean } }) {
      this.workerConfig = { astcSupported: true }; return this as never;
    });
    setActiveRenderer(fakeRenderer);
    detect.mockRestore();

    // detectedCaps.astc=true → a ktx2-astc texture now resolves to the native ~astc.ktx2
    // variant (no UASTC fallback).
    registerAsset(GUID, PATH, 'texture', { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-astc' });
    expect(resolveTextureVariantUrl(GUID, '3d')).toContain(PATH + '~astc.ktx2');
  });

  it('onRendererReady fires immediately once the renderer is already active', () => {
    const cb = vi.fn();
    onRendererReady(cb); // rendererReadyFired is true after the previous test → sync call
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('swallows a detectSupport throw with a warn (renderer still set)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const detect = vi.spyOn(getKTX2Loader(), 'detectSupport').mockImplementation(() => { throw new Error('no gpu'); });
    expect(() => setActiveRenderer({} as never)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(getActiveRenderer()).toBeDefined();
    detect.mockRestore();
    warn.mockRestore();

    // Restore caps to {astc:false} for any later additions to this file.
    const reset = vi.spyOn(getKTX2Loader(), 'detectSupport').mockImplementation(function (this: { workerConfig?: { astcSupported?: boolean } }) {
      this.workerConfig = { astcSupported: false }; return this as never;
    });
    setActiveRenderer({} as never);
    reset.mockRestore();
  });
});
