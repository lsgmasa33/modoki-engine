/** Keymap registry + focus scope.
 *
 *  Pure modules, so these run in the default `node` env with no DOM — the
 *  undoManager.test.ts / panelDock.test.ts model. This is deliberately the FIRST
 *  vitest coverage of editor keyboard shortcuts in the repo: until now every
 *  shortcut assertion lived in Playwright e2e, which is why the ⌘Z binding path had
 *  3 tests and the panel handlers had none. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  register, unregister, resolve, clearBindings, getBindings, normalizeChord,
  chordFromEvent, formatChord, KeymapConflictError, type ResolveContext,
} from '../../src/editor/input/keymap';
import {
  isTextEditable, pushOverlay, popOverlay, topOverlay, clearOverlays, overlayDepth,
} from '../../src/editor/input/focusScope';

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  focusedPanel: null, overlay: null, textEditable: false, ...over,
});

beforeEach(() => { clearBindings(); clearOverlays(); });

describe('normalizeChord', () => {
  it('canonicalizes modifier ORDER so equivalent chords compare equal', () => {
    expect(normalizeChord('shift+meta+z')).toBe(normalizeChord('meta+shift+z'));
  });

  it('accepts cmd/command/ctrl/option aliases', () => {
    expect(normalizeChord('cmd+d')).toBe(normalizeChord('meta+d'));
    expect(normalizeChord('command+d')).toBe(normalizeChord('meta+d'));
    expect(normalizeChord('ctrl+d')).toBe(normalizeChord('control+d'));
    expect(normalizeChord('option+d')).toBe(normalizeChord('alt+d'));
  });

  it('resolves `mod` to exactly one platform modifier, stably', () => {
    const m = normalizeChord('mod+d');
    expect([normalizeChord('meta+d'), normalizeChord('control+d')]).toContain(m);
    expect(normalizeChord('mod+d')).toBe(m); // idempotent
  });

  it('is case-insensitive on the key', () => {
    expect(normalizeChord('mod+D')).toBe(normalizeChord('mod+d'));
  });
});

describe('chordFromEvent — full-chord matching', () => {
  it('distinguishes a bare key from the same key with a modifier', () => {
    // The bug this prevents: bare `r` eating Cmd+R (reload). Already fixed once by
    // hand in SceneView with an early-return on any modifier.
    const bare = chordFromEvent({ key: 'r' });
    const withMeta = chordFromEvent({ key: 'r', metaKey: true });
    expect(bare).not.toBe(withMeta);
    expect(bare).toBe('r');
  });

  it('round-trips against normalizeChord', () => {
    expect(chordFromEvent({ key: 'Z', metaKey: true, shiftKey: true }))
      .toBe(normalizeChord('meta+shift+z'));
  });
});

describe('register — conflict detection at registration time', () => {
  const noop = () => {};

  it('allows the SAME chord in DIFFERENT scopes (the point of scoping)', () => {
    register({ id: 'hierarchy.dup', keys: 'mod+d', scope: 'hierarchy', run: noop });
    expect(() =>
      register({ id: 'anim.dup', keys: 'mod+d', scope: 'animation-editor', run: noop }),
    ).not.toThrow();
    expect(getBindings()).toHaveLength(2);
  });

  it('THROWS on a duplicate chord within one scope', () => {
    register({ id: 'scene.grid', keys: 'g', scope: 'scene', run: noop });
    expect(() => register({ id: 'scene.other', keys: 'g', scope: 'scene', run: noop }))
      .toThrow(KeymapConflictError);
  });

  it('normalizes before comparing, so meta+shift+z collides with shift+meta+z', () => {
    register({ id: 'a', keys: 'meta+shift+z', scope: 'scene', run: noop });
    expect(() => register({ id: 'b', keys: 'shift+meta+z', scope: 'scene', run: noop }))
      .toThrow(KeymapConflictError);
  });

  it('throws on a duplicate id', () => {
    register({ id: 'dup', keys: 'g', scope: 'scene', run: noop });
    expect(() => register({ id: 'dup', keys: 'h', scope: 'hierarchy', run: noop }))
      .toThrow(KeymapConflictError);
  });

  it('returns a working disposer', () => {
    const off = register({ id: 'tmp', keys: 'g', scope: 'scene', run: noop });
    off();
    expect(getBindings()).toHaveLength(0);
    expect(() => register({ id: 'tmp2', keys: 'g', scope: 'scene', run: noop })).not.toThrow();
  });
});

describe('resolve — scope gating', () => {
  const noop = () => {};

  it('routes a panel chord ONLY to the focused panel', () => {
    register({ id: 'hierarchy.dup', keys: 'mod+d', scope: 'hierarchy', run: noop });
    register({ id: 'anim.dup', keys: 'mod+d', scope: 'animation-editor', run: noop });

    expect(resolve('mod+d', ctx({ focusedPanel: 'hierarchy' }))?.id).toBe('hierarchy.dup');
    expect(resolve('mod+d', ctx({ focusedPanel: 'animation-editor' }))?.id).toBe('anim.dup');
    // Nothing focused → nobody claims it → YIELD.
    expect(resolve('mod+d', ctx({ focusedPanel: 'assets' }))).toBeNull();
  });

  it('fires app-chord even while typing in a text field', () => {
    register({ id: 'app.save', keys: 'mod+s', scope: 'app-chord', run: noop });
    expect(resolve('mod+s', ctx({ textEditable: true }))?.id).toBe('app.save');
  });

  it('BLOCKS app-key while typing, but fires it anywhere else', () => {
    // Bare `f` = frame selected. Typing "fog" into a name field must not frame 3×.
    register({ id: 'app.frame', keys: 'f', scope: 'app-key', run: noop });
    expect(resolve('f', ctx({ textEditable: true }))).toBeNull();
    expect(resolve('f', ctx({ focusedPanel: 'hierarchy' }))?.id).toBe('app.frame');
  });

  it('blocks panel chords while typing', () => {
    register({ id: 'hierarchy.del', keys: 'Backspace', scope: 'hierarchy', run: noop });
    expect(resolve('Backspace', ctx({ focusedPanel: 'hierarchy', textEditable: true }))).toBeNull();
  });

  it('lets an overlay outrank the app scope (a modal may swallow Cmd+Z)', () => {
    register({ id: 'app.undo', keys: 'mod+z', scope: 'app-chord', run: noop });
    register({ id: 'sprite.undo', keys: 'mod+z', scope: 'overlay', owner: 'sprite-editor', run: noop });

    expect(resolve('mod+z', ctx())?.id).toBe('app.undo');
    expect(resolve('mod+z', ctx({ overlay: 'sprite-editor' }))?.id).toBe('sprite.undo');
  });

  it('scopes an overlay binding to the TOP of the stack, not any overlay', () => {
    register({ id: 'picker.esc', keys: 'Escape', scope: 'overlay', owner: 'picker', run: noop });
    // A different overlay is on top → the picker's Escape must not fire.
    expect(resolve('Escape', ctx({ overlay: 'context-menu' }))).toBeNull();
    expect(resolve('Escape', ctx({ overlay: 'picker' }))?.id).toBe('picker.esc');
  });

  it('prefers text-field over panel scope while typing', () => {
    register({ id: 'field.clear', keys: 'Backspace', scope: 'text-field', run: noop });
    register({ id: 'hierarchy.del', keys: 'Backspace', scope: 'hierarchy', run: noop });
    expect(resolve('Backspace', ctx({ focusedPanel: 'hierarchy', textEditable: true }))?.id)
      .toBe('field.clear');
  });
});

describe('resolve — the YIELD contract (docs/editor-input.md)', () => {
  const noop = () => {};

  it('returns null for an unbound chord so the caller does NOT preventDefault', () => {
    // Null is what lets the Electron menu item / native role handle the chord. A
    // dispatcher that preventDefaults unconditionally would kill cut/copy/paste,
    // reload and devtools across the whole editor.
    expect(resolve('mod+c', ctx({ focusedPanel: 'hierarchy' }))).toBeNull();
  });

  it('falls THROUGH to the next scope when when() is false', () => {
    // Mirrors AnimationEditor's real behaviour: it claims Cmd+D only when keys are
    // selected, otherwise yields so Hierarchy's entity-duplicate still works.
    let hasKeys = false;
    register({ id: 'anim.dup', keys: 'mod+d', scope: 'animation-editor', when: () => hasKeys, run: noop });
    register({ id: 'app.dup', keys: 'mod+d', scope: 'app-chord', run: noop });

    const c = ctx({ focusedPanel: 'animation-editor' });
    expect(resolve('mod+d', c)?.id).toBe('app.dup');   // yielded past the panel binding
    hasKeys = true;
    expect(resolve('mod+d', c)?.id).toBe('anim.dup');  // now claims it
  });

  it('yields entirely when the only candidate declines', () => {
    register({ id: 'anim.del', keys: 'Backspace', scope: 'animation-editor', when: () => false, run: noop });
    expect(resolve('Backspace', ctx({ focusedPanel: 'animation-editor' }))).toBeNull();
  });

  it('does not invoke run() — resolution is side-effect free', () => {
    const run = vi.fn();
    register({ id: 'x', keys: 'g', scope: 'scene', run });
    resolve('g', ctx({ focusedPanel: 'scene' }));
    expect(run).not.toHaveBeenCalled();
  });
});

describe('formatChord — pinned by editor-hierarchy.spec.ts:43', () => {
  it('emits exactly the glyphs the Hierarchy context menu asserts', () => {
    expect(formatChord('F2')).toBe('F2');
    expect(formatChord('meta+d')).toBe('⌘D');
    expect(formatChord('meta+c')).toBe('⌘C');
    expect(formatChord('meta+x')).toBe('⌘X');
    expect(formatChord('f')).toBe('F');
    expect(formatChord('Backspace')).toBe('⌫');
  });

  it('orders and glyphs multi-modifier chords', () => {
    expect(formatChord('meta+shift+z')).toBe('⇧⌘Z');
    expect(formatChord('alt+control+k')).toBe('⌃⌥K');
  });
});

describe('isTextEditable', () => {
  const el = (o: Record<string, unknown>) => o as unknown as Element;

  it('treats text inputs, textareas and contenteditable as editable', () => {
    expect(isTextEditable(el({ tagName: 'INPUT', type: 'text' }))).toBe(true);
    expect(isTextEditable(el({ tagName: 'INPUT' }))).toBe(true); // type defaults to text
    expect(isTextEditable(el({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isTextEditable(el({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  it('does NOT treat a checkbox as editable', () => {
    // editor-multi-select.spec.ts:52 presses Cmd+Z while a checkbox has focus and
    // expects the SCENE undo. A blunt tagName==='INPUT' test would swallow it.
    expect(isTextEditable(el({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(isTextEditable(el({ tagName: 'INPUT', type: 'radio' }))).toBe(false);
  });

  it('does NOT treat a readOnly input as editable', () => {
    // AssetRefField renders a readOnly input and binds Backspace to clear the ref.
    expect(isTextEditable(el({ tagName: 'INPUT', type: 'text', readOnly: true }))).toBe(false);
  });

  it('is false for non-fields and null', () => {
    expect(isTextEditable(el({ tagName: 'DIV' }))).toBe(false);
    expect(isTextEditable(el({ tagName: 'BODY' }))).toBe(false);
    expect(isTextEditable(null)).toBe(false);
  });
});

describe('overlay stack — Escape gets ONE owner', () => {
  it('reports the top overlay', () => {
    expect(topOverlay()).toBeNull();
    pushOverlay('context-menu');
    pushOverlay('submenu');
    expect(topOverlay()).toBe('submenu');
  });

  it('closes innermost-first via the disposer', () => {
    pushOverlay('context-menu');
    const closeSub = pushOverlay('submenu');
    closeSub();
    expect(topOverlay()).toBe('context-menu');
  });

  it('removes BY ID, not by popping the top (overlays close out of order)', () => {
    pushOverlay('menu');
    pushOverlay('picker');
    popOverlay('menu');            // the parent closes while the picker is still open
    expect(topOverlay()).toBe('picker');
    expect(overlayDepth()).toBe(1);
  });

  it('re-pushing an open id moves it to the top instead of duplicating', () => {
    pushOverlay('a');
    pushOverlay('b');
    pushOverlay('a');
    expect(overlayDepth()).toBe(2);
    expect(topOverlay()).toBe('a');
    popOverlay('a');
    expect(topOverlay()).toBe('b');
  });

  it('popping an unknown id is a no-op', () => {
    pushOverlay('a');
    popOverlay('nope');
    expect(overlayDepth()).toBe(1);
  });
});

describe('unregister', () => {
  it('removes a binding so the chord yields again', () => {
    register({ id: 'x', keys: 'g', scope: 'scene', run: () => {} });
    unregister('x');
    expect(resolve('g', ctx({ focusedPanel: 'scene' }))).toBeNull();
  });
});

describe('key-name normalization', () => {
  it('names Space so it survives chord splitting', () => {
    // e.key for space is ' ', which '+'-splitting + trimming would erase entirely —
    // a binding on it would silently never match. AnimationEditor binds Space to
    // toggle preview playback, so this is load-bearing.
    expect(chordFromEvent({ key: ' ' })).toBe('space');
    expect(normalizeChord('Space')).toBe('space');
    expect(normalizeChord(' ')).toBe('space');
  });

  it('keeps modified space distinct', () => {
    expect(chordFromEvent({ key: ' ', shiftKey: true })).toBe('shift+space');
  });
});

describe('modifier variants are distinct chords', () => {
  const noop = () => {};

  it('does not let a bare arrow claim its shift/alt variants', () => {
    // AnimationEditor: ArrowLeft nudges by 1 frame, Shift+ArrowLeft by 10, and
    // Alt+ArrowUp is a 0.1 value step. If these collapsed, shift would silently
    // nudge by 1.
    register({ id: 'a.left', keys: 'ArrowLeft', scope: 'animation-editor', run: noop });
    register({ id: 'a.left10', keys: 'shift+ArrowLeft', scope: 'animation-editor', run: noop });
    register({ id: 'a.upFine', keys: 'alt+ArrowUp', scope: 'animation-editor', run: noop });

    const c = { focusedPanel: 'animation-editor', overlay: null, textEditable: false };
    expect(resolve(chordFromEvent({ key: 'ArrowLeft' }), c)?.id).toBe('a.left');
    expect(resolve(chordFromEvent({ key: 'ArrowLeft', shiftKey: true }), c)?.id).toBe('a.left10');
    expect(resolve(chordFromEvent({ key: 'ArrowUp', altKey: true }), c)?.id).toBe('a.upFine');
    // A bare ArrowUp is unbound here → yields.
    expect(resolve(chordFromEvent({ key: 'ArrowUp' }), c)).toBeNull();
  });
});

describe('Cmd+D three-way ownership (was a capture-phase race)', () => {
  const noop = () => {};

  it('routes by focused panel, and yields when the animation panel has no keys selected', () => {
    // AnimationEditor used to register a SECOND capture-phase listener purely to beat
    // Hierarchy's and Assets' bubble handlers, claiming with stopImmediatePropagation
    // only when keys were selected. Scope + when() replaces the whole race.
    let animHasKeys = false;
    register({ id: 'h.dup', keys: 'mod+d', scope: 'hierarchy', run: noop });
    register({ id: 'as.dup', keys: 'mod+d', scope: 'assets', run: noop });
    register({ id: 'an.dup', keys: 'mod+d', scope: 'animation-editor', when: () => animHasKeys, run: noop });

    const at = (p: string) => ({ focusedPanel: p, overlay: null, textEditable: false });
    expect(resolve('mod+d', at('hierarchy'))?.id).toBe('h.dup');
    expect(resolve('mod+d', at('assets'))?.id).toBe('as.dup');
    expect(resolve('mod+d', at('animation-editor'))).toBeNull(); // no keys → yields
    animHasKeys = true;
    expect(resolve('mod+d', at('animation-editor'))?.id).toBe('an.dup');
  });
});

describe('Escape overlay stack — the four-owner bug (§1)', () => {
  const noop = () => {};

  /** Mirrors useOverlayEscape: push + register against a per-instance owner. */
  function openOverlay(id: string, run = noop) {
    const pop = pushOverlay(id);
    const off = register({ id: `overlay.escape.${id}`, keys: 'Escape', scope: 'overlay', owner: id, run });
    return () => { off(); pop(); };
  }

  it('closes ONLY the innermost overlay, not every open one', () => {
    // The shipped bug: ContextMenu (one listener per menu INCLUDING each nested
    // submenu), treeChrome, DevicePicker and SpritePicker each held a document
    // keydown and none stopped propagation, so one Escape closed them all.
    const menu = vi.fn(), submenu = vi.fn();
    openOverlay('context-menu:1', menu);
    openOverlay('context-menu:2', submenu);

    const hit = resolve('Escape', ctx({ overlay: topOverlay() }));
    expect(hit?.id).toBe('overlay.escape.context-menu:2');
    hit?.run();
    expect(submenu).toHaveBeenCalledTimes(1);
    expect(menu).not.toHaveBeenCalled();
  });

  it('falls back to the parent once the child closes', () => {
    const menu = vi.fn();
    openOverlay('context-menu:1', menu);
    const closeChild = openOverlay('context-menu:2');
    closeChild();

    resolve('Escape', ctx({ overlay: topOverlay() }))?.run();
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it('gives distinct instances of the same component distinct owners', () => {
    // Instance-scoped by useId(), not by kind — a shared owner id would collapse
    // nested submenus back into the original bug.
    openOverlay('context-menu:a');
    openOverlay('context-menu:b');
    expect(topOverlay()).toBe('context-menu:b');
    expect(overlayDepth()).toBe(2);
  });

  it('yields Escape entirely when no overlay is open', () => {
    expect(resolve('Escape', ctx())).toBeNull();
  });
});
