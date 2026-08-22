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
 *  Returns whether the cap engaged, which the caller must OR into `anyRenderableMasked` so
 *  masking arms even when no light or renderable was authored with a mask. */
export function armAutoLightCap(lights: MaskedLight[], caps: LightCaps): boolean {
  capLights.length = 0;
  authoredLightMasks.length = 0;
  authoredCache.clear();
  engaged = false;
  activeCaps = caps;

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
  const entry = {
    bits,
    globalMask: globalKeptMask(capLights, activeCaps, bits),
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
 *  round would let the cap hand back a light the artist had masked away. */
export function autoCapMaskFor(renderableMask: number, x: number, y: number, z: number): number {
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
  if (fits) return bits;
  // `bits` is the CANDIDATE SET, not a filter applied afterwards — intersecting after the fact
  // deletes the very light the cap chose whenever the nearest one was masked away, leaving the
  // object darker than either mechanism alone would have. See `maskForObject`'s `allowed`.
  return maskForObject(capLights, activeCaps, globalMask, x, y, z, bits);
}

/** What the cap did this frame — for `diagnose`, and for the "why is this object dark?" question
 *  this feature will generate. Answering it from data beats answering it from the shader. */
export function getAutoLightCapStats(): {
  engaged: boolean; lights: number; keptGlobally: number; caps: LightCaps;
} {
  const g = engaged ? authoredFor(DEFAULT_RENDERING_LAYER_MASK).globalMask : 0;
  let keptGlobally = 0;
  for (let i = 0; i < capLights.length; i++) if ((g >> i) & 1) keptGlobally++;
  return { engaged, lights: capLights.length, keptGlobally, caps: activeCaps };
}

/** Test/teardown hook. */
export function resetAutoLightCapFrame(): void {
  capLights.length = 0;
  authoredLightMasks.length = 0;
  authoredCache.clear();
  engaged = false;
  activeCaps = { maxDirectional: 0, maxLocal: 0 };
}

/** The inert authored default, re-exported so a caller need not import two modules to ask
 *  "was anything authored here?". */
export { DEFAULT_RENDERING_LAYER_MASK };
