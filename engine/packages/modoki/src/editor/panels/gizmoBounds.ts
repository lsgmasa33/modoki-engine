/** Gizmo bounds for an entity with no visual of its own — the union AABB of its descendants.
 *
 *  Extracted from `SceneView.tsx` deliberately: a panel holds JSX, hooks and imperative wiring, and
 *  its DECISIONS belong in a plain `.ts` module beside it where a unit test can reach them (see
 *  docs/editor.md § Panels — editor `.ts` is expected to carry tests, editor `.tsx` is not). Mounting
 *  a panel in jsdom to test this would assert the mock.
 */

/** A 2D gizmo box: half-extents (the drawn box is `halfW*2 x halfH*2`) plus the normalized pivot
 *  within it, so an asymmetric box can still sit on the entity's own transform. */
export type GizmoBox2D = { halfW: number; halfH: number; pivotX: number; pivotY: number };

/** The minimum an entity must answer for the union walk — deliberately structural rather than the
 *  koota `Entity` type, so a test can hand in plain objects instead of building a world. */
export interface GizmoBoundsEntity {
  has: (trait: unknown) => boolean;
  get: (trait: unknown) => Record<string, unknown>;
}

export interface GizmoBoundsDeps {
  findEntity: (id: number) => GizmoBoundsEntity | null;
  /** child id -> parent id, the editor's existing scene-graph map. */
  parentOf: Map<number, number>;
  transformTrait: unknown;
  /** Optional so a caller without the trait registered still gets a defined answer (null). */
  r2dTrait?: unknown;
  /** Measures a Text2D's laid-out block. Injected because it needs the loaded font provider, which
   *  is renderer state — and because a test can then measure text without a font at all. */
  measureText?: (e: GizmoBoundsEntity) => GizmoBox2D | null;
}

/** Deepest parent chain the walk will follow. A malformed chain would otherwise recurse forever
 *  inside a render loop; 32 is far past any real nesting. */
const MAX_DEPTH = 32;

/**
 * The union AABB of `selectedId`'s descendant visuals, in the selected entity's own local space, or
 * `null` when it has no visual descendants at all.
 *
 * ⚠️ **Why this exists: a Transform-only GROUP had no gizmo and could not be dragged.** Every gizmo
 * path gated on the entity owning a `Renderable2D` / `SkinnedSprite2D` / `Bone2D` / `Text2D`, so
 * grouping children under a plain parent — the normal way to move several things at once — produced a
 * selectable entity with nothing to grab. Owner ask, 2026-08-08: *"if the entity doesn't have visual,
 * we should construct aabb that contains all child visuals"*.
 *
 * **Why a union rather than a bare pivot point.** A point would be draggable but would say nothing
 * about what is being moved, and scale/rotate handles need an extent to mean anything. The union is
 * also what Unity shows for an empty parent, so it is the unsurprising answer.
 *
 * ⚠️ **Translation and scale compose; ROTATION does not.** A rotated descendant contributes its
 * axis-aligned extent about its own origin, so the union is CONSERVATIVE — never too small, but
 * possibly looser than the true oriented bounds. That is the safe direction for a grab target and
 * keeps this a short walk instead of a matrix pipeline. Do not read the box as exact geometry.
 *
 * ⚠️ **A nested group contributes no extent of its own and is still recursed into** — that is what
 * makes a group-of-groups work (Court's `ChipRow` holds a group per dot). Dropping the recursion for
 * "efficiency" would silently shrink the box to whichever children happen to be direct.
 */
export function descendantUnionGizmoBox2D(selectedId: number, deps: GizmoBoundsDeps): GizmoBox2D | null {
  const { findEntity, parentOf, transformTrait, r2dTrait, measureText } = deps;
  // Invert parentOf once per call rather than scanning it per node — the walk is O(subtree) after
  // this, where a naive filter-per-node would be O(n * subtree) on every gizmo frame.
  const childrenOf = new Map<number, number[]>();
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent);
    if (list) list.push(child); else childrenOf.set(parent, [child]);
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  const visit = (id: number, ox: number, oy: number, sx: number, sy: number, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const childId of childrenOf.get(id) ?? []) {
      const child = findEntity(childId);
      if (!child || !child.has(transformTrait)) continue;
      const t = child.get(transformTrait);
      const cx = ox + num(t.x) * sx;
      const cy = oy + num(t.y) * sy;
      // A zero or absent scale must not collapse the subtree to a point — treat it as 1, matching
      // how the renderer's own compose behaves for an unset field.
      const csx = sx * (num(t.sx, 1) || 1);
      const csy = sy * (num(t.sy, 1) || 1);

      let hw: number | null = null, hh: number | null = null;
      if (r2dTrait && child.has(r2dTrait)) {
        const rend = child.get(r2dTrait);
        // An explicitly hidden child contributes nothing — the box should hug what you can SEE.
        if (rend.isVisible !== false) { hw = num(rend.width); hh = num(rend.height); }
      } else if (measureText) {
        const tbox = measureText(child);
        if (tbox) { hw = tbox.halfW; hh = tbox.halfH; }
      }
      if (hw !== null && hh !== null) {
        minX = Math.min(minX, cx - hw * csx); maxX = Math.max(maxX, cx + hw * csx);
        minY = Math.min(minY, cy - hh * csy); maxY = Math.max(maxY, cy + hh * csy);
      }
      visit(childId, cx, cy, csx, csy, depth + 1);
    }
  };
  visit(selectedId, 0, 0, 1, 1, 0);

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const w = maxX - minX, h = maxY - minY;
  // An asymmetric union is expressed through the PIVOT rather than by moving the box, so the gizmo
  // still sits on the entity's own transform — that transform is the thing a drag edits. A degenerate
  // axis (every descendant on one line) falls back to a centred pivot rather than dividing by zero.
  return {
    halfW: w / 2, halfH: h / 2,
    pivotX: w > 1e-6 ? -minX / w : 0.5,
    pivotY: h > 1e-6 ? -minY / h : 0.5,
  };
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
