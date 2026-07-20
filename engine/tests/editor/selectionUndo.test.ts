/** Tests for selection undo — separate entries with coalescing */

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '@modoki/engine/editor';
import { clearHistory, undo, redo, canUndo, pushAction } from '@modoki/engine/editor';

describe('selection undo', () => {
  beforeEach(() => {
    // Reset selection without pushing undo, then clear history
    useEditorStore.setState({ selectedEntityId: null, selectedAsset: null });
    clearHistory();
  });

  it('selecting an entity pushes an undo entry', () => {
    useEditorStore.getState().selectEntity(42);
    expect(canUndo()).toBe(true);
  });

  it('undo restores previous selection', async () => {
    useEditorStore.getState().selectEntity(1);
    useEditorStore.getState().selectEntity(2);

    await undo(); // undo select 2 → back to 1
    expect(useEditorStore.getState().selectedEntityId).toBe(1);
  });

  it('redo re-applies selection', async () => {
    useEditorStore.getState().selectEntity(1);
    useEditorStore.getState().selectEntity(2);

    await undo(); // back to 1
    expect(useEditorStore.getState().selectedEntityId).toBe(1);

    await redo(); // forward to 2
    expect(useEditorStore.getState().selectedEntityId).toBe(2);
  });

  it('each selection gets its own undo entry', async () => {
    useEditorStore.getState().selectEntity(1);
    useEditorStore.getState().selectEntity(2);
    useEditorStore.getState().selectEntity(3);
    useEditorStore.getState().selectEntity(4);

    // 4 selections = 4 undo entries
    await undo(); expect(useEditorStore.getState().selectedEntityId).toBe(3);
    await undo(); expect(useEditorStore.getState().selectedEntityId).toBe(2);
    await undo(); expect(useEditorStore.getState().selectedEntityId).toBe(1);
    await undo(); expect(useEditorStore.getState().selectedEntityId).toBe(null);
  });

  it('selection between edits creates separate entries', async () => {
    useEditorStore.getState().selectEntity(1);

    // Push a non-selection action (simulating a field edit)
    let val = 0;
    pushAction({ label: 'edit', undo: () => { val = 0; }, redo: () => { val = 1; } });
    val = 1;

    useEditorStore.getState().selectEntity(2);

    // Undo sequence: undo select 2 → undo edit → undo select 1
    await undo(); // undo select 2
    expect(useEditorStore.getState().selectedEntityId).toBe(1);

    await undo(); // undo edit
    expect(val).toBe(0);

    await undo(); // undo select 1
    expect(useEditorStore.getState().selectedEntityId).toBe(null);
  });

  it('selecting same entity twice does not push', () => {
    useEditorStore.getState().selectEntity(5);
    clearHistory(); // clear the select push
    useEditorStore.getState().selectEntity(5); // same entity — no change
    expect(canUndo()).toBe(false);
  });

  it('asset selection creates undo entry', async () => {
    useEditorStore.getState().selectAsset({ path: '/test.glb', type: 'model', name: 'Test' });
    expect(canUndo()).toBe(true);

    await undo();
    expect(useEditorStore.getState().selectedAsset).toBeNull();
  });

  it('switching between entity and asset selection undoes correctly', async () => {
    useEditorStore.getState().selectEntity(10);
    useEditorStore.getState().selectAsset({ path: '/a.glb', type: 'model', name: 'A' });

    await undo(); // undo asset select → back to entity 10
    expect(useEditorStore.getState().selectedEntityId).toBe(10);
    expect(useEditorStore.getState().selectedAsset).toBeNull();
  });
});
