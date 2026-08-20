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
Users and Access role requirement bites only at purchase time.

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

[tn3186]: https://developer.apple.com/documentation/technotes/tn3186-troubleshooting-in-app-purchases-availability-in-the-sandbox

### Android — every device iteration costs a Play upload

- **A sideloaded build CAN bill** — measured, against an earlier claim here that it could not. The
  A23 that ran every purchase and the force-quit recovery reports `installer=null` and carries no
  `DEBUGGABLE` flag: a sideloaded, release-signed APK Play never installed. (The account/device had
  been licensed by an earlier Play install, which is the part that matters.)
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
- Release builds swallow JS console logs unless `loggingBehavior: "production"` is set.

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

Two shapes recur. **A correct mechanism with a missing consumer** (rows 4, 5) — when touching this
subsystem, sweep the *chain*, not the change. And **a check that cannot fail** (rows 1, 10): if a
guard has never been observed rejecting anything, assume it does not work. The first row is the one
to remember — it was found only by tracing the durability claim through four files into the
storage backend, and every test and every device run had been green with it in place.

---

## See also

- `games/iap-test/CLAUDE.md` — the verification fixture, its real store identities, and the device recipes
- [player-prefs.md](./player-prefs.md) — the persistence the ledger rides on, and its durability limits
- [native-and-sdks.md](./native-and-sdks.md) — the standalone Capacitor plugin pattern
- Issue #196 — the original spec and decision log
