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

    const pA = cache.acquireAudio(1, 'clipA.wav'); // in flight

    cache.invalidateAudio('clipA.wav'); // same key — must supersede this in-flight decode

    const staleBuf = {} as AudioBuffer;
    resolveDecode('clipA.wav', staleBuf);
    await pA;

    expect(cache.getCachedAudioBuffer('clipA.wav')).toBeUndefined();
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
