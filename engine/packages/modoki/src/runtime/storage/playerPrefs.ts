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

/** Cap on the pre-swap convergence loop in `init()` (see its call site) — bounds a pathological
 *  case where writes keep landing every drain forever, without claiming unbounded retry. */
const MAX_PRESWAP_FLUSHES = 5;

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
/** Serializes `init()` calls — see `init()`'s doc comment for why an overlapped call is
 *  queued rather than raced or superseded. Mirrors `writeChain`'s shape: each `.then()`
 *  callback attached here must itself never reject (see `init()`'s wrapper below), so a
 *  failing `init()` never poisons the chain for the next queued caller. */
let initChain: Promise<void> = Promise.resolve();

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

/** The result of `init()` — see the `discardedPending` field. */
export interface PlayerPrefsInitResult {
  /** Logical keys whose durable write never landed and that this `init()` discarded.
   *  Empty on the ordinary path. Non-empty in two DISTINCT ways — see `init`'s doc
   *  comment — never conflate them in a message: a real game swap (`hydrated` was
   *  true) means the pre-swap convergence loop was still not clean when it hit its
   *  cap, or every key it attempted was rejected by the backend; a first `init()`
   *  (`hydrated` was false) means these were written before `init()` ever ran and
   *  never reached a backend at all. Sorted (siblings that expose a pending set —
   *  `pendingKeys()`, the `player-prefs-*` agent ops — all sort; this matches). */
  discardedPending: string[];
}

/** Hydrate the in-memory cache from the backend. Call once at boot (safe to re-call
 *  on a game/namespace swap — it re-hydrates for the new namespace).
 *
 *  Resolves to `{ discardedPending }` — the logical keys this call discarded whose
 *  durable write never landed. This is NOT a refusal: `init()` always completes the
 *  swap (a quota-exceeded phone must not hard-block an OTA sub-game switch), but a
 *  non-empty `discardedPending` is real data loss the caller should surface, not
 *  silently swallow — see the two callers in `App.tsx` / `editor/setup.ts`.
 *
 *  The set means something DIFFERENT depending on `hydrated` at entry:
 *   - `hydrated === true` (an actual game/namespace swap): the loop just below drains
 *     to CONVERGENCE (not `flush()`'s bounded two drains — see the loop's own comment
 *     for why that matters), so what's left in `dirty` is either a key the backend
 *     never stopped rejecting, or — if the loop hit `MAX_PRESWAP_FLUSHES` still
 *     changing — a key that may never have been attempted at all. The message below
 *     says which.
 *   - `hydrated === false` (the very first `init()` call): no flush runs on this
 *     path at all, so a dirty key here was `set()` before `init()` was ever called —
 *     it only ever lived in the throwaway `'default'`-namespace cache this call is
 *     about to clear, and nothing was ever sent to a backend. That's a caller bug
 *     (writing before init), not a backend rejection — see docs/player-prefs.md
 *     § Gotchas, "every signal says success".
 *
 *  ⚠️ **SERIALIZED on `initChain` — an overlapped call is QUEUED, never superseded or
 *  rejected out.** Without this, a second `init()` (a new `gameId` landing while a first
 *  `init()` is still parked in `await backend.getAll(...)`) can finish first, and the
 *  FIRST call's continuation then resumes and pours ITS rows into the SECOND call's
 *  cache/namespace — cross-contaminating two games' stores (#428). Serializing means the
 *  whole body below — the pre-swap convergence loop, the `backend`/`namespace` swap, the
 *  `cache`/`dirty` clear, and the hydration loop — runs to completion for one caller
 *  before the NEXT QUEUED CALLER'S BODY even starts: no two `init()` *bodies* interleave.
 *  This is also what keeps `discardedPending` honest for the queued call: it runs a REAL
 *  swap from the previous call's already-finished state, rather than reporting `[]`
 *  because an interleaved call already cleared `dirty` out from under it. A caller whose
 *  own turn throws (e.g. `backend.getAll` rejects) still rejects to ITS OWN caller and
 *  leaves `hydrated` false — see the comment below — but must not poison the chain for the
 *  next queued `init()`; see the wrapper just below `doInit`.
 *
 *  ⚠️ **This does NOT mean `hydrated`/`namespace`/`cache`/`dirty` are never observed
 *  half-swapped.** They are — by every SYNCHRONOUS caller (`get`/`set`/`has`/`del`/`keys`/
 *  `pendingKeys`), for the entire `await backend.getAll(prefix)` round-trip below: `namespace`
 *  is assigned and `cache`/`dirty` are cleared BEFORE that await, so a synchronous `set()`
 *  racing the swap lands in the INCOMING namespace's cache, not the outgoing one's. What this
 *  fix closes is only the init-vs-init interleave (#428); the write-during-swap window is a
 *  separate, still-open gap — see #438. */
async function doInit(opts: PlayerPrefsInitOptions): Promise<PlayerPrefsInitResult> {
  // On a game swap (re-init with a new namespace), persist the previous game's
  // pending writes BEFORE we clear the cache — otherwise debounced writes are lost.
  const wasHydrated = hydrated;
  let converged = true;
  if (hydrated) {
    // `flush()` drains at most twice, and `drain()` snapshots `dirty` into a local array
    // BEFORE awaiting the backend calls (see `drain()`) — so a `set()` landing during the
    // SECOND drain is never attempted by anyone, and a plain `await flush()` here would
    // return with it still dirty and get discarded below as a false "rejected" report.
    // Loop `flush()` itself until the pending SET stops changing: a key the backend keeps
    // rejecting is re-queued identically (no progress ⇒ stop, correctly reported as
    // rejected), while a key merely written mid-drain gets its own attempt on the next
    // pass. Compare set CONTENTS, not size — a rejected key plus a newly arrived one keeps
    // the size equal while the set has changed. Capped, not unbounded — see `flush()`'s own
    // doc comment for why an unbounded retry is the wrong shape (a key the backend keeps
    // rejecting forever must not spin `init()` forever).
    // `null` rather than a string sentinel: a real signature is a space-joined sorted key list,
    // and keys `''` + `'none'` would join to exactly `' none'` — a collision that would call the
    // first pass converged. `null` is unrepresentable as a signature.
    let prev: string | null = null;
    converged = false;
    for (let i = 0; i < MAX_PRESWAP_FLUSHES; i++) {
      await flush();
      const sig = pendingKeys().sort().join(' ');
      if (sig === '' || sig === prev) { converged = true; break; }
      prev = sig;
    }
  }

  if (opts.backend) backend = opts.backend;
  if (opts.namespace !== undefined) namespace = sanitizeNamespace(opts.namespace);

  // Drop any in-flight writes' bookkeeping for the previous namespace/cache. Capture
  // whatever is STILL in `dirty` first — `dirty.clear()` below would otherwise discard
  // it with nothing inspecting it. See the two cases in the doc comment above.
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const discardedPending = pendingKeys().sort();
  cache.clear();
  dirty.clear();
  // The store genuinely is NOT hydrated for the new namespace between here and the
  // `hydrated = true` below — if `backend.getAll()` throws, this must stay `false` rather
  // than keep the PREVIOUS namespace's `true`, which would answer reads/writes for a store
  // under the new namespace this process never actually opened (see `agentBridge.ts`'s
  // `prefsUnhydrated()`, which gates on exactly this flag).
  hydrated = false;

  if (discardedPending.length > 0) {
    if (wasHydrated && converged) {
      console.error(
        `[PlayerPrefs] game swap discarded ${discardedPending.length} pending write(s) the backend ` +
          `did not accept during the pre-swap flush: ${discardedPending.join(', ')} — the outgoing ` +
          `game's last write to these keys is lost (possible causes: quota exceeded, a native I/O error)`,
      );
    } else if (wasHydrated) {
      console.error(
        `[PlayerPrefs] game swap discarded ${discardedPending.length} pending write(s) after ` +
          `${MAX_PRESWAP_FLUSHES} pre-swap flush attempt(s) still saw new writes arriving: ` +
          `${discardedPending.join(', ')} — some may have been attempted and rejected by the backend, ` +
          `others may never have been attempted at all; the outgoing game's last write to these keys ` +
          `is lost`,
      );
    } else {
      console.error(
        `[PlayerPrefs] init() discarded ${discardedPending.length} write(s) made before init() was ` +
          `called: ${discardedPending.join(', ')} — these never reached a backend and are lost; ` +
          `call PlayerPrefs.init() before writing`,
      );
    }
  }

  const prefix = keyPrefix();
  const raw = await backend.getAll(prefix);
  for (const [full, str] of Object.entries(raw)) {
    if (readEnvelope(str) === undefined) continue; // skip corrupt entries
    cache.set(full.slice(prefix.length), str);
  }
  hydrated = true;
  return { discardedPending };
}

/** Public `init()` — queues onto `initChain` so overlapping calls run one at a time.
 *  See `doInit`'s doc comment for why.
 *
 *  Mirrors the `writeChain` idiom in `drain()`: `run` is THIS call's own turn and is
 *  what gets returned (and rejects to this caller if `doInit` throws), while
 *  `initChain` is advanced to a version that always resolves — `run.then(noop, noop)` —
 *  so a rejection never poisons the chain for the next queued caller.
 *
 *  ⚠️ **ACCEPTED COST — a caller can be wedged behind an `init()` that never settles.**
 *  Before this fix a hung `backend.getAll()` (a dead native bridge, a browser storage API that
 *  never resolves) wedged only ITS OWN caller. Now `run = initChain.then(() => doInit(opts))`
 *  means a hung `doInit` also wedges every `init()` call queued behind it, for the rest of the
 *  process — there is no timeout here, deliberately (see below). `App.tsx`'s boot effect awaits
 *  `init()` with no timeout of its own either, feeding `setConfigReady`, so the practical
 *  consequence of a hang is a LoadingOverlay that never clears for the game the user actually
 *  asked for. This is accepted, not overlooked: a timeout here would mean racing ahead with
 *  `hydrated`/`namespace`/`cache` in an unknown state relative to a `doInit` that might still
 *  complete later and clobber it — trading a visible hang for the silent cross-contamination
 *  this whole mechanism exists to prevent. Do not add one without solving that.
 *
 *  ⚠️ **ACCEPTED COST — a rapid swap now pays for a cancelled init it used to skip.** Even on
 *  the healthy path, queuing means a cancelled game's `doInit` still runs to completion (a full
 *  `getAll`) before the wanted one starts, and because it leaves `hydrated === true`, the wanted
 *  `doInit` then takes the `wasHydrated` branch and pays a pre-swap convergence `flush()` it
 *  would previously have skipped (its own `dirty` is typically empty, so this is usually cheap,
 *  but it is a real await it didn't used to take). A rapid g1→g2→g3 swap costs g3's boot one
 *  extra `getAll` plus one extra `flush()` versus the unserialized code. This is the price of
 *  `discardedPending` staying honest (see `doInit`'s doc comment) — do not "optimize" it back
 *  into skipping a queued call's body, that reintroduces #428. */
function init(opts: PlayerPrefsInitOptions = {}): Promise<PlayerPrefsInitResult> {
  const run = initChain.then(() => doInit(opts));
  initChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
/** Reset all module state to a fresh in-memory backend. Call in `afterEach`.
 *
 *  ⚠️ This resets `initChain` to a fresh `Promise.resolve()` — it does NOT cancel whatever
 *  `doInit` a test left running on the OLD chain. A test that starts an `init()` and abandons
 *  it (never awaits/releases its gate) leaves that call's `run` still chained to the pre-reset
 *  `initChain`; nothing here stops it from resolving later and mutating module state
 *  concurrently with the NEXT test's own `init()` calls — reintroducing the #428 race across a
 *  test boundary. This reset only guarantees a clean *chain*, not that every previously-queued
 *  call has actually finished. */
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
  initChain = Promise.resolve();
}
