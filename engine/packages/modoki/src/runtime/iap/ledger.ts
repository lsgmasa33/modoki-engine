/**
 * The purchase ledger — durable, idempotent, and the reason a re-delivered transaction credits a
 * player once instead of twice.
 *
 * ── What it is actually for ────────────────────────────────────────────────────
 * It is **not** the record of what the player owns. Subscriptions and non-consumables are
 * re-derived from the store on every launch (see `types.ts` → `ProductKind`), because the store
 * answers that question better than we ever could and survives a reinstall doing it.
 *
 * The ledger exists for exactly two jobs the store cannot do:
 *
 *  1. **Idempotency.** `processed` is the set of transaction ids already granted. The crash window
 *     "granted durably, not yet finished" causes the store to re-deliver on the next launch, and
 *     without this set a coin pack would be credited again every single launch until the finish
 *     landed. Cheap insurance against the most expensive kind of bug — the one that mints currency.
 *  2. **Consumable balances.** A consumable is forgotten by the store the instant it is consumed,
 *     so its grant lives here or nowhere.
 *
 * ── Persistence is INJECTED, and that is a layering decision, not a preference ──
 * `runtime/iap/` is an L2 subsystem and `runtime/storage/` (PlayerPrefs) is another, so importing
 * it directly would violate the layer contract (docs/architecture-layers.md). The dependency is
 * inverted instead: this file declares the tiny `IapLedgerStore` shape it needs, and L3 wires
 * PlayerPrefs into it.
 *
 * That constraint made the design better rather than worse — an injected store is exactly what
 * Phase 2's crash matrix needs, because a fake can be told to drop a write, which is how the
 * "durable" half of "grant durably, then finish" gets tested at all.
 */

import {
  classifyFormatVersion,
  isReadable,
  preservedVersion,
  collectUnknownFields,
  mergeUnknownFields,
} from '../core/formatVersion';

/**
 * The persistence shape the ledger needs. Deliberately the same get/set/flush contract PlayerPrefs
 * already offers, so the L3 adapter that wires them together is three lines and can't introduce
 * behaviour of its own.
 */
export interface IapLedgerStore {
  /** The stored document, or `undefined` on first run / unreadable data. Must never throw. */
  read(): unknown;
  /** Stage a write. May be cached in memory; `flush` is what pushes it down. */
  write(doc: unknown): void;
  /** Resolve once the staged write has been handed to the platform. */
  flush(): Promise<void>;
  /**
   * OPTIONAL, and load-bearing where it exists: did the staged write actually reach the backing
   * store? Distinct from reading it back, which an optimistic in-memory cache satisfies whether or
   * not the write landed. A store that cannot tell omits it, and `confirmDurable` then falls back
   * to the read-back alone — weaker, but no weaker than before.
   */
  durable?(): boolean;
}

/** One granted transaction. `seq` orders entries for eviction — insertion order can't be used,
 *  because iOS transaction ids are integer-like strings and JS object key order reshuffles those. */
interface ProcessedEntry {
  productId: string;
  seq: number;
  /** True once the store has been told (`finish`) and can no longer re-deliver it. Only finished
   *  entries are ever evicted. */
  finished: boolean;
}

/** FORMAT version of the persisted ledger document. Named, because a bare `1` gives a reader
 *  nothing to compare against and a reviewer nothing to find — the precondition every unfixed
 *  row of `docs/format-versioning.md` § 3 shared (#767). */
export const LEDGER_FORMAT_VERSION = 1;

/** Lowest version this build will read. Equal to the current one today: `v: 1` is the only
 *  version ever written, so anything below it predates the format entirely. Separate from the
 *  constant above so a future bump does not silently become a floor bump too. */
export const MIN_READABLE_LEDGER_VERSION = 1;

/** The fields this build owns. Anything else in the stored document is preserved verbatim —
 *  see `unknownFields`. */
const KNOWN_LEDGER_KEYS = ['v', 'seq', 'processed', 'consumables'] as const;

interface LedgerDoc {
  /** ⚠️ `number`, not the literal `1`. A type describing a document read back from STORAGE must
   *  not pin its version literal — the bytes may have been written by a different build, and
   *  pinning is what let `parse` treat "newer" as "invalid" (#767, same shape as #734). */
  v: number;
  seq: number;
  processed: Record<string, ProcessedEntry>;
  /** productId → units held. Consumables only. */
  consumables: Record<string, number>;
  /** Top-level keys a NEWER build wrote that this one does not understand, carried through
   *  untouched so an old build reading a new document does not silently strip it (the additive
   *  rule — owner, 2026-09-05). Absent rather than `{}` when there is nothing unknown, so an
   *  ordinary document's serialized shape is unchanged. Never itself written as a key. */
  unknownFields?: Record<string, unknown>;
}

/**
 * Cap on retained `processed` entries. Only **finished** entries are evicted (oldest first) — an
 * unfinished one is precisely what re-delivery will hand back, so evicting it would reintroduce the
 * double-grant this table exists to prevent.
 *
 * 1000 is enormous headroom: the store rarely holds more than a handful of unfinished transactions
 * at once, so this bounds a multi-year buying history at a few tens of KB without ever touching an
 * entry that could still matter.
 */
const MAX_PROCESSED = 1000;

function emptyDoc(): LedgerDoc {
  return { v: LEDGER_FORMAT_VERSION, seq: 0, processed: {}, consumables: {} };
}

/**
 * Parse whatever came back from storage, failing soft. A corrupt ledger reads as an EMPTY ledger,
 * never a throw — the recovery path then re-grants from the store's own unfinished list, which is
 * the correct repair. Throwing here would brick a launch over a bad byte.
 *
 * ⚠️ **This used to be `if (d.v !== 1) return emptyDoc()` — exact equality (#767).** That mapped
 * *too-new*, *too-old*, *absent* and *unreadable* onto one action, and that action **emptied
 * `processed`** — the idempotency table, i.e. the only thing standing between a re-delivered
 * purchase and a duplicate credit. A `v: 2` document written by a newer build was not merely
 * stripped of unknown fields; every already-granted transaction read as ungranted, and the next
 * `record()`/`settle()` wrote `{v: 1, …}` straight over it. The gate was also `||`-fused with
 * shape validation, so a caller could not tell a version refusal from a corrupt payload.
 *
 * The disposition for this document is **PRESERVE**, not REFUSE (`docs/format-versioning.md`
 * § 2b-bis): it holds the player's own purchases, so refusing to read it loses their entitlements.
 * Verdict by verdict:
 *
 *  - `ok` / `too-new` — read the known fields, bag the rest, and keep the higher version on
 *    write-back. A newer document is readable *because* the format is additive.
 *  - `absent` — readable, per § 2a. This build has always stamped `v`, so a version-less document
 *    is foreign or damaged; it is still gated by the `processed` shape check below, and reading it
 *    is the safer error, because the harm of wrongly emptying this table is minting currency.
 *  - `too-old` / `unreadable` — empty ledger. A malformed version is damaged data, and normalizing
 *    it is correct.
 *
 * ⚠️ **The `Math.max` write-back is safe HERE and that was checked, not assumed.** #763's
 * close-out caught that rule transferring wrongly onto a document with a version-GATED field
 * (`readProgress` keeps `activeGuid` only when the version is readable, so preserving the higher
 * `v` made the document claim semantics the writing build did not implement). Audited: `seq`,
 * `processed` and `consumables` are each normalized unconditionally, with no field kept or dropped
 * on the strength of `v`. Re-do this audit if one is ever added.
 */
function parse(raw: unknown): LedgerDoc {
  const verdict = classifyFormatVersion(raw, LEDGER_FORMAT_VERSION, {
    field: 'v',
    minReadable: MIN_READABLE_LEDGER_VERSION,
  });
  if (!isReadable(verdict) && verdict.kind !== 'too-new') return emptyDoc();

  const d = raw as Partial<LedgerDoc>;
  // Shape validation stays SEPARATE from the version verdict — fusing them with `||` is what made
  // the two failures indistinguishable to the caller.
  if (typeof d.processed !== 'object' || !d.processed) return emptyDoc();

  const unknownFields = collectUnknownFields(raw, KNOWN_LEDGER_KEYS);
  return {
    v: preservedVersion(verdict, LEDGER_FORMAT_VERSION),
    seq: typeof d.seq === 'number' && Number.isFinite(d.seq) ? d.seq : 0,
    processed: d.processed as Record<string, ProcessedEntry>,
    consumables: (typeof d.consumables === 'object' && d.consumables ? d.consumables : {}) as Record<string, number>,
    ...(unknownFields ? { unknownFields } : {}),
  };
}

/** The bytes to persist: this build's fields, with any preserved unknown keys spread back
 *  UNDER them so a key this build owns always wins over a stale copy in the bag. `unknownFields`
 *  is a parse-time construct and is never itself written. */
function serialize(doc: LedgerDoc): Record<string, unknown> {
  const { unknownFields, ...known } = doc;
  return mergeUnknownFields(known, unknownFields);
}

export class IapLedger {
  private doc: LedgerDoc;
  private readonly store: IapLedgerStore;

  constructor(store: IapLedgerStore) {
    this.store = store;
    this.doc = parse(store.read());
  }

  /** Has this transaction already been granted? The idempotency check, and the only thing standing
   *  between a re-delivered purchase and a duplicate credit. */
  isProcessed(transactionId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.doc.processed, transactionId);
  }

  /**
   * Record a grant. **Idempotent** — calling it twice for the same transaction credits once, which
   * is what makes the recovery path safe to run unconditionally on every launch. Returns whether
   * this call was the one that actually granted.
   *
   * Staged only; nothing is durable until `flush()` resolves.
   */
  recordGrant(transactionId: string, productId: string, consumableUnits: number): boolean {
    if (this.isProcessed(transactionId)) return false;
    this.doc.processed[transactionId] = { productId, seq: ++this.doc.seq, finished: false };
    if (consumableUnits > 0) {
      this.doc.consumables[productId] = (this.doc.consumables[productId] ?? 0) + consumableUnits;
    }
    this.evict();
    this.store.write(serialize(this.doc));
    return true;
  }

  /** Note that the store has been told. Enables eviction of this entry and nothing else — the
   *  grant itself is already recorded and must never be undone here. */
  markFinished(transactionId: string): void {
    const e = this.doc.processed[transactionId];
    if (!e || e.finished) return;
    e.finished = true;
    this.store.write(serialize(this.doc));
  }

  balanceOf(productId: string): number {
    return this.doc.consumables[productId] ?? 0;
  }

  /** Spend consumable units. Returns false (and spends nothing) if the balance is short — a
   *  partial spend would be a silent loss of the player's money. */
  spend(productId: string, units: number): boolean {
    if (units <= 0) return false;
    const have = this.balanceOf(productId);
    if (have < units) return false;
    this.doc.consumables[productId] = have - units;
    this.store.write(serialize(this.doc));
    return true;
  }

  /** Resolve once the staged document has reached the platform. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  /**
   * Re-read through the store and confirm the transaction survived the round trip.
   *
   * ⚠️ **Be precise about what this proves.** It confirms the document serialized and was ACCEPTED
   * by the persistence layer — it catches a quota rejection, a serialization failure, and a value
   * the backing store silently skipped. It does **not** prove the bytes reached the disk platter:
   * `@capacitor/preferences` uses Android's `SharedPreferences.apply()`, which is async-to-disk, so
   * an awaited flush is not an fsync (see docs/player-prefs.md).
   *
   * That residual window is the accepted cost of serverless verification, recorded in #196 rather
   * than papered over. The check is still worth making — the failure modes it *does* catch are
   * silent ones, and the alternative is finishing a transaction against a write that never landed.
   */
  confirmDurable(transactionId: string): boolean {
    // ⚠️ **The read-back ALONE is a false positive, and this is the bug that matters most in the
    // whole subsystem.** PlayerPrefs writes into an in-memory cache and queues the real write; a
    // rejected backend write (quota exceeded, a native I/O error) is caught, re-queued and warned
    // about, `flush()` still settles fulfilled, and `get()` keeps serving the cached value. So the
    // check below re-read the very cache that the failed write had already updated and could not
    // fail — for exactly the failure modes its own doc-comment claimed to catch.
    //
    // The consequence was the one invariant 1 exists to prevent: `settle()` reads "durable", calls
    // `finish()` — the irreversible step — and the store stops re-delivering a purchase whose
    // record vanishes on the next launch. The player's money, with no recovery path.
    //
    // So ask the store whether the write was ACCEPTED, when it can answer.
    if (this.store.durable && !this.store.durable()) return false;

    const fresh = parse(this.store.read());
    return Object.prototype.hasOwnProperty.call(fresh.processed, transactionId);
  }

  /** Evict finished entries beyond the cap, oldest `seq` first. Unfinished entries are untouchable. */
  private evict(): void {
    const ids = Object.keys(this.doc.processed);
    if (ids.length <= MAX_PROCESSED) return;
    const finished = ids
      .filter((id) => this.doc.processed[id].finished)
      .sort((a, b) => this.doc.processed[a].seq - this.doc.processed[b].seq);
    let over = ids.length - MAX_PROCESSED;
    for (const id of finished) {
      if (over <= 0) break;
      delete this.doc.processed[id];
      over--;
    }
  }
}
