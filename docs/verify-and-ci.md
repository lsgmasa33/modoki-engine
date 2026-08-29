# Verify & CI

The measured history behind the local `npm run verify` gate and the manual/free-tier CI setup —
the numbers, the two speedup changes that were kept, the two that were tried and declined, and
the e2e suite's own history. `CLAUDE.md` keeps only the load-bearing rules (run `verify` before
every push, when to run `test:e2e` locally, CI is manual); this doc is where the evidence lives.

## `npm run verify` — the local gate

**How long it takes depends on the MACHINE, so budget by clone, not by one number.** Measured
warm on the main Mac: **~84s, ranging 82-86s across four runs** (2026-08-18, down from ~245s —
see "What made it faster" below; it was ~110s until Court's corpus tests were memoised). Quote
the RANGE, not a best case: the spread is real, it comes from two vitest pools sharing one box,
and a single lucky 85s reading is what this entry said first.

⚠️ **All of that wall-clock is the APP-TESTS lane, and that is now measured rather than
assumed** (2026-08-18): wall exceeded the app-tests lane by only 7-8 ms in all four runs —
`verify.mjs`'s own overhead, nothing else. The other lane (typecheck→lint→engine tests) reads
52-56s but carries ~30s of SLACK and is far less work than that suggests, so **nothing removed
from it changes this number**. Two tempting cuts there were measured and **DECLINED** rather than
left as plausible ideas:
- parallelising the independent typecheck commands
- running typecheck ‖ engine tests

Both work, both buy 0s of gate. **The app lane is the only lever.** Per-leg numbers, the A/B, and
the reasoning live in ONE place, `engine/scripts/verify.mjs`'s header — don't copy them here,
that is how the ~110s figure above went stale.

Warm is the honest figure to quote: `typecheck`/`lint` cache into the gitignored
`node_modules/.tmp` (65f5f840), so a COLD clone pays ~55s more on those two.

### The Windows clone

The Windows clone was **~10 min** at the old shape (2026-08-04): 608s, of which the app-tests
leg alone was 520s (86%). ⚠️ **`win` has NOT been re-measured since the speedups**, and two of
the three do not obviously carry: the worker cap (below) is Apple-Silicon-specific and falls
through to vitest's default there, and that box is ~2.5-4.5x slower on everything. Quote the Mac
number for a Mac only. Two consequences worth carrying: a Windows session should EXPECT to wait,
rather than reading a long run as a hang; and a budget tuned on a Mac is not automatically a
budget — that is exactly how five Court hint sweeps came to time out and leave `win` with no
working gate at all (#108, `games/court/tests/budgets.ts`, whose tiers are still sized on the
Windows measurement).

## What made it faster (2026-08-06)

**The two test changes are a PAIR — neither works alone.**

- **The vitest worker cap is the big one — 179s → 84s on its own.** Vitest defaults to
  `availableParallelism() - 1`, which counts Apple Silicon's EFFICIENCY cores as if they were
  performance cores. A CPU-bound test file scheduled onto an E core runs ~4x slower, and vitest's
  wall-clock is set by its SLOWEST FILE, so one unlucky placement becomes the whole run. This box
  is 12P+4E and 12 workers measured 84s against 15 workers' 179s; 8 measured 101s, so it is a
  real optimum, not "fewer is better". Derived per-machine in `engine/vite.config.ts`
  (`perfCoreWorkers`, overridable with `MODOKI_TEST_MAX_WORKERS`); non-Apple-Silicon keeps
  vitest's default.
- **Court's hint sweeps are sharded across files** (`games/court/tests/shard.ts`) — vitest
  parallelizes by FILE and cannot split one, so `hint.test.ts` at 141.7s was a hard FLOOR that no
  worker count could get under. ⚠️ Sharding alone bought almost NOTHING (198s → 179s): it
  converted one long pole into 19 medium ones that promptly oversubscribed onto E cores. The two
  changes are a pair — sharding removes the floor, the cap lets the machine exploit it. Do not
  read either as an independent win, and do not "simplify" one away.
- **`npm run verify` runs its legs CONCURRENTLY** (`engine/scripts/verify.mjs`) — TWO lanes: app
  tests ‖ typecheck→lint→engine tests, output buffered per lane so nothing interleaves. The old
  `&&` chain is kept as `verify:serial`. ⚠️ It was THREE lanes first, and that was worse: two
  unrestricted vitest pools fought (85/115/147s on an identical tree) and resurrected a timing
  flake. Budgeting workers across three lanes was worse still — starving either suite just moves
  the wall-clock onto the other. Chaining the short work behind `typecheck` (largely
  single-threaded) is what made it reproducible. This is the smallest of the three wins:
  sequential would now be ~154s against ~84s concurrent. ⚠️ The three-lane instability no longer
  reproduces (re-measured 2026-08-18 — the pinned worker cap is why), so chaining is now kept
  because splitting is wall-clock-NEUTRAL and therefore pointless, not because it is harmful.

## Typecheck traps that have bitten CI

- **Always run root `npm run typecheck`, not just the package one.** The package's
  `tsconfig.check.json` does not set `noUnusedLocals`, but the root `tsc -b engine`
  (`engine/tsconfig.app.json`) does — so an unused local/var passes
  `npm --prefix engine/packages/modoki run typecheck` yet fails CI's root typecheck.
- `npm run lint` is a CI gate too (the no-`fetch('/api/...')` parity rule) — run it as well.
- **Test files are typechecked by their OWN configs** — `engine/tsconfig.test.json` and
  `engine/packages/modoki/tsconfig.test.json`, both run by `npm run typecheck`. They are separate
  from the app/package configs on purpose: tests need Node types + vitest globals, and folding
  those into the app program would make `node:*` resolve for browser-side code and mask real
  errors. Until issue #23 no engine test file was typechecked at all (695 of them) — vitest
  transpiles without checking, so a mock could drift from the module it stands in for and the
  suite stayed green. `engine/tests/architecture/testTypecheckCoverage.test.ts` now asserts every
  test file on disk is actually IN one of those programs; **a config can be wrong in a way that
  looks clean** (an `exclude` inherited via `extends` beats a local `include`, compiling zero
  files and reporting a cheerful pass), which is why the guard checks coverage, not just errors.

## Coverage

**`npm run coverage` runs BOTH suites and merges them — never quote one leg alone.** The repo's
tests live in two vitest projects (the engine package's 466 files, the root's 276) and both
exercise `packages/modoki/src`, so a single leg understates it badly: root-alone reads 26% where
the merged number is 59%. It excludes project-owned tests (`games/*/tests`) because V8's
precise-coverage mode deoptimizes hot functions ~3.6x, which blows Court's solver budgets.
Coverage is *execution, not assertion* — a covered line is one some test ran, not one any test
would catch a bug in. Current numbers + what they changed: [editor.md](./editor.md) § Panels.

## GitHub CI — manual and billed

**GitHub CI is MANUAL — it does NOT run on push.** As of 2026-08-01 `.github/workflows/ci.yml`
is `workflow_dispatch` only: **the owner decides when to spend the minutes, and will say so.**
Never trigger it yourself (`gh workflow run ci.yml`) unless asked — it is billed, and a run is
~47 minutes of the monthly allowance (Windows ~18min at the 2x private-repo multiplier + Linux
~11min). Why: at four clones merging into `main`, per-push runs exhausted the budget on
2026-07-31, and once exhausted every run failed in 3-12s with a budget error that MASKED a real
test failure for a day. A gate that is silently off is worse than one that is deliberately off.

**So the local gate is now the ONLY gate: run `npm run verify` before every push** (typecheck +
lint + app tests + engine tests). Nothing remote will catch what you skip. When the owner asks
for a CI run, use `gh workflow run ci.yml --ref main` then `gh run watch <id>`, and **read BOTH
legs** (or the `gh-ci` skill).

CI (`.github/workflows/ci.yml`) runs on a **matrix of `ubuntu-latest` + `windows-latest`**
(`fail-fast: false`; lint is Linux-only, being OS-invariant), so CI is strictly broader than any
local run — a local pass does NOT imply the other platform passes. The Windows leg exists
because this repo has a recurring class of Windows-only path bugs (drive letters, separators,
`/@fs/` URLs, POSIX-only assumptions like a `:`-joined PATH or `chmod 0600`); it earned its place
by failing on its first run and catching a latent `.toml` CRLF bug nothing else could see. **When
a run is requested, read BOTH legs before calling it green** — but note that run is MANUAL now,
so on an ordinary push there is no remote leg at all: local `verify` + `test:e2e` is the whole
gate, and the Windows class of bug is simply unguarded until the next manual run.

### `test:native` — the on-demand native gate

`npm run verify` is vitest. It cannot run XCTest and it cannot run gradle, so anything written in
Swift or Java is structurally outside it. **`npm run test:native`** (`engine/scripts/test-native.mjs`)
is where those suites run, on demand. Four legs today, all golden-vector parity replays:

| leg | what runs it |
|---|---|
| `ios/lease-parity` | `swift test` on the standalone `capacitor-game-debug/ios/Tests` package — no deps, no simulator, seconds |
| `android/lease-parity` | gradle on `capacitor-game-debug/android/test-harness` — plain JVM, no AGP, no Android SDK |
| `ios/ota-core` | `swift test` on `capacitor-modoki-ota/core` (already a standalone package) |
| `android/ota-core` | `javac` + `java` on `OtaCoreSelfTest` — a `main()` that exits non-zero, no gradle at all |

The lease legs were wired in #376 after both sat unrunnable — and therefore permanently
green-looking — since they were written; the OTA legs existed only as two hand-typed recipes in
[ota-updates.md](./ota-updates.md), so they ran when somebody remembered.

Gradle comes from `MODOKI_GRADLE`, else any project's committed `gradlew`, else a system `gradle`
— the wrapper before PATH deliberately, since every wrapper here pins 8.14.3 while a Homebrew/scoop
`gradle` is 9.x. (Those wrappers pin the `-all` distribution, so the very first run on a machine
with no cached wrapper distribution downloads ~200 MB; set `MODOKI_GRADLE` to skip that.) `JAVA_HOME` comes from `print-toolchain-env.mjs`, never from
`/usr/libexec/java_home -v 21` (which on this Mac hands back a JDK 25 path with exit 0).

A leg that cannot run on this machine reports **SKIP** with the reason, as loudly as a failure, and
`--require-all` makes a skip fatal. That is the point: the defect these tests were part of is a test
that never runs looking exactly like a test that passes.

⚠️ **It is not part of `npm run verify` and must not be** — but nor is it optional after touching
`engine/packages/capacitor-*/**`. And read the legs separately: the OTA ones replay the SHIPPING
`OtaCore`, while the lease ones replay a port that lives inside the test file — a green lease leg
does not vouch for `GameDebugPlugin` ([native-and-sdks.md](./native-and-sdks.md) § Lease parity
harness).

### `verify:publish` — the hub-only privacy gate

**On the HUB, add `npm run verify:publish` before pushing `main`** — ~5s, and it is the only
thing that can catch a private value (Apple Team ID, a real device UDID, an internal `gs://`
bucket) before it reaches a PUBLIC repo. It assembles the same snapshot the OSS CI job does, with
the same demos, and runs every publish guard without pushing anything — plus the shipped
`architecture/`+`assets/` guards INSIDE the snapshot, which catches a test that assumes private
content the snapshot does not ship (that class went red on `ci/main` twice). `npm test` mostly
cannot see this class: the guards run over the assembled SNAPSHOT, and a real id is perfectly
valid TypeScript. **One slice of it IS in `npm test` now** —
`engine/tests/architecture/privateBuildFields.test.ts` fails on every clone if a committed
`project.config.json` carries a `PRIVATE_BUILD_FIELDS` value, or if a `project.user.json` is
tracked at all. That is the merge-re-leak shape specifically, caught before the push instead of
on `main`; a real id pasted into a fixture or prose still needs `verify:publish`.

Twice now a leak has ridden a worker branch into `main` and killed the snapshot there — a real
Team ID in a test fixture, then three real iPhone UDIDs plus a third party's device name in the
#143 xctrace fixture. It scans WORKING-TREE content of tracked files, so it answers about what
you are about to push, not about HEAD. Deliberately hub-only: it is bash + rsync (no Windows),
and the worker clones don't publish. Detail: [engine-oss-publishing.md](./engine-oss-publishing.md).

## The public repo as a free CI runner (#96)

**EXCEPT on `main`: the free public runner now covers it.** Actions is unbilled on standard
runners for PUBLIC repos — `windows-latest` AND `macos-*` included — and
`lsgmasa33/modoki-engine` is public. So a push to `main` triggers
`.github/workflows/oss-ci-snapshot.yml` (ubuntu, **~20s wall-clock → 1 billed min** — it only
assembles; measured over 20 runs 2026-08-10, range 16–26s, and GitHub rounds each job up to the
minute), which force-pushes a **scrubbed snapshot** to the `ci/main` branch; that fires the
public `ci.yml`. What runs there, all free, on every `main` push: **typecheck/lint/tests on
ubuntu + windows**, the **Playwright e2e suite**, and a **DMG + Windows installer build**. The
legs that cost the most privately (Windows 2×, macOS 10×) are the ones this buys back. Nothing
waits for the result (polling would bill the wait); read it with
`gh run list --repo lsgmasa33/modoki-engine --branch ci/main`.

The packaged artifacts there are **NOT shippable** — unsigned, and the beforePack stagers
silently skip when `toktx`/`msdf-atlas-gen` are absent, which those jobs do not install. Debug
packaging with them; never distribute them.

Caveats that matter: it is a **subset** gate (no `games/`, so anything game-dependent still runs
only locally), it tests the **transformed snapshot** rather than this tree, it needs the repo
secret `OSS_PUSH_TOKEN`, and **public run logs are world-readable and permanent**. Never push the
private tree to a public branch to get a free run — deleting a branch unpublishes nothing. Full
mechanism: [engine-oss-publishing.md](./engine-oss-publishing.md) § "The public repo as a free CI
runner".

## e2e (Playwright)

**`npm run test:e2e` is NOT the local gate on ANY clone — the free public runner is**
(2026-08-06, superseding the 2026-08-01 hub-only rule). It costs ~2.5–5 min per run, and since
#96 the public `ci.yml` runs the whole Playwright suite free on ubuntu on every push to `main`.
Paying for it locally on every push buys ordering, not coverage. So:
- **Default on every clone, hub included: don't run it.** Push, then read the remote result:
  `gh run list --repo lsgmasa33/modoki-engine --branch ci/main`.
- **Run it locally when the change touches what it actually covers** — **editor input, DOM
  structure, or scene boot**. That is the case where you want the answer before the push, not
  after. A game-only, docs-only, or engine-internals commit does not need it.
- **Always run it before a release** — `verify:all` is still the mandatory gate in the
  `release-version` skill, and a release is exactly where "fix it forward" is not available.

Deliberately accepted: a broken spec can now reach `main` and surface on `ci/main` minutes later,
to be fixed forward. That is the trade — the suite is no longer a pre-push cost on four clones,
and nothing rots unseen because the remote leg watches every `main` push.

⚠️ **What the local gate CANNOT see is Windows.** CI's Windows leg exists because this repo has
a recurring class of Windows-only path bugs (drive letters, separators, `/@fs/` URLs, POSIX-only
assumptions like a `:`-joined PATH or `chmod 0600`) — five such fixes in six months, every one
invisible to a Mac clone. So flag it to the owner when a change touches path handling, the
toolchain, or native config: that is when a manual run earns its cost. **The traps themselves —
and the probes that get them wrong — are in [windows.md](./windows.md)**; read it before
concluding a tool is missing on Windows (it resolves through `MODOKI_TOOLCHAIN_DIR`, not PATH)
or quoting a Mac timing as if it were Windows'.

**e2e DOES have a remote counterpart now (#96) — but it runs AFTER the push, not before.** The
public `ci.yml` has an `e2e` job on the free ubuntu runner, firing on every `main` push. That
reverses the old rule's premise ("nothing remote is ever watching it"), which held until #96 and
is why two specs once rotted silently for months (`editor-2d-ui` waited on a DOM canvas the
PixiJS cutover deleted; `editor-assets` clicked a button title a refactor removed). Nothing rots
unseen any more.

**What the remote leg costs is ORDERING, and that is now an accepted cost.** It reports on a
branch nothing waits for, so it catches a break only once `main` already has it. The hub used to
run e2e pre-push to keep a red spec off `main` in the first place; as of 2026-08-06 it does not,
because ~5 min on every push is a steep price for moving a fix from after the push to before it.
Fix forward when `ci/main` goes red — and run it locally first whenever the diff touches editor
input/DOM/scene boot, where that ordering actually matters.

### Where local and remote disagree, believe the remote one

A loaded shared runner surfaces timing races a quiet Mac cannot, and this is not theoretical:
`editor-hierarchy-folder-drag` passed 47/47 here and died on `ci/main` minutes later — twice, the
second time straight through the `expect(...).toBeVisible()` guard added for the first. A local
green is weaker evidence than a public red. When they conflict, fix the race (retry the READ —
see `stableBoundingBox` in `engine/tests/e2e/helpers.ts`), never re-guard around it, and never
add a retry: `retries` is `0` on purpose, and the suite is deterministic (`workers: 1` — see
below).

The e2e suite remains the ONLY end-to-end coverage of editor interaction — every keyboard spec
that pins the focus-scope behaviour lives there. When you change editor input/DOM structure, run
it.

### e2e runs SERIAL (`workers: 1`) on purpose — don't "optimize" it back to 4

All workers drive the ONE dev server `webServer` starts, so at `workers: 4` they contended on a
single editor (one scene, one selection, one undo stack) and the suite failed
nondeterministically: measured on one commit back to back, 2 failed / 44 passed then 46/46 green,
no code change. Serial costs ~6% (4m51s vs 4.5–4.9m) because the parallelism was buying almost
nothing *precisely* while they fought. `retries` stays `0` — a retry would paper over the
signal. Real fix (per-worker dev servers) is deferred as low priority — the cost/benefit is in
[editor.md](./editor.md). **If a spec fails now, treat it as real.**

### e2e leaves the working tree byte-for-byte unchanged

It is safe to run with a dirty tree: **e2e leaves the working tree byte-for-byte unchanged**
(measured — identical `git diff` hash before/after a full run). The specs POST to
`/api/write-file` but INTERCEPT those routes, which is why they assert on the request rather than
on a file. ⚠️ That measurement is a `git diff`, so it says nothing about IGNORED files, and there
is one that matters: the editor autosaves its dock layout to
`.modoki/layouts/autosave.layout.json`, which every later boot reads back — including the
human's next editor launch. A spec that opened the Particle Editor panel once left a
`particle-editor` tab selected over the Scene tab, and the ENTIRE suite then timed out at boot
with no source change, on HEAD, reading exactly like a regression (2026-08-19). The goto helpers
now swallow `POST /api/layout` so a spec cannot persist one; detail in
`engine/tests/e2e/helpers.ts`. The config's "these specs mutate scenes" warning is about pointing
them at a LIVE editor, which the dedicated port already prevents. That port is **derived per
clone** from the repo path (#20), so two clones can run e2e at once without contending; the
config prints it at startup (`[e2e] dev server port …`) — take the number from there rather than
assuming 38173, and use `MODOKI_E2E_PORT` to pin one deliberately.

## Packaging gate

**Before pushing a PACKAGING change** (`engine/electron/**`, `electron-builder.yml`,
`engine/plugins/**`, `engine/scripts/build-web.mjs`, `engine/toolchain/**`): run
**`npm run verify:packaged`** (`verify` + `smoke:packaged`) — a manual gate that builds the
faithful `--dir` app and asserts render + prod CSP. It runs on **Windows as well as macOS** (it
was long described as macOS-only, which was wrong and helped hide a packaged-Windows bug). Detail
in [build.md](./build.md) ("Packaged editor loop").

## Editor `.ts` vs `.tsx` test coverage

**Editor `.ts` logic is expected to carry tests; editor `.tsx` is not.** A panel component holds
JSX, hooks and imperative wiring — its DECISIONS belong in a plain `.ts` module beside it, and
that module is where the unit test goes, with one e2e spec for the real browser gesture. Never
mount a panel in jsdom to test it: that asserts the mock. Measured 2026-08-04 — editor `.ts` is
**80%** line-covered against `.tsx` at **12%**, which is the split working as intended, not a gap
to close by testing components. Some panel logic is already pure and at module scope but simply
unexported, so nothing can import it and nothing tests it — exporting it is the cheapest coverage
in the editor, and carries no behaviour risk. Detail, and the two traps (duplicated private
helpers; orchestration that resists extraction): [editor.md](./editor.md) § Panels.

## Test structure

Tests live under `engine/tests/` and `engine/packages/modoki/tests/`, split by subsystem; `ls`
them rather than trusting a listing here. Run a subset by path:
`npx vitest run --config engine/vite.config.ts <path>` (the `--config` is required — without it a
game's tests fail with `__MODOKI_MODULE_RENDER2D__ is not defined`).

### Source-scanning guards, and the ONE comment scanner they share

A large family of guards works by reading source off disk and asserting that a forbidden pattern
does not appear — `determinismGuard` (no raw `performance.now()` in `runtime/**`), `reapScoping`
(no unscoped `pkill`), `posixPathGuard`, `assetJsonGuard`, `inputSourceGuard`, `ktx2CapsGuard`,
Court's `sharedPredicates` and `palette`, and others. Every one of them must strip comments first,
because these files' own prose explains the very hazard being guarded and an unstripped scan
matches its own documentation.

⚠️ **Never write a comment stripper. Import `@modoki/engine/testing`.** Enforced by
`engine/tests/architecture/commentStripperIsShared.test.ts`, which fails on a hand-rolled stripper
in any test file — a rule this repo states but does not enforce is how twelve copies accumulated,
and how the first sweep for #419 still missed sixteen more.
(`engine/packages/modoki/tests/helpers/sourceScanner.ts`.) Inside that package use the relative
path; from `engine/tests/**` and from a game's tests use the package subpath — a game may not
reach outside its own folder by relative path (`assets/gamePortability.test.ts`).

```ts
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
const stripped = stripComments(raw);          // or { strings: 'blank' } / { regexLiterals: false }
assertScanIsSane(raw, stripped, 'file.ts');   // BEFORE any count is trusted
```

**Why this is a correctness rule and not a tidiness one (#419).** Twenty-eight guards each carried
a private stripper, and every one was built the same broken way: strip block comments with a lazy
regex, then line comments. A `/*` sequence inside a **line** comment opens a phantom block that
runs to the next real terminator, and everything between is **deleted**. Measured: a line comment
in `runtime/rendering/Scene3D.tsx` writes the glob `runtime/**`, which hid 82 lines — 22 of them
`import` statements — from `determinismGuard`. Mutation-proved both directions: a
`performance.now()` planted inside that window left the guard green; the same line outside it
failed.

⚠️ **Every failure mode of a comment stripper LOWERS what the scan can see, and these are
forbidden-pattern guards — so a lower count is a PASS.** They fail silent and green, which is the
only direction that matters. Hence the two rules: one scanner (the multiplicity is what let one
copy be fixed twice, in #411 and #418, while eleven copies of the original bug carried on), and
`assertScanIsSane` at every call site, because a guard whose own instrument can delete the code it
inspects is not a guard.

⚠️ **`strings: 'blank'` is a different function, and it is PARSER-driven for a reason.**
`stripCommentsAndStrings` blanks string and template literal content as well, for a guard hunting a
value that can hide in prose either way (Court's bare-hex sweep). It uses TypeScript's own tokens
rather than the character scanner because a scanner cannot tell a quote or backtick in **JSX text**
from a string delimiter: one stray backtick in JSX prose blanked six following lines of real code,
including a `0xff0000` constant, and the hex guard reported nothing. It therefore requires source
TypeScript can parse and throws otherwise — reach for `stripComments` on anything else (shader
text, a sliced function body, `.mjs`).

The scanner is a five-state machine (code / line / block / string / regex literal) that is
**length- and line-preserving**, so a reported line number still addresses the real file and a
parser's token offsets over the raw source address the stripped string directly. That last property
is what `findDamagedCodeTokens` / `assertEveryCodeTokenSurvives` rest on: TypeScript parses the raw
file and every non-comment leaf token must be byte-identical in the stripped output. Its own test
sweeps all of `src/runtime/**` with that oracle (~340 ms) as a **forward** guard — it needs nobody
to have thought of the next hazard first. The crafted snippets in that test are the only
*regression* cover, with a measured matrix of which snippet catches which scanner defect; real
fixture files strip byte-identically under most of them and can tell nothing apart.
