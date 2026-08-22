/** groupAlpha — the per-entity ALPHA PRODUCT down the 2D entity hierarchy (#211).
 *
 *  `Scene2D` puts every display object straight onto its Canvas2D slot container and writes
 *  `obj.alpha` per entity, so the PixiJS tree is flat and a parent's alpha never reaches its
 *  children. Fading a WHOLE 2D canvas already works (the pooled canvas lives inside the
 *  `2D Canvas` UI node's div, so CSS opacity on that node composites all of PixiJS at once);
 *  what this adds is fading PART of a scene — one actor and its attachments, a tray but not
 *  the board — without hand-writing `Renderable2D.opacity` on every descendant and fighting
 *  whatever per-entity alpha the game already uses for its own reasons.
 *
 *  Semantics match Unity's CanvasGroup and a PixiJS container: `GroupAlpha` on an entity
 *  multiplies that entity AND everything under it, and nested groups multiply together.
 *  It is a SEPARATE trait from `Renderable2D.opacity` on purpose — the two compose
 *  (`effective = opacity × group`) rather than one overwriting the other, and a group can sit
 *  on a bare hierarchy node that renders nothing itself.
 *
 *  Deliberately sparse and lazy: with no `GroupAlpha` anywhere the result is an empty map and
 *  callers read `?? 1`, so a scene that never uses this pays one `.size` check per frame. */

/** Effective alpha per entity, for every entity under (or carrying) a `GroupAlpha`.
 *  Entities absent from the result are unaffected — read them as `1`.
 *
 *  `alphaOf` holds only the entities that carry the trait; `parentOf` is the same
 *  `entityId → parentId` map `computePaintOrder` consumes (0 = root). A parent id that is
 *  not itself a key is treated as a root, so an orphan still gets its own group applied. */
export function computeGroupAlpha(
  alphaOf: ReadonlyMap<number, number>,
  parentOf: ReadonlyMap<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (alphaOf.size === 0) return out; // nothing authored ⇒ no walk, no allocation beyond this

  // Children by parent, so the walk is one pass down instead of a chain-climb per entity.
  // The edge is kept under the REAL parent id even when that parent is not itself a key here —
  // re-pointing it at 0 instead would silently detach the subtree. `parentOf` only holds
  // entities carrying `EntityAttributes`, so a group spawned without one (`world.spawn(GroupAlpha,
  // …)`, which the trait explicitly invites) is absent from it while its children still name it
  // as their parent; collapsing that to a root made those children inherit NOTHING.
  const childrenOf = new Map<number, number[]>();
  for (const [id, parent] of parentOf) {
    let arr = childrenOf.get(parent);
    if (!arr) { arr = []; childrenOf.set(parent, arr); }
    arr.push(id);
  }

  // Where the walk starts: the real roots (parent 0), plus any parent id that is not itself a
  // child of anything — either an entity outside `parentOf` (the case above, and it may carry a
  // group of its own) or a dangling id naming an entity that no longer exists (which carries
  // none, so it contributes 1 and its children still get theirs).
  //
  // ⚠️ This DIVERGES from `computePaintOrder`, which is handed the same map and instead appends
  // such entities to its tail as orphans. That is not an inconsistency to unify away: paint
  // order is asking "where in the stack does this sit", and an entity whose parent is outside
  // the hierarchy map has no defined position, so a stable appended index is the right answer.
  // Inheritance is asking "what does its ancestor multiply it by", and there the ancestor is
  // right there with a value — dropping the subtree is simply wrong. Making this one match that
  // one is what the bug looked like before it was fixed.
  const rootParents: number[] = [];
  for (const parent of childrenOf.keys()) {
    if (parent !== 0 && !parentOf.has(parent)) rootParents.push(parent);
  }

  const seen = new Set<number>();
  const visit = (id: number, inherited: number) => {
    // Defensive only, and knowingly so: `parentOf` gives each entity exactly ONE parent, so a
    // cycle's members all have their parent inside the cycle — none has parent 0 and none is a
    // pseudo-root, which makes a cycle unreachable from every walk start. No test covers this
    // line because no input can reach it (mutation-checked: deleting it fails nothing). It stays
    // because that argument rests on a Map invariant no type enforces, and the cost is one
    // Set lookup; `seen` is load-bearing regardless — the trailing loop reads it.
    if (seen.has(id)) return;
    seen.add(id);
    const own = alphaOf.get(id);
    // Clamp per level: an authored 1.4 must not brighten a sibling group back up. A non-finite
    // value (NaN from broken scene data or a bad binding) is treated as 1 rather than clamped —
    // `Math.min(1, Math.max(0, NaN))` is NaN, which would reach `obj.alpha` and make the whole
    // subtree render as nothing, turning bad data into an invisible scene.
    const product = own === undefined || !Number.isFinite(own)
      ? inherited
      : inherited * Math.min(1, Math.max(0, own));
    if (product !== 1) out.set(id, product);
    const kids = childrenOf.get(id);
    if (kids) for (const k of kids) visit(k, product);
  };
  for (const root of childrenOf.get(0) || []) visit(root, 1);
  for (const p of rootParents) visit(p, 1); // the pseudo-root itself may carry a group
  // Anything not reached from a root (i.e. its parent chain closes into a CYCLE — malformed
  // data) still gets its OWN group applied; silently dropping it would make the trait look
  // broken. The limit, measured rather than assumed: a non-cycle DESCENDANT of a cycle member
  // inherits nothing, because no walk ever reaches it. That is pre-existing and shared with
  // `computePaintOrder`, whose ordering is equally undefined for a cyclic chain — there is no
  // principled answer to "which member of a cycle is the root", so both stop at the same place
  // rather than inventing one.
  for (const [id, own] of alphaOf) {
    if (seen.has(id)) continue;
    if (!Number.isFinite(own)) continue;
    const a = Math.min(1, Math.max(0, own));
    if (a !== 1) out.set(id, a);
  }
  return out;
}
