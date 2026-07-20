/** PlayerPrefs platform backends (Phase 2).
 *
 *  LocalStorageBackend against a controllable fake `localStorage` global (env-
 *  independent — jsdom disables storage on opaque origins); PreferencesBackend
 *  against a mocked @capacitor/preferences (its real export is a Capacitor proxy that
 *  can't be spied); and selectDefaultBackend()'s platform choice. Asserts per-key
 *  writes, namespace-prefix filtering in getAll, and that a QuotaExceeded reject
 *  surfaces (the write pipeline's re-queue is covered in playerPrefs.test.ts). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import {
  LocalStorageBackend, PreferencesBackend, InMemoryBackend, selectDefaultBackend,
} from '../../src/runtime/storage';

// Replace the Capacitor Preferences plugin with a stateful in-memory fake so the test
// exercises PreferencesBackend's mapping only. `_store` is reset per test.
vi.mock('@capacitor/preferences', () => {
  const store = new Map<string, string>();
  return {
    Preferences: {
      _store: store,
      keys: async () => ({ keys: [...store.keys()] }),
      get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
      set: async ({ key, value }: { key: string; value: string }) => { store.set(key, value); },
      remove: async ({ key }: { key: string }) => { store.delete(key); },
    },
  };
});

import { Preferences } from '@capacitor/preferences';
const prefStore = (Preferences as unknown as { _store: Map<string, string> })._store;

/** A minimal Storage-shaped fake, backed by a Map. `throwOnSet` simulates quota/denied. */
function makeFakeLocalStorage(throwOnSet = false) {
  const m = new Map<string, string>();
  return {
    _map: m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (throwOnSet) throw new DOMException('denied', 'QuotaExceededError');
      m.set(k, v);
    },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

beforeEach(() => {
  prefStore.clear();
  vi.stubGlobal('localStorage', makeFakeLocalStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LocalStorageBackend', () => {
  it('writes each key as its own localStorage entry and reads by prefix', async () => {
    const b = new LocalStorageBackend();
    await b.set('mk:g1:a', 'A');
    await b.set('mk:g1:b', 'B');
    await b.set('mk:other:c', 'C'); // different namespace — must not match

    expect(localStorage.getItem('mk:g1:a')).toBe('A');
    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:a': 'A', 'mk:g1:b': 'B' });
  });

  it('remove deletes a single entry, leaving siblings intact', async () => {
    const b = new LocalStorageBackend();
    await b.set('mk:g1:a', 'A');
    await b.set('mk:g1:b', 'B');
    await b.remove('mk:g1:a');
    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:b': 'B' });
  });

  it('surfaces a QuotaExceeded reject from setItem', async () => {
    vi.stubGlobal('localStorage', makeFakeLocalStorage(true));
    const b = new LocalStorageBackend();
    await expect(b.set('mk:g1:a', 'A')).rejects.toThrow();
  });
});

describe('PreferencesBackend', () => {
  it('maps set/get/remove onto the plugin and filters getAll by prefix', async () => {
    const b = new PreferencesBackend();
    await b.set('mk:g1:a', 'A');
    await b.set('mk:g1:b', 'B');
    await b.set('mk:zz:c', 'C');
    expect(prefStore.get('mk:g1:a')).toBe('A');

    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:a': 'A', 'mk:g1:b': 'B' });

    await b.remove('mk:g1:a');
    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:b': 'B' });
  });

  it('getAll skips a key that keys() lists but get() returns null for', async () => {
    // Preferences.keys() can list a key whose get() yields null (removed between calls).
    vi.spyOn(Preferences, 'keys').mockResolvedValueOnce({ keys: ['mk:g1:ghost', 'mk:g1:real'] });
    prefStore.set('mk:g1:real', 'R'); // 'ghost' is absent → get() returns null
    const b = new PreferencesBackend();
    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:real': 'R' });
  });

  it('surfaces a set() rejection (parity with LocalStorage quota)', async () => {
    vi.spyOn(Preferences, 'set').mockRejectedValueOnce(new Error('native IO error'));
    const b = new PreferencesBackend();
    await expect(b.set('mk:g1:a', 'A')).rejects.toThrow();
  });
});

describe('selectDefaultBackend', () => {
  it('returns Preferences on a native platform', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    expect(selectDefaultBackend()).toBeInstanceOf(PreferencesBackend);
  });

  it('returns LocalStorage in a browser with working localStorage', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    expect(selectDefaultBackend()).toBeInstanceOf(LocalStorageBackend);
  });

  it('falls back to in-memory when localStorage is unavailable', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubGlobal('localStorage', makeFakeLocalStorage(true)); // setItem throws
    expect(selectDefaultBackend()).toBeInstanceOf(InMemoryBackend);
  });
});
