/** PlayerPrefs — engine-owned, atomic, per-key JSON key/value store.
 *
 *  A Unity-`PlayerPrefs`-style persistent store, refined for this engine:
 *   - Values are plain JSON documents (POJO — objects/arrays/primitives/null; no
 *     methods/class instances/Map/Set survive). One key ⇒ one document.
 *   - ATOMIC PER KEY: a reader never sees a torn value; a write lands whole or not
 *     at all. There is no cross-key transaction — state that must change together
 *     goes under ONE key. Atomicity comes for free from each backend's single-entry
 *     atomic write (see backends.ts) plus the in-memory cache being read/written in
 *     JS's single thread.
 *   - DURABILITY IS BEST-EFFORT (atomic ≠ durable): a kill right after `set()` can
 *     lose the last write but never corrupt it — the guarantee Unity gives. Call
 *     `flush()` (before quit / on background) to make pending writes durable.
 *
 *  Shape mirrors the engine's other singletons (audioService, sceneManager): a
 *  module singleton games `import { PlayerPrefs } from '@modoki/engine/runtime'` and
 *  call directly — no registration. The persistence adapter is injectable; the
 *  default is the platform-free in-memory backend, so this is determinism-guard-safe
 *  (no Date.now/Math.random) and usable headless before `init()` is ever called.
 *
 *  Platform backend selection (localStorage / @capacitor/preferences) is layered on
 *  in Phase 2; app-shell init/flush wiring in Phase 3. */

import { InMemoryBackend, type PrefsBackend } from './backends';

/** A plain JSON-serializable value. No functions, class instances, Map/Set, or cycles. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Bumped only if the on-disk envelope shape changes (not the game's data shape). */
const SCHEMA_VERSION = 1;

/** Persisted wrapper: `v` guards the envelope format, `d` is the game's document. */
interface Envelope {
  v: number;
  d: JsonValue;
}

/** Coalesce burst writes; `flush()` bypasses this for immediate durability. */
const WRITE_DEBOUNCE_MS = 150;

// ── Module state ──────────────────────────────────────────────────
let backend: PrefsBackend = new InMemoryBackend();
let namespace = 'default';
let hydrated = false;

/** Logical key → envelope JSON string. Storing the serialized form means `get()`
 *  parses a fresh object each call (no caller can mutate the cache) and enforces the
 *  JSON contract at `set()` time. */
const cache = new Map<string, string>();

/** Logical keys awaiting a backend write. A dirty key absent from `cache` ⇒ remove. */
const dirty = new Set<string>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Serializes all backend writes so `flush()` can await a stable point. */
let writeChain: Promise<void> = Promise.resolve();

// ── Keys ──────────────────────────────────────────────────────────
function sanitizeNamespace(ns: string): string {
  // Keep the `mk:<ns>:` delimiter unambiguous — collapse any ':' in the namespace.
  return ns.replace(/:/g, '_') || 'default';
}
function keyPrefix(): string {
  return `mk:${namespace}:`;
}
function fullKey(logical: string): string {
  return keyPrefix() + logical;
}

// ── Envelope ──────────────────────────────────────────────────────
/** Parse a stored envelope string → its document. Returns `undefined` on any
 *  malformed / unparseable value (fail soft — never throw into game code). */
function readEnvelope(str: string): JsonValue | undefined {
  try {
    const parsed = JSON.parse(str) as Envelope;
    if (parsed && typeof parsed === 'object' && 'd' in parsed) return parsed.d;
  } catch {
    /* corrupt entry — treat as absent */
  }
  return undefined;
}

/** Serialize a document into an envelope string. Returns `undefined` if the value
 *  can't be persisted — a cycle (JSON.stringify throws) or a top-level function/symbol
 *  (which would serialize to a `d`-less envelope, i.e. silent data loss). The caller
 *  then skips the write + warns.
 *
 *  Note: non-finite numbers (NaN, ±Infinity) and -0 are coerced by JSON.stringify
 *  (→ null / 0) rather than rejected — this is inherent JSON behavior and accepted. */
function writeEnvelope(value: JsonValue): string | undefined {
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  try {
    const env: Envelope = { v: SCHEMA_VERSION, d: value };
    return JSON.stringify(env);
  } catch {
    return undefined;
  }
}

// ── Write pipeline ────────────────────────────────────────────────
function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void drain();
  }, WRITE_DEBOUNCE_MS);
}

/** Append a drain of all currently-dirty keys to the serialized write chain.
 *
 *  Each per-key write is guarded so a backend rejection (localStorage QuotaExceeded,
 *  Preferences I/O error) NEVER poisons the chain: the failed key is re-queued as
 *  dirty for the next flush and we warn, but `writeChain` always settles fulfilled so
 *  subsequent writes still run. Only keys actually attempted are cleared from `dirty`. */
function drain(): Promise<void> {
  writeChain = writeChain.then(async () => {
    if (dirty.size === 0) return;
    const keys = [...dirty];
    dirty.clear();
    await Promise.all(
      keys.map(async (k) => {
        const full = fullKey(k);
        const env = cache.get(k);
        try {
          if (env !== undefined) await backend.set(full, env);
          else await backend.remove(full);
        } catch (err) {
          dirty.add(k); // re-queue for a later flush; never poison the chain
          console.warn(`[PlayerPrefs] write for "${k}" failed — will retry on next flush`, err);
        }
      }),
    );
  });
  return writeChain;
}

// ── Public API ────────────────────────────────────────────────────
export interface PlayerPrefsInitOptions {
  /** Per-game key namespace (typically the game's appId) so games can't collide. */
  namespace?: string;
  /** Explicit persistence adapter. Defaults to the current backend (in-memory). */
  backend?: PrefsBackend;
}

/** Hydrate the in-memory cache from the backend. Call once at boot (safe to re-call
 *  on a game/namespace swap — it re-hydrates for the new namespace). */
async function init(opts: PlayerPrefsInitOptions = {}): Promise<void> {
  // On a game swap (re-init with a new namespace), persist the previous game's
  // pending writes BEFORE we clear the cache — otherwise debounced writes are lost.
  if (hydrated) await flush();

  if (opts.backend) backend = opts.backend;
  if (opts.namespace !== undefined) namespace = sanitizeNamespace(opts.namespace);

  // Drop any in-flight writes' bookkeeping for the previous namespace/cache.
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  cache.clear();
  dirty.clear();

  const prefix = keyPrefix();
  const raw = await backend.getAll(prefix);
  for (const [full, str] of Object.entries(raw)) {
    if (readEnvelope(str) === undefined) continue; // skip corrupt entries
    cache.set(full.slice(prefix.length), str);
  }
  hydrated = true;
}

/** Read a value. Returns a fresh copy (parsed from cache) — mutating it never
 *  affects the store. `undefined` if the key is absent. Synchronous. */
function get<T extends JsonValue = JsonValue>(key: string): T | undefined {
  const env = cache.get(key);
  if (env === undefined) return undefined;
  return readEnvelope(env) as T | undefined;
}

/** Write a value (atomic per key). `undefined` deletes the key. Synchronous into the
 *  cache; the durable write is debounced (see `flush()`). */
function set<T extends JsonValue>(key: string, value: T | undefined): void {
  if (value === undefined) {
    del(key);
    return;
  }
  const env = writeEnvelope(value);
  if (env === undefined) {
    console.warn(`[PlayerPrefs] value for "${key}" is not JSON-serializable — skipped`);
    return;
  }
  cache.set(key, env);
  dirty.add(key);
  scheduleFlush();
}

function has(key: string): boolean {
  return cache.has(key);
}

function del(key: string): void {
  cache.delete(key);
  dirty.add(key); // dirty with no cache entry ⇒ backend.remove
  scheduleFlush();
}

/** The logical keys currently stored (this namespace only). */
function keys(): string[] {
  return [...cache.keys()];
}

/** Remove every key in this namespace. */
function clear(): void {
  for (const k of cache.keys()) dirty.add(k);
  cache.clear();
  scheduleFlush();
}

/** Resolve once all pending writes are durable. Cancels the debounce and drains
 *  immediately; loops so keys dirtied mid-drain are also flushed. */
async function flush(): Promise<void> {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await drain();
  if (dirty.size > 0) await drain();
}

/** True once `init()` has hydrated the cache. */
function isHydrated(): boolean {
  return hydrated;
}

export const PlayerPrefs = {
  init,
  get,
  set,
  has,
  delete: del,
  keys,
  clear,
  flush,
  isHydrated,
} as const;

// ── Test seam ─────────────────────────────────────────────────────
// Standalone export (not on the public `PlayerPrefs` object) so it never leaks into
// game-author autocomplete — mirrors the engine's `__resetManagersForTesting` pattern.
/** Reset all module state to a fresh in-memory backend. Call in `afterEach`. */
export function resetPlayerPrefsForTest(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  backend = new InMemoryBackend();
  namespace = 'default';
  hydrated = false;
  cache.clear();
  dirty.clear();
  writeChain = Promise.resolve();
}
