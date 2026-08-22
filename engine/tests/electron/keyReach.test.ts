/** The key-name alias maps must stay inverses across the process boundary.
 *
 *  Same shape, and the same reason, as activeElementProbe.test.ts next door: two copies of
 *  one fact, in two processes that cannot import each other at runtime.
 *
 *    rendererOps.KEYCODE_ALIAS  (main)      DOM name  → Electron accelerator, for sendInputEvent
 *    keyReach.DOM_KEY_ALIAS     (renderer)  Electron accelerator → DOM name, for chord resolution
 *
 *  A one-sided addition is invisible: the key still presses correctly, but `probe-key-reach`
 *  resolves the wrong chord, decides no editor binding claimed it, and `/api/input/key` starts
 *  warning "this press did nothing at all" about a press that did exactly what was asked. The
 *  warning exists to be believed, so it must not be able to lie on one key. */

import { describe, it, expect } from 'vitest';
import { KEYCODE_ALIAS } from '../../electron/rendererOps';
// Relative, not '@modoki/engine/editor': reaching for the real map is the point — a copy
// declared here would prove nothing.
import { DOM_KEY_ALIAS } from '../../packages/modoki/src/editor/input/keyReach';

describe('DOM_KEY_ALIAS ↔ KEYCODE_ALIAS', () => {
  it('every DOM→accelerator alias has the matching accelerator→DOM entry', () => {
    for (const [dom, accel] of Object.entries(KEYCODE_ALIAS)) {
      expect(DOM_KEY_ALIAS[accel]).toBe(dom);
    }
  });

  it('and nothing extra in the reverse direction', () => {
    for (const [accel, dom] of Object.entries(DOM_KEY_ALIAS)) {
      expect(KEYCODE_ALIAS[dom]).toBe(accel);
    }
  });

  it('covers the four arrows (guards against both maps being emptied together)', () => {
    expect(Object.keys(KEYCODE_ALIAS).sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
  });
});
