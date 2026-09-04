# Cloud sync

The engine's cloud-save protocol — a sync-guaranteed **group** as the unit of versioning and
transport, so a game's durable save data can be exchanged with a per-account cloud document without
losing data on a race, a torn write, or a genuine two-device fork.

## What it is

A game's save data does not all share one lifetime or one merge rule. Court, the first consumer,
has a coin balance that should be **chosen** between two devices, a purchase record that must be
**unioned** regardless of which device wins, and a settings blob that should silently take
**whichever device touched it last**. Cramming all of that behind one document and one version
counter means every field pays for the group's most conservative rule.

This module inverts that: the game declares one or more **sync groups**, each backed by its own
cloud document, its own monotonic version, and its own device-local marks. The engine drives the
same protocol — compare-and-swap versioning, a fingerprint-derived dirtiness check, a four-case
decision table, and fork resolution — identically over every group, while each group answers for
its own merge rules, its own "is this worth protecting" predicate, and its own fork policy.

**A group is a versioning/transport unit, not a merge unit.** Fields inside one group can and do
have different merge rules — Court's purchase group unions `entitlements` and chooses `coins` in
the same group. Grouping replaces the per-save version; it does not replace a game's field-by-field
merge table.

## Key files

| File | Role |
|---|---|
| `engine/packages/modoki/src/runtime/sync/types.ts` | The declaration surface — `GroupMarks`, `LocalGroup`/`CloudGroup`, `GroupStore`, `ForkPolicy`, `GroupAtomicity`, `SyncGroupSpec`, `defineSyncGroup`, `GroupTransport`. |
| `engine/packages/modoki/src/runtime/sync/decide.ts` | `hasLocalWrites`, `scopeMarksToAccount`, `decideGroup` — the pure four-case decision table. |
| `engine/packages/modoki/src/runtime/sync/runGroupSync.ts` | `runGroupSync`/`runCloudSync` — the per-group attempt loop (CAS re-decide, the durability two-phase write) and the aggregate runner over a set of groups. |
| `engine/packages/modoki/src/runtime/sync/resolveFork.ts` | `resolveGroupFork` — apply the player's fork answer for one group. |
| `engine/packages/modoki/src/runtime/sync/coordinator.ts` | `CloudSyncCoordinator` — *when* a sync runs. Debounce, the pending-conflict suppression, trigger coalescing, and the #506 teardown guard. Generic over the FORK (`SyncFork`), never the save. Promoted out of Court in #658. |
| `games/court/runtime/saveSync.ts` | The first consumer's group declarations (`courtProgressSaveGroup`/`courtPurchasesSaveGroup`/`courtSettingsSaveGroup`) and its own field-by-field merge rules. Worked example. |
| `games/court/accounts.md` | Court's account system end to end — auth, the conflict dialog UI, the account-deletion flow. Read it for how a game WIRES this contract, not for the contract itself. |

L2 folder (`'sync'` is in `L2_FOLDERS`, `engine/eslint.config.js`), importing no other L2 folder —
in particular not `storage/`. The one edge out of the folder is `coordinator.ts` → L0
`core/liveness`, which is legal (L2 may reach L0) and required: #573 makes the shared teardown token
the ONLY sanctioned epoch/generation implementation, and a hand-rolled counter is a build failure.

A game hands in a `GroupStore`/`GroupTransport` and this module never
learns what backs them, the same structural-typing inversion `storage/prefsDocStore.ts` and
`iap/ledger.ts` already use. Pure and clock-free: every clock reading (`now`) arrives as a
parameter, so the determinism guard is satisfied by construction.

## How it works

### The group is the unit, and why

A **sync-guaranteed group** is one cloud document, one monotonic `version`, one set of
device-local marks (`GroupMarks`: `lastSyncedVersion`, `lastSyncedFingerprint`, `uid`,
`lastSyncedAt`). A game declares groups by what must stay CONSISTENT together — which is a
different question from what happens to share a storage key, though for the reason below the two
usually end up meaning the same thing.

**Why the marks live inside the group's own document.** A game's storage layer is atomic per key
(see `docs/player-prefs.md`), so a group whose content and marks share one key cannot tear them
apart: a rejected write drops both, leaving the group coherently behind rather than holding a
receipt for content it never stored. The next sync sees the group behind the server, reads clean
against its own (unmoved) mark, and re-fetches. Self-healing, with nothing to remember.

### Single-key vs multi-key — a probed guarantee, not a convention

That self-healing property holds only for a **single-key** group. A group spanning several storage
keys can still land its marks while a content write is rejected — after which it reads clean at a
version it never actually holds, and the next sync uploads stale content over whatever the server
holds (the failure #491 names). Worse, a *partial* failure across a multi-key group's keys — some
land, some don't — leaves content matching neither side, which reads dirty against the old marks
while the server has moved. That is a fork with no coherent local side to offer the player, and
`onFork: 'ask'` cannot ask a meaningful question about it.

So `atomicity: GroupAtomicity` is a discriminated union, not a boolean the declarer picks freely:

- `{ kind: 'single-key' }` — the group's one `store.write()` already carries content and marks
  together. Nothing more is owed.
- `{ kind: 'multi-key'; durable(): boolean }` — **required** to declare multi-key, so the compiler
  asks for the durability probe rather than a convention nobody re-reads. `durable()` reports
  `false` when any of the group's keys still has an unlanded write. This is what buys back safety
  for a group that genuinely cannot be one key: `persist()` (`runGroupSync.ts`) writes the content
  first with marks left UNADVANCED, flushes, probes `durable()`, and only once that says the
  content actually landed does the marks write go out. Reading the content back does **not**
  answer this — a rejected backend write is commonly re-queued while the in-memory cache keeps
  returning the value, so a read-back check confirms itself rather than the backend.

  ⚠️ **This is damage control, not a self-heal, and the difference decides how a game should
  group.** The gate is only clean when the content write failed *entirely* — the group then still
  holds coherent old content and the next sync re-fetches. A *partial* multi-key failure is the
  unrepresentable case above, and no policy resolves it well. The engine's own storage contract
  already says the right answer directly: state that must change together goes under one key. Reach
  for `multi-key` only when a group genuinely cannot be consolidated (Court's first cut of this had
  none that couldn't be — every one of its groups ended up `single-key`), never because it is easier
  to declare.

### `SyncGroupSpec` — the declaration surface

```ts
interface SyncGroupSpec<T> {
  id: string;                 // the cloud document id — stable for the group's life (see below)
  store: GroupStore<T>;       // read/write/flush against local storage
  fingerprint(content: T): string;
  isFreshAndEmpty(content: T): boolean;
  merge(local: LocalGroup<T>, server: CloudGroup<T>, choice: ConflictChoice): T;
  adopt(local: LocalGroup<T>, server: CloudGroup<T>): { content: T; upload: boolean };
  onFork: ForkPolicy;
  atomicity: GroupAtomicity;
}
```

- **`fingerprint`** — a stable serialization-and-hash of the content only (order-insensitive fields
  must be sorted so two devices holding the same content produce the same value). Exclude anything
  that changes without the player acting — an ad cooldown, a re-anchored clock — or the group reads
  dirty for a non-event and can raise a fork dialog whose entire content is a timestamp.
- **`isFreshAndEmpty`** — "this group has nothing worth protecting": a never-synced device holding
  only defaults. Must account for whatever `store.read()` **seeds** as a side effect (Court's
  wallet grants a new player's starting coins on first read) — a predicate written as "equals empty"
  reports every fresh install as dirty, turning a silent adopt into the "choose between nothing and
  your progress" dialog, whose reflex *keep this device* answer then uploads the empty save over a
  real account.
- **`merge`** — resolves a genuine fork, called only after the player has answered an `'ask'` group.
  Fields exempt from the player's choice (a purchase, an unioned record set) are merged here on
  *both* arms — the choice adjudicates progress, not everything.
- **`adopt`** — resolves the *silent* `take-server` path, where nothing local is worth preserving.
  A separate hook from `merge`, deliberately: this path fires with nothing local to preserve, so a
  union here can preserve nothing, and after a sign-out it actively **leaks** — folding the
  previous account's content into the new account's document, with no inverse. A union belongs on
  the fork path (`merge`), which is one player's account by definition; `adopt` is for something
  genuinely exempt from the choice, like a restored purchase this device holds that the server has
  never seen. `{ upload: true }` says the adopted result holds something the server doesn't, so the
  silent adopt owes an upload of its own.
- **`onFork`** — see Fork policies below.

`defineSyncGroup(spec)` is the only constructor; it exists solely to keep `T` checked at the
declaration site while erasing it into `AnySyncGroup` for the heterogeneous runner (`runCloudSync`
drives groups of different content types through one loop — every value handed back to a group came
out of that same group, so the erasure is sound).

`SyncGroupSpec.id` is the cloud document id and must stay stable for the group's life — renaming it
orphans the old document, reachable by nothing. A game that deletes an account must enumerate its
actual documents (a `list` over the account's collection) rather than trust a hardcoded set of
group ids, for exactly this reason (Court's `deleteAllSaves`; F23 in the retired tracker — see
"`F<n>` citations" below).

### The four-case decision table

Two mechanisms answer two different questions. The **version counter** decides *whether the two
sides have forked* — a monotonic integer per group, with the server accepting an upload only at
exactly `current + 1` (a compare-and-swap, enforced server-side, cheap and exact, no content
inspection needed). The **fingerprint** decides *whether this device has unsynced writes* — a bare
version number can't tell "my 9 IS the server's 9" from "my 9 is a different 9 that never left this
device," and that ambiguity loses data silently:

1. Both devices synced at v8.
2. Tablet goes offline, writes local v9.
3. Phone uploads its own v9; server = 9.
4. Tablet reconnects: `local.version === server.version`, so "nothing to do" — the tablet's write
   is never uploaded, the phone's never arrives, and the tablet's *next* save goes to v10, which the
   server accepts, silently overwriting the phone's v9.

So the device tracks `lastSyncedVersion` — the version it last actually **exchanged**, not merely
observed — and `decideGroup` (`decide.ts`) folds that against the server version and dirtiness into
four cases:

| | no local writes | local writes pending |
|---|---|---|
| `server.version == lastSynced` | `none` | `upload` at `server.version + 1` |
| `server.version > lastSynced`  | `take-server` (silent adopt) | `fork` |

Plus a `server.version < lastSynced` case (the cloud document was reset or rolled back — not a
fork, just a lineage to re-establish, so it uploads at `server.version + 1`) and `create` when
there is no server document yet.

`hasLocalWrites` (the dirtiness half) treats a never-synced group with `isFreshAndEmpty(content)`
true as clean — the fresh-install exclusion the table above depends on to avoid raising a fork on a
brand-new device signing into a real account.

`scopeMarksToAccount` re-derives the marks against the account actually signed in: a mismatch reads
as never-synced (the safe direction — the group looks dirty, uploads once redundantly, and cannot
claim the server has seen writes it hasn't), *unless* the current content's fingerprint still
matches what the previous account's marks describe, in which case that content is already safe in
the previous account's cloud and this device owes the new one nothing. Getting this wrong in either
direction loses data: treating a stranger's leftover marks as belonging to the new account can push
one account's content into another's document (a silent cross-account overwrite); treating a
legitimate carry-over as "clean" can erase progress made offline before the sign-in.

### The CAS re-decide loop

`runGroupSync` (`runGroupSync.ts`) drives one group to completion: load the server document, decide,
act, and on a rejected push (`'conflict'` — another device wrote first) **re-read and re-decide,
never blindly re-push**. A write that lost a race was, by definition, made while this device held
unsynced changes against a server that has since moved — that is a fork by definition, and a blind
retry would silently destroy the other device's work. The one retryable case is a server that moved
*backwards* (a cleared/reset document), where the re-decide yields a fresh `upload`. The attempt
count is bounded (`maxAttempts`, default 3) — a rejected write and a misconfigured security rule are
indistinguishable to the transport, and unbounded retries spin forever on a player's phone.

Two races the loop guards explicitly, both found porting Court — a working game — onto this
contract (in the now-folded `per-group-sync` tracker; the rationale lives here):

- **A game write landing during the network round trip.** `localMovedUnderUs` re-checks the store
  immediately before applying a content-*replacing* outcome (`take-server`, or a fork resolved by
  adopting the server outright) — the decision was made against a read that may now be one or two
  round trips stale. This check applies only to **established** lineages; re-deciding against a
  fresh-install's synthetic post-adopt state would defeat the fresh-install exclusion and turn a
  benign race into the "choose between nothing and your progress" dialog.
- **A game write landing during the *push's* round trip**, for a push that writes content (a
  policy-resolved merge, or an adopt that deferred its own persist to this push). A plain upload is
  self-healing without a check — the marks stamp the fingerprint of what was *uploaded*, so a racing
  write reads dirty and goes up next pass, and it can only self-heal if it's still there. A
  content-writing push has no such self-heal: the marks would stamp `fingerprint(local.content)` —
  the very content that just overwrote the race — so the device would read clean with no next pass
  to recover the lost write. `pushAndPersist` re-checks after a successful content-writing push and,
  on a move, **discards the outcome and re-enters the loop** rather than applying it; the push itself
  stands, and the re-decide finds a device dirty against a server it has seen move, which raises the
  fork the player should see.

`persist` vs `persistMarks` is the same two-phase idea from the other direction: `persist` is
content-and-marks (used for anything that changes what's on disk — an adopt, a merge resolution);
`persistMarks` advances only the marks, reading the *current* store content through rather than a
decision-time snapshot, so a plain upload's marks-only path can never clobber a write that landed
during its own await.

### Fork resolution

When `onFork === 'ask'`, `runGroupSync` returns `{ kind: 'fork', local, server }` and writes nothing
— the caller shows the dialog and later calls `resolveGroupFork` (`resolveFork.ts`) with the
player's `ConflictChoice` (`'local' | 'server'`, deliberately two-way; see Fork policies).
`resolveGroupFork` re-reads local fresh (a write can have landed while the dialog was open),
computes `group.merge(local, server, choice)`, and — the same derivation `runGroupSync`'s own fork
branch makes — skips the push entirely if the merge taught the server nothing new
(`fingerprint(merged) === fingerprint(server.content)`), adopting at the server's version instead.
Skipping that check would cost every *other* device on the account a redundant lineage bump for a
document whose content never changed.

⚠️ **This pushes directly, never back through `runCloudSync`.** Routing the answer back through the
decision loop would simply re-derive `'fork'` — the device is still dirty against a server that
still holds the other lineage — and the player's answer would vanish back into the dialog it just
came out of.

The player's chosen content is written to the device even if the follow-up push fails — losing the
answer to a dropped connection is the accepted trade against the alternative (believing a fork was
settled when the server never heard about it). A `'conflict'` result here (the server moved again
while the dialog was open) returns `{ kind: 'restart' }`; the caller must re-run a full sync pass
for that group, not treat it as a plain failure.

### Fork policies

`ForkPolicy` is `'ask' | 'take-server' | 'take-newer'`:

- **`'ask'`** — raise the dialog. A game aggregating several `'ask'` groups behind one player choice
  (one dialog, applied to whichever groups actually forked — never to every declared group) is a
  UI-layer decision the engine doesn't make; see `runCloudSync`'s `asking: string[]` for the set a
  single dialog should resolve together, `sync/coordinator.ts` for the driver that aggregates them,
  and Court's `saveSync.ts` for a worked example of the game-side half.
- **`'take-server'`** — silently take the server's side. For a group whose local side is never worth
  defending.
- **`'take-newer'`** — silently take whichever side has the later `updatedAt`.

  ⚠️ **This puts a wall clock in charge of the outcome**, and it is only safe for a group where a
  wrong device clock can lose nothing the player would miss — a preference, never a balance and never
  progress. Court uses it for `settings` alone.

There is deliberately no third "combine" choice at the `ConflictChoice` level: a three-way choice on
a two-way question is how a dialog stops being read, and a whole-group merge is only safe if *every*
field has a defined merge rule. Fields that need to survive regardless of the choice go through
`merge`'s exemption path instead, on both arms.

### Worked example: Court's three groups, and the rulings that shaped them

Court declares `court.purchases` (`onFork: 'ask'`), `court.progress` (`onFork: 'ask'`) and
`court.settings` (`onFork: 'take-newer'`) — `games/court/runtime/saveSync.ts`. It replaced a single
document with one set of marks covering everything, and the shape of the three groups follows
directly from a sequence of owner decisions (numbered rulings, cited by number from code and tests —
keep the numbers stable):

1. **Purchase-related values are one group** — entitlements, passes, the coin wallet, and the
   purchased daily days. They must stay consistent together, so they share one document.
2. **The purchased-day record moved out of daily progress into that group**; daily progress stays
   pure (`assignments`, `completed`, `introSeen`, `bootMenuShownOn`, `salt`).
4. **One dialog resolves every group that actually forked, with a single choice.** See Fork
   policies above — `runCloudSync`'s `asking` list is the set that dialog answers for, never every
   declared group. Court's dialog rows are authored per FIELD, not per group, so a group that did
   not fork simply hides its rows rather than growing its own row pair.
5. **Existing save data was dropped rather than migrated** — Court had not shipped publicly yet, so
   there was no local migration, no cloud migration, no mixed-fleet window to protect. This is what
   let the three-group cut land as three separate commits without pricing a migration for each.
6. **The purchased-day receipt became `{dateKey: levelId}`** rather than a bare list, so it names
   the puzzle it bought. Once the receipt and the day's puzzle assignment could travel through
   different sync groups, a bought day resolved purely by re-deriving "today's puzzle" could hand
   back a different puzzle than the one the receipt paid for; naming the puzzle in the receipt
   dissolves the coupling instead of relocating it.
7. **`solvePaid` (the first-solve payout marker) lives in the progress group**, beside the solves
   it guards, not with the coins — see "Ordering as a substitute for atomicity" below for what
   protects the payout now that the marker can no longer share a document with the wallet.
8. **A group declares `multi-key` (and pays for the durability probe) honestly**, rather than
   declaring `single-key` for a group that, mid-migration, genuinely still spans several keys —
   see Single-key vs multi-key above.
9. **A coin balance that moved off the seeded starting grant counts as dirty.** The pre-existing
   rule excluded the wallet from "is this device dirty" entirely, which silently discarded a spend
   made on a never-synced device on the next silent adopt. Under a purchases group, `coins` is that
   group's *chosen* value, so a never-synced device that has spent or earned coins now raises the
   purchases fork instead of losing the difference. Accepted deliberately: one more dialog, on a
   question whose answer is usually "the cloud". `isFreshAndEmpty` for the purchases group is
   therefore not "equals empty" but "no entitlements, no passes, no purchased days, no
   `iapApplied`, no spend history, and coins still at the seeded starting grant" — read from the
   game's own config, never a literal, or a retuned starting grant makes every fresh install read
   dirty at once.

   ⚠️ **That cost widened past where it was first priced, and was then closed.** A `Clear
   progress`/forget-this-device wipe deliberately preserved entitlements, passes and `iapApplied`,
   which left the purchases group non-empty and forced a fork on the very next sign-in — a money
   dialog on a device with nothing left to lose, where "keep this device" would have pushed a
   re-seeded starting wallet over the real cloud balance. **Fixed**: the wipe now deletes
   `court.purchases` outright, so the group reads genuinely fresh-and-empty and the sign-in adopts
   the cloud silently instead. Pinned by
   `qa/cases/persistence/cloud-sync-clear-progress-adopts-silently.md` (QA-PREFS-0006).

⚠️ **Ruling 3 is missing from this list on purpose, not by omission.** The retired tracker's ruling 3
read *"mechanism first, regrouping second — the sync layer learns 'group' as a general contract
before Court declares groups against it"* — a sequencing decision about the ORDER the work landed in,
not a decision about the shape of what shipped, so it never carried a numbered citation anywhere and
has nothing to fold in here. Recovered from git history (see "`F<n>` citations" below) rather than
restated from memory.

### `F<n>` citations — the retired #532 tracker's numbered findings

Code comments, tests and these docs cite findings as `F1`, `F23`, `F1-bis`, and so on. Those numbers
were minted by `docs/plans/per-group-sync.md`, the in-flight tracker for issue #532 that this "Worked
example" section folds the rationale of — the tracker itself was deleted once it landed, per
[doc-conventions](./doc-conventions.md)'s rule that a landed plan's tracker does not survive it. This
document never adopted the `F<n>` numbering itself, so a live `F<n>` citation resolves to nothing
here.

The findings' CONTENT is not lost — it survives in the code banners and doc passages that cite it,
which is what every existing citation is actually pointing a reader at. The tracker's own text is
still recoverable from git history:

```
git log --diff-filter=D -- docs/plans/per-group-sync.md      # find the deleting commit <sha>
git show <sha>^:docs/plans/per-group-sync.md                  # the tracker's last content, one commit before deletion
```

Do not repoint the ~90 existing `F<n>` citations at this subsection — they stay as historical
markers naming which tracker finding a piece of code or prose descends from; this subsection exists
so a reader hitting one for the first time knows where to look instead of assuming it is a dead link.

### Ordering as a substitute for atomicity — Court's first-solve payout (ruling 7)

A payout marker used to share ONE document with the coins it guarded against a double payment, so a
torn write could never separate "the coins were paid" from "the payout already happened." Ruling 7
moved the marker into the progress group, beside `solvedIds`/`daily.completed` — the guards it
protects — which is right for the sync fork question but reopens the local-torn-write question the
old co-location answered for free, since the marker no longer shares a document with the coins.

**The fix is write ORDER, not a shared document**: write the guard and the marker together in one
atomic write, confirm it durable, and only THEN credit the coins. A rejected write then records
nothing and credits nothing, so a retry pays exactly once — strictly better than the old scheme,
which merely stopped a *repeat* payout rather than preventing a *missed* one. The residual this
does not cover — the progress document going missing *after* the coins already landed, so the
marker disappears with it and a retry pays again — is accepted and recorded in a comment on
`settleSolvePayout`, not silently absorbed. See `games/court/ads.md` § "A first-solve payout that
can't repay itself (#490)" for the full account, and `games/court/tests/coinEconomy.test.ts`/
`dailyPlay.test.ts` for the write-time property this pins.

**The general lesson:** when a ruling moves a value out of the document that used to protect it
against a torn write, look for an ordering fix before reaching for a second atomicity mechanism —
"guard + marker in one write, confirmed durable, then the dependent side-effect" recovers the same
guarantee without needing the two values to share a key.

### Still open: the narrowed dialog has never been seen on a device

When only some of a game's asking groups fork, the dialog narrows to the fields the forking groups
own (Fork policies above). Court's version of this — hiding all five `court.progress` rows on a
purchases-only fork, leaving only `Coins`/`NoAds` — is unit-tested with distinguishing assertions,
but data-correct is not pixels-correct, and nobody has looked at the resulting layout on a device.
`qa/cases/persistence/cloud-sync-purchases-only-fork-narrowed-dialog.md` (QA-PREFS-0007) is the case
that exists to close this gap; it stays open until an owner has watched it happen.

## Gotchas

- **A group is a versioning/transport unit, not a merge unit.** Don't reach for a second group just
  because two fields have different merge rules — that's what `merge`'s per-field logic is for.
  Reach for a second group when two things genuinely need *different fork policies* or *different
  fresh-install predicates* (Court's settings group exists because `'take-newer'` is fine for a
  slider and would be reckless for a coin balance).
- **`atomicity: 'multi-key'` is a probed cost, not a free choice.** It requires a `durable()` probe
  and costs a second write on every content-changing path (`persist`'s two-phase dance). Reach for
  `single-key` first; it is very often achievable by nesting named sub-documents inside one storage
  key rather than truly needing separate keys (Court's daily-challenge fields folded into
  `court.progress` this way).
- **`adopt` and `merge` are not interchangeable, even though both eventually decide "what does this
  group's content become."** `adopt`'s whole safety argument is that nothing local is worth
  preserving; using it on a genuine fork silently discards one side. A policy-resolved fork always
  goes through `merge`, never `adopt`.
- **`updatedAt` on a merged/adopted result is the LATER of the two sides' stamps when the result
  descends from both**, and the server's own stamp when the result purely *is* the server's content.
  Getting this backwards makes a `take-newer` policy or a dialog's "last played" row read a
  freshly-merged document as stale.
- **A group's `store.read()` may legitimately seed a default as a side effect** (a new player's
  starting balance). `isFreshAndEmpty` must be written against what the seeded content looks like,
  not against a hand-built "empty" fixture production never actually constructs — F3 in the retired
  tracker (see "`F<n>` citations" above) is the near-miss this produced in Court.
- **The transport's `load()` must throw on a read failure, never return `null`.** `null` means "no
  document for this group" and licenses a fresh-install `create`; conflating a read failure with
  "no document" lets an offline device conclude it's brand new and overwrite a real account.

## Related

- [player-prefs.md](./player-prefs.md) — the per-key atomic storage contract a `single-key`
  group's `GroupStore` is typically built on, and the source of the "state that must change together
  goes under one key" rule this module's `atomicity` split exists to enforce or probe around.
- [games/court/accounts.md](../games/court/accounts.md) — the full worked consumer: auth, the
  account-deletion flow, the conflict-dialog UI, and the device-measured incidents that shaped both
  Court's own merge rules and several of this contract's own defect fixes.
