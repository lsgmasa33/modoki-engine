// @vitest-environment jsdom
/** keyReach — the two-gate "did this key reach anything?" probe behind `/api/input/key`'s
 *  second warning (QA-PHYS-0003).
 *
 *  BOTH halves are covered here, and the second half is the one that matters. An earlier
 *  version of this file tested only `chordFromElectronKey` and said in its own header that
 *  `probeKeyReach` "reads live state, so what is unit-testable here is the pure half" — which
 *  was an excuse, not a fact. Every piece of that state is injectable: the store has a setter,
 *  the gate is installed by the host, jsdom owns `document.activeElement`. Meanwhile the route
 *  test mocks the IPC reply wholesale, so with only the pure half covered, negating
 *  `isInputSuppressed()`, returning the wrong field for `editorBinding`, or dropping `overlay`
 *  / `textEditable` from the resolve context all left every test in the change GREEN — and each
 *  one makes the warning fire when it must not, or stay silent when it must fire. That is
 *  precisely the QA-PHYS-0003 failure class this probe exists to prevent. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { register, clearBindings, normalizeChord, resolve, type ResolveContext } from '../../src/editor/input/keymap';
import { chordFromElectronKey, probeKeyReach } from '../../src/editor/input/keyReach';
import { clearOverlays, pushOverlay } from '../../src/editor/input/focusScope';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { setInputGate } from '../../src/runtime/input/inputSources';
import { setPlayState } from '../../src/runtime/core/playState';

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  focusedPanel: null, overlay: null, textEditable: false, ...over,
});

beforeEach(() => { clearBindings(); });

describe('chordFromElectronKey', () => {
  it('builds the same canonical chord a real keydown would', () => {
    expect(chordFromElectronKey('z', ['meta'])).toBe(normalizeChord('mod+z'.replace('mod', 'meta')));
    expect(chordFromElectronKey('w')).toBe('w');
  });

  it('accepts every InputModifier spelling the route allows', () => {
    const canonical = chordFromElectronKey('d', ['meta']);
    for (const m of ['cmd', 'command', 'meta']) expect(chordFromElectronKey('d', [m])).toBe(canonical);
    expect(chordFromElectronKey('d', ['control'])).toBe(chordFromElectronKey('d', ['ctrl' as string]));
  });

  it('canonicalizes modifier ORDER, so a caller-supplied list cannot miss a binding', () => {
    expect(chordFromElectronKey('z', ['shift', 'meta'])).toBe(chordFromElectronKey('z', ['meta', 'shift']));
  });

  it("resolves an arrow key spelled the ELECTRON way ('Up') to the binding registered on 'ArrowUp'", () => {
    // The false-warning trap: rendererOps rewrites ArrowUp → Up for sendInputEvent, so a
    // caller may legitimately pass either. Resolution must see the DOM form either way.
    register({ id: 'test.nudge', keys: 'ArrowUp', scope: 'app-key', run: () => {} });
    expect(resolve(chordFromElectronKey('Up'), ctx())).not.toBeNull();
    expect(resolve(chordFromElectronKey('ArrowUp'), ctx())).not.toBeNull();
  });

  it("passes a non-aliased key through untouched — 'Space' is not in the map and must not be invented", () => {
    // Weak-test guard: asserting `chordFromElectronKey('Space') === normalizeChord(' ')` alone
    // proves nothing about the alias map, since both sides reach 'space' by unrelated routes.
    // Pin the pass-through against a REGISTERED binding instead, so a stray alias entry for
    // Space (or a mangled fall-through) actually fails something.
    register({ id: 'test.pause', keys: 'Space', scope: 'app-key', run: () => {} });
    expect(resolve(chordFromElectronKey('Space'), ctx())?.id).toBe('test.pause');
    expect(chordFromElectronKey('Space')).toBe(normalizeChord(' '));
  });
});

/** `probeKeyReach` — the function the whole feature rests on.
 *
 *  The route test mocks this reply, so nothing else in the change can catch a field wired to
 *  the wrong source. Each test below names the mutation it defends against. */
describe('probeKeyReach', () => {
  const setScope = (p: string | null) => useEditorStore.getState().setFocusedPanel(p);

  beforeEach(() => {
    clearBindings(); clearOverlays();
    setScope(null);
    setInputGate(null);
    setPlayState('stopped');
    document.body.innerHTML = '';
  });
  afterEach(() => { setInputGate(null); setPlayState('stopped'); setScope(null); });

  it('reports the live scope and the INSTALLED gate, not a re-derived copy of the policy', () => {
    // Mutation: `gameInputSuppressed: !isInputSuppressed()`, or re-deriving
    // `focusedPanel !== 'game'` here instead of asking the host's own predicate.
    setInputGate(() => useEditorStore.getState().focusedPanel === 'hierarchy');
    setScope('hierarchy');
    expect(probeKeyReach('d')).toMatchObject({ focusedPanel: 'hierarchy', gameInputSuppressed: true });
    setScope('scene');
    // The editor's REAL gate would suppress 'scene' too; this fake one does not — and the probe
    // must follow the installed predicate, which is the whole point of not copying it.
    expect(probeKeyReach('d')).toMatchObject({ focusedPanel: 'scene', gameInputSuppressed: false });
  });

  it('tracks the sim state — mutation: `simRunning: !isSimRunning()`', () => {
    expect(probeKeyReach('d').simRunning).toBe(false);
    setPlayState('playing');
    expect(probeKeyReach('d').simRunning).toBe(true);
    setPlayState('paused');   // playing but NOT advancing — the sim tier does not run
    expect(probeKeyReach('d').simRunning).toBe(false);
  });

  it("returns the binding's COMMAND ID — mutation: returning the chord, or a bare boolean", () => {
    register({ id: 'gizmo.translate', keys: 'w', scope: 'scene', run: () => {} });
    setScope('scene');
    expect(probeKeyReach('w').editorBinding).toBe('gizmo.translate');
    expect(probeKeyReach('d').editorBinding).toBeNull();
  });

  it('resolves against the FOCUSED panel, so the same key answers differently per scope', () => {
    register({ id: 'gizmo.translate', keys: 'w', scope: 'scene', run: () => {} });
    setScope('hierarchy');
    expect(probeKeyReach('w').editorBinding).toBeNull();
    setScope('scene');
    expect(probeKeyReach('w').editorBinding).toBe('gizmo.translate');
  });

  it('passes `textEditable` into the context — mutation: dropping it from the resolve() call', () => {
    // A focused text field demotes every panel scope to ineligible (keymap.priority). Drop this
    // from the context and the probe reports a binding the real dispatcher would never run —
    // silencing the warning on a press that genuinely reached nothing.
    register({ id: 'gizmo.translate', keys: 'w', scope: 'scene', run: () => {} });
    setScope('scene');
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(probeKeyReach('w').editorBinding).toBeNull();
  });

  it('passes `overlay` into the context — mutation: dropping it from the resolve() call', () => {
    // An overlay binding belongs to the overlay on TOP of the stack. Without `overlay` in the
    // context every overlay-scoped chord resolves to null, and the probe under-reports.
    register({ id: 'modal.escape', keys: 'Escape', scope: 'overlay', owner: 'sprite-editor', run: () => {} });
    expect(probeKeyReach('Escape').editorBinding).toBeNull();   // nothing open
    pushOverlay('sprite-editor');
    expect(probeKeyReach('Escape').editorBinding).toBe('modal.escape');
  });

  it('echoes the canonical chord it resolved against', () => {
    expect(probeKeyReach('z', ['meta']).chord).toBe(chordFromElectronKey('z', ['meta']));
    expect(probeKeyReach('Up').chord).toBe('arrowup');
  });

  it('mirrors the dispatcher and never resolves a bare modifier press', () => {
    // dispatcher.ts returns before resolve() for Meta/Shift/Control/Alt ("a bare modifier
    // press is not a chord"). Without the same early-out the probe could claim the keymap
    // claims a key that physically cannot reach resolve() in production.
    register({ id: 'bogus.shift', keys: 'shift', scope: 'app-key', run: () => {} });
    for (const k of ['Shift', 'Meta', 'Control', 'Alt']) {
      expect(probeKeyReach(k).editorBinding).toBeNull();
    }
  });
});
