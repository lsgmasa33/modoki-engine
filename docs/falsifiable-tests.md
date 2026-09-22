# Falsifiable tests — making sure a test CAN fail

A test that cannot fail is worse than no test: it costs the same to run, it reads as coverage in
every audit, and it actively licenses deleting the mechanism it claims to protect. This doc is the
one place the repo records **how a test goes unfalsifiable here, and the shapes that fix it**.

## What it is

The dominant shape is not a wrong assertion. It is a test whose *input* cannot tell the mechanism
apart from its absence:

> **A teardown or a discriminant is unfalsifiable when the suite constructs only ONE instance of the
> axis it separates.**

Three axes, one mechanism:

- **Time** — a module registers cleanup for the world going away. If the suite never swaps the
  world (or mocks away the thing that emits the swap), the handler never runs, and deleting the
  registration leaves the suite green.
- **Space** — a cache keys on a renderer, surface, provider or entity generation so two live
  instances do not collide. If the suite only ever builds ONE renderer, a correctly-discriminated
  cache and one keyed on the source alone behave identically, and deleting the discriminant leaves
  the suite green.
- **World** — the same as *space*, but keyed on the koota `World` itself. Swept separately in #851;
  9 of 11 such caches are unpinned. ⚠️ Weaker in practice than the other two: two renderers coexist
  permanently in the editor, whereas two `World`s coexist only transiently during the two-world
  atomic swap — so treat it as a cover gap first, and a live defect only where you can show the
  window.

All three are one family (`family/unfalsifiable-test`, #838 + #828 + #851) because all three are
verified the same way — see **The bar** below.

⚠️ **A second, unrelated shape lives in the same family: the guard whose SUBJECT is wrong** (#855).
The one-instance shapes above all interrogate the right thing with too narrow an input. This one
interrogates the wrong thing entirely — it asserts a constant against a *sibling* constant and never
reaches the mechanism it is named for. It is not fixed by adding a second instance; it is fixed by
asking the subject. See **The wrong-subject shape** below.

## Key files

| File | Role |
|---|---|
| `engine/tests/architecture/worldSwapTeardownFalsifiable.test.ts` | The guard. Flags a producer whose swap teardown a test mocks away with no covering test |
| `engine/packages/modoki/src/runtime/core/ecs/worldRegistry.ts` | Defines `onWorldSwap` and the listener `Set` — the real emitter |
| `engine/packages/modoki/src/runtime/core/ecs/world.ts` | **Re-exports** `onWorldSwap`. This indirection is the trap; see Gotchas |
| `engine/packages/modoki/tests/runtime/materialInstanceClones.test.ts` | Reference for shape **(A)**, the real swap |
| `engine/packages/modoki/tests/editor/selectionRestore.test.ts` | Reference for shape **(B)**, capture-and-invoke |
| `engine/packages/modoki/tests/runtime/envPmremOwnership.test.ts` | Reference for the two-instance discriminant test |
| `engine/packages/modoki/tests/video/videoTextureSync2D.test.ts` | The compact model of the same, in `gives each surface its own texture over the SAME element` |
| `engine/tests/tools/readAssetDefServed.ts` | Reference for the **wrong-subject** shape — probes the op instead of inferring what it serves |
| `engine/packages/modoki/tests/helpers/inOrder.ts` | `expectInOrder` / `found` — ordering checks that fail on an absent subject, shape **(H)** |
| `engine/tests/architecture/indexOrderingAssertions.test.ts` | The shape (H) guard: no raw `indexOf`-family position on the vacuous side of an ordering matcher |

## How it works

### The bar: mutation, not inspection

**EVERY new test is mutation-checked, and the result gets REPORTED** — not only the tests in this
family. Delete the mechanism in the production source, re-run the test, confirm it goes **red** and
that nothing unrelated does, restore, confirm **green**. Red in both states proves nothing; green in
both states is the defect itself. Then say in the commit or the close-out what you broke and what
went red: an unreported mutation check is indistinguishable from one that never ran.

⚠️ **Unconditional on purpose — the tests that LOOK obvious are the ones that ship unfalsifiable**
(owner, 2026-09-07). The #823/#825 close-out found three mechanisms whose tests stayed green when the
mechanism was deleted (reverting the detail-selection block left 1614 tests green) — and every test
that had been *explicitly* required to carry a mutation check survived review. The bar was already
written here and was applied unevenly; **that unevenness IS the defect**, so there is no
"is this one risky enough" question to answer first. Writing a test yourself feels like verification
and is not — this survives the 2026-09-07 inline-implementation ruling
([model-routing.md](model-routing.md)) rather than being fixed by it.

⚠️ **Restore with an ABSOLUTE path.** A `cd` earlier in a command chain silently redirects the
restore and leaves the source broken while the test reports what you wanted to see.

The mutation is specific to the axis:

| Mechanism | The mutation |
|---|---|
| A swap teardown | Delete the `onWorldSwap(...)` registration line |
| A per-renderer cache | Collapse the per-instance `WeakMap` to a shared module-level `Map` |
| A keyed cache | Drop the discriminant (`provider.id`, the surface, the generation) from the key |
| An idempotency guard | Delete the `if (!map.has(k))` so a second call overwrites |

### The three shapes for a world-swap teardown

**(A) Real swap** — import `setCurrentWorld` from `core/ecs/world` and `createWorld` from `koota`,
swap, assert the handler's effect. Only viable when the suite does **not** mock the world module.
Reference: the `the PRODUCTION world-swap wiring` block in `materialInstanceClones.test.ts`.

**(B) Capture-and-invoke** — mock `onWorldSwap` so it *captures* the handler, then call it:

```ts
let listener: ((next: unknown, prev: unknown) => void) | null = null;
vi.mock('../../src/runtime/core/ecs/world', () => ({
  onWorldSwap: (fn) => { listener = fn; return () => {}; },
}));
// ...
expect(listener).not.toBeNull();   // <- the assertion that makes it falsifiable
listener!(newWorld, oldWorld);
```

Falsifiable because deleting the production registration leaves `listener` null. Works **with** a
mock in place, so it is the right shape for a suite that mocks the world module for genuine
import-isolation reasons. Reference: `selectionRestore.test.ts`. A partial variant spreading
`await importOriginal()` is in `hierarchyGhostGating.test.tsx`.

**(C) Bare no-op** — `onWorldSwap: vi.fn()` or `() => {}`. **This is the defect.** The handler is
dropped on the floor and nothing in the suite can observe its absence.

### The two-instance shape for a discriminant

Construct **two** bare `{}` instances of the discriminant, drive the **same** input through both,
and assert three things — the third is the one people forget:

1. the derived outputs are `not.toBe` each other;
2. the underlying build counter incremented **once per instance**, not once in total;
3. touching instance B does **not** disturb a cache hit already established for instance A.

### The FROZEN-PARAMETER shape: a sweep that varies one axis and pins the other (#984, #979)

A test over a *sampled* process has more than one free parameter, and freezing the wrong one makes
the assertion collapse into something that cannot fail. Both games that hit-test a swept pointer
stroke shipped this, in two different generations, and the second was written as the FIX for the
first:

| Generation | Swept | Frozen | What it degenerated into |
|---|---|---|---|
| original | the row OFFSET | the x-PHASE, at cell centre → cell centre | "is the offset inside the radius" — a substep lands on every cell's exact centre, so no step size can straddle a chord |
| its replacement | the x-PHASE | the OFFSET, at 0.35 pitch — outside the band where the failure lives | passed, and declared impossible the defect filed against it days later |

**The rule: sweep every free parameter, and compare against a near-continuous REFERENCE run of the
same input rather than a literal expected output.** The property is *"the shipped step finds what a
finer one finds"*; a hardcoded `[6,7,8,9]` cannot express it, because a start phase inside the first
cell's circle legitimately seeds it and yields `[7,8,9]`, which is not a failure.

Four details that each cost a green-but-empty test:

- **An ABSOLUTE anchor is mandatory.** Both sides call the same sampler, so any mutation that makes
  the sampler match *nothing* — a radius of zero — collapses them to `[] === []` and the entire
  sweep passes. Assert the reference itself found a plausible number of hits.
- **The phase count must be COPRIME with the stride divisor.** `shift = pitch * p / PHASES` against
  a stride of `pitch/4` gives only `PHASES / gcd` distinct alignments: 16 phases was really FOUR,
  and the losing phases hid in the aliased set. Use a prime.
- **The segment must not be a whole number of pitches.** An exact multiple keeps the sample grid
  commensurate with the cell grid, so a miss becomes all-or-nothing rather than phase-dependent.
- ⚠️ **Deriving the sweep's BOUNDS from production makes the sweep blind to production's formula.**
  Court's blind-band edge is computed from the shipped stride. Take that stride from the production
  function (right — a mirrored copy drifts) and the band moves with it, so a changed formula is
  still "consistent with itself" and the sweep stays green. That is not a reason to re-mirror it:
  it means the FORMULA needs its own test, asserting the shipped value and the relationship
  directly. Measured — with the stride reverted to its pre-fix form, the sweep passed and only the
  formula test went red.

Worked examples: `games/wordweave/tests/screen.test.ts` (the reference implementation) and
`games/court/tests/memo.test.ts` § "a swept stroke finds what a near-continuous walk finds".

### The wrong-subject shape: a guard that interrogates a sibling constant (#855)

The shapes above fail on the INPUT. This one fails on the SUBJECT — and it is harder to see, because
the file reads as a parity guard and its assertions are all true.

`assetTypeParity.test.ts` was named for parity between the two hand-kept MCP `read-asset-def` enums
and **what the op serves**. It established the second half like this:

```ts
const NOT_READABLE: Record<string, string> = { material: '…', atlas: '…' };
const READ_ASSET_DEF_TYPES = ASSET_SCHEMA_TYPES.filter((t) => !(t in NOT_READABLE));
```

`ASSET_SCHEMA_TYPES` is a sibling constant, and `NOT_READABLE` is a hand-maintained *inference*
about a dispatch chain in two other files. **Not one assertion in the file called the op.** So every
comparison was constant-against-constant, and the guard could not tell *"the enum drifted from the
op"* from *"the enum drifted from a list that has nothing to do with the op"*.

⚠️ **What makes this shape expensive is that it does not merely fail to catch a defect — it PUSHES
one.** #831 added `atlas` to `ASSET_SCHEMA_TYPES`; the derived list grew to 8, the enums still had 7,
and the test went red naming exactly that difference. The cheapest way to green was to widen the
enums, so that is what happened, at the hub, in `de3cdce48` — to a type the op has no arm for.
`modoki_read_asset_def {type:'atlas'}` then passed zod and died at the backend, with the tool
description edited to advertise `.atlas.json`. **A tool that ACCEPTS a type it cannot serve is worse
than one that refuses it.** Reverted in `ac546c720`.

**The fix is to make the mechanism answer.** Both `read-asset-def` surfaces already distinguish
themselves in their own error text — a type they dispatch misses with `not in the live <kind> cache`,
a type they do not falls through to `unsupported type '<kind>'` — so the served set is *observable*
and never needed inferring. `probeServedTypes` calls the op once per candidate type and classifies
the reply; the enum is then asserted against that.

Three things that shape needs, and each cost a defect to learn:

- **Pass the discriminating input explicitly.** Every probe passes `type`, bypassing
  `inferAssetDefType`. Left to suffix inference, an unrecognised type lands in the *"cannot tell what
  kind of asset"* branch instead — a third answer, to a different question, that looks like a refusal.
- **Assert the probe DISTINGUISHES, in its own test.** One `it` shows a known-served type classifies
  `served` and a known-unserved one classifies `no-branch`. Without it the parity assertion rests on
  a classifier that might return one verdict for everything.
- **Keep "will not" apart from "cannot".** `material` is dispatched and refuses on purpose; `atlas`
  has no arm. Collapsing them into one exemption map is what made the two look interchangeable — so
  the verdict is three-valued (`served` / `no-branch` / `other`), not a boolean.

⚠️ **Two surfaces cannot be probed from one module graph.** `registerAgentOp` is register-or-replace
on a single module-level `Map`, and `registerEditorAgentOps` has a one-shot `registered` flag that
cannot be un-set — so importing the editor ops permanently replaces the runtime twin for that file.
The two probes live beside each op's own behaviour tests (`tests/editor/readAssetDef.test.ts` and
`tests/framework/liveLifecycleOps.test.ts`), which is also where whoever edits an op will see them.

**What stays in the parity file is what it can honestly observe**: that the tools are *registered*
with their enum and validate against it. That is parity with the transport, not with the op — and it
is the `modoki_prefab` class, which 400'd on every call for months with a green suite. Both halves
are worth having; conflating them is what went wrong.

### The wrong-ALTITUDE shape: asserting the command you built, never the effect it has (#875)

The shapes above pick the wrong input or the wrong subject. This one picks the wrong **altitude**:
the assertion is about a value the code *constructs*, when the thing that can be wrong is what the
operating system then *does* with it.

`trashCommand.test.ts` covered the editor's "move to Recycle Bin". It built the argv and asserted:

```ts
expect(args.join(' ')).toContain('foreach ($p in $args)');
expect(args.slice(-2)).toEqual(['C:/x/m.glb', 'C:/x/n.png']);
```

Both assertions were true, and both pinned a **broken** invocation as correct: `powershell
-Command "<script>" p1 p2` does not bind `$args` (see [windows.md](windows.md)), so the loop ran
zero times and nothing was recycled on Windows for months. `assetFsOps.integration.test.ts`
covered the same function with an injected `exec` and `platform: 'darwin'`, so the win32 branch
was executed by nothing at all.

**Why the mutation bar does not catch this one by itself.** Delete the mechanism and the test DOES
go red — it notices the string changed. It just cannot notice that the string never worked. The
test and the defect are at different altitudes, so mutation only proves the test is wired to the
code, not that the code is wired to the OS.

The discriminator to add is **one test that performs the real effect and observes it**:

- Run the actual API against a real fixture, and assert on the **filesystem afterwards**, not on
  the command. `trashCommandLive.test.ts` recycles real files and checks they are gone.
- Assert what must be **ABSENT**, not only what is present. "no path appears in argv" is the
  invariant; "the script contains `SendToRecycleBin`" is a spelling.
- Pin a **bystander**. The sharpest case here is not "the file was deleted" but "the file next to
  it was NOT" — the old defect split `…\a file.json` and aimed at `…\a`.
- ⚠️ **Check that your platform can even express the failure.** The UTF-8 guard in that fix is
  inert on a dev box already at code page 65001; a mutation check there reports it as dead code.
  The test has to *manufacture* the hostile condition (force CP437) or it is measuring your
  machine's luck. A green mutation check on an environment-dependent guard is not evidence.

### The guard, and what it deliberately does not cover

`worldSwapTeardownFalsifiable.test.ts` is **producer-side** — one test per teardown, not one per
suite that mocks it. Nine suites mock away `uiTreeStore`'s handler and ONE test on `uiTreeStore`
covers all nine; the others mock the world module for unrelated reasons and have no claim to make.
Measured while designing it: a mock-site rule needs ~21 hand-maintained allowlist entries.

It has **two halves**, and the split is the whole design:

- **`BASELINE` (the ratchet)** — a hand-maintained map of producer → the ONE test file covering its
  wiring. That file must exist, VALUE-import the producer, and contain the marker phrase
  **`world-swap wiring`**. Deleting the test or renaming the marker goes red.
- **`SWALLOWED` (the tripwire)** — computed: a producer some test wholesale-mocks in a way that
  drops `onWorldSwap` (a no-op, a shorthand, or omitting the key) **and imports directly**. Absent
  from `BASELINE`, it is a new arrival and goes red.

⚠️ **That "and imports directly" is load-bearing, and a green tripwire is weaker than it looks.**
Measured: 62 test files mock the world module, 55 swallow it, and the tripwire attributes exactly
**three** producers. A producer reached transitively is invisible to it — which is how
`editor/store/canvas2DDirty.ts` went uncovered until a second review pass found it: editor suites
mock the world module and reach it through `editorStore.ts`, and deleting its registration left 71
tests green. Anything found that way goes in `BASELINE`.

⚠️ **Why the ratchet is hand-maintained rather than derived.** The first version computed its
protected set from the defect — "producers some test mocks to a no-op" — which meant each producer
left the protected set at the moment it was fixed. Measured on the commit that introduced it: **4 of
the 7 tests it existed to protect could be deleted with the guard still green**, and a fully-fixed
repo would have driven the set to zero and failed the file's own non-vacuity assertion. *A guard
whose premise is computed from the thing it guards switches itself off as the problem is solved.*

⚠️ **`BASELINE` names the exact file for a reason.** A weaker rule — "some file that imports this
producer carries the marker" — was satisfied by a **type-only** import: `uiNode.test.tsx`'s
`import type { UINodeData }` marked `uiTreeStore.ts` covered, so `uiTreeStore.test.ts`'s own wiring
test could be deleted with the guard green.

The marker phrase is a **declaration, not a proof** — the same trust model as the allowlist in
`invalidatorsAreReachable.test.ts`. What proves the test is the mutation check, which belongs to
review. The guard's job is to make the *absence* of a test loud.

⚠️ **A declared parameter is not a capture.** `onWorldSwap: (_fn) => () => {}` is a no-op wearing a
capture's signature, and the guard's own failure message hands you that signature — writing it and
forgetting the body is the cheapest way to silence the guard. The parser now requires the parameter
to be *referenced*, and carries its own regression cover for every shape a review caught it
misreading.

It does **not** catch:

- **a teardown no test mocks and no test covers** — the at-risk set is seeded from what tests
  actually mock, so a producer with no suite at all is invisible. Widening to "every producer needs
  a wiring test" flags ~30 sites and would ship as an allowlist, which goes stale rather than guards.
- **the discriminant half — either axis.** *"This mock is a no-op"* is greppable; *"this cache's key
  is missing a renderer"* is not, and neither is *"missing a `World`"* (#851). Those tests are
  hand-written with no mechanical backstop.
- **the wrong-subject shape (#855) — and this one is the least visible of the three.** There is no
  syntax to grep: a guard comparing two constants is indistinguishable from a guard comparing a
  constant to a value that happens to be constant, and the wrong one reads *better* (no setup, no
  async, fast). The only thing that finds it is asking, of a named parity guard, **"which line in
  this file reaches the thing the name says it is parity WITH?"** — and if the answer is "none",
  the guard is measuring its own left hand against its right.

### Three shapes already exist for the World axis — copy one, do not mint a fourth

`journal.ts`, `rng.ts` and `worldRegistry.ts`'s `entityIndices` each have a real two-`World` test
(`keeps a separate, independently-ticked trace per world` · `is isolated per world` · `creates a new
Map for a new world`). ⚠️ **`worldRegistry.ts`'s `guidIndices` is the instructive near-miss**: its
test *does* build two worlds and register the same guid in both, but asserts only that the CURRENT
world resolves correctly. Under a shared map the second registration simply overwrites the first and
that assertion still passes. **Two instances is necessary, not sufficient — the assertion has to
interrogate the STALE one.**

### The World axis (#851) — and what running the census actually showed

The third axis of shape (A)/(B): **a per-`World` cache's discriminant is unfalsifiable because no
test holds two live `World`s while exercising that cache's read/write path in the same assertion.**
The fixture is `engine/packages/modoki/tests/helpers/twoWorlds.ts`; copy it rather than deriving a
fourth shape.

⚠️ **The ordering is the whole mechanism: write A, write B, then read A BACK.** "Two worlds exist"
is necessary and NOT sufficient. `guidIndex.test.ts` built two worlds, registered the same guid in
both, and asserted only that the CURRENT world resolved correctly — which is exactly what a shared
map produces under last-write-wins. Never assert on the world you wrote last.

⚠️ **Honest scope.** Two koota `World`s coexist only transiently, during the two-world atomic scene
swap, unlike #828's renderer axis where SceneView and GameView coexist permanently. This is a cover
gap first and only possibly a live defect; a row count is not severity.

⚠️ **A hand-traced census is a hypothesis. Running it moved a row.** #851 was filed READ-ONLY with
the verdicts reached by reading each declaration and hand-tracing the suites. Executed, the
`zoneEventBus` row was **wrong**: collapsing its `WeakMap` reddens 29 of 39 existing zone tests —
not through any isolation assertion, but incidentally, because the module-level singleton then
leaks subscribers between tests. `physicsEventBus` (32 tests) and `timelineEventBus` were confirmed
blind, as filed. Two lessons: **incidental cross-test contamination is not coverage** (reorder the
file and it may stop failing, which is why the deliberate assertion still earns its place), and a
census that has not been run belongs in the issue as a hypothesis, not as a count.

⚠️ **Mutate the way a careless FIX would, not by deleting the declaration.** Removing
`subsByWorld` outright also breaks `__clear`'s reference to it, so the suite fails to compile and
39 tests go red — which reads exactly like detection and is not. The valid mutation KEEPS the map
and ignores the key (`get(ONE)`/`set(ONE, …)`): it compiles, it preserves every other behaviour,
and it isolates the one property under test.

⚠️ **Two live instances is not enough if the TEST supplies both key and value.** A case that does
`registry.worlds.set(a, …)` then `registry.worlds.get(a)` asserts `Map.prototype`, not any
production keying — it cannot fail under the prescribed mutation, because the mutation changes code
the test never calls. Ask where the keying actually happens: for the physics registry it is at the
CONSUMERS (`physics2DSystem` / `physics3DSystem` take `registry.worlds` and do their own
`get(world)`/`set(world, st)`), so no test in the registry's own file can reach it. Test the thing
the module itself decides — for that registry, WHICH world each teardown path frees.

`physicsWorldRegistry` was flagged in the issue for escalation on the grounds that two koota
`World`s sharing one Rapier instance might be prevented somewhere. It is not: `worlds` is a
`Map<World, S>` whose `disposeAll` iterates it, and `onWorldSwap((next, old) => dispose(old))`
frees the old world's WASM while the new one is already live. **Two entries coexisting is a
designed state during the swap**, so a test is the right artifact — not an assertion at a
prevention point that does not exist.

### Shape (C): the test drives the WRONG COPY of the code

The two shapes above are about how many INSTANCES a suite builds. This one is about which **copy**
it runs. A file is a SOURCE that gets copied, bundled, staged or vendored into the place it
actually executes — and the verification reads the source, or rebuilds its own private copy, so a
stale or wrong SHIPPED artifact cannot fail it.

Closed instances, which are the same sentence with different nouns: **#909** (a git hook is copied
into the hooks dir, git runs the copy, the test spawned the source), **#685** (a re-vendored plugin
tarball is never EXTRACTED — `npm install` says "up to date" and the native build ships the old
plugin), **#215** (`bootstrap-game-deps` skips a project whose `node_modules` is stale, so "already
installed" is true and wrong), and **#945** across the Electron packaging pipeline.

**The rule: the test drives the artifact the shipping path produces.** Not a faithful rebuild of
it — the rebuild is a second implementation, and it drifts.

⚠️ **A rebuild does not merely fail to catch staleness; it drifts on its own.** `mcpBundle.test.ts`
re-ran esbuild with options its own comment said "mirror `build-electron.mjs`", and by the time
#945 was written the two had already diverged in two fields while staying green. The fix is a
**declaration-only** module both sides import (`scripts/mcpBuildOpts.mjs`) — declaration-only
because the builder runs `await esbuild.build(...)` at top level, so importing *it* for the options
would run a build as an import side effect.

⚠️ **Two claims, not one — do not collapse them.** "The shipped artifact runs" and "the bundle is
self-contained" need different setups: the first spawns `dist/index.js` where it actually lives,
the second builds into an isolated dir holding nothing else. The shipped file sits beside its own
`node_modules` and cannot make the second claim. Keep both cases; the mutation check that proves
they are different is *break the shipped file and watch only one go red*.

⚠️ **Where the check already exists, look at whether its VERDICT survives.** The sharpest form of
this class is not "nothing verifies it" but "something verifies it and throws the answer away".
Both toolchain stagers already ran their staged binary (`toktx --version`; `msdf-atlas-gen`, which
exits non-zero when dyld cannot resolve the dylibs the stager just relocated) and then
`console.warn`ed the failure and continued — so a binary that could not run was staged, signed and
shipped. Distinguish a **missing** optional tool (a legitimate graceful skip, `before-pack.cjs`'s
documented contract) from a **staged-but-broken** one (a bad artifact that must stop the pack).

The reference implementations of the right shape, for copying rather than re-deriving:
`vendorPluginsIntegration.test.ts` (a real `npm pack`, then `verifyInstalledMatchesTarball`
through the unmocked path), `packagedViteConfig.test.ts` (including its stale-leftover case), and the publish scanners, which run over `$STAGE` rather than the working tree.

⚠️ **A staleness check keyed on MTIME is the wrong instrument twice over.** The first version of
the MCP guard compared `dist/index.js`'s mtime against `src/index.ts`'s. The bundle inlines 22
source files plus `node_modules`, so touching any of the other 21 left it green with a genuinely
stale artifact — and an mtime comparison against a TRACKED file goes red after any
`git merge`/`checkout` that rewrites that file's mtime without changing what it produces, i.e. a
false red on the worker-merges-main flow, on a step `verify` does not even run. **Compare CONTENT**:
rebuild with the shared options into a tmpdir and diff the bytes. Any change to any input changes
the output and nothing else does. That rebuild is an *oracle for currency*, not a substitute for
the artifact — the shipped file is still the thing that gets spawned.

⚠️ **A byte comparison also tells you when a mutation was INVALID, and this matters for the bar.**
Two obvious-looking mutations of that guard left it green and were both correct to: a comment-only
edit, and adding an unused export (tree-shaken). Neither changes the artifact, so the bundle really
was current. Only a *reachable semantic* change reddens it. "The test stayed green" is a finding
about your mutation before it is a finding about the test.

⚠️ **A currency guard on a gitignored artifact taxes every clone, so say so where they read it.**
This one reddens `verify` on any clone that has ever packaged, whenever the MCP source changes —
including a change that arrives via `git merge` rather than one the session made. That was accepted
deliberately (owner, 2026-09-09) because the failure it prevents is silent and reaches real users,
and it is announced in `CLAUDE.md` § Tests rather than left to be discovered as a mystery red. The
fix is always `npm run build:electron`. If you add a guard of this shape, budget for the same
announcement — a gate that fails for reasons the reader cannot place gets disabled, not obeyed.

⚠️ **Know which runs your guard is actually live on.** `dist/` is gitignored and CI never runs
`build:electron`, so both shipped-artifact cases skip on every CI run — they are a
developer-machine guard, not a CI gate. Say that in the suite rather than letting the coverage be
overread; what actually stops a stale bundle shipping is that every packaging path re-runs the
builder.

⚠️ **What a text scan of a build script CANNOT tell you** is whether the artifact works — only that
the code says it will check. Where a hook is context-driven (`copy-three-addons`'s `appOutDir` /
`projectDir`) drive the real hook against a staged tree in a tmpdir. Where it writes to a fixed
repo path (the stagers' module-level `BIN_DIR`), a unit test would write into the checkout, so the
end-to-end claim belongs to `verify:packaged` and stays open until a pack fixture exists. Say which
half you covered.

#### (C1) The MUTATION CHECK drives the wrong copy — a worktree's symlinked `node_modules`

Every instance above is a *test* running the wrong copy. This one is worse, because it corrupts the
thing that validates every other entry in this file: **a mutation check run from a git worktree can
report a false green.**

A worktree created by `Agent(isolation: "worktree")` gets its `node_modules` as a symlink, so
`node_modules/@modoki/engine -> ../../engine/packages/modoki` resolves **back into the parent
clone**. Mutate `engine/packages/modoki/tests/helpers/<x>.ts` inside the worktree, run a suite that
imports it through the `@modoki/engine/...` specifier, and the suite loads the PARENT's unmutated
file. The mutation is real, the run is real, and the green is meaningless.

⚠️ **It fails in the safe-looking direction, which is why it is dangerous.** A false RED would be
investigated. A false green reads as "the mechanism is pinned" and retires the question.

Found 2026-09-12, reviewing #1119's label budget: a reviewer's first pass at mutating
`tests/helpers/authoredTextBudget.ts` appeared not to reach the wordweave suite at all, and every
helper-level finding had to be re-derived after rebuilding the link inside the worktree.

**So: before trusting any mutation check of a file imported through a package specifier, establish
which copy the suite loaded** — point the worktree's link inside itself, or run the check in the
clone. Two shapes are affected and one is not: a change under `engine/packages/modoki/**` imported
as `@modoki/engine/...` is exposed, a change to a test file the suite loads by relative path is not.
This is also the one case where "I ran the mutation and it stayed green" should make you check the
setup before concluding the test is vacuous — the usual inference runs the other way.

### Shape (D): the STUB or FAKE is more capable than the thing it stands in for

Shapes (A)-(C) are about how many instances a suite builds, and which copy it runs. This one is
about the **boundary** it replaces: a double that accepts inputs production rejects, or performs
behaviour the real dependency lacks, lets the test explore a region **production cannot reach** —
and everything asserted about that region is about the double.

Two surfaces, one mechanism, and they are easy to read as unrelated:

- **A stub that ACCEPTS more.** `editorActionRouter.test.ts` stubbed `resolveAssetPath` as the
  identity function. Production resolves only paths under an asset root's `urlPrefix`, so a native
  absolute path 404s and never reaches the staleness gate; through the identity stub it sailed
  through. The fixtures duly built paths with `path.join(os.tmpdir(), …)` — a shape production never
  produces — and the case was green on macOS (`/var/folders/…` survives the route's
  `startsWith('/') ? p : '/' + p`) and red on Windows (`E:\…` becomes `/E:\…` and matches nothing).
- **A fake that DOES more.** The mirror image, already in this repo's practice: a fake modelling
  behaviour the real dependency does not have makes the guard defend the bug.

⚠️ **The tempting fix is to widen PRODUCTION so the test's input works**, and it is wrong. Here that
was one line — teach the normaliser about `path.isAbsolute` — measured as a **no-op on POSIX**, so
it would have passed every check either platform could run and looked entirely safe. It would have
widened production to serve a path production cannot produce. **Fix the double, not the subject.**

**The rule: a double must be no more permissive, and no more capable, than what it replaces.** When
one is, the honest question is not "why does this fail on platform X" but "what is this test
actually exercising".

⚠️ Windows merely EXPOSED this one, because that is where the two path spellings differ. Do not
read it as a Windows lesson — `docs/windows.md` § Paths carries the platform instance and links
here for the general shape.

⚠️ **Not the same as Shape (E) below, and the remedies do not transfer.** (D) is a double that can
DO more than production; (E) is two sides of a comparison that MOVE together. A test can have both,
and making a double faithful does nothing for a dependent comparison.

### Shape (E): the two sides of the comparison SHARE A SOURCE

Shape (D) is about a double that can DO more than production. This one is narrower and commoner:
both sides of an assertion derive from the same thing, so **a fault in that thing moves both and the
comparison cannot express it**. Neither side need be unfaithful; they need only be dependent.

**Trigger — apply this when the EXPECTATION is COMPUTED rather than WRITTEN.** A literal expectation
cannot share a source with the subject; a computed one might, and that is the whole population. The
test is mechanical and cheap, and it selects every instance below while excluding almost everything
else in a suite. Do not run the procedure on every assertion — a bar people skip is worse than no
bar, because the next reviewer assumes it was applied.

Three instances, one mechanism (all 2026-09-09, all in one session, which is how the family was
noticed):

| instance | the shared source |
|---|---|
| `linkFixtureGuard`'s `${realTmp}-alias` | fixture and expectation built off the same base, so an unanchored `startsWith` passed under the very mutation the case existed to catch |
| `cleanPackagedCacheLinkGuard`'s exemption case | script and fixture both call `appSupportRoot()`, so a WRONG platform rule moves both and the case stays green |
| an `appSupportRoot` assertion authored through a bash heredoc | argument and expectation mangled identically by the transport (`'C:\\U…'` → `'C:\U…'`), so the case passed on a corrupted value |

⚠️ **The mutation bar INVERTS here, and this is the useful part.** For an ordinary mechanism, mutate
it and expect RED; a green is a test gap. For a shared source, **GREEN is the diagnostic** — it says
the two sides moved together, so the comparison is blind to a fault in that source. The procedure:

```
0. confirm the mutation actually MOVES the shared value   <- else the green means nothing
1. mutate the shared source
2. RED   -> the two sides are independent; done
   GREEN -> Shape (E): the comparison cannot see that source
3. demand an INDEPENDENT pin elsewhere
4. no such pin exists -> that is the gap
```

⚠️ **Step 0 is not optional, and the platform case makes it easy to skip.** A green also results when
the mutation never changed the value the test uses — mutate `appSupportRoot`'s **darwin** branch while
running on Windows and you get a worthless green, then go hunting for a pin against a source the test
never consumes. It is this file's own positive-control rule aimed at the mutation. **The cheap form
for a platform rule: mutate the branch you are standing on.** (Measured: mutating the *win32* branch
on Windows, with `APPDATA` set by the fixture's sandbox, is a real green and real evidence.)

**Step 3's independent pin, and where it must NOT come from.** Three forms that work — a literal that
IS the specification (`packagedAppPaths.test.ts`'s per-platform `appSupportRoot` cases; legitimate
for the same reason a golden file is), an anchor off a *different* base (the `path.sep`-anchored
`startsWith`), or a **read-back** that observes what actually landed (author via argv, then read the
file). ⚠️ It must not come from **the same generator**: a literal typed by the script that wrote the
value, or a read-back through the same mangling transport, is the shared source with an extra step —
and that is how a Shape (E) fix quietly becomes another Shape (E).

**A fourth instance, and the purest — because nothing was TRANSFORMED.** A gate log showed
`[FAIL]` on both lanes and `REAL_EXIT=0` beneath it, which reads exactly like a runner lying about
its status. Two runs were writing to one file: an earlier run, killed for memory, whose children
were still alive, and the real one. Both lines were **correct about their own run**; they were false
only when read as one document. The other three instances each involved a mangled value —
truncated, wrapped, collapsed — and can be dismissed as "be careful with pipes". This one has no
transformation at all, which is why it is the version to cite.

Its remedy is also the most reusable: **assert the artifact has exactly ONE summary.** That works
because it does not check the values at all — it checks that **the reading has one source**, which
is the property actually in question, and it generalises to any accumulating artifact two producers
can reach. (A timestamp check is the tempting alternative and a worse one: it compares values that
both producers can legitimately write.) Name each run's artifact uniquely and stamp the identity
INSIDE it — `verify-<sha>-<time>.log`, with the sha written into the file — so a shared file is
detectable rather than silently plausible.

**The fix for Shape (E) is to make one side a written literal; the trigger for Shape (E) is that
neither side is.**

⚠️ Related to Shape (D) but **not** foldable into it: (D)'s remedy is *make the double faithful*,
which does nothing here, where both sides may be perfectly faithful and merely dependent. A shape
whose remedy applies to half its instances is worse than two shapes.

### Shape (F): the EXEMPTION is keyed coarser than the ban it pardons (#1123)

A guard bans a per-occurrence pattern and pardons per FILE, so the row's scope is every occurrence
that file will ever contain rather than the one its `reason` argues for. The guard then cannot fail on
the thing it was written to catch, and no green run can show it — the mutation check is the only
instrument that sees it, and **the mutation has to ADD a second occurrence to an exempt file**, not
delete the only one. Deleting exercises the staleness arm instead, which is why this survived 16
guards.

Measured across 16 guards; 9 already had an exempt file holding more than its reason covered. The rule,
the shared helper (`assertExemptionLedger`) and the four arms it enforces live in
[verify-and-ci.md](verify-and-ci.md) § "Exemption GRAIN" — not restated here, because this page owns
the FALSIFIABILITY framing and that one owns the guard conventions.

⚠️ Related but distinct, and bending one fix across both serves neither: a guard with no non-vacuity
FLOOR (Shape G, below) has a fine population and greens on zero inputs, and a guard whose SCOPE is
narrower than its claim (#830, #1124) never reaches the population at all.

### Shape (G): the scan asserts no offences, and never that its MATCHER found anything (#1105)

A corpus scan collects offences and ends in `expect(offences).toEqual([])`. A regex that stops
matching produces the same empty list as a clean repo. A `repoFiles({ floor })` or a
`toContain(file)` check does not close this: those prove the FILES were enumerated, not that the
matcher yielded anything inside them. The first census found fifteen scans across ten files in this
shape. Its close-out sweep found eight more inside larger test files that already had a floor
somewhere, because a floor on one `it` covers nothing in the next. So census per `it`, not per file.
Which fix applies depends on whether a clean corpus has any positive yield:

- **The matcher has a legitimate yield** (citations, command blocks, `pkill` patterns, temp paths).
  Count what the matcher returned and floor that count inline:
  `expect(n, '<what> found — fix the matcher, do not delete this assertion').toBeGreaterThan(N)`.
  Count AFTER any `continue` that sits between the match and the check, so a skip that eats
  everything is caught too. Size `N` under the **public snapshot** wherever the scan runs there.
  The snapshot has no `.claude/skills` or `games/`, and ships no demos or a two-demo subset (see
  [verify-and-ci.md](verify-and-ci.md) on sizing floors to the snapshot). `cliToolchainRecipes`
  counts 458 shell blocks on a clone but roughly 120 in the snapshot's markdown, so its floor is 50.
- **A clean corpus yields ZERO** (a banned pattern: `BANNED`, the basename-reap rule, the
  Windows `-like` predicate, a chained geometry destroy). A floor here is impossible, because a
  correct run yields zero too. Put the matcher in ONE constant or function, and pin it with an
  accept/reject self-test built from the shipped defect string. `uiLengthFallback` already had
  this shape. `winProcessPredicates` only looked like it: its detection test carried its OWN copy
  of the regex, so an edit to the sweep's copy left the test pinning a regex nothing ran.
- **A completeness check skips the real instances before testing them.**
  `packagedLaunchIsolation` skipped every listed launcher and then asked the detector about the
  rest, so the detector never ran on a real launch. The positive control is the skipped set
  itself: every listed launcher must read as a launch.
- **An unparsed input is skipped instead of counted.** `buildTargetFloor`'s `if (m && …)` and
  `deviceAppIdentity`'s bare `catch {}` both skipped input they failed to read. Report the
  failure as an offence, and swallow only the absence the comment actually names. Converting the
  parse failure is NOT enough on its own. `buildTargetFloor` skipped on `existsSync` BEFORE the
  parse, so renaming the `CapApp-SPM` path segment still skipped every project and passed. The
  review caught it by mutation, and the file now floors the count of files it parsed too.
- **The yield is real but tiny.** Don't floor a population of one. The skills carry exactly ONE
  `§`-heading citation, so a floor there goes red when a skill is edited, and its message blames
  the matcher for it. Pin the regex with a self-test instead. Where a small floor is kept
  deliberately (`reapScoping`'s 2 and 1, all in one script), its message names the other way it
  can go red.
- **A `> 0` floor only catches a TOTAL wipe-out.** A second review broke part of each matcher
  and both floors stayed green. Deleting the array branch of `assetRefIntegrity`'s `stringValues`
  cut 27,600 strings to about 2,400, blinding the scan to every entity's trait refs, and `> 0` passed.
  In `sceneGuidUniqueness`, breaking the dominant `EntityAttributes.guid` read left 29 guids from the
  top-level fallback, enough to hold a combined total above zero. Size the floor to the corpus, gated on
  the private tree where it lives. When a read has a fallback, floor each path separately.

The mutation bar applies to the floor itself. The #1105 pass broke each of the fifteen matchers
once, then the eight from the close-out sweep and the three review fixes. Each time, exactly the
intended test went red. The one exception was the geometry anchor mutation, which also reddened
the corpus sweep that runs the same matcher.

⚠️ **Check that a real-corpus control finds something before relying on it.** The first idea for
`geometryRelease` was to count the helper's own sanctioned `destroy(true)` as a real-corpus
instance. It counted **0**: the helper's parameter is named `g`, which the name-based matcher
deliberately ignores, so the `inHelper` exemption exempts nothing today. Assuming the control
matched would have added a floor that could never pass.

### Shape (H): an ABSENT subject reads as a position (#1181)

`expect(s.indexOf(a)).toBeLessThan(s.indexOf(b))` looks like it checks that `a` comes before `b`.
But `indexOf` returns `-1` for a missing needle, and `-1` is less than every real position. So the
assertion also passes when `a` never appeared. `userDataDir.test.ts` did exactly this: its guard for
#1036 compared a formatter-wrapped `app.setPath(`, the left side read `-1`, and the check passed with
its subject gone. The hole sits on whichever side should be SMALLER:

- the actual of `toBeLessThan[OrEqual]`, and the expected of `toBeGreaterThan[OrEqual]`;
- `.not` swaps the two sides;
- binding the position first (`const at = src.indexOf(x)`) carries the `-1` into every later
  comparison;
- a constant bound is no protection: `expect(banner.indexOf(X)).toBeLessThan(8)` passes on `-1`.

The same holds for `lastIndexOf`, `findIndex`, `findLastIndex` and `search`, and for the boolean
spelling `expect(a < b).toBe(true)`.

**The census was 114 comparisons in 54 files, not the 21 the issue was filed with** — 102 converted,
and 12 in the four files `IN_FLIGHT_1179` pardons (below). A regex count
missed the mirror form, the variable-bound form (the majority), and every `expect(` a formatter had
wrapped across lines. The guard's first cut missed two more: it read only the ordering matchers, and
it prefiltered files by those matcher names. So `geometryRelease`'s boolean
`expect(body.indexOf('.unload(') < body.indexOf('.destroy(')).toBe(true)` was never parsed — and
that one was live. Its presence checks were whitespace-tolerant regexes, so a
`g.destroy(true); g.unload ();` order left it green 8/8 (close-out review, by mutation). A re-review
then found six more: comparisons inside `&&`/`!` (`renderFrameFlushOrdering`'s inline
`idx >= 0 && idx < other` pins, and `iapParkedCallRelease`'s `lineOf` conjunct), and a same-file
`const idx = (p) => list.findIndex(p)` helper (`chromeLetterbox`, live: a missing Canvas2D entity
passed). About half the sites already carried a
separate presence pin (`toBeGreaterThan(-1)`, `toContain(needle)`), so they were not vacuous today.

⚠️ **The position's pattern must match at least as broadly as the presence check — and as broadly as
the ORDERING question.** `geometryRelease` proved presence with `/\.unload\s*\(\s*\)/` and ordered
with `indexOf('.unload(')`, which disagree on a single space. The first repair then ordered against
`/\.destroy\s*\(\s*true\s*\)/` because that was the presence pattern — and a bare `destroy()` placed
ahead of `unload()` passed, where the old `indexOf('.destroy(')` had caught it (re-review, by
mutation). Presence asks "is `destroy(true)` there?"; the order asks "does ANY destroy come first?",
so the position comes from `/\.destroy\s*\(/`.

**The fix is where the index is PRODUCED, not a pin beside the comparison.** Import from
`@modoki/engine/testing/inOrder` (package tests: `../helpers/inOrder`):

- `expectInOrder(haystack, [a, b, c], label)`. Every needle must be present, and a missing one is
  reported by name before any position is compared. Then their first occurrences must strictly
  increase. Use it for needles searched from the start of a string or list.
- `found(index, what)`. It throws naming `what` for any negative or non-integer index, and otherwise
  returns the index. Use it for a position computed any other way: a `from` offset, `lastIndexOf`,
  a predicate `findIndex`, a regex `search`. For example,
  `const at = found(src.indexOf('x(', start), 'x( after start')`.

⚠️ **A presence pin does NOT satisfy the guard, on purpose** (owner, 2026-09-14). "Does the
`toBeGreaterThan(-1)` three lines up pin THIS operand?" is an adjunct question. A pin on a re-bound
variable, or on the same needle in a different haystack, reads identically, and an adjunct pardon is
the kind that fails open ([verify-and-ci.md](verify-and-ci.md) § Exemption GRAIN). So every site
migrated, including the already-pinned half, and the separate pin lines were deleted.

`engine/tests/architecture/indexOrderingAssertions.test.ts` enforces this over every test file,
on the AST: the four ordering matchers, and a relational comparison under
`toBe`/`toEqual`/`toStrictEqual(true|false)`, `toBeTruthy` or `toBeFalsy`. It parses every test
file with no content prefilter, because a prefilter that skips too much is invisible once the tree
is clean. It does **not** cover:

- ordering outside an `expect` (`if (a < b)`, `assert(a < b)`, a detector's own arithmetic);
- a position returned by an IMPORTED helper, or by a same-file helper whose body is anything but a
  concise expression or exactly one `return` statement (`{ const i = s.indexOf(n); return i; }` is
  not followed) — a same-file `const idx = (p) => list.findIndex(p)` IS followed (`chromeLetterbox`);
- a position that travels through anything but a plain `const`/`let` initialiser: destructuring
  (`const [a, b] = [s.indexOf(x), s.indexOf(y)]`), an element of a `.map(n => s.indexOf(n))` array, a
  later reassignment (`let r = 0; r = s.indexOf(x)`), an object property or method (`o.at`,
  `h.idx(x)`), a pass-through call (`wrap(s.indexOf(x))`, `Math.min(s.indexOf(x), 9)`). A full
  tracing probe over the real tree found no live site of any of these (re-review, 2026-09-14);
- a comparison inside a disjunction asserted true, or a conjunction asserted false — neither asserts
  any single comparison. A conjunct asserted true (`idx >= 0 && idx < other`), a disjunct asserted
  false, and `!` are followed, which is what caught `renderFrameFlushOrdering`'s inline pins;
- arithmetic on a raw index (`src.indexOf(x) + 1` reads `0` when absent).

⚠️ **An ABSENCE check is refused too if it is spelled as an ordering** — `expect(s.indexOf(x)).toBeLessThan(0)`
reads exactly like the vacuous shape. Spell absence as `expect(s.indexOf(x)).toBe(-1)` or
`expect(s).not.toContain(x)`; `found()` is for positions that must exist.

Its `IN_FLIGHT_1179` rows pardon four files that #1179 was rewriting on another branch at the time.

### Shape (I): the SETUP waits a CONSTANT, so the mechanism may never be exercised (#527)

A fixed `setTimeout` before an assertion is the well-known flake — it bets that a deferred effect
lands inside a hardcoded window, which is true on an idle machine and false under load. The half
that belongs in THIS doc is the other one: **the same constant in the SETUP fails green.**

`deviceConnectionReentrancy.test.ts` builds a 3-step interleaving — two teardowns suspended inside
one `client.disconnect()` — by racing two connects with `await new Promise(r => setTimeout(r, 20))`
between them. Nothing asserted that both had arrived. Under load the second never suspends, the
race does not form, and the #527 regression guard **passes without exercising #527 at all**. The
assertion is still there and still correct; it is just being evaluated against a world where the
hazard was never set up. That is the same "cannot fail" family as the rest of this doc, hiding one
level earlier than usual — the mutation check still goes red, because a mutation check runs on an
idle machine where the sleep is long enough.

Both halves have the same repair, and it is the ruling already recorded in `deviceConnection.test.ts`'s
"auto-reconnects over real TCP after an unexpected socket drop" — **poll, never sleep**, via
`vi.waitFor`:

- **In the setup**, poll on an observable of the step itself and then ASSERT it. Where the test has
  no such observable, a **pass-through spy** (one that counts and calls through, changing no
  behaviour) is a legitimate way to mint one. Record the count AT the moment it matters — a
  post-hoc read of a counter that keeps incrementing answers a different question.
- **In the assertion**, poll to a deadline and fail there. This is not a softened assertion: the
  effect that never happens still fails.

⚠️ **A poll's timeout is bounded from BOTH ends, and the upper bound is the one that gets
forgotten.** It must clear event-loop slop, and stay **below the product's own late-acting timers**
— otherwise the poll waits out a real defect and reports it as healthy. `deviceConnection`'s socket
closes late on three paths (`reconnectDelayMs` 1000ms, `pingIntervalMs` 2000ms,
`REQUEST_TIMEOUT_MS` 5000ms), so its leak assertions poll for **500ms**: a deadline at 5000ms would
have tolerated a socket that only closed via the RPC timeout. Name the ceiling in a comment, so the
next person raising the timeout to quiet a flake sees what they are spending.

⚠️ **Polling is not a free substitute everywhere — check which direction the wait serves.** The
same file's positive control reads a socket count that must be `> 0`. Polling for that returns on
the first sample, which can catch sockets already destroyed but not yet reaped; the sleep it
replaced was buying SETTLING time, and swapping it for a poll weakened the control it was meant to
strengthen. A wait that exists so a reading STOPS changing is not the same as one that exists so an
event ARRIVES.

## Gotchas

⚠️ **`onWorldSwap` is a re-export, and that is what makes this invisible.** It is defined in
`worldRegistry.ts` and surfaced through `world.ts`. A wholesale `vi.mock` of `core/ecs/world`
severs the module under test from the **real listener `Set`** — so calling `setCurrentWorld()` in
that suite fires **nothing**. "I drove a real swap" is not on its own evidence that anything ran.
This is why shape (A) cannot simply be pasted into a suite that mocks the world module, and why
shape (B) exists.

⚠️ **The reset export is not the wiring.** A suite that calls `clearAllInstancedBatches()` directly
covers the *function* and says nothing about whether a swap ever reaches it. Both halves need
saying — the two reference blocks are titled `not the test-only reset hook` for this reason.

⚠️ **A guard must be checked on its ACCEPT side too.** Tests proving a guard rejects bad input never
prove it accepts good input, and that half has hidden two defects in this repo already. For this
guard: confirm it goes red when a real fix is reverted, **and** that it stays silent on the
falsifiable files (`selectionRestore.test.ts`, the Hierarchy specs) and on suites that mock the
world module while registering no teardown of their own.

⚠️ **Scan dynamic imports, not just static ones.** The idiom here is `vi.doMock(...)` followed by
`await import('<subject>')` inside the test body. A scan reading only top-of-file `import`
statements misses most of the real hits.

⚠️ **A deliberate no-op is not a defect.** `focusManager.test.ts` and one block in
`uiTreeStore.test.ts` mock `onWorldSwap` to **throw on purpose**, testing a latch-ordering hazard.
Leave them alone; settle them through the guard's allowlist if they surface.

## Related

- [verification-harness.md](./verification-harness.md) — the deterministic headless harness these
  tests run inside (`createTestWorld`, the event journal, `stepSimulation`).
- [scene-loading.md](./scene-loading.md) — what a world swap actually does, and why per-scene
  resources are released wholesale at the swap.
- [doc-conventions.md](./doc-conventions.md) — including the `invalidatorsAreReachable` allowlist
  pattern this guard's trust model copies.
