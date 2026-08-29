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
  flushed write on a plain web tab, measured; Electron narrows the window to the write(s) in
  flight but still isn't an fsync).

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
PlayerPrefs.pendingKeys(): string[]               // the authoritative pending set (see Gotchas — NOT keys().filter(hasPendingWrite))
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
  - **A plain web tab** — `localStorage.setItem` is synchronous into Chromium's in-memory area, but
    the on-disk LevelDB is committed on a **clean shutdown**. A `SIGKILL` loses every write since
    the last commit.
  - **Electron** — same in-memory `localStorage` mechanism, but `LocalStorageBackend.flush()`
    (`runtime/storage/backends.ts`) additionally asks main to call `session.flushStorageData()`
    (`engine/electron/main.ts`'s `modoki:flush-storage-data` IPC handler) after every drained write
    batch — a forced-commit lever a plain browser tab has no equivalent of. This bounds the loss
    window to **the write(s) currently in flight**, not everything since the last clean shutdown
    (#335). Still not an fsync: `flushStorageData()`'s TS signature returns `void` — fire-and-forget,
    no completion signal to await — so a SIGKILL in the same instant as the call can still race it.
    ⚠️ **"Electron" here means the editor, not a shipped game** — a game builds `--target
    web|native|playable` and never runs on Electron, so this narrower window applies to the
    `<gameId>@editor` namespace and the editor's own prefs, not to anything a player's device does.

  **MEASURED** (2026-08-19, `games/anim-bug`, backend 5183, **pre-#335**): identical `set()` +
  `await flush()` returning `pending:false`, with the raw `localStorage` entry confirmed present,
  then —

  | how the process ended | the flushed value after relaunch |
  |---|---|
  | `npm run editor:stop`, graceful (SIGTERM, exit hooks ran) | **survives** |
  | `SIGKILL` immediately after `flush()` | **lost** |
  | `SIGKILL` 8 s after `flush()` | **lost** |

  Not a timing race at the time — waiting did not help, because nothing committed until shutdown.

  **RE-MEASURED against the #335 fix** (2026-08-26, `games/anim-bug`, backend 5182, this clone's
  dev editor): wrote a key, called `flush()` (confirmed the IPC round-trip returns `{ok:true}`),
  then `kill -9`'d the Electron main process and relaunched —

  | write | flush() called before SIGKILL | survived the SIGKILL |
  |---|---|---|
  | `probe` | yes | **survived** |
  | `noflush` (negative control, same process instance) | no | **lost** |

  The negative control in the *same* process instance is the distinguishing observation: it rules
  out "the whole mechanism changed for some other reason" and isolates the survival to the
  `flushStorageData()` call specifically. ⚠️ This bites the editor itself: `stop-editor.sh` falls
  back to `SIGKILL` when Electron does not exit within its graceful window ("did not exit
  gracefully — forcing"), so the sanctioned stop CAN still discard an in-flight write — no longer
  silently, and less often: the window was raised 5 s → 15 s after a healthy-but-slow exit was
  measured at 10 s, and the force path now names what it drops. It also means a `kill -9`'d
  session's *deletes* can still revert on a plain web tab — the old value is still the last thing
  on disk there.

  So a game that must not lose progress still cannot rely on `flush()` alone (Android and plain-web
  keep the wide window); it leans on the OS lifecycle (that is what flush-on-background is for) and,
  where the value is irreversible, on being able to re-derive the state from an authority that is not
  PlayerPrefs.
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

- ⚠️ **`keys()` cannot see a rejected DELETE — use `pendingKeys()`, not `keys().filter(hasPendingWrite)`.**
  `delete(key)` removes the key from `cache` (and so from `keys()`) in the same call that marks it
  `dirty`, so a key with a rejected `backend.remove()` is dirty and simultaneously absent from every
  cache-derived view. `pendingKeys()` reads `dirty` directly and is the only source that sees it
  (#422 — the agent-facing `player-prefs` ops reported `pendingWrites: []` for exactly this case
  before the fix). **"Authoritative" holds only at a STABLE point — after an awaited `flush()`**,
  the same qualifier `hasPendingWrite` already carries: `drain()` empties `dirty` BEFORE awaiting the
  backend calls, so mid-drain `pendingKeys()` under-reports a write that is genuinely in flight.

- **No cross-key transaction.** Two values that must stay consistent belong in **one** key.
- **JSON only.** `undefined` deletes the key. A top-level function/symbol or a cyclic value is
  skipped with a warning (not stored). Nested functions are dropped by `JSON.stringify`;
  `NaN`/`±Infinity` coerce to `null`. Keep values plain data.
- **Determinism.** `playerPrefs.ts` is under `runtime/**` and uses no wall-clock / randomness
  (the envelope has no timestamp/nonce), so it's safe for the verification harness — tests run
  against `InMemoryBackend` with `resetPlayerPrefsForTest()` in `afterEach`.

## Agent surface

`modoki_player_prefs` (read, `GET /api/player-prefs`) and `modoki_write_player_prefs` (write, `POST
/api/player-prefs`) expose the store to an agent; `device_player_prefs` / `device_write_player_prefs`
are the on-device twins. Split in two per `docs/mcp-tool-conventions.md` §7 ("if one argument value
changes whether it writes to disk, it is more than one tool") — verified in the code: `get`/`keys`/
`has`/`hasPendingWrite`/`pendingKeys` are pure cache reads with no lazy hydration and no `scheduleFlush`, while
`set`/`delete`/`clear` all dirty a key and schedule a durable write.

Every reply names its `namespace`, and it must be read, not assumed: the editor deliberately
hydrates `<gameId>@editor` (`engine/app/editor/setup.ts`) so a playtest save can't reach a shipped
build's store, so prefs read through the editor are NOT the store a web/native build sees. An
un-hydrated store REFUSES (`NOT_AVAILABLE_HERE`) rather than answering with an empty key list — the
cache fills only in `init()`, and before that "no keys" and "nobody looked" are the same empty
array. It gates writes too, and that half is sharper: a `set()` before `init()` lands in a throwaway
cache under the `'default'` namespace that `init()` then clears — every signal says success and
nothing survives.

`set`/`delete` flush before replying, so `saved:true` means the backend accepted the durable write;
a rejected write (quota, native I/O error) keeps its value in the cache, so a read-back structurally
cannot see the failure (see `hasPendingWrite` above) — such a write reports PARTIAL, never success.
`action` is required on the WRITE tool (the read takes only an optional `key`), and
`action:'clear'` additionally requires `confirm:true` — one rule on both surfaces, and on the device
the target is a real player's save data on an installed app.

`PlayerPrefs` gained a `namespace()` getter for this (`runtime/storage/playerPrefs.ts`) — a key list
is meaningless without knowing which store it came from.

Three behavioural refinements to the op contract (#422 follow-up — a key dirty-and-absent-from-cache
is not proof of a rejection; it's the identical signature an ordinary DEBOUNCED write leaves too):

- **`delete` on a key that is dirty and absent from the cache flushes rather than assuming a
  rejection.** If the flush settles it (the key was only ever debounced, never attempted), the op
  returns `ok:true, deleted:true, saved:true, alreadyRemoved:true` — the durable remove genuinely
  happened, this call just performed it. Only if the flush leaves the key pending does it return
  `PARTIAL` (the backend actually rejected it).
- **The named-key read's `present:false` branch carries `pendingWrite`**, but that flag means "the
  durable remove has not been accepted yet" — rejected, or merely still debounced — not "still on
  disk". `player-prefs-read` never flushes, so it can't settle which one it is; it only reports the
  ambiguity.
- **`clear`'s `PARTIAL` separates keys this call enumerated from keys already pending beforehand.**
  `pendingWrites` is the honest full dirty set; `failed` (keys this clear's own `flush()` retried and
  saw rejected again) and `alsoPending` (dirty before the clear ran) are reported as separate clauses
  so the count in the message stays consistent with `cleared`/`keys`.

## Related

- [engine-concepts.md](./engine-concepts.md) — service/singleton vocabulary.
- [scene-loading.md](./scene-loading.md) — the `Persistent` trait (in-session survival, a
  different mechanism from disk persistence).
- [verification-harness.md](./verification-harness.md) — the headless test loop the integration
  test drives.
