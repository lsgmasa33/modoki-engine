/** #1586: the runtime half of the transcoder cache-bust — both pairs are requested with
 *  `?v=<content hash>` when the build baked one, and bare when it did not. The three path is driven
 *  through the REAL `KTX2Loader` (its `init()` fetches the pair), because the version has to reach the
 *  loader through three's own `FileLoader` → `manager.resolveURL` seam, which a unit test of the
 *  modifier alone cannot prove. The build half is `engine/tests/plugins/transcoders.test.ts`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  basisTranscoderUrlModifier, pixiKtxTranscoderUrls,
} from '../../packages/modoki/src/runtime/loaders/transcoderUrls';

describe('pixiKtxTranscoderUrls', () => {
  it('appends the version to BOTH urls', () => {
    const { jsUrl, wasmUrl } = pixiKtxTranscoderUrls('abc123');
    expect(jsUrl).toMatch(/\/pixi-ktx\/libktx\.js\?v=abc123$/);
    expect(wasmUrl).toMatch(/\/pixi-ktx\/libktx\.wasm\?v=abc123$/);
  });

  it('leaves them bare with no version (editor, dev, playable)', () => {
    const { jsUrl, wasmUrl } = pixiKtxTranscoderUrls('');
    expect(jsUrl).toMatch(/\/pixi-ktx\/libktx\.js$/);
    expect(wasmUrl).toMatch(/\/pixi-ktx\/libktx\.wasm$/);
  });
});

describe('basisTranscoderUrlModifier', () => {
  it('touches only the two transcoder names', () => {
    const modify = basisTranscoderUrlModifier('abc123')!;
    expect(modify('/game/basis/basis_transcoder.js')).toBe('/game/basis/basis_transcoder.js?v=abc123');
    expect(modify('/game/basis/basis_transcoder.wasm')).toBe('/game/basis/basis_transcoder.wasm?v=abc123');
    expect(modify('/game/textures/wood~uastc.ktx2?v=ff')).toBe('/game/textures/wood~uastc.ktx2?v=ff');
  });

  it('is absent with no version, so the loader keeps three\'s default manager', () => {
    expect(basisTranscoderUrlModifier('')).toBeUndefined();
  });
});

// Every test above passes the version explicitly. These drive the DEFAULT argument — the baked
// `__MODOKI_TRANSCODER_VERSIONS__` — so swapping the two pairs' defaults (a three-only bump would then
// leave the Basis `?v=` unchanged) or dropping the missing-define fallback goes red.
describe('the default version is the baked define, per pair', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('each helper reads ITS OWN pair from the define', async () => {
    vi.stubGlobal('__MODOKI_TRANSCODER_VERSIONS__', { basis: 'b1', pixiKtx: 'p1' });
    vi.resetModules();
    const m = await import('../../packages/modoki/src/runtime/loaders/transcoderUrls');
    expect(m.pixiKtxTranscoderUrls().jsUrl).toMatch(/\?v=p1$/);
    expect(m.pixiKtxTranscoderUrls().wasmUrl).toMatch(/\?v=p1$/);
    expect(m.basisTranscoderUrlModifier()!('/basis/basis_transcoder.wasm')).toBe('/basis/basis_transcoder.wasm?v=b1');
  });

  it('a host with no define gets bare URLs, not a ReferenceError', async () => {
    vi.stubGlobal('__MODOKI_TRANSCODER_VERSIONS__', undefined);
    vi.resetModules();
    const m = await import('../../packages/modoki/src/runtime/loaders/transcoderUrls');
    expect(m.pixiKtxTranscoderUrls().jsUrl).toMatch(/\/pixi-ktx\/libktx\.js$/);
    expect(m.basisTranscoderUrlModifier()).toBeUndefined();
  });
});

describe('getKTX2Loader requests the Basis pair with the version (real KTX2Loader)', () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.resetModules();
    // three's FileLoader builds `new Request(url)` then `fetch(req)`. Node's Request rejects the
    // relative `/basis/…` URL, so record the URL at construction and fail the fetch — init() has
    // already issued both requests by then, which is all this asserts.
    vi.stubGlobal('Request', class { url: string; constructor(url: string) { this.url = url; } });
    vi.stubGlobal('fetch', vi.fn((req: { url: string }) => {
      requested.push(req.url);
      return Promise.reject(new Error('offline in test'));
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../packages/modoki/src/runtime/loaders/transcoderUrls');
  });

  async function initAndCollect(version: string): Promise<string[]> {
    vi.doMock('../../packages/modoki/src/runtime/loaders/transcoderUrls', async (orig) => {
      const real = await orig<typeof import('../../packages/modoki/src/runtime/loaders/transcoderUrls')>();
      return { ...real, basisTranscoderUrlModifier: () => real.basisTranscoderUrlModifier(version) };
    });
    const { getKTX2Loader } = await import('../../packages/modoki/src/runtime/loaders/textureResolver');
    const loader = await getKTX2Loader();
    await loader.init().catch(() => {});
    return requested.filter((u) => u.includes('basis_transcoder'));
  }

  it('appends ?v=<version> to both files', async () => {
    const urls = await initAndCollect('abc123');
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => /\/basis\/basis_transcoder\.js\?v=abc123$/.test(u))).toBe(true);
    expect(urls.some((u) => /\/basis\/basis_transcoder\.wasm\?v=abc123$/.test(u))).toBe(true);
  });

  it('requests them bare with no version', async () => {
    const urls = await initAndCollect('');
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => /\/basis\/basis_transcoder\.(js|wasm)$/.test(u))).toBe(true);
  });
});
