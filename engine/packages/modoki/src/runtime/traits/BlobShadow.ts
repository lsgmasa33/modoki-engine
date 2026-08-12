import { trait } from 'koota';

/**
 * A single soft dark ellipse rendered on the ground beneath the entity — a cheap
 * "contact shadow" grounding cue for entities that don't cast a real shadow — because the
 * `low` quality tier has real shadows off, or because the entity's material is alpha-blended
 * (`applyShadowFlags` leaves `castShadow` false for a `transparent` material, since the shadow
 * map treats blended geometry as opaque). NOTE this comment used to add "and that is why the
 * forest-camp character has no shadow" — that was WRONG, and the real cause was #183: skinned
 * models never had `applyShadowFlags` called on them at all. Fixed; don't re-derive the old
 * theory from this comment. `blobShadowSync` raycasts straight down
 * from the entity's world position to find the ground, places a quad flush against the
 * hit surface (tilted to its normal so it doesn't sink into a slope), and fades it out
 * as the entity rises above the surface. No hit (or no physics world) → hidden, not a
 * floating blob.
 *
 * ⚠️ **THE COST MODEL RUNS OPPOSITE TO THAT PURPOSE UNLESS YOU SAY OTHERWISE — see
 * `onlyWhenShadowsOff`.** A blob costs one physics raycast PER FRAME PER VIEWPORT plus an
 * always-submitted `frustumCulled = false` draw, on EVERY tier — including `high`, where the real
 * shadow it stands in for is being rendered too, so the device pays for both. Before 2026-08-12
 * presence was the only knob, so an author could not express "only when shadows are off" at all
 * (review R7.2). They can now, and it is opt-in.
 */
export const BlobShadow = trait({
  /** Draw the blob ONLY while the active quality tier has real shadows off — the low-tier
   *  substitute case this trait was built for. The gate short-circuits BEFORE the ground raycast,
   *  so a blob ticked this way costs **nothing** on a tier that renders real shadows, instead of a
   *  scene query per frame per viewport whose result is thrown away.
   *
   *  ⚠️ **DEFAULT `false` — opt IN, and the default is the owner's deliberate choice** (2026-08-12),
   *  taken over defaulting `true` for one reason: the editor runs unclamped, so a `true` default
   *  would make a freshly-added BlobShadow render NOTHING in the Inspector until the tier dropped
   *  to `low`. A trait that looks dead when you author it is the exact defect class this review was
   *  cleaning up, and introducing a fresh instance of it to fix a cost was the wrong trade. So
   *  nothing changes until someone ticks this, and the saving is a deliberate authoring act.
   *
   *  Leaving it `false` is also simply CORRECT for a blob that is not a tier substitute at all: an
   *  entity that can never cast a real shadow (an alpha-blended material — `applyShadowFlags`
   *  leaves `castShadow` false for a `transparent` one, since the shadow map treats blended
   *  geometry as opaque), or a deliberate stylistic blob. The engine cannot tell that case from
   *  "this is standing in for a shadow", which is why it is authored rather than inferred. */
  onlyWhenShadowsOff: false,
  /** world-space radius of the blob (ground units) */
  radius: 0.5,
  /** peak darkness at ground contact (0..1) */
  opacity: 0.5,
  /** lift above the hit surface, along its normal, to avoid z-fighting (world units) */
  groundOffset: 0.02,
  /** how far straight down to search for ground before giving up (world units) */
  maxDrop: 5,
  /** distance from the entity's ORIGIN (not its feet) to the ground at full opacity — e.g. a
   *  capsule character's origin commonly sits ~1 world unit above the ground it stands on, so
   *  leaving this at 0 would read a grounded character as already half-faded. Below this
   *  distance the blob stays at full `opacity`; fading starts here (world units) */
  fadeStart: 0,
  /** opacity fades linearly to 0 as the entity rises this far beyond `fadeStart` (world units) */
  fadeHeight: 2,
  /** how soft the blob's EDGE is, 0..1 — a shader falloff across the disc, independent of the
   *  height fade above. 0 is a hard-edged disc (the original shape); 1 fades from the very
   *  centre outward; the default fades over the outer ~65% of the radius, which reads as a
   *  contact shadow rather than a decal. Live-tunable — it is a uniform, not baked per material,
   *  so tuning it by eye on a device costs no rebuild. */
  softness: 0.65,
});
