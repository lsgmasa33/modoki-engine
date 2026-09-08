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
