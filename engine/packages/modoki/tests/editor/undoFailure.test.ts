/** reportUndoFailure (#308) — the shared reporter for an undo/redo closure whose
 *  filesystem op didn't happen. Pins the two-level bar from the header comment in
 *  undoFailure.ts: every failure logs at `console.error` naming the direction/label/
 *  detail; only `userFixable: true` (a 409-style collision) ALSO toasts. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportUndoFailure, COLLISION_STATUS } from '../../src/editor/undo/undoFailure';
import { useEditorStore } from '../../src/editor/store/editorStore';

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  useEditorStore.setState({ toast: null });
});
afterEach(() => { errorSpy.mockRestore(); });

describe('reportUndoFailure', () => {
  it('a backend failure (userFixable omitted) logs at error level and does NOT toast', () => {
    reportUndoFailure({ direction: 'Undo', label: 'Update prefab "Rig"', detail: '"/x.prefab.json" was not restored' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('Undo');
    expect(msg).toContain('Update prefab "Rig"');
    expect(msg).toContain('/x.prefab.json');
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('a backend failure with userFixable: false behaves the same as omitted', () => {
    reportUndoFailure({ direction: 'Redo', label: 'Set base scene', detail: '"/s.json" was not updated', userFixable: false });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('a userFixable collision logs AND shows a warn toast', () => {
    reportUndoFailure({
      direction: 'Undo', label: 'Rename foo.png', detail: `HTTP ${COLLISION_STATUS} — destination exists`, userFixable: true,
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const toast = useEditorStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.kind).toBe('warn');
    expect(toast!.message).toContain('Undo');
    expect(toast!.message).toContain('Rename foo.png');
  });

  it('names Redo distinctly from Undo in the message, since they leave the file in opposite states', () => {
    reportUndoFailure({ direction: 'Redo', label: 'Delete x', detail: 'detail' });
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toContain('Redo');
    expect(msg).not.toMatch(/\bUndo\b/);
  });
});
