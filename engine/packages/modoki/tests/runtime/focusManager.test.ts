/** focusManager — pure directional resolution + scope stack (Phase 3, Part B).
 *
 *  Unit-tests the spatial resolver with fabricated rects (no DOM) and the scope-stack
 *  mutators. The system-level wiring (Input → focus movement → activation) is covered
 *  headlessly in uiFocusSystem.test.ts. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  pickInDirection, pushScope, popScope, activeScope, setFocus, focusedGuid, resetFocus,
  requestActivate, retargetFocusedGuid, useFocusStore,
} from '../../src/runtime/ui/focusManager';
import type { ScreenRect } from '../../src/runtime/core/screenBounds';

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

/** A pooled scroll-view entry's guid is stable at the SLOT, so when the pool recycles the
 *  entries system re-points focus at whichever slot now holds the same ENTRY (#319). */
describe('retargetFocusedGuid', () => {
  const pending = () => useFocusStore.getState().pendingActivateGuid;

  it('moves focus from one guid to another', () => {
    setFocus('slot-3');
    retargetFocusedGuid('slot-3', 'slot-1');
    expect(focusedGuid()).toBe('slot-1');
  });

  it('carries a QUEUED activation with it — the half that fires the wrong element', () => {
    // A "confirm" is deferred on purpose: uiFocusSystem queues it inside the pipeline tick and
    // UIRenderer drains it from a React effect after commit. A scroll-event pool re-drive lands
    // inside that gap, so a queued guid left behind would activate whatever the slot recycled to.
    setFocus('slot-3');
    requestActivate('slot-3');
    expect(pending()).toBe('slot-3');

    retargetFocusedGuid('slot-3', 'slot-1');
    expect(pending()).toBe('slot-1');
    expect(focusedGuid()).toBe('slot-1');
  });

  it('leaves a queued activation for a DIFFERENT element alone', () => {
    setFocus('slot-3');
    requestActivate('elsewhere');
    retargetFocusedGuid('slot-3', 'slot-1');
    expect(focusedGuid()).toBe('slot-1');
    expect(pending()).toBe('elsewhere');
  });

  it('is a no-op on an empty or unchanged move rather than clobbering state', () => {
    setFocus('slot-3');
    requestActivate('slot-3');
    retargetFocusedGuid('', 'slot-1');
    retargetFocusedGuid('slot-3', '');
    retargetFocusedGuid('slot-3', 'slot-3');
    expect(focusedGuid()).toBe('slot-3');
    expect(pending()).toBe('slot-3');
  });

  it('does not move focus that is somewhere else entirely', () => {
    setFocus('a-button');
    retargetFocusedGuid('slot-3', 'slot-1');
    expect(focusedGuid()).toBe('a-button');
  });
});
