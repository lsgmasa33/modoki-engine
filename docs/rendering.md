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

#### The PixiJS tree is FLAT — alpha does not inherit for free (`GroupAlpha`, #211)

Every display object goes straight onto its `Canvas2D` slot container, so the Pixi tree carries no
nesting and a parent's `alpha` never reaches its children. UI does not have this problem (nested
DOM + CSS opacity), and fading a WHOLE 2D canvas already worked — the pooled Pixi canvas is
`appendChild`-ed *inside* the `2D Canvas` UI node's div, so CSS opacity on that node composites all
of PixiJS at once. What was missing is fading PART of a scene.

**`GroupAlpha { alpha }`** supplies the ancestor product. Semantics follow Unity's CanvasGroup and a
PixiJS container: it multiplies the entity **and every descendant**, nested groups multiply
together, and it **composes with** `Renderable2D.opacity` (`drawn = opacity × group`) rather than
replacing it — so a game already driving per-entity opacity for its own reasons keeps doing that
while a group fade rides on top. Put it on a bare hierarchy node to fade a subtree the node itself
does not draw. The product is computed once per rebuild by `computeGroupAlpha` (`groupAlpha.ts`)
off the same parent map `computePaintOrder` uses, and is **sparse** — no `GroupAlpha` anywhere means
an empty map and a `?? 1` read, so a scene that never uses it pays one `.size` check.

2D **particle emitters** honour it too, by a different route: `particleSync2D` attaches its wrapper
straight onto the same Canvas2D slot container, so it takes the product through
`ParticleSync2DCtx.groupAlphaOf` and writes `wrapper.alpha` every frame (particles animate
continuously — there is no snapshot to invalidate). Without that a faded group dimmed its sprites
and left its particles at full brightness, which is the half-wired version of a trait that claims
the whole subtree.

⚠️ **The load-bearing part is the CHANGE DETECTION, not the multiply.** Each 2D pass early-returns
on a per-entity snapshot, and those snapshots compared the entity's OWN `opacity`. A parent group
fading while the child's own opacity holds still is exactly the case that would read as "nothing
changed" and never paint — the fade would work on the frame the child moved and at no other time.
So the snapshots store the **effective** alpha (`opacity × group`), and `Text2D` — whose opacity
lives in the MTSDF shader uniforms rather than on the container — carries `groupAlpha` as its own
snapshot field. Verified live rather than by inspection: an authored `0.25` over a background of
(11,12,28) predicted a composite of (51,21,35) and measured (52,22,34); nesting `0.25 × 0.5`
predicted (31,17,31) and measured (31,17,31) exactly, with a sibling outside the group
byte-identical throughout.

The editor gets this for free — `editorScene2D.ts` instantiates the same `Scene2DRenderer`, so the
SceneView preview and the game cannot disagree about it.

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
| `shadowCameraSize` | `16` | Directional shadow-camera ortho half-extent (world units). With `shadowFollowCamera` off it must ENCLOSE THE SCENE; with it on (the default) it only has to enclose what is around the subject, which is what lets it be smaller — see below. |
| `shadowBias` | `-0.0003` | Depth bias (fights acne). |
| `shadowNormalBias` | `0.008` | Normal-offset bias (fights peter-panning). |
| `shadowRadius` | `4` | PCF blur radius. |
| `shadowFollowCamera` | `true` | Recentre the ortho box on the view every frame instead of leaving it anchored at the light's authored position. |
| `shadowFollowTarget` | `''` | Entity GUID to centre the box on instead of the view (usually the player). Empty = follow the view. |
| `showShadowFrustum` | `false` | Editor-only: outline the shadow-camera coverage box in SceneView (runtime ignores it). |

Casters/receivers come from the RENDERER's own `castShadow` (`'auto'`/`'on'`/`'off'`) + `receiveShadow`
fields on `Renderable3D` / `Renderable3DPrimitive` / `SkinnedModel`, applied by `applyShadowFlags`.
`'auto'` derives cast from the material — an alpha-blended (`transparent`) material does NOT cast,
because the shadow map treats blended geometry as opaque and a translucent surface would throw a
hard, wrongly-shaped shadow. All of it is inert unless a light casts AND the renderer's shadow map is
enabled (project `three.shadows`; the `low` tier turns it off outright).

⚠️ **A rig had NO shadow at all until #183** — `applyShadowFlags` was called from three places, all
inside `syncRenderables` (LOD / GLB mesh / primitive), and never for skinned models, so every rigged
character in every project kept THREE's defaults and neither cast nor received. **The tell for this
class is `receiveShadow`**: the function sets it true unconditionally, so a mesh reporting
`receiveShadow: false` proves it never ran there — whatever the material says. Do not re-derive the
old "a transparent material explains it" theory; it was measured false.

#### The shadow pass is a SECOND submit of the scene, and it is easy for it to be the bigger one

A casting directional light makes `renderer.render()` submit the casters again, from the shadow
camera. Nothing bounds that against what the player camera sees, so the shadow pass can cost more
than the visible frame — measured on `demos/forest-camp` / Galaxy A23 (#224), where it was **57 of
103 draw calls and 58k of 87k triangles, against a main pass of 46 calls and 29k**. That project is
CPU-bound there, and `renderer.render` costs ~0.063 ms per draw call on that device, so the shadow
pass was ~3.6 ms of a 15.7 ms CPU frame.

**Cut the caster LIST, not the shadow settings.** Both obvious knobs were measured and neither is a
lever: `shadowMapSize` 1024 → 512 changed nothing (the cost is submission, not rasterization), and
`shadowCameraSize` 16 → 6 culled 8 calls because the casters cluster near the camera anyway. What
works is authoring `Renderable3D.castShadow: 'off'` on geometry whose shadow nobody reads — in
forest-camp, grass/flowers/bushes, which bought ~1.0 ms.

⚠️ **Size the cut in DRAW CALLS, not meshes.** Turning 23 forest-camp entities off removed 30 caster
*meshes* but only 10 draw calls, because LOD children are counted in a mesh traversal and only one
level ever submits. A mesh count will overstate the win by ~3x on any LOD-wrapped content.

#### Follow (`shadowFollow.ts`)

A directional shadow camera anchored at the light's authored position covers a FIXED patch of ground,
so a moving subject walks off it and loses its shadow. Measured in `demos/forest-camp`: the Sun at
`(5,10,4)` with `shadowCameraSize` 16 put the box's footprint around `(7.8, 12.5)` while the player
walked near `(5.6, -0.5)` — the player sat at **-0.873 in shadow-camera NDC standing still**, and 9 m
of walking north took it outside the box entirely.

Each surface supplies the focus point it actually has. The editor passes its orbit `controls.target`
(a true look-at). The runtime has none — a camera is just a Transform, and a follow target like
forest-camp's lives in game code the renderer cannot see — so `viewGroundFocus` intersects the camera's
view axis with the ground plane, which for any camera pointed at the ground IS the look-at, and unlike
a fixed distance ahead of the camera is stable under zoom and pitch. A miss (level/upward camera) falls
back to a bounded forward point rather than putting the box at infinity. `shadowFollowTarget` overrides
all of that with an entity's world position; an unset or STALE guid falls back to the view focus, never
to the origin (which would silently relocate every shadow in the scene).

**Known bound, accepted**: that fallback distance is a fixed 32 world units, so a camera more than ~32
units above the ground looking down still gets clamped to a point short of the true intercept — the box
lands laterally off by the difference. Aerial/top-down setups should author `shadowFollowTarget` (which
skips the derivation entirely) rather than rely on the ground hit.

`snapShadowCenter` then snaps the centre to whole shadow-texel increments **in the light's own view
basis**. Without it the shadow edge crawls as the camera moves, because each sub-texel shift of the box
re-rasterizes the depth map differently.

**Why `shadowFollowTarget` is worth authoring**: the view-derived point trails the character (measured
2.8–3.7 m in forest-camp, growing while walking, since the camera lags and looks slightly ahead), which
spends a quarter of the box radius on ground nobody looks at. Centred on the subject, `shadowCameraSize`
can be SMALLER for the same coverage — and texel size is `2 * size / mapSize`, so shrinking it is the
cheapest sharpness available. Measured: target + `shadowCameraSize` 16 → 10 put the character at NDC
`0 / -0.065` (dead centre) and took texels from 15.6 mm to **9.8 mm**.

⚠️ **Near/far are NOT simply `0.1` / `200` any more.** Near is `0.1`; far is `200` widened to
`back + size*2` when the follow moves the camera, where `back = size*2 + 10`. Without that widening a
scene authoring `shadowCameraSize >= 95` puts the focus at or beyond far and **every shadow from that
light silently disappears** — and since `shadowFollowCamera` defaults on, that would hit an outdoor
level unasked. Pinned by `syncLights.test.ts` § "shadow follow target".

⚠️ **Shadow flags bake into compiled WGSL on the WebGPU/TSL path.** Flipping `castShadow` — or even
`renderer.shadowMap.enabled` — at runtime over CDP/MCP changes NOTHING on screen. It is not a valid
instrument; verify after a restart, or on the WebGL path. This cost real time during #183: it made a
correct diagnosis look like a failed one.

### Rendering-layer light masks — per-object light selection (`lightMaskVariants.ts`)

A light affects a renderer when their `renderingLayerMask` bitmasks INTERSECT (Unity's Rendering
Layers, Godot's `light_mask`, Unreal's lighting channels). The field is on `Light`, `Renderable3D`
and `Renderable3DPrimitive`, defaults to `1` on all three, and an unauthored scene is completely
inert — no variant is allocated and the code path is skipped entirely.

**Why**: forward shading evaluates EVERY scene light for EVERY fragment, superlinearly on mobile.
Masking is the highest-value low-tier knob there is — bigger than the entire post-FX stack. The
numbers, and the two measurement traps that produced three retracted figures, are in
"The automatic light cap" below.

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

## Draw-Call Cost & Instanced Batching (`instancedBatching.ts`)

`instancedBatching.ts` collapses repeated (geometry, material) pairs into `InstancedMesh` draws.
It is BUILT, unit-tested, and **`BATCH_DRAW_CALLS = false`** in `Scene3D.tsx` — read the flag's
own comment for the disposition and the two conditions it needs. What follows is what the three
measurements taught that outlives the flag.

### `submit` measures a QUEUE — establish which side is slower BEFORE reading draw calls into it

This is the load-bearing rule, and it is why two honest measurements of the same marker disagreed.

- **`games/sling` / Huawei Y6.** 197 draw calls removed (235 → 38) and the frame **did not move**:
  81–86 ms in both arms, inside a ±2.5% noise floor. `submit` stayed ~13 ms at 38 calls having been
  13–25 ms at 235 — if per-call driver overhead were the cost it would have collapsed with the
  count. Batching cut `cpuMs` 62.7 → 38.6 and `restMs` rose 17.7 → **47.2** to absorb it: sling is
  **GPU-bound at ~85 ms**, and its 25 ms `submit` was a CPU-side wait on a GPU that was already the
  limiter.
- **`demos/forest-camp` / Galaxy A23.** The opposite regime, `cpuMs` 15.6 against `restMs` 2.4, and
  there `submit` scales per call: `submit ≈ 2.5 ms + 0.063 ms × calls`, from two perturbations that
  agree on the slope (shadow pass off→on, 46→103 calls; half the `Renderable3D` hidden, 47→28).
  Two were needed — the shadow A/B varies call count *and* pass type together, so on its own it
  cannot separate per-call cost from depth-only-pass cost.

So: `submit`'s cost is set by whichever side of the queue is slower. Read `cpuMs` vs `restMs`
first; a draw-call conclusion drawn from `submit` alone is a guess about which regime you are in.

### Check `getBatchStats()` before building anything

`batched` / `drawCallsSaved` / `skipped` answer "is there a win available here" from one live read,
with no rebuild and no A/B. The forest-camp A/B/A that killed the idea there is one
`device_profiler` field in hindsight: `batched: 0 of 80`, `skipped: {below-threshold: 51}` — 88
batchable meshes resolving to **59 distinct geometries, largest repeat group 5**, one below
`MIN_INSTANCES`. Nothing to collapse, and the A→A′ drift was as large as A→B.

⚠️ **Census by RESOLVED identity, never by authored mesh refs.** "forest-camp: 554 entities on
repeated pairs" counted authored refs and is what kept the idea alive for eleven days after its own
refutation. Rule the plausible wrong answer out explicitly while you are there: `pairBuckets 59 ==
geoBuckets 59` proved per-entity material forks were *not* splitting a repeated geometry into
singletons — had those differed, the fix would have been a material-sharing one instead.

### What forces an entity OUT of a batch

Still reference, because the mechanism still ships. `InstancedMesh` shares ONE material across all
instances, so any per-entity divergence breaks the group:

- **`ecsColors` / `ecsMaterials`** — per-entity colour and material overrides. An override is its
  own material, so it cannot share.
- **`renderingLayerMask`** — `applyLightMask` swaps in a per-mask material variant. Different mask
  → different material → different batch.
- **`castShadow`**, set per-material from transparency.
- **`isVisible`** — cheap: skip the instance.

**The batch key must therefore be the RESOLVED material identity, not the authored `material`
GUID.** Two entities sharing a GUID but carrying different masks are not batchable, and treating
them as one is a rendering bug that presents as "lighting stopped working on some tiles".

### The process lesson, which is the durable output

This was a plausible optimization built on a marker read as a cause. What changed is the cost of
finding out: `drawCallsSaved: 197` beside an unchanged frame time is unambiguous in ONE
measurement, where `calls: 235` alone had already produced a false null result an hour earlier.
**The instrumentation, not the optimization, was the valuable output** — the stats that say *why* a
candidate was skipped turned a day of hunting into one build.

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
- **Pixel ratio.** `setPixelRatio(Math.min(window.devicePixelRatio, three.pixelRatioCap))` — the
  cap is not hardcoded, it's the quality-tier-driven `three.pixelRatioCap` (`scene3DSync.ts`
  ~3475, `webCanvasSizing.ts` ~85; defaults to 2 on the high tier). See the quality-tier table
  below.
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

### Quality tiers — `low` / `mid` / `high` (#121 P3, `mid` from #188)

A project sets `rendering.three.qualityTier: 'auto' | 'low' | 'mid' | 'high'` (Project Settings →
Three.js).

⚠️ **It was two tiers for most of this work, and the reason was honest** — three tiers demand
evidence for two boundaries and we had it for zero. What changed is the **boot ramp probe** (below):
run on five real devices, it puts the population in three bands ~10× and ~2.5× apart. The Galaxy
A23 is the case that forced it — a two-tier split files it with a Huawei Y6, and that is wrong by
our own measurement, since forest-camp's IBL costs **+2.9 ms of GPU** there and fits inside 60 fps
on hardware ~10× the Y6.

**A TIER CLAMPS; IT NEVER RAISES.** `high` is provably a no-op — a project that deliberately
authored `pixelRatioCap: 1` or `shadows: false` keeps it, because landing on the high tier is not a
reason to do MORE work than the author asked for. That property is what made wiring tiers up safe
for every existing project when the default was `high`. As of #155, `DEFAULT_TIER_SETTING` is
`'auto'`: a project that does not pin `qualityTier` no longer resolves to `high` outright — it goes
through the allowlist/desktop-carve-out/calibration precedence below, and an unrecognised device
starts `low`. A project that wants exactly today's behaviour must pin `qualityTier: 'high'`.

| knob | `low` | `mid` | `high` | live-changeable? |
|---|---|---|---|---|
| `pixelRatioCap` | 1 | **1.5** | 2 | ✅ via the resize bus |
| `shadows` | off | **on** | on | ✅ `shadowMap.enabled` |
| `Light.shadowMapSize` ceiling | 512 | **1024** | none | ✅ re-read each frame by `syncLights` |
| post-FX stack | **dropped** | **dropped** | on | ✅ stack disposed |
| `antialias` | off | off | on | ❌ **constructor-only** |
| max directional lights | 1 | 2 | unlimited | ✅ per-frame, via `armAutoLightCap` — see § "The automatic light cap" below |
| max point+spot lights | 1 | 3 | unlimited | ✅ per-frame, via `armAutoLightCap` — see § "The automatic light cap" below |
| **max shadow casters** (#229) | **1** | **1** | unlimited | ✅ per-frame, via `armShadowCasterCap` |
| **IBL** (`scene.environment`) | **dropped** | **on** | on | ✅ `syncEnvironment` re-reads each frame |
| ambient compensation | ×4 | ×1 | ×1 | ✅ `syncLights`, gated on `isIblSuppressed()` |
| exposure compensation | ×1.25 | ×1 | ×1 | ✅ `reconcileToneExposure`, same gate, per frame |
| **`targetFps`** (#202) | **30** | none | none | ✅ `setTargetFPS` at every publish point — **not in the editor** |
| **`pixi.pixelRatioCap`** (#202) | **1** | 1 | 2 | ✅ via the resize bus |
| **`pixi.antialias`** (#202) | off | off | on | ❌ **constructor-only** (`Application.init`) |
| **`textureMaxSize`** (#212) | **512** | **1024** | none | ⚠️ per-TEXTURE, at LOAD — a texture already in flight keeps its current variant; the next load picks up a live tier change |

**`maxShadowCasters` caps how many lights RENDER a shadow map, not how many SHADE a fragment
(#229).** `max directional`/`max point+spot` above bound per-fragment shading; a shadow map is a
whole extra submit of the scene's caster set, once per frame, at the same cost regardless of how
many fragments sample it — between `shadows: off` and "every casting light renders a full map" the
tier table had nothing for that. Measured on a Galaxy A23: one shadow pass cost 57 of 103 draw
calls, 58k of 87k triangles, ~3.6 ms of a 15.7 ms CPU frame. `demos/postfx-demo` (five casting
spots) is the only scene in the fleet with more than one caster today. Which lights survive when
the cap bites — directionals first, then spot/point, each by effective intensity — is
`shadowCasterCap.ts`; the full rationale is `TierRenderOverrides.maxShadowCasters`'s docblock in
`qualityTier.ts`.

⚠️ **The selection is fixed at scene load ON PURPOSE — moving it at runtime costs ~200 ms per
swap.** The obvious better rule is "whichever light lights the thing the camera/Director is
focused on", and it was measured on a Galaxy A23 (`demos/postfx-demo`, one caster flipped, every
frame timed around it): **255.3 ms** on the swap frame, **191.3 ms** swapping back, then **220.4**
and **184.9** for a third and fourth swap of the same pair — no warm-up, the price is per swap.
Changing which lights cast changes the `ShadowNode` set a material's `LightsNode` builds, and that
pipeline rebuild is a synchronous stall. A focus-driven caster therefore needs a pre-warm that
compiles every single-caster variant up front (the `prewarmShadersForWorld` pattern) before it is
viable — it is not a comparator swap.

**`textureMaxSize` is a DOWNLOAD-size knob, orthogonal to every other row above it (#212).**
Textures are 67% of a shipped build (measured on `demos/postfx-demo`: 21.8 MB of KTX2 in a
32.4 MB dist), and variant resolution was format-aware (KTX2 vs WebP) but size-blind — a `low`
phone downloaded the identical full-resolution texture a flagship did. The build
(`vite-asset-scanner.ts`) emits an EXTRA derived file at each authored tier's cap (only when the
cap actually shrinks that texture further than it already is — see `sizesToEmit` in
`runtime/loaders/textureSettings.ts`), and the runtime resolver picks it up only when the
manifest confirms that size was actually built (never a guess — a 404 there is a hang, not a
failure, per this repo's own history). It never touches format/codec selection
(`selectVariant`), so it composes with every other row unchanged. Full pipeline detail —
`variantSuffix`'s `@<size>` suffix, the manifest's `texture.sizes`, the `textureSizeCap.ts` L0
seam — is in [docs/textures.md](./textures.md) § "Texture LOD by quality tier".

⭐ **`mid`'s `pixelRatioCap` is 1.5 as of 2026-08-12, and it is a MEASUREMENT, not a compromise.**
It sat at `low`'s value of 1 for months because the plan demanded "its own measurement; do not guess
it" and the only datum was a Y6 paying ~4x for 2x DPR. Measured on the band's own anchor, a Galaxy
A23 (`sling`, uncapped, driven through the tier path so every resize is real):

| DPR | buffer | Mpx | fps | frame | GPU (`restMs`) |
|---|---|---|---|---|---|
| 1 | 384x801 | 0.31 | 61.7 | 16.2 ms | 4.9 ms |
| **1.5** | 576x1201 | 0.69 | **59.5** | 16.8 ms | 6.2 ms |
| 1.875 (cap 2) | 720x1501 | 1.08 | 54.6 | 18.3 ms | 7.2 ms |

**The curve bends BETWEEN the integers** — which is why the answer stayed hidden while the only
values anyone tried were 1 and 2 (the debug menu's DPR row offered exactly those, and now offers
1.5 too). 1.5 buys 2.2x the pixels for +1.3 ms of GPU and holds 60; 2 costs 3.5x and does not.

⚠️ **Measured on ONE project, and `sling` is light** (38 draw calls, 112k triangles). A fill-heavy
scene has not been measured at 1.5 on this band; a project that cannot afford it authors its own
`tiers.mid.pixelRatioCap: 1`. ⚠️ And on a DEBUG build carrying ~10.5 ms of CPU — a release build has
more margin, so this errs safe. ⚠️ `pixi.pixelRatioCap` did NOT follow it: that is a different
renderer and #204 is still open on what 2D DPR should be for Android; raising it by analogy is the
guess this measurement replaced.

**`mid` LOOSENS ONLY WHAT WAS MEASURED**, and reading the table's unchanged columns as unfinished
work gets it backwards. IBL is on because the A23 was measured affording it; shadows are on because
the band is ~10× the Y6 — but with a map-size **floor**, since bias scaling alone was measured NOT
to make a 512 map usable. Post-FX stays off *because* of a measurement, not for lack of one: an
iPhone 8, squarely mid-band, goes 27 ms → 56 ms on NPR alone. Resolution and AA stay at `low`'s
values because nothing has measured them on this band, and that costs nothing today — every
mid-band device currently resolves `low` anyway, so `mid` is a strict improvement on what they get,
never a regression. The light caps are anchored on the A23 ladder (1 directional = 21 ms; +3 point =
34 ms; +8 point = 165 ms — superlinear, with a cliff between 5 and 10 lights).

The one number here with neither a measurement nor a carry-forward is the **1024 shadow-map
ceiling**: 512 is measured unusable and 2048 is what projects author, so it is the step between.
Worst case it renders coarser shadows than intended, which costs quality and not the frame.

#### A frame time measured on a big.LITTLE phone is a LITTLE-core number — and that is the shipping budget

Every CPU figure above from the Galaxy A23 was produced with the **big cores idle**. Sampling the
frame-critical threads while `demos/forest-camp` renders puts `RenderThread` on the LITTLE cluster
in ~27 of 30 samples and `Chrome_InProcGpu` / `VizWebView` / `mali-cmar-backend` / the main thread
at ~0 of 30 — while cpu6/cpu7 idle around **985 MHz of a 2203 MHz ceiling**. The little cores are
`cpu_capacity` **367**; the big ones **1024**. So there is a 2.8× machine sitting unused next to
every low-end measurement this doc reports.

**It is not reachable from the app, and that is measured, not assumed** (#228). Three independent
findings, each sufficient on its own:

- **ADPF — the sanctioned API for this — is unsupported.** `dumpsys performance_hint` reports
  `HAL Support: false` and `HintSessionPreferredRate: -1`, so `createHintSession()` returns null.
  The other low-end phone here (Huawei MRD-LX3, Android 9) has no `performance_hint` service at all.
- **The mechanism ADPF drives does not exist on this kernel.** Its whole effect is `uclamp.min`, and
  `/dev/cpuctl/top-app/cpu.uclamp.min` is absent — the device is on the older **schedtune** scheme.
- **The scheduler is behaving correctly.** `/dev/stune/top-app/schedtune.boost` is **0** and
  `prefer_idle` **0** — this OEM gives the *foreground* group no boost — and with the misfit
  threshold at ~80% of 367, no single one of our four render threads is ever heavy enough to be
  flagged for migration. The work is split four ways, so none of them qualifies.

**Declaring the app a game does not change it either.** `android:appCategory="game"` plus a
`game_mode_config.xml` (both now healed in by `healNativeConfig`) *do* register the app —
`dumpsys game` went from an empty dump to listing the package — and moved placement not at all:
A/B/A, 30 samples per arm, `RenderThread` on a big core **3/30 → 4/30 → 4/30**, cpu7 median 985 MHz
in all three arms. Those keys are kept for the intervention opt-outs (below), not as a perf fix.
**Do not re-run this experiment.**

The consequence is the useful part, and it points the opposite way from the intuition that started
it: the A55 numbers are **not** conservative readings that a scheduling fix would improve on — they
are the budget the game actually ships into. Content levers keep their full weight. It also means a
single before/after frame-time reading on this device proves nothing: `cpuMs` swings 13.0–18.1 ms
with no input change, which is this same placement lottery, so alternate A/B/A.

⚠️ The one thing the app *can* control is letting the OS make it worse. `game_mode_config.xml` sets
`allowGameDownscaling="false"` and `allowGameFpsOverride="false"`: those are Android's compat
interventions for games that do not manage their own quality, and an OS-imposed fps cap would be
read by live tier calibration as the device being slow — demoting it for a slowdown the OS imposed.

#### ⭐ A TIER'S CONTENT IS AUTHORED BY THE PROJECT — `TIER_SETTINGS` is only the seed

Owner decision, 2026-08-11. The table above is **not** what runs any more; it is what a project
**starts from**. A project authors its own degradation in **Project Settings → Rendering & Physics
→ Three.js (3D)**, and the rule that shapes everything else is:

> **A project starts with ONE config — the default, which is what it authored — and *adds* a `mid`
> and a `low` only if it wants degradation.**

Why it moved: `TIER_SETTINGS` was ten fields of `const` that the owner could not reach, which is
exactly the bias CLAUDE.md's "Author values in the SCENE and the PREFAB" rule exists to correct. A
project could only pin *which row it got*, never say what a row meant — so postfx-demo, a post-FX
*showcase*, had to drop the entire stack on `low` because the engine said so.

- **The default is the ABSENCE of clamping**, not a stored object. `rendering.three` gains nothing;
  only an added tier carries values (`rendering.three.tiers.{mid,low}`, both optional and **absent**
  rather than empty when unauthored). That is what `high` already meant — the engine guarantees it
  is a no-op — so this names existing behaviour. `UNCLAMPED_OVERRIDES` is the identity.
  ⚠️ It is a **true** identity, which `TIER_SETTINGS.high` was not: that row carries
  `pixelRatioCap: 2` and the clamp is `Math.min(authored, 2)`, so a project authoring 3 silently
  got 2 (#200).
- **Resolution falls DOWN, never up.** A `low` on a project that authored only `mid` gets `mid` —
  the author's most conservative config is the closest thing to what they meant, and reaching for
  the unclamped default there would hand the weakest hardware the settings they were degrading away
  from. `unknown` (the probe ran and produced nothing usable) takes the LOWEST authored config, for
  the same reason: absence of a measurement is not evidence of capability.
- ⭐ **ONE CONFIG ⇒ NO PROBE, and no calibration either.** Stated as a property rather than an
  optimisation: the probe's only job is to *choose between configs*, so with one config the choice
  is already made and the launch-blocking probe buys a verdict that cannot change a pixel — 0.5–0.8 s
  on an A23/S22, 1964–2619 ms on an iPhone 8, ~2.2 s cold on a Y6, and up to three launches before
  a verdict settles. The live half stands down too: with nothing to demote *to*, a demotion would
  move a tier name, free no memory, drop no effect, and still pay a `forceResizeAllSurfaces()` on a
  device already missing its budget. Two cases fall out of the rule instead of needing their own
  gates — **a playable ad never probes** (it never could have usefully: `deviceModel` comes from
  the `GameDebug` native plugin, so a plugin-less ad bundle always resolved `calibrating` and ran
  the FULL probe on *every impression*), and neither does the editor.
- **Post-FX is per effect**, not one switch: `npr`/`ao`/`dof`/`bloom`/`vignette`, named with
  `PostFXRequest`'s own keys because the mask is applied by *deleting* keys from that request. On
  one iPhone 8 NPR is ~+29 ms against vignette's ~6 and bloom's ~4 — seven to one, and the old
  boolean treated them identically.
- **Adding a tier SEEDS it from `TIER_SETTINGS`**, with the measurement behind each value in the
  field's help text, so "Add low" is an informed edit rather than ten blank boxes.
- **Every existing project was seeded** (`engine/scripts/seed-quality-tiers.mjs`), so nothing
  regressed — at the price that a seeded project has >1 config and therefore keeps probing. The
  drift guard is on the **seeder's** values against `TIER_SETTINGS`, deliberately *not* on each
  project's, since asserting those still match would forbid the tuning this feature exists for.
  ⚠️ The seeder is **idempotent by "already authors `tiers`"**, which means a field added later
  would never reach the 22 already-seeded projects. So it also **backfills**: any seed key an
  authored tier is missing is added, per tier, and a key already present is never overwritten (a
  tuned value stays authoritative — the STARTING POINT rule applies to a field added today exactly
  as it did in A4). `resolveTierOverrides` completes a config the same way at read time, from
  `UNCLAMPED_OVERRIDES`, so **a missing field means UNCLAMPED, never `0`/`false`** — a config
  written before a field existed cannot have meant to clamp it, and `Math.min(3, undefined)` is
  `NaN`, i.e. a backing buffer of `NaN` pixels, silently.

#### Telling a GAME the tier changed — `onQualityTierChange` (#241)

Every knob described above is a knob the engine turns on **itself**. A game that wants to degrade
its own content by tier — spawn counts, particle budgets, an LOD bias, an expensive gameplay
effect — needs to know when the tier moves, and until #241 it could only poll
`getActiveTierOrDefault()` and hope it read at the right moment. Polling is fine at a scene
boundary and wrong for the case the tier system exists for: **calibration demotes mid-session, on
the weak hardware where a game's own degradation matters most.**

```ts
import { onQualityTierChange } from '@modoki/engine/runtime'

const off = onQualityTierChange((res, prev) => {
  // prev === null on the first resolution of a session — the tier the device booted into.
  setMaxEnemies(res.tier === 'low' ? 12 : 40)
})
```

- **Multi-subscriber, deliberately.** The other listener seam here, `onTierSwitchOverlay`, carries
  overlay COPY and documents that it has exactly one intended reader; two renderers of it would
  double the overlay. N readers of a *value* cannot conflict that way.
- **Fires on CHANGE only.** A re-publish carrying a fresh `reason` for the tier already active is
  not a tier change, and clearing the tier at teardown is not one either.
- **A listener, not a store write** — `runtime/store` is L3 and `runtime/rendering` is L2, so
  publishing into the store would be an upward import and an ESLint error.
- **A `@tier` journal event rides along**, so a demote is visible to `modoki_journal` /
  `device_journal` and assertable in `createTestWorld`. It is Tier-1 (always-on): tier changes are
  low-rate, and gating them behind a watch would mean the demote you are hunting is the one event
  you did not capture.

⚠️ **It publishes from `setActiveQualityTier`, NOT from `applyQualityTier` — and that is #202
repeating.** `applyQualityTier` reads like the single funnel every tier change goes through and is
not: it runs on a live promote/demote and on a player's menu pick, while **the tier a device
actually ships with is published by `tierResolve.publishActiveTier` calling `setActiveQualityTier`
directly**. Wiring a new tier consumer into `applyQualityTier` alone is precisely how the frame cap
and the 2D backing size ended up inert on the path nearly every device takes and never leaves. Any
future tier consumer belongs at the value, not at one of its callers.

#### A project with no 3D surface resolves a tier too (#203)

⭐ **Until 2026-08-13 it did not, and every tier field on three projects was inert.**
`resolveActiveTier` ran from exactly one call site — `makeWebGPURenderer` — so `games/chess` and
`games/audio-demo` (`disable3D: true`) and `games/space-invader` (`build.modules.render3d: false`)
built no renderer, resolved no tier, and left `getActiveQualityTier()` null for the process
lifetime with `getActiveTierOverrides()` returning the unclamped default. All three were seeded
with a full `rendering.three.tiers` config; nothing errored, the Inspector showed every field, and
none of it did anything. #202 made it consequential by giving a tier the 2D DPR cap and the frame
cap — the first two fields those projects would have benefited from.

**It had a second half the issue never recorded, and it is the worse one**: `tickTierCalibration`
is called from `Scene3D.tsx` and nowhere else, so a 2D project had no live calibration in *either*
direction. It could not be demoted when it dropped frames and could not be promoted when it turned
out to have headroom. Resolving a tier at boot without fixing that would buy a first guess with no
way to correct it.

Both halves now live in **`tierBoot.ts`**, called from the app shell's boot sequence when no
`Scene3D` will mount:

- the decision itself moved out of `scene3DSync` into **`tierResolve.ts`**, which imports no
  `three/webgpu` — that import is exactly what `render3d: false` dead-code-eliminates, and pulling
  it back through the tier resolver would re-break the projects this exists for, silently, visible
  only as a bundle ~173 KB larger. A 3D project still resolves inside `makeWebGPURenderer`, because
  `antialias` is a renderer constructor option a later decision cannot apply;
- the calibration loop registers a frame callback at `PRIORITY_RENDER_2D`.

⚠️ The condition is **`!Scene3D || config.disable3D`, and the first half is the one a config check
misses.** `space-invader` sets `build.modules.render3d: false`, which nulls `Scene3D` at build time
while `disable3D` stays unset — so a test on the flag alone would leave the playable-ad project,
the one with the tightest budget in the repo, exactly as unclassified as before.

⚠️ **The probe runs its 2D shape there — `fill` + `cpu`, not `shade` + `cpu`** (owner,
2026-08-13). A 2D project's only tier-controlled GPU knob is `pixiPixelRatioCap`, which is purely
fill-rate bound, so `shade` would be pricing IBL and shadow taps the project will never issue and
charging the launch for it. `ProbeMeasurement.axes` carries which shape ran, explicitly rather than
inferred from which reading is present — "`shade` is undefined so it was 2D" is true today and
silently wrong the first time a 3D probe's heavy program fails to compile, which is a supported
degrade path.

⚠️ **`PROBE_THRESHOLDS_2D` ships NULL**, exactly as the 3D pair shipped null, and that is the
honest state rather than a gap. There is no number to inherit: the 3D figures were measured through
a Three renderer, and the fill axis has never had a boundary drawn on it at all. In practice a
recognised device answers from `gpuIdentity` in ~0 ms and never reaches the probe; an unrecognised
one classifies `unknown`, exactly as it does today; and every launch now logs `fill` in comparable
Mpx/ms, which is the measurement a boundary has to come from. Four devices on a 2D project, three
wiped launches each, is what fills it in.

#### The 2D layer and the frame cap (#202)

A tier used to clamp **three Three.js knobs and nothing else**. `qualityTier.ts` contained zero
references to `pixi` and the clamp was literally named `applyTierToThree`, so `pixi.pixelRatioCap`
and `pixi.antialias` passed through untouched at every tier — meaning the whole tier system, boot
probe included, changed nothing for a project that renders no 3D. `games/court` is the sharpest
case: it authors `pixi.pixelRatioCap: 3`. And `targetFps` reached the frame driver once at boot
(`register.ts`) and was never re-read, so it was the one renderer knob no tier could touch.

- **The 2D DPR cap carries the SAME Y6 measurement, not a new one** — 1× = 22 ms/45 fps against
  2× = 69 ms/14 fps, ~4× cost for 2× DPR. That is a fill-rate fact about a tile-based mobile GPU,
  not a Three.js fact, so it applies to a Pixi canvas identically. Say "carry-forward" rather than
  implying the 2D layer was measured separately.
- ⚠️ **`low` capping to 30 fps is the ONE seeded value that is a deliberate behaviour change**
  (owner, 2026-08-11). Every other seeded value preserves what the fleet already did; this one
  takes a seeded project on weak hardware from uncapped to capped. It was chosen over the inert
  `0` because it is the largest single saving in the table — halving per-second GPU *and* CPU work
  and cutting thermal throttling — and because it buys **feel**: a device that cannot hold 60
  judders between 40 and 55, where a 30 cap is a stable 30. `mid` stays uncapped **as the engine
  default**, because inventing a fleet-wide cap is what this table exists to avoid.

  ⚠️ **"No mid-band device has been measured missing 60" was true until 2026-08-21 and is not any
  more** — this bullet said so, and the editor's own tooltip repeated it, which is exactly the
  shape that argues a reader out of a measurement. A **Galaxy A23** (Mali-G57 MC2, assessed `mid`
  by the GPU benchmark) runs `demos/forest-camp` at a **20.5 ms median against mid's 20.0 ms
  budget** — half a millisecond over, sustained — so live calibration demoted it `mid → low` about
  six seconds into play, costing a 619 ms + 268 ms switch stall and pulling shadows, IBL and the
  texture cap out from under the player (testboard `kR2G1q5BzRPskMi1fhrm`). The fix is a
  **per-project** override, `tiers.mid.targetFps: 30` in forest-camp's `project.config.json`, which
  moves the budget to 40 ms (`frameCapInterval * 1.2`); re-measured on the same phone after ~30 s
  of traversal it reads frame median 33.6 / p95 36.2 / max 38.1 ms (`overBudget: false`) with cpu
  median 19.9 ms against the 28.0 ms `frameIsFull` bar — clear of BOTH demotion conditions rather
  than sitting on one. **The engine default stays `0`**: one measurement on the heaviest 3D demo
  is a reason to cap THAT project, not the fleet, and no other project has been measured in this
  shape. What it does change is the honest reason for the default — "nobody has measured it" is no
  longer available.

  A second-order effect worth knowing, because nothing in the diff says it: `mid.targetFps` is also
  the `promoteTargetMs` for a **low → mid promotion** (`hasHeadroom` asks whether our work fits in
  half the frame the tier above targets). Capping mid at 30 moves that bar from 8.3 ms to 16.7 ms,
  so a low-tier device promotes into forest-camp's mid more readily than before — which is correct,
  since mid now genuinely asks for less, and it stays clear of the 28.0 ms demotion bar, so the pair
  cannot oscillate.
- ⚠️ **`0` MEANS "NO CAP" ON ALL THREE NUMERIC FIELDS, so none of them may clamp with a bare
  `Math.min`.** `min(60, 0)` is 0 — which would silently *remove* a project's own cap on every
  tier that sets none; `min(0, 30)` is also 0 — so the field would read as wired and do nothing on
  exactly the projects that left the default alone. All three go through `applyTierToTargetFps` /
  `applyTierToPixi` / `applyTierToThree`, which widen `0` to `Infinity`, compare, and narrow back.

  ⚠️ **`three.pixelRatioCap` is the third, and it was missed for a whole close-out.** The sentinel
  helpers were written for `targetFps` and `pixiPixelRatioCap` while the *pre-existing* field with
  identical semantics kept its bare `Math.min` — so a project authoring `0` (native DPR on capable
  hardware, which Project Settings advertises as `2 (0 = uncapped)` and `basePixelRatio` reads as
  `cap > 0 ? min(dpr, cap) : dpr`) had `min(0, 1) = 0` on `low`: still uncapped, with the single
  measured saving behind that whole row doing nothing on exactly the devices it exists for. The
  lesson generalises past this field: **when you build a helper because a sentinel makes the
  obvious operation wrong, sweep for every field that shares the sentinel**, not just the ones the
  current change happens to add.
- **`pixi.resolution` is deliberately NOT tiered.** It is a PIN (0 = auto), and the standing rule
  is that a pinned resolution is never capped — capping an explicit pin would make the pin a lie.
  There is no analogue on the `three` side, so tiering it would be a new philosophy rather than a
  symmetric addition. If a project ever pins it high, that is the moment to ask whether a tier may
  overrule a pin.

⚠️ **THE TRAP THAT ALMOST SHIPPED: `setActiveQualityTier` RECORDS a tier, it APPLIES nothing.** The
tier a device actually ships with is published by `tierResolve.resolveActiveTierOnce` calling it
**directly** — that path never goes through `applyQualityTier`, which runs only on a live
promote/demote and on a player's menu choice. Three survived that only because
`makeWebGPURenderer` re-reads `getEffectiveThreeSettings()` on the very next line after awaiting
the resolution, so the three 3D fields appeared to "just work" and any field added later would
silently not. Wiring the frame cap into `applyQualityTier` alone — the obvious place, and what
this work was originally specified to do — would have left it inert on the path nearly every
device takes and never leaves. Both publish points now call one `applyActiveTierToRuntime()`
(`setTargetFPS` + `forceResizeAllSurfaces`). `Canvas2DMount` was already on that bus and re-reads
its settings on every run, so the broadcast *is* the whole of "apply the new 2D cap".

✅ **A PROJECT WITH NO 3D USED TO RESOLVE NO TIER AT ALL — FIXED 2026-08-13 (#203).** The history
is worth keeping, because the shape recurs: `resolveActiveTier` ran from exactly one place,
`makeWebGPURenderer`, so if `Scene3D` never mounted nothing built a renderer and
`getActiveQualityTier()` stayed `null` for the process lifetime, with every tier field inert — the
3D ones equally, and always had been. #202 only made it consequential.

**Two independent routes reach that state, and missing the second is easy** — the first close-out
of #202 named only `disable3D` and was wrong about the blast radius:

| route | mechanism | projects |
|---|---|---|
| `disable3D: true` in the game config | `App.tsx` renders `Scene3D && !disable3D` | `games/chess`, `games/audio-demo` |
| `build.modules.render3d: false` | `Scene3D` is `null` at module scope (`__MODOKI_MODULE_RENDER3D__`) | `games/space-invader` |

A 2D project that does neither (`games/court`, `games/text_demo`, `demos/2d-physics-demo`) mounts
Scene3D and always resolved normally — verified live on court.

⚠️ **The fork that made this expensive is gone, and it is worth saying why rather than just that
it is fixed.** The blocker was that on Android the only classifier *built a Three renderer*, so a
2D project had to choose between a launch-blocking probe it had no use for and falling through to
`low` on every mobile device. #210 gave recognised hardware a ~0 ms string lookup, and
`rampWorkloadGL` moved the probe off Three entirely — so neither horn of the fork survived. See
"A project with no 3D surface resolves a tier too" above for what replaced it.

⚠️ **THE 2D `antialias` DOES NOT MERELY "CATCH UP LATER" — IT USUALLY MISSES THE FIRST SLOT.** Both
`antialias` fields are constructor options, but the two layers are not equally protected:
`makeWebGPURenderer` *awaits* `resolveActiveTier` before it allocates, so 3D gets the clamped value
first time. `Canvas2DPool.initSlotApp` awaits only backend detection and then reads the effective
settings — it never waits for a tier. `Scene3D` and the 2D host mount as siblings in one React
commit, and the boot probe takes 0.5–2.6 s, so on a mixed project the first Pixi `Application` is
almost always created *before* the tier resolves and bakes in the unclamped AA for a slot that
typically lives for the session. The DPR cap is unaffected (it re-measures through the resize bus).
This is a known limitation of the same shape as #203 and belongs with that decision — making the 2D
pool block on a 3D-owned probe is exactly the coupling #203 exists to settle.

⚠️ **THE FRAME CAP IS OFF IN THE EDITOR, deliberately** (`setTierFrameCapEnabled`, called from
`app/main.tsx` beside `setJournalEnabled` and friends). `targetFPS` is a single global in the frame
driver gating *every* registered callback — the ECS tick and `PRIORITY_EDITOR_3D`/`_2D` along with
the game's passes. The editor mounts `Scene3D`, so it runs tier calibration, and two viewports
doing double the work is precisely what trips a demotion — which would then throttle the author's
whole session, gizmo dragging included, for a symptom the shipped build never had. Every other tier
knob degrades how the preview *looks*, which is arguably informative; this one degrades the tool.
The cost, stated rather than discovered: **GameView does not preview the frame cap.** Note the gate
is a runtime setter and not `if (!__MODOKI_EDITOR__)` at the call site — that global is `true`
under `vitest` and under a plain `npm run dev`, so it would have disabled the cap for a developer
running their own game and made the behaviour untestable by construction.

**Verified live** on `games/court` (2026-08-11), by perturbation rather than by reading data back:
authoring a `low` with `pixiPixelRatioCap: 0.5` and `targetFps: 24` — values in no table and no
config, so nothing else could produce them — took the Pixi backing buffer 513 → 257 px and the
frame driver's live `targetFPS` 60 → 24. On a fresh launch with the tier resolving to `low` at
boot, an authored `targetFps: 60` ran at **30** with `pixi.pixelRatioCap` clamped 3 → 1.

⚠️ **Two consequences that read as bugs if you meet them cold.** Pinning `qualityTier: 'low'` on a
project that has authored nothing **does nothing** — you cannot select a config that does not
exist, and the dropdown still offers all four (filtering it needs a dynamic-options capability the
settings schema lacks). And `rendering.three.tiers` is in `deepMergeConfigPatch`'s
`REPLACE_WHOLESALE` set: without that, removing a tier in the dialog would post an *absent* key,
which every other map-like section reads as "leave it alone" — the Remove button would close
cleanly, report success, and change nothing on disk.

#### The automatic light cap — the tier's light limits, enforced (#188 item 7)

⚠️ **These two rows were AUTHORED INTENT and nothing else from #121 P3c until 2026-08-10**:
`autoLightCap.ts` held the rule, was unit-tested, and was **imported by nothing**, so a `low`-tier
phone rendered every scene light on every fragment. `autoLightCapFrame.ts` is the wiring that was
missing; it decides a mask and hands it to the **authored mask path** (`lightMaskVariants`, #136)
rather than introducing a second mechanism.

The rule: **all ambient + the most EFFECTIVE N directional + the nearest N point/spot.** Ambient is
never capped (three sums it into a single constant term). Directionals are chosen scene-wide by
luminance-weighted intensity rather than raw intensity — a deep-blue rim light at 2.0 contributes
less visible light than a white key at 1.0 and would otherwise win. Locals are chosen per object,
by distance.

**Measured on two real devices** (`demos/postfx-demo`, frozen viewpoint, cap toggled on and off
inside a single run, with the run rejected unless the viewpoint, the tier and the toggle all held):

| device | GPU | tier | scene | cap ON | cap OFF |
|---|---|---|---|---|---|
| **Huawei Y6 2019** | PowerVR Rogue GE8300 | `low` | as shipped | **16.6 ms frame** (10.7 rest) | **18.4 ms frame** (11.9 rest) |
| **Galaxy A23 5G** | Mali-G57 MC2 | `mid` | as shipped | 10.9–11.3 ms GPU | 11.0–11.1 ms GPU |
| **Galaxy A23 5G** | Mali-G57 MC2 | `mid` | masks stripped | **3.80 ms GPU** | **9.24 ms GPU** |

Three things to read out of that:

- **On the Y6 the cap is the difference between hitting vsync and missing it** — 18.4 ms → 16.6 ms
  on the demo *as shipped*. Note `gpu: unsupported` there: WebGL2 without
  `EXT_disjoint_timer_query_webgl2`, exactly the population this plan predicted GPU timers would
  never reach, so that row is frame/rest time rather than GPU time.
- **On a scene that already authors its own masks the cap is NEUTRAL** (10.9–11.3 against
  11.0–11.1 — inside the noise, reproduced across two independent runs). This settles a question
  that was open: it neither helps nor hurts there, which is what "the artist already culled these
  lights" should look like.
- **On an un-authored scene it is worth 2.4×** — 9.24 → 3.80 ms. That is the win the A23 light
  ladder predicted, and un-authored is what every project except postfx-demo is.
- **A Galaxy S22 also runs the cap**, because it resolves `mid` in a real game (below). Forcing
  `high` on it confirms the property the table implies: `engaged: false`, caps `0/0`, while the
  scene's own authored masks keep working (25 variants) — `high` cannot engage the cap, and the
  two mechanisms are independent.

⚠️ Stripping the masks on the A23 also made the scene heavy enough that **calibration demoted
`mid`→`low` mid-run** while the camera tour moved, which invalidates any A/B taken across it. The
measurement harness now rejects a run whose viewpoint, tier or toggle changed rather than
averaging over it — a median across a demotion is how this workstream has twice published a number
that was really two conditions.

⚠️⚠️ **THE PROBE DOES NOT CLASSIFY A DEVICE IN THE NATIVE SHIPPING PATH, BECAUSE ITS MEASUREMENT
WINDOW IS THE GAME'S OWN BOOT.** Measured 2026-08-11 on all three phones, native APK, cached verdict
wiped before each run:

The probe runs before the real renderer exists, i.e. while the game is parsing GLBs and uploading
textures, and it times frames with rAF deltas. So it times the STALLS:

| device | warm-up frames, rendering an EMPTY scene | estimated interval | true interval | verdict |
|---|---|---|---|---|
| Galaxy S22 | `[125 125 125 125 167 167 167 167]` ms | 125.6–167.4 ms | 16.8 ms | **none**, 9/9 launches |
| Galaxy A23 5G | `[100 117 117 117 117 117 133 133]` ms | 116.7 → 99.9 → 83.3 ms | 16.7 ms | **none**, 3/3 |

The A23 row is worth reading twice: the estimate falls on each successive launch as the caches warm,
and after three it is **still 5 × the truth**. Warming the app does not recover the measurement —
the stalls are GLB parse and texture upload, which are paid every launch.

Every ramp threshold is a multiple of that estimate, so one contaminated number breaks four things
at once: escape needs `3 × interval` = 377–502 ms, which is past `ABORT_FRAME_MS` (250), so **escape
is unreachable by construction**; the budget becomes `9 × interval` ≈ 1.1–1.5 s, past the whole
`HARD_DEADLINE_MS` (900 ms), so the ramp is cut off with `status: 'running'` and yields nothing; the
floor it would otherwise have produced was persisted as if it were a slope; and a small enough floor
reads as "clear below every boundary" and **settled the verdict permanently on one pass**.

⚠️ **This supersedes the earlier reading of the same symptom** — "the devices are measured against
different yardsticks, so use a fixed one", and "the probe reads 20–40 % slower inside a game than on
the harness, so re-derive the bands from in-game probes". Both are **retracted**. It is not an offset
to calibrate out and it is not a per-device yardstick problem: the ramp is not measuring the GPU at
all, so no choice of boundary and no common yardstick can fix it. What made it look like it worked is
that a weak device also has a slow boot, so the Y6's contaminated numbers landed in the `weak` band
and read as correct.

`mid` remains correct as a TIER — its settings are measured and the light cap it enables is worth
2.4 × — but **which tier a native device is assigned is not trustworthy**, and the failure direction
is `low` (recoverable, and what every device got before #188 anyway).

**Four guards now stand between that and a wrong verdict**, all measured into place 2026-08-11:

- ~~**A floor cannot settle a device BELOW a band boundary**~~ — **SUPERSEDED 2026-08-11: nothing
  settles on one pass any more, so the asymmetry this guard encoded has no path left and
  `ProbeReading.measured` was removed with it.** The one-pass shortcut needed the per-launch spread
  to be inside `PROBE_CLEAR_MARGIN` (1.5x). Measured, it is not: the A23's shade axis alone spans
  0.055-0.16 and OVERLAPS the iPhone 7's 0.03-0.07, so no single reading separates a mid-band phone
  from a weak one at any margin. Every device now pays the full `PROBE_SAMPLE_TARGET` (3) launches,
  and against a median a floor is merely conservative — it understates, which is the recoverable
  direction.
- **An implausible interval declines the pass** (`MAX_PLAUSIBLE_INTERVAL_MS` = 40 ms — 30 Hz plus
  jitter, since a throttled iPhone 8 really does drop there). ⚠️ Declines rather than CLAMPS: against
  a clamped 35 ms the S22's real steps "escape" on two boot stalls and report 0.14 Mpx/ms, settling a
  flagship at `weak`.
- **Every failure path logs** — the stage breadcrumb, the error, and the full ramp step table. It
  used to return `null` silently, so a device that never classified looked exactly like one that
  never probed.
- **The frame wait is bounded (5 s).** rAF does not fire while the page is invisible, and the probe
  blocks renderer creation — so a launch with the screen off used to hang it forever, with
  `HARD_DEADLINE_MS` unable to help (it is only consulted after a frame arrives).

Three properties keep it off the common path and bounded:

- **It engages only when the tier's caps would restrict something** (`capChangesAnything`). The
  census says nearly every scene is one directional plus a few locals, which already fits — so
  nothing is published and the frame behaves exactly as before. `high` sets both caps to 0
  (unlimited) and can therefore never engage.
- **An object whose AUTHORED selection already fits is left alone** — a CPU fast path, and provably
  not a behaviour change, since capping a set that already fits returns that same set.
- **It disengages entirely** past 31 lights (a 32-bit mask cannot address them individually, and a
  partial cap would drop whichever fell off the end) or on a light type the rule cannot classify
  (hemisphere, rect-area) — leaving the scene fully lit rather than guessing.

⚠️ **Two mask SPACES, and conflating them mis-lights the scene.** Authored masks are LAYER bitmasks
that intersect (several lights may share a layer); the cap's mask is INDEX space, where bit `i` is
the light at index `i`. When the cap engages it republishes every light under a synthetic identity
mask, so a selection can name individual lights. The authored intent then enters as the **candidate
set**, not as a filter on the result: choosing the nearest N globally and intersecting afterwards
deletes the cap's own choice whenever the nearest light is one the artist masked away, leaving the
object with fewer lights than either mechanism alone would have given it.

✅ **SETTLED — what it costs on a scene that DOES author masks: nothing measurable.** Earlier runs
disagreed (1.1 ms slower, then 0.45 ms faster) because they compared different frozen viewpoints; a
controlled run on the A23 puts the cap at 10.9–11.3 ms GPU against 11.0–11.1 ms uncapped, i.e.
inside the noise, reproduced twice. postfx-demo is the only project that authors masks.

`diagnose` reports `lightCap` whenever the cap is engaged — "why is this object dark?" is the
question this feature generates, and it should be answerable from data.

The shadow-caster cap (#229) has the same reporting rule and one extra wrinkle worth knowing:
`diagnose` reports `shadowCap` when that cap is engaged, but its `casters`/`kept` counts are
**absent rather than zero when the tier is unlimited**. On that path the engine deliberately never
walks the lights (there is no cap to compute), so it does not know the count — and a `0` from the
one function exported to answer "where did my shadow go?" would be a confident wrong answer on the
most common path of all. A scene that WAS counted reports both numbers even when the cap did not
bite, so "5 casters, 5 kept" is still a usable answer.

#### ⭐ GPU identity decides the tier — the probe is the fallback (#210)

**A device is classified by WHAT ITS GPU IS, not by benchmarking it at boot.** `resolveTier`
consults `gpuIdentity.ts` after the desktop carve-out and **before** the ramp probe, so a
recognised device gets its tier in ~0 ms, correctly, **on launch #1**.

Why this replaced the probe as the primary classifier (all measured 2026-08-12, evidence in "The
three-layer resolver, and what the GPU database cannot do" below):

- the probe **measures the boot, not the device** — the same Galaxy S22 reads `cpu` 11.2k on
  `sling` and 37.4k on `3d-physics-demo`, because the ramp runs while GLBs parse and textures
  upload;
- its top axis **was flat where the top boundary is** — `shade` read 0.20 / 0.21 / 0.20 for an
  iPhone 8, an S22 and an iPhone Air, so **no Android device ever reached `capable`**.
  ⭐ **FIXED 2026-08-13, and the cause was not the axis.** The probe was measuring flagships at
  IDLE CLOCKS: running the same ramp twice in one launch, a Galaxy S22 goes 7.49 → 19.92 while a
  Galaxy A23 moves only 12.13 → 15.61, and on the second pass the S22 finally ranks above the A23.
  Each GPU ramp now discards a warm-up pass, the shade axis is monotone across the three Androids
  (0.04 / 0.14 / 0.18), and **the S22 classifies `capable`**. Two other explanations were tested on
  hardware and refuted first — the GPU-clock latency floor (raising the ramp's start load moved
  nothing) and the per-submit clear (the S22's buffer is the *smaller* of the two). This does not
  make the probe primary again: identity still answers first, in ~0 ms, for recognised hardware;
- it needed **three launches to settle**, so the verdict was wrong on launches 1 and 2 — the ones a
  first impression is made on. ⭐ **FIXED 2026-08-13 (#221)**: the probe now repeats itself within
  one launch and settles there, under the unanimity rule described in "W2 — the probe becomes an
  isolated fallback" below. This one is no longer an argument against the probe;
- it **blocks launch 0.5–2.6 s** — and settling in one launch made that 1.6–1.8 s on the three
  Androids, paid once instead of three times. Still the reason identity answers first.

**Two layers**, and the second covers the first's blind spot:

| layer | answers | source | stale-proof? |
|---|---|---|---|
| **table** — 132 Android GPUs, vendored in `gpuBenchmarks.ts` | hardware we have data on; most entries sit at the bottom of the range, so the decision that can black-screen a phone is made where the data is densest | `'gpu-benchmark'` | **CC BY 4.0**, first-party from Kishonti |
| **generation floor** — parsed from the renderer string | hardware the data can NEVER cover: `Adreno 8xx`, `Immortalis-G9xx`, `Xclipse 9xx` | `'gpu-generation'` | ✅ never stale |

⭐ **The table comes from Kishonti's own open-sourced GFXBench results** (CC BY 4.0, © 2005–2025
Kishonti Ltd), not from a third-party republication. GFXBench was retired in December 2025 and its
results database published; taking the figures from the party that measured them replaced an
earlier table whose upstream rights were an open question. Attribution — credit, licence link, and
the statement that changes were made — is in `oss/THIRD-PARTY-NOTICES.md`, enforced by a guard test
because no automated licence scanner can see vendored data.

⭐ **It uses an OFFSCREEN test, and that is what resurrected the top band.** The previous table's
numbers were *onscreen* framerates capped at 120 by a 120 Hz panel, so every GPU above an Adreno 650
read ~120 and flagships could not be told apart — which is why this workstream once concluded the
`capable`/`high` boundary was unresolvable. Uncapped, the same GPUs span
650 → 122, 730 → 143, 740 → 233, 750 → 317, 830 → 436.

Anchored on the three devices this engine has actually measured: **PowerVR GE8300 (Huawei Y6)
→ `low`**, **Mali-G57 MC2 (Galaxy A23) → `mid`**, **Adreno 730 (Galaxy S22) → `high`** — the
band structure the ramp campaign spent three days failing to reproduce.

✅ **VERIFIED ON HARDWARE, 2026-08-12** (`demos/3d-physics-demo`, fresh APK, `pm clear` first, tier
read from the live page): the A23 reports `Mali-G57 MC2` and resolves **`mid`/`gpu-benchmark`**; the
S22 reports `Adreno (TM) 730` and resolves **`high`/`gpu-benchmark`**. The S22 result is the one
that matters — six probe launches across two projects had put that phone at `middle` every time,
and `high` was unreachable for any Android device. `source: 'gpu-benchmark'` is itself the proof the
probe was skipped: only the `cheap.source !== 'calibrating'` early return can produce it.
⚠️ The Y6 leg is NOT a fresh observation — it cannot install against `androidMinSdk: 31`.

⭐ **Every GPU with at least one submission gets a row, and thin rows are ROUNDED DOWN near a
boundary** (2026-08-13). The generator dropped GPUs with fewer than three submissions until then,
on the argument that "a median of two is just their mean" — true as statistics, and answering the
wrong question: this table does not publish an fps, it picks one of three coarse bands. Bootstrapped
over the source CSV itself (every individual submission against its own GPU's full-population
median, GPUs with n ≥ 8, 3,266 submissions), **a single submission lands in a different band only
0.7% of the time**, and the error is skewed ~100× toward the safe direction — 2.87% read below half
the truth, 0.03% read above 3× it.

The gate is now 1, which takes the table from **84 GPUs to 132**. The additions are the high-volume
budget and midrange silicon that previously had no row at all — Adreno 610/612/615/616/619/620/644,
Mali-G31/G51/G52 MC1/G57/G57 MC3/G72 MP3/G76 MC4/G610 MC6, Xclipse 940, Mali-G925-Immortalis MC12.
The risk is paid for at the consumer instead: a row with fewer than `CONFIDENT_SAMPLES` (3, i.e. the
old gate — so nothing that shipped before changes tier) that sits within `LOW_CONFIDENCE_MARGIN`
(1.2×) above a floor is **rounded down one band**, and its `reason` says so. Today that demotes
exactly four rows: Adreno 615/616 and Intel Skylake GT1 over the `mid` floor, Adreno 644 over
`high`. Rounding is **downward only** — a thin row just below a floor is already on the safe side.

⚠️ **The comparison is not "table against truth", it is "table against what happens instead".** An
absent row falls through to the boot probe, which was measured missing by a full band on the S22 and
reading its deciding `shade` axis 1.6–3× low on both Android phones. 0.7% is an improvement on that.

⚠️ **The band floors are not a frame budget.** The table's numbers are a GFXBench-derived
*relative ranking*. The floors are **`MID_FLOOR_FPS = 29`** and **`HIGH_FLOOR_FPS = 85`**, each placed at the widest
gap in its corridor (27.86→29.99 and 77.24→91.02), with no entry sitting exactly on either — a
property a test pins, because an earlier floor landed exactly on two budget parts and promoted them.
⚠️ That gap test reads the **confident** rows only, and it has to: softening the sample gate put
`adreno644` (90.3, n=1) inside the `high` gap, and it is demoted for exactly that reason. The floors
stay placed by the data they were derived from. The guard did its job — it failed on the
regeneration rather than letting a data-placed boundary quietly become an arbitrary one.

⚠️ **Neither sits in a large void, and the previous table's void was an ARTIFACT.** That table had a
conspicuous empty interval at 71–89 which this doc once cited as "decided by the data". It was the
edge of the refresh-rate saturation cliff. Uncapped data is dense and continuous, which is more
truthful — and it means both floors rest on the three measured anchors plus a plausibility
argument, not on a canyon. **Measured devices between the anchors are what would settle them.**

⚠️ **Extrapolation is only ever UPWARD, and only past the top of the data** — and "bigger number"
is not "newer series". An **Adreno 765 is upper-midrange where an Adreno 750 is a flagship**, so
`adreno`/`mali-g` compare by series (`floor(n/100)`) while `xclipse` compares by generation
(Samsung has stayed inside 9xx across three architectures). A part inside the top series that has
no row falls to the probe, which is the conservative answer.

⚠️ **Core counts come as `MCn` OR `MPn`** — ARM writes `MC` on Valhall-era parts and `MP` on
Midgard/Bifrost ones, and the table carries both. Matching only `MC` (a close-out fix) silently
disabled the "retry without the core count" fallback for every older Mali, so a `Mali-G72 MP6` fell
through to the probe while `malig72` sat unused in the table — stranding precisely the old, weak
hardware the data is densest on.

⚠️ **The ANGLE unwrap is load-bearing.** Android Chrome reports
`ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)` — the most common string shape on the platform.
A lazy `[^)]*` stops inside `Adreno (TM)` and the whole match fails, leaving `ANGLE (Qualcomm` as
the candidate, which normalizes to `angle` and matches nothing. `normalizeGpuKey` is duplicated in
`engine/scripts/gen-gpu-benchmarks.mjs` (an `.mjs` build script cannot import the package), and a
test requires every generated key to be a **fixed point** of the runtime copy — a divergence would
be a table that silently never matches, with no error and no log.

**Two consequences that fall out for free:**

- **A recognised device skips the launch-blocking probe entirely.** `resolveActiveTierOnce`
  resolves once with `useProbe: false` and only pays for the ramp when that returns
  `'calibrating'`. Identity returns `'gpu-benchmark'`, so the branch is never taken. No new
  mechanism — the property is pinned by a test on exactly that condition.
- **A DEBUG build still measures and throws the verdict away**, so every launch on a recognised
  phone is a free A/B between identity and the probe. A release build is byte-for-byte unaffected.

⚠️ **The desktop carve-out MUST stay ahead of this**, and the ordering is pinned by a test: the
table is *mobile* and includes mobile Intel/NVIDIA parts, so a desktop reporting an integrated
Intel GPU matches a row reading 30 and would be **demoted to `mid`** — an authoring machine
downgraded by a phone table. iOS likewise still answers from the model id, because WebGL masks
every iPhone to `Apple GPU`.

Identity returns `null` rather than guessing on a masked string, an unknown vendor or a generation
it cannot place — which lands exactly where such a device already landed (the probe, then
`calibrating → low`). **So adding this layer can only move a device that had no confident answer.**

#### The three-layer resolver, and what the GPU database cannot do (#210)

**Why identity is better, with the numbers.** `deviceCaps.ts:180` already reads
`UNMASKED_RENDERER_WEBGL` on every device in a release build. It was written off
(`qualityTier.ts:649`) as *"ambiguous — one name ships two GPUs"*. Checked against real data, the
ambiguity is between **siblings**, not generations, and a public database resolves even that:

| our device | database entry | fps |
|---|---|---|
| **Galaxy S22** `SM-S901U1` | `qualcomm adreno 730` → *"samsung galaxy s22 5g (sm-s901u)"* | **120** |
| **Galaxy A23** (Mali-G57 MC2) | `arm mali-g57 mc2` → *"samsung galaxy a2…"* | **35** |
| **Huawei Y6** (GE8300) | `powervr rogue ge8300` | **5–9** |

It names our exact phone models, and it splits `mali-g57 mc2` (35) from `mc3` (48) from plain `g57`
(49) — the ambiguity the code cites as the reason Android must measure.

**Ordering 120 / 35 / 5–9 is the band structure the ramp campaign spent three days failing to
reproduce**, available in ~0 ms with no launch cost and correct on launch #1.

⚠️ **What the database CANNOT do — and why it does not matter here.** Its top saturates.
Histogrammed across all 104 mobile entries:

```
median fps    entries
  0- 14    ############################################ 44
 15- 29    ################# 17
 30- 44    ############## 14
 45- 59    ############ 12
 60- 74    ####### 7
 90-119    ##### 5
120-134    ##### 5     ← Adreno 650=117, 730=120, 750=121, G715=121, G720=120
```

Those are **onscreen fps capped by a 120 Hz panel**, so an Adreno 650 (2020) and an Adreno 750
(2024) read 4% apart, which is false.

**But this saturation is benign and ours is not, and the difference is which side of the boundary
it falls on.** `shade` saturates at an **iPhone 8 — a 2017 phone** — i.e. *below* the boundary we
need to draw. The database saturates at a 2020 flagship sustaining 120 fps in a GFXBench scene,
i.e. *well above* anything our content asks of a GPU. So **"reads ≥ ~100 → `high`" is a sound
rule**, where "shade reads 0.20 → ?" is not.

And the region that carries the real risk is where this data is dense and monotone: **75 of 104
entries sit below 45 fps.** The decision that can black-screen a phone is made exactly where the
data is good.

**The three-layer resolver.** Each layer covers the blind spot of the one above it. Precedence is
top-down; the first layer that answers, wins.

| layer | answers | stale-proof? | cost |
|---|---|---|---|
| **1. Family + generation** — parsed from the renderer string | the TOP: `Adreno 8xx`, `Immortalis-G9xx`, `Xclipse 9xx` → `high` | ✅ **never** | ~0 ms |
| **2. GPU database** — vendored lookup on the normalized renderer string | the long tail of old/cheap hardware, where names do not order cleanly and the black-screen risk lives | frozen Dec 2025 — which is *behind* us | ~36 KB, ~0 ms |
| **3. Probe** — the existing ramp | unknown vendor, masked string, iOS web | — | the 6 s, paid by a MINORITY |
| **iOS native** — model id (already shipped) | all iOS native | ✅ threshold rule | ~0 ms |

**Layer 1 is what makes the stale database a non-issue**, and it is not a new idea — it is the rule
`qualityTier.ts:653` already argues for on iOS, never applied to Android:

> *"A THRESHOLD, NOT A LIST — AND THAT IS THE WHOLE POINT. An enumerated allowlist ossifies in the
> WORST direction… A `>= N` rule cannot fail that way, because newer silicon is only ever faster."*

The generation number is IN the string — `Adreno (TM) 840`, `Immortalis-G925`, `Xclipse 940` — so
2026 and 2027 silicon classify with no data refresh. **Verified against real shipping parts**, not
invented ones: all four of those resolve `high` via `gpu-generation` with no table row.

**There is no database current enough to make this unnecessary, and that is structural.** Surveyed
2026-08-12: detect-gpu's source (GFXBench) froze Dec 2025 and its
[issue #132](https://github.com/pmndrs/detect-gpu/issues/132) is open with no PR and no timeline;
the newest alternative found, [cpuranker](https://cpuranker.github.io/gpu.html) (98 GPUs, Jan 2026,
AnTuTu+GFXBench, GPU-name-keyed, CSV export), is one month newer and **still lacks Adreno 830/840**.
Every such database lags shipping hardware by months. Layer 1 is what makes that fine.

⚠️ **`Adreno 850` DOES NOT EXIST** — it was a rumour for Snapdragon 8 Elite Gen 6 (Sept 2026), and
it sat in a test as if it were real hardware. The shipping top is **Adreno 840** (SD 8 Elite Gen 5),
with 830 before it.

**The one gap a newer database WOULD close** is midrange parts *inside* the top series — Adreno
725/732/735, and Huawei's **Maleoon** family, which detect-gpu lacks entirely. Layer 1 deliberately
refuses those (extrapolating inside a series is the Adreno-765 bug), so they fall to the probe.
cpuranker has all of them. That is a **precision** win on new midrange, not a coverage win on
flagships, and the probe already handles it safely — so it is optional polish, not a blocker.
Merging it means either scraping an HTML table under an unstated licence, or hand-adding ~12 rows
with a source note; prefer the latter. Tested as a known property, not left as a surprise.

**The owner's constraint this is built to satisfy:**

> *"the game first impression is important. if probe says low on a high end device, the player
> experience would be bad vice versa."*

**A recognised device resolves its tier in ~0 ms, on launch #1, with no benchmark.** The 6 s probe
budget is then spent where it is genuinely needed — making the fallback stable for the unrecognised
tail — instead of being charged to every install. The player's own `quality.set` control stays
exactly as it is; it is the escape hatch in both directions.

⛔ **CANCELLED: the `capable` band re-campaign.** It was once the top item of this workstream. **Do
not run it.** Nothing available can rank flagships against each other — not our `shade` ramp (flat
from the iPhone 8 upward), not GFXBench (refresh-capped from the Adreno 650 upward), and not a
6-second version of either. The top boundary is a **lookup**, not a measurement. Re-opening this
needs a new axis with evidence it discriminates above an Adreno 650, not another campaign on the
axes we have.

#### Native (WebView) differs from mobile Chrome — verified on a Huawei Y6, 2026-08-10

Demos publish **web-only**, so measuring one in mobile Chrome is its shipping surface. Native games
are a different runtime, and three differences showed up the moment the same demo ran as an APK:

- **`deviceModel` exists natively and not on web** (`MRD-LX3`, via the `GameDebug` bridge). That is
  the field the iOS tier table keys on, so iOS *web* takes the measured path while iOS *native*
  answers statically — as documented above, now observed.
- ✅ ~~The WebGPU probe costs 8 seconds~~ — **RETRACTED, and it was a phantom.** The message
  `[gpuDetect] WebGPU probe did not answer within 8000ms` fired on every launch of every device
  because the timeout timer was created and **never cancelled**: it ran 8 s after a probe that had
  already answered, and `resolve(false)` on a settled race is a silent no-op. Measured directly in
  the WebView on a Galaxy A23: `requestAdapter()` **27 ms**, `requestDevice()` **29 ms**, returning
  a real `arm`/`valhall` adapter. Fixed by clearing the timer in a `finally`, verified on device
  (the line is gone), and pinned by a test that fails if the timer is left uncancelled.
- ⚠️ **The ramp probe returned NO READING on the first native launch**:
  `[rampProbe] no usable reading — fill ramp produced no usable reading (running)`. Status
  `running` means the ramp was cut off mid-flight, so the device fell through to
  `source: 'calibrating'` — the right tier (`low`) by fallback rather than by measurement.

  The cause is `HARD_DEADLINE_MS = PROBE_BUDGET_MS * 3` (900 ms), which is **wall clock**. This is
  the same defect class the plan already fixed one level down: `RAMP_BUDGET_FRAMES` became frames
  precisely because a millisecond budget buys too few frames on slow hardware and "returns a
  non-answer that looks like an answer". The outer deadline never got the same treatment, and the
  Y6's cold launch is where that bites.

  **It self-heals**: a second attempt measures cleanly — the Y6 blocking the launch 1948 ms, the
  A23 landing `middle` and caching it. ⚠️ The `fill`/`draw` figures this passage used to quote are
  removed rather than updated: those ramps no longer decide anything (see the band table below), and
  a corroboration between two numbers that both measured the wrong quantity is not corroboration.

  ⚠️ **Do not read an early sample as a failed probe.** A reading taken seconds after launch shows
  `source: 'calibrating'` and no cached verdict on every device, because the FIRST attempt has
  failed and the second has not finished. It is not evidence the probe is inert natively — the
  A23, sampled later, reports `source: 'measured'` with the verdict cached. Native PlayerPrefs is
  also `@capacitor/preferences`, **not** localStorage, so reading `localStorage` for the cached
  verdict reports "nothing cached" for every device no matter what is stored.

- ✅ ~~The native WebView never gets WebGPU~~ — **RETRACTED.** That was read off the phantom
  warning above and is false: the A23 and S22 have working WebGPU in the WebView, and
  `DeviceCaps.webgpu` (which is the same probe) correctly reported `true` all along. The lesson is
  the one this file keeps re-learning: **a log line is an instrument, and an instrument can be
  broken.** Two confident conclusions were drawn from this one — "native has no WebGPU" and "the
  probe costs 8 s of every launch" — and both were wrong, in the same direction, for a whole
  session. The Y6 genuinely reports `webgpu: false`; that answer is real and arrives fast.
- **Steady state is still 60 fps natively** on both the A23 and the S22 with the cap engaged
  (16.6 / 16.8 ms, 8 and 11 draw calls). The A23 got there the interesting way: it booted `mid`
  from its cached verdict, hit a 92.6 ms frame during load, and **calibration demoted it to `low`**
  — the demotion ladder firing on real hardware, unprompted. ⚠️ **Re-read after #227: that was also
  the defect.** "During load" is the whole of it — the frame being judged was produced by the load,
  not by the game. Calibration is no longer armed until a scene has finished loading; see "Live
  calibration" below.
- ⚠️ **Unexplained: the S22 reports `probeVerdictStore` as having no provider** in the native app,
  which would mean it cannot cache a verdict and re-probes every launch. The A23 has the provider
  in the same APK. Not chased down.

**IBL is the single most expensive thing the low tier drops — by a wide margin.** Measured on a
Huawei Y6 2019 (#154): **~26 ms of a ~53 ms frame**, entirely GPU. Suppressing it took `games/sling`
from 18.7 to 36.5 fps, and with the whole tier applied the game runs at **22 ms / 45 fps**.

Three things about it are worth knowing before touching it:

- **It cannot be fixed by shrinking the asset.** Downsampling the source HDR from 2048×1024 to
  256×128 (16 MB → 0.25 MB) moved the frame 53.4 → 53.2 ms — nothing. three's PMREM converts the
  source ONCE into a fixed-size CubeUV cubemap and the fragment shader samples that, so the source
  resolution never reaches the shader. The cost is the per-fragment env lookup itself.
- **The scene BACKGROUND is deliberately left alone.** It was measured not to be the cost, and it
  is what keeps a sky/ocean looking right — so only the lighting contribution is suppressed.
- **The compensation exists because IBL is fill light.** Without it the scene renders visibly dark
  and flat. Both multipliers are 1 whenever `ibl` is true, so a tier that keeps IBL passes the
  authored lighting through untouched and cannot double-light the scene.

  ⚠️ **`iblOffAmbientBoost` is MULTIPLICATIVE on the authored `AmbientLight`, and that makes it
  structurally weak in exactly the scenes that need it most.** A scene that leans on an
  environment for fill authors a near-zero ambient *because* the environment is doing the work —
  `demos/forest-camp` authors `0.06` against an `Environment` at intensity `0.3` — so the default
  ×4 returns `0.24` and cannot come close to replacing what was taken away. Measured with the tier
  pinned in the editor, one fixed camera, mid vs low (sRGB mean over a fixed crop): character body
  **51.8 → 36.3**, grass **127.5 → 101.5**. The character loses more than the terrain for a
  geometric reason, not a material one — both are `metalness: 0` — its visible surfaces face away
  from the sun and were taking most of their light from the environment, while the terrain faces up
  into the directional light. forest-camp now authors **8** (body 44.1, grass 109.7); the owner
  chose that over full parity at 12 (body 50.4) because ambient is UNIFORM, so past a point it
  lifts shadowed surfaces above where IBL had them and the scene flattens — the tent's dark side
  reads 36.1 at mid, 43.4 at boost 8, 48.5 at boost 12. Two consequences: **tune this per project
  against the scene's authored ambient**, not by carrying a number between projects; and when a
  low-tier scene looks wrong, compare frames from ONE camera — testboard `q4UxFVVeioEQqT5sqymu`
  reported a "near-black" hero from two frames shot minutes and several metres apart, whose
  measured torso luminance was in fact 44.3 vs 44.2.

  **Confirmed on hardware that actually lands on `low`** — the numbers above are an editor A/B with
  the tier pinned, which is the weaker instrument. The A23 stopped reaching `low` once forest-camp
  capped its mid tier, so the device is the **Huawei Y6 2019** (API 28, PowerVR GE8300 — below the
  shipping floor, so this needs the temporary-floor recipe in
  [build.md](./build.md) § "Testing on hardware BELOW the shipping floor"). It resolves `low` for
  real (`scene.environment` false, exposure 1.375, DPR 1, shadows off, `AmbientLight` 0.48 = the
  authored 0.06 × 8), and two builds differing in that ONE field, same boot pose and crop, read:

  | | character body | grass | tent (shadowed) |
  |---|---|---|---|
  | `iblOffAmbientBoost: 4` | 63.3 | 125.4 | 27.1 |
  | `iblOffAmbientBoost: 8` | 69.6 | 139.3 | 35.7 |

  The shaded tent stays well below the sunlit terrain at 8, which is the flattening check passing on
  the device rather than in the editor. ⚠️ These absolutes are NOT comparable with the editor
  figures above — different pose, different framing, the campfire in shot. Only the delta within one
  device means anything, which is the same "compare frames from ONE camera" rule applied to the
  instrument itself.
- **The compensation is gated on ACTUAL suppression, not on the tier** — `isIblSuppressed()`, set
  by `syncEnvironment` each frame, is true only when the tier says no IBL *and* the scene owns a
  loaded HDR `Environment` to lose. Keying it on the tier alone (as it first shipped) brightened
  every low-tier scene that had an `AmbientLight` and no environment — several shipped demos — and
  since an unrecognised device resolves `low`, that meant every phone. **A tier CLAMPS, never
  RAISES**, and a compensation whose condition is broader than the thing it compensates for is a
  raise. This is also why the exposure half moved out of `applyRendererColorConfig`, which runs
  once at renderer creation, before any scene has loaded: it cannot know yet whether there is an
  environment, so `reconcileToneExposure` re-derives it per frame (change-gated, so the steady
  state writes nothing).
- **Every surface that calls `syncEnvironment` must call `reconcileToneExposure` right after it.**
  The flag is module state describing what the LAST `syncEnvironment` saw, and the editor mounts
  two surfaces that each call it (the Game panel's `Scene3D`, the Scene panel's `SceneView`). One
  that sets the flag and never reads it back keeps whatever exposure its renderer was built with —
  which is how the Scene panel briefly baked in a compensation belonging to the Game panel.
  Enforced by `engine/tests/architecture/iblCompensationSurfaces.test.ts`. `applyRendererColorConfig`
  is deliberately outside this: it sets the AUTHORED exposure with no compensation, because it also
  serves the asset-preview renderers (`ModelPreview`, `previewScene`), which never sync an
  environment and are correct by having no compensation rather than by reconciling one.

**The low tier does NOT spend that saving on resolution — that was tried and measured.** With IBL
off: 1× (360×753) = 22 ms / 45 fps, 1.4× (503×1054) = 72 ms / 14 fps, 2× (720×1506) = 69 ms /
14 fps. A fill-bound GPU pays ~4× for 2× DPR, far past the ~11 ms of headroom, and an odd-sized
1.4× buffer is worse for a tile-based renderer than the aligned 2× one.

⚠️ **`syncEnvironment`, `syncLights` and `syncRenderables` re-apply their state EVERY FRAME.**
Setting `scene.environment`, a material, or `obj.visible` from the console is silently reverted
within a frame or two, so a live A/B measures the same thing twice and reports a clean null. This
cost most of a session and produced several confidently wrong conclusions. To probe live, either
change the authored source or defeat the re-sync and verify it held:
```js
Object.defineProperty(scene, 'environment', { configurable: true, get: () => null, set: () => {} });
// …then re-read after 10+ s and assert it is still off BEFORE measuring.
```

**`antialias` cannot change live** — it is a `WebGPURenderer` constructor option baked into the
swapchain, so it applies at the next renderer creation. We deliberately do not rebuild the renderer
for it: a rebuild costs the ~316 ms hitch measured above, which is a lot to pay during a DEMOTION,
the one moment the device is already struggling.

**Read the tier through `getEffectiveThreeSettings()` — never `getRenderSettings().three`.**
`pixelRatioCap` is read twice, by `makeWebGPURenderer` when it allocates the first buffer and by
Scene3D's `ResizeObserver` on every resize. If one applied the tier and the other read the raw
setting, the first resize would silently undo it.

**Precedence: player > project pin > iOS model id > allowlist > desktop > measured (boot ramp probe) > calibrating (low).** The player wins
outright because they can see the screen and we cannot; their choice persists via `PlayerPrefs`
(behind the `playerTierStore` provider slot, since `rendering/` may not import `storage/`) and
**stops calibration**, or the engine would override an explicit human decision with an inference.

**Desktops are the one carve-out (`TierSource: 'desktop'`), and it is keyed on `formFactor`, never
on `platform`.** `DeviceCaps.formFactor` decides `'mobile'` vs `'desktop'` from a POSITIVE desktop
signal only — a native iOS/Android build is mobile; `navigator.userAgentData.mobile` is believed in
both directions when the browser reports it; otherwise a fine pointer AND zero touch points reads
as desktop. It deliberately does not derive from `platform`: `platform` is Capacitor's, so a phone
browser reports `'web'` exactly like a desktop does, and the demos publish web-only — keying on
platform would put the demos' entire mobile-web audience back on `high`. Unresolvable cases default
to `'mobile'`, the safe side: a desktop wrongly called mobile boots low and calibration promotes it
seconds later, while a phone wrongly called desktop boots high and can lose its context before
demotion ever fires.

One consequence of `auto` being the default: an unpinned project now awaits `getDeviceCaps()`
before the first drawing buffer is created, because the knobs a tier clamps — `antialias` above all
— are baked into that buffer at creation and cannot be applied later.

**`auto` starts LOW (outside the desktop carve-out) and promotes on measured evidence.** The
failure is asymmetric: booting high and guessing wrong is a lost context and a permanent black
screen; booting low and guessing wrong costs a beat of uglier rendering. Two rules that are easy to
get backwards:

- **Demotion is IMMEDIATE, promotion waits for a scene boundary.** A tier switch recompiles
  shaders; a mid-play promotion can freeze longer than the low tier it escapes, while a deferred
  demotion leaves a struggling device struggling until a scene load — which for a one-scene game is
  never. Demotion is also **sticky**: never promote again after one, or the tier oscillates.
- **Both move ONE RUNG of `TIER_ORDER` at a time**, and the target comes from the decision, never
  from a literal at the call site — `low → mid → high` up, `high → mid → low` down. A hardcoded
  `'low'`/`'high'` was correct only while there were two tiers; with three it would jump the ladder
  and throw away settings a middling device was measured affording. A second demotion still reaches
  `low`, because the sticky flag blocks promotion only.
- **`mid` is the one rung that can move in both directions, and the two rules can BOTH be true
  there.** On a 30 Hz display a vsync-pinned 33.4 ms frame is over the 33.3 ms budget *and* leaves
  the CPU under 40% of the interval. Demotion is evaluated first and has the shorter hold (2 s vs
  5 s), so that resolves in the safe direction every time.
- **Headroom is judged by `cpuMs` while vsync-bound, by `frameMs` only once frames run long.**
  While vsync-capped, `frameMs` is pinned at the display interval and reports "barely making 60"
  and "trivially making 60" identically — judging by it would promote a device with no headroom.
- ⚠️ **"Over budget" means the FRAME CAP in force × 1.2, not a fixed 30 fps** — and the practical
  effect is that **demotion is stricter than it looks**. `frameProfiler` reads the cap
  (`setProfilerFrameCap`, pushed from `setTargetFPS`), so on the fleet's `targetFps: 60` the
  threshold is **20 ms**, not 33.3: a device holding ~45 fps for the 2 s hold demotes one rung,
  where before it had to fall under 30 fps. That is deliberate — you asked for 60 and are not
  getting it, and demoting is the recoverable direction — but demotion is **sticky for the
  session**, so a heavy load window can cost a rung until relaunch. A project that would rather
  ride it out authors a lower `rendering.targetFps`, which raises its own budget in step. The
  profile publishes the threshold it used (`budgetMs`) and the demotion log quotes THAT; it used
  to quote a hardcoded 33.3 ms and contradict its own numbers (close-out 2026-08-12).
- ⭐ **CALIBRATION IS NOT ARMED UNTIL A SCENE HAS FINISHED LOADING** (#227, `armTierCalibration`).
  The loop used to start judging the instant a tier resolved, which meant judging GLB parsing and
  shader compilation and calling the result the device's steady-state capability.

  **Measured on `demos/forest-camp` / Galaxy A23** (2026-08-14, app data cleared): `[rampProbe]
  middle` at +0.000 s and `mid via gpu-benchmark` at +0.001 s — *two independent methods agreeing* —
  then `switched to 'low'` at +3.570 s on a 95.5 ms median over the 20 ms budget. The 2 s streak
  began ~1.6 s in, inside the load. Pinned to `mid` the same scene on the same phone runs
  **16.8-20.5 ms**, inside the budget it was condemned against, and because demotion is sticky the
  misreading lasted the session. Nothing about this is forest-camp-specific: any project with a
  non-trivial first load, on any device assessed above `low`, was exposed.

  The rules, and each is load-bearing:
  - **The arm signal is the first world swap** — `onWorldSwap`, which fires from `setCurrentWorld`
    at the END of a load, after the staging world is populated *and* after the `beforeSwap` prewarm
    has compiled shaders. ⚠️ Deliberately **not** `sceneManager.registerSceneCallback('*', …)`,
    which looks purpose-built for it: that registry is a `Map` keyed by pattern, so a second `'*'`
    registrant silently replaces the first and arming would vanish with nothing reporting it.
    `onWorldSwap` holds a `Set`, and it is L0 — `rendering/` (L2) may not import `scene/` (L3) at all.
  - **Arming also DROPS the frame window**, and that half is easy to miss. `PROFILE_WINDOW_FRAMES`
    is a frame *count* (120), on purpose, so a slow device gets a longer window — at 95.5 ms load
    frames that is ~11.4 s of history. Gating the verdict without dropping the window would hand
    the policy a median still dominated by the load, and the demotion would fire moments later
    anyway.
  - **Both directions are suppressed**, not just the demotion that was seen misfiring — a promotion
    decided off load frames reads the same contaminated window.
  - ⚠️ **Demotion is suppressed outright during the window** (owner, 2026-08-18). The alternative —
    keep it live at a harsher threshold so only catastrophic frames trip it — is ruled out by the
    measurement, not by taste: the A23's load frames ran 95.5 ms against a 20 ms budget, nearly 5×
    over, so any threshold high enough to ignore a load also ignores a genuinely broken device. The
    stated cost is that a device that truly cannot render gets no relief until its first scene
    loads; that is cheap because the player is watching a *load*, and the knobs a demotion applies
    (DPR, shadows, frame cap) change how a rendered game looks. The one knob that matters during a
    load is the texture cap, already resolved from the probe before assets fetch (#212).
  - ⚠️ **Arming is gated on live calibration being ENABLED, so the editor is untouched.** The
    listener is module-scope and does not consult the tick's gates, so an ungated one fired in the
    editor too — which opts out entirely (`main.tsx: setTierCalibrationEnabled(!__MODOKI_EDITOR__)`)
    — and zeroed the frame window on the first scene load. That window is what `debug/perfSources.ts`
    feeds the Profiler panel and `modoki_profiler`, so a measurement taken just after loading the
    scene you want to measure read a handful of frames with nothing saying why. A mechanism the
    editor has opted out of must not have side effects there.
  - **A 30 s backstop arms it anyway** if no world swap ever arrives, so "arm on a scene load"
    cannot fail *closed* and leave a slow device un-demotable for the session — #227 inverted, and
    the worse direction. It is long on purpose: a short backstop would fire mid-load and hand the
    policy exactly the frames arming excludes. The worst first-scene prewarm measured here is
    postfx-demo's **16.5 s on a Huawei Y6**, and 30 s clears it.

  ✅ **VERIFIED ON THE A23** (2026-08-18, on the low-end Samsung, `demos/forest-camp`, app data cleared,
  repo config). An A/B on the same device and the same install path, which is the only form of this
  check that means anything — "no demotion" alone is equally explained by a crash, a gate, or a
  missing config:

  | build | result |
  |---|---|
  | pre-fix (`HEAD~1`) | `mid via gpu-benchmark` → `switched to 'low' — median frame 83.6ms over the 20.0ms budget for 2s` |
  | post-fix | `mid via gpu-benchmark`, **no switch** — 33 s of runtime, tier stays `mid` |

  The backstop warning never appeared despite >30 s elapsing, which is the positive half of the
  result: arming came from a real world swap, not from the failsafe. `qualityTier` is unset on
  forest-camp (so `auto`) and it authors both `mid` and `low`, so neither the pinned-tier nor the
  one-config gate can account for the quiet run.

- ⭐ **AN IDLE WINDOW IS NOT EVIDENCE EITHER** (owner, 2026-08-20, `core/userActivity.ts`). The
  arming rule above says a LOAD window does not describe the device the player plays on. The second
  window that does not is an IDLE one: nothing is being touched, so what the frames describe is the
  device's idle behaviour rather than its capability.

  ⚠️ **THE MECHANISM IS THE DISPLAY, NOT THE CPU GOVERNOR — corrected 2026-08-20 after measuring
  it.** This section originally attributed the idle readings to "mobile CPU governors drop clocks
  when there is no input", which is plausible, was never measured, and is not what produces the
  number. On the S22, `dumpsys display` shows `mActiveRenderFrameRate` dropping **120 → 24.000002**
  after ~20 s of static content (an LTPO panel idling down), recovering in **<69 ms** on the first
  touch. rAF follows the panel, so `frameMs` becomes **41.67 ms = 1000/24** — which is the 41.6 ms
  in every reading below, to three digits. The governor contributes something (`cpuMs` rose 5.6 →
  8.4 ms across the same transition) but it is the minor term: 8.4 ms of CPU cannot make a 41.6 ms
  frame. **Why the distinction earns its place:** a governor story says "wait for the clocks to ramp
  and the reading fixes itself", and that is what the idle guard alone assumed. A display story says
  the interval is *somebody else's number entirely* — which is why the fix below had to change what
  the demotion MEANS, not just when it may fire.

  **Measured on a Galaxy S22** — the most powerful Android handset in the lab — sitting idle on
  Court's tutorial (Testboard `lvROp0yDYPSzS0VZM6LH`):

  ```
  {"tick":204,"tier":"mid","prev":"high","reason":"median frame 41.6ms over the 20.0ms budget for 2s"}
  {"tick":270,"tier":"low","prev":"mid","reason":"median frame 41.7ms over the 20.0ms budget for 2s"}
  ```

  Two tiers in ~66 ticks, while GPU identity had deterministically resolved `high` on that same
  phone at boot (`Adreno (TM) 730`, byte-identical across three cold launches) — so the boot answer
  and the calibrated answer disagreed by two whole rungs on one device. And it does not come back:
  the player taps, the panel returns to full rate, and the game is still running at `low`
  on a flagship.

  ⚠️ **What `low` actually costs COURT is narrower than the tier's field list suggests, and this
  was overstated here until it was checked** (close-out, 2026-08-21). The obvious reading — DPR 1,
  shadows off, IBL off, `textureMaxSize` 512 — is a list of the tier's fields, not of the fields
  this project READS. Court renders no 3D, so shadows/IBL/`pixelRatioCap`/`shadowMapCeiling`/
  `maxDirectional`/postFX are all inert for it; and `textureMaxSize` is inert too, for a reason
  worth knowing generally: the cap applies only where the build EMITTED a variant at that size
  (`resolveTextureVariantUrl` checks `settings.sizes?.includes(cap)` and falls through otherwise),
  and **0 of Court's 51 textures carry a `sizes[]` array in the NATIVE manifest**. So on the builds
  measured here a demotion changes exactly three things for Court: `pixiPixelRatioCap`,
  `pixiAntialias`, and the 30 fps cap. That is still the difference between a sharp board and a
  pixelated one — which is why the defect mattered — but a reader should not carry away that
  texture memory or lighting moved.

  ⚠️ **"Inert" here means IN A NATIVE BUILD, and the distinction is the gate's whole purpose** —
  this qualifier was missing for about an hour after the paragraph above was written, which is the
  same overstatement it exists to correct. `shouldEmitTextureTierVariants`
  (`engine/plugins/textureTierEmit.ts`) emits per-tier sizes only for `--target web` or an OTA
  publish; on native every size would ship inside the app bundle anyway, so there is no download to
  save and emitting them is pure bloat. A **web or OTA** Court therefore does honour
  `textureMaxSize` on `low`. Before quoting an empty `sizes[]` as evidence about a project, check
  which target produced the manifest you are reading.

  ⚠️ **Why it did not come back is worth stating exactly, because "the `demoted` flag is sticky" is
  the tempting answer and it is not the whole one** (close-out, 2026-08-20). That flag is cleared by
  any idle→active bounce (`tickTierCalibration`'s `wasIdle` reset calls `freshTierChangeState()`),
  so the device does get fresh chances to climb. It could not take them because PROMOTION was
  independently impossible on that reading — see the promotion rule below. Two defects, one
  symptom; fixing either alone leaves the phone on `low`. Not
  lab-specific either — reading a tutorial, taking a call, or looking away is the same window.

  The rules:
  - **Both directions**, for the same reason arming suppresses both: letting one through would make
    the window's meaning depend on which way the sample happened to point. Three alternatives were
    offered to the owner (idle blocks demotion only; floor the demotion at a `gpu-benchmark` boot
    verdict; both) and this is the call.
  - **The signal is stamped by the input SOURCES, not by `inputSystem`.** A game with no `Input`
    resource never runs that system, and gating calibration on a signal such a project cannot emit
    would suppress it forever for a whole class of game. A game registering its OWN `InputSource`
    should call `noteUserInput()` — it is exported from the runtime barrel for that, and the
    suppression logs itself once after the arm backstop rather than going quiet.
  - ⚠️ **The window is dropped on the way BACK from idle, not on the way out**, and this is the half
    that is easy to get wrong. The frame profiler keeps filling its ring throughout the idle stretch
    and the sustain clocks keep whatever they held, so without the reset the first interacting tick
    judges a ring full of throttled frames against a clock that ran the whole time — and demotes
    instantly, which is the same bug in slow motion.
  - **`IDLE_EVIDENCE_MS` is 5 s**, sized off the longer of the two sustain windows
    (`PROMOTION_HOLD_MS`), so the frames that voted were plausibly measured while somebody was
    playing. Shorter would let a governor that has not yet dropped clocks vote; much longer would
    let one that already has.
  - **Stated cost**: a device that genuinely cannot render gets no relief while nobody is touching
    it. Cheap for the same reason the load-window cost is — the knobs a demotion turns change how a
    game LOOKS to a player who, by construction, is not looking.

  ✅ **Verified on the S22, 2026-08-20.** Two runs of a 92 s measured idle window (`games/court`,
  built from the fix): **zero `@tier` events**, tier held at `high`, `frameMs` 16.7 ms with `cpuMs`
  5.6 ms throughout the following play window. The pre-fix build on the same phone demoted twice
  within 10 s of boot. `qa/cases/rendering/tier-calibration-idle-window.md` (QA-RENDER-0007) is the
  case, targeted at that phone specifically — a device whose panel does not idle down passes it
  vacuously.

- ⭐ **AND A FRAME WE ARE NOT FILLING IS NOT A FRAME WE CAN RELIEVE** (owner, 2026-08-20,
  `frameIsFull` in `rendering/qualityTier.ts`). **The idle guard above was necessary and not
  sufficient, and this is the half that actually closes the bug.**

  With the idle fix in place the S22 still demoted — reproduced deliberately: launch, idle 92 s,
  then tap every 2 s. It fell to `mid` **4 s after input resumed**, `median frame 41.1ms over the
  20.0ms budget`, with the panel already measured back at **120 Hz**. Sampling the live profile
  every 400 ms across that window (120 samples) shows why:

  | frame interval | engine CPU | headroom | verdict |
  |---|---|---|---|
  | 41.6 ms | **8.4 ms** | ~33 ms | `overBudget: true` → demote |

  The engine was using 8.4 ms of a 41.6 ms frame and being condemned for the 33 ms it spent
  *waiting*. `overBudget` compares the frame INTERVAL against the budget, and an interval is set by
  whatever paces the frame — the workload, the engine's own cap, or the display. Only the first is
  something a tier can change.

  **The rule:** demotion additionally requires `cpuMs.median >= budgetMs * DEMOTION_CPU_SHARE`
  (0.7). If the engine's own work fits comfortably inside the budget there is nothing a lower tier
  could give back — every knob it turns (DPR, shadows, IBL, texture size) buys time the engine is
  not spending.

  - **The bar scales with the target fps, because it is a ratio of the BUDGET** and the budget is
    derived from the frame cap in force (`frameCapIntervalMs * 1.2`). At `targetFps: 60` it asks for
    14 ms of engine CPU; at `targetFps: 30`, 28 ms. The same 20 ms of CPU is therefore full at 60
    and not full at 30 — correct, since at 30 that engine still has half its frame left. (owner,
    2026-08-20: *"if the current target fps is 30, we should increase the threshold"*.)
  - **The demotion `reason` now carries the CPU share** — `median frame 41.6ms over the 20.0ms
    budget for 2s (engine cpu 8.4ms of it)`. This is the one surface that explains a surprising
    tier, and for months it asserted "slow device" by omission while the engine idled.
  - ✅ **The weak end was checked with the weak device, not with arithmetic** (2026-08-21). The
    obvious worry about a CPU-based bar is that it strands the hardware this system exists for, so
    Court was installed on the **Huawei Y6 2019** (API 28, below the shipping floor — `androidMinSdk`
    lowered temporarily per [build.md](./build.md), reverted before commit) and profiled while being
    played:

    It was pinned to each tier in turn with `quality.set` and profiled while being played:

    | Y6 2019 (throughput index **4.782**) | frame | fps | engine CPU | restMs | over budget? |
    |---|---|---|---|---|---|
    | on `low` (30 fps cap) | 33.2 ms | **30.1** | 20.7 ms | 12.6 ms | no |
    | on `mid` (inherits 60) | 22.0 ms | **45.5** | 20.5 ms | **1.4 ms** | **yes** |

    Court's `mid` authors `targetFps: 0` and so inherits the project's 60 → budget 20 ms → a
    fullness bar of 14 ms. The Y6 spends **20.5 ms** there, well past it: on `mid` this device
    demotes. Against the S22's idled-panel reading (41.8 ms frame, **8.7 ms** CPU) the two cases are
    separated by ~2.4x on the one number the rule reads, which is the margin the bar actually
    operates with.

    ⭐ **The Y6 is CPU-BOUND, and that is what makes a CPU bar safe on weak hardware.** `restMs` on
    `mid` is 1.4 ms — the GPU is barely waited on; the engine's own main thread IS the frame. It
    therefore cannot reach 60 fps by arithmetic, not by measurement: 20.5 ms of CPU does not fit a
    16.67 ms frame whatever the GPU does. On `low` it makes its 30 fps target exactly and is not
    over budget, so nothing demotes it — the tier the GPU table boots it into is already right, and
    `promotionCeiling` pins it there (zero `@tier` events all session).

    ✅ **What each tier costs once its DPR was raised** (Court, 2026-08-21, owner's spec `high 3 /
    mid 2 / low 2` for the 2D `pixiPixelRatioCap` — the knob that decides a 2D game's sharpness;
    the three-side `pixelRatioCap` is inert for a project that renders no 3D). Each phone measured
    on the tier the GPU table actually gives it, while being played:

    | device | tier it gets | DPR | frame | fps | cpu | rest | over budget? |
    |---|---|---|---|---|---|---|---|
    | Galaxy S22 (index 143.2) | `high` | 3 | 16.7 ms | 59.9 | 5.6 ms | 11.2 ms | no |
    | Galaxy A23 5G (39.4) | `mid` | 2 | 16.7 ms | 59.9 | 13.4 ms | 3.1 ms | no (budget 20) |
    | Huawei Y6 2019 (4.8) | `low` | 2 | 33.2 ms | 30.1 | 23.3 ms | 9.9 ms | no (budget 40) |

    Every rung holds its own target with room to spare, and the DPR rise cost nothing measurable on
    either end: the Y6 took 4x the pixels at `low` with no change in frame time, and the A23 holds
    60 fps at `mid` with ~6.6 ms of headroom. The reason is the same at both ends and is the
    property this whole section turns on — **these devices are CPU-bound, not fill-bound**, so
    spending the idle GPU on sharpness is close to free.

    ⚠️ **A DPR CAP ONLY BITES A DEVICE WHOSE OWN RATIO EXCEEDS IT** — `min(devicePixelRatio, cap)`
    (`canvas2DSizing.ts`), so raising a cap above a phone's native ratio changes nothing at all.
    Worth stating because it makes the table above read differently than the numbers suggest:

    | device | density | its DPR | CSS viewport | cap | ratio actually used | backing buffer |
    |---|---|---|---|---|---|---|
    | Y6 2019 | 320 | 2.0 | 360×780 | 2 | 2.0 — binds exactly | 720×1560 ≈ 4.3 MiB |
    | A23 5G | 300 | **1.875** | 384×832 | 2 | **1.875 — cap does NOT bind** | 720×1560 ≈ 4.3 MiB |
    | S22 | 480 | 3.0 | 360×780 | 3 | 3.0 | 1080×2340 ≈ 10.1 MiB |

    So `mid: 2` means "render at native" on the A23 rather than "render at 2", and the `low` rise
    costs the Y6 about **+3.2 MiB** of backing buffer (1.07 → 4.3), not the ~12.6 MiB a
    physical-pixel reading of the same arithmetic gives — a review got that wrong by treating the
    720-px PHYSICAL width as the CSS viewport, which on a DPR-2 panel is 360. Small enough that the
    Y6 held 30 fps with no stalls across the session; big enough to be worth computing rather than
    waving at, since this is GPU/unified memory on a 1.8 GB phone and MSAA can multiply it again.

    ✅ **A live tier switch DOES re-apply the pixel ratio**, unlike `antialias`.
    `applyActiveTierToRuntime` ends in `forceResizeAllSurfaces()`, `Canvas2DMount` registers
    `updateSize` on that bus, and `updateSize` re-reads `getEffectivePixiSettings()` fresh — so a
    mid-session demotion really does shrink the buffer. Pointer math cannot desync from it either:
    the 2D hit-test re-derives the backing size from `app.renderer.screen` on every call rather
    than caching a ratio.

    ⚠️ **The A23 is the only rung whose calibration outcome is worth thinking about**: 13.4 ms of
    CPU sits just under `frameIsFull`'s 14 ms demotion bar and well over `hasHeadroom`'s 8.33 ms
    promotion bar, so it stays on `mid` in both directions — which is correct, and is what a device
    sitting comfortably in its own tier should look like.

    ⚠️ **An earlier draft of this table said `low` ran at 61.4 ms / 16 fps.** That sample was taken
    seconds after boot with a 1678 ms stall inside the window; the owner, watching the screen, said
    the game was running at a constant 30 fps and was right. The instrument was what was wrong — a
    profiler read from a boot-adjacent window is not evidence about steady-state play, however
    precise its decimals look. Re-read on a settled window: 33.2 ms, p95 33.6, `vsyncBound: true`.
  - ⚠️ **Stated cost: a purely GPU-bound device with an idle CPU no longer demotes automatically.**
    `restMs` is GPU + present + idle *together* and cannot be split without timestamp queries
    (`core/gpuTimings.ts`), so CPU is the only per-frame cost measured honestly. Accepted because it
    is the direction that costs least: the low-end hardware this system exists for is CPU-bound in
    the measurement the profiler was built from (the Y6 2019 sat at 83 ms with ~48 ms of it CPU,
    58%), while the false demotion is silent, sticky, and hits the FASTEST phones hardest. A player
    who wants that relief can still pick a tier by hand, which outranks calibration by design.
  - ⚠️ **Two existing unit tests were DEFENDING this bug** and had to change. One asserted a
    demotion on a vsync-pinned 33.4 ms frame with an 8 ms CPU, described as "real on a 30Hz display"
    — which is the S22 shape exactly. See the comments on both in `tests/runtime/qualityTier.test.ts`.
- ⭐ **AND PROMOTION ASKS THE SAME QUESTION, ABOUT THE NEXT TIER'S FRAME** (owner, 2026-08-20).
  The demotion fix above left promotion still reading the interval, and that half had the mirror
  defect: `VSYNC_INTERVALS_MS` lists only 60/90/120/144 Hz, so a device presenting at 24/30/48 Hz
  read `vsyncBound: false` and fell to a branch asking for `frameMs.median <= 16.67 ms` — which a
  48 Hz panel (20.8 ms) can never satisfy however idle its CPU. A phone that boots `low` on an
  idling panel could never climb out. Same shape as the #202 frame-cap defect, one rung over.

  **Extending the table was the obvious fix and is the wrong one** — the next phone presents at a
  rate nobody listed, and it would also mean promoting on evidence gathered while the panel was
  idled down, which "not evidence in either direction" forbids. So `hasHeadroom` stopped reading
  `frameMs` entirely:

  > **`cpuMs.median <= promoteTargetMs * PROMOTION_TARGET_SHARE`** — would our own work fit in the
  > frame the tier ABOVE is asking for, at half of it.

  - **The NEXT tier's target, not the current one**, and the difference is the bug it prevents: a
    `low` device on a 30 fps cap has a roomy 33.3 ms frame, so judging by its own frame would call
    12 ms of CPU idle and promote it into a 60 fps tier it cannot hold. Resolved in the caller
    (`promotionTargetFrameMs`) through `resolveTierOverrides`, the one resolution point, so a tier
    that authored no `targetFps` inherits the project's exactly as the live frame cap would; an
    uncapped tier stands in `ASSUMED_UNCAPPED_FPS` (60) rather than "whatever the display gives",
    which would make the bar trivial to clear.
  - **HALF, not "does it fit"** (owner: *"let's go half then"*). The higher tier ADDS cost, so a
    device that only just fits would be promoted into a frame it no longer fits. More sharply: the
    promote bar must stay clear of the demote bar or the two overlap — at `targetFps: 60`,
    promoting at 15 ms of CPU would immediately re-qualify as full (14 ms), and `demoted` is
    sticky, so the device would land **below** where it started, permanently. 8.3 ms to promote
    against 14 ms to demote. A property test asserts the gap over both targets, so a later tweak to
    either constant fails in CI rather than on a phone.
  - ⚠️ **BUT PROMOTION IS ALSO FLOORED ON `!overBudget`, and leaving that out was a real hole** —
    caught in close-out the same day, before it shipped. A CPU-only rule cannot see a GPU-bound
    frame; `promotionCeiling` says exactly that ("a CPU streak cannot see a GPU-bound frame") and
    is allowed to ignore it only where the GPU axis already cleared the band above. Nothing granted
    `hasHeadroom` that cover, and the old `frameMs <= 16.67 ms` branch had been carrying it by
    accident. The scenario is ordinary rather than exotic, because the Android GPU allowlist ships
    EMPTY and `calibrating` is the normal state there: a device boots `low` with a ceiling of
    `mid`, sits GPU-bound at ~100 ms frames with 5 ms of CPU, clears the 8.3 ms bar and is promoted
    into a tier that renders it slower — and it cannot come back, because `frameIsFull` reads that
    same idle CPU and refuses to demote. One-way, and in the direction that hurts.

    **Missing the budget you already have is disqualifying regardless of why.** That restores the
    floor without reintroducing an interval THRESHOLD (the thing that made 24 Hz look slow):
    `overBudget` is judged against the cap in force, so a device comfortably meeting its own target
    passes, and one that is not has no business being handed more work.
  - **A useful consequence: the two decisions are now mutually exclusive by construction** —
    promotion requires `!overBudget`, demotion requires `overBudget`. The old "both can be true,
    demotion wins because its hold is shorter" ordering rule is dead, and the situation it ordered
    can no longer arise. A property test sweeps 90 profiles (frame × cpu × budget) asserting no
    profile qualifies for both, which is the kind of claim a single fixture cannot make.
  - **`vsyncBound` is now unread by either decision.** It survives as a profiler field (the debug
    Profiler tab shows it, and `getRestBreakdown` still contrasts itself with it); nothing in the
    tier policy consults it, and `VSYNC_INTERVALS_MS`' incompleteness is therefore no longer
    load-bearing for anything.

  ✅ **The overlay spinner survives the stall — measured, not inferred.** The mid-play promotion
  path covers a shader recompile with `LoadingOverlay`'s spinner, which only works if a
  compositor-driven `transform` animation keeps running while the main thread is blocked. On the
  A23's WebView, the same spinner CSS under a **6.03 s synchronous WebGL compile+link storm (367
  programs)** kept rotating across all **10 captured frames inside the block**, at the same
  per-frame pixel delta as the 8 frames before it. Captured with `adb exec-out screencap`, which
  reads the NATIVE framebuffer and therefore cannot be fooled by the blocked webview thread — a
  webview-side capture would have proved nothing. ⚠️ The progress-bar variant animates
  `margin-left` (main-thread layout) and would freeze mid-slide; this path must stay on the spinner.

  📌 **This re-reads an earlier observation in this file.** The native-build note above records the
  A23 booting `mid` from a cached verdict, hitting a 92.6 ms frame *during load*, and demoting to
  `low` — written up at the time as "the demotion ladder firing on real hardware, unprompted." It
  was the ladder firing, and it was also this defect. The same log line is evidence for both
  readings; only the timing relative to the load separates them.

- ⭐ **PROMOTION MAY NOT EXCEED THE TIER THE DEVICE WAS ASSESSED AT** (`promotionCeiling`, #188).
  The headroom rule above reads `cpuMs` and nothing else, and that proxy is wrong in both
  directions on the hardware this exists for: on an A23, `games/3d-test` runs the GPU at **13.9 of
  every 16.6 ms** with `presentIdleMs: 0` while the CPU reads as idle. No live signal fixes it
  there — `frameMs` is pinned, `restMs` mixes GPU with idle, and GPU timestamps are `unsupported`
  on WebGL2 mobile. What *can* see GPU cost is the boot ramp probe's `shade` axis, so once
  something has assessed the device that assessment is the cap:

  | assessed by | promotion may reach |
  |---|---|
  | `measured` (the probe's band) · `model` (iOS table) · `allowlist` · `desktop` | exactly that tier |
  | `measured` **and `cpuLimited`** — the probe missed the next band on the cpu axis ALONE | **one rung** |
  | `project` (a human decided; calibration already refuses to run) | exactly that tier |
  | `calibrating` — **nothing** assessed it | **one rung**, never further |

  ⭐ **The `cpuLimited` row is the only crack in "a measurement is the cap", and it exists because
  the boot cpu reading is a MEASURED under-estimate** (#205, owner 2026-08-13): across three
  Androids a device reads 20-30% lower at boot than the same device sustains in game, because the
  probe runs while the launch boost is decaying — and nothing inside the probe closes that (two
  fixes were built and refuted; see `CPU_WARMUP_RAMPS`). Rather than inflate the floors, the boot
  reading is accepted as deliberately low and the correction moved to the live path.

  ✅ **The whole round trip is verified on a Galaxy S22** (2026-08-13): `mid via measured —
  cpu-limited`, a 5 s headroom streak, then `switched to 'high' — cpu 6.4ms of a 16.7ms frame
  sustained for 5s (applied at a scene boundary)`. ⚠️ Note what the same phone does on the *heavier*
  scene: `cpu 6.8 ms` of a `16.7 ms` frame against a bar that was then `interval × 0.4` =
  **6.68 ms** — declining by 0.12 ms. The ceiling being raised does not mean a device climbs; on
  content that already spends ~41% of the frame on CPU the headroom rule is the binding constraint.
  (That measurement predates the 2026-08-20 rewrite: the bar is now half the frame the NEXT tier
  targets, so the same reading would be judged against 8.33 ms and would climb. The point it
  illustrates — that headroom, not the ceiling, is usually what binds — is unchanged.)

  It is set **only** when the reading cleared the next band's GPU floor and missed its cpu floor,
  which is what keeps the objection above intact: there is no GPU verdict being overruled, and
  `hasHeadroom` measures exactly the quantity that was under-read. A device short on `shade` is not
  `cpuLimited` and does not move. On the **2D** table it can only ever apply to `weak → middle`,
  since both bands share a cpu floor of 4,500. On a cached verdict it is **recomputed from the
  stored samples**, never persisted — a stored derived field would outlive the thresholds it came
  from.

  ⚠️ **A `player` pin never becomes an assessment at all (#208).** A pin persists in `PlayerPrefs`,
  so the next launch boots straight into `{source:'player'}` and the probe never runs — and that
  resolution used to latch as *the assessment*. Switching back to "Auto" then re-resolved the
  active tier correctly and left the ceiling pinned at whatever the player had picked, for the
  whole process. `setActiveQualityTier` now skips `player` when latching, so the assessment stays
  the device's (or `null` — honestly "nothing measured it this launch") and the first non-player
  resolution after the pin clears latches normally. Nothing is lost: calibration already
  early-returns while a pin is in force, so the ceiling is not consulted then anyway.

  ⚠️ The consequence is deliberate: **on a device the probe classified as anything but
  `cpuLimited`, live promotion is a no-op.** That is the probe's job done, not a mechanism gone missing. The one rung for an
  unassessed device is what stops `auto` pinning unrecognised hardware to `low` forever (#155's
  stated cost) without ever reaching `high` on something nobody measured. A project that knows it
  is cheap enough to outrun its band pins `qualityTier: 'high'`; a player who can see the screen
  overrides everything (below). **Demotion is untouched** — live, immediate, sticky.

  The cap reads `getAssessedQualityTier()`, which holds the session's FIRST resolution, not
  `getActiveQualityTier()`. Every live change republishes with `source: 'measured'`, so the active
  resolution asserts a measurement on devices nothing ever measured, and the original source is
  gone from the second call onward. The two happen to agree today (`'measured'` caps at its own
  tier) — verified by perturbing the call and watching every test stay green — so the honest test
  is that the *assessment survives*, which is what `tierCalibration.test.ts` pins.
- **A capped device says so, once per session**: `TierDecision` has a third action, `hold`, for
  "sustained headroom, and the assessment caps it". Without it a device that held five seconds of
  headroom and did not move is indistinguishable from one whose streak never started, and "why is
  my A23 not promoting" has no answer short of an eval.

**Seeing it:** the resolved tier, its `source`, and a one-line `reason` appear in `diagnose` and in
the debug menu's **Device tab**, which also has one button per tier (driven off `TIER_ORDER`, so a
new tier appears there automatically) applying it LIVE, so a low-end look can be authored without
owning the phone. The reason is the point — "low" alone is
unexplainable, and project-pinned / failed-calibration / player-chosen want different responses.

**The Device tab's "Backing resolution" row can drive `pixelRatioCap` ABOVE the active tier's
ceiling** (2026-08-19), through a debug-only override channel in `renderSettings.ts`
(`setDebugPixelRatioCapOverride`, per-surface `number | null`) that
`getEffectivePixiSettings`/`getEffectiveThreeSettings` honour by skipping the tier clamp for that
one field. Every other tier-governed knob keeps flowing through the tier, and the clamp on a
*project's authored config* is untouched — this is an escape hatch for the panel, not a hole in the
low-end protection.

Why it had to exist: the row wrote the AUTHORED value and the tier clamped it straight back, so on
any device below `high` a pick changed nothing you could see — measured on an iPhone 8 (tier `mid`,
`pixiPixelRatioCap: 1`), where tapping "3" gave authored 3, effective 1 and a canvas that stayed
375×667. The row exists to A/B backing resolution on exactly that hardware, so it read as broken on
the only devices it was for.

Three properties worth knowing, all deliberate:
- **`Auto`**, at the head of each row, clears the override and hands the surface back to the tier —
  without it you could go above the ceiling but never compare against the tier again without
  relaunching, which is the other half of an A/B.
- **The override SURVIVES a live tier change** (owner's call, 2026-08-19): an explicit QA override
  outranks a calibration demotion, which goes on dropping shadows and post-FX around it.
- **`0` means UNCAPPED, `null` means "no override"** — they are different states, which is why the
  channel is `number | null` and not a bare number. The row's "Off" button IS `0`.

It is non-persistent (no PlayerPrefs, no `project.config.json`), like the tier-preview buttons
beside it. `runtime/index.ts` exports the setter so an agent can drive it from `device_eval`, and
a change made that way notifies the panel — a debug surface silently disagreeing with the renderer
is the false-success class the panel exists to prevent. What the row's marks and caption mean lives
in `capRowMarks.ts` (pure, tested).

**iOS answers from the MODEL ID and never measures** (owner, 2026-08-09) — `TierSource: 'model'`,
⚠️ **except that a DEBUG build now measures anyway and throws the verdict away** (#188,
2026-08-11): `resolveActiveTierOnce` runs the ramp probe even when something cheaper decided, gated
on `areDebugHandlesEnabled()` and excluding desktop, and logs it as `EVIDENCE ONLY (tier came from
'<source>')`. The tier is unchanged and a release build is unaffected — it exists because no iPhone
had ever produced a probe reading, so every band boundary was derived from Android while applying to
iOS too. The harness page is not a substitute: measured on the same three phones both ways, it
disagrees with native about the RATIO between devices (S22:A23 on `cpu` is 2.1x native, 13.3x on the
harness), so it is a different instrument rather than a proxy.

via `IOS_TIER_MIN_GENERATION`. Apple's hardware set is small and the generation is *encoded in
the identifier*, so `iPhone10,1` sorts against `iPhone14,6` with no lookup; Android's only
comparable signal is the GPU renderer string, which is ambiguous (one name, two GPUs) and already
deprecated in Firefox for fingerprinting. That is why one platform gets a table and the other has
to measure.

It carries **two floors per family since #188** (`mid` and `high`), and the `mid` one is a
correction: an iPhone 8 (A11) reads 3.9 Mpx/ms + 15.8 calls/ms on the ramp probe — the *middle*
band, which it is one of the two devices defining — so the single-floor table said `low` on a
native build while the same handset on iOS web said `mid` from the probe. Two classifiers, one
phone, two answers. What the A11 measurement actually shows is 27 ms → 56 ms **with NPR**, i.e. it
cannot afford post-FX, which is the knob `mid` turns off; nothing has shown it unable to afford IBL
or shadows at DPR 1. The **iPad row keeps `mid === high` on purpose** — no iPad below A12 has been
measured, so giving it a mid band would invent the kind of number this table exists to avoid, and
iPad behaviour is unchanged.

It is a **threshold (`>= N`), not a list**, and that is the whole point: an enumerated allowlist
ossifies in the *worst* direction — a phone that does not exist yet is absent from it, so next
year's hardware is classified `low` by a table written today. `>=` cannot fail that way, because
newer Apple silicon is only ever faster. The major number is a real SoC boundary rather than a
year: `iPhone10,x` is A11, covering the iPhone 8 **and** the iPhone X, which genuinely share the
chip. Two caveats: the **high** floor for `iPhone` is still inferred (the probe now corroborates it
from an unrelated method — an A12 iPad measures ~2.5× the A11 iPhone, into the `capable` band), the
`iPad` value is a straight guess, and the rule is
**native-only** — mobile Safari reports no model, so iOS *web*, which is how every published demo
ships, stays on the measured path.

The Android allowlist (`TIER_ALLOWLIST`) ships **empty on purpose**: an unvalidated threshold in
code is what ossifies. Measured, a Galaxy A23 does not qualify for `high` — it is `mid`.

#### The boot ramp probe — how a device gets classified (#188)

`rampProbe.ts` (pure policy + maths) + `rampProbeRunner.ts` (renderer side). It runs ONCE per
device, at boot, and the tier it produces does not change mid-play; demotion stays live.

- **Why a probe rather than live stats.** `frameMs` is pinned at the display interval whenever the
  renderer finishes early, so it reports "barely making 60" and "trivially making 60" identically.
  A ramp escapes that by construction: raise the load until the frame is no longer vsync-bound. GPU
  timestamps cannot substitute — they report `unsupported` on WebGL2 without
  `EXT_disjoint_timer_query_webgl2`, i.e. on most of the low-end Android population the tiers exist
  for.
- **Two ramps, because our three profiled projects had three different bottlenecks**: `fill`
  (overlapping quads → fragment throughput, reported in **megapixels/ms** so a small screen cannot
  score as a fast GPU) and `draw` (many tiny quads → per-object submit). **Both** must clear a
  band's floor; the weaker bottleneck is the one a real frame hits.
- **Throughput is a SLOPE between two supra-vsync steps**, never `load / frameMs` at one point —
  that would attribute the fixed per-frame overhead to the load.
- **It resolves to ~3×, and no better.** Vsync rounds every frame to a whole interval, so
  neighbouring slope outputs sit 3× apart (measured on an A23: the draw figure took essentially two
  values, 10.2 and 30.7). The band boundaries sit in the middle of 10× and 2.5× gaps, well outside
  that. Do not chase finer resolution until something needs it.
- **It BLOCKS THE LAUNCH** — necessarily, since `antialias` is baked into the swapchain at renderer
  creation. Measured per pass: **~2.2 s cold on a Huawei Y6** (of which ~1.3 s is cold renderer
  creation), ~0.5-0.8 s on an A23/S22. (A recorded ~5.8 s exists for the Y6's first-EVER launch;
  a re-run on the same phone measured 2.25 s cold, so treat 5.8 s as a first-install worst case,
  not the steady cold path.) The verdict is cached in `PlayerPrefs` against a hardware fingerprint
  (platform, model, GPU renderer string, a coarse viewport bucket **and a classifier version**, so
  re-drawn band boundaries cannot leave already-launched devices pinned to a stale conclusion).
- **The verdict is REFINED ACROSS LAUNCHES, not decided by one pass** (owner, 2026-08-09). One
  pass misclassifies by a band about **1 run in 5** — measured on three attached devices, five
  passes each: Y6 `weak`×4 + `middle`×1, A23 `middle`×4 + `weak`×1, S22 `capable`×4 + `middle`×1 —
  and the original design cached that one pass for the life of the device. (The "bands are 10×
  apart" argument compared band *medians* to a per-reading error bar; a single pass is exposed to
  the *within-device* spread, which measured 2.3–4.5×.) So the cache now persists the raw
  **readings**, not just the band — a band cannot be averaged, and a vote over bands throws away
  how close each pass came to a boundary. Three rules:
  - **`PROBE_SAMPLE_TARGET` = 3**, checked exhaustively against those runs: every one of the 10
    possible 3-subsets per device gives the right band (30/30). Two fails 3 of 10 on the S22 (a
    median of two is their mean). Five buys nothing three did not.
  - ⚠️ ~~**One pass settles it if the reading is `PROBE_CLEAR_MARGIN` (1.5×) clear of every
    boundary**~~ — **REMOVED 2026-08-11. Every device now pays all three launches.** The shortcut
    was sound only if the per-launch spread was inside the margin, and it is not: the A23's `shade`
    axis spans 0.055–0.16 and OVERLAPS the iPhone 7's 0.03–0.07, so a single reading cannot separate
    a mid-band phone from a weak one at any margin. Worse, the A23 has produced a pass 1.5× clear
    BELOW the `middle` floor on real hardware — under this rule that cached `weak` on that phone for
    the life of the device. The cost of removing it is two extra probe launches on hardware that
    used to settle early, the slowest included; a launch is recoverable and a cached wrong verdict
    is not.
  - **While refining, the reported band is the LOWEST sample's; only the settled verdict is the
    median.** Same asymmetry as everything else here — booting a weak device high is a lost context
    (#156), booting a capable device low is a beat of ugliness the next launch corrects. In
    practice an S22 sits at `mid` for two launches and earns `high` on the third, and a Y6 that
    draws its one bad pass first spends *one* launch on `mid` instead of forever.

  ⚠️ The honest cost of this choice: no launch pays more than one probe, but the **first up-to-3
  launches each pay one** where previously only the first did. A pre-refinement cached record has
  no `samples` and is rejected on read, so an already-launched device re-probes — deliberately.

  "No launch pays more than one" is enforced by `shareTierResolution` (`probeReentrancy.ts`), and
  it is a *different* guard from the recursion flag beside it: that one stops a call arriving from
  INSIDE the probe, this one stops two surfaces arriving from outside it in the same tick, before
  either has set the flag. Both would otherwise clear every early-out and probe — and since the
  verdict refines, both would read the same prior samples and the second write would discard the
  first's reading, so the device pays two probes and banks one sample. ⚠️ The recursion check must
  stay ABOVE the coalescer: a re-entrant call handed to it would await the promise waiting for it.
- **The measured bands**, medians of `escaped`/`measured` readings only — a `budget`/`ceiling` row
  is a lower bound, not a measurement, and mixing the two produced two wrong answers in this
  workstream:

  ⚠️ **The AXES CHANGED on 2026-08-11 — the bands are `cpu` and `shade`, not `fill` and `draw`.**
  `fill` never measured fill: it stacks coplanar OPAQUE quads, and a tile-based GPU resolves which
  fragment survives BEFORE shading, so the overdraw never reaches a shader and what was ranked was
  rasterization. `draw` produced no usable reading at all on the two weakest devices (Y6 0/6
  launches, iPhone 7 0/3) — it failed on exactly the hardware the tier system exists for. Both are
  still measured and logged; neither votes. `CLASSIFIER_VERSION` is 4 so no verdict survives the
  change.

  | band | devices | cpu k xform/ms | shade Mfrag/ms | tier |
  |---|---|---|---|---|
  | `weak` | Huawei Y6 2019 · iPhone 7 (A10) | 2.0 · 5.5 | 0.02 · 0.03 | `low` |
  | `middle` | Galaxy A23 5G · iPhone 8 (A11) | 9.9 · 10.9 | 0.13 · 0.20 | `mid` |
  | `capable` | Galaxy S22 · iPhone Air | 21.3 · 37.4 | 0.21 · 0.20 | `high` |

  Boundaries at the geometric mean of each gap: `middle` 4500 / 0.06, `capable` 14500 / 0.165.
  Each band mixes vendors and platforms — the A23 and the iPhone 8 land on top of each other from
  opposite ecosystems, on measurement alone, and the probe never sees a model id.

  ⭐ **The two axes are COMPLEMENTARY, and requiring BOTH is load-bearing.** `cpu` is monotone over
  the whole range; `shade` separates the bottom 4-6x and then SATURATES at the top, where the
  iPhone 8, S22 and iPhone Air all read 0.20-0.21 across several times the real performance. The
  case that proves it is the **iPhone 7**: it clears the middle `cpu` floor (5.5k against 4500) and
  fails the middle `shade` floor (0.03 against 0.06), so a cpu-only classifier would call a 2016
  phone `middle`.

  ⚠️ An **iPad mini 5** measured `cpu` 7.9k and is deliberately absent: its shade ramp sits on a
  ~27 ms fixed floor (largest buffer here, on the WebGL2 fence path), yielding one or two real
  points and no trustworthy slope. A large-buffer WebGL2 tablet is the one device shape this
  instrument still cannot read.
- **`'unknown'` is not a fourth band.** It means the probe did not run or produced nothing usable,
  lands on `low` like `weak` does, and is never cached — but the `reason` distinguishes them, or an
  inert probe would be indistinguishable from one that ran and said no.
- **The measurement harness**: `node engine/tools/ramp-probe-page/build.mjs --serve` builds a
  standalone page on `0.0.0.0:8899`. Android can be driven over USB end to end
  (`adb reverse tcp:8899 tcp:8899`, then an `am start` at `?auto=<label>&runs=8`); iOS needs a human
  to open the URL. ⚠️ **Space the runs out — the probe heats the device it measures.** Twenty
  stacked runs took an iPhone 8 to 30 Hz, at which point every threshold doubled, nothing escaped,
  and ten runs returned beautifully consistent numbers that were pure artifact.

#### The CPU axis — boot vs in-game, and why more passes cannot fix it (#205)

Two rounds of the boot-vs-in-game A/B were run on 2026-08-13 — three Androids, `games/sling`,
five boot launches (`pm clear` before each) against five in-game runs from the debug menu's
`Re-run probe (idle)` button. **v6** is the single-pass cpu ramp; **v7** discards a warm-up pass,
as the GPU ramps have since done. cpu, k xform/ms, median (spread):

| device | v6 boot | v6 in-game | v7 boot | v7 in-game |
|---|---|---|---|---|
| **Huawei Y6** | 1.9 (1.18x) | 2.0 (1.44x) | 1.7 (1.83x) | **2.1 (1.10x)** |
| **Galaxy A23** | 7.7 (2.1x) | 3.8 (1.4x) | 8.7 (1.38x) | **12.1 (1.17x)** |
| **Galaxy S22** | 18.2 (3.5x) | 19.3 (2.4x) | 20.2 (1.98x) | **23.8 (1.05x)** |

⛔ **The v6 conclusion is RETRACTED — it was an instrument artifact, and it is written up here only
so nobody re-derives it.** v6 said "the A23 reads 2x higher at boot than in game", i.e. a
device-dependent bias in the unsafe direction. Wrong: v6 ran one cpu pass, so its *in-game* reading
caught a CPU that had settled low and never climbed. Under v7 the same A23 reads 12.1 in game
rather than 3.8 — and the old in-game number reappears exactly as v7's discarded warm-up pass
(3.5-4.8k), which is what makes this a diagnosis rather than a coincidence.

- **In game, all three spreads collapse to 1.05-1.17x** and the ordering is clean and wide: Y6
  2.1 < A23 12.1 < S22 23.8. The axis has never looked like this before.
- **The gain is asymmetric, which is what identifies the governor** — in game the A23 gains ~3.1x
  over its own warm-up pass, the S22 ~1.2x, the Y6 ~1.0x. A device already at its ceiling gains
  nothing, the same signature the shade discard found.
- ⚠️ **Boot is now the WORSE condition, and boot is where the shipped decision is made.** Spread
  1.38-1.98x on the Samsungs, and both read BELOW their in-game figure. At boot the process launch
  has already boosted the CPU, so pass 1 is not cold and the discard has nothing to warm. The Y6's
  boot spread got worse (1.18x -> 1.83x) — small absolute numbers, but stated.
- ⚠️ **A BAND MOVED: the S22 now reads `capable` on 4 of 5 boot launches** (cpu floor 14,500), where
  under v6 it read `middle` on 4 of 5. Not a retune — a consequence of measuring the same phone with
  a warmed instrument. Flagged rather than acted on.

⛔ **TWO FIXES FOR THE BOOT SPREAD HAVE NOW BEEN TRIED ON HARDWARE AND BOTH FAILED. Do not retry
either.**

- **Defer the probe out of boot** — refuted by v6: the in-game spread was then no better than the
  boot spread, and on the Y6 it was wider.
- **Discard a SECOND cpu pass** (owner-directed, 2026-08-13) — built, installed on all three phones,
  measured on the same 5+5 protocol, **reverted**. Median (spread):

  | device | boot ×1 | boot ×2 | in-game ×1 | in-game ×2 |
  |---|---|---|---|---|
  | Huawei Y6 | 1.7 (1.83x) | 2.0 (1.69x) | 2.1 (1.10x) | 2.2 (1.15x) |
  | Galaxy A23 | 8.7 (1.38x) | 9.2 (1.25x) | 12.1 (1.17x) | 9.5 (1.09x) |
  | Galaxy S22 | 20.2 (1.98x) | **19.3 (2.82x)** | 23.8 (1.05x) | 23.2 (1.19x) |

  The S22's boot spread nearly doubled — worse than the single-pass instrument it replaced — and
  its band flipped `middle`/`capable` across the five launches. Everything else moved within noise.

  ⚠️ **The S22 boot ×2 cell is a RE-MEASUREMENT — the first attempt was contaminated.** That run
  (18:17-18:20) overlapped a lease another clone held on the phone (`work-ai`, claimed 18:15:49) and
  read **16.8 (3.56x)**. Re-run 18:58-19:01 with the phone free: **19.3 (2.82x)**, the number in the
  table. The confound was real and it inflated the harm — but the direction is unchanged and now
  measured cleanly, since 2.82x is still materially worse than ×1's 1.98x and the band still flips
  (`middle` on launch 1, `capable` on 2-5). ⭐ **Two cheap lessons: check
  `~/.modoki/device-claims.json` BEFORE a measurement run, and re-measure rather than argue from a
  claim record** — a claim proves a claim, not activity, and the claiming pid was dead by the time
  anyone looked.

  ⭐ **Why it cannot work, and this is the durable part:** the warm-up sequences the log now prints
  show an A23 in-game run reading `warm-up 3.6k->13.4k` and then measuring **9.8k**. Pass 2 peaks,
  pass 3 falls back. **The boost is transient and decays even under continuous load, so more
  sustained work is not monotonically a warmer reading** — which is the assumption every "add
  another pass" variant rests on.

*How the S22 promotion test was staged, so the result is reproducible and its limits are visible:*
two throwaway edits, neither shipped — `gpuIdentityTier` forced `null` (all three phones are in the
GPU table, so the probe path is otherwise unreachable), and the `capable` cpu floor raised to 40,000
so the S22 landed in the cpu-limited state deterministically rather than on a lucky median. The
scene boundaries were driven with `device_load_scene` over the adb lease.

⚠️ **The S22 is the target population and it is not a coincidence.** Its shade sits at ~0.20 against
a `capable` floor of 0.165 while its cpu straddles 14,500 — so the launches where it reads `middle`
are precisely the ones where cpu fell short and shade cleared. The A23 (shade ~0.14) and the Y6
(~0.03) are **shade-limited**, so the licence correctly never applies to them. Which is the honest
scope of this change: it helps devices the cpu axis alone holds down, and on this hardware that is
one phone out of three.

*Honest limit:* "in-game" means **steady-state gameplay with the debug menu open**, not an idle
process — the game loop is running and competing, which is deliberately the condition a tier is
supposed to predict. Neither condition here is a quiescent-CPU reading.

#### W2 — the probe becomes an isolated fallback: what landed (#221)

Owner: *"if probe becomes stable and finishes in ~6 seconds, I think it's great."*

⚠️ **Two earlier items in this plan (delete `capable`; trim the probe to two ramps) were written
before #205/#203 landed and were CONTRADICTED BY MEASUREMENT — struck through rather than deleted,
because a reader who has seen an earlier version of this plan would otherwise reinstate them.**
Both rested on the same premise — that the probe's only remaining job is to separate `weak` from
everything else — and both were overtaken:

- ⛔ ~~"Two bands, not three — `capable` is deleted."~~ **INVALID, confirmed by the owner
  2026-08-13.** `capable` is not deleted; it is *reachable* and *anchored on both tables*. The shade
  axis went monotone once the GPU ramp discarded a warm-up pass, a Galaxy S22 now reaches `capable`
  on the 3D table, and the 2D table's capable floor is a measured 8.5 Mpx/ms with an escaped S22 on
  the far side of it. Collapsing to two bands now would discard both.
- ⚠️ ~~"Trim the instrument — `fill` and `draw` have not voted since 2026-08-11."~~ **HALF right,
  and the half that was right is now DONE.** False of `fill`: it is **the deciding axis of the
  entire 2D probe**, because `pixiPixelRatioCap` is the only GPU knob a 2D tier moves and it is
  fill-rate bound — dropping it would leave every 2D project with no GPU axis at all. True of
  `draw`: ✅ **deleted 2026-08-13 by owner decision.** `gpuKinds` named only `fill` (2D) or `shade`
  (3D), so it had not run since 2026-08-11 and no threshold read it; when it did run it failed
  outright on the weakest hardware (Y6 0/6, iPhone 7 0/3). The ramp and its GL workload are
  recoverable from git if a project ever turns out to be per-object-submit bound — forest-camp
  measured 0.14 ms/call on the Y6, which is the case that would justify it. `CLASSIFIER_VERSION` is
  deliberately NOT bumped: `draw` never entered `ProbeReading`, so no persisted sample and no
  threshold changed meaning.

1. ✅ **Isolation — ALREADY TRUE, verified by reading the boot path 2026-08-13, no work needed.**
   Both doors already run the probe ahead of every asset: a 2D project resolves in `App.tsx`'s
   `GameShell` **before** `setConfigReady(true)` mounts the renderers and before
   `ensureManifestLoaded`/`loadScene`; a 3D project resolves inside `makeWebGPURenderer`, which is
   likewise ahead of the manifest and the scene. The contention this item was written against was
   the **rAF path's** interval estimation (an S22 estimating 125–167 ms against a true 16.8 ms), and
   that path is now the fallback — the GPU-clock path waits on a fence, estimates no interval, and
   uses a nominal 16.7 ms constant. ⚠️ Do not "add isolation"; there is nothing to move.
2. ✅ **Settle within ONE launch — LANDED 2026-08-13 (`tierResolve.ts`), and the naive version was
   REFUTED on hardware first.** `resolveProbeClass` now repeats the whole probe up to
   `PROBE_SAMPLE_TARGET` times inside one launch, bounded by `PROBE_IN_LAUNCH_BUDGET_MS` (2500).
   Measured, one wiped launch per device, `space-invader`:

   | device | passes | per-pass band | settles | blocked launch, total |
   |---|---|---|---|---|
   | Huawei Y6 | 3 | weak · weak · weak | launch 1 | 1602 ms |
   | Galaxy A23 | 3 | middle · middle · middle | launch 1 | 1828 ms |
   | Galaxy S22 | 3 | capable · capable · capable | launch 1 | 1655 ms |

   Launch 2 emits **zero** probe lines on all three — the cache short-circuit still fires ahead of
   the loop.

   ⛔ **The in-launch MEDIAN is wrong and was nearly shipped.** In-launch passes are a **warming
   sequence**, not independent draws: a Y6 read fill `0.94 → 1.17 → 1.36` in one launch, and on
   another `1.37 → 2.11 → 1.69` — an in-launch median of **1.69** against a cross-launch median of
   **1.10**, a 1.5× **upward** bias that lands past the 1.68 `middle` fill floor. Only the cpu floor
   kept that phone out of a band measured at 14 fps on it. Medianing a warm population against
   cold-derived thresholds is the same instrument mistake this workstream has now made three times.

   ⭐ **So the settle rule is UNANIMITY, not the median**: a launch may settle only when every pass
   in it classified the same band anyway — in which case the warming never reached a boundary. When
   the passes disagree, only **cold readings** are persisted with `final: false` — one per launch —
   so a near-boundary device degrades onto the already-measured pre-#221 path rather than onto a new
   one.

   ⚠️ **That degrade path did not exist for eight days: it degraded to NEVER SETTLING (#240, fixed
   2026-08-18).** The in-launch loop is seeded from the cache, so a launch reading a stored sample
   runs *fewer* than three passes by construction — and the in-launch settle demands three passes in
   THIS launch. The store then kept only the newest cold reading, throwing the accumulation away.
   Read 1 sample → run 2 passes → store 1 sample, on every launch for the life of the install.
   Measured on a Galaxy A23 over three launches at ~1.1 s of blocked launch each, its cpu reading
   moving 8977 → 9230 → re-measured and discarded. The devices that pay are the ones the probe
   DECIDES for — an unrecognised/masked/software renderer, and every iOS **web** device, i.e. the
   published demos' mobile-web audience. Fix: cold readings **accumulate** instead of replacing, and
   the `perPass` unanimity conjunct gates the in-launch shortcut only — the CROSS-launch settle
   (three cold readings, medianed, `refineProbeVerdict`'s own rule) is allowed to stand again.
   Verified on the A23 by installing over its stuck record: launch 1 stored 2 samples, launch 2
   stored 3 and `final: true`, launch 3 ran **zero** passes.

   ⚠️ **`PROBE_IN_LAUNCH_BUDGET_MS`'s "a Y6 pass costs ~2 s, so it takes only one" was never true**
   — the table above says 3 passes in 1602 ms on that phone, on the same day the constant was
   written. The figure predated the renderer removal (`8cf61e859`, "600-1700 ms of cold renderer
   creation") and the draw-ramp deletion. Re-measured 2026-08-18 on the Y6: **589 / 478 / 468 ms**,
   1.54 s for three, settling in launch 1; a Galaxy A23 501 / 621 ms. The budget currently stops
   nothing on any device we own.
3. ✅ **Playable ads must never probe — LANDED 2026-08-13** (`core/bootProbeAllowed.ts`, set from
   `main.tsx` as `setBootProbeAllowed(!__MODOKI_PLAYABLE__)`). ⚠️ **"One config ⇒ no probe" covered
   LESS than the item assumed, and the gap was the expensive half:**
   - the single-config short-circuit is a **project's** choice, not the ad format's — it fires only
     when exactly one tier config is authored, and the scaffolder's default (and every project here)
     is two;
   - the **measure-and-log EVIDENCE path never consulted it at all** — a tier answered cheaply by
     GPU identity or the iOS model table still ran the whole probe whenever
     `areDebugHandlesEnabled()`, and **ten projects ship `build.debugBuild: true`**. So the likely
     playable was exactly the one that paid.

   ⚠️ **And the bill had just tripled**: the in-launch settling above took it from ~550 ms to
   **1.6–1.8 s** of blocked launch, in the one build where launch time is the product.

   ⭐ **Verified the probe really was reaching a playable, rather than assuming it.** Grepping
   `games/space-invader/ads/index.html` for `rampProbe` returns **0**, which is meaningless and
   nearly became a wrong conclusion here — the creative's JS payload is compressed + base64, a trap
   [playable-export.md](./playable-export.md) § Gotchas already records ("You cannot `grep` the
   artifact", two false diagnoses before this one). Decompressed, the payload contains `rampProbe`
   ×5, `qualityTier` ×12 and `resolveTierForNo3D` ×4.

   Both guards are mutation-checked (removing either fails a test), and a separate architecture
   guard pins the `main.tsx` wiring, which no unit test can reach — deleting that one line would
   otherwise leave the whole suite green.

#### The 2D probe: sample-gate softening, the fill-ceiling bug, and the v9 re-measure (#221)

- **The probe runs on a raw WebGL2 context** (`rampWorkloadGL.ts`), so `render3d: false` and
  `disable3D` projects can run it. ONE instrument, not two — the Three path is deleted, taking the
  re-entrancy hazard, the leaked-context timeout and 600–1700 ms of cold renderer creation with it.
- ✅ **VERIFIED ON HARDWARE 2026-08-13 — `games/space-invader` on the iPhone Air.** The 2D probe
  ran, on a 2D-only project (`build.modules.render3d: false`), and the device resolved a tier:

  ```
  [rampProbe] EVIDENCE ONLY (tier came from 'model') capable — cpu 43.7k xform/ms,
              fill 24.515Mpx/ms — clears the capable floor on both ramps (median of 3 launches)
  [qualityTier] high via model — iPhone18,4 is iPhone generation 18, at or past the high-tier
              floor of 11
  ```

  The probe AGREES with the model table (`capable` → `high`), which is the first cross-check the
  2D shape has ever had. It is also **cheap**: `blocked launch 264 ms`, against 0.5-2.6 s for the
  3D shape on Android.

  ⚠️ **STILL true, and still the rule: not verifiable in the editor.** The seam is in `App.tsx`'s
  `GameShell`, which the editor does not mount. An attempt to read the live tier through CDP
  returned `null`, and that reading is UNTRUSTWORTHY — the `/@fs/` import produced a second module
  instance (its `tiers` came back `[]`), so it reported a fresh module's state, not the app's.
  **Verify on a device build, or via the web build served at `/`.**

  ⚠️ **iOS console logs do NOT reach `idevicesyslog` or `log stream`** — a WKWebView's
  `console.warn` goes to the debugger, not `os_log`, so 899k syslog lines contained not one probe
  line. What works is `xcrun devicectl device process launch --console --terminate-existing
  <bundleId>`. Recorded because two tools failing silently reads exactly like a probe that never
  ran.

- ✅ **AND IT FOUND SOMETHING — FIXED 2026-08-13 (#221): the fill ramp's CEILING was too low for
  modern hardware.** The Air's fill ramp came back `ceiling/lower` — it exhausted
  `RAMP_BOUNDS.fill.maxLoad` (1024) without escaping, its last step still only 15 ms — so its
  24.5 Mpx/ms was a LOWER BOUND, and so was the Galaxy S22's 7.69. A midpoint computed with one end
  pinned to the instrument's own ceiling is not a midpoint, so the 2D `capable` floor was wrong by
  more than it looked.

- ⭐ **THE 2D FILL AXIS IS RE-MEASURED ON AN UNCLIPPED RAMP (#221, `v9`), AND ONE NUMBER MOVED
  3.4x.** `RAMP_BOUNDS.fill.maxLoad` 1024 → **65536**; `games/space-invader`, debug build,
  `pm clear` before every launch, three launches per device. Median Mpx/ms:

  | device | v5 (ceiling 1024) | v9 (ceiling 65536) | status |
  |---|---|---|---|
  | Huawei Y6 | 1.02 | **1.10** | escaped under both — unchanged |
  | Galaxy A23 | 2.77 | **2.81** | escaped under both — unchanged |
  | Galaxy S22 | 7.69 ⛔ bound | **25.82** | now `escaped/measured` |
  | iPhone Air | 24.5 ⛔ bound | **68.21** | now `escaped/measured` |

  ⭐ **The asymmetry IS the proof.** A ramp ceiling cannot affect a device that never reaches it, so
  the two weak phones moving <5% while the flagship moves 3.4x is exactly the signature of a clipped
  instrument rather than of three phones changing. The S22's spread also *tightened* to 1.19x — its
  old 1.05x was precision about the ceiling, not about the GPU.

  **Consequence: the 2D `capable` floor moved 4.6 → 8.5** (geometric mean of 2.81 and 25.82). The
  `middle` floor stayed at **1.68** deliberately — the v9 pair puts it at 1.76, a 5% move inside the
  Y6's own 0.75–1.12 launch spread, and re-fitting on noise costs the ability to say a threshold
  survived two independent campaigns. **No device tested changes band**; what changed is where an
  unseen device lands, and the move is toward the conservative side.

  ⚠️ **How big a ceiling is enough, and why the first answer was not:** 8192 was tried first and the
  S22 escaped on its VERY LAST STEP (83.9 ms against a 50.1 ms bar) — one device generation from
  being clipped again. The headroom is free because a ramp always ends on the first step past the
  escape bar, so the *last* step costs ~50–100 ms on every device and a faster GPU just spends more
  doublings at the ~4.2 ms GPU-clock latency floor getting there. Measured: the S22's full 11-step
  ramp sums to ~200 ms against a 400 ms budget. **Take the headroom; it is not paid for by anyone.**

  ✅ **The iPhone Air leg is DONE** (three launches, `--console`): 65.37 / 68.21 / 98.06 →
  **68.21**, `escaped/measured`, escape at 8192 / 56 ms. It was 24.5 ⛔ bound before, so 2.8x under.
  The axis is monotone over 62x across four devices and the Air clears `capable` by 8x, which is
  what a top anchor is for — without one the top floor is only ever pinned from below.

  ⚠️ **AND IT PRICED THE CHANGE, WHICH THE ANDROID RUNS COULD NOT: blocked launch 264 ms → 486 ms
  on the Air**, same build, ceiling the only difference. The three added steps cost ~104 ms and the
  discarded warm-up pass renders them again, so the price is ~2x the visible steps. The first
  version of the code comment claimed the headroom was "free" — it is free against
  `GPU_RAMP_BUDGET_MS`, and it is **not** free against launch time, which is the number this work
  exists to cut. Worth paying (the alternative is ranking a fast unrecognised device by the ramp's
  ceiling), and only paid while a device is still refining and never once GPU identity recognises
  it.
  ⭐ The lesson: a change measured only on hardware that escapes EARLY cannot show you what it costs
  the hardware that escapes LATE. The Y6 and A23 both said "free"; only the fastest device tested
  had the steps to pay for.

#### Findings that must not be re-derived

Each cost a session or more.

1. **Opaque overdraw is not a load.** A tile-based GPU resolves which fragment survives BEFORE
   shading, so stacking coplanar opaque quads measures rasterization, not fill. Every mobile GPU is
   tile-based. Blending is what makes overdraw real. This explains three sessions of "fill cannot
   rank these GPUs".
2. **A boundary separates MEDIANS, never readings.** The A23's `shade` spans 0.055–0.16 and
   OVERLAPS the iPhone 7's 0.03–0.07. Any one-pass settle is unsound; `PROBE_CLEAR_MARGIN` was
   removed for this and must not return without new evidence.
3. **Guards written naively defend only the safe direction.** Throughput is `dLoad/dMs`, so an
   anomalously SMALL `dMs` *overstates* — and overstating is what costs a GPU context. Every guard
   written first (`SPIKE_RATIO`, `GROWTH_OVER_FLOOR`) caught only the understating direction; three
   defects lived in that blind spot.
4. **A mechanism that is authored but never read is this repo's dominant defect.** `autoLightCap`
   held the rule, was unit-tested, and was imported by nothing for two months. The tier's light
   limits were authored intent and nothing else. **Verify by PERTURBING an authored value** and
   watching the render follow — a value that coincides with the default cannot tell "read" from
   "ignored".
5. **A tier CLAMPS; it never raises.** `high` is a true no-op (`UNCLAMPED_OVERRIDES` is the
   identity). This is what made tiers safe to wire into every existing project, and it is why a
   wrong `mid`-vs-`high` verdict is cosmetic while a wrong `weak` verdict is a black screen.
6. **The failure directions are not symmetric.** Booting high on weak hardware: one 6,388 ms
   `submit-postfx`, the GPU watchdog kills the context, recovery fails, blank for the process
   lifetime (#156, Huawei Y6). Booting low on strong hardware: a beat of uglier rendering, fixable
   by the player's own setting. Design every fallback toward the second.

#### The measurement protocol — every line was paid for

- **ONE campaign, ONE build, at a time.** Two overlapping campaigns on the same phones voided a
  session's counts.
- **Measure on MORE THAN ONE PROJECT.** All seven original band figures came from one, and that is
  why they do not transfer.
- **Wipe the verdict before every launch** (`adb shell pm clear <pkg>`; on iOS
  `ideviceinstaller uninstall` — NSUserDefaults survives a reinstall). ⚠️ Wiping is right for
  independent readings and blind to the persistence seam; test that separately.
- **Check the phone is awake AND unlocked** — `dumpsys display | grep mScreenState`. A dark or
  locked phone stops rAF and is indistinguishable from a broken build in logcat.
- **Read EVERY device's leg before concluding.** Repeatedly, the leg skipped held the answer.
- **A metronomic reading is a throttle, not contention.** Frame deltas stepping by a whole number of
  the device's own ticks are the scheduler backing off; a busy CPU is never that tidy.
- **iOS quantizes `performance.now()` to 1 ms**, so every iOS step time is a whole number and reads
  as more precise than it is. Real resolution is about ±15%.
- **`setRenderSettings` alone does NOT resize.** The backing buffer follows only once something
  drives the resize bus. **Read the canvas buffer, never the setting**, when asking what is on
  screen.
- ⚠️ **Neither `modoki_capture_viewport` nor `device_screenshot` forces a render.** `capture_viewport`
  is `webContents.capturePage()`, a screenshot of the window; the iOS device capture is
  `window.drawHierarchy(in:afterScreenUpdates: false)`, which *explicitly* declines to flush pending
  updates, and `adb screencap` reads the already-composited buffer. **An unchanged capture is
  therefore not evidence that a change failed to render.** Whether a capture can be STALE is a
  property of the SURFACE, not of the capture call: a shipped game renders continuously via rAF, so
  a device screenshot is current — but the editor SceneView is render-on-demand, and there
  successive captures come back byte-identical straight through a real change until something arms
  its dirty gate (measured 2026-08-18: painting a visible material red, three identical captures
  until a camera move). To force a frame use `modoki_render_scene` (a genuine offscreen render,
  Game panel only) or move the camera; for the true framebuffer use CDP `Page.captureScreenshot`.
  The corollary: if a device surface ever goes on-demand, the same trap arrives with it.
- **Tooling**: Android over `adb`; iOS 15/16 via `libimobiledevice`, iOS 17+ via `xcrun devicectl`.

#### More reference measurements

**A TRUE release build cannot afford `mid.pixelRatioCap: 1.875` — it is far past a cliff, not near
one.** The DPR ladder above (`sling` on an A23) was measured on a DEBUG build carrying ~10.5 ms of
CPU, which left open the possibility that a release build's extra margin could afford more. Both
halves of that doubt failed:

1. **The ~10 ms is NOT debug overhead.** Measured on an Android **release-build-type** APK (bridge
   still compiled in, so the profiler could be read): `cpuMs` median **10.0 ms** at DPR 1, **10.0**
   at 1.5, **10.8** at 1.875 — flat across the DPR ladder and identical to the debug figure. That
   CPU is the game and engine, not the build type. DPR is a GPU knob and the ladder confirms it:
   `restMs` 6.7 → 6.5 → 8.3, and only the 1.875 row misses vsync (frame 20.0 ms, 50 fps).
2. **A TRUE release build cannot afford 1.875 either — it is far past a cliff, not near one.**
   `debugBuild: false` (no bridge at all), so measured from OUTSIDE the app with
   `adb shell dumpsys gfxinfo <pkg>`, two builds differing only in `mid.pixelRatioCap`:

   | `mid.pixelRatioCap` | device DPR | buffer | p50 | p90 | janky | Missed Vsync |
   |---|---|---|---|---|---|---|
   | **1.5** | 1.5 | 0.69 Mpx | **26 ms** | 34 ms | 35.8% | **0** |
   | 2 | 1.875 | 1.08 Mpx | **53 ms** | 73 ms | 98.0% | 145 |

   A 1.56x pixel increase doubles the frame — superlinear, and the `Missed Vsync` count goes 0 →
   145. **1.5 is the right cap on this band; it was never conservative.**

⚠️ **`gfxinfo` absolutes are not the in-app frame time** (26 ms against the profiler's 16.7 ms at the
same cap) — it counts UI-thread/compositing work the engine's own profiler does not. Read the
DELTA between two builds on one instrument, never the level. It is still the only instrument that
works with no bridge compiled in, which is what "release" means here.

⚠️ Two method notes worth keeping: a release APK needs signing to install (debug keystore via
`apksigner` is fine for a perf test), and `gradlew` needs `JAVA_HOME=/opt/homebrew/opt/openjdk@21`
on this Mac — the default JDK 25 fails with `Unsupported class file major version 69`.

**Physics substepping costs less than assumed** — A23, `sling`, `frame/ecs/physics3D` selfMs:
0.9 ms at `mid` (60 fps, one substep) → 1.4 ms at `low` (30 fps, two substeps). Not 2×, and per
*second* the cost falls: 54 ms/s → 42 ms/s.

### GPU context loss is recoverable — and bring-up must stay self-contained

A lost GPU context used to be **permanent**: detected, logged, nothing rendered again for the
process lifetime. That is how a Huawei Y6 2019 died ~4 s into boot with `games/sling` (#121 P1).

**A lost three renderer cannot be revived.** `WebGLBackend` already calls `preventDefault()` on
`webglcontextlost` (so the browser *will* restore the underlying context) and routes to
`renderer.onDeviceLost()`, which sets a private `_isDeviceLost` that gates `render()` and is never
cleared anywhere in three. So recovery means **building a new renderer**, not restoring one.

Detection and policy live in `runtime/core/activeRenderer.ts` — one funnel for both backends, a
sliding budget (`MAX_RECOVERY_ATTEMPTS` in `RECOVERY_WINDOW_MS`), then abandon loudly. It
*asks*; it cannot rebuild. Viewports subscribe via `onRendererLost` and rebuild themselves.
Scheduling (defer out of the loss event, one rebuild at a time, coalesce a loss that lands
mid-rebuild) is `rendering/rendererRecovery.ts`.

**A rebuild that REJECTS is now retried (#156), not dropped.** It used to be reported and abandoned,
which was terminal by construction: the only thing that can ask for another attempt is a further
`onRendererLost`, and once a rebuild has failed there is no live renderer left to lose — so that
event can never arrive. `rendererRecovery.ts` now retries bring-up itself, bounded by
`DEFAULT_MAX_REBUILD_ATTEMPTS` (3) with a doubling backoff (250ms, then 500ms, then 1000ms) on the
theory that a rejection moments after a loss usually means the driver is still resetting. **This is
a separate budget from `activeRenderer`'s `MAX_RECOVERY_ATTEMPTS`** — that one counts context
*losses*; this one counts bring-up *rejections* — and the two must not be conflated. `onError` now
receives `(e, { description, attempt, willRetry })` so a viewport can say "retrying" instead of
announcing a permanent black screen a retry may be about to disprove. `description` comes from the
new exported `describeRebuildFailure`: the observed symptom was a rejection logging as `{}`, and the
device console capture already special-cases `instanceof Error` (it would have sent the stack), so
an empty `{}` proves the rejection was a non-Error object with no enumerable properties, not a
serialization bug. Evidence for the retry: a Huawei Y6 2019 lost its context **during boot** (every
prior validation here was steady-state loss on a settled scene) and, without the retry, stayed blank
for the process lifetime.

**THE INVARIANT: a viewport's bring-up must stay self-contained.** Recovery works because
everything built against the renderer — scene, cameras, render state, particles, the post-FX
stack, the frame callback, and the capture/bounds/broker registrations — is created inside one
bring-up closure and torn down by one cleanup, so a rebuild is `teardown(); bringUp();` and
re-points nothing. Hoist anything renderer-touching *out* of that closure and recovery silently
breaks. Three consequences that are easy to get wrong:

- **Teardown runs against a DEAD context**, so every step is individually guarded. Unguarded, one
  throw skips the rest and the rebuild double-registers on top of the leftovers.
- **`RendererLostInfo.renderer` says WHICH renderer died** — the notification is a broadcast and
  the editor mounts two viewports. Compare by identity and ignore a loss that is not yours, or you
  tear down a healthy renderer in sympathy.
- **A render-on-demand viewport must be re-marked dirty after a rebuild**, or it completes
  recovery and stays black until the user nudges the camera — indistinguishable from failure.
  `SceneView`'s dirty gate is created at mount, so a rebuild inherits it already spent.

**It is a re-UPLOAD, not a re-download.** Bring-up never calls `loadScene`; it rebuilds the three
objects from the ECS world through the scene-scoped caches (the same path a world swap uses), so
the cached `BufferGeometry`/`Texture` objects simply re-upload to the new device. Measured: after
a rebuild the new renderer drew the real scene at 68 draw calls / 137,443 triangles with 41
geometries + 39 textures resident on it.

**Recovery is a visible hitch, not seamless** — shader prewarm re-runs. Measured **~316 ms**
(iPhone 8 / WebGL2) and **~235 ms** (Galaxy A23). That is the honest cost behind the `warn` log's
"expect a visible hitch", and it is the right trade against a permanently black surface.

**Testing it:** on a WebGL backend, `canvas.getContext('webgl2').getExtension('WEBGL_lose_context')
.loseContext()` produces a genuinely dead context. On a **WebGPU** backend you cannot easily force
one — the only way to kill the device is `device.destroy()`, and that reports
`reason: 'destroyed'`, which the detection layer deliberately filters as orderly teardown. So a
WebGPU device is best exercised by dispatching a synthetic `webglcontextlost` on the canvas, which
drives the same rebuild path but is not a real loss.

⚠️ **Do not "simplify" the two detection paths into three's single `renderer.onDeviceLost(info)`
hook without preserving the false-positive filters.** Unifying them is a real and worthwhile
simplification, but those two filters (superseded-renderer, and `reason === 'destroyed'`) were
paid for by shipping a diagnostic that declared a healthy 61 fps editor dead. They are the
acceptance criteria for any such refactor.

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
To **report** it (a label, a caps payload, a HUD), call **`readRendererBackend(renderer)`**
(`runtime/core/activeRenderer.ts`), the single place that decides — `deviceCaps.backend` and the
profiler's `readRenderer` both go through it, so the two labels cannot disagree. Both derived it
from the class flag independently until #147, and both were therefore unable to report `'WebGL'`
at all: an iPhone 8 with no adapter reported `backend: 'WebGPU'` next to `webgpu: false` in the
same payload. `Scene3D.tsx` reads `isWebGLBackend` directly because it is *branching* (planning
FXAA away), not labelling — that stays correct, and its `isWebGPU` gate is deliberately the CLASS,
since the post-FX stack needs the node pipeline, which runs on both backends.

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

**Fix:** `Scene3D.tsx` calls `prewarmShadersForWorld(getCurrentWorld(), renderer, camera)` on mount, **before** registering the render loop, so a normal material compiles first and primes the node builder. (`prewarmShadersForWorld` also mirrors the world's lights and environment so it compiles the correct PBR shader variants, eliminating first-frame stutter on scene swap. The mirror is TIER-SHAPED on both counts — IBL and shadow arming each follow what the resolved tier will actually draw, because compiling a variant the render never uses leaves the real one to the first frame, which IS the stutter. See [plans/profiler.md](./plans/profiler.md) § Phase 2 for the measurement that established this, #238.)

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

> **An entity that routes to NO Canvas2D is warned about, once, and the warning FORGETS a recovery** (QA-ASSET-0014). Scene2D skips a visible `Renderable2D` with no canvas ancestor, so a 2D prefab instantiated at the world root (`modoki_prefab`'s own default parent) came back `ok:true` and then reported `screen:null` with nothing said anywhere; `Scene2D` now warns once per entity and `modoki_prefab` answers in its own response via `findUnrenderable2D`. The bookkeeping lives in `canvas2DRouting.ts` `Orphan2DTracker`, not inline in the component, and it holds two properties that both regressed silently while inline: it **drops an entity's warned key when the entity finds a canvas**, so parenting an orphan under the host and back out again warns a *second* time (a warn-once registry over a recoverable condition has to forget, or the second break is the silent one — the same gap `resolveRefWarnOnce` had, QA-ASSET-0005); and the guid lookup that forms the key is a **callback**, invoked only on the frame an entity crosses the threshold or recovers, never for the healthy entities that make up the scene — `clear()` runs per drawn 2D entity per frame, so an eager key would put a trait read on the hot path.

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

Rule: every client↔canvas-px conversion goes through the ONE shared helper in `canvas2DScaler.ts`; nothing re-derives the fit transform by hand. `clientToCanvasPx` is factored out of `screenToReference2D` precisely so bounds reporting shares the identical half, and `referenceToScreen2D` (design→client, the inverse an agent needs to AIM at a design-space point) shares `canvasPxToClient` with `bounds2DProvider` in `Scene2D.tsx`. The point is that both directions and the bounds report agree **by construction rather than by re-derivation**. `clientToDesign2D` / `designToClient2D` are the one-call convenience pair so game code never hand-rolls the fit-mode math either.

Why it is a rule and not a preference: a divergent re-derivation WAS the coordinate-space bug behind Court's 2D drag-aim misses, and a hand-rolled copy is exactly what silently drifts from the engine the day the `Canvas2D` trait is edited — the copy keeps compiling and keeps returning plausible coordinates, so the drift surfaces as an aim that is subtly wrong rather than as a failure. `computeCanvasScale`'s container transform and PixiJS `getBounds()` both operate in canvas rendering-space px. Keeping that equal to the backing pixel size is a deliberate, load-bearing choice, not a coincidence: `canvas2DPool.ts` **never** passes `resolution`/`autoDensity` to Pixi, pinning it at resolution 1, and folds a project's `resolution` setting into `computeBackingSize` (`canvas2DSizing.ts`) instead. Were Pixi given its own resolution, the two spaces would diverge and every hand-rolled conversion would be wrong by that factor — so the pinning and the single shared helper are the same invariant seen from two sides.

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
- **Sampling the sprite bitmap.** The material Mesh samples the entity's OWN `Renderable2D.sprite` as `uTexture` (`resolveMaterialTexture` resolves the GUID and loads it through the shared `spriteTextureRefs` refcount, exactly like the sprite pass — retained on build, released in `disposeSlot`). While the texture loads — or when the entity has no image sprite (a purely procedural shader like `gradient-scroll`) — it falls back to `Texture.WHITE`; the resolved url is part of the slot's rebuild signature (`matSig`), so the Mesh re-mints with the real bitmap the frame it becomes resident. A texture is only bound once its `source` is live (a cached-but-mid-decode/stale texture would otherwise crash the shader on `source.style`). Example: `games/3d-test/.../shaders/dissolve.{shader.json,wgsl,glsl}` (samples `uTexture`, burns it away by a hashed-noise `uThreshold`), driven by a MaterialInstance `time` curve — demo scene `games/3d-test/.../scenes/2d-material-demo.scene.json`. An **atlas slice** (a `resolved.frame`) binds a per-slot framed WRAPPER Texture whose uv matrix (`uTextureMatrix` = the texture's `mapCoord`) maps the quad's 0..1 UVs into the sub-rect, so the shader samples the right pixels (a whole image borrows the base texture, identity matrix); the wrapper is `destroy(false)`d in `disposeSlot` (source kept for the refcount). `matSig` carries the sprite REF so a frame swap on one sheet forces a rebuild. `vUV` is therefore texture-space (0..1 whole, sub-rect for a slice).
- **Extra samplers (`texture` params).** A shader can declare `texture`-typed params — each becomes an ADDITIONAL sampler beyond the entity's own `uTexture`. A texture param's VALUE is its manifest `default` (a sprite GUID) OR a per-instance `MaterialInstance` override with `kind:'texture'` + a `ref` on that target (a STATIC swap — MaterialInstance *sources* drive only scalar uniforms, so a texture ref isn't animated; `readTextureOverrides` collects them, the override wins over the default, and the resolved url is in `matSig` so an inspector edit rebuilds the Mesh with the new texture). Scene2D resolves each WHOLE-image through the same `spriteTextureRefs` refcount + KTX2/WebP variant seam as the sprite (`resolveMaterialTexture(ref, wholeOnly)`), retains each url on build (stored in `slot.materialTexUrls`), releases them in `disposeSlot`, and binds them in `makePixiShaderInstance`. An unresolved extra texture binds `Texture.WHITE` (WebGPU needs every declared group-3 binding present) and `matSig`'s `extraSig` forces exactly one rebuild when it lands. **WGSL binding:** the custom bit declares extra textures in `@group(3)` at binding `1+2i` (texture) / `2+2i` (`<key>Smp` sampler) — binding 0 stays reserved for `matUniforms` — so a texture param `uFoo` is sampled `textureSample(uFoo, uFooSmp, vUV)` (WGSL) or `texture(uFoo, vUV)` (GLSL). Extra textures are whole-image (no atlas sub-rect) and sampled at the sprite-space `vUV`. **Authoring footgun:** never write `@group(N)`/`@binding(N)` in a WGSL body COMMENT — Pixi's `extractStructAndGroups` regex only skips a decorator when the char before `@` is `/`, so `// @group(3) … ;` (space after `//`) is parsed as a real binding and silently fails the whole material. Example: `games/3d-test/.../shaders/reveal.{shader.json,wgsl,glsl}` (cross-fades the sprite with a Metal texture bound to `uReveal`, mix driven by a MaterialInstance) in `2d-material-demo.scene.json`. **Build:** the asset tree-shaker keeps extra-sampler textures in prod — `processShader` follows a 2D shader's `texture`-param `default` GUIDs and `probeTraitRefs` follows `MaterialInstance` `kind:'texture'` override refs (both were previously shaken out → a 404 in prod). **Runtime gap:** like every 2D texture, an extra sampler loads LAZILY (one-frame pop-in) — not scene-pre-acquired; the scene `resources` manifest lists override refs (via `collectResourceRefsFromEntities`) but not the async shader-manifest defaults. Scalar-VALUE overrides remain **uniform-only** and **scalar-only** (see the MaterialInstance section); a `kind:'texture'` override is the only non-scalar override kind, and it's 2D-only.

### Paint order

`paintOrder.ts` `computePaintOrder` is the single stacking source shared with the editor SceneView: a depth-first walk of the hierarchy by `EntityAttributes.sortOrder` (lower = painted first / furthest back; last-visited on top), assigned to each object's Pixi `zIndex` (slot containers are `sortableChildren`, set ONCE at slot creation). `Renderable2D.orderInLayer` / `Text2D.orderInLayer` (Unity "Order in Layer") RE-RANKS globally — higher = on top, independent of tree position, with the hierarchy DFS index as the stable tiebreak — so a cut-out character's parts parented to scattered bones can stack by an explicit layer order.

### Per-viewport instancing

The pass is a `Scene2DRenderer` CLASS (not a singleton): a Pixi display object and a `<canvas>` can each live in only ONE place, so each viewport rendering the same world — the runtime / GameView vs the editor SceneView — owns its OWN renderer, display objects, dirty state, particle state, and `Canvas2DPool`. A module-level `defaultRenderer` on the `defaultPool` backs the free-function exports so runtime + GameView stay byte-identical. The PRIMARY (runtime) renderer owns process-wide registrations — the layout-bounds provider, the prewarm-before-swap hook, and the `unloadAllSpriteTextures` net; a non-primary (editor) renderer skips all three so it never tears texture accounting out from under GameView. The `Assets` decoded-image cache + its refcount (`spriteTextureRefs`) are GLOBAL across renderers — a per-viewport count would `Assets.unload()` a texture another viewport still shows.

#### Sprite textures: why the unload is DEFERRED, and the sourceless-entry trap

⚠️ **A refcount reaching 0 does NOT mean a texture is finished with — it means nothing holds it AT THIS INSTANT.** A renderer that rebuilds a subtree by despawning and respawning it (Court's board overlay does this on every interaction) legitimately drops a url to 0 and back to 1 inside ONE synchronous frame. `releaseSpriteTexture` therefore defers its `Assets.unload` by a macrotask and `retainSpriteTexture` CANCELS a pending one; `unloadAllSpriteTextures` flushes any still armed, so none can fire against the next scene (the F3 "no texture accounting survives a scene" invariant stays exact).

**The trap this closes**: `Assets.unload` destroys the texture's `source` EAGERLY but removes the cache entry ASYNCHRONOUSLY, so there is a window where the entry is **present and unusable**. `Assets.cache.has(url)` says yes, `Assets.get(url)` hands back a corpse, and every consumer reads it as live — a Sprite binds it and draws **nothing, forever** (no load is ever kicked, because `has()` stays true), a Mesh binds it, and the font atlas path does `tex.source.scaleMode = 'linear'` and throws. Measured on a live renderer 2026-08-10: `{inCache: true, hasSource: false}` while a healthy sibling texture in the same overlay rendered fine.

**Where the guard lives**: `loadPixiTexture` (`pixiTextureLoad.ts`) evicts a sourceless entry before loading, so every consumer that GOES THROUGH IT is protected at the one choke point they share. `makeSprite` and `resolveMaterialTexture` additionally test `.source` before binding, because they must decide to take the load path at all rather than bind what they found. **Never treat `Assets.cache.has(url)` as proof a texture is usable** — check `.source`, or call `isPixiTextureLive(url)`.

⚠️ **"At the choke point, therefore covered by construction" was WRONG for two of the consumers, and the 2026-08-11 close-out found both.** A choke-point fix only reaches callers that actually reach the choke point, and this paragraph originally listed four consumers as protected when two were not:

- **The skinned-mesh part path** (`Scene2D.tsx`) guarded its load with `if (!Assets.cache.has(part.url))` and then bound `Assets.get(part.url)` into a `new Mesh`. On a present-but-sourceless entry the `has()` is true, so `loadPixiTexture` is **never called** and the eviction never runs — the exact bug, at a site the fixing commit had itself listed as covered. It now asks `isPixiTextureLive`, which is why that predicate is exported: a call site deciding *"do I need to load?"* cannot ask `has()` and be correct.
- **`pixiParticleBackend.ts` was a FIFTH consumer nobody enumerated** — it called `Assets.load(url)` directly. The sweep that found the others searched for the `has(url)` → `Assets.get(url)` shape, and this path has no `has()` at all, so pattern-matching on the symptom missed it. It lost *both* of the shim's guarantees: no `blob:` parser forcing (a **playable** build's particle textures never load) and no sourceless eviction — and `pixiParticleObject`'s flipbook path reads `base.source.width` unguarded, making it a TypeError rather than a blank sprite.

**The lesson is about the sweep, not the bug**: stating the defect as *"treats presence in the cache as proof of usability"* finds sites that check presence, and by construction cannot find the site that checks nothing. Sweep for **who acquires the resource**, not for how they get it wrong.

Found via Court's memo pen marks, which rendered nothing while being perfectly correct in the ECS (visible, positioned, valid sprite ref). They were the only Pixi-side user of their texture, so the refcount hit 0 on every rebuild; the piece art survived only because the persistent tray coins pinned it.

### Dirty gating

`renderFrame` used to re-tessellate + GPU-render every Canvas2D every frame; a two-tier gate fixes that:
1. **Idle whole-frame skip** — while the sim is stopped / paused, 2D only changes via paths that set `_externalDirty` (editor edits, async texture loads, canvas resizes, world swaps, play-state changes), so idle + clean ⇒ no ECS scan, no render.
2. **Per-entity change detection** — a `RenderSnap` / `MeshSnap` / `TextSnap` per entity captures the exact inputs that determine its output; only Canvas2D hosts with a CHANGED entity are GPU-rendered (`dirtyCanvases` → `pool.renderAll(dirtyIds)`). `preserveDrawingBuffer: true` keeps a skipped canvas's last frame on screen across a browser recomposite (scroll, ancestor transform, tab refocus).

### Canvas2D Application pool + GPU-context budget

`canvas2DPool.ts` pools one PixiJS `Application` (+ `<canvas>` + root `Container`) per Canvas2D entity, `backgroundAlpha: 0` for transparency over the 3D layer. Each INITIALIZED slot = one live GPU context; browsers cap live WebGL contexts (~8–16) and evict the oldest past that, so the pool tracks a cross-pool live-context count and warns ONCE past a soft limit of 8 (`SOFT_CONTEXT_LIMIT` — catching a slot leak or an unusually context-heavy scene before the browser silently drops a context), and caps slots at `MAX_SLOTS = 6`. Real scenes use 1–2 canvases.

A slot has TWO independent claims and is reclaimable only when BOTH drop:
- **`boundBySim`** — Scene2D's claim: the Canvas2D entity is present in the world (`allocate` / `release`).
- **`mounted`** — Canvas2DMount's claim: that component owns the slot (`mount` / `unmount`).

⚠️ **`mounted` does NOT mean "the canvas is in the DOM", and conflating the two cost #213 five fixes.** `Canvas2DMount` takes the claim synchronously in its effect but appends the canvas only once `slot.ready` resolves — i.e. after an async `Application.init()`. Inside that gap the slot is fully claimed and `canvas.parentElement` is `null`. **Any teardown that asks the DOM "is anyone using this slot?" gets the wrong answer there.** Ask the CLAIM. See the incident below.

Reclaiming only when both clear stops mount/unmount churn from leaking slots AND stops slot reuse from destroying the WebGL context behind a still-visible canvas; `entityId === null` is the canonical "unclaimed" marker. The pool DETACHES children on reclaim but never destroys them — Scene2D owns display-object destruction + texture-refcount release (destroying in both places would double-free). `renderAll` swallows a transient teardown-race throw (a canvas losing its context mid-swap) silently and only warns after 30 consecutive stuck frames.

#### Incident: the engine destroying its own GPU context (#213, closed 2026-08-13)

Court rendered no gameboard on an iPhone 8 (A11 / iOS 16) while the ECS, the DOM, the canvas size
and the intro were all perfectly correct. Five fixes were needed; four were real defects but not
this one. The durable lessons:

**Root cause.** `destroyPool()` decided "is this slot in use?" by reading `canvas.parentElement`.
Inside `Canvas2DMount`'s async gap (above) that reads `null` on a fully-claimed slot, so:

1. `mount(id)` → slot claimed, `Application.init()` in flight, canvas not appended.
2. `destroyPool()` → `releaseAll()` leaves `entityId` set (reclaim bails on `mounted`), the DOM
   check says free, slot flagged `destroyed` and spliced out. Its app is NOT destroyed here —
   `initialized` is still false.
3. `init()` resolves → `initSlotApp`'s orphan check destroys the brand-new, LIVE context.
4. `slot.ready` resolves → `Canvas2DMount` appends the now-DEAD canvas into the DOM.
5. `webglcontextlost` fires on a visible canvas; recovery declines `'disposed'`; `renderAll` never
   iterates the slot **because it is no longer in the pool**.

Step 5 is why "0 of 25,680 sampled pixels ever drawn" was literal rather than "draws into a dead
context" — nothing ever tried to draw.

**How it was finally pinned, and the transferable technique.** Every destroy path uses
`app.destroy(true)`, which Pixi's `ViewSystem` treats as `removeView` — it removes the canvas from
its parent. The canvas was measured IN the DOM with a dead context, so it had **no parent when the
context died** and was appended afterwards. That one observation discriminated this from the
already-fixed "destroyed a mounted slot" case; no amount of source reading could.

**Traps that burned whole sessions — do not repeat:**
- **It is a RACE (~60% of boots on that device), not deterministic.** Every "clean install → the
  board renders → fixed" was one or two lucky boots. **A single good boot is not evidence.** Verify
  a race fix by RATE against a measured baseline, plus an observation that the race actually
  occurred and was survived (the pool logs a one-shot warn when a teardown lands in the gap).
- **A plain webview `location.reload()` reproduces it** — no reinstall, no Xcode. That is the cheap
  repro loop, drivable over the device lease.
- **The build/install path decides whether it reproduces at all.** Same source, same phone, same
  reload protocol: Modoki Build → iOS → Xcode ⌘R failed 6/10, while a raw `xcodebuild` +
  `ideviceinstaller` build failed **0/10 even unfixed**. An agent-built install therefore cannot
  falsify a fix here — always A/B the *unfixed* build on the *same* path before believing a green.
- **A test can DEFEND the bug.** The guard added by the previous fix asserted that `destroyPool()`
  destroys a slot whose mount claim is held — the exact failing state, encoded as correct.
- **Do not infer "spliced out" from `!slots.includes(slot)`.** That is also true of a slot not yet
  pushed and of a still-claimed one; `Canvas2DSlot.destroyed` is the explicit flag, and the
  `includes` check is the line that actually destroyed the context.
- StrictMode's double-invoke of effects is **development-only**, so it cannot explain a
  `destroyPool()` during a shipped boot (verified: the shipped React chunk is the production build).
  What calls it in production is still unidentified — the teardown is merely safe now.

**⚠️ Pixi fires a context loss on EVERY `app.destroy()`.** `GlContextSystem.destroy()` ends with
`extensions.loseContext?.loseContext()`, and it removes only *Pixi's* listeners, not ours. Three
consequences the pool now handles explicitly, each with a mutation-verified test:

- A slot's `webglcontextlost` handler runs on our OWN teardown. Unguarded it emitted two errors
  swearing the surface would stay blank and citing #213 — on a correct path. Every destroy site
  therefore sets `destroyed` and detaches the listeners **before** calling `app.destroy()`.
- Those listeners close over the **slot**, not the canvas, so one left on a *replaced* canvas keeps
  mutating the live slot: a rebuild's forced loss would flip `contextLost` back to true on the
  freshly healthy renderer and queue a redundant second rebuild.
- `initSlotApp` must **capture** `slot.app` rather than re-read it after its `await`. `rebuildSlotApp`
  reassigns `slot.app`, so a rebuild whose `init()` exceeds `REBUILD_INIT_TIMEOUT_MS` (rejected, but
  *not* cancelled) would resume on the retry's Application — double-counting the context budget while
  the timed-out one is never destroyed at all: a leaked live GPU context.

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
