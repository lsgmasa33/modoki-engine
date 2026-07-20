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
  flush-on-background close the gap.

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

- **Atomic ≠ durable.** A crash right after `set()` can lose that write; it is never partially
  written. Call `flush()` at a save point you care about. On Android, `SharedPreferences.apply()`
  is async-to-disk, so even an awaited `set()`/`flush()` is not a hard fsync — durability leans
  on the OS lifecycle (that's what flush-on-background is for).
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
