/** A Transform-only GROUP must still get a gizmo box, built from its descendants' visuals.
 *
 *  ⚠️ The bug: every 2D gizmo path gated on the selected entity owning a `Renderable2D` /
 *  `SkinnedSprite2D` / `Bone2D` / `Text2D`. Grouping children under a plain parent — the normal way
 *  to move several things together, and what Court's tray-badge prefab is built from — produced a
 *  selectable entity with NO gizmo, so it could not be dragged at all. Confirmed by data before the
 *  fix: `get_scene_state bounds=1` reported the group as `screen: null, onScreen: false` while every
 *  child had a rect.
 *
 *  Unit-tested here rather than through the panel because the decision lives in a plain `.ts` module
 *  (docs/editor.md § Panels): mounting SceneView in jsdom would assert the mock, and jsdom reports
 *  every rect as 0x0 anyway. */

import { describe, it, expect } from 'vitest';
import { descendantUnionGizmoBox2D, type GizmoBoundsEntity } from '../../src/editor/panels/gizmoBounds';

const TRANSFORM = { name: 'Transform' };
const R2D = { name: 'Renderable2D' };

/** A world as plain data: `{id: {traits}}` plus a child->parent map. No ECS, no renderer. */
function fixture(rows: Record<number, Record<string, Record<string, unknown>>>, parents: Array<[number, number]>) {
  const findEntity = (id: number): GizmoBoundsEntity | null => {
    const traits = rows[id];
    if (!traits) return null;
    return {
      has: (t: unknown) => {
        if (t === TRANSFORM) return 'Transform' in traits;
        if (t === R2D) return 'Renderable2D' in traits;
        return false;
      },
      get: (t: unknown) => (t === TRANSFORM ? traits.Transform : traits.Renderable2D) ?? {},
    };
  };
  return { findEntity, parentOf: new Map(parents), transformTrait: TRANSFORM, r2dTrait: R2D };
}

const tf = (x = 0, y = 0, extra: Record<string, unknown> = {}) => ({ x, y, ...extra });
const disc = (r: number) => ({ width: r, height: r });

describe('descendantUnionGizmoBox2D', () => {
  it('unions a group\'s direct children, centring the box when they are symmetric', () => {
    // Court's `InfoBadge`: ring + fill + a glyph, all at the group's origin. The ring is the widest
    // at half-extent 33.4, so the box is 66.8 across and the pivot stays centred.
    const deps = fixture({
      1: { Transform: tf() },                                  // the group (no visual)
      2: { Transform: tf(), Renderable2D: disc(33.4) },
      3: { Transform: tf(), Renderable2D: disc(30.4) },
    }, [[2, 1], [3, 1]]);
    const box = descendantUnionGizmoBox2D(1, deps)!;
    expect(box, 'a Transform-only group must still get a box').not.toBeNull();
    expect(box.halfW).toBeCloseTo(33.4, 6);
    expect(box.halfH).toBeCloseTo(33.4, 6);
    expect(box.pivotX, 'symmetric children -> centred pivot').toBeCloseTo(0.5, 6);
    expect(box.pivotY).toBeCloseTo(0.5, 6);
  });

  it('recurses through NESTED groups — a group of groups', () => {
    // Court's `ChipRow` holds a group per dot, and each dot group holds ring + fill. Dropping the
    // recursion would silently shrink the box to whichever children happen to be DIRECT — here, to
    // nothing at all, since both direct children are themselves visual-less groups.
    const deps = fixture({
      1: { Transform: tf() },                                  // ChipRow
      2: { Transform: tf(-15.6, 0) },                          // ChipDot0 (group)
      3: { Transform: tf(), Renderable2D: disc(15) },           //   ring
      4: { Transform: tf(15.6, 0) },                           // ChipDot1 (group)
      5: { Transform: tf(), Renderable2D: disc(15) },           //   ring
    }, [[2, 1], [3, 2], [4, 1], [5, 4]]);
    const box = descendantUnionGizmoBox2D(1, deps)!;
    expect(box.halfW, 'spans both dots: 15.6 + 15').toBeCloseTo(30.6, 6);
    expect(box.halfH, 'but only one dot tall').toBeCloseTo(15, 6);
  });

  it('expresses an ASYMMETRIC union through the pivot, keeping the box on the entity\'s transform', () => {
    // One child, offset. The box must hug the child while the gizmo still sits at the group's own
    // origin — that transform is what a drag edits, so moving the box instead would detach the
    // handles from the thing they change.
    const deps = fixture({
      1: { Transform: tf() },
      2: { Transform: tf(100, 0), Renderable2D: disc(10) },
    }, [[2, 1]]);
    const box = descendantUnionGizmoBox2D(1, deps)!;
    expect(box.halfW).toBeCloseTo(10, 6);
    // Union spans x 90..110, so the entity's origin (0) sits far to the LEFT of the box: pivot
    // -minX/width = -90/20 = -4.5. A negative pivot is correct and meaningful here.
    expect(box.pivotX).toBeCloseTo(-4.5, 6);
  });

  it('composes SCALE down the chain', () => {
    const deps = fixture({
      1: { Transform: tf() },
      2: { Transform: tf(0, 0, { sx: 2, sy: 3 }) },
      3: { Transform: tf(), Renderable2D: disc(10) },
    }, [[2, 1], [3, 2]]);
    const box = descendantUnionGizmoBox2D(1, deps)!;
    expect(box.halfW, '10 x sx 2').toBeCloseTo(20, 6);
    expect(box.halfH, '10 x sy 3').toBeCloseTo(30, 6);
  });

  it('skips a hidden child — the box hugs what you can SEE', () => {
    const deps = fixture({
      1: { Transform: tf() },
      2: { Transform: tf(), Renderable2D: disc(10) },
      3: { Transform: tf(500, 0), Renderable2D: { ...disc(10), isVisible: false } },
    }, [[2, 1], [3, 1]]);
    expect(descendantUnionGizmoBox2D(1, deps)!.halfW).toBeCloseTo(10, 6);
  });

  it('returns null when there is nothing visual to bound', () => {
    // Not zero-sized — NULL, so the caller keeps its "no gizmo" path for a genuinely empty entity
    // instead of drawing a degenerate box at the origin.
    const deps = fixture({ 1: { Transform: tf() }, 2: { Transform: tf(5, 5) } }, [[2, 1]]);
    expect(descendantUnionGizmoBox2D(1, deps)).toBeNull();
    expect(descendantUnionGizmoBox2D(1, fixture({ 1: { Transform: tf() } }, [])), 'no children at all').toBeNull();
  });

  it('survives a CYCLIC parent chain instead of hanging the render loop', () => {
    // A malformed chain must not recurse forever — this runs inside a draw, so a hang is a frozen
    // editor rather than an exception someone notices.
    const deps = fixture({
      1: { Transform: tf() },
      2: { Transform: tf(1, 0), Renderable2D: disc(4) },
    }, [[2, 1], [1, 2]]);   // 1 -> 2 -> 1
    expect(() => descendantUnionGizmoBox2D(1, deps)).not.toThrow();
  });
});
