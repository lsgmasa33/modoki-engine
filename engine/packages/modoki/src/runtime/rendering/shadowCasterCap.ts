/** Tier cap on how many lights RENDER A SHADOW MAP (#229) — the pure rule.
 *
 *  The tier system could already say "shadows, but smaller" (`shadowMapCeiling`) and "no shadows
 *  at all" (`shadows: false`), and nothing in between. `TIER_SETTINGS.mid` caps how many lights
 *  SHADE a fragment (`maxDirectional`/`maxLocal`, enforced by `autoLightCapFrame`), but shadow
 *  casting was applied per light and unconditionally — `l.castShadow = light.castShadow` — so a
 *  scene with five casting lights paid five shadow passes on a `mid` phone while its shading was
 *  capped to two directionals. `Light.renderingLayerMask`'s own doc already stated the
 *  consequence: *"a light kept by even ONE renderer still renders its full shadow map."*
 *
 *  The two caps are not the same question and must not be folded together:
 *
 *    - **Shading** is per fragment per light, and which lights an object may see varies PER
 *      OBJECT (the nearest N). That is `autoLightCap`.
 *    - **A shadow map** is a whole extra submit of the caster set, once per frame, for the WHOLE
 *      scene. It cannot be decided per object, and it costs the same whether one fragment or a
 *      million ends up sampling it. #224 measured one such pass on a Galaxy A23: 57 of 103 draw
 *      calls, 58k of 87k triangles, ~3.6 ms of a 15.7 ms CPU frame — the shadow pass submitted
 *      more geometry than the visible scene did.
 *
 *  ── THE RULE ──────────────────────────────────────────────────────────────────────────────
 *      every DIRECTIONAL caster first (most effective first), then the local (spot/point)
 *      casters (most effective first), keeping the first `max`.
 *
 *  ⚠️ **DIRECTIONAL-BEFORE-LOCAL IS NOT A PREFERENCE — IT IS WHAT MAKES THE RANKING MEANINGFUL.**
 *  three's intensities are not comparable across light types: a spot/point is in candela and a
 *  directional is not, so `demos/postfx-demo` authors its five spots at 70-120 while a typical
 *  sun sits at 1-5. Ranking every caster on one number would therefore hand every shadow slot to
 *  the spots and drop the sun's — the scene-wide shadow — every time. Within a type the numbers
 *  ARE comparable, which is the only place {@link effectiveness} is used. (`autoLightCap` never
 *  hit this: it ranks directionals against directionals and locals against locals, never across.)
 *
 *  Ordering is otherwise the caller's supplied order — the sort is stable, so equally effective
 *  lights keep scene order rather than swapping.
 *
 *  ⚠️ **A SELECTION THAT MOVES AT RUNTIME COSTS ~200 ms PER SWAP — MEASURED, not feared.** The
 *  obvious better rule is "whichever light lights the thing you are looking at", and the owner
 *  asked for exactly that (the caster following the Director's focused exhibit). It was tested on
 *  a Galaxy A23 by flipping one caster on `demos/postfx-demo` and timing every frame around it:
 *  the swap frame took **255.3 ms**, swapping back **191.3 ms**, and a third and fourth swap of
 *  the SAME pair cost **220.4** and **184.9** — so nothing warms up and the price is per swap,
 *  forever. Changing which lights cast changes the `ShadowNode` set a material's `LightsNode`
 *  builds, and rebuilding that pipeline is a synchronous stall on exactly the hardware this cap
 *  exists for. Five stations would mean five ~200 ms freezes per tour.
 *
 *  Hence selection on authored intensity/colour: the choice is made once when the scene loads and
 *  then never moves. A focus-driven caster is a genuinely better feature and stays possible — but
 *  only behind a pre-warm that compiles every single-caster variant up front (the
 *  `prewarmShadersForWorld` pattern), which is its own piece of work, not a comparator swap.
 *
 *  Pure: plain numbers in, a Set of ids out. No THREE, no world, no globals. */

/** A shadow-casting light reduced to what the rule needs. `id` is the caller's identity for it
 *  (an entity id) — it is only ever compared for equality, never bit-shifted, so it carries none
 *  of the 31-light limit that `autoLightCap`'s index space does. */
export interface ShadowCaster {
  id: number;
  type: 'directional' | 'spot' | 'point';
  /** Authored `Light.intensity`. Comparable only WITHIN a type — see the module header. */
  intensity: number;
  /** 0xRRGGBB, folded into effectiveness. Defaults to white when omitted. */
  color?: number;
}

/** How much light this puts into the scene: intensity scaled by the perceptual luminance of its
 *  colour (Rec. 709).
 *
 *  Deliberately duplicated from `autoLightCap.effectiveness` rather than imported — that one
 *  takes a `CapLight`, which carries a bitmask `index` and a world position this rule has no use
 *  for, and widening its parameter type to share it would couple the two caps' inputs for four
 *  lines of arithmetic. The reasoning behind the metric is the same: raw intensity mis-ranks a
 *  deep-blue rim light above a white key, and a light someone disabled by zeroing its colour
 *  scores 0 and never wins a slot. */
export function effectiveness(l: ShadowCaster): number {
  const c = l.color ?? 0xffffff;
  const r = ((c >> 16) & 0xff) / 255, g = ((c >> 8) & 0xff) / 255, b = (c & 0xff) / 255;
  return l.intensity * (0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** Map an authored `Light.lightType` to the caster type, or `null` for a light that has no
 *  shadow map to render (ambient, hemisphere — and anything unrecognised, which must not silently
 *  consume a shadow slot). Lives here rather than in the caller so the vocabulary of "what can
 *  cast" has one definition. */
export function casterTypeOf(lightType: string): ShadowCaster['type'] | null {
  return lightType === 'directional' || lightType === 'spot' || lightType === 'point'
    ? lightType
    : null;
}

/** Which of `casters` may render a shadow map, under a cap of `max` (**0 = unlimited**, the same
 *  sentinel every other numeric tier field uses).
 *
 *  Returns `null` for "no cap applies" — unlimited, or fewer casters than the cap allows — so the
 *  caller can skip the whole path rather than allocating a Set it would then always hit. That is
 *  the common case: a fleet sweep of all 53 committed scenes found exactly ONE with more than a
 *  single caster (`demos/postfx-demo`, five spots).
 *
 *  `max < 0` is treated as 0/unlimited rather than as "no shadows": a tier that wants no shadows
 *  says so with `shadows: false`, and silently reading a typo'd negative as a global shadow kill
 *  is a worse failure than ignoring it. */
export function keptShadowCasters(casters: readonly ShadowCaster[], max: number): Set<number> | null {
  if (max <= 0 || casters.length <= max) return null;
  // A fractional cap keeps one MORE than it reads: `kept.size >= 2.5` first holds at 3. The number
  // comes from a plain `<input type="number">` with no `step`, so it is reachable by typing. Floor
  // it — but never below 1, because 0 is the "unlimited" sentinel and a `0.5` that collapsed to it
  // would turn a tighter cap into no cap at all, which is the opposite of what was asked for.
  const limit = Math.max(1, Math.floor(max));
  const directional: ShadowCaster[] = [], local: ShadowCaster[] = [];
  for (const c of casters) (c.type === 'directional' ? directional : local).push(c);
  // Stable within each bucket (see the header): equally effective lights keep scene order.
  const byEffect = (a: ShadowCaster, b: ShadowCaster) => effectiveness(b) - effectiveness(a);
  directional.sort(byEffect);
  local.sort(byEffect);
  const kept = new Set<number>();
  for (const c of [...directional, ...local]) {
    if (kept.size >= limit) break;
    kept.add(c.id);
  }
  return kept;
}
