/** Tests for generic entity introspection — read/write traits without direct imports. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerTrait, getAllTraits,
} from '@modoki/engine/runtime';

// We need to test against the real world since entityIntrospect uses it.
// Import the actual module which depends on world.
import { getCurrentWorld } from '@modoki/engine/runtime';
import {
  getEntityTraits, readTraitData, writeTraitField, getAllEntities, deleteEntity,
} from '@modoki/engine/runtime';

// Register test traits (using real game traits for integration testing)
import { Transform, Renderable3D, Paused } from '@modoki/engine/runtime';

// Ensure traits are registered
registerTrait({
  name: 'Transform', trait: Transform, category: 'component',
  fields: {
    x: { type: 'number', step: 0.1 },
    y: { type: 'number', step: 0.1 },
    z: { type: 'number', step: 0.1 },
    rx: { type: 'number', step: 0.01 },
    ry: { type: 'number', step: 0.01 },
    rz: { type: 'number', step: 0.01 },
    sx: { type: 'number', step: 0.1 },
    sy: { type: 'number', step: 0.1 },
    sz: { type: 'number', step: 0.1 },
  },
});
registerTrait({
  name: 'Renderable3D', trait: Renderable3D, category: 'component',
  fields: {
    mesh: { type: 'string' },
    material: { type: 'string' },
    isVisible: { type: 'boolean' },
  },
});
registerTrait({ name: 'Paused', trait: Paused, category: 'tag', fields: {} });

describe('entityIntrospect', () => {
  let entityId: number;

  beforeEach(() => {
    // Spawn a test entity
    const entity = getCurrentWorld().spawn(
      Transform({ x: 1, y: 2, z: 3 }),
      Renderable3D({ mesh: 'test-cube' }),
    );
    entityId = entity.id();
  });

  it('getEntityTraits returns all traits on an entity', () => {
    const traits = getEntityTraits(entityId);
    const names = traits.map((t) => t.name);
    expect(names).toContain('Transform');
    expect(names).toContain('Renderable3D');
    expect(names).not.toContain('Paused');
  });

  it('readTraitData reads Transform values', () => {
    const meta = getAllTraits().find((t) => t.name === 'Transform')!;
    const data = readTraitData(entityId, meta);
    expect(data).not.toBeNull();
    expect(data!['x']).toBe(1);
    expect(data!['y']).toBe(2);
    expect(data!['z']).toBe(3);
  });

  it('readTraitData reads Renderable3D values', () => {
    const meta = getAllTraits().find((t) => t.name === 'Renderable3D')!;
    const data = readTraitData(entityId, meta);
    expect(data!['mesh']).toBe('test-cube');
    expect(data!['isVisible']).toBe(true);
  });

  it('writeTraitField updates a number field', () => {
    const meta = getAllTraits().find((t) => t.name === 'Transform')!;
    writeTraitField(entityId, meta, 'x', 99);
    const data = readTraitData(entityId, meta);
    expect(data!['x']).toBe(99);
  });

  it('writeTraitField updates a string field', () => {
    const meta = getAllTraits().find((t) => t.name === 'Renderable3D')!;
    writeTraitField(entityId, meta, 'mesh', 'new-name');
    const data = readTraitData(entityId, meta);
    expect(data!['mesh']).toBe('new-name');
  });

  it('writeTraitField adds a tag', () => {
    const pausedMeta = getAllTraits().find((t) => t.name === 'Paused')!;
    writeTraitField(entityId, pausedMeta, '', true);
    const traits = getEntityTraits(entityId);
    expect(traits.map((t) => t.name)).toContain('Paused');
  });

  it('writeTraitField removes a tag', () => {
    const pausedMeta = getAllTraits().find((t) => t.name === 'Paused')!;
    writeTraitField(entityId, pausedMeta, '', true); // add
    writeTraitField(entityId, pausedMeta, '', false); // remove
    const traits = getEntityTraits(entityId);
    expect(traits.map((t) => t.name)).not.toContain('Paused');
  });

  it('getAllEntities returns spawned entities', () => {
    const entities = getAllEntities();
    const found = entities.find((e) => e.id === entityId);
    expect(found).toBeDefined();
    expect(found!.name).toBe('test-cube'); // first string field value
    expect(found!.traits).toContain('Transform');
    expect(found!.traits).toContain('Renderable3D');
  });

  it('deleteEntity removes the entity', () => {
    deleteEntity(entityId);
    const traits = getEntityTraits(entityId);
    expect(traits).toHaveLength(0);
  });

  it('readTraitData returns null for non-existent entity', () => {
    const meta = getAllTraits().find((t) => t.name === 'Transform')!;
    const data = readTraitData(999999, meta);
    expect(data).toBeNull();
  });
});
