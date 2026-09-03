/** UIToggle's click cue actually fires through the REAL `applyBindings` (#528 seam).
 *
 *  `uiNode.test.tsx` mocks `applyBindings` wholesale (see its own header comment), so nothing in
 *  that suite crosses `UINode.tsx`'s `fire()` → the real `applyBindings` → `setUIClickCue`'s
 *  registered callback. That gap is exactly the shape #528 lived in: the old
 *  `event === 'click'` test inside `applyBindings` silenced every UIToggle, whose activation
 *  fires `'change'`, not `'click'` — a unit test asserting on the MOCK could not have caught it,
 *  because the mock has no event-name logic to get wrong.
 *
 *  This file renders a real `UIToggle` through `UINode` with the REAL (unmocked) `applyBindings`,
 *  registers a real click-cue callback via `setUIClickCue` (the same hookup
 *  `registerAudioControls` uses), clicks it, and asserts the cue fires exactly once. A separate
 *  file from `uiNode.test.tsx` on purpose — mixing this with that file's module-level
 *  `vi.mock('../../src/runtime/ui/bindings', ...)` would silently re-mock the very seam this test
 *  exists to cross. */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createWorld } from 'koota';

import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { setPlayState } from '../../src/runtime/core/playState';
import { setUIClickCue } from '../../src/runtime/ui/bindings';
import { UINode } from '../../src/runtime/ui/UINode';
import type { UINodeData } from '../../src/runtime/ui/uiTreeStore';

registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} });
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} });

/** A complete UINodeData with neutral defaults, standing in as a UIToggle — same field set as
 *  `uiNode.test.tsx`'s `makeNode`/`toggle` helpers, duplicated rather than imported so this file
 *  has no dependency on that file's module-mocked environment. */
function makeToggleNode(over: Partial<UINodeData> = {}): UINodeData {
  return {
    entityId: 1, guid: 'toggle-1',
    width: 60, height: 30, widthUnit: 'px', heightUnit: 'px',
    flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
    gap: 0, gapUnit: 'px', flexGrow: 0, flexShrink: 1,
    paddingTop: 0, paddingTopUnit: 'px', paddingLeft: 0, paddingLeftUnit: 'px',
    paddingRight: 0, paddingRightUnit: 'px', paddingBottom: 0, paddingBottomUnit: 'px',
    marginTop: 0, marginTopUnit: 'px', marginRight: 0, marginRightUnit: 'px',
    marginBottom: 0, marginBottomUnit: 'px', marginLeft: 0, marginLeftUnit: 'px',
    minWidth: 0, minWidthUnit: 'px', maxWidth: 0, maxWidthUnit: 'px',
    minHeight: 0, minHeightUnit: 'px', maxHeight: 0, maxHeightUnit: 'px',
    alignSelf: 'auto', zIndex: 0, rotation: 0, scale: 1, overflow: 'visible', isVisible: true, pointerThrough: false,
    scrollbarStyle: 'auto', scrollbarThumbColor: 0x888888, scrollbarTrackColor: 0xdddddd,
    backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0, borderColor: 0x333333, borderOpacity: 1, opacity: 1,
    text: '', fontFamily: '', fontSize: 16, fontSizeUnit: 'px', fontWeight: 'normal', fontStyle: 'normal',
    autoFitText: false, fontSizeMin: 0,
    textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0, letterSpacingUnit: 'px',
    textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
    textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
    imageSrc: '', imageMode: 'cover', imageEpoch: 0, hasVideo: false, elementType: 'div', placeholder: '',
    rangeMin: 0, rangeMax: 100, rangeStep: 1,
    toggle: {
      value: false, trackOnColor: 0x4aa3ff, trackOffColor: 0x767676, trackOpacity: 1,
      knobColor: 0xffffff, knobOpacity: 1, knobInset: 2, trackRadius: 999, knobRadius: 999,
      disabled: false,
    },
    // The Inspector's real authoring shape for a working toggle: a `set` binding on
    // event 'change' — matches `UIToggle`'s own header ("does NOT write value itself").
    action: {
      bindings: [
        { event: 'change', kind: 'set', target: 'toggle-1', component: 'UIElement', property: 'isVisible', value: true },
      ],
    },
    children: [],
    ...over,
  };
}

describe('UIToggle click cue crosses the real applyBindings (#528)', () => {
  let world: ReturnType<typeof createWorld>;

  beforeEach(() => {
    world = createWorld();
    setCurrentWorld(world);
    setPlayState('playing');
    // The 'set' binding above targets this same entity so applyBindings has a real target to
    // resolve — not load-bearing for the click cue itself (which fires before target resolution),
    // but keeps this test honestly exercising the whole activation, not just the cue.
    world.spawn(EntityAttributes({ guid: 'toggle-1', name: 'toggle-1' }), UIElement({ isVisible: false }));
  });

  afterEach(() => {
    cleanup();
    setUIClickCue(null);
    setPlayState('playing');
    world.destroy();
    // ⚠️ Both tests above fire a discrete 'change' binding, which ACQUIRES the #466 global input
    // lock (bindings.ts's `acquireLock`) and never releases it here — a 'set' binding (unlike
    // 'call') has nothing to await, so nothing calls `trackLockPromise`/`releaseLock` for it, and
    // `bindings.ts` exports no reset hook to call from this `afterEach`. It is harmless TODAY only
    // because each test's `beforeEach` calls `setCurrentWorld(world)` on a brand-new world, and
    // that fires `onWorldSwap` → `releaseLock()` (bindings.ts ~94) before the NEXT test's body
    // runs. If a future test in this file is added that does NOT swap worlds first (or the
    // beforeEach's world-swap goes away), a valid 'change' binding would silently no-op behind the
    // still-held lock and fail as a confusing "cue not called" — the lock's own `lockMaxMs`/
    // `lockMinMs` valve is time-based, not test-boundary-based, so it will not save you.
  });

  it('clicking a UIToggle fires the registered click cue exactly once', () => {
    const cue = vi.fn();
    setUIClickCue(cue);

    const { container } = render(<UINode node={makeToggleNode()} storeState={{}} />);
    const track = container.querySelector('[role="switch"]') as HTMLElement;
    expect(track).toBeTruthy();

    fireEvent.click(track);

    expect(cue).toHaveBeenCalledTimes(1);
  });

  it('sanity: a click-only binding leaves the toggle non-interactive — the dead-toggle authoring trap', () => {
    const cue = vi.fn();
    setUIClickCue(cue);

    // A toggle authored (or defaulted, per the Inspector's own default) with a 'click' binding
    // instead of 'change' cannot move — this is the authoring trap the `warnDeadToggle` guard next
    // to `fire()` exists to warn about (UINode.tsx ~691: `canFire` requires a 'change' binding,
    // and `interactive = canFire && ...` gates whether `onClick` is even wired at all). With no
    // 'change' binding, `interactive` is false and `onClick` is `undefined` — so this test never
    // reaches `applyBindings`; `fireEvent.click` calls nothing. It does NOT exercise the real
    // event-name filter inside `applyBindings` (the positive case above does that); it only proves
    // the dead-toggle gate keeps a click-only toggle from firing at all.
    const node = makeToggleNode({
      action: { bindings: [{ event: 'click', kind: 'set', target: 'toggle-1', component: 'UIElement', property: 'isVisible', value: true }] },
    });
    const { container } = render(<UINode node={node} storeState={{}} />);
    const track = container.querySelector('[role="switch"]') as HTMLElement;

    fireEvent.click(track);

    expect(cue).not.toHaveBeenCalled();
  });
});
