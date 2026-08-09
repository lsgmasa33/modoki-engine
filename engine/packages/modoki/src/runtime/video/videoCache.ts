/** Downloaded-video cache — fetch with progress, store locally, evict against a
 *  per-game budget.
 *
 *  Splits into three pieces on purpose:
 *   - `videoCachePolicy.ts` decides WHAT to evict (pure, heavily tested);
 *   - a `CacheBackend` stores bytes (swappable: Cache API on web, Capacitor
 *     Filesystem on native, an in-memory fake in tests);
 *   - this module orchestrates them.
 *
 *  ## The index is separate from the bytes, deliberately
 *
 *  `lastUsed` cannot be derived from a Cache API entry, and asking the backend for
 *  every response's size to make an eviction decision would mean reading the whole
 *  cache off disk to decide what to delete. So sizes + use-times live in a small
 *  index persisted next to the data. The index is authoritative for DECISIONS; the
 *  backend is authoritative for EXISTENCE, and `reconcile()` repairs drift (a
 *  half-written entry, or a browser evicting our storage behind our back — which it
 *  is allowed to do at any time).
 *
 *  ## iOS
 *
 *  Downloaded content MUST be excluded from iCloud backup or App Store review
 *  rejects the app. That is a backend concern (the native backend sets the flag);
 *  the Cache API is already exempt. */

import {
  planAdmission, explainRefusal, totalBytes, type CacheEntry,
} from './videoCachePolicy';

export interface CacheBackend {
  /** Keys currently holding bytes. */
  keys(): Promise<string[]>;
  /** A playable URL for a stored clip, or undefined when absent. */
  urlFor(key: string): Promise<string | undefined>;
  /** Stored size in bytes, or undefined when absent. Used to adopt an orphan at its
   *  REAL size — see reconcile(). */
  sizeOf(key: string): Promise<number | undefined>;
  write(key: string, data: Blob): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Persisted index entry. Kept small — it is read on every admission decision. */
interface IndexEntry { bytes: number; lastUsed: number; pinned?: boolean }

const INDEX_STORAGE_KEY = 'modoki.videoCache.index.v1';

export interface VideoCacheOptions {
  backend: CacheBackend;
  budgetBytes: number;
  /** Injected so tests are deterministic and the engine keeps its no-wall-clock rule:
   *  `lastUsed` values are only ever COMPARED, never interpreted as a date. */
  now?: () => number;
  /** Where the index persists. Omit for in-memory (tests / no localStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export interface DownloadProgress {
  receivedBytes: number;
  /** Undefined when the server sends no Content-Length. */
  totalBytes?: number;
}

export class VideoCache {
  private index = new Map<string, IndexEntry>();
  private readonly backend: CacheBackend;
  private readonly budget: number;
  private readonly now: () => number;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** De-dupes concurrent requests for the same clip — two entities sharing a video
   *  must not race two downloads of it. */
  private inFlight = new Map<string, Promise<string | undefined>>();
  private tick = 0;

  constructor(opts: VideoCacheOptions) {
    this.backend = opts.backend;
    this.budget = opts.budgetBytes;
    this.storage = opts.storage;
    // Default clock is a monotonic counter, NOT Date.now() — the engine's determinism
    // rule bans wall-clock reads, and a counter is all LRU needs (ordering, not time).
    this.now = opts.now ?? (() => ++this.tick);
    this.loadIndex();
  }

  private loadIndex(): void {
    try {
      const raw = this.storage?.getItem(INDEX_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, IndexEntry>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v?.bytes === 'number') this.index.set(k, v);
      }
      // Keep the counter ahead of anything restored, else a fresh session's entries
      // would all look OLDER than the persisted ones and be evicted first.
      for (const v of this.index.values()) this.tick = Math.max(this.tick, v.lastUsed);
    } catch { /* corrupt index → start empty; the backend reconcile will repopulate */ }
  }

  private saveIndex(): void {
    try {
      this.storage?.setItem(INDEX_STORAGE_KEY, JSON.stringify(Object.fromEntries(this.index)));
    } catch { /* quota/private mode — the cache still works, it just forgets across reloads */ }
  }

  /** Drop index entries whose bytes are gone, and adopt bytes with no index entry.
   *  A browser may evict our storage at ANY time without telling us, so an index that
   *  is merely stale must not make us believe the cache is full of things that no
   *  longer exist. */
  async reconcile(): Promise<void> {
    const present = new Set(await this.backend.keys());
    for (const k of [...this.index.keys()]) {
      if (!present.has(k)) this.index.delete(k);
    }
    for (const k of present) {
      // Orphan bytes with no index entry: keep them (deleting would throw away a
      // usable clip) at worst-case age so they are first to go — but MEASURE them.
      //
      // Adopting at bytes:0 silently under-reports the budget, and this path is not
      // hypothetical: the module can be evaluated twice, and if one instance runs
      // reconcile() while the backend momentarily reports nothing, it persists an
      // empty index and the next instance adopts every real entry as a zero-size
      // orphan. The cache then believes it is empty and will happily blow the budget.
      if (!this.index.has(k)) {
        const bytes = (await this.backend.sizeOf(k)) ?? 0;
        this.index.set(k, { bytes, lastUsed: 0 });
      }
    }
    this.saveIndex();
  }

  entries(): CacheEntry[] {
    return [...this.index].map(([key, v]) => ({ key, bytes: v.bytes, lastUsed: v.lastUsed, pinned: v.pinned }));
  }

  usedBytes(): number { return totalBytes(this.entries()); }
  budgetBytes(): number { return this.budget; }

  /** Mark a clip as never-evictable (a game declaring what it is about to need). */
  setPinned(key: string, pinned: boolean): void {
    const e = this.index.get(key);
    if (!e) return;
    e.pinned = pinned;
    this.saveIndex();
  }

  /** A cached clip's local URL, touching its LRU position. Undefined when not cached. */
  async get(key: string): Promise<string | undefined> {
    const url = await this.backend.urlFor(key);
    if (!url) { this.index.delete(key); return undefined; }
    const e = this.index.get(key);
    if (e) { e.lastUsed = this.now(); this.saveIndex(); }
    return url;
  }

  /** Fetch and cache a clip, returning its local URL. Returns the cached copy if
   *  present. Concurrent calls for the same key share one download. */
  async fetchAndStore(
    key: string, url: string, onProgress?: (p: DownloadProgress) => void,
  ): Promise<string | undefined> {
    const cached = await this.get(key);
    if (cached) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const job = this.doFetch(key, url, onProgress).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, job);
    return job;
  }

  private async doFetch(
    key: string, url: string, onProgress?: (p: DownloadProgress) => void,
  ): Promise<string | undefined> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`video download failed: ${res.status} ${res.statusText} — ${url}`);

    const declared = Number(res.headers.get('content-length')) || undefined;

    // Refuse BEFORE downloading when the server told us the size and it cannot fit —
    // downloading megabytes only to discard them is the worst possible order.
    if (declared != null) {
      const plan = planAdmission({
        entries: this.entries(), incomingBytes: declared, budgetBytes: this.budget, incomingKey: key,
      });
      if (!plan.ok) throw new Error(`video cache refused ${key}: ${explainRefusal(plan, this.budget)}`);
    }

    const blob = await this.readWithProgress(res, declared, onProgress);

    // Re-plan against the ACTUAL size: a server may lie, omit Content-Length, or the
    // cache may have changed while we were downloading.
    const plan = planAdmission({
      entries: this.entries(), incomingBytes: blob.size, budgetBytes: this.budget, incomingKey: key,
    });
    if (!plan.ok) throw new Error(`video cache refused ${key}: ${explainRefusal(plan, this.budget)}`);

    for (const victim of plan.evict) {
      await this.backend.delete(victim);
      this.index.delete(victim);
    }

    await this.backend.write(key, blob);
    this.index.set(key, { bytes: blob.size, lastUsed: this.now(), pinned: this.index.get(key)?.pinned });
    this.saveIndex();
    return this.backend.urlFor(key);
  }

  private async readWithProgress(
    res: Response, declared: number | undefined, onProgress?: (p: DownloadProgress) => void,
  ): Promise<Blob> {
    // No progress wanted, or no streaming body available → the simple path.
    if (!onProgress || !res.body) return res.blob();

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress({ receivedBytes: received, totalBytes: declared });
      }
    }
    return new Blob(chunks as BlobPart[], { type: res.headers.get('content-type') ?? 'video/mp4' });
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(key);
    this.index.delete(key);
    this.saveIndex();
  }

  async clear(): Promise<void> {
    for (const k of [...this.index.keys()]) await this.backend.delete(k);
    this.index.clear();
    this.saveIndex();
  }
}

/** Cache API backend — the web/default implementation. Storage under this API is
 *  already excluded from iCloud backup, so the iOS review requirement is satisfied
 *  without extra work on this path. */
export class CacheApiBackend implements CacheBackend {
  private readonly cacheName: string;

  constructor(cacheName = 'modoki-video-v1') { this.cacheName = cacheName; }

  private open(): Promise<Cache> { return caches.open(this.cacheName); }

  async keys(): Promise<string[]> {
    const c = await this.open();
    return (await c.keys()).map((r) => new URL(r.url).pathname.replace(/^\//, ''));
  }

  private req(key: string): string { return `/${key}`; }

  async sizeOf(key: string): Promise<number | undefined> {
    const c = await this.open();
    const res = await c.match(this.req(key));
    if (!res) return undefined;
    // Prefer the header over reading the body — this runs for every orphan at boot.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0) return declared;
    return (await res.blob()).size;
  }

  async urlFor(key: string): Promise<string | undefined> {
    const c = await this.open();
    const res = await c.match(this.req(key));
    if (!res) return undefined;
    // A blob: URL is what a media element can actually play from a Cache entry.
    return URL.createObjectURL(await res.blob());
  }

  async write(key: string, data: Blob): Promise<void> {
    const c = await this.open();
    await c.put(this.req(key), new Response(data, { headers: { 'content-type': data.type || 'video/mp4' } }));
  }

  async delete(key: string): Promise<void> {
    const c = await this.open();
    await c.delete(this.req(key));
  }
}

/** True when the Cache API is usable here (absent in Node/tests, and in some
 *  insecure-context webviews). */
export function hasCacheStorage(): boolean {
  return typeof caches !== 'undefined';
}
