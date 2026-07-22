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
- `syncLights(world, scene, ecsLights)` — creates/updates/removes `THREE.Light` instances from the `Light` trait (ambient / directional / point / spot), re-aiming spot & directional targets from the world transform.
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
- **Aiming** — directional/spot lights aim at a `target` Object3D added to the scene; each frame `syncLights` projects the light's local −Z forward from the WORLD transform onto that target, so a parented spot follows its transform instead of always aiming at the origin. A reaped or type-switched light removes its stray target too (`removeLightTarget`), else empties accumulate on churn.
  - **GOTCHA — aim comes from `Transform` ROTATION, and the `Light` trait's `targetX/targetY/targetZ` fields are NOT read by `syncLights`.** The forward vector is computed purely from `rx`/`ry` (`forward = (−sin ry·cos rx, sin rx, −cos ry·cos rx)`), so a light with **zero rotation always points along −Z — dead horizontal — no matter where you place it or what you type into `target*`.** Positioning a sun high above the scene and setting its target to the origin does nothing on its own. Symptom: ground planes render **black** (their +Y normal is edge-on to the light, N·L ≈ 0) while walls and object sides light normally, and `castShadow` appears to do nothing because the shadow map is cast edge-on. Cost a long false hunt for a "WebGPU shadow bug" in `demos/3d-physics-demo`; the fix was rotating the light. To aim a light at a point, set the rotation: `rx = asin(u.y)`, `ry = atan2(−u.x, −u.z)` where `u` is the normalized direction from the light to the target.
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
stripe shader; worked demo: `games/3d-test/assets/scenes/material-instance-demo.json`.

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

## NPR Outline Post-Process

The engine ships a stylized cel/outline post-process that runs **only on WebGPU**. It is off by default and toggled by the `NPRPostFX` ECS trait.

### Pipeline — `npr/NPRPostProcess.ts`

`NPRPostProcess` owns the node graph and uniforms for one `Scene3D` instance.

```ts
class NPRPostProcess {
  constructor(renderer, scene, camera, initial?: Partial<NPRConfig>)
  render(): void                            // replaces renderer.render(scene, camera)
  setConfig(config: Partial<NPRConfig>): boolean   // returns true if a rebuild is needed
  resize(width, height): void
  dispose(): void
}
```

It builds a single geometry `pass(scene, camera)` with an **MRT** (`setMRT(mrt({...}))`) writing three targets:

- `output` — lit scene color.
- `normal` — view-space normal (`normalView`).
- `lineColor` — `vec4(materialReference('lineColor','color'), materialReference('nprColorPreserve','float'))`: the per-material outline color in RGB and the color-preserve amount in alpha.

The pass plus the screen-space composite are wired into a `RenderPipeline` (from `three/webgpu`); `render()` drives `pipeline.render()`.

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

`nprFragmentOutput(colorRGBA, preserve?)` is a helper for custom `NodeMaterial` shaders rendered into the NPR pass — it wraps a fragment color into an `outputStruct` that writes **all three** MRT targets (so WebGPU validation doesn't discard the draw for missing target outputs).

### FXAA — `npr/fxaaNode.ts`

`buildFXAANode(...)` adds post-composite anti-aliasing to soften the hard black outlines. It is a self-contained raw-WGSL `wgslFn` (simplified FXAA 3.11) used because Three.js's built-in `FXAANode` trips a `setLayout`/`Fn` build bug on r183/r184. The on/off toggle is a uniform branch inside the shader, so flipping `fxaa` is instant once the FXAA path is built.

### Supersampling

`superSampleScale` (1 or 2) renders the MRT pass and the composite RTT at a higher internal resolution (`setResolutionScale` / `setPixelRatio`), reducing aliasing at silhouettes and creases before FXAA.

> **Rebuild rule:** only a `superSampleScale` change (or turning `fxaa` on while in the no-RTT fast path) triggers a full pipeline **rebuild**. Every other parameter is a cheap in-place uniform update. `setConfig()` returns `true` to signal the caller must `dispose()` and recreate the instance.

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

- The composer is created **lazily** on the first frame where `NPRPostFX.enabled` is true *and* the renderer is WebGPU (`renderer.isWebGPURenderer === true`).
- Each frame, `Scene3D` reads the singleton `NPRPostFX` into an `NPRConfig` and feeds the active camera's `clearColor` into `nprConfig.clearColor`.
- Per frame the render routes through `nprComposer.render()` when NPR is enabled, else `renderer.render(scene, camera)`. Turning the trait off keeps the composer alive but bypasses it, so toggling stays cheap.
- `setConfig()` is called for cheap updates; a `true` return disposes and rebuilds the composer.
- The `ResizeObserver` resizes both the renderer and `nprComposer.resize(w, h)`.

## Gotcha: TSL first-compile race (prewarm)

TSL node builders have a racy lazy initialization on the **first** compile a renderer ever performs. If an MRT/NPR pass happens to be that first compile — e.g. in the lazily-mounted editor Game panel, which mounts *after* the initial scene swap so the normal pre-swap prewarm hook never fired — WGSL generation can intermittently fail with `unresolved type 'OutputType'` and the mesh is dropped.

**Fix:** `Scene3D.tsx` calls `prewarmShadersForWorld(getCurrentWorld(), renderer, camera)` on mount, **before** registering the render loop, so a normal material compiles first and primes the node builder. (`prewarmShadersForWorld` also mirrors the world's lights and environment so it compiles the correct PBR shader variants, eliminating first-frame stutter on scene swap.)

**Related HMR caveat:** the `npr/*.ts` modules call `import.meta.hot.invalidate()` to opt out of HMR. TSL node (and `wgslFn`) instances get baked into compiled WGSL pipelines; hot-reloading a module creates new node identities that the old cached pipeline still references, raising the same `unresolved type 'OutputType'` error. A full page reload is the correct (and cheap) price for a stable cache.

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
- **Per-page meshes + dynamic packing** — one Pixi `Mesh` per atlas PAGE the text touches (a dynamic CJK provider spills glyphs across pages; a baked / single-page font is one mesh), all children of the slot `Container` so the anchor pivot + transform apply to the whole block. Geometry rebuilds only when the layout hash changes (text/font/size/wrap/spacing/`atlasVersion`); the shader updates only on a style-hash change; placement writes only when the transform moves. Atlas textures are FONT-owned (freed on scene teardown), never disposed by the slot. Per-glyph animation recomputes page positions from the base quads each frame while the sim runs (frozen when stopped, like skeletal animation).

## Related

- [Materials & Textures](./textures.md) — `.mat.json` resolution, the KTX2 texture pipeline + variant selection, MSDF font atlases.
- [UI System](./ui-system.md) — the `ui` (React DOM) layer.
- [2D Skinning](./2d-skinning.md) — `SkinnedSprite2D` deformable meshes + the `Billboard3D` / `FlatSprite3D` 2.5D bridge.
- [Model Import Pipeline](./model-pipeline.md) — GLB → `.mesh.json` / `.mat.json`, LODs, rigged models.
- [Architecture](./architecture.md) — the frame driver, scene-scoped resource refcounting (mesh / material / env caches).
