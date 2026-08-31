/**
 * `CapacitorStoreBackend`'s `purchasesUpdated` subscription — the constructor's `addListener()`
 * call is a native bridge round-trip, not a synchronous registration, so `dispose()` can run
 * before it settles (a game swap during boot). See `disposed`'s doc comment in `capacitorStore.ts`.
 *
 * `registerPlugin` is mocked directly rather than going through `capacitor-modoki-iap`, matching
 * the module's own doc comment: the plugin is resolved by NAME at runtime, never imported.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const addListener = vi.fn();
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({ addListener })),
}));

// `reconcile` is what the `purchasesUpdated` callback (`capacitorStore.ts:98`) drives when it is
// NOT bailing on `disposed` — mocking the module it comes from is the seam that lets a test
// observe that call without touching the real purchase ledger.
const reconcile = vi.fn();
vi.mock('../../src/runtime/iap/purchaseService', () => ({ reconcile }));

const { CapacitorStoreBackend } = await import('../../src/runtime/iap/capacitorStore');

/** A deferred promise, so a test can resolve `addListener()` on its own schedule relative to
 *  `dispose()`. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  addListener.mockReset();
  reconcile.mockReset();
});

describe('CapacitorStoreBackend — dispose() vs. the in-flight addListener() round-trip', () => {
  it('a dispose() that lands BEFORE addListener() resolves still removes the handle', async () => {
    const gate = deferred<{ remove: () => Promise<void> }>();
    addListener.mockReturnValue(gate.promise);
    const remove = vi.fn().mockResolvedValue(undefined);

    const store = new CapacitorStoreBackend([]);
    // dispose() runs first — nothing to unsubscribe yet, `unsubscribe` is still null.
    store.dispose();

    // The native bridge round-trip settles AFTER dispose() already ran.
    gate.resolve({ remove });
    await gate.promise;
    // Let the `.then` callback's microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledTimes(1);

    // No leaked unsubscribe installed either — a second dispose() must not call remove again.
    store.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('the working path — addListener() resolves first, THEN dispose() — removes exactly once', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    addListener.mockResolvedValue({ remove });

    const store = new CapacitorStoreBackend([]);
    // Let the constructor's `.then` install `unsubscribe`.
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).not.toHaveBeenCalled();

    store.dispose();
    expect(remove).toHaveBeenCalledTimes(1);

    // dispose() is idempotent — calling it again must not call remove() a second time.
    store.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

/** The OTHER half of the guard: the callback registered with `addListener` itself
 *  (`capacitorStore.ts:98`), not just the handle-removal `.then()` above. The native listener is
 *  live from the moment `addListener` is invoked — so a `purchasesUpdated` event can arrive
 *  BEFORE that promise even settles, let alone after `dispose()` — and this is what proves the
 *  callback bails rather than driving `reconcile()` against a torn-down session. Nothing in the
 *  existing pair above ever calls the callback it captured, so `if (this.disposed) return;` was
 *  pinned by nothing before this file existed. */
describe('CapacitorStoreBackend — the purchasesUpdated callback itself, not just handle removal', () => {
  it('a purchasesUpdated event delivered AFTER dispose() does not drive reconcile()', () => {
    // Never resolved — the callback under test does not depend on the promise settling, since
    // the native listener is live from the moment addListener() is called.
    addListener.mockReturnValue(new Promise(() => {}));

    const store = new CapacitorStoreBackend([]);
    store.dispose();

    const onPurchasesUpdated = addListener.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(onPurchasesUpdated).toBeInstanceOf(Function);
    onPurchasesUpdated!();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it('a purchasesUpdated event delivered BEFORE any dispose() DOES drive reconcile()', () => {
    addListener.mockReturnValue(new Promise(() => {}));

    new CapacitorStoreBackend([]); // no dispose() at all in this test

    const onPurchasesUpdated = addListener.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(onPurchasesUpdated).toBeInstanceOf(Function);
    onPurchasesUpdated!();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
