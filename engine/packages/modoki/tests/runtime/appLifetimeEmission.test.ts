/** #1527 — an app-lifetime mark on ONE emission, for a type the boot and the scene both emit.
 *
 *  Court's price fetch is one: the IAP boot asks once, and every board build past the ad unlock asks
 *  again. A take recorded on a later Play of the editor has only the board builds' answers, while
 *  its replay boots a fresh page and has the boot's too — observed as `diverged`,
 *  `court.store.products` 1x played and 2x replayed. Declaring the TYPE (#1524's tool) would also
 *  stop counting the board builds', so the boot marks its own emissions instead, and every layer
 *  between the emit and the replay check has to carry the mark. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { emit, journalEvents, appLifetimeEventTypes } from '../../src/runtime/core/journal';
import { journalState, journalWarn } from '../../src/runtime/core/gameJournal';
import { TakeJournalTap } from '../../src/runtime/core/takeJournal';
import { createTestWorld, type TestWorld } from '../../src/runtime';
import {
  configureIap, resetIap, reconcile, restorePurchases,
  type StoreBackend, type StoreTransaction, type IapLedgerStore, type IapProductInfo,
} from '../../src/runtime/iap';

const worlds: World[] = [];
const world = () => { const w = createWorld(); worlds.push(w); return w; };
afterEach(() => { while (worlds.length) worlds.pop()!.destroy(); });

describe('the journal carries a per-emission mark', () => {
  it('emit marks only the emission it was asked to, and leaves the key off every other', () => {
    const w = world();
    emit('court.store.products', { where: 'no-ads-offer' }, w, 'info', { appLifetime: true });
    emit('court.store.products', { where: 'no-ads-offer' }, w);
    emit('court.store.products', { where: 'no-ads-offer' }, w, 'info', { appLifetime: false });
    const events = journalEvents({ type: 'court.store.products' }, w);
    expect(events.map((e) => e.appLifetime)).toEqual([true, undefined, undefined]);
    expect(Object.hasOwn(events[1], 'appLifetime')).toBe(false);
  });

  it('the game journal helpers pass it through', () => {
    const w = world();
    journalState('s', null, w, { appLifetime: true });
    journalWarn('w', null, w, { appLifetime: true });
    journalState('plain', null, w);
    expect(journalEvents(undefined, w).map((e) => [e.type, e.appLifetime])).toEqual([['s', true], ['w', true], ['plain', undefined]]);
  });

  it('the take tap keeps the mark, and adds none', () => {
    const w = world();
    const tap = new TakeJournalTap();
    emit('court.store.products', { summary: '6/6' }, w, 'info', { appLifetime: true });
    emit('court.store.products', { summary: '6/6' }, w);
    const drained = tap.drain(w);
    expect(drained.map((e) => e.appLifetime)).toEqual([true, undefined]);
    expect(Object.hasOwn(drained[1], 'appLifetime')).toBe(false);
  });
});

class MemStore implements IapLedgerStore {
  doc: unknown;
  read(): unknown { return this.doc; }
  write(d: unknown): void { this.doc = JSON.parse(JSON.stringify(d)); }
  async flush(): Promise<void> {}
  durable(): boolean { return true; }
}

/** One unfinished transaction, so a reconcile journals `iap.reconcile`; `failUnfinished` for its twin. */
class OnePending implements StoreBackend {
  readonly available = true;
  failUnfinished = false;
  failEntitlements = false;
  finished: string[] = [];
  async products(ids: readonly string[]): Promise<IapProductInfo[]> {
    return ids.map((id) => ({ id, displayPrice: '$1', title: id, description: '' }));
  }
  async purchase(): Promise<null> { return null; }
  async unfinished(): Promise<StoreTransaction[]> {
    if (this.failUnfinished) throw new Error('simulated query failure');
    return [{ transactionId: 'tx-1', productId: 'coins' }].filter((t) => !this.finished.includes(t.transactionId));
  }
  async entitlements(): Promise<StoreTransaction[]> {
    if (this.failEntitlements) throw new Error('simulated entitlement failure');
    return [];
  }
  async finish(tx: StoreTransaction): Promise<void> { this.finished.push(tx.transactionId); }
  async acknowledge(): Promise<void> {}
}

describe('the IAP recovery pass marks its lines only when the boot runs it', () => {
  let tw: TestWorld;
  let backend: OnePending;
  const IAP_TYPES = ['iap.entitlements', 'iap.entitlements-failed', 'iap.reconcile', 'iap.reconcile-failed'];
  const marks = () => journalEvents(undefined, tw.world)
    .filter((e) => IAP_TYPES.includes(e.type)).map((e) => [e.type, e.appLifetime === true]);

  function launch(): void {
    tw = createTestWorld();
    resetIap();
    backend = new OnePending();
    configureIap({ backend, store: new MemStore(), products: [{ id: 'coins', kind: 'consumable', grant: 1 }] });
  }
  afterEach(() => { resetIap(); tw.dispose(); });

  it('reconcile({ atBoot: true }) marks the entitlement read and the pending count', async () => {
    launch();
    await reconcile({ atBoot: true });
    expect(marks()).toEqual([['iap.entitlements', true], ['iap.reconcile', true]]);
  });

  it('Restore Purchases runs the same pass UNmarked, so the replay check counts a restore', async () => {
    launch();
    await restorePurchases();
    expect(marks()).toEqual([['iap.entitlements', false], ['iap.reconcile', false]]);
  });

  it('the boot pass marks its failures too', async () => {
    launch();
    backend.failUnfinished = true;
    await reconcile({ atBoot: true });
    expect(marks()).toEqual([['iap.entitlements', true], ['iap.reconcile-failed', true]]);
  });

  it('the boot pass marks a failed entitlement read, and a restore\'s stays unmarked', async () => {
    launch();
    backend.failEntitlements = true;
    await reconcile({ atBoot: true });
    await restorePurchases();
    expect(marks().filter(([t]) => t === 'iap.entitlements-failed')).toEqual([['iap.entitlements-failed', true], ['iap.entitlements-failed', false]]);
  });

  it('the entitlement and reconcile types are no longer declared whole; iap.not-configured is', () => {
    // Declared whole, a restore's lines would be skipped with the boot's (#1524's caveat).
    expect(appLifetimeEventTypes()).not.toEqual(expect.arrayContaining(['iap.entitlements']));
    expect(appLifetimeEventTypes()).not.toEqual(expect.arrayContaining(['iap.entitlements-failed']));
    expect(appLifetimeEventTypes()).not.toEqual(expect.arrayContaining(['iap.reconcile-failed']));
    expect(appLifetimeEventTypes()).toContain('iap.not-configured');
  });
});
