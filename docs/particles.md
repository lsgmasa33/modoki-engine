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
