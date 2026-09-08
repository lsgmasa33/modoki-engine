/** VideoCache orchestration — download, admission, eviction, index reconciliation.
 *  Uses an in-memory backend so these exercise the REAL orchestrator rather than a
 *  mock of it; only the byte storage is faked. */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { VideoCache, type CacheBackend } from '../../src/runtime/video/videoCache';

const MB = 1024 * 1024;

class FakeBackend implements CacheBackend {
  store = new Map<string, Blob>();
  writes = 0;
  deletes: string[] = [];
  /** Keys whose `delete` should reject instead of succeeding — models an I/O error or
   *  an entry being evicted out from under us mid-clear. */
  failDelete = new Set<string>();
  async keys() { return [...this.store.keys()]; }
  async urlFor(key: string) { return this.store.has(key) ? `blob:fake/${key}` : undefined; }
  async sizeOf(key: string) { return this.store.get(key)?.size; }
  async write(key: string, data: Blob) { this.writes++; this.store.set(key, data); }
  async delete(key: string) {
    if (this.failDelete.has(key)) throw new Error(`fake delete failure: ${key}`);
    this.deletes.push(key);
    this.store.delete(key);
  }
}

/** A localStorage stand-in. */
const memStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    _map: m,
  };
};

const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });

/** Mock fetch returning a body of `bytes`, optionally lying about content-length. */
function mockFetch(bytes: number, opts: { declared?: number | null; ok?: boolean; status?: number } = {}) {
  const declared = opts.declared === undefined ? bytes : opts.declared;
  const headers = new Headers({ 'content-type': 'video/mp4' });
  if (declared !== null) headers.set('content-length', String(declared));
  return vi.fn(async () => new Response(opts.ok === false ? null : blobOf(bytes), {
    status: opts.status ?? (opts.ok === false ? 404 : 200),
    headers,
  }));
}

let backend: FakeBackend;
beforeEach(() => { backend = new FakeBackend(); });
afterEach(() => { vi.restoreAllMocks(); });

const makeCache = (budgetMB: number) => new VideoCache({
  backend, budgetBytes: budgetMB * MB, storage: memStorage(),
});

describe('fetchAndStore', () => {
  it('downloads, stores, and returns a local URL', async () => {
    vi.stubGlobal('fetch', mockFetch(5 * MB));
    const c = makeCache(100);
    const url = await c.fetchAndStore('k1', 'https://cdn/x.mp4');
    expect(url).toBe('blob:fake/k1');
    expect(c.usedBytes()).toBe(5 * MB);
  });

  it('returns the cached copy without re-downloading', async () => {
    const f = mockFetch(5 * MB);
    vi.stubGlobal('fetch', f);
    const c = makeCache(100);
    await c.fetchAndStore('k1', 'https://cdn/x.mp4');
    await c.fetchAndStore('k1', 'https://cdn/x.mp4');
    expect(f).toHaveBeenCalledTimes(1);
    expect(backend.writes).toBe(1);
  });

  it('shares ONE download between concurrent callers', async () => {
    // Two entities using the same clip must not race two downloads of it.
    const f = mockFetch(5 * MB);
    vi.stubGlobal('fetch', f);
    const c = makeCache(100);
    const [a, b] = await Promise.all([
      c.fetchAndStore('k1', 'https://cdn/x.mp4'),
      c.fetchAndStore('k1', 'https://cdn/x.mp4'),
    ]);
    expect(a).toBe(b);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reports progress while downloading', async () => {
    vi.stubGlobal('fetch', mockFetch(3 * MB));
    const c = makeCache(100);
    const seen: number[] = [];
    await c.fetchAndStore('k1', 'https://cdn/x.mp4', (p) => seen.push(p.receivedBytes));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(3 * MB);
  });

  it('throws on a failed download', async () => {
    vi.stubGlobal('fetch', mockFetch(0, { ok: false, status: 404 }));
    const c = makeCache(100);
    await expect(c.fetchAndStore('k1', 'https://cdn/missing.mp4')).rejects.toThrow(/404/);
  });

  it('refuses BEFORE downloading when the declared size cannot fit', async () => {
    // Downloading megabytes only to discard them is the worst possible ordering.
    const f = vi.fn(async () => new Response(blobOf(1), {
      status: 200, headers: new Headers({ 'content-length': String(500 * MB) }),
    }));
    vi.stubGlobal('fetch', f);
    const c = makeCache(100);
    await expect(c.fetchAndStore('big', 'https://cdn/big.mp4')).rejects.toThrow(/never be cached/);
    expect(backend.writes).toBe(0);
  });

  it('still refuses when the server LIED about content-length', async () => {
    // Declared small, actually huge — the re-plan against the real size is what
    // catches this, and it must, or the budget is merely advisory.
    vi.stubGlobal('fetch', mockFetch(200 * MB, { declared: 1 * MB }));
    const c = makeCache(100);
    await expect(c.fetchAndStore('liar', 'https://cdn/liar.mp4')).rejects.toThrow(/never be cached/);
    expect(backend.writes).toBe(0);
  });

  it('handles a missing content-length by planning on the actual size', async () => {
    vi.stubGlobal('fetch', mockFetch(5 * MB, { declared: null }));
    const c = makeCache(100);
    await expect(c.fetchAndStore('k1', 'https://cdn/x.mp4')).resolves.toBe('blob:fake/k1');
  });

  it('evicts LRU to make room', async () => {
    vi.stubGlobal('fetch', mockFetch(40 * MB));
    const c = makeCache(100);
    await c.fetchAndStore('a', 'https://cdn/a.mp4');
    await c.fetchAndStore('b', 'https://cdn/b.mp4');
    await c.get('a');                       // touch 'a' so 'b' is now the stale one
    await c.fetchAndStore('cc', 'https://cdn/c.mp4');
    expect(backend.deletes).toEqual(['b']);
    expect(backend.store.has('a')).toBe(true);
    expect(backend.store.has('cc')).toBe(true);
  });

  it('never evicts a pinned clip', async () => {
    vi.stubGlobal('fetch', mockFetch(40 * MB));
    const c = makeCache(100);
    await c.fetchAndStore('a', 'https://cdn/a.mp4');
    c.setPinned('a', true);
    await c.fetchAndStore('b', 'https://cdn/b.mp4');
    await c.fetchAndStore('cc', 'https://cdn/c.mp4');
    expect(backend.deletes).not.toContain('a');
    expect(backend.store.has('a')).toBe(true);
  });
});

describe('doFetch eviction failure (#429 second pass)', () => {
  // Regression: a rejection partway through the eviction loop used to propagate before
  // saveIndex() ran, so a victim already deleted from the backend AND the in-memory
  // index stayed claimed by the PERSISTED index — a ghost that reappears on reload and
  // inflates usedBytes() past what's actually on disk.
  it('persists the index when eviction fails partway through, leaving no ghost entry', async () => {
    const storage = memStorage();
    vi.stubGlobal('fetch', mockFetch(30 * MB));
    const c = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    await c.fetchAndStore('a', 'https://cdn/a.mp4');
    await c.fetchAndStore('b', 'https://cdn/b.mp4');
    await c.fetchAndStore('cc', 'https://cdn/c.mp4');

    backend.failDelete.add('b');
    vi.stubGlobal('fetch', mockFetch(60 * MB));
    // Evicting 'a' then 'b' is required to fit 'd'; 'b' rejects mid-loop.
    await expect(c.fetchAndStore('d', 'https://cdn/d.mp4')).rejects.toThrow();

    expect(backend.store.has('a')).toBe(false); // actually evicted before the failure
    expect(backend.store.has('b')).toBe(true);  // delete rejected — still there

    const inMemoryKeys = c.entries().map((e) => e.key).sort();
    expect(inMemoryKeys).toEqual(['b', 'cc']); // no ghost 'a' in memory

    const persisted = JSON.parse(storage._map.get('modoki.videoCache.index.v1')!) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(inMemoryKeys); // and none persisted either

    // The real harm this pins: a fresh instance over the SAME persisted storage must
    // not over-report usage — a ghost 'a' would have inflated it by 30 MB and made
    // planAdmission refuse a download that actually fits.
    const c2 = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    expect(c2.usedBytes()).toBe(backend.store.get('b')!.size + backend.store.get('cc')!.size);
  });
});

describe('get() drops a stale index entry', () => {
  // Regression: get() deleted the in-memory entry for a key the backend no longer has,
  // but never persisted the drop — so the ghost survived in storage and reappeared on
  // the next loadIndex().
  it('persists the drop, so a fresh instance over the same storage does not resurrect it', async () => {
    const storage = memStorage();
    vi.stubGlobal('fetch', mockFetch(5 * MB));
    const c = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    await c.fetchAndStore('k1', 'https://cdn/x.mp4');

    backend.store.delete('k1'); // the backend loses it without telling the cache
    expect(await c.get('k1')).toBeUndefined();
    expect(c.entries()).toHaveLength(0);

    const persisted = JSON.parse(storage._map.get('modoki.videoCache.index.v1')!) as Record<string, unknown>;
    expect(Object.keys(persisted)).toHaveLength(0);

    const c2 = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    expect(c2.entries()).toHaveLength(0);
  });
});

describe('reconcile', () => {
  it('drops index entries whose bytes the browser evicted behind our back', async () => {
    // Storage can be reclaimed at any time without telling us. A stale index would
    // otherwise make the cache believe it is full of clips that no longer exist.
    vi.stubGlobal('fetch', mockFetch(10 * MB));
    const c = makeCache(100);
    await c.fetchAndStore('gone', 'https://cdn/x.mp4');
    expect(c.usedBytes()).toBe(10 * MB);

    backend.store.delete('gone');           // simulate the browser reclaiming it
    await c.reconcile();
    expect(c.usedBytes()).toBe(0);
    expect(c.entries()).toHaveLength(0);
  });

  it('adopts orphan bytes as evict-me-first rather than deleting them', async () => {
    backend.store.set('orphan', blobOf(1 * MB));
    const c = makeCache(100);
    await c.reconcile();
    const e = c.entries().find((x) => x.key === 'orphan');
    expect(e).toBeDefined();
    expect(e!.lastUsed).toBe(0);            // oldest possible → first to go
    expect(backend.store.has('orphan')).toBe(true); // but NOT thrown away
    // MEASURED, not zero: adopting at 0 would under-report the budget, and this path
    // is reachable whenever the index is lost while the bytes survive.
    expect(e!.bytes).toBe(1 * MB);
    expect(c.usedBytes()).toBe(1 * MB);
  });
});

describe('index persistence', () => {
  it('survives a reload, and restored entries do not out-rank fresh ones', async () => {
    const storage = memStorage();
    vi.stubGlobal('fetch', mockFetch(10 * MB));
    const c1 = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    await c1.fetchAndStore('old', 'https://cdn/a.mp4');

    // New session, same storage + backend.
    const c2 = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    expect(c2.usedBytes()).toBe(10 * MB);

    await c2.fetchAndStore('fresh', 'https://cdn/b.mp4');
    const entries = c2.entries();
    const old = entries.find((e) => e.key === 'old')!;
    const fresh = entries.find((e) => e.key === 'fresh')!;
    // Regression: a fresh session's counter used to restart at 0, making every NEW
    // entry look older than every restored one — so new clips were evicted first.
    expect(fresh.lastUsed).toBeGreaterThan(old.lastUsed);
  });

  it('starts empty on a corrupt index rather than throwing', () => {
    const storage = memStorage();
    storage.setItem('modoki.videoCache.index.v1', '{not json');
    expect(() => new VideoCache({ backend, budgetBytes: 100 * MB, storage })).not.toThrow();
  });
});

describe('delete / clear', () => {
  it('removes a single entry', async () => {
    vi.stubGlobal('fetch', mockFetch(5 * MB));
    const c = makeCache(100);
    await c.fetchAndStore('k1', 'https://cdn/x.mp4');
    await c.delete('k1');
    expect(c.usedBytes()).toBe(0);
    expect(backend.store.has('k1')).toBe(false);
  });

  it('empties the cache', async () => {
    vi.stubGlobal('fetch', mockFetch(5 * MB));
    const c = makeCache(100);
    await c.fetchAndStore('a', 'https://cdn/a.mp4');
    await c.fetchAndStore('b', 'https://cdn/b.mp4');
    await c.clear();
    expect(c.usedBytes()).toBe(0);
    expect(backend.store.size).toBe(0);
  });

  describe('clear() with a failing delete', () => {
    // Regression for #429: an uncaught throw used to abort clear() before
    // index.clear()/saveIndex() ran, so every key deleted BEFORE the throw was gone
    // from the backend but still claimed by the (unpersisted) index.
    const setUpThreeEntries = async (storage: ReturnType<typeof memStorage>) => {
      vi.stubGlobal('fetch', mockFetch(5 * MB));
      const c = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
      await c.fetchAndStore('a', 'https://cdn/a.mp4');
      await c.fetchAndStore('b', 'https://cdn/b.mp4');
      await c.fetchAndStore('cc', 'https://cdn/c.mp4');
      return c;
    };

    it('deletes every OTHER key and rejects, leaving the failing key genuinely still cached', async () => {
      const storage = memStorage();
      const c = await setUpThreeEntries(storage);
      backend.failDelete.add('b');

      // Matches the aggregate message specifically — a bare /b/ would also match the
      // fake's own `fake delete failure: b`, so it doesn't by itself prove the
      // aggregate error (with the failed-count prefix) is what's actually thrown.
      await expect(c.clear()).rejects.toThrow(/video cache clear: failed to delete 1 entry: b/);

      expect(backend.store.has('a')).toBe(false);
      expect(backend.store.has('cc')).toBe(false);
      expect(backend.store.has('b')).toBe(true); // still in the backend → index keeping it is correct

      const keys = c.entries().map((e) => e.key);
      expect(keys).toEqual(['b']);

      // The persisted index must match the in-memory one — this is the bug: the old
      // code never reached saveIndex() after the throw.
      const persisted = JSON.parse(storage._map.get('modoki.videoCache.index.v1')!) as Record<string, unknown>;
      expect(Object.keys(persisted)).toEqual(['b']);
    });

    it('all deletes succeeding empties both the index and the persisted index', async () => {
      const storage = memStorage();
      const c = await setUpThreeEntries(storage);

      await expect(c.clear()).resolves.toBeUndefined();

      expect(c.entries()).toHaveLength(0);
      expect(backend.store.size).toBe(0);
      const persisted = JSON.parse(storage._map.get('modoki.videoCache.index.v1')!) as Record<string, unknown>;
      expect(Object.keys(persisted)).toHaveLength(0);
    });

    it('a failure on the FIRST key does not stop the rest from being cleared', async () => {
      const storage = memStorage();
      const c = await setUpThreeEntries(storage);
      backend.failDelete.add('a');

      await expect(c.clear()).rejects.toThrow();

      expect(backend.store.has('b')).toBe(false);
      expect(backend.store.has('cc')).toBe(false);
      expect(c.entries().map((e) => e.key)).toEqual(['a']);
    });

    it('entries()/usedBytes() after a partial clear report only what actually remains', async () => {
      const storage = memStorage();
      const c = await setUpThreeEntries(storage);
      backend.failDelete.add('cc');

      await expect(c.clear()).rejects.toThrow();

      expect(c.usedBytes()).toBe(5 * MB); // only 'cc' remains
      expect(c.entries()).toHaveLength(1);
      expect(c.entries()[0].key).toBe('cc');
    });

    it('the aggregated error carries the first underlying failure as cause, and caps the inlined key list', async () => {
      const storage = memStorage();
      vi.stubGlobal('fetch', mockFetch(1 * MB));
      const c = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
      const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
      for (const k of keys) await c.fetchAndStore(k, `https://cdn/${k}.mp4`);
      for (const k of keys) backend.failDelete.add(k);

      let caught: unknown;
      try {
        await c.clear();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error;
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).message).toMatch(/fake delete failure/);
      // 7 failures, only the first 5 inlined, the rest folded into a count.
      expect(err.message).toContain('failed to delete 7 entries');
      expect(err.message).toContain('(+2 more)');
      for (const k of keys.slice(0, 5)) expect(err.message).toContain(k);
      for (const k of keys.slice(5)) expect(err.message).not.toContain(k);
    });
  });
});

/** A `clear()` landing mid-download must not leave the entry behind (#573).
 *
 *  `doFetch` awaits three times — the fetch, the body read, and `backend.write` — and only then
 *  seats `index` and PERSISTS it. "Clear the video cache" is a user-facing storage action, so the
 *  window is entirely ordinary: a download in flight while someone frees space. Without the guard
 *  the clear reports success and the entry reappears in both the backend and the saved index,
 *  surviving a reload — the one thing the user explicitly asked to be rid of.
 */
/** `delete(key)` landing mid-download must stale THAT key and nothing else (#573).
 *
 *  The per-key twin of the `clear()` case below. Two things are pinned, and the second is a
 *  regression the first version of this guard introduced:
 *   - the deleted key's download does not re-seat the entry the user just removed;
 *   - an UNRELATED key's download is untouched — which is the whole reason `invalidateKey` exists
 *     rather than `invalidateAll`. ⚠️ Both downloads are gated here on purpose: an earlier version
 *     gated only the doomed one, and the survivor finished BEFORE the delete even ran, so the
 *     assertion passed just as happily with `invalidateAll()` in place of `invalidateKey()`.
 *   - and a fresh request for the deleted key starts a NEW download rather than coalescing onto
 *     the staled one — staling without dropping the `inFlight` entry turned the next
 *     `fetchAndStore` into a permanent cache miss.
 */
describe('VideoCache — a delete(key) during a download of that key', () => {
  it('stales only that key, and a later request re-downloads it', async () => {
    const backend = new FakeBackend();
    const cache = new VideoCache({ backend, budgetBytes: 100 * MB, storage: memStorage() });
    vi.stubGlobal('fetch', mockFetch(1 * MB));

    // BOTH writes gated, so neither can quietly finish before the delete lands.
    let releaseWrites: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseWrites = r; });
    const realWrite = backend.write.bind(backend);
    backend.write = async (k: string, d: Blob) => { await gate; await realWrite(k, d); };

    const doomed = cache.fetchAndStore('gone', 'https://example.test/gone.mp4');
    const survivor = cache.fetchAndStore('kept', 'https://example.test/kept.mp4');
    await new Promise((r) => setTimeout(r, 0)); // both downloads now parked in write
    await cache.delete('gone');
    releaseWrites();

    expect(await doomed).toBeUndefined();
    expect(await survivor, 'an unrelated key must be untouched by invalidateKey').toBeDefined();
    expect(cache.entries().map((e) => e.key)).toEqual(['kept']);

    // The regression: the staled job must not be left registered for the next caller to inherit.
    backend.write = realWrite;
    const retry = await cache.fetchAndStore('gone', 'https://example.test/gone.mp4');
    expect(retry, 'a request after the delete starts a FRESH download').toBeDefined();
  });
});

describe('VideoCache — a clear() during a download', () => {
  it('does not re-seat the downloaded entry after the cache was cleared', async () => {
    const backend = new FakeBackend();
    const storage = memStorage();
    const cache = new VideoCache({ backend, budgetBytes: 100 * MB, storage });
    vi.stubGlobal('fetch', mockFetch(1 * MB));

    // Hold the download inside its final await, which is where the real window lives.
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((r) => { releaseWrite = r; });
    const realWrite = backend.write.bind(backend);
    backend.write = async (k: string, d: Blob) => { await writeGate; await realWrite(k, d); };

    const job = cache.fetchAndStore('clip', 'https://example.test/clip.mp4');
    // Let the download actually GET in flight — `fetchAndStore` awaits a cache lookup before
    // `doFetch` even starts, so clearing immediately would land before the download captured its
    // token and prove nothing. The real cadence is a clear arriving during a live download.
    await new Promise((r) => setTimeout(r, 0));
    await cache.clear();   // the user frees space while the download is still writing
    releaseWrite();
    const url = await job;

    expect(url).toBeUndefined();              // the caller is told there is no cached copy
    expect(cache.entries()).toEqual([]);      // …and the index agrees
    expect(backend.store.has('clip')).toBe(false); // …and the bytes are gone, not orphaned
    const persisted = JSON.parse(storage._map.get('modoki.videoCache.index.v1') ?? '{}') as Record<string, unknown>;
    expect(persisted).toEqual({});            // …and nothing survives a reload
  });
});
