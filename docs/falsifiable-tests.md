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

### Three shapes already exist for the World axis — copy one, do not mint a fourth

`journal.ts`, `rng.ts` and `worldRegistry.ts`'s `entityIndices` each have a real two-`World` test
(`keeps a separate, independently-ticked trace per world` · `is isolated per world` · `creates a new
Map for a new world`). ⚠️ **`worldRegistry.ts`'s `guidIndices` is the instructive near-miss**: its
test *does* build two worlds and register the same guid in both, but asserts only that the CURRENT
world resolves correctly. Under a shared map the second registration simply overwrites the first and
that assertion still passes. **Two instances is necessary, not sufficient — the assertion has to
interrogate the STALE one.**

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
