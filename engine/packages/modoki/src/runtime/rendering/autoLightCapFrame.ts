/** Per-frame driver for the automatic light cap (#188, item 7) — the half that touches THREE.
 *
 *  `autoLightCap.ts` is the pure rule (all ambient + the most effective N directional + the
 *  nearest N point/spot). It has been complete and unit-tested since #121 P3c and **imported by
 *  nothing**: `TIER_SETTINGS.*.maxDirectional` / `.maxLocal` were read by no shipping code path,
 *  so `low` rendered every scene light on every fragment for months. This module is the wiring
 *  that was missing.
 *
 *  ── WHY IT PLUGS INTO THE AUTHORED MASK PATH RATHER THAN BESIDE IT ────────────────────────
 *  #136 already ships the only mechanism that can express "this object is lit by those lights":
 *  `lightMaskVariants`, which builds a per-selection material variant off three's
 *  `NodeMaterial.lightsNode`. A second mechanism would mean a second material-variant cache, a
 *  second set of `ShadowNode`s, and two ways for an object to be dark. So the cap does not render
 *  anything — it only decides a MASK, and hands it to the path that already exists.
 *
 *  ── THE ONE TRICK: TWO MASK SPACES ────────────────────────────────────────────────────────
 *  They are not the same bitmask and conflating them would silently mis-light the scene.
 *
 *    - **Layer space** (authored): `Light.renderingLayerMask` and `Renderable3D.renderingLayerMask`
 *      are LAYER bitmasks that intersect. Both default to layer 0, so an unauthored scene has
 *      every light hitting every object. Several lights can share a layer.
 *    - **Index space** (the cap): `autoLightCap` returns a mask where bit `i` IS the light at
 *      index `i` — light identity, not a layer.
 *
 *  The cap has to name individual lights, so when it engages this module republishes every light
 *  under a SYNTHETIC identity mask (`1 << i`) and computes each object's mask in index space.
 *
 *  ⚠️ **The authored intent enters as the CANDIDATE SET, not as a filter on the result** — and the
 *  difference is a real bug, caught by the test written for it. Choosing the nearest N lights
 *  globally and intersecting with the authored bits afterwards deletes the cap's own choice
 *  whenever the nearest light is one the artist masked away, leaving the object with FEWER lights
 *  than either mechanism alone would have given it. Selecting from the eligible set means "the
 *  nearest local light you are ALLOWED to see", which is what the two mechanisms mean together.
 *  A scene that authors masks (postfx-demo is the only one) therefore keeps them, with the cap
 *  applied within them, rather than the cap quietly overriding an artist's decision.
 *
 *  ── WHAT KEEPS THIS OFF THE COMMON PATH ENTIRELY ──────────────────────────────────────────
 *  `capChangesAnything` — if a scene already has no more lights than the tier allows (the census
 *  says that is nearly every scene: one directional, few locals), the cap never engages, no
 *  synthetic masks are published, and the frame behaves exactly as it does today. `high` sets both
 *  caps to 0 (unlimited), so it can never engage at all. That is also what makes the per-object
 *  cost acceptable when it DOES engage: the scenes that pay for it are the ones measured at 2 fps.
 */

import * as THREE from 'three';
import {
  canAutoCap, capChangesAnything, globalKeptMask, maskForObject,
  type CapLight, type LightCaps,
} from './autoLightCap';
import { DEFAULT_RENDERING_LAYER_MASK, type MaskedLight } from './lightMaskVariants';

/** This frame's lights, reduced to what the rule needs. Reused across frames — the cap runs in
 *  the render sync, and Phase 4 measured that per-frame object churn is the engine's real CPU
 *  cost on a weak device (~600 short-lived objects to describe 153 mostly-static entities). */
const capLights: CapLight[] = [];
/** The AUTHORED layer mask of each light, kept because publishing synthetic identity masks
 *  overwrites them and the authored intent still has to be honoured per object. */
const authoredLightMasks: number[] = [];
/** Authored-renderable-mask → the index-space bits it may see, AND the global (ambient +
 *  directional) part of the selection computed over exactly those bits.
 *
 *  ⚠️ The global part is cached PER AUTHORED MASK rather than computed once, because "the most
 *  effective directional" must be chosen from the lights the object is ALLOWED to see — see
 *  `maskForObject`'s note on `allowed`. Renderables overwhelmingly share one authored mask (the
 *  default layer), so in practice this still collapses to one entry, and the number of distinct
 *  selections stays bounded by the local-light count rather than by the object count — which is
 *  what keeps the material-variant cache from exploding. */
const authoredCache = new Map<number, { bits: number; globalMask: number; fits: boolean }>();

/** Hysteresis memory (#353) — deliberately NOT cleared per frame like the three maps above; it has
 *  to survive from one frame to the next to mean anything. `resetAutoLightCapFrame` (test teardown)
 *  reassigns fresh instances, but that is NOT what invalidates a stale mapping in production — see
 *  `sameLightIdentity` below, which is what actually runs every frame.
 *
 *  Directional selection is scene-wide (no position), so its memory is keyed by the authored
 *  bucket (the same `bits` key `authoredCache` uses) rather than by object. Local selection is
 *  per-object, keyed by the caller's own identity (`scene3DSync` passes its `THREE.Object3D`) —
 *  a WeakMap so an entity that stops rendering doesn't leak.
 *
 *  ⚠️ **PER SURFACE, not module-global — caught in review before it shipped.** The editor runs
 *  SceneView and the Game panel's `Scene3D` at once, each with its OWN `ecsLights` map
 *  (`syncLights`'s `ecsLights` param) and therefore its OWN `THREE.Light` instances describing the
 *  SAME scene. `armAutoLightCap` is called once per surface per frame. A single module-global
 *  memory would see surface A's lights, then surface B's DIFFERENT light objects, read that as a
 *  changed light set every single call, and wipe the memory it just wrote — hysteresis would look
 *  broken in exactly the place `docs/rendering.md` tells the owner to go watch and tune it,
 *  because the editor is the one place two surfaces are ever both alive. Keyed on `surface`
 *  (`syncRenderables`'s `state: RenderState` — already one instance per surface, never shared, per
 *  its own module-header note) in a `WeakMap` so a torn-down surface's memory is not held forever.
 *
 *  **The general rule, so this isn't read as an isolated fix.** `capLights`/`authoredLightMasks`/
 *  `authoredCache`/`engaged`/`activeCaps` above ARE module-global and stay so correctly — they are
 *  per-PASS scratch, written by `armAutoLightCap` and fully consumed by this same synchronous call
 *  stack before the OTHER surface's pass ever runs (`beginLightMaskFrame`'s `active`/`currentLights`
 *  in `lightMaskVariants.ts` are the same shape, for the same reason). Module-global state is safe
 *  exactly as long as it's per-pass scratch consumed synchronously within one sync call. It breaks
 *  the moment something has to persist ACROSS frames — like this memory — because every surface's
 *  call is another frame's worth of alternation to a state that survives past its own call. */
interface SurfaceMemory {
  previousGlobalMaskByBucket: Map<number, number>;
  previousLocalMaskByObject: WeakMap<object, number>;
  /** The `.light` identity at each index, as of the last `armAutoLightCap` call for THIS surface —
   *  what actually guards the two maps above.
   *
   *  ⚠️ **A light's `index` is its position in `lights`, not a stable identity.** A light that
   *  deactivates or a scene that swaps rebuilds this array from scratch, and everything AFTER a
   *  removed light shifts down one index. Without this check the incumbent bits above would keep
   *  naming index N after index N started meaning a different light — the "wrong light lit,
   *  permanently, until someone remembers to touch it again" bug. A mismatch (length OR any
   *  position differs) means the memory means nothing anymore, so both maps are dropped rather
   *  than trusted. */
  previousLightIdentity: readonly THREE.Light[];
}

function freshSurfaceMemory(): SurfaceMemory {
  return { previousGlobalMaskByBucket: new Map(), previousLocalMaskByObject: new WeakMap(), previousLightIdentity: [] };
}

const surfaceMemory = new WeakMap<object, SurfaceMemory>();
/** The DEFAULT surface, for every caller that doesn't distinguish surfaces — every existing test,
 *  and any future single-surface caller. A plain object identity works fine as a `WeakMap` key. */
const DEFAULT_SURFACE: object = {};

/** This frame's active memory — set by `armAutoLightCap`, read by everything else in this module
 *  for the rest of that same synchronous call (there is no `await` between arming a surface and
 *  every `autoCapMaskFor`/`getAutoLightCapStats` call that consumes it, so this is never read for
 *  the wrong surface). */
let memory: SurfaceMemory = freshSurfaceMemory();

function sameLightIdentity(lights: readonly MaskedLight[]): boolean {
  const previous = memory.previousLightIdentity;
  if (lights.length !== previous.length) return false;
  for (let i = 0; i < lights.length; i++) if (lights[i].light !== previous[i]) return false;
  return true;
}

let engaged = false;
let activeCaps: LightCaps = { maxDirectional: 0, maxLocal: 0 };

function typeOf(l: THREE.Light): CapLight['type'] | null {
  if ((l as THREE.AmbientLight).isAmbientLight) return 'ambient';
  if ((l as THREE.DirectionalLight).isDirectionalLight) return 'directional';
  if ((l as THREE.SpotLight).isSpotLight) return 'spot';
  if ((l as THREE.PointLight).isPointLight) return 'point';
  // Hemisphere / rect-area / anything else: not classified, so not capped. Returning null rather
  // than guessing keeps an unknown light lit instead of dropping it — the failure direction that
  // looks like a bug rather than one that looks like a black object.
  return null;
}

/** Decide whether the cap engages this frame and, if so, republish `lights` under synthetic
 *  identity masks. Call once per sync, BEFORE `beginLightMaskFrame`.
 *
 *  ⚠️ MUTATES `lights[].mask` when it engages. That is the point — the array is the frame's
 *  light publication and the cap needs identity, not layers — but it means the AUTHORED value
 *  must be read before this runs, which is why `authoredLightMasks` is captured here rather than
 *  looked up later.
 *
 *  `surface` is this render surface's own identity (see `SurfaceMemory`'s doc — the hysteresis
 *  memory is keyed on it so SceneView and the Game panel's `Scene3D` don't fight over one memory).
 *  Omit it to share `DEFAULT_SURFACE`, which is correct for every single-surface caller (tests, and
 *  any future caller that only ever runs one surface).
 *
 *  Returns whether the cap engaged, which the caller must OR into `anyRenderableMasked` so
 *  masking arms even when no light or renderable was authored with a mask. */
export function armAutoLightCap(lights: MaskedLight[], caps: LightCaps, surface: object = DEFAULT_SURFACE): boolean {
  capLights.length = 0;
  authoredLightMasks.length = 0;
  authoredCache.clear();
  engaged = false;
  activeCaps = caps;

  let m = surfaceMemory.get(surface);
  if (!m) { m = freshSurfaceMemory(); surfaceMemory.set(surface, m); }
  memory = m;

  // Both caps 0 means `high`/unclamped — `capChangesAnything` can never be true and the cap can
  // never engage this call, so there is nothing for the hysteresis memory to protect. Skipping the
  // identity check (and the array it would allocate) here matters because THIS branch is the
  // common one: `high` and every project that never authored a tier take it every frame.
  if (caps.maxDirectional > 0 || caps.maxLocal > 0) {
    // The hysteresis memory names lights by INDEX, so the moment the light set stops matching
    // last frame's — one deactivated, a scene swap, any reorder — every stored bit is pointing at
    // whatever now happens to sit at that position, not at the light it was chosen for. Drop the
    // memory rather than trust it. This also covers a scene swap: the new scene's lights are
    // different objects, so the very first frame after a load never matches.
    if (!sameLightIdentity(lights)) {
      memory.previousGlobalMaskByBucket = new Map();
      memory.previousLocalMaskByObject = new WeakMap();
    }
    memory.previousLightIdentity = lights.map((l) => l.light);
  }

  // Past 31 lights a 32-bit mask cannot address them individually, and a partial cap would drop
  // whichever lights fell off the end — a rendering bug that looks like an art bug. Disengage.
  if (!canAutoCap(lights.length)) return false;

  for (let i = 0; i < lights.length; i++) {
    const l = lights[i].light;
    const type = typeOf(l);
    if (type === null) return false;   // an unclassifiable light disengages the whole cap
    // World position, not `.position`: a light parented to a moving rig has a local position that
    // says nothing about where it actually is, and "nearest" is the whole selection rule.
    const p = l.matrixWorld.elements;
    capLights.push({
      index: i, type, intensity: l.intensity, color: l.color?.getHex(),
      x: p[12], y: p[13], z: p[14],
    });
    authoredLightMasks.push(lights[i].mask);
  }

  if (!capChangesAnything(capLights, caps)) return false;

  engaged = true;
  // Republish under identity masks so `lightsForMask` resolves the cap's selection exactly.
  for (let i = 0; i < lights.length; i++) lights[i].mask = 1 << i;
  return true;
}

export function isAutoLightCapEngaged(): boolean {
  return engaged;
}

/** Which lights (index space) an object with this AUTHORED layer mask may see, plus the global
 *  part of the cap computed over exactly those. */
function authoredFor(renderableMask: number): { bits: number; globalMask: number; fits: boolean } {
  const hit = authoredCache.get(renderableMask);
  if (hit !== undefined) return hit;
  let bits = 0;
  const eligible: CapLight[] = [];
  for (let i = 0; i < authoredLightMasks.length; i++) {
    if ((authoredLightMasks[i] & renderableMask) !== 0) { bits |= 1 << i; eligible.push(capLights[i]); }
  }
  const previousGlobal = memory.previousGlobalMaskByBucket.get(bits) ?? 0;
  const globalMask = globalKeptMask(capLights, activeCaps, bits, previousGlobal);
  memory.previousGlobalMaskByBucket.set(bits, globalMask);
  const entry = {
    bits,
    globalMask,
    // The SAME question `capChangesAnything` asks globally, asked of just this object's eligible
    // lights — which is the only set that decides whether capping it would change anything.
    fits: !capChangesAnything(eligible, activeCaps),
  };
  authoredCache.set(renderableMask, entry);
  return entry;
}

/** The mask to hand `maskNeedsVariant` / `applyLightMask` for one object.
 *
 *  Composes both spaces: the authored intersection FIRST, then the cap. Doing it the other way
 *  round would let the cap hand back a light the artist had masked away.
 *
 *  `objKey` is this object's identity, for the per-object hysteresis memory (#353) — pass the
 *  same value every frame for the same object (`scene3DSync` passes its `THREE.Object3D`) and its
 *  previously-kept local lights get remembered so a near-tie doesn't flap. Omit it to get today's
 *  memoryless behaviour (what every existing caller/test does); `caps.hysteresisMargin` still has
 *  to be nonzero for the memory to matter. */
export function autoCapMaskFor(
  renderableMask: number, x: number, y: number, z: number, objKey?: object,
): number {
  if (!engaged) return renderableMask;
  const { bits, globalMask, fits } = authoredFor(renderableMask);
  // A CPU FAST PATH, and deliberately NOT a behaviour change: when the eligible set already fits
  // the caps, capping it returns that same set (all its ambient, all ≤max of its directionals,
  // all ≤max of its locals), so this short-circuit is provably a no-op on the RESULT. It exists to
  // skip the per-object distance sort and its allocation for objects the cap cannot change —
  // which, in a scene that authored its own masks, is most of them.
  //
  // ⚠️ Do not read it as the fix for a measured regression. It was written believing that, and a
  // mutation test disproved it: removing this line changes no assertion. (The device numbers that
  // seemed to show an improvement were taken at two different frozen viewpoints — 9 draw calls
  // against 7 — and were never comparable.)
  if (fits) {
    // The object's eligible set already fits — but it may have carried a local-light incumbent
    // from a PRIOR frame where it did not fit (its authored mask hasn't changed, only which cap
    // bucket it resolves to has). Left in place, that stale bit would survive as an incumbent if
    // the object ever stops fitting again, with no relation to anything chosen this frame.
    if (objKey) memory.previousLocalMaskByObject.delete(objKey);
    return bits;
  }
  // `bits` is the CANDIDATE SET, not a filter applied afterwards — intersecting after the fact
  // deletes the very light the cap chose whenever the nearest one was masked away, leaving the
  // object darker than either mechanism alone would have. See `maskForObject`'s `allowed`.
  const previousLocal = objKey ? memory.previousLocalMaskByObject.get(objKey) ?? 0 : 0;
  const result = maskForObject(capLights, activeCaps, globalMask, x, y, z, bits, previousLocal);
  if (objKey) memory.previousLocalMaskByObject.set(objKey, result & ~globalMask);
  return result;
}

/** What the cap did this frame — for `diagnose`, and for the "why is this object dark?" question
 *  this feature will generate. Answering it from data beats answering it from the shader.
 *
 *  ⚠️ Computes the default bucket's global mask WITHOUT going through `authoredFor` — that function
 *  writes `previousGlobalMaskByBucket` (needed so the NEXT real renderable in this bucket sees an
 *  incumbent) and populates `authoredCache` (needed so a later call in the SAME frame doesn't
 *  recompute). A read-only diagnostic must not do either: writing the memory here would let calling
 *  `diagnose` — nothing else — seed an incumbent that steers next frame's real selection, and
 *  populating the cache first would freeze the entry before any real renderable ever asked for it,
 *  silently skipping the write real objects depend on. So this recomputes the bits inline and reads
 *  (never writes) the hysteresis memory. */
export function getAutoLightCapStats(): {
  engaged: boolean; lights: number; keptGlobally: number; caps: LightCaps;
} {
  let g = 0;
  if (engaged) {
    let bits = 0;
    for (let i = 0; i < authoredLightMasks.length; i++) {
      if ((authoredLightMasks[i] & DEFAULT_RENDERING_LAYER_MASK) !== 0) bits |= 1 << i;
    }
    g = globalKeptMask(capLights, activeCaps, bits, memory.previousGlobalMaskByBucket.get(bits) ?? 0);
  }
  let keptGlobally = 0;
  for (let i = 0; i < capLights.length; i++) if ((g >> i) & 1) keptGlobally++;
  return { engaged, lights: capLights.length, keptGlobally, caps: activeCaps };
}

/** Test/teardown hook. Production never calls this — `armAutoLightCap`'s own light-identity check
 *  (`sameLightIdentity`) is what actually invalidates the hysteresis memory frame to frame,
 *  including across a scene swap (the new scene's lights are different objects, so the very next
 *  `armAutoLightCap` call sees a mismatch on its own). This exists so a test can start clean. */
export function resetAutoLightCapFrame(): void {
  capLights.length = 0;
  authoredLightMasks.length = 0;
  authoredCache.clear();
  // Only `DEFAULT_SURFACE` needs dropping here: `surfaceMemory` is a `WeakMap` (no way to clear it
  // wholesale, and no need to — every OTHER key is a real surface object a real caller still
  // owns), and no test passes a surface token of its own, so `DEFAULT_SURFACE` is the only entry
  // this process could have written.
  surfaceMemory.delete(DEFAULT_SURFACE);
  memory = freshSurfaceMemory();
  engaged = false;
  activeCaps = { maxDirectional: 0, maxLocal: 0 };
}

/** The inert authored default, re-exported so a caller need not import two modules to ask
 *  "was anything authored here?". */
export { DEFAULT_RENDERING_LAYER_MASK };
