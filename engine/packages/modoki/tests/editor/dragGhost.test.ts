// @vitest-environment jsdom
/**
 * dragGhost self-heal (panels F10): an aborted drag whose React onDragEnd never fires must
 * still clean up — a native dragend/drop force-calls endDragGhost so the floating ghost,
 * the document dragover listener, and the sticky `editor-mousedown` body class don't leak.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startDragGhost, endDragGhost } from '../../src/editor/utils/dragGhost';

// Minimal React.DragEvent stand-in — startDragGhost only touches dataTransfer.setDragImage.
const fakeDragEvent = () => ({ dataTransfer: { setDragImage: () => {} } }) as unknown as React.DragEvent;

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.classList.remove('editor-mousedown');
  delete (window as any).__editorDragCleanup;
});
afterEach(() => endDragGhost());

describe('startDragGhost self-heal', () => {
  it('mounts a floating ghost', () => {
    startDragGhost(fakeDragEvent(), 'Foo');
    expect(document.getElementById('editor-drag-ghost')).not.toBeNull();
    expect((window as any).__editorDragCleanup).toBeTypeOf('function');
  });

  it('a native dragend removes the ghost + cleanup even if onDragEnd never fired', () => {
    document.body.classList.add('editor-mousedown');
    startDragGhost(fakeDragEvent(), 'Foo');
    expect(document.getElementById('editor-drag-ghost')).not.toBeNull();

    document.dispatchEvent(new Event('dragend'));

    expect(document.getElementById('editor-drag-ghost')).toBeNull();
    expect((window as any).__editorDragCleanup).toBeUndefined();
    expect(document.body.classList.contains('editor-mousedown')).toBe(false);
  });

  it('a native drop also force-cleans up', () => {
    startDragGhost(fakeDragEvent(), 'Bar');
    document.dispatchEvent(new Event('drop'));
    expect(document.getElementById('editor-drag-ghost')).toBeNull();
  });

  it('the self-heal listener does not fire after a normal endDragGhost (no double-cleanup throw)', () => {
    startDragGhost(fakeDragEvent(), 'Baz');
    endDragGhost(); // normal path removes the dragend/drop listeners too
    // A later stray dragend must be a no-op, not re-run cleanup on a stale closure.
    expect(() => document.dispatchEvent(new Event('dragend'))).not.toThrow();
    expect(document.getElementById('editor-drag-ghost')).toBeNull();
  });
});
