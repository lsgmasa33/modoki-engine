// @vitest-environment jsdom
/** PanelFocusHost — click-to-focus.
 *
 *  Package default env is `node`, so the jsdom pragma above is required. This is the
 *  first editor test in the repo that dispatches a real pointer event at a panel
 *  wrapper; the existing jsdom panel tests mount components but
 *  never drive input. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const emitted: { type: string; payload?: unknown }[] = [];
vi.mock('../../src/editor/editorJournal', () => ({
  editorEmit: (type: string, payload?: unknown) => { emitted.push({ type, payload }); },
  withEditorActor: (_a: string, fn: () => unknown) => fn(),
}));
// Selection undo plumbing is irrelevant here and drags in the whole undo stack.
vi.mock('../../src/editor/undo/undoManager', () => ({
  pushSelectionChange: () => {},
  isExecutingUndoRedo: () => false,
}));

const { PanelFocusHost } = await import('../../src/editor/input/PanelFocusHost');
const { useEditorStore } = await import('../../src/editor/store/editorStore');

beforeEach(() => {
  emitted.length = 0;
  useEditorStore.setState({ focusedPanel: null });
});

describe('PanelFocusHost', () => {
  it('records the clicked panel as focused', () => {
    const { getByText } = render(
      <PanelFocusHost id="hierarchy"><div>tree</div></PanelFocusHost>,
    );
    expect(useEditorStore.getState().focusedPanel).toBeNull();
    fireEvent.pointerDown(getByText('tree'));
    expect(useEditorStore.getState().focusedPanel).toBe('hierarchy');
  });

  it('stamps data-panel-scope for scope resolution', () => {
    const { container } = render(
      <PanelFocusHost id="animation-editor"><div>keys</div></PanelFocusHost>,
    );
    expect(container.querySelector('[data-panel-scope="animation-editor"]')).not.toBeNull();
  });

  it('does NOT stamp the legacy data-editor-panel attribute', () => {
    // P2 must stay inert: Hierarchy.tsx:860 READS that attribute to decide whether to
    // yield, so stamping it on every panel would silently change an existing guard.
    const { container } = render(
      <PanelFocusHost id="scene"><div>viewport</div></PanelFocusHost>,
    );
    expect(container.querySelector('[data-editor-panel]')).toBeNull();
  });

  it('marks the focused host so the CSS ring can target it', () => {
    const { container, rerender } = render(
      <PanelFocusHost id="assets"><div>files</div></PanelFocusHost>,
    );
    expect(container.querySelector('[data-panel-focused="true"]')).toBeNull();
    useEditorStore.setState({ focusedPanel: 'assets' });
    rerender(<PanelFocusHost id="assets"><div>files</div></PanelFocusHost>);
    expect(container.querySelector('[data-panel-focused="true"]')).not.toBeNull();
  });

  it('does not consume the click — the panel still receives it', () => {
    // Mouse is never focus-FILTERED, only focus-SETTING. Swallowing mousedown here
    // would break every drag, gizmo grab and row selection in the editor.
    const onMouseDown = vi.fn();
    const { getByText } = render(
      <PanelFocusHost id="scene"><div onMouseDown={onMouseDown}>viewport</div></PanelFocusHost>,
    );
    fireEvent.mouseDown(getByText('viewport'));
    expect(onMouseDown).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().focusedPanel).toBe('scene');
  });

  it('focuses on POINTERdown, not only mousedown — REGRESSION', () => {
    // Found by live verification, not by this suite: the first implementation listened
    // for mousedown only, and clicking the SceneView canvas set no focus at all. Canvas
    // pointer handlers call preventDefault() on pointerdown, which SUPPRESSES the
    // compatibility mouse events — so mousedown never arrives on exactly the panels that
    // matter most. fireEvent.mouseDown passed anyway, which is why this test fires
    // pointerDown ALONE and asserts nothing else was needed.
    const { getByText } = render(
      <PanelFocusHost id="scene"><div>viewport</div></PanelFocusHost>,
    );
    fireEvent.pointerDown(getByText('viewport'));
    expect(useEditorStore.getState().focusedPanel).toBe('scene');
  });

  it('journals !focus on a scope CHANGE only, never per click', () => {
    const { getByText } = render(
      <PanelFocusHost id="hierarchy"><div>tree</div></PanelFocusHost>,
    );
    fireEvent.pointerDown(getByText('tree'));
    fireEvent.pointerDown(getByText('tree'));
    fireEvent.pointerDown(getByText('tree'));
    const focusEvents = emitted.filter((e) => e.type === '!focus');
    expect(focusEvents).toHaveLength(1);
    expect(focusEvents[0].payload).toEqual({ panel: 'hierarchy', from: null });
  });

  it('journals the transition when focus moves between panels', () => {
    const a = render(<PanelFocusHost id="hierarchy"><div>tree</div></PanelFocusHost>);
    fireEvent.pointerDown(a.getByText('tree'));
    const b = render(<PanelFocusHost id="scene"><div>viewport</div></PanelFocusHost>);
    fireEvent.pointerDown(b.getByText('viewport'));

    const focusEvents = emitted.filter((e) => e.type === '!focus');
    expect(focusEvents).toHaveLength(2);
    expect(focusEvents[1].payload).toEqual({ panel: 'scene', from: 'hierarchy' });
  });
});
