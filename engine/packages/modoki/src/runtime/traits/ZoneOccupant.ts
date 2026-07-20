import { trait } from 'koota';

/** ZoneOccupant — a marker (tag) trait: "this entity participates in zone triggers."
 *  Only entities carrying it are tested for containment by the `Zone2D`/`Zone3D` trigger
 *  systems, so a scene with a few actors (the player, an enemy) doesn't pay to test every
 *  positioned prop each frame — the author opts an entity in explicitly.
 *
 *  Dimension-agnostic: the SAME marker opts an entity into BOTH 2D and 3D zone tests. A
 *  given entity is normally one or the other (its Transform lives in a 2D or 3D scene), so
 *  a 3D zone only ever contains 3D occupants in practice. Pure tag — no fields; membership
 *  IS the signal. Pair with a `Transform` (the occupant's world position is what's tested). */
export const ZoneOccupant = trait();
