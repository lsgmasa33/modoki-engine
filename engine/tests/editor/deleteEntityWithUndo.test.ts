/** Tests for deleteEntityWithUndo — recursive delete with undo/redo snapshot */

import { describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { Transform, Renderable3D, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { deleteEntity, getAllEntities, getEntityTraits } from '@modoki/engine/runtime';
import { deleteEntityWithUndo, setActionCallback } from '@modoki/engine/editor';
import { pushAction, clearHistory, undo, redo, canUndo, undoLabel } from '@modoki/engine/editor';

registerAllTraits();
setActionCallback(pushAction);

describe('deleteEntity (recursive)', () => {
  it('deletes an entity and all its children', () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'DelParent' }),
    );
    const pid = parent.id();
    const child = getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      EntityAttributes({ name: 'DelChild', parentId: pid }),
    );
    const grandchild = getCurrentWorld().spawn(
      Transform({ x: 2, y: 0, z: 0 }),
      EntityAttributes({ name: 'DelGrandchild', parentId: child.id() }),
    );

    deleteEntity(pid);

    expect(getEntityTraits(pid)).toHaveLength(0);
    expect(getEntityTraits(child.id())).toHaveLength(0);
    expect(getEntityTraits(grandchild.id())).toHaveLength(0);
  });

  it('deleting a leaf does not affect siblings', () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'SibParent' }),
    );
    const pid = parent.id();
    const a = getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'SibA', parentId: pid }));
    const b = getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'SibB', parentId: pid }));

    deleteEntity(a.id());

    expect(getEntityTraits(a.id())).toHaveLength(0);
    expect(getEntityTraits(b.id()).length).toBeGreaterThan(0);
  });
});

describe('deleteEntityWithUndo', () => {
  beforeEach(() => clearHistory());

  it('deletes entity and pushes undo action', () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 5, y: 0, z: 0 }),
      Renderable3D({ mesh: 'del-test', color: 0xff0000, size: 1 }),
      EntityAttributes({ name: 'UndoDelTest', layer: '3d' }),
    );
    const id = entity.id();

    deleteEntityWithUndo(id);
    expect(getEntityTraits(id)).toHaveLength(0);
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toBe('Delete Entity');
  });

  it('undo restores entity with all traits', async () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 7, y: 8, z: 9 }),
      Renderable3D({ mesh: 'restore-test', color: 0x00ff00, size: 2 }),
      EntityAttributes({ name: 'RestoreMe', layer: '3d' }),
    );
    const id = entity.id();

    deleteEntityWithUndo(id);
    await undo();

    // Entity should be restored — find by name
    const all = getAllEntities();
    const restored = all.find(e => e.name === 'RestoreMe');
    expect(restored).toBeDefined();
    expect(restored!.traits).toContain('Transform');
    expect(restored!.traits).toContain('Renderable3D');
    expect(restored!.traits).toContain('EntityAttributes');
  });

  it('undo restores entity tree (parent + children)', async () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'TreeRoot' }),
    );
    const pid = parent.id();
    getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      EntityAttributes({ name: 'TreeChild1', parentId: pid }),
    );
    getCurrentWorld().spawn(
      Transform({ x: 2, y: 0, z: 0 }),
      EntityAttributes({ name: 'TreeChild2', parentId: pid }),
    );

    deleteEntityWithUndo(pid);

    // All gone
    const afterDelete = getAllEntities();
    expect(afterDelete.find(e => e.name === 'TreeRoot')).toBeUndefined();
    expect(afterDelete.find(e => e.name === 'TreeChild1')).toBeUndefined();

    // Undo restores all
    await undo();
    const afterUndo = getAllEntities();
    expect(afterUndo.find(e => e.name === 'TreeRoot')).toBeDefined();
    expect(afterUndo.find(e => e.name === 'TreeChild1')).toBeDefined();
    expect(afterUndo.find(e => e.name === 'TreeChild2')).toBeDefined();
  });

  it('redo re-deletes the entity', async () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'RedoDelTest' }),
    );
    deleteEntityWithUndo(entity.id());
    await undo();

    const before = getAllEntities().find(e => e.name === 'RedoDelTest');
    expect(before).toBeDefined();

    await redo();
    const after = getAllEntities().find(e => e.name === 'RedoDelTest');
    expect(after).toBeUndefined();
  });
});
