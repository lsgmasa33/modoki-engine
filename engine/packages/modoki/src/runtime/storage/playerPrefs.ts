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
 *     `flush()` (before quit / on background) to push pending writes to the platform.
 *     ⚠️ `flush()` is NOT an fsync on any backend: it resolves once the platform has
 *     ACCEPTED the write, and the platform decides when that reaches the platter.
 *     On a PLAIN web tab, Chromium commits the localStorage area on a CLEAN SHUTDOWN, so
 *     a SIGKILL loses every write since the last one — measured, and waiting does not
 *     help. Under ELECTRON specifically, the loss window is narrower: main forces a
 *     commit (`session.flushStorageData()`) after every drained batch, so a SIGKILL
 *     only risks the write(s) currently in flight, not everything since the last clean
 *     shutdown (see docs/player-prefs.md § Gotchas for the three-arm measurement, both
 *     before and after this).
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
    // Push this batch the rest of the way to disk if the backend has a lever for that
    // (Electron's LocalStorageBackend — see backends.ts). One call per drained batch, not
    // per key: it's a step beyond `set`/`remove`, not a per-write requirement. Guarded the
    // same way a per-key write is: a rejection here must NOT poison `writeChain` — an
    // unguarded `await` sat here for one revision and, since every later `writeChain.then`
    // propagates a rejected chain WITHOUT running its callback, a single throwing
    // `flush()` would have silently ended persistence for the rest of the session.
    try {
      await backend.flush?.();
    } catch (err) {
      console.warn('[PlayerPrefs] backend.flush() failed — writes above are still recorded', err);
    }
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

/** The namespace these keys live under — the sanitized `init({namespace})`, or `'default'`
 *  before init.
 *
 *  Exposed because a key list is meaningless without it. The same game has SEPARATE stores
 *  depending on where it runs: a real build uses the game's own namespace, while the editor
 *  deliberately hydrates `<gameId>@editor` so playtest experiments cannot write into the save a
 *  shipped build reads (`app/editor/setup.ts`). Anything reporting prefs back to a human or an
 *  agent has to say WHICH store it looked in, or "the key is not there" is unanswerable. */
function getNamespace(): string {
  return namespace;
}

/**
 * Does this key still have a write the backend has NOT accepted?
 *
 * ⚠️ **Read this together with `flush()`, because `flush()` resolving does not mean the write
 * landed.** A rejected `backend.set()` (quota exceeded, a native I/O error) is caught in `drain()`,
 * re-queued into `dirty`, and warned about — and `writeChain` still settles *fulfilled* so later
 * writes are not poisoned. Meanwhile `cache` keeps the value, so `get()` happily returns it. Every
 * signal a caller normally has says the write succeeded.
 *
 * So: `await flush()` then `hasPendingWrite(key)` is the only way to learn that it did not.
 *
 * This exists for the purchase ledger (#196), where the distinction is money. Its durability check
 * read the value back through `get()` and therefore could not fail: it was re-reading the
 * optimistic cache, so it confirmed a grant that had never reached the disk, and the state machine
 * then FINISHED the transaction — telling the store to stop re-delivering a purchase whose record
 * was about to vanish on the next launch. Nothing else in the engine cares this much; nothing else
 * has an irreversible step gated on the answer.
 *
 * NOTE this still is not an fsync — `false` means "the platform ACCEPTED it", not "it is on the
 * platter", and that holds on EVERY backend, not just the native one: Android's
 * `SharedPreferences.apply()` is async-to-disk, and on a plain web tab Chromium commits the
 * localStorage area only on a clean shutdown — Electron narrows that window (see the
 * `LocalStorageBackend.flush` doc comment in backends.ts) but does not close it, since
 * `session.flushStorageData()` itself is fire-and-forget with no completion signal to await.
 * This function therefore separates "the backend rejected it" from "the backend took it" —
 * never "it is safe". See docs/player-prefs.md § Gotchas.
 */
function hasPendingWrite(key: string): boolean {
  return dirty.has(key);
}

/**
 * The logical keys with a write the backend has NOT accepted yet — the authoritative
 * pending set, for a caller that needs the whole list rather than one key at a time.
 *
 * ⚠️ **This is NOT derivable from `keys()`.** `keys()` mirrors `cache`, which a delete
 * empties out immediately (`del()` does `cache.delete(key); dirty.add(key)`): the key is
 * dirty and simultaneously absent from `cache`. So `keys().filter(hasPendingWrite)` can
 * never see a rejected DELETE — that's a blind spot by construction, not a bug in the
 * filter, and it's exactly the trap `pendingKeys()` exists to route around by reading
 * `dirty` directly instead of reconstructing it from `cache`.
 *
 * ⚠️ **"Authoritative" holds only at a STABLE point — after an awaited `flush()`**, exactly
 * how `hasPendingWrite`'s own doc frames it ("`await flush()` then `hasPendingWrite(key)`").
 * Mid-drain it UNDER-reports: `drain()` does `const keys = [...dirty]; dirty.clear();` and
 * only then awaits the backend calls, so `dirty` (and so `pendingKeys()`) is empty for the
 * whole duration of a batch, even though every one of those writes is still in flight and
 * could be about to be rejected.
 *
 * Same caveats as `hasPendingWrite` apply per-key: "pending" means "the backend has not
 * ACCEPTED it", not "it is unsynced to disk" — see that doc comment for what `flush()`
 * resolving does and doesn't guarantee.
 */
function pendingKeys(): string[] {
  return [...dirty];
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
  namespace: getNamespace,
  hasPendingWrite,
  pendingKeys,
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
