/** Tests for the undo/redo system. */

import { describe, it, expect, beforeEach } from 'vitest';
import { pushAction, undo, redo, canUndo, canRedo, undoLabel, redoLabel, clearHistory } from '@modoki/engine/editor';
import { getCurrentWorld } from '@modoki/engine/runtime';
import { Transform, Renderable3D } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getTraitByName } from '@modoki/engine/runtime';
import { readTraitData } from '@modoki/engine/runtime';
import { writeTraitFieldWithUndo, setActionCallback } from '@modoki/engine/editor';

registerAllTraits();
setActionCallback(pushAction);

describe('undoManager', () => {
  beforeEach(() => clearHistory());

  it('starts with empty stacks', () => {
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('pushAction enables undo', () => {
    pushAction({ label: 'test', undo: () => {}, redo: () => {} });
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
    expect(undoLabel()).toBe('test');
  });

  it('undo reverses the action and enables redo', async () => {
    let value = 0;
    pushAction({ label: 'set to 1', undo: () => { value = 0; }, redo: () => { value = 1; } });
    value = 1;

    await undo();
    expect(value).toBe(0);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
    expect(redoLabel()).toBe('set to 1');
  });

  it('redo re-applies the action', async () => {
    let value = 0;
    pushAction({ label: 'set to 1', undo: () => { value = 0; }, redo: () => { value = 1; } });
    value = 1;

    await undo();
    expect(value).toBe(0);
    await redo();
    expect(value).toBe(1);
    expect(canUndo()).toBe(true);
    expect(canRedo()).toBe(false);
  });

  it('new action clears redo stack', async () => {
    pushAction({ label: 'a1', undo: () => {}, redo: () => {} });
    await undo();
    expect(canRedo()).toBe(true);

    pushAction({ label: 'a2', undo: () => {}, redo: () => {} });
    expect(canRedo()).toBe(false);
  });

  it('multiple undo/redo in sequence', async () => {
    const values: number[] = [];
    pushAction({ label: 'a1', undo: () => values.push(1), redo: () => values.push(-1) });
    pushAction({ label: 'a2', undo: () => values.push(2), redo: () => values.push(-2) });
    pushAction({ label: 'a3', undo: () => values.push(3), redo: () => values.push(-3) });

    await undo(); // undo a3
    await undo(); // undo a2
    expect(values).toEqual([3, 2]);

    await redo(); // redo a2
    expect(values).toEqual([3, 2, -2]);
  });

  it('undo returns false when stack is empty', async () => {
    expect(await undo()).toBe(false);
  });

  it('redo returns false when stack is empty', async () => {
    expect(await redo()).toBe(false);
  });

  it('limits stack to 200 actions', async () => {
    for (let i = 0; i < 250; i++) {
      pushAction({ label: `a${i}`, undo: () => {}, redo: () => {} });
    }
    let count = 0;
    while (await undo()) count++;
    expect(count).toBe(200);
  });
});

describe('writeTraitFieldWithUndo', () => {
  beforeEach(() => clearHistory());

  it('writes value and creates undo entry', () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 10, y: 0, z: 0 }),
      Renderable3D({ mesh: 'undo-test', color: 0xff0000, size: 1 }),
    );

    const tfMeta = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(entity.id(), tfMeta, 'x', 99);

    const data = readTraitData(entity.id(), tfMeta);
    expect(data!['x']).toBe(99);
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toContain('Transform.x');
  });

  it('undo restores old value', async () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 5, y: 0, z: 0 }),
    );

    const tfMeta = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(entity.id(), tfMeta, 'x', 42);
    expect(readTraitData(entity.id(), tfMeta)!['x']).toBe(42);

    await undo();
    expect(readTraitData(entity.id(), tfMeta)!['x']).toBe(5);
  });

  it('redo re-applies value', async () => {
    const entity = getCurrentWorld().spawn(
      Transform({ x: 5, y: 0, z: 0 }),
    );

    const tfMeta = getTraitByName('Transform')!;
    writeTraitFieldWithUndo(entity.id(), tfMeta, 'x', 42);
    await undo();
    expect(readTraitData(entity.id(), tfMeta)!['x']).toBe(5);

    await redo();
    expect(readTraitData(entity.id(), tfMeta)!['x']).toBe(42);
  });
});
