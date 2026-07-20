/** Tests for reparentEntity — reparenting with world-preserving transforms + sort order */

import { describe, it, expect, beforeEach } from 'vitest';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { Transform, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { readTraitData, getAllEntities, buildEntityTree } from '@modoki/engine/runtime';
import { reparentEntity, setActionCallback } from '@modoki/engine/editor';
import { getTraitByName } from '@modoki/engine/runtime';
import { pushAction, clearHistory, undo, redo, canUndo } from '@modoki/engine/editor';
import { worldTransforms } from '@modoki/engine/three';

registerAllTraits();
setActionCallback(pushAction);

describe('reparentEntity', () => {
  let parentId: number;
  let childId: number;
  let siblingId: number;

  beforeEach(() => {
    clearHistory();
    const parent = getCurrentWorld().spawn(
      Transform({ x: 10, y: 0, z: 0 }),
      EntityAttributes({ name: 'Parent', sortOrder: 0 }),
    );
    parentId = parent.id();

    const child = getCurrentWorld().spawn(
      Transform({ x: 5, y: 0, z: 0 }),
      EntityAttributes({ name: 'Child', sortOrder: 0, parentId: parentId }),
    );
    childId = child.id();

    const sibling = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'Sibling', sortOrder: 1 }),
    );
    siblingId = sibling.id();

    // Populate worldTransforms for the test entities
    worldTransforms.set(parentId, { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    worldTransforms.set(childId, { x: 15, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    worldTransforms.set(siblingId, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  });

  it('rejects reparenting to self', () => {
    expect(reparentEntity(parentId, parentId)).toBe(false);
  });

  it('rejects reparenting to a descendant (cycle prevention)', () => {
    // child is a descendant of parent — can't make parent a child of child
    expect(reparentEntity(parentId, childId)).toBe(false);
  });

  it('reparents child to root (parentId = 0)', () => {
    const result = reparentEntity(childId, 0);
    expect(result).toBe(true);

    const ea = readTraitData(childId, getTraitByName('EntityAttributes')!);
    expect(ea!['parentId']).toBe(0);
  });

  it('preserves world position when reparenting to root', () => {
    reparentEntity(childId, 0);
    const tf = readTraitData(childId, getTraitByName('Transform')!);
    // World pos was (15,0,0) — after unparenting, local should equal world
    expect(tf!['x']).toBeCloseTo(15, 4);
    expect(tf!['y']).toBeCloseTo(0, 4);
    expect(tf!['z']).toBeCloseTo(0, 4);
  });

  it('preserves world position when reparenting to new parent', () => {
    // Move sibling (world 0,0,0) under parent (world 10,0,0)
    reparentEntity(siblingId, parentId);
    const ea = readTraitData(siblingId, getTraitByName('EntityAttributes')!);
    expect(ea!['parentId']).toBe(parentId);
    const tf = readTraitData(siblingId, getTraitByName('Transform')!);
    // New local = world(0,0,0) - parent(10,0,0) = (-10,0,0)
    expect(tf!['x']).toBeCloseTo(-10, 4);
  });

  it('returns false when parent does not change', () => {
    expect(reparentEntity(childId, parentId)).toBe(false);
  });

  it('updates sortOrder when provided', () => {
    reparentEntity(siblingId, 0, 42);
    const attr = readTraitData(siblingId, getTraitByName('EntityAttributes')!);
    expect(attr!['sortOrder']).toBe(42);
  });

  it('reorders within same parent (sort only, no transform change)', () => {
    const child2 = getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      EntityAttributes({ name: 'Child2', sortOrder: 5, parentId: parentId }),
    );
    worldTransforms.set(child2.id(), { x: 11, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

    // Reorder child under same parent with different sortOrder
    const result = reparentEntity(childId, parentId, 10);
    expect(result).toBe(true);
    const attr = readTraitData(childId, getTraitByName('EntityAttributes')!);
    expect(attr!['sortOrder']).toBe(10);
    // Local transform should NOT change (same parent)
    const tf = readTraitData(childId, getTraitByName('Transform')!);
    expect(tf!['x']).toBe(5); // unchanged
  });

  it('pushes undo action', () => {
    reparentEntity(childId, 0);
    expect(canUndo()).toBe(true);
  });

  it('undo restores original parent and local transform', async () => {
    const tfBefore = { ...readTraitData(childId, getTraitByName('Transform')!)! };
    reparentEntity(childId, 0);
    await undo();
    const eaAfter = readTraitData(childId, getTraitByName('EntityAttributes')!);
    expect(eaAfter!['parentId']).toBe(parentId);
    const tfAfter = readTraitData(childId, getTraitByName('Transform')!);
    expect(tfAfter!['x']).toBe(tfBefore['x']);
  });

  it('redo re-applies reparent', async () => {
    reparentEntity(childId, 0);
    await undo();
    await redo();
    const ea = readTraitData(childId, getTraitByName('EntityAttributes')!);
    expect(ea!['parentId']).toBe(0);
    const tf = readTraitData(childId, getTraitByName('Transform')!);
    expect(tf!['x']).toBeCloseTo(15, 4);
  });
});

describe('buildEntityTree sortOrder', () => {
  it('sorts children by sortOrder', () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      EntityAttributes({ name: 'TreeParent', sortOrder: 0 }),
    );
    const pid = parent.id();

    getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'C', sortOrder: 3, parentId: pid }));
    getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'A', sortOrder: 1, parentId: pid }));
    getCurrentWorld().spawn(Transform({ x: 0, y: 0, z: 0 }), EntityAttributes({ name: 'B', sortOrder: 2, parentId: pid }));

    const tree = buildEntityTree(getAllEntities());
    const parentNode = tree.find(n => n.name === 'TreeParent');
    expect(parentNode).toBeDefined();
    const childNames = parentNode!.children!.map(c => c.name);
    expect(childNames).toEqual(['A', 'B', 'C']);
  });
});
