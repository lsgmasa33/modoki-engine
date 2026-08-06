/** Rendering-layer light masks — per-object light selection (#136).
 *
 *  A light affects a renderer when their `renderingLayerMask` bitmasks INTERSECT
 *  (Unity's Rendering Layers, Godot's `light_mask`, Unreal's lighting channels). Both
 *  default to `DEFAULT_RENDERING_LAYER_MASK`, so an unauthored scene has every light
 *  intersecting every renderer and this module stays completely inert — see
 *  `isLightMaskingActive()`.
 *
 *  WHY: forward shading evaluates EVERY scene light for EVERY fragment, and the cost is
 *  superlinear in light count on mobile. Measured on a Galaxy A23 (Mali-G57 MC2), one frozen
 *  viewpoint of `demos/postfx-demo`: 19 lights = 689 ms; the same scene with each material
 *  seeing only ambient + directional = 98 ms; dropping the post-FX stack on top of that = 20 ms
 *  (49 fps). Culling lights was worth ~470 ms of that 689 while the ENTIRE post-FX stack was
 *  worth 104 — hence a light-count cap being the highest-value low-tier knob there is.
 *  Detail: docs/plans/low-end-device-support.md §4.
 *
 *  MECHANISM: three's `NodeMaterial.lightsNode` overrides the scene's global light list for one
 *  material, in a SINGLE pass (`NodeMaterial.js` — `this.lightsNode || builder.lightsNode`). It
 *  works on a classic `MeshStandardMaterial` too, because `NodeLibrary.fromMaterial` copies
 *  properties across with a `for…in` and an assigned `lightsNode` is own+enumerable. So this
 *  needs no material-class migration.
 *
 *  FREE BONUS: in three's WebGPU path a shadow map is rendered by `ShadowNode.updateBefore`,
 *  and that node only exists if `AnalyticLightNode.setupShadow` ran — which happens only for
 *  lights some built `LightsNode` actually references. A light no material references therefore
 *  renders NO shadow map pass. Masking a light out drops its per-fragment cost AND its shadow
 *  pass. (Measured as part of a 66 → 26 draw-call drop.) The converse is the sharp edge: a light
 *  referenced by even ONE material still pays its full shadow-map render, so masking a 1024²
 *  shadow-casting spot down to a single statue saves the fragment cost but not the pass.
 *
 *  KEYED BY (base material, mask) — NOT per entity. Materials are shared (13 across 33 meshes in
 *  postfx-demo); a per-entity variant would trade a fragment-cost problem for a pipeline-count
 *  one, since every distinct material means another shader compile and another pipeline. Keying
 *  by the light set means every mesh sharing a mask shares one variant. This is the whole reason
 *  the module exists rather than reusing `materialInstanceClones` (which is deliberately
 *  per-entity, for per-instance PROPERTY overrides).
 *
 *  Lifecycle mirrors the other material caches: variants are created lazily and freed on world
 *  swap — the scene is the unit of memory management. */

import * as THREE from 'three';
import { onWorldSwap } from '../core/ecs/world';

/** Layer 0. Both `Light.renderingLayerMask` and a renderable's default to this, so masks are
 *  opt-in: an unauthored scene behaves exactly as it did before the feature existed. */
export const DEFAULT_RENDERING_LAYER_MASK = 1;

/** A light paired with the mask it illuminates. */
export interface MaskedLight {
  light: THREE.Light;
  mask: number;
}

/** Anything with a `lightsNode`. Classic materials accept the assignment too (see header), so
 *  this is deliberately structural rather than `NodeMaterial`. */
type LightsNodeMaterial = THREE.Material & { lightsNode?: unknown };

/** The renderer surface we need. Passed IN rather than read from a global: this module is
 *  `rendering/` (L2) and the active-renderer accessor lives in `loaders/` (L3), so importing it
 *  would invert the layer contract for no benefit — the caller already holds the renderer. */
export interface LightingFactory {
  lighting: { createNode(lights: THREE.Light[]): unknown };
}

/** Current frame's lights + their masks, set by `beginLightMaskFrame`. */
let currentLights: MaskedLight[] = [];
/** True when any light or any renderable uses a non-default mask. While false, `getMaskedMaterial`
 *  returns null for everything and no variant is ever allocated. */
let active = false;

/** A stable small id per THREE.Light, so a variant can be keyed by WHICH lights it holds.
 *
 *  This is what makes the cache correct when more than one render SURFACE is mounted. Each
 *  surface owns its own `ecsLights` map and therefore builds its OWN `THREE.Light` instances for
 *  the same ECS entities — the editor's SceneView and GameView are two such surfaces. Keying a
 *  variant by mask alone made the two surfaces collide on one entry and rebuild it on every
 *  frame, and a material whose pipeline is still compiling renders UNLIT. That is the
 *  "base lights and unlights as the camera orbits" bug: nothing to do with the camera, everything
 *  to do with two surfaces alternating. Keying by light identity gives each surface its own entry
 *  and neither invalidates the other. */
const lightIds = new WeakMap<THREE.Light, number>();
let nextLightId = 1;
function lightId(l: THREE.Light): number {
  let id = lightIds.get(l);
  if (id === undefined) { id = nextLightId++; lightIds.set(l, id); }
  return id;
}

interface Variant {
  material: LightsNodeMaterial;
}
/** `${base.uuid}|${selected light ids}` → the shared variant.
 *
 *  The selection, not the mask, is the key: two masks that resolve to the same lights can share
 *  one variant, and a genuine change (a light added, removed, or re-masked) yields a different id
 *  list and therefore a different entry — so correctness no longer depends on a generation
 *  counter that a second surface could trip every frame. */
const variants = new Map<string, Variant>();
/** Every variant we own, for disposal. The map's values are not enough: a rebuild replaces an
 *  entry, and the superseded material still needs disposing. */
const owned = new Set<LightsNodeMaterial>();

function disposeAll(): void {
  for (const m of owned) m.dispose();
  owned.clear();
  variants.clear();
  currentLights = [];
  active = false;
}

onWorldSwap(disposeAll);

/** Test/teardown hook — dispose every variant and clear the registry. */
export function resetLightMaskVariants(): void {
  disposeAll();
}

/** Publish this frame's lights and their masks. Call once per sync, before any
 *  `getMaskedMaterial`.
 *
 *  `anyRenderableMasked` must be true if ANY renderable in the world carries a non-default mask.
 *  Masking activates when either side is authored: lights alone can restrict what they touch,
 *  and renderables alone are meaningless without it — but a renderable whose mask excludes the
 *  default layer must still stop being lit by default-layer lights, so both sides arm it. */
export function beginLightMaskFrame(lights: MaskedLight[], anyRenderableMasked: boolean): void {
  const anyLightMasked = lights.some((l) => l.mask !== DEFAULT_RENDERING_LAYER_MASK);
  active = anyLightMasked || anyRenderableMasked;
  // Copy unconditionally — the caller reuses its array across frames. No diffing: the variant
  // key encodes the selection, so a changed light set simply lands on a different entry.
  currentLights = lights.map((l) => ({ light: l.light, mask: l.mask }));
}

/** Whether masking is doing anything this frame. When false the caller should skip the whole
 *  path — no variant lookups, no per-entity mask reads. */
export function isLightMaskingActive(): boolean {
  return active;
}

/** The lights that illuminate `mask`. Exported for tests and for the debug surface — "why is
 *  this object dark?" is the question this feature will generate, and answering it from data
 *  beats answering it from the shader. */
export function lightsForMask(mask: number): THREE.Light[] {
  return currentLights.filter((l) => (l.mask & mask) !== 0).map((l) => l.light);
}

function countForMask(mask: number): number {
  let n = 0;
  for (const l of currentLights) if ((l.mask & mask) !== 0) n++;
  return n;
}

/** Whether `mask` will get a variant — i.e. masking is active AND the mask sees fewer than every
 *  light. Allocation-free, so callers can ask per entity per frame.
 *
 *  Exists so the render sync can decide, BEFORE it resolves the material, whether this entity's
 *  material is about to be owned by a variant. `syncMaterial` re-binds the resolved base every
 *  frame (to pick up a late async load), which would stomp the variant and thrash `.material` on
 *  every frame — the same class of fight that Tint and MaterialInstance already opt out of. */
export function maskNeedsVariant(mask: number): boolean {
  return active && countForMask(mask) !== currentLights.length;
}

/** The shared variant of `base` that sees only the lights intersecting `mask`, or **null** when
 *  no variant is needed — masking inactive, or `mask` already sees every light (the common case
 *  for the default layer, and the reason an unmasked scene allocates nothing).
 *
 *  Returning null rather than `base` is deliberate: the caller must be able to tell "use the
 *  material you already resolved" from "use this other material", because it also has to decide
 *  whether to leave a per-entity MaterialInstance clone alone. */
export function getMaskedMaterial(
  base: THREE.Material,
  mask: number,
  factory: LightingFactory,
): THREE.Material | null {
  if (!active) return null;

  const selected = lightsForMask(mask);
  // Sees everything anyway — the scene's global lights node is already correct and cheaper.
  if (selected.length === currentLights.length) return null;

  const key = `${base.uuid}|${selected.map(lightId).join(',')}`;
  const existing = variants.get(key);
  if (existing) return existing.material;

  const material = base.clone() as LightsNodeMaterial;
  material.lightsNode = factory.lighting.createNode(selected);
  material.needsUpdate = true;
  // Record the material this was derived FROM. The caller re-reads a mesh's current material
  // each frame, and by frame 2 that IS this variant — deriving from it would clone the clone
  // every frame, growing materials (and pipelines) without bound while every visible symptom
  // looked correct. `baseOf` lets the caller recover the true base instead. Same discipline
  // materialInstanceClones states for its own base: never read it off `mesh.material`.
  material.userData = { ...material.userData, [BASE_KEY]: base };
  owned.add(material);
  variants.set(key, { material });
  return material;
}

const BASE_KEY = '__lightMaskBase';

/** The material `m` was derived from, or `m` itself when it is not a variant. Callers hand this
 *  back into `getMaskedMaterial` so a re-entrant frame keys off the ORIGINAL base. */
export function baseOf(m: THREE.Material): THREE.Material {
  const b = (m.userData as Record<string, unknown> | undefined)?.[BASE_KEY];
  return (b as THREE.Material | undefined) ?? m;
}

/** Live counts for the debug/agent surface and for the tests that assert this cache does NOT
 *  grow per entity — the failure mode it exists to prevent is invisible in a frame time. */
export function getLightMaskStats(): { variants: number; lights: number; active: boolean } {
  return { variants: variants.size, lights: currentLights.length, active };
}
