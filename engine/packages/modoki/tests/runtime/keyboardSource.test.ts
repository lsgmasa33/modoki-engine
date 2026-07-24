/** keyboardSource — direct mapping coverage (closes the review's test-gap finding).
 *
 *  The keyboard is the ONLY currently-shipped input path, and its key→action mapping
 *  is the load-bearing behavior-neutrality invariant (2D jump = W/↑/Space, 2D moveX =
 *  A/D/arrows; 3D forward W/↑ → moveY=+1 → later negated to −Z; 3D jump = Space). The
 *  other input tests exercise the Input→controller bridge and the gamepad mapper, but
 *  none pinned the keyboard mapping itself — so a silent regression there (e.g. Space
 *  no longer producing jump) would ship green. This drives keyboardSource through a
 *  stubbed DOM: dispatch keydown/keyup, then assert what sample() writes into a frame. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { keyboardSource } from '../../src/runtime/input/keyboardSource';
import { createInputFrame } from '../../src/runtime/input/actions';

type Handler = (e: unknown) => void;
let handlers: Record<string, Handler[]>;

/** Install a minimal fake window/document with a listener registry, so keyboardSource
 *  can attach and receive dispatched key events without a real browser. */
function installDom(): void {
  handlers = {};
  const add = (t: string, h: Handler) => { (handlers[t] ||= []).push(h); };
  const remove = (t: string, h: Handler) => { handlers[t] = (handlers[t] || []).filter((x) => x !== h); };
  (globalThis as Record<string, unknown>).window = { addEventListener: add, removeEventListener: remove };
  (globalThis as Record<string, unknown>).document = {
    addEventListener: add, removeEventListener: remove,
    activeElement: null, visibilityState: 'visible',
  };
}

function fire(type: string, event: unknown): void {
  for (const h of handlers[type] || []) h(event);
}
/** A held snapshot: press the given keys (keydown), then read sample() into a frame. */
function sampleWith(keys: string[]) {
  for (const key of keys) fire('keydown', { key });
  const f = createInputFrame();
  keyboardSource.sample(f);
  return f;
}

beforeEach(() => { installDom(); keyboardSource.attach(); });
afterEach(() => {
  keyboardSource.detach(); // clears held + removes listeners
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe('keyboardSource key→action mapping', () => {
  it('A/D and arrows drive moveX + nav (∓1)', () => {
    expect(sampleWith(['a']).axes.moveX).toBe(-1);
    keyboardSource.detach(); keyboardSource.attach();
    expect(sampleWith(['d']).axes.moveX).toBe(1);
    keyboardSource.detach(); keyboardSource.attach();
    const arrows = sampleWith(['ArrowLeft']);
    expect(arrows.axes.moveX).toBe(-1);
    expect(arrows.held.navLeft).toBe(true);
  });

  it('W/S and ↑/↓ drive moveY with forward/up = +1, plus nav', () => {
    const up = sampleWith(['w']);
    expect(up.axes.moveY).toBe(1);       // forward/up = +1 (negated to −Z by the 3D bridge)
    expect(up.held.navUp).toBe(true);
    keyboardSource.detach(); keyboardSource.attach();
    expect(sampleWith(['s']).axes.moveY).toBe(-1);
  });

  it('Space → jump + confirm; Enter → confirm only (NOT jump)', () => {
    const space = sampleWith([' ']);
    expect(space.held.jump).toBe(true);
    expect(space.held.confirm).toBe(true);
    keyboardSource.detach(); keyboardSource.attach();
    const enter = sampleWith(['Enter']);
    expect(enter.held.confirm).toBe(true);
    expect(enter.held.jump).toBe(false);  // 3D jump is Space-only — Enter must not jump
  });

  it('Escape → cancel + menu; P → pause; lastDevice tracks activity', () => {
    const esc = sampleWith(['Escape']);
    expect(esc.held.cancel).toBe(true);
    expect(esc.held.menu).toBe(true);
    expect(esc.lastDevice).toBe('keyboard');
    keyboardSource.detach(); keyboardSource.attach();
    expect(sampleWith(['p']).held.pause).toBe(true);
  });

  it('F → aim', () => {
    expect(sampleWith(['f']).held.aim).toBe(true);
  });

  it('keyup releases; blur/detach clears all held state', () => {
    fire('keydown', { key: 'a' });
    fire('keyup', { key: 'a' });
    const afterUp = createInputFrame(); keyboardSource.sample(afterUp);
    expect(afterUp.axes.moveX).toBe(0);

    fire('keydown', { key: 'd' });
    fire('blur', {});
    const afterBlur = createInputFrame(); keyboardSource.sample(afterBlur);
    expect(afterBlur.axes.moveX).toBe(0);
  });

  it('ignores keys while a text field is focused (editing guard)', () => {
    (globalThis as Record<string, unknown>).document = {
      ...(globalThis as Record<string, { document: object }>).document,
      addEventListener: () => {}, removeEventListener: () => {},
      activeElement: { tagName: 'INPUT', isContentEditable: false },
      visibilityState: 'visible',
    };
    fire('keydown', { key: 'a' });     // should be ignored — user is typing
    const f = createInputFrame(); keyboardSource.sample(f);
    expect(f.axes.moveX).toBe(0);
  });
});
