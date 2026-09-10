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

### The gate re-installs the git hooks first (#909)

`verify.mjs` runs `engine/scripts/install-git-hooks.mjs` before it launches the lanes. It costs
milliseconds and normally prints nothing.

**The reason is that `engine/scripts/git-hooks/*` is a SOURCE, and git runs a COPY of it.** The
installer puts each hook in the git common dir's `hooks/` (not `core.hooksPath` — that would take
the existing Git LFS hooks out with it), so **editing a hook source changes nothing until the
installer re-runs**, and nothing said so. `prepare` covers a hook change that rides along with a
dependency change; it does not cover a hook edited on its own, which is exactly when this bites.
Measured 2026-09-08: two clones were both committing through a `prepare-commit-msg` from before the
`release_*` exemption was written, and real release commits came out carrying the prefix that edit
removed.

⚠️ **It is a HEAL, not a guard, and the alternative was rejected on purpose.** A test comparing
installed against source goes red for the state of somebody's machine rather than for anything in
the diff under test, needs a skip for a clone that has no hooks — and `CLAUDE.md` already declined a
blocking hook once, on the grounds that *"the discipline IS the guard"*. ⚠️ **And the two must not
both exist**: healing immediately before such a test ran would leave a guard that cannot fail, which
is the class being fixed here, not a belt-and-braces version of it.

That is also why the installer compares before it copies and prints only on a real write. On a gate
this runs every time, so an unconditional line per hook would be noise on every run — and the one
run where it matters would look exactly like the hundreds where it does not.

⚠️ **It writes ONLY inside this clone's own `.git/hooks`, and that is a safety decision, not an
oversight.** `git rev-parse --git-path hooks` — where git actually *runs* hooks — honours
`core.hooksPath`, which is typically ONE directory shared by every repo on the machine. A version of
this installer used it as the WRITE target and replaced the developer's own hook there, in every
repo, from a `verify` run: reproduced, reverted the same day. Where git *looks* is now only
**reported** — when it differs, the installer says the install is INERT and names both directories.
Two questions that read alike: *where may we write* is answered by the clone, *where does git look*
by `--git-path hooks`.

⚠️ **Silence from this preamble must mean "nothing to do", never "it failed".** The first version
filtered the installer's output with an allow-list (`[hooks] installed …`), which also discarded its
stack trace — measured, an unwritable hooks dir exits 1 with EACCES and `verify` printed nothing and
went green, i.e. the heal's own reporting hiding the state the heal exists to prevent. It is a
deny-list now (one known-noise line suppressed, everything else passed through) plus a warning on a
non-zero exit. `gitHooksInstall.test.ts` pins both, and pins that the installer really does fail
loudly, so the claim is about something reachable.

**The falsifiable half lives elsewhere.** `engine/tests/architecture/gitHooksInstall.test.ts` drives
the installer into a throwaway `git init` repo and asserts what LANDED — byte-identical, executable,
a stale copy replaced and reported, a current one silent — and the behavioural `prepare-commit-msg`
block in `releaseBranch.test.ts` now installs into its own throwaway repo and spawns the installed
copy rather than the source. This is the general rule behind both: **verify the artifact that
executes, not the source it was built from.** A test on the source cannot fail for the copy being
stale, and this one stayed green through a full day of the live hook doing the old thing.

### The two lanes share ONE working tree — a test must not leave a linted file in it

⚠️ **A test that writes a linted-extension file (`.ts/.tsx/.js/.mjs/.cjs`) into a non-ignored
directory can take the gate red from the other lane, with zero failing tests.** The lanes are
concurrent over one checkout, so the app lane's writes land under lane 2's `lint` while it is
enumerating. **ESLint is the reader that DIES** — it treats a stat-then-read mismatch as **fatal,
not skippable** (`ENOENT … readAndVerifyFile`, exit 2), and it is the only reader that fails the
gate from the OTHER lane.

⚠️ **It is not the only exposed reader, and a fix aimed only at it is not a fix.** Two guards in
the APP lane also enumerate by extension and then read, so they race the writer *within* one lane,
across `fileParallelism` workers:

- `buildWebCallSites.test.ts` — `repoFiles({ under: engine/, match: /\.(ts|mjs|sh)$/ })` at MODULE
  scope, read through `readScannedSource`, which does **not** catch. An ENOENT there throws during
  vitest COLLECTION. `repoCorpus.test.ts` names this file as the hazard its own probe was moved to
  avoid.
- `noNulBytesInSource.test.ts` — its `SOURCE_EXT` includes `.cjs` and it walks the whole repo. It
  survives only because its read sits in a `try { … } catch { continue }`.

`tsc` is a third reader, but a narrower one than it looks: no tsconfig sets `allowJs`, so a
transient `.cjs` is invisible to it, and a transient **`.ts`** is picked up only inside the three
root programs' `include` sets: `engine/app`, `engine/electron`, `engine/tests`, `games`, `demos`
(plus `engine/vite.config.ts` by name). A stray `.ts` under `engine/scripts/` or `engine/plugins/` is in no
program at all, which is exactly the directory `buildWebCallSites` scans and where this repo has
already been bitten. Do not reach for `tsc` as a safety net there.

**Two failures, not one, and a fix for either alone leaves the other:**

| | trigger | symptom |
|---|---|---|
| mid-flight | the other lane is globbing while the file exists | `[FAIL] <lane>` with **no failing test underneath** — indistinguishable at a glance from a real failure, and the documented "re-run quiet before believing a red" reflex costs a full gate cycle |
| stranded | a SIGINT / crash / failed pack skips the cleanup | the artifact is **linted** on every later run, red until someone deletes it by hand |

**The rule: any transient artifact written into the tree is declared in BOTH `.gitignore` and the
`ignores` list in `engine/eslint.config.js`, as the same glob.** Those are two lists that must
agree, and #879 was exactly them disagreeing — `.gitignore` knew about `engine/vite.config.cjs`
and not the test probe beside it; ESLint's list knew about neither. That is the **fourth** time
this list has cost a red gate (`ads/` — 33,482 errors from one interrupted playable build;
`subgame-dist/` — 1,657; `.claude/worktrees/` — 36, in code not even on the branch), which is why
the entries there each carry the lesson in prose — and why the seam itself is filed as **#885**
rather than left as a fifth comment asking the next author to remember. Gitignoring is also what
keeps an artifact out of every `repoFiles()` corpus — see
[Corpus production](#corpus-production-the-one-enumerator-these-guards-share), which enumerates
with `git ls-files --others --exclude-standard`.

**Prefer not writing into the tree at all.** Almost every test here uses `mkdtemp`; the handful
that cannot each say why in place. `packagedViteConfig.test.ts` genuinely cannot — the bundle
collapses the plugin graph into one file whose modules locate themselves via `__dirname`, so it
must load from inside `engine/`. `repoCorpus.test.ts` shows the other way out when the location is
forced: put the probe where **no reader's filter reaches it** (repo root, `.tmp`), which is where
its own comment says it moved after living under `engine/scripts/`. ⚠️ That comment describes the
hazard **prospectively** — *"a flake seam this test creates for its neighbours"* — so treat it as a
reasoned relocation, not as a recorded flake; no such failure was observed.

`engine/tests/architecture/ignoreListsAgree.test.ts` pins the two `vite.config*.cjs`
producers by asking the real resolvers (`ESLint#isPathIgnored`, `git check-ignore`) and by deriving
the filenames from the producers' own source, so renaming one goes red instead of silently
reopening the hole. ⚠️ **It pins those two, not the class** — a new test writing some other linted
extension into a linted directory reopens this with the guard green. That is what this rule is for.

### A red gate that belongs to ANOTHER CLONE's machine, not to your branch

⚠️ **`cleanPackagedCacheLinkGuard.test.ts` goes red whenever a packaged editor is running anywhere
on this machine — including one another clone started.** `clean-packaged-cache.mjs` refuses to run
while the app is up (*"is currently running — quit it first, or re-run with --force to kill it"*),
which is correct: it is about to delete that app's cache. The guard drives the real script, so the
refusal reaches your gate as a failure.

`smoke-packaged.sh` stages its app at `$TMPBASE/modoki-pkg-smoke-$CLONE`, so the running binary's
path NAMES the clone that launched it — read it before doing anything else:

```
ps aux | grep -i "Modoki Editor" | grep -v grep
#   …/T/modoki-pkg-smoke-modoki-qa/mac-arm64/Modoki Editor.app/…   ← work-qa's, not yours
```

⚠️ **This is NOT the "a live editor breaks a concurrent verify" rule in `CLAUDE.md` § Editor.** That
one is about a DEV editor on your own clone, which your own discipline can prevent. This is a
PACKAGED editor on a sibling clone: nothing on this checkout can see it coming, and the failure text
("quit it and re-run") addresses someone who is not you.

**What to do — and the first step is attribution, not a fix:**

1. **Check whether the failing file is the ONLY one that failed.** If your change is innocent, it
   will be — a real defect does not confine itself to a guard about packaged-cache deletion.
2. **Re-run that file alone once the sibling's process exits.** Passing in isolation on a quiet
   machine is the confirmation.
3. ⚠️ **Do NOT kill it, and do not reach for `--force`.** `CLAUDE.md` § Clones: never reap another
   clone's processes — a packaged smoke takes minutes and killing it costs that clone its run. Wait;
   observed 2026-09-10 exiting on its own inside ~100 s.

Both sightings that day cost a gate re-run each and self-corrected. The expensive outcome is the
other one: reading the red as your own and going looking for it in a diff that never touched
`engine/toolchain/**`.

#### ⭐ FIXED 2026-09-10 (#1037) — and the fix is narrower than "a packaged editor is running"

The section above is kept because the *attribution* advice is still how you read a red gate, but its
premise is gone: **the guard no longer fires because an editor is running somewhere on the machine.**

`isPackagedRunning()` asked `pgrep -f "<productName>.app"` — *"does this string appear in ANY
process's argv"* — which is not the question that makes a wipe unsafe. It was wrong in both
directions, and the too-broad half had **three** observed shapes, only the first of which the advice
above covers:

| what matched | was it an editor? |
|---|---|
| a sibling clone's packaged smoke, in its own temp dir | yes, but not *this* installation |
| a shell running a heredoc that QUOTED the path | no |
| a `grep`/`pgrep` typed to debug this very issue | no — **the diagnostic triggered the bug** |

It also refused `--dry-run`, which deletes nothing, because liveness was consulted before `DRY_RUN`.
Five sightings across four clones, and it reds **`verify:publish`** too — the hub's only gate against
a private value reaching the public mirror.

`engine/scripts/livePackagedEditor.mjs` now asks two questions instead: is this process **executing**
the bundle (from the executable path, never argv), and is it **this installation** (its
`--user-data-dir`, or the packaged default, under one of the paths the run would delete). A sibling's
smoke points at its own scratchpad and no longer blocks; the developer's real editor still does.

⚠️ **The remaining reason to read this section is that `--toolchain` still cannot see a live DEV
editor** — the toolchain is machine-shared, and that gap is deliberate (owner, 2026-09-10): nobody
has established a toolchain wipe actually breaks one. If you ever see it happen, record the
observation before writing a guard.

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

### The SCOPED per-project typecheck — `typecheck:projects` (#24, #967)

`npm run typecheck` compiles ONE WIDE program: `engine/tsconfig.app.json` includes `app` plus ALL
of `../games` and `../demos`. **A per-game web build does not** — `build-web.mjs` generates a
SCOPED config holding `app` plus the one active project. So a project file can typecheck in the
gate purely because a SIBLING project puts something in the shared program, and then fail the
release build. That is #24. `npm run typecheck:projects` is the gate for it: it regenerates that
same scoped shape (via `scopedTsconfig.mjs`, shared with `build-web.mjs` so the two cannot drift)
and runs `tsc -p` per project.

⚠️ **It used to run in exactly one place — the private `ci.yml` — so when that stopped being run
it ran NOWHERE** (#967). No local gate called it, and the free public runner carries no `games/`
at all, so #24's hole was open with nothing behind it. It is now a leg of `verify` (lane 2, after
`typecheck`).

**It checks the projects the branch TOUCHED, not all of them**, which is what makes it affordable:
a full sweep on every `verify` would roughly triple an 82-86s gate. ⚠️ **The per-project and
full-sweep timings live in ONE place — `engine/scripts/typecheck-projects.mjs`'s own header — along
with the caveat that the project COUNT is a per-clone filesystem fact (this clone has 29
directories; `git ls-files` knows 25) and must not be quoted as a repo fact.** Don't copy them
here; that is how the ~110s `verify` figure above went stale.

⚠️ **On `main` this leg roughly DOUBLES `verify`.** A clean checkout of `main` is the degenerate
`merge-base === HEAD` case, which fails safe to a full sweep, so lane 2 becomes the pole there and
the 82-86s wall-clock does not hold. Owner's call, taken deliberately (2026-09-08): a fresh clone
that checks nothing and reports green is the failure this gate exists to prevent. The hub's normal
path is the cheap one — right after `git merge origin/<branch>` the `--first-parent --no-merges`
walk sees nothing, so the leg selects 0 projects.

A
typical worker branch selects 2. ⚠️ **The in-lane cost is stated in ONE place — the scoped leg's
own comment in `engine/scripts/verify.mjs`** — because the in-lane figure and the standalone one
differ by ~1.7x and quoting the wrong one understates the gate (I did exactly that in the first
draft of this section). What matters here: it has not made lane 2 the pole in any measured run,
lane 2's documented "~30s of slack" is a pre-#967 figure and the margin is thinner than it reads,
and the run it was measured in had Court's suite in the app lane — the Court-excluded
configuration has NOT been re-measured, so do not assume the leg is free there.

Scoping it that way is *sound*, not merely cheap — the mask can only bite the project you touched:

| What changed | Why the touched-only default still catches it |
|---|---|
| A project gains the offending import | Checking THAT project catches it — the real case |
| The sibling DROPS the dep it was leaking | The WIDE program stops resolving too, so plain `npm run typecheck` goes red first |
| A new project is added | It is "touched" by definition (the selection reads untracked files too) |
| Engine `app/**` changes | Present in the wide program AND in every scoped one; already covered |

The one thing that changes the scoped SHAPE for a project you did *not* touch is the scoping
machinery itself, so touching `engine/tsconfig.app.json`, `scopedTsconfig.mjs`, `build-web.mjs` or
`projectRoots.mjs` escalates to a full sweep.

⚠️ **Selection FAILS TOWARD SWEEPING EVERYTHING.** No git, no `origin/main`, or a degenerate
`merge-base === HEAD` range all mean *cannot tell*, and that maps to `--all`.

⚠️ **Those are TWO different facts and the report says which (#826).** The degenerate range is not
a failure — git answered fine, HEAD merely has nothing beyond `origin/main` — and it is the
commonest position on the fleet, not a rarity: any checkout sitting AT `origin/main`, which a
fast-forward merge produces, plus the hub after every push and a freshly cut `release_*` branch.
Collapsing it into "git could not answer" was a false statement on the line a human reads before a
long run, and it cost a session a turn of the owner's attention. `selectTouched` now prints
`HEAD has no commits beyond origin/main — sweeping ALL` for it and keeps the original wording for a
real failure. **Which projects get checked is unchanged** — only the sentence. Same contract, and the same reasoning, as `courtTouched()` in
`courtAuthored.mjs`: a detector that cannot answer must never be indistinguishable from one
answering "nothing changed". The committed half of the diff is `--first-parent --no-merges`, so
merging someone else's game work does not make the hub re-check it — CLAUDE.md's "merging is not
re-testing AT THE HUB".

⚠️ **A green run is not automatically coverage — read the `selection:` line it prints.** "0
projects" is a legitimate and common result (a branch that touched no game), but it is also what a
broken detector would print. `--list` prints the selection and checks nothing; `--all` (or
`npm run typecheck:projects:all`, which `verify:all` and `ci.yml` use) forces the full sweep; a
bare project name checks just that one, and an unknown name is a hard error rather than an empty
green run.

⚠️ **Exit 0 is not coverage, so the leg checks that each project actually contributed files.**
`app` alone makes the scoped program non-empty, so `tsc` never raises TS18003 and a run that
compiled NOTHING of the project would report PASS — the same "a config can be wrong in a way that
looks clean" trap the section above describes. The leg therefore runs `--listFiles` and fails a
project that contributed zero files *while git says it has TypeScript sources*; a project with no
TypeScript at all (`games/agy`) reports `no TypeScript` rather than a hollow PASS.
⚠️ **Widening `SCOPED_EXCLUDE` is NOT the way to trigger that** — measured 2026-09-08, it does not
empty the program, because `tsc` still pulls a file in when an included file IMPORTS it, so an
exclude only strips what nothing reaches. The include shape (`buildInclude()`) is the lever, which
is why that file is in `MACHINERY_PATHS`.

**Re-proving this leg can fail — and why the obvious probe no longer works.** #24's original
symptom was `node:*` resolving repo-wide because some project pulled in `@types/node`. That shape
**no longer reproduces**: `@types/node` now sits in the repo-root `node_modules`, which every
scoped program can reach, so a game importing `node:path` passes both the wide and the scoped
program. The difference between the two is now only *which project sources are in the program*, so
a faithful probe has to be a cross-project source reference — declare an ambient global in one
project's `.d.ts` and consume it from another. Verified 2026-09-08: wide exit 0, scoped exit 1
with `TS2304: Cannot find name`.

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

⚠️ **As of 2026-09-08 it is not run at all** (owner). "Manual" has become "retired in practice",
so do not describe it as a gate that exists — read the two paragraphs below for what that
orphaned before assuming something is still covered.

**So the local gate is now the ONLY gate: run `npm run verify` before every push** (typecheck +
scoped per-project typecheck + lint + app tests + engine tests). Nothing remote will catch what
you skip. If the owner ever does ask for a CI run, use `gh workflow run ci.yml --ref main` then
`gh run watch <id>`, and **read BOTH legs** (or the `gh-ci` skill).

**What retiring it orphaned.** Every other step in that workflow (`typecheck`, `lint`, `npm test`,
the engine suite) is `npm run verify` re-spelled, so only two things were lost:
- **`typecheck:projects`** — the scoped per-project typecheck was reachable from nowhere else.
  Fixed in #967 by making it a leg of `verify`; see the section above.
- **Nothing else — and in particular NOT Windows.** ⚠️ It is tempting to conclude the Windows
  matrix died with this workflow. It did not: `oss/.github/workflows/ci.yml` runs an
  `[ubuntu-latest, windows-latest, macos-14]` matrix on the PUBLIC mirror, free and automatic on every push
  to `main` (#96 — that file's header explains that Actions is unbilled on standard public-repo
  runners, windows-latest included, so the leg that costs ~47 billed minutes privately is free
  there). #847 is a `ci/main` run going red *on windows-latest*, i.e. direct evidence the leg
  fires. The residual gap is narrow and specific: the public snapshot carries **no `games/`**, so
  a game project's Windows behaviour — and `typecheck:projects`, which needs `games/` to have
  anything to check — is gated on no runner anywhere, only on someone running `verify` on the
  `win` clone ([windows.md](./windows.md)).

  ⚠️ **That public `check (windows-latest)` leg is the only AUTOMATIC place a Windows red is
  visible to anyone but the `win` clone** — the private `ci.yml` runs a `check (windows-latest)` of
  its own over the same matrix, but it is `workflow_dispatch` and billed, so nothing fires it and
  it is not a gate anyone waits on. A green
  `verify` on a Mac says nothing about it, and — the trap that actually bit — a green `verify` on
  `win` does not either, when the box differs from the runner. #958/#949 are the worked example:
  `repoReapSpellings.test.ts` was red on that leg from the moment #913 landed, green on every Mac,
  and its sibling `projectPaths.test.ts` was filed as reddening the same leg when it never did
  (both the runner and the `win` box have the symlink privilege; a box without it has neither).
  **So: read the leg, do not reason about it** — `gh run view <id> --repo lsgmasa33/modoki-engine
  --log-failed`. A Windows claim argued from a Mac has been wrong here more often than right.

  **`macos-14` joined that matrix on 2026-09-09** (owner), on the same economics: unbilled on a
  public repo, already used by the `package` job, and running in parallel so it costs no
  wall-clock. ⚠️ **Its value is narrower than it looks and the distinction is worth holding.** A
  platform **RULE** — pure logic that merely branches on the platform — needs no runner: make it
  injectable and every leg pins every branch for free (`appSupportRoot` is the worked example). The
  leg buys the other half, platform **BEHAVIOUR**, which injection cannot reach: `/var` →
  `/private/var` aliasing, `rmSync` unlinking a dir symlink and sparing the payload, mount-point
  traversal. Measured over the assignment that prompted it (#883/#949/#955/#958): the platform was
  genuinely necessary **twice**, and the macOS-only test failure found by hand that day was a RULE
  — unreachable for want of a parameter, not for want of a Mac. Worth its zero cost; **not** a
  substitute for a second reader, which caught considerably more. Full split:
  [windows.md](./windows.md) § "The same split decides what a test can COVER".

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

⚠️ **`N/A` is a third status and is NOT a skip** (#991). A SKIP means *this runner could not check
it*, which a toolchain install would fix — so `--require-all` is right to fail on it. An N/A means
*there is nothing here to check on any machine*, a fact about the package rather than the runner, so
it stays off the exit code even under `--require-all`. One row today (`ios/class/capacitor-litert-lm`,
whose package is not an SPM package); the reason prints in the summary, and the row's premise is
asserted under `npm run verify` so it cannot quietly go stale. Detail:
[native-and-sdks.md](./native-and-sdks.md) § `no-spm`.

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
them rather than trusting a listing here. **The two trees are separate vitest projects, and which
one a path lives in decides how you run it:**

```bash
npx vitest run --config engine/vite.config.ts <path>   # engine/tests/** and games'/demos' tests
npm --prefix engine/packages/modoki test -- <path>     # engine/packages/modoki/tests/**
```

The `--config` on the first is required — without it a game's tests fail with
`__MODOKI_MODULE_RENDER2D__ is not defined`.

⚠️ **Pointing the root config at a package test finds NOTHING and exits 0** — `engine/vite.config.ts`
carries `exclude: ['**/node_modules/**', 'packages/**', '**/release/**']`, so
`npx vitest run --config engine/vite.config.ts engine/packages/modoki/tests/video/` prints
`No test files found` and reads as "the file is broken" rather than "wrong runner". Both suites run
under `npm run verify`, so this only bites while iterating on one file — which is exactly when a
silent empty run is most expensive. Surfaced by the #426 review, which lost a pass to it.

### Corpus production: the ONE enumerator these guards share

A guard that scans source first has to decide **which files**. Before #799/#771/#805 every one
answered that itself, and each answered a different part of it wrong — the ROOT, the enumeration
SOURCE, the EXCLUSION set, the separator NORMALISATION, and whether to pin NON-VACUITY. **Every
omission fails OPEN**, because the dominant shape here collects offenders and asserts the list is
empty, and an under-enumerated corpus satisfies that. A guard scanning nothing is indistinguishable
from a clean repo.

⚠️ **Never hand-roll a corpus. Import `repoFiles` from `engine/scripts/repoCorpus.mjs`.** Enforced
by `engine/tests/architecture/corpusProducerIsShared.test.ts`, which forbids a direct `git ls-files`
spawn and a hand-rolled recursive `readdir` walker. It lives in `engine/scripts/` rather than
`engine/tests/helpers/` because the plain-`.mjs` build scripts must import it too — the same `.ts`
barrier that forced `pathPosix.mjs` to exist (see [windows.md](windows.md) § Paths).

⚠️ **A source-scanning guard needs BOTH shared halves, and they answer different questions.**
`repoFiles()` decides *which files* are in the corpus; `readScannedSource()` (next section) decides
*how each one is read*. Landed independently by two clones — #799/#771/#805 and #812 — and
`corpusProducerIsShared.test.ts` is right to call itself `commentStripperIsShared.test.ts`'s
structural twin one mechanism over. A guard using only the first enumerates the right files and can
still be satisfied by a comment in one of them; a guard using only the second reads each file
correctly and can still be blind to half the corpus. The shape to copy:

```ts
for (const { abs, rel } of repoFiles({ under: SRC_DIR, match: /\.tsx?$/, floor: 400 })) {
  const { code } = readScannedSource(abs);   // enumerate with one, read with the other
}
```

```js
import { repoFiles } from '../../scripts/repoCorpus.mjs';
// `rel` is git's own repo-relative POSIX path; `abs` is joined FROM it.
const files = repoFiles({ under: SRC_DIR, match: /\.tsx?$/, floor: 400 });
```

What it settles once, and why each one is load-bearing:

- **`rel` is git's output verbatim** — already POSIX on every platform. Joining TO an absolute path
  is safe; the round-trip BACK via `path.relative` is the hazard, and it is what
  [windows.md](windows.md) § Paths records eight instances of. `under` accepts an absolute path
  precisely so no caller needs that round-trip.
- **`-z`, always.** Without it git C-quotes and octal-escapes non-ASCII paths, and this repo has 18.
- **`execFileSync` with argv, never `execSync` with a shell string** — `cmd.exe` does not strip
  quotes, so a quoted pathspec matches nothing. This was live in `migrate-assets.mjs`: measured 0
  files where the same argv unquoted found 69, with the failure swallowed by a `catch`.
- **Two separate aborts.** A git *throw* cannot be caught by an empty-result check, and a
  zero-file listing is always fatal regardless of the caller's floor.
- **`floor` is REQUIRED**, so the author must answer "how few files means my enumeration is broken
  rather than my repo clean?". `floor: 0` is a legitimate answer — it throws, so at MODULE scope it
  fails vitest *collection* rather than skipping — and then the real pin belongs in a `skipIf`-gated
  test. `engine/tests/assets/prefabInertSize.test.ts` is the worked example.
- **`includeUntracked` defaults to true.** A file you just wrote and have not staged is exactly when
  a guard is most useful; pass `false` only when the guard's subject is genuinely what is COMMITTED.

⚠️ **Its ledger is load-bearing, and that is the part to preserve.** Every `EXEMPT` entry must
*currently* be flagged, so migrating a producer makes its entry stale and turns the gate RED until
the entry is deleted — the list cannot rot into decoration the way a path-keyed allowlist did in
#578. For the same reason the detectors' aliveness pins are SYNTHETIC: a floor on how many real
offenders survive counts down to zero as the migration succeeds, which is a countdown, not a pin.

⚠️ **Scope: the guard reads `engine/tests/**` and `engine/scripts/**` only.** 15 producers live
outside it — including five guards in the `engine/packages/modoki/tests` project and
`scripts/scan-publish-safety.mjs` — tracked as **#814**. A green run is not "none exist".

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

⚠️ **Do not read the file yourself either — `readScannedSource` is the entry point (#812).** One
scanner was never the whole rule: sixteen guards imported nothing and matched
`fs.readFileSync(…, 'utf8')` output directly, and enforcing the rule turned up twenty-one more —
the class was 37 files, not the 16 the report enumerated. Remembering to strip is exactly what nobody does, so the READ is what got routed.

```ts
import { readScannedSource } from '@modoki/engine/testing';
const { raw, code } = readScannedSource(absPath);   // strips by EXTENSION, runs assertScanIsSane
expect(code).toMatch(/…/);                          // match on `code`; `raw` only to scan prose
```

It picks a stripper by extension — js · braces (C-family, no regex literals, and where `.pbxproj`
lands: Xcode writes `/* Name */` annotations denser than anything else the guards scan) · swift ·
shell · yaml (`#`, the same rule — a workflow guard is defeatable by a comment exactly as a script
guard is) · jsonc — and **REFUSES an extension it has no stripper for** rather than falling back to
raw text, because falling back is the defect. A guard scanning Markdown or a storyboard declares
`{ comments: 'include', reason }`, which makes the exemption a sentence somebody wrote instead of a
silent default.

⚠️ **Before registering a language, read the CONSUMER's pattern — a "comment" a guard MATCHES is
data, not noise.** `.pbxproj` was briefly routed to the C-family stripper because Xcode annotations
are the densest comments in the repo. They are, and `pbxprojObjectIds`' regex matches them *as
syntax* (`^\t\t<id>(optional annotation) = {`), so blanking them cut the object ids that guard
inspects from **43 to 1** while it stayed green under a `> 0` floor. `.pbxproj` is now deliberately
unregistered so the reader refuses it and the caller has to decide. The general lesson is the one
in `sourceScanner.ts`'s docblock; the general defence is a non-vacuity floor that can tell 43 from
1, which `> 0` cannot.

⚠️ **Stripping is not universally right, and that is why the opt-out exists.** `docCitations` scans
comments on purpose (a citation living in a docblock is exactly what it exists to catch), and
`editorStoreActionsReachable` states that any textual reference counts — strip either and you DEFEAT
it. `fontSourceShipped` is the mixed case that shows the shape: eight of its assertions are about
code, and one asserts that a RATIONALE is documented, where the comment IS the subject. The reader
hands back both views from one read, so it keeps `code` for the eight and `raw` for the one, named
`SRC` and `SRC_WITH_PROSE` so reaching for prose stays a deliberate act rather than the default.

**Both halves are enforced by `commentStripperIsShared.test.ts`** — no hand-rolled stripper
anywhere, no raw read of repo source, and no `.raw` without a declared reason, across
`engine/tests/**`, `engine/packages/modoki/tests/**` **and every `games/<id>/tests` and
`demos/<id>/tests`**.

⚠️ **`.raw` is enforced because it was a silent bypass.** `comments: 'include'` throws without a
`reason`; `readScannedSource(p).raw` returns the identical unstripped text and required nothing,
and the rule matched only `readFileSync` — so a `.raw` scan was invisible to it. It was live in
`mcpRegistry`, the migration's own worked example, with two call sites matching CODE against raw
text. `.raw` now has to come from a read that declared the opt-out.

⚠️ **The scope was narrowed twice and both narrowings were wrong, which is the whole lesson
(#812 → #816).** First to `engine/tests/architecture/`, then — after widening — to "both vitest
projects", which still left out `games/<id>/tests`: not a third project (Court's suite runs under
`engine/vite.config.ts`), and already enumerated by the *other* rule in the same file. Three real
source-scanning guards were reading raw there, two of them scanning `games/court/runtime/systems.ts`
— the file where #411's comment defect was found LIVE.

⚠️ **On the first narrowing:** The argument was that of 1,234 test files only ~113 carry a raw utf8
read, and almost all of those read back a fixture the test itself just wrote — so a repo-wide rule
would need a ~55-entry allowlist, which is the same fail-open hole one level up. True about the
FILES, wrong about the RULE: the exclusions already discriminate a fixture read from a source scan
by what it *is* (wrapped in `JSON.parse`, wrapped in `stripComments`, or a Markdown path), so the
directory was standing in for a test that had already been written. Widening the roots needed **no
allowlist at all** and found **28 more real source-scanning guards** — in `assets`, `editor`,
`electron`, `plugins`, `tools` and the package suite, i.e. every root the narrowing had excused.

The generalisable bit: **a scope restriction is a claim about where a defect can occur.** If the
rule's own exclusions can tell the classes apart, the restriction is buying nothing and hiding
whatever sits outside it.

#### A script that looked for something reports what it LOOKED FOR — and a gate floors it

The reporting half of the same discipline (#944, after #908 and #129). A script that prints its
success message and exits 0 on an empty result set makes "did the work" and "matched nothing" one
output and one exit code, so a lookup that silently found nothing reads as a completed operation.
The failure then *"presents as **the app is broken**, not as **something was stopped**."*

⚠️ **The property wanted is DISTINGUISHABLE, not FATAL.** Most of these genuinely have nothing to do
most of the time — `dev:stop` with no server running is the normal case. Three outcomes, three
messages: did it, had nothing to do, could not look. `stop-editor.sh` now names the patterns it
searched, and `clean-packaged-cache` the paths it checked, which is what makes a spelling miss
visible to a human instead of silent.

**A GATE is the exception, and even there the floor goes on the right question.**
`typecheck-projects` exits non-zero on zero projects — but keyed on whether the project ROOTS are
on disk, not on the count, because `discoverProjects` documents that a checkout may legitimately
ship neither ("the public OSS repo ships neither") and a blanket fatal would redden a correct tree.
Its `repoRoot` is derived from the script, never `process.cwd()`: a gate must check the same tree
whoever spawned it and from where. `repoCorpus`' required `floor` is the reference shape.

⚠️ **The gate exception has since been taken for a NON-gate, deliberately.**
`migrate-private-config` is a manual `npm run`, not a gate, and it also exits non-zero on a
discovery miss — because its empty-set message was not merely unhelpful but a positive claim
(*"every project is already clean"*) about projects it never examined. So the rule is not "gates
floor, scripts don't": it is that a script asserting something about what it found owes a floor on
having found it. A script that only reports its own inaction does not.

⚠️ **An empty result asserted as a CONCLUSION is the worst form.** `logKillForensics` printed an
empty candidate list as positive evidence that the killer had already exited — while omitting the
repo's own `stop-editor` from the list it filtered on, so a live stop produced the same empty
output as no killer at all. If two states are indistinguishable from where you stand, say so rather
than picking one.

**Two halves, one site.** Whether a lookup MATCHES (`docs/windows.md` § Paths) and what it SAYS when
it does not are separate mechanisms with separate fixes — but at a reap they are one repair, and
fixing either alone leaves a half-repair. #908 shipped both together at `dev:stop` for that reason.

### The second half of that rule: a scope bound ships with an assertion, or it is a comment

**A comment naming a hole is not a guard over it** (#830, 2026-09-06). Applying the rule above to
the rest of the repo found **ten more** guards whose declared scope was narrower than the claim in
their own docblock — and the striking part is that most of them *said so*. `corpusProducerIsShared`
called its own scope "a real hole, not a tidy boundary"; `chromeTagging` had an `HONEST SCOPE` note;
`mcpErrorCodes` recorded which directory it never scanned. Every one of those admissions was
accurate, and every one was inert. Prose does not fail a build.

⚠️ **The sharpest version — and the one to look for first — is a self-check that filters the
hand-list BY ITSELF.** Four sites independently wrote it. `clonePortHardcoding.test.ts` is the
clearest:

```ts
const resolvesBinary = SPAWNERS.filter(existsSync).filter(hasMarker);
expect(resolvesBinary.sort()).toEqual([...SPAWNERS].sort());
```

under a comment claiming the set was *"found by the marker … rather than by a hand-listed set, so a
NEW spawner is covered the day it is written"*. It can detect a **deleted** entry and never an
**added** one — and the population is the thing that grows. Four unlisted spawners were sitting
outside it.

**The fix has three shapes, and picking the wrong one is how the defect returns:**

| Shape | When | Example |
|---|---|---|
| **Derive** — delete the list | the subject is enumerable by a marker, or the type checker can enumerate it | `NumberField.dataUiId` made REQUIRED, so `tsc` names every call site (#772) |
| **Widen + migrate** | the scope is a directory bound, so there is no list to assert | `corpusProducerIsShared`'s `under` → the repo (#814) |
| **Assert completeness** | the list must stay, so make its gap RED | `assertDeclaredListIsComplete` (#830) |

`engine/tests/helpers/declaredList.ts` is the shared helper for the third: *enumerate the population
by its marker, assert the hand-list equals it*, with a reasoned exemption ledger whose every row
must CURRENTLY be flagged. `testFilesAreCollected.test.ts` is the older, hand-written instance of
the same idea and is worth reading as the reference.

⚠️ **The marker is the judgement; the helper only makes the comparison honest.** A marker that is
subtly too narrow re-creates the defect one level down with every test still green. Two ways that
actually happened while writing this:

- **A marker only meets its population once you widen the scope.** `clonePortHardcoding`'s
  "derives a per-clone port" check tested for `clonePort.mjs` alone, while `CLAUDE.md` names
  `editorPorts.mjs` as the primary derivation. Both `launch-editor.sh` and `test-packaged.sh`
  derive correctly and would have FAILED it — the narrowness was invisible until the list grew to
  include them.
- **Comment-stripping silently changes a population.** A marker run over `readScannedSource(…).code`
  cannot see a mention that lives in a docblock, so `packagedAppPaths.d.mts` dropped out of its own
  population and `launch-editor.sh`'s `clonePort` references (all comments) did not count.

**And the honest limit is part of the fix.** Where a marker cannot reach file granularity, say so in
the guard rather than implying otherwise: `courtSweepScope.test.ts` asserts coverage at BARREL level
because Court's tests import the runtime barrel 104 times, and per-file coverage would resolve to
watching all of `src/runtime` — which `courtAuthored.mjs` rules out as making the gate a no-op. A
guard whose scope claim is wider than its reach is the defect this whole section is about, so a
guard that states its own reach is not hedging.

⚠️ **Both directions of this defect are fail-OPEN, and the second one is the easy one to miss.** A
**forbidden**-pattern guard goes green because a comment HID the offender. A **required**-pattern
guard goes green because a comment SATISFIED the match — so the real call site can be deleted and
nothing fails. Measured example of the second: `devStopEditorCarveOut` asserts `stopDevServer.mjs`
tests for `--configLoader runner`, and that file's own explanatory comment matched the regex on its
own.

```ts
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
const stripped = stripComments(raw);          // or { regexLiterals: false } for non-JS source
assertScanIsSane(raw, stripped, 'file.ts');   // BEFORE any count is trusted
```

The lower-level `stripComments` stays exported for source you already hold as a string — a sliced
function body, shader text, a value that never came off disk.

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
