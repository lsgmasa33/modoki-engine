/**
 * A single-document view over [PlayerPrefs](../../../../../../docs/player-prefs.md) — one key, read /
 * write / flush.
 *
 * ── Why this exists in `storage/` rather than next to its consumer ─────────────
 * The IAP ledger needs durable persistence, but `runtime/iap/` and `runtime/storage/` are both L2
 * subsystems and L2 may not import L2 (docs/architecture-layers.md). Rather than declare an
 * exception, the dependency is inverted through **structural typing**: this returns a plain
 * `{ read, write, flush }` object, and `iap/ledger.ts` declares the identical shape as its own
 * `IapLedgerStore` interface. Neither folder imports the other and no edge exists at all — the
 * caller (a game's `setup.ts`, or app composition) hands one to the other.
 *
 * It is deliberately generic. Nothing here knows what a purchase is, so any subsystem that wants
 * one durable JSON document can use it, and the ledger's persistence stays swappable for a test
 * fake without a seam of its own.
 */

import { PlayerPrefs } from './playerPrefs';

export interface PrefsDocStore {
  read(): unknown;
  write(doc: unknown): void;
  flush(): Promise<void>;
  /** False when the last write was rejected by the backing store and re-queued — see the
   *  implementation note below. Reading it back is NOT sufficient to know. */
  durable(): boolean;
}

/**
 * A read/write/flush handle on one PlayerPrefs key.
 *
 * Inherits PlayerPrefs' guarantees and its one limit exactly: the write is atomic per key and
 * never tears, but `flush()` resolving is **not** a hard fsync on Android (`SharedPreferences`
 * uses `apply()`, which is async-to-disk). A consumer for which that gap matters — the purchase
 * ledger is the one that does — must account for it rather than assume durability. See
 * docs/player-prefs.md § Gotchas and issue #196.
 */
export function createPrefsDocStore(key: string): PrefsDocStore {
  return {
    read: () => PlayerPrefs.get(key),
    write: (doc) => { PlayerPrefs.set(key, doc as never); },
    flush: () => PlayerPrefs.flush(),
    // ⚠️ **Reading the document back does NOT prove it was stored.** `PlayerPrefs.set()` writes
    // into an in-memory cache and queues the backend write; if that write is rejected (quota, a
    // native I/O error) `drain()` re-queues it, warns, and lets `flush()` settle fulfilled anyway
    // — while `get()` keeps returning the cached value. A read-back check therefore confirms
    // itself. The pending-write flag is the only signal that distinguishes the two.
    //
    // ⚠️ **A PROTECTED key is a second, distinct way to be non-durable, and `hasPendingWrite`
    // alone cannot see it (#630 review finding 2).** `PlayerPrefs.set()` on a key holding a save
    // this build cannot read REFUSES the write outright — it never touches `cache`, `dirty` or
    // the in-flight ledger — so `hasPendingWrite(key)` is `false` for a write that never
    // happened, and this would report `true`. There genuinely is no pending write to report; the
    // honest fix is here, not in `hasPendingWrite`: a document this store could not write is not
    // durable, whichever of the two reasons is why.
    durable: () => !PlayerPrefs.hasPendingWrite(key) && !PlayerPrefs.isProtected(key),
  };
}
