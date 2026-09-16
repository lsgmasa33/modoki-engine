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

#### The other shape: a guard whose SAMPLE only exists on a machine that has built iOS

⚠️ **Same class, but no running process to blame — the file simply cannot exist here.**
`packagingManifest.test.ts`'s accept side asserts every `ship` row names a path that really occurs,
so an over-broad exclude cannot silently drop something required. Its `Package.resolved` row sampled
`engine/packages/capacitor-game-debug/Package.resolved` — which **SwiftPM writes during an
Xcode/`cap sync` build**, and `.gitignore:83` excludes. On a Mac that has built iOS it is there; on a
clone that has not it is absent; and on the **Windows clone it is permanently absent**, because that
toolchain cannot run at all.

So it was green on the clone that wrote it (#1050 close-out, `work-qa`) and red on the next gate to
see it — 1 failed file out of 723, on a branch that had touched neither packaging nor any capacitor
package. **Attribution first: if your change is innocent, the red confines itself to one unrelated
guard.** The fix is the escape hatch the guard already provides — `absentOk` with a written reason,
the same shape two neighbouring rows use for "absent in a fresh clone" and "staged at pack time".
Declaring it does NOT disarm the assertion: mutation-checked by removing a *different* row's
`absentOk`, which goes red.

The general rule, of which this is the second instance: **a guard asserting that a GITIGNORED,
build-generated artifact EXISTS is asserting something about the machine, not about the repo** — and
the machines differ. Five of six clones are Macs.

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
the bundle (from the executable path, never the rest of argv), and is it **this installation** (its
`--user-data-dir`, or the packaged default, under one of the paths the run would delete). A sibling's
smoke points at its own scratchpad and no longer blocks; the developer's real editor still does.

⚠️ **Reopened 2026-09-11 — a flagless editor's "packaged default" was computed from the wrong home.**
A sibling clone's `release/mac-arm64/Modoki Editor.app` (and its Squirrel `ShipIt`) carries no
`--user-data-dir` and is not under a staging root, so the guard attributed it to the default userData
— derived from `os.homedir()`, which honours `$HOME`. The guard suite redirects `$HOME` into a
fixture, so that editor read as "using `<fixture>/Library/Application Support/Modoki Editor`" and
`verify` went red again. **Electron on darwin ignores `$HOME`**: measured with `HOME=/tmp/fakehome`,
`app.getPath('home')` and `app.getPath('appData')` still report the passwd home. The default is now
resolved from that home (`editorHomeDir`), so production is unchanged and a sandboxed run is no
longer anyone's business but its own. win32/linux keep the old derivation as a stated gap — see the
docblock. Reproduced and pinned end-to-end without a signed bundle: macOS `ps -o comm=` reports a
process's `argv[0]`, so a `node` spawned with `argv0` set to a bundle path stands in for the editor.

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

### The 20 files no runner checks on Windows (#1054)

⚠️ **A test whose subject is private-repo-only skips on the public mirror, and the public mirror is
the only automated runner.** On run `34538499332`, job `check (windows-latest)`, the summary read
`Test Files 574 passed | 20 skipped (594)` — **green**, because nothing reads skip counts.

Be precise about what is and is not covered, because the original filing got this wrong in both
directions:

- These tests are **not** ungated in general. They run on every PRIVATE clone's `npm run verify`,
  and five Mac clones run that constantly. **On darwin they are well covered.**
- What has no automated gate is their **Windows** verdict. `win` is the only Windows checkout, so a
  Windows-specific defect in one of them is visible to exactly one machine, and only when a human
  runs the gate on it.

**Measured cost, 2026-09-11:** two defects shipped through this gap in one week, both found by
running `verify` on `win` after a routine merge, both green on every gate, both fixed in
`c23d4a6f9`. Both were Windows path-SPELLING bugs — **a class no Mac clone's `verify` can catch by
construction**: `clonePort` hashed the repo path raw, so Git Bash's `E:/Projects/modoki` and Node's
`E:Projectsmodoki` resolved as two different clones and the launch banner advertised a CDP port
no tool would aim at; and `memoryIndexSync` did `import("E:...")`, which Node rejects as scheme
`e:` before reaching the guard under test.

**THE RULE (owner, 2026-09-11): `win` runs `npm run verify` after every `merge-main`.** That is
already the natural trigger — `/close-out` § 6 merges main on a worker — and it is exactly what
caught both defects above. A self-hosted Actions runner on the Windows box was considered and
**declined**: `verify` takes ~19 min there, so gating every push would cost more of that machine
than the gap is worth. The honest position is that this stays **discipline-guarded, not gated** —
the same acceptance #968 made, now with a price tag attached.

⚠️ **#1084 narrowed this gap by three files, and it is the shape to copy.** `editorPorts.test.ts`,
`editorPortsCli.test.ts` and `clonePortHardcoding.test.ts` skipped on `!hasPrivateTooling()` —
"`.mcp.json` exists", a PROXY for "private clone" — while everything those blocks read
(`engine/scripts/editorPorts.mjs`, `launch-editor.sh`, `lib/repo-reap.sh`, the six packaged-app
spawners, `package.json`) ships in the snapshot: the manifest is `git ls-files -- engine` with no
exclusion under `engine/scripts/`. So the suite whose subject is path SPELLING — the exact class both
2026-09-11 defects belong to — was skipping on the only Windows runner there is. Each block now gates
on what it READS: the port blocks are unconditional, `editorPorts.test.ts`'s doc-table block keeps
`hasPrivateDocs()`, and `clonePortHardcoding.test.ts`'s `.mcp.json` block keeps
`hasPrivateTooling()`. Verified locally by running the four files with `.mcp.json` moved aside —
103 passed, 1 skipped, where previously every block skipped. **The lesson generalises: before
accepting a file into the list below, check whether its inputs actually fail to ship, rather than
whether its gate says so.**

What IS gated: `engine/tests/architecture/layoutConditionalTestLedger.test.ts` pins the **72
test files whose execution is conditional on this checkout** — every `*.test.ts` and Playwright
`*.spec.ts` importing `helpers/repoLayout.ts`, plus any test gating a skip on a raw filesystem
probe — and for each, the predicates its gates call **with their sense** (`!hasInternalGames` =
skips when `games/` is absent; unsigned = the gate is inverted). Membership is the IMPORT, not a
skip shape: review mutation-proved a shape-based detector blind to `describe.runIf(...)`, to an
aliased `const present = fs.existsSync(...)`, to `if (!pred()) { ctx.skip(); }` (the shape
`docCitations.test.ts` uses throughout), and to a `repoLayout.js` import specifier —
`showRefsCorpus.test.ts` skips its whole suite on the snapshot and went unledgered for exactly
that reason. The measurement lives in `engine/tests/helpers/layoutConditionalScan.ts`, imported by
both the guard and the generator that writes the table, so the two cannot drift.

**The raw-probe half missed three spellings, and that was the rule's THIRD under-enforcement
(#98 → #1054 → #1071).** It matched a literal `existsSync(` in a gate expression, so it could not
see a probe wrapped in a same-file function (`docCitations`' own `hasFullDocsTree()`), a
`readdirSync` in a `try`, a bare `if (!exists) return` that reports PASS for a check that never ran
(four in `docCitations`, one each in four more files), or any Playwright spec. #1071 widened the
detector to all of those — with the detector's own accept/reject cases in the ledger file,
mutation-checked branch by branch — and routed every member through a `repoLayout.ts` predicate
(`hasPrivateDocs()` and `hasAgentSettings()` are new). Two boundaries were drawn on purpose and
are worth keeping:

- **A probe is resolved by CALL, not by data flow.** Resolving every mention flagged Court's
  `labels.length < 2` — a puzzle's region count, from a level that was read off disk. The question
  is "does this condition ask whether a path is there", and a value derived from file content does
  not.
- **A presence gate on TRACKED content is not a layout question, so it becomes an assertion, not a
  predicate.** `engine/packages/capacitor-*` and the starter template ship in the snapshot too, so
  a gate on them could only ever fire on a move — and answered one by skipping every check and
  reporting green.

The same pass found the bare return's other half — a PREDICATE answered with `if (!hasAnyProject())
return;` (`sceneContentBudgets.test.ts`) — and the ledger now fails on that shape too: a predicate
is the right question, but only `ctx.skip()` makes the answer countable.

The raw-probe allowlist is keyed per gate SITE — file, gate text and a count — not per file, so
blessing one legitimate probe (a build artifact, a case-folding capability check, a file a sibling
test already reports) cannot hide a second one added beside it, not even a copy-pasted identical
one.

**What the scan deliberately does not reach**, so nobody reads its silence as coverage:

- **Same-file only.** A probe inside an imported helper is invisible — `e2e/hostProject.ts`'s
  `pickHostProject()` (`discoverProjects(process.cwd())`, gating six specs) is the live example,
  carried as `projectPresencePredicate.test.ts`'s one `E2E_EXEMPT` row. ⚠️ Not its `SANCTIONED` list —
  that is a separate, adjacent list in the same file for structural exclusions, and since #1123 the
  two words mean different things there.
- **One call hop.** `const x = helper()` counts when `helper` itself probes, not when it calls
  something that does. Following calls to a fixpoint turned every variable holding a log's TEXT in
  `fileLogWarnings.test.ts` into a "probe": the further a value is from its `existsSync`, the more
  likely it is content rather than presence.
- **JSX.** The literal blanker is a heuristic, and a closing tag's `/` or an apostrophe in JSX text
  can make it drop a closing bracket, which shifts nesting for the rest of a `.tsx` file and can
  hide a gate below it. No `.tsx` test probes the filesystem or imports `repoLayout` today; a real
  tokenizer measured ~10 s over the corpus against the scan's ~0.2 s, so it is a stated limit.

The scan reads literal-blanked source (string, template and regex contents replaced by spaces,
positions kept). #1071's close-out found a bracket inside a string making one declaration's
"initializer" run on for ~200 lines in three real test files, which is what blanking fixed; an
earlier version of this paragraph called that a harmless limit because no verdict had changed yet.

It closes the silence, not the coverage.

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

## What made it faster (2026-09-16, #1285) — and why the 2026-08 numbers above are unquotable

The section above is still correct about **mechanism** and wrong about **magnitude**, because it was
measured on a box that no longer exists in practice.

### ⚠️ Wall clock stopped being a measurement on this machine

Six clones run concurrent sessions (CLAUDE.md § Clones), and a session runs the gate whenever it is
finishing work — so the gate is routinely measured against other clones' gates. Measured on the hub
while `modoki-qa` ran its own:

```
load average: 149.47 / 177.23 / 147.48     on a 12P+4E box
38 live node processes under ~/Projects/modoki-qa · 3 under ~/Projects/modoki
```

That is ~9x oversubscription of the twelve performance cores. **Two runs of the same tree measured
118.4s and 191.7s on the same afternoon**, differing only in what else was on the box.

**The damage is not only slowness — it turns the gate RED.** `engine/testWorkers.ts` already records
the shape: oversubscription's first casualties are the tests nearest `testTimeout`, and they fail as
*timeouts*, which reads exactly like a regression in the diff under test. It cost a session on
2026-09-16 (wordweave `backgroundRotation` overshooting a 20s ceiling by 302ms while `npm test`
alone stayed green).

⚠️ **A casualty does not have to wear a timeout's shape — under load it also fails as an ASSERTION**
(`modoki-ai3`, 2026-09-16, load 123.41/132.11/129.54 with another clone's gate running, on a tree
*without* any of this section's changes). Two files failed that run, neither a timeout, neither in
the diff: `tests/architecture/projectPresencePredicate.test.ts` (*"no test computes project presence
inline"*) and `games/wordweave/tests/backgroundRotation.test.ts`. **So "it failed as an assertion,
not a timeout" is not evidence that the load hypothesis is out** — an earlier version of this
paragraph implied it was, and reasoning from it would start a regression hunt on a saturation
artifact. Both of those files enumerate a corpus off disk, which is the suspected reason they are
load-sensitive; that has not been diagnosed.

⚠️ **The discriminator is re-running the SAME file alone, REPEATEDLY — one isolated pass is not an
answer.** Same afternoon, same sha, no edit between runs, `backgroundRotation` in isolation:
pass, pass, **fail** (1 failed / 5 passed, 20.7s), pass (6 passed, 32.2s). A single clean isolated
run is what got this written off as an unreproducible flake earlier in the day; it took three to see
it alternate.

**The ceilings were then doubled (40s, 120s on Windows), and that was the RIGHT call, not a
symptomatic patch** — this paragraph said the opposite twice. `work-qa`'s three reds the same day
measured 20846ms, 34491ms and 22601ms; all three pass at 40s and none of them is a regression. Do
not lower them. The contention work below is what addresses the cause; the ceilings are what stops
the cause from being mistaken for a diff.

So: **`npm run verify` now prints a `context:` line on every run** — load average, how many verify
runs share the box, and the worker split — plus each lane's vitest aggregates. Those aggregates are
summed across workers and so do NOT inflate under contention the way wall clock does; they are the
only figures two runs on a busy machine can be compared by. **A timing quoted without its context
line is not a measurement.**

`engine/scripts/verifyLoad.mjs` registers each run in `~/.modoki/verify-runs.json` and divides the
performance-core pool by the number of live runs. It intervenes **only when `peers > 1`**, so a solo
gate is byte-identical to before — `testWorkers.ts` keeps deciding, which matters because it returns
`{}` on a homogeneous CPU and halves on Windows. `MODOKI_VERIFY_NO_BUDGET=1` opts out;
`MODOKI_TEST_MAX_WORKERS` still beats everything. It is advisory, not a mutex: serializing would make
one clone wait on another's gate, and the goal is to stop the thrash, not the work.

### The app suite paid for jsdom on every file and needed it on about an eighth of them

`engine/vite.config.ts` set `environment: 'jsdom'` for the whole app suite. The engine package suite
sets no `environment` at all and so defaulted to `node` — which is the entire reason its per-file
environment cost was ~8x cheaper.

⚠️ **The table below was measured over the 866-file, Court-EXCLUDED population** (`courtTouched()`
was false on that branch). The gate runs **1086** files when Court is in. The ratio holds; the
absolute figures are for the smaller set, and quoting them as "the current gate" overstates nothing
but describes a different population than a reader will see.

| (866 files, Court excluded) | jsdom everywhere | node by default |
|---|---|---|
| aggregate `environment` | 957.87s | **8.59s** |
| CPU time (user+sys) | 1168s | **791s (−32%)** |
| tests passing | 26,964 | 26,964 (identical) |

⚠️ **Those are QUIET-BOX figures, and the aggregates inflate under load like everything else.** A
green run on the merged tree on 2026-09-16 at `load 109.5/81.6 · 2 verify run(s)` reported aggregate
`environment` **116.77s** over 868 files — 13x the 8.59s above, and still an eighth of the 957.87s
the flip removed. So the table measures the FLIP, not a budget: a loaded run showing three figures
of environment time is not a regression against it. Compare a loaded run only against another loaded
run, and read the `context:` line of both.

⚠️ **No file count is quoted anywhere in this section on purpose.** The first draft said "108", and
three commits in the same change added ten more without updating it. The live answer is
`grep -rl '@vitest-environment jsdom'` over the include roots — a number that cannot go stale.

`tests/architecture` alone is **178 of 180 files DOM-free** — source-scanning guards that read files
off disk and never render. A file that needs a DOM now says so with `// @vitest-environment jsdom`.

⚠️ **`environmentMatchGlobs` is not the mechanism** — it was removed in vitest 4 (4.1.11 here). The
per-file docblock is what this version supports.

⚠️ **The list was derived by RUNNING the suite under node and taking the failures, not by grepping
for `document`.** A grep over these files is dominated by source-scanning guards that match the word
"document" inside a string they are searching for.

### ⚠️ Two files failed as UNHANDLED REJECTIONS, and a passing test count hid them

`@capacitor/app` touches `document` at import time, so under node
`tests/framework/bridgeJournalGate.test.ts` and `bridgeRequestRejection.test.ts` threw
`ReferenceError` *asynchronously*. Vitest printed `865 passed`, then `Errors 6 errors`, and **exited
non-zero** — the suite was red while every test line read green.

This was missed on the first pass because the check was `grep 'Test Files'` on a run whose exit code
was never read. **A passing test count is not a passing suite**: read the exit code, and read the
`Errors` line. This is the same class as the timeout above — a real failure wearing the costume of
something else.

### ⚠️ `void <async>` at a test seam: a failure that blames an unrelated file

The general form of the trap above, and worth knowing on its own because the symptom points
somewhere the bug is not. Found by `work-ai2` on 2026-09-16, diagnosed to a fix:

A test called `void shutdownRealmThenReload(...)`. The `void` let the whole registered-task chain run
asynchronously and **outlive the test file**. Vitest attributes late async work to *whatever file is
running when it settles* — so the failure surfaced in **a different game's suite entirely**, and was
unreproducible in isolation. Capturing and awaiting the promise fixed it.

- **The shape:** `void <async call>` (or any un-awaited promise) at a test seam.
- **The tell:** *fails only in the full run, passes alone, and blames an unrelated file.*
- ⚠️ **Per-file isolation does NOT contain it.** A fresh module registry per file still shares the
  process, so an escaped promise crosses files regardless. Do not reason "each file is isolated,
  therefore this cannot be cross-file".

Three clones hit `games/wordweave/tests/backgroundRotation.test.ts` three different ways on three
different trees the same afternoon — a timeout, a non-reproducing assertion, and this escaped
promise. When one test keeps absorbing unrelated failures, suspect the victim's own isolation, not
three coincidences. The wordweave case is #1288: that test is correct only if its stub wins a
module-hydration race, and per-file isolation is its only defence.

⚠️ **The canary set is THREE tests, not one.** `work-qa`'s reds were `backgroundRotation` (20846ms),
`releaseBuild` (34491ms) and `projectPresencePredicate` (22601ms) — in the same run — and `ai3`'s
non-timeout casualties were two of those three.

⚠️ **What they share is NOT a mechanism, and the first version of this paragraph said it was.** It
claimed all three "walk the repo corpus off disk". Checked against the files, that is one of three:
`projectPresencePredicate` calls `repoFiles()`; `backgroundRotation` steps **7,200 frames** over an
in-memory stubbed level corpus and reads nothing off disk; `releaseBuild` is pure decision functions
plus `spawnSync`. What the three actually share is being **long-running**, which
`engine/testWorkers.ts` already gives as the reason a test goes first under oversubscription. Do not
instrument the other two looking for a corpus.

The corpus-walk budget gap is real on its own evidence and is **#1290**: `grep -rl` over
`repoCorpus|repoFiles(` across `engine/tests games demos` finds **125 test files**, of which **2**
state a timeout — so 123 corpus walks are charged against a ceiling sized for a unit test.
⚠️ **That ratio is a property of a TREE, not of the repo** — counted on `b85b1ddbf`; `work-qa`
counted 122/1 on `55203d6f2` an hour earlier, and the difference is the #1285 commits in between.
It drifts upward every time somebody adds a corpus test, which is the argument rather than a
footnote to it, so quote the sha with the figure the way a timing is quoted with its `context:` line. Repo size and machine contention move
independently, so a ceiling tuned against one gets re-crossed by the other, and the repo accumulates
a number per test with no rationale between them. **#1046 is the closed precedent**: docCitations'
scan at 17s against a 20s budget, handed 60s on Windows. The unit-test default is the wrong
*instrument* for a corpus walk, not merely a too-small number — which is what decides the fix shape.

### What the environment flip does NOT risk, and how that was checked

The obvious worry is a test that still passes under node because its subject silently no-ops without
a DOM. Checked rather than assumed: 46 engine modules carry a `typeof window === 'undefined'`
fallback, and 43 node-environment test files import one. Of those, the guards actually reached are
DEV debug-console hooks (`window.__ecsWorld`, `__editorStore`, `__prefabEdit`) that no test asserts
on. The one genuinely behavioural guard — `readViewport()` in `engine/app/editor/agentEditorOps.ts`,
which returns `null` with no `window` — is asserted by no node-environment test.

**To regenerate the classification** after adding tests: run `npm test -- --environment node`, take
the `FAIL` files *and* any file named by an `Errors` block, and add the docblock to each.

⚠️ **A classification derived from "run it and take the failures" is only as complete as what that
run DISCOVERED — and this suite's file set is conditional.** `engine/vite.config.ts` excludes
`games/court/tests/**` unless `courtTouched()` says the branch touched Court, so the original sweep
never saw Court's 220 files and silently did not cover them. It surfaced two commits later, when
editing comments in `games/court/tests/*.ts` flipped that gate and pulled in 6 failures plus 2
unhandled-rejection files, every one DOM-dependent. **Before trusting a regenerated list, check that
the run actually discovered the files you think it did** — compare the `Test Files` count against
`1086` (866 without Court).

The residual gap is **narrower than "51 unclassified files"**, which an earlier draft of this
section claimed. Court's sweep-tier files are ordinary `*.test.ts` and ARE discovered in a normal
run — `MODOKI_COURT_SWEEPS` gates the `describe` BODIES, and vitest runs a describe callback to
collect its tasks (`engine/vite.config.ts` records this), so their imports and collection already
ran under node and would have thrown. What is genuinely unexercised is a DOM need inside a skipped
`it` body. The nightly sweep on `main` is where that would surface.

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
is where those suites run, on demand. Two kinds of leg:

| leg | what runs it |
|---|---|
| `ios/lease-parity` | `swift test` on the standalone `capacitor-game-debug/ios/Tests` package — no deps, no simulator, seconds |
| `android/lease-parity` | gradle on `capacitor-game-debug/android/test-harness` — plain JVM, no AGP, no Android SDK |
| `ios/ota-core`, `ios/iap-core` | `swift test` on the extracted core package (the SHIPPING core, replayed against golden vectors) |
| `android/ota-core`, `android/iap-core` | `javac` + `java` on the core's self-test `main()` — no gradle at all, only possible because both cores import nothing |
| `ios/class/*` (#981) | `xcodebuild` per plugin package — COMPILES the plugin class; shapes in `engine/scripts/nativePluginLegs.mjs` |
| `android/class/*` (#992) | gradle per plugin package on a synthesised project: `:capacitor-android` from the root `node_modules` + the package's `android/`, AGP at the version Capacitor's core pins, build output redirected into the temp dir — COMPILES the Java/Kotlin class against the real core, AndroidX and the vendor SDK |

⚠️ **The `*/class/*` legs cannot catch a `@PluginMethod` defect**, which is what #992 was filed
assuming they would. Capacitor indexes plugin methods by reflection at runtime, so a MISSING
annotation and one on a PRIVATE helper both compile. That class is caught under `npm run verify`,
for every plugin package, by `engine/tests/architecture/pluginMethodParity.test.ts`: the JS name
the TS interface declares against the Android annotations and the iOS `pluginMethods` array, the
three plugin names, and an `@objc func` behind every iOS entry. That last one is the iOS twin: the
bridge dispatches by `NSSelectorFromString` + `responds(to:)`, so a method without `@objc` compiles
too.

⚠️ **Once its prerequisites are present, an `android/class/*` leg SKIPs only on a NETWORK failure**
(offline, or a vendor SDK not yet in the Gradle cache), and FAILs on anything else. The
prerequisites are `android/build.gradle`, gradle, the Android SDK and `@capacitor/android`, and each
one missing is its own SKIP. The network test is ANCHORED. It needs a Gradle cause that STARTS
with the failure (`> Could not GET '…'`, `> Could not get resource '…'` for a download that stalls
mid-body, `> No cached version … offline mode`), the resolve step's
own `> MODOKI-UNRESOLVED` cause naming one, or the wrapper's `java.net` exception at column 0
(distribution not cached, offline). A looser match turned a real compile failure into a SKIP twice
in #992's close-out. The first was a compiler error quoting `UnknownHostException`; the second was
a javac-echoed source line that itself began with `>`, which Gradle 8.14 repeats in its summary.
That is `networkFailureCause` in `nativePluginLegs.mjs`, unit-tested in
`nativePluginLegCoverage.test.ts`. Treating a network failure as a FAIL would report
a machine without network as a broken plugin. The rule keys on network-specific output lines
(`Could not GET '…'`, `No cached version … offline mode`, `UnknownHostException`) and never on
`Could not resolve`. That word is Gradle's headline for EVERY resolution failure, and the first run
of these legs matched it: all eight reported SKIP, "offline", while the real cause was a broken
resolve step (an AGP artifact-variant ambiguity). A mistyped coordinate with the network up reads
`Could not find` and FAILs. With the network down it cannot be told apart, and `--require-all`
catches the resulting SKIP. The first
run on a machine downloads the AppLovin, AppsFlyer, Adjust and Play Billing SDKs.

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
it stays off the exit code even under `--require-all`. No row uses it today — the one that did
(`ios/class/capacitor-litert-lm`) left with its package in #1191; a row's reason prints in the
summary, and its premise belongs under `npm run verify` so it cannot quietly go stale. Detail:
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

⚠️ **The in-stage run is SCOPED to `architecture/`+`assets/`** (why: `scripts/publish-engine-oss.sh`
§ 4b), so it covers the class, not every test. One hub merge on 2026-09-11 carried both shapes:
a COUNT floor sized for a clone (`retractedClaims.test.ts` — inside the scope, caught here) and,
outside it, a guard asserting a GITIGNORED build output exists on disk
(`tests/electron/packagingManifest.test.ts` sampling `engine/electron/dist/main.cjs`), which only
`ci/main` saw — its fresh checkout has never built. So: a floor over a walk that reaches beyond
`engine/` must clear the snapshot's counts, in every layout it ships (this gate assembles the
two-demo one; a publish without `--with-demos` ships none), or pick per layout through a
`repoLayout` predicate; and a sample that only a build produces declares `absentOk`.

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
ubuntu + windows + macos-14** (the macOS leg was added 2026-09-09; observed job names are
`check (ubuntu-latest)`, `check (windows-latest)`, `check (macos-14)`, `package (macos-14)`,
`package (windows-latest)`, `e2e (editor, chromium)`), the **Playwright e2e suite**, and a
**DMG + Windows installer build**. The
legs that cost the most privately (Windows 2×, macOS 10×) are the ones this buys back. Nothing
waits for the result (polling would bill the wait); read it with
`gh run list --repo lsgmasa33/modoki-engine --branch ci/main`.

The packaged artifacts there are **NOT shippable** — unsigned, and the beforePack stagers
silently skip when `toktx`/`msdf-atlas-gen` are absent, which those jobs do not install. Debug
packaging with them; never distribute them.

Caveats that matter: it is a **subset** gate (no `games/`, so anything game-dependent still runs
only locally — **and that is bigger than it sounds: 20 test files skip outright there**, see
§ "The 20 files no runner checks on Windows" above), it tests the **transformed snapshot** rather
than this tree, it needs the repo secret `OSS_PUSH_TOKEN`, and **public run logs are world-readable
and permanent**. Never push the
private tree to a public branch to get a free run — deleting a branch unpublishes nothing. Full
mechanism: [engine-oss-publishing.md](./engine-oss-publishing.md) § "The public repo as a free CI
runner".

### The ubuntu leg is the ONLY Linux this repo can reach — and it finds a real class

⚠️ **Five of the six clones are Macs and the sixth is Windows, so nothing local runs Linux.** A
shell tool invoked with BSD-only syntax therefore passes `npm run verify` on every machine that
runs it and fails only on the public ubuntu leg — *after* the push, with `main` already red.

Measured 2026-09-10 (#1037 follow-up): `ps -Axo command=` shipped to `main` in two files. `x` is
a BSD-style option, and Linux `procps` parses a **dash-prefixed** bundle as UNIX-style, where `x`
is not an option at all:

```
error: must set personality to get -x option
```

So the call **threw** on ubuntu, `listProcesses()` correctly returned `null` rather than `[]`, and
three cases went red across `cleanPackagedCacheLinkGuard` and `livePackagedEditor`. The hub's
`verify` had been green minutes earlier, as had the worker's.

Two things worth carrying forward:

- **What is unportable is the MIX, not BSD syntax.** `ps axo command=` (no dash) is BSD-style and
  procps accepts it; `ps -Ao` / `ps -eo` are UNIX-style and portable. Only a dash-prefixed bundle
  containing `x` breaks. On macOS the `x` buys nothing anyway — it lifts the must-have-a-tty
  restriction `-A` has already lifted (measured: the `-Axo` and `-Ao` pid sets differ only by churn
  between the two calls, symmetrically, 3–6 pids).
- **The detector has to be static, because the dynamic one does not exist here.**
  `engine/tests/architecture/psFlagPortability.test.ts` scans the tooling corpus for the pattern.
  It matches `.code` via `readScannedSource`, never `raw` — both fixes explain themselves in
  comments that necessarily quote `-Axo`, so a raw-text scan would flag the fix as the defect — and
  it excludes itself, its fixtures being string literals that survive the strip.

⚠️ **The same shape is one flag over in `pgrep`**, and was already written down:
`repoReapSpellings.test.ts` records that BSD `pgrep` skips its own ancestor chain while `procps`
skips only its own pid. `cleanPackagedCacheLinkGuard`'s helper **cites that note** and still
reached for BSD `ps` on the next line. Knowing the class did not prevent the instance, which is the
argument for a guard rather than a doc paragraph.

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

⚠️ **A `@playwright/test` bump silently disarms the local run until the browsers are reinstalled.**
1.60.0 → 1.62.1 (#57) expected `chromium_headless_shell-1234` while the machine had `-1223`, and
**all 47 e2e specs failed** with `browserType.launch: Executable doesn't exist at …` — which reads
like the merge broke the editor, not like a missing binary. After any merge that moves
`@playwright/test`, run `npx playwright install chromium` before believing a red local run. The
Windows clone sets `PLAYWRIGHT_BROWSERS_PATH=E:\dev-cache\playwright`, so one install covers every
clone on that box. Open follow-up (proposed on #57, not done): chain `playwright install` into the
root `postinstall`, so "run `npm install` after a lockfile change" is actually sufficient.

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

### Scratch dirs — `makeScratchDir`, never a bare `mkdtemp` (#1117)

A test that needs a throwaway directory calls `makeScratchDir(prefix)` from
`@modoki/engine/testing/scratchDir` (`{ base }` and `{ canonical: true }` cover the other shapes).
The helper removes every dir it made **after the test file ends, pass or fail**. Removal is the
helper's job, not the test's. `engine/tests/architecture/scratchDirOwnership.test.ts` refuses the
names `mkdtemp`/`mkdtempSync` anywhere in the test corpus except the helper.

**Why it exists.** Removal used to be each test's job, and `os.tmpdir()` had no other cleaner. Measured on
2026-09-14: **131,158 `modoki-*` entries on the `modoki-qa` Mac, 59,249 of them more than 3 days
old**, and 8,551 on the win clone. The issue as filed said macOS reaps `/var/folders` itself. It does
not, at least not on anything like this timescale. The leaks came in three shapes:
- **no teardown at all:** a `beforeEach` that makes a dir per test and has no `afterEach`
  (`modoki-recents`: 27,100 dirs)
- **removal on the success path only:** an `rmSync` at the end of the test body, skipped whenever
  an assertion above it throws
- **removal of the wrong path:** the test keeps `path.join(mkdtempSync(…), 'race')` and removes that
  child, orphaning the dir it made

The biggest producer was not a test. It was production code a test drives: `claimsDir()` falls back
to `os.tmpdir()/modoki-claims-vitest-<pid>` under vitest (42,904 dirs), and the store cannot know
when a process is done with it. Three kinds of process make one:
- a vitest worker
- the vitest **main** process, because vitest builds a Vite server from `engine/vite.config.ts` and
  the editor backend plugin's `configureServer` sweeps claims
- every **child** a test spawns (the OTA and build CLIs inherit `VITEST`)

No per-file hook reaches the last two. A private-`TMPDIR` `verify` still left 96 of them after
the per-file fix, which is how they were found, by tracing every write under that name.
`engine/tests/globalSetup.ts` calls `reapVitestClaimsDirs` at teardown. It removes the main
process's own dir, plus every dead-pid dir touched since the run started. A LIVE pid is skipped,
because another clone's vitest may share `os.tmpdir()`, and older dirs are skipped as historical
debris.

The shell side had the same defect. `publish-engine-oss.sh` and `publish-demo.sh` now remove their
minted stage and push clone on `EXIT` (plus the engine script's manifest). `MODOKI_KEEP_STAGE=1` keeps the stage, and
`--out DIR` is never removed. `assert-app-renders.sh` removes its throwaway Chromium profile on
every exit. It removes its logs on a PASS, or when they are empty, and a failure prints the path
of what it keeps. The tests drive each script into a private `TMPDIR`. `publish-demo.sh` runs
from a throwaway git repo, because the script refuses a dirty demo dir, and a live editor dirties
one (#18).

How it works, and the traps it closes:
- **The wiring is asserted, not assumed.** Each vitest config's setup file calls
  `installScratchDirCleanup(afterAll)`. `makeScratchDir` throws until that has run in its own
  module instance. A config that forgets it, or a second copy of the module, therefore fails
  loudly. Otherwise it would silently make dirs nothing removes, which is the exact defect.
- **File scope, not test scope.** Dirs made at module scope or in `beforeAll` are shared across a
  file's tests. The setup file's `afterAll` registers first, so under vitest's `stack` hook order it
  runs after the file's own.
- ⚠️ **KNOWN GAP: that `afterAll` can be skipped.** Vitest 4 stops a file's `afterAll` chain at the
  first hook that throws. A file whose OWN `afterAll` throws or times out leaks its dirs, and so
  does a killed run. A `process.on('exit')` fallback was tried, and it is **unreachable**: the pool
  ends each worker with SIGTERM, which emits no `exit` unless a SIGTERM handler is installed
  (measured). `scratchDir.test.ts` pins the gap. What would close it: `globalSetup` mints a run-scoped
  parent dir, exports it to the workers, and removes it at teardown, with `makeScratchDir` defaulting
  its `base` to that dir. Not built. It changes every scratch path's parent, and the gap needs a test
  whose own teardown is already broken.
- **A dir that cannot be removed is a warning, not a failure.** On Windows a handle a child process
  has not released yet can outlast the retries. Failing an unrelated suite over temp cleanup would
  trade a leak for a flaky gate.
- **Immune to `vi.mock('fs')`.** The helper takes its builtins from `process.getBuiltinModule`,
  so a suite that mocks `fs` or `os` cannot disarm its own cleanup.
- **It does not import vitest.** `afterAll` is passed in, because `makeTestGlb` imports the helper
  and is also loaded by a Playwright spec. A Playwright spec cannot use `makeScratchDir`: nothing
  installs the cleanup there.
- **An explicit `rmSync` of a scratch dir is harmless.** The helper's removal is `force`.

**Not covered by the guard:** a computed key (`fs['mkdtemp' + 'Sync']`), a `mktemp -d` in a spawned
command, a plain write straight into `os.tmpdir()`, and **production code a test drives**, which
is the class the claims store belonged to. The first two are pinned as the guard's KNOWN GAPS.

**What a private-`TMPDIR` `verify` still leaves (2026-09-14): 23 entries.**
- 19 `modoki-render-<pid>-N.jpg`. Production owns these: `pruneOldTempFiles` removes them after
  30 minutes.
- `device-screenshot-<pid>.png` (or `.jpg`), one per process that captures.
- `modoki-menu-test` and `modoki-logs`. Both are fixed names, reused rather than accumulated.
- Node's own `node-compile-cache`.

To check a change, run `TMPDIR=<empty dir>/ npm run verify` and list what is left. A shared
`os.tmpdir()` cannot answer this, because other clones and live editors write there too.

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

### Every git read passes an explicit `maxBuffer` — and ENOBUFS is never "git said no"

Node caps a `child_process` read at **1 MiB** by default and throws `ENOBUFS` above it. Pass
`maxBuffer` on every `execFileSync`/`execSync`/`spawnSync` that reads git, and **derive the number
from a measurement, with the measurement in the comment** — a round number nobody can justify only
proves that a number is present. Enforced by
`engine/tests/architecture/gitReadIsBounded.test.ts`, whose `EXEMPT` ledger is the backlog: each
row names a file, the COUNT of unbounded reads it is allowed, and why each is bounded by something
other than the repo's size.

⚠️ **Size is the easy half. The half that bites is the `catch`.** Every one of these sites turns a
throw into a semantic answer, so an overflow arrives as a fact about the repo: before #1120,
`check-scene-churn.mjs` reported a long-committed scene as `NEW FILE (untracked)` and **skipped its
diff**, and `gen-release-notes.mjs` emitted **empty release notes at exit 0**. So ask
`isGitVerdict` (`engine/scripts/gitError.mjs`) before swallowing: a numeric `status` with NO `code`
means git ran and chose that exit code; anything else means no verdict was returned
at all. Measured — git saying no gives a bare `status:128`, a missing binary gives `ENOENT`, and an
overflow gives `code:'ENOBUFS'`. It asks for the absence of `code` rather than
`code === 'ENOBUFS'` on purpose: the class is "never ran", not the one member that prompted it.

⚠️ **A measured error shape can be ONE BRANCH OF A RACE (#1127).** The first `isGitVerdict` asked
about `status` alone, because 300/300 overflows measured `status:null, signal:'SIGTERM'`. But the
parent's overflow detection races the child's exit: a child that exits straight after its last write
is reaped first, and the error carries `code:'ENOBUFS'` **and** `status:0`. The probe was a `node -e`
child, whose slow teardown always loses; `/bin/sh -c printf` wins 1000/1000, and git wins whenever its
output exceeds `maxBuffer` by less than one pipe buffer. It surfaced as one red `verify:publish` run
that went green on re-run — a flake whose assertion mirrored the shipped predicate, so it was the
predicate failing. Agreeing samples cannot establish that a shape is deterministic; drive the other
branch on purpose, and assert the invariant rather than the premise.

⚠️ **Size the hazard by what the read GROWS with, not by commit count.** #1114 sized its own
instance at ~25,575 commits (the repo is at 8,822) — years away, and the wrong axis. The nearest
sites are fed by an authored asset: `games/court`'s `main.scene.json` went 148,417 B -> 369,684 B in
the month to 2026-09-12, **2.5x, and 35% of the default**, and it is the input to three separate
`git show` reads.

⚠️ **Never run git through a SHELL — `execFileSync` with an argv array, never `execSync` with a
command string.** Beyond the Windows quoting hazard `repoCorpus.mjs` already documents, a shell
**breaks `isGitVerdict`**: a shell that cannot find git exits **127** (9009 on `cmd.exe`), which is
a NUMERIC status, so the "did git actually answer?" test reads a missing git as a verdict and
swallows it. Measured — `execSync('git …')` with git off PATH gives `status:127`, while
`execFileSync('git', …)` gives `code:'ENOENT', status:null`. The scene/prefab churn gates shipped
this for one commit, which would have printed `NEW FILE (untracked)` for every committed file on a
machine without git.

⚠️ **A non-vacuity floor must clear the SNAPSHOT's file count, not this clone's.** A guard that
filters the corpus before asserting its floor can be green on every local run and red on the free
3-OS public CI. `gitReadIsBounded` sized a floor at 1,500 against 1,518 local files while the
snapshot leg has 1,145. `corpusProducerIsShared.test.ts`'s own note owns this rule — it is "a fact
to MEASURE rather than to reason to" — and #1014/#1015 are the scar. Related: the public CI clones
with `actions/checkout` and **no `fetch-depth`**, so history is depth-1 and any probe that assumes
a long history (`git rev-list HEAD` being large, a previous tag existing) does not hold there.

⚠️ **A file-level exemption is fail-open, and this guard shipped that way for one commit.**
Exempting `repoCorpus.mjs` for its one `rev-parse` also pardoned its two `ls-files` reads, so
deleting `maxBuffer` from the corpus producer left the guard GREEN — a guard for fail-open guards,
failing open, found only because the mutation check was run. Hence the count. That instance turned out
to be one of **16** (#1123) — the general rule is "Exemption GRAIN" below.

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
| **Fix the GRAIN** | the list is complete, but a ROW pardons more than its reason argues for | `assertExemptionLedger` (#1123) — see below |

`engine/tests/helpers/declaredList.ts` is the shared helper for the third: *enumerate the population
by its marker, assert the hand-list equals it*, with a reasoned exemption ledger whose every row
must CURRENTLY be flagged. `testFilesAreCollected.test.ts` is the older, hand-written instance of
the same idea and is worth reading as the reference.

### Exemption GRAIN — a row must pardon the OCCURRENCE, not the file it lives in

The table above is about the LIST versus the POPULATION. This is the question one level in, and it is
a different defect: **once a row exists, how many things does it pardon?**

**The rule: key a row at the same grain the rule is evaluated at.** A guard that bans a per-OCCURRENCE
pattern — a line, a call, a literal — and keys its pardon by the FILE has granted a pardon whose scope
is not the occurrence its `reason` argues for; it is every occurrence that file will ever contain. The
guard is then blind exactly where somebody already had a reason to look, and no green run can show it.

Measured 2026-09-12 (#1123): **16 guards, 9 of them already holding an exempt file with more
occurrences than its reason covers.** `determinismGuard` — the guard `CLAUDE.md` § Time cites as what
keeps game state deterministic — had three file-keyed allowlists and **no staleness re-check at all**.
`importSettingSelectsSpliced` was worse than file-keyed: its rows were bare expression text with no
file, so one `'options'` row pardoned two different components and would have pardoned the next
`options`-named select anywhere in the tree.

**`assertExemptionLedger` (`@modoki/engine/testing/exemptionLedger`) is the shared helper.** It is in
the PACKAGE rather than beside `declaredList.ts`, because the guards that need it span
`engine/tests/**`, the package's own `tests/**` and a project's own `tests/**` — and a game copied out
of the monorepo, or a demo published by snapshot, cannot reach `engine/tests/…` at all. What it
enforces:

- **Rows are SPENT, not matched.** `population` is one entry per occurrence; each `exempt` row spends
  `count` (default 1) of them, and the next occurrence is an offender. Matching with `.some()` instead
  is the trap `qaCaseReferences`' otherwise-correct `{file, token}` and `{file, near}` rows carried until #1128 — a second
  copy of an exempt line-citation example, or a bare toolbar id beside an exempt one, was green.
- **A row that blesses more than exists is an error too** (`"blesses N, found M"`), so a fix must
  deduct from its row in the same commit. The `>= 1 occurrence survives` form — which
  `corpusProducerIsShared` carried until #1128 — cannot see this: `>= 1` stays true however many extra
  occurrences appear.
- **Measure per ITEM against the SUMMED budget.** Two rows for one item that jointly over-bless are
  the same fail-open one level down; the helper shipped that way for one commit and review caught it.
- **`count` must be positive and `floor` at least 1.** `count: 0` writes a pardon that can never be
  stale; `floor: 0` gives back the vacuity the field is required for.
- **When the population is ONLY offenders, bound the SCAN with `scanned`.** A ledger over "ids with
  fewer than three segments" or "mutating reads" exists to shrink to nothing, and a floor on its
  population refuses exactly that end state — Phase 3 shipped six such ledgers, and the reviewer's fix
  (rename both legacy ids, delete both rows) went red as "the detector has stopped matching". Pass the
  size of the set the detector walked (every static id, every contract) as `scanned`, and `floor`
  bounds that instead. It must be a count of the walk, never a constant.
- **`sanctioned` is for STRUCTURAL exclusions only** — the one legitimate implementer, or a guard that
  must quote its own subject to explain itself. Reason-free, because nobody should re-review it, but
  still staleness-checked. Keeping those out of the reviewed list is what stops 164 self-citations
  diluting the three rows a reader is meant to read (`docCitations`), and `clientJsonWriteSeam` made
  this split by hand first.

⚠️ **Compose `item` as `file::token` wherever the detector can tell two occurrences apart — a bare
count still fails open WITHIN a file.** Measured in #1120: with `count: 1`, binding the `rev-parse`
while unbinding one `ls-files` keeps the count at 1 and stays green. Naming the occurrence closes both
directions.

⚠️ **One ledger per BAN, never one ledger for two rules.** Three of the 16 served two independent bans
from one row, so a reason written about one excused the other — `commentStripperIsShared`'s staleness
check was `blockStripper || lineStripper`, so dropping one while keeping the other stayed green;
`inputSourceGuard`'s one `Set<file>` let a keyboard-toggle reason pardon a raw POINTER listener; and
`docCitations`' single list was read at three call sites where it pardoned nothing in two of them.

⚠️ **The falsifying mutation is ADDING a second occurrence to an already-exempt file, not deleting the
only one.** Deletion exercises the staleness arm; only addition exercises the grain.

⚠️ **And there is a THIRD direction the first two miss: LOOSENING THE CLASSIFIER.** A guard that
decides "offender or not" inside a window, a lookahead or a threshold can be disarmed by widening that
constant alone — every offender reads as compliant, and a non-vacuity floor phrased as `>=` cannot see
it, because the counts only go UP. Measured on `editorAssetJsonGuard`: a real offender reddens at
`LOOKAHEAD = 400` and PASSES at 4000. Pin such a constant with synthetic fixtures that bracket it from
outside — and ⚠️ **write the distances as literals, not as `THRESHOLD ± n`**, or the fixture scales
with the constant and cannot fail (that is [falsifiable-tests.md](falsifiable-tests.md)'s Shape (E),
and it happened in the very commit that added these fixtures). Keep the thing being CLASSIFIED inside
the window and move only the classifier: a fixture that drops both out of view passes for the wrong
reason. A migration
mutation-checked by deletion alone ships this defect again under a green gate, which is how it got
here. And **count on the source the DETECTOR sees**: every guard in this family strips comments first,
and #1123 was filed with `grep` figures that were inflated by docblock mentions in 7 of its 16 rows —
its title said an exempt file held 8 wall-clock reads where the detector sees 2.

⚠️ **And the classifier's window must be the OCCURRENCE ITSELF — a CODE occurrence is classified
inside its own AST node, never by distance (#1144).** A window chosen by character count
(`src.slice(at, at + 400)`, `[\s\S]{0,300}`, ±90 around a match, "bounded by the next occurrence")
is not the occurrence's extent even when nobody widens it, so it fails both ways. **Too wide:** a
NEIGHBOUR's token vouches — `adbTargeting` read an un-targeted adb call as targeted because the next
call's `adbArgs(` was within 400 chars (#1140); `rawSourceReads` excused a raw read because the next
line's `JSON.parse(` was; `crFragileLineParses` excused a match because the next loop's `line.trim()`
was, and it was green that way on a real file (`gen-memory-index.mjs`, whose nearby `trim()` result is
discarded). **Too narrow:** a formatter-wrapped occurrence escapes — `rawSourceReads`' text pattern
required `'utf8'` then `)`, so 21 reads in 11 files written with a trailing comma were never checked.
The shared helper is `@modoki/engine/testing/sourceAst` (`parseSource` throws on a stump parse;
`callsTo`, `boundIdentifier`, `readsOf`/`declarationOf` resolve by SYMBOL, `enclosingFunction`).
⚠️ **Parse — do not write a tokenizer:** #1140's hand-balanced paren scan and the regex-vs-division
heuristic after it were each broken by review. And the node is only half of it — **its adjuncts must
be the occurrence's too**, which is where #1144's own first cut still failed open, four ways:
- a ledger row keyed per loop, because the detector returned the FIRST match per body;
- "some call has a refusal" instead of every call;
- a refusal found inside a nested function nobody calls;
- a raw read excused because ONE of its variable's uses was wrapped — `manifestBlockPlumbing` stripped
  once and matched the raw text three times beside it.

Comments and Markdown prose have no AST; collapsing whitespace in a matched span stays the right tool
there.

**#1179 moves the ~40 guards that still judged a code occurrence one LINE at a time onto the same
helper, in phases.** A line is a window too: too narrow for a wrapped call, too wide for two
occurrences sharing it. Progress: **P0 + P1 landed (9 guards)** — `determinismGuard`,
`buildChildGroupKill`, `playableSkipsProbe`, `consoleRingRetainCallSiteGate`, `audioBusVocabulary`,
`keymapOwnership`, `materialCloneStamp`, `userDataDir` and `tempPathScoping`'s `devServer.ts` check.
The helper gained `accessPath`/`referencesToPath`/`callsToPath` (a dotted name however it is
formatted — `performance\n  .now()`, `(mesh.material as Material).clone()`), `statementOf`/`flatText`
(a ledger KEY that survives a re-wrap) and `enclosingNamedFunction`. What the phase turned up,
because these recur:

- **Counting READS, not calls, finds what a `tok\s*\(` pattern never could.** `determinismGuard`'s
  whole delta over 567 runtime files was two rows: `sceneMutate.ts`' `mint = newGuid` default (an
  unseeded minter handed on uncalled, unledgered until now) and `assetRefRules.ts`' `function
  newGuid()` — a DECLARATION the regex had been matching, and a sanctioned row had been pardoning.
- **A migration's text anchors fail open on the absent case.** `userDataDir` asserted
  `expect(src.indexOf("app.setPath('userData'")).toBeLessThan(src.indexOf('initFileLog();'))`: a
  wrapped `setPath(` is `-1`, and `-1` is less than everything. Anchor on a found node, and use NaN
  for "absent" — no comparison passes it. The shape is filed as its own class (#1181).
- **Source position is run order only at module scope.** Every ordering check compares positions,
  so the anchor call must be pinned to module scope too; a `setPath` moved into an arrow kept its
  position and ran later, green, until that was asserted.
- **A statement's text is not a key without its scope — and the scope must stay SHORT.** Keyed on
  `flatText(statementOf(call))` alone, `return profileBaseDir ?? app.getPath('userData');` pardoned
  that body in ANY function — the migration's own regression, caught by review. The first repair keyed
  on the host call's full text, which gave a `.catch` off the 800-line startup body an 18 KB key and let
  `memo(() => …)` carry a pardon between functions — caught by the re-review. What holds:
  `<named function | <module>>` `>` `<host's short callee>(<first string arg | …>)` `::<statement>`.
- **"Contains the call" is not "is the gate".** `userDataDir`'s `shouldOverrideUserData` check was a
  whole-file regex the `if` would still satisfy after the `setPath` moved out of it; its first AST
  replacement asked whether the condition CONTAINED the call, which `if (!shouldOverride…(…))` and
  `… || true` both do. The unwrapped condition must BE the call, and the occurrence must be in its
  then-branch.
- **Moving a guard onto the parse surfaces its OTHER text checks.** `audioBusVocabulary` carried a
  hand paren-balancing scanner and proved its one exception with a whole-file regex any function's
  `hasDocKey` satisfied (and never read which TABLE was checked); `buildChildGroupKill` compared
  FILE-wide counts, so one route killing twice paid for another that never kills. Each is now per node.
- **`referencesToPath` deliberately does not follow an alias** (`const p = performance; p.now()`), a
  destructure from anything but a named chain, or a nested pattern — that is dataflow (`readsOf`), and
  the per-line forms missed them too. Its docblock says so rather than implying coverage.

**P2 landed (8 more guards, 17 in all)** — `pathIdentityIsShared` (five scans), `uiLengthFallback`,
`traitPersistencePredicateGuard`, `projectPresencePredicate`, `formatVersionFromConstant`,
`trackedConfigPaths`, `codeAssetRefs` and `relayRefusalStatus`. Most of these guard a clean tree
(populations 0 before and after), so their fixture tables are what carry them. What recurred:

- **"The operand IS the call" is too strict once a regex's `[^;]*` is gone.** The first parse of
  `pathIdentityIsShared` asked whether a compared value WAS `path.resolve(…)`, and so dropped every
  re-spelt form the regex had flagged: `.toLowerCase()` (which is `pathCaseKey` written inline),
  `.replace(/\\/g, '/')`, `path.normalize(…)`. The rule that holds is to peel RE-SPELLINGS
  (`comparedValue`) but not DERIVING calls (`path.relative`/`dirname`/`basename`, which ask a
  different question). Caught by review, not by the author's population measure — which was 0/0 and
  so could not tell a narrowed detector from a clean tree.
- **Narrowings hide in "the regex caught it by accident".** A unit fallback quoted inside a string, a
  GUID quoted inside a JSON string, a renamed import (`DEFAULT_FONT_GUID as F`): each was caught only
  because the regex read raw text, and each silently dropped out of the first parse. Before landing a
  migration, list what the OLD text form matched that the new node form cannot see, and either keep
  it (a text channel over string content, a `readsOf` follow) or pin it as an accepted gap.
- **An exemption or pardon found by text is a neighbour's.** "`import.meta.url` anywhere on the line"
  (`pathIdentityIsShared`), "any 504 on the classifier's line" (`relayRefusalStatus`), "every literal
  on the marker's line" (`formatVersionFromConstant`), "a docblock quoting `version: FOO`" as the
  from-a-constant anchor — each is now the occurrence's own.
- **A guard can match its own prose.** `projectPresencePredicate`'s `what:` labels spelt the forbidden
  shapes, so the file SANCTIONED itself; in the parse a string is not a call, the row went stale, and
  it is gone.
- **Two costs the gate surfaced that the suites did not:** a parse over a whole corpus (~3,000 files)
  must prefilter on a token the occurrence cannot exist without, or it overruns a 20 s budget under
  `verify`'s load; and reading `readScannedSource(…).raw` must be DECLARED (`comments: 'include'` +
  reason), which `commentStripperIsShared` enforces.

**P3 landed (11 more guards, 28 in all)** — the ones whose GATE or pre-flight was found beside the
occurrence rather than from it: `deviceConsoleCaptureInstallOrder` (+ `earlyConsoleShim`'s gate
pin), `render3dBoundary`, `deleteBoundary`, `projectNeedsInstall`, the JS halves of `reapScoping`
and `killPackagedGuard`, `packStagedTree`, `assetJsonGuard`, `importSettingSelectsSpliced`,
`settingsDisabledIfTotal` and `editorStoreActionsReachable`. They share four `sourceAst` walks:
`guardsOf` (the conditions a node runs under — its `if`/`? :` branch, the right side of `&&`/`||`,
and an earlier `if (T) <exit>` in an enclosing list), `guardProves` (does a guard prove an atom true,
through `!`, `&&`, `||`), `precedingStatements` (what has run on every path before it) and
`printedText` (a formatter-proof spelling for comparing two expressions). What recurred:

- **"The nearest `if (` / `function` line above" is the window again, pointed backwards.** It
  vouched for a marker that sat AFTER the gate's closing brace, for an import below a PREVIOUS
  accessor's gate, and — in `assetJsonGuard` — gave an arrow bound after `tryFetchEmbeddedManifest`
  that function's exemption. Ask the node what encloses it; do not scan for what came before it.
- **A gate is a claim about control flow, so its polarity is part of it.** The text forms matched the
  flag's NAME: `if (__MODOKI_MODULE_RENDER3D__) return; import(…)` and `if (!existsSync(nm)) {
  install(); continue }` both read as the thing they are the opposite of.
- **What a dominating gate means depends on who can call the code.** A gate dominating where a
  closure is CREATED dominates the closure (the build DCEs it). A hoisted function DECLARATION can be
  called from above an early exit in its own statement list, so those exits are not its guards — but
  the branches enclosing that list still are. Review found the hoisted case after the docblock had
  waved it away as "no caller asks"; the first fix stopped the climb at the declaration, and re-review
  found that dropped a real enclosing `if` and let a nested gate pass as the only one.
- **The accidental catches this time were one hop away from the occurrence.** A presence test moved
  into a helper (`return existsSync(…node_modules)`) that the line form caught at its caller, a
  `basename` inside an arrow whose BINDING is named `pattern`, a shell `$(basename …)` inside a JS
  string, an `<option>` produced by something that is not a `.map()` callback (the text form reported
  it `<unparsed>` and failed; the first parse made it vanish), `res.json?.()` rejected by a prefilter
  stricter than the node, and `interface EditorState extends Slice` — which the text reader FAILED on,
  and the first parse silently read as a smaller population. When a node reader cannot see members,
  make it refuse the shape rather than shrink.

**P4 landed (7 more guards, 35 in all)** — the router and import guards: `getOkFalseGuard`,
`routeVocabularyForwarding`, `assetJsonBytesAgree`, `buildLeaseSourceWireShape`, `hmrStaleness`'s
layering pin, the shared `importClosure` walker (under `mtsdf2DBoundary`, `render3dBoundary` and
`importClosurePaths`), and the TS half of `buildWebCallSites` — plus the two paren scanners P3 left
(`earlyConsoleShim`'s plugin-call args, `assetJsonGuard`'s `fetch(assetUrl(…))`). One new `sourceAst`
walk, `importsIn`: every static import, re-export and literal `import()` with its bindings by exported
and local name. What recurred:

- **A hand-written paren or brace counter is a line reader with a longer reach.** Four guards had one
  (`okFalseResponses`, `extractPluginCallArgs`, `assetUrlFetches`, and the statement joiner under the
  import walker). Each read string contents as syntax — a `(` in a message ended a call early — and
  each then regexed the text it had cut out, so `error:` inside a nested object counted as the body's
  cause and `ASSET_FETCH_INIT` inside `assetUrl(…)`'s own arguments counted as the fetch's init. The
  argument, the key, the element is a node; ask for it.
- **A block that runs "from this line to the next marker" is a window with a moving edge.** The router
  guard filed a response under whichever `urlPath === '…'` LINE came before it, and read GET-ness off
  that one line — so a wrapped `&& method === 'GET'` put a GET route under the POST rule, where its bare
  200 was never checked. The route and the method are the response's own held guards.
- **A file-wide name lookup is a neighbour that vouches from further away.** `assetJsonBytesAgree`
  accepted `writeJsonAtomic(abs, bytes)` because SOME `const bytes = assetJsonBytes(` existed in the
  2,600-line router; `buildWebCallSites` accepted an args array because a `'--target', 'web'` sat
  within six lines. Resolve the identifier by scope; read the array the literal is an element of.
- **The migration found real misses, not just re-spellings.** The import walker had never followed an
  `export … from` edge, and capped a statement at 12 lines — `DeviceConnectSection.tsx`'s import is 13.
  The 2D closure it guards went from 202 files to 471 (still clean), and it stopped inventing edges from
  `import('./x').T` type positions and from `import()` in comments. And its `skipEdges`, meant for
  flag-gated `import()`s, skipped a STATIC import at the same address too — while the caller's "is it
  gated?" check read only the `import()` and passed. A skip is now dynamic-only.
- **When a classification decides whether a rule applies at all, require PROOF to take something out
  of it — and make the rule you cannot afford to skip unconditional.** `getOkFalseGuard` owes a status
  from any `ok:false` a GET can reach. Four review rounds on one detector: reading `=== 'GET'` dropped
  `['GET', 'HEAD'].includes(method)`; "an un-negated `'GET'` literal" moved `(req.method || 'GET') ===
  'POST'` under the GET rule and off the cause rule; "guards that mention `method`" dropped an aliased
  `m === 'GET'` and a second `/api/` literal; and the first proof-of-exclusion was itself too generous —
  any `q.method === 'POST'` nested in a GET route counted, and a one-hop "every caller excludes GET" found
  callers by NAME in one file, so `hiddenWindowRefusal`, exported and also called from `main.ts`, was
  excluded by its single in-file caller (the reviewer turned that into a false pass on the real tree).
  It landed small: the GET rule applies unless the ROUTE'S OWN test (`urlPath === … && method ===
  'POST'`) proves a GET cannot reach it; a route whose method is checked anywhere else is a ledger row
  with the reason, not an inference. And every GET response already named its cause (6 of 6), so the
  cause rule now applies to all of them. Measure what an unconditional rule costs before assuming it is
  too strict, and prefer a visible ledger row to an inference that has to be right about every caller.
  Its sibling class — ~20 guards outside #1179's census that read import SYNTAX with a regex — is #1193.

**P5 landed (3 more guards, 38 in all)** — Court's `cellMapDiscipline`, `pieceSprites` (both source
rules) and `sweepGate`'s describe-scope scan. One new `sourceAst` helper, `siteText`: a site's
statement, narrowed to the object-literal member or the compound statement's head it sits in, so a
ledger key names `cellCenters` in a 700-line `__testing` export instead of the whole export. What recurred:

- **A layout convention is a line reader's hidden premise, and the file stops following it before
  the guard notices.** `sweepGate` took "two spaces of indent" to mean describe-body scope. That holds
  for a describe at column 0 — and 18 of the 38 gated describes are registered from inside an exported
  function (`hintNotesSweep.ts` and its siblings), so their bodies sit at four spaces and were never
  scanned, while the registering function's own statements, which are not describe scope at all, were.
  `cellMapDiscipline` credited a read to "the last `function` line above it", which had already been
  wrong once (`export function` was invisible) and still filed the module-scope declaration under
  `readConfig` and the `__testing` export under `resetCourtIapBoot`. Ask the tree which describe body,
  which function.
- **Find a binding by SYMBOL, and count a read that is not a call.** `/PIECE_ICON\(/` per line saw one
  reader; a `const f = PIECE_ICON` handed on — the way a second reader hides — was none, and neither
  was `auditLevel` passed to `CORPUS.map`. `readsOf` sees both, skips a shadowing parameter, and does not
  count the declaration as a read (which is why the cell-map population went 9 → 8).
- **A NAME-keyed pardon is only as narrow as the name's scope.** `INPUT_PATHS` pardons `hitTest`; by
  name alone that also reached a `hitTest: () => …` method on the export or a helper called `hitTest`
  nested inside a draw path. The pardon now applies only to a function declared at module scope.
- **"When does this run" is a property of the call a function is handed to, not of how its
  initializer starts.** The old scan read "deferred" off `= () =>`, so a lazy memo it approved was
  never checked where it was CALLED — and a memo called at describe scope pays for the corpus as early
  as the `const` it replaced. The walk judges a callback by its call (`it`/hook: later; `describe`:
  now; an unknown call such as `.map`: not proven to wait, so now) and a named function at every place
  it is called or handed on.
- **Some surviving mutants were the better rule.** Widening `cfg.pieceIcon*` to a field of that NAME on
  any holder, and `=` to every assignment operator, killed nothing on the tree and closed shapes the
  narrower code let through. So the mutant became the code, rather than a fixture being written to
  defend the narrower version.
- **Re-specifying a rule is the moment to re-derive what it covers — not only how it reads.** The review
  found the texture rule still listed `pieceIcon*`/`civilianIcon` by name, while every piece surface has
  drawn the COIN since 2026-08-12: `sprite: PIECE_COIN(piece)` in a hint ghost passed, and
  `PIECE_COIN_SPRITE`'s own comment cited this test as its guard. The set is now DERIVED — every
  `CourtConfig` field the Inspector offers as an image — and a field leaves it only on proof from the
  data: the four login-bonus icons are authored as derived sprite guids (no image's texture id), and
  that exclusion is pinned. The first fix still NAMED the functions that return a texture
  (`PIECE_ICON`, `PIECE_COIN`, `COIN_SETS`) and the re-review found two it missed, `TRAY_MASTER_TEX` and
  `tileStarsTexture`; a call now counts as a texture when the local function it reaches can RETURN one.
  The same mistake at two layers in one fix: a list is a guess about the population. It also found `sweepGate` knew a gate only as `describe.skipIf(c)(…)`; a
  gate is any `skipIf`/`runIf`/`skip` link of the chain (`describe.skipIf(c).each(rows)(…)`), and a
  conditional base is judged per arm with the chain's links attached (`(S ? describe : describe.skip).each(…)`).
  A third round moved the texture rule through destructures, record members and function aliases, and
  listed what it still does not follow (parameters, pass-through helpers, class methods) on the detector.
  Its sibling class — test guards outside #1179's census that delimit a code unit by a hand-counted
  bracket depth, a column-0 line or a fixed indent — is #1195.

**P6 landed (2 census guards, 40 in all, plus one sibling)** — wordweave's `refusalJournal` (#980) and
`adBannerReserve`'s playable-gate ledger (#1108/#1139), and `levelMoveTransitionGuard` (#1090), which was
not in the census but read the same handler bodies the same way. One `sourceAst` change: `guardProves`
takes `value: false`, the atom proven FALSE — "not proven true" is not that. What recurred:

- **A regex over a function body's TEXT is a window, however exactly the body was parsed.** #1144 gave
  each handler its own body from the parser, and the guards then ran `/const (\w+) = liveBuilt\(/` and
  `/if \(refusedDuringTransition\(…\)\) return;/` over that text — so the bind-and-check inside a nested
  `setTimeout` callback vouched for a handler whose own statements ran unguarded, and an honoured
  refusal in a callback vouched for an `advanceFromResult` the handler ran straight into mid-fade. Both
  passed on the real file. The parse bounded the span; the classification still has to be a node: the
  bind is the handler's first statement, and each later statement (each mover CALL, for #1090) runs
  under a guard imposed inside that handler.
- **A guard's population is every READ of the thing, not the syntaxes it was seen in.** The playable
  ledger collected `if (PLAYABLE_ASSETS` and `PLAYABLE_ASSETS ?` per line and stepped over every
  `const` line to skip the path constants. `if (!PLAYABLE_ASSETS)`, `const reserve = PLAYABLE_ASSETS ?
  0 : r` inside a function, and `__MODOKI_PLAYABLE__` in `screen.ts` all passed on the real tree — the
  third time this ledger turned out to be a deny list (#1108 round 2, #1139, now). Every read of the
  alias by symbol, and the define in any game file, is one entry.
- **An exclusion owned by ANOTHER guard is sound only while both read the same shape — so share the
  shape.** The path constants leave the ledger because `playableCorpus.test.ts` checks them against
  `asset-keep.json`; the exclusion now matches that test's own declaration regex, one copy in
  `playablePathDeclaration.ts`, against the RAW statement. A copy of it could narrow in one file and
  leave a `const MODE: string = PLAYABLE_ASSETS ? 'ad' : 'app'` checked by neither.
- **Replace a one-spelling ban with the property it stood for.** "No verbatim `!built || built.world !==
  world`" became "no handler reads module `built`" — which is what CLAUDE.md's rule says, catches the
  copy however it is wrapped or reordered, and also catches a read AFTER the guard. It is narrower in
  one direction on purpose: the text ban was file-wide, and `syncBuild`'s rebuild test IS that
  expression, legitimately — it passed only because it is wrapped over five lines.
- **A ledger KEY that is not unique per occurrence turns a counted pardon back into a name.** Keying by
  `file::function::site` read better than `function::nth`, and two `if (PLAYABLE_ASSETS)` in one
  function share it — so a `sanctioned` NAME pardoned the second; the `nth` key it replaced had caught
  that. Site keys go with counted `exempt` rows. (The same review: an exclusion correct for the file
  its owning guard reads was applied to every file once the population grew beyond it.)
- **When the property is "nothing can happen in between", refuse the shapes that can suspend rather
  than enumerate the suspensions.** A same-function refusal rule was widened to "no `await` between
  refusal and move", and the next review found five more gaps (an await in the guard's test, in the
  move's arguments, after the move in a loop, `for await`, `await using`). A move in an `async`
  function or a generator is now unverifiable, and unverifiable is an offender — no real one exists.

**P7 landed (the shell guards — the census closes)** — `killPackagedGuard`, `packagedLaunchIsolation`,
`exemptionLedgerIsShared`'s publisher check, `tempPathScoping`, `reapScoping`'s shell half and
`winProcessPredicates`' `.sh` half. Shell has no parser here, so the unit is the COMMAND:
`shellLogicalLines` in the scanner — comment-blanked source joined only at a backslash-newline. What
recurred:

- **The grain for shell is the command, and a command ends at a separator, not at a newline.** A
  logical line fixes the wrap; it does not fix the neighbour — `node "$PATHS" kill || true; : 2>/dev/null`
  is one line and two commands, and the old per-line check accepted the second command's redirect for
  the first. The kill reader cuts at `||`, `&&`, `;`, `|` and a background `&`, and the `mktemp` excuse
  applies only to a template that is `mktemp`'s own argument (any line MENTIONING `mktemp` used to excuse
  every `/tmp` path on it). Joining stops at a backslash on purpose: joining across `&&` or an open quote would
  manufacture exactly the neighbour this removes.
- **A syntax a detector does not recognise is an exclusion nobody wrote down — including the syntax the
  NEW detector does not list.** `packagedLaunchIsolation` knew a launch as `"$BIN" … &`, so
  `test-packaged.sh`'s foreground `exec "$BIN"` was never a launch, and the file-wide `--user-data-dir`
  contains let one isolated launch vouch for a second. The first rewrite listed launch shapes instead
  (`exec`, `VAR=` prefixes) and the review found `nohup "$BIN" &`, `env X=1 "$BIN" &` and `then "$BIN"
  &` had silently stopped being launches — each caught by the regex it replaced. Now every command
  mentioning the binary is a launch unless PROVEN not to be (a test, `echo`, pure assignments), the
  unisolated ones go through a counted ledger keyed by command, and the guard's premise was corrected
  for #1036 (packaged profiles are per install).
- **Filter a ledger row by LAYOUT, never by "its file is present".** `subprocessLineEndings` dropped a
  `CR_SAFE_UPSTREAM` row whenever its file was not scanned — right for the OSS snapshot, which ships no
  top-level `scripts/`, and wrong for a full checkout where the file was deleted: the stale pardon
  vanished instead of failing. Same shape as `exemptionLedgerIsShared`'s `absentByLayout`.
- **No parser is a recorded decision, not a silent one.** PowerShell (`winProcessPredicates`' `.ps1`:
  backtick continuation, `<# #>` blocks) and Java (`iapParkedCallRelease`) stay line-grained, each with
  the reason on the reader — the Java one fails loud on a reflow because its counts are exact.
- **The command, on every platform.** The review found the logical-line join silently did nothing on a
  `core.autocrlf` checkout — each continuation ends backslash-CR — so every P7 guard fell back to
  physical lines on Windows only. A background `&` ends a command too; and "inside `$( … )`" is found
  from the start of the line (`insideShellSubstitution`), because cutting at a separator first threw
  away the `$(` of `$(cd "$REPO" && node … kill)` — a capture opened on an earlier physical line is a
  stated limit.
- **Merging two rewrites of one guard is a review of both sides' ASSERTIONS, not of the conflict hunks.**
  #1187 rewrote the same wordweave guards on `main` while this ran, making every refusal RETURNED. Taking
  this side's parser detectors and teaching them the new idiom looked complete and kept every test green —
  and silently dropped `main`'s `GUARD_RETURNS` requirement that a self-guarding mover return its refusal,
  so a void mover whose guard dropped it passed all 13,693 wordweave tests. The final review found it by
  running `main`'s version of the guard against the mutated tree. The same merge showed the payoff the
  other way: the parser ledger immediately found two playable gates (#926, #1184) `main`'s line scan had
  never counted.

**#1193 — the import-SYNTAX readers (~40 sites, outside #1179's census).** Each guard had
its own regex for which spellings of an import exist, and each one missed a different subset: a
side-effect `import '…'`, `import x = require()`, `export … from`, a statement that does not start its
line, a clause longer than the regex's window, double quotes, or an import in a string it mistook
for a real one. They all read `importsIn` now. The helper gained two things. `importBindings(sf, spec)`
is the one reader for "F imports N from M": one row per binding, however the import is wrapped or aliased.
`importsIn`'s `typePositions` option returns the import types the compiler resolves (`import('x').T`)
without counting them as runtime edges. What recurred:

- **Measure the population old against new BEFORE switching, per reader.** Six readers came out
  identical: the vite config, publish exclusions, Court's sweep scope, account literals, repoLayout
  importers and the F11 closure (453 files). The runtime graph kept its 2,016 edges. The measurement found
  every real miss. `barrelImportOrder` entered 240 modules and the barrel names 250. Ten modules, `./traits`
  and `./iap` among them, had never been imported first, because their export clauses ran past a
  `[\s\S]{0,400}?` window. `worldSwapTeardownFalsifiable` never saw 24 side-effect imports of a producer.
  It also counted 145 `typeof import('…')` and fixture-string "imports". Its verdicts were identical
  anyway, which the probe had to show, since the specifier lists could not. A partial mock does run its
  producer, though: `vi.mock('../producer', (importOriginal) => … importOriginal() …)`. The text form
  credited it only by accident, through `importOriginal`'s `typeof import('…')` type argument. Review
  caught the first parse dropping it. It is now read from what LOADS: the mock target whose factory
  calls its loader, and `vi.importActual`'s argument. The type argument does not count.
- **Under `verbatimModuleSyntax`, `import { type A } from './x'` is NOT erased.** It emits
  `import {} from './x'`, which still runs `./x`. Only `import type` / `export type` statements are
  erased. `moduleGraph` counted the inline form as type-only. Two runtime edges moved to value, and no
  cycle changed.
- **"Which modules does this file run" and "which modules must resolve" are different questions.** A
  type-position import runs nothing, so walkers and attribution skip it. It still fails a standalone typecheck, so `gamePortability`, `publishExclusions` and
  `mainBundleExternals` read it on purpose. None of these reads `declare module '…'` or
  `/// <reference path>`.
- **A binding pin requires a VALUE binding, and a re-export is not an import.** `export { N } from 'M'`
  binds no local name. An `import type { N }` does not construct or call anything.
- **The migration found a latent defect beyond the guard.** `playableAppServicesStub` read dynamic uses as
  `m.<name>` within 120 characters, so `games/3d-test`'s `.then(({ analytics }) => analytics.logEvent(…))`
  was invisible. The playable stub had no `analytics`, and a playable build would have rejected that
  promise at runtime. Rollup does not check dynamic imports. The stub gained the namespace. The guard now
  THROWS on a use shape it cannot read, where it used to pass it unread: a non-`.then` use, a rest or
  nested destructure, a callback parameter used other than as a call of its member, `m.<name>(…)`
  (a chained or held member hides its own members from the namespace scan). A mock's original is credited
  only for `vi.mock`/`vi.doMock` whose factory calls its loader, by symbol, in its own body. Each reader has its own
  positive pin (`track` static, `register` dynamic, `analytics` destructured), because the review emptied
  the destructured branch with the suite still green.
- **A narrowing hides in "the regex caught it by accident", again.** The review found two more.
  `mainBundleExternals`' regex took `` import(`@modoki/engine/${n}`) ``, a template the parse names no
  module for; that arm is read again, by its head. `mainDialog`'s ban keyed on `'electron'` never saw
  `'electron/main'`, which predates this change. The whole-module arms also had no fixture while the
  real tree held no offender, so a typo in any arm would have stayed green.
- **Stays out, and why.** Where a code UNIT ends, measured by bracket counting or the next column-0
  declaration, is #1195. `findInstallCalls` and `requiredNamespaceMembers` are call scans, not import
  readers. `crashSinkOrder`'s bundle case reads a built artifact. `sourceScanner.test.ts` counts
  `/^import /` to measure the stripper itself.

**#1195 — where a code UNIT ends (~117 sites, in five phases; P3–P5 are #1240–#1242).** These guards
took the extent of a unit from its text shape: a hand-counted bracket depth, a slice to the next column-0
`function`, or a fixed-indent closer such as `'\n}'` or `\n {2}\}\);`. A bracket inside a string, a
neighbour, or one more level of nesting moved that edge. The anchor was observed before the move:
`keymapHmrEpochGuard`'s paren count ran through `console.log(':-(')`, swallowed the next effect, and read
its `[hmrEpoch]` as the deps of an effect with `[]`. **P1 landed** the helpers and the 12 guards that read
a declaration's shape. `sourceAst` gained four helpers. `propertyValue` returns a key's value, and the
last duplicate wins. `variablesNamed` finds a binding in any scope. `typesNamed`/`typeMembers` return an
interface or type literal's OWN members, and refuse a union rather than read it as empty. `functionsNamed`
returns every function known by a name, methods included. What recurred:

- **A text reader fails open by OVER-counting as well as by missing.** `playableAppServicesStub`'s member
  regex credited the stub with 10 members it does not have. They were parameter names (`_value`, `_doc`),
  `return`, and the keys of nested return literals (`ok`, `user`, `scheduled`), so a game calling
  `auth.user(…)` passed. `handleProviderOwner`'s brace walk counted 21 handle literals where there are 16
  string-kinded ones (17 in all, below).
  Five were spans anchored on a `kind:` that is not a handle, such as a TYPE `{ kind: 'color' | 'alpha' }`
  or a `setSel({ kind: 'color' })`. They ran wide enough to match `id:`, `x:` and `owner:` elsewhere in
  the component. A phantom member vouches for a missing one. Measuring old against new is what separates
  a real miss from a phantom. A count that DROPS is not a regression until each dropped row has been read.
- **Every hazard was probed on the real subject, and the old guard passed all six.** They were: a TS
  method whose name wraps before its `(`; a nested literal closing at the fixed indent, ahead of a
  `catch`; `markDirty` moved OUT of `install` (the anchor-to-anchor window still held it); an `owner`
  moved into a nested `meta` literal; `_isFileDirect: true` nested the same way; and the anchor's
  paren in a string.
- **"The function named X" has more than one answer.** `install: (r) => install(r)` in a deps literal is a
  function known by `install`, beside `const install = async …`. `functionsNamed` returns both on purpose,
  and a caller asking about the declaration filters out a property-assigned one and asserts the count.
- **Compare a wired value WHOLE.** `viewportBringUpWired` anchored each needle on the delimiter ending it,
  so that `() => disposed && false` would not pass as `() => disposed`. `printedText(propertyValue(…))`
  equal to the expected code does the same without a delimiter, and without the brace count that found
  the call.
- **The P1 review found the migration opening two holes the text had kept shut, and both have the same
  shape: one reader widened while the reader it pairs with did not.**
  - `stubExports` learned the `export { auth }` list form, but `stubNamespaceMembers` still read only
    `export const auth = {`. A namespace exported through a list counted as exported, and its members were
    never checked. One export table now feeds both.
  - `typeMembers` returned an extending interface's own members. The `interface NAME {` text it replaced
    could not find `interface NAME extends B {` at all, so it failed. The new reader instead read a field
    moved into the base as missing from the interface, and `manifestBlockPlumbing` passed with `hash`
    moved and dropped from the writer. `typeMembers` now refuses `extends`.

  So when a migration makes one reader see MORE, ask what pairs with it: the other half of a
  cross-check, or a failure the old text produced by seeing less.
- **A population restricted to dodge a false positive is also a hole.** The stub's member scan ran only
  over namespace OBJECTS, "so an unrelated local called `auth` can't false-positive". So a namespace
  written as `export class serverTime {}` went unchecked. When the scan was widened to every export, its
  name regex immediately credited Court's `track: string` parameter's `track.slice(…)` to the imported
  `track`. The fix is to read by symbol, and that loses a binding HANDED ON: `cloudSyncWiring.ts` calls
  through `services.auth` and a `cloudSave` parameter, and the symbol scan alone dropped those 4 calls.
  So a binding whose every read is a member call, a direct call or a `typeof` is read by symbol, and a
  handed-on binding is followed by name. The third review showed that name-following errs toward
  requiring a member ONLY when the receiver is spelled like the import. Wordweave calls through
  `accountAuth()`, which RETURNS `c ? { ...auth, …o } : auth`. Neither form saw those calls, so wordweave
  required no `auth` member at all, and only Court calling the same four members kept the stub whole.
  Following the return fixed that, and the fourth review found `const a = accountAuth(); a.signInWithApple()`
  dropped the same way. **Every round had found one more path the value takes, and each was silent**,
  because an unmodelled path yielded no members and no report. So there is now one classifier. A value
  is a member call (required), a direct call or `typeof` (nothing), bound by `const` (follow its reads),
  or returned from a named function (follow its calls), up to three hops. Anything else is COUNTED on a
  hand-on ledger. That is `dynamicMembers`' rule: a use the guard cannot read must not pass as no use.
  **The lesson is the loud default, not the extra hops.** A dataflow follower that returns "nothing" for
  a shape it does not model has the same defect as the text slice it replaced. A pardoned hand-on is
  UNCHECKED: the name fallback reads it only while the receiver keeps the import's spelling, and a
  renamed parameter stayed green in review, so each row's reason has to say so.
- **A fixture has to call the guard's own classifier.** Three #1195 fixtures re-implemented the check
  inline (`lits.filter(… 'owner')`, `propertyValue(…)?.kind`, `typeMembers(…)` in place of
  `versionType`). A mutation back to the text rule left them green. The classifier is now a named
  function (`isOwned`, `isFlagged`, `versionTypeIn`), and the fixture calls that function.
- **The docblock's own example was outside the population.** `handleProviderOwner` names `chromeHandles`
  as the provider it exists to see. That literal's `kind` is computed (`el.getAttribute(…) ?? …`), and
  both the text reader and the first parse required a string, so deleting its `owner` passed. A computed
  `kind` now counts, and the ledger key prints it in parentheses.
- **No parser is still a recorded decision.** `pluginMethodParity`'s Swift `pluginMethods` array keeps
  its bracket count, and the reason is written on `bracketBody`. A moved edge shows up as a method-set
  mismatch against the TS and Android sides, so it fails loud.

**P2 landed** the 19 guards that read a function body, a branch, a table or a call by its text extent.
It added no `sourceAst` helper: each guard's reader is a named function in its own file, over the P1
helpers plus `precedingStatements`, `readsOf` and `declarationOf`. What recurred:

- **A text reader over a TEST corpus reads the tests' own fixture strings as code.** `liveReloadKinds`
  enumerated watcher files by comment-blanked text, so the new fixture strings (`server.watcher.on(`,
  `const onChange = (`) made it list its own test file as a watcher and fail. `posixPathGuard`'s binding
  regex counted 23 POSIX bindings where there are 14; all 9 extra were `const p = '/Users/…'` inside
  fixture source strings. `jsonSafeIsShared` counted a `JSON.stringify(...)` written in a message string
  (the DEV error in `writeMaterialExtra`, `materialExtras.ts`). Comment blanking does not make a text scan safe; strings are the other half.
- **The extent was not the only window.** "Runs before", "inside the install's try", "the error path"
  and "the claim is released before this exit" were also offsets: the first `indexOf` of each call, the
  400 characters after one, the text between a log line and the next `} catch`. The node form is an
  earlier statement of an enclosing list (`precedingStatements`) in the SAME function. The first draft
  of that dropped the same-function half and credited a closure merely DEFINED before the install.
  Offsets on nodes are still offsets: "exits after `buildClaim = …`" by position included the
  acquisition's own `catch`, which runs while no claim is held. The unit there is the top-level
  statement.
- **Where names repeat, resolve by symbol.** SceneView's 2D and 3D pickers are both
  `pickEntityAtViewportPoint`; only the slice each regex ran over told them apart. A handler that
  shadows `path` passes `activeScenePath(path` as text. `posixPathGuard`'s indent window was a guess at
  scope, and missed a module-level binding used two `it`s down.
- **A reader that sees the whole unit finds what the slice never covered.** `createPrefabFromEntity`
  writes the prefab twice: the `redo` closure rewrites it and must stay quiet, and that is now pinned.
  "No tool spreads an `action`-bearing arg object" checked one tool; it now checks the 11 that declare
  `action`. `classifySceneChange` branches must now RETURN the kind they test, not merely compare it.
- **A fixture written as a fragment cannot be parsed.** `jsonSafeIsShared`'s detector fixtures were
  `': JSON.stringify(…) ?? …'` and an unclosed `function isThenable(…) {`. They are statements of the same
  shapes now, plus the two the paren scan documented as blind spots (a `)` in a regex literal, a
  backtick nested in `${…}`).
- **The review confirmed 16 more (plus one plausible and a nit, all fixed), and the largest class was a
  node reader NARROWER than the text it replaced.** Three reviewers, one per file group, each ran the old
  guard beside the new one on a perturbed subject. The old window was often wide by ACCIDENT, and that width was load-bearing.
  - `bootstrapGameDepsVendorOrder`'s `'\n  }'` closer never matched the file's indent, so it scanned
    from the vendor call to the install. A catch-only reader passed an `if (!vendorResult) continue;`
    between them.
  - The icon guard's text ban covered the whole function; `iconSpawns` covered one array literal. A
    second spawn with `--icon`, or a flag held in a variable, passed.
  - `objectReads` read array literals and missed `gcloudRun('storage', 'cat', …)`.
  - The install port only had to CALL `runScaffoldShell`, where the concise-arrow regex had pinned its
    RETURN. `return true` after it builds on while npm is still running.
  - `warnInertPrefabSizes` compared the path argument, and the regex had pinned the prefab too.
  - `posixPathGuard` needed the literal to be the whole argument, and `'/tmp/' + name` is not.
  - `constructsTeardownToken` took a declaration or `=`, and a `??=` module left the population with
    both checks on it.

  So "the same population on today's tree" is necessary and not sufficient. Measure the old guard's
  REACH as well: what else could its window have contained?
- **A check that lives only in a comment or a failure message is not a check.** `dirtyWake`'s message
  said the wake ran "before its return", and it compared top-level indices, so a conditional
  `{ …; return; }` above the wake passed. `viteCacheBust`'s docblock said a clear "on every boot" is not
  the fix, and nothing read the `if (prev !== buildSig)` gate. The stub scan's commit said nothing
  unreadable yields "no members" without a row. A returner with no in-file call, or a `return` inside
  an anonymous callback, did exactly that. A commit message's mutation list is a claim too: "no
  dedupe: red" was green, because no fixture held a node in both sets.
- **Each fix to a guard reader gets its own review, and two rounds of it still found defects.** The
  first re-review of the review fixes found one that stopped counting a `break` the text reader had
  counted. The second found a release credited because it sat below module scope, though it ran before
  the build it was meant to cover. It also found a gate reader built from a list of what CAN skip
  (`guardsOf`: `if`, `? :`, `&&`, `||`), which `??`, `||=` and a `switch` walked past. That reader is now
  a list of what CANNOT skip. And it found three new rules that no mutation turned red. A list of the
  ways to escape a check is never complete. Allow the known-safe shapes and flag everything else.

  A third round still found seven, two of them false greens against the real script. Two lessons are new:
  - **Stop locating the work, and pin a checkable condition instead.** Each claim-release reader tried to
    say where "the build" was: module scope, then after the `try` block. Each moved the hole
    (`release(); try { build } catch { failed = true } if (failed) exit` passed). The rule now is that
    nothing but `console.*` or an exit runs between the release and the exit. It is strict, and red on a
    nested report, but it cannot be walked around.
  - **An allowlist needs its own accept cases, or it turns into false reds.** The install allowlist red-flagged
    `if (npmRun(…).status !== 0)`. The "prior value" check red-flagged `JSON.parse(prev).buildSig !==
    buildSig`, because a property NAME matched. And a depth budget that returns "clean" when exhausted
    fails open. Fail loudly instead.

**P3 landed** the ~43 sites in 14 GAME test files — Court (11), sling, forest-camp and wordweave (3) —
that took a code unit out of a game's `runtime/systems.ts` by text shape. It added no `sourceAst`
helper: each file's reader is a named function over P1's. Populations were measured old against new
for every member, and **most were identical, which is the point** — these guards were correct on
today's tree and blind to the next edit. Three were not identical, and the deltas say what the text
could not see:

- **A scan can enumerate NOTHING and still look busy.** `worldSwap`'s `__testing` partition has three
  member scans, all keyed on a two-space indent. The INLINE-ARROW arm — the one its own comment calls
  "the one shape this partition could not see" — matched 0 members where there are 85; every one of
  them was in no population at all, under a rule whose claim is that it is TOTAL. The verdict does not
  move (none takes a world first), so nothing but the count could have reported this.
- **A body-by-name slice over-reads, and how far is not visible at the call site.** `winSequence` cut
  to the next `'\nfunction '`: `lockedRefusal`'s body is 316 characters and it read 1,235;
  `commitUndo`'s is 1,873 and it read 4,848. wordweave's 14 `update*Visuals` passes are 61,015
  characters together and the slices returned 151,714. Every one of those checks asks whether a body
  MENTIONS something, so the answer was partly a neighbour's.
- **A `[^}]*` body is a fail-OPEN miss.** wordweave's backgroundColor guard read a `patchUI` body with
  `\{([^}]*)\}`, which ends at the first `}` — so a call nesting an object before its
  `backgroundColor` read as not pushing one. 36 sites found against 37 (`CoinShortfallBuy`).

What else recurred:

- **`function name(` cannot see a GENERIC signature, and a parameter's TEXT cannot see an optional
  one.** Court's `systems.ts` has three generic declarations (`nestEntryMap`, `withDeadline`,
  `trackedCloudSync`) that were in no population, and `saveSession(world?: World)` read as world-free
  because `world?: World` fails `startsWith('world: World')`.
- **A slice to EOF is a window over the whole rest of the file, and two of these were.**
  `cellMapDiscipline` anchored at `layoutBoard` and ran to the end; `sweepGate` sliced its skip banner
  the same way, and the file declares a THIRD banner below it that also writes to stderr and calls no
  `console.*`. Narrowing the second to its `if` statement was NOT enough on its own: mutation-checked,
  aiming the selector at the other banner left both assertions green, because the two blocks are
  indistinguishable by what they assert. It now pins which banner it read.
- **Fixture-testing a reader usually means SPLITTING it from the file it reads.** Half of these readers
  took a path, so their hazards could not be staged: `palette`'s mirror reader, `layoutInputSignature`'s
  runtime-write reader and the three `configFields` span readers all became `(source, label)` functions
  with a thin file wrapper, and the fixture calls the reader rather than a copy of it.
- **A fixture expectation is a claim too.** Three of these were wrong on the first run — a nested
  literal's HOLDER is a field of the interface (its inner key is not), a top-level `nested: {…}` key IS
  a written field, and `objectLiteralKeys` spells a spread `'...'`, which the hand-rolled reader had
  skipped silently. Each was a case the new reader answered correctly and the fixture had guessed at.
- **The migration's OWN review found the one regression, and it was a node reader that asked for MORE
  than the text did.** The bare-entity-id BAN in `worldSwap` went from `/^let (\w*RootId) = /gm` — a
  name — to a name PLUS a `number` annotation or a numeric-literal initializer. Three of its four
  spellings went silent: `= -1` (a `PrefixUnaryExpression`, not a numeric literal), `= NONE`, and
  `= boardRoot.id()`, which is the shape the ban exists to forbid. Proven both ways: with that
  declaration inserted into `systems.ts`, the migrated file was 22/22 green while the pre-migration
  guard was RED. **A node predicate is not automatically wider than the text it replaces — every
  conjunct you add to "what the node must look like" is reach you are giving up**, and the fixture
  will not tell you, because a fixture written alongside the new reader exercises the spellings that
  still work. The same shape, smaller: `p0.type?.getText() === 'World'` refuses `World | null`, which
  `startsWith('world: World')` accepted.
- **A partition that enumerates by SHAPE has to enumerate every shape.** The `__testing` seam rule
  calls itself total; 27 of that literal's 321 properties are METHOD syntax (`name(world, dt) { … }`),
  which neither the three `^ {2}` regexes nor the first node cut put in any population. Asking "is
  this a `PropertyAssignment` whose initializer is an arrow" is a question about spelling, and a
  partition's members do not owe you one spelling. Related, and empty today: a reader enumerating
  only `function` declarations cannot see a member naming a `const f = (world: World) => …`.
- **A migration can strand an exemption row in ANOTHER file.** `cellMapDiscipline`'s two `indexOf`
  ordering comparisons were on `indexOrderingAssertions`' in-flight ledger (#1181). Converting them to
  node positions left that row blessing occurrences that no longer exist, and the ledger's
  over-blessing check caught it in `verify` — which is that rule working, and worth knowing before the
  next phase moves a file another guard counts.
- **Three smaller ones, all fail-closed, all from the same cause — a node reader answers a slightly
  different question than the text did, and the difference is invisible until the input changes.**
  Excising a literal by its own span left `cfg`/`fields`/the trait `name` in the identifier corpus (a
  config field spelled `name` would have counted as read by its own declaration); `objectLiteralKeys`
  spells a spread `'...'`, which a guard checking keys against scene entities would have reported as
  "no entity named '...' is authored"; and `findNodes(…, isStringLiteralLike)` descends INTO a
  template's `${…}`, so `` `${n === 1 ? 'minute' : 'minutes'}` `` contributes two arms the function
  cannot return alone. Read what the helper returns for the shapes your subject does NOT have yet.


Progress: **seventeen guards are on the ledger** — `determinismGuard`, `docCitations` and
`importSettingSelectsSpliced` (Phase 1); `assetJsonGuard`, `handleProviderOwner`,
`abandonmentIsShared`, `keymapOwnership` and `projectPresencePredicate` (Phase 2); and the nine whose
DETECTORS had to learn to count first (#1128 Phase 3) — `rendererLossHandling`, `clientJsonWriteSeam`,
`metaReadPreferringPark`, `cliNativeBuildHeals`, `inputSourceGuard`, `commentStripperIsShared`,
`corpusProducerIsShared`, `appManagerDisposeReachable` and `qaCaseReferences`' `CLONE_PORT_ALLOWED`.
Every one of Phase 3's was mutation-checked by ADDITION and red where the file-keyed form was green.
Counting also surfaced **four exempt files holding more than their reason covered** — all legitimate
once read, none written down: a second `ls-files` spawn in `typecheck-projects.mjs`, a second walker
in `editorBackendRouter.ts`, `inlinePlayable.ts`'s `pruneEmpty`, `clean-texture-cache.mjs`'s `dirSize`.
That is the grain defect's usual shape — not an offender hiding, but a reason nobody re-read. A tenth,
`editorAssetJsonGuard`, has **no ledger at all**: its single row pardoned zero occurrences, so it was
deleted and replaced with the non-vacuity floor the guard had always lacked — which is the right
outcome when a pardon turns out to be inert, and worth knowing before you reach for a row.

Three shapes the Phase 3 migrations kept meeting, recorded so the next one does not rediscover them:

- **An EMPTY ledger is deleted, not migrated.** It has nothing to spend, and its first row would have
  pardoned a whole file (`commentStripperIsShared`'s `RAW_READ_ALLOW`). A ban with no pardons is a
  plain `toEqual([])`; since its clean-tree population is 0 and `floor` cannot be, pin its detector on
  SYNTHETIC input instead (`inputSourceGuard`'s pointer ban).
- **Keep `floor` at 1 and let `sanctioned` carry liveness.** A floor equal to the measured count
  reports every legitimate FIX as "the detector has stopped matching" (the floor arm runs before
  over-blessed). Where the one implementer is sanctioned, its staleness check already proves the
  detector alive. Where the only occurrence is a pardon, removing it will trip the floor — still red,
  read it as the row going stale.
- **A guard that quotes its own marker in string literals is `sanctioned`, not counted** — its count
  moves with every edit to its own prose (`corpusProducerIsShared`).

**#1140 Phase 1 re-read the 20 hand-rolled ledgers a shape census sorted as grain mismatches** —
and re-reading, not the census, is what found the defects. Every one was either put on the helper
(`pixiApplicationTeardown`, `buildWebCallSites`, `docCitations`' `SOURCE_CITATION_EXEMPT`,
`adbTargeting`, `codeAssetRefs`' `PENDING_MIGRATION`, `authoredAssetRefs`, `chromeTagging`,
`userDataDir`, `accountNoCopy`, Court's `cellMapDiscipline`, `appManagerDisposeReachable`'s
`NOT_A_MANAGER_DECLARATION`), deleted because it was empty (`materialCloneStamp`,
`updateEachFanoutGuard`, `codeAssetRefs`' `ALLOWED`, `danglingCodeGuids`, `docCitations`'
`KNOWN_DANGLING_TITLES`), or replaced by a rule that needs no list (`projectDocs` now asks
`git check-ignore`). What the migrations turned up, because these are the shapes to expect next time:

- **Inert pardons are the commonest finding, and a list with no staleness check hides them
  indefinitely.** 6 of `cellMapDiscipline`'s 11 function names, all 3 of `projectDocs`'
  `ABSENT_ON_PURPOSE` rows and one of its two `ABSENT_BY_DESIGN` names, and `docCitations`'
  inline self-skips in rules 3 and 4 pardoned nothing (each measured).
- **A pardon can hide a DETECTOR bug.** `adbTargeting`'s row for `androidDevices.ts`' device
  listing looked load-bearing because the detector's fixed 400-char window reached the NEXT
  call's `adbArgs(` and misread the un-targeted call as targeted. Spending the row reported
  "blesses 1, found 0", which is how it surfaced. So an over-blessed report is a question about
  the detector as much as about the row.
- **A collapsed key hides written-down-nowhere extras.** `authoredAssetRefs`' `file:trait.field`
  rows covered four more blank entities than they named (legitimate once read), exactly the
  "reason nobody re-read" shape Phase 3 found.
- **`sanctioned` is the right home for a correctly-coarse pardon** — a field whose blank is its
  meaning, an input-path function, a type-union member, a whole file that must quote its subject.
  The grain stays; the staleness check is what it gains. `authoredAssetRefs`' `UIElement.imageSrc`
  had already gone inert once as a bare `Set` and was found by hand.
- **A structural exclusion read by several scans is several claims.** `docCitations`'
  `SELF_QUOTING` stays a whole-file exclusion, but a test now requires it to excuse something in
  EACH of the three scans that apply it.

**#1140 Phase 2 did the same for the lists already keyed at the right grain** (per file, per name)
and for three that already counted by hand (`gitReadIsBounded`, `layoutConditionalTestLedger`,
`notifyIsShared`). "Correct grain, no staleness check" sounded like bookkeeping; it was not:

- **A correct-grain pardon still hides a dead detector or a dead reason.** `courtSweepScope`'s and
  `ktx2CapsGuard`'s only rows pardoned nothing, and `notifyIsShared`'s outside-SCAN_DIRS list and
  four others were empty. Spending the list is what said so.
- **An EXCLUSION list can make a REQUIRED-pattern guard unfalsifiable.** `moduleTogglesWired` asks
  that every build-module toggle has a consumer, and excluded a hand list of definition files from
  that count. A fourth definition site (`electron/ssrLoader.ts`) was never on it, so it vouched for
  every toggle — and when that was fixed by shape, three STRING literals mentioning the define still
  vouched for `video`, until the scan stripped strings too. A hand list of what to exclude fails open
  on the entry nobody added; derive the exclusion from what the excluded thing IS.
- **One pardon consulted by two rules.** `invalidatorGranularity`'s per-key exemption `continue`d
  past the overshoot rule too — the Phase 1 lesson, in a list that looked correctly keyed.
- **Key a row by the SPELLING its reason is about.** Court's `worldSwap` exemptions argue about a
  plain reference to a function; keyed by name alone, a later inline-arrow rewrite of that member
  that never entered the world spent the same row. They are `name::plain` now.
- **Absent by LAYOUT is not absent by existence.** A row whose file the checkout does not ship is
  dropped with a layout predicate (`gitReadIsBounded`'s `rootIsPresent`), never with `fs.existsSync`,
  which would also silence a row whose file was deleted or renamed in a root that ships.

Not everything in the census is a pardon, and forcing one onto the helper would change what it
means: a two-way exact baseline (`noNewCycles`, `routeCoverage`, `gamePortability`) is already
exact, and a coverage REGISTRY proven by the test it names (`worldSwapTeardownFalsifiable`'s
`BASELINE`) must not be spent against the thing it covers.

⚠️ **The helper is non-optional now: `engine/tests/architecture/exemptionLedgerIsShared.test.ts`
(#1140 Phase 3).** It fails on a hand-rolled pardon anywhere vitest collects tests — `engine/tests/**`,
the package's `tests/**`, the scaffolder template's `tests/**`, every `games/<id>/tests` and
`demos/<id>/tests`, and a project's own `packages/**` tests. It detects a SHAPE, never a name: a
`const` literal collection (no spread, never mutated; an empty `new Set()` counts) consulted by a
membership test that skips a hit — the condition of an `if` whose branch ends in `continue`, or
inside a `.filter(…)` callback either negated or the condition of an `if` that ends in
`return false`. What it cannot see, and the measured false-positive count that chose its breadth,
are in its docblock. Two things
to know before you meet it:

- **The breadth was an owner call on a measurement, not a default.** The broad shape matched 55
  sites (about 30 real pardons, 13 of them in guards no census had listed, and about 25 data lists);
  matching only lists that carry reasons matched 9 and missed about 20 pardons written as a bare
  `new Set([...])`. Broad won because a guard that only sees reasoned pardons rewards leaving the
  reason out. Migrating those 13 first found the usual yield: `mcpRegistry`'s `PER_TOOL_MEANING`
  pardoned 13 params whose wording had already converged. (The first count said 15: two of them,
  `action` and `type`, only looked converged because an undescribed param's `''` was taken as the
  shared base — close-out review.)
- **A list that selects rather than excuses goes in its `RESIDUE`, with its KIND first** — data,
  vocabulary, classifier, scan scope, an expected/declared table, a two-way exact baseline, a
  registry, a structural self-exclusion, a GENERATION skip (a list that skips generating a per-item
  test has no scan population to spend — give it a check that it is still load-bearing instead, as
  `deviceToolCoverage`'s routing probe and `liveCoverage`'s `NO_OK_FLAG` test do), or deferred to
  another lane. A pardon that filters a detector's hits is none of these: put it on the helper.

⚠️ Do not quote a remaining count from a marker that greps for `ALLOW*`/`EXEMPT*` names: migrating a
guard makes it DISAPPEAR from such a census (measured 43 → 42 → 40 across #1128's two phases, by a
rename, a deletion and a split), so the number falls for reasons unrelated to progress.

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
