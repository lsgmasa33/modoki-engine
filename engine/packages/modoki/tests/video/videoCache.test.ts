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
  async keys() { return [...this.store.keys()]; }
  async urlFor(key: string) { return this.store.has(key) ? `blob:fake/${key}` : undefined; }
  async sizeOf(key: string) { return this.store.get(key)?.size; }
  async write(key: string, data: Blob) { this.writes++; this.store.set(key, data); }
  async delete(key: string) { this.deletes.push(key); this.store.delete(key); }
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
});
