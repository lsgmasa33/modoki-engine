/** Automatic per-object light cap for the `low` quality tier (#121 P3c).
 *
 *  Forward shading evaluates EVERY scene light for EVERY fragment, and the cost is superlinear on
 *  mobile with a cliff around 5-8 lights. #136 shipped the MECHANISM to fix that — rendering-layer
 *  masks giving an object its own light selection — but masks are AUTHORED, and a census found
 *  exactly one project (postfx-demo) that authors any. Every other project ships every light
 *  hitting every fragment. This is the automatic fallback for them.
 *
 *  ── THE RULE ──────────────────────────────────────────────────────────────────────────────
 *      all ambient  +  the most EFFECTIVE N directional  +  the nearest N point/spot
 *
 *  Three things about it are deliberate:
 *
 *  1. **Ambient is never capped.** three sums every `AmbientLight` into a single constant term, so
 *     N of them cost the same as one and none runs a BRDF. Capping them buys nothing and visibly
 *     flattens the scene.
 *  2. **Directional is capped to ONE**, matching the owner's authoring intent ("at most 1
 *     directional light"). In practice this is insurance rather than a saving: a per-SCENE census
 *     found a maximum of TWO directionals anywhere (3d-test's tropical-island: a 0.1-intensity
 *     `Sun Light` plus a 1.0 `Fill Light`) and exactly one in every other scene. An earlier
 *     per-PROJECT count claimed seven and was wrong — it summed five separate scenes, and
 *     per-fragment cost is per scene. The cap costs nothing on a scene that already conforms.
 *  3. **Local lights are chosen per OBJECT, directionals globally.** A directional has no position
 *     — "nearest" is meaningless — so the strongest wins scene-wide. Only point/spot vary per
 *     object.
 *
 *  ── WHY THIS CANNOT EXPLODE THE PIPELINE COUNT ───────────────────────────────────────────
 *  The variant cache keys a material clone by its light SELECTION, and a `LightsNode` builds a
 *  `ShadowNode` per shadow-casting light it references — so a design that produced a distinct
 *  selection per OBJECT would multiply both compiled pipelines and shadow passes, and could end up
 *  slower than doing nothing. This rule cannot: the global part is identical for every object, so
 *  the number of distinct selections is bounded by the number of LOCAL lights (+1 for "none in
 *  range"), never by the object count. 33 meshes and 6 spots is 7 selections, not 33. (On `low`
 *  the shadow question is moot anyway — that tier disables shadows outright.)
 *
 *  Pure: takes plain numbers, returns a bitmask. No THREE, no world, no globals. */

/** A light reduced to what the rule needs. `index` is its position in the frame's light array;
 *  its BIT is `1 << index`. */
export interface CapLight {
  index: number;
  type: 'ambient' | 'directional' | 'point' | 'spot';
  intensity: number;
  /** 0xRRGGBB. Folded into effectiveness — see `effectiveness`. Defaults to white when omitted. */
  color?: number;
  x: number;
  y: number;
  z: number;
}

/** How much light this actually puts into the scene: intensity scaled by the perceptual luminance
 *  of its colour (Rec. 709).
 *
 *  Raw intensity alone mis-ranks lights, and it does so in the direction that matters: a deep-blue
 *  rim light at intensity 2 contributes far less visible illumination than a white key at 1, but
 *  wins on intensity and would be the one the cap keeps. Since the cap keeps exactly ONE
 *  directional, picking the wrong one is the difference between a lit scene and a tinted dark one.
 *
 *  A black light (colour 0) scores 0 and is never chosen over anything that emits — which is also
 *  the sensible treatment of a light someone disabled by zeroing its colour. */
export function effectiveness(l: CapLight): number {
  const c = l.color ?? 0xffffff;
  const r = ((c >> 16) & 0xff) / 255, g = ((c >> 8) & 0xff) / 255, b = (c & 0xff) / 255;
  return l.intensity * (0.2126 * r + 0.7152 * g + 0.0722 * b);
}

export interface LightCaps {
  /** 0 = unlimited. */
  maxDirectional: number;
  /** 0 = unlimited. */
  maxLocal: number;
}

/** Masks are 32-bit, so a scene with more lights than this cannot address them individually.
 *  Rather than silently capping the wrong set, the cap DISENGAGES past this — see `canAutoCap`. */
export const MAX_CAPPABLE_LIGHTS = 31;

/** Every bit set — "this sees every light", the inert value. */
export const ALL_LIGHTS_MASK = 0xffffffff;

/** Is the automatic cap usable for this light set?
 *
 *  False when there are more lights than a 32-bit mask can address individually. Disengaging is
 *  the honest failure: a partial cap would silently drop whichever lights fell off the end of the
 *  mask, which is a rendering bug that looks like an art bug. */
export function canAutoCap(lightCount: number): boolean {
  return lightCount <= MAX_CAPPABLE_LIGHTS;
}

/** The bits every object keeps regardless of where it is: all ambient, plus the MOST EFFECTIVE
 *  `maxDirectional` directionals (see `effectiveness` — not raw intensity).
 *
 *  Ties break on `index` so the choice is DETERMINISTIC — two equally effective lights must not
 *  swap between frames (or between the editor and a device), because a changed selection swaps a
 *  material variant and would strobe the scene. */
export function globalKeptMask(lights: readonly CapLight[], caps: LightCaps): number {
  let mask = 0;
  const directional: CapLight[] = [];
  for (const l of lights) {
    if (l.type === 'ambient') mask |= 1 << l.index;      // never capped
    else if (l.type === 'directional') directional.push(l);
  }
  const keep = caps.maxDirectional > 0
    ? [...directional].sort((a, b) => (effectiveness(b) - effectiveness(a)) || (a.index - b.index))
        .slice(0, caps.maxDirectional)
    : directional;
  for (const l of keep) mask |= 1 << l.index;
  return mask;
}

/** The full mask for an object at (x,y,z): the global part plus the nearest `maxLocal` point/spot.
 *
 *  Distance is measured to the light's POSITION, squared (no sqrt — only the ordering matters).
 *  Intensity and range are deliberately NOT weighted in: a brightness-weighted metric changes
 *  which light wins as intensities animate, and every change of winner is a material-variant swap.
 *  Nearest is stable, cheap, and predictable, which matters more here than being optimal. */
export function maskForObject(
  lights: readonly CapLight[],
  caps: LightCaps,
  globalMask: number,
  x: number, y: number, z: number,
): number {
  if (caps.maxLocal <= 0) {
    let mask = globalMask;
    for (const l of lights) if (l.type === 'point' || l.type === 'spot') mask |= 1 << l.index;
    return mask;
  }
  const local: { l: CapLight; d2: number }[] = [];
  for (const l of lights) {
    if (l.type !== 'point' && l.type !== 'spot') continue;
    const dx = l.x - x, dy = l.y - y, dz = l.z - z;
    local.push({ l, d2: dx * dx + dy * dy + dz * dz });
  }
  local.sort((a, b) => (a.d2 - b.d2) || (a.l.index - b.l.index));
  let mask = globalMask;
  for (let i = 0; i < Math.min(caps.maxLocal, local.length); i++) mask |= 1 << local[i].l.index;
  return mask;
}

/** Would this cap actually restrict anything? False when every light is kept anyway — a 2-light
 *  scene under a 1-directional/1-local cap, say. Lets the caller skip the whole path (and avoid
 *  allocating a variant) exactly as an unauthored scene does today. */
export function capChangesAnything(lights: readonly CapLight[], caps: LightCaps): boolean {
  let directional = 0, local = 0;
  for (const l of lights) {
    if (l.type === 'directional') directional++;
    else if (l.type === 'point' || l.type === 'spot') local++;
  }
  return (caps.maxDirectional > 0 && directional > caps.maxDirectional)
    || (caps.maxLocal > 0 && local > caps.maxLocal);
}
