/** PlayerPrefs storage backends.
 *
 *  A backend is the persistence adapter under the in-memory cache — it only ever
 *  sees FULL storage keys (`mk:<namespace>:<logical>`) and opaque envelope strings.
 *  Every backend's single-entry write is atomic on its platform, which is what makes
 *  a per-key PlayerPrefs write torn-free:
 *   - InMemory     — the default (tests, SSR, verification harness). No platform.
 *   - LocalStorage — web; `setItem` replaces a value wholesale (atomic).
 *   - Preferences  — Android; commits via temp+rename. Backed by @capacitor/preferences.
 *                    Also iOS on a native build too old to have the store below.
 *   - BackupExcluded — iOS; one file per key in a folder iCloud/Finder backups skip
 *                    (capacitor-modoki-system), each written temp+rename (#1271).
 *
 *  The interface is intentionally raw-string / async — the cache, envelope, and the
 *  synchronous Unity-style API all live in playerPrefs.ts. */

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { ModokiSystemPlugin } from 'capacitor-modoki-system';
import { PREFS_KEY_ROOT } from './prefsKey';

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

/** Native backend via @capacitor/preferences — SharedPreferences on Android, NSUserDefaults on an
 *  iOS build without the backup-excluded store (and the source `MigratingBackend` moves off). Each single-key write is ATOMIC (no torn value): iOS rewrites
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

/** The iOS store PlayerPrefs uses since #1271: `capacitor-modoki-system`'s key-value methods,
 *  whose files live in a folder marked `isExcludedFromBackup`. UserDefaults (Preferences) is part of
 *  every iCloud/Finder backup and cannot leave single keys out, so a new iPhone restored from a
 *  backup came back with a days-old save — the stale-save fork #1267 removed on Android by turning
 *  backup off. The owner ruled iOS should match (2026-09-17). The restore case itself was never
 *  observed on a device; this matches Android's ruled behaviour rather than fixing a confirmed bug.
 *
 *  The plugin is read from `Capacitor.Plugins` on every call, never through `registerPlugin` —
 *  the same rule as `actions/systemControls.ts`, whose docblock says why. */
export class BackupExcludedBackend implements PrefsBackend {
  private readonly plugin: () => ModokiSystemPlugin;

  constructor(plugin: () => ModokiSystemPlugin = bridgedSystemPlugin) {
    this.plugin = plugin;
  }

  async getAll(prefix: string): Promise<Record<string, string>> {
    const { entries } = await this.plugin().kvGetAll({ prefix });
    return { ...entries };
  }

  async set(fullKey: string, value: string): Promise<void> {
    await this.plugin().kvSet({ key: fullKey, value });
  }

  async remove(fullKey: string): Promise<void> {
    await this.plugin().kvRemove({ key: fullKey });
  }
}

/** The root every PlayerPrefs full key starts with (`mk:<namespace>:<logical>`) — owned by
 *  `prefsKey.ts`; re-exported here for the migration below, which moves exactly these keys. */
export { PREFS_KEY_ROOT };

/** Written into the NEW store once the old one has been copied. It has no `mk:` prefix, so no
 *  `getAll` ever returns it. The new store is out of backup, so a phone restored from a backup has
 *  no marker and migrates whatever the backup's UserDefaults still holds — nothing, for any backup
 *  taken after this migration ran, because the migration deletes the old keys. */
export const PREFS_MIGRATED_MARKER = '__modoki_prefs_migrated_from_preferences';

/** Routes every call to `target`, after a one-way move of all PlayerPrefs keys out of `legacy`
 *  (#1271: UserDefaults → the backup-excluded store). Players who update keep their save.
 *  Rationale and accepted edges: docs/player-prefs.md § How it works.
 *
 *  Per launch (per instance):
 *  1. **Read the marker.** If that read fails, REJECT: "never migrated" and "cannot tell" need
 *     different stores, and guessing `legacy` on a migrated device shows an emptied save whose
 *     writes the next launch then deletes (close-out review). `init()` fails loud on a rejected
 *     `getAll`; only a later `getAll` retries, and writes in between re-reject. ⚠️ The native
 *     store SKIPS a file it cannot parse, so a corrupt marker reads as absent — see step 3.
 *  2. **Marker present** → `target` is the save. Any `mk:` key left in `legacy` is deleted
 *     (a launch that died mid-delete), best-effort, never copied over `target`.
 *  3. **No marker** → make `target` an exact copy of `legacy`: delete `target`'s `mk:` keys that
 *     `legacy` lacks (a half-copy from an earlier failed launch, whose key the player may since
 *     have deleted in the fallback session) — but only when `legacy` holds any key at all, since
 *     an empty `legacy` beside a populated `target` is a migrated device with an unreadable
 *     marker — write every `legacy` key, THEN the marker. Any
 *     failure keeps this session on `legacy`, which is whole; running on the half-filled `target`
 *     would show a partial save and the retry would overwrite that session's progress.
 *  4. **After the marker**, re-read `legacy` before deleting: a write that another, outgoing
 *     instance drained into `legacy` after the snapshot (two instances across a re-`init()`) is
 *     copied forward rather than deleted with the stale copy. This NARROWS that race, it does
 *     not close it: a write landing after the re-read is still deleted.
 *
 *  ⚠️ An OTA rollback to JavaScript older than this change, on a native build that already
 *  migrated, reads the emptied UserDefaults and shows no save. Accepted: rollback bundles target
 *  the binary they shipped with. */
export class MigratingBackend implements PrefsBackend {
  private ready: Promise<PrefsBackend> | null = null;
  private readonly target: PrefsBackend;
  private readonly legacy: PrefsBackend;

  constructor(target: PrefsBackend, legacy: PrefsBackend) {
    this.target = target;
    this.legacy = legacy;
  }

  private failed: Promise<PrefsBackend> | null = null;

  /** `retry`: only `getAll` (i.e. an `init()`) may start a new attempt after one rejected. A write
   *  after a rejected `init()` re-rejects instead, so it can never land in a store that no
   *  `init()` hydrated from (close-out review: a default written over the real save). */
  private resolve(retry: boolean): Promise<PrefsBackend> {
    if (!this.ready) {
      if (this.failed && !retry) return this.failed;
      const attempt = this.migrate();
      this.ready = attempt;
      this.failed = null;
      attempt.catch(() => {
        if (this.ready !== attempt) return;
        this.ready = null;
        this.failed = attempt;
      });
    }
    return this.ready;
  }

  private async migrate(): Promise<PrefsBackend> {
    const marker = await this.target.getAll(PREFS_MIGRATED_MARKER);
    if (PREFS_MIGRATED_MARKER in marker) {
      await this.deleteLegacy(null);
      return this.target;
    }
    let copied: Record<string, string>;
    try {
      copied = await this.legacy.getAll(PREFS_KEY_ROOT);
      // Never when UserDefaults holds nothing: then the "no marker" answer is more likely a marker
      // file the native store could not parse (it skips unreadable files rather than failing the
      // read) on a migrated device, and mirroring would delete the whole save (close-out review).
      // Writing the marker below repairs it.
      if (Object.keys(copied).length > 0) {
        const halfCopied = await this.target.getAll(PREFS_KEY_ROOT);
        for (const key of Object.keys(halfCopied)) {
          if (!(key in copied)) await this.target.remove(key);
        }
      }
      for (const [key, value] of Object.entries(copied)) await this.target.set(key, value);
      await this.target.set(PREFS_MIGRATED_MARKER, '1');
    } catch (err) {
      console.error('[PlayerPrefs] moving the save out of UserDefaults failed; staying there this session', err);
      return this.legacy;
    }
    await this.deleteLegacy(copied);
    return this.target;
  }

  /** Best-effort removal of every `mk:` key in `legacy` — a failure leaves a key the next launch
   *  deletes (step 2), and the save is already whole in `target`. With `copied` (step 4), a key
   *  whose value moved or vanished since that snapshot is carried into `target` first. */
  private async deleteLegacy(copied: Record<string, string> | null): Promise<void> {
    let now: Record<string, string>;
    try {
      now = await this.legacy.getAll(PREFS_KEY_ROOT);
    } catch {
      return; // retried next launch
    }
    try {
      if (copied) {
        for (const [key, value] of Object.entries(now)) {
          if (copied[key] !== value) await this.target.set(key, value);
        }
        for (const key of Object.keys(copied)) {
          if (!(key in now)) await this.target.remove(key);
        }
      }
    } catch {
      // The newer value stays in legacy, and the next launch's marker path deletes it. Accepted:
      // it needs the two-instance race AND a store write failing moments after the copy succeeded.
      return;
    }
    for (const key of Object.keys(now)) {
      try {
        await this.legacy.remove(key);
      } catch {
        /* retried next launch */
      }
    }
  }

  async getAll(prefix: string): Promise<Record<string, string>> {
    return (await this.resolve(true)).getAll(prefix);
  }

  async set(fullKey: string, value: string): Promise<void> {
    return (await this.resolve(false)).set(fullKey, value);
  }

  async remove(fullKey: string): Promise<void> {
    return (await this.resolve(false)).remove(fullKey);
  }

  async flush(): Promise<void> {
    try {
      await (await this.resolve(false)).flush?.();
    } catch {
      /* flush must never reject — see PrefsBackend.flush */
    }
  }
}

const SYSTEM_PLUGIN = 'ModokiSystem';

function bridgedSystemPlugin(): ModokiSystemPlugin {
  const plugin = (Capacitor as unknown as { Plugins?: Record<string, ModokiSystemPlugin | undefined> }).Plugins?.[SYSTEM_PLUGIN];
  if (!plugin) throw new Error('[PlayerPrefs] capacitor-modoki-system is not in this native build');
  return plugin;
}

/** True when this native build carries the backup-excluded store. False on a build without the
 *  plugin, or with a plugin from before #1271 (a JS bundle delivered by OTA to an older binary):
 *  that build keeps its save in Preferences, as it always has, rather than losing it.
 *
 *  Read from the native `PluginHeaders`, never from `typeof Plugins.ModokiSystem.kvGetAll`: a game
 *  that imports the plugin's JS (Weaveling) replaces that entry with a `registerPlugin` proxy, which
 *  answers a function for ANY property name (close-out review). */
function hasBackupExcludedStore(): boolean {
  const headers = (Capacitor as unknown as { PluginHeaders?: readonly { name: string; methods?: readonly { name: string }[] }[] }).PluginHeaders;
  const methods = new Set(headers?.find((h) => h.name === SYSTEM_PLUGIN)?.methods?.map((m) => m.name) ?? []);
  return methods.has('kvGetAll') && methods.has('kvSet') && methods.has('kvRemove');
}

/** Pick the persistence backend for the current platform:
 *  iOS with the backup-excluded store → that store, after moving the save out of Preferences
 *  (#1271); other native → Preferences; a working `localStorage` → LocalStorage; else
 *  in-memory (SSR / locked-down browser / tests). The app passes the result to
 *  `PlayerPrefs.init({ backend })`; `init()` itself defaults to in-memory so headless
 *  and unit-test runs stay deterministic unless a backend is chosen explicitly. */
export function selectDefaultBackend(): PrefsBackend {
  try {
    if (Capacitor.isNativePlatform()) {
      if (Capacitor.getPlatform() === 'ios' && hasBackupExcludedStore()) {
        return new MigratingBackend(new BackupExcludedBackend(), new PreferencesBackend());
      }
      return new PreferencesBackend();
    }
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
