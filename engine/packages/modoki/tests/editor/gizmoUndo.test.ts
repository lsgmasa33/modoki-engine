/** buildTransformUndoAction — the single per-drag Transform undo step both gizmos push
 *  at drag end (gizmos: one-undo-per-drag). Asserts a drag yields ONE action whose undo
 *  restores the start fields and redo restores the end fields, merged onto the live
 *  transform (siblings untouched), re-resolving the entity each time. */
import { describe, it, expect, vi } from 'vitest';
import { buildTransformUndoAction, buildGroupTransformUndoAction, type UndoEntity } from '../../src/editor/scene/gizmoUndo';

const TRAIT = { name: 'Transform' };

function fakeEntity(initial: Record<string, number>): UndoEntity & { value: Record<string, number> } {
  const e = {
    value: { ...initial },
    has: () => true,
    get: () => e.value,
    set: (_t: unknown, v: Record<string, number>) => { e.value = v; },
  };
  return e;
}

describe('buildTransformUndoAction', () => {
  it('undo restores the before-fields, redo restores the after-fields (one action per drag)', () => {
    const e = fakeEntity({ x: 0, y: 0, rz: 0, sx: 1, sy: 1 });
    const action = buildTransformUndoAction({
      label: 'Transform "Box"', trait: TRAIT,
      resolve: () => 7, findEntity: () => e,
      before: { x: 0, y: 0 }, after: { x: 5, y: 3 },
    });
    expect(action.label).toBe('Transform "Box"');

    action.redo(); // re-apply the drag's end state
    expect(e.value).toMatchObject({ x: 5, y: 3 });
    action.undo(); // back to start
    expect(e.value).toMatchObject({ x: 0, y: 0 });
  });

  it('MERGES the field set onto the live transform — does not clobber sibling fields', () => {
    const e = fakeEntity({ x: 0, y: 0, rz: 0, sx: 1, sy: 1 });
    const action = buildTransformUndoAction({
      label: 'rotate', trait: TRAIT, resolve: () => 1, findEntity: () => e,
      before: { rz: 0 }, after: { rz: 1.57 },
    });
    // simulate an unrelated scale edit landing between the drag and the undo
    e.value = { ...e.value, sx: 2, sy: 2 };
    action.undo();
    expect(e.value.rz).toBe(0);     // the dragged field reverted
    expect(e.value.sx).toBe(2);     // the sibling edit preserved
    expect(e.value.sy).toBe(2);
  });

  it('re-resolves the entity each call and no-ops when it is gone', () => {
    const resolve = vi.fn<() => number | null>(() => null);
    const findEntity = vi.fn(() => undefined);
    const action = buildTransformUndoAction({
      label: 'x', trait: TRAIT, resolve, findEntity, before: { x: 0 }, after: { x: 1 },
    });
    expect(() => { action.undo(); action.redo(); }).not.toThrow();
    expect(resolve).toHaveBeenCalledTimes(2); // resolved fresh on each apply, not captured
    expect(findEntity).not.toHaveBeenCalled(); // short-circuits on a null id
  });

  it('skips the write when the resolved entity lacks the trait', () => {
    const e = { ...fakeEntity({ x: 0 }), has: () => false };
    const set = vi.spyOn(e, 'set');
    const action = buildTransformUndoAction({
      label: 'x', trait: TRAIT, resolve: () => 3, findEntity: () => e, before: { x: 0 }, after: { x: 1 },
    });
    action.redo();
    expect(set).not.toHaveBeenCalled();
  });

  // Percept V2b: journalling a gizmo drag as !transform.
  it('tags !transform with a {entity, before, after} payload when given entityGuid', () => {
    const action = buildTransformUndoAction({
      label: 'Transform "Box"', trait: TRAIT, resolve: () => 7, findEntity: () => fakeEntity({}),
      before: { x: 0, y: 0, z: 0 }, after: { x: 5, y: 3, z: 0 }, entityGuid: 'g-box',
    });
    expect(action.kind).toBe('!transform');
    expect(action.journalPayload).toEqual({ entity: 'g-box', before: { x: 0, y: 0, z: 0 }, after: { x: 5, y: 3, z: 0 } });
    // Payload holds its OWN copy of before/after (snapshot), not the caller's references.
    expect((action.journalPayload!.before as Record<string, number>)).not.toBe(undefined);
  });

  it('omits kind/journalPayload when no entityGuid (falls back to a bare !edit)', () => {
    const action = buildTransformUndoAction({
      label: 'x', trait: TRAIT, resolve: () => 1, findEntity: () => fakeEntity({}),
      before: { x: 0 }, after: { x: 1 },
    });
    expect(action.kind).toBeUndefined();
    expect(action.journalPayload).toBeUndefined();
  });
});

describe('buildGroupTransformUndoAction', () => {
  it('undo/redo of the group runs EVERY member action (one step for N members)', () => {
    const a = fakeEntity({ x: 0 }), b = fakeEntity({ x: 10 });
    const actions = [
      buildTransformUndoAction({ label: 'A', trait: TRAIT, resolve: () => 1, findEntity: () => a, before: { x: 0 }, after: { x: 3 }, entityGuid: 'g-a' }),
      buildTransformUndoAction({ label: 'B', trait: TRAIT, resolve: () => 2, findEntity: () => b, before: { x: 10 }, after: { x: 13 }, entityGuid: 'g-b' }),
    ];
    const group = buildGroupTransformUndoAction('Transform 2 entities', actions);
    expect(group.label).toBe('Transform 2 entities');

    group.redo();
    expect(a.value.x).toBe(3); expect(b.value.x).toBe(13);
    group.undo();
    expect(a.value.x).toBe(0); expect(b.value.x).toBe(10);
  });

  it('journals a single !transform carrying every member guid + before/after', () => {
    const actions = [
      buildTransformUndoAction({ label: 'A', trait: TRAIT, resolve: () => 1, findEntity: () => fakeEntity({}), before: { x: 0 }, after: { x: 3 }, entityGuid: 'g-a' }),
      buildTransformUndoAction({ label: 'B', trait: TRAIT, resolve: () => 2, findEntity: () => fakeEntity({}), before: { x: 10 }, after: { x: 13 }, entityGuid: 'g-b' }),
    ];
    const group = buildGroupTransformUndoAction('Transform 2 entities', actions);
    expect(group.kind).toBe('!transform');
    expect((group.journalPayload as { entities: string[] }).entities).toEqual(['g-a', 'g-b']);
    expect((group.journalPayload as { members: unknown[] }).members).toHaveLength(2);
  });
});
