# Engine runtime layers

The engine runtime (`engine/packages/modoki/src/runtime/`) is a **layered module graph**, not a
bag of topic folders. A module may only import *downward*. The direction is a declared contract,
enforced mechanically by ESLint zones and a cycle guard test — not a convention you have to
remember.

## What it is

Four layers. Each may import only the layers below it.

| Layer | Contents | May import |
|---|---|---|
| **L0 core** | `core/` — `core/ecs/` (world, registry, entity index, world transforms + the `transformPropagationSystem` render-path cache, trait registry), the deterministic primitives (`rng`, `journal`, `gameJournal`, `clock`, `getTime`, `timeSystem`, `playState`, `pipeline`, `projection`, `lateUpdate`, `stepSimulation`, `warnSuppress`), the cross-subsystem seams (`skeletalSeek`, `particleControlRegistry`, `timelinePreview`, `skeletalPreview`, `actionRegistry`, `curves`, `uiDirty`, `screenBounds`, `activeRenderer`, `currentScene`, `sceneSwapHooks`, `managerTypes`, `providerSlot` + the provider slots built on it — `textureProvider`/`textureRefs`, `assetPlumbing`, `shaderSchema`), the core traits (`Transform`, `EntityAttributes`, `Time`, the input action vocabulary `inputActions`), and the loose root files (`config`, `gameDefinition`, `appServices`, `instanceGuard`, `version`) | **nothing** |
| **L1 traits** | `traits/` — pure data schemas (koota traits + their accessors) | L0 |
| **L2 subsystems** | `account`, `animation`, `audio`, `iap`, `input`, `particles`, `physics`, `rendering`, `skinning`, `storage`, `sync`, `timeline`, `ui`, `zones` | L0, L1 — **not each other**, except the declared exceptions below |
| **L3 composition** | `loaders`, `scene`, `managers`, `assets`, `actions`, `harness`, `debug`, `store`, `ota` | everything |

`runtime/index.ts` — the public barrel — is the one deliberately unlayered file, and the only
special case the guards carry. It is what games, demos and the app import; keeping its exported
*names* stable is what lets the layers be rearranged underneath with zero downstream risk.

## Why the boundary exists

**ESM circular imports do not error.** They hand you `undefined` at module-evaluation time, and
*which* binding is `undefined` depends on which module the runtime happened to evaluate first. So a
reverse dependency — engine core importing a feature subsystem — is not untidiness, it is a silent,
order-sensitive correctness bug that appears when an unrelated import order changes (a new barrel
export, a lazily-mounted editor panel, a test importing one module directly).

That is not hypothetical here: the layering work started from a real "engine core depends on the
Animation system" failure. A measurement of the runtime graph found **20 cross-folder value-edge
cycles**, including `ecs ⇄ systems` (core depending on features) and trait schemas reaching up into
three different subsystems, rooted in one structural cause: `systems/` was a 47-file flat bucket
holding half of every subsystem (physics, audio, animation, timeline, zones, plus the genuine L0
primitives), so neither half of any subsystem was a unit you could draw a boundary around.

The layer rule makes the whole class impossible: a graph where every edge points downward through a
total order **cannot contain a cycle**. Enforcing direction is cheaper and more complete than
hunting cycles one at a time. `systems/` no longer exists — every file in it moved to `core/` (the
16 genuine L0 primitives) or its own feature folder (the other 31, into `animation`, the new
`physics`/`zones`, `audio`, `input`, `skinning`, `timeline`, `rendering`, `ui`). The contract is now
a hard ESLint error with no burn-down allowlist (`PERMANENT_ALLOWLIST` only — 6 named, permanent
exceptions), and the cycle baseline is down to **2 entries** (`loaders|rendering`, `managers|scene`
— see "Known residue" below for why both are likely graph-tooling artifacts, not real violations).

Two secondary payoffs: you can reason about what a subsystem can possibly touch by looking at its
folder, and a leaf subsystem becomes a candidate for extraction later without a dependency
archaeology dig first.

## Key files

| File | Role |
|---|---|
| `engine/eslint.config.js` | The machine-readable contract — `RUNTIME_LAYER_ZONES` (per-layer `no-restricted-imports` zones) + `PERMANENT_ALLOWLIST` (the 6 named, permanent exceptions; there is no burn-down list anymore). `npm run lint` is a CI gate |
| `engine/tests/architecture/moduleGraph.ts` | The graph parser — resolves relative specifiers on disk, tags each edge value vs type-only. Only walks `runtime/**`; blind to edges into sibling `src/` trees (see Gotchas) |
| `engine/tests/architecture/noNewCycles.test.ts` | Ratchet: the set of cross-folder value-edge cycles must stay a subset of `cycles-baseline.json` (2 entries — equality by construction, both no-new and no-stale). Only detects pairwise (2-folder) cycles — see Known residue |
| `engine/tests/architecture/barrelSurface.test.ts` | Pins the barrel's exported names (`barrel-surface-baseline.json`) so refactors can't change the public API |
| `engine/packages/modoki/tests/runtime/barrelLiveness.test.ts` | Every named barrel export is `!== undefined` — the specific signature of a circular-init miss (not merely falsy) |
| `engine/packages/modoki/tests/runtime/barrelImportOrder.test.ts` | Re-imports the barrel after entering through each of the ~130 modules it reaches, asserting liveness holds regardless of which module a caller (or test) imports first |
| `engine/packages/modoki/tests/runtime/crossSubsystemSmoke.test.ts` | One production-pipeline `createTestWorld` run crossing six subsystem boundaries in a single frame, plus a byte-identical-journal determinism check |
| `engine/packages/modoki/src/runtime/core/providerSlot.ts` | `createProviderSlot<T>(name)` — the injection primitive an L2 subsystem calls into instead of importing L3; see "The registration-inversion pattern" |

## How it works

### The two guards do different jobs

- **The ESLint zones enforce DIRECTION.** They count type-only imports too: `import type { X } from
  '../ui/bindings'` is still a layer violation, even though it erases at compile time. It is a
  design smell that a schema knows about a subsystem, and it will grow a value binding eventually.
- **The cycle guard test enforces ACYCLICITY, and ignores type-only edges.** A type-only edge
  compiles to nothing, so it physically cannot produce an ESM circular-init `undefined`. Flagging
  cycles that cannot break anything produces false alarms, and false alarms are how a ratchet gets
  switched off.

An edge is **type-only** only if *every* binding the statement introduces is erased. A mixed
statement — `import { makeAxes, type Axis }` — is a **value** edge, because TypeScript's
`verbatimModuleSyntax` can only drop a statement with no value bindings at all. This distinction is
load-bearing; it is what proved `traits/Input.ts → input/` was a real runtime cycle rather than the
harmless type crossing it had been assumed to be.

### Declared L2→L2 exceptions

"L2 must not import L2" is the rule; a small set of edges are declared legal because there is a real
one-directional tier order *inside* L2 — **producers → conductor → presentation**:

| Edge | Rationale |
|---|---|
| `rendering → animation` | The renderer is the presentation consumer of authored animation data — `scene3DSync` samples clips to pose the mixer/bones. `animation/` never imports `rendering/`. |
| `rendering → particles` | The renderer owns particle-backend instantiation and lifetime (`particleSync` builds an `IParticleBackend`); particle definitions are data it consumes. |
| `rendering → skinning` | Same shape — the renderer uploads the skinned vertex buffers the skinning pass produces. |
| `timeline → animation` | A Director sequencing animation tracks *is* the timeline's job; timeline is the conductor tier. Nothing in `animation/` imports `timeline/`. |
| `timeline → audio` | Same, for audio tracks. |
| `skinning → animation` | The 2D skin pass composes on top of the deform pass's output — deform runs first, so skinning is downstream. |

Everything else between two L2 folders is a violation. `particles → rendering`, `skinning →
rendering`, `audio → ui`, `input → ui`, `animation → ui`, `ui → rendering`, and `rendering → ui`
were all real edges at P1's measurement and were deliberately **rejected** as exceptions rather than
blessed — each one was inverted (by registration, injection, or a type move) in P7, so none of them
exist today. The one exception the original plan proposed and later rejected outright:
`systems → skinning` (name-similarity only — `skin2DSystem` was just a misfiled file, resolved by
P6's move into `skinning/` itself, not by inversion).

### The registration-inversion pattern

`loaders → animation` is fine (L3 → L2). It is `animation → loaders` that is wrong — a subsystem
asking the wiring layer for something. The fix is almost never a shim; it is to **invert the edge by
registration**, a pattern the codebase already uses in several places:

- **`traitRegistry`** (`core/ecs/`) — traits register their editor metadata; the editor reads the
  registry instead of importing every trait module.
- **`particleControlRegistry`** — `timelineSystem` (a deterministic sim system) writes a pending
  `restart`/`pause` keyed by entity id; `syncParticles` (the render layer) drains it. Neither
  imports the other; the registry is the neutral meeting point, and it lives in L0 precisely because
  both ends are L2.
- **`skeletalSeek`** — identical shape for "the timeline scrubbed, re-pose this rig".
- **`physicsWorldRegistry`** — a dimension-agnostic `createPhysicsWorldRegistry<S>(freeState)` that
  owns the per-world map and the Stop/world-swap teardown hooks, so 2D and 3D physics share the
  lifecycle without either importing the other.
- **`controlSpawnRegistry`** — timeline control tracks publish the entities they spawned so teardown
  paths can clear them without a cycle back through `timelineSystem`.

The shape is always the same: **a small L0 module holding a map plus register/take/clear, with a
world-swap reset.** The producer writes, the consumer drains, and the type flowing through it is a
plain local union or a generic — never a subsystem's own type, or you have re-created the edge.

The two other inversions to reach for when registration does not fit:

- **Injection, via `core/providerSlot.ts`** — the L3→L2 sibling of the registries above, built for
  breaking a subsystem's need to call something L3 *owns* (asset resolution, cache lookups), rather
  than to exchange state with another L2 subsystem. `createProviderSlot<T>(name)` returns
  `{provide(impl), get(), reset(), isProvided()}`; the L3 loader that owns the real implementation
  self-registers at module-evaluation time (`loaders/registerProviders.ts` imports every
  provider-owning loader for side effect; `runtime/index.ts` imports it once), and the L2 subsystem
  calls `.get()` instead of importing the loader directly. Per the owner's D5 decision, an
  unprovided slot **warns once and returns a neutral value — it does not throw**, so a headless unit
  test that deep-imports one L2 module, or a DCE'd playable-ad build that drops a provider, degrades
  instead of crashing. **One slot per type**, owned by whichever L2 folder owns that type — eleven
  slots exist today (`particles/particleDefProvider`, `core/textureProvider` +`core/textureRefs`,
  `core/assetPlumbing`, `animation/assetProviders`, `audio/audioAssetProvider`,
  `skinning/rig2dProvider`, `rendering/materialProvider`, `physics/meshColliderProvider`,
  `timeline/assetProvider`, `core/playerTierStore`, `core/probeVerdictStore`) — never one god registry, which would satisfy the linter while
  re-creating the original hairball behind a single name.
- **Move the type down** — if a subsystem type is really the trait's own schema, move it into
  `traits/` (or `core/`) and let the subsystem import it from there. `UIActionBinding` belongs to
  `traits/UIAction.ts`, not to `ui/bindings.ts`; `CurvePoint` is a generic curve type, not a
  particles type.

### The permanent allowlist

The contract has no burn-down list anymore — `RUNTIME_LAYER_ALLOWLIST` (59 files / 133 specifiers at
its P1 peak) was fully deleted in P8. What remains is `PERMANENT_ALLOWLIST` in
`engine/eslint.config.js`: **6 named, permanent exceptions**, each with its own rationale comment,
not a TODO:

- 5× `core/ecs/{entityIndex,entityUtils,world,worldTransform,transformPropagationSystem}.ts` →
  `../traits` — resolves to `core/traits/EntityAttributes.ts`, an intra-L0 edge. The zone matcher
  works on literal specifier text, not a resolved path, so it can't tell "reaches the real L1
  `runtime/traits/`" apart from "reaches the L0-internal `core/traits/`" — this is a permanent
  limitation of the matcher, not a violation waiting to be fixed.
- `rendering/sceneLightUniforms.ts` → `../../three` — a genuine Three trait (`Light`), consumed by
  the Three renderer. `rendering/` is exactly what is meant to import Three traits.

A reverse dependency cannot land today without deliberately editing this list.

## Gotchas

- **`no-restricted-imports` patterns cannot be negated.** ESLint matches them with gitignore
  semantics, so `../ui` already covers `../ui/actionRegistry` — but `!../ui/actionRegistry` is
  *not* honoured (verified; the object `group:` form does not help either, and extglob
  `../ui/!(actionRegistry)` does not either). That is why allowlist entries exempt at **folder**
  granularity and name the exact specifier in a comment. Read the comment, not just the `allow`
  array, when burning an entry down.
- **Glob matching is case-insensitive.** A pattern `./input` would falsely flag
  `traits/index.ts`'s `export … from './Input'`. The config deliberately omits the `./<folder>`
  shape for this reason.
- **`moduleGraph.ts` only walks `runtime/**` — an edge into a sibling `src/` tree is structurally
  invisible to the cycle ratchet.** P5's `runtime ⇄ src/three` cycle (closed by relocating
  `worldTransforms`) never appeared in `cycles-baseline.json` at all — only the ESLint
  `THREE_ESCAPE` zone covered it. Don't read "the cycle count didn't change" as "nothing changed";
  check the ESLint zones too for anything reaching outside `runtime/`.
- **The cycle guard only detects pairwise (2-folder) cycles, not longer chains.** A 3+-folder cyclic
  chain (A→B→C→A with no 2-node sub-cycle) would pass `noNewCycles.test.ts` undetected — confirmed
  live with a synthetic 3-node edge list during P10's review. Real cycle detection (Tarjan/DFS)
  would need to replace the current reciprocal-pair check to close this; not done, since no such
  chain has been found in the actual graph.
- **A provider slot (`core/providerSlot.ts`) warns once and returns a neutral value if nothing ever
  called `.provide()`.** It does not throw. If a subsystem's provider silently returns `null` in
  production, check that `loaders/registerProviders.ts` is actually reached — a DCE'd/playable-ad
  build that strips the owning loader will degrade this way by design (D5), not just at a genuine
  wiring bug.
- **A barrel import can drag in a value edge you did not intend.** `import { Transform } from
  '../traits'` pulls the whole `traits/index.ts` module graph, not just one file. Check the emitted
  graph (`buildRuntimeGraph()`), not the source line.
- **A file move can silently duplicate a module-level singleton.** If a module holding a
  `Map`/`Set`/counter ends up reachable by two different specifiers, you get two copies and a
  catastrophic, silent behaviour change. Registries are exactly this shape — after moving one,
  verify identity, not just that the tests pass.
- **`worldTransforms` is L0** — `core/ecs/transformPropagationSystem.ts`. It lived in
  `src/three/systems/` until P5 of the module-boundaries work, which forced ten runtime subsystems
  (2D + 3D rendering, physics 2D/3D, zones, UI) to import out of the runtime tree. Using THREE for
  matrix math is not the same as being a renderer concern — its L0 sibling `worldTransform.ts` does
  the same composition with the same math. What is left in `src/three/` is the three genuinely
  Three-specific traits (`Light`, `Environment`, `Fog`), consumed only by `rendering/`; those two
  `../../three` exemptions are permanent, not burn-down. The move relocated the cache — it did NOT
  change who is authoritative for a world pose, so the world-transform gap in
  [architecture.md](./architecture.md) is unchanged by it.

## Settled decisions (do not re-litigate)

Five judgment calls the owner made during the design phase, kept here since a future subsystem will
run into the same shape of question:

- **D1 — L0 is a nested `core/`, with `core/ecs/` inside it.** Not a flat `core/` sibling to `ecs/`
  and not "grow `ecs/`" — its name would stop describing its contents, the exact drift that turned
  `systems/` into a bucket. The layer is spelled in the import path itself (`../core/rng`), so the
  lint rule and a reader agree without consulting a table.
- **D2 — type-only edges are edges, but at the back of the queue.** They erase at compile time and
  carry zero runtime risk, so the cycle guard ignores them (flagging what can't break anything
  produces false alarms) while the ESLint zones still count them (they're a design smell that will
  grow a value binding eventually). This is why moving a type "down" a layer is always available as
  a fix even when the type itself never runs.
- **D3 — `assets/`/`store/` are plain L3; the five loose root files live in `core/`.** Both folders
  are pure sinks or single-file leaves needing no special treatment. The five root files
  (`config`, `gameDefinition`, `appServices`, `instanceGuard`, `version`) are all leaves too —
  leaving them loose at `runtime/` root (the rejected option) would have preserved exactly the kind
  of un-owned, importable-from-anywhere space where the next `systems/` starts to form.
- **D4 — `rendering/{Scene2D.tsx,Scene3D.tsx,scene3DSync.ts,envPmrem.ts}` are reclassified L3 in
  place, not moved.** They structurally compose scene data + loaders + subsystems into a rendered
  frame — L3 composition wearing an L2 folder path — but physically moving them would change
  `engine/app/App.tsx`'s deep import of `Scene3D`, a public-surface change. Implemented as a
  file-level ESLint carve-out (`L3_RECLASSIFIED_FILES`), the same mechanism used pre-P6 for the L0
  primitives still sitting in `systems/`. `envPmrem.ts` joined in #739: it registers itself with
  `loaders/meshTemplateCache.ts`'s env-dispose hook registry at module scope so a 2D-only build
  (which never imports it) never pulls in `three/webgpu`.
- **D5 — an unprovided provider slot warns once and returns a neutral value; it does not throw.**
  See "The registration-inversion pattern" above — this is what keeps headless unit tests and
  DCE'd playable-ad builds from crashing on a missing provider.

## Known residue (not blockers, recorded so they aren't rediscovered)

P10's adversarial review confirmed these; none were fixed because each is genuinely cosmetic or a
tooling-precision gap, not a live bug. Prioritize the tooling gaps over the cosmetics if anyone picks
one up:

- **`cycles-baseline.json`'s `loaders|rendering` entry is very likely a `moduleGraph.ts`
  folder-granularity artifact**, not a real violation — both directions resolve to legal edges once
  D4's file-level L3 reclassification of `Scene2D.tsx`/`scene3DSync.ts` is accounted for, which the
  parser's per-folder node model can't see (the same class of blind spot P5 found for `src/three`).
  A real fix needs `moduleGraph.ts` to special-case `L3_RECLASSIFIED_FILES` in its node identity.
- **The pairwise-cycle blind spot** described in Gotchas above (`crossFolderValueCycles()` doesn't
  catch 3+-folder chains) is the other tooling gap worth closing before trusting the guard fully.
- **`ui/UINode.tsx`'s `lazy(() => import('../rendering/Canvas2DMount'))` is a real `ui → rendering`
  edge invisible to both the ESLint zones and the cycle guard** (neither inspects dynamic
  `import()` — a deliberate exclusion for the ESM-`undefined`-binding risk this plan targets, which
  incidentally also hides a real layer-direction smell). Predates this refactor (2026-07-18); a DCE
  reason, not an oversight, but never revisited since.
- **`loaders/registerProviders.ts`'s `timelineAssetProvider.provide(...)` uses an `as never` cast**
  to bridge the slot's declared `{ entities: unknown[] }` shape against the real
  `PrefabFileEntry[]` — a future shape change to `PrefabFileEntry` wouldn't get a compiler error at
  this seam.
- **`core/assetPlumbing.ts` bundles two zero-dependency pure values** (`assetUrl`,
  `ASSET_FETCH_INIT`) with its one real network-bound member (`fetchShaderManifest`) — the pure two
  could have relocated straight into `core/` with no provider-slot indirection, the way C9 did for
  `core/textureRefs.ts`.

## Adding a new subsystem without violating the contract

1. **Create one folder** at `runtime/<name>/` and add its name to `L2_FOLDERS` in
   `engine/eslint.config.js`. One subsystem = one folder — do not split it across a feature folder
   and a shared "systems" bucket. That split is what produced the original hairball: neither half
   was a unit you could draw a boundary around.
2. **Depend downward only.** Your subsystem may import `core/` and `traits/`. If you find yourself
   reaching for `loaders/` (to fetch an asset), `scene/` (to ask what is loaded), `managers/` (to
   raise an event), or another subsystem — stop; that is the contract telling you the dependency is
   backwards.
3. **Put your traits in `traits/`**, and keep them pure data + accessors. A trait that imports your
   subsystem's logic is an L1→L2 violation. If your subsystem needs a shared vocabulary the traits
   also need (an enum of actions, a curve type), that vocabulary is L0 — put it in `core/`.
4. **Invert the upward edges.** If you need to *exchange state* with another L2 subsystem, use a
   small L0 registry (register/take/clear, world-swap reset if keyed by entity id). If you need to
   *call something L3 composition owns* (an asset resolver, a cache lookup), use
   `core/providerSlot.ts` instead — the L3 loader self-registers, your subsystem calls `.get()`, and
   an unprovided slot degrades to a warning rather than a crash.
5. **Register your systems, do not import a pipeline of them.** `registerSystem(name, fn, priority)`
   with a `SYSTEM_PRIORITY` tier; the pipeline never learns your subsystem's name at compile time.
6. **Export through `runtime/index.ts`** — that barrel is the public API. Adding names is fine;
   the barrel-surface test only fails on a *change* to existing ones, and it will tell you to update
   the baseline.
7. **Run `npm run lint` and `npm test`.** The zones and the cycle guard will tell you immediately if
   step 2 or 4 went wrong — which is the whole point of having them.

## Related

- [architecture.md](./architecture.md) — the runtime architecture the layers organize (world
  registry, traits, render layers, frame driver) and the world-transform gap
- [engine-concepts.md](./engine-concepts.md) — the vocabulary: entity, trait, system, projection,
  manager, store, service
- [managers-and-systems.md](./managers-and-systems.md) — the five logic roles and when to reach for
  each
- [verification-harness.md](./verification-harness.md) — the determinism primitives that live in L0
  (clock, seeded RNG, journal, `stepSimulation`)

## P12 — package promotion (decided)

**No subsystem is promoted to a workspace package.** `@modoki/engine` stays the one extracted
package, and it stays the whole engine. This was the open question the layering work deferred until
boundaries were real; they are now, and the answer is no. Recorded here so it is not re-litigated.

**Leaves exist — that part of the hypothesis held.** Eleven of the fourteen L2 folders have zero
static edges to another L2 folder, zero to L3, and zero out of `runtime/`: `account`, `animation`,
`audio`, `iap`, `input`, `particles`, `physics`, `storage`, `sync`, `ui`, `zones`. ⚠️ An external npm
dependency does not disqualify a leaf — `physics` imports `three` and `koota` and is one; the
property is about edges INSIDE `runtime/`. The
other three are the declared producer→conductor→presentation exceptions (`rendering`, `timeline`,
`skinning`) and are structurally ineligible by design. A provider slot does not disqualify a leaf —
`animation`, `audio`, `particles` and `physics` each own one, but the slot is L0 machinery and the
L3 loader pushes into it, so the subsystem's own import list still only reaches `core/`. One caveat:
`ui` is a leaf on the static graph only; its `lazy(() => import('../rendering/Canvas2DMount'))` is a
real `ui → rendering` edge that neither guard sees (see Known residue).

**A package boundary would catch nothing the current guards miss.** Reverse and lateral imports are
already hard ESLint errors (`npm run lint`: 0 errors); acyclicity is ratcheted at 2 baseline
entries; the public surface is pinned by `barrelSurface.test.ts`, and deep imports from
`games/`/`demos/` into an L2 folder measure **zero** — the barrel is the only surface anyone
downstream uses. Nor would a package stop them: `@modoki/engine`'s `exports` map resolves straight
to `.ts` source consumed by Vite, so a deep relative path still resolves — the same weakness that
made "packages first" the wrong opening move. The one gap a package *also* fails to close, noted
honestly: a newly invented `runtime/<foo>/` folder that is added to neither `L2_FOLDERS` nor
`L3_FOLDERS` matches no zone and is therefore unrestricted. The fix for that is a default-deny zone
or the checklist step above, not a package.

**The cost is concrete and larger than it looks.** No leaf is self-contained: every one relative-
imports `../core/**` and most `../traits/**` (`physics` 13+13 distinct specifiers, `ui` 12+4,
`animation` 8+9), and a package cannot `../` into a sibling package's `src/` — so promoting one leaf
forces promoting `core/` and `traits/` first, three packages minimum for one subsystem. The editor
deep-imports 31 files / ~53 distinct specifiers into eight of these folders; a package boundary
either breaks all of them or forces an `exports` map that freezes today's internal file layout as
public API — the exact coupling the barrel was built to avoid. Each package would restate its own
externals (`particles`: three + `three/tsl` + `three/webgpu` + pixi; `physics`: both rapier-compat
builds + `poly-decomp-es`; `ui`: react + zustand; `storage`: `@capacitor/*`), and `ui/UINode.tsx`
additionally reads the build-time define `__MODOKI_MODULE_RENDER2D__` (the playable-ad DCE toggle),
which a standalone package build would have to replicate. Finally, real enforcement needs TS project
references, and this repo typechecks as **one program** (`tsconfig.app.json` `noEmit: true`,
`composite: false`) shipping **one** web/Electron artifact; flipping to composite means per-package
`.d.ts` emit and build ordering bought for a bundle nobody installs piecewise. And two "leaves" that
later need each other become a circular *package* dependency — where the same situation inside one
package is a one-line `L2_ALLOWED` entry with a rationale comment, which is how all six existing
L2→L2 edges are handled.

**What would make this worth revisiting:** a genuine second consumer — something that must install
one subsystem *without* the engine (a headless server stepping `physics/` alone, a second renderer,
or per-subsystem npm publishing on independent versions). Until then the enforcement is free and the
packaging is not. Preconditions if it ever comes back: the candidate must stop being deep-imported
by the editor, and `core/` + `traits/` must be promotable with it.
