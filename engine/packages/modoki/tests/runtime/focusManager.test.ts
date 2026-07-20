/** focusManager — pure directional resolution + scope stack (Phase 3, Part B).
 *
 *  Unit-tests the spatial resolver with fabricated rects (no DOM) and the scope-stack
 *  mutators. The system-level wiring (Input → focus movement → activation) is covered
 *  headlessly in uiFocusSystem.test.ts. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  pickInDirection, pushScope, popScope, activeScope, setFocus, focusedGuid, resetFocus,
} from '../../src/runtime/ui/focusManager';
import type { ScreenRect } from '../../src/runtime/rendering/screenBounds';

const rect = (x: number, y: number): ScreenRect => ({ x, y, w: 10, h: 10 });

afterEach(() => resetFocus());

describe('pickInDirection (spatial nav)', () => {
  const from = rect(0, 0); // center (5,5)

  it('picks the nearest candidate strictly in the pressed direction', () => {
    const cands = [
      { guid: 'right', rect: rect(100, 0) },
      { guid: 'left', rect: rect(-100, 0) },
      { guid: 'down', rect: rect(0, 100) },
      { guid: 'up', rect: rect(0, -100) },
    ];
    expect(pickInDirection(from, cands, 'right')).toBe('right');
    expect(pickInDirection(from, cands, 'left')).toBe('left');
    expect(pickInDirection(from, cands, 'down')).toBe('down');
    expect(pickInDirection(from, cands, 'up')).toBe('up');
  });

  it('prefers the closer of two in-direction candidates', () => {
    const cands = [
      { guid: 'far', rect: rect(300, 0) },
      { guid: 'near', rect: rect(80, 0) },
    ];
    expect(pickInDirection(from, cands, 'right')).toBe('near');
  });

  it('penalizes perpendicular offset (aligned beats sideways even if slightly farther)', () => {
    const cands = [
      { guid: 'aligned', rect: rect(120, 0) },   // along 120, perp 0 → score 120
      { guid: 'sideways', rect: rect(100, 100) }, // along 100, perp 100 → score 300
    ];
    expect(pickInDirection(from, cands, 'right')).toBe('aligned');
  });

  it('returns null when nothing is in the pressed direction', () => {
    const cands = [{ guid: 'left', rect: rect(-100, 0) }];
    expect(pickInDirection(from, cands, 'right')).toBeNull();
  });

  it('excludes candidates exactly on the perpendicular line (along === 0)', () => {
    const cands = [{ guid: 'above', rect: rect(0, -100) }];
    expect(pickInDirection(from, cands, 'right')).toBeNull(); // dx = 0 → not to the right
  });
});

describe('scope stack', () => {
  it('pushes/pops scopes and clears focus on each transition', () => {
    expect(activeScope()).toBe('');
    setFocus('a');
    expect(focusedGuid()).toBe('a');

    pushScope('modal');
    expect(activeScope()).toBe('modal');
    expect(focusedGuid()).toBe(''); // cleared so the new scope re-autofocuses

    setFocus('b');
    expect(popScope()).toBe(true);
    expect(activeScope()).toBe('');
    expect(focusedGuid()).toBe('');
  });

  it('never pops the base scope', () => {
    expect(popScope()).toBe(false);
    expect(activeScope()).toBe('');
  });
});
