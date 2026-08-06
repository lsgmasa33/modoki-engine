/** @vitest-environment jsdom */
/** Device capability probe (#121 P0) — `runtime/rendering/deviceCaps.ts`.
 *
 *  The probe reports FACTS and picks no tier, so these tests pin two things: that each fact is
 *  read from the right place, and that every source being absent degrades to `undefined` rather
 *  than throwing. The second half matters more than it looks — this runs at boot on the weakest
 *  hardware we support, where the GL context may not exist and no native plugin is installed,
 *  and a probe that throws there takes the whole game with it.
 *
 *  Each test does `vi.resetModules()` + a fresh dynamic import so the module-level cache starts
 *  clean, and stubs `document.createElement` because jsdom has no real WebGL. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Minimal WebGL2 stub — only the handful of members `readGlFacts` touches. */
function makeGl(opts: {
  renderer?: string;
  maxTextureSize?: number;
  extensions?: string[];
  loseContext?: () => void;
} = {}) {
  const exts = new Set(opts.extensions ?? []);
  return {
    MAX_TEXTURE_SIZE: 0x0d33,
    getParameter: vi.fn((p: number) => {
      if (p === 0x0d33) return opts.maxTextureSize ?? 4096;
      if (p === 0x9246) return opts.renderer ?? '';   // UNMASKED_RENDERER_WEBGL
      return undefined;
    }),
    getExtension: vi.fn((name: string) => {
      if (name === 'WEBGL_debug_renderer_info') {
        return opts.renderer !== undefined ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null;
      }
      if (name === 'WEBGL_lose_context') {
        return { loseContext: opts.loseContext ?? (() => {}) };
      }
      return exts.has(name) ? {} : null;
    }),
  };
}

/** Install a `document.createElement('canvas')` whose `getContext('webgl2')` returns `gl`. */
function stubCanvas(gl: unknown) {
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return real(tag);
    return { width: 0, height: 0, getContext: (t: string) => (t === 'webgl2' ? gl : null) };
  }) as typeof document.createElement);
}

/** Load the module with `gpuDetect` and `activeRenderer` mocked to the given answers. */
async function load(opts: { webgpu?: boolean; renderer?: unknown } = {}) {
  vi.resetModules();
  vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({
    getWebGPUSupported: () => Promise.resolve(opts.webgpu ?? false),
    getWebGPUSupportedSync: () => opts.webgpu ?? false,
  }));
  vi.doMock('../../src/runtime/core/activeRenderer', () => ({
    getActiveRenderer: () => opts.renderer ?? null,
  }));
  return await import('../../src/runtime/rendering/deviceCaps');
}

beforeEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/runtime/rendering/gpuDetect');
  vi.doUnmock('../../src/runtime/core/activeRenderer');
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('deviceCaps — identity', () => {
  it('reports platform web when no Capacitor global exists', async () => {
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).platform).toBe('web');
  });

  it('reads the platform from the Capacitor global', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'ios' };
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).platform).toBe('ios');
  });

  it('reads deviceModel from the Device plugin — the iOS tier key', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'ios',
      Plugins: { Device: { getInfo: () => Promise.resolve({ model: 'iPhone10,1' }) } },
    };
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).deviceModel).toBe('iPhone10,1');
  });

  it('leaves deviceModel undefined when the Device plugin is absent — the web-build case', async () => {
    // Published demos are web-only, so this is the NORMAL path for them on iOS, not an error.
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).deviceModel).toBeUndefined();
  });

  it('survives a Device plugin whose getInfo rejects', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'android',
      Plugins: { Device: { getInfo: () => Promise.reject(new Error('no bridge')) } },
    };
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    const caps = await getDeviceCaps();
    expect(caps.deviceModel).toBeUndefined();
    expect(caps.platform).toBe('android');
  });

  it('reads the unmasked GPU renderer — the Android tier key', async () => {
    stubCanvas(makeGl({ renderer: 'Adreno (TM) 610' }));
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).gpuRenderer).toBe('Adreno (TM) 610');
  });

  it('leaves gpuRenderer undefined when the debug extension is blocked', async () => {
    stubCanvas(makeGl()); // no renderer => WEBGL_debug_renderer_info returns null
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).gpuRenderer).toBeUndefined();
  });
});

describe('deviceCaps — GL facts', () => {
  it('reports maxTextureSize and compressed-format support', async () => {
    stubCanvas(makeGl({
      maxTextureSize: 8192,
      extensions: ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc'],
    }));
    const { getDeviceCaps } = await load();
    const caps = await getDeviceCaps();
    expect(caps.maxTextureSize).toBe(8192);
    expect(caps.compressed).toEqual({ astc: true, etc2: true, s3tc: false });
  });

  it('RELEASES the throwaway GL context — a leak costs most on the devices this profiles', async () => {
    const loseContext = vi.fn();
    stubCanvas(makeGl({ loseContext }));
    const { getDeviceCaps } = await load();
    await getDeviceCaps();
    expect(loseContext).toHaveBeenCalled();
  });

  it('degrades cleanly when webgl2 is unavailable', async () => {
    stubCanvas(null);
    const { getDeviceCaps } = await load();
    const caps = await getDeviceCaps();
    expect(caps.maxTextureSize).toBeUndefined();
    expect(caps.gpuRenderer).toBeUndefined();
    expect(caps.compressed).toEqual({ astc: false, etc2: false, s3tc: false });
  });

  it('NEVER throws when getContext itself throws', async () => {
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return real(tag);
      return { getContext: () => { throw new Error('context creation failed'); } };
    }) as typeof document.createElement);
    const { getDeviceCaps } = await load();
    await expect(getDeviceCaps()).resolves.toMatchObject({
      compressed: { astc: false, etc2: false, s3tc: false },
    });
  });
});

describe('deviceCaps — backend vs capability', () => {
  it('backend is null before any renderer registers', async () => {
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load({ renderer: null });
    expect((await getDeviceCaps()).backend).toBeNull();
  });

  it('distinguishes what the device CAN do from what the renderer IS doing', async () => {
    // A project can force the WebGL backend on a WebGPU-capable device, so these two fields
    // genuinely disagree — conflating them would misreport the machine.
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load({ webgpu: true, renderer: { isWebGPURenderer: false } });
    const caps = await getDeviceCaps();
    expect(caps.webgpu).toBe(true);
    expect(caps.backend).toBe('WebGL');
  });

  it('reports a live WebGPU renderer as WebGPU', async () => {
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load({ webgpu: true, renderer: { isWebGPURenderer: true } });
    expect((await getDeviceCaps()).backend).toBe('WebGPU');
  });

  it('survives the WebGPU probe rejecting', async () => {
    vi.resetModules();
    vi.doMock('../../src/runtime/rendering/gpuDetect', () => ({
      getWebGPUSupported: () => Promise.reject(new Error('adapter exploded')),
      getWebGPUSupportedSync: () => null,
    }));
    vi.doMock('../../src/runtime/core/activeRenderer', () => ({ getActiveRenderer: () => null }));
    stubCanvas(makeGl());
    const { getDeviceCaps } = await import('../../src/runtime/rendering/deviceCaps');
    expect((await getDeviceCaps()).webgpu).toBe(false);
  });
});

describe('deviceCaps — caching', () => {
  it('probes ONCE and reuses the result', async () => {
    const gl = makeGl();
    stubCanvas(gl);
    const { getDeviceCaps } = await load();
    await getDeviceCaps();
    const callsAfterFirst = gl.getExtension.mock.calls.length;
    await getDeviceCaps();
    expect(gl.getExtension.mock.calls.length).toBe(callsAfterFirst);
  });

  it('concurrent callers share ONE in-flight probe', async () => {
    const gl = makeGl();
    stubCanvas(gl);
    const { getDeviceCaps } = await load();
    const [a, b] = await Promise.all([getDeviceCaps(), getDeviceCaps()]);
    expect(a).toBe(b); // same object identity — not merely equal
  });

  it('getDeviceCapsSync returns null before the probe completes, then the result', async () => {
    stubCanvas(makeGl());
    const { getDeviceCaps, getDeviceCapsSync } = await load();
    expect(getDeviceCapsSync()).toBeNull();
    const caps = await getDeviceCaps();
    expect(getDeviceCapsSync()).toBe(caps);
  });

  it('resetDeviceCaps forces a re-probe — needed to re-read backend after renderer bring-up', async () => {
    stubCanvas(makeGl());
    const { getDeviceCaps, resetDeviceCaps, getDeviceCapsSync } = await load();
    const first = await getDeviceCaps();
    resetDeviceCaps();
    expect(getDeviceCapsSync()).toBeNull();
    expect(await getDeviceCaps()).not.toBe(first);
  });
});

describe('deviceCaps — the non-discriminative signals are reported, not trusted', () => {
  it('passes through deviceMemory / hardwareConcurrency when present', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);
    Object.defineProperty(navigator, 'deviceMemory', { value: 4, configurable: true });
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    const caps = await getDeviceCaps();
    expect(caps.hardwareConcurrency).toBe(8);
    expect(caps.deviceMemory).toBe(4);
    delete (navigator as { deviceMemory?: number }).deviceMemory;
  });

  it('leaves deviceMemory undefined where the browser omits it (all of iOS)', async () => {
    delete (navigator as { deviceMemory?: number }).deviceMemory;
    stubCanvas(makeGl());
    const { getDeviceCaps } = await load();
    expect((await getDeviceCaps()).deviceMemory).toBeUndefined();
  });
});
