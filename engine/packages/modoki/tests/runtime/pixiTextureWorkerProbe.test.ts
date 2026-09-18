/** #1404 — the worker-error probe in `pixiTextureLoad`. On iOS 16 WebKit a worker cannot
 *  structured-clone an `Error`, so Pixi's worker `postMessage({error})` throws, the failed texture
 *  load never settles, and the worker never returns to Pixi's pool. The shim asks the browser once,
 *  before the first texture load, and falls back to main-thread decode where the answer is no.
 *
 *  The fake Worker RUNS the shim's real probe source; only `postMessage` is faked, to behave like
 *  WebKit 16 (throws `DataCloneError` on an Error payload) or like a browser that clones errors. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const order: string[] = [];
const load = vi.fn((arg: unknown) => { order.push('load'); return Promise.resolve({ id: arg } as unknown); });
const setPreferences = vi.fn((p: unknown) => { order.push(`prefs:${JSON.stringify(p)}`); });
const cacheMap = new Map<string, unknown>();
const cache = { has: (k: string) => cacheMap.has(k), get: (k: string) => cacheMap.get(k), remove: (k: string) => cacheMap.delete(k) };
vi.mock('pixi.js', () => ({
  Assets: { load, setPreferences, cache },
  ImageSource: class {},
  Texture: class {},
}));

type Mode = 'clones' | 'webkit16' | 'silent' | 'crash';
let created: FakeWorker[] = [];
let mode: Mode = 'clones';

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  constructor(_url: string) {
    created.push(this);
    queueMicrotask(() => this.run());
  }
  private run(): void {
    if (mode === 'crash') { this.onerror?.({}); return; }
    if (mode === 'silent') return;
    const postMessage = (data: Record<string, unknown>) => {
      if (mode === 'webkit16' && Object.values(data).some((v) => v instanceof Error)) {
        throw new DOMException('The object can not be cloned.', 'DataCloneError');
      }
      queueMicrotask(() => this.onmessage?.({ data }));
    };
    new Function('postMessage', src)(postMessage);
  }
  terminate(): void { this.terminated = true; }
}

let src = '';
async function freshShim() {
  vi.resetModules();
  const mod = await import('../../src/runtime/rendering/pixiTextureLoad');
  const errors = await import('../../src/runtime/core/assetLoadErrors');
  src = mod.WORKER_ERROR_PROBE_SRC;
  return { ...mod, ...errors };
}

beforeEach(() => {
  load.mockClear(); setPreferences.mockClear(); order.length = 0; created = []; cacheMap.clear();
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('pixiTextureLoad — worker-error probe (#1404)', () => {
  it('iOS 16 WebKit (Error not cloneable): disables Pixi workers BEFORE the first load', async () => {
    mode = 'webkit16';
    const { loadPixiTexture } = await freshShim();
    await loadPixiTexture('/assets/a.webp');
    expect(order).toEqual(['prefs:{"preferWorkers":false}', 'load']);
    expect(created[0].terminated).toBe(true);
  });

  it('a browser that clones Errors keeps its workers', async () => {
    mode = 'clones';
    const { loadPixiTexture } = await freshShim();
    await loadPixiTexture('/assets/a.webp');
    expect(setPreferences).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(created[0].terminated).toBe(true);
  });

  it('a worker that never answers counts as unable to report failures (after the bound)', async () => {
    vi.useFakeTimers();
    mode = 'silent';
    const { loadPixiTexture } = await freshShim();
    const p = loadPixiTexture('/assets/a.webp');
    await vi.advanceTimersByTimeAsync(1999);
    expect(load, 'held until the verdict').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['prefs:{"preferWorkers":false}', 'load']);
  });

  it('a worker that errors on start counts as unable too', async () => {
    mode = 'crash';
    const { loadPixiTexture } = await freshShim();
    await loadPixiTexture('/assets/a.webp');
    expect(order).toEqual(['prefs:{"preferWorkers":false}', 'load']);
  });

  it('concurrent first loads share ONE probe, and loads after the verdict go straight through', async () => {
    mode = 'webkit16';
    const { loadPixiTexture } = await freshShim();
    const first = [loadPixiTexture('/assets/a.webp'), loadPixiTexture('/assets/b.webp')];
    expect(load, 'nothing reaches Pixi mid-probe').not.toHaveBeenCalled();
    await Promise.all(first);
    expect(created).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
    void loadPixiTexture('/assets/c.webp');
    expect(load, 'synchronous once settled').toHaveBeenCalledTimes(3);
    expect(setPreferences).toHaveBeenCalledTimes(1);
  });

  it('no Worker global (Node, worker-less hosts): no probe, the load is synchronous', async () => {
    vi.unstubAllGlobals();
    const { loadPixiTexture } = await freshShim();
    void loadPixiTexture('/assets/a.webp');
    expect(load).toHaveBeenCalledTimes(1);
    expect(setPreferences).not.toHaveBeenCalled();
  });
});

// Pixi decodes KTX2 on its own worker with no main-thread path, and that worker posts `{err}` the
// same way, so `preferWorkers:false` cannot reach it. Where errors cannot cross, the shim checks a
// KTX2 on the main thread first, and a missing file rejects with a classified error.
describe('pixiTextureLoad — KTX2 main-thread check where worker errors are lost (#1404)', () => {
  const cancel = vi.fn(() => Promise.resolve());
  const respond = (status: number) => ({ ok: status >= 200 && status < 300, status, statusText: '', headers: new Headers({ 'content-type': 'application/octet-stream' }), body: { cancel } });
  beforeEach(() => cancel.mockClear());

  it('a KTX2 whose fetch REJECTS never reaches Pixi, and rejects as a network failure', async () => {
    mode = 'webkit16';
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Load failed')));
    vi.stubGlobal('fetch', fetchMock);
    const { loadPixiTexture, AssetNetworkError } = await freshShim();
    await expect(loadPixiTexture('/assets/gone.ktx2')).rejects.toBeInstanceOf(AssetNetworkError);
    expect(fetchMock).toHaveBeenCalledWith('/assets/gone.ktx2');
    expect(load).not.toHaveBeenCalled();
  });

  it('a KTX2 answering 404 rejects as an ABSENT missing asset, without reaching Pixi', async () => {
    mode = 'webkit16';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(404))));
    const { loadPixiTexture, MissingAssetError } = await freshShim();
    const e = await loadPixiTexture('/assets/gone.ktx2?v=3').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MissingAssetError);
    expect((e as { absent?: boolean }).absent).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it('a KTX2 that answers goes on to Pixi, its checked body cancelled unread', async () => {
    mode = 'webkit16';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(200))));
    const { loadPixiTexture } = await freshShim();
    await loadPixiTexture('/assets/here.ktx2');
    expect(load).toHaveBeenCalledWith('/assets/here.ktx2');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('no check where errors DO cross, and none for a PNG where they do not', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(respond(200)));
    vi.stubGlobal('fetch', fetchMock);
    mode = 'clones';
    await (await freshShim()).loadPixiTexture('/assets/a.ktx2');
    vi.stubGlobal('Worker', FakeWorker); // freshShim's module state is new; the stubs persist
    mode = 'webkit16';
    await (await freshShim()).loadPixiTexture('/assets/a.png');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a LIVE cached KTX2 skips the check — no request, and no offline failure', async () => {
    mode = 'webkit16';
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('offline')));
    vi.stubGlobal('fetch', fetchMock);
    const { loadPixiTexture } = await freshShim();
    await loadPixiTexture('/assets/warm.webp'); // settle the probe first
    cacheMap.set('/assets/cached.ktx2', { source: {} });
    await expect(loadPixiTexture('/assets/cached.ktx2')).resolves.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('concurrent callers for one KTX2 share ONE check', async () => {
    mode = 'webkit16';
    const fetchMock = vi.fn(() => Promise.resolve(respond(200)));
    vi.stubGlobal('fetch', fetchMock);
    const { loadPixiTexture } = await freshShim();
    await loadPixiTexture('/assets/warm.webp');
    await Promise.all([1, 2, 3].map(() => loadPixiTexture('/assets/shared.ktx2')));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('/assets/shared.ktx2');
    await loadPixiTexture('/assets/shared.ktx2'); // settled: a later call checks afresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
