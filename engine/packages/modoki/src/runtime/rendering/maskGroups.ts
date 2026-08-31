/** maskGroups — which `Mask2D` clips which entity, down the flat 2D hierarchy (#449).
 *
 *  Sibling of `groupAlpha.ts`: same problem shape (a `Scene2D` flat PixiJS tree means a
 *  parent's effect never reaches its children on its own), same sparse ancestor-walk answer.
 *  Where `computeGroupAlpha` asks "what does this entity's alpha multiply out to", this asks
 *  "which mask entity's shape clips this entity" — nearest-mask-wins, plus enough of the
 *  nesting chain (`parentMaskOf`) for the renderer to nest mask containers and get INTERSECTION
 *  (not replacement) between nested masks for free, rather than hand-intersecting shapes here.
 *
 *  Deliberately sparse and lazy, for the same reason `computeGroupAlpha` is: a scene with no
 *  masks must pay ~nothing per frame. Read an absent `groupOf` entry as "unclipped". */

/** `groupOf`: entityId → the nearest `Mask2D` ancestor-or-self that clips it. SPARSE — an
 *  entity under no mask is absent, never mapped to itself or to 0.
 *
 *  `parentMaskOf`: maskId → the nearest STRICT `Mask2D` ancestor of that mask (i.e. excluding
 *  the mask itself), for nesting. SPARSE — a top-level mask (no mask ancestor) is absent. */
export interface MaskGrouping {
  groupOf: Map<number, number>;
  parentMaskOf: Map<number, number>;
}

/** Compute `MaskGrouping` for the given set of `Mask2D` entity ids and the entity hierarchy.
 *
 *  `maskIds` is a set (unlike `computeGroupAlpha`'s `alphaOf` map) because a mask contributes
 *  no per-entity scalar to combine — only IDENTITY matters: which mask, if any, is nearest.
 *  `parentOf` is the same `entityId → parentId` map `computePaintOrder`/`computeGroupAlpha`
 *  consume (0 = root).
 *
 *  Ancestor-OR-self, matching `GroupAlpha` (where an entity's own alpha applies to itself): a
 *  `Mask2D` entity is clipped by its OWN mask, so `groupOf.get(maskId) === maskId` always holds
 *  for a reachable mask. Nearest wins for descendants — an inner mask shadows an outer one in
 *  `groupOf`, and the outer-vs-inner relationship is instead captured in `parentMaskOf` so the
 *  renderer can nest containers (inner inside outer) and get intersection as a side effect of
 *  nested clip regions, rather than this module hand-intersecting two shapes. */
export function computeMaskGroups(
  maskIds: ReadonlySet<number>,
  parentOf: ReadonlyMap<number, number>,
): MaskGrouping {
  const groupOf = new Map<number, number>();
  const parentMaskOf = new Map<number, number>();
  if (maskIds.size === 0) return { groupOf, parentMaskOf }; // nothing authored ⇒ no walk, no allocation beyond the two empty maps

  // Children by parent, keyed on the REAL parent id even when that parent is not itself a key
  // in `parentOf` — see `computeGroupAlpha`'s identical comment: `parentOf` only holds entities
  // carrying `EntityAttributes`, so a mask spawned via a bare `world.spawn(Mask2D, …)` is absent
  // from it while its children still name it as their parent. Re-pointing that edge at 0 would
  // silently detach the subtree and those children would inherit no mask at all.
  const childrenOf = new Map<number, number[]>();
  for (const [id, parent] of parentOf) {
    let arr = childrenOf.get(parent);
    if (!arr) { arr = []; childrenOf.set(parent, arr); }
    arr.push(id);
  }

  // Walk starts: real roots (parent 0), plus any parent id that is not itself a child of
  // anything (an entity outside `parentOf`, possibly itself a mask, or a dangling id naming an
  // entity that no longer exists). Same pseudo-root seeding as `computeGroupAlpha`, and the same
  // divergence from `computePaintOrder` (which appends such entities to its tail as orphans
  // instead) — paint order has no defined position for them, but a mask/alpha ancestor is right
  // there with a value, so dropping the subtree here would simply be wrong.
  const rootParents: number[] = [];
  for (const parent of childrenOf.keys()) {
    if (parent !== 0 && !parentOf.has(parent)) rootParents.push(parent);
  }

  const seen = new Set<number>();
  // `nearestMask` is the nearest Mask2D ancestor-or-self as the walk descends (0 = none yet);
  // `parentMask` is the nearest STRICT ancestor mask, i.e. `nearestMask` as it stood BEFORE this
  // level's own mask (if any) took over — exactly what `parentMaskOf` wants to record for a mask.
  const visit = (id: number, nearestMask: number) => {
    // Defensive only, same reasoning as `computeGroupAlpha`: `parentOf` gives each entity
    // exactly one parent, so a cycle's members all have their parent inside the cycle and none
    // is reachable from a root or pseudo-root walk start. Kept because that argument rests on a
    // Map invariant no type enforces, and `seen` is load-bearing regardless (the trailing loop
    // below reads it).
    if (seen.has(id)) return;
    seen.add(id);
    const isMask = maskIds.has(id);
    if (isMask) {
      if (nearestMask !== 0) parentMaskOf.set(id, nearestMask);
      groupOf.set(id, id); // ancestor-or-self: a mask clips itself
    } else if (nearestMask !== 0) {
      groupOf.set(id, nearestMask);
    }
    const effectiveMask = isMask ? id : nearestMask;
    const kids = childrenOf.get(id);
    if (kids) for (const k of kids) visit(k, effectiveMask);
  };
  for (const root of childrenOf.get(0) || []) visit(root, 0);
  for (const p of rootParents) visit(p, 0); // the pseudo-root itself may carry a mask

  // Anything not reached from a root (its parent chain closes into a CYCLE — malformed data)
  // still gets its own mask applied if it IS one, matching `computeGroupAlpha`'s identical
  // fallback: silently dropping it would make the trait look broken. A non-mask descendant of a
  // cycle member inherits nothing, because no walk ever reaches it — pre-existing and shared
  // with `computeGroupAlpha`/`computePaintOrder`, neither of which has a principled answer for
  // "which member of a cycle is the root" either.
  for (const id of maskIds) {
    if (seen.has(id)) continue;
    groupOf.set(id, id);
  }

  return { groupOf, parentMaskOf };
}
