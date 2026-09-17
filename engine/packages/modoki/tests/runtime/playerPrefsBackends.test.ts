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
  BackupExcludedBackend, MigratingBackend, PREFS_MIGRATED_MARKER, type PrefsBackend,
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

  describe('flush() — Electron forced-commit lever (#335)', () => {
    it('is a no-op in a headless/node context with no `window` global at all', async () => {
      expect(typeof window).toBe('undefined'); // this suite's env — the branch this case names
      const b = new LocalStorageBackend();
      await expect(b.flush!()).resolves.toBeUndefined();
    });

    it('is a no-op in a plain browser tab (`window` present, no __modokiElectron bridge)', async () => {
      vi.stubGlobal('window', {}); // a real browser global with nothing Electron-specific on it
      const b = new LocalStorageBackend();
      await expect(b.flush!()).resolves.toBeUndefined();
    });

    it('invokes modoki:flush-storage-data when __modokiElectron is present', async () => {
      const invoke = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('window', { __modokiElectron: { invoke } });
      const b = new LocalStorageBackend();
      await b.flush!();
      expect(invoke).toHaveBeenCalledWith('modoki:flush-storage-data');
    });

    it('swallows a rejected invoke — best-effort, never poisons the write pipeline', async () => {
      const invoke = vi.fn().mockRejectedValue(new Error('ipc gone'));
      vi.stubGlobal('window', { __modokiElectron: { invoke } });
      const b = new LocalStorageBackend();
      await expect(b.flush!()).resolves.toBeUndefined();
    });
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

/** A stand-in for capacitor-modoki-system's iOS key-value methods, as the native bridge exposes
 *  them on `Capacitor.Plugins`. */
function makeFakeSystemPlugin() {
  const files = new Map<string, string>();
  return {
    files,
    openUrl: async () => ({ opened: false }),
    openAppSettings: async () => ({ opened: false }),
    kvGetAll: async ({ prefix }: { prefix: string }) => ({
      entries: Object.fromEntries([...files].filter(([k]) => k.startsWith(prefix))),
    }),
    kvSet: async ({ key, value }: { key: string; value: string }) => { files.set(key, value); },
    kvRemove: async ({ key }: { key: string }) => { files.delete(key); },
    kvInfo: async () => ({ path: '/fake', excludedFromBackup: true, entries: files.size }),
  };
}

type Header = { name: string; methods: { name: string }[] };
const cap = Capacitor as unknown as { Plugins: Record<string, unknown>; PluginHeaders?: Header[] };
/** Install the plugin as a native build exposes it: the object on `Capacitor.Plugins`, and the
 *  native method list on `Capacitor.PluginHeaders` (what the capability check reads). */
function installSystemPlugin(plugin: unknown, nativeMethods = ['openUrl', 'openAppSettings', 'kvGetAll', 'kvSet', 'kvRemove', 'kvInfo']): void {
  cap.Plugins.ModokiSystem = plugin;
  cap.PluginHeaders = [{ name: 'ModokiSystem', methods: nativeMethods.map((name) => ({ name })) }];
}
afterEach(() => {
  delete cap.Plugins.ModokiSystem;
  delete cap.PluginHeaders;
});

describe('selectDefaultBackend', () => {
  it('returns Preferences on Android, even with the backup-excluded store present (#1271)', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    installSystemPlugin(makeFakeSystemPlugin());
    expect(selectDefaultBackend()).toBeInstanceOf(PreferencesBackend);
  });

  it('returns the migrating backup-excluded store on iOS when the plugin has it (#1271)', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
    installSystemPlugin(makeFakeSystemPlugin());
    expect(selectDefaultBackend()).toBeInstanceOf(MigratingBackend);
  });

  it('keeps Preferences on iOS when the native build has no plugin, or one from before #1271', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
    expect(selectDefaultBackend()).toBeInstanceOf(PreferencesBackend);
    // An OTA bundle on an older binary: the plugin is there, but only with openUrl/openAppSettings.
    installSystemPlugin({ openUrl: async () => ({ opened: false }), openAppSettings: async () => ({ opened: false }) }, ['openUrl', 'openAppSettings']);
    expect(selectDefaultBackend()).toBeInstanceOf(PreferencesBackend);
  });

  it('is not fooled by a registerPlugin proxy, which answers a function for any method name', () => {
    // Weaveling imports the plugin JS, so its Plugins entry is a proxy (close-out review).
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('ios');
    const proxy = new Proxy({}, { get: () => async () => { throw new Error('not implemented'); } });
    installSystemPlugin(proxy, ['openUrl', 'openAppSettings']);
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

describe('BackupExcludedBackend (#1271)', () => {
  it('maps set/getAll/remove onto the plugin, filtering getAll by prefix', async () => {
    const fake = makeFakeSystemPlugin();
    installSystemPlugin(fake);
    const b = new BackupExcludedBackend();
    await b.set('mk:g1:a', 'A');
    await b.set('mk:g1:b', 'B');
    await b.set('mk:zz:c', 'C');
    expect(fake.files.get('mk:g1:a')).toBe('A');
    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:a': 'A', 'mk:g1:b': 'B' });
    await b.remove('mk:g1:a');
    expect(await b.getAll('mk:g1:')).toEqual({ 'mk:g1:b': 'B' });
  });

  it('rejects rather than pretending when the plugin is missing', async () => {
    await expect(new BackupExcludedBackend().getAll('mk:')).rejects.toThrow(/capacitor-modoki-system/);
  });
});

/** An in-memory backend whose chosen calls can be made to fail. */
class FlakyBackend extends InMemoryBackend {
  failSet: ((key: string) => boolean) | null = null;
  failRemove = false;
  failGetAll = false;
  override async set(key: string, value: string): Promise<void> {
    if (this.failSet?.(key)) throw new Error(`set ${key} failed`);
    return super.set(key, value);
  }
  override async remove(key: string): Promise<void> {
    if (this.failRemove) throw new Error(`remove ${key} failed`);
    return super.remove(key);
  }
  override async getAll(prefix: string): Promise<Record<string, string>> {
    if (this.failGetAll) throw new Error('getAll failed');
    return super.getAll(prefix);
  }
}

async function seed(b: PrefsBackend, entries: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(entries)) await b.set(k, v);
}

describe('MigratingBackend — moving the save out of UserDefaults (#1271)', () => {
  it('an updating player keeps their save: every mk: key moves, and leaves the old store', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:court:progress': 'P', 'mk:weave:coins': '7', 'otherPlugin:key': 'X' });
    const b = new MigratingBackend(target, legacy);

    expect(await b.getAll('mk:court:')).toEqual({ 'mk:court:progress': 'P' });
    expect(await target.getAll('mk:')).toEqual({ 'mk:court:progress': 'P', 'mk:weave:coins': '7' });
    expect(await target.getAll(PREFS_MIGRATED_MARKER)).toEqual({ [PREFS_MIGRATED_MARKER]: '1' });
    // The old copy is gone, so the next backup holds no save; a key that is not PlayerPrefs' stays.
    expect(await legacy.getAll('')).toEqual({ 'otherPlugin:key': 'X' });
  });

  it('writes go to the new store after the move', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    const b = new MigratingBackend(target, legacy);
    // A write before any getAll still waits for the migration, then lands in the new store.
    await b.set('mk:g:a', 'A');
    await b.remove('mk:g:missing');
    expect(await target.getAll('mk:')).toEqual({ 'mk:g:a': 'A' });
    expect(await legacy.getAll('')).toEqual({});
  });

  it('a phone restored from a post-update backup starts empty and does not re-migrate', async () => {
    // The new store is out of backup and the backup's UserDefaults no longer holds the save, so the
    // restored phone sees neither. The player signs in and takes the cloud save.
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    const b = new MigratingBackend(target, legacy);
    expect(await b.getAll('mk:court:')).toEqual({});
    expect(await target.getAll(PREFS_MIGRATED_MARKER)).toEqual({ [PREFS_MIGRATED_MARKER]: '1' });
  });

  it('once migrated, the old store is never copied over the new one; a leftover is deleted', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(target, { [PREFS_MIGRATED_MARKER]: '1', 'mk:g:level': 'new' });
    // A launch that died after the marker, mid-delete, left a stale copy behind.
    await seed(legacy, { 'mk:g:level': 'stale' });
    const b = new MigratingBackend(target, legacy);

    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:level': 'new' });
    expect(await legacy.getAll('mk:')).toEqual({});
  });

  it('a launch that dies before the marker repeats the copy next launch, and loses nothing', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:g:a': 'A', 'mk:g:b': 'B' });
    target.failSet = (key) => key === PREFS_MIGRATED_MARKER;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = new MigratingBackend(target, legacy);
    // This session stays on the old store, which still holds everything.
    expect(await first.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A', 'mk:g:b': 'B' });
    await first.set('mk:g:a', 'A2');
    expect(await legacy.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A2', 'mk:g:b': 'B' });
    expect(console.error).toHaveBeenCalled();

    // Next launch: the retry copies the old store again, including this session's write.
    target.failSet = null;
    const second = new MigratingBackend(target, legacy);
    expect(await second.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A2', 'mk:g:b': 'B' });
    expect(await legacy.getAll('mk:')).toEqual({});
  });

  it('a copy that fails part-way leaves the session on the old store, untouched', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:g:a': 'A', 'mk:g:b': 'B' });
    target.failSet = (key) => key === 'mk:g:b';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new MigratingBackend(target, legacy);
    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A', 'mk:g:b': 'B' });
    expect(await target.getAll(PREFS_MIGRATED_MARKER)).toEqual({});
  });

  it('a marker that cannot be read REJECTS rather than guessing a store, and the next call retries', async () => {
    // On a migrated device, guessing the old store would show an emptied save (close-out review).
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(target, { [PREFS_MIGRATED_MARKER]: '1', 'mk:g:a': 'A' });
    target.failGetAll = true;
    const b = new MigratingBackend(target, legacy);
    await expect(b.getAll('mk:g:')).rejects.toThrow();
    target.failGetAll = false;
    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A' });
  });

  it('a write after a rejected init() re-rejects instead of retrying into an unread store', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(target, { [PREFS_MIGRATED_MARKER]: '1', 'mk:g:coins': '30' });
    target.failGetAll = true;
    const b = new MigratingBackend(target, legacy);
    await expect(b.getAll('mk:g:')).rejects.toThrow();
    target.failGetAll = false; // the read would now succeed, but no init() has read the store
    await expect(b.set('mk:g:coins', '0')).rejects.toThrow();
    await expect(b.remove('mk:g:coins')).rejects.toThrow();
    await expect(b.flush()).resolves.toBeUndefined();
    expect(await target.getAll('mk:g:')).toEqual({ 'mk:g:coins': '30' });
    // A later init() retries, and writes then go through.
    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:coins': '30' });
    await b.set('mk:g:coins', '31');
    expect(await target.getAll('mk:g:')).toEqual({ 'mk:g:coins': '31' });
  });

  it('a corrupt marker (read as absent) on a migrated device keeps the save, and is rewritten', async () => {
    // The native store skips a file it cannot parse, so the marker is simply missing from getAll.
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(target, { 'mk:g:a': 'A', 'mk:g:b': 'B' });
    const b = new MigratingBackend(target, legacy);
    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A', 'mk:g:b': 'B' });
    expect(await target.getAll(PREFS_MIGRATED_MARKER)).toEqual({ [PREFS_MIGRATED_MARKER]: '1' });
  });

  it('once migrated, a failing old store never moves the session off the new one', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(target, { [PREFS_MIGRATED_MARKER]: '1', 'mk:g:a': 'A' });
    legacy.failGetAll = true;
    const b = new MigratingBackend(target, legacy);
    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A' });
    await b.set('mk:g:b', 'B');
    expect(await target.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A', 'mk:g:b': 'B' });
  });

  it('a key deleted during a fallback session stays deleted when the retry succeeds', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:g:a': 'A', 'mk:g:b': 'B' });
    target.failSet = (key) => key === 'mk:g:b'; // a is half-copied, then the copy fails
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = new MigratingBackend(target, legacy);
    await first.remove('mk:g:a'); // the player's delete lands in the old store
    expect(await target.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A' });

    target.failSet = null;
    const second = new MigratingBackend(target, legacy);
    expect(await second.getAll('mk:g:')).toEqual({ 'mk:g:b': 'B' });
  });

  it('a write drained into the old store after the snapshot is carried forward, not deleted', async () => {
    // Two instances across a re-init(): the outgoing one fell back and is still draining.
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:g:a': 'A', 'mk:g:gone': 'G' });
    const realSet = target.set.bind(target);
    let raced = false;
    target.set = async (key, value) => {
      if (key === PREFS_MIGRATED_MARKER && !raced) {
        raced = true;
        await legacy.set('mk:g:a', 'A2'); // the outgoing instance's late write
        await legacy.set('mk:g:new', 'N');
        await legacy.remove('mk:g:gone');
      }
      return realSet(key, value);
    };
    const b = new MigratingBackend(target, legacy);
    expect(await b.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A2', 'mk:g:new': 'N' });
    expect(await legacy.getAll('mk:')).toEqual({});
  });

  it('a failed delete still runs the session on the new store, and the next launch deletes', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:g:a': 'A' });
    legacy.failRemove = true;
    const first = new MigratingBackend(target, legacy);
    await first.set('mk:g:a', 'A2');
    expect(await target.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A2' });
    expect(await legacy.getAll('mk:')).toEqual({ 'mk:g:a': 'A' });

    legacy.failRemove = false;
    const second = new MigratingBackend(target, legacy);
    expect(await second.getAll('mk:g:')).toEqual({ 'mk:g:a': 'A2' });
    expect(await legacy.getAll('mk:')).toEqual({});
  });

  it('migrates once per instance, even under concurrent first calls', async () => {
    const target = new FlakyBackend();
    const legacy = new FlakyBackend();
    await seed(legacy, { 'mk:g:a': 'A' });
    const spy = vi.spyOn(target, 'set');
    const b = new MigratingBackend(target, legacy);
    await Promise.all([b.getAll('mk:g:'), b.set('mk:g:b', 'B'), b.getAll('mk:g:')]);
    expect(spy.mock.calls.filter(([key]) => key === PREFS_MIGRATED_MARKER)).toHaveLength(1);
  });

  it('flush never rejects', async () => {
    const target = new FlakyBackend();
    (target as PrefsBackend).flush = async () => { throw new Error('boom'); };
    await expect(new MigratingBackend(target, new FlakyBackend()).flush()).resolves.toBeUndefined();
  });
});
