/** Tests for parent-child entity hierarchy. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { Transform, Renderable3D, EntityAttributes } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getAllEntities, buildEntityTree } from '@modoki/engine/runtime';

registerAllTraits();

describe('entity hierarchy', () => {
  it('entities with parentId=0 are roots', () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: 'root-entity', color: 0xffffff, size: 1 }),
      EntityAttributes({ name: 'root-entity', parentId: 0, layer: '3d' }),
    );

    const entities = getAllEntities();
    const found = entities.find((e) => e.id === parent.id());
    expect(found!.parentId).toBe(0);
  });

  it('child entities reference parent via parentId', () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: 'parent-mesh', color: 0xff0000, size: 1 }),
      EntityAttributes({ name: 'parent-mesh', layer: '3d' }),
    );
    const child = getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      Renderable3D({ mesh: 'child-mesh', color: 0x00ff00, size: 0.5 }),
      EntityAttributes({ name: 'child-mesh', layer: '3d', parentId: parent.id() }),
    );

    const entities = getAllEntities();
    const childInfo = entities.find((e) => e.id === child.id());
    expect(childInfo!.parentId).toBe(parent.id());
  });

  it('buildEntityTree nests children under parents', () => {
    const parent = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: 'tree-parent', color: 0xff0000, size: 1 }),
      EntityAttributes({ name: 'tree-parent', layer: '3d' }),
    );
    const child1 = getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      Renderable3D({ mesh: 'tree-child-1', color: 0x00ff00, size: 0.5 }),
      EntityAttributes({ name: 'tree-child-1', layer: '3d', parentId: parent.id() }),
    );
    const child2 = getCurrentWorld().spawn(
      Transform({ x: 2, y: 0, z: 0 }),
      Renderable3D({ mesh: 'tree-child-2', color: 0x0000ff, size: 0.5 }),
      EntityAttributes({ name: 'tree-child-2', layer: '3d', parentId: parent.id() }),
    );

    const flat = getAllEntities();
    const tree = buildEntityTree(flat);

    // Find the parent in the tree
    const parentNode = tree.find((e) => e.id === parent.id());
    expect(parentNode).toBeDefined();
    expect(parentNode!.children).toBeDefined();
    expect(parentNode!.children!.length).toBeGreaterThanOrEqual(2);

    const childIds = parentNode!.children!.map((c) => c.id);
    expect(childIds).toContain(child1.id());
    expect(childIds).toContain(child2.id());
  });

  it('buildEntityTree: orphaned children (invalid parentId) become roots', () => {
    const orphan = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: 'orphan-entity', color: 0xaaaaaa, size: 1 }),
      EntityAttributes({ name: 'orphan-entity', layer: '3d', parentId: 999999 }),
    );

    const flat = getAllEntities();
    const tree = buildEntityTree(flat);

    // Orphan should be at root level
    const found = tree.find((e) => e.id === orphan.id());
    expect(found).toBeDefined();
  });

  it('buildEntityTree: deep nesting (grandchildren)', () => {
    const root = getCurrentWorld().spawn(
      Transform({ x: 0, y: 0, z: 0 }),
      Renderable3D({ mesh: 'deep-root', color: 0xff0000, size: 1 }),
      EntityAttributes({ name: 'deep-root', layer: '3d' }),
    );
    const child = getCurrentWorld().spawn(
      Transform({ x: 1, y: 0, z: 0 }),
      Renderable3D({ mesh: 'deep-child', color: 0x00ff00, size: 0.5 }),
      EntityAttributes({ name: 'deep-child', layer: '3d', parentId: root.id() }),
    );
    const grandchild = getCurrentWorld().spawn(
      Transform({ x: 2, y: 0, z: 0 }),
      Renderable3D({ mesh: 'deep-grandchild', color: 0x0000ff, size: 0.25 }),
      EntityAttributes({ name: 'deep-grandchild', layer: '3d', parentId: child.id() }),
    );

    const flat = getAllEntities();
    const tree = buildEntityTree(flat);

    const rootNode = tree.find((e) => e.id === root.id());
    const childNode = rootNode!.children!.find((c) => c.id === child.id());
    expect(childNode).toBeDefined();
    const grandchildNode = childNode!.children!.find((c) => c.id === grandchild.id());
    expect(grandchildNode).toBeDefined();
    expect(grandchildNode!.name).toBe('deep-grandchild');
  });
});
