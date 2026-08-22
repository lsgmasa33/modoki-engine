/** Per-frame driver for the shadow-caster cap (#229) — the state `syncLights` reads as it walks
 *  the lights.
 *
 *  `shadowCasterCap.ts` is the pure rule (directionals first, then locals, each by effective
 *  intensity, keep `max`). This holds the answer for one frame.
 *
 *  ── WHY THE CALLER COLLECTS AND THIS MODULE DOES NOT ──────────────────────────────────────
 *  Reading the world here would mean importing the `Light` trait, and `rendering/` is an L2
 *  subsystem that may import L0 core and L1 traits only — `three/traits/Light` is neither
 *  (`docs/architecture-layers.md`; `scene3DSync.ts` gets away with it because D4 reclassifies
 *  that one file as L3 in place). So the dependency inverts exactly as `autoLightCapFrame` does
 *  with its `MaskedLight[]`: the composition layer queries the world and hands plain data down,
 *  and this module knows nothing about koota or three.
 *
 *  ── WHY THE ANSWER IS COMPUTED BEFORE THE LIGHT LOOP RATHER THAN INSIDE IT ────────────────
 *  The cap is a question about the light SET ("which of these do we keep?"), and the loop that
 *  applies it visits one light at a time — the first cannot know whether it is the brightest
 *  until the last has been seen. Deciding up front also means a demoted light never reaches
 *  `configureLightShadow`, which would otherwise resize a shadow map and resolve a follow-target
 *  guid for a map that is then never rendered.
 *
 *  ── WHY IT DOES NOT GO THROUGH `autoLightCapFrame` ────────────────────────────────────────
 *  That module publishes an INDEX-space bitmask over the frame's THREE lights, capped at 31
 *  lights, to pick a material variant per object. This cap is a scene-global property of an
 *  ENTITY ("does this light render a map at all?"), applies to point lights too, and must keep
 *  working past 31 lights — where `autoLightCap` deliberately disengages. Same input trait, two
 *  genuinely different questions; sharing the plumbing would give the smaller answer the bigger
 *  one's limits. */

import { keptShadowCasters, type ShadowCaster } from './shadowCasterCap';

/** Entity ids allowed to cast this frame, or `null` for "no cap applies" (the common case: 52 of
 *  the fleet's 53 scenes have at most one caster). */
let kept: Set<number> | null = null;
let total = 0;
/** Did this frame actually COUNT the casters? False on the unlimited path, where the caller skips
 *  the collection walk — see `getShadowCasterCapStats`. Distinct from `engaged`: a scene under the
 *  limit is counted but not capped, and its counts are real. */
let counted = false;

/** Decide which of this frame's casting lights may render a shadow map. Call once per
 *  `syncLights`, BEFORE the light loop, with every ACTIVE casting light in the scene.
 *
 *  `max` is the resolved tier's `maxShadowCasters` (0 = unlimited). Returns whether the cap is
 *  actually restricting anything. */
export function armShadowCasterCap(casters: readonly ShadowCaster[], max: number): boolean {
  counted = max > 0;
  total = casters.length;
  kept = keptShadowCasters(casters, max);
  return kept !== null;
}

/** May this entity's light render a shadow map? True whenever the cap is not engaged, so the
 *  caller can ask unconditionally and a scene under the limit behaves exactly as before. */
export function shadowCasterAllowed(entityId: number): boolean {
  return kept === null || kept.has(entityId);
}

/** What the cap did this frame — for `diagnose`, and for the "why did this shadow disappear?"
 *  question it will generate. A dropped shadow has no error and no visible cause; answering it
 *  from data beats answering it from the shader.
 *
 *  ⚠️ **`casters`/`kept` are ABSENT when the cap is not engaged, and that is not tidiness — it is
 *  the only honest answer.** An unlimited cap skips the collection walk entirely (see
 *  `armShadowCastersFor`), so this module never learns how many casters the scene has. Reporting
 *  the `0` that the un-walked counter happens to hold would be a confident lie on the MOST common
 *  path (`high`, and every project that never authored a tier) — from the one function exported to
 *  answer "where did my shadow go?". Absent beats wrong.
 *
 *  A scene that WAS counted still reports both numbers even when the cap did not bite ("5 casters,
 *  5 kept" is a useful answer), so the flag that gates them is `counted`, not `engaged`. */
export function getShadowCasterCapStats(): { engaged: boolean; casters?: number; kept?: number } {
  if (!counted) return { engaged: false };
  return { engaged: kept !== null, casters: total, kept: kept === null ? total : kept.size };
}

// NOTE: there is deliberately no reset hook. `armShadowCasterCap` runs at the top of every
// `syncLights` and overwrites both fields, so nothing can read state from a previous frame or a
// previous scene — the re-arm test in `syncLights.test.ts` pins that. The sibling
// `autoLightCapFrame` exports one only because its own test needs it; adding an unused twin here
// would be surface nothing calls.
