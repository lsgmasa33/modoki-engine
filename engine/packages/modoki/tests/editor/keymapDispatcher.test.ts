// @vitest-environment jsdom
/** Keymap dispatcher.
 *
 *  The tests that matter here are the YIELD ones. Plan A.8 measured that the renderer
 *  sees a key before the Electron menu and that preventDefault() is what SUPPRESSES the
 *  menu accelerator / native role. So a dispatcher that preventDefaults an unclaimed
 *  chord would silently kill text-field cut/copy/paste, reload and devtools — with no
 *  error anywhere. These assert on `defaultPrevented`, not just on what ran. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/editor/editorJournal', () => ({
  editorEmit: () => {},
  withEditorActor: (_a: string, fn: () => unknown) => fn(),
}));
vi.mock('../../src/editor/undo/undoManager', () => ({
  pushSelectionChange: () => {},
  isExecutingUndoRedo: () => false,
}));

const { register, clearBindings } = await import('../../src/editor/input/keymap');
const { installKeymapDispatcher } = await import('../../src/editor/input/dispatcher');
const { clearOverlays, pushOverlay, isTextEditable: isTextEditableEl } = await import('../../src/editor/input/focusScope');
const { useEditorStore } = await import('../../src/editor/store/editorStore');

let dispose: () => void;

beforeEach(() => {
  clearBindings();
  clearOverlays();
  useEditorStore.setState({ focusedPanel: null });
  document.body.innerHTML = '';
  dispose = installKeymapDispatcher();
});
afterEach(() => dispose());

/** Dispatch a keydown on window and report whether the dispatcher claimed it. */
function press(key: string, mods: Partial<KeyboardEventInit> = {}) {
  const e = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...mods });
  window.dispatchEvent(e);
  return e;
}

describe('dispatcher — claiming', () => {
  it('runs a matching binding and preventDefaults (suppressing the menu fallback)', () => {
    const run = vi.fn();
    register({ id: 'app.save', keys: 'meta+s', scope: 'app-chord', run });
    const e = press('s', { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('routes to the focused panel', () => {
    const hier = vi.fn(); const anim = vi.fn();
    register({ id: 'h.dup', keys: 'meta+d', scope: 'hierarchy', run: hier });
    register({ id: 'a.dup', keys: 'meta+d', scope: 'animation-editor', run: anim });

    useEditorStore.setState({ focusedPanel: 'animation-editor' });
    press('d', { metaKey: true });
    expect(anim).toHaveBeenCalledTimes(1);
    expect(hier).not.toHaveBeenCalled();
  });

  it('lets an overlay outrank the app scope', () => {
    const app = vi.fn(); const modal = vi.fn();
    register({ id: 'app.undo', keys: 'meta+z', scope: 'app-chord', run: app });
    register({ id: 'm.undo', keys: 'meta+z', scope: 'overlay', owner: 'sprite', run: modal });
    pushOverlay('sprite');
    press('z', { metaKey: true });
    expect(modal).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
  });
});

describe('dispatcher — the YIELD contract (docs/editor-input.md)', () => {
  it('does NOT preventDefault an unbound chord', () => {
    // This is what lets Cmd+C in a text field reach the native role:'copy', Cmd+R reach
    // reload, and F12 reach devtools. Verified live too: bare `e` stayed unbound here and
    // still reached SceneView's own listener, flipping gizmoMode to 'rotate'.
    const e = press('c', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
  });

  it('does NOT preventDefault when the only candidate declines via when()', () => {
    const run = vi.fn();
    register({ id: 'a.del', keys: 'Backspace', scope: 'animation-editor', when: () => false, run });
    useEditorStore.setState({ focusedPanel: 'animation-editor' });
    const e = press('Backspace');
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('does NOT preventDefault a panel chord while an unrelated panel is focused', () => {
    register({ id: 'h.del', keys: 'Backspace', scope: 'hierarchy', run: vi.fn() });
    useEditorStore.setState({ focusedPanel: 'assets' });
    expect(press('Backspace').defaultPrevented).toBe(false);
  });

  it('ignores bare modifier presses', () => {
    const run = vi.fn();
    register({ id: 'x', keys: 'meta+s', scope: 'app-chord', run });
    for (const k of ['Meta', 'Shift', 'Control', 'Alt']) {
      expect(press(k, { metaKey: true }).defaultPrevented).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('dispatcher — text-field tier', () => {
  function focusTextInput() {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  it('still fires app-chord while typing (Cmd+S must save mid-edit)', () => {
    const run = vi.fn();
    register({ id: 'app.save', keys: 'meta+s', scope: 'app-chord', run });
    focusTextInput();
    press('s', { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS a bare app-key while typing, and yields it', () => {
    const run = vi.fn();
    register({ id: 'app.frame', keys: 'f', scope: 'app-key', run });
    focusTextInput();
    const e = press('f');
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false); // must reach the input as a typed character
  });

  it('does not treat a checkbox as a text field', () => {
    // editor-multi-select.spec.ts:52 presses Cmd+Z with a checkbox focused and expects
    // the SCENE undo to run.
    const run = vi.fn();
    register({ id: 'app.undo', keys: 'meta+z', scope: 'app-chord', run });
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    document.body.appendChild(cb);
    cb.focus();
    press('z', { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('dispatcher — lifecycle', () => {
  it('stops dispatching after disposal', () => {
    const run = vi.fn();
    register({ id: 'x', keys: 'meta+s', scope: 'app-chord', run });
    dispose();
    press('s', { metaKey: true });
    expect(run).not.toHaveBeenCalled();
    dispose = installKeymapDispatcher(); // restore for afterEach
  });
});

describe('claim vs preventDefault are SEPARATE decisions (P8 review D1)', () => {
  function focusTextInput() {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    return input;
  }

  it('an exclusive overlay still CLAIMS the chord while typing — app scope must not run', () => {
    // THE REGRESSION. The first migration expressed "don't preventDefault while typing" as
    // `when`, but a false when() YIELDS — so Cmd+Z fell through to app.undo and ran the
    // scene undo underneath an open modal, which can unmount it with unsaved edits.
    const appUndo = vi.fn();
    const modalUndo = vi.fn();
    register({ id: 'app.undo', keys: 'meta+z', scope: 'app-chord', run: appUndo });
    register({
      id: 'modal.undo', keys: 'meta+z', scope: 'overlay', owner: 'sprite',
      preventDefault: () => !isTextEditableEl(document.activeElement),
      run: () => { if (!isTextEditableEl(document.activeElement)) modalUndo(); },
    });
    pushOverlay('sprite');
    focusTextInput();

    const e = press('z', { metaKey: true });
    expect(appUndo).not.toHaveBeenCalled();        // the modal denied it to the app scope
    expect(modalUndo).not.toHaveBeenCalled();      // and did nothing itself while typing
    expect(e.defaultPrevented).toBe(false);        // so native text-undo survives
  });

  it('the same overlay binding acts and prevents when NOT typing', () => {
    const appUndo = vi.fn();
    const modalUndo = vi.fn();
    register({ id: 'app.undo', keys: 'meta+z', scope: 'app-chord', run: appUndo });
    register({
      id: 'modal.undo', keys: 'meta+z', scope: 'overlay', owner: 'sprite',
      preventDefault: () => !isTextEditableEl(document.activeElement),
      run: () => { if (!isTextEditableEl(document.activeElement)) modalUndo(); },
    });
    pushOverlay('sprite');

    const e = press('z', { metaKey: true });
    expect(modalUndo).toHaveBeenCalledTimes(1);
    expect(appUndo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('defaults to preventDefault when the field is absent', () => {
    const run = vi.fn();
    register({ id: 'x', keys: 'meta+s', scope: 'app-chord', run });
    expect(press('s', { metaKey: true }).defaultPrevented).toBe(true);
  });

  it('an overlay does NOT block chords it has not bound', () => {
    // Guards against "fixing" D1 by making overlays swallow everything.
    const appSave = vi.fn();
    register({ id: 'app.save', keys: 'meta+s', scope: 'app-chord', run: appSave });
    register({ id: 'modal.undo', keys: 'meta+z', scope: 'overlay', owner: 'sprite', run: () => {} });
    pushOverlay('sprite');
    press('s', { metaKey: true });
    expect(appSave).toHaveBeenCalledTimes(1);
  });
});
