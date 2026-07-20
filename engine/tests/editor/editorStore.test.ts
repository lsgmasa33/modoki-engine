/** Tests for the editor store — selection, gizmo mode, game view size. */

import { describe, it, expect } from 'vitest';
import { useEditorStore } from '@modoki/engine/editor';

describe('editorStore', () => {
  it('defaults to no selection', () => {
    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it('selectEntity updates selectedEntityId', () => {
    useEditorStore.getState().selectEntity(42);
    expect(useEditorStore.getState().selectedEntityId).toBe(42);
    useEditorStore.getState().selectEntity(null);
    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it('defaults gizmo mode to translate', () => {
    expect(useEditorStore.getState().gizmoMode).toBe('translate');
  });

  it('setGizmoMode updates mode', () => {
    useEditorStore.getState().setGizmoMode('rotate');
    expect(useEditorStore.getState().gizmoMode).toBe('rotate');
    useEditorStore.getState().setGizmoMode('translate');
  });

  it('defaults gameViewSize', () => {
    const size = useEditorStore.getState().gameViewSize;
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it('setGameViewSize updates dimensions', () => {
    useEditorStore.getState().setGameViewSize(393, 852);
    const size = useEditorStore.getState().gameViewSize;
    expect(size.width).toBe(393);
    expect(size.height).toBe(852);
  });

  it('gameViewSize aspect ratio is correct', () => {
    useEditorStore.getState().setGameViewSize(1920, 1080);
    const { width, height } = useEditorStore.getState().gameViewSize;
    const aspect = width / height;
    expect(aspect).toBeCloseTo(16 / 9, 2);
  });
});
