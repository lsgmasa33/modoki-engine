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
import { createSupersessionToken } from '../core/liveness';

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

/**
 * Keys a drain has taken OUT of `dirty` but whose backend call has not settled yet (#559).
 *
 * ⚠️ **Without this, `hasPendingWrite`/`pendingKeys` under-report for the whole duration of every
 * batch.** `drain()` does `const keys = [...dirty]; dirty.clear();` and only THEN awaits the
 * backend, so a write that is still in flight — and may be about to be REJECTED — read as durable.
 * That defeats the one signal those accessors exist to provide: `get()` re-reads the optimistic
 * cache and therefore cannot fail, so `hasPendingWrite` is the only thing that separates "stored"
 * from "queued while the cache lies about it" (#196, where the distinction is real money).
 *
 * A `Set`, not a refcount. `drain()` chains on `writeChain` and returns it, so batches are strictly
 * SERIALIZED — two can never be in flight at once, and `keys` is `[...dirty]`, deduped by
 * construction. A key therefore cannot be in flight twice, and a count could never exceed 1.
 *
 * ⚠️ An earlier version of this used a refcount and justified it as protecting the swap case — a
 * stale batch settling after `inFlight.clear()` and deleting an entry a NEW batch made for the same
 * key. That justification was wrong in both directions (#559 review): serialization means the
 * overlap cannot arise in production, and where it CAN (a test's `resetPlayerPrefsForTest` re-arming
 * `writeChain` under an unsettled batch) the refcount gave no protection anyway — the clear zeroes
 * the count, so the stale `unmarkInFlight` computes `0 - 1` and takes the delete branch, removing
 * exactly the entry it was supposed to preserve. Dead sophistication with a false explanation, in a
 * file where the comments are the primary artifact.
  */
const inFlight = new Set<string>();

function markInFlight(key: string): void {
  inFlight.add(key);
}

/**
 * The keys QUEUED for a future drain — `dirty` alone, deliberately excluding in-flight writes.
 *
 * ⚠️ **Not a weaker `pendingKeys()`; a DIFFERENT QUESTION, and the swap classification needs this
 * one.** `pendingKeys()`/`hasPendingWrite` answer "has the backend accepted this write yet", so
 * they must include in-flight writes (#559). `doInit`'s discard report answers "which writes were
 * queued and never offered to a flush at all" — and an in-flight write WAS offered. Folding
 * in-flight state into that snapshot was tried in #438 round 4 and reported a write that goes on to
 * SUCCEED as discarded, a false loss report; it was reverted then, and widening the shared accessor
 * silently reintroduced it until this split (#559). What caught it was the four swap-window tests
 * from `b7a360573` (#454) — worth knowing, because nothing else in the suite would have, and the
 * reintroduction was invisible to typecheck, lint and every Court test.
 */
function queuedKeys(): string[] {
  return [...dirty];
}

/** Symmetric with `markInFlight`. A delete of an entry a swap already cleared is a no-op. */
function unmarkInFlight(key: string): void {
  inFlight.delete(key);
}

/** `true` for the duration of `doInit`'s body (set at the top, cleared in a `finally` so both
 *  the success and throw paths clear it) — a namespace/backend swap is in flight. Separate from
 *  `hydrated`, which deliberately stays `true` through the window describing the OUTGOING store
 *  (see `doInit`'s doc comment): this flag is the signal a caller needs to tell "not open" apart
 *  from "mid-swap", e.g. `agentBridge.ts`'s `player-prefs-write` op, which must refuse a write
 *  during the window rather than accept one the install is about to discard (#438). */
let swapInFlight = false;
/** Supersession token (`runtime/core/liveness.ts`) for the CURRENT `swapInFlight` window —
 *  `begin()` is called each time `doInit` sets `swapInFlight = true`, bumping its counter.
 *  Originally existed only so `resetPlayerPrefsForTest` can't be fooled by
 *  a STALE `doInit` call left parked mid-`getAll` by a prior test: that call's `finally` block
 *  only clears `swapInFlight` if its captured check still passes, so a newer swap
 *  (started by the new test, after the reset) is never incorrectly cleared by the old one
 *  settling later. Production was unaffected by THAT role — `initChain` serializes real `doInit`
 *  calls, so there is never more than one attempt in flight there. Test-isolation-only, not a
 *  production race (see `doInit`'s comment).
 *
 *  ⚠️ It now has a SECOND, production role too (#454 C, via `PlayerPrefs.swapGeneration()`): a
 *  caller that awaits something of its own (e.g. `agentBridge.ts`'s `player-prefs-write` op
 *  awaiting `flush()`) can capture this token's counter before the await and compare after, to learn
 *  whether a swap window opened in between — including one that opened AND closed entirely
 *  inside the await, which a re-sampled `isSwapInFlight()` structurally cannot see (that flag is
 *  already back to `false` by the time the caller resumes). See `swapGeneration()`'s own doc
 *  comment for the contract. */
const swapToken = createSupersessionToken();
/** Non-null only while a swap window is open (`doInitBody` sets it just before taking the
 *  pre-window pending snapshot; both exit paths null it again) — so the ordinary non-swapping
 *  path pays nothing for it. Exists to answer a question set membership alone cannot (#454 B): a
 *  pre-window key that (1) was pending before the window, (2) landed durably during it, and (3)
 *  was then re-set during it ends up back in the post-window pending set indistinguishable, by
 *  membership alone, from a key that never landed at all — yet `PlayerPrefsInitResult`'s doc
 *  comment says those two must never be conflated in the console reporting (one is a plain
 *  discard, the other RACED a re-write against a write that already succeeded). `drain()` adds a
 *  key here the instant its write is accepted by the backend and removes it again if a LATER
 *  attempt for that same key (inside the same window) is then rejected — so membership answers
 *  "did this key's MOST RECENT attempt inside the window land?", not "did it ever land". That
 *  lets `doInitBody` tell "landed then re-set" apart from "never landed" when it closes the
 *  window, and also correctly re-discards a key that landed, was re-set, and whose re-write was
 *  then genuinely refused by the backend before the window closed (#454 B, review finding 1). */
let windowLanded: Set<string> | null = null;

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
/** Single place that knows the `mk:<ns>:` format. `doInit()` needs this for the INCOMING
 *  namespace before that global is swapped in, so it calls this directly with a local;
 *  `drain()` similarly calls it with the namespace it captured at the start of its batch (see
 *  `drain()`'s doc comment, #438) rather than reading the live global — a full key is never
 *  built off whatever `namespace` happens to be at the moment a write settles. */
function prefixFor(ns: string): string {
  return `mk:${ns}:`;
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
 *  subsequent writes still run. Only keys actually attempted are cleared from `dirty`.
 *
 *  `namespace`/`backend` are captured into LOCALS (`batchNamespace`/`batchBackend`) at the
 *  START of the batch, before any `await` — never re-read from module state once a write is
 *  in flight (#438). A `PlayerPrefs.init()` swap can install a new namespace/backend WHILE
 *  this batch's backend calls are still pending (that's the whole write-during-swap window),
 *  and re-reading the live globals at settle time would resolve the full key and the rejection
 *  handler's re-queue against the INCOMING store — a real cross-namespace write/delete. So the
 *  full key is built from `batchNamespace`, the backend call goes to `batchBackend`, and a
 *  rejection is only re-queued into `dirty` if `namespace` is STILL `batchNamespace` by the time
 *  it settles; otherwise the write is lost (the outgoing store no longer exists in this process)
 *  and that's logged instead of silently discarded or misdirected.
 *
 *  ⚠️ **That re-queue guard is NAMESPACE-ONLY, deliberately (#454 A) — and it does NOT mean the
 *  write survives.** `init()` can swap the BACKEND while keeping the same namespace (`App.tsx`'s
 *  `init({namespace: gameId, backend: selectDefaultBackend()})`, a same-game reload), and this
 *  guard does not detect that: the namespace matches, so the key re-queues. But by then the
 *  install has already done `cache.clear()` and repopulated from the INCOMING backend's `getAll`,
 *  so the re-queued key no longer carries the outgoing write's value — the next drain resolves
 *  `cache.get(k)` against the incoming cache and either re-sets the value that store already
 *  holds or, more usually, issues a `remove` for a key it does not hold. Both are no-ops against
 *  that same game's own store. Do not read this branch as "the pending write follows the game
 *  into its new backend": the VALUE is gone either way, and only the retry attempt follows.
 *
 *  It stays namespace-only because the namespace is what answers the question the guard is
 *  actually asking — *is there still a store in this process to retry against?* — and because
 *  the else-branch's `console.error` would otherwise fire on a backend-only swap and report the
 *  store as having "already swapped to" the very namespace it started in: a message that
 *  misdescribes what happened, to buy a behaviour change that is a no-op either way. */
function drain(): Promise<void> {
  writeChain = writeChain.then(async () => {
    if (dirty.size === 0) return;
    const keys = [...dirty];
    dirty.clear();
    // #559 — the keys leave `dirty` here and their backend calls have not run yet, so from this
    // point until each one settles the in-flight ledger is the ONLY thing that can report them as
    // still pending. Marked before the first `await`, cleared in each key's `finally` below.
    for (const k of keys) markInFlight(k);
    const batchNamespace = namespace;
    const batchBackend = backend;
    await Promise.all(
      keys.map(async (k) => {
        const full = prefixFor(batchNamespace) + k;
        const env = cache.get(k);
        try {
          if (env !== undefined) await batchBackend.set(full, env);
          else await batchBackend.remove(full);
          // Record the landing for whoever has a swap window open (#454 B) — but only if this
          // batch's namespace is the one the window is watching. A batch belonging to a namespace
          // the store has already swapped away from is not a landing in THIS window; without the
          // guard a late-settling batch from an OLDER namespace could mark a key "landed" against
          // a window that opened for an entirely different game.
          if (windowLanded && batchNamespace === namespace) windowLanded.add(k);
        } catch (err) {
          // Symmetric with the `add` above (#454 B): `windowLanded` answers "did this key's MOST RECENT
          // attempt inside the window land?", not "did it ever land". A key that landed earlier in the
          // window and was then re-set and REJECTED is a backend failure, and must go back to being
          // reported as discarded — leaving the stale landing here routed it to `reportRaced`, whose
          // message says "this is NOT a backend failure" about a write the backend had just refused.
          if (windowLanded && batchNamespace === namespace) windowLanded.delete(k);
          if (namespace === batchNamespace) {
            dirty.add(k); // re-queue for a later flush; never poison the chain
            console.warn(`[PlayerPrefs] write for "${k}" failed — will retry on next flush`, err);
          } else {
            // The store has already swapped away from `batchNamespace` — re-queuing would send
            // the NEXT drain's attempt against the INCOMING namespace/backend instead (#438).
            // There is no store left to retry this write against, so it's lost; say so loudly
            // rather than silently dropping it or misdirecting it.
            console.error(
              `[PlayerPrefs] write for "${k}" in namespace "${batchNamespace}" was rejected after ` +
                `the store had already swapped to "${namespace}" — the write is lost, this ` +
                `process no longer holds "${batchNamespace}"'s store to retry it against`,
              err,
            );
          }
        } finally {
          // #559 — placed after the catch's `dirty.add(k)` for readability only. ⚠️ This is NOT
          // load-bearing, and an earlier comment here claimed it was ("clearing this first would
          // leave a window in which a still-unresolved write belongs to neither"). There is no such
          // window in either ordering: `catch` and `finally` run in the same synchronous turn with
          // no `await` between them, so no observer can sample the intermediate state.
          unmarkInFlight(k);
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
      await batchBackend.flush?.();
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
   *  Empty on the ordinary path. Non-empty for up to THREE distinct reasons, reported
   *  through separate `console.error` messages — never conflate them:
   *   - a real game swap (`hydrated` was true) where the pre-swap convergence loop was
   *     still not clean when it hit its cap, or every key it attempted was rejected by
   *     the backend;
   *   - a first `init()` (`hydrated` was false) where these were written before `init()`
   *     ever ran and never reached a backend at all;
   *   - a write that raced the `await nextBackend.getAll(prefix)` window (#438) — never
   *     offered to the pre-swap flush at all, discarded by the synchronous install, and
   *     reported through a dedicated message that says so rather than blaming the backend.
   *  This field is the union of whichever of these fired, since all three are keys whose
   *  write is genuinely lost — but the console messages are what say WHY. Sorted (siblings
   *  that expose a pending set — `pendingKeys()`, the `player-prefs-*` agent ops — all
   *  sort; this matches). */
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
 *  ⚠️ **The write-during-swap window is closed (#438) — `namespace`/`backend`/`cache`/`dirty`
 *  stay on the OUTGOING game for the entire `await backend.getAll(prefix)` round-trip.** The
 *  incoming `backend`/`namespace` are computed into LOCALS (`nextBackend`/`nextNamespace`) and
 *  the read goes through them into a local `raw`; the globals are not touched until one
 *  synchronous block right after the await installs everything at once — `backend`/`namespace`
 *  swap, `cache`/`dirty` clear, `cache` repopulated from `raw`, `hydrated = true` — with no
 *  `await` in between. So a synchronous `set()`/`del()`/`clear()` racing the swap still lands
 *  in the OUTGOING namespace (where it belongs) instead of contaminating the incoming one; it
 *  is then discarded by the install step just like any other pre-swap pending write, and
 *  reported through the same `discardedPending` path. `hydrated` deliberately stays `true`
 *  throughout the window — it is describing the OUTGOING store, which genuinely has been read
 *  from its backend, matching `prefsUnhydrated()`'s own wording ("nothing has read the
 *  backend"). If `nextBackend.getAll()` throws, the catch below installs the incoming
 *  `backend`/`namespace` with an explicitly empty, unhydrated cache (today's failure shape)
 *  and rethrows.
 *
 *  **Scope note:** this closes the cross-namespace CONTAMINATION (#438's harm), not the loss —
 *  a write arriving during the window still lands in `dirty` under the outgoing namespace and
 *  is one of two things depending on timing, and this comment must not claim only one of them
 *  happens: if the 150ms debounce has NOT yet fired when the install runs, the write is caught
 *  by the SECOND `pendingKeys()` snapshot below (taken in the synchronous install block, after
 *  the await) and reported through a dedicated "raced the swap" message — never blamed on the
 *  backend, since it was never offered to a flush. If the debounce fires WHILE the await is
 *  still pending, `drain()` sends it straight to the outgoing backend and it is persisted
 *  durably to the outgoing namespace, reported nowhere — UNLESS (#454 B) the outgoing game
 *  writes to that same key AGAIN before the window closes: then the pre-window key is back in
 *  `dirty`, and that re-write is exactly the "raced the swap" case above, reported through the
 *  same message via `windowLanded` (see its doc comment) rather than silently as before. So
 *  there are three outcomes, not two: never lands (discarded), lands and stays landed (reported
 *  nowhere), lands and then gets re-set (raced). Every outcome above is acceptable; what's fixed
 *  is that none of them can contaminate the INCOMING namespace. Nothing is queued or replayed
 *  into the incoming store; doing that would need another `await` and therefore another window.
 *  The init-vs-init interleave (#428) is unaffected by this change. */
async function doInit(opts: PlayerPrefsInitOptions): Promise<PlayerPrefsInitResult> {
  swapInFlight = true;
  const stillCurrentSwap = swapToken.begin();
  try {
    return await doInitBody(opts);
  } finally {
    // Only clear if no NEWER swap has started since — guards against a stale call left
    // parked mid-`getAll` by a prior test settling after `resetPlayerPrefsForTest` has
    // already started a fresh swap (see `swapToken`'s doc comment). In production there is
    // only ever one attempt in flight (`initChain` serializes real callers), so this is always
    // a no-op there.
    if (stillCurrentSwap()) {
      swapInFlight = false;
    }
  }
}

async function doInitBody(opts: PlayerPrefsInitOptions): Promise<PlayerPrefsInitResult> {
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

  // Compute the INCOMING backend/namespace into locals — the globals stay on the outgoing
  // game until the synchronous install block below, so a `set()`/`del()`/`clear()` racing
  // this await still resolves against the outgoing namespace (`drain()` captures its own local
  // for this — see the ⚠️ above `doInit`).
  const nextBackend = opts.backend ?? backend;
  const nextNamespace = opts.namespace !== undefined ? sanitizeNamespace(opts.namespace) : namespace;
  const prefix = prefixFor(nextNamespace);

  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function reportDiscarded(discarded: string[]): void {
    if (discarded.length === 0) return;
    if (wasHydrated && converged) {
      console.error(
        `[PlayerPrefs] game swap discarded ${discarded.length} pending write(s) the backend ` +
          `did not accept during the pre-swap flush: ${discarded.join(', ')} — the outgoing ` +
          `game's last write to these keys is lost (possible causes: quota exceeded, a native I/O error)`,
      );
    } else if (wasHydrated) {
      console.error(
        `[PlayerPrefs] game swap discarded ${discarded.length} pending write(s) after ` +
          `${MAX_PRESWAP_FLUSHES} pre-swap flush attempt(s) still saw new writes arriving: ` +
          `${discarded.join(', ')} — some may have been attempted and rejected by the backend, ` +
          `others may never have been attempted at all; the outgoing game's last write to these keys ` +
          `is lost`,
      );
    } else {
      console.error(
        `[PlayerPrefs] init() discarded ${discarded.length} write(s) made before init() was ` +
          `called: ${discarded.join(', ')} — these never reached a backend and are lost; ` +
          `call PlayerPrefs.init() before writing`,
      );
    }
  }

  // A key reported here fits one of TWO shapes, both raced the swap window rather than being
  // rejected by a backend:
  //   - the original shape: the key was NEVER offered to the pre-swap flush loop above — it was
  //     written by the OUTGOING game after that loop finished, while this call was still awaiting
  //     `nextBackend.getAll()`.
  //   - added for #454 B: a key pending BEFORE the window whose write LANDED durably during the
  //     window and was then RE-WRITTEN by the outgoing game before the window closed — the
  //     landing means it was never a backend rejection either, it's the re-write that raced the
  //     install.
  // Neither is a backend rejection (there was nothing for a backend to reject) — a distinct
  // message so a debugger doesn't go hunting a phantom storage failure.
  function reportRaced(raced: string[], outgoingNamespace: string): void {
    if (raced.length === 0) return;
    console.error(
      `[PlayerPrefs] game swap discarded ${raced.length} pending write(s) written by the ` +
        `outgoing "${outgoingNamespace}" namespace DURING the swap's backend read, after the ` +
        `pre-swap flush had already finished: ${raced.join(', ')} — these were never offered to ` +
        `a flush and are lost; this is NOT a backend failure, the write simply arrived too late ` +
        `to be flushed before the new namespace was installed`,
    );
  }

  // Open the landing-tracking window (#454 B) here, immediately before the pre-window snapshot
  // it's paired with, so the two are read as one unit. Ordering between these two synchronous
  // statements does not matter — there is no `await` between them, and a landing can only be
  // recorded from a `drain()` continuation, which cannot run between two synchronous statements.
  // See `windowLanded`'s doc comment for what it's for.
  //
  // `myWindow` is held in a LOCAL, and the module global is only ever touched through an
  // `windowLanded === myWindow` identity check, rather than gated on the epoch the way
  // `swapInFlight` is in `doInit`'s `finally` (#454, review finding 3). A stale `doInit` left
  // parked mid-`getAll` by a prior test (see `resetPlayerPrefsForTest`'s own ⚠️) can resume
  // AFTER a newer swap has already opened its own window: an epoch check alone can't tell the
  // two `doInit` calls' windows apart (the epoch only guards `swapInFlight`), so without the
  // identity check the stale call would consume the LIVE window's `landed` set for its own
  // report and null it out — silently disabling the current swap's #454 B reclassification.
  const myWindow = new Set<string>();
  windowLanded = myWindow;
  try {
    // The pre-window pending set — keys the pre-swap flush loop above genuinely failed to land
    // (rejected by the backend, or never attempted before it hit its cap). Captured AFTER
    // `flushTimer` is cleared and BEFORE the `await` below, so nothing can drain it out from
    // under us during the window (see the ⚠️ above `doInit`).
    const preWindowPending = queuedKeys().sort();   // #559 — see queuedKeys()
    const preWindowPendingSet = new Set(preWindowPending);

    let raw: Record<string, string>;
    try {
      // Everything up to here reads/writes only the OUTGOING `backend`/`namespace` — this is
      // the write-during-swap window (#438). `cache`/`dirty`/`hydrated` are untouched, so any
      // synchronous `set()`/`del()`/`clear()` racing this await lands in the outgoing store.
      raw = await nextBackend.getAll(prefix);
    } catch (err) {
      // Fail loud (owner ruling, #438): install the INCOMING namespace anyway, but leave it
      // explicitly unhydrated and empty — matches the pre-#438 failure shape, so
      // `agentBridge.ts`'s `prefsUnhydrated()` keeps refusing reads/writes for the new
      // namespace rather than silently answering out of the old game's store.
      const outgoingNamespace = namespace;
      const fullPending = queuedKeys().sort();   // #559 — see queuedKeys()
      const fullPendingSet = new Set(fullPending);
      const racedPending = fullPending.filter((k) => !preWindowPendingSet.has(k));
      backend = nextBackend;
      namespace = nextNamespace;
      cache.clear();
      dirty.clear();
      // #559 — describes the OUTGOING store, same as `dirty` above. ⚠️ DEFENSIVE, and NOT covered
      // by a test: the pre-swap flush loop above means the ledger is normally already empty by the
      // time this runs, so deleting this line leaves the whole suite green. It earns its place only
      // for a write dirtied DURING the swap's `getAll` await (the #438 race), where a batch can
      // still be settling at install. Kept because a stale entry here would report the OUTGOING
      // store's write as pending against the INCOMING one, which is the wrong answer to the
      // question `hasPendingWrite` asks.
      inFlight.clear();
      hydrated = false;
      // Close the landing-tracking window and reclassify (#454 B) — same shape as the
      // successful-install path below; see the comment there for the reasoning.
      const landed = windowLanded === myWindow ? myWindow : new Set<string>();
      if (windowLanded === myWindow) windowLanded = null;
      const preWindowStillPending = preWindowPending.filter((k) => fullPendingSet.has(k));
      const landedThenReSet = preWindowStillPending.filter((k) => landed.has(k));
      reportDiscarded(preWindowStillPending.filter((k) => !landed.has(k)));
      reportRaced([...racedPending, ...landedThenReSet].sort(), outgoingNamespace);
      throw err;
    }

    // Synchronous install — no `await` between here and `hydrated = true`, so there is no
    // window for a caller to observe a partially-swapped state. Capture whatever is STILL
    // pending against the outgoing store (the full pending set, including anything that raced
    // the await above) before `dirty.clear()` would otherwise discard it with nothing inspecting
    // it. The difference between this full set and `preWindowPending` is exactly the raced writes.
    //
    // ⚠️ Deliberately `dirty`-only, NOT anything wider. A `drain()` batch that is mid-flight at
    // this exact instant (taken out of `dirty` for its own `Promise.all`, not yet settled — see
    // `drain()`'s doc comment) is invisible here — which is exactly what `queuedKeys()` below
    // means, and why this reads it rather than `pendingKeys()`. ⚠️ This used to cite
    // `pendingKeys()`'s "authoritative only after an awaited flush" caveat; #559 deleted that
    // caveat (it reports in-flight writes now), so the pointer would land on text saying the
    // opposite. See `queuedKeys()`'s own doc for why the two are different questions. That write's eventual settlement is
    // NOT silently lost: `drain()` captures its own `batchNamespace`/`batchBackend` locals, so a
    // late SUCCESS lands durably in the outgoing store (nothing to report), and a late REJECTION
    // after this install has already swapped `namespace` away fires drain()'s own "already
    // swapped" `console.error` — see `drain()`'s catch branch. Folding that in-flight state into
    // THIS snapshot was tried (#438 round 4) and reported a write that goes on to succeed as
    // discarded — a false loss report; reverted.
    const outgoingNamespace = namespace;
    const fullPending = queuedKeys().sort();   // #559 — see queuedKeys()
    const fullPendingSet = new Set(fullPending);
    const racedPending = fullPending.filter((k) => !preWindowPendingSet.has(k));
    backend = nextBackend;
    namespace = nextNamespace;
    cache.clear();
    dirty.clear();
    inFlight.clear();   // #559 — see the identical clear on the failure path above, incl. why it
                        // is defensive and uncovered.
    // Populate from a freshly-cleared cache (not layered on top of whatever was already
    // there) — clearing immediately before repopulating from `raw` means a key that survived
    // in the old cache but is absent from the incoming namespace's `getAll` result cannot
    // leak through.
    for (const [full, str] of Object.entries(raw)) {
      if (readEnvelope(str) === undefined) continue; // skip corrupt entries
      cache.set(full.slice(prefix.length), str);
    }
    hydrated = true;
    // Close the landing-tracking window and reclassify (#454 B). Set membership alone (whether a
    // pre-window key is still in `fullPendingSet`) cannot distinguish a key that never landed from
    // one that landed durably during the window and was then RE-SET during it — both end up back in
    // the pending set, and the first pass here used to pass both to `reportDiscarded`. That's wrong
    // for the second case: the outgoing game's write did NOT fail, it was superseded by a later
    // write from the same outgoing game that then genuinely raced the swap install — the truth is
    // "raced", not "discarded". `windowLanded` (populated by `drain()` for exactly this window)
    // is what tells the two apart; membership can't. `discardedPending`/`fullPending` themselves are
    // UNCHANGED — they stay the install-time union, already correct — only the console attribution
    // below is reclassified.
    const landed = windowLanded === myWindow ? myWindow : new Set<string>();
    if (windowLanded === myWindow) windowLanded = null;
    const preWindowStillPending = preWindowPending.filter((k) => fullPendingSet.has(k));
    const landedThenReSet = preWindowStillPending.filter((k) => landed.has(k));
    reportDiscarded(preWindowStillPending.filter((k) => !landed.has(k)));
    reportRaced([...racedPending, ...landedThenReSet].sort(), outgoingNamespace);
    // The caller-visible "these writes are lost" list spans BOTH causes — see
    // `PlayerPrefsInitResult.discardedPending`'s doc comment.
    const discardedPending = fullPending;
    return { discardedPending };
  } finally {
    // Backstop only — both exit paths above already null this out via the identity check when
    // they run. This catches an unexpected throw elsewhere in the try block that neither exit
    // path handles, so it can't leak a window for the next `doInit` (real or stale-parked) to
    // inherit.
    if (windowLanded === myWindow) windowLanded = null;
  }
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

/** True for the duration of an in-flight `init()` swap — from the moment `doInit` starts until
 *  it settles (success OR throw). Distinct from `isHydrated()`: `hydrated` deliberately stays
 *  `true` for the whole swap window, describing the OUTGOING store (see `doInit`'s doc
 *  comment), so a caller cannot tell "no swap in progress" from "mid-swap" off `isHydrated()`
 *  alone. Exists so a caller like `agentBridge.ts`'s `player-prefs-write` op can refuse a write
 *  it knows the install is about to discard, rather than accept one that silently vanishes. */
function isSwapInFlight(): boolean {
  return swapInFlight;
}

/** An opaque, monotonically-increasing token — meaningless in absolute terms, never compare it to
 *  a literal. Its ONLY sanctioned use is capture-before-await / compare-after-await: a caller that
 *  is about to `await` something of its own (e.g. `agentBridge.ts`'s `player-prefs-write` op
 *  awaiting its own `flush()`) captures this beforehand, then after the await checks whether it's
 *  still the same value. A change means a swap window opened at some point during the await —
 *  including one that opened AND CLOSED entirely inside it, which `isSwapInFlight()` structurally
 *  cannot see (by the time the caller resumes, that flag is already back to `false`). #454 C is
 *  exactly this: a re-sampled `isSwapInFlight()` after the await is a SAMPLE, not a guarantee, and
 *  a swap that both starts and finishes inside the caller's own await defeats it; this counter
 *  catches that case because it never resets.
 *
 *  `resetPlayerPrefsForTest` also bumps it (see `swapToken`'s doc comment) — harmless here, since
 *  a caller comparing across a test-boundary reset is exactly the "something changed" signal this
 *  is for. */
function swapGeneration(): number {
  return swapToken.current;
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
 * So: `await flush()` then `hasPendingWrite(key)` is the only way to learn that it did not — and
 * since #559 ONE awaited flush is enough, because an in-flight write is still reported as pending.
 * A caller no longer needs to flush repeatedly to defeat a mid-drain sample.
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
  // #559 — the UNION of "queued" and "in flight". Reading `dirty` alone under-reported for the
  // whole duration of every batch; see `inFlight`'s own doc comment.
  return dirty.has(key) || inFlight.has(key);
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
 * ⚠️ **It no longer under-reports mid-drain (#559) — do not re-add that caveat.** This used to
 * read `dirty` alone, which `drain()` empties BEFORE awaiting the backend, so for the whole
 * duration of every batch each write in it reported as landed even though none had been accepted
 * and one might be about to be rejected. It now reads the union of `dirty` and the in-flight
 * ledger, so a write is pending from the moment it is queued until the backend settles it. Two
 * money defects came out of the old behaviour (Court #532 F17, #558); the game-side flush-until-
 * stable workaround could not close it either, because both of its samples can land mid-drain and
 * agree.
 *
 * ⚠️ `queuedKeys()` is the DIFFERENT question — "queued and never offered to a flush" — and the
 * swap-discard classification needs that one, not this. See its doc comment before using either.
 *
 * Same caveats as `hasPendingWrite` apply per-key: "pending" means "the backend has not
 * ACCEPTED it", not "it is unsynced to disk" — see that doc comment for what `flush()`
 * resolving does and doesn't guarantee.
 */
function pendingKeys(): string[] {
  // #559 — union, for the reason on `hasPendingWrite`. De-duplicated: a key re-set while its own
  // earlier write is still in flight is legitimately in BOTH sets, and must appear once.
  return [...new Set([...dirty, ...inFlight])];
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
  isSwapInFlight,
  swapGeneration,
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
  swapInFlight = false;
  windowLanded = null; // belt-and-braces, same reasoning as `doInit`'s `finally` above (#454 B)
  // Bump the token so a stale `doInit` left parked mid-`getAll` by a PRIOR test (see the ⚠️
  // above) can never clear `swapInFlight` out from under a swap the NEXT test genuinely
  // starts — its captured check from before this reset no longer passes. Test-isolation
  // only; see `swapToken`'s doc comment.
  swapToken.begin();
  cache.clear();
  dirty.clear();
  inFlight.clear();
  writeChain = Promise.resolve();
  initChain = Promise.resolve();
}
