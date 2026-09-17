/** audioBufferCache liveness tests (#856) — `invalidateAudio(path)` must supersede only that
 *  path's OWN in-flight decode, not an unrelated clip's. Before the fix, `invalidateAudio` called
 *  the shared `audioLiveness.invalidateAll()`, so re-importing clip A silently discarded clip B's
 *  concurrent in-flight fetch/decode — exactly the cross-asset supersession #856 is about. Mirrors
 *  the reference fix in `spriteMaterialCache.invalidateShader` (#852) and the sibling per-key tests
 *  for `fontLoader`/`fontAtlasLoader`.
 *
 *  `AudioContext` + `XMLHttpRequest` are faked so the decode step is independently controllable
 *  per path — a real `AudioContext` doesn't exist in this test environment anyway (headless), so
 *  without the fake, `getAudioContext()` returns null and every load short-circuits before ever
 *  reaching the liveness guard this issue is about. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let xhrUrls: string[];
let bytesByUrl: Map<string, ArrayBuffer>;
let urlByBytes: Map<ArrayBuffer, string>;
// Decode gates keyed by URL (== path here — these tests use plain relative paths with no
// leading slash and no manifest hash, so `assetUrl`/`withCacheBust` are no-ops and the served
// URL is the path itself). "get-or-create" on BOTH sides (the decodeAudioData mock and
// `resolveDecode` below) so it doesn't matter which runs first.
let decodeGates: Map<string, Deferred<AudioBuffer>>;

function gateFor(url: string): Deferred<AudioBuffer> {
  let g = decodeGates.get(url);
  if (!g) { g = deferred<AudioBuffer>(); decodeGates.set(url, g); }
  return g;
}

/** Resolve the decode for a given path/URL with the given buffer. Safe to call before OR after
 *  the corresponding `decodeAudioData` call actually happens — both converge on the same gate. */
function resolveDecode(path: string, buffer: AudioBuffer): void {
  gateFor(path).resolve(buffer);
}

function installAudioMocks(): void {
  xhrUrls = [];
  bytesByUrl = new Map();
  urlByBytes = new Map();
  decodeGates = new Map();

  class FakeXHR {
    url = '';
    responseType = '';
    status = 200;
    response: ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string): void { this.url = url; }
    send(): void {
      xhrUrls.push(this.url);
      let buf = bytesByUrl.get(this.url);
      if (!buf) {
        buf = new ArrayBuffer(8); // non-empty — xhrAudioBytes rejects an empty response
        bytesByUrl.set(this.url, buf);
        urlByBytes.set(buf, this.url);
      }
      this.response = buf;
      queueMicrotask(() => this.onload?.());
    }
  }
  (globalThis as any).XMLHttpRequest = FakeXHR;

  const decodeAudioData = vi.fn((bytes: ArrayBuffer) => {
    const url = urlByBytes.get(bytes);
    if (!url) return Promise.reject(new Error('decodeAudioData called with untracked bytes'));
    return gateFor(url).promise;
  });
  const fakeCtx = { state: 'running', sampleRate: 44100, decodeAudioData };

  vi.doMock('../../src/runtime/audio/audioContext', () => ({
    getAudioContext: () => fakeCtx,
  }));
}

async function getCache() {
  return import('../../src/runtime/loaders/audioBufferCache');
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('audioBufferCache liveness (#856 per-key)', () => {
  it('invalidating clip A does not discard clip B\'s unrelated in-flight decode', async () => {
    installAudioMocks();
    const cache = await getCache();

    const pA = cache.acquireAudio(1, 'clipA.wav'); // in flight
    const pB = cache.acquireAudio(1, 'clipB.wav'); // in flight, concurrently

    cache.invalidateAudio('clipA.wav'); // must supersede ONLY clipA's in-flight decode

    const bufB = {} as AudioBuffer;
    resolveDecode('clipB.wav', bufB);
    await pB;

    // clipB was never invalidated — its own decode lands normally.
    expect(cache.getCachedAudioBuffer('clipB.wav')).toBe(bufB);

    // Let clipA settle too so nothing is left hanging.
    resolveDecode('clipA.wav', {} as AudioBuffer);
    await pA;
  });

  it('invalidating clip A still discards its OWN in-flight decode', async () => {
    installAudioMocks();
    const cache = await getCache();

    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const guid = manifest.newGuid();
    manifest.registerAsset(guid, 'clipA.wav', 'audio', undefined, { audio: { ext: 'mp3' } }, 'old');
    const pA = cache.acquireAudio(1, guid); // in flight
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(1));

    // A new hash, so the #1361 refill fetches a DIFFERENT url whose decode this test never settles.
    manifest.registerAsset(guid, 'clipA.wav', 'audio', undefined, { audio: { ext: 'mp3' } }, 'new');
    cache.invalidateAudio('clipA.wav'); // same key — must supersede this in-flight decode

    const staleBuf = {} as AudioBuffer;
    resolveDecode(xhrUrls[0], staleBuf);
    await pA;

    expect(cache.getCachedAudioBuffer(guid)).toBeUndefined();
  });

  it('full teardown (disposeAllAudioBuffers) still supersedes every outstanding decode', async () => {
    installAudioMocks();
    const cache = await getCache();

    const pB = cache.acquireAudio(1, 'clipB.wav'); // in flight

    cache.disposeAllAudioBuffers();

    const buf = {} as AudioBuffer;
    resolveDecode('clipB.wav', buf);
    await pB;

    expect(cache.getCachedAudioBuffer('clipB.wav')).toBeUndefined();
  });
});

/** #1361 — `invalidateAudio` refills an OWNED buffer clip itself. A miss is read-only for the
 *  audio system and the only other refill runs from `resume()` on user input, so an evicted owned
 *  clip used to stay silent until a click or a scene reload. No test here calls `resume()` or
 *  `retryFailedAudioDecodes`. */
describe('audioBufferCache invalidation refill (#1361)', () => {
  type Manifest = typeof import('../../src/runtime/loaders/assetManifest');
  const register = (m: Manifest, guid: string, audio: { ext?: string; loadType: 'buffer' | 'stream' }, hash?: string) =>
    m.registerAsset(guid, 'clipA.wav', 'audio', undefined, { audio }, hash);

  it('an owned buffer clip is cached again with the NEW bytes, fetched at the new manifest hash', async () => {
    installAudioMocks();
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const cache = await getCache();
    const guid = manifest.newGuid();
    register(manifest, guid, { ext: 'mp3', loadType: 'buffer' }, 'h1');

    const oldBuf = {} as AudioBuffer;
    const acquired = cache.acquireAudio(1, guid);
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(1));
    expect(xhrUrls[0]).toContain('~audio.mp3?v=h1');
    resolveDecode(xhrUrls[0], oldBuf);
    await acquired;
    expect(cache.getCachedAudioBuffer(guid)).toBe(oldBuf);

    // The reimport's manifest update lands first, then the invalidation (the route's order).
    register(manifest, guid, { ext: 'mp3', loadType: 'buffer' }, 'h2');
    cache.invalidateAudio('clipA.wav');
    expect(cache.getCachedAudioBuffer(guid)).toBeUndefined();
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(2));
    expect(xhrUrls[1]).toContain('~audio.mp3?v=h2');

    const newBuf = {} as AudioBuffer;
    resolveDecode(xhrUrls[1], newBuf);
    await vi.waitFor(() => expect(cache.getCachedAudioBuffer(guid)).toBe(newBuf));
  });

  it('a superseded load settling does not drop the refill\'s in-flight entry — no third fetch', async () => {
    installAudioMocks();
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const cache = await getCache();
    const guid = manifest.newGuid();
    register(manifest, guid, { ext: 'mp3', loadType: 'buffer' }, 'h1');
    const pA = cache.acquireAudio(1, guid); // load A in flight
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(1));

    register(manifest, guid, { ext: 'mp3', loadType: 'buffer' }, 'h2');
    cache.invalidateAudio('clipA.wav'); // refill B in flight
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(2));
    resolveDecode(xhrUrls[0], {} as AudioBuffer); // A settles, superseded
    await pA;

    cache.retryFailedAudioDecodes(); // B is still in flight — must not start another
    await new Promise((r) => setTimeout(r, 0));
    expect(xhrUrls).toHaveLength(2);
    const buf = {} as AudioBuffer;
    resolveDecode(xhrUrls[1], buf);
    await vi.waitFor(() => expect(cache.getCachedAudioBuffer(guid)).toBe(buf));
  });

  it('the server op then the panel call (back-to-back invalidations) still end cached', async () => {
    installAudioMocks();
    const cache = await getCache();
    resolveDecode('clipA.wav', {} as AudioBuffer);
    await cache.acquireAudio(1, 'clipA.wav');
    // The URL is unchanged here, so every decode shares one resolved gate.
    cache.invalidateAudio('clipA.wav');
    cache.invalidateAudio('clipA.wav');
    await vi.waitFor(() => expect(cache.getCachedAudioBuffer('clipA.wav')).toBeDefined());
    // …and once more after the first refill has landed.
    cache.invalidateAudio('clipA.wav');
    expect(cache.getCachedAudioBuffer('clipA.wav')).toBeUndefined();
    await vi.waitFor(() => expect(cache.getCachedAudioBuffer('clipA.wav')).toBeDefined());
  });

  it('a clip no scene owns stays evicted — nothing is fetched', async () => {
    installAudioMocks();
    const cache = await getCache();
    resolveDecode('clipA.wav', {} as AudioBuffer);
    await cache.acquireAudio(1, 'clipA.wav');
    cache.releaseAudioForScene(1);

    cache.invalidateAudio('clipA.wav');
    await new Promise((r) => setTimeout(r, 0));
    expect(xhrUrls).toEqual(['clipA.wav']);
    expect(cache.getCachedAudioBuffer('clipA.wav')).toBeUndefined();
  });

  it('an owned clip the reimport switched to stream is not decoded', async () => {
    installAudioMocks();
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const cache = await getCache();
    const guid = manifest.newGuid();
    register(manifest, guid, { loadType: 'buffer' });
    const acquired = cache.acquireAudio(1, guid);
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(1));
    resolveDecode(xhrUrls[0], {} as AudioBuffer);
    await acquired;

    register(manifest, guid, { loadType: 'stream' });
    cache.invalidateAudio('clipA.wav');
    await new Promise((r) => setTimeout(r, 0));
    expect(xhrUrls).toHaveLength(1);
    expect(cache.getCachedAudioBuffer(guid)).toBeUndefined();
  });

  it('an owned clip the reimport switched from stream to buffer is decoded', async () => {
    installAudioMocks();
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const cache = await getCache();
    const guid = manifest.newGuid();
    register(manifest, guid, { loadType: 'stream' });
    await cache.acquireAudio(1, guid, 'stream');
    expect(xhrUrls).toEqual([]);

    register(manifest, guid, { loadType: 'buffer' });
    cache.invalidateAudio('clipA.wav');
    await vi.waitFor(() => expect(xhrUrls).toHaveLength(1));
    const buf = {} as AudioBuffer;
    resolveDecode(xhrUrls[0], buf);
    await vi.waitFor(() => expect(cache.getCachedAudioBuffer(guid)).toBe(buf));
  });
});
