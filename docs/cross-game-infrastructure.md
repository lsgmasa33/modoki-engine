# Cross-game infrastructure

Several games in this repo want the same things: purchases, attribution, analytics, crash
reporting, a settings screen, a way to push live values onto authored UI. This doc is the design
rationale for **what gets shared, what deliberately does not, and how shared code reaches a game.**

It is the folded form of the plan tracked by #632 (Court → engine → a second game), kept after that
plan landed because the reasoning outlives the checklist.

## Why not a starter template

The obvious answer is a "shell" each new game forks and owns. It does not solve the problem.

If a second game gets a *copy* of the first game's daily-challenge code at scaffold time, a bug fix
still has to be hand-ported to every game that copied it. Duplication just moves from "written
independently" to "copy-pasted" — the fix cost is still N. Behaviour that should be identical
everywhere has to be **imported**, not forked.

⚠️ "Imported" mostly does **not** mean "a package". The bulk of this is plain TypeScript reached
through the `@modoki/engine` specifier; only native Capacitor plugins involve packaging at all.

## The three-layer split

| Layer | Where it lives | What differs per game |
|---|---|---|
| **Behaviour** — fixed once, never forked | `engine/packages/*` | Just config passed in |
| **Glue** — a config/hook seam, forked immediately, *expected* to diverge | a stub in the game's own `runtime/` | Product ids, level lists, unlock rules |
| **Default art** — forked immediately, expected to be replaced | ⚠️ **blocked as specified** — see below | Everything, eventually |

This is the same split CLAUDE.md's "Single source of truth" table already draws *within* a game,
applied *across* games.

## Distribution: how shared code reaches a game

Three kinds of shared code want three different mechanisms.

| Kind | Mechanism | Cost |
|---|---|---|
| Shared TS runtime (scene-chrome patching, IAP core, settings/policy machinery) | `engine/packages/modoki/src/runtime/**`, reached via the `@modoki/engine` specifier | **zero** — no packing, vendoring or versioning |
| Shared native Capacitor plugins | `engine/packages/capacitor-*` + the vendoring pipeline | 1 edit + N re-vendors, gate-enforced |
| Game *content* infrastructure (word banks, level corpora) | genuinely a package question | deferred |

**Most shared code is row 1 and needs no package at all.** The precedent is `@modoki/engine`
itself: a root `workspaces: ["engine/packages/*"]` symlink plus `hostSharedDeps()` in
`engine/vite.config.ts`, which re-resolves bare shared imports from files outside the repo root to
the editor's single instance. No game declares `@modoki/engine` as a dependency.

### The vendoring pipeline, and why it is tarballs

`engine/plugins/vendorPlugins.ts` records the ruling: **never symlink engine→game** — the packaged
editor's engine lives inside a signed, read-only `.app` that a `file:../../engine` directory
dependency cannot reach. A `file:` dep on a *directory* symlinks; on a `.tgz` it extracts a real
copy. So engine plugins are `npm pack`ed into `<game>/plugins/<name>-<version>-<hash>.tgz` and
committed.

⚠️ **Propagation is manual, and that is the real cost.** `engine/scripts/vendor-plugins.mjs` takes
exactly one project directory — there is no bulk refresh, so fixing a widely-used plugin means
repeating `vendor-plugins.mjs <game>` + `npm install` + commit for every game that pins it.

It is **gate-enforced, not silent**: `engine/tests/architecture/vendoredPluginFreshness.test.ts`
runs inside `npm run verify` and checks name freshness, lockfile integrity, and a byte-level
tarball-vs-source diff — that third check exists because *the name is not the bytes*. The live
footgun it defends against: editing a plugin mid-session and re-running a build silently builds
against the STALE vendored copy.

⚠️ **The hash covers plugin SOURCE, comments included.** Rewording a comment in a plugin's Swift
file moves the content hash and makes every pinned tarball stale, even though nothing in the
shipped binary would differ. The guard cannot know which bytes matter, and a guard that tried to
reason about that would not be one. Re-vendor; do not argue with it.

### Two things that bite when a plugin MOVES

Promoting a plugin out of a game and into `engine/packages/` is a `git mv`, which is the right
shape — but two consequences do not follow the rename, and both were paid for the first time
AppsFlyer was promoted.

⚠️ **A concurrent EDIT on another branch makes the vendored tarball stale by construction.** If one
branch moves the plugin while another edits its Java/Swift at the old path, the merged source is
neither branch's version, so a tarball vendored before the merge cannot match it. Nobody made a
mistake; it is what merging a move and an edit means. **The fix belongs at the hub, after the
merge** — `engine/scripts/vendor-plugins.mjs <game>` + `npm install` for every consuming game —
and `vendoredPluginFreshness.test.ts` is what catches it, which is the whole reason that test
compares BYTES and not just the hash in the filename. Corollary for a worker: do not re-vendor
independently to "fix" it, or you produce a second set of tarball bytes and turn a clean re-vendor
into a binary conflict on a `.tgz`.

⚠️ **`git mv` does not clean untracked build output, so the old location survives as an orphan.**
The plugin's own `.gitignore` (`android/build/`, `android/.gradle/`, `.build/`, `.swiftpm/`,
`Package.resolved`) travels WITH the plugin — so in any clone that built the Android side before
the move, the ignore file walks away and leaves its former Gradle output behind, suddenly
unignored. It surfaces after the merge as a pile of untracked paths under a directory that no
longer exists in `HEAD` (39 of them the first time, all `android/build/**`).
**The disposition is `rm -rf`, never a new ignore rule and never `git add`** — the content is
regenerable Gradle output, and committing it, or adding an ignore entry for a path the merge
deletes, means resolving against a deletion for nothing. Clones that never built that plugin's
Android side see no orphan at all, which is why this can look like a per-machine mystery.

### Git URL as a package source — rejected

Three independent blockers, any one of which is fatal:

1. The public mirror keeps `"workspaces": ["engine/packages/*"]` and runs a root `npm ci`. A
   private-git dependency in any engine package makes public CI permanently red and breaks every
   outside consumer.
2. `scripts/publish-demo.sh` strips only specs starting with `"file:"`. A `git+ssh://` spec
   survives into a published public demo repo, and `scripts/scan-publish-safety.mjs` has no
   dependency-spec awareness — nothing catches it until a real person clones the demo and hits a
   permissions error.
3. CI's default token is scoped to this repo alone, so there are no credentials for a second
   private repo.

⚠️ `engine/tests/assets/gamePortability.test.ts` would **not** catch any of it: it never reads
`package.json` dependency objects, and its native-config scanner explicitly skips any reference
carrying a URI scheme.

### Registry — not yet

Nothing in the repo publishes to npm today. [modoki-package-manager.md](./modoki-package-manager.md)
answers a *different* question — how an external project pulls packages from an installed editor —
not in-repo cross-game sharing.

**Revisit trigger for all of the above:** when two consumers need DIFFERENT versions of the same
plugin at the same time. Handing someone a copied-out game does not count; the editor regenerates a
missing tarball on open.

## What is shared today

| Capability | Where | Note |
|---|---|---|
| IAP mechanism | `engine/packages/modoki/src/runtime/iap/**` | Product-agnostic, exposes `configureIap({ onGrant })`. `games/iap-test` proves it with zero game-side state |
| Firebase analytics + crashlytics | official `@capacitor-firebase/*` | Crashlytics needs **no** game-side call sites — the engine reads `appServices().crashlytics` in `globalErrors.ts`, `gameStore.ts` and `ErrorBoundary.tsx` |
| AppsFlyer attribution | `engine/packages/capacitor-appsflyer` | iOS Swift + Android Java + TS; `devKey`/`appleAppId` are call parameters |
| Scene-chrome patching | `engine/packages/modoki/src/runtime/ui/sceneChrome.ts` | See [ui-system.md](./ui-system.md) § "Pushing live values onto scene-authored chrome" |
| Scroll views / recycled entries | `UIScrollView` + `UIEntries` | `games/scroll-demo` is a deliberate non-Court proof |
| Trusted clock | `engine/packages/modoki/src/runtime/core/trustedClock.ts` | Server-time/monotonic anchor, promoted in #660. Pure arithmetic, **zero imports**; the GAME owns fetching and persisting. Passes the determinism guard with no allowlist entry. ⚠️ Defends the *instant*, NOT the timezone — see the daily-challenge bullet below |
| **Cloud-save protocol** (the sync-guaranteed GROUP) | `engine/packages/modoki/src/runtime/sync/**` | ⚠️ **This row's absence is what made #658 wrong.** Landed #532 Phase A (2026-09-01); Court moved onto it the same day. Generic over `T` — `SyncGroupSpec<T>` (`fingerprint`/`isFreshAndEmpty`/`merge`/`adopt`/`onFork`/`atomicity`), `GroupStore<T>`, `GroupTransport`, `runCloudSync`, `decideGroup`, `resolveGroupFork`. Firebase-free, clock-free, imports no other L2 folder; one `court` token in the whole folder and it is a docstring. Tested over an anonymous `Content` type (`tests/runtime/syncGroups.test.ts`, 39 tests). **The GAME owns what its save MEANS; the engine owns the protocol** |
| **Cloud-sync coordinator** (*when* a sync runs) | `engine/.../runtime/sync/coordinator.ts` | Promoted in #658 (2026-09-04). Debounces a burst of progression writes, suppresses further syncs while a fork dialog is unanswered, coalesces overlapping triggers into ONE follow-up rather than a queue, and carries the #506 generation guard for sign-out-mid-sync. Generic over the **fork**, not the save — `CloudSyncCoordinator<TFork extends SyncFork>`, with `resolve`'s document reached as `TFork['serverDoc']`. ⚠️ **It must never read a field off a save document** — that property is the whole basis of the type parameter, and its test's `{ version }` stub document is the tripwire: needing a richer one there means it has stopped being generic |
| **Account decisions** (provider, state machine, re-auth choice) | `engine/.../runtime/account/**` | Promoted in #675 (2026-09-04, `f3a32f79a`) — `AccountProvider`, `AccountState`, `SignInFailure`, `AvailableProviders`, `reauthProviderFor`. ⚠️ **Carries ZERO player-visible copy, and `tests/runtime/accountNoCopy.test.ts` fails if any lands** — there is no i18n mechanism anywhere in this repo, so an engine module that hardcodes English is a localisation blocker a game cannot reach. The GAME owns every rendered word; the engine owns the vocabulary that UI programs against |

## What is deliberately NOT shared

These are roads not taken **on evidence**, not backlog. Each carries the condition that would
reopen it.

- **A main menu — dropped, not deferred.** There is no condition that brings it back, because it
  was never a cross-game candidate: generalizing requires a second implementation to generalize
  *from*, and there is only one. It also grew organically as "a UI root in the same scene, not a
  scene of its own" — hand-driven visibility with fade scalars and input gates, no navigation or
  screen-stack framework to extract.
- **A level selector — deferred.** The genuinely shared part turned out to be ~8 lines: two
  functions that find the first unplayed level, differing in terminal convention and key field.
  Even that understates the divergence — one game passes a per-track filtered ladder (three
  simultaneous frontiers) where the other passes its whole corpus, and the first carries a second,
  deliberately different frontier because "first unsolved" was the wrong answer for progress
  labels (a shipped bug). **Two clear short functions beat one generic one.** Reopens only if a
  second game gets a player-facing selector — a *product* decision, not an extraction, since it
  needs its own answer to "do this game's levels lock?".
  ⚠️ Whoever revisits it: the source side is not liftable as-is.
  `games/court/runtime/levelManifest.ts` value-imports the difficulty tables, dragging the whole solver behind anything
  that touches it, while `levelSelect.ts` needs only the frontier function and one entry type,
  both solver-free. **Split the manifest into a solver-free ladder half first.**
- **A daily challenge — deferred.** Zero second consumers: the other game's progress model has no
  date dimension at all, so a daily there would be a new game mode, not parity. Revisit when a
  second game actually wants one.
  ⚠️ **Do NOT "ship a trusted clock alongside it" — an earlier version of this line said to, and it
  does not work.** `trustedNow()` defends the *instant*; `dateKeyOf` (`games/court/runtime/daily.ts`)
  converts that instant through the **device timezone** (`getFullYear`/`getMonth`/`getDate`, local by
  deliberate design — a UTC key hands a player east of Greenwich tomorrow's puzzle in the evening).
  A player shifting UTC−11 → UTC+14 moves the local civil CLOCK by 25 hours with a perfectly trusted
  `nowMs` — and the device-selectable span is 26 hours, since UTC−12 exists — which is more than
  enough to roll the civil DATE onto the next day. The farm still works and the code now *claims* a
  defence it does not have.
  A trusted daily needs a trusted **civil date** — an owner ruling on timezone policy — not a clock
  swap. ⚠️ And the raw `Date.now()` the daily is fed today is **an accepted written ruling, not a
  defect**: `games/court/daily.md` § "The clock is not trusted, and it is not defended either" states
  it as an explicit *Ruling: accept it* (single-player, no leaderboard, every defence needs infra
  Court does not have). So this work would **overturn a ruling**, not fill a gap — start there.
- **Settings + ad policy — deferred on evidence (#661, closed 2026-09-04).** The mechanism in each
  generalizes; the field set does not; and the second consumer the extraction would be written
  against **does not exist and cannot yet**. Measured, not read: the only other shipping-shaped game
  has no settings module, no settings UI, and **no audio subsystem at all** — `audio|music|sfx|sound`
  greps its `systems.ts` and `traits.ts` at 0 and 0, so there is nothing for a volume slider to
  control — and its scene JSON contains zero occurrences of `settings`. `settings.ts` exists in
  exactly one place repo-wide. Ad gating likewise: no `interstitial`/`rewarded`/cooldown logic under
  any other `games/*/runtime` or `demos/*/runtime`. (The second game's scene does carry an
  `AdBannerSlot` — with **zero code references**, and its `app-services` has no `ads.ts`.)
  ⚠️ **Two corrections to how this pair gets described**, both of which would mislead a future
  extraction:
  1. **`settings.ts` does not persist.** It is 60 lines of pure normalise-on-read — defaults,
     0..1 clamping, and the one legacy `soundOn` migration branch — and is banner-forbidden from
     touching `PlayerPrefs`. "Defaults, migration, and persist" describes two different files;
     persistence lives in `systems.ts`, the only file in that game allowed to touch `PlayerPrefs`.
  2. **Settings are not local.** `court.settings` is a single-key **sync group** with
     `onFork: 'take-newer'`, whose content deliberately survives an account wipe. So the extraction
     is not "lift a 60-line pure module" — it drags a `SyncGroupSpec`, an on-disk envelope, and a
     legacy pre-envelope document shape that readers must still tolerate. Sequence it **after** the
     cloud-save row below, not before.
  **Reopens when a second game grows a settings SCREEN or an ad cooldown** — a product decision, not
  an extraction. Start with settings when it does: the legacy-field migration is the part that is
  genuinely painful to re-derive.
- **A store SCREEN — deferred on assessment (#659, closed 2026-09-04).** `games/court/runtime/storeUi.ts`
  is 581 lines / 228 code, and splits ~18% catalog-agnostic / ~42% generic mechanism wearing a
  Court-shaped type / ~40% copy and catalog. Its two DIRECT imports are siblings — no
  `@modoki/engine`, no `@court/*`, and it never names an IAP type itself — but the generic ~42%
  cannot move until `StoreSlot`/`StoreConfig` become a catalog descriptor, and those live in
  `store.ts`. **The two files are ORDERED, not neighbours.** The genuinely reusable asset is four
  rules totalling ~40 lines: *no price, no row*; *no verdict while the question is still open*;
  *a cancel is not an error*; *hidden, not greyed*.
  **Reopens when a second game acquires a store SCREEN** — verified not met: `storeRows`/
  `StoreRowView`/`shortfallCard` appear in no game outside `games/court/`.
  ⚠️ A second game already ships the IAP MECHANISM with no such screen
  (`games/wordweave/runtime/store.ts`), and the two `store.ts` export surfaces are **disjoint** —
  Court's is catalog/entitlements/passes, wordweave's is coin-credit/idempotency. They share a
  posture, not an API, so this is not duplication awaiting extraction.

## Blocked: the default-art layer

The premise — primitive sprite keywords plus a generic nine-slice, zero asset authoring — does not
hold on the UI layer, which is where every screen this would serve actually lives. Four
independent reasons:

1. **Primitive sprite keywords are `Renderable2D.sprite` ONLY.**
   `engine/packages/modoki/src/runtime/loaders/sceneValidation.ts` scopes the exemption to that
   exact trait + field. `UIElement.imageSrc` resolves against the asset manifest, so `"circle"`
   renders nothing there.
2. **No generic nine-slice asset ships in `engine/`** — it would have to be authored.
3. **Per-scaffold GUID re-minting vs. the code-asset-ref guard.**
   `engine/scripts/scaffold-project.mjs` re-mints every GUID per scaffold, so engine code cannot
   address a template prefab by GUID — and `engine/tests/assets/codeAssetRefs.test.ts` forbids GUID
   literals in code and explicitly scans the starter template. The only precedent is fixed
   engine-side assets in `runtime/assets/builtinAssets.ts`.
4. **No shipped prefab/scene precedent exists anywhere in `engine/`.**

What *does* work with zero authoring: flat colour boxes with `borderRadius` on `UIElement`, and
`UIElement.systemFont` (a CSS family name — `fontFamily` holds a font GUID).

## Gotchas that generalize

- ⚠️ **An import-graph check is not enough to call a file game-agnostic.** The most Court-coupled
  file in the whole audit reads as a thin config layer and has a clean import graph; it is coupled
  through *string literals* — a hardcoded game id in a `console.warn`, English copy in logic, a
  literal union of one game's shelf items. The same shape recurs elsewhere, keying pattern tables
  on `'court.<thing>'` strings. **Every "no game-specific logic" claim needs a string-literal
  sweep, not just a dependency check.**
- ⚠️ **Passing the sweep's most MEMORABLE item is not passing the sweep.**
  `games/court/runtime/storeUi.ts` has no hardcoded game id at all — all 18 `court` tokens are in
  comments — and no namespaced key, no analytics event and no PlayerPrefs read anywhere. It is still
  only ~18% liftable, because it fails the other two items the bullet above already names: Court's
  six shelf items are materialised three times in executable code (a `Record<StoreSlot, …>` seed, an
  exhaustive `switch`, a ternary chain), and ~35 English strings are hardcoded with pluralisation,
  subject-verb agreement and sentence assembly compiled in. **The config supplies only numbers; every
  noun is typed in the file.** So the checklist above is right as written — the trap is stopping at
  the `'court.'` grep, which is the easiest item to run and the weakest signal of the three.
- ⚠️ **A "cleaner-looking" file can be DOWNSTREAM of the hard one, not independent of it.** The ~42% of
  `storeUi.ts` that is genuine generic mechanism cannot move until `StoreSlot`/`StoreConfig` are
  parameterised into a catalog descriptor — and those live in `store.ts`, the most coupled file in the
  audit. The two were surveyed as neighbours; they are actually **ordered**. Any attempt that starts
  with the UI file because it reads cleaner stalls on the config file anyway.
- **The reusable asset can be a set of RULES, not code.** The most valuable thing found in
  `storeUi.ts` was four design rules totalling ~40 lines — *no price, no row*; *no verdict while the
  question is still open*; *a cancel is not an error*; *hidden, not greyed*. Worth stating explicitly
  because a line-count-driven survey ranks that file low and misses them.
- ⚠️ **Extraction that touches persisted keys lands on a SHIPPING game.** A progress-key reshape
  with no migration is the precedent that this class breaks live players. Treat it as a design
  constraint, not a merge problem.
- **Make each move a pure `git mv` with zero content edits in the same commit.** Several clones
  work this repo concurrently; a structural move with edits mixed in conflicts *semantically*,
  where a pure rename conflicts mechanically and resolves in seconds.
- **The claim mechanism coordinates by TASK, not by FILE.** A different, legitimately-claimed issue
  can still collide with a structural move at merge time, and the `wip/*` labels give no warning
  either way. Before starting a move, query open issues touching that specific file.
- ⚠️ **A move into `engine/**` relocates content from never-published to published-by-default.**
  `engine/` and `docs/` ship to the public mirror; `games/` does not. A plugin's own code is
  usually key-free and safe; a game's app-services config that holds live credentials is not, and
  must not follow it. `npm run verify:publish` is the only thing that catches this, and it runs on
  the hub.

## Open work

The tiered extractions are done. What remains was surveyed but never tiered, and each has an issue
carrying its own validation status — the coupling verdicts below came from *reading*, and the audit
that produced them reversed itself on three of the four rows it originally covered, once someone
actually read the code:

**All four are now settled** (2026-09-04). **#660** (the trusted clock) was PROMOTED — see the table
in § "What is shared today". **#659** (the store screen) and **#661** (settings + ad policy) were
assessed and DEFERRED — see § "What is deliberately NOT shared", which carries each one's reopening
condition.

**#658** — cloud save / account sync — was **re-scoped, because its stated blocker did not exist.**

⚠️ **The correction worth carrying forward: #658 was filed on 2026-09-03 saying "there is nothing to
extract until a generic save-document seam exists". One had existed since 2026-09-01** — `runtime/sync/**`,
#532 Phase A — **and the game it called welded had been running on it for two days.** The issue cited
this very doc for context, and this doc's § "What is shared today" table did not list the sync
subsystem. A survey reads the table, not the whole engine. **When something lands in `engine/**`, the
row here is part of landing it** — an omission does not read as "unlisted", it reads as "absent", and
it cost a filed issue with an inverted premise.

What is genuinely left is **not** a seam design. The protocol, the versioning, the conflict decision
table, the fork resolution and the transport interface are all engine-side and document-agnostic
already; the coordinator joined them (see the table above). What is still game-shaped is *what a save
MEANS*, plus three narrower items, each now its own issue:

**All three are now settled** (2026-09-04), and the settlement turned on one owner ruling: **the
account and conflict-dialog UI is GAME-SPECIFIC.** Court's dialog keeps its self-describing sentences
("3 puzzles the other one doesn't have"); the engine owns no layout for it, and no copy.

- **#674 — LANDED** (`e8bc4f74c`). `startCloudSync` now takes two injections — a `services` pair
  covering the four auth/cloud-save calls, and an `onBackground` hook — both defaulting to Court's
  own values, so nothing changed behaviourally. The widen/narrow pair became ONE `ASKABLE_GROUPS`
  table: their own comments said the two "state the SAME invariant", and holding one invariant in two
  places is what lets it drift. ⚠️ The `SyncTransport`/`GroupTransport` bridge was left alone — real
  translation, misread as a free deletion once. ⚠️ The injections are a real testability seam and
  narrow what #679 has to do, but they do not by themselves make this file consumable by a second
  game: `cloudSyncWiring.ts` still lives under `games/court/`, `CloudSyncServices.auth.currentUser`
  is still typed on Court's own `CourtUser`, and `sync`/`resolve` still hard-import
  `syncNow`/`resolveSyncConflict` from `./systems` — `gamePortability.test.ts` still forbids another
  game importing it, so Wordweave would still have to port the file.
- **#675 — LANDED, NARROWED** (`f3a32f79a`). The engine took the account DECISIONS and none of the copy.
  The issue proposed moving the account-generic two thirds of `accountUi.ts` and named the hazard in
  the same breath: ~51 of those lines are player-visible English, and there is no i18n mechanism in
  this repo. The UI ruling resolves that by subtraction rather than by care — move the vocabulary,
  move zero strings. `accountNoCopy.test.ts` is what holds the line, and it was mutation-tested twice.
- **#673 — CLOSED, won't do.** Its proposal was *"the engine owns the two-column layout and the
  choice; the game owns every noun"*, and the ruling above deletes the first half. What remains — a
  view-model of one game's nouns, rendered by that game — is already correctly placed.

⚠️ **#673 also named something that was NOT UI, and it was already promoted.** It singled out
`conflictKeepsEntitlements` as *"a genuinely generic rule — the choice adjudicates progress, never
purchases"*. That rule is `ConflictChoice`'s own contract in `runtime/sync/types.ts`: *"Fields exempt
from the choice are handled by the group's own `merge`."* Court's `mergeEntitlements`/`mergePasses`
ARE that mechanism. The function only decides whether to show a reassurance LINE — presentation. So
no generic rule was stranded in game code; **only its rendering was, and rendering is meant to be.**

**A second consumer now exists as an intention, not yet as code.** Wordweave will adopt this stack
(owner, 2026-09-04) and its adoption is **#679** — deliberately a separate issue, so the seams above
stay engine/Court-scoped. Two measured facts from that survey bear on any future row here: Wordweave
has **zero** sign-in, accounts or `runtime/sync/**` usage today, and its headline progression is a
**SET** (324 level guids, set-union merge), not Court's scalar counters — so a view-model shaped on
Court's numbers would not have fitted it, which is a second, independent reason #673's struct was the
wrong shape.

**The COORDINATOR has now moved** (2026-09-04) — see the row in § "What is shared today". It is the
one part that needed no design at all: it never reads a field off the save document, so the type
parameter is the FORK (`SyncFork = { groupId, serverDoc: unknown }`), not the save, and `resolve`'s
document arrives as `TFork['serverDoc']`.

⚠️ **This one was moved against the "wait for a second consumer" rule, deliberately and on the
owner's call** (2026-09-04), so do not read it as the rule weakening. Two things made it different
from every deferred row above: the engine already owned the protocol and shipped **no driver** above
it, so the gap was in an extracted subsystem rather than a speculative one; and the extraction
required **no guess about a second game's needs**, because the module had zero `court` tokens before
it moved. The reason it had been held back — "a shipping game's save path" — **was simply wrong**:
Court is not publicly shipped, which #532 ruling 5 had already recorded when it priced a fleet-wide
re-fingerprint at zero.

## Related

- [native-and-sdks.md](./native-and-sdks.md) — the native SDK plugin pattern, and the wiring traps a
  plugin promotion has to clear
- [iap.md](./iap.md) — the IAP mechanism used as the template for a core/config split
- [cloud-sync.md](./cloud-sync.md) — the group protocol itself: what a sync-guaranteed group is, the
  decision table, and the fork rules
- [ui-system.md](./ui-system.md) — scene-chrome patching, the one UI extraction that landed
- [architecture-layers.md](./architecture-layers.md) — the L0–L3 contract any engine destination
  has to satisfy
- `engine/plugins/vendorPlugins.ts` — the vendoring ruling this reuses
