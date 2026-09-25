/** #925 — the store screen's stateful guards, promoted from Court. Each case drives the race its
 *  field exists for, with the purchase and price promises held open by hand. */

import { describe, it, expect, vi } from 'vitest';
import { ShelfSession, type ShelfTimers } from '../../src/runtime/iap/shelfSession';
import type { IapProductInfo, PurchaseResult } from '../../src/runtime/iap/types';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Timers that fire only when told to. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: ShelfTimers = {
    set: (fn) => { const h = next++; pending.set(h, fn); return h; },
    clear: (h) => { pending.delete(h as number); },
  };
  return { timers, fireAll: () => { for (const [h, fn] of [...pending]) { pending.delete(h); fn(); } }, count: () => pending.size };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function info(id: string, displayPrice: string): IapProductInfo {
  return { id, displayPrice } as IapProductInfo;
}

function granted(productId: string): PurchaseResult {
  return { outcome: 'granted', productId } as PurchaseResult;
}

function make(over: Partial<ConstructorParameters<typeof ShelfSession>[0]> = {}) {
  const t = manualTimers();
  const purchases = new Map<string, ReturnType<typeof deferred<PurchaseResult>>>();
  const priceCalls: Array<ReturnType<typeof deferred<readonly IapProductInfo[]>>> = [];
  const onChange = vi.fn();
  const session = new ShelfSession<'store' | 'shortfall'>({
    purchase: (id) => { const d = deferred<PurchaseResult>(); purchases.set(id, d); return d.promise; },
    productInfo: () => { const d = deferred<readonly IapProductInfo[]>(); priceCalls.push(d); return d.promise; },
    onChange,
    timers: t.timers,
    ...over,
  });
  return { session, t, purchases, priceCalls, onChange };
}

const ROW = { show: true, title: '300 Coins' };

describe('prices and the open question', () => {
  it('open drops prices, shows loading, and a current answer lands the shelf with trimmed prices', async () => {
    const answered = vi.fn();
    const { session, priceCalls } = make({ onPricesAnswered: answered });
    session.open('store');
    expect(session.state).toEqual({ kind: 'loading' });
    expect(session.pricesAnswered(0)).toBe(false);
    priceCalls[0]!.resolve([info('a', ' $1 '), info('b', '  ')]);
    await flush();
    expect(session.state).toEqual({ kind: 'shelf' });
    expect([...session.prices]).toEqual([['a', '$1']]);
    expect(session.pricesAnswered(0)).toBe(true);
    expect(answered).toHaveBeenCalledWith({ where: 'store', priced: 1, failed: false, atBoot: false });
  });

  it('a failed fetch is still an answer, and is reported', async () => {
    const failed = vi.fn();
    const { session, priceCalls } = make({ onPricesFailed: failed });
    session.open('store');
    priceCalls[0]!.reject(new Error('offline'));
    await flush();
    expect(session.pricesAnswered(1e9)).toBe(true);
    expect(session.prices.size).toBe(0);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('refreshPrices hands the boot\'s origin back to both price hooks, and only for that fetch (#1527)', async () => {
    const answered = vi.fn();
    const failed = vi.fn();
    const { session, priceCalls } = make({ onPricesAnswered: answered, onPricesFailed: failed });
    session.refreshPrices('store', { atBoot: true });
    priceCalls[0]!.reject(new Error('offline'));
    await flush();
    expect(failed).toHaveBeenLastCalledWith(expect.any(Error), 'store', true);
    expect(answered).toHaveBeenLastCalledWith({ where: 'store', priced: 0, failed: true, atBoot: true });
    session.refreshPrices('shortfall');
    priceCalls[1]!.resolve([info('a', '$1')]);
    await flush();
    expect(answered).toHaveBeenLastCalledWith({ where: 'shortfall', priced: 1, failed: false, atBoot: false });
    session.open('store');
    priceCalls[2]!.reject(new Error('offline'));
    await flush();
    expect(failed).toHaveBeenLastCalledWith(expect.any(Error), 'store', false);
  });

  it('a SUPERSEDED fetch cannot answer for a newer open', async () => {
    const { session, priceCalls } = make();
    session.open('store');
    session.open('store');
    priceCalls[0]!.resolve([info('a', '$1')]);
    await flush();
    expect(session.pricesAnswered(0)).toBe(false);
    expect(session.state).toEqual({ kind: 'loading' });
    priceCalls[1]!.resolve([info('b', '$2')]);
    await flush();
    expect([...session.prices.keys()]).toEqual(['b']);
  });

  it('idle waits for the backstop; pending is never cut off by it (#463)', () => {
    const { session } = make();
    expect(session.pricesAnswered(500)).toBe(false);
    session.tickIdle(499);
    expect(session.pricesAnswered(500)).toBe(false);
    session.tickIdle(1);
    expect(session.pricesAnswered(500)).toBe(true);
    session.open('store');
    session.tickIdle(10_000);
    expect(session.pricesAnswered(500)).toBe(false);
  });

  it('a refetch clears an earlier answer — the three fetch fields move together (#463)', async () => {
    const { session, priceCalls } = make();
    session.open('store');
    priceCalls[0]!.resolve([info('a', '$1')]);
    await flush();
    expect(session.refreshPrices('shortfall')).toBe(true);
    expect(session.prices.size).toBe(0);
    expect(session.pricesAnswered(0)).toBe(false);
    expect(session.state).toEqual({ kind: 'shelf' });
  });

  it('refuses to refetch under a live purchase, which would silence its settle', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    expect(session.refreshPrices('shortfall')).toBe(false);
    purchases.get('p1')!.resolve(granted('p1'));
    expect((await settling).current).toBe(true);
  });

  it('a price answer does not knock a purchase started under a half-priced shelf off the screen', async () => {
    const { session, priceCalls } = make();
    session.open('store');
    const b = session.begin(ROW, 'p1');
    expect(b.ok).toBe(true);
    expect(session.state.kind).toBe('buying');
    priceCalls[0]!.resolve([info('p1', '$1')]);
    await flush();
    // The buy moved the epoch, so the open's fetch is superseded and cannot touch the screen.
    expect(session.state.kind).toBe('buying');
  });
});

describe('begin — refusals, in order, latched', () => {
  it('refuses mid-purchase, not-on-shelf, not-authored and already-in-flight', () => {
    const { session } = make();
    expect(session.begin({ show: false, title: 'x' }, 'p1')).toEqual({ ok: false, refusal: 'not-on-shelf' });
    expect(session.refusal).toBe('not-on-shelf');
    expect(session.begin(ROW, null)).toEqual({ ok: false, refusal: 'not-authored' });
    session.setInFlightForTest('p1', true);
    expect(session.begin(ROW, 'p1')).toEqual({ ok: false, refusal: 'already-in-flight' });
    session.setInFlightForTest('p1', false);
    expect(session.begin(ROW, 'p1').ok).toBe(true);
    expect(session.refusal).toBeNull();
    expect(session.begin(ROW, 'p2')).toEqual({ ok: false, refusal: 'mid-purchase' });
  });

  it('an accepted buy shows buying with the row title', () => {
    const { session } = make();
    session.begin(ROW, 'p1');
    expect(session.state).toEqual({ kind: 'buying', title: '300 Coins', productId: 'p1' });
  });

  it('opening the shelf forgets an earlier refusal', () => {
    const { session } = make();
    session.begin({ show: false, title: 'x' }, 'p1');
    session.open('store');
    expect(session.refusal).toBeNull();
  });
});

describe('settle — the in-flight marker and the epoch', () => {
  it('holds the product in flight until its promise settles, and releases it then', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    expect(session.isInFlight('p1')).toBe(true);
    expect(session.inFlightCount).toBe(1);
    purchases.get('p1')!.resolve({ outcome: 'cancelled', productId: 'p1', cancelReason: 'why' } as PurchaseResult);
    expect(await settling).toEqual({ current: true, outcome: 'cancelled', threw: false, cancelReason: 'why' });
    expect(session.isInFlight('p1')).toBe(false);
  });

  it('a thrown purchase settles as failed and carries the error', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    const boom = new Error('boom');
    purchases.get('p1')!.reject(boom);
    expect(await settling).toEqual({ current: true, outcome: 'failed', threw: true, error: boom });
  });

  it('a settle superseded by a NEWER PURCHASE is not current, but still releases its marker', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    session.showShelf();
    const second = session.begin(ROW, 'p2');
    expect(second.ok).toBe(true);
    purchases.get('p1')!.resolve(granted('p1'));
    expect((await settling).current).toBe(false);
    expect(session.isInFlight('p1')).toBe(false);
  });

  // #925 close-out review: Court's one shared epoch let a price refetch silence a purchase that had
  // been released from the screen but was still in the store's hands — the #580 silent outcome.
  it('re-opening the shelf or refetching prices does NOT silence a released purchase still in flight', async () => {
    const { session, purchases, t } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    t.fireAll();
    expect(session.dismissBusy()).toBe('p1');
    session.open('store');
    expect(session.refreshPrices('shortfall')).toBe(true);
    purchases.get('p1')!.resolve({ outcome: 'cancelled', productId: 'p1' } as PurchaseResult);
    expect((await settling).current).toBe(true);
  });

  it('a late settle releasing the screen leaves a re-opened shelf in loading', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    session.showShelf();
    session.open('store');
    purchases.get('p1')!.resolve(granted('p1'));
    await settling;
    session.showShelf();
    expect(session.state).toEqual({ kind: 'loading' });
  });

  it('the settle clears a refusal the purchase was about', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    session.begin(ROW, 'p1');
    expect(session.refusal).toBe('mid-purchase');
    purchases.get('p1')!.resolve(granted('p1'));
    await settling;
    expect(session.refusal).toBeNull();
  });

  it('after reset, an abandoned settle cannot release a NEW purchase of the same product', async () => {
    const { session, purchases } = make();
    const first = session.begin(ROW, 'p1');
    if (!first.ok) throw new Error('refused');
    const oldSettle = session.settle(first.stillCurrent, 'p1');
    const oldPurchase = purchases.get('p1')!;
    session.reset();
    const second = session.begin(ROW, 'p1');
    if (!second.ok) throw new Error('refused');
    void session.settle(second.stillCurrent, 'p1');
    oldPurchase.resolve(granted('p1'));
    await oldSettle;
    expect(session.isInFlight('p1')).toBe(true);
  });
});

describe('the watchdog', () => {
  it('marks a long purchase stalled — screen kept, epoch kept, so the settle still speaks (#580)', async () => {
    const stalled = vi.fn();
    const { session, purchases, t } = make({ onStalled: stalled });
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    t.fireAll();
    expect(session.state).toEqual({ kind: 'buying', title: '300 Coins', productId: 'p1', stalled: true });
    expect(stalled).toHaveBeenCalledWith({ title: '300 Coins', productId: 'p1' });
    purchases.get('p1')!.resolve({ outcome: 'cancelled', productId: 'p1' } as PurchaseResult);
    expect((await settling).current).toBe(true);
  });

  it('does nothing once the purchase has settled or the screen has moved on', async () => {
    const { session, purchases, t } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    purchases.get('p1')!.resolve(granted('p1'));
    await settling;
    expect(t.count()).toBe(0);
    session.showShelf();
    t.fireAll();
    expect(session.state).toEqual({ kind: 'shelf' });
  });

  it('the escape hatch releases only a STALLED purchase, and leaves it in flight', () => {
    const { session, t } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    void session.settle(b.stillCurrent, 'p1');
    expect(session.dismissBusy()).toBeNull();
    expect(session.state.kind).toBe('buying');
    t.fireAll();
    expect(session.dismissBusy()).toBe('p1');
    expect(session.state).toEqual({ kind: 'shelf' });
    expect(session.isInFlight('p1')).toBe(true);
  });

  it('showShelf (a grant landing before finish) keeps the epoch, so the later settle is current', async () => {
    const { session, purchases } = make();
    const b = session.begin(ROW, 'p1');
    if (!b.ok) throw new Error('refused');
    const settling = session.settle(b.stillCurrent, 'p1');
    session.showShelf();
    purchases.get('p1')!.resolve(granted('p1'));
    expect((await settling).current).toBe(true);
  });
});

describe('reset', () => {
  it('returns every field to a fresh screen', async () => {
    const { session, priceCalls, t } = make();
    session.open('store');
    priceCalls[0]!.resolve([info('a', '$1')]);
    await flush();
    session.begin({ show: false, title: 'x' }, 'a');
    const b = session.begin(ROW, 'a');
    if (!b.ok) throw new Error('refused');
    void session.settle(b.stillCurrent, 'a');
    session.reset();
    expect(session.state).toEqual({ kind: 'shelf' });
    expect(session.prices.size).toBe(0);
    expect(session.refusal).toBeNull();
    expect(session.inFlightCount).toBe(0);
    expect(session.pricesAnswered(1)).toBe(false);
    expect(t.count()).toBe(0);
  });
});
