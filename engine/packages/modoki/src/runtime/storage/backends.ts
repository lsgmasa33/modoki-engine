/** PlayerPrefs storage backends.
 *
 *  A backend is the persistence adapter under the in-memory cache — it only ever
 *  sees FULL storage keys (`mk:<namespace>:<logical>`) and opaque envelope strings.
 *  Every backend's single-entry write is atomic on its platform, which is what makes
 *  a per-key PlayerPrefs write torn-free:
 *   - InMemory     — the default (tests, SSR, verification harness). No platform.
 *   - LocalStorage — web; `setItem` replaces a value wholesale (atomic).
 *   - Preferences  — device; iOS writes the plist atomically, Android commits
 *                    via temp+rename. Backed by @capacitor/preferences.
 *
 *  The interface is intentionally raw-string / async — the cache, envelope, and the
 *  synchronous Unity-style API all live in playerPrefs.ts. */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

export interface PrefsBackend {
  /** All entries whose full key starts with `prefix`, as `{ fullKey: envelopeString }`. */
  getAll(prefix: string): Promise<Record<string, string>>;
  /** Write one entry atomically (full key → envelope string). */
  set(fullKey: string, value: string): Promise<void>;
  /** Remove one entry. */
  remove(fullKey: string): Promise<void>;
  /** Push whatever `set`/`remove` already handed the platform the rest of the way to disk,
   *  if this backend has a lever for that (see `LocalStorageBackend.flush` for the only one
   *  that currently does). Optional — most backends have no additional step beyond `set`.
   *
   *  ⚠️ MUST NOT reject. The write pipeline's `drain()` calls this once per drained batch,
   *  guarded so a rejection can never poison `writeChain` (playerPrefs.ts) — but an
   *  implementation should treat "couldn't force the extra commit" as best-effort and
   *  swallow its own errors, the way `LocalStorageBackend.flush` does, rather than lean on
   *  the caller's guard. */
  flush?(): Promise<void>;
}

/** In-memory backend — the default. Deterministic, platform-free: the verification
 *  harness and unit tests run against this with no localStorage/Capacitor dependency. */
export class InMemoryBackend implements PrefsBackend {
  private readonly store = new Map<string, string>();

  async getAll(prefix: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.store) if (k.startsWith(prefix)) out[k] = v;
    return out;
  }

  async set(fullKey: string, value: string): Promise<void> {
    this.store.set(fullKey, value);
  }

  async remove(fullKey: string): Promise<void> {
    this.store.delete(fullKey);
  }
}

/** Web backend. Each key → its own `localStorage` entry; `setItem` replaces the value
 *  wholesale (atomic — a reader never sees a torn string). `set` may throw
 *  `QuotaExceededError`; the write pipeline in playerPrefs.ts catches it and re-queues.
 *
 *  Caveat (durability) on a PLAIN browser tab, the exact counterpart of the Android one
 *  below: `setItem` is SYNCHRONOUS into the browser's in-memory area, but the on-disk store
 *  is written back asynchronously and there is no way from a renderer to force that — so an
 *  awaited `set()`/`flush()` guarantees atomicity but NOT persistence there.
 *
 *  Under ELECTRON specifically this backend also calls `flush()` (below): Electron's main
 *  process exposes `session.flushStorageData()`, a real forced-commit hook a plain browser
 *  tab has no equivalent of (docs/player-prefs.md § Gotchas). That shrinks the durability
 *  window from "everything since the last clean shutdown" down to "the write(s) currently
 *  in flight" — still not an fsync guarantee (the call itself is fire-and-forget void), but
 *  the best lever this platform has. Measured three ways in docs/player-prefs.md § Gotchas. */
export class LocalStorageBackend implements PrefsBackend {
  async getAll(prefix: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k != null && k.startsWith(prefix)) {
        const v = localStorage.getItem(k);
        if (v != null) out[k] = v;
      }
    }
    return out;
  }

  async set(fullKey: string, value: string): Promise<void> {
    localStorage.setItem(fullKey, value);
  }

  async remove(fullKey: string): Promise<void> {
    localStorage.removeItem(fullKey);
  }

  /** Electron only — asks main to force the localStorage LevelDB commit right now, rather
   *  than waiting for a clean shutdown. A no-op (never rejects) outside Electron, or if the
   *  bridge/channel isn't there for any reason — this is a durability improvement, not a
   *  contract the write pipeline can depend on succeeding. */
  async flush(): Promise<void> {
    if (typeof window === 'undefined') return;
    const invoke = (window as unknown as { __modokiElectron?: { invoke?: (c: string, p?: unknown) => Promise<unknown> } })
      .__modokiElectron?.invoke;
    if (!invoke) return;
    try {
      const result = await invoke('modoki:flush-storage-data');
      // Today this can only be {ok:false} if the caller isn't the main frame (main.ts's
      // fromMainFrame guard) — unreachable while the game preview always runs in the top
      // frame, but worth a signal if that ever stops being true rather than looking identical
      // to success.
      if ((result as { ok?: boolean } | undefined)?.ok === false) {
        console.warn('[PlayerPrefs] modoki:flush-storage-data was refused', result);
      }
    } catch {
      /* best-effort — see class doc comment */
    }
  }
}

/** Native backend (iOS/Android) via @capacitor/preferences — NSUserDefaults /
 *  SharedPreferences. Each single-key write is ATOMIC (no torn value): iOS rewrites
 *  the plist atomically; Android's SharedPreferences writes the whole file atomically.
 *
 *  Caveat (durability): on Android the plugin uses `SharedPreferences.Editor.apply()`,
 *  which returns BEFORE the write reaches disk — so an awaited `set()` / `flush()`
 *  guarantees atomicity but NOT that the byte is persisted. This is the best-effort
 *  durability the contract already documents; flush-on-background (Phase 3) must not
 *  assume an awaited `set` is on disk, and leans on the OS lifecycle to actually sync. */
export class PreferencesBackend implements PrefsBackend {
  async getAll(prefix: string): Promise<Record<string, string>> {
    const { keys } = await Preferences.keys();
    const matched = keys.filter((k) => k.startsWith(prefix));
    const out: Record<string, string> = {};
    await Promise.all(
      matched.map(async (k) => {
        const { value } = await Preferences.get({ key: k });
        if (value != null) out[k] = value;
      }),
    );
    return out;
  }

  async set(fullKey: string, value: string): Promise<void> {
    await Preferences.set({ key: fullKey, value });
  }

  async remove(fullKey: string): Promise<void> {
    await Preferences.remove({ key: fullKey });
  }
}

/** Pick the persistence backend for the current platform:
 *  native (Capacitor) → Preferences; a working `localStorage` → LocalStorage; else
 *  in-memory (SSR / locked-down browser / tests). The app passes the result to
 *  `PlayerPrefs.init({ backend })`; `init()` itself defaults to in-memory so headless
 *  and unit-test runs stay deterministic unless a backend is chosen explicitly. */
export function selectDefaultBackend(): PrefsBackend {
  try {
    if (Capacitor.isNativePlatform()) return new PreferencesBackend();
  } catch {
    /* Capacitor unavailable — fall through to web/in-memory */
  }
  if (hasWorkingLocalStorage()) return new LocalStorageBackend();
  return new InMemoryBackend();
}

/** localStorage exists AND is writable (Safari private mode / disabled storage throw). */
function hasWorkingLocalStorage(): boolean {
  const probe = '__mk_prefs_probe__';
  try {
    localStorage.setItem(probe, '1');
  } catch {
    return false;
  } finally {
    // Never leave the probe behind, even if setItem succeeded but a later step throws.
    try { localStorage.removeItem(probe); } catch { /* ignore */ }
  }
  return true;
}
