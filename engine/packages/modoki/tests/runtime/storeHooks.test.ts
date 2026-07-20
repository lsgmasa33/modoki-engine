/** storeHooks registry tests (missing-test #6) — add/remove bump the version and
 *  notify subscribers; getStoreHooks exposes the live array; removal is by identity. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level singleton registry — reset between tests.
beforeEach(() => { vi.resetModules(); });

async function load() {
  return import('../../src/runtime/ui/storeHooks');
}

describe('storeHooks', () => {
  it('addStoreHook appends and bumps the version; getStoreHooks returns the live array', async () => {
    const { addStoreHook, getStoreHooks, getHooksVersion } = await load();
    expect(getStoreHooks()).toHaveLength(0);
    const v0 = getHooksVersion();

    const hook = () => ({ a: 1 });
    addStoreHook(hook);
    expect(getStoreHooks()).toEqual([hook]);
    expect(getHooksVersion()).toBe(v0 + 1);
  });

  it('removeStoreHook drops by identity and bumps the version', async () => {
    const { addStoreHook, removeStoreHook, getStoreHooks, getHooksVersion } = await load();
    const a = () => ({ a: 1 });
    const b = () => ({ b: 2 });
    addStoreHook(a);
    addStoreHook(b);
    const vBefore = getHooksVersion();

    removeStoreHook(a);
    expect(getStoreHooks()).toEqual([b]); // only a removed; b survives (identity-based)
    expect(getHooksVersion()).toBe(vBefore + 1);
  });

  it('removeStoreHook of an unregistered hook is a no-op (no version bump)', async () => {
    const { addStoreHook, removeStoreHook, getHooksVersion } = await load();
    addStoreHook(() => ({}));
    const v = getHooksVersion();
    removeStoreHook(() => ({})); // a different identity, never added
    expect(getHooksVersion()).toBe(v);
  });

  it('subscribeHooksVersion is notified on add and remove, and unsubscribe stops it', async () => {
    const { addStoreHook, removeStoreHook, subscribeHooksVersion } = await load();
    const cb = vi.fn();
    const unsub = subscribeHooksVersion(cb);

    const hook = () => ({});
    addStoreHook(hook);
    expect(cb).toHaveBeenCalledTimes(1);
    removeStoreHook(hook);
    expect(cb).toHaveBeenCalledTimes(2);

    unsub();
    addStoreHook(() => ({}));
    expect(cb).toHaveBeenCalledTimes(2); // no longer notified
  });

  it('getStoreHooks reflects live registry state (multiple hooks, ordered)', async () => {
    const { addStoreHook, getStoreHooks } = await load();
    const a = () => ({ a: 1 });
    const b = () => ({ b: 2 });
    const c = () => ({ c: 3 });
    addStoreHook(a); addStoreHook(b); addStoreHook(c);
    expect(getStoreHooks()).toEqual([a, b, c]);
  });
});
