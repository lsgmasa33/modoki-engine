# PlayerPrefs

The engine's runtime persistence primitive — a Unity-`PlayerPrefs`-style, atomic, per-key
JSON key/value store for saving player progress, settings, and high scores across launches.

## What it is

Modoki's `Persistent` trait only survives scene swaps *within a running session*; nothing
persisted player state across app restarts. `PlayerPrefs` fills that gap with a small,
Claude-friendly store modelled on Unity's `PlayerPrefs`, refined in three ways:

- **Per-key JSON documents, not typed scalars.** A value is a plain JSON-serializable object
  (POJO — objects/arrays/primitives/`null`; no methods, class instances, `Map`/`Set`, or
  cycles survive). One key holds one document: `set("progress", { level: 5, coins: 100 })`.
- **Atomic per key.** A reader never sees a torn value; a write lands whole or not at all.
  There is **no cross-key transaction** — state that must change together goes under one key
  as one document. (Atomicity is free: each backend's single-entry write is atomic, and the
  in-memory cache is touched in JS's single thread.)
- **Best-effort durability** (atomic ≠ durable). A kill immediately after `set()` can *lose*
  the last write but never *corrupt* it — the same guarantee Unity gives. `flush()` and
  flush-on-background NARROW the gap; they do not close it (see Gotchas — a `SIGKILL` loses a
  flushed web write, measured).

It is an engine-owned singleton, exported from the runtime barrel like `sceneManager` — a
game just imports and calls it; there is no registration.

## Key files

| File | Role |
|---|---|
| `runtime/storage/playerPrefs.ts` | The singleton, the sync API, the envelope, and the debounced write pipeline. |
| `runtime/storage/backends.ts` | `PrefsBackend` interface + `InMemoryBackend` / `LocalStorageBackend` / `PreferencesBackend` + `selectDefaultBackend()`. |
| `runtime/storage/index.ts` | Re-exports; surfaced from `runtime/index.ts`. |
| `engine/app/App.tsx` | Hydrates per game (`init({ namespace: gameId, backend: selectDefaultBackend() })`) and registers flush-on-background. |
| `engine/packages/modoki/tests/runtime/playerPrefs*.test.ts` | Core, backends, and save→reload→restore integration tests. |

## API

```ts
import { PlayerPrefs } from '@modoki/engine/runtime';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

await PlayerPrefs.init({ namespace, backend })   // hydrate the cache once at boot (app does this)
PlayerPrefs.get<T>(key): T | undefined           // sync, returns a fresh copy
PlayerPrefs.set<T>(key, value): void             // sync into cache; atomic durable write is debounced
PlayerPrefs.has(key): boolean
PlayerPrefs.delete(key): void                    // also: set(key, undefined)
PlayerPrefs.keys(): string[]
PlayerPrefs.clear(): void                         // empties THIS game's namespace
PlayerPrefs.isHydrated(): boolean                 // true once init() has hydrated the cache
PlayerPrefs.hasPendingWrite(key): boolean         // a write the backend has NOT accepted (see Gotchas)
await PlayerPrefs.flush()                         // resolve once pending writes are durable
```

`get`/`set` are **synchronous** (served from an in-memory cache hydrated at `init()`), so game
code reads and writes prefs inline like Unity. Only `init()` and `flush()` are async. `set`
schedules a debounced (~150 ms) write-through; `flush()` forces it immediately.

Typical game use:

```ts
// at load: read saved progress (undefined the first time)
const best = PlayerPrefs.get<number>('bestScore') ?? 0;

// on improvement: persist it
if (score > best) PlayerPrefs.set('bestScore', score);
```

## How it works

- **Backends.** `init()` defaults to the platform-free `InMemoryBackend`; the app passes
  `selectDefaultBackend()`, which picks **`@capacitor/preferences`** on device
  (NSUserDefaults / SharedPreferences), **`localStorage`** in a browser with working storage,
  else in-memory (SSR / private-mode). Each backend maps one logical key to one atomic
  single-entry write.
- **Namespacing.** Every key is stored under `mk:<namespace>:<logical>` — the app uses the
  `gameId`, so two games on the same device/browser can't collide.
- **Envelope.** Each value persists as `{ v: SCHEMA_VERSION, d: <document> }`. The version
  guards the on-disk format (not the game's data shape) so a future migration is possible; a
  corrupt/unparseable entry fails soft to `undefined`, never a throw.
- **Write pipeline.** The cache stores the serialized envelope string per key (so `get()`
  parses a fresh object — no caller can mutate the cache — and the JSON contract is enforced
  at `set()` time). Writes are serialized on a promise chain so `flush()` has a stable point;
  a backend rejection (localStorage quota, native I/O) **re-queues the key and never poisons
  the chain**.
- **Lifecycle.** `App.tsx` hydrates on each game load *before* scene load, so systems that
  read saved progress at spawn see it. It flushes on background — `visibilitychange` /
  `pagehide` on web, Capacitor `App` `appStateChange` on native — and a game swap flushes the
  outgoing namespace before clearing the cache.

## Gotchas

- **Atomic ≠ durable, and `flush()` does NOT close that gap — it is not an fsync on ANY backend.**
  A crash right after `set()` can lose that write; it is never partially written. `flush()` gets the
  value to the *platform*, and then the platform decides when it reaches the platter:
  - **Android** — `SharedPreferences.apply()` returns before the write hits disk.
  - **Web / Electron** — `localStorage.setItem` is synchronous into Chromium's in-memory area, but
    the on-disk LevelDB is committed on a **clean shutdown**. A `SIGKILL` loses every write since
    the last commit.

  **MEASURED on the editor** (2026-08-19, `games/anim-bug`, backend 5183): identical
  `set()` + `await flush()` returning `pending:false`, with the raw `localStorage` entry confirmed
  present, then —

  | how the process ended | the flushed value after relaunch |
  |---|---|
  | `npm run editor:stop`, graceful (SIGTERM, exit hooks ran) | **survives** |
  | `SIGKILL` immediately after `flush()` | **lost** |
  | `SIGKILL` 8 s after `flush()` | **lost** |

  Not a timing race — waiting does not help, because nothing commits until shutdown. ⚠️ This bites
  the editor itself: `stop-editor.sh` falls back to `SIGKILL` when Electron does not exit within its
  graceful window ("did not exit gracefully — forcing"), so the sanctioned stop CAN discard editor
  prefs — no longer silently, and less often: the window was raised 5 s → 15 s after a
  healthy-but-slow exit was measured at 10 s, and the force path now names what it drops. It also means a `kill -9`'d session's *deletes* revert — the old value is still the
  last thing on disk.

  So a game that must not lose progress cannot rely on `flush()` alone; it leans on the OS lifecycle
  (that is what flush-on-background is for) and, where the value is irreversible, on being able to
  re-derive the state from an authority that is not PlayerPrefs.
- ⚠️ **`flush()` resolving does NOT mean the write landed, and reading it back cannot tell you.**
  A rejected `backend.set()` (quota exceeded, a native I/O error) is caught in `drain()`, re-queued
  into `dirty` and warned about — and `writeChain` still settles *fulfilled* so later writes are not
  poisoned. Meanwhile `cache` keeps the value, so `get()` returns it happily. Every ordinary signal
  says success. **`await flush()` then `hasPendingWrite(key)` is the only way to learn otherwise.**

  This exists because the IAP ledger needs it (see [iap.md](./iap.md)): its durability check read
  the value back and therefore could not fail, so it confirmed a grant that never reached the disk
  and the purchase state machine then took an irreversible step on it. Any consumer gating something
  irreversible on "is it saved?" must use this; a read-back is self-confirming. Still not an fsync —
  `false` means the platform accepted it, not that it is on the platter.

- **No cross-key transaction.** Two values that must stay consistent belong in **one** key.
- **JSON only.** `undefined` deletes the key. A top-level function/symbol or a cyclic value is
  skipped with a warning (not stored). Nested functions are dropped by `JSON.stringify`;
  `NaN`/`±Infinity` coerce to `null`. Keep values plain data.
- **Determinism.** `playerPrefs.ts` is under `runtime/**` and uses no wall-clock / randomness
  (the envelope has no timestamp/nonce), so it's safe for the verification harness — tests run
  against `InMemoryBackend` with `resetPlayerPrefsForTest()` in `afterEach`.

## Related

- [engine-concepts.md](./engine-concepts.md) — service/singleton vocabulary.
- [scene-loading.md](./scene-loading.md) — the `Persistent` trait (in-session survival, a
  different mechanism from disk persistence).
- [verification-harness.md](./verification-harness.md) — the headless test loop the integration
  test drives.
