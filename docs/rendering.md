# Rendering

The modoki runtime composites three rendering layers into a single view. Every renderable ECS entity carries a `Renderable.layer` of `3d`, `2d`, or `ui`, and the engine routes it to the matching backend. The two WebGL/WebGPU canvases are stacked, with the React DOM UI layer painted on top.

See also: [Architecture](./architecture.md) · [UI System](./ui-system.md) · [Materials & Textures](./textures.md) · [2D Skinning](./2d-skinning.md)

## Three Rendering Layers

| Layer | Backend | Driver |
|-------|---------|--------|
| `3d`  | Three.js (WebGPU/WebGL2) | `Scene3D.tsx`, synced by `scene3DSync.ts` |
| `2d`  | PixiJS v8 | `Scene2D.tsx`, draw utils in `render2DUtils.ts` |
| `ui`  | React DOM | `UIRenderer` (see [UI System](./ui-system.md)) |

Layering: `Scene3D` mounts an absolutely-positioned container at `zIndex: 0`. The PixiJS canvas(es) and the React DOM UI sit above it, so 3D acts as the background and 2D / UI overlay it.

### `3d` — Three.js

`Scene3D.tsx` owns a single `THREE.Scene`, a `PerspectiveCamera`, and the renderer. It does **no** ECS bookkeeping itself — each frame it calls into `scene3DSync.ts`:

- `syncCamera(world, scene, camera)` — pushes the active `Camera` + `Transform` onto the Three camera, applies FOV/near/far and `clearColor`.
- `syncEnvironment(world, scene)` — binds the cached HDR `Environment` texture (envmap + optional background).
- `syncLights(world, scene, ecsLights)` — creates/updates/removes `THREE.Light` instances from the `Light` trait (ambient / directional / point / spot), re-aiming spot & directional targets from the authored `target*` point, or from the world transform when it's unset.
- `syncRenderables(world, scene, state)` — the main mesh sync. Handles GLB meshes (`Renderable3D`, including baked `THREE.LOD` sets) and procedural primitives (`Renderable3DPrimitive`). Internally it uses:
  - `syncMaterial(...)` — resolves `.mat.json` references, inline texture paths, and the default material; fans the result out to single meshes or every LOD child.
  - `applyTransform(...)` — copies the propagated world transform (from `worldTransforms`) onto the object, falling back to the local `Transform`.

Object lifetimes are tracked in a `RenderState` (`ecsObjects`, `ecsSprites`, `ecsMaterials`, …); entities that disappear from the query are removed and their owned geometry/materials disposed.

### `2d` — PixiJS v8

`Scene2D.tsx` renders `Renderable2D` entities into their nearest `Canvas2D` ancestor's PixiJS container. A sprite is drawn either as a tinted `Graphics` primitive (driven by `Renderable2D.color`) or an image. Shared draw computations live in `render2DUtils.ts` (`drawPrimitiveShapeGfx()`, etc.) so the editor and runtime share one code path. Full detail: [2D Rendering (PixiJS)](#2d-rendering-pixijs) below.

### `ui` — React DOM

UI entities (`Renderable.layer = 'ui'`) are projected to React/DOM by `UIRenderer`, laid out with CSS flexbox and bound to the store. Full details in [UI System](./ui-system.md).

## Camera & Framing

The active camera is an ECS entity carrying `Camera` + `Transform`; `syncCamera(world, scene, persp, ortho)` (`scene3DSync.ts`) drives the Three cameras from it each frame and returns whichever `Camera.projection` selects (the render camera).

### `Camera` trait — `runtime/traits/Camera.ts`

| Field | Default | Meaning |
|-------|---------|---------|
| `projection` | `'perspective'` | `'perspective'` (uses `fov`) or `'orthographic'` (uses `orthoSize`). |
| `fov` | `30` | Vertical field of view, degrees (perspective). |
| `orthoSize` | `5` | Half the visible world-height, world units (ortho): `top=+orthoSize`, `bottom=−`, left/right derived from the viewport aspect. Unity-style knob — good for board/top-down games. |
| `near` / `far` | `0.1` / `500` | Clip planes (applied to both cameras). |
| `overlayDistance` | `3` | Camera-space overlay plane distance. |
| `clearColor` | `0x000000` | Scene background colour (unless the Environment sync owns a texture background). |

`syncCamera` writes pos/rot to BOTH the perspective and orthographic cameras so a live `projection` toggle is seamless, applies FOV/near/far (change-gated), sets the ortho frustum from `orthoSize` × aspect via `applyOrthoFrustum` (aspect comes from the live perspective camera, kept current on resize), and pushes `clearColor` onto `scene.background` — reading the ACTUAL `scene.background` (not a cache) so a scene reload re-applies it, and leaving a TEXTURE background alone (owned by the Environment sync). A camera whose entity is deactivated is SKIPPED: an inactive ortho camera would otherwise clobber the active pose and flip the whole scene to orthographic (the projection pick is monotone persp→ortho).

### `CameraFrame` — declarative auto-fit

A `CameraFrame` entity is an oriented framing box (its `Transform` scale IS the box size, matching a size-1 primitive box); the framing loop places the camera so the box fits the viewport. `selectActiveFrame` picks the FIRST `CameraFrame` with `active === true` that isn't deactivated — a false `active` is a real off switch (no "fall back to any frame", so toggling it off releases the camera). The fit itself is pure, side-effect-free, unit-tested math in `cameraFraming.ts` (`computeFrameFit`).

The key geometric shortcut: translating the camera along its own forward axis changes only a point's depth in view space, never its lateral coordinates — so the perspective fit distance has a CLOSED FORM (accumulated per-corner: `D ≥ |lateral|/(frac·tan) − depth`), no iterative dolly/binary-search. Options:
- **`mode`** — `'contain'` (fit both axes), `'fitWidth'`, `'fitHeight'`.
- **margins** (`marginTop`/`Bottom`/`Left`/`Right`, viewport fractions) — asymmetric margins SHIFT the framed content when `autoAim` recenters; otherwise they shrink the fit symmetrically.
- **`autoAim`** — true → camera owns lateral position and recenters the box into the margined sub-rect; false → keep the AUTHORED lateral position and dolly for size only (the fit measures each corner from the camera's optical axis, not the box center).
- **anchors** (`anchorV`/`anchorH` + `anchorPosV`/`anchorPosH`) — pin a chosen box edge (or its center) to a viewport fraction, overriding the mode/margin centering.
- **blend** (`continuous`, `blendTime`, `blendEase`) — a runtime active-frame switch (`setActiveCameraFrame`, ref by name/guid/id; a no-match is a NO-OP) blends the camera into the new frame over the TARGET frame's `blendTime`/`blendEase` (easings in `cameraFraming.ts` `ease()`).

`computeActiveFrameFit` returns `{position, orthoSize, …}`; `Scene3D` applies `position` to the camera (and `orthoSize` in ortho mode). Ortho fits set `orthoSize` from the max lateral extent; perspective fits set the dolly distance. Both keep the nearest box corner in front of `near`.

## Lights & Shadows

`syncLights(world, scene, ecsLights)` (`scene3DSync.ts`) creates / updates / removes a `THREE.Light` per `Light` entity (`three/traits/Light.ts`), tracked in a `Map<entityId, THREE.Light>`.

- **Types** — `lightType` selects `AmbientLight` / `DirectionalLight` / `PointLight` / `SpotLight` (`createLightFromTrait`). Switching the type at runtime disposes the old instance and recreates it (`lightMatchesType`).
- **Per-frame fields** — `color`, `intensity`, `castShadow` are re-applied every frame; `distance` for point/spot; `angle` + `penumbra` for spot. Subclasses ignore irrelevant fields (an `AmbientLight` has no `distance`).
- **Aiming** — directional/spot lights aim at a `target` Object3D added to the scene. Two ways to author it, checked in this order each frame by `syncLights`. A reaped or type-switched light removes its stray target too (`removeLightTarget`), else empties accumulate on churn.
  - **1. `Light.targetX/targetY/targetZ` — a WORLD-space point to aim AT.** Set any one of them non-zero and the light points there, ignoring its rotation entirely. This is usually what you want: "this spot lights that statue" is a position, not an euler.
  - **2. Rotation fallback** — when all three are 0 the aim is the light's local −Z forward put through its WORLD euler, so a parented spot follows its transform instead of always aiming at the origin. To aim at a point this way, set the rotation from the normalized light→target direction `u`: **`ry = asin(−u.x)`, `rx = atan2(u.y, −u.z)`** (roll is irrelevant — rotating about Z cannot move the −Z axis).
  - **`(0,0,0)` means UNSET, not "aim at the world origin"** — that is what keeps every scene authored before the fields were wired working unchanged, since they all serialize `0,0,0`. To aim at the origin, nudge one axis (`targetY: 0.001`); the direction error is immeasurable at any real light distance. Both directions are pinned in `tests/runtime/syncLights.test.ts`.
  - **⚠️ Historical trap (fixed 2026-07-26): the `target*` fields used to be DEAD.** They were declared on the trait, shown in the Inspector under a "Target" group, and written into prefab defaults — and read by nothing, so a light with **zero rotation always pointed along −Z, dead horizontal, no matter what you typed into `target*`.** Symptom: ground planes render **black** (their +Y normal is edge-on to the light, N·L ≈ 0) while walls and object sides light normally, and `castShadow` appears to do nothing because the shadow map is cast edge-on. Cost a long false hunt for a "WebGPU shadow bug" in `demos/3d-physics-demo`, and made a correctly-targeted spot in `demos/postfx-demo` look dead at intensity 4000. If you meet a scene that still aims six spots by hand-computed `asin`/`atan2` rotations, that is the old workaround — it still works (all-zero targets), and can be simplified to plain targets.
  - **⚠️ Post-FX stages that reconstruct DEPTH must be handed the SCENE camera's near/far as
    caller-owned uniforms — never TSL's global `cameraNear`/`cameraFar`** (fixed 2026-07-26).
    Those globals resolve from whatever camera renders the CURRENT pass, and a post-FX stage
    like DOF's circle-of-confusion pass is a full-screen QUAD with its own camera — so they
    silently resolve to the quad's near/far and the reconstructed viewZ becomes effectively
    constant across the frame. three's own `PassNode.getViewZNode()` sidesteps this with the
    pass's private `_cameraNear`/`_cameraFar`; `buildViewZNode` (`postfx/dofViewZ.ts`) takes
    them as explicit parameters, and the DOF stage updates them each frame in its
    `StageHandle.prepare()`. **Symptom to recognise:** depth-of-field with *no depth* — near
    and far objects blur by the same amount and move together as `focusDistance` changes,
    and the effect completely ignores the scene camera's `near` (the diagnostic: change
    `Camera.near` and watch nothing happen). It cost hours because it looks like a tuning
    problem, not a wiring one.
  - **Euler order is XYZ — the same order the renderer applies to every other object** (`applyTransform`'s `obj.rotation.set(rx, ry, rz)` at three's default, and `getWorldTransform3D`'s decomposition). ⚠️ **Historical trap (fixed 2026-07-26):** `syncLights` used to derive the aim with a hand-rolled `(−sin ry·cos rx, sin rx, −cos ry·cos rx)`, which is **YXZ** — so one authored euler meant one orientation on a mesh/camera and a *different* one on a light. The two agree only when `ry ≈ 0`, true of most authored spots, which is why it survived so long; a light with both pitch and yaw was mis-aimed (measured: 80° on one scene's key light). The fix routes the forward through `applyEuler`, and the 24 affected lights across ~20 scenes were migrated so their directions are unchanged. **If you ever re-test this, use a pose where the orders disagree — both pitch and yaw non-zero. A test at `ry = 0` passes either way and proves nothing** (`tests/runtime/syncLights.test.ts`).
- **Particle layer** — every created light enables `PARTICLE_LAYER` (Three lights are layer-gated); without it, lit mesh-particle materials render black.
- A light whose query row vanishes is removed + disposed at the end of the pass.

### Shadows (`configureLightShadow`)

Applied each frame while `castShadow` is on and the light is directional/spot. `Light` trait knobs (defaults tuned for a clean papercraft drop shadow):

| Field | Default | Meaning |
|-------|---------|---------|
| `shadowMapSize` | `2048` | Depth-map resolution (square). A change reallocs the depth texture — GUARDED so it only regenerates when the size actually changes. |
| `shadowCameraSize` | `16` | Directional shadow-camera ortho half-extent (world units) — must ENCLOSE the scene. |
| `shadowBias` | `-0.0003` | Depth bias (fights acne). |
| `shadowNormalBias` | `0.008` | Normal-offset bias (fights peter-panning). |
| `shadowRadius` | `4` | PCF blur radius. |
| `showShadowFrustum` | `false` | Editor-only: outline the shadow-camera coverage box in SceneView (runtime ignores it). |

The shadow camera near/far are fixed at `0.1` / `200`; the directional light's ortho frustum is set from `shadowCameraSize`. Casters/receivers are flagged via `applyShadowFlags` (traverses the object, setting `castShadow` + `receiveShadow` on every mesh) — inert unless a light casts AND the renderer's shadow map is enabled.

### Rendering-layer light masks — per-object light selection (`lightMaskVariants.ts`)

A light affects a renderer when their `renderingLayerMask` bitmasks INTERSECT (Unity's Rendering
Layers, Godot's `light_mask`, Unreal's lighting channels). The field is on `Light`, `Renderable3D`
and `Renderable3DPrimitive`, defaults to `1` on all three, and an unauthored scene is completely
inert — no variant is allocated and the code path is skipped entirely.

**Why**: forward shading evaluates EVERY scene light for EVERY fragment, superlinearly on mobile.
Masking is the highest-value low-tier knob there is — bigger than the entire post-FX stack. The
numbers, and the two measurement traps that produced three retracted figures, are in
[plans/low-end-device-support.md](plans/low-end-device-support.md).

**Mechanism**: three's `NodeMaterial.lightsNode` overrides the scene's global light list for one
material, in a single pass. It works on a classic `MeshStandardMaterial` because
`NodeLibrary.fromMaterial` copies properties with a `for…in`. So a masked mesh renders with a
CLONE of its material carrying a restricted lights node.

Two caches, deliberately keyed differently — **both keys are load-bearing, and getting either wrong
renders a correct-looking scene wrong**:

- **The material variant** is keyed by `(base material, light selection)`. Not per entity:
  materials are shared (13 across 33 meshes in postfx-demo), so a per-entity variant would trade a
  fragment-cost problem for a pipeline-count one.
- **The lights node** is keyed by the **selection alone** and shared across base materials. A
  `LightsNode` builds a `ShadowNode` per shadow-casting light it references, and each ShadowNode
  renders its own shadow map — so one node per material means one shadow PASS per material.

⚠️ **A variant of a CLASSIC material MUST override `customProgramCacheKey()`.** This is not an
optimisation; without it masked objects render **pitch black while their data is perfect**. three's
`RenderObject.getMaterialCacheKey()` decides which compiled PIPELINE a material reuses by walking
its properties, and it cannot see a lights node: a non-texture object property contributes the
literal string `"{}"`, and `uuid`/`name`/`userData` are skipped outright. So N clones of one base
that differ ONLY in their light set hash to the SAME key and all share whichever pipeline compiled
first — each rendering with another variant's lights.

**A real `NodeMaterial` is already safe and must be left alone.** `NodeMaterial` overrides
`customProgramCacheKey()` to hash its node graph — `_getNodeChildren()` walks every own property
whose value `isNode`, which an assigned `lightsNode` is. Overriding it *there* would REPLACE that
graph hash with just the light selection, so two different node graphs (two file shaders on the
same material class) would share one pipeline: the identical defect one layer up. Hence the
`isNodeMaterial` guard — the classic material is the only one whose key is blind to nodes, so it is
the only one touched, and even then the base's own key is composed with rather than replaced.

The failure hides behind material SHARING, which is what made it hard: postfx-demo's six plinths
are one shared `.mat.json`, so their variants collide with each other; several selections were
empty (those spots were off), the empty-lights pipeline won, and every plinth went black. The horse
statue's material is its own — one variant, no collision, correctly lit. A cache collision
therefore looked exactly like a per-object lighting fault. It also needs a SECOND light before any
variant exists at all (a mask that already sees every light returns `null` and uses the global
path), so the trigger reads as "enable a second spot and an unrelated object goes dark".

Wrong theories that cost time, recorded so they are not re-derived: it is *not* the two render
surfaces (SceneView and GameView own separate `THREE.Light` instances — real, and handled by keying
on light identity, but not this bug); it is *not* shadow-map contention; and it is *not* cloning.
Note the confound that produced the second wrong fix — **toggling `castShadow` off→on forces a
shadow rebuild**, so "changing X lit it" may only mean "rebuilding lit it". Isolate with
`shadow.intensity`, which changes no build state.

Not yet masked: skinned meshes, billboards and text have no mask field, and multi-material meshes
are skipped.

### Scene lights in custom shaders (`sceneLightUniforms.ts`)

Standard `MeshStandardMaterial`s get scene lights for free through Three's `LightsNode`. A **custom shader** (a `.shader.json` file shader, or a code-registered TSL builder) assigns its own `fragmentNode`, which BYPASSES that lighting pipeline — so historically each custom shader baked in a fixed sun direction/colour. `sceneLightUniforms.ts` closes that: it picks a small set of the scene's actual `Light` traits each frame and exposes them to custom shaders as uniforms.

- **The picker** — `sceneLightPicker.ts` (`pickSceneLights`) is a PURE function (headless, unit-tested) that turns `LightSample[]` into: the brightest **directional** as the key light (`keyDir` toward-light + `keyColor` linear rgb×intensity), the **summed ambient** (`ambientColor`), and the strongest `MAX_SHADER_POINT_LIGHTS` (**4**) **point/spot** lights (world pos + colour + `invRange`). Colours are sRGB-hex → linear to match Three's pipeline. Ranking is by intensity — camera-INDEPENDENT, so the editor SceneView and runtime GameView agree and lights don't pop as the camera moves.
- **Why scene-global, not per-mesh** — materials are shared + refcounted, so a true "nearest lights to THIS mesh" pick would force per-entity material clones. Instead ONE singleton set of `uniform()` nodes is shared by every custom material; `updateSceneLightUniforms(world)` refreshes their values at the end of `syncLights` (so every render surface feeds it, and a gizmo-moved light updates immediately). The singleton is created lazily on first bind — a scene with no custom shaders pays nothing. Per-mesh selection is a possible future extension.
- **Shader inputs** — a file shader binds these by argument name (it declares only what it uses): `sceneDiffuse` (vec3, a ready-made Lambert term — `albedo * (ambientColor + sceneDiffuse)`), plus the raw `keyLightDir` / `keyLightColor` / `ambientColor` for shaders that want their own (stylized) lighting math. Point-light falloff is windowed `(1 - (d·invRange)⁴)²`, which collapses to no attenuation when `invRange` is 0 (infinite range). Code TSL builders reach the same uniforms via `getSceneLightUniforms()` from `@modoki/engine/runtime/rendering`. Worked examples (both migrated off hardcoded suns): `games/space-console/.../shaders/ship-halo.{wgsl,glsl}` and `games/space-console/runtime/shaders/planet.ts`.

## HDR Environment & IBL

An `Environment` entity (`three/traits/Environment.ts`) binds an HDR equirect as the scene's image-based lighting + optional background. `syncEnvironment(world, scene)` (`scene3DSync.ts`) binds the CACHED texture each frame:

| Field | Default | Meaning |
|-------|---------|---------|
| `hdrPath` | `''` | HDR asset ref (GUID). |
| `intensity` | `1` | IBL / reflection strength (`scene.environmentIntensity`). |
| `showAsBackground` | `false` | Also draw the envmap as the scene background. |
| `backgroundIntensity` | `1` | Background exposure when shown. |
| `backgroundBlurriness` | `0` | Background blur, 0..1. |

The texture is acquired + refcounted per scene by `SceneManager` (see [Architecture](./architecture.md)) so `getCachedEnvironment(hdrPath)` returns a ready texture before first render. Every `scene.environment` / intensity / background write is CHANGE-GATED — this runs every frame, but the texture + scalars rarely change and reassigning them flags the render state dirty on some backends. An `ultrahdr`-format source is display-referred (dimmer for IBL), so both its env + bg intensity are boosted by `ULTRAHDR_INTENSITY_BOOST` toward scene-linear parity (the user's `intensity` still scales on top). A runtime-spawned Environment (editor live-edit) that skipped the acquire path kicks off an async load and lands on a later frame. Removing/deactivating the Environment clears `scene.environment` (the texture is owned by `envCache`, never disposed here).

### HDR conversion (Node — dev server + build)

Source `.hdr` files are downscaled offline into a content cache by `env-convert.ts` + `hdr-codec.ts` — DEPENDENCY-FREE (no ImageMagick / native tool, unlike `toktx` for KTX2):

1. **Decode** — `three`'s `HDRLoader.parse` (robust: handles RLE + flat), lazy-imported so `three` stays out of the plugin's top-level bundle, decoded to an RGBA `Float32Array` (`FloatType`).
2. **Downscale** — an area-average box filter in LINEAR radiance space (`downscaleRGBA`) to `settings.maxSize` on the longest edge (`envTargetDims`, never upscales). Averaging in linear space is the correct high-quality filter for an equirect that feeds a blurred PMREM.
3. **Re-encode** — a hand-rolled canonical new-RLE RGBE `.hdr` (`encodeHDR`, literal/uncompressed runs — a layout `HDRLoader` always parses; `floatToRgbe` shared-exponent encoding). Width must be in `[8, 32767]` (a real ≥256 equirect always is; a pathologically narrow HDR THROWS → source fallback rather than silent corruption).
4. **Cache** — the output `~env.hdr` lands in the content cache (`env-cache.ts`), keyed on source bytes + settings. A cache hit SKIPS the expensive decode entirely, reading src + variant dims cheaply from the ASCII header resolution line (`readHdrHeaderDims`).

## Fog

A `Fog` entity (`three/traits/Fog.ts`) drives scene-wide fog. `syncFog(world, scene)`
(`scene3DSync.ts`) applies it every frame, mirroring `syncEnvironment`'s first-active-entity-wins +
clear-on-none convention:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Turn fog on for this scene. |
| `mode` | `'linear'` | `'linear'` (Near/Far), `'exponential'` (Density), or `'height'` (Density + Height). |
| `color` | `0xa8b4c0` | Fog color, blended over distant/fogged surfaces. |
| `near` / `far` | `10` / `100` | Linear mode: distance (world units) where fog starts / reaches full color. |
| `density` | `0.02` | Exponential + height modes: thickness — higher closes in sooner. Rule of thumb: `density ≈ 1 / typical viewing distance` — the `0.02` default is tuned for scenes spanning hundreds of units and reads as "no fog" in a small scene (a few world units needs density closer to 0.2–0.5). |
| `height` | `10` | Height mode: world-Y fog ceiling — geometry BELOW this fogs (denser the lower + farther), geometry above stays clear. Requires Y-up. |

### The hybrid mechanism (why there are two code paths)

**`linear`/`exponential` → the classic `scene.fog` object.** Despite this engine rendering
exclusively through `WebGPURenderer` with TSL/`NodeMaterial` (see "No custom GLSL" below),
`NodeMaterial.fog` defaults to `true`, and three's own `NodeManager.updateFog()` transparently
converts `scene.fog` (a `THREE.Fog`/`FogExp2` instance) into the equivalent TSL node graph
(`fog(color, rangeFogFactor(near, far))` / `densityFogFactor(density)`) on every render — no manual
`scene.fogNode`/TSL wiring needed. `syncFog` just assigns `scene.fog` directly, and three caches the
derived TSL node by the `Fog`/`FogExp2` object's own identity, refreshing
`color`/`near`/`far`/`density` each frame via `reference()` nodes (`NodeUpdateType.OBJECT`) — so
mutating the SAME object's fields already gets "update without recompiling the shader" for free.
`syncFog` only allocates a NEW `Fog`/`FogExp2` instance when `mode` switches to/from one of these
(different classes, cached separately under different keys).

**`height` → `scene.fogNode` directly.** There is no classic-object equivalent for height fog, so it
drives `scene.fogNode` via `fog(color, exponentialHeightFogFactor(density, height))` — the same TSL
primitives, hand-assembled. `NodeManager.getFogNode()` prefers `scene.fogNode` over a
derived-from-`scene.fog` node, so `syncFog` explicitly nulls whichever path is inactive (a stale
`scene.fog`/`scene.fogNode` would otherwise silently win).

**A stable node identity is a correctness requirement here, not an optimization.** `Node.getHash()`
returns the node's own instance id, and `NodeManager.getCacheKey()` folds `fogNode.getCacheKey()`
into the render-object's SHADER CACHE KEY — so rebuilding the height-fog node every frame would
recompile every affected material's shader every frame. `syncFog` keeps one `HeightFogState` (the
`color`/`density`/`height` `uniform()` nodes + the composed fog node) per physical `THREE.Scene` in a
`WeakMap`, built once and mutated in place — the same pattern `sceneLightUniforms.ts` uses for
custom-shader lighting. Toggling `height → linear/exponential → height` reuses the cached node
rather than rebuilding it.

### ⚠️ Scene-global TSL uniforms MUST use `renderGroup` — the uniform-group rule

This bit us twice (HDR env intensity, then height fog) before the root cause was understood. **The
rule: a bare `uniform()` is a PER-OBJECT uniform, and a per-object uniform on static geometry never
updates.** Read this before adding any new TSL uniform.

Three's `uniform()` defaults to `objectGroup` — one uniform buffer **per render object**. Those
buffers are only re-uploaded inside `Bindings.updateForRender(renderObject)`, which `Renderer`
calls **only when `NodeMaterialObserver.needsRefresh(renderObject)` is true**. That observer
watches only MATERIAL properties (its fixed `refreshUniforms` list), the world matrix, geometry,
and lights — so for a **static mesh with a plain (non-node) material it returns false forever**
once initialized. A scene-global value written into such a uniform therefore updates its JS-side
`.value` correctly but **never reaches the GPU on non-animating geometry**, while animated objects
update fine — a maddening *partial* staleness that looks like "some things update, some don't".
(Diagnosing it requires a TRUE framebuffer read: a forced `modoki_capture_viewport` render does
NOT fix it, which rules out a render-on-demand scheduling gap and points at the uniform upload.)

`renderGroup` is the fix and the intended mechanism: a **shared** group (`shared: true`,
`updateType: RENDER`) whose single bind group / buffer is shared by every material referencing
those nodes and re-uploaded once per render call, so it cannot go per-object stale. Three's own
`NodeManager.updateFog()` does exactly this for the classic `scene.fog` path
(`reference(...).setGroup(renderGroup)`) — which is precisely why linear/exponential fog never had
the bug and height fog did.

```ts
// ✅ scene-global (fog, scene lights, wind, global time)
const color = uniform(new THREE.Color()).setGroup(renderGroup);
// ✅ genuinely per-object (reads from object.userData)
const t = uniform(0).onObjectUpdate(({ object }) => object.userData.stripeTime ?? 0);
// ❌ scene-global in the default per-object group → stale on static meshes
const bad = uniform(new THREE.Color());
```

Guarded by a unit test (`syncFog.test.ts`, "puts every height-fog uniform in renderGroup") so the
`.setGroup` calls can't be "simplified" away.

**Is this a three.js bug?** For fog, no — it was our misuse of a documented grouping mechanism.
For `scene.environmentIntensity` it's arguably a three-side wart: `materialEnvIntensity`
(`nodes/accessors/MaterialProperties.js`) is a single `objectGroup` uniform serving BOTH the
per-material `material.envMapIntensity` and the scene-global `scene.environmentIntensity`
fallback — correct for the former, structurally stale-prone for the latter. We can't re-group
three's own node, so `refreshEnvIntensityObserver` (above) remains the justified workaround *there*
— but it is a workaround, and should never be copied for engine-owned uniforms; use `renderGroup`.

**Height-fog semantics** (`three/src/nodes/fog/Fog.js`): `distance = max(height − positionWorld.y,
0)`; `m = distance × viewZ`; `factor = 1 − exp(−(density × m)²)`. Fog needs BOTH depth below the
ceiling AND camera distance — a fragment just under `height` stays clear even far away. Y-up only.

**Height mode is EXTRA density-sensitive** (measured live on `games/3d-test`'s ~5-unit island with
a camera ~25 units out): because `m` is the PRODUCT of depth-below-ceiling and camera distance,
`density: 0.3` (already the high end for plain exponential fog at that distance) fully saturated the
entire visible scene to the fog color — indistinguishable from "nothing rendered" when the fog color
happens to resemble the background. `density: 0.03` at the same distance gave a clean gradient
(clear palm-tree tops, hazy water). Start an order of magnitude below the exponential-mode rule of
thumb and raise slowly.

### NPR interaction — custom shaders must opt out of fog

A custom `NodeMaterial` shader that sets `fragmentNode` to an NPR `outputStruct` (via
`nprFragmentOutput`, see "NPR Outline Post-Process" below) breaks when fog is enabled and the
material's `fog` flag is left at its default `true`: `NodeMaterial.setupOutput()` still runs
`setupFog()` on the struct, which REPLACES it with a single `vec4` — collapsing the 3 MRT targets
(output/normal/lineColor) down to 1, which WebGPU then discards as an incomplete draw (the exact
"targets[1]/[2] have no fragment output" failure `nprFragmentOutput`'s own docblock warns about,
just triggered by fog instead of a missing wiring). **Use `applyNprFragmentOutput(mat, colorRGBA,
preserve?)`** instead of `nprFragmentOutput` + a manual `fragmentNode` assignment — it sets both
`fragmentNode` and `fog = false` in one call, so a scene that later gains a `Fog` entity doesn't
silently drop the shader's draws. `games/space-console`'s `stripes`/`matcap`/`planet` shaders use it.

## Material Sync

`syncMaterial(obj, id, curMat, state)` (`scene3DSync.ts`) binds a mesh renderer's material each frame. A renderer references a MATERIAL only (a `.mat.json` GUID) — never a texture directly (textures live on the material; resolution + the KTX2 variant pick are in [Materials & Textures](./textures.md)):

- An empty ref falls back to a shared engine default (`MeshStandardMaterial`, grey, `roughness 0.5`, `metalness 0`).
- A material created inline for one entity is tracked in `_ownedMaterials` and disposed when reassigned; shared cache materials are NEVER disposed here (the scene refcount owns them).
- When the ref is UNCHANGED but the async `.mat.json` load only just finished, `syncMaterial` re-checks `resolveMaterial` and swaps the resolved material in — retrying each frame until it lands.
- A `THREE.LOD` fans the material out to every LOD child mesh (`materialTargetsOf`).

**Tint** — the `Tint` trait renders a per-`(material,color,amount)` CLONE of the shared base material (`.color` set to the tint, `nprColorPreserve` set to the strength). Clones are cached (every ally ship shares ONE blue clone) and freed only on world swap (`disposeTintMaterials`, wired to `onWorldSwap`); a continuously-varying tint (an animated colour) would grow the cache unbounded and warns past 64 entries. The NPR composite then blends the grayscale fill toward that colour per-draw (see [Color preservation](#color-preservation)).

## MaterialInstance — runtime material parameter driving

The `MaterialInstance` trait (Unity `.material` / Unreal Material Instance Dynamic) gives an
entity a private, parameter-overridable view of its material whose params can be **driven each
frame** — by `Time`, gameplay/store state, or a curve — or simply tweaked per-instance. It's the
general, dependable replacement for one-off "drive a uniform from a bespoke system" hacks. Pure
data: a list of `overrides`, each `{ target, kind, source }`. Reference game: `space-console`'s
stripe shader; worked demo: `games/3d-test/assets/scenes/material-instance-demo.scene.json`.

**The core problem it solves.** A plain ECS system runs with only `world` — it can't reach an
entity's live THREE material (materials live in per-renderer `RenderState.ecsObjects`, and the
editor runs TWO surfaces on one world). The **material broker** (`materialBroker.ts`) fixes that:
each renderer publishes its `RenderState` + world; `getEntityObjects(world,id)` /
`getEntityMaterials(world,id)` fan out over every surface. `materialInstanceSystem` (pipeline
priority `SYSTEM_PRIORITY.MATERIAL` = 260, ≥ TRANSFORM so it keeps writing while paused) drives the
overrides through it.

**Two target kinds — pick by what the shader reads:**
- **`kind:'uniform'`** — a custom-shader TSL uniform. The value is written to every drawable
  object's `userData[target]`; the shader's uniform reads it per-draw via
  `.onObjectUpdate(({object}) => object.userData[target])` (the three.js instance-uniform pattern —
  see `WoodNodeMaterial`). **One SHARED material yields independent per-entity values — no clone, no
  shader recompile.** This is the cheap path and the one to use for custom shaders. A custom shader
  becomes driveable just by wiring its uniforms this way (see `space-console/stripes`). NOTE: a
  custom shader whose `fragmentNode` hardcodes output (e.g. `nprFragmentOutput(vec4(rgb,1))`) ignores
  standard `.color/.opacity/…` — drive it with a uniform override, not a prop.
- **`kind:'prop'`** — a standard material property (`color`/`opacity`/`roughness`/`metalness`/
  `emissive`/`emissiveIntensity`, plus the `map*` Vector2 sub-props `mapOffsetX/Y` + `mapRepeatX/Y`
  for per-entity UV scroll/tiling). Requires a per-entity **clone** (mutating the shared cached
  material would hit every entity). `materialInstanceClones.ts` clones the material — the base is
  **re-resolved from the entity's material GUID each frame** (like `Tint`, via `resolveMaterial`),
  NOT read off `mesh.material`, which is what makes it correct across both surfaces and across an
  async `.mat.json` load (one base per entity; never disposes a still-bound clone). A `map*` driver
  clones the base **texture** once per material (`material.clone()` shares `.map` by reference), flags
  it on `userData._miOwnsMap`, and frees it with the clone. `syncMaterial`'s `isInstanced` guard (set
  for entities with a prop override) suppresses its per-frame "reset to base" so the clone survives;
  `MaterialInstance` takes precedence over `Tint`. Clones are freed at world swap (like Tint clones).
  Valid prop bases: an explicit **`.mat.json`** material, or a **baked multi-material array**
  (per-slot clones, driven on every slot). A **single default-material primitive** is NOT a valid
  base (its material is recreated on canvas resize and owned per surface, so cloning it would leak
  a material+texture each resize) — give it a `.mat.json`, or drive `rend.color` / a custom uniform
  instead; it's skipped with a one-time dev warning. Custom-fragment shaders that hardcode output
  also ignore standard props (drive them with a uniform override).
- **`kind:'texture'`** (2D custom materials only) — a per-instance texture-param swap. Instead of a
  `source`, it carries a `ref` (a sprite/texture GUID) that overrides a `space:'2d'` shader's
  texture-param [manifest default](#2d-custom-materials-pixijs-shaders) for THIS entity — so two
  entities sharing one material can bind different extra-sampler textures. It's STATIC (a ref, not a
  driven value — MaterialInstance sources are scalar-only), resolved + refcounted by the renderer
  (`Scene2D.readTextureOverrides` → the extra-sampler path), and the scalar driver
  (`materialInstanceSystem`) ignores it (no `source`). No 3D equivalent (a 3D texture param would need
  a material clone like `kind:'prop'`).

**Sources** (`MaterialParamSource`): `constant`; `time` (session-relative, `timeScale`-aware, wrapped
to dodge the float32 precision cliff — reproduces the stripe-shader lessons engine-wide, so pause
freezes it and no game re-learns them); `store` (a live value from the read-source registry,
`getReadValue(key)` — the same registry UI `readSource` bindings use — × `scale`, with an unscaled
`default` fallback); and `curve` (samples the particle-`Curve` shape at a nested **non-curve**
driver, e.g. a `time` driver with `wrap:1` loops the curve once/sec). A malformed curve degrades to
0 rather than throwing; `sceneValidation` also validates a curve's nested shape.

**Authoring.** The Inspector renders a dedicated `MaterialOverridesField` (a `'materialOverrides'`
FieldType): per-row `kind` / `target` / `source` pickers, with `target` suggestion chips — standard
props for `prop`, and the material's **resolved shader uniform names** for `uniform`. `curve` sources
are shown read-only (author points/driver in the scene JSON).

**Timeline keyframing.** A material param CAN be keyed on the animation timeline: an override whose
source is a `constant` exposes a nested-path track `overrides.<i>.source.value` (only `constant`
sources — a `time`/`store`/`curve` source is procedurally driven and would fight the clip). Nested
tracks flow through `pathValue.ts` (`getPath`/`setPath`, immutable — clones each node on the path so
koota change-detection fires), and `materialInstanceSystem` re-reads the overrides every frame so a
keyed value reaches the material. The track's `field` is a **positional index** into the overrides
array (`overrides.2.source.value`), so reordering/removing overrides can leave a track pointing at a
different (or absent) entry — `setPath` drops a write to a stale/out-of-range index rather than
corrupting the array. (Unity's material-property tracks are positionally fragile in the same way.)

**2D (PixiJS) materials — same trait, same sources.** `materialInstanceSystem` drives the 2D layer
too: an entity rendered through a custom 2D material (`Renderable2D.material` → a `space:'2d'`
`.shader.json`; see [2D custom materials](#2d-custom-materials-pixijs-shaders) below) has a live
per-entity Pixi `Shader`, and the SAME `evalSource` writes its `uniform` overrides into that shader's
`matUniforms` group. The system checks the 2D layer FIRST (a material `Renderable2D` has no 3D broker
presence, so the two paths are exclusive) and reaches the shader(s) via `sprite2DMaterialBroker` — the
2D twin of `materialBroker`, into which each live `Scene2DRenderer` registers its `entityShaders` map,
so GameView + SceneView both get driven. **2D is uniform-only:** PixiJS has no standard-material
surface to clone, so a `prop` override on a 2D entity is a no-op + one-time warn. And because a source
yields a single **number**, only a **scalar (`float`) uniform** can be driven — a `vec`/`color` uniform
(a `Float32Array`) is skipped + warned (writing a number would NaN the whole vector). Determinism is
identical to 3D: same clock keys, no wall-clock, so a `time`/`store`/`curve`-driven 2D shader is as
reproducible as a 3D one. Authoring is the same `MaterialOverridesField`, which surfaces the 2D
shader's `params` as uniform-target suggestion chips.

## WebGPU Renderer

The 3D renderer is created by `createRenderer(container, preferWebGPU)` in `scene3DSync.ts`, which delegates to `makeWebGPURenderer(container)`:

```ts
export async function createRenderer(
  container: HTMLDivElement,
  preferWebGPU: 'auto' | 'force' = 'auto',
): Promise<WebGPURenderer>
```

- **Always a `WebGPURenderer`.** There is no longer a legacy `THREE.WebGLRenderer` path — `makeWebGPURenderer` always constructs a `WebGPURenderer` (from `three/webgpu`), and when WebGPU is unavailable it runs the *same* TSL/node pipeline on top of WebGL2 via the renderer's internal `forceWebGL` fallback. This is required for TSL post-processing (NPR) to work uniformly.
- **`preferWebGPU` is a no-op.** The parameter is retained for signature compatibility but ignored (`void preferWebGPU`) — both `'auto'` and `'force'` produce a `WebGPURenderer`.
- **Detection & backend selection.** `getWebGPUSupported()` (`gpuDetect.ts`) decides whether native WebGPU is available. The backend is driven by `getRenderSettings().three.backend` (`renderSettings.ts`), not by `preferWebGPU`: `'webgl'` forces the WebGL2 backend outright; `'webgpu'`/`'auto'` (the default) use native WebGPU when the device supports it, else fall back to WebGL2. If a native WebGPU `init()` fails, `makeWebGPURenderer` disposes it and retries once with `forceWebGL: true`.
- **Async init.** `await renderer.init()` runs before the render loop starts. `Scene3D.tsx` gates everything behind the `createRenderer(...).then(...)` resolution and guards post-init teardown with a `disposed` flag (if the component unmounts before init resolves, the renderer is disposed immediately).
- **Tone mapping.** `THREE.ACESFilmicToneMapping`, `toneMappingExposure = 1.2`.
- **Pixel ratio.** `setPixelRatio(Math.min(window.devicePixelRatio, 2))` — capped at 2.
- After init, `setActiveRenderer(r)` is called so `KTX2Loader` can detect GPU formats (see [Materials & Textures](./textures.md)).

### GPU capability detection — `gpuDetect.ts`

`getWebGPUSupported()` is the single CACHED WebGPU probe, shared by BOTH renderers: the 3D `WebGPURenderer` backend pick (above) and the 2D `Canvas2DPool`'s `preference`. It probes once via an inlined native check, `probeWebGPU()` (`navigator.gpu.requestAdapter` + `requestDevice`, mirroring what PixiJS's `isWebGPUSupported` did — inlined so this shared module carries no renderer-SDK dependency), and memoizes the boolean; `getWebGPUSupportedSync()` returns it (or `null` if not probed yet). A module-level `FORCE_WEBGL` constant forces WebGL everywhere for frame-pacing tests. (The related choice of KTX2 texture VARIANT — native-ASTC vs universal UASTC — is a SEPARATE GPU-format probe in `textureResolver`, not here; see [Materials & Textures](./textures.md).)

### Per-game preference

`GameConfig.preferWebGPU?: 'auto' | 'force'` (`runtime/config.ts`) is now vestigial. `Scene3D.tsx` still reads it from the active config and passes it to `createRenderer`, but `createRenderer` discards it — every game gets a `WebGPURenderer` (with WebGL2 fallback) regardless. Several games (including **space-console**) and the starter template still set `preferWebGPU: 'force'`, and its NPR outline post-process still needs the WebGPU node pipeline, but the flag no longer changes behavior:

```ts
// games/space-console/runtime/config.ts
export const spaceConsoleConfig: GameConfig = {
  name: 'Space Console',
  // …
  preferWebGPU: 'force', // no-op: kept for historical parity
};
```

The `GameConfig.preferWebGPU` JSDoc in `runtime/config.ts` is likewise stale (still describes an `'auto'` → legacy `WebGLRenderer` fallback).

### No custom GLSL

Materials are standard Three.js materials (`MeshStandardMaterial`, GLB-imported materials, etc.). `WebGPURenderer` auto-converts them to TSL/WGSL — there is no hand-written shader source in the standard render path. The NPR post-process is the one place that authors node graphs, and it does so through TSL (plus one small raw-WGSL `wgslFn` for FXAA).

## Post-Process Stack

All 3D post-processing runs through **one composable chain**, `rendering/postfx/PostFXStack.ts`.
Effects are **not** mutually exclusive: `NPRPostFX` + `BloomPostFX` + `VignettePostFX` +
`DepthOfFieldPostFX` + `AmbientOcclusionPostFX` can all be on at once. (Before the stack landed,
`Scene3D` had two exclusive branches and "NPR wins, bloom is skipped" — that is gone.)
**Runs on WebGL2 as well as WebGPU — every stage except FXAA.** (This doc long claimed the
opposite: "WebGPU-only; on a WebGL2 fallback every effect is skipped". That was wrong, and an
iPhone 8 on iOS 16.7 — no WebGPU whatsoever — visibly rendering the `postfx-demo` stack is what
caught it.) `createRenderer` (`scene3DSync.ts`) ALWAYS constructs a `WebGPURenderer`
(`preferWebGPU` is vestigial — `void preferWebGPU`), and three falls back to a **WebGL2 backend
inside that same class**. The stack's gate is `isWebGPURenderer === true` (`Scene3D.tsx`), which
stays true on that fallback, so the chain builds and renders normally. The ONE stage dropped is
**FXAA** — `planFxaaEnabled` returns false when `isWebGLBackend` (`postfx/stackPlan.ts`), since
it's a raw-WGSL `wgslFn` the WebGL backend's GLSL parser cannot compile.

⚠️ **`isWebGPU` names the renderer CLASS, not the API in use.** To branch on the actual backend,
read `renderer.backend.isWebGLBackend` — that is the distinction the wrong claim above rested on.

```
scenePass  ── MRT: { output, [normal], [lineColor] }   + depth (free)
     │
     ├─▶ [NPR stylize]        normal + lineColor + depth → stylized color
     ├─▶ [NPR particles]      scene-injecting: particles drawn over the stylized buffer
     ├─▶ [AO]                 consumes depth + normal (see AO section — normal is NOT optional here)
     ├─▶ [DOF]                consumes viewZ
     ├─▶ [Bloom]              color only
     ├─▶ [Vignette]           color only
     └─▶ [FXAA]               tail AA
             │
             ▼
      terminal RenderPipeline  (outputColorTransform = true)
```

### The two invariants

- **I1 — one terminal color transform.** Every stage works in **linear/working space**. The
  stack's own `RenderPipeline` is the *sole* terminal one and keeps `outputColorTransform = true`
  (tone map + sRGB encode, applied exactly once). The NPR particle stage owns an **internal**
  pipeline and must therefore set `outputColorTransform = false`. Getting this backwards
  double-encodes the frame (visibly washed out or crushed).
- **I2 — one canonical MRT layout.** The scene pass's targets are the **union** of what the
  enabled stages need (`output`, plus `normal` for NPR *or* AO, plus `lineColor` for NPR only),
  computed once — never a per-effect target set. This matters because under MRT a `NodeMaterial`
  whose `fragmentNode` writes only target[0] has its **draw silently discarded by WebGPU**.

### Planning is pure — `rendering/postfx/stackPlan.ts`

Zero `three`/TSL imports, so every decision is unit-testable with no GPU
(`tests/runtime/postfxStackPlan.test.ts`). `PostFXStack` must not re-derive any of it:

| Function | Decides |
|---|---|
| `planStages(req)` | The enabled stages in canonical order (NPR → NPR-particles → AO → DOF → bloom → vignette → FXAA), never the request's key order. |
| `requiredMrtTargets(req)` | The minimal MRT union (I2). |
| `stackSignature(req)` | Edge-trigger key, so a static scene does zero per-frame config work. |
| `needsRebuild(prev, next)` | `true` iff the stage SET, the MRT layout, or an NPR **structural** field (`superSampleScale`, `isOrthographic`) changed. A param-only edit returns `false` → a live uniform write, not a shader recompile. |
| `planFxaaEnabled({...})` | FXAA's three preconditions: requested, not the WebGL2 backend, and `superSampleScale === 1`. |

### Stage shapes

Most stages are pure color-node transforms (color in, color out). Two are not, and both are NPR's:
the **stylize** stage reads extra MRT targets, and the **particle** stage is a real scene draw, not
a filter — see the NPR section below.

### Ordering deviations (deliberate — don't "fix" these)

- **Vignette runs pre-tonemap.** Most engines apply it inside the tonemapper; keeping it linear
  preserves I1, and a real lens vignette *is* pre-sensor.
- **FXAA runs pre-tonemap**, matching what NPR did historically. FXAA's luma heuristics assume
  gamma space, so this is a known, pre-existing compromise.

## NPR Outline Post-Process

The engine ships a stylized cel/outline post-process that runs **only on WebGPU**. It is off by default and toggled by the `NPRPostFX` ECS trait. It is **two stages of the post-FX stack** above, not a standalone pipeline — so it composes with bloom/vignette/DOF.

### Stages — `postfx/PostFXStack.ts` (+ `npr/NPRPostProcess.ts`)

There is **no `NPRPostProcess` class**. It used to own two `RenderPipeline`s and was mutually
exclusive with bloom; it is now the `'npr'` and `'npr-particles'` stages built inside
`PostFXStack.buildStage`. `npr/NPRPostProcess.ts` survives as the NPR **shared vocabulary** only:
the public `nprFragmentOutput` / `applyNprFragmentOutput` helpers games call from custom shaders,
the `ensureLineColorOnMaterials` prototype patch, `NPRConfig`, and `computeNprTexelSize`.

**Stage 1 — stylize.** The stack's geometry `pass(scene, camera)` carries an **MRT**
(`setMRT(mrt({...}))`) writing three targets:

- `output` — lit scene color.
- `normal` — view-space normal (`normalView`).
- `lineColor` — `vec4(materialReference('lineColor','color'), materialReference('nprColorPreserve','float'))`: the per-material outline color in RGB and the color-preserve amount in alpha.

The pass excludes `PARTICLE_LAYER` (particles must not be Sobel-outlined or grayscaled) and is
supersampled by `setResolutionScale(superSampleScale)`. `buildCompositeNode` turns those targets
into a stylized color node, which flows on to the next stage.

**Stage 2 — particles (`npr/ParticlePassNode.ts`).** This one is a **real scene draw, not a
filter**: it renders the particle layer with `autoClear = false` over a prefilled color + depth
buffer, so it needs a concrete *texture* to prefill from. Rather than teach the generic stack about
scene-injecting stages, the stage keeps that shape internally — its own `RenderTarget` plus an
**internal** `RenderPipeline` (`outputColorTransform = false`, per I1) that renders everything
upstream into the stylized texture — and hands the chain `particlePass.getTextureNode()`, a plain
texture node every downstream stage filters like any other color. That is what lets bloom glow the
stylized frame *including* its particles.

### Edge detection — `npr/edgeNodes.ts`

Sobel edge detection, built as TSL node graphs over a shared 3×3 stencil:

- `sobelDepth(depthTextureNode, texelSize)` — silhouettes; samples raw perspective depth and linearizes to view-space Z (`perspectiveDepthToViewZ`) so the threshold is scale-invariant.
- `sobelNormal(normalTextureNode, texelSize)` — creases; max magnitude over the X/Y/Z normal channels.
- `sobelLuminance(colorTextureNode, texelSize)` — texture/color seams; Sobel on Rec.709 `luminance`.

### Composite — `npr/compositeNodes.ts`

`buildCompositeNode({ colorNode, normalNode, lineColorNode, depthTextureNode, uniforms })`:

- Runs the three Sobels, `smoothstep`s each over `[threshold, threshold*2]`, and combines them with `max` into a single `edge` mask.
- Builds the **fill**: flat white (`vec3(1.0)`) or grayscale (lit luminance, gamma-remapped via `grayscaleGamma` and lifted via `grayscaleLift`), selected by the `fillMode` uniform.
- Blends lines over the fill: `mix(fillKept, lineColor, edge * lineStrength)`.
- A background mask (`step(0.5, length(normal))`) keeps the camera's `clearColor` outside the silhouette and writes `isForeground` into the output alpha (transparent background for layered DOM).

`nprFragmentOutput(colorRGBA, preserve?)` is a helper for custom `NodeMaterial` shaders rendered into the NPR pass — it wraps a fragment color into an `outputStruct` that writes **all three** MRT targets (so WebGPU validation doesn't discard the draw for missing target outputs). Prefer `applyNprFragmentOutput(mat, colorRGBA, preserve?)` over calling this directly and assigning `fragmentNode` by hand — it also sets `mat.fog = false`, which fog-enabled scenes require (see "Fog" above, NPR interaction).

### FXAA — `npr/fxaaNode.ts`

`buildFXAANode(...)` softens the hard black outlines. It is a self-contained raw-WGSL `wgslFn`
(simplified FXAA 3.11) used because Three.js's built-in `FXAANode` trips a `setLayout`/`Fn` build
bug on r183/r184.

It is now the stack's **tail `'fxaa'` stage**, not part of NPR — NPR used to reason about "FXAA is
the pipeline output", which is invalid once anything runs downstream of it. Because the `wgslFn`
samples with `textureSample`, the stage needs a real texture node: it uses the incoming color
directly when that is already one (the NPR particle texture, or a supersample RTT) and otherwise
resolves the chain through an `rtt()` first. Its texel size is always derived at **display**
resolution. Legality is decided by `planFxaaEnabled` — the `NPRPostFX.fxaa` field still owns the
knob, but the stage is dropped on the WebGL2 backend (the `wgslFn` cannot compile there) and
whenever `superSampleScale > 1` (SSAA already covers it, at scale² cost).

### Supersampling

`superSampleScale` (1 or 2) renders the MRT pass and the composite RTT at a higher internal resolution (`setResolutionScale` / `setPixelRatio`), reducing aliasing at silhouettes and creases before FXAA.

> **Rebuild rule:** `superSampleScale` and the camera projection are **structural** — they resize
> every render target / swap the depth reconstructor, so `needsRebuild` reports them and the driver
> must `dispose()` + reconstruct the stack. Every other NPR parameter is a cheap in-place uniform
> update. An SS-scale change is additionally **debounced** (`npr/ssRebuildDebounce.ts`): dragging
> the slider sweeps a new value almost every frame, and rebuilding per intermediate value thrashes
> shader compiles. The driver holds the request's scale pinned to the applied value until the
> target settles, and only then latches the signature — do not simplify this away.

### Color preservation

The material property `nprColorPreserve` (0..1) lets a material keep its true hue through NPR. It's injected into the `lineColor` MRT target's **alpha**; the composite lerps the grayscale fill toward the lit scene color by that amount (`mix(fill, sceneColor, preserve)`). Outlines are still drawn on top at every preserve level.

Both `lineColor` and `nprColorPreserve` are auto-patched onto `THREE.Material.prototype` via `Object.defineProperty` (defaulting to black / `0`), so `materialReference(...)` resolves for **all** materials — including GLB-imported ones — without patching every creation site. (The `Tint` trait sets `nprColorPreserve` on its tinted clones so the grayscale fill blends toward the team color.)

### Control trait — `runtime/traits/NPRPostFX.ts`

`NPRPostFX` is a singleton ECS trait (first entity wins), editable in the Inspector. Defaults from the source:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Master toggle; routes `Scene3D` through the composer when true. |
| `fillMode` | `'grayscale'` | `'flat'` (white sheet) or `'grayscale'` (lit luminance remap). |
| `depthThreshold` | `0.005` | View-space depth Sobel threshold for silhouettes. |
| `normalThreshold` | `0.4` | Normal Sobel threshold for crease edges (0..1). |
| `colorThreshold` | `0.15` | Luminance Sobel threshold for texture/color edges (0..1). |
| `lineThickness` | `1` | Sobel sample radius in pixels (1 or 2). |
| `lineStrength` | `1` | Multiplier on the line mask before darkening the fill (0..1). |
| `grayscaleGamma` | `0.7` | Luminance remap exponent (grayscale mode); `<1` lifts midtones. |
| `grayscaleLift` | `0.3` | Black lift in grayscale mode (0..1). |
| `fxaa` | `true` | FXAA post-AA on the composite output. |
| `fxaaEdgeThreshold` | `0.125` | FXAA relative-contrast threshold (typical 0.05–0.25). |
| `fxaaEdgeThresholdMin` | `0.0312` | FXAA absolute luma floor — pixels below are flat. |
| `fxaaBlendStrength` | `4.0` | FXAA blur strength on detected edges (typical 2–8). |
| `superSampleScale` | `1` | MRT + composite supersample factor (1 = native, 2 = 4× pixels). **Rebuilds the pipeline.** |

### Integration — `Scene3D.tsx`

There is **one** post-FX code path; NPR has no branch of its own.

- Each frame `Scene3D` reads the `NPRPostFX`, `BloomPostFX`, `VignettePostFX` and
  `DepthOfFieldPostFX` singletons (first entity with the trait wins) and builds a single
  `PostFXRequest`. NPR also feeds the active camera's `clearColor` into its stage config.
- The stack is built **lazily** on the first frame `planStages(req)` is non-empty *and* the
  renderer is WebGPU (`renderer.isWebGPURenderer === true`); otherwise
  `renderer.render(scene, activeCamera)`.
- Turning every trait off keeps the stack alive but routes around it, so toggling stays cheap.
- `setConfig()` applies cheap uniform updates; a `true` return disposes and rebuilds. A
  camera-object swap (perspective ↔ ortho) also forces a rebuild.
- The request is edge-triggered on `stackSignature`, so a static scene does no per-frame config work.
- Resizing needs no post-FX call: every resolution-derived uniform (NPR + FXAA texel size, the
  stylized RT size) is recomputed from the live drawing buffer in each stage's per-frame prologue.

## Gotcha: TSL first-compile race (prewarm)

TSL node builders have a racy lazy initialization on the **first** compile a renderer ever performs. If an MRT/NPR pass happens to be that first compile — e.g. in the lazily-mounted editor Game panel, which mounts *after* the initial scene swap so the normal pre-swap prewarm hook never fired — WGSL generation can intermittently fail with `unresolved type 'OutputType'` and the mesh is dropped.

**Fix:** `Scene3D.tsx` calls `prewarmShadersForWorld(getCurrentWorld(), renderer, camera)` on mount, **before** registering the render loop, so a normal material compiles first and primes the node builder. (`prewarmShadersForWorld` also mirrors the world's lights and environment so it compiles the correct PBR shader variants, eliminating first-frame stutter on scene swap.)

**Related HMR caveat — editing a shader module forces a RELOAD, automatically.** TSL node (and `wgslFn`) instances get baked into compiled WGSL pipelines; hot-reloading a module creates new node identities that the old cached pipeline still references, raising the same `unresolved type 'OutputType'` error — or, worse, silently keeps rendering the PREVIOUSLY compiled graph so a correct fix looks like it did nothing. A full page reload is the correct (and cheap) price for a stable cache.

The reload is now decided **by path on the dev server**: `isShaderGraphFile` (`engine/plugins/vite-asset-scanner.ts`) matches anything under `runtime/rendering/postfx/` or `runtime/rendering/npr/`, and `handleHotUpdate` sends `modoki:shader-code-changed` instead of letting Vite propagate an update. The renderer (`engine/app/debug/hmrStaleness.ts`) then reloads — via the same unsaved-scene countdown banner the game-code reload uses, so a shader edit can never silently discard scene work. ⚠️ **Do NOT re-add `import.meta.hot.invalidate()` to these modules** (they all used to carry it): `invalidate()` does not force a reload, it propagates to importers and stops at the first one that ACCEPTS — and the only importer is `Scene3D.tsx`, a React Fast Refresh boundary that self-accepts, so it was silently swallowed. Fast Refresh then re-ran the component but not its `[]`-deps effect, leaving the already-built `PostFXStack` (and its stale compiled graph) alive. That is exactly how one DOF `viewZ` fix was concluded "didn't work" three separate times. Since `engine/plugins/**` is not hot-reloadable, restart the editor once after changing the rule itself.

## Bloom Post-Process

A reusable whole-scene HDR bloom, added for `demos/particle-demo`'s dark-VFX showreel but not
specific to it — any 3D scene can add the trait. Off by default, toggled by the
`BloomPostFX` ECS trait (and it renders on the WebGL2 backend too — see the stack's gate above). It is a **stage of the post-FX stack**, so it composes with NPR,
vignette and DOF rather than being an alternative to them.

### Control trait — `runtime/traits/BloomPostFX.ts`

Singleton (first entity wins), editable in the Inspector:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `false` | Master toggle. |
| `strength` | `0.8` | Glow intensity (typical 0.3–1.5). |
| `radius` | `0.6` | Blur spread (0..1). |
| `threshold` | `0.0` | Only pixels brighter than this bloom; `0` blooms the whole scene (the right value on a near-black void, where bloom itself acts as the key light). |

### The stage

There is no `BloomPostProcess` class — it was replaced by the stack. The `'bloom'` stage is a few
lines of `PostFXStack.buildStage`: `bloom(color, strength, radius, threshold)` (from
`three/examples/jsm/tsl/display/BloomNode.js`) builds the glow node and `add(color, bloomPass)`
composites it. `bloom()` returns a Node class whose `strength`/`radius`/`threshold` are live
uniforms, so `setConfig` is a uniform write and never a rebuild.

All three tunables update live. Particles ride `PARTICLE_LAYER`, which the camera already enables,
so a whole-scene bloom includes them — this is what makes additive particle effects read as the
scene's only light source. Under NPR the particles arrive via the NPR particle stage instead, and
bloom still sees them.

- **NPR + bloom compose.** Bloom operates on the working-space stylized color, so a stylized scene
  gets a real glow. (This was the exclusivity the post-FX stack existed to remove.)
- **WebGL fallback**: gated on `isWebGPU`, which is the renderer CLASS and stays true on the
  WebGL2 backend — so bloom still renders there. (This bullet used to say the render "falls
  through to the plain path (no bloom, no error)". Wrong — see the stack's gate above.)
- Same shader-HMR / prewarm-race caveats as NPR (see above) — TSL bakes into WGSL, so the stack is
  disposed on camera-projection swap and never hot-reloaded in place; editing anything under
  `postfx/` forces a full reload from the dev server.

## Vignette & Depth of Field

Two more stack stages, each with its own singleton trait
(`VignettePostFX` `{enabled, intensity, smoothness}`, `DepthOfFieldPostFX`
`{enabled, focusDistance, focalLength, bokehScale}`), both off by default and, like every stack
stage bar FXAA, working on the WebGL2 backend too (see the stack's gate above).

- **Vignette** uses `vignette()` from `three/examples/jsm/tsl/display/CRT.js`, which is a bare TSL
  `Fn`, **not** a Node class — so the stage must pass `uniform()` nodes for `intensity`/
  `smoothness`, or the values freeze at graph-build time and `setConfig` can never reach them.
- **DOF** uses `dof(color, viewZ, ...)`. ⚠️ Its `viewZ` must **not** come from
  `PassNode.getViewZNode()`, which hardcodes `perspectiveDepthToViewZ` with no ortho branch —
  `postfx/dofViewZ.ts` picks the matching reconstructor from the camera's projection instead
  (`tests/runtime/dofViewZ.test.ts` pins it).

## Ambient Occlusion (GTAO)

`AmbientOcclusionPostFX` `{enabled, radius, intensity}`, off by default, WebGL2 backend included
(see the stack's gate above). Uses
`ao(depthNode, normalNode, camera)` from `three/examples/jsm/tsl/display/GTAONode.js`, which
returns a `GTAONode`; its output texture's `.r` (raw 0..1 occlusion) is lerped toward `1` by
`intensity` (GTAO has no strength knob of its own) and multiplied into the incoming color.

⚠️ **Always passes a REAL normal buffer — the "nullable normalNode" cheap path is broken here.**
`ao()`'s `normalNode` argument is documented as nullable (GTAO reconstructs normals from depth
when it's `null`), and that was the original plan. It doesn't work under this renderer:
`getNormalFromDepth`'s null-normal fallback compiles `textureDimensions(depthTex, 0)`, but the
depth attachment is **multisampled**, and WGSL's multisampled-texture overload of
`textureDimensions` takes **no level argument** — confirmed via the browser's native WGSL
compiler diagnostic (`THREE.[Invalid ShaderModule "fragment_GTAO"]`, root cause `no matching
call to 'textureDimensions(texture_depth_multisampled_2d, abstract-int)'`), not a wiring
mistake. So `requiredMrtTargets` forces the `'normal'` MRT target for AO too — the same target
NPR already forces, just triggered by one more gate (never `lineColor`, which stays NPR-only).
When NPR is also enabled they **share** the same normal texture node; AO alone still costs the
extra MRT target.

⚠️ Same silently-discarded-draw hazard as NPR (I2): a custom-shader `NodeMaterial` combined with
AO on the (previously MRT-free) plain path must emit both MRT targets or its draw is dropped.
Inert today — no shipped game enables `AmbientOcclusionPostFX`.

## 2D Rendering (PixiJS)

The `2d` layer draws `Renderable2D` (and `Text2D` / `SkinnedSprite2D`) entities with PixiJS v8, into one or more **Canvas2D** host entities. `Scene2D.tsx` owns the pass; `render2DUtils.ts` holds the shape / pivot / scale math shared with the editor's Canvas2D preview so the two can't drift (guarded by `tests/runtime/render2DParity.test.ts`).

### Canvas2D host + design-resolution scaler

A **Canvas2D** entity (`traits/Canvas2D.ts`) marks a UI element that hosts a PixiJS `<canvas>`; every `Renderable2D` descendant renders into its NEAREST Canvas2D ancestor (`canvas2DRouting.ts` `findCanvasAncestor` — a cycle-guarded walk up `EntityAttributes.parentId`; an entity that IS a Canvas2D resolves to itself). Content is authored at a design resolution (`referenceWidth`×`referenceHeight`, default 1080×1920) and mapped onto the live canvas pixels by `canvas2DScaler.ts` `computeCanvasScale(refW, refH, actualW, actualH, mode)`:

> **GOTCHA — a Canvas2D host MUST be a UI node, or its `<canvas>` never mounts (silent black).** The pooled PixiJS canvas is attached to the DOM by `Canvas2DMount`, which the `UIRenderer` renders **only for entities that appear in the UI tree** — i.e. entities that carry `UIElement` (+ `RenderableUI`, and normally `UIAnchor`). A bare Canvas2D entity (just `Canvas2D` + `EntityAttributes`) is NOT a UI node, so no `Canvas2DMount` is created, no canvas mounts, and every `Renderable2D` under it draws to nothing — with **no error** in either viewport. Always give a Canvas2D host the full UI-node trait set: `RenderableUI` + `UIAnchor {anchor:'stretch'}` + `UIElement {width:100%, height:100%}` + `Canvas2D` (this is exactly what the editor's **Create ▸ Canvas2D** / `canvas2DSpecs` produces — never hand-author a Canvas2D without them). The `Renderable2D` children themselves need only `Transform` + `Renderable2D` (+ `EntityAttributes`), positioned in the host's design-resolution space.

| `scaleMode` | Behaviour |
|-------------|-----------|
| `fitW` | Match width exactly (the other axis may crop / letterbox). |
| `fitH` | Match height exactly (default). |
| `contain` | Uniform scale to fit ENTIRELY inside (letterbox the excess axis). |
| `cover` | Uniform scale to COVER the area (crop the overflow axis). |
| `fill` | Non-uniform stretch to fill exactly (no crop, no letterbox). |
| `none` | 1:1 pixels. |

Every mode CENTERS the content (via `offsetX`/`offsetY`). `fill` stretches non-uniformly, so the scaler also returns `compensateX`/`compensateY` (= `uniformScale / axisScale`) which Scene2D multiplies back onto each object's scale so PRIMITIVE SHAPES stay un-stretched even while the container fills. `screenToReference2D` inverts the mapping for 2D picking (client px → reference space), shared by the DOM SceneView layer and the Pixi pick overlay so both pick identically.

### Primitives, sprites, tint

`Renderable2D.sprite` selects the display kind:
- **Primitive keyword** — `square` / `triangle` / `circle` (empty ⇒ circle) → a PixiJS `Graphics` tinted by `Renderable2D.color`, vertices from `computeShapeGeometry` (`render2DUtils.ts`).
- **Image ref** (GUID / path / URL) → a PixiJS `Sprite`; textures load async through the GLOBAL `Assets` cache (KTX2 decoded for the 2D path — see [Materials & Textures](./textures.md)) and are preloaded before a scene swap so there's no pop-in. A sliced sprite / atlas frame gets a per-slot framed Texture WRAPPER (sub-rect of the shared source); a sprite-sheet frame swap that keeps the same base texture swaps the sub-rect IN PLACE (no texture-unload churn).
- **`collider`** sentinel → draws the entity's OWN `Collider2D` shape as a filled (open polyline: stroked) body — for polygon/polyline/concave colliders that have no primitive form.

Shared placement knobs: `width`/`height` (half-extents), `pivotX`/`pivotY` (0 = edge, 0.5 = center), `keepAspect` (uniform sprite scale = `min(scaleX, scaleY)`), `flipX`/`flipY` (render-only mirror about the pivot — a sign flip on scale that never touches the transform, mirrors no children, and is invisible to the physics collider), `opacity` (alpha), and `isVisible` (per-renderer hide, ANDed with the entity's `isActive`).

**Blend mode.** `Renderable2D.blendMode` (`normal` | `add` | `multiply` | `screen`, default `normal`) sets the Pixi compositing mode on both the sprite and primitive paths — `add` gives an additive glow (on dark backdrops) with zero shader work. Mapped through the shared `pixiBlendMode2D` guard in `render2DUtils.ts` (an unknown/legacy value coerces to `normal`); also applied to the material path below.

### 2D custom materials (PixiJS shaders)

`Renderable2D.material` (empty by default) points at a **`space:'2d'` `.shader.json`** — a custom fragment shader that draws the entity instead of the default tint/texture path. It's the 2D twin of the 3D `shader:'file'` material, built for PixiJS rather than Three, and its uniforms are driven at runtime by [`MaterialInstance`](#materialinstance--runtime-material-parameter-driving).

- **Asset shape.** A `.shader.json` with `space:'2d'` + a `params` block, plus sibling `<name>.wgsl` / `<name>.glsl` bodies (Pixi v8 is WebGPU-preferred, so both backends ship). The body is a fragment MAIN snippet that writes `outColor` (a premultiplied vec4; the base high-shader multiplies it by `vColor` = the mesh tint/alpha). Available in the body: `vUV` (the texture-space UV — 0..1 for a whole-image sprite, the atlas sub-rect for a slice), `uTexture`/`uSampler` (the sampled texture), and the params as a uniform block — WGSL `matUniforms.<param>`, GLSL loose `<param>`. One configured shader = one material (v1); multiple looks = multiple assets.
- **Builder** — `pixiShaderBuilder.ts` generalizes the MTSDF text shader (`mtsdfPixiShader.ts`): it composes Pixi's own high-shader bits (`localUniformBit` transform, `textureBit` sampler, `roundPixelsBit`) + ONE generated custom bit that declares the uniform block (a WGSL `struct MatUniforms` at `@group(3)`, or GLSL loose uniforms) and splices the authored body — so the engine owns only the fragment maths. It compiles **only the active backend's** program (resolved by the shared `canvas2DPool.resolvePixiBackend`, honoring the `pixi.backend` override so the program always matches the live renderer), once per asset; each entity mints its OWN `Shader` (its own `UniformGroup`) so uniforms are per-entity. **Reserved-name guard:** a param keyed like a Pixi built-in (`uColor`/`uTexture`/`uResolution`/…) is rejected at build + validation (it would break the WebGL fallback where uniforms are loose globals).
- **Cache** — `spriteMaterialCache.ts` resolves a material GUID → compiled program, lazily and deduped (a failed compile is marked so it isn't retried every frame). World-lifecycle: cleared **unconditionally** on world swap / teardown (a compiled program holds no GPU memory of its own — Pixi caches the underlying programs by source and each live per-entity `Shader` holds its own reference — so a clear only empties the maps, and clearing on swap is what makes an edited `.shader.json` recompile on hot-reload). The GUID is a scene resource (`type:'shader'`, no-op acquire — tree-shaker keep; the `.wgsl`/`.glsl` siblings are kept by the shader-manifest sweep).
- **Rendering** — Scene2D draws a material entity in a SEPARATE pass (like the skinned/text passes, so it can't destabilize the sprite change-detection) as a `Mesh`: a pivot quad (`buildMaterialQuad`, sized like a primitive) + the per-entity `Shader`, with `blendMode`/tint/alpha/transform/paint applied. The sprite pass skips a material entity once its program is ready and falls back to the default sprite/tint while it loads (an `onReady` wake re-renders when the async compile lands, even while the sim is stopped). Each entity's `Shader` is registered in a Scene2D-owned `entityShaders` map (published via `sprite2DMaterialBroker` for the driver) and disposed with its slot.
- **Redraw gate (`MaterialSnap`)** — a material's uniforms are usually the only thing that moves per frame, and the driver writes them straight into the `UniformGroup` with no render-visible signal, so the pass can't tell a changed frame from a static one on its own. Rather than force a GPU pass every running frame, the material pass dirties its canvas only when (a) the `Mesh` was just (re)built, (b) an external edit/load/swap forced it, (c) the placement/appearance moved vs a per-entity `MaterialSnap`, or (d) a driver wrote a NEW uniform value this frame: `materialInstanceSystem` compares-before-write and, on an actual change, flags the entity through `sprite2DMaterialBroker` (a per-frame set it clears at the top of its pass, at ECS priority — before the render passes read it). So an animating material still redraws each frame, but a static-uniform one (no driver, a constant curve, or a stopped clock) costs zero redraws once settled.
- **Sampling the sprite bitmap.** The material Mesh samples the entity's OWN `Renderable2D.sprite` as `uTexture` (`resolveMaterialTexture` resolves the GUID and loads it through the shared `spriteTextureRefs` refcount, exactly like the sprite pass — retained on build, released in `disposeSlot`). While the texture loads — or when the entity has no image sprite (a purely procedural shader like `gradient-scroll`) — it falls back to `Texture.WHITE`; the resolved url is part of the slot's rebuild signature (`matSig`), so the Mesh re-mints with the real bitmap the frame it becomes resident. A texture is only bound once its `source` is live (a cached-but-mid-decode/stale texture would otherwise crash the shader on `source.style`). Example: `games/3d-test/.../shaders/dissolve.{shader.json,wgsl,glsl}` (samples `uTexture`, burns it away by a hashed-noise `uThreshold`), driven by a MaterialInstance `time` curve — demo scene `games/3d-test/.../scenes/2d-material-demo.json`. An **atlas slice** (a `resolved.frame`) binds a per-slot framed WRAPPER Texture whose uv matrix (`uTextureMatrix` = the texture's `mapCoord`) maps the quad's 0..1 UVs into the sub-rect, so the shader samples the right pixels (a whole image borrows the base texture, identity matrix); the wrapper is `destroy(false)`d in `disposeSlot` (source kept for the refcount). `matSig` carries the sprite REF so a frame swap on one sheet forces a rebuild. `vUV` is therefore texture-space (0..1 whole, sub-rect for a slice).
- **Extra samplers (`texture` params).** A shader can declare `texture`-typed params — each becomes an ADDITIONAL sampler beyond the entity's own `uTexture`. A texture param's VALUE is its manifest `default` (a sprite GUID) OR a per-instance `MaterialInstance` override with `kind:'texture'` + a `ref` on that target (a STATIC swap — MaterialInstance *sources* drive only scalar uniforms, so a texture ref isn't animated; `readTextureOverrides` collects them, the override wins over the default, and the resolved url is in `matSig` so an inspector edit rebuilds the Mesh with the new texture). Scene2D resolves each WHOLE-image through the same `spriteTextureRefs` refcount + KTX2/WebP variant seam as the sprite (`resolveMaterialTexture(ref, wholeOnly)`), retains each url on build (stored in `slot.materialTexUrls`), releases them in `disposeSlot`, and binds them in `makePixiShaderInstance`. An unresolved extra texture binds `Texture.WHITE` (WebGPU needs every declared group-3 binding present) and `matSig`'s `extraSig` forces exactly one rebuild when it lands. **WGSL binding:** the custom bit declares extra textures in `@group(3)` at binding `1+2i` (texture) / `2+2i` (`<key>Smp` sampler) — binding 0 stays reserved for `matUniforms` — so a texture param `uFoo` is sampled `textureSample(uFoo, uFooSmp, vUV)` (WGSL) or `texture(uFoo, vUV)` (GLSL). Extra textures are whole-image (no atlas sub-rect) and sampled at the sprite-space `vUV`. **Authoring footgun:** never write `@group(N)`/`@binding(N)` in a WGSL body COMMENT — Pixi's `extractStructAndGroups` regex only skips a decorator when the char before `@` is `/`, so `// @group(3) … ;` (space after `//`) is parsed as a real binding and silently fails the whole material. Example: `games/3d-test/.../shaders/reveal.{shader.json,wgsl,glsl}` (cross-fades the sprite with a Metal texture bound to `uReveal`, mix driven by a MaterialInstance) in `2d-material-demo.json`. **Build:** the asset tree-shaker keeps extra-sampler textures in prod — `processShader` follows a 2D shader's `texture`-param `default` GUIDs and `probeTraitRefs` follows `MaterialInstance` `kind:'texture'` override refs (both were previously shaken out → a 404 in prod). **Runtime gap:** like every 2D texture, an extra sampler loads LAZILY (one-frame pop-in) — not scene-pre-acquired; the scene `resources` manifest lists override refs (via `collectResourceRefsFromEntities`) but not the async shader-manifest defaults. Scalar-VALUE overrides remain **uniform-only** and **scalar-only** (see the MaterialInstance section); a `kind:'texture'` override is the only non-scalar override kind, and it's 2D-only.

### Paint order

`paintOrder.ts` `computePaintOrder` is the single stacking source shared with the editor SceneView: a depth-first walk of the hierarchy by `EntityAttributes.sortOrder` (lower = painted first / furthest back; last-visited on top), assigned to each object's Pixi `zIndex` (slot containers are `sortableChildren`, set ONCE at slot creation). `Renderable2D.orderInLayer` / `Text2D.orderInLayer` (Unity "Order in Layer") RE-RANKS globally — higher = on top, independent of tree position, with the hierarchy DFS index as the stable tiebreak — so a cut-out character's parts parented to scattered bones can stack by an explicit layer order.

### Per-viewport instancing

The pass is a `Scene2DRenderer` CLASS (not a singleton): a Pixi display object and a `<canvas>` can each live in only ONE place, so each viewport rendering the same world — the runtime / GameView vs the editor SceneView — owns its OWN renderer, display objects, dirty state, particle state, and `Canvas2DPool`. A module-level `defaultRenderer` on the `defaultPool` backs the free-function exports so runtime + GameView stay byte-identical. The PRIMARY (runtime) renderer owns process-wide registrations — the layout-bounds provider, the prewarm-before-swap hook, and the `unloadAllSpriteTextures` net; a non-primary (editor) renderer skips all three so it never tears texture accounting out from under GameView. The `Assets` decoded-image cache + its refcount (`spriteTextureRefs`) are GLOBAL across renderers — a per-viewport count would `Assets.unload()` a texture another viewport still shows.

### Dirty gating

`renderFrame` used to re-tessellate + GPU-render every Canvas2D every frame; a two-tier gate fixes that:
1. **Idle whole-frame skip** — while the sim is stopped / paused, 2D only changes via paths that set `_externalDirty` (editor edits, async texture loads, canvas resizes, world swaps, play-state changes), so idle + clean ⇒ no ECS scan, no render.
2. **Per-entity change detection** — a `RenderSnap` / `MeshSnap` / `TextSnap` per entity captures the exact inputs that determine its output; only Canvas2D hosts with a CHANGED entity are GPU-rendered (`dirtyCanvases` → `pool.renderAll(dirtyIds)`). `preserveDrawingBuffer: true` keeps a skipped canvas's last frame on screen across a browser recomposite (scroll, ancestor transform, tab refocus).

### Canvas2D Application pool + GPU-context budget

`canvas2DPool.ts` pools one PixiJS `Application` (+ `<canvas>` + root `Container`) per Canvas2D entity, `backgroundAlpha: 0` for transparency over the 3D layer. Each INITIALIZED slot = one live GPU context; browsers cap live WebGL contexts (~8–16) and evict the oldest past that, so the pool tracks a cross-pool live-context count and warns ONCE past a soft limit of 8 (`SOFT_CONTEXT_LIMIT` — catching a slot leak or an unusually context-heavy scene before the browser silently drops a context), and caps slots at `MAX_SLOTS = 6`. Real scenes use 1–2 canvases.

A slot has TWO independent claims and is reclaimable only when BOTH drop:
- **`boundBySim`** — Scene2D's claim: the Canvas2D entity is present in the world (`allocate` / `release`).
- **`mounted`** — Canvas2DMount's claim: the slot's `<canvas>` is in the DOM (`mount` / `unmount`).

Reclaiming only when both clear stops mount/unmount churn from leaking slots AND stops slot reuse from destroying the WebGL context behind a still-visible canvas; `entityId === null` is the canonical "unclaimed" marker. The pool DETACHES children on reclaim but never destroys them — Scene2D owns display-object destruction + texture-refcount release (destroying in both places would double-free). `renderAll` swallows a transient teardown-race throw (a canvas losing its context mid-swap) silently and only warns after 30 consecutive stuck frames.

### 2D SDF text (MTSDF)

`Text2D` (`traits/Text2D.ts`) renders as a PixiJS mesh using the SAME MSDF/MTSDF font atlas + effect maths as the 3D `Text3D`, so 2D and 3D text look identical. Three pieces:

- **Layout** — `text/layoutText.ts` (`layoutText`) is pure + headless: a string + a synchronous glyph source → positioned textured quads in px, Y-down, block-local space (origin = top-left of the text box). Handles hard `\n` breaks + greedy word wrap (`maxWidth`), per-line kerning, `align` (left/center/right), `lineSpacing`, `letterSpacing`, and a fallback advance for a not-yet-generated glyph. Each quad carries its atlas `page`, so the geometry builder groups quads by page. It's the single geometry source BOTH text paths feed.
- **Shader** — `text/mtsdfPixiShader.ts` (`makeMtsdfPixiShader`) composes Pixi's own high-shader BITS (`localUniformBit` transform, `textureBit` atlas sampler, `roundPixelsBit`) with ONE custom `mtsdfBit` that overrides the fragment colour — reusing Pixi's per-backend transform boilerplate and shipping BOTH WGSL and GLSL programs (Pixi v8 is WebGPU-preferred). The fragment maths mirrors the 3D TSL graph 1:1: median (sharp) fill, outline via the median, alpha-SDF glow, offset-sample shadow, `screenPxRange` AA via `fwidth`, composited straight-alpha. Style uniforms (`weight` / outline / glow / shadow) update in place (`updateMtsdfPixiStyle`); a per-glyph `aTextColor` vertex attribute (for rainbow/fade colour animation) premultiplies onto Pixi's built-in `vColor`.
- **The default font is ENGINE-provided** — `DEFAULT_FONT_GUID` (`runtime/assets/builtinAssets.ts`, exported from `@modoki/engine/runtime`) is the engine's Arimo, baked mtsdf/ascii. A game does NOT need a font in its own assets to render `Text2D`; point `Text2D.font` at that GUID. It exists because fonts are otherwise referenced by CSS **family name** and stay guid-less — the asset scanner deliberately skips GUID healing for them — while a `Text2D` ref must be a GUID, so before it, getting MSDF text meant copying a font into the project (Court shipped a byte-identical 500 KB duplicate for exactly this reason, #52). It is the one engine font with a committed `.meta.json`; the other bundled families stay family-name-only, and the tree-shaker keeps a font only if something names it (measured: Court's build keeps **1 of 9** engine font files). A code-only reference still needs an `asset-keep.json` entry — the path is under `/modoki/assets/`, which is keep-listable like any project path.
- **⚠️ The GLSL program declares `OES_standard_derivatives`, and WHERE it declares it is load-bearing.** Pixi's high-shader assembly emits **version-less (GLSL ES 1.00)** source — it only takes the ES 3.00 path when the source literally contains `#version 300 es` (`GlProgram`: `indexOf('#version 300 es')`). In ES 1.00 the `screenPxRange` line's `fwidth` is illegal without the extension declared, so every MTSDF program failed to compile on iOS 15 (`ERROR: 'GL_OES_standard_derivatives' : extension is disabled`) and **every glyph silently vanished**. Not a capability gap — WebGL2 and the extension are both present; desktop and Android drivers simply accept `fwidth` in ES 1.00 source anyway, so only Apple's stricter compiler rejects it, which is why it hid on every machine we test on. The directive **must precede `precision`**: measured on-device, a pragma placed in this file's `fragment.header` bit (where Pixi injects it, i.e. *after* the precision line) fails just as loudly with `extension directive must occur before any non-preprocessor tokens`. Hence `withDerivativesExtension` rewrites the ASSEMBLED source instead. `enable`, not `require`, so a device lacking it degrades to a warning; not switched to `#version 300 es`, which would hard-fail a genuinely WebGL1-only device.
- **A baked font's SOURCE file is not always shipped.** `Text2D` needs only `~atlas.png` + `~metrics.json`; the `.ttf` ships only when a DOM consumer names the family. See [build.md](./build.md) § "Converted assets" — including the blind spot where a CSS-named family needs `shipSource: 'always'`.
- **Per-page meshes + dynamic packing** — one Pixi `Mesh` per atlas PAGE the text touches (a dynamic CJK provider spills glyphs across pages; a baked / single-page font is one mesh), all children of the slot `Container` so the anchor pivot + transform apply to the whole block. Geometry rebuilds only when the layout hash changes (text/font/size/wrap/spacing/`atlasVersion`); the shader updates only on a style-hash change; placement writes only when the transform moves. Atlas textures are FONT-owned (freed on scene teardown), never disposed by the slot. Per-glyph animation recomputes page positions from the base quads each frame while the sim runs (frozen when stopped, like skeletal animation).

## Shipped web build: canvas sizing (`rendering.web.sizeMode`)

How the STANDALONE web game's layer container (`App.tsx`'s `.game-wrapper`) is sized in the
browser. Project Settings → **Screen / Canvas Size**; geometry in
`runtime/rendering/webCanvasSizing.ts` (pure, unit-tested). Editor viewports are unaffected —
they size themselves / use device presets.

| `sizeMode` | Container | Drawing buffer |
|---|---|---|
| `free` (default) | fills the viewport | full CSS size |
| `fixed` | letterboxed to the `width`×`height` ASPECT, centred on black | fills that (smaller) container |
| `max` | fills the viewport | clamped to ≤ `width`×`height` **device px** (after devicePixelRatio), upscaled to fill — a literal ≤`width`×`height` buffer on every device, retina included; saves fill-rate on 4K/high-DPR |

`width`/`height` are read only by `fixed`/`max`. `max`'s buffer clamp applies to BOTH
render layers — the 3D layer (`Scene3D`, via a scaled pixel ratio) and the 2D layer
(`Canvas2DMount`, via `canvas2DSizing.computeBackingSize`), opt-in per surface
(`applyWebSizeMode`) so the editor viewport is excluded. Worked example: `games/sling` ships
`fixed` 1080×1920, so on a desktop window it presents as a phone-shaped portrait box with
bars either side.

**How each layer reaches the clamped buffer** — the two renderers size their buffers
differently, so `max` cannot be applied the same way to both:

- **2D** sizes its backing directly. `canvas2DSizing.computeBackingSize` is the whole
  pipeline: `rect` (CSS, already including any editor CSS-transform zoom) → × the backing
  ratio, capped at `pixi.pixelRatioCap` on the auto path only (a pinned `pixi.resolution` is
  never capped) → the `max` clamp → a uniform 8192 longer-axis cap (GPU max-texture guard). It
  returns `0×0` for an unmeasured (0×0) box *before* clamping, deliberately — `clampBufferSize`
  floors at 1×1, which would look "measured" and defeat `retrySizeUntilMeasured`'s bounded
  retry.
- **3D** cannot. three computes `canvas.width = floor(cssWidth × pixelRatio)`, so shrinking
  the CSS size it is handed just gets re-multiplied by the ratio. `clampPixelRatio` therefore
  rides the clamp on the RATIO instead, reaching the same buffer through three's own maths.
  It is applied in TWO places, and both are load-bearing: `makeWebGPURenderer`'s initial
  `setPixelRatio`/`setSize` pair (the FIRST buffer — same `applyWebSizeMode` opt-in as the 2D
  side, since that function is shared with SceneView / ParticleEditor / ModelPreview / the caps
  probe) and `Scene3D`'s `ResizeObserver` (every resize after). Clamping only on resize left a
  one-frame full-resolution allocation at mount — the exact peak `max` exists to avoid (#56).
  **The two must compute the same ratio for the same container**, base included (`min(
  devicePixelRatio, three.pixelRatioCap)`) — if they disagree, the observer's first fire
  reallocates the buffer one frame after mount and you have traded a spike for a churn. Pinned
  by a test that compares the creation-time `setPixelRatio` against `clampPixelRatio` directly.

> **GOTCHA — `max` was a no-op on every retina display until #38, for exactly that reason.**
> The clamp was applied to the CSS box and three multiplied it straight back out. A logical
> viewport rarely exceeds the `width`×`height` target (a phone is ~393×852 CSS px), so the
> mode silently did nothing on the high-DPR hardware it exists for. If you touch this, assert
> on `canvas.width` — the real drawing buffer — never on the CSS size or on `setSize`'s
> arguments. `Scene3D` also recomputes its base ratio from `devicePixelRatio` on every
> resize rather than reading `renderer.getPixelRatio()` back: the getter returns the
> already-clamped value, which cannot climb again when the container shrinks.

> **GOTCHA — `pixi.resolution` is applied by the ENGINE, not handed to Pixi.** `0` = auto
> (use `devicePixelRatio`), a positive value pins the backing multiplier; either way it is
> folded into `computeBackingSize` and Pixi is left at its own default resolution of **1**,
> so `renderer.resize(w, h)` means literally `w`×`h` backing pixels. Passing it to
> `Application.init()` instead double-counts (the DPR is already applied before `resize` is
> called) and `autoDensity: true` writes inline canvas styles that fight `Canvas2DMount`'s
> `width/height: 100%`. Note Pixi's default is 1 and **not** `devicePixelRatio`, which the
> code comments claimed for a while.

**Both layers cap devicePixelRatio by default** (issue #55) — 3D via `three.pixelRatioCap`,
2D via its own `rendering.pixi.pixelRatioCap`, each defaulting to **2** so a DPR-3 phone
renders both layers at the same backing ratio out of the box instead of the 2D HUD running
sharper (and 2.25× the fill-rate) than the 3D scene under it. There are two separate knobs
rather than one shared value — the owner chose per-layer flexibility (a game may want the
two layers capped differently) over renaming a shipped `three.*` field to something
layer-neutral. `pixi.pixelRatioCap` applies to EVERY 2D surface unconditionally, editor
viewports included (unlike the `max` sizeMode clamp above, which is opt-in via
`applyWebSizeMode`) — mirroring how `three.pixelRatioCap` applies at renderer creation with
no opt-out. The cap only binds on the AUTO path: a pinned `pixi.resolution` (see the GOTCHA
above) is an explicit "I want exactly N" and is never capped — capping a pin would make the
pin a lie. Implemented in `canvas2DSizing.computeBackingSize` (`BackingSizeInput.pixelRatioCap`);
the 3D base ratio comes from the shared `webCanvasSizing.basePixelRatio`, which both 3D sites
call so they cannot drift.

> **GOTCHA — on EITHER knob, a cap of `0` (or negative) means UNCAPPED, not "ratio 0".** Taken
> literally, 0 is a 0×0 drawing buffer: a blank 3D canvas, and on 2D a `0×0` backing that
> `retrySizeUntilMeasured` reads as "not laid out yet" — so the canvas retries every frame and
> then warns about a `display:none` ancestor, blaming the DOM for a config value. A negative cap
> produced a negative backing size. This is not defensive padding: `pixi.resolution` sits
> directly above `pixi.pixelRatioCap` in Project Settings and uses `0` for "auto", so `0` is
> exactly what a human types here, and numeric config is unvalidated (only string unions are —
see below). Both fields'
> placeholders say `2 (0 = uncapped)`.

**Two failure modes this field has actually hit — both were SILENT, and both are now
guarded:**

- **An out-of-union value falls through to `free`.** Every consumer guards with
  `!== 'fixed'` / `!== 'max'`, so an unrecognised string means "fill the viewport" and the
  neighbouring `width`/`height` are quietly ignored. `games/sling` carried
  `sizeMode: "portrait"` — the native `capacitor.orientation` vocabulary, which does not
  exist here — for months (issue #25); it also showed as an unmatched blank in the Project
  Settings dropdown. `mergeProjectConfig` now coerces an out-of-union value to the default and
  **warns** (`oneOf` in `engine/project-config.ts`), and a guard test rejects one in any
  committed `project.config.json`. Originally this covered only `sizeMode` and the two
  `backend`s; #39 extended it to EVERY string-union field in the config, and made a bad value
  FAIL THE BUILD (coercing keeps the project openable; the build is where it ships). The
  read-coerces / write-round-trips rule that governs it is owned by
  [docs/editor.md](editor.md) § "Project Settings — the save contract".
- **Reading the settings too early yields the DEFAULTS.** The project's render settings are
  injected mid-boot (`initWorldSync()` → `setRenderSettings()`), which lands *after* a
  mount-time read — so `useWebCanvasSizing` (`engine/app/useWebCanvasSizing.ts`) takes
  `configReady` as an effect dependency. Without it a `fixed` project renders full-bleed
  until some later window resize happens to recompute the box. Anything else reading
  `getRenderSettings()` from a `[]`-deps effect has the same bug.

## Related

- [Materials & Textures](./textures.md) — `.mat.json` resolution, the KTX2 texture pipeline + variant selection, MSDF font atlases.
- [UI System](./ui-system.md) — the `ui` (React DOM) layer.
- [2D Skinning](./2d-skinning.md) — `SkinnedSprite2D` deformable meshes + the `Billboard3D` / `FlatSprite3D` 2.5D bridge.
- [Model Import Pipeline](./model-pipeline.md) — GLB → `.mesh.json` / `.mat.json`, LODs, rigged models.
- [Architecture](./architecture.md) — the frame driver, scene-scoped resource refcounting (mesh / material / env caches).
