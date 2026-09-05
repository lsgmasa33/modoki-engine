# Particles

A renderer-agnostic particle runtime: one `.particle.json` effect schema driven by three
interchangeable backends — a deterministic CPU sim + Three.js billboard, a TSL GPU-compute
sim for very high counts, and a PixiJS 2D backend — all behind one interface.

## What it is

A particle **effect** is pure data: a `ParticleEffectDef` (the `.particle.json` payload,
`version: 1`) describing emission, an emitter shape, per-particle spawn values, over-life
curves/gradients, and optional forces/collision/trails/sub-emitters. It knows nothing about
how it's simulated or rendered. An ECS entity attaches an effect via the thin `ParticleEmitter`
trait (an asset ref + per-instance knobs); a per-frame sync layer creates a backend **handle**,
steps it, and mounts its render object.

The runtime is layered so the **schema is independent of any sim/render backend** (the whole
reason a GPU-compute backend could be added later without touching the schema, the editor, or
saved assets). Three backends implement the same contract:

- **`CpuTslBackend`** (Three.js, default) — the pure `CpuParticleSim` writes struct-of-arrays
  into a `SpriteNodeMaterial` instanced billboard (or instanced mesh). Full feature set,
  deterministic, headless-testable.
- **`GpuComputeBackend`** (Three.js) — a TSL compute-shader sim for 100k+ particles. State lives
  in GPU storage buffers; a compute pass integrates + respawns. A subset of features.
- **`PixiParticleBackend`** (2D) — reuses the *same* `CpuParticleSim`, copying its outputs onto a
  PixiJS v8 `ParticleContainer`. Renders into the Canvas2D layer.

A `RouterParticleBackend` (the exported `particleBackend`) fronts the two Three.js backends and
picks CPU vs GPU per effect. The 2D path is a separate singleton (`pixiParticleBackend`), selected
by scene hierarchy — an emitter with a `Canvas2D` ancestor renders 2D, everything else 3D.

## Key files

- `runtime/particles/types.ts` — the `ParticleEffectDef` schema + the `IParticleBackend(Core)`
  interface, plus the shared scalar helpers every backend calls (`clampSimDt`, `seekSteps`,
  `spriteFrameIndex`, `renderStructuralKey`, `gpuDefSupported`).
- `runtime/particles/cpuSimulator.ts` — `CpuParticleSim`: the renderer-free, deterministic SoA
  pool. Emits, integrates, ages, recycles; writes `ParticleOutputs`/`TrailOutputs`.
- `runtime/particles/cpuTslBackend.ts` — Three.js CPU backend: wraps `CpuParticleSim` in a stable
  `THREE.Group` + billboard/mesh + trail + sub-emitter children.
- `runtime/particles/gpuComputeBackend.ts` — Three.js GPU backend: storage buffers, TSL init +
  update compute kernels, over-life LUTs, instanced render.
- `runtime/particles/particleBackend.ts` — `RouterParticleBackend`: routes each effect to CPU or
  GPU, swaps the inner sim under a stable wrapper on `setDef`.
- `runtime/particles/simSpec.ts` — canonical noise/force/drag/radius formulas the CPU sim *calls*
  and the GPU kernel *transcribes* to TSL (the single source of truth for shared math).
- `runtime/particles/emitterShapes.ts` · `colliders.ts` — shared `resolveShape` / `resolveCollider`
  + `collide`: flatten authoring config to a runtime form both backends sample identically.
- `runtime/particles/pixiParticleBackend.ts` — the 2D backend (`IParticle2DBackend`); the 2D twin
  of `cpuTslBackend`, driving the same sim onto a Pixi `Container`.
- `runtime/traits/ParticleEmitter.ts` — the ECS trait (effect ref + `playOnStart`/`playbackSpeed`/
  `speedScale`/`isVisible`).
- `runtime/rendering/particleSync.ts` · `particleSync2D.ts` · `particle2DRouting.ts` — the
  per-frame ECS→backend bridges for 3D and 2D, and the shared "which path owns this emitter?" rule.
- `runtime/loaders/particleCache.ts` — loads/caches `.particle.json` by GUID/path and
  `normalizeParticleDef` (fills defaults, clamps min≤max / positive pool / finite numbers, migrates
  legacy fields).

## How it works

### The backend contract

Every backend implements `IParticleBackendCore`: `create(def) → handle`, `update(handle, dt)`,
`setTransform`, `setDef` (hot-swap for live editor edits), `play`/`pause`, `restart`, `seek`,
`dispose`, plus optional `setSpeedScale`. The one renderer-specific method is split out — Three.js
backends add `getObject3D(handle)` (`IParticleBackend`); the 2D backend adds `getContainer(handle)`
(`IParticle2DBackend`). Each handle owns a **stable wrapper object** (a `THREE.Group` / Pixi
`Container`) that the sync layer mounts once; structural rebuilds swap the *inner* mesh/container
inside it, so the scene graph never needs re-wiring — even when the router flips CPU↔GPU beneath
the same wrapper.

### Routing (3D: CPU vs GPU)

`RouterParticleBackend.pick(def)` chooses GPU only when **all** hold (`gpuEligible`):
`def.simulation === 'gpu'`, the active renderer is the **native WebGPU backend** (`isWebGPUBackend`;
unavailable under `forceWebGL`), and `gpuDefSupported(def)` — which requires `emission.fillPool`,
**no** trails, **no** sub-emitters, **≤ `MAX_GPU_FORCES` (8)** force fields, and a non-`polyline`
shape. Anything else transparently falls back to the CPU sim (which honors `fillPool` identically,
so the look matches). A misconfigured `simulation: 'gpu'` effect logs an info line **once per
effect** and runs on CPU.

### Routing (2D vs 3D)

`particle2DRouting.ts` is the single arbiter: an emitter renders in 2D iff it has a `Canvas2D`
ancestor (walking `EntityAttributes.parentId`) — the same rule `Renderable2D` uses. `particleSync`
(3D) and `particleSync2D` (2D) both consult it, so exactly one path owns each emitter per frame;
`particleSync` skips any emitter with a Canvas2D ancestor and disposes a stale 3D handle if the
emitter was reparented into 2D. The asset's `space: '2d' | '3d'` field is an **editor-only** preview
hint (which canvas + property sections the Particle Editor shows) — it does **not** affect runtime
routing.

### The CPU sim

`CpuParticleSim` keeps a dense struct-of-arrays pool (`px/py/pz`, `vx/vy/vz`, `age`, `life`, …);
the first `count` entries are alive, death is a **swap-remove**. Each `step(dt)`: emits (rate
accumulator + bursts, or `fillPool`'s one-time staggered fill + in-place respawn), integrates
(`gravity + noise + forces`, then semi-implicit `drag`, then optional `collide`), ages, and writes
`ParticleOutputs` (`offsets/scales/colors/opacities/rotations/frames`) for alive particles.
Deterministic given a seed (`makeRng`), so it's unit-tested with no renderer. `worldSpace` bakes
each spawn through the emitter matrix at birth (position as a point, velocity as a direction) so
particles stop following the emitter after birth; local-space instead moves the render group.
Trails keep a per-particle position-history ring; sub-emitters are depth-1 (a child's own emission
and sub-emitters are stripped — it's driven purely by injected bursts at the parent's birth/death
events).

⚠️ **A fresh emitter that declares a sprite texture starts HIDDEN, and this is not cosmetic (#338).**
`build()` constructs the render objects **and** a new `CpuParticleSim` together, and
`loadTextureFor` calls it a **second** time when the texture arrives — a sprite texture changes the
material (textured quad vs. the radial soft-circle alpha), so the billboard cannot simply be
re-pointed. That second build **discards every live particle and resets the sim clock to 0**,
which the owner saw as particles "spawning for 1-2 frames, resetting, and continuing".

It only bites the FIRST activation, and the reason is worth knowing: `loadTexture3D` is async even
on a cache **hit**, but a hit resolves on a microtask — before the next rAF — so a warm texture
rebuilds before anything is drawn. A **cold** one takes a frame or two, and that rebuild is
visible. Which is also why restarting always looked clean.

So the throwaway build happens off-screen and the emitter is revealed on the rebuild that has the
texture: one visible start, no reset, and the sim the player sees begins at t=0 (a burst authored
at 0 still fires on the frame they first see). **The wait is BOUNDED** —
`TEXTURE_WAIT_BUDGET_MS` (1500 ms of wall clock, read through `rawNow()`), spent before the play
gate so a paused emitter cannot be stranded by it. Hiding until the texture lands is right for a
showcase and wrong for gameplay VFX: a hit spark showing *nothing* while a large or cold KTX2
transcodes reads as a dropped effect, so past the budget the emitter is revealed untextured and
picks up its sprite on arrival. A failed load reveals too — a 404 must never hide an emitter
forever, and neither may a ref that `setDef` swaps away mid-load (that path starts no replacement
load, so it reveals on the way out). A `setDef` that swaps to a NEW sprite re-arms the wait, because
the rebuild it triggers is untextured.

⚠️ **This budget was `TEXTURE_WAIT_BUDGET_FRAMES = 6` and both the number and the UNIT were wrong —
that is the whole of #338's reopen.** The reasoning for frames was "a slower device drawing slower
frames should get proportionally longer to load", which is backwards: what is being waited on is a
network fetch plus a transcode, and neither cares about the frame rate (a 120 Hz desktop got 50 ms,
a 30 Hz phone 200 ms, for the same download). Measured on the deployed
`modoki-engine.com/particle-demo`, cold, in a fresh Chrome window: the sprite landed **~120 ms**
after the emitter was created and the budget expired at **~80 ms**, so the very first station
flashed on every cold load — invisible from the editor and from any warm reload, because a cached
texture resolves on a microtask. See the reveal-is-not-a-degradation note below for why losing that
race is so loud.

⚠️ **Revealing untextured is the WRONG MATERIAL, not a lesser one — and describing it as a mild
degradation is what let the budget stay too small.** An effect that declares a sprite never draws
the radial fallback in steady state, and the fallback is far brighter per particle: a full-quad
`radialAlpha()` at opacity 1, where an authored fire or dust sprite is mostly near-transparent.
Measured on `demos/particle-demo` with texture responses held back at the server (CDP screencast →
`ffmpeg signalstats` per-frame mean luma): the Fireball station reads **69 untextured at 61
particles** and **49 textured at 292** — roughly 15x the light per particle — and the 40k GPU Nebula
pool reaches **241 of 255, a full-screen white wash**. Before/after over the same experiment: 434
untextured-visible frames and peak luma 241 → **0 frames and peak 121** (Nebula's own legitimate
steady state) with an 800 ms delay, while a 3000 ms delay still falls back rather than hiding
forever. That is #338's "burst": not extra particles, the wrong material.

⚠️ **What the budget still does NOT buy:** past it, the late texture arrival still rebuilds, so the
player sees the full reset rather than a texture pop. The budget trades *silence* for *a visible
reset*, which is better but is not "no artifact" — removing it means letting the sim survive a
render rebuild (`CpuParticleSim` holds `out` by reference, so a `setOutputs()` would do it), which
is a lifecycle change deliberately left for its own change. The deadline is checked before the play
gate (a paused emitter whose load went stale would otherwise be hidden forever) and in `update()`,
never inside `advance()`, which `seek()`/`prewarm()` call in a loop — the old counter there measured
sim steps and a single scrub spent the whole budget. A wall-clock deadline is immune to that by
construction, since a synchronous loop spends no real time.

⚠️ **`buildChildRender()` rebuilds a sub-emitter child's `sim` as well as its render**, despite the
name — so the identical defect exists one level down, and a late child texture deletes every
particle the parent has injected. The child gets the same bounded hidden-wait. Latent today (no
sub-emitter child in the repo declares a sprite) and reachable the moment one does, which for a
spark or debris child is an entirely ordinary thing to author. Related: the texture rebuild also
discards the sim `create()` built **including its prewarm**, so `prewarm` + a texture is re-applied
after the rebuild rather than silently lost.

### The GPU sim

`GpuComputeBackend` holds all state in `instancedArray` storage buffers (`pos`, `vel`, a packed
`meta` vec4 = `(age, life, size, rot)`, `spin`). Two TSL kernels: **init** spawns the whole pool
with staggered ages; **update** ages each slot, respawns dead ones **in place**, and integrates.
Emission is **continuous full-pool only** (hence the `fillPool` eligibility requirement). Forces,
collision, and mesh-primitive rendering are supported but **baked into the kernel only when the
effect uses them** — the common no-force/no-collision ambient case (galaxy/snow/dust) pays nothing.
The render mesh is an `InstancedBufferGeometry` whose per-instance state comes from **storage reads**
(`.element(instanceIndex)`), not vertex attributes, sidestepping WebGPU's 8-vertex-buffer cap;
over-life size/opacity/color are sampled from small baked LUT textures (`gpuLut.ts`). Compute is
dispatched against the renderer that actually draws the mesh, captured via `onBeforeRender`.

⚠️ **The four storage buffers are owned by `GpuEntry` and MUST be freed by hand — three exposes no
public API for it (#717).** They used to be locals in `build()`, reachable only from the TSL closures
that captured them, so `dispose()` ran cleanly, reported success and freed **nothing**. Two facts make
this non-obvious, both checked in three r0.184's source rather than assumed:

- **`geometry.dispose()` cannot reach them.** `Geometries.initGeometry`'s `onDispose` deletes only
  the render object's *attributes* and index; these are **storage bindings**, never geometry
  attributes (`buildMesh` sets only `position`/`uv`/`index`).
- **`computeNode.dispose()` cannot either.** It *is* public and wired — `Renderer.compute()`
  registers a listener that drops the pipeline, bind groups and node cache — but
  `Bindings.deleteForCompute` frees the *binding*, not the buffer behind it.

The only route to `GPUBuffer.destroy()` is `Attributes.delete(attr)` → `backend.destroyAttribute`,
and `Renderer` has no `attributes` getter, so `freeStorageBuffer` reaches the private `_attributes`
deliberately, guarded at every hop. **If a future three release adds a public free, replace that
helper's body — the call sites do not change.**

**`build()` REUSES the four buffers when `count` is unchanged**, which is what makes editor tuning
cheap: `maxParticles` is only ONE field of `renderStructuralKey`, so every blend / aspect / tiles /
anchor / sprite-mode / texture edit also rebuilds with an identical count. Safe because a rebuild
re-inits the pool regardless (`inited = false` → `computeInit` respawns every slot), so no stale
particle state survives. Superseded buffers and compute nodes are freed at the **END** of `build()`,
after the replacements are assigned — `Pipelines.delete` decrements `usedTimes` and releases the
compute program at zero, so freeing first would drop a program the new kernel is about to ask for.

MEASURED on `games/3d-test` (15k particles, 12 blend-only rebuilds): **before, +4 buffers and
+780,000 B per rebuild, 9.36 MB orphaned, perfectly linear; after, zero growth.** Note the sizing is
**13 floats per particle, not 11** — WebGPU pads each `vec3` storage element to 16 B, so `pos` and
`vel` cost 4 floats each. Any estimate derived from the element types alone understates by 18%.

⚠️ **That capture creates an ordering hole, and a fresh pool must therefore stay HIDDEN for its
first frames (#338).** The renderer is only obtainable from `onBeforeRender` — i.e. from a DRAW —
so the first draw necessarily happens *before* the first `update()` that can dispatch anything.
Drawing `maxParticles` instances there renders them against buffers the init kernel has not filled:
on `demos/particle-demo`'s 40k Nebula that is a **full-screen white wash** for the station's opening
frames. (Not zeroed buffers — zeros give `meta.z = 0` → `scaleNode = 0` → nothing drawn. What reads
back is stale/recycled pool memory, drawn additively at 40k instances.) So **`build()`** starts the mesh at
`instanceCount = 0` — `build()`, not `create()`, because it is also the texture-load and `setDef`
rebuild path, and each of those mints fresh buffers that must be hidden again. `ensurePoolReady()`
then uploads the over-life LUTs explicitly rather than letting the first draw do it lazily, and
reveals the pool only after `REVEAL_DELAY_FRAMES` (`gpuPoolReveal.ts`).

⚠️ **The pool waits for its declared SPRITE as well as for its buffers, and until #338's reopen it
did not.** The CPU backends have held a textured emitter hidden since the first #338 pass; this one
had no such gate at all, and revealed as soon as `computeInit` completed whatever the texture was
doing. It is the worst place for the gap, because every effect the router sends here is a `fillPool`
one — Nebula is 40,000 particles in a single frame — so the untextured build is the 241/255 white
wash measured above. `revealPool()` therefore has TWO conditions (`!e.mesh || e.awaitingTexture`),
and the frame backstop in `ensurePoolReady()` is what retries it: the `onSubmittedWorkDone` promise
fires once, so a reveal blocked there would strand the pool if the counter were not still running
underneath. Every exit — arrival, failure, a `setDef` that swaps the ref away, the deadline — clears
`awaitingTexture`, for the same reason the CPU twin does.

⚠️ **Readiness runs even while PAUSED**, before `update()`'s play gate. `seek()` deliberately does
NOT reveal directly — it steps the buffers itself, but doing so in the same JS call as the dispatch
is a ZERO-frame boundary, and a one-frame boundary is on the measured disproved list; it restarts
the countdown and lets `ensurePoolReady` finish. Both matter for the
Particle Editor, which stops driving `update()` when paused: without them, any structural edit made
while paused left the preview EMPTY until the user pressed Play. The editor also calls
`update(handle, 0)` while paused so readiness can converge with no simulation advancing.

**The reveal is driven by a readiness SIGNAL, not by a timer.** `revealWhenGpuWorkDone` takes
`backend.device.queue.onSubmittedWorkDone()` immediately after the init dispatch — `finishCompute`
submits each compute group's own command buffer, so that promise resolves once the dispatch has
actually completed on the device. It cannot fire too early, and it self-tunes across GPUs.
`REVEAL_DELAY_FRAMES` remains only as a **backstop** for the paths that signal cannot reach: the
WebGL fallback (no `backend.device`), a lost device, or a browser without the method.

⚠️ **The backstop's value has a cautionary history worth keeping.** It was first bisected on two
devices and reported as "exactly 3 on both" — which was wrong, not because the measurement was
sloppy but because **the failure is intermittent and the bisect ran one take per value**. Re-running
a single build pinned at 3 gave one flash in four takes. The value is now 6 (double the observed
edge), verified 5/5 by repeated takes. **Never conclude from one run here**, in either direction.
Method: `screenrecord` a timeline pass → `ffmpeg signalstats` per-frame `YAVG` → compare a station's
entry against its own steady-state luma, and lock the screen orientation first (black side-bars in
landscape dilute the mean and make takes incomparable).

### Shared-math discipline

Because the integration math is mirrored across two languages (JS in the CPU sim, TSL in the GPU
kernel) and **TSL can't run headless, there is no automatic parity test**. The fix (`simSpec.ts`):
keep ONE documented, unit-tested scalar reference that the CPU sim *calls* (`accumNoise`,
`accumForce`, `dragFactor`, `annulusRadius`, `sphereRadius`, `resolveGravity`), and write the GPU
kernel as a visible line-by-line transcription of it. Same pattern for the sprite-frame index
(`spriteFrameIndex` ↔ `spriteFrameNode`), the seek step count (`seekSteps`), the frame-step clamp
(`clampSimDt`/`MAX_SIM_DT`), and the shape/collider resolvers (`resolveShape`/`resolveCollider`).
Editing any of these means editing it here and updating the matching TSL block in lockstep.

### ECS integration

`ParticleEmitter` is deliberately thin — just an effect ref + per-instance runtime knobs
(`playOnStart`, `playbackSpeed`, `speedScale`, `isVisible`); all effect-authoring lives in the
`.particle.json` (single source of truth). `syncParticles`/`syncParticles2D` run in the render phase
each frame: create a handle on first sight, push `setDef` when the cached def changes (a live editor
edit reseeds `particleCache` with a new object → reference compare detects it), compose the emitter
matrix from the **propagated world transform** (so a parented emitter follows a moving ancestor),
push `speedScale`, and `update` on the **visual delta** scaled by `playbackSpeed`. A trailing
`seen` sweep disposes handles for emitters that vanished or switched paths.

## Gotchas

- **2D vs 3D units — the CPU sim is unit-agnostic; EVERY length-dimensioned field means something
  different per backend, not just `startSize`.** The 3D backends read the sim's output as **metres**
  (world units); the Pixi 2D backend reads the exact same numbers as **Canvas2D design pixels**
  (`pixiParticleMap.ts` — position and size both live under the single canvas-slot scale, so the
  result is device-independent). That covers `startSize` (a TEXTURE MULTIPLIER: rendered height =
  `startSize × textureHeight` in design px — a 64×128 strip at `startSize: 0.2` renders ~26 design
  px tall; authoring `startSize: 28` "as pixels" renders the texture at 28× — a full-screen wash) —
  and identically `startSpeed` (design px/s), `gravity`/`forces` (design px/s²), `shape.radius`/
  `size`/`points` (design px), and `collision.planePoint`/radius/extents (design px). `drag` is a
  unitless s⁻¹ rate and does NOT need converting. **There is no auto-conversion** — porting a
  metre-authored effect to 2D means multiplying every one of those fields by a chosen
  pixels-per-metre factor `L` (`startSize` is the odd one out: multiply by `L / textureHeightPx`
  instead). Get one of these wrong (most often: reusing a 3D asset's numbers unchanged in a
  Canvas2D-parented emitter) and the effect still SIMULATES correctly — it just renders at a
  fraction of a pixel, indistinguishable from nothing. `PixiParticleBackend` warns once per effect
  id to the console when an effect looks sub-pixel in 2D (`warnIfSubPixel2D` in
  `pixiParticleBackend.ts` — a cheap heuristic on `startSize`/`startSpeed`/`startLifetime`, not a
  hard error), but nothing else signals it: no thrown error, particle count stays nonzero,
  `modoki_diagnose` reports no issues. **The sprite-size half of that heuristic only applies to
  the DEFAULT soft-circle texture** — a `render.texture` effect's real size isn't known until the
  async load completes, so a textured effect is judged on plume reach alone (worse recall, but no
  false positive on a real sprite sheet authored bigger than the 64px default — confirmed against
  `games/court`'s shipped win-sequence confetti). The 3D backends are the opposite of all of the
  above — every one of these fields there IS world units, unscaled.
- **2D silently ignores `render.mode: 'mesh'` (and trails/sub-emitters).** The Pixi backend only
  ever draws billboard sprites (`pixiParticleObject.ts`) — a Canvas2D-routed emitter using a
  mesh-mode 3D effect (`meshPrimitive`/`meshLit`) still renders, just as the default soft-circle
  sprite instead. Same asset, categorically different look per backend, with no warning.
- ⚠️ **`render.aspect` COMPOUNDS with the texture's own shape — it is not a correction for it.**
  The mapping is `scaleX = size × aspect`, `scaleY = size` (`pixiParticleMap.ts`), and both are
  multipliers on the texture's OWN pixel dimensions. So `aspect` below 1 on an already-tall
  texture multiplies the tallness: a 64×128 strip at `aspect: 0.5` renders **1:4**, not 1:2.
  This is what made Court's first confetti invisible (#333) — `startSize: 0.15–0.24` read as
  "19–31 design px" counting only the height, while the width was 4.8–7.7 px, i.e. a rotating
  hairline. **Compute BOTH axes before believing a size**: `w = startSize × texW × aspect`,
  `h = startSize × texH`. `aspect: 1` means "render the texture undistorted", not "square".
- ⚠️ **2D `noise.frequency` is in DESIGN PIXELS, so the usable values are ~100× smaller than
  they look.** `accumNoise` (`simSpec.ts`) feeds the particle's raw POSITION into the sine, so the
  spatial wavelength is `2π / frequency` px: `0.9` is a **7 px** wavelength — every particle
  jitters — while a visible flutter wants `~0.02` (a ~310 px sway). The 3D backends pass world
  units, where `0.9` is the sane end of the range; the number does not transfer between spaces.
  Pair it with `strength`, which is an acceleration in px/s² (peak `2 × strength`).
- **Untextured 2D particles render as soft round blobs** — the default texture is a radial
  alpha falloff (`pixiParticleObject.ts`), so "plain coloured squares" is not what you get.
  Confetti/paper effects need a real strip texture (`render.texture`), authored near-white so
  `startColor` multiplies it cleanly.
- **2D `render.renderOrder` must exceed the canvas's whole paint rank.** A Canvas2D slot sorts
  children by zIndex, and every Renderable2D's zIndex is a DENSE rank over ALL entities
  (`computePaintOrder`: orderInLayer primary, hierarchy DFS tiebreak) — on a real board that
  runs well past 100, so `renderOrder: 100` lands mid-board and the effect draws behind cells.
  Use ~1e6 (Scene2D's own "above every sprite" idiom is 1e9).
- **CPU is deterministic; GPU is not headless-testable.** Only the CPU sim can be driven headless
  with a fixed seed. GPU↔CPU parity is maintained *by construction* via `simSpec.ts` transcription,
  not by a test — so edits to the shared math must touch both sides. `simSpec.ts`, `emitterShapes.ts`,
  and `colliders.ts` are the canonical scalar references; the TSL in `gpuComputeBackend.ts` mirrors
  them line-by-line.
- **Never nest TSL `hash()` in the GPU spawn RNG.** Three's TSL collapses `hash(hash(...))` to a
  constant across invocations (once made *all* particles identical). Every hash argument must contain
  `instanceIndex` **directly**, plus a distinct salt (and `time`, so a slot's successive respawns
  differ) — see `rndAt` in `gpuComputeBackend.ts`.
- **GPU eligibility is narrow.** `simulation: 'gpu'` is a *request*, not a guarantee: it needs the
  native WebGPU backend **and** `emission.fillPool` **and** no trails/sub-emitters **and** ≤8 forces
  **and** a non-`polyline` shape. Miss any and it silently runs CPU (one info log per effect). A
  `polyline` shape or a 9th force forces CPU — the GPU kernel would otherwise diverge (map polyline →
  point, drop forces past the cap).
- **What triggers a GPU rebuild differs from CPU.** Sprite-sheet playback (`spriteMode`/`spriteCycles`/
  `spriteRandomStart`) is *baked into the render shader* on GPU, so changing it needs a rebuild — but
  the CPU sim computes the frame live, so it doesn't (this is why sprite playback is *not* in the
  shared `renderStructuralKey`). Likewise the **presence** of forces/collision and the collider
  **shape + invert** flag are baked into the compute kernel → changing them rebuilds; force values,
  collider center/radius/extents, and `kill↔bounce` are plain uniforms (no rebuild).
- **GPU time advances even before a renderer is captured.** The GPU backend steps its noise/sim clock
  every `update()`, gated only for the compute *dispatch* (which waits for `onBeforeRender` to capture
  a renderer). Render-gating the clock too once made GPU time start from 0 only after the mesh first
  drew, skewing noise advection vs an identical CPU effect.
- **Mesh mode is untextured.** `render.mode: 'mesh'` instances a built-in primitive and ignores
  `render.texture`; both backends zero out the texture ref in mesh mode.
- **`gravity` has two forms.** A scalar `g` means a downward `-Y` pull of magnitude `g` (legacy 3D);
  an explicit `[x,y,z]` vector is applied as-is (axis-neutral — 2D effects use `[0,+G,0]` to fall
  toward screen-down, since PixiJS +Y is down). `normalizeParticleDef` migrates a loaded scalar to
  `[0,-g,0]`; `resolveGravity` handles both so either integrates identically.
- **2D has no trails/sub-emitters yet.** `PixiParticleBackend` is Phase-1 scope (billboards, blend,
  render-order, flipbook, async texture). The CPU sim already *produces* trail/sub-emitter data; the
  Pixi render side is the missing piece.
- **Two image seams for the sprite texture.** The 3D backends decode KTX2 (GPU variant); the 2D Pixi
  backend loads via `resolveImageUrl` + the KTX2 transcoder. DOM/Canvas2D consumers can't decode KTX2
  — irrelevant here, but see `textures.md` for the general rule.
- **`worldSpace` toggle forces a clean rebuild on CPU** (avoids mixed-space live particles); a bare
  `radius`/`fromShell` still round-trips exactly through the annulus `radiusStart`/`radiusEnd` form.

## Related

- [`docs/plans/2d-particles-plan.md`](./plans/2d-particles-plan.md) — the phased plan for the 2D
  (PixiJS) backend: what's reused unchanged, what's new, the routing decisions, deferred work.
- [`rendering.md`](./rendering.md) — the three render layers (3d/2d/ui), the WebGPU renderer, and the
  NPR pass (which excludes the `PARTICLE_LAYER`).
- [`textures.md`](./textures.md) — sprite-sheet texture import + KTX2/WebP variant resolution.
- [`editor.md`](./editor.md) — the Particle Editor panel (curve/gradient authoring, live preview,
  retargeting).
