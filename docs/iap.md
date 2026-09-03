# In-app purchases & subscriptions

Consumables, non-consumables and auto-renewing subscriptions on iOS (StoreKit 2) and Android
(Play Billing), with **crash-safe recovery** as the organising requirement rather than a feature
bolted on afterwards.

The owner's sentence, which the whole design exists to satisfy:

> *"make sure interrupted purchase e.g. force close during the transaction / crash, will be
> recovered in the next game session as long as the money is paid"*

Verified on real hardware, both platforms (2026-08-11): purchase → force-quit → relaunch → the
entitlement arrives, exactly once.

---

## 1. The two invariants

Everything else follows from these. If you change one line in this subsystem, check it against
both.

1. **Grant durably, THEN finish.** `finish()` — iOS `Transaction.finish()`, Android `consumeAsync`
   (consumable) or `acknowledgePurchase` (everything else) — is what stops the store re-delivering a
   transaction. Both stores hand back every unfinished transaction on every launch, and **that
   re-delivery IS the recovery mechanism**. Finishing before the entitlement is durable is the
   single way to permanently lose a purchase somebody paid for. So it is always last, and it is
   skipped entirely when the durable write cannot be confirmed: leaving a transaction open is always
   better than finishing one we failed to record.

2. **Every grant is idempotent, keyed by transaction id.** Invariant 1 deliberately leaves a window
   where a purchase is granted but not finished, so the store *will* re-deliver it. Without
   idempotency that window credits a coin pack again on every launch until the finish lands.

They are two halves of one thing: invariant 1 chooses to risk duplicate delivery over lost money,
and invariant 2 is what makes that trade free.

### Invariant 1 covers the GAME's state too — the grant hook (#371)

⚠️ **A game whose truth lives outside the ledger needs `configureIap({ onGrant })`, or invariant 1
holds only for the engine.** `settle()` runs `verify → ledger.recordGrant → flush → confirmDurable →
finish`, and `finish()` IS the consume. A game that writes its own coin wallet or entitlement flag
when `purchase()` resolves writes it *after* the store has already been told to stop re-delivering —
so a crash in that window loses the purchase with no recovery. That is invariant 1's own failure
mode, reintroduced one layer out by wiring rather than by logic.

The hook moves the consume behind the game's write:

```
verify → ledger.recordGrant → flush → confirmDurable
       → onGrant(grant)   ← the game writes its state and CONFIRMS it durable
       → backend.finish   ← the consume, last, and only if onGrant returned true
```

Owner, 2026-08-29: *"the flow should be purchase start, callback, increment the balance / change
flag, save them, then consume the purchase. the consume must be called last."*

Four contract points, each load-bearing:

1. **Returning false — or throwing — withholds the finish.** The transaction stays unfinished and
   the store re-delivers next launch. Same trade `confirmDurable` already makes: leaving a
   transaction open beats finishing one we failed to record. A refusal is the safe outcome, not an
   error path.
2. ⚠️ **The hook runs on the ALREADY-GRANTED path too**, not only on a fresh grant. Skipping it
   there makes the crash between the ledger write and the game's write *unrecoverable*: the
   re-delivery would find the ledger already processed, go straight to the finish, and the game
   would apply nothing, forever.
3. **Therefore the hook MUST be idempotent, keyed by `IapGrant.transactionId`** — it is called once
   per settle pass until a finish lands. It is the same key the ledger uses, which is what makes the
   two agree by construction rather than by two people remembering the same rule.
4. **`stillActive()` is re-checked after it returns.** The hook awaits the game's own flush, which
   is another window a game swap can land in.

**Optional, and omitting it changes nothing.** `games/iap-test` passes no hook and does not need
one: the fixture holds no game-side state at all, reading `iapBalanceOf()` straight off the ledger,
so for it the ledger genuinely *is* the truth. `games/court` is the first caller for which it is not.

Proved by five rows in `iapCrashMatrix.test.ts` — a refusing hook, a throwing hook, the
already-granted repair, many relaunches crediting once, and the no-hook default.

### The crash matrix

| Crash point | Store state | Our state | Next launch |
|---|---|---|---|
| after payment, before we hear | paid, unfinished | nothing | re-delivered → grant → finish |
| after we hear, before the grant is durable | paid, unfinished | nothing | re-delivered → grant → finish |
| after the grant is durable, before finish | paid, unfinished | granted | re-delivered → **no-op** → finish |
| after finish | paid, finished | granted | nothing to do |

No row loses money and no row grants twice. This table is **proved, not asserted** —
`engine/packages/modoki/tests/runtime/iapCrashMatrix.test.ts` walks every row plus the refusal cases.

---

## 2. Product kind decides who owns the truth

The most load-bearing distinction in the subsystem, and the easiest to get wrong in either
direction:

- **`non-consumable` / `subscription` → the STORE owns it.** Both platforms re-report an active
  entitlement forever (`Transaction.currentEntitlements` / `queryPurchasesAsync`), so we re-derive
  on every launch instead of remembering. Survives reinstall and a new device for free, and no local
  corruption can lose it. **Expiry, refunds and revocation are applied by the platform** — which is
  what makes serverless verification correct rather than merely cheap.
- **`consumable` → WE own it.** The store forgets a consumable the moment it is consumed, so the
  grant exists only in our ledger. This is the only kind for which durability is our problem, and
  therefore **the only kind the ledger is load-bearing for**.

Treating a subscription as ours means a reinstall loses it. Treating a consumable as the store's
means the balance vanishes on the first consume.

---

## 3. Shape

`runtime/iap/` is an L2 subsystem (see [architecture-layers.md](./architecture-layers.md)).

| File | Role |
|---|---|
| `types.ts` | `ProductKind`, `IapProduct`, `StoreTransaction`, `PurchaseOutcome` — store-agnostic vocabulary; nothing here names StoreKit or Play |
| `storeBackend.ts` | The **port**. Six methods, plus `NoopStoreBackend` (the default off-device) |
| `ledger.ts` | Durable + idempotent: the processed-transaction set and consumable balances |
| `verifier.ts` | `PurchaseVerifier` seam; `LocalVerifier` ships empty on purpose (§5) |
| `purchaseService.ts` | The state machine — `purchase()`, `reconcile()`, `restorePurchases()` |
| `capacitorStore.ts` | Adapts `capacitor-modoki-iap` onto the port |
| `mockStore.ts` | Editor/browser simulation + `pickStoreBackend()` |

### One `settle()`, entered from two doors

`purchase()` and `reconcile()` both funnel into a single `settle()`. **Recovery is not a second
implementation of the happy path — it *is* the happy path, entered from a different door.** Had they
been separate, the crash tests would prove the recovery path correct while saying nothing about
whether it still agreed with normal purchasing, and the two would drift on the first change. Resist
any refactor that splits them.

`reconcile()` must be called **once on every launch, before the player can buy anything.** Without
it, an interrupted purchase is never picked up.

### Concurrency: the ledger alone is not enough

`settle()` can be entered twice for the same transaction, concurrently — the `purchase()` promise
resolving, and the store's `purchasesUpdated` event driving `reconcile()`. The ledger's idempotency
check is synchronous, so **both pass it before either has written**. Measured on a device:

```
acknowledgePurchase: code=0
acknowledgePurchase: code=2  Server error   (42ms later, same tx)
consumeAsync:        code=0
consumeAsync:        code=6  Server error   (2ms later, same token)
```

Idempotency in the ledger cannot fix this because **the destructive step is in the store**. A
`settling` set provides mutual exclusion per transaction id; the loser reports `already-owned`.

### A game swap can outlive an await — check `stillActive()` right before the WRITE (#434)

A settle spans awaits that can last minutes (a platform sheet, Face ID, a parent approving
Ask-to-Buy), and `resetIap()`/`configureIap()` can run in that window — the editor's Open Project, or
an OTA sub-game module. `entitled` (the module's live entitlement `Set`) is **REASSIGNED, not
mutated**, across that swap, so a write that only checked `stillActive(c)` *before* an await can still
land in the INCOMING game's live `Set` if the check does not happen again *after* it. **The rule is
general, stated in `stillActive`'s own doc comment in `purchaseService.ts`: check `stillActive(c)`
immediately before every write to module state that follows an await capable of outliving the
session — not only before the await.** `refreshEntitlements()`'s happy path, its failure/catch
branch, and the post-`finish()` `entitled.add()` in `settleInner` all follow it now; the failure
branch was the gap closed on top of #434's first fix — an early return there used to hand back the
module-global `entitled` by reference, which could already be the incoming game's `Set`.

**The instance-level twin: `disposed`, guarding state a constructor's own async round-trip
established (#487).** `stillActive(c)` answers "is this still the live *session*" — no help when
the object being torn down is the instance itself. `CapacitorStoreBackend`'s constructor calls
`iap().addListener('purchasesUpdated', …)` and stores the unsubscribe handle in that promise's
`.then()`; a `dispose()` landing inside that native bridge round-trip used to null a binding that
was still `null`, and the resumed `.then()` went on to install an unsubscribe nobody would ever
call — the native listener outlived the game swap and drove the module-level `reconcile()` against
whatever `cfg` was live by then. The fix is a `private disposed` flag checked in BOTH halves of the
window: the `.then()` calls `h.remove()` directly instead of storing the handle, and the listener
callback itself bails. Both checks are needed because **the native listener is live from the moment
`addListener` is INVOKED, not from when its promise settles** — guarding only the handle-storage
half leaves the callback free to fire, and drive `reconcile()`, in the exact gap the flag exists to
close.

⚠️ **`settling.delete()` in `settle()`'s own `finally` is deliberately UNGUARDED — do not add a
`stillActive`-style check there.** `resetIap()` clears `cfg` and `entitled` but deliberately does
NOT clear `settling`, so a settle for the same transaction id restarting in the next session still
sees it busy via `settle()`'s in-flight check, and the stale `finally` releasing it later is correct,
not a leak. Court's `storeInFlight` (`games/court/runtime/systems.ts`) is the mirror image and needs
the OPPOSITE fix — a generation check IS required there — because `resetStoreUi` DOES clear its set
on teardown, so a next-session entry can be added right after, and only a generation check stops the
stale `finally` from deleting the NEW entry. Same shape, opposite requirement, because exactly one of
the two teardown functions clears its set: check which before copying either fix elsewhere.

**Two more sites, closed under the same rule (#487 items 3+4).** Both are post-await reads rather
than writes, which is why #434's sweep walked past them, and both were reporting a plausible
falsehood rather than corrupting anything:

- **`confirmDurable` after `ledger.flush()`.** `confirmDurable` reads back through PlayerPrefs, which
  the incoming game has already RE-NAMESPACED, so a swap inside the flush makes the read-back miss a
  write the backend genuinely took. The path then journalled `iap.durability-unconfirmed` at ERROR
  level — blaming storage quota or native I/O for a torn-down session. The money outcome was never
  in doubt (both arms decline to finish, which is the conservative direction); only the attribution
  was wrong, and an error-level journal line that names the wrong subsystem is how a session gets
  spent chasing PlayerPrefs. One `stillActive(c)` between the two now returns `tornDown` instead.
- **`restorePurchases`'s entitlement trace.** `reconcile()` spans a settle and so can outlive the
  session, and `entitled` is reassigned — so `[...entitled]` could name the INCOMING game's
  purchases as this restore's result. ⚠️ **The obvious fix — capture the Set before the await — is
  wrong here**, and this is the interesting part: `reconcile()` itself calls `refreshEntitlements()`,
  which REPLACES `entitled` on its happy path, so a pre-await snapshot reports the set from *before*
  the restore, which is precisely the number this trace exists not to report. And once a swap has
  happened, this session's own refreshed Set has already been dropped on the floor — there is no
  truthful list left to name. So the swap case journals `tornDown: true` at `warn` instead of a set:
  a restore reporting nothing *because it was torn down* is a different event from one reporting
  nothing because the player owns nothing, and that line is what a "restore did not give me back
  what I own" report gets read against.

  The general lesson, worth more than either fix: **a capture-before is not automatically the answer
  to a post-await read.** It is right when the await cannot legitimately change the value
  (`refreshEntitlements`), and wrong when the awaited work is *supposed* to change it. Ask which
  before copying the pattern.

### `StoreBackend` — the port that makes any of this testable

The interface is the only thing that differs between a phone and a headless test. It also earns its
keep twice over: the [interruption harness](#8-testing) is a ~40-line decorator that works
identically against StoreKit, Play Billing and a fake.

**A backend must never finish anything on its own.** That rule is why this repo has a first-party
plugin (§6).

---

## 4. Wiring a game

Product ids and grants are **authored data, not code constants** — a config resource read at
bootstrap, so a rename is one edit in the Inspector rather than an agent round-trip. Worked example:
`games/iap-test/runtime/`.

```ts
const backend = await pickStoreBackend({ useMock, store, products });
configureIap({ backend, store: createPrefsDocStore('iap.ledger'), products });
await reconcile();                    // the recovery pass — every launch, before any Buy button works
```

Persistence is **injected**: `runtime/iap/` and `runtime/storage/` are both L2, so the ledger
declares the tiny `IapLedgerStore` shape it needs and L3 wires `PlayerPrefs` in via
`createPrefsDocStore`. The constraint improved the design — an injected store is exactly what lets a
test drop a write, which is how the "durable" half of invariant 1 gets tested at all.

Buttons are declarative `UIAction` bindings, not bespoke TS:

- **`iap.buy`** — payload `{ product }` or the bare product-id string. No default: guessing would
  charge real money for a typo.
- **`iap.restore`** — **App Store review requires a visible Restore control.** It is deliberately
  just the launch path run on demand; restoring is not a different operation from recovering, and
  giving it its own implementation would give it its own bugs.

⚠️ Two more Apple rules that are cheap now and expensive to retrofit: a visible Restore control (as
above), and subscription **terms, price and billing period** shown before the purchase is confirmed.
Prices must come from the store (`productInfo()`), never hardcoded.

`PlayerPrefs.isHydrated()` must be true before `configureIap` — the ledger reads its document
immediately, and reading pre-hydration boots an EMPTY ledger, which makes `isProcessed()` answer
false for transactions already granted and re-grants every unfinished consumable. A double-credit
bug caused by wiring, with the state machine behaving exactly as designed on a ledger that lied.

---

## 5. Verification is LOCAL — and what that costs

**On-device, no server, no third party** (owner, 2026-08-11; RevenueCat explicitly declined).
StoreKit 2 verifies JWS on-device; `currentEntitlements` already excludes expired, refunded and
revoked transactions. `queryPurchasesAsync` is the Android equivalent. Both refresh against their
own store's servers, so no backend of ours is involved.

Accepted with the owner's eyes open:

- a lapse is observed at next launch, not the instant it happens;
- Android is weaker against rooted-device tampering (iOS's JWS verification is strong);
- **no cross-platform entitlement** — an iOS purchase does not unlock on Android;
- one residual crash window: `PlayerPrefs` writes through `@capacitor/preferences`, and Android's
  `SharedPreferences.apply()` is async-to-disk, so an awaited flush is **not** an fsync. A hard kill
  in that window can lose a *consumable* grant that was already consumed. Only a server closes it.

⚠️ **Durability is checked by asking whether the write was ACCEPTED, never by reading it back.**
`PlayerPrefs.set()` writes into an in-memory cache and queues the real write; a rejected backend
write (quota exceeded, a native I/O error) is caught, re-queued and warned about, `flush()` still
settles *fulfilled*, and `get()` keeps serving the cached value. So a read-back check confirms
itself — it re-reads the very cache the failed write already updated, and cannot fail for the
failure modes it exists to catch. `confirmDurable()` therefore consults
`PlayerPrefs.hasPendingWrite(key)` (surfaced through `PrefsDocStore.durable()`) *before* the
read-back. Get this wrong and `settle()` concludes "durable", calls `finish()`, and the store stops
re-delivering a purchase whose record vanishes on the next launch — the player's money, with no
recovery path, which is the exact failure invariant 1 exists to prevent.

### A rejection carries a diagnosis, not just prose (#499)

`call.reject(message)` alone is not enough on either platform, because the message is the one thing
that does NOT distinguish the cases. Both plugins pass Capacitor's full reject payload:

| Field | iOS | Android |
|---|---|---|
| `error.code` | `storekit.networkError`, `purchase.purchaseNotAllowed`, … falling back to `<NSError domain>:<code>` | `billing.<BillingResponseCode>` |
| `error.data.storeError` | `{ domain, code, description, failureReason?, underlying? }`, nested up to 3 deep | `{ domain: 'BillingResponseCode', code, description }` |

**Read it through `describeStoreError` (exported to games as `iapDescribeStoreError`), never by
hand.** The two fields live at different depths and the mistake is silent:

⚠️ **`call.reject(message, code, error, data)` does NOT flatten `data`.** iOS wraps it as
`["data": data]` (`PluginCallResult.swift`, `init(message:code:error:data:)`); Android does
`errorResult.put("data", data)` (`PluginCall.java`, the 4-arg `reject`); only then does
`native-bridge.js` copy that payload's TOP-LEVEL keys onto the rejected `Error`. So `code` is an own
property and `storeError` is one level down. **The first cut of #499 read `err.storeError` and
shipped a producer whose payload the reader could not see** — the fix landed, the journal looked
correct, and the entire diagnostic was `undefined` on every call. Worse, the unit test asserted the
same flattened shape, so the fake and the implementation were wrong *together*: the assertions were
green, and mutation-testing the fix still broke them "correctly". Caught in review, not by the
tests. The fixture builder in `iapFailurePaths.test.ts` now states the wire shape in one place, with
the Capacitor sources cited.

⚠️ **On iOS the underlying error is unwrapped from the `StoreKitError` enum's ASSOCIATED VALUE, not
from `NSError.userInfo`.** Swift's synthesized NSError bridge of a Swift enum keeps neither the
`URLError` inside `.networkError` nor the error inside `.systemError`, and `NSUnderlyingErrorKey` is
empty — so the `ASDErrorDomain`/`AMSErrorDomain` code that names the actual account or sandbox fault
lives *only* there. Reading `userInfo` alone looks like it works and reports nothing.

**Coverage: every reject that carries a store RESULT is structured; the rest have nothing to
classify.** iOS carries both fields from `purchase()` and `products()`. On Android the rule is
mechanical — **if a `BillingResult` is in scope at the reject, it goes through `rejectWithBilling`**
(`grep -n 'rejectWithBilling(' ` on the plugin lists the definition plus every call site, which is
the check to re-run rather than trusting a number here; a hand-maintained count is exactly what
goes stale, and the first draft of this paragraph said "six" because it counted the definition).
What stays bare prose is app-side refusal with no store result behind it — `productId is required`,
`unknown product`, `no subscription offer available`, `a purchase is already in progress`,
`purchaseToken is required`.

⚠️ **"Is a `BillingResult` in scope" is the test, not "does the message sound like validation" —
and the difference is not cosmetic.** `unknown product` sat in that bare list while its `if` was
`responseCode != OK || list.isEmpty()`, with the `BillingResult` right there in the lambda. So a
`SERVICE_UNAVAILABLE(2)` or `NETWORK_ERROR(12)` — the store simply not answering — was reported as
"unknown product: coins_100", telling the player and the log that a product visible on the shelf
does not exist. On the *purchase* path, where unlike `consume`/`acknowledge` the payload is actually
read. The two disjuncts are now separate branches: a non-OK response rejects as "could not look up
…" with the code attached, and only the OK-but-empty case keeps the "unknown product" prose — its
response code is `OK(0)`, so attaching it as a classification would name a success. Caught by the
close-out review *after* this paragraph had already blessed the site as validation, which is the
lesson: a doc that ratifies a miss stops the next sweep from finding it.

⚠️ **Treat both fields as optional on the JS side.** An older native binary predating #499, the web
stub, and any throw from outside the bridge carry neither; `describeStoreError` omits them rather
than journalling `undefined`, and there is a test for that degraded shape specifically — it is the
case that actually ships first, since JS updates OTA and native does not.

⚠️ **A classified reject that nothing reads is a producer with no consumer** — the defect this repo
repeats most, and #499 walked back into it: the plugins were taught to classify `consume`/
`acknowledge`/`finish` failures while every one of those journal sites still printed `String(e)`, so
a `billing.6` arrived and was discarded one line short of the log. Nothing failed, because those
paths are deliberately non-fatal. **Every store rejection now goes through `journalStoreFailure`**
(`iap.finish-failed`, `iap.acknowledge-failed`, `iap.entitlements-failed`, `iap.reconcile-failed`,
`iap.dispose-failed`), with a test asserting the finish path carries `code`. Route new ones through
it rather than calling `journal` with `String(e)`.

⚠️ **The decision rests on "a subscription unlocks nothing outside the app"** — no server-granted
content, no single player spanning both stores. Those two are exactly what on-device verification
cannot do. **If either is ever wanted, reopen the decision; do not work around it.** The
`PurchaseVerifier` seam ships empty so a server can land later without touching the state machine.

---

## 6. `capacitor-modoki-iap` — why first-party

`@capgo/capacitor-native-purchases`, the obvious off-the-shelf choice, **structurally cannot honour
invariant 1**: its iOS `Transaction.updates` listener calls `await transaction.finish()`
unconditionally *before* emitting a JS event, fire-and-forget, and `restorePurchases()`
blanket-finishes `SKPaymentQueue`. On the launch after a crash it destroys the re-delivered
transaction before any JS has subscribed. Read from source, not inferred.

So the plugin's whole reason to exist is a promise the alternative cannot make:

> **Nothing in it ever finishes a transaction on its own.** `finish()` happens only when JS calls
> `finish()`. No auto-finish, no listener that finishes, no tidy-up on launch.

It is deliberately small — exactly the six operations the port needs — which is most of why a
first-party plugin was tractable. It is an **opt-in dependency**: a game that does not list it in
its `package.json` ships no StoreKit and no Play Billing, whatever the JS does. The engine reaches
it through `registerPlugin` by name with a type-only import, so nothing pulls it into the graph.

---

## 7. Platform notes

### Current state — honest inventory (`games/iap-test`)

**Phases 1–3, 5 and 6 are landed and working on real hardware.** Phase 4 (server verification) was
declined by the owner in favour of local on-device verification; the `PurchaseVerifier` seam ships
empty so it can land later without touching the state machine.

| | Android | iOS |
|---|---|---|
| Purchase → grant → persist → consume | ✅ verified on a Galaxy A23 | ✅ verified on the iPhone Air |
| Products loading | both products resolve — `com.modoki.subscription` was created in Play Console 2026-08-11 | `store: 2/2` **from the real App Store sandbox** (2026-08-12, once each product had localization text) |
| Subscription purchase + entitlement | ✅ **bought through REAL Play billing** on the A23 (owner, 2026-08-11) | ✅ **bought through the REAL App Store sandbox** (owner, 2026-08-12) |
| **Force-quit recovery — the requirement** | ✅ **verified 2026-08-11** | ✅ **verified 2026-08-11** — driven through Xcode's Manage Transactions on the local catalog, which is now DELETED; re-running it needs the sandbox's own tools + the `holdPoint` harness |
| Real store sandbox | ✅ **fully exercised** — internal testing track, both products, a real subscription purchase | ✅ **working** — the local catalog was deleted 2026-08-12 (see below for the two wrong diagnoses it took) |

**Both platforms now run against their REAL store sandboxes** — Play via the internal testing
track (2026-08-11), the App Store once each product had localization text (2026-08-12) — so every
claim below is backed by a real store rather than by a mock or a local catalog. #201 is closed out
with the diagnosis below; what is left there is optional tidying (a stray `com.modoki.iap1`
consumable) rather than a blocker.

### iOS — the real App Store sandbox is the loop

The fixture talks to the **real sandbox**: both products load and purchase there. The local
StoreKit catalog (`Modoki.storekit`) was **removed on 2026-08-12** once the sandbox worked — a local
catalog answers *instead* of Apple, so keeping one around is a way to accidentally test nothing.
`games/iap-test/tests/storekitScheme.test.ts` keeps it gone.

**When `Product.products(for:)` returns an empty array, it is almost certainly incomplete metadata
on the product's own page.** It fails with no error and no reason, which invites elaborate
theories; two were recorded here before the right one, and both were wrong:

- *"the account state is broken"* — the Paid Applications Agreement was Active with banking and W-9
  complete the whole time.
- *"nothing has been submitted"* — reasoned from the subscription group's banner (*"Your first
  subscription group must be submitted with a new app version"*) plus forum threads reporting empty
  arrays on never-released apps. Disproved by observation: the subscription started serving with
  nothing submitted and nothing reviewed. [TN3186][tn3186] is right as written — sandbox
  availability does not require submission, and that banner governs **review**.

What actually fixed it, twice: **adding the localization text.** The subscription group's
Localization was empty, then `com.modoki.coins100`'s was; each product resolved as soon as it had
one. A sandbox tester is irrelevant to this symptom — product *fetch* touches no account, so the
Users and Access role requirement bites only at purchase time. If a sandbox tester ever does block
a *purchase*, a **TestFlight** build sidesteps it: IAPs there run against the sandbox, free, on the
tester's real Apple ID.

The `store: N/2` line the fixture puts on screen is what makes this tractable: **`0/2` is
app-level** (agreement, bundle id, signing team), **`k/2` is one product's own state**. Read the
count before opening App Store Connect.

⚠️ **A device can keep answering from a StoreKit catalog that is no longer in the repo.** An Xcode
**Run** *syncs* a configuration into a persistent per-bundle-id container
(`DVTDevice.handleStoreKitConfigurationSyncForBundleID`), and every later launch path inherits it —
a Modoki build, `devicectl`, or tapping the icon. `xcodebuild` alone never syncs, and deleting the
app is what clears it. So **delete the app from the device before trusting any product count**; a
reading taken on a phone that once ran a local catalog is not evidence about App Store Connect.
This is also why the repo once had a catalog attached while the phone was on the real store.

- **Xcode rewrites `.xcscheme` through its own serializer and deletes comments.** A scheme cannot
  document itself; that is why this knowledge is here.
- **What the removal costs:** Xcode → Debug → StoreKit → Manage Transactions only drives a local
  catalog. It simulated interrupted purchases, Ask-to-Buy, refunds and renewals, and it is how the
  crash matrix was performed by hand on iOS. The matrix is verified, but re-running it now means the
  sandbox's own tools (Settings → Developer, accelerated renewals) plus the fixture's built-in
  interruption harness.

⚠️ **Do not "restore" `Modoki.storekit` casually.** If a local catalog is genuinely wanted again, it
must be recreated AND attached to the Run action AND the two assertions in
`games/iap-test/tests/storekitScheme.test.ts` flipped in the same commit. An unreferenced catalog
file is a trap rather than a fallback: nothing reads it, so it drifts from the scene unnoticed until
someone re-attaches it and unknowingly tests against a stale product list.

[tn3186]: https://developer.apple.com/documentation/technotes/tn3186-troubleshooting-in-app-purchases-availability-in-the-sandbox

### Android — every device iteration costs a Play upload

- **A sideloaded build CAN bill, and neither the signing nor the `versionCode` is what allows it.**
  Four arms on the A23, 2026-09-03, every one returning `queryProductDetails(inapp): code=0 found=6
  remaining=0` — release-signed at versionCode 1; release-signed at 6050; **debug-signed** at 1; and
  debug-signed at the auto-derived 6067 on a FRESH install after a full uninstall. So the earlier
  wording here ("a sideloaded, **release-signed** APK") was narrower than the truth, and the claim in
  `a19f2be8d`'s commit message that a debug-signed APK "genuinely cannot match the Play Console
  listing" is wrong — that symptom is explained by the missing `@PluginMethod` on `products()`, which
  failed every Android call however the APK was signed.
- ⚠️ **A parked `purchase()` has a 5-minute native timeout (#583) — and it HAD to be native.** When
  `purchasesUpdated` fires OK with a list that does not contain the awaited product, the call is
  deliberately left parked (the delivery may be an unrelated Ask-to-Buy approval or a renewal).
  Nothing bounded that, so a delivery that never matched left the slot occupied for the life of the
  process: the product refused every later `purchase()` with "already in progress", and in Court
  `storeInFlight` never cleared either — which made the `court.purchase` reload blocker read blocked
  forever and **silently disabled the whole #574 resume-reload for the process**. `armStoreWatchdog`
  does not help; by design it releases the SCREEN, not the purchase.
  A JS-side timeout in `purchaseService.ts` would NOT have worked, and the fix is worth understanding
  for that reason: the stuck resource is `awaitingPurchase`, a plugin FIELD. Settling the JS promise
  clears `storeInFlight` but leaves the native slot parked, so the next `purchase()` still hits the
  hard reject — one confusing "cancelled" followed by a permanent refusal that merely LOOKS fixed.
  ⚠️ **It is armed from the NO-MATCH BRANCH ONLY — never at park time**, and that distinction is the
  whole safety argument. A park-time draft shipped first and close-out review killed it: arming at
  park bounds EVERY purchase, including one whose Play sheet is legitimately still open, and firing
  resolves `{transaction:null}`, which settles the JS promise, which clears `storeInFlight` — whose
  own doc records that the last omission in that area was a DOUBLE CHARGE. That was not theoretical:
  the park-time build was measured on the A23 firing at 10:55:25 with the sheet still on screen.
  Bounding only the case #583 describes — an OK delivery that arrived without the awaited product,
  re-armed on each further non-matching one — leaves a live sheet alone. Cancelled in `unpark()`, the
  single choke point every settle path routes through (including #586's reload release), with the
  cancel INSIDE the `awaitingPurchase == call` identity check so a stale settle cannot cancel a newer
  call's timer.
  Three further things review forced, all pinned by `iapParkedCallRelease.test.ts` and each verified
  by mutation (break it, watch exactly one test go red, restore):
  **(a)** the check-and-park is `synchronized (lock)` and the two fields are `volatile` — the park runs
  on a Play Billing THREAD POOL (`queryProductDetailsAsync` submits to
  `Executors.newFixedThreadPool(availableProcessors())` and calls back directly, no Handler post), so
  a non-atomic guard lets two `purchase()` calls both see the slot free and the loser parks a
  `setKeepAlive(true)` call nothing can settle — the very defect #583 bounds, on the one path a
  stale-fire guard cannot rescue; **(b)** `handleOnDestroy()` drops anything posted, since an armed
  timer strongly holds the `PluginCall` → `Bridge` → `WebView` → `Activity`; **(c)** the fire path
  unparks BEFORE resolving, matching every other settle site.
  ⚠️ **What the device session verified was the TIMER MECHANISM, not this arm site.** Parked
  10:50:25.955 → fired 10:55:25.956 → JS promise resolved `{transaction:null}` → a second
  `launchBillingFlow` launched → zero `already in progress`. That was the park-time build, because
  the no-match branch needs Play to deliver an OK purchase list without the awaited product, which is
  precisely why #583 was filed as a static-analysis finding and never reproduced. The arm site is
  therefore covered by the source guards and by reasoning, not by a device trace — treat it as such.

- ⚠️ **The precondition that DOES gate it is a Play LICENCE-TESTER account on a published app.**
  Court is on internal testing (#370), and the human confirmed the sheet shows the real price against
  a licensed test account — a free test purchase. That is the documented Google condition, and it is
  why the four arms are indistinguishable: a licence tester is served the catalogue for ANY locally
  installed build of a published package. **A machine whose Google account is not a licence tester
  cannot test IAP locally, however it builds or signs** — budget a Play upload there, not here.
- ⚠️ **Catalogue and sheet-launch are not a completed purchase.** The runs above were cancelled on
  purpose, so nothing measured here covers a purchase completing, being acknowledged, or being
  attributed — where Play's checks are strictest. Do not generalise "IAP works on a local build"
  past `queryProductDetails` + `launchBillingFlow`.
- What blocks the loop is narrower: `adb install` of a **debug** APK over a **release-signed** one
  fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Build release-signed, or uninstall first — and
  uninstalling destroys the on-device ledger, which is usually the state under test. A `versionCode`
  bump is still required for every Play upload.
- A **duplicate `versionCode` is rejected silently** — the bundle simply does not attach, and the
  release then reports three errors that never mention versions. **Fixed by #199**: the number is
  now `app.buildNumber` in `project.config.json`, healed into `versionCode` +
  `CURRENT_PROJECT_VERSION` and never lowered. See
  [Build](./build.md) § "The app version + build number".
- ⚠️ **A native change that is not bumped never reaches the device.** The single-`BillingClient` fix
  sat in the tree while the phone kept running the previous build, and the symptom — "it's not
  fixed" — was simply true. Bump in the SAME change as the native edit.
- Google **auto-refunds and revokes** a purchase that is not acknowledged within three days. So
  `acknowledge()` runs *before* the durable write: it is non-destructive, does not stop
  `unfinished()` re-reporting the purchase, and protects the player even when everything after it
  fails.
- **One `BillingClient`, ever.** Building one per call produced four concurrent clients at boot; the
  plugin holds a single client with queued callers and reconnects rather than replacing.
- **The `purchase()` call is parked, not answered directly** — Play reports the outcome through
  `purchasesUpdatedListener`, not through `launchBillingFlow`'s return, so `purchase()` stashes the
  call in `awaitingPurchase`/`awaitingProductId` and marks it `setKeepAlive(true)`. Every one of the
  four places that can settle it (cancel, a non-OK/null delivery, a matched delivery, a launch
  failure) routes through one `unpark()` helper, which clears both fields and the keep-alive flag
  together, before resolve/reject. **Invariant: a settle path never touches `awaitingPurchase`,
  `awaitingProductId`, or `setKeepAlive` directly — always through `unpark()`.** ⚠️ On Android today
  that keep-alive flag is inert rather than a leak (`Bridge.java` only saves a kept-alive call at
  the moment the plugin method *returns*, and this call is parked several async hops later) — #514
  was filed on the opposite reading; see the docblock on `unpark()` for the full trace through
  Capacitor's bridge.
- Release builds swallow JS console logs unless `loggingBehavior: "production"` is set.

**`games/iap-test`'s upload history**, so a later reader can date a device behaviour to a build:
**1** first upload (no billing library) · **2** billing library added but built before the store UI
existed, so nothing to tap · **3** the first build a purchase could be driven from · **5** the
single-`BillingClient` fix (4 skipped) · **9** `loggingBehavior: production`, which finally made
the JS trace visible in logcat · **10** the `markUIDirty` fix — the ledger had been right all along
and only the screen was stale · **11** the close-out review's two Android fixes, NEITHER
device-verified, both needing a real purchase to exercise (a parked `purchase()` no longer
resolving `cancelled` on an unrelated Play delivery; a second concurrent `purchase()` refused
instead of orphaning the first call, whose promise then hung forever on a double-tapped Buy). It
reads **11** on the fixture, this project's real Play upload count; iOS sat at 5 because each store
counts its own uploads, and the first heal raised it to 11. iOS is the opposite of Android here — a
directly-installed dev build is enough, no upload needed per iteration.

---

## 8. Testing

**Headless — `iapCrashMatrix.test.ts`.** A crash is modelled by its only observable consequence: the
pair of (what the store recorded, what reached persistent storage) at the instant of the kill. Each
case sets up that pair, throws the session away, and boots a fresh one from the persisted bytes —
`resetIap()` + `configureIap()` against the same bytes *is* the relaunch. The property is two-sided
every time: **zero means we stole from them; double means we minted currency.**

**On device — the interruption harness** (`games/iap-test/runtime/interrupt.ts`). Killing an app
*during* a real transaction cannot be done by hand: once the store's sheet is confirmed, the
dangerous span is grant → flush → finish, tens of milliseconds. There is no window to aim at, and
the sheet itself is the wrong place to kill because nothing has been paid yet — quitting there tests
an empty store and **looks exactly like a recovery failure**.

So the harness stops requiring timing: it parks the app in a crash-matrix state and leaves it there.
A scene button cycles `none → after-pay → before-finish → none` live, so the whole matrix is
walkable on the phone with no rebuild.

- **`after-pay`** — the store charges, the app discards the answer. Buy, see an error, balance
  unmoved; relaunch and the coins appear. The owner's requirement, demonstrated literally.
- **`before-finish`** — granted and durable, finish withheld, so the store keeps re-delivering.
  Relaunch must credit **exactly once**. The double-credit trap.

`acknowledge()` is never withheld — risking the player's actual money to test something else is a
bad trade. The harness has its own tests, which is not ceremony: a silently-inert instrument is
worse than none, because a device run would then "pass" having interrupted nothing.

---

## 9. Bugs this subsystem has already had

Kept because each is a class, not an incident.

| Bug | Class |
|---|---|
| **`confirmDurable()` could not fail** — it read the value back through an optimistic cache, so a backend write rejection read as durable and `finish()` ran on a grant that never landed | a check that confirms itself |
| Four concurrent `BillingClient`s at boot | no CONNECTING state in a lazy-init singleton |
| `acknowledge`/`consume` each running twice on one token | check-then-act race across two async entry points |
| A refunded transaction would have been **granted** — the plugin flagged `revoked` and nothing read it | a mechanism firing into a consumer that does not exist |
| `dispose()` was never called and was not even on the interface, so the native listener outlived every game swap | same — a mechanism nothing can reach |
| An unknown product was never acknowledged, exposing the purchase it was preserving to Play's 3-day auto-refund | a guard that destroyed the thing it guarded |
| An unrelated Play delivery resolved a parked `purchase()` as **cancelled** | one shared slot, no ownership check |
| Two concurrent `purchase()` calls orphaned a `PluginCall` — its promise hung forever | same slot, no occupancy check |
| Ledger held 300 coins; screen showed 0 | `entity.set(UIElement, …)` does not dirty the UI projection — **data-correct is not pixels-correct** |
| `withInterruption` skipped the wrapper at `'none'`, so the device toggle could never arm | an optimisation for the state every build starts in |
| A game swap landing during an await could write entitlements into the NEXT game's live `Set` (#434) — `stillActive(c)` was checked before the await but not immediately before the write that followed it | a check that guards the wrong moment |
| `dispose()` existed and was called, but raced the constructor's own `addListener` round-trip, so the native listener still outlived the swap (#487) | a teardown that cannot see the setup it is undoing |
| Every purchase failure on iOS reported `"Request Canceled"` — the catch-all rejected with `localizedDescription` alone, discarding the domain, code and underlying error (#499) | **a diagnostic that erases the difference it exists to report** |
| A *thrown* `StoreKitError.userCancelled` fell into that same generic arm, so a player who backed out was reported as a failure — and reached `purchase_failed` analytics, which the design says a cancel must never do (#499) | one outcome with two code paths, only one of them handled |

Three shapes recur. **A correct mechanism with a missing consumer** (rows 4, 5) — when touching this
subsystem, sweep the *chain*, not the change. And **a check that cannot fail** (rows 1, 10): if a
guard has never been observed rejecting anything, assume it does not work. The first row is the one
to remember — it was found only by tracing the durability claim through four files into the
storage backend, and every test and every device run had been green with it in place.

The third, added by #499: **an error path that reports without classifying.** A failure that always
says the same thing is indistinguishable from a failure that always happens for the same reason, and
the cost is paid later, by whoever has to reproduce it on a phone. The owner hit a reproducible
purchase failure whose journal line — `error: "Error: purchase failed: Request Canceled"` — was
compatible with a user cancel, an `ASDErrorDomain`/`AMSErrorDomain` account or sandbox fault, and a
network drop, all at once. The native plugins now carry `domain`/`code`/`underlying` through
Capacitor's reject payload, `iap.purchase.failed` journals them, and the classification rides into
`PurchaseResult.error`. **The test to apply when writing any error branch: could two causes that
need different fixes produce the same line here?**

⚠️ The fix for it had the same defect one layer up, which is worth more than the fix: the JS reader
looked for the payload at the wrong depth, so a carefully-built diagnostic was assembled natively,
serialized, and dropped on arrival — and the test asserted the reader's own wrong shape, so nothing
went red. See § "A rejection carries a diagnosis" above. **A fake that models behaviour the real
dependency does not have makes the guard defend the bug.**

---

## See also

- `games/iap-test/CLAUDE.md` — the verification fixture, its real store identities, and the device recipes
- [player-prefs.md](./player-prefs.md) — the persistence the ledger rides on, and its durability limits
- [native-and-sdks.md](./native-and-sdks.md) — the standalone Capacitor plugin pattern
- Issue #196 — the original spec and decision log
