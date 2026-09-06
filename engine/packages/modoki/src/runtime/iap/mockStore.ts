/**
 * A mock store for the editor and the browser — so purchase flows, entitlement-gated content and
 * the mandatory Restore button can be built and exercised without a device, a sandbox account, or
 * a console round trip.
 *
 * ── The hard constraint, and why it is not negotiable ──────────────────────────
 * **This can never be selected on a native platform.** `pickEditorStoreBackend()` checks
 * `Capacitor.isNativePlatform()` and hands back a real backend regardless of what the game asked
 * for, so no authored flag, config mistake or stale scene can ship a build that sells imaginary
 * goods. A fake that a phone could select is precisely how a game "works" everywhere except where
 * money changes hands.
 *
 * It is also never the silent default: `NoopStoreBackend` still is, and choosing this one is an
 * explicit, authored decision that announces itself in the console.
 *
 * ── It persists, and that is the whole point ───────────────────────────────────
 * The mock keeps its state in its OWN document, separate from the ledger. That is what makes the
 * crash matrix reproducible by hand: buy something with `failFinish` on, reload the editor, and
 * watch `reconcile()` recover it — the same path a force-close on a real phone takes, at the speed
 * of an editor reload rather than a device build. A mock that reset on reload could not show you
 * that, which is the one behaviour hardest to trust without seeing it.
 *
 * Determinism: transaction ids come from a persisted counter, never a clock or `Math.random()` —
 * `runtime/**` forbids both, and a reproducible id is more useful anyway.
 */

import { Capacitor } from '@capacitor/core';
import { NoopStoreBackend, type StoreBackend } from './storeBackend';
import type { IapProduct, IapProductInfo, StoreTransaction } from './types';
import {
  classifyFormatVersion,
  isReadable,
  preservedVersion,
  collectUnknownFields,
  mergeUnknownFields,
} from '../core/formatVersion';

/** The same structural persistence shape the ledger uses — satisfied by `createPrefsDocStore`. */
export interface MockStoreStore {
  read(): unknown;
  write(doc: unknown): void;
  flush(): Promise<void>;
}

/** FORMAT version of the persisted mock-store document. Named for the same reason
 *  `LEDGER_FORMAT_VERSION` is — see `docs/format-versioning.md` § 2b. */
export const MOCK_STORE_FORMAT_VERSION = 1;

/** Lowest version this build will read. See `MIN_READABLE_LEDGER_VERSION`. */
export const MIN_READABLE_MOCK_STORE_VERSION = 1;

/** The fields this build owns; everything else is preserved verbatim. */
const KNOWN_MOCK_KEYS = ['v', 'seq', 'paid', 'finished', 'acknowledged'] as const;

interface MockDoc {
  /** `number`, not the literal `1` — a document read back from storage may have been written
   *  by a different build. Same reasoning as `LedgerDoc.v`. */
  v: number;
  seq: number;
  /** Everything ever "paid for". */
  paid: StoreTransaction[];
  /** Transaction ids the app has finished. */
  finished: string[];
  acknowledged: string[];
  /** Keys a NEWER build wrote that this one does not understand, carried through untouched.
   *  Absent rather than `{}` when there is nothing unknown. Never itself written as a key. */
  unknownFields?: Record<string, unknown>;
}

function emptyDoc(): MockDoc {
  return { v: MOCK_STORE_FORMAT_VERSION, seq: 0, paid: [], finished: [], acknowledged: [] };
}

/**
 * Parse the stored document. Same defect and same fix as `ledger.ts`'s `parse` (#767): this was
 * `d.v !== 1 || !Array.isArray(d.paid)`, which collapsed all four verdicts onto "discard the whole
 * document" and fused the version gate with shape validation so a caller could not tell them apart.
 *
 * Lower stakes than the ledger — this is the editor/off-device mock and no real money moves
 * through it — but it is fixed identically on purpose. The whole point of the shared classifier
 * is that the same document question does not get two different answers depending on how important
 * the document looked to whoever was passing.
 */
function parse(raw: unknown): MockDoc {
  const verdict = classifyFormatVersion(raw, MOCK_STORE_FORMAT_VERSION, {
    field: 'v',
    minReadable: MIN_READABLE_MOCK_STORE_VERSION,
  });
  if (!isReadable(verdict) && verdict.kind !== 'too-new') return emptyDoc();

  const d = raw as Partial<MockDoc>;
  if (!Array.isArray(d.paid)) return emptyDoc();

  const unknownFields = collectUnknownFields(raw, KNOWN_MOCK_KEYS);
  return {
    v: preservedVersion(verdict, MOCK_STORE_FORMAT_VERSION),
    seq: typeof d.seq === 'number' ? d.seq : 0,
    paid: d.paid,
    finished: Array.isArray(d.finished) ? d.finished : [],
    acknowledged: Array.isArray(d.acknowledged) ? d.acknowledged : [],
    ...(unknownFields ? { unknownFields } : {}),
  };
}

/** This build's fields, with preserved unknown keys spread UNDER them so a known key always
 *  wins. `unknownFields` is a parse-time construct and is never itself written. */
function serialize(doc: MockDoc): Record<string, unknown> {
  const { unknownFields, ...known } = doc;
  return mergeUnknownFields(known, unknownFields);
}

export interface MockStoreOptions {
  store: MockStoreStore;
  /** The catalog — the mock needs kinds to answer `entitlements()` the way a real store would. */
  products: readonly IapProduct[];
  /**
   * Initial value for `failFinish` — see the property.
   *
   * ⚠️ **No game currently passes this.** It was introduced as an Inspector-authored switch on
   * `iap-test`, and that trait field is gone: the fixture replaced it with an interruption harness
   * that decorates whatever backend `pickStoreBackend()` returned, so it holds the REAL store as
   * well as the mock (`games/iap-test/runtime/interrupt.ts`; see docs/iap.md § Testing).
   *
   * Kept as a library affordance for a game that wants the mock-only version without a harness of
   * its own — but the comment that used to justify it as "reachable from the Inspector" was left
   * vouching for wiring that no longer exists, which is the failure this subsystem keeps having.
   */
  failFinish?: boolean;
}

export class MockStoreBackend implements StoreBackend {
  readonly available = true;

  /**
   * Make `finish()` throw — the switch that reproduces the interesting crash window live.
   *
   * With it on, a purchase is granted and persisted but the store keeps handing it back, exactly
   * as it would after a force-close. Reload the editor and `reconcile()` should credit it once,
   * not twice. Mutable so it can be toggled between purchases from a debug control.
   */
  failFinish = false;

  /** Simulate the pending state (Ask-to-Buy, cash payment) — granted by nothing until approved. */
  nextPurchasePending = false;

  private doc: MockDoc;
  private readonly store: MockStoreStore;
  private readonly kinds: Map<string, IapProduct>;

  constructor(opts: MockStoreOptions) {
    this.store = opts.store;
    this.doc = parse(opts.store.read());
    this.kinds = new Map(opts.products.map((p) => [p.id, p]));
    this.failFinish = opts.failFinish ?? false;
    console.warn('[iap] MOCK STORE ACTIVE — purchases are simulated and no money moves. '
      + 'This backend cannot be selected on a device.');
  }

  private persist(): void { this.store.write(serialize(this.doc)); }

  async products(ids: readonly string[]): Promise<IapProductInfo[]> {
    return ids.filter((id) => this.kinds.has(id)).map((id) => ({
      id,
      displayPrice: '¥000 (mock)',
      title: `${id} (mock)`,
      description: 'Simulated product — the mock store is active.',
    }));
  }

  async purchase(productId: string): Promise<StoreTransaction | null> {
    if (!this.kinds.has(productId)) {
      console.warn(`[iap:mock] "${productId}" is not in the catalog — the real store would return nothing too.`);
      return null;
    }
    const tx: StoreTransaction = {
      transactionId: `mock-${++this.doc.seq}`,
      productId,
      ...(this.nextPurchasePending ? { pending: true } : {}),
    };
    this.doc.paid.push(tx);
    this.persist();
    return tx;
  }

  async unfinished(): Promise<StoreTransaction[]> {
    return this.doc.paid.filter((t) => !this.doc.finished.includes(t.transactionId));
  }

  async entitlements(): Promise<StoreTransaction[]> {
    // A real store reports owned non-consumables and ACTIVE subscriptions, whether or not the app
    // has finished them. Consumables are never entitlements — they are spent, not owned.
    return this.doc.paid.filter((t) => {
      if (t.pending) return false;
      const kind = this.kinds.get(t.productId)?.kind;
      return kind === 'non-consumable' || kind === 'subscription';
    });
  }

  async finish(tx: StoreTransaction): Promise<void> {
    if (this.failFinish) throw new Error('[iap:mock] failFinish is on — simulating a kill before the finish landed.');
    if (!this.doc.finished.includes(tx.transactionId)) {
      this.doc.finished.push(tx.transactionId);
      this.persist();
    }
  }

  async acknowledge(tx: StoreTransaction): Promise<void> {
    if (!this.doc.acknowledged.includes(tx.transactionId)) {
      this.doc.acknowledged.push(tx.transactionId);
      this.persist();
    }
  }

  /** Wipe the simulated store. Note this does NOT clear the ledger — clearing one and not the
   *  other is itself a useful state to test, since it is what a reinstall looks like. */
  reset(): void {
    this.doc = emptyDoc();
    this.persist();
  }
}

export interface PickStoreBackendOptions extends MockStoreOptions {
  /** Author's intent for the EDITOR/browser. Ignored entirely on a device — see the header. */
  useMock: boolean;
}

/**
 * Choose the backend for the current platform.
 *
 * ⚠️ **`useMock` is advisory, not authoritative.** On a native platform this returns the REAL
 * store no matter what was authored, which is what makes the mock safe to leave switched on in a
 * committed scene: no scene edit, config mistake or stale field can ship a build that sells
 * imaginary goods.
 *
 * Async because deciding whether a device can actually sell anything requires asking it — the
 * native plugin may not be installed in this project at all (`capacitor-modoki-iap` is an opt-in
 * dependency, since that is what governs whether StoreKit / Play Billing ship), and billing can be
 * unavailable on a managed or restricted device. Both answer `false` and fall back to a noop that
 * says so, rather than surfacing later as an unexplained rejection inside a purchase.
 */
export async function pickStoreBackend(opts: PickStoreBackendOptions): Promise<StoreBackend> {
  if (Capacitor.isNativePlatform()) {
    // Lazy, and type-only at compile time — the engine never takes a runtime dependency on the
    // plugin, so a game without it still builds and runs.
    const { CapacitorStoreBackend } = await import('./capacitorStore');
    if (await CapacitorStoreBackend.probeAvailable()) {
      return new CapacitorStoreBackend(opts.products);
    }
    console.warn('[iap] Billing is not available on this device — nothing is for sale. '
      + 'Either the project does not depend on `capacitor-modoki-iap`, or the store is '
      + 'unreachable (no Play Store, or a restricted/managed device).');
    return new NoopStoreBackend();
  }
  if (!opts.useMock) return new NoopStoreBackend();
  return new MockStoreBackend(opts);
}
