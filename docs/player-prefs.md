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
                                                  // → { discardedPending: string[] } (see Gotchas)
PlayerPrefs.get<T>(key): T | undefined           // sync, returns a fresh copy
PlayerPrefs.set<T>(key, value): void             // sync into cache; atomic durable write is debounced
PlayerPrefs.has(key): boolean
PlayerPrefs.delete(key): void                    // also: set(key, undefined)
PlayerPrefs.keys(): string[]
PlayerPrefs.clear(): void                         // empties THIS game's namespace
PlayerPrefs.isHydrated(): boolean                 // true once init() has hydrated the cache
PlayerPrefs.isSwapInFlight(): boolean             // true while an init() swap is mid-flight (see Gotchas)
PlayerPrefs.swapGeneration(): number              // opaque token — capture before your own await, compare after (see Gotchas)
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
  `gameId`, so two games on the same device/browser can't collide. **That guarantee has two parts,
  and only one is closed.** `init()` is `async`: it captures the prefix, awaits
  `backend.getAll(prefix)`, then hydrates. Unserialized, a second `init()` could swap the namespace
  and clear the cache inside that await, and the first call's continuation then poured its rows into
  the second call's cache — g2's saved data readable *and re-writable* under g3's namespace, since
  `set()` marks the key dirty and `fullKey()` uses the *current* prefix. **The init-vs-init path is
  fixed (#428):** `init()` queues on its own promise chain (mirroring the write pipeline below), so
  an overlapped call is **queued, never superseded and never rejected**, and no two `init()` bodies
  interleave. Queuing rather than bailing is what keeps `discardedPending` meaningful — the second
  call runs a *real* swap from the first's finished state instead of reporting `[]` because the
  first already cleared `dirty`. **The write-side path is closed too (#438):** the OUTGOING
  `namespace`/`backend`/`cache`/`dirty` stay live for the *entire* `await backend.getAll(prefix)`
  round-trip — the incoming namespace/backend are computed into locals and installed in one
  synchronous block right after the await, with no `await` in between. So a synchronous
  `set()`/`del()`/`clear()` racing the window — e.g. an outgoing game's async auth/sync handler
  resolving mid-swap — still lands in the *outgoing* namespace, never contaminating the incoming
  one. `isHydrated()` deliberately stays `true` throughout the window: it is truthfully describing
  the outgoing store, which has genuinely been read from its backend. Two `dirty`-only pending-key
  snapshots are taken to tell what happened to a write that raced the window — one just before the
  await (`preWindowPending`), one at install time (`fullPending`). **`fullPending` does NOT
  include everything in `preWindowPending`** — a pre-window key that lands successfully during the
  window (the outgoing backend accepts it before the install runs) drops out of `dirty` and so out
  of `fullPending`, which is exactly why the discarded report filters `preWindowPending` down to
  `preWindowPending.filter(k => fullPendingSet.has(k))` rather than reporting the raw snapshot: only a
  pre-window key STILL pending at install is genuinely lost, reported via `reportDiscarded`. A key
  that appears in `fullPending` but was NOT in `preWindowPending` was written during the window
  itself, after the pre-swap flush loop had already finished, and never offered to a flush at all —
  that's a raced write, reported via `reportRaced`. Neither snapshot sees a `drain()` batch that is
  genuinely mid-flight (taken out of `dirty` for its own `Promise.all`, not yet settled) at the
  instant either snapshot is taken — that write's eventual settlement is handled by `drain()`
  itself, not by `discardedPending`: a late success lands durably in the outgoing store (nothing
  to report); a late rejection, arriving after the swap has already moved `namespace` away, is
  reported through `drain()`'s own "already swapped" `console.error` instead — `drain()` captures
  `batchNamespace`/`batchBackend` locals at the start of each batch precisely so a rejection
  settling after a swap is reported as lost rather than silently re-queued against the incoming
  namespace/backend. If `getAll()` throws, the incoming namespace is still installed, but
  explicitly empty and unhydrated (see the `getAll()`-rejection gotcha below) — this is a fail-loud
  path, not a silent one. **Callers cannot write during the window either:**
  `PlayerPrefs.isSwapInFlight()` reports `true` for the duration, and `agentBridge.ts`'s
  `player-prefs-write` op refuses with `NOT_AVAILABLE_HERE` — ALL FOUR actions, `flush` included,
  since any of them can settle after the install and answer for a namespace it no longer owns —
  rather than accept an op it cannot truthfully report on. `player-prefs-read` is NOT refused,
  since a read during the window answers truthfully about the (still fully hydrated) outgoing
  store.
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

- ⚠️ **`init()` DISCARDS whatever a failed flush re-queued — it now REPORTS this instead of
  silently dropping it (#421).** `init()` clears `cache`/`dirty` unconditionally to hydrate the new
  namespace/game, and the swap PROCEEDS regardless — a quota-exceeded phone must not hard-block an
  OTA sub-game switch. But `dirty` can be non-empty when it does, for up to THREE distinct reasons,
  and `init()` now `console.error`s the discarded keys — through a message specific to each reason —
  and returns the union as `discardedPending` (sorted):
  - **A real game swap** (`init()` re-called while already hydrated): the pre-swap step drains to
    CONVERGENCE, not `flush()`'s bounded two drains — `flush()` alone snapshots `dirty` before
    awaiting the backend, so a `set()` landing during its second drain is never attempted by anyone
    and would otherwise be reported as "rejected" when it was never even tried (#421 review). If the
    loop converges, anything still `dirty` was genuinely **rejected by the backend** (quota, native
    I/O). If it hits its cap (`MAX_PRESWAP_FLUSHES`) still changing, the message says explicitly that
    some keys may have been attempted-and-rejected and others may never have been attempted — it
    does not claim either. Either way, the outgoing game's last write to that key is lost.
  - **The very first `init()` call**: no flush runs on this path at all, so a dirty key here was
    `set()` *before* `init()` ever ran — it only ever lived in the throwaway `'default'`-namespace
    cache `init()` is about to clear, and nothing was ever sent to a backend. This is the "every
    signal says success" case above (a caller bug — writing before `init()`), not a rejection, and
    the message says so — do not conflate the two in a message, that conflation is what cost two
    review rounds on #422's sibling issue.
  - **A write that raced the swap window (#438):** written by the outgoing game *during* the
    `await backend.getAll(prefix)` round-trip, after the pre-swap flush loop above had already
    finished — never offered to a flush at all, and discarded by the synchronous install the
    instant it runs. Reported through its own message (`reportRaced`) that says exactly this,
    rather than blaming the backend the way the first bullet's message would.
    **Two shapes reach this message, not one (#454 B).** The second is a key that was pending
    *before* the window, LANDED durably during it, and was then re-set before the window closed:
    it is back in the pending set at install time and, by set membership alone, is
    indistinguishable from a key the backend never accepted — so it used to be reported as
    discarded, blaming a backend that had in fact accepted the write. `drain()` records every
    accepted key into a `windowLanded` set while a window is open, which is what tells the two
    apart; `discardedPending` (the caller-visible union) was already correct and is unchanged by
    this — only the console attribution moved. `windowLanded` tracks the LATEST attempt for a
    key, not "ever landed" (review finding 1) — a key that lands, is re-set, and whose re-write
    is then genuinely rejected goes back to being reported as discarded, not raced. There are
    therefore four outcomes for a pre-window key, not two: never lands (discarded); lands and
    stays landed (reported nowhere); lands and is re-set with the re-write still pending (raced);
    lands, is re-set, and the re-write is rejected (discarded again).
  Both callers (`App.tsx`'s `GameShell` boot effect, `editor/setup.ts`'s `createGameEditor`) log the
  discarded keys with the outgoing/incoming game context `init()` itself doesn't have. Neither
  routes this through the event journal — a game swap is a two-world atomic swap, and the journal is
  per-world, so the record would land in the world being discarded.

  ⚠️ **A `getAll()` rejection leaves `hydrated` correctly `false`, not stale-`true`.** `init()` sets
  `hydrated = false` immediately after clearing `cache`/`dirty`, before the `await backend.getAll()`
  — so a throw there is answered as "not hydrated" (the true state for the new namespace) rather
  than carrying over the PREVIOUS namespace's `true`. `agentBridge.ts`'s `prefsUnhydrated()` gates
  every prefs read/write on this flag; before this, a throwing `getAll()` left it stale-true and a
  caller got `keys: []` for a store it never actually opened, indistinguishable from a genuinely
  empty one.

  ⚠️ **`GameShell` is the only in-process seam that reaches the swap case — File → Open Project in
  the Electron editor cannot, and neither can the web-served editor, for two different reasons.**
  #421 named "File → Open Project in the editor" as a discard seam; it is not one. In the Electron
  editor, `setProject` ends with `mainWindow.webContents.reloadIgnoringCache()`
  (`engine/electron/main.ts`), so `createGameEditor` always runs in a FRESH renderer with
  `hydrated === false` and the pre-swap flush never executes there. In the web-served editor there
  is no in-process "Open Project" action at all to begin with — `EditorApp`'s `React.lazy(() =>
  createGameEditor())` is a module-level constant evaluated once per page load
  (`engine/app/App.tsx`), and the project a dev server serves is fixed by `MODOKI_PROJECT` at server
  start; "File → Open Project" itself is an Electron-only native menu item (`onOpenProject` in
  `engine/electron/main.ts`), absent from the web build. Either way, `createGameEditor` can only
  ever hit the write-before-`init()` case. The live swap seams are an **OTA sub-game switch** and
  **hash navigation between two baked games**, both re-entering `GameShell`'s `[gameId]` boot effect
  in a live process.

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

ALL FOUR actions — `set`/`delete`/`clear`/`flush` — are refused with `NOT_AVAILABLE_HERE` while a
game/namespace swap is in flight (`PlayerPrefs.isSwapInFlight()` — see Gotchas, #438), `flush`
included. ⚠️ **That refusal is an INTERVAL, not a sample (#454 C).** The entry-time check only
answers for the instant the op started; a swap landing during one of the op's own
`await PlayerPrefs.flush()` calls would let the `pendingKeys()`/`hasPendingWrite()` readback
answer against the INCOMING namespace and report a clean success for writes belonging to the
outgoing store. So the op captures `PlayerPrefs.swapGeneration()` alongside the namespace at entry
and re-checks it after **every** internal flush, degrading the reply if it moved.

**This post-flush check does NOT refuse (#454, review finding 2).** By the time it can fire, the
mutation has already happened — the cache write landed, and a durable write was at least
attempted against the outgoing namespace — so `NOT_AVAILABLE_HERE` (which at entry truthfully
means "nothing was done") would be a lie here; worse, a caller retrying a `delete` whose durable
remove already landed would then see `NOT_FOUND: nothing was deleted` and conclude its delete
never happened. Instead it reports `PARTIAL` with `durability:'unknown'`, merging in whichever
facts that action already knows are true (`deleted:true`, `cleared:<n>`, etc.) but never a
`saved`/`pendingWrites` field — those are exactly what's unknown. The check is also deliberately
**conservative**: it fires whenever a swap started during the await, even in cases where the
readback would in fact still have been truthful (the swap may be parked behind this op's own
`writeChain` and not yet installed) — over-reporting "unknown" is the safe direction, claiming a
durability we could not observe is not.

It is a generation counter rather than a second `isSwapInFlight()` sample because a swap that
opens *and closes* entirely inside the op's await leaves that flag back at `false` by the time the
op resumes — a re-sampled flag structurally cannot see it, and a monotonic counter can. The
counter's justification is defence-in-depth plus a genuinely reachable case: two queued `init()`
calls where one completes entirely inside this op's own await (`initChain` serializes them, so the
first can finish before the second even starts). A swap that both opens and fully closes *inside a
single `init()`'s own body* while parked behind this op's `writeChain` proved impossible to
construct against the real, serialized `init()` — any swap on an already-hydrated store must
itself call `flush()` before it can install, and that `flush()` shares this op's own `writeChain`,
so it cannot finish before this op's own gated write settles. Don't present that unconstructible
case as the driver for the counter; the review's own regression test records that it could not be
built.

A round-4 fix exempted `flush` on the theory that draining whatever the outgoing store already
owes is harmless — but a `flush` that is still draining when the install runs settles *after* the
swap, so `PlayerPrefs.pendingKeys()` (read to decide the reply) answers against the
already-installed INCOMING namespace instead: a write that never landed anywhere reported
`{ok:true, flushed:true, pendingWrites:[]}`, a false success. The same reasoning applies to
`set`/`delete`/`clear`: even where the write itself durably lands in the OUTGOING backend, this op
cannot truthfully report so once the swap has moved the namespace out from under it. Reads are NOT
refused during the same window — a read answers truthfully about the (still fully hydrated)
outgoing store, since there is nothing for it to settle across.

**A second production consumer of `swapGeneration()` — `probeVerdictProvider`'s `write()` (#487)
— shows the other shape this pattern takes.** `agentBridge.ts`'s check above fires AFTER the
mutation has already happened, so it can only degrade the reply (`PARTIAL`, `durability:'unknown'`);
it cannot undo a write already attempted. The probe-verdict check fires BEFORE its write, so it CAN
refuse outright, and does — a verdict whose captured namespace or generation no longer matches is
dropped, not stored. Dropping is safe there specifically because the cost is one re-probe next
launch; a durable-write consumer rarely has that option. **The generalizable fact: what a
post-await session check should DO depends on whether the mutation it's guarding has already
happened** — refuse before, degrade after. See `docs/rendering.md` § "The boot ramp probe" for the
probe's own mechanics; this is only the `swapGeneration()`-consumer shape of it.

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
