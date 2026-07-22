/** Panel-scoped bare keys.
 *
 *  These encode the §1 "live bug" list as executable assertions, so the specific
 *  collisions this refactor exists to fix can never silently come back:
 *    - bare W fired SceneView's gizmo AND SkinCanvas's tool AND the game's "up" key
 *    - bare B fired AnimationEditor's break-tangents AND SkinCanvas's brush
 *    - bare C toggled collider display from anywhere outside a text field
 *
 *  Registry-level, so they need no DOM and no panel mount — the resolution rules ARE
 *  the behaviour. Live end-to-end verification was done by hand against a running editor. */

import { describe, it, expect, beforeEach } from 'vitest';
import { register, resolve, clearBindings, type ResolveContext } from '../../src/editor/input/keymap';

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  focusedPanel: null, overlay: null, textEditable: false, ...over,
});
const noop = () => {};

/** The subset of real bindings these collisions involve. Mirrors SceneView.tsx /
 *  SkinCanvas.tsx / AnimationEditor registration; kept minimal on purpose. */
function registerRealBindings() {
  register({ id: 'scene.gizmo.translate', keys: 'w', scope: 'scene', run: noop });
  register({ id: 'scene.gizmo.rotate', keys: 'e', scope: 'scene', run: noop });
  register({ id: 'scene.gizmo.scale', keys: 'r', scope: 'scene', run: noop });
  register({ id: 'scene.toggleColliders', keys: 'c', scope: 'scene', run: noop });
  register({ id: 'scene.toggleGrid', keys: 'g', scope: 'scene', run: noop });
  register({ id: 'skin.toolTransform', keys: 'w', scope: 'skin-editor', run: noop });
  register({ id: 'skin.toolBrush', keys: 'b', scope: 'skin-editor', run: noop });
  register({ id: 'anim.breakTangents', keys: 'b', scope: 'animation-editor', run: noop });
}

beforeEach(() => { clearBindings(); registerRealBindings(); });

describe('bare W — the three-way collision (§1)', () => {
  it('goes to the SceneView gizmo ONLY when the scene is focused', () => {
    expect(resolve('w', ctx({ focusedPanel: 'scene' }))?.id).toBe('scene.gizmo.translate');
  });

  it('goes to the skin tool ONLY when the skin editor is focused', () => {
    expect(resolve('w', ctx({ focusedPanel: 'skin-editor' }))?.id).toBe('skin.toolTransform');
  });

  it('resolves to EXACTLY ONE owner, never both', () => {
    // The actual shipped bug: one press moved the gizmo AND switched the skin tool.
    for (const panel of ['scene', 'skin-editor']) {
      const hits = [resolve('w', ctx({ focusedPanel: panel }))].filter(Boolean);
      expect(hits).toHaveLength(1);
    }
  });

  it('reaches NOBODY when an unrelated panel is focused', () => {
    // Previously it reached everyone regardless of where you were working.
    expect(resolve('w', ctx({ focusedPanel: 'hierarchy' }))).toBeNull();
    expect(resolve('w', ctx({ focusedPanel: 'assets' }))).toBeNull();
    expect(resolve('w', ctx({ focusedPanel: 'inspector' }))).toBeNull();
  });

  it('reaches nobody while typing — so "w" types a w', () => {
    expect(resolve('w', ctx({ focusedPanel: 'scene', textEditable: true }))).toBeNull();
  });
});

describe('bare B — SkinCanvas vs AnimationEditor (§1)', () => {
  it('splits cleanly by focused panel', () => {
    expect(resolve('b', ctx({ focusedPanel: 'skin-editor' }))?.id).toBe('skin.toolBrush');
    expect(resolve('b', ctx({ focusedPanel: 'animation-editor' }))?.id).toBe('anim.breakTangents');
    expect(resolve('b', ctx({ focusedPanel: 'scene' }))).toBeNull();
  });
});

describe('bare C / G — no longer global (§1)', () => {
  it('only toggles colliders/grid from the scene panel', () => {
    expect(resolve('c', ctx({ focusedPanel: 'scene' }))?.id).toBe('scene.toggleColliders');
    expect(resolve('c', ctx({ focusedPanel: 'hierarchy' }))).toBeNull();
    expect(resolve('g', ctx({ focusedPanel: 'console' }))).toBeNull();
  });
});

describe('full-chord matching — Cmd+R must not hit the scale gizmo', () => {
  it('does not match bare `r` for a meta chord', () => {
    // SceneView had to bail on any meta/ctrl/alt by hand to avoid eating Cmd+R (reload).
    // Chord matching makes that structural: 'meta+r' simply is not 'r'.
    expect(resolve('meta+r', ctx({ focusedPanel: 'scene' }))).toBeNull();
    expect(resolve('r', ctx({ focusedPanel: 'scene' }))?.id).toBe('scene.gizmo.scale');
  });

  it('does not match bare `c`/`w` for Cmd+C / Cmd+W', () => {
    expect(resolve('meta+c', ctx({ focusedPanel: 'scene' }))).toBeNull();
    expect(resolve('meta+w', ctx({ focusedPanel: 'scene' }))).toBeNull();
  });
});

describe('`f` frame-selected is app-key, not scene-scoped', () => {
  beforeEach(() => {
    clearBindings();
    // Mirrors SceneView: yields when there is nothing to frame.
    let framable = true;
    register({
      id: 'scene.frameSelected', keys: 'f', scope: 'app-key',
      when: () => framable, run: noop,
    });
    (globalThis as Record<string, unknown>).__setFramable = (v: boolean) => { framable = v; };
  });

  it('fires from the HIERARCHY — the pinned e2e behaviour', () => {
    // editor-hierarchy.spec.ts:84 presses `f` after clicking a Hierarchy row and expects
    // SceneView to frame the entity. A `scene`-scoped `f` would fail that test.
    expect(resolve('f', ctx({ focusedPanel: 'hierarchy' }))?.id).toBe('scene.frameSelected');
  });

  it('fires with nothing focused at all', () => {
    expect(resolve('f', ctx())?.id).toBe('scene.frameSelected');
  });

  it('does NOT fire while typing — so "fog" does not frame three times', () => {
    expect(resolve('f', ctx({ focusedPanel: 'hierarchy', textEditable: true }))).toBeNull();
  });

  it('yields when there is nothing to frame', () => {
    (globalThis as Record<string, () => void> & { __setFramable: (v: boolean) => void }).__setFramable(false);
    expect(resolve('f', ctx({ focusedPanel: 'scene' }))).toBeNull();
  });
});

describe('selection commands work from the SCENE view too (regression)', () => {
  // P6 scoped entity copy/cut/paste/duplicate/delete to `hierarchy` alone, which silently
  // removed them from the SceneView. They had worked there because the old document
  // listener only yielded when activeElement sat inside a panel carrying
  // `data-editor-panel`, and SceneView never set that attribute — so the loose boundary was
  // load-bearing behaviour, not an accident. These act on the SELECTION, which is global,
  // so they belong to every panel that displays it (Unity behaves the same way).
  beforeEach(() => {
    clearBindings();
    for (const scope of ['hierarchy', 'scene']) {
      register({ id: `${scope}.copy`, keys: 'mod+c', scope, run: noop });
      register({ id: `${scope}.paste`, keys: 'mod+v', scope, run: noop });
      register({ id: `${scope}.duplicate`, keys: 'mod+d', scope, run: noop });
      register({ id: `${scope}.delete0`, keys: 'mod+Backspace', scope, run: noop });
    }
    // Rename is Hierarchy-ONLY: the inline edit box lives on a Hierarchy row, so there is
    // nothing for it to show in the SceneView.
    register({ id: 'hierarchy.rename', keys: 'F2', scope: 'hierarchy', run: noop });
  });

  for (const [keys, cmd] of [['mod+c', 'copy'], ['mod+v', 'paste'], ['mod+d', 'duplicate'], ['mod+Backspace', 'delete0']] as const) {
    it(`${keys} resolves in BOTH hierarchy and scene`, () => {
      expect(resolve(keys, ctx({ focusedPanel: 'hierarchy' }))?.id).toBe(`hierarchy.${cmd}`);
      expect(resolve(keys, ctx({ focusedPanel: 'scene' }))?.id).toBe(`scene.${cmd}`);
    });
  }

  it('still yields from panels that do NOT show the selection', () => {
    expect(resolve('mod+d', ctx({ focusedPanel: 'console' }))).toBeNull();
    expect(resolve('mod+d', ctx({ focusedPanel: 'assets' }))).toBeNull();
  });

  it('rename stays Hierarchy-only — there is no rename box in the SceneView', () => {
    expect(resolve('F2', ctx({ focusedPanel: 'hierarchy' }))?.id).toBe('hierarchy.rename');
    expect(resolve('F2', ctx({ focusedPanel: 'scene' }))).toBeNull();
  });
});
