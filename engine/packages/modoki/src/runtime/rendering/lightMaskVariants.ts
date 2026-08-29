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
 *  Detail: docs/rendering.md § "Quality tiers" → "The automatic light cap".
 *
 *  MECHANISM: three's `NodeMaterial.lightsNode` overrides the scene's global light list for one
 *  material, in a SINGLE pass (`NodeMaterial.js` — `this.lightsNode || builder.lightsNode`). It
 *  works on a classic `MeshStandardMaterial` too, because `NodeLibrary.fromMaterial` copies
 *  properties across with a `for…in` and an assigned `lightsNode` is own+enumerable. So this
 *  needs no material-class migration — but a classic material's PIPELINE CACHE KEY is blind to
 *  the node it now carries, which is why `customProgramCacheKey` below is mandatory rather than
 *  cosmetic. Full account: docs/rendering.md § "Rendering-layer light masks".
 *
 *  FREE BONUS: in three's WebGPU path a shadow map is rendered by `ShadowNode.updateBefore`,
 *  and that node only exists if `AnalyticLightNode.setupShadow` ran — which happens only for
 *  lights some built `LightsNode` actually references. A light no material references therefore
 *  renders NO shadow map pass. Masking a light out drops its per-fragment cost AND its shadow
 *  pass. (Measured as part of a 66 → 26 draw-call drop.) The converse is the sharp edge: a light
 *  referenced by even ONE material still pays its full shadow-map render, so masking a 1024²
 *  shadow-casting spot down to a single statue saves the fragment cost but not the pass.
 *
 *  TWO CACHES, KEYED DIFFERENTLY ON PURPOSE — and neither key is arbitrary:
 *    - the material variant by **(base material, light selection)**, NOT per entity. Materials are
 *      shared (13 across 33 meshes in postfx-demo); a per-entity variant would trade a
 *      fragment-cost problem for a pipeline-count one, since every distinct material means another
 *      shader compile and another pipeline. This is the whole reason the module exists rather than
 *      reusing `materialInstanceClones` (deliberately per-entity, for PROPERTY overrides).
 *    - the lights node by the **selection alone**, shared across base materials, so a light gets
 *      one `ShadowNode` — and so one shadow pass — instead of one per material.
 *
 *  Lifecycle mirrors the other material caches: variants are created lazily and freed on world
 *  swap — the scene is the unit of memory management. */

import * as THREE from 'three';
import { onWorldSwap } from '../core/ecs/world';
import { markDerived, cloneDerived, retireDerivedMaterial } from './derivedMaterials';

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
type LightsNodeMaterial = THREE.Material & {
  lightsNode?: unknown;
  /** three calls this to seed the pipeline cache key; overriding it per variant is what keeps
   *  two clones that differ only in `lightsNode` from sharing one compiled shader. */
  customProgramCacheKey?: () => string;
};

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

/** `${selected light ids}` → ONE shared lights node for that exact selection.
 *
 *  SEPARATE from the material cache on purpose, and load-bearing. A `LightsNode` builds a
 *  `ShadowNode` per shadow-casting light it references, and a ShadowNode owns its own shadow-map
 *  render target which its material samples. Build TWO nodes over the same light and you get two
 *  ShadowNodes competing for one `LightShadow` — `ShadowNode.setup` assigns `shadow.map` to
 *  whichever built last — and the losing material samples a map nothing rendered into, i.e. it
 *  reads as FULLY IN SHADOW. On screen that is a pitch-black object, in a scene whose data is
 *  entirely correct.
 *
 *  It bit exactly where materials differ but lighting does not: the horse plinth (a primitive on
 *  the shared plinth `.mat.json`) and the horse statue (its own GLB material) both select only
 *  SpotHorse, so keying the node by (material, lights) gave them a node each — statue lit, plinth
 *  black. Keying the NODE by the light selection alone gives one ShadowNode per light, exactly as
 *  the unmasked global path has always had.
 *
 *  So the two caches are keyed differently and both keys are right: a material variant is per
 *  (base material, selection) because it carries that material's own properties, while the lights
 *  node is per selection because it owns shadow state that must not be duplicated. */
const lightsNodes = new Map<string, unknown>();

function lightsNodeFor(sel: string, selected: THREE.Light[], factory: LightingFactory): unknown {
  let node = lightsNodes.get(sel);
  if (node === undefined) {
    node = factory.lighting.createNode(selected);
    lightsNodes.set(sel, node);
  }
  return node;
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
  // The nodes own shadow render targets, so they leak GPU memory if merely dropped.
  for (const n of lightsNodes.values()) {
    const d = (n as { dispose?: () => void } | null)?.dispose;
    if (typeof d === 'function') d.call(n);
  }
  lightsNodes.clear();
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

  const sel = selected.map(lightId).join(',');
  const key = `${base.uuid}|${sel}`;
  const existing = variants.get(key);
  if (existing) return existing.material;

  // `cloneDerived`, not a bare `.clone()` — this site has the SAME userData trap it polices
  // elsewhere (#325 sweep). `base` here is whatever `applyLightMask` recovered, and for a tinted or
  // MaterialInstanced mesh that is a `markDerived` clone — whose `userData.__derivedBase` holds a
  // MATERIAL. `Material.copy()` would deep-copy that through `JSON.parse(JSON.stringify(...))`,
  // serialising a whole material graph (and logging `Unable to serialize Texture.` for a compressed
  // one) every time a tinted mesh is also masked. The stamping it does is redundant with the
  // `markDerived` below and deliberately left there: that call is what the module's own tests pin.
  const material = cloneDerived(base, base) as LightsNodeMaterial;
  // Shared per selection, NOT built per material — see `lightsNodes` for why a second node over
  // the same shadow-casting light duplicates that light's shadow pass.
  material.lightsNode = lightsNodeFor(sel, selected, factory);
  // MANDATORY, and the whole reason masked objects rendered black. three's
  // `RenderObject.getMaterialCacheKey()` walks the material's properties to decide which compiled
  // PIPELINE to reuse, and it cannot see a lightsNode: an object-valued property that is not a
  // texture contributes the literal string "{}", and uuid/name/userData are skipped outright. So
  // N clones of one base material differing ONLY in their lights node hash to the SAME key and
  // all share whichever pipeline compiled first — every one of them lit by another variant's
  // light list. `customProgramCacheKey` is three's sanctioned escape hatch (it is the first
  // component of that key), so this is what makes the variants distinct to the pipeline cache.
  //
  // It hid behind material SHARING. postfx-demo's six plinths are one shared plinth .mat.json, so
  // they collide with each other; several of their selections were empty (those exhibit spots were
  // off), the empty pipeline won, and every plinth went black. The horse statue's material is its
  // own, so it had exactly one variant, no collision, and rendered correctly — which made it look
  // like a per-object lighting fault rather than a cache collision.
  //
  // Keyed by the SELECTION only, not by `key`: the base uuid is already covered by the rest of
  // three's key, and this way two materials that genuinely match can still share a pipeline.
  //
  // ONLY for a classic material. A real `NodeMaterial` already hashes its own node graph into
  // `customProgramCacheKey` (`_getNodeChildren()` walks every own property whose value `isNode`,
  // which an assigned `lightsNode` is), so it needs nothing from us — and overriding there would
  // REPLACE that graph hash with just the light selection, letting two different node graphs (two
  // file shaders, say) share one pipeline. That is this very defect one layer up. The classic
  // material is the only one whose key is blind to nodes, so it is the only one we touch.
  if (!(material as { isNodeMaterial?: boolean }).isNodeMaterial) {
    // Compose rather than replace, so a base that customises its own key keeps that distinction.
    const inherited = base.customProgramCacheKey?.() ?? '';
    material.customProgramCacheKey = () => `${inherited}|lightmask:${sel}`;
  }
  material.needsUpdate = true;
  // Record the material this was derived FROM. The caller re-reads a mesh's current material
  // each frame, and by frame 2 that IS this variant — deriving from it would clone the clone
  // every frame, growing materials (and pipelines) without bound while every visible symptom
  // looked correct. `baseOf` lets the caller recover the true base instead. Same discipline
  // materialInstanceClones states for its own base: never read it off `mesh.material`.
  material.userData = { ...material.userData, [BASE_KEY]: base };
  // Second stamp, different question (#318). BASE_KEY answers "re-derive from THIS", which is why
  // a tint clone must answer it with itself; `markDerived` answers "my texture references belong
  // to that", so the retired-material sweep can see that a mesh binding this variant is still
  // holding the base — and the base's textures — through it.
  markDerived(material, base);
  owned.add(material);
  variants.set(key, { material });
  return material;
}

const BASE_KEY = '__lightMaskBase';

/** Drop every variant derived from `base`, retiring each so it is disposed once no mesh binds it.
 *
 *  Called when `base` itself has gone stale — a re-imported `.mat.json` (the retired instance a
 *  bound variant recovers through `baseOf`), or a superseded tint clone. Eviction alone would not
 *  be enough and is not what fixes the staleness: the CALLER must also re-derive from the fresh
 *  base, because a variant re-derived from the dead one lands on the same key. This is the
 *  lifetime half — without it the orphaned variant sits in `owned` until world swap, holding
 *  texture references its base is about to release.
 *
 *  Idempotent: a second call for the same base finds nothing. */
export function retireVariantsOf(base: THREE.Material): void {
  for (const [key, variant] of [...variants]) {
    if ((variant.material.userData as Record<string, unknown> | undefined)?.[BASE_KEY] !== base) continue;
    variants.delete(key);
    // Out of `owned` at RETIRE time, not at dispose time: otherwise a world swap in between would
    // dispose it from both sides.
    owned.delete(variant.material);
    const stale = variant.material;
    retireDerivedMaterial(stale, () => stale.dispose());
  }
  // The lights nodes are deliberately left alone — they are keyed by light SELECTION, shared
  // across every base, and own the shadow state a rebuilt variant will bind straight back to.
}

/** Give `clone` the same light-mask base `source` answers with, so `baseOf(clone)` keeps resolving
 *  to the material a variant must be re-derived FROM.
 *
 *  For a clone that is layered OUTSIDE masking — one taken of whatever `applyLightMask` settled on,
 *  rather than one masking will later derive from. `videoTextureSync` is the case (#325): without
 *  this its clone answers `baseOf` with itself, so the next frame's `applyLightMask` mints a
 *  variant keyed on the CLONE's uuid, `videoTextureSync` sees an unrecognised material and rebuilds,
 *  and the two mint a fresh material and a fresh pipeline at each other forever. Inheriting the
 *  base keeps the variant-cache key stable, so the lookup hits and both systems settle.
 *
 *  ⚠️ This is the OPPOSITE of what a tint clone wants, and the difference is not stylistic. A tint
 *  clone answers `baseOf` with ITSELF so masking derives from it and the variant keeps the tint —
 *  correct there because a tint clone is cached and outlives the frame. A video clone is per-binding
 *  and OWNS the `VideoTexture` it disposes on unbind, so letting the shared variant cache clone it
 *  would leave cached variants sampling a disposed texture and grow that cache per entity. Video
 *  therefore composes the other way round: it clones the variant and carries the mask's own
 *  properties across (`cloneDerived`). What makes that safe is ordering — `syncVideoTextures` runs
 *  after the renderable pass, so video always gets the last word on the slot. */
export function inheritMaskBase(clone: THREE.Material, source: THREE.Material): void {
  // No `base === clone` guard: every caller passes a freshly minted clone, so `baseOf(source)`
  // cannot be it. A guard here would read as a live safety net for a case that cannot occur.
  clone.userData = { ...clone.userData, [BASE_KEY]: baseOf(source) };
}

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
