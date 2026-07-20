/** Phase 1 — entity lifecycle + undo.
 *  createEntityWithUndo: spawn from trait specs, select, and create/delete undo. */

import { describe, it, expect, beforeEach } from 'vitest';
import { getAllEntities, getEntityTraits, readTraitData, getTraitByName } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { createEntityWithUndo, setActionCallback } from '@modoki/engine/editor';
import { pushAction, clearHistory, undo, redo, canUndo, undoLabel } from '@modoki/engine/editor';

registerAllTraits();
setActionCallback(pushAction);

/** Capture the most recent selection so we can assert create/undo selects correctly. */
let selected: number | null = null;
const select = (id: number | null) => { selected = id; };

beforeEach(() => {
  clearHistory();
  selected = null;
});

describe('createEntityWithUndo', () => {
  it('spawns an entity with the requested traits and selects it', () => {
    const id = createEntityWithUndo('Create Entity', 0, [
      { name: 'Transform', data: {} },
      { name: 'EntityAttributes', data: { name: 'Fresh', layer: '3d' } },
    ], select);

    expect(id).not.toBeNull();
    const traits = getEntityTraits(id!).map(t => t.name);
    expect(traits).toContain('Transform');
    expect(traits).toContain('EntityAttributes');
    expect(selected).toBe(id);
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toBe('Create Entity');
  });

  it('applies trait field data passed in the spec', () => {
    const id = createEntityWithUndo('Create Primitive', 0, [
      { name: 'Transform', data: { x: 3, y: 4 } },
      { name: 'EntityAttributes', data: { name: 'Prim', layer: '3d' } },
      { name: 'Renderable3DPrimitive', data: { mesh: 'sphere', size: 2, color: 0x123456, isActive: true } },
    ], select);

    const tf = readTraitData(id!, getTraitByName('Transform')!)!;
    expect(tf.x).toBe(3);
    expect(tf.y).toBe(4);
    const prim = readTraitData(id!, getTraitByName('Renderable3DPrimitive')!)!;
    expect(prim.mesh).toBe('sphere');
    expect(prim.size).toBe(2);
  });

  it('auto-assigns an increasing sortOrder per sibling under the same parent', () => {
    const a = createEntityWithUndo('A', 0, [{ name: 'EntityAttributes', data: { name: 'SortA' } }], select);
    const b = createEntityWithUndo('B', 0, [{ name: 'EntityAttributes', data: { name: 'SortB' } }], select);

    const ea = getTraitByName('EntityAttributes')!;
    const sortA = readTraitData(a!, ea)!.sortOrder as number;
    const sortB = readTraitData(b!, ea)!.sortOrder as number;
    expect(sortB).toBeGreaterThan(sortA);
  });

  it('undo deletes the entity and clears selection', async () => {
    const id = createEntityWithUndo('Create Entity', 0, [
      { name: 'EntityAttributes', data: { name: 'UndoMe' } },
    ], select);
    expect(getEntityTraits(id!).length).toBeGreaterThan(0);

    await undo();

    expect(getEntityTraits(id!)).toHaveLength(0);
    expect(getAllEntities().find(e => e.name === 'UndoMe')).toBeUndefined();
    expect(selected).toBeNull();
  });

  it('redo re-creates the entity and reselects it', async () => {
    createEntityWithUndo('Create Entity', 0, [
      { name: 'Transform', data: { x: 9 } },
      { name: 'EntityAttributes', data: { name: 'RedoMe' } },
    ], select);
    await undo();
    expect(getAllEntities().find(e => e.name === 'RedoMe')).toBeUndefined();

    await redo();

    const restored = getAllEntities().find(e => e.name === 'RedoMe');
    expect(restored).toBeDefined();
    expect(restored!.traits).toContain('Transform');
    // Redo respawns a fresh entity and selects it.
    expect(selected).toBe(restored!.id);
  });

  it('returns null and creates nothing when a trait is not registered', () => {
    const before = getAllEntities().length;
    const id = createEntityWithUndo('Bad', 0, [
      { name: 'NotARealTrait', data: {} },
    ], select);

    expect(id).toBeNull();
    expect(getAllEntities().length).toBe(before);
    expect(canUndo()).toBe(false);
  });
});
